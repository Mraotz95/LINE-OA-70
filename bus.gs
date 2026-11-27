/**
 * bus.gs
 * ผู้ช่วยแนะนำ "รถโดยสารสาธารณะในจังหวัดบึงกาฬ"
 *
 * โหมด 1  ผู้ใช้พิมพ์ชื่อสถานที่ (เช่น "ภูทอก")
 *         -> หาสายรถที่ผ่านหรืออยู่ใกล้สถานที่นั้น แล้วเปิดอินโฟ/การ์ดสายนั้นที่มีอยู่แล้ว (ไม่ใช้ AI ไม่เสียโควตา)
 *         -> ถ้ามีหลายสาย ให้ผู้ใช้กดเลือกสาย  + มีปุ่มให้แชร์ตำแหน่งเพื่อให้ช่วยวางแผนจากจุดที่อยู่
 * โหมด 2  ผู้ใช้ถามไปหลายจุดในทริปเดียว (เช่น "จากตลาดสดไปภูทอกแล้วไปวัดอาฮง")
 *         -> ขอตำแหน่งเริ่มต้น -> คำนวณระยะเดินไปขึ้น/ลงรถของแต่ละช่วง -> เลือกสายที่ดีที่สุด
 *            (ถ้าไม่มีสายตรงจะลองต่อรถ 1 ครั้ง) -> ให้ Gemini เรียบเรียงคำตอบจากผลที่คำนวณได้
 *
 * ข้อมูลที่ใช้ (ชีตใน Google Sheets)
 *   Routes : รหัสสาย | ชื่อสาย | ประเภทรถ | ต้นทาง | ปลายทาง | จุดผ่าน(เรียงลำดับ คั่น ,) | จุดขึ้นรถ | เวลา/ความถี่ | ค่าโดยสาร | เบอร์ | หมายเหตุ | รหัสการ์ด(L)
 *            "รหัสการ์ด" = GroupID (ImageCards) / ID (Images) / CardID (Cards) ของอินโฟสายนั้นที่มีอยู่แล้ว
 *   Stops  : ชื่อจุด | ชื่อเรียกอื่น | Lat | Lng   (พิกัดของจุดที่รถผ่าน ใช้ fillStopCoordinates() เติมให้ได้)
 *   Places : สถานที่ท่องเที่ยว (มีพิกัดแล้ว ระบบใช้ร่วมกัน)
 *
 * ต้องมี travel.gs (ฟังก์ชันช่วย), intent.gs (replyTopic_), safety.gs (normalizeForMatch_)
 */

const STOPS_SHEET_NAME = 'Stops';
const BUS_NEAR_KM = 1.0;        // สถานที่ห่างจุดผ่านไม่เกินนี้ ถือว่า "สายนี้ผ่านใกล้"
const BUS_MAX_WALK_KM = 2.0;    // เดินไปขึ้น/ลงรถไม่เกินนี้ (กม.) จึงเสนอสาย
const BUS_TRANSFER_KM = 0.3;    // จุดต่อรถสองสายต้องห่างกันไม่เกินนี้
const WALK_FACTOR = 1.3;        // ระยะเดินจริง ≈ เส้นตรง x 1.3
const MAX_QUICK_ITEMS = 12;

/* ---------- ข้อมูล ---------- */

