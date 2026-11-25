import { RESORTS } from './resorts.js';
import { toGeoJSON, pisteKey, liftKey, pisteLabel, liftLabel, DIFF_LABEL, normName } from './osm.js';
import { buildGraph, route, nearestNode, costsTo, focusModel, reachable } from './graph.js';
import * as off from './offline.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const COLORS = { blue: '#1c6fe0', red: '#e03131', black: '#1b1b1f', unknown: '#8a8f98', freeride: '#f08c00', connection: '#9aa1ab' };
const LIFT_ICON = { cable_car: '🚡', gondola: '🚠', mixed_lift: '🚠', chair_lift: '💺', magic_carpet: '➖' };
const liftIcon = (t) => LIFT_ICON[t] || '⤴️';
const today = () => new Date().toISOString().slice(0, 10);

const state = {
  resort: null,
  raw: null, // dati completi scaricati
  model: null, // dati del solo comprensorio (o tutti, se showAll)
  graph: null,
  showAll: false,
  excluded: { lifts: 0, pistes: 0 },
  from: null,
  to: null,
  maxRank: 2,
  highlight: { blue: true, red: true, black: true, other: true },
  base: 'topo',
  is3d: true,
  gps: null,
  gpsWatch: null,
  gpsMarker: null,
  picking: null, // 'from' | 'to' | 'addResort'
  manual: {}, // chiave -> 'open'|'closed' (solo per oggi)
  auto: null, // stato automatico da file
  closed: { lifts: new Set(), pistes: new Set() },
  result: null,
  markers: { from: null, to: null },
  options: [],
};

// ------------------------------------------------------------------ utilità UI
let bannerTimer;
function banner(msg, ms = 3500) {
  const b = $('#banner');
  b.textContent = msg;
  b.classList.add('show');
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
}
const hideBanner = () => $('#banner').classList.remove('show');

export function fmtTime(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
export function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}
const mapsLink = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;

function allResorts() {
  let custom = [];
  try { custom = JSON.parse(localStorage.getItem('customResorts') || '[]'); } catch { /* */ }
  return [...RESORTS, ...custom.map((r) => ({ ...r, custom: true }))];
}

// ------------------------------------------------------------------ mappa
let map;
let mapReady;

