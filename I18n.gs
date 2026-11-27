/**
 * i18n.gs
 * รองรับผู้ใช้ที่พิมพ์ภาษาอื่นนอกจากไทย
 *
 * กติกา
 *   - ข้อความที่มีตัวอักษรไทยอยู่ด้วย (แม้ปนภาษาอื่น เช่น "รถ Bus สายที่") -> ถือเป็นภาษาไทย ไม่แปล
 *   - ข้อความที่ไม่มีตัวอักษรไทยเลยและมีตัวอักษรภาษาใดภาษาหนึ่ง (เช่น "Hi! I want to go...") ->
 *       1) Gemini ตรวจภาษา + แปลเป็นภาษาไทย (1 คำขอ)  แล้วเข้าระบบเดิมตามปกติ
 *       2) ก่อนส่งคำตอบกลับ ระบบแปลข้อความทั้งหมดในคำตอบ (ข้อความ ชื่อปุ่ม ข้อความในการ์ด) เป็นภาษาของผู้ใช้ (1 คำขอ)
 *   - ตัวเลข/สัญลักษณ์/อีโมจิล้วน (เช่น "79") ไม่ถือเป็นภาษาอื่น
 *   - จำภาษาของผู้ใช้ไว้ 30 นาที เพื่อให้การกดปุ่มการ์ด/แชร์ตำแหน่ง (ซึ่งไม่มีข้อความ) ตอบเป็นภาษาเดิม
 *   - ถ้า Gemini แปลไม่สำเร็จ จะส่งคำตอบภาษาไทยตามเดิม
 *
 * ต้องมี callGeminiTravel_() (travel.gs)
 * ใช้โควตา Gemini เพิ่ม 2 คำขอต่อข้อความภาษาต่างประเทศ
 */

var REPLY_LANG_ = '';      // ภาษาที่ต้องตอบกลับ (ว่าง = ไทย)
var ORIGINAL_TEXT_ = '';   // ข้อความต้นฉบับของผู้ใช้ (ไว้บันทึก Log)
const LANG_CACHE_TTL = 1800;

function isForeignText_(text) {
  const s = String(text || '');
  if (/[\u0E00-\u0E7F]/.test(s)) return false; // มีตัวอักษรไทย -> ยึดภาษาไทย
  return /\p{L}/u.test(s);
}

function getUserLang_(userId) {
  try { return CacheService.getScriptCache().get('lang_' + userId) || ''; } catch (e) { return ''; }
}
function setUserLang_(userId, lang) {
  try { CacheService.getScriptCache().put('lang_' + userId, lang, LANG_CACHE_TTL); } catch (e) { /* ignore */ }
}
function clearUserLang_(userId) {
  try { CacheService.getScriptCache().remove('lang_' + userId); } catch (e) { /* ignore */ }
}

/** เรียกต้นทุกอีเวนต์: ข้อความตัวอักษรเริ่มจากไทย, ปุ่มกด/ตำแหน่ง/สติกเกอร์ใช้ภาษาที่จำไว้ */
function resetReplyLang_(event) {
  REPLY_LANG_ = '';
  ORIGINAL_TEXT_ = '';
  const isText = event && event.type === 'message' && event.message && event.message.type === 'text';
  if (!isText && event && event.source && event.source.userId) {
    REPLY_LANG_ = getUserLang_(event.source.userId);
  }
}