/** อ่านชีต Stops -> [{name, aliases, lat, lng}] */
function getStopsSheetRows_() {
  const out = [];
  readSheetRows_(STOPS_SHEET_NAME, 4).forEach(function (r) {
    const name = String(r[0] || '').trim();
    if (!name) return;
    const lat = parseFloat(r[2]), lng = parseFloat(r[3]);
    out.push({
      name: name,
      aliases: String(r[1] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      lat: isNaN(lat) ? null : lat,
      lng: isNaN(lng) ? null : lng
    });
  });
  return out;
}

/**
 * คีย์สำหรับจับคู่ชื่อ: ชื่อเต็ม (คีย์แรก) + ชื่อเรียกอื่น + รูปย่ออัตโนมัติ
 *   - ตัดคำนำหน้า จังหวัด/อำเภอ/ตำบล/เขต (รวม จ. อ. ต.)
 *   - ตัดส่วนท้าย "จังหวัด..." เช่น "อำเภอกุมภวาปี จังหวัดอุดรธานี" -> "กุมภวาปี"
 *   - ตัดท้าย "ธานี" เช่น อุดรธานี -> อุดร
 * ผู้ใช้จึงพิมพ์ชื่อสั้นๆ ได้ แม้ในชีตเขียนชื่อเต็ม
 */
function nameKeys_(o) {
  const out = [];
  function add(k) { if (k && out.indexOf(k) === -1) out.push(k); }
  [o.name].concat(o.aliases || []).forEach(function (n) {
    const raw = String(n || '').trim();
    add(normalizeForMatch_(raw));
    // ชื่อมีวงเล็บ เช่น "ปู่อือลือ (เกาะดอนโพธิ์)" -> เพิ่มคีย์ "ปู่อือลือ" และ "เกาะดอนโพธิ์" ให้พิมพ์/ตั้งชื่อจุดผ่านแบบสั้นได้
    const mp = raw.match(/^(.*?)\s*[(（](.+?)[)）]/);
    if (mp) {
      [mp[1], mp[2]].forEach(function (part) {
        const kp = normalizeForMatch_(part);
        if (kp.length >= 3) add(kp);
      });
    }
    let s = raw.replace(/^(กิ่งอำเภอ|จังหวัด|อำเภอ|ตำบล|เขต|จ\.|อ\.|ต\.)\s*/, '');
    const cut = s.replace(/\s+จังหวัด.*$/, ''); // ต้องมีช่องว่างนำหน้า ไม่งั้น "สถานีขนส่งผู้โดยสารจังหวัดบึงกาฬ" จะถูกตัดเหลือคีย์กว้างเกินไป
    if (cut) s = cut;
    const k = normalizeForMatch_(s);
    if (k.length >= 3) add(k);
    const k2 = k.replace(/ธานี$/, '');
    if (k2.length >= 3) add(k2);
  });
  return out;
}

/** รวมข้อมูลสายรถ: แต่ละสายมี seq = ลำดับจุดที่รถผ่าน พร้อมพิกัด (ถ้ามี) */
function buildBusModel_() {
  const routes = getRoutes_();
  const stopRows = getStopsSheetRows_();
  const places = getPlaces_();
  const coordByKey = {};
  stopRows.concat(places).forEach(function (o) {
    if (o.lat === null || o.lng === null) return;
    nameKeys_(o).forEach(function (k) { if (!coordByKey[k]) coordByKey[k] = { lat: o.lat, lng: o.lng }; });
  });

  routes.forEach(function (r) {
    const names = [r.from].concat(String(r.stops || '').split(','), [r.to])
      .map(function (s) { return String(s || '').trim(); }).filter(Boolean);
    r.seq = [];
    names.forEach(function (n) {
      const k = normalizeForMatch_(n);
      if (r.seq.length && r.seq[r.seq.length - 1].key === k) return;
      const c = coordByKey[k] || null;
      r.seq.push({ name: n, key: k, keys: nameKeys_({ name: n, aliases: [] }), lat: c ? c.lat : null, lng: c ? c.lng : null });
    });
  });

  // สายที่ระบุจุดว่า "บึงกาฬ" = ตัวเมือง/สถานีขนส่ง: ให้ถือว่าตรงกับ "บขส.บึงกาฬ" ด้วย
  // (ไม่งั้นระบบมองว่าสายผ่านบึงกาฬไม่ผ่าน บขส. จึงแนะนำต่อรถโดยไม่จำเป็น)
  const STATION_KEYS = nameKeys_({
    name: 'บขส.บึงกาฬ',
    aliases: ['บขส บึงกาฬ', 'สถานีขนส่งบึงกาฬ', 'สถานีขนส่งผู้โดยสารบึงกาฬ', 'สถานีขนส่งผู้โดยสารจังหวัดบึงกาฬ', 'สถานีขนส่งจังหวัดบึงกาฬ']
  });
  const CITY_KEY = normalizeForMatch_('บึงกาฬ');
  routes.forEach(function (r) {
    r.seq.forEach(function (s) {
      if (s.key === CITY_KEY) {
        STATION_KEYS.forEach(function (k) { if (s.keys.indexOf(k) === -1) s.keys.push(k); });
      }
    });
  });

  // จุดที่ผู้ใช้อาจพิมพ์ถึง: สถานที่ + จุดในชีต Stops + ชื่อจุดที่รถผ่าน
  const known = [];
  const seen = {};
  function addKnown(o, kind) {
    const keys = nameKeys_(o);
    if (!keys.length || seen[keys[0]]) return;
    seen[keys[0]] = true;
    const c = coordByKey[keys[0]] || (o.lat !== null && o.lat !== undefined ? { lat: o.lat, lng: o.lng } : null);
    known.push({ name: o.name, keys: keys, kind: kind, lat: c ? c.lat : null, lng: c ? c.lng : null });
  }
  places.forEach(function (p) { addKnown(p, 'place'); });
  stopRows.forEach(function (s) { addKnown(s, 'stop'); });
  routes.forEach(function (r) { r.seq.forEach(function (s) { addKnown({ name: s.name, aliases: [] }, 'stop'); }); });

  return { routes: routes, known: known };
}

/**
 * หาจุดที่รู้จักทั้งหมดที่ปรากฏในข้อความ เรียงตามตำแหน่งที่พิมพ์
 *  - ตัดจุดที่ซ้อนอยู่ในชื่อที่ยาวกว่า
 *  - ตัดชื่อจังหวัดที่พิมพ์ต่อท้ายอำเภอ เช่น "พังโคน สกลนคร" นับเป็นจุดเดียว (พังโคน) ไม่ใช่สองจุด
 */
function findKnownPoints_(text, model) {
  const t = normalizeForMatch_(text);
  const hits = [];
  model.known.forEach(function (k) {
    let bestPos = -1, bestLen = 0, bestKey = '';
    k.keys.forEach(function (key) {
      const p = t.indexOf(key);
      if (p !== -1 && key.length > bestLen) { bestPos = p; bestLen = key.length; bestKey = key; }
    });
    if (bestPos !== -1) hits.push({ point: k, pos: bestPos, len: bestLen, key: bestKey });
  });
  hits.sort(function (a, b) { return b.len - a.len; });
  let kept = [];
  hits.forEach(function (h) {
    const covered = kept.some(function (o) { return h.pos >= o.pos && h.pos + h.len <= o.pos + o.len; });
    if (!covered) kept.push(h);
  });

  // ชื่อที่เป็น "คุณสมบัติ" ของอีกจุดและพิมพ์ติดกัน (อำเภอ + จังหวัด) ให้เหลือจุดที่เจาะจงกว่า
  kept = kept.filter(function (h) {
    return !kept.some(function (o) {
      if (o === h || o.point === h.point) return false;
      if (o.point.keys[0].length <= h.point.keys[0].length) return false;
      if (o.point.keys[0].indexOf(h.key) === -1) return false;
      let between = null;
      if (h.pos >= o.pos + o.len) between = t.substring(o.pos + o.len, h.pos);
      else if (o.pos >= h.pos + h.len) between = t.substring(h.pos + h.len, o.pos);
      return between !== null && (between === '' || between === 'จังหวัด' || between === 'จ');
    });
  });

  kept.sort(function (a, b) { return a.pos - b.pos; });
  return kept;
}

/* ---------- คำนวณ ---------- */

function walkKm_(a, b) { return haversineKm_(a, b) * WALK_FACTOR; }

/** จุดบนสายที่ใกล้ point ที่สุด คืน {idx, name, km} (ตรงชื่อ = 0 กม.) หรือ null */
function nearestOnRoute_(route, point) {
  let best = null;
  route.seq.forEach(function (s, i) {
    let km = null;
    if (point.keys && s.keys.some(function (k) { return point.keys.indexOf(k) !== -1; })) km = 0;
    else if (s.lat !== null && point.lat !== null && point.lat !== undefined) km = walkKm_(point, s);
    if (km !== null && (!best || km < best.km)) best = { idx: i, name: s.name, km: Math.round(km * 100) / 100 };
  });
  return best;
}

/** สายที่ผ่าน/ใกล้จุดหนึ่ง (โหมด 1) */
function routesNearPoint_(model, point) {
  const out = [];
  model.routes.forEach(function (r) {
    if (routeStatus_(r).unavailable) return;
    const n = nearestOnRoute_(r, point);
    if (n && n.km <= BUS_NEAR_KM) out.push({ route: r, stop: n.name, walkKm: n.km });
  });
  out.sort(function (a, b) { return a.walkKm - b.walkKm; });
  return out;
}

function routeBrief_(r) {
  return { label: routeLabel_(r), frequency: frequencyLabel_(r), nextDeparture: (function () { const nd = nextDepartureInfo_(r); return nd ? (nd.exact ? nd.label : nd.label + ' (ความถี่เฉลี่ย)') : ''; })(), id: r.id, name: r.name, type: r.type, boardingPoint: r.boarding, schedule: r.schedule, fare: r.fare, phone: r.phone, note: r.note };
}

/**
 * ระยะทางถนน (กม.) / เวลาโดยประมาณ ระหว่างสองจุดบนสายเดียวกัน (ใช้ Google Maps ผ่าน computeLeg_ ใน travel.gs)
 * คืน null ถ้าจุดใดจุดหนึ่งไม่มีพิกัด  (ตัวเลขนี้คือ "ระยะทางที่นั่งรถ" ไม่ใช่ระยะเดิน)
 */
function rideLeg_(route, i, j) {
  const a = route.seq[i], b = route.seq[j];
  if (!a || !b || a.lat === null || a.lat === undefined || b.lat === null || b.lat === undefined) return null;
  const l = computeLeg_(a, b);
  return { roadKm: l.km, approxMinutes: l.minutes, estimated: !!l.estimated };
}

/** ระยะทางถนนระหว่างจุดต้นกับจุดปลายของช่วง (ถ้ามีพิกัดทั้งคู่) */
function roadBetween_(from, to) {
  if (!from || !to || from.lat === null || from.lat === undefined || to.lat === null || to.lat === undefined) return null;
  const l = computeLeg_(from, to);
  return { roadKm: l.km, approxDriveMinutes: l.minutes, estimated: !!l.estimated };
}

/** หาสายที่ดีที่สุดสำหรับ 1 ช่วง X -> Y: สายตรงก่อน ไม่มีค่อยลองต่อรถ 1 ครั้ง */
function planLeg_(model, X, Y) {
  const direct = [];
  model.routes.forEach(function (r) {
    const a = nearestOnRoute_(r, X), b = nearestOnRoute_(r, Y);
    if (!a || !b || a.idx === b.idx) return;
    if (a.km > BUS_MAX_WALK_KM || b.km > BUS_MAX_WALK_KM) return;
    if (!routeUsableFrom_(r, a.name)) return; // หยุดให้บริการ / ไม่มีรถออกจากจุดที่ขึ้น (ดูหมายเหตุ) -> ข้าม เลือกสายอื่น
    direct.push({
      type: 'direct', cost: a.km + b.km, score: a.km + b.km + servicePenalty_(r), route: r,
      boardIdx: a.idx, alightIdx: b.idx,
      board: a.name, walkToBoardKm: a.km, alight: b.name, walkFromAlightKm: b.km,
      direction: a.idx < b.idx ? 'ไปทางปลายทาง ' + r.to : 'ไปทางต้นทาง ' + r.from,
      stopsBetween: Math.abs(b.idx - a.idx)
    });
  });
  direct.sort(function (p, q) { return p.score - q.score; }); // ระยะเดิน + เวลารอรถ + ความถี่
  if (direct.length) return { kind: 'direct', options: direct.slice(0, 3) };

  // ต่อรถ 1 ครั้ง: สาย r1 ใกล้ X, สาย r2 ใกล้ Y และมีจุดที่สองสายอยู่ใกล้กัน
  let best = null;
  model.routes.forEach(function (r1) {
    const a = nearestOnRoute_(r1, X);
    if (!a || a.km > BUS_MAX_WALK_KM) return;
    if (!routeUsableFrom_(r1, a.name)) return;
    model.routes.forEach(function (r2) {
      if (r1 === r2) return;
      const b = nearestOnRoute_(r2, Y);
      if (!b || b.km > BUS_MAX_WALK_KM) return;
      r1.seq.forEach(function (s1, i1) {
        if (i1 === a.idx) return;
        r2.seq.forEach(function (s2, i2) {
          if (i2 === b.idx) return;
          let gap = null;
          if (s1.keys.some(function (k) { return s2.keys.indexOf(k) !== -1; })) gap = 0;
          else if (s1.lat !== null && s2.lat !== null) gap = walkKm_(s1, s2);
          if (gap === null || gap > BUS_TRANSFER_KM) return;
          if (!routeUsableFrom_(r2, s2.name)) return;
          const cost = a.km + b.km + gap + 0.5; // บวกโทษการต่อรถเล็กน้อย
          if (!best || cost < best.cost) {
            best = { type: 'transfer', cost: cost, first: { route: r1, boardIdx: a.idx, alightIdx: i1, board: a.name, walkToBoardKm: a.km, alight: s1.name },
              second: { route: r2, boardIdx: i2, alightIdx: b.idx, board: s2.name, alight: b.name, walkFromAlightKm: b.km }, transferWalkKm: Math.round(gap * 100) / 100 };
          }
        });
      });
    });
  });
  return best ? { kind: 'transfer', options: [best] } : { kind: 'none', options: [] };
}

/* ---------- สถานะสาย (หมายเหตุ) / เวลาออก / ตัวถ่วงการเรียงลำดับ ---------- */

const WAIT_MIN_PER_KM = 15;   // รอรถ 15 นาที = เสียเท่ากับเดินเพิ่ม 1 กม. (ใช้เรียงสายตัวเลือก)

/**
 * อ่านคอลัมน์ K (หมายเหตุ) ของสาย:
 *   unavailable  = หยุดให้บริการ/ยกเลิก/งดเดินรถ ฯลฯ  -> ไม่นำมาแนะนำเลย
 *   noDepartFrom = รายชื่อจุดที่ "ไม่มีรถออกจาก..." เช่น "ไม่มีรถออกจากบึงกาฬ" -> ไม่แนะนำให้ขึ้นรถที่จุดนั้น (ขึ้นที่จุดอื่นของสายได้)
 */
function routeStatus_(r) {
  if (r._st) return r._st;
  const note = String(r.note || '');
  const noDepartFrom = [];
  const re = /ไม่มี(?:รถ|เที่ยว)?(?:ออก)?จาก\s*([ก-๙A-Za-z0-9.]+)/g;
  let m;
  while ((m = re.exec(note)) !== null) noDepartFrom.push(m[1]);
  const unavailable = /(หยุดให้บริการ|หยุดเดินรถ|ยกเลิก|งดเดินรถ|งดให้บริการ|ระงับ|ปิดเส้นทาง|ไม่เปิดให้บริการ|ไม่ให้บริการ|ไม่มีรถวว*ิ่ง|ไม่มีรถให้บริการ)/.test(note);
  r._st = { unavailable: unavailable, noDepartFrom: noDepartFrom, flagged: unavailable || noDepartFrom.length > 0, note: note };
  return r._st;
}

/** ขึ้นรถสายนี้ที่จุด stopName ได้ไหม (stopName ว่าง = ตรวจเฉพาะว่าสายยังให้บริการอยู่) */
function routeUsableFrom_(r, stopName) {
  const st = routeStatus_(r);
  if (st.unavailable) return false;
  const a = normalizeForMatch_(stopName);
  if (!a) return true;
  for (let i = 0; i < st.noDepartFrom.length; i++) {
    const p = normalizeForMatch_(st.noDepartFrom[i]);
    if (p && (a.indexOf(p) !== -1 || p.indexOf(a) !== -1)) return false;
  }
  return true;
}

function routeWarn_(r) {
  const st = routeStatus_(r);
  return st.flagged && st.note ? ' ⚠️ ' + st.note : '';
}

function hhmm_(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
}

/**
 * เวลาออกถัดไปโดยประมาณ จากข้อความในคอลัมน์ H คืน {waitMin, label, exact} หรือ null ถ้าอ่านไม่ได้
 *   รายการเวลา (06:00, 09:30, ...)      -> เวลาออกที่ใกล้ที่สุดหลังตอนนี้ (หมดวันแล้ว = เที่ยวแรกของพรุ่งนี้) exact=true
 *   "ทุก X นาที/ชม." (+ช่วง 06:00-18:00) -> รอเฉลี่ย X/2 ถ้าอยู่ในช่วงให้บริการ ไม่งั้นรอถึงเวลาเริ่ม
 * เป็นเวลาตามตาราง (มักเป็นเวลาออกจากต้นสาย) ไม่ใช่การรับประกัน
 */
function nextDepartureInfo_(r, nowMinOverride) {
  const s = toArabicDigits_(r.schedule || '');
  const times = (s.match(/\b(?:[01]?\d|2[0-3])[:.][0-5]\d\b/g) || []).map(function (t) { const a = t.split(/[:.]/); return parseInt(a[0], 10) * 60 + parseInt(a[1], 10); });
  const isRange = times.length >= 2 && /[-–—]|ถึง/.test(s);
  let now = nowMinOverride;
  if (now === undefined) {
    const p = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'HH:mm').split(':');
    now = parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }
  const mh = s.match(/ทุก\s*(\d+(?:\.\d+)?)\s*(นาที|ชั่วโมง|ชม)/);
  if (mh) {
    const head = /นาที/.test(mh[2]) ? parseFloat(mh[1]) : parseFloat(mh[1]) * 60;
    const label = 'ทุก ' + mh[1] + (/นาที/.test(mh[2]) ? ' นาที' : ' ชั่วโมง');
    if (isRange) {
      const st = times[0], en = times[1];
      if (now >= st && now <= en) return { waitMin: head / 2, label: label, exact: false };
      return { waitMin: now < st ? st - now : st + 1440 - now, label: (now < st ? '' : 'พรุ่งนี้ ') + hhmm_(st), exact: true };
    }
    return { waitMin: head / 2, label: label, exact: false };
  }
  if (times.length >= 3 || (times.length >= 2 && !isRange)) {
    const sorted = times.slice().sort(function (a, b) { return a - b; });
    for (let i = 0; i < sorted.length; i++) if (sorted[i] >= now) return { waitMin: sorted[i] - now, label: hhmm_(sorted[i]), exact: true };
    return { waitMin: sorted[0] + 1440 - now, label: 'พรุ่งนี้ ' + hhmm_(sorted[0]), exact: true };
  }
  return null;
}

/** ตัวถ่วงการเรียงสายตัวเลือก (หน่วยเทียบเท่า กม.): ยิ่งน้อยยิ่งดี  = รอรถ + ความถี่ (ไม่รู้ความถี่ = ถ่วงเล็กน้อย) */
function servicePenalty_(r) {
  const f = parseTripsPerDay_(r);
  let p = f === null ? 0.3 : -Math.min(f, 24) * 0.02;
  const nd = nextDepartureInfo_(r);
  if (nd && nd.waitMin !== null) p += nd.waitMin / WAIT_MIN_PER_KM;
  return p;
}

/* ---------- สายอื่นที่ผ่านใกล้ (เรียงตามความถี่) ---------- */

