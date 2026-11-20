/* Artist Hub – alle Daten bleiben lokal auf dem Gerät (localStorage). */
'use strict';

// ---------------------------------------------------------------------------
// Datenmodell
// kind "stock": Bestandswert (aktueller Stand, z. B. Follower) → Veränderung = letzter Wert − Wert zu Periodenbeginn
// kind "flow":  Tageswert (Menge an genau diesem Tag, z. B. Streams) → Periodenwert = Summe der Tage
// ---------------------------------------------------------------------------
const PLATFORMS = {
  spotify: {
    name: 'Spotify', color: '--spotify', plays: 'streams',
    metrics: {
      followers: { label: 'Follower', kind: 'stock' },
      listeners: { label: 'Hörer', kind: 'stock', hint: 'Wert so, wie S4A ihn zeigt (Tages- oder Monatshörer) – nicht mischen' },
      streams: { label: 'Streams', kind: 'flow' },
    },
  },
  soundcloud: {
    name: 'SoundCloud', color: '--soundcloud', plays: 'plays',
    metrics: {
      followers: { label: 'Follower', kind: 'stock' },
      plays: { label: 'Plays gesamt', kind: 'stock', hint: 'Gesamtzahl laut Profil/Insights' },
      likes: { label: 'Likes gesamt', kind: 'stock' },
    },
  },
  tiktok: {
    name: 'TikTok', color: '--tiktok', plays: 'views',
    metrics: {
      followers: { label: 'Follower', kind: 'stock' },
      likes: { label: 'Likes gesamt', kind: 'stock' },
      views: { label: 'Video-Aufrufe', kind: 'flow' },
    },
  },
  instagram: {
    name: 'Instagram', color: '--instagram', plays: 'views',
    metrics: {
      followers: { label: 'Follower', kind: 'stock' },
      views: { label: 'Aufrufe', kind: 'flow' },
      interactions: { label: 'Interaktionen', kind: 'flow' },
    },
  },
};
const PIDS = Object.keys(PLATFORMS);
const STORE_KEY = 'artist-hub:v1';
const PREF_KEY = 'artist-hub:prefs';

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nfFull = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const nfCompact = new Intl.NumberFormat('de-DE', { notation: 'compact', maximumFractionDigits: 1 });
const nfAxis = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const nfPct = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const fmt = (v) => (v == null || isNaN(v) ? '–' : Math.abs(v) >= 100000 ? nfCompact.format(v) : nfFull.format(v));
const fmtPct = (p) => (p == null || !isFinite(p) ? '' : `${p > 0 ? '+' : ''}${nfPct.format(p)} %`);
const sign = (v) => (v > 0 ? '+' : '');

