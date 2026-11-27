/**
 * cards.gs
 * ระบบตอบกลับเป็น "การ์ด" (Flex Message) ตามข้อมูลในชีต "Cards"
 *
 * โครงสร้างชีต Cards (แถวที่ 1 เป็นหัวตาราง, ข้อมูลเริ่มแถวที่ 2):
 *   A: CardID        รหัสการ์ด (ภาษาอังกฤษ/ตัวเลข ไม่ซ้ำ เช่น tax)
 *   B: Triggers      คำที่ทำให้ส่งการ์ดนี้ คั่นด้วยคอมมา เช่น ต่อภาษี,ชำระภาษี,ภาษีรถ
 *   C: หัวข้อ         หัวข้อการ์ด
 *   D: ข้อความ        เนื้อหาในการ์ด
 *   E,F: ปุ่ม 1  ชื่อปุ่ม / ค่า
 *   G,H: ปุ่ม 2  ชื่อปุ่ม / ค่า
 *   I,J: ปุ่ม 3  ชื่อปุ่ม / ค่า
 *
 * "ค่า" ของปุ่มใช้ได้ 3 แบบ:
 *   - ขึ้นต้นด้วย http:// https:// หรือ tel:  -> เปิดลิงก์/โทรออก
 *   - ขึ้นต้นด้วย card:   เช่น card:license    -> เปิดการ์ดอื่น (ไม่มีข้อความโผล่ในแชท)
 *   - อย่างอื่น                                -> ส่งเป็นข้อความเข้าแชท
 */

function getCardRows_() {
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEET_NAME_CARDS);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  return values
    .filter(r => String(r[0]).trim() !== '')
    .map(r => ({
      id: String(r[0]).trim(),
      triggers: String(r[1]).split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      title: String(r[2]).trim(),
      text: String(r[3]).trim(),
      buttons: [[r[4], r[5]], [r[6], r[7]], [r[8], r[9]]]
        .map(b => ({ label: String(b[0]).trim(), value: String(b[1]).trim() }))
        .filter(b => b.label && b.value)
    }));
}

/** หาการ์ดที่ตรงกับข้อความ: ตรงเป๊ะก่อน แล้วค่อยแบบมีคำนั้นอยู่ในข้อความ */
function findCard_(userText, cards) {
  const text = String(userText || '').trim().toLowerCase();
  if (!text || !cards.length) return null;

  // trigger ที่ขึ้นต้นด้วย = (เช่น =ใบขับขี่) จะตรงเฉพาะเมื่อผู้ใช้พิมพ์/กดเมนูคำนั้นเป๊ะเท่านั้น
  const exact = cards.find(c => c.triggers.some(t => t.replace(/^=/, '') === text));
  if (exact) return exact;

  // ถ้าหลายการ์ดตรงพร้อมกัน เลือกการ์ดที่คำ trigger ยาวที่สุด (เจาะจงที่สุด)
  const compact = text.replace(/\s+/g, '');
  let best = null;
  let bestLen = 0;
  cards.forEach(c => {
    c.triggers.forEach(t => {
      if (t.charAt(0) === '=') return; // trigger แบบตรงเป๊ะ ไม่นำมาจับแบบมีคำอยู่ในข้อความ
      const tc = t.replace(/\s+/g, '');
      if (tc && compact.indexOf(tc) !== -1 && tc.length > bestLen) {
        best = c;
        bestLen = tc.length;
      }
    });
  });
  return best;
}

function findCardById_(cardId) {
  return getCardRows_().find(c => c.id === cardId) || null;
}

function buildButtonAction_(button) {
  const label = button.label.substring(0, 20); // LINE จำกัดชื่อปุ่ม 20 ตัวอักษร
  const value = button.value;

  if (/^(https?:|tel:)/i.test(value)) {
    return { type: 'uri', label: label, uri: value };
  }
  if (/^card:/i.test(value)) {
    // แนบชื่อปุ่มไปกับ data (&t=) เพื่อให้บอทตอบ "คุณเลือก: ..." ก่อนแสดงการ์ด/รูป (data ยาวไม่เกิน 300 ตัวอักษร)
    return { type: 'postback', label: label, data: ('card=' + value.substring(5).trim() + '&t=' + encodeURIComponent(label)).substring(0, 300) };
  }
  return { type: 'message', label: label, text: value };
}

/** ข้อความนำ "คุณเลือก: ..." ที่แทรกก่อนการ์ด/รูป (ว่างถ้าไม่มีชื่อ) */
function leadMessages_(leadText, headline) {
  // leadText เป็นข้อความ -> "✅ คุณเลือก: ..."   leadText เป็น {raw: '...'} -> ส่งข้อความนั้นตรงๆ
  const raw = (leadText && typeof leadText === 'object') ? String(leadText.raw || '').trim() : '';
  const chosen = raw ? '' : String(leadText || '').trim();
  const head = String(headline || '').trim();
  const lines = [];
  if (raw) lines.push(raw);
  else if (chosen) lines.push('✅ คุณเลือก: ' + chosen);
  if (head) lines.push(head);
  return lines.length ? [{ type: 'text', text: lines.join('\n').substring(0, 5000) }] : [];
}