/** จำนวนเที่ยวต่อวัน: ใช้คอลัมน์ M ก่อน ไม่มีค่อยแกะจากข้อความในคอลัมน์ H คืน null ถ้าแกะไม่ได้ */
function parseTripsPerDay_(r) {
  const manual = parseFloat(r.tripsPerDay);
  if (!isNaN(manual) && manual > 0) return manual;
  const s = String(r.schedule || '').replace(/[๐-๙]/g, function (d) { return '๐๑๒๓๔๕๖๗๘๙'.indexOf(d); });
  const times = s.match(/\b(?:[01]?\d|2[0-3])[:.][0-5]\d\b/g) || [];
  const isRange = times.length >= 2 && /[-–—]|ถึง/.test(s);
  let span = 12; // ไม่ระบุช่วงเวลา สมมติวิ่งวันละ 12 ชม.
  if (isRange) {
    const p = function (t) { const a = t.split(/[:.]/); return parseInt(a[0], 10) * 60 + parseInt(a[1], 10); };
    const d = (p(times[1]) - p(times[0])) / 60;
    if (d > 0 && d <= 20) span = d;
  }
  let m = s.match(/ทุก\s*(\d+(?:\.\d+)?)\s*(นาที|ชั่วโมง|ชม)/);
  if (m) {
    const v = parseFloat(m[1]);
    const minutes = /นาที/.test(m[2]) ? v : v * 60;
    if (minutes > 0) return Math.max(1, span * 60 / minutes);
  }
  m = s.match(/(\d+)\s*(?:เที่ยว|รอบ)/);
  if (m) return parseInt(m[1], 10);
  if (times.length >= 3 || (times.length >= 2 && !isRange)) return times.length;
  return null;
}

function frequencyLabel_(r) {
  const n = parseTripsPerDay_(r);
  if (n) return 'ประมาณ ' + Math.round(n) + ' เที่ยว/วัน';
  if (r.schedule) return r.schedule.replace(/\s+/g, ' ').substring(0, 40);
  return 'ยังไม่มีข้อมูลความถี่';
}

/** สายที่ผ่านใกล้ต้นทางหรือปลายทางของช่วงนี้ ที่ยังไม่ได้แนะนำ เรียงจากถี่สุด (ไม่มีข้อมูลความถี่ไว้ท้าย) */
function otherRoutesForLeg_(model, X, Y, excludeIds) {
  const out = [];
  model.routes.forEach(function (r) {
    if (excludeIds[r.id] || routeStatus_(r).unavailable) return;
    const a = nearestOnRoute_(r, X), b = nearestOnRoute_(r, Y);
    // ขึ้นรถที่จุดใกล้ต้นทางไม่ได้ (เช่น "ไม่มีรถออกจากบึงกาฬ") ก็ไม่นับว่าผ่านใกล้ต้นทาง
    const nearO = !!(a && a.km <= BUS_NEAR_KM && routeUsableFrom_(r, a.name)), nearD = !!(b && b.km <= BUS_NEAR_KM);
    if (!nearO && !nearD) return;
    out.push({ route: r, nearO: nearO, nearD: nearD, stopO: a ? a.name : '', stopD: b ? b.name : '',
      freq: parseTripsPerDay_(r), walk: Math.min(nearO ? a.km : 99, nearD ? b.km : 99) });
  });
  out.sort(function (p, q) {
    if ((p.freq === null) !== (q.freq === null)) return p.freq === null ? 1 : -1;
    if (p.freq !== q.freq) return q.freq - p.freq;
    const wp = nextDepartureInfo_(p.route), wq = nextDepartureInfo_(q.route);
    const dp = wp && wp.waitMin !== null ? wp.waitMin : 9999, dq = wq && wq.waitMin !== null ? wq.waitMin : 9999;
    if (dp !== dq) return dp - dq; // ความถี่เท่ากัน: สายที่ออกเร็วกว่าก่อน
    return p.walk - q.walk;
  });
  return out;
}

function formatOtherRoutes_(othersByLeg) {
  const blocks = [];
  const multi = othersByLeg.length > 1;
  othersByLeg.forEach(function (l) {
    if (!l.items.length) return;
    const lines = [];
    l.items.slice(0, 5).forEach(function (o) {
      const where = (o.nearO && o.nearD) ? 'ผ่านใกล้ทั้งต้นทางและปลายทาง'
        : o.nearD ? 'ผ่านใกล้ปลายทาง (' + o.stopD + ')' : 'ผ่านใกล้ต้นทาง (' + o.stopO + ')';
      lines.push('• สาย ' + routeLabel_(o.route) + ' – ' + where + ' · ' + frequencyLabel_(o.route) + (function () { const nd = nextDepartureInfo_(o.route); return nd && nd.exact ? ' · ออกถัดไป ' + nd.label : ''; })());
    });
    blocks.push((multi ? 'ช่วง ' + l.from + ' → ' + l.to + '\n' : '') + lines.join('\n'));
  });
  if (!blocks.length) return '';
  return '🚌 สายอื่นที่ผ่านใกล้เส้นทางนี้ (เรียงจากวิ่งถี่ที่สุด)\n' + blocks.join('\n\n');
}

/* =====================================================================
 * ถามตามหมวดรถ เช่น "รถหมวด 1" "หมวด 4" "หมวด 1, 2"
 *   -> แสดงรายการสายรถทุกสายในหมวดนั้น (อ่านเลขหมวดจากคอลัมน์ C ประเภทรถ -> B ชื่อสาย -> K หมายเหตุ
 *      ช่องไหนมีข้อความ "หมวด <เลข>" ก่อนใช้ช่องนั้น) แล้วมีปุ่มกดดูรายละเอียดแต่ละสาย
 * ===================================================================== */

function toArabicDigits_(s) {
  return String(s || '').replace(/[๐-๙]/g, function (d) { return '๐๑๒๓๔๕๖๗๘๙'.indexOf(d); });
}

/** คืน {num, desc} เช่น {num:1, desc:'รถในอำเภอเมืองบึงกาฬ'} หรือ null ถ้าสายนี้ไม่ระบุหมวด */
function getRouteCategory_(r) {
  const fields = [r.type, r.name, r.note];
  for (let i = 0; i < fields.length; i++) {
    const m = toArabicDigits_(fields[i]).match(/หมวด\s*(\d+)\s*([^()（）]*)/);
    if (m) return { num: parseInt(m[1], 10), desc: String(m[2] || '').replace(/^[\s:\-–—]+|[\s,;]+$/g, '') };
  }
  return null;
}

/** คืน true ถ้าตอบแล้ว (ไม่พบหมวดในข้อมูลเลย = false ให้ระบบเดิมทำงานต่อ) */
function handleBusCategory_(userId, userText, replyToken) {
  const raw = toArabicDigits_(String(userText || '').trim());
  if (!raw || raw.length > 40) return false;
  const seg = raw.match(/หมวด\s*\d+(?:\s*(?:,|และ|กับ)\s*(?:หมวด\s*)?\d+)*/g);
  if (!seg) return false;
  const nums = [];
  (seg.join(' ').match(/\d+/g) || []).forEach(function (n) {
    const v = parseInt(n, 10);
    if (nums.indexOf(v) === -1) nums.push(v);
  });
  if (!nums.length) return false;

  const map = {};
  getRoutes_().forEach(function (r) {
    const c = getRouteCategory_(r);
    if (!c) return;
    if (!map[c.num]) map[c.num] = { desc: '', routes: [] };
    if (!map[c.num].desc && c.desc) map[c.num].desc = c.desc;
    map[c.num].routes.push(r);
  });
  const available = Object.keys(map).map(Number).sort(function (a, b) { return a - b; });
  if (!available.length) return false; // ชีต Routes ยังไม่มีข้อมูลหมวด

  const blocks = [];
  const items = [];
  nums.forEach(function (n) {
    const g = map[n];
    if (!g) {
      blocks.push('ยังไม่พบรถหมวด ' + n + ' ในระบบค่ะ (ตอนนี้มีหมวด ' + available.join(', ') + ')');
      return;
    }
    const lines = ['🚌 รถหมวด ' + n + (g.desc ? ' ' + g.desc : '')];
    g.routes.forEach(function (r, i) {
      const label = routeLabel_(r);
      const path = (r.from && r.to && label.indexOf(r.from) === -1) ? ' (' + r.from + ' → ' + r.to + ')' : '';
      lines.push((i + 1) + '. สาย ' + label + path + routeWarn_(r));
      if (r.cardId && items.length < MAX_QUICK_ITEMS) items.push(cardQuickItem_(r));
    });
    blocks.push(lines.join('\n'));
  });
  let answer = blocks.join('\n\n');
  if (items.length) answer += '\n\nกดชื่อสายด้านล่างเพื่อดูรายละเอียดเส้นทางค่ะ';
  answer = answer.substring(0, 4900);

  clearPending_(userId);
  const res = replyTextQuick_(replyToken, answer, items);
  logInteraction_(userId, userText, 'Bus', '[หมวดรถ] ' + answer, res);
  return true;
}

/** ทดสอบใน Editor: ดูว่าแต่ละสายถูกจัดอยู่หมวดไหน (ไม่ส่งอะไรเข้า LINE) */
function debugBusCategory() {
  getRoutes_().forEach(function (r) {
    const c = getRouteCategory_(r);
    console.log(routeLabel_(r) + '  ->  ' + (c ? 'หมวด ' + c.num + ' ' + c.desc : 'ไม่พบคำว่า "หมวด N" ในคอลัมน์ B/C/K'));
  });
}

/* =====================================================================
 * ถามไปจังหวัดอื่นนอกเหนือจุดที่รถในระบบผ่าน เช่น "ไปภูเก็ต" "ไปจังหวัดขอนแก่น"
 *   -> ค้นพิกัดจังหวัดนั้นจาก Google Maps แล้วแสดงสายรถที่วิ่งไป "ใกล้จังหวัดนั้นที่สุด" (เรียงจากใกล้ไปไกล)
 *   ใช้ได้เมื่อจุดผ่านของสายมีพิกัดในชีต Stops (ถ้าไม่มีพิกัดสายนั้นจะถูกข้าม)
 *   ไม่ใช้ Gemini ไม่เสียโควตา
 * ===================================================================== */

const FAR_MAX_ROUTES = 4;
const FAR_ROAD_ROUTES = 6;     // คัดสายที่ใกล้สุดตามเส้นตรงมา N สาย แล้วค่อยวัดระยะถนนจริง (ประหยัดโควตา Maps)
const FAR_ROAD_STOPS = 2;      // แต่ละสายวัดระยะถนนจากจุดผ่านที่ใกล้ที่สุดตามเส้นตรง N จุด แล้วเลือกจุดที่ถนนสั้นที่สุด
const FAR_MIN_PROGRESS = 0.25;  // สายต้องพาไปใกล้จังหวัดนั้นกว่าตัวเมืองบึงกาฬอย่างน้อย 25% ของระยะทาง จึงจะแนะนำ (กันสายที่ขึ้นเหนือ/ไปไม่ถึงไหนโผล่มา)
const BUENGKAN_CENTER = { lat: 18.3609, lng: 103.6466 };
const FAR_TAIL_WORDS = /(ยังไง|อย่างไร|ได้ไหม|ได้มั้ย|ไหม|มั้ย|หรือเปล่า|ครับ|ค่ะ|คะ|นะ|หน่อย|บ้าง|เท่าไหร่|กี่โมง|ทางไหน|ได้|ด้วย)$/;

/** ดึงชื่อจังหวัดที่ผู้ใช้อยากไปจากข้อความสั้นๆ เช่น "ไปภูเก็ต" "ไปจังหวัดภูเก็ตยังไง" คืนชื่อ หรือ '' */
function extractFarDestination_(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 40) return '';
  let m = s.match(/(?:ไปที่|ไป|เดินทางไป|ขึ้นรถไป|รถไป|มีรถไป)\s*(?:จังหวัด|จ\.)?\s*([ก-๙]{2,25})/) ||
          s.match(/จังหวัด\s*([ก-๙]{2,25})/);
  if (!m) return '';
  let name = m[1];
  for (let i = 0; i < 4; i++) {
    const t = name.replace(FAR_TAIL_WORDS, '');
    if (t === name) break;
    name = t;
  }
  return name.length >= 2 ? name : '';
}

