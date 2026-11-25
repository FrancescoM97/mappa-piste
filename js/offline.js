// Salvataggio dati e mappe sul telefono per l'uso senza internet
import { fetchOverpass, parseOverpass } from './osm.js';
import { tilesForBbox } from './geo.js';

export const DATA_CACHE = 'data-v1';
export const TILE_CACHE = 'tiles-v1';

export const SOURCES = {
  topo: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
  sat: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  dem: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
};
export const FONT = 'Noto Sans Regular';

/** Stessa normalizzazione usata dal service worker: un'unica copia per tile. */
export function normalizeTileUrl(url) {
  return url.replace(/^https:\/\/[abc]\.tile\.opentopomap\.org\//, 'https://a.tile.opentopomap.org/');
}

const dataKey = (id) => new URL(`offline-data/${id}.json`, location.href).href;
const hasCaches = () => typeof caches !== 'undefined';

export async function loadResortData(id) {
  try {
    if (hasCaches()) {
      const c = await caches.open(DATA_CACHE);
      const r = await c.match(dataKey(id));
      if (r) return await r.json();
    }
    const s = localStorage.getItem('data:' + id);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export async function saveResortData(id, model) {
  const body = JSON.stringify(model);
  if (hasCaches()) {
    const c = await caches.open(DATA_CACHE);
    await c.put(dataKey(id), new Response(body, { headers: { 'Content-Type': 'application/json' } }));
  } else {
    try { localStorage.setItem('data:' + id, body); } catch { /* spazio esaurito */ }
  }
}

export async function deleteResortData(id) {
  if (hasCaches()) (await caches.open(DATA_CACHE)).delete(dataKey(id));
  localStorage.removeItem('data:' + id);
}

/** Scarica da OpenStreetMap e salva. */
export async function downloadResortData(resort, opts) {
  const raw = await fetchOverpass(resort.bbox, opts);
  const model = parseOverpass(raw);
  if (!model.pistes.length && !model.lifts.length) {
    throw new Error('Nessuna pista trovata in quest’area');
  }
  model.resortId = resort.id;
  await saveResortData(resort.id, model);
  return model;
}

const fill = (tpl, z, x, y) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);

/** Elenco degli indirizzi da salvare per un comprensorio. */
export function tileList(resort) {
  // allargo un po' il riquadro per vedere i dintorni
  const [s, w, n, e] = resort.bbox;
  const pad = 0.01;
  const bbox = [s - pad, w - pad, n + pad, e + pad];
  const urls = [];
  for (const [z, x, y] of tilesForBbox(bbox, 9, 14)) urls.push(fill(SOURCES.dem[0], z, x, y));
  for (const [z, x, y] of tilesForBbox(bbox, 10, 15)) urls.push(fill(SOURCES.topo[0], z, x, y));
  for (const range of ['0-255', '256-511']) {
    urls.push(SOURCES.glyphs.replace('{fontstack}', encodeURIComponent(FONT)).replace('{range}', range));
  }
  return urls;
}

/** Salva tile del rilievo, della mappa e dei caratteri. onProgress(fatti, totale, errori) */
export async function prefetchTiles(resort, onProgress, signal) {
  const urls = tileList(resort);
  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0, i = 0;
  const worker = async () => {
    while (i < urls.length) {
      if (signal?.aborted) return;
      const url = urls[i++];
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url, { mode: 'cors', signal });
          if (res.ok) await cache.put(url, res);
          else failed++;
        }
      } catch {
        failed++;
      }
      done++;
      onProgress?.(done, urls.length, failed);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  localStorage.setItem('offline:' + resort.id, JSON.stringify({ at: new Date().toISOString(), failed, total: urls.length }));
  return { total: urls.length, failed };
}

export function offlineInfo(id) {
  try { return JSON.parse(localStorage.getItem('offline:' + id)); } catch { return null; }
}

export async function storageUsed() {
  if (!navigator.storage?.estimate) return null;
  const { usage } = await navigator.storage.estimate();
  return usage;
}
