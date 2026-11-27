/**
 * images.gs
 * ตอบเป็น "รูปเดี่ยว" ที่ผู้ใช้กดค้างเพื่อบันทึก/แชร์ได้ (LINE image message)
 * พร้อมข้อความท้ายรูป (ไม่บังคับ) และปุ่มลอย Quick Reply (ไม่บังคับ)
 *
 * ชีต "Images" หัวตาราง (แถวที่ 1):
 *   A: ID | B: Triggers | C: ลิงก์รูป | D: ข้อความท้ายรูป | E: ปุ่ม1 | F: ปุ่ม2 | G: ปุ่ม3
 *
 * - ID        รหัสสำหรับให้ปุ่มอื่นเรียก เช่น ใส่ card:plate_change ในช่อง "เมื่อกด" ของ ImageCards
 * - Triggers  คั่นด้วยคอมมา  ใส่ = นำหน้าคำเพื่อให้ตรงเป๊ะ (อย่าขึ้นต้นช่องด้วย = เพราะ Sheets จะมองเป็นสูตร)
 *             การเทียบตัดช่องว่าง จุด ขีด ออกก่อน จึง "พ.ร.บ." ตรงกับ "พรบ"
 * - ปุ่ม      รูปแบบ  ชื่อปุ่ม|ค่า   โดยค่า = https://... (เปิดลิงก์) หรือ card:รหัส (เปิดการ์ด/รูปอื่น ไม่มีข้อความโผล่ในแชท)
 *             ชื่อปุ่มยาวไม่เกิน 20 ตัวอักษร
 * - ใช้ Reply API ฟรี ไม่นับโควตา
 *
 * ต้องมีฟังก์ชัน getSpreadsheet_(), getLineAccessToken_(), normalizeImageUrl_() (cards.gs) และ normalizeForMatch_() (safety.gs)
 */

const IMAGES_SHEET_NAME = 'Images';

function getImageRows_() {
  const sheet = getSpreadsheet_().getSheetByName(IMAGES_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  const rows = [];
  values.forEach(function (r) {
    const url = normalizeImageUrl_(r[2]); // ฟังก์ชันนี้อยู่ใน cards.gs (แปลงลิงก์ Drive เป็นรูปแบบ thumbnail)
    if (!/^https:\/\//i.test(url)) return; // ข้ามแถวที่ยังไม่มีลิงก์ https ที่ใช้ได้
    const buttons = [];
    [r[4], r[5], r[6]].forEach(function (b) {
      const parsed = parseQuickButton_(b);
      if (parsed) buttons.push(parsed);
    });
    rows.push({
      id: String(r[0] || '').trim(),
      triggers: String(r[1] || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean),
      url: url,
      caption: String(r[3] || '').trim(),
      buttons: buttons
    });
  });
  return rows;
}

function findImageById_(id) {
  const rows = getImageRows_();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].id && rows[i].id === id) return rows[i];
  }
  return null;
}

/**
 * จับคู่ข้อความกับ Triggers (เทียบหลังตัดช่องว่าง จุด ขีด ฯลฯ)
 * "=คำ" ต้องตรงเป๊ะ, คำปกติ = มีคำนั้นอยู่ในข้อความ, ถ้าตรงหลายคำเลือกคำที่ยาวที่สุด
 */
function findImageRow_(text, rows) {
  const t = normalizeForMatch_(text);
  if (!t) return null;
  let best = null;
  let bestLen = 0;
  rows.forEach(function (row) {
    row.triggers.forEach(function (raw) {
      let trig = String(raw || '').trim();
      let exact = false;
      if (trig.charAt(0) === '=') {
        exact = true;
        trig = trig.substring(1);
      }
      trig = normalizeForMatch_(trig);
      if (!trig) return;
      const ok = exact ? (t === trig) : (t.indexOf(trig) !== -1);
      if (ok && trig.length > bestLen) {
        best = row;
        bestLen = trig.length;
      }
    });
  });
  return best;
}

/*
 * หมายเหตุ: ไม่ประกาศ normalizeImageUrl_ ในไฟล์นี้ เพราะมีอยู่แล้วใน cards.gs
 * ถ้าประกาศซ้ำ Apps Script จะใช้ตัวใดตัวหนึ่งโดยไม่แจ้งเตือน และกระทบรูปในการ์ดภาพด้วย
 */

function parseQuickButton_(cell) {
  const s = String(cell || '').trim();
  const i = s.indexOf('|');
  if (i < 1) return null;
  const label = s.substring(0, i).trim().substring(0, 20);
  const value = s.substring(i + 1).trim();
  if (!label || !value) return null;
  if (/^https:\/\//i.test(value)) {
    return { type: 'action', action: { type: 'uri', label: label, uri: value } };
  }
  if (/^card:/i.test(value)) {
    return {
      type: 'action',
      action: { type: 'postback', label: label, data: 'card=' + value.substring(5).trim() }
    };
  }
  return null;
}

/**
 * ส่งรูป (+ข้อความท้ายรูป) (+ปุ่มลอย)
 * คืนค่า {code, body} รูปแบบเดียวกับที่ logInteraction_ ใช้
 */
function replyImageRow_(replyToken, row, leadText) {
  const messages = leadMessages_(leadText);
  messages.push({
    type: 'image',
    originalContentUrl: row.url,
    previewImageUrl: row.url
  });
  if (row.caption) {
    messages.push({ type: 'text', text: row.caption.substring(0, 5000) });
  }
  if (row.buttons.length) {
    messages[messages.length - 1].quickReply = { items: row.buttons.slice(0, 13) };
  }
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getLineAccessToken_() },
    payload: JSON.stringify({ replyToken: replyToken, messages: localizeMessages_(messages) }),
    muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), body: res.getContentText() };
}