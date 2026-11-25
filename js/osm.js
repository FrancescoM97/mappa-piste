// Scarica e interpreta i dati di OpenStreetMap (piste, impianti, parcheggi, rifugi)
import { lineLength } from './geo.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export function buildQuery(bbox) {
  const b = bbox.join(',');
  return `[out:json][timeout:120];
(
  way["piste:type"~"^(downhill|connection)$"](${b});
  way["aerialway"](${b});
  node["aerialway"="station"](${b});
  nwr["amenity"="parking"](${b});
  nwr["amenity"~"^(restaurant|cafe|bar|fast_food)$"](${b});
  nwr["tourism"~"^(alpine_hut|wilderness_hut)$"](${b});
  node["natural"="peak"]["name"](${b});
)->.a;
relation["piste:type"="downhill"](${b})->.r;
way(r.r)->.rw;
(.a; .r; .rw;);
out body geom;`;
}

/** Scarica i dati grezzi da Overpass provando più server. */
export async function fetchOverpass(bbox, { signal } = {}) {
  const q = buildQuery(bbox);
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    // ogni server ha al massimo 2 minuti, poi si passa al successivo
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
      const json = await res.json();
      parseOverpass(json); // verifica che la risposta sia completa prima di accettarla
      return json;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr || new Error('Overpass non raggiungibile');
}

// ---- Classificazione ----

/** Difficoltà OSM -> categoria colore usata in Italia. */
export function diffCategory(tag) {
  switch ((tag || '').toLowerCase()) {
    case 'novice':
    case 'easy':
      return 'blue';
    case 'intermediate':
      return 'red';
    case 'advanced':
    case 'expert':
      return 'black';
    case 'freeride':
    case 'extreme':
      return 'freeride';
    default:
      return 'unknown';
  }
}

export const DIFF_RANK = { blue: 1, red: 2, unknown: 2, black: 3, freeride: 9, connection: 0 };
export const DIFF_LABEL = {
  blue: 'blu',
  red: 'rossa',
  black: 'nera',
  freeride: 'freeride',
  unknown: 'difficoltà n.d.',
  connection: 'collegamento',
};

export const LIFT_TYPES = {
  cable_car: { label: 'Funivia', speed: 8, wait: 240, bidir: true },
  gondola: { label: 'Cabinovia', speed: 5, wait: 90, bidir: true },
  mixed_lift: { label: 'Impianto misto', speed: 5, wait: 90, bidir: true },
  chair_lift: { label: 'Seggiovia', speed: 2.3, wait: 90, bidir: false },
  drag_lift: { label: 'Skilift', speed: 3, wait: 60, bidir: false },
  't-bar': { label: 'Skilift', speed: 3, wait: 60, bidir: false },
  'j-bar': { label: 'Skilift', speed: 3, wait: 60, bidir: false },
  platter: { label: 'Skilift', speed: 3, wait: 60, bidir: false },
  rope_tow: { label: 'Manovia', speed: 2, wait: 30, bidir: false },
  magic_carpet: { label: 'Tapis roulant', speed: 0.8, wait: 30, bidir: false },
};

function parseDuration(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  v = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v) * 60; // minuti
  const m = v.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) {
    // "mm:ss" oppure "hh:mm:ss"
    return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  }
  return null;
}

// ---- Validazione: i dati arrivano da server esterni, quindi non ci si fida di nulla ----
const validLon = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
const validLat = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const validPt = (g) => !!g && typeof g === 'object' && validLon(g.lon) && validLat(g.lat);
/** Testo pulito e di lunghezza limitata, oppure null. */
const str = (v, max = 100) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const validId = (v) => (typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && v.length < 40);
const tagsOf = (el) => (el.tags && typeof el.tags === 'object' && !Array.isArray(el.tags) ? el.tags : {});

function centerOf(el) {
  if (el.type === 'node') return validPt(el) ? [el.lon, el.lat] : null;
  if (validPt(el.center)) return [el.center.lon, el.center.lat];
  const b = el.bounds;
  if (b && validLon(b.minlon) && validLon(b.maxlon) && validLat(b.minlat) && validLat(b.maxlat)) {
    return [(b.minlon + b.maxlon) / 2, (b.minlat + b.maxlat) / 2];
  }
  if (Array.isArray(el.geometry)) {
    let x = 0, y = 0, n = 0;
    for (const g of el.geometry) if (validPt(g)) { x += g.lon; y += g.lat; n++; }
    return n ? [x / n, y / n] : null;
  }
  return null;
}

