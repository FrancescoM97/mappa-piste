// Scarica e interpreta i dati di OpenStreetMap (piste, impianti, parcheggi, rifugi)
import { lineLength } from './geo.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
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
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
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
  if (!v) return null;
  v = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v) * 60; // minuti
  const m = v.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) {
    // "mm:ss" oppure "hh:mm:ss"
    return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  }
  return null;
}

function centerOf(el) {
  if (el.type === 'node') return [el.lon, el.lat];
  if (el.center) return [el.center.lon, el.center.lat];
  if (el.bounds) {
    const b = el.bounds;
    return [(b.minlon + b.maxlon) / 2, (b.minlat + b.maxlat) / 2];
  }
  if (el.geometry && el.geometry.length) {
    let x = 0, y = 0, n = 0;
    for (const g of el.geometry) if (g) { x += g.lon; y += g.lat; n++; }
    return n ? [x / n, y / n] : null;
  }
  return null;
}

/**
 * Converte la risposta Overpass nel modello dell'app:
 * { pistes, lifts, parkings, huts, peaks, fetchedAt }
 */
export function parseOverpass(json) {
  const els = json.elements || [];
  const ways = new Map();
  const stationNodes = new Set();
  const relations = [];
  const parkings = [], huts = [], peaks = [];

  for (const el of els) {
    if (el.type === 'way') ways.set(el.id, el);
    else if (el.type === 'relation' && el.tags?.['piste:type'] === 'downhill') relations.push(el);
    if (el.type === 'node' && el.tags?.aerialway === 'station') stationNodes.add(el.id);
  }

  // Tag ereditati dalle relazioni (nome, numero, difficoltà) per le vie membro
  const inherited = new Map();
  for (const r of relations) {
    for (const m of r.members || []) {
      if (m.type !== 'way') continue;
      const prev = inherited.get(m.ref) || {};
      inherited.set(m.ref, {
        name: prev.name || r.tags.name,
        ref: prev.ref || r.tags['piste:ref'] || r.tags.ref,
        difficulty: prev.difficulty || r.tags['piste:difficulty'],
      });
    }
  }

  const pistes = [], lifts = [];
  for (const w of ways.values()) {
    const t = w.tags || {};
    const geom = (w.geometry || []).filter(Boolean);
    if (geom.length < 2 || !w.nodes || w.nodes.length !== w.geometry.length) continue;
    const coords = geom.map((g) => [+g.lon.toFixed(6), +g.lat.toFixed(6)]);
    const inh = inherited.get(w.id) || {};
    const ptype = t['piste:type'] || (inherited.has(w.id) ? 'downhill' : null);

    if (ptype === 'downhill' || ptype === 'connection') {
      if (t.disused === 'yes' || t['piste:abandoned'] === 'yes') continue;
      const closed = w.nodes[0] === w.nodes[w.nodes.length - 1];
      const area = t.area === 'yes' || (closed && t.area !== 'no' && ptype === 'downhill');
      const name = t['piste:name'] || t.name || inh.name || null;
      const ref = t['piste:ref'] || t.ref || inh.ref || null;
      const diff = ptype === 'connection' ? 'connection' : diffCategory(t['piste:difficulty'] || inh.difficulty);
      pistes.push({
        id: w.id,
        name,
        ref,
        diff,
        area,
        // le piste da discesa si percorrono nel verso del disegno; i collegamenti in entrambi
        bidir: ptype === 'connection',
        grooming: t['piste:grooming'] || null,
        nodes: w.nodes,
        coords,
        length: Math.round(lineLength(coords)),
      });
    } else if (t.aerialway && LIFT_TYPES[t.aerialway]) {
      if (t.disused === 'yes' || t.abandoned === 'yes' || t.construction === 'yes') continue;
      const info = LIFT_TYPES[t.aerialway];
      // fermate: partenza, eventuali stazioni intermedie, arrivo
      const stops = [0];
      for (let i = 1; i < w.nodes.length - 1; i++) if (stationNodes.has(w.nodes[i])) stops.push(i);
      stops.push(w.nodes.length - 1);
      const length = Math.round(lineLength(coords));
      lifts.push({
        id: w.id,
        name: t.name || null,
        ref: t.ref || null,
        type: t.aerialway,
        typeLabel: info.label,
        occupancy: t['aerialway:occupancy'] || null,
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
    const t = el.tags || {};
    if (!t) continue;
    const c = centerOf(el);
    if (!c) continue;
    if (t.amenity === 'parking') {
      if (t.access === 'private' || t.access === 'no' || t.access === 'customers') continue;
      if (t.parking === 'garage' && t.access === 'private') continue;
      parkings.push({
        id: el.type[0] + el.id,
        name: t.name || null,
        lon: +c[0].toFixed(6),
        lat: +c[1].toFixed(6),
        capacity: t.capacity ? parseInt(t.capacity, 10) || null : null,
        fee: t.fee || null,
        kind: t.parking || null,
      });
    } else if (/^(restaurant|cafe|bar|fast_food)$/.test(t.amenity || '') || /^(alpine_hut|wilderness_hut)$/.test(t.tourism || '')) {
      if (!t.name) continue;
      huts.push({
        id: el.type[0] + el.id,
        name: t.name,
        kind: t.tourism === 'alpine_hut' || t.tourism === 'wilderness_hut' ? 'rifugio' : t.amenity === 'restaurant' ? 'ristorante' : 'bar',
        lon: +c[0].toFixed(6),
        lat: +c[1].toFixed(6),
        ele: t.ele || null,
      });
    } else if (t.natural === 'peak' && el.type === 'node') {
      peaks.push({ id: 'n' + el.id, name: t.name, ele: t.ele || null, lon: el.lon, lat: el.lat });
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