function toISO(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const today = () => toISO(new Date());
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return toISO(new Date(y, m - 1, d + n));
}
function dayNum(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y.slice(2)}`; };
const fmtDateShort = (iso) => { const [, m, d] = iso.split('-'); return `${d}.${m}.`; };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------------------------------------------------------------------------
// Speicher
// ---------------------------------------------------------------------------
let db = { entries: {}, demo: false };
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) db = Object.assign({ entries: {}, demo: false }, JSON.parse(raw));
  } catch (e) { console.warn('Laden fehlgeschlagen', e); }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); return true; }
  catch (e) { alert('Speichern fehlgeschlagen – Speicher voll oder blockiert. Bitte Backup exportieren.'); return false; }
}
const key = (p, m, d) => `${p}|${m}|${d}`;
function setValue(p, m, d, v) { db.entries[key(p, m, d)] = v; }

let seriesCache = null;
function allSeries() {
  if (seriesCache) return seriesCache;
  const out = {};
  for (const [k, v] of Object.entries(db.entries)) {
    const [p, m, d] = k.split('|');
    ((out[p] ||= {})[m] ||= []).push({ d, v });
  }
  for (const p in out) for (const m in out[p]) out[p][m].sort((a, b) => (a.d < b.d ? -1 : 1));
  return (seriesCache = out);
}
const series = (p, m) => allSeries()[p]?.[m] || [];
function invalidate() { seriesCache = null; }

function atOrBefore(s, d) {
  let r = null;
  for (const pt of s) { if (pt.d <= d) r = pt; else break; }
  return r;
}
function lastDate(p) {
  let last = null;
  for (const m in PLATFORMS[p].metrics) { const s = series(p, m); if (s.length && (!last || s[s.length - 1].d > last)) last = s[s.length - 1].d; }
  return last;
}

// Kennzahl über den gewählten Zeitraum
function stats(p, m, range) {
  const s = series(p, m);
  const end = today();
  const start = addDays(end, -range);
  const kind = PLATFORMS[p].metrics[m].kind;
  if (!s.length) return null;
  if (kind === 'stock') {
    const last = atOrBefore(s, end);
    if (!last) return null;
    const base = atOrBefore(s, start) || s.find((pt) => pt.d > start && pt.d <= end);
    const delta = base && base.d !== last.d ? last.v - base.v : null;
    return { kind, value: last.v, delta, pct: delta != null && base.v ? (delta / base.v) * 100 : null, lastDate: last.d, baseDate: base?.d };
  }
  const prevStart = addDays(start, -range);
  let sum = 0, prev = 0, days = 0, prevDays = 0;
  for (const pt of s) {
    if (pt.d > start && pt.d <= end) { sum += pt.v; days++; }
    else if (pt.d > prevStart && pt.d <= start) { prev += pt.v; prevDays++; }
  }
  const comparable = prevDays >= range * 0.8 && days >= range * 0.8;
  return {
    kind, value: days ? sum : null, delta: comparable ? sum - prev : null,
    pct: comparable && prev ? ((sum - prev) / prev) * 100 : null, days, range, lastDate: s[s.length - 1].d,
  };
}

// Wiedergaben im Zeitraum pro Plattform (Summe bzw. Zuwachs der Gesamtzahl)
function playsInRange(p, range) {
  const m = PLATFORMS[p].plays;
  const st = stats(p, m, range);
  if (!st) return null;
  return st.kind === 'flow' ? { value: st.value, note: st.days < range ? `${st.days}/${range} Tage erfasst` : '' } : { value: st.delta, note: 'Zuwachs der Gesamt-Plays' };
}

// ---------------------------------------------------------------------------
// Charts (SVG, ohne Abhängigkeiten)
// ---------------------------------------------------------------------------
function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const step0 = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= step0);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

const tooltip = () => $('#tooltip');
function showTip(html, x, y) {
  const t = tooltip();
  t.innerHTML = html; t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  let left = x + 14, top = y - h - 12;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  if (top < 8) top = y + 14;
  t.style.left = `${Math.max(8, left)}px`; t.style.top = `${top}px`;
}
function hideTip() { tooltip().hidden = true; }

/**
 * list: [{ id, name, color, points:[{d,v}] }]
 * opts: { start, end, yFmt, tipFmt, zeroLine, labels }
 */
function lineChart(el, list, opts) {
  const W = Math.max(280, el.clientWidth || 320), H = opts.height || 200;
  const m = { t: 10, r: opts.labels ? 64 : 12, b: 24, l: 44 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const withData = list.filter((s) => s.points.length);
  if (!withData.length) {
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="nodata" x="${W / 2}" y="${H / 2}" text-anchor="middle">Keine Daten im Zeitraum</text></svg>`;
    return;
  }
  const x0 = dayNum(opts.start), x1 = dayNum(opts.end);
  const vals = withData.flatMap((s) => s.points.map((p) => p.v));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (opts.zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const ticks = niceTicks(lo, hi);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const X = (d) => m.l + ((dayNum(d) - x0) / Math.max(1, x1 - x0)) * iw;
  const Y = (v) => m.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
  const yFmt = opts.yFmt || fmt;

  const xTicks = [];
  const n = 4;
  for (let i = 0; i <= n; i++) xTicks.push(addDays(opts.start, Math.round(((x1 - x0) * i) / n)));

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria || 'Diagramm')}">`;
  svg += `<g class="grid">${ticks.map((t) => `<line x1="${m.l}" x2="${m.l + iw}" y1="${Y(t)}" y2="${Y(t)}"/>`).join('')}</g>`;
  if (opts.zeroLine && y0 < 0) svg += `<line class="zero" x1="${m.l}" x2="${m.l + iw}" y1="${Y(0)}" y2="${Y(0)}"/>`;
  svg += `<g class="axis">${ticks.map((t) => `<text x="${m.l - 6}" y="${Y(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`).join('')}`;
  svg += xTicks.map((d, i) => `<text x="${X(d)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n ? 'end' : 'middle'}">${fmtDateShort(d)}</text>`).join('') + '</g>';

  // Linien; Lücken > 7 Tage werden nicht verbunden
  for (const s of withData) {
    let path = '', prev = null;
    for (const p of s.points) {
      const cmd = !prev || dayNum(p.d) - dayNum(prev.d) > 7 ? 'M' : 'L';
      path += `${cmd}${X(p.d).toFixed(1)},${Y(p.v).toFixed(1)}`;
      prev = p;
    }
    svg += `<path class="series" d="${path}" stroke="${s.color}"/>`;
    if (s.points.length === 1) svg += `<circle cx="${X(s.points[0].d)}" cy="${Y(s.points[0].v)}" r="4" fill="${s.color}"/>`;
  }

  // Direkte Beschriftung am Linienende (Kollisionen vermeiden)
  if (opts.labels) {
    const lbls = withData.map((s) => { const p = s.points[s.points.length - 1]; return { s, x: X(p.d), y: Y(p.v) }; }).sort((a, b) => a.y - b.y);
    for (let i = 1; i < lbls.length; i++) if (lbls[i].y - lbls[i - 1].y < 13) lbls[i].y = lbls[i - 1].y + 13;
    svg += lbls.map((l) => `<text class="label" x="${l.x + 6}" y="${l.y + 4}">${esc(l.s.name)}</text>`).join('');
  }

  svg += `<g class="hover" visibility="hidden"><line class="crosshair" y1="${m.t}" y2="${m.t + ih}"/>${withData.map((s) => `<circle r="5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join('')}</g>`;
  svg += `<rect x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent" class="hit"/></svg>`;
  el.innerHTML = svg;

  const root = $('svg', el), hover = $('.hover', root), cross = $('.crosshair', hover), dots = $$('circle', hover);
  const tipFmt = opts.tipFmt || fmt;
  function onMove(ev) {
    const r = root.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const day = x0 + Math.round(((px - m.l) / iw) * (x1 - x0));
    let rows = '', anyDate = null;
    withData.forEach((s, i) => {
      let best = null;
      for (const p of s.points) if (!best || Math.abs(dayNum(p.d) - day) < Math.abs(dayNum(best.d) - day)) best = p;
      if (best && Math.abs(dayNum(best.d) - day) <= 3) {
        dots[i].setAttribute('cx', X(best.d)); dots[i].setAttribute('cy', Y(best.v)); dots[i].style.display = '';
        rows += `<div class="r"><span><span class="dot" style="background:${s.color};display:inline-block"></span> ${esc(s.name)}</span><b>${esc(tipFmt(best.v))}</b></div>`;
        anyDate = anyDate || best.d;
      } else dots[i].style.display = 'none';
    });
    if (!rows) { hover.setAttribute('visibility', 'hidden'); hideTip(); return; }
    const cx = X(anyDate);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
    hover.setAttribute('visibility', 'visible');
    showTip(`<div class="t">${fmtDate(anyDate)}</div>${rows}`, ev.clientX, ev.clientY);
  }
  function onLeave() { hover.setAttribute('visibility', 'hidden'); hideTip(); }
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerdown', onMove);
  root.addEventListener('pointerleave', onLeave);
  root.addEventListener('pointercancel', onLeave);
}