/**
 * Converte la risposta Overpass nel modello dell'app:
 * { pistes, lifts, parkings, huts, peaks, fetchedAt }
 */
export function parseOverpass(json) {
  // Overpass in caso di timeout risponde 200 con dati parziali e un "remark": meglio fermarsi
  if (json && typeof json.remark === 'string' && /runtime error|timed out|out of memory/i.test(json.remark)) {
    throw new Error('Risposta incompleta dal server delle mappe: riprova tra poco');
  }
  const els = Array.isArray(json?.elements) ? json.elements.filter((e) => e && typeof e === 'object' && validId(e.id)) : [];
  const ways = new Map();
  const stationNodes = new Set();
  const relations = [];
  const parkings = [], huts = [], peaks = [];

  for (const el of els) {
    const t = tagsOf(el);
    if (el.type === 'way') ways.set(el.id, el);
    else if (el.type === 'relation' && t['piste:type'] === 'downhill') relations.push(el);
    if (el.type === 'node' && t.aerialway === 'station') stationNodes.add(el.id);
  }

  // Tag ereditati dalle relazioni (nome, numero, difficoltà) per le vie membro
  const inherited = new Map();
  for (const r of relations) {
    const rt = tagsOf(r);
    for (const m of Array.isArray(r.members) ? r.members : []) {
      if (!m || m.type !== 'way') continue;
      const prev = inherited.get(m.ref) || {};
      inherited.set(m.ref, {
        name: prev.name || str(rt.name),
        ref: prev.ref || str(rt['piste:ref'], 20) || str(rt.ref, 20),
        difficulty: prev.difficulty || str(rt['piste:difficulty'], 20),
      });
    }
  }

  const pistes = [], lifts = [];
  for (const w of ways.values()) {
    const t = tagsOf(w);
    // la geometria deve essere completa e allineata ai nodi, altrimenti la via si scarta
    if (!Array.isArray(w.nodes) || !Array.isArray(w.geometry) || w.nodes.length < 2) continue;
    if (w.nodes.length !== w.geometry.length || !w.geometry.every(validPt) || !w.nodes.every(validId)) continue;
    const coords = w.geometry.map((g) => [+g.lon.toFixed(6), +g.lat.toFixed(6)]);
    const inh = inherited.get(w.id) || {};
    const ptype = t['piste:type'] || (inherited.has(w.id) ? 'downhill' : null);

    if (ptype === 'downhill' || ptype === 'connection') {
      if (t.disused === 'yes' || t['piste:abandoned'] === 'yes') continue;
      const closed = w.nodes[0] === w.nodes[w.nodes.length - 1];
      const area = t.area === 'yes' || (closed && t.area !== 'no' && ptype === 'downhill');
      const name = str(t['piste:name']) || str(t.name) || inh.name || null;
      const ref = str(t['piste:ref'], 20) || str(t.ref, 20) || inh.ref || null;
      const diff = ptype === 'connection' ? 'connection' : diffCategory(str(t['piste:difficulty'], 20) || inh.difficulty);
      if (area && coords.length < 4) continue; // poligono non valido
      pistes.push({
        id: w.id,
        name,
        ref,
        diff,
        area,
        // le piste da discesa si percorrono nel verso del disegno; i collegamenti in entrambi
        bidir: ptype === 'connection',
        grooming: str(t['piste:grooming'], 30),
        nodes: w.nodes,
        coords,
        length: Math.round(lineLength(coords)),
      });
    } else if (typeof t.aerialway === 'string' && Object.hasOwn(LIFT_TYPES, t.aerialway)) {
      if (t.disused === 'yes' || t.abandoned === 'yes' || t.construction === 'yes') continue;
      const info = LIFT_TYPES[t.aerialway];
      // fermate: partenza, eventuali stazioni intermedie, arrivo
      const stops = [0];
      for (let i = 1; i < w.nodes.length - 1; i++) if (stationNodes.has(w.nodes[i])) stops.push(i);
      stops.push(w.nodes.length - 1);
      const length = Math.round(lineLength(coords));
      lifts.push({
        id: w.id,
        name: str(t.name),
        ref: str(t.ref, 20),
        type: t.aerialway,
        typeLabel: info.label,
        occupancy: str(t['aerialway:occupancy'], 10),
        detachable: t['aerialway:detachable'] === 'yes',
        bidir: info.bidir || t.oneway === 'no',
        duration: parseDuration(t['aerialway:duration']),
        nodes: w.nodes,
        coords,
        stops,
        length,
      });
    }
  }

  for (const el of els) {
    const t = tagsOf(el);
    const c = centerOf(el);
    if (!c) continue;
    if (!['node', 'way', 'relation'].includes(el.type)) continue;
    if (t.amenity === 'parking') {
      if (t.access === 'private' || t.access === 'no' || t.access === 'customers') continue;
      if (t.parking === 'garage' && t.access === 'private') continue;
      parkings.push({
        id: el.type[0] + el.id,
        name: str(t.name),
        lon: +c[0].toFixed(6),
        lat: +c[1].toFixed(6),
        capacity: typeof t.capacity === 'string' && /^\d{1,5}$/.test(t.capacity.trim()) ? parseInt(t.capacity, 10) : null,
        fee: t.fee === 'yes' || t.fee === 'no' ? t.fee : null,
        kind: str(t.parking, 30),
      });
    } else if (/^(restaurant|cafe|bar|fast_food)$/.test(t.amenity || '') || /^(alpine_hut|wilderness_hut)$/.test(t.tourism || '')) {
      if (!str(t.name)) continue;
      huts.push({
        id: el.type[0] + el.id,
        name: str(t.name),
        kind: t.tourism === 'alpine_hut' || t.tourism === 'wilderness_hut' ? 'rifugio' : t.amenity === 'restaurant' ? 'ristorante' : 'bar',
        lon: +c[0].toFixed(6),
        lat: +c[1].toFixed(6),
        ele: str(t.ele, 10),
      });
    } else if (t.natural === 'peak' && el.type === 'node' && str(t.name)) {
      peaks.push({ id: 'n' + el.id, name: str(t.name), ele: str(t.ele, 10), lon: el.lon, lat: el.lat });
    }
  }

  return { pistes, lifts, parkings, huts, peaks, fetchedAt: new Date().toISOString() };
}

