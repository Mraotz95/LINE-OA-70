/**
 * main.gs
 * จุดรับ Webhook จาก LINE และควบคุมลำดับการทำงานหลักของระบบ Q&A
 *
 * ลำดับการตอบ:
 *   0. ข้อความจากเมนู/การ์ด (ชีต MenuSkip)  -> ไม่ตอบ
 *   1. ตรง trigger ในชีต ImageCards / Images / Cards (เลือกอันที่เจาะจงที่สุด ดู router.gs)
 *        แต่ถ้า keyword ของ FAQ ยาวกว่า (เจาะจงกว่า) ให้ FAQ ชนะ (faqBeatsTopic_ ใน match.gs)
 *        ข้อความที่ตรง trigger ทั้งคำ (เช่นกดปุ่มเมนู) การ์ดชนะเสมอ
 *   2. ตรงกับชีต FAQ                         -> ตอบข้อความ
 *   2.3 คำถามเส้นทาง/วางแผนเดินทาง (travel.gs, ชีต Places + Routes)
 *   2.5 Gemini จัดหมวดหัวข้อ (ชีต Topics)    -> เปิดการ์ด/รูปของหัวข้อที่เลือก (ถ้าติดตั้ง intent.gs)
 *   3. Gemini ช่วยตอบ (อิง FAQ)
 *   4. fallback
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
    if (EVENT_META_.redelivery || (EVENT_META_.delaySec !== null && EVENT_META_.delaySec > STALE_EVENT_SEC)) {
      // ไม่เขียน Log ทีละอีเวนต์ (เคยมีอีเวนต์ซ้ำเป็นร้อย ทำให้ doPost ช้าจน LINE ส่งซ้ำอีก) -> บันทึกสรุปไม่เกิน 1 แถวต่อ 5 นาที
      let first = true;
      try {
        const cache = CacheService.getScriptCache();
        if (cache.get('stale_logged')) first = false; else cache.put('stale_logged', '1', 300);
      } catch (eC) { /* ignore */ }
      if (first) {
        logInteraction_((event.source && event.source.userId) || '',
          (event.message && event.message.text) || (event.postback && event.postback.data) || event.type,
          'SkippedStale', '(ข้าม: อีเวนต์ส่งซ้ำ/มาถึงช้า ' + EVENT_META_.delaySec + ' วิ redelivery=' + EVENT_META_.redelivery + ' reply token หมดอายุแล้ว; ช่วง 5 นาทีนี้จะไม่บันทึกอีเวนต์ที่ข้ามซ้ำอีก)', null);
      }
      return;
    }
    if (isDuplicateEvent_(event)) return;
    handleEvent_(event);
  } catch (err) {
    logError_('handleEvent_', err, event);
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
  if (typeof resetReplyLang_ === 'function') resetReplyLang_(event);

  if (event.type === 'postback') {
    handlePostback_(event);
    return;
  }

  if (event.type !== 'message') return;

  if (event.message.type === 'sticker') {
    handleSticker_(event);
    return;
  }

  if (event.message.type === 'location') {
    if (typeof handleLocationEvent_ === 'function') handleLocationEvent_(event);
    return;
  }

  if (event.message.type !== 'text') return;

  const userId = event.source.userId;
  let userText = event.message.text;
  const replyToken = event.replyToken;

  if (typeof prepareIncomingText_ === 'function') userText = prepareIncomingText_(userId, userText);

  // ขั้นที่ 0: ข้อความจากเมนู/การ์ด (ตรงกับชีต "MenuSkip") ให้ข้ามไปเลย
  const trimmedText = String(userText || '').trim();
  const skipTexts = getMenuSkipTexts_();
  const isMenuTrigger = skipTexts.some(skipText => trimmedText === skipText);
  if (isMenuTrigger) {
    logInteraction_(userId, userText, 'SkippedMenu', '(ไม่ได้ตอบ เพราะเป็นข้อความจากเมนู/การ์ด)', null);
    return;
  }

  // ขั้นที่ 0.3: ถามตามหมวดรถ เช่น "รถหมวด 1" (bus.gs)
  if (typeof handleBusCategory_ === 'function') {
    if (handleBusCategory_(userId, userText, replyToken)) return;
  }

  // ขั้นที่ 0.5: ถ้าบอทเพิ่งถามต้นทางการเดินทางไว้ ให้ถือข้อความนี้เป็นคำตอบ (travel.gs)
  if (typeof hasPendingTrip_ === 'function' && hasPendingTrip_(userId)) {
    if (handleTravelText_(userId, userText, replyToken)) return;
  }

  const faqList = getAllFaq_();

  // ขั้นที่ 1: หาคำตอบที่เจาะจงที่สุดจากทั้งสามชีต (router.gs) แต่ให้ FAQ ชนะถ้า keyword ยาวกว่า
  const match = findBestTopicMatch_(trimmedText);
  if (match && !faqBeatsTopic_(match, userText, faqList)) {
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

  // ขั้นที่ 2: หาคำตอบจาก FAQ (เร็ว ไม่เสียโควตา Gemini)
  const faqMatch = findFaqAnswer_(userText, faqList);
  if (faqMatch) {
    const result = replyMessage_(replyToken, faqMatch.answer);
    logInteraction_(userId, userText, 'FAQ', faqMatch.answer, result);
    return;
  }

  // ขั้นที่ 2.4: คำถามเรื่องภาษาที่รองรับ (i18n.gs)
  if (typeof handleLanguageSupportQuestion_ === 'function') {
    if (handleLanguageSupportQuestion_(userId, userText, replyToken)) return;
  }

  // ขั้นที่ 2.3: คำถามเส้นทาง/วางแผนเดินทาง (travel.gs)
  if (typeof handleTravelText_ === 'function') {
    if (handleTravelText_(userId, userText, replyToken)) return;
  }

  // ขั้นที่ 2.5: ให้ Gemini จัดหมวดหัวข้อ (intent.gs)
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

  // ขั้นที่ 3: Gemini ช่วยตอบโดยอิงข้อมูล FAQ เป็น context เท่านั้น
  const geminiAnswer = askGemini_(userText, faqList);
  if (geminiAnswer) {
    const result = replyMessage_(replyToken, geminiAnswer);
    logInteraction_(userId, userText, 'Gemini', geminiAnswer, result);
    return;
  }

  // ขั้นที่ 4: fallback
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

  if (typeof getRoutes_ === 'function' && typeof replyRouteInfo_ === 'function') {
    const rt = getRoutes_().filter(function (r) { return r.cardId === cardId; })[0];
    if (rt) { replyRouteInfo_(userId, data, event.replyToken, rt); return; }
  }

  const miss = replyMessage_(event.replyToken, 'ขออภัยค่ะ ข้อมูลส่วนนี้ยังไม่พร้อมแสดง กรุณาสอบถามเจ้าหน้าที่ หรือพิมพ์คำถามใหม่อีกครั้งนะคะ 🙏');
  logInteraction_(userId, data, 'PostbackNoCard', '(ไม่พบการ์ดรหัส ' + cardId + ')', miss);
}

/** ทดสอบใน Editor: ดูว่าชีต FAQ มีแถว [สติกเกอร์] ที่ระบบหาเจอหรือไม่ */
function testSticker() {
  const m = findFaqAnswer_(STICKER_KEYWORD, getAllFaq_());
  console.log(m ? ('พบคำตอบสติกเกอร์: ' + m.answer) : 'ไม่พบแถว ' + STICKER_KEYWORD + ' ในชีต FAQ');
}

/** ทดสอบใน Editor: ดูว่าข้อความตัวอย่างจะไปทางการ์ดหรือ FAQ (ไม่ส่งอะไรเข้า LINE) */
function testHandleQuestion() {
  ['จะไปสอบข้อเขียนใบขับขี่ สอบวันไหนได้บ้างครับ', 'ใบขับขี่', 'ผมอยากทำใบขับขี่ครั้งแรกต้องทำอย่างไรบ้างครับ'].forEach(function (t) {
    const faqList = getAllFaq_();
    const m = findBestTopicMatch_(t);
    const f = findFaqAnswer_(t, faqList);
    const winner = (m && !faqBeatsTopic_(m, t, faqList)) ? ('การ์ด ' + (m.item.id || m.item.title)) : (f ? 'FAQ' : 'ไม่ตรงอะไร');
    console.log(t + '  ->  ' + winner +
      ' (การ์ดคะแนน ' + (m ? m.score : '-') + ', FAQ keyword ยาว ' + (f ? f.longest : '-') + ')');
  });
}