/**
 * travel.gs
 * ผู้ช่วยบอกเส้นทาง / วางแผนเดินทางในจังหวัดบึงกาฬ (ใช้ Gemini ช่วยตีความและเรียบเรียงคำตอบ)
 *
 * หลักการ: "ข้อมูลจริง" มาจากชีต ส่วน AI ทำหน้าที่ตีความคำถามและเรียบเรียงเท่านั้น (ไม่แต่งข้อมูลเอง)
 *   - ชีต Places : สถานที่ (พิกัด เวลาเปิด ค่าเข้าชม เวลาที่ควรใช้เที่ยว)
 *   - ชีต Routes : สายรถโดยสารที่วิ่งในจังหวัด (ต้นทาง ปลายทาง จุดผ่าน เวลา ค่าโดยสาร)
 *   - ระยะทาง/เวลาขับรถ คำนวณจาก Google Maps (บริการ Maps ใน Apps Script ฟรี)
 *
 * ลำดับการทำงาน
 *   1. ผู้ใช้ถามทาง  -> ถ้ายังไม่รู้ต้นทาง บอทขอให้แชร์ตำแหน่ง (ปุ่ม Quick Reply) หรือพิมพ์ชื่อจุดเริ่มต้น
 *   2. ได้ต้นทาง    -> คำนวณระยะทาง/เวลา + ให้ Gemini เทียบกับชีต Routes แล้วตอบ
 *   ใช้ Gemini 1-2 คำขอต่อคำถาม  (ถ้าถามสั้นๆ ว่า "ไปภูทอกยังไง" จะใช้เพียง 1 คำขอ)
 *
 * ต้องมี: getSpreadsheet_(), getGeminiApiKey_(), getLineAccessToken_(), CONFIG.GEMINI_MODEL,
 *         normalizeForMatch_() (safety.gs)
 * ครั้งแรกต้องรัน authorizeMaps() จาก Editor เพื่ออนุญาตการใช้ Google Maps
 */

const PLACES_SHEET_NAME = 'Places';
const ROUTES_SHEET_NAME = 'Routes';
const TRAVEL_PENDING_TTL = 900;      // วินาที: จำคำถาม/ตำแหน่งของผู้ใช้ไว้ 15 นาที
const TRAVEL_REGION_HINT = 'บึงกาฬ';  // ต่อท้ายตอนค้นหาพิกัดจากชื่อ เพื่อให้ได้สถานที่ในจังหวัด
const TRAVEL_MAX_STOPS = 6;
const TRAVEL_KEYWORDS = [
  'ไปยังไง', 'ไปทางไหน', 'เส้นทาง', 'เดินทาง', 'นั่งรถ', 'รถสายไหน', 'สายไหน', 'รถผ่าน',
  'ขึ้นรถ', 'ระยะทาง', 'กี่กิโล', 'กี่ชั่วโมง', 'กี่นาที', 'วางแผน', 'ทริป', 'เที่ยว', 'อยากไป', 'ขอไป'
];

/* ---------- อ่านชีต ---------- */

function readSheetRows_(name, cols) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const real = Math.min(cols, sheet.getMaxColumns()); // ชีตที่มีคอลัมน์น้อยกว่าที่ขอ (เช่นยังไม่มีคอลัมน์ M) ไม่ให้ error
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, real).getValues();
  if (real < cols) rows.forEach(function (r) { while (r.length < cols) r.push(''); });
  return rows;
}

