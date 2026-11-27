/**
 * intent.gs
 * ให้ Gemini "จัดหมวดหัวข้อ" ของข้อความที่ไม่ตรงกับ trigger ใดเลย แล้วเปิดการ์ด/รูปของหัวข้อนั้น
 *
 * Gemini ไม่ได้แต่งคำตอบเอง แค่เลือก "รหัสหัวข้อ" จากรายการในชีต Topics เท่านั้น
 * ถ้าตอบนอกรายการหรือไม่แน่ใจ (NONE) จะไม่เปิดอะไร แล้วระบบไปต่อตามเดิม
 *
 * ชีต "Topics" (ชื่อแท็บตรงเป๊ะ) หัวตารางแถวที่ 1:
 *   A: ID | B: คำอธิบายหัวข้อ
 * - ID  ต้องตรงกับ GroupID ในชีต ImageCards หรือ CardID ในชีต Cards หรือ ID ในชีต Images
 * - คำอธิบาย  เขียนเป็นภาษาธรรมดาว่าหัวข้อนี้ครอบคลุมเรื่องอะไรบ้าง ยิ่งเจาะจงยิ่งแม่น
 *
 * ต้องมี getSpreadsheet_(), getGeminiApiKey_(), CONFIG.GEMINI_MODEL (มีอยู่แล้วในโปรเจกต์)
 */

const TOPICS_SHEET_NAME = 'Topics';

function getTopics_() {
  const sheet = getSpreadsheet_().getSheetByName(TOPICS_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const topics = [];
  values.forEach(function (r) {
    const id = String(r[0] || '').trim();
    const desc = String(r[1] || '').trim();
    if (id && desc) topics.push({ id: id, desc: desc });
  });
  return topics;
}

/** คืนรหัสหัวข้อที่ Gemini เลือก หรือ null ถ้าไม่แน่ใจ/เรียกไม่สำเร็จ */
function classifyTopic_(userText, topics) {
  if (!topics || !topics.length) return null;
  const apiKey = getGeminiApiKey_();
  if (!apiKey) return null;

  const list = topics.map(function (t) { return t.id + ' : ' + t.desc; }).join('\n');
  const prompt =
    'คุณเป็นตัวจัดหมวดหมู่คำถามของหน่วยงานขนส่ง\n' +
    'อ่านข้อความของผู้ใช้ แล้วเลือกรหัสหัวข้อที่ตรงที่สุดเพียงหนึ่งรหัสจากรายการด้านล่าง\n' +
    'ตอบเฉพาะรหัสหัวข้อเท่านั้น ห้ามอธิบายหรือใส่เครื่องหมายอื่น\n' +
    'ถ้าไม่มีหัวข้อที่ตรงอย่างชัดเจน หรือเป็นแค่คำทักทาย/ข้อความทั่วไป ให้ตอบ NONE\n\n' +
    '=== รายการหัวข้อ (รหัส : คำอธิบาย) ===\n' + list + '\n=== จบรายการ ===\n\n' +
    'ข้อความของผู้ใช้: ' + userText;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    CONFIG.GEMINI_MODEL + ':generateContent?key=' + apiKey;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    // Gemini 3.x: ไม่ใช้ temperature/thinkingBudget แล้ว ใช้ค่ากลางจาก Config.gs (thinkingLevel ต่ำสุด + เผื่อโทเคนคิด)
    generationConfig: geminiGenConfig_(32, false)
  };

  try {
    const response = geminiPost_(payload, true); // จัดหมวด = งานสั้น ใช้โมเดลเร็ว
    if (response.getResponseCode() !== 200) {
      console.error('classifyTopic_ HTTP ' + response.getResponseCode() + ': ' +
        response.getContentText().substring(0, 300));
      return null;
    }
    const json = JSON.parse(response.getContentText());
    const text = json && json.candidates && json.candidates[0] &&
      json.candidates[0].content && json.candidates[0].content.parts &&
      json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
    if (!text) return null;

    const answer = String(text).trim().split(/\s+/)[0].replace(/[`"'.,]/g, '');
    for (let i = 0; i < topics.length; i++) {
      if (topics[i].id === answer) return topics[i].id;
    }
    return null; // NONE หรือตอบนอกรายการ
  } catch (err) {
    console.error('classifyTopic_ error: ' + err);
    return null;
  }
}

/**
 * เปิดการ์ด/ชุดการ์ดภาพ/รูปเดี่ยวตามรหัสหัวข้อ (ค้นตามลำดับเดียวกับปุ่ม card:รหัส)
 * คืน {answer, result} หรือ null ถ้าไม่พบรหัส (ยังไม่ได้ใช้ replyToken)
 */
function replyTopic_(replyToken, id, leadText) {
  const card = findCardById_(id);
  if (card) {
    return { answer: '[การ์ด] ' + card.title, result: replyCard_(replyToken, card, leadText) };
  }
  const group = findImageGroupById_(id);
  if (group) {
    return { answer: '[การ์ดภาพ] ' + group.id, result: replyImageCarousel_(replyToken, group, leadText) };
  }
  const image = findImageById_(id);
  if (image) {
    return { answer: '[รูป] ' + image.id, result: replyImageRow_(replyToken, image, leadText) };
  }
  return null;
}

/** ทดสอบใน Editor โดยไม่ต้องส่งใน LINE */
function debugIntent() {
  const topics = getTopics_();
  console.log('จำนวนหัวข้อในชีต Topics: ' + topics.length);
  [
    'สอบถามต่อพรบ.รถครับ',
    'อยากต่อภาษีรถ',
    'ใบขับขี่หมดอายุแล้วทำไงดี',
    'รถผมขาดต่อมาสองปีแล้ว',
    'สวัสดีครับ'
  ].forEach(function (t) {
    console.log(t + '  ->  ' + classifyTopic_(t, topics));
  });
}