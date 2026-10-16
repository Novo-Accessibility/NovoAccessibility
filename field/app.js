/* Novo Field Tool — RHFAC v4.0 rating with CSA B651:23 / B652:23 measurement checks.
   Offline-first: all data lives in IndexedDB on this device. */
(function () {
'use strict';

var VERSION = '3.0.0';
var SV, ST;                 // survey + standards data
var S;                      // app state
var DB;                     // IndexedDB handle
var photoURL = {};          // photo id -> object URL cache
var open = {};              // item number -> expanded
var LIMIT = 80, shown = LIMIT;

/* ================= storage (IndexedDB) ================= */
function idb() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open('novo-field', 1);
    r.onupgradeneeded = function () {
      var d = r.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
    };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
function tx(store, mode, fn) {
  return new Promise(function (res, rej) {
    var t = DB.transaction(store, mode), s = t.objectStore(store), out;
    out = fn(s);
    t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
    t.onerror = function () { rej(t.error); };
    t.onabort = function () { rej(t.error); };
  });
}
function kvGet(k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); }
function kvSet(k, v) { return tx('kv', 'readwrite', function (s) { s.put(v, k); }); }
function photoPut(rec) { return tx('photos', 'readwrite', function (s) { s.put(rec); }); }
function photoGet(id) { return tx('photos', 'readonly', function (s) { return s.get(id); }); }
function photoDel(id) { return tx('photos', 'readwrite', function (s) { s.delete(id); }); }
function photoAll() { return tx('photos', 'readonly', function (s) { return s.getAll(); }); }
function photoClear() { return tx('photos', 'readwrite', function (s) { s.clear(); }); }

var saveT, saveFailed = false;
function save() {
  S.changed = Date.now();
  if (!S.firstUnbacked) S.firstUnbacked = S.changed;
  clearTimeout(saveT);
  saveT = setTimeout(function () {
    kvSet('state', JSON.parse(JSON.stringify(S))).then(function () {
      if (saveFailed) { saveFailed = false; banner(''); }
      toast('Saved'); backupNag();
    }).catch(function () {
      saveFailed = true;
      banner('NOT SAVED — this device refused to store the change. Back up now.', 'Back up now', function () { backup(true); });
    });
  }, 300);
}

/* ================= state ================= */
function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function newFac(name) {
  return { id: uid('f'), facility: { name: name || '' }, cats: {}, subs: {}, items: {}, pre: { cert: {}, gold: {} } };
}
function blank() { var f = newFac('Building 1'); return { v: 4, active: f.id, facs: [f], shared: {}, lastBackup: 0, changed: 0 }; }
function cur() {
  var f = S.facs.filter(function (x) { return x.id === S.active; })[0];
  if (!f) { f = S.facs[0]; S.active = f.id; }
  return f;
}
function migrate(o) {
  if (o && o.v === 4 && o.facs) return o;
  // v3 (single-file tool): status-based scores -> points
  if (o && o.facs) {
    var map = {};
    SV.items.forEach(function (it) { map[it.n] = it; });
    o.facs.forEach(function (f) {
      Object.keys(f.items || {}).forEach(function (n) {
        var st = f.items[n], it = map[n]; if (!it) return;
        if (st.status === 'na') st.na = true;
        else if (st.override != null && st.override !== '') st.pts = Math.max(0, Math.min(it.p, Math.round(+st.override || 0)));
        else if (st.status === 'met') st.pts = it.p;
        else if (st.status === 'part') st.pts = Math.floor(it.p / 2);
        else if (st.status === 'no') st.pts = 0;
        delete st.status; delete st.override;
        if (st.measured) { st.note = (st.note ? st.note + '\n' : '') + 'Measured: ' + st.measured; delete st.measured; }
        st.photos = [];   // v3 kept photos inline; they are imported separately
      });
    });
    o.v = 4; o.shared = o.shared || {}; o.lastBackup = 0;
    return o;
  }
  return blank();
}

/* ================= helpers ================= */
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function money(n) { return '$' + Math.round(n).toLocaleString('en-CA'); }
function pc(e, m) { return m ? (Math.floor(e / m * 1000) / 10).toFixed(1) + '%' : '—'; }
var tt;
function toast(m) { var t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { t.classList.remove('show'); }, 1100); }
function banner(msg, btn, fn, info) {
  var b = $('banner');
  if (!msg) { b.classList.add('hide'); return; }
  b.className = 'banner' + (info ? ' info' : '');
  b.innerHTML = esc(msg) + (btn ? ' <button type="button">' + esc(btn) + '</button>' : '');
  if (btn) b.querySelector('button').onclick = fn;
}
function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

/* ================= scoring ================= */
var ITEM = {};
function catOn(f, c) { return f.cats[c] !== false; }
function subOn(f, s) { return f.subs[s] !== false; }
function live(f, it) { return catOn(f, it.cat) && subOn(f, it.sub); }
function ist(f, n) { return f.items[n] || {}; }
function techPts(st) {
  var t = (st.tech && st.tech.types || []).length, u = (st.tech && st.tech.users || []).length;
  if (t >= 4 && u >= 4) return 10;
  if (t >= 2 && u >= 2) return 5;
  return 0;
}
function scored(f, it) {
  var st = ist(f, it.n);
  if (it.kind === 'tech') return !!st.tech;
  if (it.kind === 'innov') return !!(st.innov && st.innov.length) || st.na;
  return st.na || (st.pts != null);
}
function earned(f, it) {
  var st = ist(f, it.n);
  if (st.na) return 0;
  if (it.kind === 'tech') return techPts(st);
  if (it.kind === 'innov') {
    var n = (st.innov || []).filter(function (x) { return x.t && x.t.trim(); }).length;
    var others = ['12.3.1', '12.3.2', '12.3.3'].reduce(function (s, k) { var x = ist(f, k); return s + (x.na ? 0 : (x.pts || 0)); }, 0);
    return Math.max(0, Math.min(2 * Math.min(n, 10), 20 - others));
  }
  return st.pts == null ? 0 : Math.max(0, Math.min(it.p, st.pts));
}
function totals(f) {
  var e = 0, m = 0, bonus = 0, sc = 0, n = 0, byCat = {};
  SV.items.forEach(function (it) {
    if (!live(f, it)) return;
    n++; if (scored(f, it)) sc++;
    var st = ist(f, it.n);
    var c = byCat[it.cat] || (byCat[it.cat] = { e: 0, m: 0 });
    var pts = earned(f, it);
    if (it.bonus) { bonus += pts; c.e += pts; c.m += it.p; return; }
    if (st.na) return;
    e += pts; m += it.p; c.e += pts; c.m += it.p;
  });
  var tot = e + bonus;
  return { base: e, bonus: bonus, earned: tot, max: m, scored: sc, total: n, byCat: byCat,
           pct: m ? tot / m * 100 : 0, cert: Math.ceil(m * 0.6), gold: Math.ceil(m * 0.8) };
}