/** Places: A ชื่อ | B ชื่อเรียกอื่น(คั่น ,) | C หมวด | D อำเภอ | E ลิงก์Maps | F Lat | G Lng | H เวลาเปิด-ปิด | I ค่าเข้าชม | J เวลาที่ควรใช้(นาที) | K หมายเหตุ */
function getPlaces_() {
  const out = [];
  readSheetRows_(PLACES_SHEET_NAME, 11).forEach(function (r, i) {
    const name = String(r[0] || '').trim();
    if (!name) return;
    const lat = parseFloat(r[5]);
    const lng = parseFloat(r[6]);
    out.push({
      row: i + 2,
      name: name,
      aliases: String(r[1] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      category: String(r[2] || '').trim(),
      area: String(r[3] || '').trim(),
      link: String(r[4] || '').trim(),
      lat: isNaN(lat) ? null : lat,
      lng: isNaN(lng) ? null : lng,
      hours: String(r[7] || '').trim(),
      fee: String(r[8] || '').trim(),
      minutes: parseInt(r[9], 10) || null,
      note: String(r[10] || '').trim()
    });
  });
  return out;
}

/** Routes: A รหัส | B ชื่อสาย | C ประเภทรถ | D ต้นทาง | E ปลายทาง | F จุดผ่าน(เรียงลำดับ คั่น ,) | G จุดขึ้นรถ | H เวลา/ความถี่ | I ค่าโดยสาร | J เบอร์ติดต่อ | K หมายเหตุ | L รหัสการ์ด(อินโฟสายนั้นที่มีอยู่แล้ว) | M เที่ยว/วัน(ตัวเลข ไม่บังคับ ใช้เรียงความถี่) */
function getRoutes_() {
  const out = [];
  readSheetRows_(ROUTES_SHEET_NAME, 13).forEach(function (r) {
    const id = String(r[0] || '').trim();
    if (!id) return;
    out.push({
      id: id,
      name: String(r[1] || '').trim(),
      type: String(r[2] || '').trim(),
      from: String(r[3] || '').trim(),
      to: String(r[4] || '').trim(),
      stops: String(r[5] || '').trim(),
      boarding: String(r[6] || '').trim(),
      schedule: String(r[7] || '').trim(),
      fare: String(r[8] || '').trim(),
      phone: String(r[9] || '').trim(),
      note: String(r[10] || '').trim(),
      cardId: String(r[11] || '').trim(),
      tripsPerDay: r[12]   // คอลัมน์ M: จำนวนเที่ยวต่อวัน (ไม่บังคับ)
    });
  });
  return out;
}

/* ---------- ตรวจว่าเป็นคำถามเดินทางไหม / หาสถานที่ในข้อความ ---------- */

function findPlaceInText_(text, places) {
  const t = normalizeForMatch_(text);
  let best = null;
  let bestLen = 0;
  places.forEach(function (p) {
    [p.name].concat(p.aliases).forEach(function (n) {
      const k = normalizeForMatch_(n);
      if (k && t.indexOf(k) !== -1 && k.length > bestLen) { best = p; bestLen = k.length; }
    });
  });
  return best;
}

function isTravelQuestion_(text, places) {
  const t = normalizeForMatch_(text);
  if (!t) return false;
  if (TRAVEL_KEYWORDS.some(function (k) { return t.indexOf(normalizeForMatch_(k)) !== -1; })) return true;
  return !!findPlaceInText_(text, places) && t.indexOf('ไป') !== -1;
}

/* ---------- ความจำชั่วคราวต่อผู้ใช้ ---------- */

function getPending_(userId) {
  try {
    const v = CacheService.getScriptCache().get('trip_' + userId);
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}
function setPending_(userId, obj) {
  try { CacheService.getScriptCache().put('trip_' + userId, JSON.stringify(obj), TRAVEL_PENDING_TTL); } catch (e) { /* ignore */ }
}
function clearPending_(userId) {
  try { CacheService.getScriptCache().remove('trip_' + userId); } catch (e) { /* ignore */ }
}
function hasPendingTrip_(userId) { return !!getPending_(userId); }

/* ---------- ตอบกลับ LINE (รองรับปุ่ม Quick Reply) ---------- */

function replyTextQuick_(replyToken, text, quickItems) {
  const msg = { type: 'text', text: String(text).substring(0, 5000) };
  if (quickItems && quickItems.length) msg.quickReply = { items: quickItems };
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getLineAccessToken_() },
    payload: JSON.stringify({ replyToken: replyToken, messages: localizeMessages_([msg]) }),
    muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), body: res.getContentText() };
}

function askOrigin_(replyToken, destName) {
  const q = destName
    ? 'ต้องการเดินทางไป "' + destName + '" ใช่ไหมคะ 🚗\nขอทราบตำแหน่งที่จะเริ่มเดินทางก่อนนะคะ กดปุ่ม "แชร์ตำแหน่ง" ด้านล่าง หรือพิมพ์ชื่อสถานที่/อำเภอที่อยู่ก็ได้ค่ะ'
    : 'ขอทราบตำแหน่งที่จะเริ่มเดินทางก่อนนะคะ 📍\nกดปุ่ม "แชร์ตำแหน่ง" ด้านล่าง หรือพิมพ์ชื่อสถานที่/อำเภอที่อยู่ก็ได้ค่ะ';
  return replyTextQuick_(replyToken, q, [
    { type: 'action', action: { type: 'location', label: 'แชร์ตำแหน่ง' } },
    { type: 'action', action: { type: 'message', label: 'ตัวเมืองบึงกาฬ', text: 'ตัวเมืองบึงกาฬ' } }
  ]);
}

