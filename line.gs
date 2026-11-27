/**
 * line.gs
 * ส่งข้อความตัวอักษรกลับด้วย Reply API
 * (ฟังก์ชันบันทึก Log อยู่ใน log.gs เท่านั้น ไม่ประกาศซ้ำที่นี่)
 * ถ้าผู้ใช้พิมพ์ภาษาต่างประเทศมา localizeMessages_() (i18n.gs) จะแปลข้อความก่อนส่ง
 */

function replyMessage_(replyToken, text) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getLineAccessToken_() },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: localizeMessages_([{ type: 'text', text: String(text).substring(0, 5000) }])
    }),
    muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), body: res.getContentText() };
}