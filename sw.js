// Service worker: fa funzionare l'app senza internet
const VERSION = 'v3';
const APP_CACHE = 'app-' + VERSION;
const TILE_CACHE = 'tiles-v1'; // stesso nome usato in js/offline.js
const DATA_CACHE = 'data-v1';

const MAPLIBRE = [
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/osm.js',
  'js/graph.js',
  'js/geo.js',
  'js/resorts.js',
  'js/offline.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(APP_CACHE);
      await c.addAll(SHELL);
      await Promise.all(MAPLIBRE.map((u) => fetch(u, { mode: 'cors' }).then((r) => r.ok && c.put(u, r)).catch(() => {})));
      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) {
        if (k.startsWith('app-') && k !== APP_CACHE) await caches.delete(k);
      }
      await self.clients.claim();
    })(),
  );
});

const TILE_HOSTS = /(tile\.opentopomap\.org|elevation-tiles-prod|arcgisonline\.com|protomaps\.github\.io)/;
const normalize = (url) => url.replace(/^https:\/\/[abc]\.tile\.opentopomap\.org\//, 'https://a.tile.opentopomap.org/');

async function cacheFirst(cacheName, req, key = req.url) {
  const c = await caches.open(cacheName);
  const hit = await c.match(key);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) c.put(key, res.clone());
    return res;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

// File dell'app: prima la rete (così gli aggiornamenti arrivano subito), poi la copia salvata
async function appFirstNetwork(req) {
  const c = await caches.open(APP_CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('lenta')), 4000)),
    ]);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch {
    const hit = await c.match(req, { ignoreSearch: true });
    return hit || new Response('Offline', { status: 503 });
  }
}

async function networkFirst(req) {
  try {
    return await fetch(req);
  } catch {
    return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (TILE_HOSTS.test(url)) return e.respondWith(cacheFirst(TILE_CACHE, req, normalize(url)));
  if (url.startsWith('https://unpkg.com/')) return e.respondWith(cacheFirst(APP_CACHE, req));
  const u = new URL(url);
  if (u.origin !== location.origin) return; // Overpass ecc.: rete normale
  if (u.pathname.includes('/offline-data/')) return e.respondWith(cacheFirst(DATA_CACHE, req));
  if (u.pathname.includes('/data/status/')) return e.respondWith(networkFirst(req));
  e.respondWith(appFirstNetwork(req));
});
