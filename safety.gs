/**
 * safety.gs
 * เครื่องมือด้านความน่าเชื่อถือของระบบ
 *   1) logError_            บันทึก error ลงชีต Log (แหล่งที่มา "Error") แทนการกลืนเงียบ
 *   2) isDuplicateEvent_    ข้ามอีเวนต์ที่ LINE ส่งซ้ำ (ใช้ webhookEventId)
 *   3) normalizeForMatch_   ตัดช่องว่าง จุด ขีด ฯลฯ ก่อนเทียบ trigger (พ.ร.บ. = พรบ)
 *   4) checkImageLinks      ตรวจลิงก์รูปในชีต ImageCards และ Images แล้วรายงานในแท็บ LinkCheck
 *
 * ต้องมี getSpreadsheet_(), getLogSheet_() (log.gs), normalizeImageUrl_() (cards.gs) และ IMAGES_SHEET_NAME (images.gs)
 */

/* ---------- 1) บันทึก error ---------- */

function logError_(where, err, event) {
  const msg = String(err) + (err && err.stack ? '\n' + err.stack : '');
  console.error(where + ' error: ' + msg);
  try {
    let userId = '';
    let question = '';
    if (event) {
      userId = (event.source && event.source.userId) || '';
      question = (event.message && event.message.text) ||
        (event.postback && event.postback.data) || event.type || '';
    }
    getLogSheet_().appendRow([
      new Date(), userId, question, 'Error',
      '[' + where + '] ' + msg.substring(0, 1500), ''
    ]);
  } catch (e) {
    console.error('logError_ เขียนชีตไม่สำเร็จ: ' + e);
  }
}

/* ---------- 2) กันตอบซ้ำ ---------- */

/**
 * คืน true ถ้าเคยจัดการอีเวนต์นี้แล้วใน 6 ชั่วโมงที่ผ่านมา
 * อีเวนต์ที่ไม่มี webhookEventId (เช่นที่จำลองใน Editor) จะไม่ถูกข้าม
 */
function isDuplicateEvent_(event) {
  const id = event && event.webhookEventId;
  const tok = event && event.replyToken;
  if (!id && !tok) return false;
  let lock = null;
  try {
    lock = LockService.getScriptLock();
    lock.waitLock(3000);
    const cache = CacheService.getScriptCache();
    // กันซ้ำสองชั้น: รหัสอีเวนต์ และ reply token (token เดียวกันตอบได้ครั้งเดียวอยู่แล้ว)
    const keys = [];
    if (id) keys.push('evt_' + id);
    if (tok) keys.push('tok_' + tok);
    for (let i = 0; i < keys.length; i++) { if (cache.get(keys[i])) return true; }
    keys.forEach(function (k) { cache.put(k, '1', 21600); }); // จำ 6 ชั่วโมง (สูงสุดของ CacheService)
    return false;
  } catch (e) {
    return false; // ถ้าตรวจไม่ได้ ให้ทำงานต่อดีกว่าทิ้งข้อความ
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (e2) { /* ignore */ }
    }
  }
}

/* ---------- 3) ปรับข้อความก่อนเทียบ trigger ---------- */

/** ตัวพิมพ์เล็ก ตัดช่องว่าง/อักขระล่องหน และเครื่องหมาย . - _ / \ ( ) [ ] { } " ' , : ; ! ? ฯ */
function normalizeForMatch_(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s​-‍﻿.\-_\/\\()\[\]{}"'“”‘’,:;!?ฯ]/g, '');
}

/* ---------- 4) ตรวจลิงก์รูป ---------- */

const LINKCHECK_SHEET_NAME = 'LinkCheck';
const LINK_MAX_BYTES = 1000000; // LINE: ภาพตัวอย่างไม่เกิน 1 MB (ตั้งแบบระมัดระวัง)

function collectImageLinks_(ss, sheetName, items) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  values.forEach(function (r, i) {
    const raw = String(r[2] || '').trim();
    if (!raw) return; // แถวหัวข้อกลุ่มหรือแถวว่าง
    items.push({
      sheet: sheetName,
      row: i + 2,
      id: String(r[0] || '').trim(),
      label: String(r[3] || '').trim().substring(0, 60),
      raw: raw
    });
  });
}