/**
 * ค้นพิกัดสถานที่ในประเทศไทยที่อยู่นอกจังหวัดบึงกาฬ (ไม่ต่อท้ายคำว่าบึงกาฬ) คืน {name, lat, lng} หรือ null
 *   wide=false (ค่าเริ่มต้น): รับเฉพาะ "จังหวัด" (fillStopCoordinates ใช้แบบนี้ กันจุดผ่านได้พิกัดผิดที่)
 *   wide=true : รับ "อำเภอ/ตำบล" ด้วย (ใช้ตอบคำถามผู้ใช้ เช่น "ไปอำเภอปาย")
 *   ตรวจว่าผลลัพธ์มีชื่อที่พิมพ์อยู่ในที่อยู่จริงและอยู่ในไทย ข้อความมั่วจึงไม่ผ่าน / เก็บแคชเฉพาะผลที่สำเร็จ
 */
function geocodeProvince_(name, wide) {
  const raw = String(name || '').trim();
  const core = raw.replace(/^(อำเภอ|อ\.|ตำบล|ต\.|จังหวัด|จ\.)\s*/, '').trim();
  if (core.length < 2 || core.indexOf('บึงกาฬ') !== -1) return null;
  const explicitSub = /^(อำเภอ|อ\.|ตำบล|ต\.)/.test(raw);

  const key = 'prov2_' + (wide ? 'w_' : 'p_') + normalizeForMatch_(raw);
  let cache = null;
  try { cache = CacheService.getScriptCache(); const c = cache.get(key); if (c) return JSON.parse(c); } catch (e) { /* ignore */ }

  // ลำดับคำค้น + ระดับที่ยอมรับ
  const tries = [];
  if (!explicitSub) tries.push({ q: 'จังหวัด' + core, levels: ['administrative_area_level_1'] });
  if (wide) {
    tries.push({
      q: (explicitSub ? raw : 'อำเภอ' + core) + ' ประเทศไทย',
      levels: explicitSub ? ['administrative_area_level_2', 'administrative_area_level_3', 'locality'] : ['administrative_area_level_2']
    });
    if (!explicitSub) tries.push({ q: core + ' ประเทศไทย', levels: ['administrative_area_level_2'] });
  }

  let out = null;
  for (let i = 0; i < tries.length && !out; i++) {
    try {
      const r = Maps.newGeocoder().setRegion('th').setLanguage('th').geocode(tries[i].q);
      if (!r || r.status !== 'OK') continue;
      for (let j = 0; j < r.results.length && !out; j++) {
        const g = r.results[j];
        const addr = String(g.formatted_address || '').replace(/\s+/g, '');
        const okType = (g.types || []).some(function (t) { return tries[i].levels.indexOf(t) !== -1; });
        if (okType && addr.indexOf(core) !== -1 && /ไทย|Thailand/.test(addr) && addr.indexOf('บึงกาฬ') === -1) {
          out = { name: raw.replace(/^(จังหวัด|จ\.)\s*/, ''), lat: g.geometry.location.lat, lng: g.geometry.location.lng };
        }
      }
    } catch (e) { console.error('geocodeProvince_ error: ' + e); }
  }
  try { if (cache && out) cache.put(key, JSON.stringify(out), 21600); } catch (e) { /* ignore */ }
  return out;
}

/** คืน true ถ้าตอบแล้ว */
function handleFarDestination_(userId, userText, replyToken) {
  const name = extractFarDestination_(userText);
  if (!name) return false;
  const model = buildBusModel_();
  if (!model.routes.length) return false;
  const dest = geocodeProvince_(name, true);
  if (!dest) {
    logInteraction_(userId, userText, 'FarDestMiss', '(ค้นพิกัดปลายทาง "' + name + '" ไม่ได้ หรือไม่ใช่จังหวัด/อำเภอในไทย รัน debugFarDestination() ดูผลดิบจาก Google Maps)', null);
    return false;
  }

  const ranked = [];
  model.routes.forEach(function (r) {
    if (!routeUsableFrom_(r, 'บึงกาฬ')) return; // ผู้ใช้เริ่มจากบึงกาฬ: สายที่หยุดวิ่ง/ไม่มีรถออกจากบึงกาฬไม่นำมาแนะนำ
    const cands = [];
    r.seq.forEach(function (s) {
      if (s.lat === null || s.lat === undefined) return;
      cands.push({ stop: s.name, lat: s.lat, lng: s.lng, km: haversineKm_(dest, s) });
    });
    cands.sort(function (p, q) { return p.km - q.km; });
    if (cands.length) ranked.push({ route: r, stop: cands[0].stop, km: Math.round(cands[0].km), cands: cands.slice(0, FAR_ROAD_STOPS), freq: parseTripsPerDay_(r), estimated: false });
  });
  if (!ranked.length) return false; // สายยังไม่มีพิกัดจุดผ่านเลย ให้ระบบเดิมทำงานต่อ

  // เก็บเฉพาะสายที่ "พาไปทางจังหวัดนั้นจริง": จุดที่ใกล้สุดต้องใกล้กว่าตัวเมืองบึงกาฬอย่างน้อย FAR_MIN_PROGRESS
  const originKm = haversineKm_(BUENGKAN_CENTER, dest);
  const toward = ranked.filter(function (o) { return o.km <= originKm * (1 - FAR_MIN_PROGRESS); });
  const noCoord = [];
  model.routes.forEach(function (r) {
    const nc = r.seq.filter(function (s) { return s.lat === null || s.lat === undefined; }).map(function (s) { return s.name; });
    if (nc.length) noCoord.push('สาย ' + r.id + ': ' + nc.join(','));
  });
  const noCoordNote = noCoord.length ? ' [จุดผ่านที่ยังไม่มีพิกัด อาจทำให้สายที่ไปทางนั้นตกหล่น -> ' + noCoord.join(' ; ') + ' | รัน fillStopCoordinates()]' : '';
  if (!toward.length) {
    const msg = 'ตอนนี้ยังไม่พบสายรถในระบบที่วิ่งไปทางจังหวัด' + name + 'ค่ะ 🙏 สอบถามเจ้าหน้าที่เพื่อวางแผนการเดินทางและการต่อรถได้เลยนะคะ';
    const r0 = replyMessage_(replyToken, msg);
    logInteraction_(userId, userText, 'Bus', '[ไปจังหวัดอื่น ' + name + '] (ไม่มีสายที่พาไปใกล้กว่าตัวเมืองบึงกาฬ ' + Math.round(originKm * (1 - FAR_MIN_PROGRESS)) + ' กม.)' + noCoordNote, r0);
    clearPending_(userId);
    return true;
  }
  // วัดระยะ "ทางถนน" จากจุดผ่านที่ใกล้สุดไปปลายทาง (Google Maps) ใช้เฉพาะสายที่ใกล้สุดตามเส้นตรงไม่กี่สาย
  toward.sort(function (p, q) { return p.km - q.km; });
  ranked.length = 0;
  toward.slice(0, FAR_ROAD_ROUTES).forEach(function (o) {
    let bestRoad = null;
    o.cands.forEach(function (c) {
      const l = computeLeg_(c, dest);
      if (!bestRoad || l.km < bestRoad.km) bestRoad = { stop: c.stop, km: l.km, estimated: !!l.estimated };
    });
    if (bestRoad) { o.stop = bestRoad.stop; o.km = Math.round(bestRoad.km); o.estimated = bestRoad.estimated; }
    ranked.push(o);
  });
  ranked.sort(function (p, q) {
    if (p.km !== q.km) return p.km - q.km;
    if ((p.freq === null) !== (q.freq === null)) return p.freq === null ? 1 : -1;
    return (q.freq || 0) - (p.freq || 0);
  });

  const top = ranked.slice(0, FAR_MAX_ROUTES);
  const lines = ['ตอนนี้ยังไม่มีสายตรงไปจังหวัด' + name + 'ในระบบค่ะ 🙏', 'สายที่วิ่งไปใกล้จังหวัด' + name + 'ที่สุด (เรียงจากใกล้ไปไกล)'];
  top.forEach(function (o, i) {
    let l = (i + 1) + '. สาย ' + routeLabel_(o.route) + '\n   ไปได้ถึง ' + o.stop + ' (ห่างจังหวัด' + name + 'ประมาณ ' + o.km + ' กม. ทางถนน' + (o.estimated ? ' ค่าประมาณ' : '') + ')';
    if (o.route.boarding) l += '\n   ขึ้นรถ: ' + o.route.boarding;
    const nd = nextDepartureInfo_(o.route);
    if (nd && nd.exact) l += '\n   ออกถัดไป: ' + nd.label;
    l += '\n   ความถี่: ' + frequencyLabel_(o.route);
    lines.push(l);
  });
  lines.push('\nต้องต่อรถจากจุดดังกล่าวไปยังจังหวัด' + name + ' สอบถามเจ้าหน้าที่เพื่อยืนยันเส้นทางและเวลาอีกครั้งได้เลยนะคะ');

  const items = [];
  top.forEach(function (o) { if (o.route.cardId && items.length < MAX_QUICK_ITEMS) items.push(cardQuickItem_(o.route)); });
  const answer = lines.join('\n').substring(0, 4900);
  clearPending_(userId);
  const res = replyTextQuick_(replyToken, answer, items);
  logInteraction_(userId, userText, 'Bus', '[ไปจังหวัดอื่น ' + name + '] ' + answer + noCoordNote, res);
  return true;
}

/** ทดสอบใน Editor (ไม่ส่งเข้า LINE): ดูว่าข้อความไหนถูกตีเป็นที่ไหน และผลดิบที่ Google Maps ตอบ (แก้รายการข้อความได้) */
function debugFarDestination() {
  ['ไปภูเก็ต', 'ไปกระบี่', 'ไปอำเภอปาย', 'ไปปาย', 'ไปขอนแก่นยังไง', 'ไปทำใบขับขี่'].forEach(function (t) {
    const n = extractFarDestination_(t);
    const d = n ? geocodeProvince_(n, true) : null;
    console.log(t + '  ->  ชื่อ "' + n + '"  ' + (d ? 'รับได้ พิกัด ' + d.lat + ',' + d.lng : 'ไม่รับ (ไม่ใช่จังหวัด/อำเภอ หรือค้นไม่เจอ)'));
    if (n && !d) {
      const core = n.replace(/^(อำเภอ|อ\.|ตำบล|ต\.|จังหวัด|จ\.)\s*/, '');
      [/^(อำเภอ|อ\.|ตำบล|ต\.)/.test(n) ? n + ' ประเทศไทย' : 'จังหวัด' + core, core + ' ประเทศไทย'].forEach(function (q) {
        try {
          const r = Maps.newGeocoder().setRegion('th').setLanguage('th').geocode(q);
          console.log('   ค้น "' + q + '" status=' + (r && r.status) + ' ผล ' + ((r && r.results) ? r.results.length : 0) + ' รายการ');
          ((r && r.results) || []).slice(0, 3).forEach(function (g) { console.log('     - ' + g.formatted_address + ' | ' + (g.types || []).join(',')); });
        } catch (e) { console.log('   ค้น "' + q + '" error: ' + e); }
      });
    }
  });
}

/* ---------- ตอบ LINE ---------- */

/** ชื่อสายสำหรับแสดงผู้ใช้: "เลขสาย ชื่อสาย" (ไม่ซ้ำเลขถ้าชื่อขึ้นต้นด้วยเลขอยู่แล้ว) */
function routeLabel_(r) {
  const id = String(r.id || '').trim();
  const name = String(r.name || '').trim();
  if (!name) return id;
  if (!id || name.indexOf(id) === 0) return name;
  return id + ' ' + name;
}

