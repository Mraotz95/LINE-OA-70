/**
 * main.gs
 * จุดรับ Webhook จาก LINE และควบคุมลำดับการทำงานหลักของระบบ Q&A
 *
 * ลำดับการตอบ:
 *   0. ข้อความจากเมนู/การ์ด (ชีต MenuSkip)  -> ไม่ตอบ
 *   1. ตรง trigger ในชีต ImageCards / Images / Cards (เลือกอันที่เจาะจงที่สุด ดู router.gs)
 *        ImageCards -> การ์ดภาพเลื่อน, Images -> รูปเดี่ยว (บันทึก/แชร์ได้), Cards -> การ์ดข้อความ
 *   2. ตรงกับชีต FAQ                         -> ตอบข้อความ
 *   2.3 คำถามเส้นทาง/วางแผนเดินทาง (travel.gs, ชีต Places + Routes)
 *   2.5 Gemini จัดหมวดหัวข้อ (ชีต Topics)    -> เปิดการ์ด/รูปของหัวข้อที่เลือก (ถ้าติดตั้ง intent.gs)
 *   3. Gemini ช่วยตอบ (อิง FAQ)
 *   4. fallback
 *
 * ความน่าเชื่อถือ (safety.gs):
 *   - อีเวนต์ที่ LINE ส่งซ้ำจะถูกข้าม
 *   - ถ้าประมวลผลข้อความใดพัง จะบันทึกแถว "Error" ลงชีต Log และพยายามตอบข้อความ fallback
 *
 * วิธี Deploy:
 * 1. Deploy > New deployment > เลือกประเภท "Web app"
 * 2. Execute as: Me  /  Who has access: Anyone
 * 3. คัดลอก URL ที่ได้ไปตั้งเป็น Webhook URL ใน LINE Developers Console
 */