function checkOneImageLink_(raw) {
  const url = normalizeImageUrl_(raw); // ตัวเดียวกับที่ระบบใช้ส่งรูปจริง (cards.gs)
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, code: '', type: '', kb: '', note: 'ไม่ใช่ลิงก์ https:// (ระบบจะข้ามแถวนี้)', url: raw };
  }
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    const code = res.getResponseCode();
    const headers = res.getHeaders();
    let type = '';
    Object.keys(headers).forEach(function (k) {
      if (k.toLowerCase() === 'content-type') type = String(headers[k]).toLowerCase();
    });
    const bytes = res.getContent().length;
    const kb = Math.round(bytes / 1024);

    if (code !== 200) {
      return { ok: false, code: code, type: type, kb: kb, note: 'HTTP ' + code, url: url };
    }
    if (!/^image\/(jpeg|jpg|png)/.test(type)) {
      return {
        ok: false, code: code, type: type, kb: kb, url: url,
        note: 'ไม่ใช่รูป JPEG/PNG (ได้ ' + (type || 'ไม่ทราบชนิด') + ') ถ้าเป็นลิงก์ Drive มักได้หน้าเว็บแทนไฟล์รูป'
      };
    }
    if (bytes > LINK_MAX_BYTES) {
      return { ok: false, code: code, type: type, kb: kb, note: 'ไฟล์ใหญ่เกิน 1 MB (' + kb + ' KB)', url: url };
    }
    return { ok: true, code: code, type: type, kb: kb, note: '', url: url };
  } catch (err) {
    return { ok: false, code: '', type: '', kb: '', note: 'เรียกลิงก์ไม่สำเร็จ: ' + String(err).substring(0, 120), url: url };
  }
}

/**
 * ตรวจทุกแถวที่มีลิงก์รูปในชีต ImageCards และ Images แล้วเขียนผลลงแท็บ LinkCheck
 * (สร้างให้เองถ้ายังไม่มี และเขียนทับทุกครั้ง) รันจาก Editor หรือตั้ง Trigger รายวันได้
 * หมายเหตุ: ผลคือสิ่งที่เซิร์ฟเวอร์ของ Google เห็น ผ่านแล้วไม่ได้รับประกันว่า LINE จะดึงได้เสมอ
 *           โดยเฉพาะลิงก์ Drive ที่อาจถูกจำกัดการเข้าถึงซ้ำๆ
 */
function checkImageLinks() {
  const started = Date.now();
  const ss = getSpreadsheet_();
  const items = [];
  collectImageLinks_(ss, (typeof CONFIG !== 'undefined' && CONFIG.SHEET_NAME_IMAGE_CARDS) || 'ImageCards', items);
  collectImageLinks_(ss, IMAGES_SHEET_NAME, items);

  const now = new Date();
  const rows = [];
  const badRowIdx = [];
  let bad = 0;
  let skipped = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (Date.now() - started > 300000) { // กันเกินเวลา 6 นาทีของ Apps Script
      skipped = items.length - i;
      break;
    }
    const r = checkOneImageLink_(it.raw);
    if (!r.ok) {
      bad++;
      badRowIdx.push(rows.length);
    }
    rows.push([now, it.sheet, it.row, it.id, it.label, r.ok ? 'OK' : 'ปัญหา', r.code, r.type, r.kb, r.note, r.url]);
  }

  const out = ss.getSheetByName(LINKCHECK_SHEET_NAME) || ss.insertSheet(LINKCHECK_SHEET_NAME);
  out.clear();
  const header = ['ตรวจเมื่อ', 'ชีต', 'แถว', 'ID/กลุ่ม', 'ข้อความ', 'ผล', 'HTTP', 'ชนิดไฟล์', 'ขนาด (KB)', 'หมายเหตุ', 'ลิงก์ที่ตรวจ'];
  out.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) {
    out.getRange(2, 1, rows.length, header.length).setValues(rows);
    badRowIdx.forEach(function (idx) {
      out.getRange(2 + idx, 1, 1, header.length).setBackground('#f8d7da');
    });
  }
  out.setFrozenRows(1);

  const summary = 'ตรวจ ' + rows.length + ' ลิงก์ ปัญหา ' + bad + ' รายการ' +
    (skipped ? ' (ยังไม่ได้ตรวจอีก ' + skipped + ' รายการ เพราะใกล้หมดเวลา รันซ้ำอีกครั้ง)' : '');
  console.log(summary);
  return summary;
}