function cardQuickItem_(route) {
  const label = ('สาย ' + routeLabel_(route)).substring(0, 20);
  return { type: 'action', action: { type: 'postback', label: label, data: ('card=' + route.cardId + '&t=' + encodeURIComponent(label)).substring(0, 300) } };
}
function locationQuickItem_() { return { type: 'action', action: { type: 'location', label: 'แชร์ตำแหน่ง' } }; }

/* ---------- ตัวควบคุม ---------- */

/** ข้อความที่เป็นคำถามใหม่ (จะไป/มีรถไหม/กี่โมง/ราคา ฯลฯ) ต่างจากการตอบสั้นๆ ว่า "ขึ้นที่บึงกาฬ" */
function looksLikeNewQuestion_(text) {
  const s = String(text || '').trim();
  // มีคำว่า "ไป" (ยกเว้นไปรษณีย์) หรือลงท้ายด้วย "ต่อ" = ผู้ใช้กำลังบอกจุดหมายใหม่ ไม่ใช่ตอบว่าต้นทางอยู่ที่ไหน
  if ((/ไป/.test(s) && !/ไปรษณีย์/.test(s)) || /ต่อ$/.test(s)) return true;
  return /^(จะ|อยาก|ขอ)?ไป/.test(s) ||
    /(จะไป|อยากไป|ขอไป|ไป.{0,12}(ไหม|มั้ย|หรือเปล่า|ยังไง|อย่างไร)|มีรถ|รถ.{0,8}(กี่โมง|ผ่าน|ไป)|กี่โมง|ออกกี่|เวลา|ราคา|ค่าโดยสาร|เท่าไหร่|สายไหน|วางแผน|ทริป|แล้วไป|ต่อไป)/.test(s);
}

/** คืน true ถ้าตอบไปแล้ว */
function handleBusText_(userId, userText, replyToken) {
  const model = buildBusModel_();
  if (!model.routes.length) return false;
  const text = String(userText || '').trim();
  const pending = getPending_(userId) || {};

  // ข้อความที่ตรงกับเมนู/การ์ดเดิม (เช่นกดริชเมนูรถโดยสาร) ต้องไม่ถูกตีเป็นคำตอบต้นทาง: ล้างคำถามค้างแล้วปล่อยให้ระบบเดิมทำงาน
  if (pending.request && typeof findBestTopicMatch_ === 'function' && findBestTopicMatch_(text)) {
    clearPending_(userId);
    return false;
  }

  // ถ้าข้อความนี้เป็น "คำถามใหม่" (ไม่ใช่การบอกต้นทาง) ให้ทิ้งคำถามค้างเดิม แล้วตอบเรื่องใหม่แทน
  if (pending.request && looksLikeNewQuestion_(text)) {
    clearPending_(userId);
    pending.request = null;
    pending.kind = null;
  }

  // ผู้ใช้กำลังตอบ "ต้นทางอยู่ที่ไหน" ของคำถามรถโดยสารที่ค้างอยู่
  if (pending.kind === 'bus' && pending.awaiting && pending.request && text.length <= 80 &&
      findKnownPoints_(text, model).length < 2 && !/แล้วไป|ต่อไป|วางแผน/.test(text)) {
    clearPending_(userId);
    return finishBusTrip_(userId, pending.request, { text: text }, replyToken);
  }

  // พิมพ์เลขสายตรงๆ เช่น "841" หรือ "สายที่ 841" -> เปิดอินโฟสายนั้นเลย
  const mNum = text.match(/^(?:สาย(?:ที่)?\s*)?(\d{1,4})\s*(?:ครับ|ค่ะ|คะ)?$/) || text.match(/สาย(?:ที่)?\s*(\d{1,4})/);
  if (mNum) {
    const byNum = model.routes.filter(function (r) { return String(r.id) === mNum[1] || String(r.name).split(/\s+/)[0] === mNum[1]; })[0];
    if (byNum) return replyRouteInfo_(userId, text, replyToken, byNum);
  }

  const hits = findKnownPoints_(text, model);
  if (!hits.length) {
    // ไม่ได้ระบุสถานที่เจาะจง แต่ถามภาพรวมแหล่งท่องเที่ยวกับรถโดยสาร
    if (isTourismBusQuestion_(text)) return handleTourismBus_(userId, text, replyToken, model);
    return false;
  }

  const wantsPlan = /แล้วไป|ต่อไป|จากนั้น|ก่อน|→|->|วางแผน|ทริป|จาก.+(ไป|ถึง)/.test(text);
  const multi = hits.length >= 2 || wantsPlan;

  if (multi) {
    if (pending.origin) { clearPending_(userId); return finishBusTrip_(userId, text, pending.origin, replyToken); }
    if (/จาก/.test(text) || hits.length >= 2) {
      // ต้นทางอาจอยู่ในประโยค ให้ finishBusTrip_ ให้ Gemini แยก ถ้าหาไม่เจอจะถามตำแหน่งต่อเอง
      return finishBusTrip_(userId, text, null, replyToken);
    }
    setPending_(userId, { kind: 'bus', request: text, awaiting: true });
    const r = replyTextQuick_(replyToken, 'ขอทราบจุดเริ่มต้นก่อนนะคะ 📍 กด "แชร์ตำแหน่ง" หรือพิมพ์ชื่อสถานที่/ตำบลที่อยู่ได้เลยค่ะ', [locationQuickItem_()]);
    logInteraction_(userId, text, 'Bus', '(ขอต้นทาง)', r);
    return true;
  }

  // โหมด 1: จุดเดียว ข้อความสั้นหรือเป็นคำถามเดินทาง
  const h = hits[0];
  const short = normalizeForMatch_(text).length <= h.len + 18;
  // ประโยคยาวที่ถามเรื่องรถ เช่น "ผมจะไปอุดร มีรถไปไหมครับ" (มีคำเกี่ยวกับการไป + คำเกี่ยวกับรถ)
  const busIntent = /(ไป|มา|ถึง|ผ่าน|นั่ง|ขึ้น|ลง|เดินทาง)/.test(text) && /(รถ|สาย|ทัวร์|โดยสาร)/.test(text);
  if (!short && !busIntent && !isTravelQuestion_(text, getPlaces_())) return false;

  const near = routesNearPoint_(model, h.point);
  if (!near.length) {
    const r = replyTextQuick_(replyToken,
      'ตอนนี้ยังไม่พบสายรถโดยสารที่ผ่านหรืออยู่ใกล้ "' + h.point.name + '" ในระบบค่ะ 🙏 หากต้องการ กดแชร์ตำแหน่งเพื่อให้ช่วยหาทางที่ใกล้ที่สุด หรือสอบถามเจ้าหน้าที่ได้เลยนะคะ',
      [locationQuickItem_()]);
    logInteraction_(userId, text, 'Bus', '(ไม่พบสายที่ผ่าน ' + h.point.name + ')', r);
    setPending_(userId, { kind: 'bus', request: text, awaiting: false });
    return true;
  }

  const withCard = near.filter(function (n) { return n.route.cardId; });
  setPending_(userId, { kind: 'bus', request: 'จากตำแหน่งที่ผู้ใช้ ไป ' + h.point.name, awaiting: false });

  if (near.length === 1 && withCard.length === 1 && typeof replyTopic_ === 'function') {
    const rep = replyTopic_(replyToken, withCard[0].route.cardId,
      { raw: '🚌 สายรถที่ผ่านหรือใกล้ "' + h.point.name + '"' });
    if (rep) {
      logInteraction_(userId, text, 'Bus', '[สาย ' + withCard[0].route.name + '] ' + rep.answer, rep.result);
      return true;
    }
  }

  const lines = ['🚌 สายรถที่ผ่านหรือใกล้ "' + h.point.name + '"'];
  near.forEach(function (n) {
    lines.push('• สาย ' + routeLabel_(n.route) + ' (' + (n.route.type || 'รถโดยสาร') + ') ' +
      (n.walkKm === 0 ? 'ผ่านจุด ' + n.stop : 'ลงที่ ' + n.stop + ' แล้วเดินประมาณ ' + n.walkKm + ' กม.'));
  });
  lines.push('\nกดชื่อสายด้านล่างเพื่อดูรายละเอียดเส้นทาง หรือกด "แชร์ตำแหน่ง" ให้ช่วยวางแผนจากจุดที่คุณอยู่ค่ะ');
  const items = withCard.slice(0, MAX_QUICK_ITEMS - 1).map(function (n) { return cardQuickItem_(n.route); });
  items.push(locationQuickItem_());
  const res = replyTextQuick_(replyToken, lines.join('\n'), items);
  logInteraction_(userId, text, 'Bus', lines.join(' | '), res);
  return true;
}

/** เปิดอินโฟของสายเดียว (ถ้ามีรหัสการ์ด) ไม่งั้นสรุปเป็นข้อความจากชีต Routes */
function replyRouteInfo_(userId, text, replyToken, route) {
  if (route.cardId && typeof replyTopic_ === 'function') {
    const rep = replyTopic_(replyToken, route.cardId, { raw: '🚌 สาย ' + routeLabel_(route) });
    if (rep) {
      logInteraction_(userId, text, 'Bus', '[สาย ' + route.id + '] ' + rep.answer, rep.result);
      return true;
    }
  }
  const lines = ['🚌 สาย ' + routeLabel_(route) + (route.type ? ' (' + route.type + ')' : '')];
  if (route.from || route.to) lines.push('เส้นทาง: ' + route.from + ' → ' + route.to);
  if (route.boarding) lines.push('จุดขึ้นรถ: ' + route.boarding);
  if (route.schedule) lines.push('เวลา: ' + route.schedule);
  if (route.fare) lines.push('ค่าโดยสาร: ' + route.fare);
  if (route.phone) lines.push('โทร: ' + route.phone);
  const res = replyMessage_(replyToken, lines.join('\n'));
  logInteraction_(userId, text, 'Bus', lines.join(' | '), res);
  return true;
}

