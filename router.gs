/**
 * router.gs
 * เลือก "คำตอบที่เจาะจงที่สุด" จากทั้งสามชีตพร้อมกัน (ImageCards, Images, Cards)
 * แทนการไล่ทีละชีตตามลำดับ ทำให้เมนูกว้างไม่บังรูปที่เจาะจงกว่า
 *
 * กติกา (เทียบหลังตัดช่องว่าง จุด ขีด ฯลฯ ด้วย normalizeForMatch_):
 *   1. ข้อความตรงกับ trigger ทั้งคำ ("=คำ" หรือคำปกติที่ตรงเป๊ะ)  ชนะการที่มีคำปนอยู่ในประโยคเสมอ
 *   2. ถ้าเป็นแบบมีคำปนอยู่ในประโยค trigger ที่ยาวกว่า (เจาะจงกว่า) ชนะ
 *   3. ถ้าเท่ากัน เรียงตามชีต: ImageCards ก่อน Images ก่อน Cards
 *   trigger แบบ "=คำ" ใช้ได้เฉพาะแบบตรงเป๊ะ ไม่จับคำที่ปนอยู่ในประโยค
 *
 * ใช้ getImageGroups_(), findImageGroupById_() ฯลฯ จาก cards.gs และ getImageRows_() จาก images.gs
 */

function findBestTopicMatch_(userText) {
  const t = normalizeForMatch_(userText);
  if (!t) return null;

  const candidates = [];
  getImageGroups_().forEach(function (g) { candidates.push({ kind: 'imageGroup', item: g, triggers: g.triggers, rank: 0 }); });
  getImageRows_().forEach(function (r) { candidates.push({ kind: 'image', item: r, triggers: r.triggers, rank: 1 }); });
  getCardRows_().forEach(function (c) { candidates.push({ kind: 'card', item: c, triggers: c.triggers, rank: 2 }); });

  let best = null;
  candidates.forEach(function (c) {
    (c.triggers || []).forEach(function (raw) {
      let trig = String(raw || '').trim();
      let exactOnly = false;
      if (trig.charAt(0) === '=') {
        exactOnly = true;
        trig = trig.substring(1);
      }
      trig = normalizeForMatch_(trig);
      if (!trig) return;

      let score = 0;
      if (t === trig) {
        score = 1000 + trig.length;          // ตรงทั้งคำ
      } else if (!exactOnly && t.indexOf(trig) !== -1) {
        score = trig.length;                 // มีคำปนอยู่ในประโยค ยิ่งยาวยิ่งเจาะจง
      }
      if (!score) return;

      if (!best || score > best.score || (score === best.score && c.rank < best.rank)) {
        best = { kind: c.kind, item: c.item, score: score, rank: c.rank };
      }
    });
  });
  return best;
}

/** ทดสอบใน Editor: ดูว่าแต่ละประโยคจะไปที่ไหน (ไม่ส่งอะไรเข้า LINE) */
function debugRouter() {
  [
    'สอบถามต่อพรบ.รถครับ',
    'ขอโอนรถหน่อย',
    'ทะเบียนรถ',
    'ทำใบขับขี่',
    'สวัสดี'
  ].forEach(function (text) {
    const m = findBestTopicMatch_(text);
    const label = m ? (m.kind + ' : ' + (m.item.id || m.item.title) + ' (คะแนน ' + m.score + ')') : 'ไม่ตรงอะไร';
    console.log(text + '  ->  ' + label);
  });
}