/* ================= B651 / B652 checks ================= */
function checksFor(n) { var e = ST.map[n]; return e ? e.c.map(function (k) { return [k, ST.checks[k]]; }) : []; }
function refsFor(n) { var e = ST.map[n]; return e ? e.r : []; }
function stdName(c) { return c.std === 'B652' ? 'B652' : 'B651'; }
function clTitle(std, cl) { return (std === 'B652' ? ST.titles652 : ST.titles)[cl] || ''; }
function reqText(c) {
  if (c.type === 'contrast') return 'Contrast ≥ ' + c.cm + '%' + (c.lrv ? ', lighter surface LRV ≥ ' + c.lrv : '');
  if (c.type === 'parkcount') return 'Table 10 range for the lot size';
  var u = ' ' + c.unit;
  if (c.min != null && c.max != null) return c.min === c.max ? c.min + u : c.min + '–' + c.max + u;
  if (c.min != null) return '≥ ' + c.min + u;
  return '≤ ' + c.max + u;
}
function parkRange(total) {
  var t = ST.parkTable; if (!(total >= 2)) return null;
  for (var i = 0; i < t.rows.length; i++) { var r = t.rows[i]; if (total >= r[0] && total <= r[1]) return [r[2], r[3]]; }
  var extra = Math.ceil((total - 500) / 100);
  return [t.over500[0] + extra * t.over500[2], t.over500[1] + extra * t.over500[3]];
}
// returns {s:'ok'|'warn'|'fail', t:text} or null when nothing entered
function evalCheck(c, v) {
  if (v == null || v === '') return null;
  if (c.type === 'contrast') {
    var a = parseFloat(v.a), b = parseFloat(v.b);
    if (!(a >= 0) || !(b >= 0) || a + b === 0) return null;
    var hi = Math.max(a, b), lo = Math.min(a, b), cm = (hi - lo) / (hi + lo) * 100;
    var fails = [];
    if (cm < c.cm) fails.push('contrast ' + cm.toFixed(0) + '% < ' + c.cm + '%');
    if (c.lrv && hi < c.lrv) fails.push('lighter LRV ' + hi + ' < ' + c.lrv);
    return fails.length ? { s: 'fail', t: 'Below B651:23 — ' + fails.join('; ') } : { s: 'ok', t: 'Meets — contrast ' + cm.toFixed(0) + '%' };
  }
  if (c.type === 'parkcount') {
    var tot = parseInt(v.a, 10), acc = parseInt(v.b, 10);
    if (!(tot >= 0) || !(acc >= 0)) return null;
    var r = parkRange(tot);
    if (!r) return { s: 'warn', t: 'Table 10 starts at 2 spaces' };
    if (acc < r[0]) return { s: 'fail', t: 'Below Table 10 — ' + tot + ' spaces calls for ' + r[0] + '–' + r[1] + ' accessible' };
    return { s: 'ok', t: 'Meets Table 10 (' + r[0] + '–' + r[1] + ' for ' + tot + ' spaces)' };
  }
  var x = parseFloat(String(v).replace(',', '.'));
  if (isNaN(x)) return null;
  var lo2 = c.min, hi2 = c.max;
  if (lo2 != null && hi2 != null && lo2 === hi2) { lo2 -= 10; hi2 += 10; }
  var std = stdName(c) === 'B652' ? 'B652:23' : 'B651:23';
  if (lo2 != null && x < lo2) return { s: 'fail', t: 'Below ' + std + ' minimum (' + reqText(c) + ')' };
  if (hi2 != null && x > hi2) return { s: 'fail', t: 'Above ' + std + ' maximum (' + reqText(c) + ')' };
  if (c.warn != null && x > c.warn) return { s: 'warn', t: c.note || 'Check profile' };
  return { s: 'ok', t: 'Meets ' + std };
}
function itemCheckState(f, n) {
  var st = ist(f, n), meas = st.meas || {}, worst = null, cnt = 0;
  checksFor(n).forEach(function (p) {
    var r = evalCheck(p[1], meas[p[0]]); if (!r) return; cnt++;
    if (r.s === 'fail') worst = 'fail'; else if (r.s === 'warn' && worst !== 'fail') worst = 'warn'; else if (!worst) worst = 'ok';
  });
  return { worst: worst, n: cnt };
}
function conflict(f, it) {
  var st = ist(f, it.n);
  if (st.na || st.pts == null || st.pts < it.p) return false;
  return itemCheckState(f, it.n).worst === 'fail';
}

/* ================= rendering: header & buildings ================= */
function renderFacBar() {
  var sel = $('facPick'); sel.innerHTML = '';
  S.facs.forEach(function (f) {
    var o = el('option'); o.value = f.id; o.textContent = f.facility.name || 'Untitled building';
    if (f.id === S.active) o.selected = true; sel.appendChild(o);
  });
  var add = el('option'); add.value = '__add'; add.textContent = '+ Add a building'; sel.appendChild(add);
  sel.onchange = function () {
    if (sel.value === '__add') { addFac(); return; }
    S.active = sel.value; save(); open = {}; renderAll(); toast('Switched building');
  };
}
function addFac() {
  var f = newFac('Building ' + (S.facs.length + 1));
  S.facs.push(f); S.active = f.id; save(); renderAll(); show('setup'); toast('Building added');
}
function renderProgress() {
  var t = totals(cur());
  $('prog').style.width = (t.total ? t.scored / t.total * 100 : 0) + '%';
  $('progL').textContent = t.scored + ' of ' + t.total + ' features rated';
  $('progR').textContent = t.max ? t.earned + ' / ' + t.max + ' pts (' + pc(t.earned, t.max) + ')' : '';
}

/* ================= setup ================= */
var SHARED = { assessor: 1, equip: 1 };
function renderSetup() {
  ['name', 'owner', 'addr', 'type', 'users', 'area', 'built', 'date', 'assessor', 'equip', 'scope'].forEach(function (k) {
    var e = $('f_' + k); if (!e) return;
    e.value = SHARED[k] ? (S.shared[k] || '') : (cur().facility[k] || '');
    e.oninput = function () {
      if (SHARED[k]) S.shared[k] = e.value; else cur().facility[k] = e.value;
      if (k === 'name') { renderFacBar(); facList(); }
      save();
    };
  });
  facList();
  var host = $('catToggles'); host.innerHTML = '';
  var f = cur();
  Object.keys(SV.cats).sort(function (a, b) { return a - b; }).forEach(function (c) {
    var subs = {}, max = 0;
    SV.items.forEach(function (i) { if (i.cat === c) { subs[i.sub] = (subs[i.sub] || 0) + i.p; max += i.p; } });
    var w = el('div', 'togrow');
    var bonus = (c === '11' || c === '12');
    w.innerHTML = '<label class="cbox"><input type="checkbox"' + (catOn(f, c) ? ' checked' : '') + '><b>' + c + '. ' + esc(SV.cats[c]) + '</b>' +
      '<span style="color:var(--muted)">&nbsp;' + max + ' pts' + (bonus ? ' bonus' : '') + '</span></label>';
    var box = el('div', 'subbox'); if (!catOn(f, c)) box.classList.add('hide');
    w.querySelector('input').onchange = function (e) { f.cats[c] = e.target.checked; box.classList.toggle('hide', !e.target.checked); changed(); };
    Object.keys(subs).sort(function (a, b) { var A = a.split('.'), B = b.split('.'); return A[0] - B[0] || A[1] - B[1]; }).forEach(function (sn) {
      var r = el('label', 'cbox');
      r.innerHTML = '<input type="checkbox"' + (subOn(f, sn) ? ' checked' : '') + '><span>' + sn + ' ' + esc(SV.subs[sn] || '') + ' <span style="color:var(--muted)">(' + subs[sn] + ')</span></span>';
      r.querySelector('input').onchange = function (e) { f.subs[sn] = e.target.checked; changed(); };
      box.appendChild(r);
    });
    w.appendChild(box); host.appendChild(w);
  });
}
function changed() { save(); shown = LIMIT; renderItems(); renderScore(); renderProgress(); facList(); }
function facList() {
  var host = $('facList'); host.innerHTML = '';
  S.facs.forEach(function (f) {
    var t = totals(f), row = el('div', 'facrow');
    row.innerHTML = '<input type="text" aria-label="Building name" value="' + esc(f.facility.name || '') + '">' +
      '<span class="fs">' + (t.scored ? t.earned + ' / ' + t.max + ' (' + pc(t.earned, t.max) + ')' : 'not started') + '</span>' +
      (S.facs.length > 1 ? '<button type="button" aria-label="Remove building">×</button>' : '');
    row.querySelector('input').oninput = function (e) { f.facility.name = e.target.value; save(); renderFacBar(); if (f.id === S.active) $('f_name').value = f.facility.name; };
    var rm = row.querySelector('button');
    if (rm) rm.onclick = function () {
      if (!confirm('Remove "' + (f.facility.name || 'this building') + '", its ratings and its photos?')) return;
      Object.keys(f.items).forEach(function (n) { (f.items[n].photos || []).forEach(function (id) { photoDel(id); }); });
      S.facs = S.facs.filter(function (x) { return x.id !== f.id; });
      if (S.active === f.id) S.active = S.facs[0].id;
      save(); renderAll();
    };
    host.appendChild(row);
  });
}