/** GeoJSON per la mappa. closed: { lifts:Set(chiavi), pistes:Set(chiavi) } */
export function toGeoJSON(model, closed = { lifts: new Set(), pistes: new Set() }) {
  const pisteLines = [], pisteAreas = [], liftLines = [], stations = [], pois = [];
  model.pistes.forEach((p, i) => {
    const props = {
      i,
      kind: 'piste',
      diff: p.diff,
      name: p.name || '',
      ref: p.ref || '',
      label: pisteLabel(p),
      closed: closed.pistes.has(pisteKey(p)),
    };
    if (p.area) {
      pisteAreas.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [p.coords] } });
    } else {
      pisteLines.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: p.coords } });
    }
  });
  model.lifts.forEach((l, i) => {
    liftLines.push({
      type: 'Feature',
      properties: { i, kind: 'lift', type: l.type, label: liftLabel(l), closed: closed.lifts.has(liftKey(l)) },
      geometry: { type: 'LineString', coordinates: l.coords },
    });
    for (const s of l.stops) {
      stations.push({ type: 'Feature', properties: { i, kind: 'station' }, geometry: { type: 'Point', coordinates: l.coords[s] } });
    }
  });
  model.parkings.forEach((p, i) => {
    if (p.nearLift === false) return;
    pois.push({ type: 'Feature', properties: { i, kind: 'parking', label: p.name || 'P' }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
  });
  model.huts.forEach((h, i) => {
    pois.push({ type: 'Feature', properties: { i, kind: 'hut', label: h.name }, geometry: { type: 'Point', coordinates: [h.lon, h.lat] } });
  });
  model.peaks.forEach((h, i) => {
    pois.push({ type: 'Feature', properties: { i, kind: 'peak', label: h.ele ? `${h.name} ${h.ele} m` : h.name }, geometry: { type: 'Point', coordinates: [h.lon, h.lat] } });
  });
  const fc = (features) => ({ type: 'FeatureCollection', features });
  return { pisteLines: fc(pisteLines), pisteAreas: fc(pisteAreas), liftLines: fc(liftLines), stations: fc(stations), pois: fc(pois) };
}

// Chiavi stabili per lo stato aperto/chiuso: le piste con lo stesso nome/numero sono una sola pista
export const pisteKey = (p) => (p.ref || p.name ? `p:${(p.ref || '').toLowerCase()}|${(p.name || '').toLowerCase()}` : `p:w${p.id}`);
export const liftKey = (l) => `l:w${l.id}`;

export function pisteLabel(p) {
  if (p.diff === 'connection') return p.name || 'Collegamento';
  const parts = [];
  if (p.ref) parts.push(p.ref);
  if (p.name) parts.push(p.name);
  return parts.join(' · ') || 'Pista senza nome';
}
export function liftLabel(l) {
  return l.name || l.ref || LIFT_TYPES[l.type]?.label || 'Impianto';
}

export const normName = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
