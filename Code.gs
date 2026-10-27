/**
 * P4Digital — ค้นข้อมูลผู้เสียภาษีจากกรมสรรพากร (VAT Service)
 * ---------------------------------------------------------------
 * ใช้เป็นตัวกลางให้หน้าเว็บ "แบบฟอร์มขออนุมัติเครดิต"
 *   GET  <URL /exec>?tin=0105560189412           → JSON
 *   GET  <URL /exec>?tin=...&callback=fn          → JSONP (สำรอง)
 *   GET  <URL /exec>?tin=...&debug=1              → แนบ XML ดิบจากกรมฯ มาด้วย (ไว้ตรวจปัญหา)
 *
 * แหล่งข้อมูล: VAT Service ของกรมสรรพากร (ข้อมูลเปิด ใช้ username/password = anonymous)
 *   https://www.rd.go.th/42535.html
 * ค้นได้เฉพาะผู้ประกอบการที่จดทะเบียนภาษีมูลค่าเพิ่ม (VAT) เท่านั้น
 */

const RD_ENDPOINT = 'https://rdws.rd.go.th/serviceRD3/vatserviceRD3.asmx';
const RD_NS = 'https://rdws.rd.go.th/serviceRD3/vatserviceRD3';
const CACHE_SECONDS = 6 * 60 * 60;   // จำผลลัพธ์ไว้ 6 ชม. ลดการเรียกกรมฯ ซ้ำ
const MAX_RESULTS = 300;             // กันกรณีบริษัทที่มีสาขาเป็นพัน ๆ

/* ===================== Web app ===================== */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const tin = String(p.tin || '').replace(/\D/g, '');
  let out;
  try {
    if (tin.length !== 13) {
      out = { ok: false, error: 'INVALID_TIN', message: 'เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก' };
    } else {
      out = lookupTin(tin, p.debug === '1');
    }
  } catch (err) {
    out = { ok: false, error: 'SERVER_ERROR', message: String((err && err.message) || err) };
  }
  return output_(out, p.callback);
}

/** กดรันฟังก์ชันนี้ในหน้า Apps Script เพื่อทดสอบ + ให้สิทธิ์ครั้งแรก */
function testLookup() {
  const res = lookupTin('0105560189412', true);   // เลขผู้เสียภาษีของ P4Digital
  const raw = res.raw; delete res.raw;
  Logger.log(JSON.stringify(res, null, 2));
  Logger.log('--- XML ดิบ (ตัดมา 1,500 ตัวอักษรแรก) ---\n' + String(raw || '').slice(0, 1500));
}

/* ===================== Core ===================== */

function lookupTin(tin, debug) {
  const cache = cacheOrNull_();
  const key = 'tin:' + tin;
  if (cache && !debug) {
    const hit = cache.get(key);
    if (hit) { const o = JSON.parse(hit); o.cached = true; return o; }
  }

  const xml = callRd_(tin);
  const fields = parseServiceResult_(xml);
  const all = buildResults_(fields).filter(function (r) { return !r.tin || r.tin === tin; });
  const results = all.slice(0, MAX_RESULTS);

  const out = results.length
    ? { ok: true, tin: tin, total: all.length, results: results }
    : { ok: false, tin: tin, error: 'NOT_FOUND',
        message: first_(fields.msgerr) || 'ไม่พบข้อมูลในระบบ VAT ของกรมสรรพากร' };

  if (out.ok && cache) {
    try { cache.put(key, JSON.stringify(out), CACHE_SECONDS); } catch (e) { /* ผลใหญ่เกิน 100KB ก็ไม่ต้อง cache */ }
  }
  if (debug) out.raw = xml.slice(0, 20000);
  return out;
}