/** ข้อความตัวอักษรขาเข้า: ถ้าเป็นภาษาอื่นคืนคำแปลไทย (และตั้งภาษาตอบกลับ) ไม่ใช่คืนข้อความเดิม */
function prepareIncomingText_(userId, text) {
  REPLY_LANG_ = '';
  ORIGINAL_TEXT_ = '';
  if (!isForeignText_(text)) {
    clearUserLang_(userId);
    return text;
  }
  const prompt =
    'ผู้ใช้ส่งข้อความมาถามเจ้าหน้าที่ขนส่งจังหวัดบึงกาฬ (เรื่องรถโดยสาร เส้นทาง การท่องเที่ยว การต่อภาษี ใบขับขี่ ฯลฯ)\n' +
    'ตรวจภาษาของข้อความ แล้วแปลเป็นภาษาไทยที่เป็นธรรมชาติ ชื่อสถานที่ในไทยให้ใช้ชื่อภาษาไทยที่ถูกต้อง\n' +
    'ตอบเป็น JSON เท่านั้น: {"lang":"ชื่อภาษาของข้อความผู้ใช้เป็นภาษาอังกฤษ เช่น English, Chinese, Japanese ถ้าเป็นภาษาไทยที่เขียนด้วยตัวอักษรโรมันให้ใส่ Thai","thai":"คำแปลภาษาไทย"}\n\n' +
    'ข้อความผู้ใช้: ' + text;
  const raw = callGeminiTravel_(prompt, 600, true);
  if (!raw) {
    logInteraction_(userId, text, 'I18nError', 'แปลเข้าไม่สำเร็จ (ตอบเป็นไทยตามเดิม): ' + GEMINI_LAST_ERROR_ + ' [' + GEMINI_LAST_MODEL_ + ' ' + GEMINI_LAST_MS_ + ' ms]', null);
    return text;
  }
  try {
    const m = String(raw).match(/\{[\s\S]*\}/); // ดึงเฉพาะก้อน {...} เผื่อมีข้อความหรือ ``` ล้อมมา
    const o = JSON.parse(m ? m[0] : raw);
    const lang = String(o.lang || '').trim();
    const thai = String(o.thai || '').trim();
    if (!thai) {
      logInteraction_(userId, text, 'I18nError', 'Gemini ไม่ส่งคำแปลไทยกลับมา: ' + String(raw).substring(0, 200), null);
      return text;
    }
    if (!lang || /^thai/i.test(lang)) { clearUserLang_(userId); return thai; }
    REPLY_LANG_ = lang;
    ORIGINAL_TEXT_ = text;
    setUserLang_(userId, lang);
    return thai;
  } catch (e) {
    console.error('prepareIncomingText_ error: ' + e);
    logInteraction_(userId, text, 'I18nError', 'อ่านผลแปลไม่ได้ (' + e + '): ' + String(raw).substring(0, 200), null);
    return text;
  }
}

/* ---------- แปลคำตอบขาออก ---------- */

function addActionRefs_(action, refs) {
  if (!action || typeof action !== 'object') return;
  if (typeof action.label === 'string' && action.label.trim()) refs.push({ obj: action, key: 'label', max: 20 });
  // ปุ่มแบบ message: ข้อความที่ผู้ใช้จะส่งกลับมา แปลด้วย เพื่อให้ผ่านขั้นแปลขาเข้ากลับเป็นไทยได้
  if (action.type === 'message' && typeof action.text === 'string' && action.text.trim()) {
    refs.push({ obj: action, key: 'text', max: 300 });
  }
}

function collectRefs_(node, refs) {
  if (Array.isArray(node)) { node.forEach(function (n) { collectRefs_(n, refs); }); return; }
  if (!node || typeof node !== 'object') return;
  if (node.type === 'text' && typeof node.text === 'string' && node.text.trim()) refs.push({ obj: node, key: 'text', max: 5000 });
  if (typeof node.altText === 'string' && node.altText.trim()) refs.push({ obj: node, key: 'altText', max: 400 });
  if (node.action) addActionRefs_(node.action, refs);
  if (node.quickReply && node.quickReply.items) {
    node.quickReply.items.forEach(function (it) { if (it && it.action) addActionRefs_(it.action, refs); });
  }
  ['contents', 'header', 'hero', 'body', 'footer'].forEach(function (k) { if (node[k]) collectRefs_(node[k], refs); });
}

function trCacheKey_(text) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, REPLY_LANG_ + '|' + text, Utilities.Charset.UTF_8);
  return 'tr_' + d.map(function (x) { return ('0' + (x & 0xff).toString(16)).slice(-2); }).join('');
}

/**
 * แปลทุกข้อความในอาร์เรย์ messages (แก้ในที่เดิม) เป็นภาษาของผู้ใช้
 *  - ผลแปลถูกแคชไว้ 6 ชั่วโมง (ภาษา+ข้อความ) คำตอบที่เคยแปลแล้ว เช่นอินโฟสายรถ จึงไม่ต้องเรียก Gemini ซ้ำ ทั้งเร็วและประหยัดโควตา
 *  - ถ้าไม่ใช่ภาษาต่างประเทศ/แปลไม่สำเร็จ คืนของเดิม (ภาษาไทย)
 */