function sparkline(points, color, start, end) {
  if (points.length < 2) return '<svg viewBox="0 0 100 36"></svg>';
  const x0 = dayNum(start), x1 = dayNum(end);
  const vs = points.map((p) => p.v), lo = Math.min(...vs), hi = Math.max(...vs);
  const X = (d) => ((dayNum(d) - x0) / Math.max(1, x1 - x0)) * 100;
  const Y = (v) => 33 - ((v - lo) / (hi - lo || 1)) * 30;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.d).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  return `<svg viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

// ---------------------------------------------------------------------------
// UI-Zustand
// ---------------------------------------------------------------------------
let prefs = { range: 28, view: 'overview', platform: 'spotify' };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) { /* egal */ }
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* egal */ } };
const pColor = (p) => cssVar(PLATFORMS[p].color);

function deltaHTML(delta, pct) {
  if (delta == null) return '<span class="meta">kein Vergleichswert</span>';
  const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
  return `<span class="${cls}">${sign(delta)}${fmt(delta)}${pct != null ? ` (${fmtPct(pct)})` : ''}</span>`;
}

// ---------------------------------------------------------------------------
// Übersicht
// ---------------------------------------------------------------------------
function renderOverview() {
  const range = prefs.range, end = today(), start = addDays(end, -range);
  const hasData = Object.keys(db.entries).length > 0;
  $('#empty-state').hidden = hasData;
  $('#overview-content').hidden = !hasData;
  if (!hasData) return;

  // Hero
  let total = 0, totalBase = 0, deltaSum = 0, complete = true, any = false;
  for (const p of PIDS) {
    const st = stats(p, 'followers', range);
    if (!st) continue;
    any = true; total += st.value;
    if (st.delta == null) complete = false; else { deltaSum += st.delta; totalBase += st.value - st.delta; }
  }
  $('#hero-followers').textContent = any ? nfFull.format(total) : '–';
  $('#hero-delta').innerHTML = any
    ? `${deltaHTML(deltaSum, totalBase ? (deltaSum / totalBase) * 100 : null)} in ${range} Tagen${complete ? '' : ' <span class="meta">(nicht alle Plattformen vergleichbar)</span>'}`
    : '';
  if (db.demo) $('#hero-delta').innerHTML += '<div class="meta" style="margin-top:6px">Demo-Daten aktiv – unter „Daten“ löschen.</div>';

  // Kacheln
  $('#platform-tiles').innerHTML = PIDS.map((p) => {
    const st = stats(p, 'followers', range);
    const last = lastDate(p);
    const age = last ? dayNum(end) - dayNum(last) : null;
    const pts = series(p, 'followers').filter((pt) => pt.d >= start && pt.d <= end);
    return `<button class="tile" data-platform="${p}">
      <div class="name"><span class="dot" style="background:${pColor(p)}"></span>${PLATFORMS[p].name}</div>
      <div class="val">${st ? fmt(st.value) : '–'}</div>
      <div class="meta">${st ? deltaHTML(st.delta, st.pct) : 'keine Follower-Daten'}</div>
      ${sparkline(pts, pColor(p), start, end)}
      <div class="meta ${age > 7 ? 'stale' : ''}">${last ? (age === 0 ? 'heute aktualisiert' : `vor ${age} T aktualisiert`) : 'noch nie aktualisiert'}</div>
    </button>`;
  }).join('');

  // Wachstum indexiert
  const growth = PIDS.map((p) => {
    const s = series(p, 'followers');
    const base = atOrBefore(s, start) || s.find((pt) => pt.d > start && pt.d <= end);
    if (!base || !base.v) return { id: p, name: PLATFORMS[p].name, color: pColor(p), points: [] };
    const pts = s.filter((pt) => pt.d > start && pt.d <= end);
    if (base.d <= start) pts.unshift({ d: start, v: base.v });
    return { id: p, name: PLATFORMS[p].name, color: pColor(p), points: pts.map((pt) => ({ d: pt.d, v: (pt.v / base.v - 1) * 100 })) };
  });
  lineChart($('#chart-growth'), growth, {
    start, end, labels: true, zeroLine: true, aria: 'Follower-Wachstum in Prozent je Plattform',
    yFmt: (v) => `${sign(v)}${nfAxis.format(v)} %`, tipFmt: (v) => fmtPct(v),
  });
  $('#legend-growth').innerHTML = growth.filter((g) => g.points.length)
    .map((g) => `<span><span class="dot" style="background:${g.color}"></span>${g.name}</span>`).join('');

  // Wiedergaben
  const plays = PIDS.map((p) => ({ p, ...(playsInRange(p, range) || { value: null, note: 'keine Daten' }) }));
  const maxPlays = Math.max(1, ...plays.map((x) => x.value || 0));
  $('#plays-bars').innerHTML = `<div class="bars">${plays.map((x) => `
    <div class="bar-row">
      <span class="lbl"><span class="dot" style="background:${pColor(x.p)}"></span>${PLATFORMS[x.p].name}</span>
      <div class="track"><div class="fill" style="width:${x.value > 0 ? Math.max(1, (x.value / maxPlays) * 100) : 0}%;background:${pColor(x.p)}"></div></div>
      <span class="num">${fmt(x.value)}</span>
    </div>
    ${x.note ? `<div class="meta" style="margin:-6px 0 0 120px;font-size:11px">${esc(x.note)}</div>` : ''}`).join('')}</div>`;

  $('#insights').innerHTML = buildInsights(range).map((t) => `<li>${t}</li>`).join('') || '<li>Zu wenig Daten für Auswertungen.</li>';
}

function buildInsights(range) {
  const out = [], end = today();
  const growth = PIDS.map((p) => ({ p, st: stats(p, 'followers', range) })).filter((x) => x.st && x.st.pct != null);
  if (growth.length >= 2) {
    growth.sort((a, b) => b.st.pct - a.st.pct);
    const best = growth[0], worst = growth[growth.length - 1];
    out.push(`Stärkstes Follower-Wachstum: <b>${PLATFORMS[best.p].name}</b> ${fmtPct(best.st.pct)} (${sign(best.st.delta)}${fmt(best.st.delta)}).`);
    if (worst.st.pct < best.st.pct) out.push(`Schwächstes: <b>${PLATFORMS[worst.p].name}</b> ${fmtPct(worst.st.pct)}.`);
  }
  for (const p of PIDS) {
    for (const [m, def] of Object.entries(PLATFORMS[p].metrics)) {
      if (def.kind !== 'flow') continue;
      const st = stats(p, m, range);
      if (!st || st.value == null) continue;
      if (st.pct != null && Math.abs(st.pct) >= 15) {
        out.push(`<b>${PLATFORMS[p].name} ${def.label}</b> ${st.pct > 0 ? 'steigen' : 'fallen'} um ${fmtPct(Math.abs(st.pct)).replace('+', '')} ggü. den ${range} Tagen davor.`);
      }
      if (st.days < range * 0.8) out.push(`${PLATFORMS[p].name} ${def.label}: nur ${st.days} von ${range} Tagen erfasst – Summe ist zu niedrig.`);
    }
    // Engagement-Rate Instagram: Interaktionen / Aufrufe
    if (p === 'instagram') {
      const i = stats(p, 'interactions', range), v = stats(p, 'views', range);
      if (i?.value && v?.value) out.push(`Instagram: ${nfPct.format((i.value / v.value) * 100)} Interaktionen pro 100 Aufrufe.`);
    }
    const last = lastDate(p);
    if (!last) out.push(`Für <b>${PLATFORMS[p].name}</b> gibt es noch keine Daten.`);
    else if (dayNum(end) - dayNum(last) > 7) out.push(`<b>${PLATFORMS[p].name}</b> ist seit ${dayNum(end) - dayNum(last)} Tagen nicht aktualisiert.`);
  }
  // Streams pro Hörer (Spotify)
  const str = stats('spotify', 'streams', range), lis = stats('spotify', 'listeners', range);
  if (str?.value && lis?.value) out.push(`Spotify: ca. ${nfPct.format(str.value / range / lis.value)} Streams pro Hörer und Tag (grob, hängt von der Hörer-Definition ab).`);
  return out;
}

// ---------------------------------------------------------------------------
// Plattform-Detail
// ---------------------------------------------------------------------------
function renderPlatforms() {
  $('#platform-switch').innerHTML = PIDS.map((p) => `<button role="tab" aria-selected="${p === prefs.platform}" class="${p === prefs.platform ? 'active' : ''}" data-p="${p}"><span class="dot" style="background:${pColor(p)}"></span>${PLATFORMS[p].name}</button>`).join('');
  const p = prefs.platform, P = PLATFORMS[p], range = prefs.range, end = today(), start = addDays(end, -range);
  const metrics = Object.entries(P.metrics);
  let html = `<div class="kpis">${metrics.map(([m, def]) => {
    const st = stats(p, m, range);
    const label = def.kind === 'flow' ? `${def.label} (${range} T)` : def.label;
    return `<div class="kpi"><div class="k">${esc(label)}</div><div class="v">${st ? fmt(st.value) : '–'}</div><div class="d">${st ? deltaHTML(st.delta, st.pct) : '<span class="meta">keine Daten</span>'}</div></div>`;
  }).join('')}</div>`;
  html += metrics.map(([m, def]) => `<div class="card"><h2>${esc(def.label)}</h2><p class="sub">${def.kind === 'flow' ? 'Tageswerte' : 'Bestand im Zeitverlauf'}${def.hint ? ' · ' + esc(def.hint) : ''}</p><div class="chart" data-m="${m}"></div></div>`).join('');
  const last = lastDate(p);
  html += `<p class="sub" style="text-align:center">${last ? `Letzter Eintrag: ${fmtDate(last)}` : 'Noch keine Daten.'} <a href="#" data-goto="data" style="color:var(--accent)">Werte eintragen</a></p>`;
  $('#platform-detail').innerHTML = html;
  for (const [m, def] of metrics) {
    const pts = series(p, m).filter((pt) => pt.d >= start && pt.d <= end);
    lineChart($(`.chart[data-m="${m}"]`, $('#platform-detail')), [{ id: m, name: def.label, color: pColor(p), points: pts }], { start, end, height: 170, aria: `${P.name} ${def.label}` });
  }
}

// ---------------------------------------------------------------------------
// Daten: Eingabe, Tabelle, CSV, Backup
// ---------------------------------------------------------------------------
function fillPlatformSelect(sel, value) {
  sel.innerHTML = PIDS.map((p) => `<option value="${p}" ${p === value ? 'selected' : ''}>${PLATFORMS[p].name}</option>`).join('');
}

function renderEntryFields() {
  const p = $('#entry-platform').value, d = $('#entry-date').value || today();
  $('#entry-fields').innerHTML = Object.entries(PLATFORMS[p].metrics).map(([m, def]) => {
    const cur = db.entries[key(p, m, d)];
    const prev = atOrBefore(series(p, m), addDays(d, -1));
    const ph = def.kind === 'stock' && prev ? `zuletzt ${nfFull.format(prev.v)}` : def.kind === 'flow' ? 'an diesem Tag' : '';
    return `<label class="field">${esc(def.label)} <small>${def.kind === 'stock' ? 'Bestand' : 'Tageswert'}</small>
      <input type="text" inputmode="numeric" name="${m}" value="${cur != null ? cur : ''}" placeholder="${esc(ph)}"></label>`;
  }).join('');
}

function renderTable() {
  const p = $('#table-platform').value, metrics = Object.entries(PLATFORMS[p].metrics);
  const dates = new Set();
  for (const [m] of metrics) series(p, m).forEach((pt) => dates.add(pt.d));
  const rows = [...dates].sort().reverse();
  if (!rows.length) { $('#data-table').innerHTML = '<p class="sub">Keine Werte gespeichert.</p>'; return; }
  $('#data-table').innerHTML = `<table><thead><tr><th>Datum</th>${metrics.map(([, d]) => `<th>${esc(d.label)}</th>`).join('')}<th></th></tr></thead><tbody>${
    rows.map((d) => `<tr><td>${fmtDate(d)}</td>${metrics.map(([m]) => { const v = db.entries[key(p, m, d)]; return `<td>${v != null ? nfFull.format(v) : ''}</td>`; }).join('')}<td><button data-del="${d}" aria-label="Zeile ${fmtDate(d)} löschen">✕</button></td></tr>`).join('')
  }</tbody></table>`;
}

function parseNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/\s| |'/g, '');
  if (!s || s === '-') return null;
  let mult = 1;
  const suf = s.match(/^(.*?)(k|m|mio\.?|tsd\.?)$/i);
  if (suf) { s = suf[1]; mult = /^k|^tsd/i.test(suf[2]) ? 1e3 : 1e6; }
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(s) && mult === 1) s = s.replace(/[.,]/g, '');
  else if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+\.\d+$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const v = Number(s) * mult;
  return isFinite(v) ? Math.round(v) : null;
}

function parseDate(raw) {
  const s = String(raw || '').trim().replace(/^"|"$/g, '');
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return toISO(new Date(+m[1], m[2] - 1, +m[3]));
  if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/))) return toISO(new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], m[2] - 1, +m[1]));
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) {
    let a = +m[1], b = +m[2]; const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (a > 12) [a, b] = [b, a]; // DD/MM
    return toISO(new Date(y, a - 1, b));
  }
  if (/[a-z]/i.test(s)) { const t = Date.parse(s); if (!isNaN(t)) return toISO(new Date(t)); }
  return null;
}

function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some((x) => x.trim())) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const SYNONYMS = {
  followers: /follower|abonnent|fans/i,
  listeners: /listener|hörer|hoerer/i,
  streams: /stream/i,
  plays: /play|wiedergabe/i,
  views: /view|aufruf/i,
  likes: /like|gefällt/i,
  interactions: /interaction|interaktion|engagement/i,
};

let csvState = null;
function handleCSV(text) {
  const p = $('#csv-platform').value;
  const rows = parseCSV(text);
  if (rows.length < 2) { $('#csv-mapping').innerHTML = '<p class="sub">Datei enthält keine Datenzeilen.</p>'; return; }
  // Kopfzeile: erste Zeile, deren nächste Zeile ein Datum enthält
  let h = 0;
  for (let i = 0; i < Math.min(rows.length - 1, 10); i++) if (rows[i + 1].some((c) => parseDate(c))) { h = i; break; }
  const header = rows[h], body = rows.slice(h + 1);
  const dateCol = header.findIndex((_, ci) => body.slice(0, 20).filter((r) => parseDate(r[ci])).length >= Math.min(body.length, 20) * 0.8);
  if (dateCol < 0) { $('#csv-mapping').innerHTML = '<p class="sub">Keine Datumsspalte gefunden.</p>'; return; }
  const metrics = PLATFORMS[p].metrics;
  const used = new Set();
  const guesses = header.map((name, ci) => {
    if (ci === dateCol) return '';
    if (/diff|change|veränder|net|gain|zuwachs|rate|%/i.test(name)) return '';
    const m = Object.keys(metrics).find((mm) => !used.has(mm) && SYNONYMS[mm]?.test(name));
    if (m) used.add(m);
    return m || '';
  });
  csvState = { p, header, body, dateCol };
  const opts = (sel) => `<option value="">— ignorieren —</option>${Object.entries(metrics).map(([m, d]) => `<option value="${m}" ${m === sel ? 'selected' : ''}>${esc(d.label)} (${d.kind === 'stock' ? 'Bestand' : 'Tageswert'})</option>`).join('')}`;
  $('#csv-mapping').innerHTML = `<p class="sub">${body.length} Zeilen · Datum aus Spalte „${esc(header[dateCol])}“. Prüfe: Follower-Spalten müssen Gesamtstand sein, nicht Tageszuwachs.</p>
    ${header.map((name, ci) => ci === dateCol ? '' : `<div class="map-row"><code title="${esc(name)}">${esc(name || `Spalte ${ci + 1}`)}</code><select data-col="${ci}">${opts(guesses[ci])}</select></div>`).join('')}
    <div class="row" style="margin-top:10px"><button class="btn primary" id="btn-csv-import">Importieren</button><span class="status" id="csv-status"></span></div>`;
}

function importCSV() {
  if (!csvState) return;
  const { p, body, dateCol } = csvState;
  const maps = $$('#csv-mapping select').map((s) => [+s.dataset.col, s.value]).filter(([, m]) => m);
  if (!maps.length) { $('#csv-status').textContent = 'Keine Spalte zugeordnet.'; return; }
  let n = 0;
  for (const r of body) {
    const d = parseDate(r[dateCol]);
    if (!d) continue;
    for (const [ci, m] of maps) { const v = parseNumber(r[ci]); if (v != null) { setValue(p, m, d, v); n++; } }
  }
  if (db.demo) { /* echte Daten zusätzlich zu Demo-Daten → Hinweis bleibt */ }
  invalidate(); save(); renderAll();
  $('#csv-status').textContent = `${n} Werte importiert.`;
}

function makeDemo() {
  const end = today(), days = 180;
  const rnd = (() => { let s = 42; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const cfg = {
    spotify: { followers: [420, 1.2], listeners: [900, 0], streams: [260, 0] },
    soundcloud: { followers: [1350, 0.9], plays: [48000, 0], likes: [2100, 0] },
    tiktok: { followers: [3100, 6], likes: [41000, 0], views: [2200, 0] },
    instagram: { followers: [1800, 1.5], views: [900, 0], interactions: [70, 0] },
  };
  for (const p of PIDS) {
    const c = cfg[p];
    let fol = c.followers[0], tot = { ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v[0]])) };
    for (let i = days; i >= 0; i--) {
      const d = addDays(end, -i);
      const wave = 1 + 0.35 * Math.sin(i / 9) + (rnd() - 0.5) * 0.5 + (i < 30 ? 0.4 : 0);
      fol += Math.max(-3, Math.round(c.followers[1] * wave + (rnd() - 0.45) * 3));
      setValue(p, 'followers', d, fol);
      for (const [m, def] of Object.entries(PLATFORMS[p].metrics)) {
        if (m === 'followers') continue;
        if (def.kind === 'flow') setValue(p, m, d, Math.max(0, Math.round(c[m][0] * wave)));
        else { tot[m] += Math.max(0, Math.round((c[m][0] / 400) * wave)); setValue(p, m, d, m === 'listeners' ? Math.round(c[m][0] * wave) : tot[m]); }
      }
    }
  }
  db.demo = true;
  invalidate(); save(); renderAll();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Navigation & Events
// ---------------------------------------------------------------------------
function showView(v) {
  prefs.view = v; savePrefs();
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${v}`));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  hideTip();
  renderAll();
  window.scrollTo(0, 0);
}

