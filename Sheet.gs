/**
 * sheet.gs
 * การเข้าถึงฐานข้อมูล FAQ และรายการ "ข้อความจากเมนู/การ์ด" ใน Google Sheets
 * โครงสร้างชีต "FAQ": คอลัมน์ A=Keywords(คั่นด้วย ,)  B=คำถาม  C=คำตอบ  D=หมวดหมู่
 * โครงสร้างชีต "MenuSkip": คอลัมน์ A=ข้อความจากเมนู/การ์ด (ตรงตัว)
 */

function getFaqSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME_FAQ);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME_FAQ);
    sheet.appendRow(['Keywords (คั่นด้วย ,)', 'คำถาม', 'คำตอบ', 'หมวดหมู่']);
  }
  return sheet;
}

/**
 * ดึงรายการ FAQ ทั้งหมดเป็น array ของ object
 * @return {Array<{keywords: string[], question: string, answer: string, category: string}>}
 */
function getAllFaq_() {
  const sheet = getFaqSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  return data
    .filter(row => row[1] && row[2]) // ต้องมีทั้งคำถามและคำตอบ
    .map(row => ({
      keywords: String(row[0] || '').split(',').map(k => k.trim()).filter(Boolean),
      question: String(row[1]).trim(),
      answer: String(row[2]).trim(),
      category: String(row[3] || '').trim()
    }));
}

function getMenuSkipSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME_MENU_SKIP);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME_MENU_SKIP);
    sheet.appendRow(['ข้อความจากเมนู/การ์ด (ตรงตัว)']);
  }
  return sheet;
}

/**
 * ดึงรายการข้อความที่มาจากการกดเมนู/การ์ด ซึ่งไม่ต้องการให้ระบบตอบกลับ
 * เพิ่ม/ลบรายการได้จากชีต "MenuSkip" โดยตรง ไม่ต้องแก้โค้ด
 * @return {string[]}
 */
function getMenuSkipTexts_() {
  const sheet = getMenuSkipSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  return data
    .map(row => String(row[0] || '').trim())
    .filter(Boolean);
}