function callRd_(tin) {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:vat="' + RD_NS + '">' +
    '<soap:Header/><soap:Body><vat:Service>' +
    '<vat:username>anonymous</vat:username><vat:password>anonymous</vat:password>' +
    '<vat:TIN>' + tin + '</vat:TIN><vat:Name></vat:Name>' +
    '<vat:ProvinceCode>0</vat:ProvinceCode><vat:BranchNumber>0</vat:BranchNumber><vat:AmphurCode>0</vat:AmphurCode>' +
    '</vat:Service></soap:Body></soap:Envelope>';

  const opts = {
    method: 'post',
    contentType: 'application/soap+xml; charset=utf-8; action="' + RD_NS + '/Service"',
    payload: body,
    muteHttpExceptions: true
  };

  let res;
  try {
    res = UrlFetchApp.fetch(RD_ENDPOINT, opts);
  } catch (err) {
    // ใบรับรอง SSL ของเซิร์ฟเวอร์กรมฯ เคยมีปัญหา chain ไม่ครบ — ลองใหม่โดยไม่ตรวจใบรับรอง (ข้อมูลเป็นข้อมูลสาธารณะ อ่านอย่างเดียว)
    opts.validateHttpsCertificates = false;
    res = UrlFetchApp.fetch(RD_ENDPOINT, opts);
  }
  const code = res.getResponseCode();
  const text = res.getContentText('UTF-8');
  if (code !== 200) throw new Error('กรมสรรพากรตอบกลับ HTTP ' + code + ': ' + text.slice(0, 300));
  return text;
}

/* ===================== Parsing ===================== */

// ชื่อฟิลด์จากกรมฯ มีหลายแบบ (vNID / NID, vThambol / ThumbolName …) จึงรองรับทุกชื่อที่พบ
const FIELD_ALIASES = {
  tin:        ['vnid', 'nid'],
  title:      ['vtitlename', 'titlename'],
  name:       ['vname', 'name'],
  surname:    ['vsurname', 'surname'],
  branchTitle:['vbranchtitlename', 'branchtitlename', 'vbranchtitle', 'branchtitle'],
  branchName: ['vbranchname', 'branchname'],
  branchNo:   ['vbranchnumber', 'branchnumber'],
  building:   ['vbuildingname', 'buildingname'],
  room:       ['vroomnumber', 'roomnumber'],
  floor:      ['vfloornumber', 'floornumber'],
  village:    ['vvillagename', 'villagename'],
  house:      ['vhousenumber', 'housenumber'],
  moo:        ['vmoonumber', 'moonumber'],
  soi:        ['vsoiname', 'soiname'],
  street:     ['vstreetname', 'streetname'],
  tambon:     ['vthambol', 'vthumbol', 'vthambolname', 'vthumbolname', 'thumbolname', 'thambolname', 'tambonname'],
  amphur:     ['vamphur', 'vamphurname', 'amphurname'],
  province:   ['vprovince', 'vprovincename', 'provincename'],
  postcode:   ['vpostcode', 'postcode'],
  firstDate:  ['vbusinessfirstdate', 'businessfirstdate'],
  msgerr:     ['vmsgerr', 'msgerr']
};

function parseServiceResult_(xml) {
  const m = /<(?:[\w-]+:)?ServiceResult\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?ServiceResult>/.exec(xml);
  const inner = m ? m[1] : '';
  const raw = {};
  const re = /<(?:[\w-]+:)?([A-Za-z_][\w-]*)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?\1\s*>)/g;
  let el;
  while ((el = re.exec(inner))) {
    const content = el[3] || '';
    const vals = [];
    const ar = /<(?:[\w-]+:)?anyType\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?anyType\s*>)/g;
    let a, hasAny = false;
    while ((a = ar.exec(content))) { hasAny = true; vals.push(decode_(a[1] || '')); }
    if (!hasAny && content.trim() && !/</.test(content)) vals.push(decode_(content));
    raw[el[1].toLowerCase()] = vals;
  }
  const fields = {};
  Object.keys(FIELD_ALIASES).forEach(function (k) {
    const hit = FIELD_ALIASES[k].find(function (n) { return raw[n] && raw[n].length; });
    fields[k] = hit ? raw[hit] : [];
  });
  return fields;
}