/* ================= prerequisites ================= */
function renderPre() {
  var f = cur();
  [['cert', 'preCert', SV.preCert], ['gold', 'preGold', SV.preGold]].forEach(function (g) {
    var host = $(g[1]); host.innerHTML = '';
    g[2].forEach(function (t, i) {
      var d = el('label', 'cbox'); d.style.padding = '8px 0'; d.style.borderBottom = '1px solid var(--border)';
      d.innerHTML = '<input type="checkbox"' + (f.pre[g[0]][i] ? ' checked' : '') + '><span>' + esc(t) + '</span>';
      d.querySelector('input').onchange = function (e) { f.pre[g[0]][i] = e.target.checked; save(); renderPreWarn(); renderScore(); };
      host.appendChild(d);
    });
  });
  renderPreWarn();
}
function preOut(f) {
  return { c: SV.preCert.filter(function (_, i) { return !f.pre.cert[i]; }).length, g: SV.preGold.filter(function (_, i) { return !f.pre.gold[i]; }).length };
}
function renderPreWarn() {
  var p = preOut(cur()), w = $('preWarn');
  if (!p.c && !p.g) { w.className = 'note'; w.innerHTML = '<b>All prerequisites met.</b> The certification level now depends on the rating score.'; return; }
  w.className = 'warnbox';
  w.innerHTML = '<b>' + p.c + ' certification and ' + p.g + ' Gold prerequisite' + (p.g === 1 ? '' : 's') + ' outstanding.</b> ' +
    (p.c ? 'The site cannot be certified at any score until the certification prerequisites are met.' : 'The site can reach Certified but not Gold.');
}

