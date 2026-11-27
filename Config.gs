/**
 * config.gs
 * ค่าคงที่และการตั้งค่าระบบ Q&A บน LINE OA
 * ค่าลับ (Token / API Key) เก็บไว้ใน Script Properties เพื่อความปลอดภัย
 * วิธีตั้งค่า: Apps Script Editor > Project Settings > Script Properties > Add script property
 *   - LINE_CHANNEL_ACCESS_TOKEN
 *   - LINE_CHANNEL_SECRET
 *   - GEMINI_API_KEY
 */

const CONFIG = {
  // ชื่อชีตที่ใช้ในระบบ (ต้องตรงกับชื่อจริงในไฟล์ Google Sheets)
  SHEET_NAME_FAQ: 'FAQ',
  SHEET_NAME_LOG: 'Log',
  SHEET_NAME_MENU_SKIP: 'MenuSkip',
  SHEET_NAME_CARDS: 'Cards',
  SHEET_NAME_IMAGE_CARDS: 'ImageCards',

  // โมเดล Gemini ที่ใช้ (gemini-2.5-flash ปิดรับผู้ใช้ใหม่แล้ว) ดูเวลาตอบจริงของแต่ละโมเดลได้ที่ Executions: บรรทัด "Gemini <โมเดล> HTTP 200 <n> ms"
  GEMINI_MODEL: 'gemini-3.5-flash-lite',   // โมเดลหลัก: เรียบเรียงคำตอบ (เปลี่ยนเป็น 'gemini-3.8-flash' ถ้าอยากได้คำตอบละเอียดขึ้นแต่ช้าลง)
  // โมเดลเร็ว: ใช้กับงานสั้นๆ ที่ตอบเป็น JSON (แปลภาษา แยกต้นทาง/ปลายทาง จัดหมวดหัวข้อ) เร็วและเบากว่า
  GEMINI_MODEL_FAST: 'gemini-3.5-flash-lite', // งานสั้นตอบเป็น JSON (แปลภาษา แยกต้นทาง/ปลายทาง จัดหมวดหัวข้อ)
  // โมเดลสำรอง: ใช้เมื่อโมเดลที่เลือกตอบ 429/5xx ซ้ำ (เช่น 503 high demand) เว้นว่างไว้ถ้าไม่ต้องการ
  GEMINI_FALLBACK_MODEL: 'gemini-3.8-flash',
  // ระดับการคิดของโมเดล: 'minimal' (เร็วสุด ถ้าโมเดลไม่รองรับระบบจะลองใหม่แบบ 'low' ให้เอง) / 'low' / 'medium' / 'high'
  GEMINI_THINKING_LEVEL: 'low',

  // คะแนนขั้นต่ำในการจับคู่คำถามกับ FAQ (0-1)
  // ถ้าคะแนนต่ำกว่านี้ ระบบจะส่งคำถามให้ Gemini ช่วยตอบแทน
  MATCH_THRESHOLD: 0.34,

  // ข้อความเมื่อทั้ง FAQ และ Gemini ก็ตอบไม่ได้ (fallback สุดท้าย)
  FALLBACK_MESSAGE: 'ขออภัยค่ะ ระบบยังไม่มีข้อมูลสำหรับคำถามนี้ เจ้าหน้าที่จะติดต่อกลับโดยเร็วที่สุดค่ะ 🙏'
};

function getScriptProps_() {
  return PropertiesService.getScriptProperties();
}

function getLineAccessToken_() {
  return getScriptProps_().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
}

function getLineChannelSecret_() {
  return getScriptProps_().getProperty('LINE_CHANNEL_SECRET');
}

function getGeminiApiKey_() {
  return getScriptProps_().getProperty('GEMINI_API_KEY');
}