/** ส่งการ์ดกลับด้วย Reply API (ฟรี ไม่นับโควตาข้อความ) คืนค่าสถานะ HTTP เหมือน replyMessage_ */
function replyCard_(replyToken, card, leadText) {
  const contents = [
    { type: 'text', text: card.title || ' ', weight: 'bold', size: 'lg', wrap: true }
  ];
  if (card.text) {
    contents.push({ type: 'text', text: card.text, wrap: true, color: '#555555', margin: 'md' });
  }

  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: contents }
  };

  if (card.buttons.length) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: card.buttons.map(b => ({
        type: 'button',
        style: 'primary',
        action: buildButtonAction_(b)
      }))
    };
  }

  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getLineAccessToken_() },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: localizeMessages_(leadMessages_(leadText).concat([{
        type: 'flex',
        altText: (card.title || 'ข้อความจากระบบ').substring(0, 400),
        contents: bubble
      }]))
    }),
    muteHttpExceptions: true
  });

  return 'HTTP ' + res.getResponseCode() + ' | ' + res.getContentText();
}


/* =====================================================================
 * การ์ดภาพแบบเลื่อน (Image Carousel) — อ่านจากชีต "ImageCards"
 *
 * โครงสร้างชีต ImageCards (แถวที่ 1 เป็นหัวตาราง):
 *   A: GroupID     รหัสกลุ่ม (แถวที่ GroupID เดียวกัน = การ์ดภาพชุดเดียวกัน เรียงตามลำดับแถว สูงสุด 12 ใบ)
 *   B: Triggers    คำที่ทำให้ส่งชุดนี้ คั่นด้วยคอมมา (ใส่ในแถวไหนของกลุ่มก็ได้ ระบบรวมให้)
 *   C: ลิงก์รูป     https://... หรือลิงก์แชร์ Google Drive (ระบบแปลงให้อัตโนมัติ)
 *   D: ข้อความบนรูป  ข้อความในแถบด้านล่างของรูป (เว้นว่างได้)
 *   E: เมื่อกด      https://... / tel:... = เปิดลิงก์/โทร, card:รหัส = เปิดการ์ด/ชุดภาพอื่น,
 *                  อย่างอื่น = ส่งเป็นข้อความเข้าแชท, เว้นว่าง = กดไม่ได้
 *   F: ข้อความบนการ์ด  ข้อความที่ส่งนำหน้าการ์ดชุดนี้ (ใส่ในแถวไหนของกลุ่มก็ได้ ใช้แถวแรกที่มีข้อความ เว้นว่างได้)
 *                  ถ้าผู้ใช้กดมาจากการ์ดอื่น จะมี "✅ คุณเลือก: ชื่อปุ่ม" อยู่บรรทัดบนของข้อความเดียวกันด้วย
 * ===================================================================== */

/** แปลงลิงก์แชร์ Google Drive เป็นลิงก์รูปที่ LINE ดึงไปแสดงได้ */
function normalizeImageUrl_(url) {
  const u = String(url || '').trim();
  const m = u.match(/drive\.google\.com\/file\/d\/([^\/?#]+)/) || u.match(/drive\.google\.com\/open\?id=([^&#]+)/);
  if (m) return 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w1000';
  return u;
}

function getImageGroups_() {
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEET_NAME_IMAGE_CARDS);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  const map = {};
  const order = [];

  values.forEach(r => {
    const id = String(r[0]).trim();
    const image = normalizeImageUrl_(r[2]);
    if (!id || !/^https:\/\//i.test(image)) return; // ข้ามแถวที่ยังไม่มีลิงก์รูปที่ใช้ได้

    if (!map[id]) {
      map[id] = { id: id, triggers: [], slides: [], headline: '' };
      order.push(id);
    }
    String(r[1]).split(',').map(s => s.trim().toLowerCase()).filter(Boolean).forEach(t => {
      if (map[id].triggers.indexOf(t) === -1) map[id].triggers.push(t);
    });
    if (!map[id].headline) map[id].headline = String(r[5] || '').trim();
    map[id].slides.push({
      image: image,
      label: String(r[3]).trim(),
      action: String(r[4]).trim()
    });
  });

  return order.map(id => map[id]);
}

function findImageGroupById_(groupId) {
  return getImageGroups_().find(g => g.id === groupId) || null;
}

/** ส่งชุดการ์ดภาพกลับด้วย Reply API (ฟรี) คืนค่าสถานะ HTTP เหมือน replyMessage_ */
function replyImageCarousel_(replyToken, group, leadText) {
  const bubbles = group.slides.slice(0, 12).map(s => {
    const action = s.action
      ? buildButtonAction_({ label: s.label || 'เปิด', value: s.action })
      : null;

    const image = {
      type: 'image',
      url: s.image,
      size: 'full',
      aspectMode: 'cover',
      aspectRatio: '1:1'
    };
    if (action) image.action = action;

    const contents = [image];
    if (s.label) {
      const overlay = {
        type: 'box',
        layout: 'vertical',
        position: 'absolute',
        offsetBottom: '16px',
        offsetStart: '16px',
        offsetEnd: '16px',
        backgroundColor: '#000000AA',
        cornerRadius: '20px',
        paddingAll: '10px',
        contents: [{
          type: 'text', text: s.label, color: '#FFFFFF',
          align: 'center', size: 'sm', wrap: true
        }]
      };
      if (action) overlay.action = action;
      contents.push(overlay);
    }

    return {
      type: 'bubble',
      size: 'mega',
      body: { type: 'box', layout: 'vertical', paddingAll: '0px', contents: contents }
    };
  });

  const flexContents = bubbles.length > 1
    ? { type: 'carousel', contents: bubbles }
    : bubbles[0];

  const firstLabel = (group.slides[0] && group.slides[0].label) || 'ข้อมูลจากระบบ';

  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getLineAccessToken_() },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: localizeMessages_(leadMessages_(leadText, group.headline).concat([{ type: 'flex', altText: firstLabel.substring(0, 400), contents: flexContents }]))
    }),
    muteHttpExceptions: true
  });

  return 'HTTP ' + res.getResponseCode() + ' | ' + res.getContentText();
}