function buildResults_(f) {
  const n = Math.max(f.tin.length, f.name.length, f.branchName.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const g = function (k) { return clean_(f[k][i]); };
    let name = joinName_(g('title'), g('name'), g('surname'));
    if (!name) name = joinName_(g('branchTitle'), g('branchName'), '');
    if (!name && !g('tin')) continue;

    const bno = parseInt(g('branchNo') || '0', 10) || 0;
    const prov = g('province');
    out.push({
      tin: g('tin').replace(/\D/g, ''),
      name: name,
      branchNo: bno,
      branchLabel: bno === 0 ? 'สำนักงานใหญ่' : 'สาขาที่ ' + String(bno).padStart(5, '0'),
      branchName: joinName_(g('branchTitle'), g('branchName'), ''),
      address: address_({
        building: g('building'), room: g('room'), floor: g('floor'), village: g('village'),
        house: g('house'), moo: g('moo'), soi: g('soi'), street: g('street'),
        tambon: g('tambon'), amphur: g('amphur'), province: prov, postcode: g('postcode')
      }),
      province: prov,
      entityType: entityType_(name),
      vatRegisteredDate: g('firstDate')
    });
  }
  return out;
}

function address_(a) {
  const bkk = /กรุงเทพ/.test(a.province);
  const pre = function (label, v, alts) {
    if (!v) return '';
    const all = [label].concat(alts || []);
    for (let i = 0; i < all.length; i++) if (v.indexOf(all[i]) === 0) return v;
    return label + v;
  };
  const parts = [
    a.house ? 'เลขที่ ' + a.house : '',
    a.moo ? 'หมู่ที่ ' + a.moo.replace(/^หมู่(ที่)?\s*/, '') : '',
    a.building,
    a.floor ? 'ชั้น ' + a.floor.replace(/^ชั้น\s*/, '') : '',
    a.room ? 'ห้อง ' + a.room.replace(/^ห้อง\s*/, '') : '',
    pre('หมู่บ้าน', a.village),
    pre('ซอย', a.soi, ['ซ.']),
    pre('ถนน', a.street, ['ถ.']),
    bkk ? pre('แขวง', a.tambon, ['ตำบล', 'ต.']) : pre('ตำบล', a.tambon, ['แขวง', 'ต.']),
    bkk ? pre('เขต', a.amphur, ['อำเภอ', 'อ.']) : pre('อำเภอ', a.amphur, ['เขต', 'อ.']),
    bkk ? 'กรุงเทพมหานคร' : pre('จังหวัด', a.province, ['จ.']),
    a.postcode
  ];
  return parts.filter(function (s) { return s && s.trim(); }).join(' ').replace(/\s+/g, ' ').trim();
}

function entityType_(name) {
  if (/^บริษัท/.test(name)) return /มหาชน/.test(name) ? 'บมจ.' : 'บจก.';
  if (/^ห้างหุ้นส่วนจำกัด/.test(name)) return 'หจก.';
  if (/^ห้างหุ้นส่วนสามัญ/.test(name)) return 'หสม.';
  if (/^ร้าน/.test(name)) return 'ร้าน';
  return '';
}

/* ===================== Helpers ===================== */

function joinName_(title, name, surname) {
  let s = name || '';
  if (title && s.indexOf(title) !== 0) s = title + ' ' + s;
  if (surname) s += ' ' + surname;
  return s.replace(/\s+/g, ' ').trim();
}
function clean_(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return (s === '-' || s === '0000-00-00') ? '' : s;
}
function first_(arr) { return (arr && arr.length) ? clean_(arr[0]) : ''; }
function decode_(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&amp;/g, '&');
}
function cacheOrNull_() { try { return CacheService.getScriptCache(); } catch (e) { return null; } }
function output_(obj, cb) {
  const s = JSON.stringify(obj);
  if (cb && /^[A-Za-z_$][\w$.]{0,80}$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + s + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}
