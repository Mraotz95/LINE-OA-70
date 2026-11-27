/**
 * match.gs
 * จับคู่คำถามของผู้ใช้กับฐาน FAQ ด้วยการเทียบ keyword
 * ทำก่อนเสมอเพื่อความเร็วและประหยัดโควตา Gemini — เรียก Gemini เฉพาะกรณีหาไม่เจอเท่านั้น
 *
 * หลักการ:
 *  - keyword แต่ละคำในแถวเดียวกันเป็น "คำที่ใช้แทนกันได้" พบคำใดคำหนึ่งถือว่าแถวนั้นตรง
 *  - ถ้าผู้ใช้ถามหลายเรื่องในข้อความเดียว จะตอบทุกหัวข้อที่ตรง (สูงสุด MAX_FAQ_ANSWERS)
 *    เรียงตามลำดับที่ผู้ใช้พิมพ์
 *  - แถวที่ keyword เป็นส่วนหนึ่งของ keyword ของแถวที่เลือกไปแล้ว จะไม่ตอบซ้ำ
 */

const MAX_FAQ_ANSWERS = 3;

function normalizeText_(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

/**
 * ตรวจว่าแถว FAQ นี้ตรงกับข้อความผู้ใช้ไหม
 * @return {{longest: number, hits: number, kw: string, pos: number}}
 */
function matchInfo_(userText, faqItem) {
  const normalizedUser = normalizeText_(userText);
  if (!normalizedUser) return { longest: 0, hits: 0, kw: '', pos: 0 };

  const keywordPool = faqItem.keywords.length > 0
    ? faqItem.keywords
    : [faqItem.question]; // ถ้าไม่ได้กรอก keyword ไว้ ให้ใช้ตัวคำถามเองแทน

  let longest = 0;
  let hits = 0;
  let kw = '';
  keywordPool.forEach(k => {
    const nk = normalizeText_(k);
    if (nk && normalizedUser.indexOf(nk) !== -1) {
      hits++;
      if (nk.length > longest) {
        longest = nk.length;
        kw = nk;
      }
    }
  });

  return { longest: longest, hits: hits, kw: kw, pos: kw ? normalizedUser.indexOf(kw) : 0 };
}

/**
 * คงไว้เพื่อให้โค้ดเดิมที่เรียกใช้ยังทำงานได้: คืน 1 ถ้าพบ keyword ใดก็ตาม ไม่พบคืน 0
 */
function scoreMatch_(userText, faqItem) {
  return matchInfo_(userText, faqItem).hits > 0 ? 1 : 0;
}

/**
 * หาคำตอบจาก FAQ ทั้งหมดที่ตรงกับข้อความ (หลายหัวข้อรวมเป็นข้อความเดียว)
 * @return {{answer: string, question: string, score: number}|null}
 */
function findFaqAnswer_(userText, faqList) {
  const candidates = [];
  faqList.forEach(item => {
    const info = matchInfo_(userText, item);
    if (info.hits > 0) candidates.push({ item: item, info: info });
  });
  if (!candidates.length) return null;

  // เจาะจงที่สุดก่อน (keyword ยาวสุด, พบหลายคำกว่า)
  candidates.sort((a, b) => (b.info.longest - a.info.longest) || (b.info.hits - a.info.hits));

  const selected = [];
  for (let i = 0; i < candidates.length && selected.length < MAX_FAQ_ANSWERS; i++) {
    const c = candidates[i];
    const covered = selected.some(s =>
      s.info.kw.indexOf(c.info.kw) !== -1 || s.item.answer === c.item.answer
    );
    if (!covered) selected.push(c);
  }

  // เรียงตามลำดับที่ผู้ใช้พิมพ์ถามมา
  selected.sort((a, b) => a.info.pos - b.info.pos);

  return {
    answer: selected.map(s => s.item.answer).join('\n\n'),
    question: selected.map(s => s.item.question).join(' / '),
    score: 1
  };
}