function doPost(e) {
  try {
    const rawBody = e.postData.contents;
    const body = JSON.parse(rawBody);
    const events = body.events || [];

    events.forEach(function (event) { safeHandleEvent_(event); });

    return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    logError_('doPost', err, null);
    return ContentService.createTextOutput(JSON.stringify({ status: 'error' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

const STALE_EVENT_SEC = 55; // อีเวนต์เก่ากว่านี้ (วินาที) ไม่ตอบ เพราะ reply token ใช้ไม่ได้แล้ว

/** ครอบการประมวลผลทีละอีเวนต์ ให้อีเวนต์หนึ่งพังแล้วไม่ลากอีเวนต์อื่นพังไปด้วย */
function safeHandleEvent_(event) {
  try {
    EVENT_META_ = {
      delaySec: (event && event.timestamp) ? Math.round((Date.now() - event.timestamp) / 1000) : null,
      redelivery: !!(event && event.deliveryContext && event.deliveryContext.isRedelivery)
    };
    // อีเวนต์ที่ LINE ส่งซ้ำ (isRedelivery) หรือมาถึงช้าเกิน ~1 นาที: รอบแรกตอบไปแล้ว/reply token หมดอายุ -> ข้ามและบันทึกไว้ กันตอบซ้ำสองรอบ
    if (EVENT_META_.redelivery || (EVENT_META_.delaySec !== null && EVENT_META_.delaySec > STALE_EVENT_SEC)) {
      logInteraction_((event.source && event.source.userId) || '',
        (event.message && event.message.text) || (event.postback && event.postback.data) || event.type,
        'SkippedStale', '(ข้าม: อีเวนต์ส่งซ้ำ/มาถึงช้า ' + EVENT_META_.delaySec + ' วิ redelivery=' + EVENT_META_.redelivery + ' reply token หมดอายุแล้ว)', null);
      return;
    }
    if (isDuplicateEvent_(event)) return;
    handleEvent_(event);
  } catch (err) {
    logError_('handleEvent_', err, event);
    // พยายามให้ผู้ใช้ได้ข้อความแทนความเงียบ (ถ้า token ถูกใช้ไปแล้ว LINE จะปฏิเสธเองโดยไม่มีผลเสีย)
    try {
      if (event && event.type === 'message' && event.replyToken) {
        replyMessage_(event.replyToken, CONFIG.FALLBACK_MESSAGE);
      }
    } catch (e2) {
      console.error('ส่งข้อความสำรองไม่สำเร็จ: ' + e2);
    }
  }
}

function handleEvent_(event) {
  // ตั้งภาษาตอบกลับต่ออีเวนต์ (i18n.gs): ข้อความตัวอักษรเริ่มจากไทย, ปุ่มกด/ตำแหน่งใช้ภาษาที่จำไว้
  if (typeof resetReplyLang_ === 'function') resetReplyLang_(event);

  // ปุ่มการ์ดแบบ postback (เช่น card:license) ไม่มีข้อความโผล่ในแชท
  if (event.type === 'postback') {
    handlePostback_(event);
    return;
  }

  if (event.type !== 'message') return;

  // สติกเกอร์: ใช้คำตอบจากชีต FAQ แถวที่ช่องคำถามเป็น [สติกเกอร์] (ถ้าไม่มีแถวนี้ก็เงียบเหมือนเดิม)
  if (event.message.type === 'sticker') {
    handleSticker_(event);
    return;
  }

  // ผู้ใช้แชร์ตำแหน่ง -> ใช้เป็นจุดเริ่มต้นเดินทาง (travel.gs)
  if (event.message.type === 'location') {
    if (typeof handleLocationEvent_ === 'function') handleLocationEvent_(event);
    return;
  }

  // ข้อความประเภทอื่นที่ไม่ใช่ตัวอักษร (รูปภาพ ฯลฯ) ยังไม่รองรับในเวอร์ชันนี้
  if (event.message.type !== 'text') return;

  const userId = event.source.userId;
  let userText = event.message.text;
  const replyToken = event.replyToken;

  // ผู้ใช้พิมพ์ภาษาอื่น (ไม่มีตัวอักษรไทยเลย) -> แปลเป็นไทยแล้วเข้าระบบเดิม คำตอบจะถูกแปลกลับก่อนส่ง
  if (typeof prepareIncomingText_ === 'function') userText = prepareIncomingText_(userId, userText);

  // ขั้นที่ 0: ข้อความจากเมนู/การ์ด (ตรงกับชีต "MenuSkip") ให้ข้ามไปเลย
  const trimmedText = String(userText || '').trim();
  const skipTexts = getMenuSkipTexts_();
  const isMenuTrigger = skipTexts.some(skipText => trimmedText === skipText);
  if (isMenuTrigger) {
    logInteraction_(userId, userText, 'SkippedMenu', '(ไม่ได้ตอบ เพราะเป็นข้อความจากเมนู/การ์ด)', null);
    return;
  }

  // ขั้นที่ 0.3: ถามตามหมวดรถ เช่น "รถหมวด 1" "หมวด 4" -> แสดงรายการสายในหมวดนั้น (bus.gs)
  if (typeof handleBusCategory_ === 'function') {
    if (handleBusCategory_(userId, userText, replyToken)) return;
  }

  // ขั้นที่ 0.5: ถ้าบอทเพิ่งถามต้นทางการเดินทางไว้ ให้ถือข้อความนี้เป็นคำตอบ (travel.gs)
  if (typeof hasPendingTrip_ === 'function' && hasPendingTrip_(userId)) {
    if (handleTravelText_(userId, userText, replyToken)) return;
  }

  // ขั้นที่ 1: หาคำตอบที่เจาะจงที่สุดจากทั้งสามชีต (router.gs)
  //   ImageCards -> การ์ดภาพเลื่อน / Images -> รูปเดี่ยว / Cards -> การ์ดข้อความ
  const match = findBestTopicMatch_(trimmedText);
  if (match) {
    // ถ้าเป็นอินโฟของสายรถ (ชีต Routes) ให้มีข้อความนำก่อน (bus.gs)
    const lead = (typeof busLeadForCardId_ === 'function') ? busLeadForCardId_(match.item.id) : undefined;
    if (match.kind === 'imageGroup') {
      const result = replyImageCarousel_(replyToken, match.item, lead);
      logInteraction_(userId, userText, 'ImageCard', '[การ์ดภาพ] ' + match.item.id, result);
    } else if (match.kind === 'image') {
      const result = replyImageRow_(replyToken, match.item, lead);
      logInteraction_(userId, userText, 'Image', '[รูป] ' + (match.item.id || match.item.url), result);
    } else {
      const result = replyCard_(replyToken, match.item, lead);
      logInteraction_(userId, userText, 'Card', '[การ์ด] ' + match.item.title, result);
    }
    return;
  }

  const faqList = getAllFaq_();

  // ขั้นที่ 2: หาคำตอบจาก FAQ (เร็ว ไม่เสียโควตา Gemini)
  const faqMatch = findFaqAnswer_(userText, faqList);
  if (faqMatch) {
    const result = replyMessage_(replyToken, faqMatch.answer);
    logInteraction_(userId, userText, 'FAQ', faqMatch.answer, result);
    return;
  }

  // ขั้นที่ 2.4: คำถาม "รองรับภาษาอะไรบ้าง/รองรับภาษา...ไหม" (i18n.gs) ตอบทันทีด้วยข้อความคงที่ ไม่เรียก Gemini เพิ่ม
  if (typeof handleLanguageSupportQuestion_ === 'function') {
    if (handleLanguageSupportQuestion_(userId, userText, replyToken)) return;
  }

  // ขั้นที่ 2.3: คำถามเส้นทาง/วางแผนเดินทาง -> ใช้ชีต Places + Routes + Google Maps + Gemini (travel.gs)
  if (typeof handleTravelText_ === 'function') {
    if (handleTravelText_(userId, userText, replyToken)) return;
  }

  // ขั้นที่ 2.5: ให้ Gemini จัดหมวดหัวข้อ (ข้ามอัตโนมัติถ้ายังไม่ได้ติดตั้ง intent.gs)
  if (typeof classifyTopic_ === 'function' && typeof getTopics_ === 'function') {
    const topicId = classifyTopic_(trimmedText, getTopics_());
    if (topicId) {
      const topicReply = replyTopic_(replyToken, topicId);
      if (topicReply) {
        logInteraction_(userId, userText, 'Intent', '[จัดหมวด ' + topicId + '] ' + topicReply.answer, topicReply.result);
        return;
      }
    }
  }

  // ขั้นที่ 3: ไม่เจอใน FAQ ให้ Gemini ช่วยตอบโดยอิงข้อมูล FAQ เป็น context เท่านั้น
  const geminiAnswer = askGemini_(userText, faqList);
  if (geminiAnswer) {
    const result = replyMessage_(replyToken, geminiAnswer);
    logInteraction_(userId, userText, 'Gemini', geminiAnswer, result);
    return;
  }

  // ขั้นที่ 4: ตอบไม่ได้จริง ๆ ส่งข้อความ fallback และบันทึกไว้ตรวจสอบภายหลัง
  const result = replyMessage_(replyToken, CONFIG.FALLBACK_MESSAGE);
  logInteraction_(userId, userText, 'None', CONFIG.FALLBACK_MESSAGE, result);
}

const STICKER_KEYWORD = '[สติกเกอร์]';

/** ตอบสติกเกอร์ด้วยคำตอบจากชีต FAQ (แถวที่ถามว่า [สติกเกอร์]) */
function handleSticker_(event) {
  const userId = event.source.userId;
  const faqMatch = findFaqAnswer_(STICKER_KEYWORD, getAllFaq_());
  if (!faqMatch) {
    logInteraction_(userId, STICKER_KEYWORD, 'None', '(ไม่มีแถว ' + STICKER_KEYWORD + ' ในชีต FAQ จึงไม่ตอบ)', null);
    return;
  }
  const result = replyMessage_(event.replyToken, faqMatch.answer);
  logInteraction_(userId, STICKER_KEYWORD, 'FAQ', faqMatch.answer, result);
}

function handlePostback_(event) {
  const userId = event.source.userId;
  const data = String((event.postback && event.postback.data) || '');
  const m = data.match(/^card=([^&]+)(?:&t=(.*))?$/);
  if (!m) return;
  const cardId = m[1];
  let chosen = '';
  try { chosen = m[2] ? decodeURIComponent(m[2]) : ''; } catch (e) { chosen = ''; }

  // รหัสเดียวกัน (card:รหัส) เรียกได้ทั้งการ์ดข้อความ, ชุดการ์ดภาพ และรูปเดี่ยว
  const card = findCardById_(cardId);
  if (card) {
    const result = replyCard_(event.replyToken, card, chosen);
    logInteraction_(userId, data, 'Card', '[การ์ด] ' + card.title, result);
    return;
  }

  const group = findImageGroupById_(cardId);
  if (group) {
    const gResult = replyImageCarousel_(event.replyToken, group, chosen);
    logInteraction_(userId, data, 'ImageCard', '[การ์ดภาพ] ' + group.id, gResult);
    return;
  }

  const imageRow = findImageById_(cardId);
  if (imageRow) {
    const iResult = replyImageRow_(event.replyToken, imageRow, chosen);
    logInteraction_(userId, data, 'Image', '[รูป] ' + imageRow.id, iResult);
    return;
  }

  // สายรถที่มีรหัสการ์ดแต่ยังหาอินโฟไม่เจอ -> สรุปจากชีต Routes แทนการเงียบ (bus.gs)
  if (typeof getRoutes_ === 'function' && typeof replyRouteInfo_ === 'function') {
    const rt = getRoutes_().filter(function (r) { return r.cardId === cardId; })[0];
    if (rt) { replyRouteInfo_(userId, data, event.replyToken, rt); return; }
  }

  // ไม่พบจริงๆ: ตอบผู้ใช้สั้นๆ (ไม่ปล่อยให้กดแล้วเงียบ) และบันทึกไว้ให้ผู้ดูแลตรวจ (รัน checkRouteCards() ใน Editor)
  const miss = replyMessage_(event.replyToken, 'ขออภัยค่ะ ข้อมูลส่วนนี้ยังไม่พร้อมแสดง กรุณาสอบถามเจ้าหน้าที่ หรือพิมพ์คำถามใหม่อีกครั้งนะคะ 🙏');
  logInteraction_(userId, data, 'PostbackNoCard', '(ไม่พบการ์ดรหัส ' + cardId + ')', miss);
}

/** ทดสอบใน Editor: ดูว่าชีต FAQ มีแถว [สติกเกอร์] ที่ระบบหาเจอหรือไม่ (ไม่ส่งอะไรเข้า LINE) */
function testSticker() {
  const m = findFaqAnswer_(STICKER_KEYWORD, getAllFaq_());
  console.log(m ? ('พบคำตอบสติกเกอร์: ' + m.answer) : 'ไม่พบแถว ' + STICKER_KEYWORD + ' ในชีต FAQ');
}

/**
 * ฟังก์ชันทดสอบ: รันจาก Apps Script Editor เพื่อเช็ก flow การจับคู่
 * โดยไม่ต้องส่งข้อความจาก LINE จริง
 */
function testHandleQuestion() {
  const testText = 'เปิดทำการวันไหนบ้าง';
  const m = findBestTopicMatch_(testText);
  if (m) {
    console.log('พบ ' + m.kind + ': ' + (m.item.id || m.item.title || m.item.url));
    return;
  }
  const match = findFaqAnswer_(testText, getAllFaq_());
  console.log(match ? ('พบใน FAQ: ' + match.answer) : 'ไม่พบใน FAQ จะส่งให้ Gemini ช่วยตอบต่อ');
}