/* ================= survey ================= */
function filtered() {
  var f = cur(), q = ($('q').value || '').toLowerCase().trim(), fc = $('fCat').value, fs = $('fStatus').value;
  return SV.items.filter(function (it) {
    if (!live(f, it)) return false;
    if (fc && it.cat !== fc) return false;
    var st = ist(f, it.n);
    if (fs === 'unscored' && scored(f, it)) return false;
    if (fs === 'short' && (st.na || st.pts == null || st.pts >= it.p || it.kind)) return false;
    if (fs === 'checks' && !checksFor(it.n).length) return false;
    if (fs === 'conflict' && !conflict(f, it)) return false;
    if (q) {
      var hay = (it.n + ' ' + it.t + ' ' + refsFor(it.n).join(' ') + ' ' + checksFor(it.n).map(function (p) { return p[1].cl + ' ' + p[1].label; }).join(' ')).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
}
function renderItems() {
  var host = $('items'), list = filtered(), f = cur(), t = totals(f);
  host.innerHTML = '';
  var cc = null, cs = null, frag = document.createDocumentFragment();
  list.slice(0, shown).forEach(function (it) {
    if (it.cat !== cc) {
      cc = it.cat; cs = null;
      var b = t.byCat[it.cat] || { e: 0, m: 0 };
      frag.appendChild(el('div', 'catbar', '<span>' + it.cat + '. ' + esc(SV.cats[it.cat]) + (it.bonus ? ' (bonus)' : '') + '</span><span class="cscore">' + b.e + ' / ' + b.m + '</span>'));
    }
    if (it.sub !== cs) { cs = it.sub; frag.appendChild(el('div', 'subbar', esc(it.sub + '  ' + (SV.subs[it.sub] || '')))); }
    frag.appendChild(itemEl(it));
  });
  host.appendChild(frag);
  if (list.length > shown) {
    var more = el('button', 'btn sec', 'Show more (' + (list.length - shown) + ' left)');
    more.type = 'button'; more.style.width = '100%';
    more.onclick = function () { shown += LIMIT; renderItems(); };
    host.appendChild(more);
  }
  if (!list.length) host.innerHTML = '<div class="card">No features match this filter.</div>';
}
function refLine(it) {
  var parts = [];
  var cls = {};
  checksFor(it.n).forEach(function (p) { cls[stdName(p[1]) + ' ' + p[1].cl] = 1; });
  refsFor(it.n).forEach(function (r) { cls[r.indexOf('B652 ') === 0 ? r : 'B651 ' + r] = 1; });
  Object.keys(cls).forEach(function (k) {
    var std = k.slice(0, 4), cl = k.slice(5);
    parts.push('<b>' + std + ' §' + esc(cl) + '</b> ' + esc(clTitle(std, cl)));
  });
  return parts.length ? '<div class="iref">' + parts.join(' · ') + '</div>' : '';
}
function itemClass(f, it) {
  var st = ist(f, it.n);
  if (st.na) return 'item na';
  if (!scored(f, it)) return 'item';
  var e = earned(f, it);
  return 'item ' + (e >= it.p ? 'full' : (e > 0 ? 'mid' : 'zero'));
}
function itemEl(it) {
  var f = cur(), st = ist(f, it.n), d = el('div', itemClass(f, it));
  d.id = 'it_' + it.n.replace(/\./g, '_');
  var cs = itemCheckState(f, it.n);
  var flag = '';
  if (conflict(f, it)) flag = '<span class="flag fail">Full points, but a measurement fails</span>';
  else if (cs.worst === 'fail') flag = '<span class="flag fail">Below B651/B652</span>';
  else if (cs.worst === 'warn') flag = '<span class="flag warn">Check profile</span>';
  else if (cs.worst === 'ok') flag = '<span class="flag ok">Measurements meet</span>';
  var pnote = it.pnote ? ' <span class="flag warn" title="' + esc(it.pnote) + '">Points per Handbook</span>' : '';
  d.innerHTML = '<div class="itop"><span class="inum">' + esc(it.n) + '</span><span class="ititle">' + esc(it.t) + pnote + ' ' + flag + '</span>' +
    '<span class="ipts">' + (it.kind ? '' : earnedLabel(f, it)) + it.p + ' pt' + (it.p === 1 ? '' : 's') + '</span></div>' + refLine(it);
  var pts = el('div', 'pts');
  if (it.kind === 'tech' || it.kind === 'innov') {
    pts.appendChild(el('span', '', '<b>' + earned(f, it) + '</b> of ' + (it.kind === 'innov' ? '20 (section)' : it.p) + ' — set below'));
  } else {
    for (var i = 0; i <= it.p; i++) pts.appendChild(pbtn(it, i, String(i), st.pts === i && !st.na));
    var noNA = it.hb && it.hb.noNA;
    var nb = pbtn(it, 'na', 'N/A', !!st.na); if (noNA) { nb.disabled = true; nb.title = 'The Handbook says this feature must be rated'; }
    pts.appendChild(nb);
  }
  var tg = el('button', 'tog', open[it.n] ? 'Close ▴' : 'Measure &amp; notes ▾'); tg.type = 'button';
  tg.setAttribute('aria-expanded', String(!!open[it.n]));
  tg.onclick = function () { open[it.n] = !open[it.n]; var n = itemEl(it); d.replaceWith(n); };
  pts.appendChild(tg);
  d.appendChild(pts);
  if (open[it.n]) d.appendChild(detailEl(it));
  return d;
}
function earnedLabel(f, it) { var st = ist(f, it.n); return (st.pts != null && !st.na) ? st.pts + ' / ' : ''; }
function pbtn(it, val, lab, on) {
  var b = el('button', 'pbtn' + (val === 'na' ? ' na' : ''), lab); b.type = 'button';
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', it.n + ' ' + (val === 'na' ? 'not applicable' : lab + ' points'));
  b.onclick = function () {
    var f = cur(), s = f.items[it.n] = f.items[it.n] || {};
    if (val === 'na') { s.na = !s.na; if (s.na) s.pts = null; }
    else { s.na = false; s.pts = (s.pts === val) ? null : val; }
    save(); refreshItem(it); renderProgress();
  };
  return b;
}
function updPts(it) {
  var d = $('it_' + it.n.replace(/\./g, '_')), sp = d && d.querySelector('.pts b');
  if (sp) sp.textContent = earned(cur(), it);
  if (d) d.className = itemClass(cur(), it);
  var t = totals(cur());
  document.querySelectorAll('.catbar').forEach(function (cb) { var c = cb.firstChild.textContent.split('.')[0], b = t.byCat[c]; if (b) cb.querySelector('.cscore').textContent = b.e + ' / ' + b.m; });
  renderProgress();
}
function refreshItem(it) {
  var old = $('it_' + it.n.replace(/\./g, '_')); if (old) old.replaceWith(itemEl(it));
  var t = totals(cur());
  document.querySelectorAll('.catbar').forEach(function (cb) {
    var c = cb.firstChild.textContent.split('.')[0], b = t.byCat[c];
    if (b) cb.querySelector('.cscore').textContent = b.e + ' / ' + b.m;
  });
}
function detailEl(it) {
  var f = cur(), st = f.items[it.n] = f.items[it.n] || {}, w = el('div', 'more');
  // ---- measurement checks
  var chks = checksFor(it.n);
  if (chks.length) {
    var s = el('div', 'sect'); s.appendChild(el('h4', '', 'Measurements'));
    st.meas = st.meas || {};
    chks.forEach(function (p) {
      var k = p[0], c = p[1], row = el('div', 'chk');
      var lab = '<div>' + esc(c.label) + '<div class="req">' + stdName(c) + ' §' + esc(c.cl) + ' — ' + esc(reqText(c)) + (c.note ? '. ' + esc(c.note) : '') + '</div></div>';
      var v = st.meas[k];
      if (c.type === 'contrast' || c.type === 'parkcount') {
        var pa = c.type === 'contrast' ? ['LRV light', 'LRV dark'] : ['Total spaces', 'Accessible'];
        row.innerHTML = lab + '<div class="pair"><input type="number" inputmode="decimal" placeholder="' + pa[0] + '" aria-label="' + pa[0] + '" value="' + esc(v && v.a) + '"><input type="number" inputmode="decimal" placeholder="' + pa[1] + '" aria-label="' + pa[1] + '" value="' + esc(v && v.b) + '"></div><div class="res"></div>';
        var ins = row.querySelectorAll('input');
        var upd2 = function () { st.meas[k] = { a: ins[0].value, b: ins[1].value }; if (!ins[0].value && !ins[1].value) delete st.meas[k]; save(); showRes(); };
        ins[0].oninput = ins[1].oninput = upd2;
      } else {
        row.innerHTML = lab + '<input type="number" inputmode="decimal" step="any" placeholder="' + esc(c.unit) + '" aria-label="' + esc(c.label + ' in ' + c.unit) + '" value="' + esc(v) + '"><div class="res"></div>';
        var inp = row.querySelector('input');
        inp.oninput = function () { if (inp.value === '') delete st.meas[k]; else st.meas[k] = inp.value; save(); showRes(); };
      }
      function showRes() {
        var r = evalCheck(c, st.meas[k]), out = row.querySelector('.res');
        out.className = 'res' + (r ? ' ' + r.s : ''); out.textContent = r ? (r.s === 'ok' ? '✓ ' : r.s === 'warn' ? '⚠ ' : '✗ ') + r.t : '';
        updFlag();
      }
      s.appendChild(row); setTimeout(showRes, 0);
    });
    var hint = el('div', 'req'); hint.style.cssText = 'font-size:.75rem;color:var(--muted);margin-top:6px';
    hint.textContent = 'Handbook 2.4.1: a feature that does not meet the 2023 CSA editions is generally not eligible for maximum points — usually one point is docked.';
    s.appendChild(hint);
    w.appendChild(s);
  } else if (it.cat === '9' || refsFor(it.n).length) {
    // references only
  }
  function updFlag() {
    var head = w.parentNode && w.parentNode.querySelector('.ititle'); if (!head) return;
    var old = head.querySelector('.flag:not([title])'); if (old) old.remove();
    var cs = itemCheckState(f, it.n), fl = null;
    if (conflict(f, it)) fl = ['fail', 'Full points, but a measurement fails'];
    else if (cs.worst === 'fail') fl = ['fail', 'Below B651/B652'];
    else if (cs.worst === 'warn') fl = ['warn', 'Check profile'];
    else if (cs.worst === 'ok') fl = ['ok', 'Measurements meet'];
    if (fl) head.appendChild(el('span', 'flag ' + fl[0], fl[1]));
  }
  // ---- special: technology use checklist
  if (it.kind === 'tech') {
    var ts = el('div', 'sect'); ts.appendChild(el('h4', '', 'Technology types and users (Handbook Tables 4–6)'));
    st.tech = st.tech || { types: [], users: [] };
    [['types', 'A. Technology types'], ['users', 'B. User groups that benefit']].forEach(function (g) {
      ts.appendChild(el('div', '', '<b style="font-size:.82rem">' + g[1] + '</b>'));
      SV.tech[g[0]].forEach(function (lab) {
        var r = el('label', 'cbox'); r.innerHTML = '<input type="checkbox"' + (st.tech[g[0]].indexOf(lab) >= 0 ? ' checked' : '') + '><span>' + esc(lab) + '</span>';
        r.querySelector('input').onchange = function (e) {
          var a = st.tech[g[0]]; if (e.target.checked) { if (a.indexOf(lab) < 0) a.push(lab); } else a.splice(a.indexOf(lab), 1);
          save(); updPts(it);
        };
        ts.appendChild(r);
      });
    });
    ts.appendChild(el('div', 'req', '<span style="font-size:.78rem;color:var(--muted)">' + esc(SV.tech.note) + ' 2+ types and 2+ groups = 5 pts; 4+ and 4+ = 10 pts.</span>'));
    w.appendChild(ts);
  }
  if (it.kind === 'innov') {
    var is = el('div', 'sect'); is.appendChild(el('h4', '', 'Innovation features — 2 points each, up to 10; section 12.3 capped at 20'));
    st.innov = st.innov || [];
    var list = el('div');
    var draw = function () {
      list.innerHTML = '';
      st.innov.forEach(function (x, i) {
        var r = el('div', 'row'); r.style.marginBottom = '6px';
        r.innerHTML = '<input type="text" style="flex:1" placeholder="Describe the feature" value="' + esc(x.t) + '"><button type="button" class="btn sec" aria-label="Remove">×</button>';
        r.querySelector('input').oninput = function (e) { x.t = e.target.value; save(); };
        r.querySelector('input').onchange = function () { updPts(it); };
        r.querySelector('button').onclick = function () { st.innov.splice(i, 1); save(); draw(); updPts(it); };
        list.appendChild(r);
      });
    };
    draw(); is.appendChild(list);
    var add = el('button', 'btn sec', '+ Add a feature'); add.type = 'button';
    add.onclick = function () { if (st.innov.length >= 10) { toast('Up to 10 features'); return; } st.innov.push({ t: '' }); save(); draw(); };
    is.appendChild(add); w.appendChild(is);
  }
  // ---- handbook criteria
  if (it.hb && Object.keys(it.hb).length) w.appendChild(hbEl(it.hb));
  if (it.pnote) w.appendChild(el('div', 'note', '<b>Point value.</b> ' + esc(it.pnote)));
  // ---- notes, cost, location, photos
  var ns = el('div', 'sect'); ns.appendChild(el('h4', '', 'Findings'));
  var g = el('div', 'dgrid');
  g.innerHTML =
    '<textarea class="full" data-f="note" placeholder="Rating rationale / finding (what you saw and why this score)">' + esc(st.note || '') + '</textarea>' +
    (it.n === '12.2.1' || it.sub === '12.2' ? '<input class="full" type="url" data-f="url" placeholder="Website URL (required for 12.2 bonus points)" value="' + esc(st.url || '') + '">' : '') +
    '<select data-f="floor" aria-label="Floor">' + ['', 'Site approach', 'Lower floor', 'Main floor', 'Upper floor', 'Other floor', 'Whole building'].map(function (o) { return '<option value="' + o + '"' + ((st.floor || '') === o ? ' selected' : '') + '>' + (o || 'Floor…') + '</option>'; }).join('') + '</select>' +
    '<input type="text" data-f="room" placeholder="Room or area" value="' + esc(st.room || '') + '">' +
    '<input type="number" inputmode="numeric" data-f="costLo" placeholder="Est. cost low $" value="' + esc(st.costLo || '') + '">' +
    '<input type="number" inputmode="numeric" data-f="costHi" placeholder="Est. cost high $" value="' + esc(st.costHi || '') + '">' +
    '<select data-f="phase" aria-label="Phase">' + [['', 'Phase: automatic'], ['0', 'Phase 0 — immediate'], ['1', 'Phase 1 — Year 1'], ['2', 'Phase 2 — Year 2'], ['-', 'Not scheduled']].map(function (o) { return '<option value="' + o[0] + '"' + ((st.phase || '') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
    '<input type="text" data-f="with" placeholder="Same work as item #" value="' + esc(st.with || '') + '">' +
    '<label class="cbox full"><input type="checkbox" data-f="life"' + (st.life ? ' checked' : '') + '> Life-safety item</label>' +
    '<label class="cbox full"><input type="checkbox" data-f="prereq"' + (st.prereq ? ' checked' : '') + '> Affects a certification prerequisite</label>' +
    '<label class="full" style="font-size:.82rem;color:var(--muted)">Photos <input type="file" accept="image/*" capture="environment" multiple data-f="photo" style="font-size:14px"></label>' +
    '<div class="photos full"></div>';
  g.querySelectorAll('[data-f]').forEach(function (inp) {
    var k = inp.dataset.f;
    if (k === 'photo') { inp.onchange = function (e) { addPhotos(it, [].slice.call(e.target.files), function () { drawPhotos(); }); inp.value = ''; }; return; }
    inp.oninput = inp.onchange = function () { st[k] = inp.type === 'checkbox' ? inp.checked : inp.value; save(); };
  });
  ns.appendChild(g); w.appendChild(ns);
  function drawPhotos() {
    var box = g.querySelector('.photos'); box.innerHTML = '';
    (st.photos || []).forEach(function (id, i) {
      var ph = el('span', 'ph'), img = el('img'); img.alt = 'Photo ' + (i + 1) + ' for ' + it.n;
      thumb(id).then(function (u) { if (u) img.src = u; });
      var rm = el('button', '', '×'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove photo');
      rm.onclick = function () { st.photos.splice(i, 1); photoDel(id); if (photoURL[id]) { URL.revokeObjectURL(photoURL[id]); delete photoURL[id]; } save(); drawPhotos(); };
      ph.appendChild(img); ph.appendChild(rm); box.appendChild(ph);
    });
  }
  drawPhotos();
  return w;
}
function hbEl(h) {
  var s = el('div', 'sect hb'); s.appendChild(el('h4', '', 'Handbook criteria (RHFAC v4.0)'));
  function list(arr) {
    return '<ul>' + arr.map(function (x) { return '<li class="' + (x.l === 2 ? 'l2' : x.l === 3 ? 'note' : '') + '">' + esc(x.t) + '</li>'; }).join('') + '</ul>';
  }
  var html = '';
  if (h.intro) html += '<div class="intro">' + h.intro.map(function (x) { return esc(x.t); }).join(' ') + '</div>';
  if (h.min) html += '<div class="lab min">Minimum points</div>' + list(h.min);
  if (h.max) html += '<div class="lab max">Maximum points</div>' + list(h.max);
  if (h.minmax) html += '<div class="lab mm">Minimum / maximum points</div>' + list(h.minmax);
  if (h.innov) html += '<div class="lab inn">Ideas for innovation</div>' + list(h.innov);
  if (h.na) html += '<div class="na"><b>N/A:</b> ' + esc(h.na) + '</div>';
  s.insertAdjacentHTML('beforeend', html);
  return s;
}

/* ================= photos ================= */
function thumb(id) {
  if (photoURL[id]) return Promise.resolve(photoURL[id]);
  return photoGet(id).then(function (r) { if (!r) return null; photoURL[id] = URL.createObjectURL(r.blob); return photoURL[id]; });
}
function addPhotos(it, files, done) {
  var f = cur(), st = f.items[it.n] = f.items[it.n] || {}; st.photos = st.photos || [];
  var left = files.length; if (!left) return;
  files.forEach(function (file) {
    shrink(file, 1600, 0.8).then(function (blob) {
      var id = uid('p');
      return photoPut({ id: id, fac: f.id, item: it.n, blob: blob, ts: Date.now(), name: file.name }).then(function () { st.photos.push(id); });
    }).catch(function () { toast('A photo could not be stored'); }).then(function () {
      if (--left === 0) { save(); done(); storageInfo(); }
    });
  });
}
function shrink(file, max, q) {
  return new Promise(function (res, rej) {
    var u = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight;
      if (w > max || h > max) { if (w > h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; } }
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h); URL.revokeObjectURL(u);
      c.toBlob(function (b) { b ? res(b) : rej(); }, 'image/jpeg', q);
    };
    img.onerror = function () { URL.revokeObjectURL(u); rej(); };
    img.src = u;
  });
}

/* ================= score ================= */
function stat(v, l) { return '<div class="st"><div class="v">' + esc(v) + '</div><div class="l">' + esc(l) + '</div></div>'; }
function level(f, t) {
  var p = preOut(f);
  if (t.pct >= 80 && !p.c && !p.g) return 'Gold range';
  if (t.pct >= 60 && !p.c) return t.pct >= 80 ? 'Certified (Gold prerequisites open)' : 'Certified range';
  if (t.pct >= 60) return 'Score met — prerequisites open';
  return 'Not certified';
}
function renderScore() {
  var f = cur(), t = totals(f);
  $('stats').innerHTML = stat(pc(t.earned, t.max), 'Rating score') + stat(t.base, 'Points, Categories 1–10') + stat('+' + t.bonus, 'Bonus, Categories 11–12') +
    stat(t.max, 'Applicable points') + stat(t.cert, 'Certified at (60%)') + stat(t.gold, 'Gold at (80%)') + stat(level(f, t), 'Status');
  $('meter').querySelector('.f').style.width = Math.min(100, t.pct) + '%';
  var rows = '<tr><th>#</th><th>Category</th><th>Earned</th><th>Max</th><th>%</th></tr>';
  Object.keys(SV.cats).sort(function (a, b) { return a - b; }).forEach(function (c) {
    if (!catOn(f, c)) { rows += '<tr><td>' + c + '</td><td>' + esc(SV.cats[c]) + '</td><td colspan="3" style="color:var(--muted)">Excluded</td></tr>'; return; }
    var b = t.byCat[c] || { e: 0, m: 0 }, bonus = (c === '11' || c === '12');
    rows += '<tr><td>' + c + '</td><td>' + esc(SV.cats[c]) + (bonus ? ' <span class="pill mid">bonus</span>' : '') + '</td><td>' + b.e + '</td><td>' + b.m + '</td><td>' + (bonus ? '—' : pc(b.e, b.m)) + '</td></tr>';
  });
  rows += '<tr class="tot"><td></td><td>Total (with bonus)</td><td>' + t.earned + '</td><td>' + t.max + '</td><td>' + pc(t.earned, t.max) + '</td></tr>';
  $('catTable').innerHTML = rows;
  var cf = SV.items.filter(function (it) { return live(f, it) && conflict(f, it); });
  $('conflicts').innerHTML = cf.length ? '<div class="warnbox"><b>' + cf.length + ' feature' + (cf.length === 1 ? ' has' : 's have') +
    ' full points but a measurement below B651/B652:23.</b> Handbook 2.4.1 says these are generally not eligible for maximum points. ' +
    cf.map(function (it) { return '<a href="#" data-n="' + it.n + '">' + it.n + '</a>'; }).join(', ') + '</div>' : '';
  $('conflicts').querySelectorAll('a').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); jumpTo(a.dataset.n); }; });
}

/* ================= remediation ================= */
function remRows(f) {
  var rows = [];
  SV.items.forEach(function (it) {
    if (!live(f, it) || it.bonus || it.kind) return;
    var st = ist(f, it.n);
    if (st.na || st.pts == null || st.pts >= it.p) return;
    rows.push({ n: it.n, t: it.t, gain: it.p - st.pts, lo: +st.costLo || 0, hi: +st.costHi || 0, life: !!st.life, prereq: !!st.prereq,
      phase: st.phase || '', with: (st.with || '').trim(), items: [it.n], loc: [st.floor, st.room].filter(Boolean).join(' · '),
      fail: itemCheckState(f, it.n).worst === 'fail' });
  });
  var by = {}; rows.forEach(function (r) { by[r.n] = r; });
  rows = rows.filter(function (r) {
    var h = r.with && r.with !== r.n ? by[r.with] : null; if (!h) return true;
    h.gain += r.gain; h.lo += r.lo; h.hi += r.hi; h.items.push(r.n); h.life = h.life || r.life; h.prereq = h.prereq || r.prereq; return false;
  });
  rows.forEach(function (r) { var mid = (r.lo + r.hi) / 2; r.ppd = mid > 0 ? r.gain / mid : (r.gain > 0 ? Infinity : 0); if (!r.phase) r.phase = r.life ? '0' : '1'; });
  rows.sort(function (a, b) { if (a.life !== b.life) return a.life ? -1 : 1; return b.ppd - a.ppd; });
  return rows;
}
function renderRemed() {
  var f = cur(), t = totals(f), rows = remRows(f);
  var lo = 0, hi = 0, gain = 0; rows.forEach(function (r) { lo += r.lo; hi += r.hi; gain += r.gain; });
  $('remStats').innerHTML = stat(rows.reduce(function (s, r) { return s + r.items.length; }, 0), 'Below maximum') +
    stat(rows.filter(function (r) { return r.life; }).length, 'Life-safety') + stat(gain, 'Points recoverable') + stat(lo || hi ? money(lo) + '–' + money(hi) : '—', 'Estimated cost');
  var run = t.earned, PH = { '0': '0', '1': '1', '2': '2', '-': '—' };
  var h = '<tr><th>#</th><th>Finding</th><th>Where</th><th>Phase</th><th>Pts</th><th>Cost</th><th>Pts/$1k</th><th>Running</th></tr>';
  rows.forEach(function (r) {
    var before = run; run += r.gain; var mid = (r.lo + r.hi) / 2;
    var hit = before < t.cert && run >= t.cert;
    h += '<tr' + (r.life ? ' style="background:var(--coral-tint)"' : '') + '><td>' + esc(r.items.join(', ')) + '</td><td>' + esc(r.t) +
      (r.life ? ' <span class="pill no">Life safety</span>' : '') + (r.prereq ? ' <span class="pill mid">Prerequisite</span>' : '') + (r.fail ? ' <span class="pill no">Below CSA</span>' : '') + '</td>' +
      '<td>' + (r.loc ? esc(r.loc) : '<span style="color:var(--muted)">—</span>') + '</td><td>' + PH[r.phase] + '</td><td>+' + r.gain + '</td>' +
      '<td>' + (r.lo || r.hi ? money(r.lo) + '–' + money(r.hi) : '—') + '</td><td>' + (mid > 0 ? (r.gain / mid * 1000).toFixed(1) : (r.gain ? 'cost?' : '—')) + '</td>' +
      '<td>' + run + (hit ? ' <span class="pill ok">60%</span>' : '') + '</td></tr>';
  });
  if (!rows.length) h += '<tr><td colspan="8" style="color:var(--muted)">Nothing scored below its maximum yet.</td></tr>';
  $('remTable').innerHTML = h;
}

/* ================= portfolio ================= */
function renderPort() {
  var rows = '<tr><th>Building</th><th>Earned</th><th>Applicable</th><th>Score</th><th>Status</th><th>Below max</th></tr>', E = 0, M = 0;
  S.facs.forEach(function (f) {
    var t = totals(f); E += t.earned; M += t.max;
    rows += '<tr><td>' + esc(f.facility.name || 'Untitled') + '</td><td>' + t.earned + '</td><td>' + t.max + '</td><td>' + pc(t.earned, t.max) + '</td><td>' + esc(t.scored ? level(f, t) : 'Not started') + '</td><td>' + remRows(f).length + '</td></tr>';
  });
  rows += '<tr class="tot"><td>Portfolio</td><td>' + E + '</td><td>' + M + '</td><td>' + pc(E, M) + '</td><td colspan="2"></td></tr>';
  $('portTable').innerHTML = rows;
  var map = {};
  S.facs.forEach(function (f) {
    remRows(f).forEach(function (r) {
      r.items.forEach(function (n) {
        var st = ist(f, n), m = map[n] || (map[n] = { n: n, t: ITEM[n].t, facs: [], lo: 0, hi: 0, pts: 0 });
        m.facs.push(f.facility.name || 'Untitled'); m.lo += +st.costLo || 0; m.hi += +st.costHi || 0; m.pts += ITEM[n].p - (st.pts || 0);
      });
    });
  });
  var sys = Object.keys(map).map(function (k) { return map[k]; }).filter(function (m) { return m.facs.length > 1; }).sort(function (a, b) { return b.facs.length - a.facs.length || b.hi - a.hi; });
  var h = '<tr><th>Feature</th><th>Buildings</th><th>Pts</th><th>Separately</th><th>One contract</th></tr>';
  sys.forEach(function (m) {
    h += '<tr><td>' + esc(m.n + ' ' + m.t) + '</td><td>' + m.facs.length + ' of ' + S.facs.length + '</td><td>+' + m.pts + '</td><td>' + (m.lo || m.hi ? money(m.lo) + '–' + money(m.hi) : '—') + '</td><td>' + (m.lo || m.hi ? money(m.lo * 0.8) + '–' + money(m.hi * 0.8) : '—') + '</td></tr>';
  });
  if (!sys.length) h += '<tr><td colspan="5" style="color:var(--muted)">' + (S.facs.length < 2 ? 'Add and rate a second building to see shared shortfalls.' : 'No shortfall appears at more than one building yet.') + '</td></tr>';
  $('sysTable').innerHTML = h;
}

/* ================= data: backup / restore / export ================= */
function dl(name, data, type) {
  var b = data instanceof Blob ? data : new Blob([data], { type: type || 'application/json' }), u = URL.createObjectURL(b), a = el('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 2000);
}
function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); }
function b64(blob) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.readAsDataURL(blob); }); }
function backup(withPhotos) {
  var p = withPhotos ? photoAll().then(function (all) {
    return Promise.all(all.map(function (r) { return b64(r.blob).then(function (d) { return { id: r.id, fac: r.fac, item: r.item, ts: r.ts, data: d }; }); }));
  }) : Promise.resolve([]);
  return p.then(function (photos) {
    S.lastBackup = Date.now(); S.firstUnbacked = 0;
    var out = { app: 'novo-field', version: VERSION, saved: new Date().toISOString(), state: S, photos: photos };
    dl('novo-field-backup-' + (withPhotos ? 'full-' : 'data-') + stamp() + '.json', JSON.stringify(out));
    save(); S.firstUnbacked = 0; backupInfo(); banner(''); toast('Backup downloaded');
  });
}
function restore(file) {
  var r = new FileReader();
  r.onload = function () {
    var o; try { o = JSON.parse(r.result); } catch (e) { toast('That file is not a backup'); return; }
    var st = o && o.app === 'novo-field' ? o.state : o;   // also accepts the old single-file tool's JSON
    if (!st || !(st.facs || st.items)) { toast('That file is not a backup'); return; }
    if (!confirm('Replace everything in the tool with this backup?')) return;
    var photos = (o.photos || []).slice();
    // old single-file backups kept photos inline as data URLs
    if (st.facs && !o.app) st.facs.forEach(function (f) {
      Object.keys(f.items || {}).forEach(function (n) {
        (f.items[n].photos || []).forEach(function (d, i) { if (typeof d === 'string' && d.indexOf('data:') === 0) photos.push({ id: uid('p'), fac: f.id, item: n, ts: Date.now(), data: d, legacy: true }); });
      });
    });
    S = migrate(st);
    photoClear().then(function () {
      return Promise.all(photos.map(function (p) {
        return fetch(p.data).then(function (x) { return x.blob(); }).then(function (blob) {
          if (p.legacy) { var f = S.facs.filter(function (x) { return x.id === p.fac; })[0]; if (f) { var it = f.items[p.item] = f.items[p.item] || {}; it.photos = it.photos || []; it.photos.push(p.id); } }
          return photoPut({ id: p.id, fac: p.fac, item: p.item, ts: p.ts, blob: blob });
        });
      }));
    }).then(function () { photoURL = {}; save(); renderAll(); toast('Backup restored'); });
  };
  r.readAsText(file);
}
function findings(f) {
  var out = [];
  SV.items.forEach(function (it) {
    if (!live(f, it)) return;
    var st = ist(f, it.n);
    if (!scored(f, it) && !(st.meas && Object.keys(st.meas).length) && !st.note && !(st.photos && st.photos.length)) return;
    var meas = checksFor(it.n).map(function (p) {
      var v = (st.meas || {})[p[0]], r = evalCheck(p[1], v); if (!r) return null;
      var val = typeof v === 'object' ? v.a + '/' + v.b : v;
      return { check: p[1].label, clause: stdName(p[1]) + ' §' + p[1].cl, required: reqText(p[1]), measured: val + (p[1].unit && typeof v !== 'object' ? ' ' + p[1].unit : ''), result: r.s };
    }).filter(Boolean);
    out.push({ item: it.n, category: SV.cats[it.cat], section: SV.subs[it.sub], feature: it.t, max: it.p, points: st.na ? null : earned(f, it), na: !!st.na, bonus: !!it.bonus,
      measurements: meas, note: st.note || '', url: st.url || '', floor: st.floor || '', room: st.room || '', costLow: +st.costLo || null, costHigh: +st.costHi || null,
      lifeSafety: !!st.life, prerequisite: !!st.prereq, phase: st.phase || '', sameWorkAs: st.with || '', photos: (st.photos || []).length,
      fullButFails: conflict(f, it) });
  });
  return out;
}
function exportCsv() {
  var rows = [['Building', 'Item', 'Category', 'Section', 'Feature', 'Max', 'Points', 'N/A', 'Measurements', 'Fails CSA', 'Note', 'Floor', 'Room', 'Cost low', 'Cost high', 'Life safety', 'Prerequisite', 'Phase', 'Same work as']];
  S.facs.forEach(function (f) {
    findings(f).forEach(function (x) {
      rows.push([f.facility.name, x.item, x.category, x.section, x.feature, x.max, x.points == null ? '' : x.points, x.na ? 'Yes' : '',
        x.measurements.map(function (m) { return m.check + ' ' + m.measured + ' (' + m.clause + ' ' + m.required + ') ' + m.result; }).join(' | '),
        x.measurements.some(function (m) { return m.result === 'fail'; }) ? 'Yes' : '', x.note.replace(/\n/g, ' '), x.floor, x.room, x.costLow || '', x.costHigh || '', x.lifeSafety ? 'Yes' : '', x.prerequisite ? 'Yes' : '', x.phase, x.sameWorkAs]);
    });
  });
  dl('novo-findings-' + stamp() + '.csv', '﻿' + rows.map(function (r) { return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n'), 'text/csv');
}
function exportJson() {
  var out = { generated: new Date().toISOString(), tool: 'Novo Field Tool ' + VERSION, sources: { survey: SV.meta.title + ' ' + SV.meta.version, handbook: SV.meta.handbook, standards: [ST.meta.title, ST.meta.b652] },
    assessor: S.shared, buildings: S.facs.map(function (f) {
      var t = totals(f), p = preOut(f);
      return { facility: f.facility, score: { pointsCat1to10: t.base, bonus: t.bonus, earned: t.earned, applicable: t.max, percent: +(t.pct.toFixed(1)), certifiedAt: t.cert, goldAt: t.gold, status: level(f, t) },
        prerequisitesOutstanding: { certification: SV.preCert.filter(function (_, i) { return !f.pre.cert[i]; }), gold: SV.preGold.filter(function (_, i) { return !f.pre.gold[i]; }) },
        byCategory: Object.keys(t.byCat).map(function (c) { return { category: c, name: SV.cats[c], earned: t.byCat[c].e, max: t.byCat[c].m }; }),
        findings: findings(f) };
    }) };
  dl('novo-report-data-' + stamp() + '.json', JSON.stringify(out, null, 1));
}
function printReport() {
  var f = cur(), t = totals(f), p = preOut(f), fa = f.facility;
  var h = '<h1>' + esc(fa.name || 'Accessibility rating') + '</h1><div class="meta">' + esc([fa.owner, fa.addr, fa.date, S.shared.assessor].filter(Boolean).join(' · ')) + '</div>' +
    '<div class="meta">Rated against the ' + esc(SV.meta.title + ' ' + SV.meta.version) + ' using the ' + esc(SV.meta.handbook) + ', with measurements checked against CSA/ASC B651:23 and B652:23. This is a field record, not an RHFAC certification.</div>' +
    '<h2>Score</h2><p><b>' + pc(t.earned, t.max) + '</b> — ' + t.earned + ' of ' + t.max + ' applicable points (' + t.base + ' + ' + t.bonus + ' bonus). Certified at ' + t.cert + ', Gold at ' + t.gold + '. Status: <b>' + esc(level(f, t)) + '</b>. ' +
    (p.c || p.g ? p.c + ' certification and ' + p.g + ' Gold prerequisites outstanding.' : 'All prerequisites met.') + '</p>' +
    (fa.scope ? '<p><b>Scope:</b> ' + esc(fa.scope) + '</p>' : '') +
    '<table><tr><th>#</th><th>Category</th><th>Earned</th><th>Max</th></tr>' + Object.keys(t.byCat).map(function (c) { return '<tr><td>' + c + '</td><td>' + esc(SV.cats[c]) + '</td><td>' + t.byCat[c].e + '</td><td>' + t.byCat[c].m + '</td></tr>'; }).join('') + '</table>' +
    '<h2>Features below maximum</h2><table><tr><th>#</th><th>Feature</th><th>Pts</th><th>Measurements</th><th>Finding</th><th>Cost</th></tr>';
  findings(f).filter(function (x) { return !x.na && x.points != null && x.points < x.max && !x.bonus; }).forEach(function (x) {
    h += '<tr><td>' + x.item + '</td><td>' + esc(x.feature) + (x.lifeSafety ? ' (life safety)' : '') + '</td><td>' + x.points + '/' + x.max + '</td><td>' +
      x.measurements.map(function (m) { return esc(m.check + ': ' + m.measured + ' — ' + m.clause + ' ' + m.required + (m.result === 'fail' ? ' ✗' : m.result === 'ok' ? ' ✓' : ' ⚠')); }).join('<br>') +
      '</td><td>' + esc(x.note) + '</td><td>' + (x.costLow || x.costHigh ? money(x.costLow || 0) + '–' + money(x.costHigh || 0) : '') + '</td></tr>';
  });
  h += '</table>';
  $('report').innerHTML = h;
  setTimeout(function () { window.print(); }, 50);
}

/* ================= storage info / backup nag ================= */
function storageInfo() {
  var e = $('storeInfo'); if (!e) return;
  var n = 0; S.facs.forEach(function (f) { Object.keys(f.items).forEach(function (k) { n += (f.items[k].photos || []).length; }); });
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(function (x) {
      e.innerHTML = '<b>' + (x.usage / 1048576).toFixed(1) + ' MB</b> used of about ' + (x.quota / 1073741824).toFixed(1) + ' GB available · ' + n + ' photo' + (n === 1 ? '' : 's') + '.';
    });
  } else e.textContent = n + ' photos stored.';
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(function (p) {
    if (!p) e.insertAdjacentHTML('beforeend', ' <span style="color:var(--coral-deep)">The browser may clear this data if the device runs low on space — install the app to the home screen and back up after every visit.</span>');
  });
}
function backupInfo() {
  var b = $('backupInfo'); if (!b) return;
  b.textContent = S.lastBackup ? 'Last backup: ' + new Date(S.lastBackup).toLocaleString('en-CA') : 'No backup yet on this device.';
}
function backupNag() {
  if (saveFailed) return;
  if (S.firstUnbacked && Date.now() - S.firstUnbacked > 4 * 3600 * 1000)
    banner('Unsaved to a backup for over 4 hours of work.', 'Back up now', function () { backup(true).then(function () { banner(''); }); }, true);
}

/* ================= tabs & misc ================= */
function show(tab) {
  ['setup', 'prereq', 'survey', 'score', 'remed', 'port', 'data'].forEach(function (t) { $('p-' + t).classList.toggle('hide', t !== tab); });
  document.querySelectorAll('nav.tabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.t === tab)); });
  if (tab === 'score') renderScore();
  if (tab === 'remed') renderRemed();
  if (tab === 'port') renderPort();
  if (tab === 'data') { storageInfo(); backupInfo(); }
  if (tab === 'survey') renderItems();
  window.scrollTo(0, 0);
}
function jumpTo(n) {
  var it = ITEM[n]; if (!it) return;
  show('survey'); $('fStatus').value = ''; $('q').value = ''; $('fCat').value = '';
  var idx = filtered().indexOf(it); shown = Math.max(LIMIT, idx + 20); open[n] = true; renderItems();
  setTimeout(function () { var e = $('it_' + n.replace(/\./g, '_')); if (e) { e.scrollIntoView({ block: 'center' }); e.style.boxShadow = '0 0 0 3px var(--teal)'; setTimeout(function () { e.style.boxShadow = ''; }, 1400); } }, 60);
}
function renderAll() {
  renderFacBar(); renderSetup(); renderPre(); renderItems(); renderScore(); renderProgress();
  if (!$('p-remed').classList.contains('hide')) renderRemed();
  if (!$('p-port').classList.contains('hide')) renderPort();
}
function wire() {
  document.querySelectorAll('nav.tabs button').forEach(function (b) { b.onclick = function () { show(b.dataset.t); }; });
  $('addFac').onclick = addFac;
  $('subsOff').onclick = function () { var f = cur(); SV.items.forEach(function (i) { if (i.cat === '8') f.subs[i.sub] = false; }); changed(); renderSetup(); toast('Category 8 sections off'); };
  $('subsOn').onclick = function () { var f = cur(); f.subs = {}; f.cats = {}; changed(); renderSetup(); toast('Everything on'); };
  $('q').oninput = function () { shown = LIMIT; renderItems(); };
  ['fCat', 'fStatus'].forEach(function (id) { $(id).onchange = function () { shown = LIMIT; renderItems(); }; });
  $('jumpBtn').onclick = function () {
    var f = cur(), nx = SV.items.filter(function (it) { return live(f, it) && !scored(f, it); })[0];
    if (!nx) { toast('Every applicable feature is rated'); return; } jumpTo(nx.n);
  };
  $('progR').onclick = function () { show('score'); };
  $('themeBtn').onclick = function () {
    var c = document.documentElement.getAttribute('data-theme'), n = c === 'dark' ? 'light' : (c === 'light' ? null : 'dark');
    if (n) document.documentElement.setAttribute('data-theme', n); else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('novo-theme', n || ''); } catch (e) {}
  };
  $('bkFull').onclick = function () { backup(true); };
  $('lockBtn').onclick = lockDevice;
  $('bkData').onclick = function () { backup(false); };
  $('expCsv').onclick = exportCsv; $('expJson').onclick = exportJson; $('doPrint').onclick = printReport;
  $('impFile').onchange = function (e) { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; };
  $('clearAll').onclick = function () {
    if (!confirm('Clear every building and photo on this device? This cannot be undone.')) return;
    photoClear().then(function () { S = blank(); photoURL = {}; save(); renderAll(); toast('Cleared'); });
  };
  var fc = $('fCat');
  Object.keys(SV.cats).sort(function (a, b) { return a - b; }).forEach(function (c) { var o = el('option'); o.value = c; o.textContent = c + '. ' + SV.cats[c]; fc.appendChild(o); });
  $('surveySub').textContent = SV.meta.title + ' ' + SV.meta.version + ' · criteria from the ' + SV.meta.handbook + ' · measurements against CSA/ASC B651:23 and B652:23.';
  $('srcMeta').innerHTML = '<p>' + esc(SV.meta.title + ' ' + SV.meta.version) + ' — feature list and point values.</p><p>' + esc(SV.meta.handbook) +
    ' — Minimum/Maximum criteria, N/A rules and scoring method. Where the survey and Handbook disagree on points (8.12.2, 8.13.3), the Handbook value is used because it matches both documents\' section totals.</p><p>' +
    esc(ST.meta.title + ', ' + ST.meta.name) + ' and ' + esc(ST.meta.b652) + ' — clause numbers and numeric requirements only.</p><p>' + esc(SV.meta.scoring) + '</p>' +
    '<p>Rick Hansen Foundation and CSA Group content is copyright of its owners. This tool is a field aid and does not certify sites.</p><p style="color:var(--muted)">Novo Field Tool ' + VERSION + '</p>';
}

/* ================= boot ================= */
try { var th = localStorage.getItem('novo-theme'); if (th) document.documentElement.setAttribute('data-theme', th); } catch (e) {}
function unb64(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function deriveKey(pass, env) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']).then(function (base) {
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(env.salt), iterations: env.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  });
}
function decrypt(key, env) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.ct)).then(function (buf) { return JSON.parse(new TextDecoder().decode(buf)); });
}
function loadData() {
  // Data ships encrypted. Once unlocked, the decrypted copy is kept in IndexedDB so the tool runs offline.
  return Promise.all([
    fetch('data/survey.enc').then(function (r) { if (!r.ok) throw new Error('survey data missing'); return r.json(); }),
    fetch('data/standards.enc').then(function (r) { if (!r.ok) throw new Error('standards data missing'); return r.json(); })
  ]).catch(function (e) {
    return kvGet('data').then(function (c) { if (c) return { cached: c }; throw e; });   // offline and not cached by the browser
  }).then(function (envs) {
    if (envs.cached) return envs.cached;
    var want = envs[0].id + envs[1].id;
    return kvGet('data').then(function (c) {
      if (c && c.id === want) return c;
      return kvGet('key').then(function (k) {
        var tryKey = k && k.salt === envs[0].salt ? Promise.all([decrypt(k.key, envs[0]), decrypt(k.key, envs[1])]) : Promise.reject();
        return tryKey.catch(function () { return askPass(envs); });
      }).then(function (d) {
        var rec = { id: want, sv: d[0], st: d[1] };
        return kvSet('data', rec).then(function () { return rec; });
      });
    });
  });
}
function askPass(envs) {
  return new Promise(function (resolve) {
    $('loading').classList.add('hide');
    var g = $('gate'); g.classList.remove('hide');
    var f = $('gateForm'), inp = $('gatePass'), msg = $('gateMsg');
    setTimeout(function () { inp.focus(); }, 50);
    f.onsubmit = function (e) {
      e.preventDefault(); msg.textContent = 'Unlocking…';
      var pass = inp.value.trim().toLowerCase();
      deriveKey(pass, envs[0]).then(function (key) {
        return Promise.all([decrypt(key, envs[0]), decrypt(key, envs[1])]).then(function (d) {
          kvSet('key', { salt: envs[0].salt, key: key }).catch(function () {});
          g.classList.add('hide'); $('loading').classList.remove('hide'); resolve(d);
        });
      }).catch(function () { msg.textContent = 'That passcode did not work. Check it and try again.'; inp.select(); });
    };
  });
}
function lockDevice() {
  if (!confirm('Remove the unlocked survey data from this device? Your ratings stay. You will need the passcode to open the tool again.')) return;
  tx('kv', 'readwrite', function (s) { s.delete('data'); s.delete('key'); }).then(function () { location.reload(); });
}
idb().then(function (db) {
  DB = db;
  if (!window.crypto || !crypto.subtle) throw new Error('This browser needs a secure (https) connection to unlock the tool.');
  return loadData();
}).then(function (d) {
  SV = d.sv; ST = d.st;
  SV.items.forEach(function (it) { ITEM[it.n] = it; });
  return kvGet('state').catch(function () { return null; });
}).then(function (st) {
  S = st ? migrate(st) : blank();
  $('loading').classList.add('hide');
  wire(); renderAll(); show('setup'); storageInfo();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  backupNag();
}).catch(function (err) {
  $('gate').classList.add('hide'); $('loading').classList.remove('hide');
  $('loading').innerHTML = 'The tool could not start: ' + esc(err && err.message || err) + '<br>Open it once while online to finish setting it up on this device.';
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(function (reg) {
    reg.addEventListener('updatefound', function () {
      var w = reg.installing;
      w && w.addEventListener('statechange', function () {
        if (w.state === 'installed' && navigator.serviceWorker.controller)
          banner('An updated version is ready.', 'Reload', function () { location.reload(); }, true);
      });
    });
  }).catch(function () {});
}
})();