/* ---------- Gemini ---------- */

var GEMINI_LAST_ERROR_ = '';

function callGeminiTravel_(prompt, maxTokens, asJson) {
  GEMINI_LAST_ERROR_ = '';
  const apiKey = getGeminiApiKey_();
  if (!apiKey) { GEMINI_LAST_ERROR_ = 'ไม่พบ GEMINI_API_KEY'; return null; }
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL + ':generateContent?key=' + apiKey;
  const cfg = geminiGenConfig_(maxTokens, asJson); // ค่ากลางสำหรับ Gemini 3.x (Config.gs)
  try {
    const res = geminiPost_({ contents: [{ parts: [{ text: prompt }] }], generationConfig: cfg }, !!asJson); // JSON = งานสั้น ใช้โมเดลเร็ว
    if (res.getResponseCode() !== 200) {
      GEMINI_LAST_ERROR_ = 'HTTP ' + res.getResponseCode() + ' ' + res.getContentText().substring(0, 200).replace(/\s+/g, ' ');
      console.error('callGeminiTravel_ ' + GEMINI_LAST_ERROR_);
      return null;
    }
    const j = JSON.parse(res.getContentText());
    const t = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
      j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
    if (!t) {
      const fr = j && j.candidates && j.candidates[0] && j.candidates[0].finishReason;
      GEMINI_LAST_ERROR_ = 'ไม่มีข้อความตอบกลับ' + (fr ? ' (finishReason ' + fr + ')' : '') + (j && j.promptFeedback ? ' ' + JSON.stringify(j.promptFeedback).substring(0, 120) : '');
      console.error('callGeminiTravel_ ' + GEMINI_LAST_ERROR_);
    }
    return t ? String(t).trim() : null;
  } catch (err) {
    GEMINI_LAST_ERROR_ = 'exception ' + String(err).substring(0, 150);
    console.error('callGeminiTravel_ error: ' + err);
    return null;
  }
}

/** ให้ Gemini แยก "ต้นทาง / ปลายทาง / ต้องการแผนหลายจุดไหม" จากประโยคของผู้ใช้ */
function extractTripIntent_(text, places) {
  const names = places.map(function (p) { return p.name + (p.category ? ' (' + p.category + ')' : ''); }).join('\n');
  const prompt =
    'คุณเป็นตัวแยกข้อมูลคำถามเรื่องการเดินทางในจังหวัดบึงกาฬ\n' +
    'อ่านข้อความผู้ใช้ แล้วตอบเป็น JSON เท่านั้นตามรูปแบบ\n' +
    '{"mode":"route|plan","origin":"ชื่อจุดเริ่มต้นที่ผู้ใช้พูดถึง หรือ \\"\\"","destination":"ชื่อจุดหมายที่ผู้ใช้พูดถึง หรือ \\"\\"","stops":["ชื่อสถานที่จากรายการ เรียงลำดับการเที่ยว"]}\n' +
    '- mode=route เมื่อถามทาง/วิธีไปที่ใดที่หนึ่ง, mode=plan เมื่อให้วางแผนเที่ยว/เส้นทางหลายจุด\n' +
    '- ถ้า mode=plan ให้เลือก stops สูงสุด ' + TRAVEL_MAX_STOPS + ' แห่งจากรายการสถานที่ด้านล่างเท่านั้น (ใช้ชื่อตรงตามรายการ) ให้เหมาะกับเวลา/จำนวนวันที่ผู้ใช้บอก\n' +
    '- ถ้า mode=route และผู้ใช้ระบุจุดหมายที่อยู่ในรายการ ให้ใส่ชื่อตามรายการใน destination\n\n' +
    '=== รายการสถานที่ ===\n' + names + '\n=== จบรายการ ===\n\nข้อความผู้ใช้: ' + text;
  const raw = callGeminiTravel_(prompt, 400, true);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw.replace(/^```json|```$/g, '').trim());
    return {
      mode: o.mode === 'plan' ? 'plan' : 'route',
      origin: String(o.origin || '').trim(),
      destination: String(o.destination || '').trim(),
      stops: (o.stops || []).map(String)
    };
  } catch (e) { return null; }
}