function localizeMessages_(messages) {
  if (!REPLY_LANG_) return messages;
  try {
    const refs = [];
    collectRefs_(messages, refs);
    if (!refs.length) return messages;
    const src = refs.map(function (r) { return r.obj[r.key]; });
    const keys = src.map(trCacheKey_);

    let cache = null, cached = {};
    try { cache = CacheService.getScriptCache(); cached = cache.getAll(keys.filter(function (k, i) { return keys.indexOf(k) === i; })) || {}; } catch (e) { cached = {}; }

    // ตัวที่ยังไม่มีในแคช (ตัดซ้ำ)
    const todo = [];
    src.forEach(function (s, i) { if (!cached[keys[i]] && todo.indexOf(s) === -1) todo.push(s); });

    const fresh = {};
    if (todo.length) {
      const prompt =
        'แปลข้อความภาษาไทยในอาร์เรย์ JSON ด้านล่างเป็นภาษา ' + REPLY_LANG_ + ' (ผู้ใช้พิมพ์ภาษานี้มา) ตอบเป็นอาร์เรย์ JSON ที่มีจำนวนและลำดับเท่าเดิมเท่านั้น\n' +
        'กติกา: คงตัวเลข ลิงก์ เบอร์โทร อีโมจิ เลขสายรถ และการขึ้นบรรทัดใหม่ไว้ตามเดิม ห้ามเพิ่มหรือตัดเนื้อหา\n' +
        '- ชื่อสถานที่ในไทยให้เขียนชื่อที่อ่านออกเสียงด้วยตัวอักษรของภาษานั้น แล้วใส่ชื่อไทยในวงเล็บตามหลัง (ยกเว้นข้อความที่ยาวไม่เกิน 20 ตัวอักษร ให้แปลสั้นๆ ไม่ต้องใส่ไทย)\n' +
        '- ข้อความที่สั้นเป็นชื่อปุ่ม (มีเลขแทรก เช่น "สาย 79") ต้องแปลให้สั้นไม่เกิน 20 ตัวอักษร\n\n' +
        JSON.stringify(todo);
      const raw = callGeminiTravel_(prompt, 4096, true);
      if (!raw) {
        logInteraction_('', ORIGINAL_TEXT_, 'I18nError', 'แปลคำตอบกลับไม่สำเร็จ (ส่งเป็นไทย): ' + GEMINI_LAST_ERROR_ + ' [' + GEMINI_LAST_MODEL_ + ' ' + GEMINI_LAST_MS_ + ' ms]', null);
      } else {
        const m = String(raw).match(/\[[\s\S]*\]/);
        let out = null;
        try { out = JSON.parse(m ? m[0] : raw); } catch (e) { out = null; }
        if (!Array.isArray(out) || out.length !== todo.length) {
          logInteraction_('', ORIGINAL_TEXT_, 'I18nError', 'ผลแปลกลับมาผิดรูปแบบ (ส่งเป็นไทย): ' + String(raw).substring(0, 200), null);
        } else {
          const toCache = {};
          todo.forEach(function (s, i) {
            const v = String(out[i] === null || out[i] === undefined ? '' : out[i]).trim();
            if (v) { fresh[s] = v; toCache[trCacheKey_(s)] = v; }
          });
          try { if (cache && Object.keys(toCache).length) cache.putAll(toCache, 21600); } catch (e) { /* ignore */ }
        }
      }
    }

    refs.forEach(function (r, i) {
      const v = cached[keys[i]] || fresh[src[i]];
      if (v) r.obj[r.key] = String(v).substring(0, r.max);
    });
  } catch (e) {
    console.error('localizeMessages_ error: ' + e);
  }
  return messages;
}

/* =====================================================================
 * ตอบคำถาม "รองรับภาษาอะไรบ้าง / รองรับภาษา...ไหม"
 *   - ทำงานหลัง FAQ (admin เพิ่มแถวใน FAQ เองเพื่อตอบแทนได้เสมอ) และก่อนระบบเดินทาง/จัดหมวด
 *   - ตรวจจากข้อความ "ไทย" แล้ว (ถ้าผู้ใช้ถามเป็นภาษาอื่น ข้อความจะถูกแปลเป็นไทยไว้แล้วตั้งแต่ prepareIncomingText_)
 *     คำตอบที่ส่งออกจะถูก localizeMessages_() แปลกลับเป็นภาษาของผู้ใช้ให้อัตโนมัติเหมือนคำตอบอื่นๆ
 *   - เป็นการจับคู่แบบ keyword ง่ายๆ ไม่ได้ฉลาดมาก ถ้าอยากเพิ่ม/ตัดรูปแบบประโยค แก้ที่อาร์เรย์ LANG_SUPPORT_PATTERNS_ ด้านล่างนี้ได้เลย
 * ===================================================================== */