/** ผู้ใช้แชร์ตำแหน่งตอนมีคำถามรถโดยสารค้างอยู่ -> เรียกจาก handleLocationEvent_ */
function finishBusTrip_(userId, requestText, origin, replyToken) {
  const model = buildBusModel_();
  const places = getPlaces_();
  const points = [];   // จุดที่จะไป ตามลำดับ
  let o = null;        // จุดเริ่มต้น {lat,lng,keys,name}

  if (origin && origin.lat !== undefined) {
    o = { name: origin.label || 'ตำแหน่งของคุณ', lat: origin.lat, lng: origin.lng, keys: [] };
  }

  const hits = findKnownPoints_(requestText, model);
  let ordered = hits.map(function (h) { return h.point; });

  // ต้องการแยกต้นทาง/ลำดับจุดที่ซับซ้อนกว่าตรงๆ -> ให้ Gemini ช่วย (1 คำขอ)
  const needAi = !o && (!origin || !origin.text) || /จาก/.test(requestText) || ordered.length > 1;
  if (needAi) {
    const ai = extractBusTrip_(requestText, model);
    if (ai) {
      if (ai.origin && !o && !(origin && origin.text)) origin = { text: ai.origin };
      if (ai.points.length) {
        const mapped = ai.points.map(function (n) {
          const k = findKnownPoints_(n, model)[0];
          return k ? k.point : resolveFreeText_(n);
        }).filter(Boolean);
        if (mapped.length) ordered = mapped;
      }
    }
  }

  if (!o && origin && origin.text) {
    const k = findKnownPoints_(origin.text, model)[0];
    const p = k ? k.point : resolveFreeText_(origin.text);
    if (p && ((p.lat !== null && p.lat !== undefined) || (p.keys && p.keys.length))) {
      o = { name: p.name || origin.text, lat: p.lat === undefined ? null : p.lat, lng: p.lng === undefined ? null : p.lng, keys: p.keys || [] };
    }
  }

  // ถ้าต้นทางเป็นหนึ่งในจุดที่พิมพ์มา (จาก A ไป B) ให้ตัดออกจากรายการปลายทาง
  if (o && o.keys && o.keys.length) {
    ordered = ordered.filter(function (p) { return !(p.keys && p.keys[0] === o.keys[0]); });
  }

  if (!o) {
    setPending_(userId, { kind: 'bus', request: requestText, awaiting: true });
    const r = replyTextQuick_(replyToken, 'ขอทราบจุดเริ่มต้นก่อนนะคะ 📍 กด "แชร์ตำแหน่ง" หรือพิมพ์ชื่อสถานที่/ตำบลที่อยู่ได้เลยค่ะ', [locationQuickItem_()]);
    logInteraction_(userId, requestText, 'Bus', '(ขอต้นทาง)', r);
    return true;
  }
  if (!ordered.length) {
    const r = replyMessage_(replyToken, 'ขออภัยค่ะ ยังไม่พบจุดหมายที่ต้องการ ลองพิมพ์ชื่อสถานที่อีกครั้งนะคะ 🙏');
    logInteraction_(userId, requestText, 'Bus', '(ไม่พบจุดหมาย)', r);
    return true;
  }
  ordered = ordered.slice(0, TRAVEL_MAX_STOPS);

  // คำนวณทีละช่วง
  const legs = [];
  const usedRoutes = {};
  const othersByLeg = [];
  let from = o;
  ordered.forEach(function (to) {
    const hasPos = (to.lat !== null && to.lat !== undefined) || (to.keys && to.keys.length);
    if (!hasPos) {
      legs.push({ from: from.name, to: to.name, result: 'unknown', note: 'ไม่มีข้อมูลตำแหน่งของจุดหมายนี้ในระบบ' });
    } else {
      const plan = planLeg_(model, from, to);
      const opts = plan.options.map(function (op) {
        if (op.type === 'direct') {
          usedRoutes[op.route.id] = op.route;
          return { type: 'ตรง', route: routeBrief_(op.route), boardAt: op.board, walkToBoardKm: op.walkToBoardKm,
            alightAt: op.alight, walkFromAlightKm: op.walkFromAlightKm, direction: op.direction, stopsBetween: op.stopsBetween,
            ride: rideLeg_(op.route, op.boardIdx, op.alightIdx) };
        }
        usedRoutes[op.first.route.id] = op.first.route; usedRoutes[op.second.route.id] = op.second.route;
        return { type: 'ต่อรถ 1 ครั้ง', first: { route: routeBrief_(op.first.route), boardAt: op.first.board, walkToBoardKm: op.first.walkToBoardKm, alightAt: op.first.alight,
            ride: rideLeg_(op.first.route, op.first.boardIdx, op.first.alightIdx) },
          second: { route: routeBrief_(op.second.route), boardAt: op.second.board, alightAt: op.second.alight, walkFromAlightKm: op.second.walkFromAlightKm,
            ride: rideLeg_(op.second.route, op.second.boardIdx, op.second.alightIdx) },
          transferWalkKm: op.transferWalkKm };
      });
      const roadInfo = roadBetween_(from, to);
      const leg = { from: from.name, to: to.name, result: plan.kind, roadBetweenPoints: roadInfo, options: opts };
      if (!roadInfo) leg.distanceNote = 'ไม่มีพิกัดของจุดนี้ในระบบ จึงไม่ทราบระยะทาง ห้ามระบุระยะทางของช่วงนี้';
      legs.push(leg);
      // สายอื่นที่ผ่านใกล้ต้นทาง/ปลายทาง (ที่ยังไม่ได้แนะนำ) เรียงตามความถี่ — โค้ดสร้างเอง ไม่ส่งให้ Gemini
      const excl = {};
      plan.options.forEach(function (op) {
        if (op.type === 'direct') excl[op.route.id] = true;
        else { excl[op.first.route.id] = true; excl[op.second.route.id] = true; }
      });
      const others = otherRoutesForLeg_(model, from, to, excl);
      othersByLeg.push({ from: from.name, to: to.name, items: others });
      others.slice(0, 5).forEach(function (o2) { usedRoutes[o2.route.id] = usedRoutes[o2.route.id] || o2.route; });
    }
    from = to;
  });

  const facts = { userRequest: requestText, legs: legs };
  const prompt =
    'คุณเป็นเจ้าหน้าที่ขนส่งจังหวัดบึงกาฬ ตอบผ่านไลน์ ภาษาไทยสุภาพ ลงท้าย "ค่ะ" กระชับ อ่านง่าย ไม่เกิน 1,200 ตัวอักษร\n' +
    'ผลการคำนวณสายรถโดยสารอยู่ใน JSON ด้านล่าง (คำนวณจากระยะห่างของจุดจริงแล้ว) ให้เรียบเรียงเป็นคำแนะนำเดินทางตามลำดับช่วง\n' +
    'กติกา: ใช้เฉพาะข้อมูลใน JSON ห้ามแต่งสาย เวลา ราคา หรือจุดขึ้น-ลงเพิ่ม\n' +
    '- เวลาพูดถึงสายรถต้องเขียนว่า "สาย " ตามด้วยค่า route.label ทุกตัวอักษร (ซึ่งมีรหัสสายนำหน้าอยู่แล้ว) ห้ามตัดรหัสหรือเลขสายออก\n' +
    '- ถ้า route มี nextDeparture ให้บอกเวลาออกถัดไป และ frequency ให้บอกความถี่ของสายที่แนะนำ (เป็นเวลาตามตาราง ควรยืนยันกับผู้ให้บริการ) ถ้าไม่มีค่าไม่ต้องพูดถึง ห้ามเดา\n' +
    '- ถ้า route.note มีข้อจำกัดของสาย ให้บอกผู้ใช้สั้นๆ ด้วย\n' +
    '- ห้ามใช้เครื่องหมาย ** หรือ markdown ใดๆ (LINE แสดงเป็นตัวอักษรดิบ) ใช้ข้อความธรรมดากับอีโมจิ/เครื่องหมาย • เท่านั้น\n' +
    '- walkToBoardKm / walkFromAlightKm / transferWalkKm คือ "ระยะเดิน" เท่านั้น ไม่ใช่ระยะทางของการเดินทาง ถ้าเป็น 0 แปลว่าไม่ต้องเดิน ห้ามเขียนว่า "0 กม." หรือนำไปบอกเป็นระยะทาง\n' +
    '- ระยะทางของแต่ละช่วงให้ใช้ roadBetweenPoints.roadKm (ระยะทางถนนจากจุดเริ่มถึงจุดหมายโดยประมาณ) และ ride.roadKm ของแต่ละสาย (ระยะที่นั่งรถจากจุดขึ้นถึงจุดลง) ' +
    'ถ้า estimated=true ให้บอกว่าเป็นค่าประมาณ ถ้าไม่มีค่าให้ไม่ต้องพูดถึงระยะทาง ห้ามเดา และห้ามสัญญาเวลานั่งรถ (เวลาจริงขึ้นกับตารางรถ)\n' +
    '- ทุกช่วงให้บอก: ขึ้นสายอะไร ขึ้นที่ไหน ลงที่ไหน ต้องเดินไปขึ้น/จากจุดลงกี่กม. (ถ้า 0 ไม่ต้องพูดถึง)\n' +
    '- ถ้า options มีหลายตัว ให้แนะนำตัวแรกเป็นหลัก และพูดถึงตัวอื่นสั้นๆ ว่าเป็นทางเลือก\n' +
    '- result=transfer ให้บอกจุดต่อรถและระยะเดินต่อรถ  result=none หรือ unknown ให้บอกตรงๆ ว่ายังไม่พบสายที่ไปถึงได้ และแนะนำสอบถามเจ้าหน้าที่\n' +
    '- ใส่เวลา/ความถี่ ค่าโดยสาร เบอร์ติดต่อ เฉพาะที่มีค่าในข้อมูล และบอกว่าเวลาและค่าโดยสารควรยืนยันกับผู้ให้บริการอีกครั้ง\n\n' +
    '=== ข้อมูล JSON ===\n' + JSON.stringify(facts) + '\n=== จบข้อมูล ===';

  let answer = callGeminiTravel_(prompt, 1024, false);
  let geminiNote = '';
  if (!answer) {
    answer = buildPlainBusAnswer_(legs);
    geminiNote = ' [Gemini ล้มเหลว: ' + (typeof GEMINI_LAST_ERROR_ !== 'undefined' ? GEMINI_LAST_ERROR_ : '') + ']';
  }

  // บันทึกใน Log (ผู้ใช้ไม่เห็น): ถ้ามีช่วงที่ไม่ได้สายตรง และมีสายที่จุดผ่านบางจุดยังไม่มีพิกัด -> อาจเป็นเพราะข้อมูลไม่ครบ ไม่ใช่เพราะไม่มีรถ
  let gapNote = '';
  if (legs.some(function (l) { return l.result !== 'direct'; })) {
    const gaps = [];
    model.routes.forEach(function (r) {
      const nc = r.seq.filter(function (s) { return s.lat === null; }).map(function (s) { return s.name; });
      if (nc.length) gaps.push('สาย ' + r.id + ': ' + nc.join(','));
    });
    if (gaps.length) gapNote = ' [จุดผ่านที่ยังไม่มีพิกัด อาจทำให้หาสายตรงไม่เจอ -> ' + gaps.join(' ; ') + ' | รัน debugBusLeg()]';
  }

  const extra = formatOtherRoutes_(othersByLeg);
  if (extra) answer = (answer + '\n\n' + extra).substring(0, 4900);

  const items = [];
  Object.keys(usedRoutes).forEach(function (id) {
    const r = usedRoutes[id];
    if (r.cardId && items.length < MAX_QUICK_ITEMS) items.push(cardQuickItem_(r));
  });
  const res = replyTextQuick_(replyToken, answer, items);
  logInteraction_(userId, requestText, 'Bus', answer + geminiNote + gapNote, res);
  clearPending_(userId); // จบแล้ว ไม่ทิ้งคำถามเก่าไว้ปนกับคำถามถัดไป
  return true;
}

/** จุดที่ไม่มีในฐานข้อมูล: ลองค้นพิกัดจาก Google Maps */
function resolveFreeText_(name) {
  const g = geocodeText_(name);
  return g ? { name: name, keys: [normalizeForMatch_(name)], lat: g.lat, lng: g.lng } : null;
}

/** ให้ Gemini แยกต้นทางและลำดับจุดหมาย จากประโยคของผู้ใช้ */
function extractBusTrip_(text, model) {
  const known = model.known.map(function (k) { return k.name; }).join(', ');
  const prompt =
    'แยกข้อมูลการเดินทางในจังหวัดบึงกาฬจากข้อความผู้ใช้ ตอบเป็น JSON เท่านั้น\n' +
    '{"origin":"ชื่อจุดเริ่มต้นที่ผู้ใช้ระบุ หรือ \\"\\" ถ้าไม่ได้ระบุ","points":["จุดหมายที่ต้องไปตามลำดับ"]}\n' +
    '- origin คือที่ที่ผู้ใช้อยู่/เริ่มเดินทาง (เช่น "จาก...", "ตอนนี้อยู่ที่...") ไม่ต้องใส่ซ้ำใน points\n' +
    '- ถ้าชื่อใกล้เคียงกับรายการด้านล่างให้ใช้ชื่อตามรายการ\n' +
    '=== ชื่อสถานที่/จุดที่รู้จัก ===\n' + known + '\n=== จบ ===\nข้อความผู้ใช้: ' + text;
  const raw = callGeminiTravel_(prompt, 300, true);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw.replace(/^```json|```$/g, '').trim());
    return { origin: String(o.origin || '').trim(), points: (o.points || []).map(String).filter(Boolean) };
  } catch (e) { return null; }
}

