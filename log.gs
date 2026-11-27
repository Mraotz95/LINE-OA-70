/**
 * log.gs
 * บันทึกการโต้ตอบทุกครั้งลงชีต Log เพื่อเอาไปตรวจสอบและปรับปรุง FAQ ภายหลัง
 * โครงสร้างชีต "Log": เวลา | LINE User ID | คำถาม | แหล่งคำตอบ(FAQ/Gemini/None) | คำตอบที่ส่ง | ผลจาก LINE
 *
 * replyResult รับได้ 3 แบบ:
 *   - null/undefined      -> ไม่มีการส่ง (ช่อง F ว่าง)
 *   - ข้อความ (string)    -> เช่น 'HTTP 200 | {}' บันทึกตามนั้น
 *   - อ็อบเจ็กต์ {code, body}
 */

var EVENT_META_ = null; // {delaySec, redelivery} ของอีเวนต์ที่กำลังทำ (main.gs ตั้งค่าให้) ไว้วินิจฉัย HTTP 400

function getLogSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME_LOG);
    sheet.appendRow(['เวลา', 'LINE User ID', 'คำถาม', 'แหล่งคำตอบ', 'คำตอบที่ส่ง', 'ผลจาก LINE']);
  }
  return sheet;
}

function formatReplyResult_(replyResult) {
  if (replyResult === null || replyResult === undefined) return '';
  if (typeof replyResult === 'string') return replyResult;
  if (typeof replyResult === 'object') {
    if (replyResult.code !== undefined || replyResult.body !== undefined) {
      return 'HTTP ' + replyResult.code + ' | ' + replyResult.body;
    }
    try {
      return JSON.stringify(replyResult);
    } catch (e) {
      return String(replyResult);
    }
  }
  return String(replyResult);
}

function logInteraction_(userId, question, source, answer, replyResult) {
  try {
    const sheet = getLogSheet_();
    // ถ้าข้อความเดิมเป็นภาษาต่างประเทศ (i18n.gs) บันทึกทั้งคำแปลไทยและต้นฉบับ
    const q = (typeof ORIGINAL_TEXT_ !== 'undefined' && ORIGINAL_TEXT_)
      ? question + '  ⟵ [' + REPLY_LANG_ + '] ' + ORIGINAL_TEXT_
      : question;
    let result = formatReplyResult_(replyResult);
    // LINE ปฏิเสธ reply token: บันทึกว่าอีเวนต์มาถึงสคริปต์ช้าแค่ไหน/เป็นอีเวนต์ส่งซ้ำหรือไม่
    if (/^HTTP 400/.test(result) && EVENT_META_) {
      result += ' | [ล่าช้า ' + EVENT_META_.delaySec + ' วิ, redelivery=' + EVENT_META_.redelivery + ']';
    }
    sheet.appendRow([new Date(), userId, q, source, answer, result]);
  } catch (err) {
    console.error('logInteraction_ error: ' + err);
  }
}