const LANG_SUPPORT_PATTERNS_ = [
  /รองรับภาษา/,           // "ระบบรองรับภาษาอะไรบ้าง", "รองรับภาษาอังกฤษไหม"
  /ภาษาอะไรบ้าง/,          // "มีภาษาอะไรบ้าง", "ตอบได้กี่ภาษา" (ดูแพทเทิร์นถัดไป)
  /ตอบได้กี่ภาษา/,
  /พูดภาษา[^ๆ]{0,15}ได้ไหม/,   // "พูดภาษาอังกฤษได้ไหม"
  /คุย(?:เป็น)?ภาษา[^ๆ]{0,15}ได้ไหม/,   // "คุยภาษาจีนได้ไหม" / "คุยเป็นภาษาญี่ปุ่นได้ไหม"
  /ตอบภาษา[^ๆ]{0,15}ได้ไหม/,   // "ตอบภาษาญี่ปุ่นได้ไหม"
  /แชทภาษา[^ๆ]{0,15}ได้ไหม/,
  /ใช้ภาษาอื่น[^ๆ]{0,10}ได้ไหม/,
  /support(s|ed|ing)?\s+(what\s+)?language/i,  // เผื่อข้อความอังกฤษหลุดมา (แปลไม่สำเร็จ)
  /what\s+language/i,
  /which\s+language/i
];

/** คืน true ถ้าข้อความ (ไทยแล้ว) เป็นคำถามว่าระบบรองรับภาษาอะไรบ้าง */
function isLanguageSupportQuestion_(text) {
  const t = normalizeForMatch_(text);
  const raw = String(text || '');
  return LANG_SUPPORT_PATTERNS_.some(function (re) { return re.test(t) || re.test(raw); });
}

/** คำตอบแบบทั่วไป: ใช้เมื่อถามกว้างๆ ว่า "รองรับภาษาอะไรบ้าง" โดยไม่ได้เจาะจงชื่อภาษา */
const LANG_SUPPORT_GENERIC_ANSWER_ =
  'ระบบนี้ไม่ได้จำกัดเฉพาะบางภาษานะคะ พิมพ์มาเป็นภาษาอะไรก็ได้ เช่น อังกฤษ จีน ญี่ปุ่น เกาหลี เวียดนาม ลาว ฝรั่งเศส ฯลฯ ' +
  'ระบบจะตรวจจับภาษาที่คุณพิมพ์มาโดยอัตโนมัติ แล้วแปลคำตอบกลับเป็นภาษาเดียวกับที่คุณพิมพ์มาให้ทันทีค่ะ\n\n' +
  '(ข้อยกเว้น: ถ้าข้อความมีภาษาไทยปนอยู่ด้วย เช่น "รถ Bus สายไหน" ระบบจะยึดภาษาไทยเป็นหลักและตอบเป็นภาษาไทยค่ะ)';

/** ชื่อภาษาทั่วไป (ไม่ใช่ชื่อภาษาเฉพาะ) ที่ไม่ควรถูกจับว่าเป็น "ชื่อภาษา" ที่ผู้ใช้เจาะจงถาม */
const LANG_SUPPORT_EXCLUDE_WORDS_ = ['อะไร', 'อื่น', 'อื่นๆ', 'ไหน', 'บ้าง', 'เพิ่ม', 'ด้วย', 'นี้', 'นั้น', 'ใด', 'ใดบ้าง'];

/**
 * ถ้าข้อความเจาะจงชื่อภาษา (เช่น "พูดภาษาจีนได้ไหม", "รองรับภาษาอังกฤษไหม") คืนชื่อภาษานั้น
 * (ไม่ใส่ \s ระหว่าง "ภาษา" กับชื่อ เพราะภาษาไทยปกติไม่มีช่องว่างระหว่างคำ)
 * คืน null ถ้าเป็นคำถามกว้างๆ ("รองรับภาษาอะไรบ้าง") หรือจับชื่อภาษาไม่ได้
 */
function extractSpecificLanguage_(text) {
  const t = String(text || '');
  const patterns = [
    /พูดภาษา([\u0E00-\u0E7Fa-zA-Z]{1,15}?)ได้ไหม/,
    /คุย(?:เป็น)?ภาษา([\u0E00-\u0E7Fa-zA-Z]{1,15}?)ได้ไหม/,
    /ตอบภาษา([\u0E00-\u0E7Fa-zA-Z]{1,15}?)ได้ไหม/,
    /แชทภาษา([\u0E00-\u0E7Fa-zA-Z]{1,15}?)ได้ไหม/,
    /ใช้ภาษา([\u0E00-\u0E7Fa-zA-Z]{1,15}?)ได้(?:ไหม|หรือไม่)/,
    /รองรับภาษา([\u0E00-\u0E7Fa-zA-Z]{1,15}?)(?:ได้)?ไหม/
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = t.match(patterns[i]);
    if (m && m[1]) {
      const name = m[1].trim();
      if (name && LANG_SUPPORT_EXCLUDE_WORDS_.indexOf(name) === -1) return name;
    }
  }
  return null;
}

