/**
 * gemini.gs
 * เรียกใช้ Gemini API เมื่อคำถามไม่ตรงกับ FAQ ที่มีอยู่
 * ใช้แผนฟรีของ Google AI Studio (Gemini 3.8 Flash ตั้งที่ CONFIG.GEMINI_MODEL) — ประมาณ 1,500 คำขอ/วัน, 15 คำขอ/นาที
 */

function buildFaqContext_(faqList) {
  return faqList
    .map(item => `Q: ${item.question}\nA: ${item.answer}`)
    .join('\n\n');
}

/**
 * ส่งคำถามผู้ใช้ให้ Gemini ช่วยตอบ โดยให้ข้อมูล FAQ ทั้งหมดเป็น context
 * เพื่อให้ AI ตอบในขอบเขตข้อมูลที่มีจริงเท่านั้น ไม่ตอบเดาเอง
 * @return {string|null} คำตอบ หรือ null ถ้าไม่มีข้อมูลเพียงพอ/เรียกไม่สำเร็จ
 */
function askGemini_(userText, faqList) {
  const apiKey = getGeminiApiKey_();
  if (!apiKey) {
    console.error('ไม่พบ GEMINI_API_KEY ใน Script Properties');
    return null;
  }

  const context = buildFaqContext_(faqList);
  const prompt = `คุณเป็นแอดมินตอบคำถามของหน่วยงานทางไลน์ ตอบให้สุภาพ กระชับ เป็นภาษาไทย
ใช้ข้อมูลอ้างอิงด้านล่างนี้เท่านั้นในการตอบ ห้ามเดาหรือแต่งข้อมูลขึ้นเอง
ถ้าไม่มีข้อมูลที่เกี่ยวข้องเพียงพอ ให้ตอบคำเดียวว่า "ไม่มีข้อมูล"

=== ข้อมูลอ้างอิง ===
${context}
=== จบข้อมูลอ้างอิง ===

คำถามจากผู้ใช้: ${userText}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: geminiGenConfig_(512, false)
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = geminiPost_(payload);
    const json = JSON.parse(response.getContentText());
    const text = json && json.candidates && json.candidates[0] &&
      json.candidates[0].content && json.candidates[0].content.parts &&
      json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;

    if (!text || text.trim() === 'ไม่มีข้อมูล') return null;
    return text.trim();
  } catch (err) {
    console.error('askGemini_ error: ' + err);
    return null;
  }
}