/** คำตอบสำรองเมื่อ Gemini ใช้ไม่ได้ (แสดงทุกสายที่เป็นตัวเลือก สูงสุด 3 ต่อช่วง) */
function buildPlainBusAnswer_(legs) {
  const lines = ['🚌 ผลการค้นหาสายรถ (ระบบสำรอง)'];
  legs.forEach(function (l) {
    if (!l.options || !l.options.length) { lines.push('• ' + l.from + ' → ' + l.to + ': ยังไม่พบสายรถที่ไปถึงได้'); return; }
    lines.push('• ' + l.from + ' → ' + l.to + ':');
    if (l.roadBetweenPoints) lines.push('  ระยะทางถนนประมาณ ' + l.roadBetweenPoints.roadKm + ' กม.' + (l.roadBetweenPoints.estimated ? ' (ค่าประมาณ)' : ''));
    l.options.forEach(function (o, i) {
      if (o.type === 'ตรง') {
        lines.push('  ' + (i + 1) + ') สาย ' + routeLabel_(o.route) + ' ขึ้นที่ ' + o.boardAt + (o.walkToBoardKm ? ' (เดิน ~' + o.walkToBoardKm + ' กม.)' : '') +
          ' ลงที่ ' + o.alightAt + (o.walkFromAlightKm ? ' (เดิน ~' + o.walkFromAlightKm + ' กม.)' : '') +
          (o.ride ? ' นั่งรถประมาณ ' + o.ride.roadKm + ' กม.' : ''));
      } else {
        lines.push('  ' + (i + 1) + ') สาย ' + routeLabel_(o.first.route) + ' ต่อสาย ' + routeLabel_(o.second.route) + ' (ต่อรถที่ ' + o.first.alightAt + ')');
      }
    });
  });
  lines.push('กรุณายืนยันเวลาและค่าโดยสารกับเจ้าหน้าที่อีกครั้งค่ะ');
  return lines.join('\n');
}

/* ---------- เครื่องมือผู้ดูแล ---------- */

/** เติมชื่อจุดที่รถผ่านทั้งหมดจากชีต Routes ลงชีต Stops แล้วค้นพิกัดให้แถวที่ยังว่าง (ต้องตรวจผลด้วยตา) */
function fillStopCoordinates() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(STOPS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(STOPS_SHEET_NAME);
    sheet.appendRow(['ชื่อจุด', 'ชื่อเรียกอื่น (คั่น ,)', 'Lat', 'Lng']);
  }
  const have = {};
  getStopsSheetRows_().forEach(function (s) { nameKeys_(s).forEach(function (k) { have[k] = true; }); });
  getPlaces_().forEach(function (p) { nameKeys_(p).forEach(function (k) { have[k] = true; }); });

  getRoutes_().forEach(function (r) {
    [r.from].concat(String(r.stops || '').split(','), [r.to]).forEach(function (n) {
      n = String(n || '').trim();
      const k = normalizeForMatch_(n);
      if (n && !have[k]) { sheet.appendRow([n, '', '', '']); have[k] = true; }
    });
  });

  let filled = 0;
  const last = sheet.getLastRow();
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 4).getValues().forEach(function (r, i) {
      if (!r[0] || (r[2] !== '' && r[3] !== '')) return;
      // ค้นแบบต่อท้ายบึงกาฬก่อน ไม่เจอ (เช่น กรุงเทพฯ ซึ่งเป็นระดับจังหวัด) ค่อยลองค้นเป็นชื่อจังหวัดทั่วประเทศ
      const g = geocodeText_(String(r[0])) || geocodeProvince_(String(r[0]).replace(/ฯ/g, '').replace(/^(จังหวัด|จ\.)\s*/, '').trim());
      if (g) { sheet.getRange(i + 2, 3, 1, 2).setValues([[g.lat, g.lng]]); filled++; }
    });
  }
  console.log('เติมพิกัดให้ ' + filled + ' จุด กรุณาเปิดตรวจชื่อ/พิกัดในชีต Stops ว่าตรงจริง แก้ด้วยมือได้เลย');
}

/** ทดสอบใน Editor (ไม่ส่งเข้า LINE) */
function debugBus() {
  const model = buildBusModel_();
  console.log('สายรถ ' + model.routes.length + ' สาย, จุดที่รู้จัก ' + model.known.length + ' จุด');
  model.routes.forEach(function (r) {
    const noCoord = r.seq.filter(function (s) { return s.lat === null; }).map(function (s) { return s.name; });
    console.log(r.id + ' ' + r.name + ': ' + r.seq.length + ' จุด' + (r.cardId ? '' : ' [ยังไม่มีรหัสการ์ด]') + (noCoord.length ? ' [ไม่มีพิกัด: ' + noCoord.join(', ') + ']' : ''));
  });
}

/* =====================================================================
 * ถามสายรถที่ผ่านแหล่งท่องเที่ยว / ขอแนะนำเส้นทางท่องเที่ยวด้วยรถโดยสาร
 *   - "สายรถที่ผ่านแหล่งท่องเที่ยว"            -> รายการสาย + สถานที่ที่สายนั้นผ่าน/ใกล้ (ไม่ใช้ AI)
 *   - "แนะนำเที่ยวโดยรถโดยสาร / ทริปรถเมล์"     -> จัดเป็นทริปต่อสาย เรียงตามลำดับที่รถผ่าน (Gemini เรียบเรียง ถ้าล่มใช้แบบสำรอง)
 *   - พิมพ์หมวดได้ เช่น "สายรถที่ผ่านวัด" ถ้าชีต Places คอลัมน์ C (หมวด) มีคำว่า "วัด"
 * ===================================================================== */

const TOURISM_WORDS = /(แหล่งท่องเที่ยว|สถานที่ท่องเที่ยว|สถานที่น่าสนใจ|ที่เที่ยว|ท่องเที่ยว|เที่ยว|ทริป)/;
const TOURISM_BUS_WORDS = /(รถโดยสาร|รถประจำทาง|ขนส่งสาธารณะ|รถเมล์|รถทัวร์|สองแถว|สายรถ|สายไหน|รถสาย|นั่งรถ|ขึ้นรถ|รถผ่าน|รถไป|รถอะไร|สาย)/;
const TOURISM_PLAN_WORDS = /(แนะนำ|วางแผน|ทริป|แผน|เส้นทาง|เที่ยวกี่วัน|ไปเที่ยวยังไง|จัดทริป)/;
const TOURISM_NEAR_KM = 3.0;   // แหล่งท่องเที่ยวห่างจุดที่รถผ่านไม่เกินนี้ (กม.) ถือว่า "สายนี้ไปได้" (ต่างจาก BUS_NEAR_KM ที่ใช้กับโหมดถามจุดเดียว)
const TOURISM_MAX_ROUTES = 6;
const TOURISM_MAX_PLACES_PER_ROUTE = 8;

function isTourismBusQuestion_(text) {
  const t = normalizeForMatch_(text);
  return TOURISM_WORDS.test(t) && TOURISM_BUS_WORDS.test(t);
}

/** เลือกสถานที่ตามหมวดที่ผู้ใช้พิมพ์ (ถ้าไม่ได้พิมพ์หมวด = ทุกแห่งที่มีพิกัด) */
function pickTourismPlaces_(text, places) {
  const t = normalizeForMatch_(text);
  // ไม่บังคับว่าต้องมีพิกัด: ชื่อตรงกับจุดผ่านในชีต Routes คอลัมน์ F ก็จับคู่ได้ (พิกัดมีไว้ช่วยหาสายที่ผ่านใกล้ๆ เพิ่มเท่านั้น)
  const withPos = places.filter(function (p) { return !!p.name; });
  const cats = {};
  withPos.forEach(function (p) { if (p.category) cats[p.category] = true; });
  const wanted = Object.keys(cats).filter(function (c) {
    const k = normalizeForMatch_(c);
    return k.length >= 2 && t.indexOf(k) !== -1;
  });
  if (!wanted.length) return { places: withPos, label: 'แหล่งท่องเที่ยว' };
  return { places: withPos.filter(function (p) { return wanted.indexOf(p.category) !== -1; }), label: wanted.join('/') };
}

/** จัดกลุ่ม: สาย -> สถานที่ที่สายนั้นผ่าน/ใกล้ (เรียงตามลำดับจุดบนสาย) */
function routesForPlaces_(model, places) {
  const map = {};
  places.forEach(function (p) {
    const pt = { name: p.name, lat: p.lat, lng: p.lng, keys: nameKeys_(p) };
    model.routes.forEach(function (r) {
      if (routeStatus_(r).unavailable) return;
      const n = nearestOnRoute_(r, pt);
      if (!n || n.km > TOURISM_NEAR_KM) return;
      if (!map[r.id]) map[r.id] = { route: r, items: [] };
      map[r.id].items.push({ place: p, stop: n.name, walkKm: n.km, idx: n.idx });
    });
  });
  const groups = Object.keys(map).map(function (k) { return map[k]; });
  groups.forEach(function (g) { g.items.sort(function (a, b) { return a.idx - b.idx; }); });
  groups.sort(function (a, b) { return b.items.length - a.items.length; });
  return groups;
}

function buildTourismPlain_(groups, label, wantsPlan) {
  const lines = [wantsPlan ? '🗺️ แนะนำเที่ยว' + label + 'ด้วยรถโดยสาร' : '🚌 สายรถที่ผ่านหรือใกล้' + label];
  groups.slice(0, TOURISM_MAX_ROUTES).forEach(function (g) {
    const r = g.route;
    lines.push('\n🚌 สาย ' + routeLabel_(r) + (r.type ? ' (' + r.type + ')' : ''));
    if (r.boarding) lines.push('ขึ้นรถ: ' + r.boarding);
    g.items.slice(0, TOURISM_MAX_PLACES_PER_ROUTE).forEach(function (it) {
      let s = '  • ' + it.place.name + (it.walkKm === 0 ? (normalizeForMatch_(it.stop) === normalizeForMatch_(it.place.name) ? '' : ' (ผ่านจุด ' + it.stop + ')') : ' (ลงที่ ' + it.stop + ' ห่างประมาณ ' + it.walkKm + ' กม.)');
      if (wantsPlan && it.place.minutes) s += ' ใช้เวลาเที่ยว ~' + it.place.minutes + ' นาที';
      lines.push(s);
    });
    if (wantsPlan && r.schedule) lines.push('เวลา: ' + r.schedule);
    if (wantsPlan && r.fare) lines.push('ค่าโดยสาร: ' + r.fare);
  });
  lines.push('\nต้องการให้ช่วยวางแผนละเอียด พิมพ์เช่น "จากตลาดสด ไปภูทอก" ได้เลยค่ะ');
  lines.push('เวลาและค่าโดยสารควรยืนยันกับผู้ให้บริการอีกครั้งค่ะ 🙏');
  return lines.join('\n').substring(0, 4900);
}

function composeTourismPlanAi_(text, groups) {
  const facts = {
    userRequest: text,
    tripOptions: groups.slice(0, TOURISM_MAX_ROUTES).map(function (g) {
      return {
        route: routeBrief_(g.route),
        placesInOrderOfBus: g.items.slice(0, TOURISM_MAX_PLACES_PER_ROUTE).map(function (it) {
          return { name: it.place.name, getOffAt: it.stop, walkKm: it.walkKm, hours: it.place.hours || '', fee: it.place.fee || '',
            suggestedVisitMinutes: it.place.minutes || null, note: it.place.note || '' };
        })
      };
    })
  };
  const prompt =
    'คุณเป็นเจ้าหน้าที่ขนส่งจังหวัดบึงกาฬ ตอบผ่านไลน์ ภาษาไทยสุภาพ ลงท้าย "ค่ะ" กระชับ อ่านง่าย ไม่เกิน 1,200 ตัวอักษร\n' +
    'ผู้ใช้ต้องการแนะนำเส้นทางท่องเที่ยวโดยรถโดยสารสาธารณะ ข้อมูลด้านล่างคำนวณแล้วว่าแต่ละสายผ่าน/ใกล้สถานที่ใดบ้าง\n' +
    'กติกา: ใช้เฉพาะข้อมูลใน JSON ห้ามแต่งสาย เวลา ราคา หรือสถานที่เพิ่ม\n' +
    '- แนะนำ 1-3 ทริป เลือกสายที่ผ่านสถานที่ได้หลายแห่งและเหมาะกับเวลาเปิด-ปิด บอกชื่อสาย จุดขึ้นรถ ลำดับสถานที่ ลงที่ไหน เดินกี่กม. (ถ้า 0 ไม่ต้องพูดถึง)\n' +
    '- ใส่เวลา/ความถี่ ค่าโดยสาร เบอร์ติดต่อ ค่าเข้าชม เฉพาะที่มีค่าในข้อมูล และบอกว่าควรยืนยันกับผู้ให้บริการอีกครั้ง\n' +
    '- ปิดท้ายชวนให้พิมพ์จุดเริ่มต้นและจุดหมาย เช่น "จากตลาดสด ไปภูทอก" เพื่อให้ช่วยวางแผนละเอียด\n\n' +
    '=== ข้อมูล JSON ===\n' + JSON.stringify(facts) + '\n=== จบข้อมูล ===';
  return callGeminiTravel_(prompt, 1024, false);
}