/**
 * ตอบคำถามเรื่องภาษาที่รองรับ คืน true ถ้าตอบแล้ว (ให้ main.gs return ทันที)
 *  - ถามกว้างๆ ("รองรับภาษาอะไรบ้าง") -> ตอบแบบทั่วไป (LANG_SUPPORT_GENERIC_ANSWER_)
 *  - เจาะจงชื่อภาษา ("พูดภาษาจีนได้ไหม") -> ตอบ "ได้ค่ะ รองรับภาษา<ชื่อ>..." ระบุชื่อภาษานั้นตรงๆ
 * คำตอบเป็นข้อความคงที่ ไม่เรียก Gemini เพิ่ม (การแปลกลับเป็นภาษาผู้ใช้เกิดใน replyMessage_ อยู่แล้ว)
 */
function handleLanguageSupportQuestion_(userId, text, replyToken) {
  if (!isLanguageSupportQuestion_(text)) return false;
  const lang = extractSpecificLanguage_(text);
  const answer = lang
    ? ('ได้ค่ะ ระบบรองรับภาษา' + lang + 'ค่ะ ระบบจะตรวจจับภาษาที่คุณพิมพ์มาโดยอัตโนมัติ แล้วแปลคำตอบกลับเป็นภาษาเดียวกับที่คุณพิมพ์มาให้ทันทีค่ะ\n\n' +
         '(ข้อยกเว้น: ถ้าข้อความมีภาษาไทยปนอยู่ด้วย เช่น "รถ Bus สายไหน" ระบบจะยึดภาษาไทยเป็นหลักและตอบเป็นภาษาไทยค่ะ)')
    : LANG_SUPPORT_GENERIC_ANSWER_;
  const result = replyMessage_(replyToken, answer);
  logInteraction_(userId, text, 'LangSupport', answer, result);
  return true;
}

/** ทดสอบใน Editor (ไม่ส่งเข้า LINE) */
function debugI18n() {
  ['รถ Bus สายที่ 79', 'Hi! I want to go to Phu Thok', '79', '我想去武吐', 'sawasdee krub'].forEach(function (t) {
    console.log(t + ' -> ภาษาอื่น: ' + isForeignText_(t));
  });
  const th = prepareIncomingText_('debug_user', 'Hi! I want to go to Phu Thok by bus');
  console.log('แปลเป็นไทย: ' + th + ' | ภาษาตอบกลับ: ' + REPLY_LANG_ + ' | ' + GEMINI_LAST_MODEL_ + ' ' + GEMINI_LAST_MS_ + ' ms');
  const msgs = [{ type: 'text', text: 'สาย 79 ผ่านภูทอกค่ะ 🚌', quickReply: { items: [{ type: 'action', action: { type: 'location', label: 'แชร์ตำแหน่ง' } }] } }];
  console.log(JSON.stringify(localizeMessages_(msgs)));
  clearUserLang_('debug_user');
  REPLY_LANG_ = '';
}

/** ทดสอบใน Editor: เช็กว่าประโยคตัวอย่างถูกจับเป็นคำถาม "รองรับภาษาอะไรบ้าง" หรือไม่ (ไม่ส่งเข้า LINE) */
function debugLanguageSupportQuestion() {
  [
    ['ระบบคุณรองรับภาษาอะไรบ้าง', true, null],
    ['รองรับภาษาจีนไหม', true, 'จีน'],
    ['พูดภาษาอังกฤษได้ไหม', true, 'อังกฤษ'],
    ['คุยเป็นภาษาญี่ปุ่นได้ไหม', true, 'ญี่ปุ่น'],
    ['รองรับภาษาอื่นไหม', true, null],   // "อื่น" ไม่ใช่ชื่อภาษา -> ตอบแบบทั่วไป ไม่ใช่เจาะจง
    ['What languages do you support?', true, null],
    ['จะไปปู่อือลือต้องขึ้นรถสายไหน', false, null],
    ['มีรถไปอุดรไหม', false, null]
  ].forEach(function (c) {
    const got = isLanguageSupportQuestion_(c[0]);
    const lang = got ? extractSpecificLanguage_(c[0]) : null;
    const ok = got === c[1] && lang === c[2];
    console.log((ok ? '✓ ' : '✗ ') + c[0] + ' -> รองรับคำถามนี้=' + got + ' ชื่อภาษาที่จับได้=' + lang + ' (คาดไว้ ' + c[1] + ' / ' + c[2] + ')');
  });
}