function getSpreadsheet_() {
  // ใช้ Spreadsheet ที่ผูกกับสคริปต์นี้ (Container-bound script)
  // ถ้าใช้แบบ Standalone script ให้เปลี่ยนเป็น SpreadsheetApp.openById('SHEET_ID_ที่นี่')
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * ค่า generationConfig สำหรับ Gemini 3.x ใช้ร่วมกันทุกไฟล์
 *  - Gemini 3.x เลิกใช้ temperature และ thinkingBudget -> ใช้ thinkingLevel แทน (3.8 ไม่รองรับ 'minimal' ใช้ 'low' ต่ำสุด)
 *  - โทเคนที่ "คิด" นับรวมใน maxOutputTokens จึงเผื่อเพิ่มให้ ไม่งั้นคำตอบสั้นๆ จะว่างเปล่า
 */
const GEMINI_THINKING_HEADROOM = 1024;
function geminiGenConfig_(maxTokens, asJson) {
  const cfg = {
    maxOutputTokens: maxTokens + GEMINI_THINKING_HEADROOM,
    thinkingConfig: { thinkingLevel: CONFIG.GEMINI_THINKING_LEVEL || 'low' }
  };
  if (asJson) cfg.responseMimeType = 'application/json';
  return cfg;
}


var GEMINI_LAST_MS_ = 0;       // เวลาที่ใช้ของคำขอล่าสุด (มิลลิวินาที) ไว้ดูว่าช้าจริงไหม
var GEMINI_LAST_MODEL_ = '';   // โมเดลที่ตอบคำขอล่าสุด

/**
 * ยิงคำขอ generateContent พร้อมลองใหม่อัตโนมัติ (ใช้ร่วมทุกไฟล์)
 *   fast=true  (งานสั้น/JSON)    : โมเดลเร็ว -> รอ 0.7 วิ -> โมเดลเร็วอีกครั้ง -> โมเดลหลัก -> โมเดลสำรอง
 *   fast=false (เรียบเรียงคำตอบ)  : โมเดลหลัก -> รอ 0.7 วิ -> โมเดลหลักอีกครั้ง -> โมเดลเร็ว -> โมเดลสำรอง
 *   (ชื่อที่ซ้ำกันจะถูกข้าม)
 *   ลองซ้ำเฉพาะ 429 / 500 / 502 / 503 / 504 (ช่วงที่ Google ยุ่ง) ส่วน 400/404 ฯลฯ คืนผลเลย
 * คืน HTTPResponse ตัวสุดท้าย (ผู้เรียกตรวจ getResponseCode() เอง) หรือ null ถ้าไม่มี API key
 */
function geminiPost_(payload, fast) {
  const apiKey = getGeminiApiKey_();
  if (!apiKey) return null;
  const main = CONFIG.GEMINI_MODEL;
  const quick = CONFIG.GEMINI_MODEL_FAST || main;
  const first = fast ? quick : main;
  const other = fast ? main : quick;
  const plan = [first, first];
  [other, CONFIG.GEMINI_FALLBACK_MODEL].forEach(function (m) { if (m && plan.indexOf(m) === -1) plan.push(m); });
  let body = JSON.stringify(payload);
  let res = null;
  for (let i = 0; i < plan.length; i++) {
    if (i === 1) Utilities.sleep(700);
    const t0 = Date.now();
    res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + plan[i] + ':generateContent?key=' + apiKey,
      { method: 'post', contentType: 'application/json', payload: body, muteHttpExceptions: true });
    GEMINI_LAST_MS_ = Date.now() - t0;
    GEMINI_LAST_MODEL_ = plan[i];
    let code = res.getResponseCode();
    console.log('Gemini ' + plan[i] + ' HTTP ' + code + ' ' + GEMINI_LAST_MS_ + ' ms');
    // โมเดลไม่รองรับระดับการคิดที่ตั้งไว้ (เช่น 'minimal') -> ลองใหม่ด้วย 'low' ทันที
    if (code === 400 && /thinking/i.test(res.getContentText()) && payload.generationConfig && payload.generationConfig.thinkingConfig &&
        payload.generationConfig.thinkingConfig.thinkingLevel !== 'low') {
      payload.generationConfig.thinkingConfig.thinkingLevel = 'low';
      body = JSON.stringify(payload);
      const t1 = Date.now();
      res = UrlFetchApp.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + plan[i] + ':generateContent?key=' + apiKey,
        { method: 'post', contentType: 'application/json', payload: body, muteHttpExceptions: true });
      GEMINI_LAST_MS_ = Date.now() - t1;
      code = res.getResponseCode();
      console.log('Gemini ' + plan[i] + ' (thinking=low) HTTP ' + code + ' ' + GEMINI_LAST_MS_ + ' ms');
    }
    if (code === 200 || [429, 500, 502, 503, 504].indexOf(code) === -1) return res;
  }
  return res;
}

/**
 * ทดสอบใน Editor: แสดงรายชื่อโมเดล Gemini ที่ API key นี้เรียกใช้ generateContent ได้จริง (ไม่ส่งอะไรเข้า LINE)
 * ผลอยู่ที่ Executions / View > Logs  ใช้ชื่อที่ขึ้นต้นด้วย gemini- ใส่ใน CONFIG ได้เลย (ไม่ต้องมี "models/")
 */
function listGeminiModels() {
  const apiKey = getGeminiApiKey_();
  if (!apiKey) { console.log('ไม่พบ GEMINI_API_KEY ใน Script Properties'); return; }
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + apiKey, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { console.log('HTTP ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 300)); return; }
  const models = (JSON.parse(res.getContentText()).models || []).filter(function (m) {
    return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1;
  }).map(function (m) { return String(m.name).replace(/^models\//, ''); });
  console.log('โมเดลที่ใช้ generateContent ได้ ' + models.length + ' รุ่น:\n' + models.join('\n'));
}