/* ---------- พิกัด / ระยะทาง (Google Maps ใน Apps Script) ---------- */

function geocodeText_(q) {
  try {
    const r = Maps.newGeocoder().setRegion('th').setLanguage('th').geocode(q + ' ' + TRAVEL_REGION_HINT);
    if (r && r.status === 'OK' && r.results.length) {
      // ผลที่ได้เป็นแค่ "จังหวัด/ประเทศ" แปลว่าหาสถานที่จริงไม่เจอ (กันข้อความมั่วถูกตีเป็นตัวเมือง)
      const types = r.results[0].types || [];
      if (types.indexOf('administrative_area_level_1') !== -1 || types.indexOf('country') !== -1) return null;
      const loc = r.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng, label: r.results[0].formatted_address };
    }
  } catch (e) { console.error('geocodeText_ error: ' + e); }
  return null;
}

function haversineKm_(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** ระยะทางถนน (กม.) และเวลาขับรถ (นาที) ถ้า Maps ใช้ไม่ได้จะประมาณจากเส้นตรง x1.3 ที่ 50 กม./ชม. */
function computeLeg_(a, b) {
  const key = 'leg_' + [a.lat, a.lng, b.lat, b.lng].map(function (v) { return Number(v).toFixed(4); }).join('_');
  const cache = CacheService.getScriptCache();
  try {
    const c = cache.get(key);
    if (c) return JSON.parse(c);
  } catch (e) { /* ignore */ }

  let leg = null;
  try {
    const d = Maps.newDirectionFinder()
      .setOrigin(a.lat, a.lng).setDestination(b.lat, b.lng)
      .setMode(Maps.DirectionFinder.Mode.DRIVING).setLanguage('th').getDirections();
    if (d && d.status === 'OK' && d.routes.length) {
      const l = d.routes[0].legs[0];
      leg = { km: Math.round(l.distance.value / 100) / 10, minutes: Math.round(l.duration.value / 60), estimated: false };
    }
  } catch (e) { console.error('computeLeg_ error: ' + e); }
  if (!leg) {
    const km = haversineKm_(a, b) * 1.3;
    leg = { km: Math.round(km * 10) / 10, minutes: Math.round(km / 50 * 60), estimated: true };
  }
  try { cache.put(key, JSON.stringify(leg), 21600); } catch (e) { /* ignore */ }
  return leg;
}

function mapsDirUrl_(a, b) {
  return 'https://www.google.com/maps/dir/?api=1&origin=' + a.lat + ',' + a.lng +
    '&destination=' + b.lat + ',' + b.lng + '&travelmode=driving';
}

/* ---------- ตัวควบคุมหลัก ---------- */

/**
 * จัดการข้อความตัวอักษรที่เกี่ยวกับการเดินทาง คืน true ถ้าตอบไปแล้ว
 * เรียกจาก main.gs (ก่อนขั้น FAQ และเรียกก่อนสุดถ้าผู้ใช้มีคำถามค้างอยู่)
 */
function handleTravelText_(userId, userText, replyToken) {
  // ระบบรถโดยสาร (bus.gs) ได้สิทธิ์ก่อน: ชื่อสถานที่/จุดที่รถผ่าน -> สายรถ, ไปหลายจุด -> วางแผนสาย
  if (typeof handleBusText_ === 'function' && handleBusText_(userId, userText, replyToken)) return true;

  // ไปจังหวัดอื่นที่ไม่มีสายตรง (เช่น "ไปภูเก็ต") -> แสดงสายที่ใกล้ที่สุด (bus.gs)
  if (typeof handleFarDestination_ === 'function' && handleFarDestination_(userId, userText, replyToken)) return true;

  const places = getPlaces_();
  if (!places.length) return false; // ยังไม่ได้ตั้งชีต Places ให้ระบบเดิมทำงานต่อ

  const pending = getPending_(userId) || {};
  const isTravel = isTravelQuestion_(userText, places);

  // ผู้ใช้กำลังตอบคำถาม "ต้นทางอยู่ที่ไหน" ด้วยข้อความ
  if (pending.request && pending.kind !== 'bus' && !isTravel && String(userText).length <= 80) {
    clearPending_(userId);
    return finishTrip_(userId, pending.request, { text: userText.trim() }, replyToken);
  }
  if (!isTravel) return false;

  // ผู้ใช้เคยแชร์ตำแหน่งไว้แล้ว ใช้ได้เลย
  if (pending.origin) {
    clearPending_(userId);
    return finishTrip_(userId, userText, pending.origin, replyToken);
  }

  const dest = findPlaceInText_(userText, places);
  const mentionsFrom = userText.indexOf('จาก') !== -1;
  const wantsPlan = /วางแผน|ทริป|แผนเที่ยว|กี่วัน|เที่ยวอะไร/.test(userText);

  // ถามสั้นๆ ว่าไป "สถานที่ที่รู้จัก" ยังไง และยังไม่รู้ต้นทาง -> ขอตำแหน่งก่อน (ไม่เสียโควตา Gemini)
  if (dest && !mentionsFrom && !wantsPlan) {
    setPending_(userId, { request: userText });
    const r = askOrigin_(replyToken, dest.name);
    logInteraction_(userId, userText, 'Travel', '(ขอตำแหน่งต้นทาง)', r);
    return true;
  }

  // กรณีอื่น ให้ Gemini แยกต้นทาง/ปลายทาง/แผนหลายจุด
  const intent = extractTripIntent_(userText, places);
  if (!intent) return false;

  if (intent.mode === 'plan' || intent.origin) {
    return finishTrip_(userId, userText, intent.origin ? { text: intent.origin } : null, replyToken, intent);
  }
  setPending_(userId, { request: userText });
  const r2 = askOrigin_(replyToken, intent.destination || (dest && dest.name) || '');
  logInteraction_(userId, userText, 'Travel', '(ขอตำแหน่งต้นทาง)', r2);
  return true;
}

/** ผู้ใช้ส่งตำแหน่ง (location message) มา */
function handleLocationEvent_(event) {
  const userId = event.source.userId;
  const origin = {
    lat: event.message.latitude,
    lng: event.message.longitude,
    label: event.message.address || event.message.title || 'ตำแหน่งที่แชร์'
  };
  const pending = getPending_(userId);
  if (pending && pending.kind === 'bus' && pending.request && typeof finishBusTrip_ === 'function') {
    clearPending_(userId);
    finishBusTrip_(userId, pending.request, origin, event.replyToken);
    return;
  }
  if (pending && pending.request) {
    clearPending_(userId);
    finishTrip_(userId, pending.request, origin, event.replyToken);
    return;
  }
  // ยังไม่มีคำถามค้าง: จำตำแหน่งไว้ แล้วถามว่าจะไปไหน
  setPending_(userId, { origin: origin });
  const r = replyTextQuick_(event.replyToken, 'ได้รับตำแหน่งแล้วค่ะ 📍 ต้องการไปที่ไหน หรือให้วางแผนเที่ยวแบบไหน พิมพ์บอกได้เลยค่ะ');
  logInteraction_(userId, '[ส่งตำแหน่ง]', 'Travel', '(จำตำแหน่งไว้ รอคำถาม)', r);
}

/** คำนวณและตอบ: origin = {lat,lng,label} หรือ {text} ที่ต้องค้นพิกัด หรือ null */
function finishTrip_(userId, requestText, origin, replyToken, intentIn) {
  const places = getPlaces_();
  const routes = getRoutes_();
  const intent = intentIn || extractTripIntent_(requestText, places) ||
    { mode: 'route', origin: '', destination: '', stops: [] };

  // หาพิกัดต้นทาง
  let o = null;
  if (origin && origin.lat !== undefined) o = origin;
  else if (origin && origin.text) {
    const hit = findPlaceInText_(origin.text, places);
    o = (hit && hit.lat !== null) ? { lat: hit.lat, lng: hit.lng, label: hit.name } : geocodeText_(origin.text);
    if (o && !o.label) o.label = origin.text;
  }

  // รายการจุดหมาย
  const targets = [];
  if (intent.mode === 'plan') {
    intent.stops.slice(0, TRAVEL_MAX_STOPS).forEach(function (n) {
      const p = places.filter(function (x) { return x.name === n; })[0] || findPlaceInText_(n, places);
      if (p && targets.indexOf(p) === -1) targets.push(p);
    });
  } else {
    const p = findPlaceInText_(intent.destination, places) || findPlaceInText_(requestText, places);
    if (p) targets.push(p);
    else if (intent.destination) {
      const g = geocodeText_(intent.destination);
      if (g) targets.push({ name: intent.destination, lat: g.lat, lng: g.lng, link: '', note: 'ไม่มีในฐานข้อมูลสถานที่ (พิกัดค้นจาก Google Maps)' });
    }
  }

  if (!targets.length) {
    const r = replyMessage_(replyToken, 'ขออภัยค่ะ ยังไม่พบสถานที่ที่ต้องการในระบบ ลองพิมพ์ชื่อสถานที่อีกครั้ง หรือติดต่อเจ้าหน้าที่ได้เลยนะคะ 🙏');
    logInteraction_(userId, requestText, 'Travel', '(ไม่พบจุดหมาย)', r);
    return true;
  }
  if (!o && intent.mode === 'route') {
    setPending_(userId, { request: requestText });
    const r = replyTextQuick_(replyToken, 'ขออภัยค่ะ หาตำแหน่งต้นทางไม่เจอ ลองกด "แชร์ตำแหน่ง" หรือพิมพ์ชื่ออำเภอ/ตำบลอีกครั้งนะคะ 📍', [
      { type: 'action', action: { type: 'location', label: 'แชร์ตำแหน่ง' } }
    ]);
    logInteraction_(userId, requestText, 'Travel', '(หาต้นทางไม่เจอ)', r);
    return true;
  }

  // ระยะทางเป็นช่วงๆ: ต้นทาง -> จุดที่ 1 -> จุดที่ 2 ...
  const legs = [];
  let prev = o;
  targets.forEach(function (t) {
    if (prev && t.lat !== null && t.lat !== undefined) {
      const l = computeLeg_(prev, t);
      legs.push({
        from: prev === o ? (o.label || 'ต้นทาง') : prev.name,
        to: t.name, km: l.km, drivingMinutes: l.minutes, estimated: l.estimated,
        mapsLink: mapsDirUrl_(prev, t)
      });
    }
    prev = t;
  });

  const facts = {
    mode: intent.mode,
    userRequest: requestText,
    origin: o ? o.label : null,
    destinations: targets.map(function (t) {
      return { name: t.name, area: t.area || '', hours: t.hours || '', fee: t.fee || '', suggestedVisitMinutes: t.minutes || null, note: t.note || '', link: t.link || '' };
    }),
    drivingLegs: legs,
    busRoutes: routes
  };

  const prompt =
    'คุณเป็นเจ้าหน้าที่ขนส่งจังหวัดบึงกาฬ ตอบผ่านไลน์ ในฐานะของสำนักงานขนส่งจังหวัดบึงกาฬ ภาษาไทยสุภาพ ลงท้าย "ค่ะ" กระชับ อ่านง่าย ไม่เกิน 1,200 ตัวอักษร\n' +
    'ใช้ข้อมูลใน JSON ด้านล่างเท่านั้น ห้ามแต่งตัวเลข เวลา ราคา หรือชื่อสายรถที่ไม่มีในข้อมูล\n' +
    'หลักการตอบ:\n' +
    '1) บอกระยะทางและเวลาเดินทางโดยรถยนต์จาก drivingLegs (ถ้า estimated=true ให้บอกว่าเป็นค่าประมาณ)\n' +
    '2) การเดินทางด้วยรถโดยสาร: ดูใน busRoutes ว่าสายใดมีจุดผ่าน (stops/from/to) ใกล้ต้นทางและจุดหมาย บอกชื่อสาย จุดขึ้นรถ เวลา ค่าโดยสาร เบอร์ติดต่อ เท่าที่มีในข้อมูล\n' +
    '   ถ้าไม่มีสายที่ผ่านทั้งสองฝั่งชัดเจน ให้บอกตรงๆ ว่ายังไม่มีข้อมูลสายรถที่ยืนยันได้ และแนะนำสอบถามเจ้าหน้าที่ อย่าเดา\n' +
    '3) ถ้า mode=plan ให้จัดลำดับเป็นแผนเที่ยวเป็นข้อๆ พร้อมเวลาเดินทางระหว่างจุดและเวลาที่ควรใช้เที่ยว (suggestedVisitMinutes) แนะนำเวลาเริ่ม 08:00 เว้นแต่ผู้ใช้ระบุ และเตือนถ้าเวลาเปิด-ปิดไม่พอ\n' +
    '4) ปิดท้ายด้วยลิงก์ Google Maps นำทาง (mapsLink) ของช่วงแรก และลิงก์สถานที่ (link) ถ้ามี\n\n' +
    '=== ข้อมูล JSON ===\n' + JSON.stringify(facts) + '\n=== จบข้อมูล ===';

  let answer = callGeminiTravel_(prompt, 1024, false);
  if (!answer) answer = buildPlainTripAnswer_(facts); // Gemini ล่ม/เต็มโควตา: ตอบแบบไม่ใช้ AI

  const res = replyMessage_(replyToken, answer);
  logInteraction_(userId, requestText, 'Travel', answer, res);
  return true;
}

/** คำตอบสำรองเมื่อเรียก Gemini ไม่ได้ */
function buildPlainTripAnswer_(f) {
  const lines = ['🗺️ ข้อมูลเส้นทาง (ระบบสำรอง)'];
  f.drivingLegs.forEach(function (l) {
    lines.push('• ' + l.from + ' → ' + l.to + ' ประมาณ ' + l.km + ' กม. ขับรถราว ' + l.drivingMinutes + ' นาที' + (l.estimated ? ' (ค่าประมาณ)' : ''));
  });
  if (f.drivingLegs[0]) lines.push('นำทาง: ' + f.drivingLegs[0].mapsLink);
  lines.push('สอบถามสายรถโดยสารเพิ่มเติมได้ที่เจ้าหน้าที่ค่ะ 🙏');
  return lines.join('\n');
}

/* ---------- เครื่องมือสำหรับผู้ดูแล (รันจาก Editor) ---------- */

/** รันครั้งแรกครั้งเดียว เพื่ออนุญาตให้สคริปต์ใช้ Google Maps */
function authorizeMaps() {
  const g = geocodeText_('ที่ว่าการอำเภอเมืองบึงกาฬ');
  console.log(g ? ('Maps ใช้งานได้: ' + JSON.stringify(g)) : 'ค้นหาไม่พบ แต่ได้รับอนุญาตแล้ว');
}

/** เติมคอลัมน์ Lat/Lng ในชีต Places ให้แถวที่ยังว่าง โดยค้นจากลิงก์ Maps (ถ้ามีพิกัดในลิงก์) หรือจากชื่อ แล้วตรวจผลด้วยตาอีกครั้ง */
function fillPlaceCoordinates() {
  const sheet = getSpreadsheet_().getSheetByName(PLACES_SHEET_NAME);
  if (!sheet) { console.log('ไม่พบชีต Places'); return; }
  let filled = 0;
  getPlaces_().forEach(function (p) {
    if (p.lat !== null && p.lng !== null) return;
    let c = null;
    if (p.link) {
      let url = p.link;
      try {
        if (/maps\.app\.goo\.gl|goo\.gl\/maps/.test(url)) {
          const res = UrlFetchApp.fetch(url, { followRedirects: false, muteHttpExceptions: true });
          const loc = res.getHeaders()['Location'] || res.getHeaders()['location'];
          if (loc) url = loc;
        }
      } catch (e) { /* ใช้ลิงก์เดิม */ }
      const m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (m) c = { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
    }
    if (!c) c = geocodeText_(p.name);
    if (c) {
      sheet.getRange(p.row, 6, 1, 2).setValues([[c.lat, c.lng]]);
      filled++;
    }
  });
  console.log('เติมพิกัดให้ ' + filled + ' แถว (กรุณาเปิดลิงก์ตรวจว่าตรงสถานที่จริง)');
}

/** ทดสอบใน Editor โดยไม่ส่งเข้า LINE */
function debugTravel() {
  const places = getPlaces_();
  console.log('สถานที่ ' + places.length + ' แห่ง, สายรถ ' + getRoutes_().length + ' สาย');
  ['ไปวัดภูทอกยังไง', 'วางแผนเที่ยวบึงกาฬ 1 วัน', 'สวัสดี'].forEach(function (t) {
    console.log(t + ' -> เป็นคำถามเดินทาง: ' + isTravelQuestion_(t, places));
  });
  console.log(JSON.stringify(extractTripIntent_('จากตัวเมืองจะไปภูทอก ต้องนั่งรถอะไร', places)));
}