function makeStyle() {
  return {
    version: 8,
    glyphs: off.SOURCES.glyphs,
    sources: {
      topo: { type: 'raster', tiles: off.SOURCES.topo, tileSize: 256, maxzoom: 15, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' },
      sat: { type: 'raster', tiles: off.SOURCES.sat, tileSize: 256, maxzoom: 18, attribution: 'Immagini © Esri, Maxar, Earthstar Geographics' },
      dem: { type: 'raster-dem', tiles: off.SOURCES.dem, tileSize: 256, maxzoom: 14, encoding: 'terrarium', attribution: 'Rilievo: Terrain Tiles (AWS Open Data)' },
      hs: { type: 'raster-dem', tiles: off.SOURCES.dem, tileSize: 256, maxzoom: 14, encoding: 'terrarium' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#eef1ec' } },
      { id: 'topo', type: 'raster', source: 'topo', paint: { 'raster-opacity': 0.92 } },
      { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } },
      { id: 'hillshade', type: 'hillshade', source: 'hs', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#3e4652' } },
    ],
    terrain: { source: 'dem', exaggeration: 1.3 },
  };
}

const diffColor = ['match', ['get', 'diff'], 'blue', COLORS.blue, 'red', COLORS.red, 'black', COLORS.black, 'freeride', COLORS.freeride, 'connection', COLORS.connection, COLORS.unknown];
function hlOpacity(on, off_ = 0.12) {
  const h = state.highlight;
  return ['match', ['get', 'diff'], 'blue', h.blue ? on : off_, 'red', h.red ? on : off_, 'black', h.black ? on : off_, h.other ? on : off_];
}

function addSkiLayers() {
  const empty = { type: 'FeatureCollection', features: [] };
  for (const id of ['pisteAreas', 'pisteLines', 'liftLines', 'stations', 'pois', 'route']) {
    map.addSource(id, { type: 'geojson', data: empty });
  }
  const font = [off.FONT];
  map.addLayer({ id: 'piste-areas', type: 'fill', source: 'pisteAreas', paint: { 'fill-color': diffColor, 'fill-opacity': hlOpacity(0.16, 0.04) } });
  map.addLayer({
    id: 'piste-casing', type: 'line', source: 'pisteLines', filter: ['!', ['get', 'closed']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3, 15, 8], 'line-opacity': hlOpacity(0.9, 0.1) },
  });
  map.addLayer({
    id: 'piste-lines', type: 'line', source: 'pisteLines', filter: ['!', ['get', 'closed']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': diffColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.6, 15, 5], 'line-opacity': hlOpacity(1, 0.15) },
  });
  map.addLayer({
    id: 'piste-closed', type: 'line', source: 'pisteLines', filter: ['get', 'closed'],
    paint: { 'line-color': '#9aa1ab', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 15, 4], 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.8 },
  });
  map.addLayer({
    id: 'lift-lines', type: 'line', source: 'liftLines', filter: ['!', ['get', 'closed']],
    paint: { 'line-color': '#23262d', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 15, 3.2] },
  });
  map.addLayer({
    id: 'lift-closed', type: 'line', source: 'liftLines', filter: ['get', 'closed'],
    paint: { 'line-color': '#9aa1ab', 'line-width': 2.2, 'line-dasharray': [2, 1.5] },
  });
  map.addLayer({ id: 'stations', type: 'circle', source: 'stations', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 15, 5], 'circle-color': '#fff', 'circle-stroke-color': '#23262d', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 11, 'line-opacity': 0.95 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['!=', ['get', 'k'], 'walk'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#d6249f', 'line-width': 6.5 } });
  map.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'k'], 'walk'], paint: { 'line-color': '#d6249f', 'line-width': 4, 'line-dasharray': [1, 1.2] } });
  map.addLayer({
    id: 'pois-circle', type: 'circle', source: 'pois',
    paint: {
      'circle-radius': ['match', ['get', 'kind'], 'parking', 9, 'hut', 6, 4],
      'circle-color': ['match', ['get', 'kind'], 'parking', '#1d4fbf', 'hut', '#8b5a2b', '#5d6470'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'pois-parking-p', type: 'symbol', source: 'pois', filter: ['==', ['get', 'kind'], 'parking'],
    layout: { 'text-field': 'P', 'text-font': font, 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': '#fff' },
  });
  map.addLayer({
    id: 'pois-label', type: 'symbol', source: 'pois', filter: ['!=', ['get', 'kind'], 'parking'], minzoom: 13,
    layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 11.5, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': '#3a2a1a', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });
  map.addLayer({
    id: 'piste-labels', type: 'symbol', source: 'pisteLines', minzoom: 13.5, filter: ['!=', ['get', 'diff'], 'connection'],
    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 12, 'symbol-spacing': 300 },
    paint: { 'text-color': diffColor, 'text-halo-color': '#fff', 'text-halo-width': 2, 'text-opacity': hlOpacity(1, 0.2) },
  });
  map.addLayer({
    id: 'lift-labels', type: 'symbol', source: 'liftLines', minzoom: 12.5,
    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 12.5, 'symbol-spacing': 400 },
    paint: { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 2.2 },
  });
}

function refreshHighlight() {
  if (!map?.getLayer('piste-lines')) return;
  map.setPaintProperty('piste-lines', 'line-opacity', hlOpacity(1, 0.15));
  map.setPaintProperty('piste-casing', 'line-opacity', hlOpacity(0.9, 0.1));
  map.setPaintProperty('piste-areas', 'fill-opacity', hlOpacity(0.16, 0.04));
  map.setPaintProperty('piste-labels', 'text-opacity', hlOpacity(1, 0.2));
}

async function clearMapData() {
  if (!map?.getSource('pisteLines')) return;
  const empty = { type: 'FeatureCollection', features: [] };
  for (const id of ['pisteAreas', 'pisteLines', 'liftLines', 'stations', 'pois', 'route']) map.getSource(id).setData(empty);
}

async function refreshMapData() {
  await mapReady;
  if (!state.model) return;
  const gj = toGeoJSON(state.model, state.closed);
  map.getSource('pisteAreas').setData(gj.pisteAreas);
  map.getSource('pisteLines').setData(gj.pisteLines);
  map.getSource('liftLines').setData(gj.liftLines);
  map.getSource('stations').setData(gj.stations);
  map.getSource('pois').setData(gj.pois);
}

function sheetPadding() {
  const sheet = $('#sheet');
  const visible = window.innerHeight - sheet.getBoundingClientRect().top;
  return { top: 80, left: 40, right: 40, bottom: Math.min(window.innerHeight * 0.6, visible + 30) };
}

function fitCoords(coords, maxZoom = 15.5) {
  if (!coords.length) return;
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  coords.forEach((c) => b.extend(c));
  map.fitBounds(b, { padding: sheetPadding(), maxZoom, duration: 700 });
}

function initMap() {
  if (typeof maplibregl === 'undefined') {
    banner('Per il primo avvio serve internet: riapri l’app quando sei connesso.', 0);
    mapReady = new Promise(() => {}); // la mappa non arriverà: le funzioni che la aspettano restano in attesa
    return;
  }
  const last = allResorts()[0];
  map = new maplibregl.Map({
    container: 'map',
    style: makeStyle(),
    center: last.center,
    zoom: last.zoom,
    pitch: 55,
    maxPitch: 78,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  mapReady = new Promise((res) => map.on('load', () => { addSkiLayers(); res(); }));
  map.on('click', onMapClick);
  for (const l of ['piste-lines', 'lift-lines', 'pois-circle', 'piste-closed', 'lift-closed']) {
    map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('error', (e) => {
    // le tile mancanti offline non sono un problema: la mappa usa rilievo e piste salvate
    if (e?.error?.status === 404) return;
  });
}

// ------------------------------------------------------------------ comprensorio
async function selectResort(r, { fly = true } = {}) {
  state.resort = r;
  localStorage.setItem('lastResort', r.id);
  $('#resortName').textContent = r.name;
  state.from = state.to = state.result = null;
  state.model = state.graph = state.raw = null;
  state.auto = null;
  popup?.remove();
  clearMapData();
  loadManual();
  updateFields();
  clearRoute();
  renderRoute();
  if (map && fly) map.jumpTo({ center: r.center, zoom: r.zoom, pitch: state.is3d ? 55 : 0 });

  let model = await off.loadResortData(r.id);
  if (!model) {
    if (!navigator.onLine) {
      banner('Questo comprensorio non è ancora salvato: aprilo una volta con internet.', 0);
      renderAll();
      return;
    }
    model = await downloadData(r);
    if (!model) return;
  }
  setModel(model);
  loadAutoStatus();
}

async function downloadData(r) {
  banner('Scarico piste, impianti e parcheggi…', 0);
  try {
    const model = await off.downloadResortData(r);
    banner(`Fatto: ${model.lifts.length} impianti e ${countPistes(model)} piste`);
    return model;
  } catch (e) {
    console.error(e);
    banner('Download non riuscito: ' + (e.message || e), 6000);
    return null;
  }
}

function countPistes(model) {
  return new Set(model.pistes.filter((p) => !p.area && p.diff !== 'connection').map(pisteKey)).size;
}

function setModel(raw) {
  state.raw = raw;
  if (state.showAll) {
    state.model = { ...raw, parkings: raw.parkings.map((p) => ({ ...p })), huts: raw.huts.map((h) => ({ ...h })) };
    state.excluded = { lifts: 0, pistes: 0 };
  } else {
    const f = focusModel(raw, { areas: state.resort?.areas });
    state.model = f.model;
    state.excluded = f.excluded;
  }
  state.graph = buildGraph(state.model);
  if (state.from || state.to) {
    // i punti scelti si riferiscono alla rete precedente: vanno reimpostati
    state.from = state.to = state.result = null;
    updateFields();
    clearRoute();
  }
  buildOptions();
  recomputeClosed();
  refreshMapData();
  renderAll();
}

// ------------------------------------------------------------------ stato aperto/chiuso
function loadManual() {
  try {
    const s = JSON.parse(localStorage.getItem('manual:' + state.resort.id) || 'null');
    state.manual = s && s.date === today() ? s.marks : {};
  } catch {
    state.manual = {};
  }
}
function saveManual() {
  localStorage.setItem('manual:' + state.resort.id, JSON.stringify({ date: today(), marks: state.manual }));
}

async function loadAutoStatus() {
  const r = state.resort;
  if (!r.statusFile || !navigator.onLine) return renderPistes();
  try {
    const res = await fetch(r.statusFile, { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const s = await res.json();
    if (state.resort !== r) return;
    state.auto = s;
    recomputeClosed();
    refreshMapData();
    if (state.result) computeRoute();
  } catch {
    state.auto = null;
  }
  renderPistes();
}

function autoFresh() {
  return state.auto?.updated && state.auto.updated.slice(0, 10) === today();
}

function recomputeClosed() {
  const m = state.model;
  const closed = { lifts: new Set(), pistes: new Set() };
  if (!m) return (state.closed = closed);
  const auto = autoFresh() ? state.auto : null;
  const autoL = new Map(Object.entries(auto?.lifts || {}).map(([k, v]) => [normName(k), v]));
  const autoP = new Map(Object.entries(auto?.pistes || {}).map(([k, v]) => [normName(k), v]));
  for (const l of m.lifts) {
    const k = liftKey(l);
    let st = autoL.get(normName(l.name)) || autoL.get(normName(l.ref));
    if (state.manual[k]) st = state.manual[k];
    if (st === 'closed') closed.lifts.add(k);
  }
  for (const p of m.pistes) {
    const k = pisteKey(p);
    let st = (p.name && autoP.get(normName(p.name))) || (p.ref && autoP.get(normName(p.ref)));
    if (state.manual[k]) st = state.manual[k];
    if (st === 'closed') closed.pistes.add(k);
  }
  state.closed = closed;
}

function setOpen(key, open) {
  state.manual[key] = open ? 'open' : 'closed';
  saveManual();
  recomputeClosed();
  refreshMapData();
  renderPistes();
  if (state.from && state.to) computeRoute();
}

// ------------------------------------------------------------------ punti selezionabili
function pisteGroups() {
  const groups = new Map();
  state.model.pistes.forEach((p, i) => {
    if (p.area || p.diff === 'connection') return;
    const k = pisteKey(p);
    if (!groups.has(k)) groups.set(k, { key: k, label: pisteLabel(p), diff: p.diff, idx: [], length: 0 });
    const g = groups.get(k);
    g.idx.push(i);
    g.length += p.length;
  });
  for (const g of groups.values()) {
    const starts = new Set(), ends = new Set();
    g.idx.forEach((i) => {
      const p = state.model.pistes[i];
      starts.add(p.nodes[0]);
      ends.add(p.nodes[p.nodes.length - 1]);
    });
    g.start = [...starts].find((n) => !ends.has(n)) ?? [...starts][0];
    g.end = [...ends].find((n) => !starts.has(n)) ?? [...ends][0];
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'it', { numeric: true }));
}

function buildOptions() {
  const g = state.graph, m = state.model;
  const opts = [];
  const pt = (node, label, extra) => ({ node, label, lngLat: g.xy(node), ...extra });
  m.lifts.forEach((l, i) => {
    const name = liftLabel(l);
    const ic = liftIcon(l.type);
    const sub = `${l.typeLabel} · ${fmtDist(l.length)}`;
    opts.push(pt(g.idx.get(l.nodes[l.stops[0]]), `${name} — partenza`, { group: 'Impianti', ic, sub, search: name }));
    opts.push(pt(g.idx.get(l.nodes[l.stops[l.stops.length - 1]]), `${name} — arrivo`, { group: 'Impianti', ic, sub, search: name }));
  });
  for (const pg of pisteGroups()) {
    const sub = `Pista ${DIFF_LABEL[pg.diff]} · ${fmtDist(pg.length)}`;
    const dot = COLORS[pg.diff];
    opts.push(pt(g.idx.get(pg.start), `${pg.label} — inizio`, { group: 'Piste', dot, sub, search: pg.label }));
    opts.push(pt(g.idx.get(pg.end), `${pg.label} — fine`, { group: 'Piste', dot, sub, search: pg.label }));
  }
  m.huts.forEach((h, i) => {
    const n = g.hutNode.get(i);
    if (n !== undefined) opts.push(pt(n, h.name, { group: 'Rifugi e ristoranti', ic: '🏠', sub: h.kind, search: h.name }));
  });
  m.parkings.forEach((p, i) => {
    const n = g.parkingNode.get(i);
    if (n !== undefined) opts.push(pt(n, parkingName(p), { group: 'Parcheggi', ic: '🅿️', sub: parkingSub(p), search: parkingName(p) + ' ' + (p.liftName || '') }));
  });
  state.options = opts.filter((o) => o.node !== undefined && o.node !== null);
}

const parkingName = (p) => p.name || (p.liftName ? `Parcheggio ${p.liftName}` : 'Parcheggio');
function parkingSub(p) {
  const bits = [];
  if (p.liftName) bits.push(`${p.liftDist} m da ${p.liftName}`);
  if (p.capacity) bits.push(`${p.capacity} posti`);
  if (p.fee === 'yes') bits.push('a pagamento');
  else if (p.fee === 'no') bits.push('gratuito');
  return bits.join(' · ');
}

// ------------------------------------------------------------------ selettore punto
function openPicker(which) {
  if (!state.graph) return banner('Dati del comprensorio non ancora disponibili');
  $('#picker').classList.add('show');
  $('#pickerTitle').textContent = which === 'from' ? 'Da dove parti?' : 'Dove vuoi arrivare?';
  $('#picker').dataset.which = which;
  $('#pickerSearch').value = '';
  renderPicker('');
}
function closePicker() { $('#picker').classList.remove('show'); }

function renderPicker(q) {
  const which = $('#picker').dataset.which;
  const nq = normName(q);
  let html = '';
  if (!nq) {
    html += `<button class="opt" data-quick="gps"><span class="ic">📍</span><span>La mia posizione<small>Usa il GPS del telefono</small></span></button>`;
    html += `<button class="opt" data-quick="map"><span class="ic">👆</span><span>Scegli sulla mappa<small>Tocca il punto desiderato</small></span></button>`;
    if (which === 'from' && state.to) html += `<button class="opt" data-quick="bestParking"><span class="ic">🅿️</span><span>Dal parcheggio migliore<small>Quello da cui arrivi prima a destinazione</small></span></button>`;
  }
  let lastGroup = null, n = 0;
  state.options.forEach((o, i) => {
    if (nq && !normName(o.search + ' ' + o.label).includes(nq)) return;
    if (++n > 200) return;
    if (o.group !== lastGroup) {
      html += `<div class="group-title">${esc(o.group)}</div>`;
      lastGroup = o.group;
    }
    const ic = o.dot ? `<span class="ic"><span class="sw-dot" style="background:${o.dot}"></span></span>` : `<span class="ic">${o.ic}</span>`;
    html += `<button class="opt" data-opt="${i}">${ic}<span>${esc(o.label)}<small>${esc(o.sub || '')}</small></span></button>`;
  });
  if (nq && !n) html += '<p class="muted">Nessun risultato.</p>';
  $('#pickerBody').innerHTML = html;
}

async function onPickerClick(ev) {
  const b = ev.target.closest('button.opt');
  if (!b) return;
  const which = $('#picker').dataset.which;
  if (b.dataset.opt !== undefined) {
    const o = state.options[+b.dataset.opt];
    setPoint(which, { node: o.node, label: o.label, lngLat: o.lngLat });
    closePicker();
  } else if (b.dataset.quick === 'map') {
    closePicker();
    startPicking(which);
  } else if (b.dataset.quick === 'gps') {
    closePicker();
    const pos = await getGpsOnce();
    if (!pos) return;
    const node = nearestNode(state.graph, pos[0], pos[1], 400);
    if (node === null) return banner('Sei troppo lontano dalle piste di questo comprensorio');
    setPoint(which, { node, label: 'La mia posizione', lngLat: state.graph.xy(node) });
  } else if (b.dataset.quick === 'bestParking') {
    closePicker();
    const best = rankParkings()[0];
    if (!best) return banner('Nessun parcheggio collegato trovato');
    setPoint('from', { node: best.node, label: parkingName(best.p), lngLat: [best.p.lon, best.p.lat] });
  }
}

function startPicking(which) {
  state.picking = which;
  $('#pickHintText').textContent =
    which === 'addResort' ? 'Inquadra tutto il comprensorio, poi premi Conferma' : which === 'from' ? 'Tocca il punto di partenza' : 'Tocca il punto di arrivo';
  $('#pickCancel').textContent = which === 'addResort' ? 'Conferma' : 'Annulla';
  $('#pickHint').classList.add('show');
  setSheet('hidden');
}
function stopPicking() {
  state.picking = null;
  $('#pickHint').classList.remove('show');
  setSheet('peek');
}

// ------------------------------------------------------------------ pannello in basso
function sheetState() {
  const c = $('#sheet').classList;
  return c.contains('open') ? 'open' : c.contains('hidden') ? 'hidden' : 'peek';
}
function setSheet(st) {
  const c = $('#sheet').classList;
  c.toggle('open', st === 'open');
  c.toggle('hidden', st === 'hidden');
  updateMini();
  // quando il pannello si abbassa, il percorso viene reinquadrato usando tutta la mappa
  if (st !== 'open' && state.result?.geojson && map) {
    setTimeout(() => fitCoords(state.result.geojson.features.flatMap((f) => f.geometry.coordinates)), 280);
  }
}
function updateMini() {
  const r = state.result;
  let t = 'Percorso, piste e parcheggi';
  if (r?.steps && state.to) t = `⏱ ${fmtTime(r.total)} · 🚡 ${r.liftsCount} → ${state.to.label}`;
  else if (state.from || state.to) t = 'Percorso: scegli partenza e arrivo';
  $('#sheetMiniText').textContent = t;
}
function bindSheetSwipe() {
  const sheet = $('#sheet');
  let y0 = null;
  const start = (e) => {
    // il trascinamento parte solo dalla maniglia, dalle schede o dalla barra ridotta
    if (!e.target.closest('.handle, .tabs, #sheetMini')) return;
    y0 = e.touches[0].clientY;
  };
  const end = (e) => {
    if (y0 === null) return;
    const dy = e.changedTouches[0].clientY - y0;
    y0 = null;
    if (Math.abs(dy) < 40) return;
    const order = ['hidden', 'peek', 'open'];
    const i = order.indexOf(sheetState());
    setSheet(order[Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1)))]);
  };
  sheet.addEventListener('touchstart', start, { passive: true });
  sheet.addEventListener('touchend', end, { passive: true });
}

function setPoint(which, p) {
  state[which] = p;
  updateFields();
  if (state.from && state.to) computeRoute();
  else {
    clearRoute();
    renderRoute();
    if (map) map.easeTo({ center: p.lngLat, duration: 500 });
  }
  renderParkings();
}

function updateFields() {
  for (const w of ['from', 'to']) {
    const el = $(`#${w}Field .txt`);
    const p = state[w];
    el.textContent = p ? p.label : w === 'from' ? 'Da dove parti?' : 'Dove vuoi arrivare?';
    el.classList.toggle('ph', !p);
    if (map) {
      state.markers[w]?.remove();
      state.markers[w] = null;
      if (p) {
        const el2 = document.createElement('div');
        el2.className = 'pin ' + (w === 'from' ? 'a' : 'b');
        state.markers[w] = new maplibregl.Marker({ element: el2, anchor: 'bottom' }).setLngLat(p.lngLat).addTo(map);
      }
    }
  }
}

// ------------------------------------------------------------------ percorso
function routeOpts() {
  return { maxRank: state.maxRank, closedLifts: state.closed.lifts, closedPistes: state.closed.pistes };
}

function computeRoute() {
  if (!state.graph || !state.from || !state.to) return;
  if (state.from.node === state.to.node) {
    state.result = { same: true };
  } else {
    state.result = route(state.graph, state.from.node, state.to.node, routeOpts()) || {
      none: true,
      separate: !reachable(state.graph, state.from.node, state.to.node),
    };
  }
  renderRoute();
  setSheet('open');
  if (state.result.geojson) {
    mapReady.then(() => {
      map.getSource('route').setData(state.result.geojson);
      fitCoords(state.result.geojson.features.flatMap((f) => f.geometry.coordinates));
    });
  } else clearRoute();
}

function clearRoute() {
  if (map?.getSource('route')) map.getSource('route').setData({ type: 'FeatureCollection', features: [] });
}

const DIFF_NAME = { 1: 'solo piste blu', 2: 'piste blu e rosse' };

function renderRoute() {
  updateMini();
  const out = $('#routeOut');
  const r = state.result;
  if (!state.model) {
    out.innerHTML = '<p class="muted" style="margin-top:14px">Caricamento dati del comprensorio…</p>';
    return;
  }
  if (!r) {
    out.innerHTML = `<p class="muted" style="margin-top:14px">Scegli partenza e arrivo: tocca la mappa, usa la tua posizione o cerca un impianto, una pista, un rifugio o un parcheggio.</p>`;
    return;
  }
  if (r.same) {
    out.innerHTML = '<div class="warn">Partenza e arrivo coincidono.</div>';
    return;
  }
  if (r.none) {
    out.innerHTML = r.separate
      ? `<div class="err">Partenza e arrivo sono in zone non collegate sugli sci (per esempio Pian del Falco): serve spostarsi in auto o in navetta. Se invece sono collegate, nei dati di OpenStreetMap manca un tratto.</div>`
      : `<div class="err">Nessun percorso con gli impianti aperti: probabilmente un impianto necessario è segnato come chiuso.</div>`;
    return;
  }
  let html = `<button class="btn primary block" id="showOnMap">🗺️ Nascondi e guarda il percorso sulla mappa</button><div class="summary"><span>⏱ ${fmtTime(r.total)}</span><span>🚡 ${r.liftsCount} ${r.liftsCount === 1 ? 'impianto' : 'impianti'}</span><span>⛷️ ${fmtDist(r.skied)} di piste</span></div>`;
  if (r.relaxed) {
    html += `<div class="warn">Non c’è un percorso con ${DIFF_NAME[state.maxRank] || 'queste piste'}: ti mostro quello più semplice possibile. I tratti più difficili sono segnati con ⚠.</div>`;
  }
  html += '<ul class="steps">';
  r.steps.forEach((s, k) => {
    let ic, t, sub;
    if (s.type === 'lift') {
      ic = `<span class="ico lift">${liftIcon(state.model.lifts[s.i].type)}</span>`;
      t = `Prendi ${s.liftType.toLowerCase()} ${esc(s.label)}`;
      sub = `${s.rev ? 'in discesa · ' : ''}${fmtDist(s.dist)} · circa ${fmtTime(s.time)} (attesa compresa)`;
    } else if (s.type === 'piste') {
      ic = `<span class="ico ${s.diff}">⛷</span>`;
      t = s.diff === 'connection' ? `Segui il collegamento ${esc(s.label)}` : `Scendi sulla pista ${esc(s.label)}`;
      sub = `${s.diff === 'connection' ? 'collegamento' : 'pista ' + DIFF_LABEL[s.diff]} · ${fmtDist(s.dist)} · circa ${fmtTime(s.time)}`;
    } else {
      ic = '<span class="ico walk">🚶</span>';
      t = 'Spostati a piedi o con gli sci';
      sub = fmtDist(s.dist);
    }
    html += `<li data-step="${k}" class="${s.over ? 'over' : ''}">${ic}<div class="main"><div class="t">${t}</div><div class="s">${sub}</div></div></li>`;
  });
  html += `<li>${'<span class="ico" style="background:var(--route)">🏁</span>'}<div class="main"><div class="t">Arrivo: ${esc(state.to.label)}</div></div></li>`;
  html += '</ul>';
  out.innerHTML = html;
}

// ------------------------------------------------------------------ parcheggi
function rankParkings() {
  const g = state.graph, m = state.model;
  if (!g) return [];
  const list = [];
  let costs = null;
  if (state.to) costs = costsTo(g, state.to.node, routeOpts());
  m.parkings.forEach((p, i) => {
    const node = g.parkingNode.get(i);
    if (node === undefined) return;
    list.push({ p, i, node, cost: costs ? costs[node] : null });
  });
  if (costs) {
    return list.filter((x) => Number.isFinite(x.cost)).sort((a, b) => a.cost - b.cost);
  }
  return list.sort((a, b) => (a.p.liftDist ?? 9999) - (b.p.liftDist ?? 9999));
}

function renderParkings() {
  const intro = $('#parkingIntro');
  const ul = $('#parkingList');
  if (!state.model) { intro.textContent = ''; ul.innerHTML = ''; return; }
  const list = rankParkings();
  intro.innerHTML = state.to
    ? `Ordinati in base al tempo per arrivare a <b>${esc(state.to.label)}</b>.`
    : 'Parcheggi vicini agli impianti. Imposta una destinazione nel Percorso per sapere dove conviene parcheggiare.';
  if (!list.length) {
    ul.innerHTML = '<li class="muted">Nessun parcheggio trovato vicino agli impianti.</li>';
    return;
  }
  ul.innerHTML = list
    .slice(0, 40)
    .map((x, k) => {
      const t = x.cost !== null ? ` · <b>≈ ${fmtTime(x.cost)} alla meta</b>` : '';
      return `<li><span class="sw-dot" style="background:#1d4fbf"></span><div class="name">${k === 0 && x.cost !== null ? '⭐ ' : ''}${esc(parkingName(x.p))}<small>${esc(parkingSub(x.p))}${t}</small>
        <div class="row"><a class="btn small primary" href="${mapsLink(x.p.lat, x.p.lon)}" target="_blank" rel="noopener">🚗 Naviga</a>
        <button class="btn small" data-park-show="${x.i}">Mappa</button>
        <button class="btn small" data-park-from="${x.i}">Parti da qui</button></div></div></li>`;
    })
    .join('');
}

// ------------------------------------------------------------------ elenco piste/impianti
function renderPistes() {
  const si = $('#statusInfo');
  const r = state.resort;
  if (!r) return;
  let s = '';
  if (autoFresh()) {
    s = `<p class="muted" style="margin-top:12px">✅ Stato impianti aggiornato automaticamente alle ${new Date(state.auto.updated).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}.</p>`;
  } else {
    s = `<p class="muted" style="margin-top:12px">Stato in tempo reale non disponibile: se un impianto o una pista è chiuso, spegnilo qui sotto e il percorso lo eviterà (vale solo per oggi).</p>`;
  }
  if (r.statusUrl) s += `<a class="btn small" href="${r.statusUrl}" target="_blank" rel="noopener">🌐 Stato ufficiale impianti</a>`;
  if (Object.keys(state.manual).length) s += ` <button class="btn small" id="resetManual">Annulla modifiche</button>`;
  si.innerHTML = s;

  const fi = $('#focusInfo');
  const hidden = state.excluded.lifts;
  fi.innerHTML =
    state.raw && (hidden || state.showAll)
      ? `<label class="check"><input type="checkbox" id="showAll" ${state.showAll ? 'checked' : ''}> Mostra anche impianti non collegati a ${esc(r.name)}${hidden ? ` (${hidden} nascosti)` : ''}</label>`
      : '';
  const m = state.model;
  if (!m) { $('#liftList').innerHTML = ''; $('#pisteList').innerHTML = ''; return; }
  const q = normName($('#pisteSearch').value);
  const lifts = m.lifts
    .map((l) => ({ l, key: liftKey(l), label: liftLabel(l) }))
    .filter((x) => !q || normName(x.label).includes(q))
    .sort((a, b) => a.label.localeCompare(b.label, 'it', { numeric: true }));
  $('#liftList').innerHTML =
    lifts
      .map(({ l, key, label }) => {
        const open = !state.closed.lifts.has(key);
        return `<li class="${open ? '' : 'closed'}"><span style="width:22px;text-align:center">${liftIcon(l.type)}</span><div class="name">${esc(label)}<small>${esc(l.typeLabel)} · ${fmtDist(l.length)}</small></div>
        <label class="toggle"><input type="checkbox" data-key="${esc(key)}" ${open ? 'checked' : ''}><span></span></label></li>`;
      })
      .join('') || '<li class="muted">Nessun impianto</li>';
  const groups = pisteGroups().filter((g) => !q || normName(g.label).includes(q));
  $('#pisteList').innerHTML =
    groups
      .map((g) => {
        const open = !state.closed.pistes.has(g.key);
        return `<li class="${open ? '' : 'closed'}"><span class="sw-dot" style="background:${COLORS[g.diff]}"></span><div class="name">${esc(g.label)}<small>${DIFF_LABEL[g.diff]} · ${fmtDist(g.length)}</small></div>
        <label class="toggle"><input type="checkbox" data-key="${esc(g.key)}" ${open ? 'checked' : ''}><span></span></label></li>`;
      })
      .join('') || '<li class="muted">Nessuna pista</li>';
}

// ------------------------------------------------------------------ info
async function renderInfo() {
  const r = state.resort;
  const p = $('#tab-info');
  if (!r) return;
  const m = state.model;
  const offi = off.offlineInfo(r.id);
  const used = await off.storageUsed();
  p.innerHTML = `
    <h3 style="margin-top:4px">${esc(r.name)}</h3>
    ${r.subtitle ? `<p class="muted">${esc(r.subtitle)}</p>` : ''}
    ${m ? `<p class="muted">${m.lifts.length} impianti · ${countPistes(m)} piste · dati del ${new Date(m.fetchedAt).toLocaleDateString('it-IT')}</p>` : '<p class="muted">Dati non ancora scaricati.</p>'}
    <button class="btn primary block" id="dlOffline">⬇️ Salva per l’uso senza internet</button>
    <div class="progress" id="dlProgress" hidden><div></div></div>
    <p class="muted" id="dlText">${offi ? `Mappa salvata il ${new Date(offi.at).toLocaleDateString('it-IT')}${offi.failed ? ` (${offi.failed} riquadri non scaricati: riprova)` : ''}.` : 'Prima di andare in pista, premi qui con il wifi: salva piste, rilievo 3D e mappa.'}${used ? ` Spazio usato dall’app: ${(used / 1048576).toFixed(0)} MB.` : ''}</p>
    <button class="btn block" id="refreshData">🔄 Aggiorna piste e impianti</button>
    ${state.raw ? '<button class="btn block" id="exportData">📤 Esporta i dati scaricati (file .json)</button>' : ''}
    <div class="row">
      ${r.statusUrl ? `<a class="btn small" href="${r.statusUrl}" target="_blank" rel="noopener">Stato impianti</a>` : ''}
      ${r.website ? `<a class="btn small" href="${r.website}" target="_blank" rel="noopener">Sito ufficiale</a>` : ''}
      ${r.mapPdf ? `<a class="btn small" href="${r.mapPdf}" target="_blank" rel="noopener">Cartina PDF</a>` : ''}
    </div>
    <h3>Altri comprensori</h3>
    <button class="btn block" id="addResort">➕ Aggiungi un comprensorio</button>
    ${r.custom ? '<button class="btn block" id="removeResort">🗑 Rimuovi questo comprensorio</button>' : ''}
    <p class="small-print">Piste, impianti e parcheggi: © <a href="https://www.openstreetmap.org/copyright" target="_blank">contributori OpenStreetMap</a> (ODbL). Mappa: OpenTopoMap (CC-BY-SA). Rilievo: Terrain Tiles su AWS Open Data. Satellite: Esri.<br>
    I tempi sono stime. I dati possono contenere errori: segui sempre la segnaletica in pista e le indicazioni del personale.</p>`;
}

async function downloadOffline() {
  const r = state.resort;
  if (!navigator.onLine) return banner('Serve una connessione internet');
  const btn = $('#dlOffline');
  btn.disabled = true;
  const bar = $('#dlProgress');
  bar.hidden = false;
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  $('#dlText').textContent = 'Scarico piste e impianti…';
  const model = await downloadData(r);
  if (model && state.resort === r) {
    setModel(model);
    loadAutoStatus();
  }
  $('#dlText').textContent = 'Scarico rilievo 3D e mappa…';
  const res = await off.prefetchTiles(r, (d, t) => {
    bar.firstElementChild.style.width = `${Math.round((d / t) * 100)}%`;
    $('#dlText').textContent = `Scarico rilievo 3D e mappa… ${d}/${t}`;
  });
  btn.disabled = false;
  banner(res.failed ? `Salvato, ma ${res.failed} riquadri non sono stati scaricati: riprova più tardi` : 'Comprensorio salvato: funziona anche offline ✅', 5000);
  renderInfo();
}

async function exportData() {
  const r = state.resort;
  const name = `mappa-piste-${r.id}-${today()}.json`;
  const file = new File([JSON.stringify(state.raw)], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function addCustomResort() {
  const b = map.getBounds();
  const name = prompt('Nome del comprensorio?');
  if (!name) return;
  const r = {
    id: 'c' + Date.now().toString(36),
    name: name.trim(),
    bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => +v.toFixed(4)),
    center: [map.getCenter().lng, map.getCenter().lat].map((v) => +v.toFixed(4)),
    zoom: Math.round(map.getZoom() * 10) / 10,
  };
  const list = JSON.parse(localStorage.getItem('customResorts') || '[]');
  list.push(r);
  localStorage.setItem('customResorts', JSON.stringify(list));
  selectResort({ ...r, custom: true }, { fly: false });
}

function removeCustomResort() {
  const r = state.resort;
  if (!r.custom || !confirm(`Rimuovere ${r.name}?`)) return;
  const list = JSON.parse(localStorage.getItem('customResorts') || '[]').filter((x) => x.id !== r.id);
  localStorage.setItem('customResorts', JSON.stringify(list));
  off.deleteResortData(r.id);
  selectResort(allResorts()[0]);
}

function renderResortPicker() {
  $('#resortBody').innerHTML = allResorts()
    .map((r) => {
      const saved = off.offlineInfo(r.id);
      return `<button class="opt" data-resort="${esc(r.id)}"><span class="ic">🏔️</span><span>${esc(r.name)}<small>${esc(r.subtitle || (r.custom ? 'aggiunto da te' : ''))}${saved ? ' · salvato offline' : ''}</small></span></button>`;
    })
    .join('');
}

// ------------------------------------------------------------------ click sulla mappa e popup
let popup;
function onMapClick(e) {
  if (state.picking === 'from' || state.picking === 'to') {
    if (!state.graph) return;
    const node = nearestNode(state.graph, e.lngLat.lng, e.lngLat.lat, 400);
    if (node === null) return banner('Tocca più vicino a una pista o a un impianto');
    const which = state.picking;
    stopPicking();
    setPoint(which, { node, label: describeNode(node), lngLat: state.graph.xy(node) });
    return;
  }
  if (state.picking) return;
  const box = [[e.point.x - 12, e.point.y - 12], [e.point.x + 12, e.point.y + 12]];
  const layers = ['pois-circle', 'stations', 'lift-lines', 'lift-closed', 'piste-lines', 'piste-closed'].filter((l) => map.getLayer(l));
  const f = map.queryRenderedFeatures(box, { layers })[0];
  if (!f) return;
  showPopup(f, e.lngLat);
}

function describeNode(node) {
  // nome leggibile per un punto toccato: impianto o pista più vicini
  const g = state.graph;
  const c = g.xy(node);
  let best = null;
  const consider = (label, coords) => {
    for (const k of coords) {
      const d = Math.hypot(k[0] - c[0], k[1] - c[1]);
      if (!best || d < best.d) best = { d, label };
    }
  };
  state.model.lifts.forEach((l) => consider(liftLabel(l), [l.coords[0], l.coords[l.coords.length - 1]]));
  state.model.pistes.forEach((p) => !p.area && consider(`pista ${pisteLabel(p)}`, p.coords));
  return best ? `Punto vicino a ${best.label}` : 'Punto sulla mappa';
}

function showPopup(f, lngLat) {
  const m = state.model, g = state.graph;
  const p = f.properties;
  let html = '';
  const ptBtns = (node, label) =>
    node === undefined || node === null
      ? ''
      : `<div class="row"><button class="btn small" data-pt="from" data-node="${node}" data-label="${esc(label)}">Parti da qui</button><button class="btn small primary" data-pt="to" data-node="${node}" data-label="${esc(label)}">Arriva qui</button></div>`;
  if (p.kind === 'lift' || p.kind === 'station') {
    const l = m.lifts[p.i];
    const key = liftKey(l);
    const open = !state.closed.lifts.has(key);
    const name = liftLabel(l);
    const bottom = g.idx.get(l.nodes[l.stops[0]]);
    const top = g.idx.get(l.nodes[l.stops[l.stops.length - 1]]);
    html = `<div class="pop"><h4>${liftIcon(l.type)} ${esc(name)}</h4><p>${esc(l.typeLabel)}${l.occupancy ? ` ${esc(l.occupancy)} posti` : ''} · ${fmtDist(l.length)}${l.duration ? ` · ${fmtTime(l.duration)}` : ''}${open ? '' : ' · <b>chiuso</b>'}</p>
      <b style="font-size:13px">Partenza</b>${ptBtns(bottom, `${name} — partenza`)}
      <b style="font-size:13px">Arrivo</b>${ptBtns(top, `${name} — arrivo`)}
      <div class="row"><button class="btn small" data-toggle="${esc(key)}" data-open="${open ? 0 : 1}">${open ? 'Segna come chiuso' : 'Segna come aperto'}</button></div></div>`;
  } else if (p.kind === 'piste') {
    const pi = m.pistes[p.i];
    const key = pisteKey(pi);
    const open = !state.closed.pistes.has(key);
    // nodo della pista più vicino al tocco
    let best = null;
    pi.nodes.forEach((id, j) => {
      const d = Math.hypot(pi.coords[j][0] - lngLat.lng, pi.coords[j][1] - lngLat.lat);
      if (!best || d < best.d) best = { d, n: g.idx.get(id) };
    });
    const label = pisteLabel(pi);
    html = `<div class="pop"><h4><span class="sw-dot" style="display:inline-block;background:${COLORS[pi.diff]}"></span> ${esc(label)}</h4>
      <p>${pi.diff === 'connection' ? 'Collegamento' : 'Pista ' + DIFF_LABEL[pi.diff]} · tratto di ${fmtDist(pi.length)}${open ? '' : ' · <b>chiusa</b>'}</p>
      ${pi.area ? '' : ptBtns(best?.n, `Pista ${label}`)}
      <div class="row"><button class="btn small" data-toggle="${esc(key)}" data-open="${open ? 0 : 1}">${open ? 'Segna come chiusa' : 'Segna come aperta'}</button></div></div>`;
  } else if (p.kind === 'parking') {
    const pk = m.parkings[p.i];
    html = `<div class="pop"><h4>🅿️ ${esc(parkingName(pk))}</h4><p>${esc(parkingSub(pk))}</p>
      <div class="row"><a class="btn small primary" href="${mapsLink(pk.lat, pk.lon)}" target="_blank" rel="noopener">🚗 Naviga fin qui</a></div>
      ${ptBtns(g.parkingNode.get(p.i), parkingName(pk))}</div>`;
  } else if (p.kind === 'hut') {
    const h = m.huts[p.i];
    html = `<div class="pop"><h4>🏠 ${esc(h.name)}</h4><p>${esc(h.kind)}${h.ele ? ` · ${esc(h.ele)} m` : ''}</p>${ptBtns(g.hutNode.get(p.i), h.name)}</div>`;
  } else if (p.kind === 'peak') {
    const h = m.peaks[p.i];
    html = `<div class="pop"><h4>⛰️ ${esc(h.name)}</h4><p>${h.ele ? esc(h.ele) + ' m' : 'Cima'}</p></div>`;
  }
  if (!html) return;
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '290px', offset: 8 }).setLngLat(lngLat).setHTML(html).addTo(map);
}

// ------------------------------------------------------------------ GPS
function startGps() {
  if (!navigator.geolocation) return banner('GPS non disponibile');
  if (state.gpsWatch !== null) return;
  state.gpsWatch = navigator.geolocation.watchPosition(
    (pos) => {
      const first = !state.gps;
      state.gps = [pos.coords.longitude, pos.coords.latitude];
      if (!state.gpsMarker && map) {
        const el = document.createElement('div');
        el.className = 'gps-dot';
        state.gpsMarker = new maplibregl.Marker({ element: el }).setLngLat(state.gps).addTo(map);
      } else state.gpsMarker?.setLngLat(state.gps);
      if (first && map) {
        const [s, w, n, e] = state.resort.bbox;
        const [x, y] = state.gps;
        if (x >= w && x <= e && y >= s && y <= n) map.easeTo({ center: state.gps, zoom: Math.max(map.getZoom(), 14.5) });
        else banner('Sei fuori dall’area di questo comprensorio');
      }
      gpsWaiters.splice(0).forEach((f) => f(state.gps));
    },
    (err) => {
      banner(err.code === 1 ? 'Permesso di posizione negato: abilitalo nelle impostazioni del browser' : 'Posizione non disponibile');
      gpsWaiters.splice(0).forEach((f) => f(null));
      stopGps();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
  $('#btnGps').classList.add('on');
}
function stopGps() {
  if (state.gpsWatch !== null) navigator.geolocation.clearWatch(state.gpsWatch);
  state.gpsWatch = null;
  state.gps = null;
  state.gpsMarker?.remove();
  state.gpsMarker = null;
  $('#btnGps').classList.remove('on');
}
const gpsWaiters = [];
function getGpsOnce() {
  if (state.gps) return Promise.resolve(state.gps);
  banner('Cerco la tua posizione…', 0);
  startGps();
  return new Promise((res) => {
    const waiter = (p) => { hideBanner(); res(p); };
    gpsWaiters.push(waiter);
    setTimeout(() => {
      const i = gpsWaiters.indexOf(waiter);
      if (i < 0) return; // già risolto
      gpsWaiters.splice(i, 1);
      banner('Posizione non ancora trovata: riprova all’aperto');
      res(null);
    }, 20000);
  });
}

// ------------------------------------------------------------------ eventi
function renderAll() {
  renderRoute();
  renderPistes();
  renderParkings();
  renderInfo();
}

function bindEvents() {
  $('#sheetHandle').onclick = () => setSheet(sheetState() === 'open' ? 'peek' : 'open');
  $('#sheetMini').onclick = () => setSheet('open');
  $('#hideSheet').onclick = () => setSheet('hidden');
  bindSheetSwipe();
  $$('.tabs button[data-tab]').forEach((b) => {
    b.onclick = () => {
      $$('.tabs button[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
      $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
      setSheet('open');
      if (b.dataset.tab === 'info') renderInfo();
      if (b.dataset.tab === 'parking') renderParkings();
    };
  });
  $('#fromField').onclick = () => openPicker('from');
  $('#toField').onclick = () => openPicker('to');
  $('#swapBtn').onclick = () => {
    [state.from, state.to] = [state.to, state.from];
    updateFields();
    if (state.from && state.to) computeRoute();
    renderParkings();
  };
  $$('#diffSeg button').forEach((b) => {
    b.onclick = () => {
      state.maxRank = +b.dataset.max;
      localStorage.setItem('maxRank', state.maxRank);
      $$('#diffSeg button').forEach((x) => x.classList.toggle('active', x === b));
      if (state.from && state.to) computeRoute();
    };
  });
  $('#routeOut').onclick = (e) => {
    if (e.target.closest('#showOnMap')) return setSheet('hidden');
    const li = e.target.closest('li[data-step]');
    if (!li || !state.result?.steps) return;
    const s = state.result.steps[+li.dataset.step];
    setSheet('peek');
    fitCoords([s.start, s.end], 16);
  };
  $$('#legend button').forEach((b) => {
    b.onclick = () => {
      const d = b.dataset.d;
      state.highlight[d] = !state.highlight[d];
      b.classList.toggle('on', state.highlight[d]);
      refreshHighlight();
    };
  });
  $('#pisteSearch').oninput = renderPistes;
  $('#tab-pistes').addEventListener('change', (e) => {
    if (e.target.id === 'showAll') {
      state.showAll = e.target.checked;
      localStorage.setItem('showAll', state.showAll ? '1' : '');
      if (state.raw) setModel(state.raw);
      return;
    }
    const k = e.target.dataset?.key;
    if (k) setOpen(k, e.target.checked);
  });
  $('#tab-pistes').addEventListener('click', (e) => {
    if (e.target.id === 'resetManual') {
      state.manual = {};
      saveManual();
      recomputeClosed();
      refreshMapData();
      renderPistes();
      if (state.from && state.to) computeRoute();
    }
  });
  $('#tab-parking').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.parkShow !== undefined) {
      const p = state.model.parkings[+b.dataset.parkShow];
      setSheet('hidden');
      map?.flyTo({ center: [p.lon, p.lat], zoom: 16 });
    } else if (b.dataset.parkFrom !== undefined) {
      const i = +b.dataset.parkFrom;
      const p = state.model.parkings[i];
      setPoint('from', { node: state.graph.parkingNode.get(i), label: parkingName(p), lngLat: [p.lon, p.lat] });
      $('.tabs button[data-tab="route"]').click();
    }
  });
  $('#tab-info').addEventListener('click', (e) => {
    const id = e.target.closest('button')?.id;
    if (id === 'dlOffline') downloadOffline();
    if (id === 'refreshData') {
      if (!navigator.onLine) return banner('Serve una connessione internet');
      downloadData(state.resort).then((m) => m && (setModel(m), loadAutoStatus()));
    }
    if (id === 'addResort') {
      startPicking('addResort');
    }
    if (id === 'removeResort') removeCustomResort();
    if (id === 'exportData') exportData();
  });
  $('#pickCancel').onclick = () => {
    const was = state.picking;
    stopPicking();
    if (was === 'addResort') addCustomResort();
  };
  $('#pickerClose').onclick = closePicker;
  $('#pickerSearch').oninput = (e) => renderPicker(e.target.value);
  $('#pickerBody').onclick = onPickerClick;
  $('#resortBtn').onclick = () => {
    renderResortPicker();
    $('#resortPicker').classList.add('show');
  };
  $('#resortClose').onclick = () => $('#resortPicker').classList.remove('show');
  $('#resortBody').onclick = (e) => {
    const b = e.target.closest('[data-resort]');
    if (!b) return;
    $('#resortPicker').classList.remove('show');
    selectResort(allResorts().find((r) => r.id === b.dataset.resort));
  };
  $('#btn3d').onclick = () => {
    state.is3d = !state.is3d;
    $('#btn3d').classList.toggle('on', state.is3d);
    if (!map) return;
    if (state.is3d) {
      map.setTerrain({ source: 'dem', exaggeration: 1.3 });
      map.easeTo({ pitch: 55, duration: 600 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    }
  };
  $('#btnLayer').onclick = () => {
    state.base = state.base === 'topo' ? 'sat' : 'topo';
    $('#btnLayer').textContent = state.base === 'topo' ? '🛰️' : '🗺️';
    if (!map) return;
    map.setLayoutProperty('sat', 'visibility', state.base === 'sat' ? 'visible' : 'none');
    map.setLayoutProperty('topo', 'visibility', state.base === 'topo' ? 'visible' : 'none');
    if (state.base === 'sat' && !navigator.onLine) banner('Il satellite funziona solo con internet');
  };
  $('#btnGps').onclick = () => {
    if (state.gpsWatch !== null) {
      if (state.gps && map) map.easeTo({ center: state.gps, zoom: Math.max(map.getZoom(), 15) });
      else stopGps();
    } else startGps();
  };
  $('#btnGps').oncontextmenu = (e) => { e.preventDefault(); stopGps(); };
  // pulsanti dentro i popup
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.pop button');
    if (!b) return;
    if (b.dataset.pt) {
      setPoint(b.dataset.pt, { node: +b.dataset.node, label: b.dataset.label, lngLat: state.graph.xy(+b.dataset.node) });
      popup?.remove();
      $('.tabs button[data-tab="route"]').click();
    } else if (b.dataset.toggle) {
      setOpen(b.dataset.toggle, b.dataset.open === '1');
      popup?.remove();
    }
  });
  window.addEventListener('online', () => { hideBanner(); loadAutoStatus(); });
  window.addEventListener('offline', () => banner('Sei offline: uso i dati salvati sul telefono'));
}

// ------------------------------------------------------------------ avvio
function init() {
  state.showAll = localStorage.getItem('showAll') === '1';
  const mr = +localStorage.getItem('maxRank');
  if (mr >= 1 && mr <= 3) {
    state.maxRank = mr;
    $$('#diffSeg button').forEach((x) => x.classList.toggle('active', +x.dataset.max === mr));
  }
  bindEvents();
  initMap();
  const lastId = localStorage.getItem('lastResort');
  const resorts = allResorts();
  const r = resorts.find((x) => x.id === lastId) || resorts[0];
  selectResort(r);
  if (!lastId) {
    renderResortPicker();
    $('#resortPicker').classList.add('show');
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
}

init();