function renderAll() {
  $$('.range button').forEach((b) => b.classList.toggle('active', +b.dataset.range === prefs.range));
  if (prefs.view === 'overview') renderOverview();
  if (prefs.view === 'platforms') renderPlatforms();
  if (prefs.view === 'data') { renderEntryFields(); renderTable(); }
}

function init() {
  load();
  $('#entry-date').value = today();
  fillPlatformSelect($('#entry-platform'), prefs.platform);
  fillPlatformSelect($('#csv-platform'), 'spotify');
  fillPlatformSelect($('#table-platform'), prefs.platform);

  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $$('.range button').forEach((b) => b.addEventListener('click', () => { prefs.range = +b.dataset.range; savePrefs(); renderAll(); }));
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) { e.preventDefault(); showView(g.dataset.goto); }
    const t = e.target.closest('.tile');
    if (t) { prefs.platform = t.dataset.platform; showView('platforms'); }
    const sw = e.target.closest('#platform-switch button');
    if (sw) { prefs.platform = sw.dataset.p; savePrefs(); renderPlatforms(); }
    const del = e.target.closest('[data-del]');
    if (del) {
      const p = $('#table-platform').value, d = del.dataset.del;
      if (confirm(`Alle ${PLATFORMS[p].name}-Werte vom ${fmtDate(d)} löschen?`)) {
        for (const m in PLATFORMS[p].metrics) delete db.entries[key(p, m, d)];
        invalidate(); save(); renderTable();
      }
    }
    if (e.target.id === 'btn-csv-import') importCSV();
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.chart')) hideTip(); });

  $('#btn-demo').addEventListener('click', makeDemo);
  $('#entry-platform').addEventListener('change', renderEntryFields);
  $('#entry-date').addEventListener('change', renderEntryFields);
  $('#table-platform').addEventListener('change', renderTable);
  $('#entry-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = $('#entry-platform').value, d = $('#entry-date').value;
    if (!d) return;
    let n = 0, bad = [];
    for (const input of $$('#entry-fields input')) {
      if (!input.value.trim()) continue;
      const v = parseNumber(input.value);
      if (v == null) { bad.push(PLATFORMS[p].metrics[input.name].label); continue; }
      setValue(p, input.name, d, v); n++;
    }
    invalidate(); save();
    $('#entry-status').textContent = bad.length ? `Ungültig: ${bad.join(', ')}` : n ? `${n} Werte gespeichert.` : 'Nichts eingetragen.';
    $('#table-platform').value = p;
    renderEntryFields(); renderTable();
  });

  $('#csv-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    handleCSV(await f.text());
  });
  $('#csv-platform').addEventListener('change', async () => {
    const f = $('#csv-file').files[0]; if (f) handleCSV(await f.text());
  });

  $('#btn-export').addEventListener('click', () => {
    download(`artist-hub-backup-${today()}.json`, JSON.stringify({ app: 'artist-hub', version: 1, exported: new Date().toISOString(), ...db }, null, 1), 'application/json');
    $('#backup-status').textContent = 'Backup erstellt.';
  });
  $('#backup-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data.entries || typeof data.entries !== 'object') throw new Error('Kein gültiges Backup');
      let n = 0;
      for (const [k, v] of Object.entries(data.entries)) {
        const [p, m, d] = k.split('|');
        if (PLATFORMS[p]?.metrics[m] && /^\d{4}-\d{2}-\d{2}$/.test(d) && typeof v === 'number') { db.entries[k] = v; n++; }
      }
      invalidate(); save(); renderAll();
      $('#backup-status').textContent = `${n} Werte wiederhergestellt.`;
    } catch (err) { $('#backup-status').textContent = `Fehler: ${err.message}`; }
    e.target.value = '';
  });
  $('#btn-clear').addEventListener('click', () => {
    if (!confirm('Wirklich ALLE Daten löschen? Das kann nicht rückgängig gemacht werden.')) return;
    db = { entries: {}, demo: false }; invalidate(); save(); renderAll();
    $('#backup-status').textContent = 'Alle Daten gelöscht.';
  });

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderAll, 150); });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', renderAll);

  showView(prefs.view);

  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