/** คืน true ถ้าตอบแล้ว */
function handleTourismBus_(userId, text, replyToken, model) {
  const picked = pickTourismPlaces_(text, getPlaces_());
  if (!picked.places.length) return false; // ยังไม่มีพิกัดในชีต Places ให้ระบบเดิมทำงานต่อ
  clearPending_(userId);

  const groups = routesForPlaces_(model, picked.places);
  if (!groups.length) {
    const r = replyMessage_(replyToken, 'ตอนนี้ยังไม่พบสายรถโดยสารที่ผ่านหรือใกล้' + picked.label + 'ในระบบค่ะ 🙏 สอบถามเจ้าหน้าที่เพิ่มเติมได้เลยนะคะ');
    logInteraction_(userId, text, 'Bus', '(ไม่พบสายที่ผ่านแหล่งท่องเที่ยว)', r);
    return true;
  }

  const wantsPlan = TOURISM_PLAN_WORDS.test(normalizeForMatch_(text));
  let answer = wantsPlan ? composeTourismPlanAi_(text, groups) : null;
  const note = (wantsPlan && !answer) ? ' [Gemini ล้มเหลว: ' + GEMINI_LAST_ERROR_ + ']' : '';
  if (!answer) answer = buildTourismPlain_(groups, picked.label, wantsPlan);

  const items = [];
  groups.slice(0, TOURISM_MAX_ROUTES).forEach(function (g) {
    if (g.route.cardId && items.length < MAX_QUICK_ITEMS) items.push(cardQuickItem_(g.route));
  });
  const res = replyTextQuick_(replyToken, answer, items);
  logInteraction_(userId, text, 'Bus', '[ท่องเที่ยว] ' + answer + note, res);
  return true;
}


/** ถ้ารหัสการ์ด/รูปนี้เป็นอินโฟของสายรถในชีต Routes (คอลัมน์ L) คืนข้อความนำ {raw}, ไม่ใช่คืน undefined */
function busLeadForCardId_(id) {
  if (!id) return undefined;
  const r = getRoutes_().filter(function (x) { return x.cardId === id; })[0];
  return r ? { raw: '🚌 สาย ' + routeLabel_(r) } : undefined;
}


/**
 * ทดสอบใน Editor: ดูว่าแต่ละแหล่งท่องเที่ยวใน Places ใกล้สายไหนที่สุด และขาดอะไรถึงจับคู่ไม่ได้
 * (ไม่ส่งอะไรเข้า LINE) ผลอยู่ที่ View > Logs / Executions
 */
function debugTourism() {
  const model = buildBusModel_();
  const places = getPlaces_();
  const stopsNoCoord = {};
  model.routes.forEach(function (r) {
    r.seq.forEach(function (s) { if (s.lat === null) stopsNoCoord[s.name] = true; });
  });
  console.log('สถานที่ใน Places ' + places.length + ' แห่ง (มีพิกัด ' + places.filter(function (p) { return p.lat !== null; }).length + ')');
  console.log('จุดผ่านของสายที่ "ยังไม่มีพิกัด" ' + Object.keys(stopsNoCoord).length + ' จุด: ' + Object.keys(stopsNoCoord).join(', ') + '  <- เติมในชีต Stops (C=Lat, D=Lng) หรือรัน fillStopCoordinates()');
  places.forEach(function (p) {
    const noPos = p.lat === null ? ' [ไม่มีพิกัดใน Places F/G จับคู่ด้วยชื่ออย่างเดียว]' : '';
    const pt = { name: p.name, lat: p.lat, lng: p.lng, keys: nameKeys_(p) };
    let best = null;
    model.routes.forEach(function (r) {
      const n = nearestOnRoute_(r, pt);
      if (n && (!best || n.km < best.km)) best = { route: r, stop: n.name, km: n.km };
    });
    if (!best) console.log('✗ ' + p.name + ' : ไม่มีสายใดที่ชื่อจุดผ่านตรงกัน และไม่มีพิกัดให้วัดระยะ' + noPos);
    else console.log((best.km <= TOURISM_NEAR_KM ? '✓ ' : '✗ ') + p.name + ' : ใกล้สุดคือสาย ' + routeLabel_(best.route) + ' จุด "' + best.stop + '" ' + (best.km === 0 ? '(ชื่อตรงกัน)' : 'ห่าง ' + best.km + ' กม.') + (best.km <= TOURISM_NEAR_KM ? '' : ' (เกิน ' + TOURISM_NEAR_KM + ' กม.)') + noPos);
  });
}


/**
 * วินิจฉัย "ทำไมจาก A ไป B ไม่เจอสายตรง" (ไม่ส่งอะไรเข้า LINE) แก้ 2 ข้อความด้านล่างเป็นต้นทาง/ปลายทางที่ต้องการแล้วรัน
 * ผลที่ Executions / View > Logs: แต่ละสายใกล้ต้นทาง/ปลายทางที่จุดไหน เดินกี่ กม. และติดที่เหตุผลใด
 */
function debugBusLeg() {
  diagnoseBusLeg_('บขส.บึงกาฬ', 'ปู่อือลือ');
  diagnoseBusLeg_('ปู่อือลือ', 'ถ้ำนาคา');
}

function diagnoseBusLeg_(fromText, toText) {
  const model = buildBusModel_();
  function resolve(t) {
    const k = findKnownPoints_(t, model);
    const p = k.length ? k[0].point : resolveFreeText_(t);
    return p || null;
  }
  const X = resolve(fromText), Y = resolve(toText);
  console.log('==== ' + fromText + ' -> ' + toText + ' ====');
  [['ต้นทาง', fromText, X], ['ปลายทาง', toText, Y]].forEach(function (a) {
    const p = a[2];
    console.log(a[0] + ' "' + a[1] + '" ถูกตีความเป็น: ' + (p ? p.name + ' พิกัด ' + (p.lat === null || p.lat === undefined ? 'ไม่มี' : p.lat + ',' + p.lng) + ' คีย์ ' + (p.keys || []).slice(0, 4).join(' | ') : 'ไม่พบ (ไม่มีในระบบและค้นพิกัดไม่ได้)'));
  });
  if (!X || !Y) return;
  if (X.lat !== null && X.lat !== undefined && Y.lat !== null && Y.lat !== undefined) {
    const km = haversineKm_(X, Y);
    console.log('ระยะเส้นตรงต้นทาง-ปลายทาง ' + km.toFixed(2) + ' กม.' + (km < 0.2 ? '  <-- ใกล้กันผิดปกติ ตรวจพิกัดของสองจุดนี้ในชีต Places/Stops ว่าไม่ได้ใส่พิกัดซ้ำกัน' : ''));
  }
  model.routes.forEach(function (r) {
    const a = nearestOnRoute_(r, X), b = nearestOnRoute_(r, Y);
    let verdict;
    if (!a && !b) verdict = 'ไม่ผ่านทั้งสองจุด (ไม่มีชื่อตรงและไม่มีพิกัดให้วัด)';
    else if (!a) verdict = 'หาจุดใกล้ "ต้นทาง" บนสายนี้ไม่ได้';
    else if (!b) verdict = 'หาจุดใกล้ "ปลายทาง" บนสายนี้ไม่ได้';
    else if (a.idx === b.idx) verdict = 'ต้นทางกับปลายทางตรงกับจุดเดียวกันบนสาย';
    else if (a.km > BUS_MAX_WALK_KM || b.km > BUS_MAX_WALK_KM) verdict = 'ไกลเกินเดิน (' + BUS_MAX_WALK_KM + ' กม.)';
    else verdict = 'OK เป็นสายตรงได้';
    const noCoord = r.seq.filter(function (s) { return s.lat === null; }).length;
    console.log('สาย ' + routeLabel_(r) + ' [' + r.seq.map(function (s) { return s.name; }).join(' > ') + ']  จุดไม่มีพิกัด ' + noCoord + '/' + r.seq.length);
    console.log('   ใกล้ต้นทาง: ' + (a ? a.name + ' (' + a.km + ' กม.)' : '-') + ' | ใกล้ปลายทาง: ' + (b ? b.name + ' (' + b.km + ' กม.)' : '-') + '  => ' + verdict);
  });
}


/**
 * ตรวจว่าปุ่ม "สาย ..." ที่บอทส่งให้กด (รหัสการ์ดในชีต Routes คอลัมน์ L) เปิดอะไรได้จริงหรือไม่ (ไม่ส่งอะไรเข้า LINE)
 * ผลที่ Executions / View > Logs  สายที่ขึ้น ✗ คือสายที่กดแล้วไม่มีอะไรตอบ
 */
function checkRouteCards() {
  const raw = {};
  [['Cards', CONFIG.SHEET_NAME_CARDS], ['ImageCards', CONFIG.SHEET_NAME_IMAGE_CARDS], ['Images', IMAGES_SHEET_NAME]].forEach(function (p) {
    readSheetRows_(p[1], 3).forEach(function (r) {
      const id = String(r[0] || '').trim();
      if (!id) return;
      if (!raw[id]) raw[id] = { sheet: p[0], withImage: false };
      if (p[0] === 'Cards' || /^https:\/\//i.test(normalizeImageUrl_(r[2]))) raw[id].withImage = true;
    });
  });
  let bad = 0;
  getRoutes_().forEach(function (r) {
    const label = 'สาย ' + routeLabel_(r);
    if (!r.cardId) { console.log('– ' + label + ' : ยังไม่มีรหัสการ์ด (ไม่มีปุ่มให้กด)'); return; }
    const hit = raw[r.cardId];
    if (hit && hit.withImage) { console.log('✓ ' + label + ' : รหัส ' + r.cardId + ' พบในชีต ' + hit.sheet); return; }
    bad++;
    if (hit) {
      console.log('✗ ' + label + ' : รหัส ' + r.cardId + ' มีในชีต ' + hit.sheet + ' แต่ไม่มีแถวไหนมีลิงก์รูป https ที่ใช้ได้ ระบบจึงข้ามทั้งชุด -> กดแล้วเงียบ (ตรวจคอลัมน์ลิงก์รูป หรือรัน checkImageLinks)');
    } else {
      const near = Object.keys(raw).filter(function (k) { return k.indexOf(String(r.id)) !== -1 || String(r.cardId).indexOf(k) !== -1; });
      console.log('✗ ' + label + ' : ไม่พบรหัส "' + r.cardId + '" ในชีต Cards/ImageCards/Images เลย (พิมพ์ผิด มีช่องว่าง หรือยังไม่ได้สร้าง)' + (near.length ? ' ใกล้เคียง: ' + near.join(', ') : ''));
    }
  });
  console.log(bad ? 'พบ ' + bad + ' สายที่ปุ่มกดไม่ได้' : 'ทุกสายที่มีรหัสการ์ดเปิดได้');
}