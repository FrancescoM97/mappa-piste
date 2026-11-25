// Test "cattivi": dati malformati, casuali o ostili non devono mandare in errore l'app
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOverpass, toGeoJSON } from '../js/osm.js';
import { buildGraph, focusModel, route, reachable, costsTo } from '../js/graph.js';
import { tilesForBbox } from '../js/geo.js';
import { bboxTooLarge } from '../js/offline.js';

// generatore pseudo-casuale riproducibile
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const junkValues = [null, undefined, '', 'abc', -1, 0, 1e309, NaN, {}, [], '__proto__', '<img src=x onerror=alert(1)>', true];

function randomElements(r, n) {
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const els = [];
  for (let i = 0; i < n; i++) {
    const len = Math.floor(r() * 6);
    const nodes = Array.from({ length: len }, () => Math.floor(r() * 30));
    const geometry = nodes.map(() =>
      r() < 0.08 ? pick([null, { lon: 'x', lat: 1 }, { lat: 46 }, {}]) : { lon: 11.5 + r() * 0.01, lat: 46.3 + r() * 0.01 },
    );
    const tags = {};
    const kind = pick(['piste', 'lift', 'parking', 'hut', 'junk']);
    if (kind === 'piste') Object.assign(tags, { 'piste:type': pick(['downhill', 'connection']), 'piste:difficulty': pick(['easy', 'intermediate', 'advanced', 'freeride', 'weird', undefined]) });
    if (kind === 'lift') Object.assign(tags, { aerialway: pick(['chair_lift', 'gondola', 'drag_lift', 'magic_carpet', 'pylon']), 'aerialway:duration': pick(['5', '05:30', 'abc', '', '1:2:3']) });
    if (kind === 'parking') tags.amenity = 'parking';
    if (kind === 'hut') Object.assign(tags, { tourism: 'alpine_hut' });
    if (r() < 0.5) tags.name = pick(junkValues);
    if (r() < 0.3) tags.capacity = pick(junkValues);
    const type = pick(['way', 'way', 'way', 'node', 'relation']);
    const el = { type, id: i + 1, tags: r() < 0.05 ? null : tags };
    if (type === 'way') Object.assign(el, { nodes: r() < 0.05 ? null : nodes, geometry: r() < 0.05 ? undefined : geometry });
    if (type === 'node') Object.assign(el, { lon: r() < 0.1 ? 'x' : 11.5 + r() * 0.01, lat: 46.3 + r() * 0.01 });
    if (type === 'relation') Object.assign(el, { tags: { 'piste:type': 'downhill', name: pick(junkValues) }, members: r() < 0.2 ? null : [{ type: 'way', ref: Math.floor(r() * n) }] });
    els.push(el);
  }
  return { elements: els };
}

test('fuzz: 300 dataset casuali e malformati non mandano in errore il calcolo', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const raw = parseOverpass(randomElements(r, 40));
    for (const p of raw.pistes) for (const c of p.coords) assert.ok(Number.isFinite(c[0]) && Number.isFinite(c[1]), `seed ${seed}: coordinate non valide`);
    for (const p of raw.parkings) assert.ok(Number.isFinite(p.lon) && Number.isFinite(p.lat));
    for (const x of [...raw.pistes, ...raw.lifts, ...raw.huts, ...raw.parkings]) {
      if (x.name !== null) assert.equal(typeof x.name, 'string', `seed ${seed}: nome non testuale`);
    }
    const { model } = focusModel(raw);
    const g = buildGraph(model);
    toGeoJSON(model);
    const N = g.lon.length;
    for (let k = 0; k < 5 && N > 1; k++) {
      const a = Math.floor(r() * N), b = Math.floor(r() * N);
      route(g, a, b, { maxRank: 1 + Math.floor(r() * 3) });
      reachable(g, a, b);
    }
    if (N) costsTo(g, 0, { maxRank: 3 });
  }
});

test('risposte Overpass vuote o strane', () => {
  for (const j of [{}, { elements: null }, { elements: 'x' }, { elements: [null, 1, 'a'] }]) {
    const m = parseOverpass(j);
    assert.equal(m.pistes.length, 0);
  }
});

test('Overpass con errore di timeout non viene preso per buono', () => {
  assert.throws(() => parseOverpass({ remark: 'runtime error: Query timed out in "query" at line 3', elements: [] }), /incomplet/i);
});

test('punti non validi per il percorso', () => {
  const g = buildGraph(parseOverpass({ elements: [] }));
  assert.equal(route(g, null, 0, { maxRank: 3 }), null);
  assert.equal(route(g, undefined, undefined, { maxRank: 3 }), null);
  assert.equal(route(g, -1, 99999, { maxRank: 3 }), null);
});

test('zone configurate male: non si nasconde tutto', () => {
  const way = (id, nodes, coords, tags) => ({ type: 'way', id, nodes, tags, geometry: coords.map(([lon, lat]) => ({ lon, lat })) });
  const raw = parseOverpass({ elements: [way(1, [1, 2], [[11.5, 46.3], [11.5, 46.31]], { aerialway: 'chair_lift', name: 'A' })] });
  const { model } = focusModel(raw, { areas: [{ center: [0, 0], radius: 100 }] });
  assert.equal(model.lifts.length, 1);
});

test('area troppo grande per il download (es. comprensorio aggiunto con mappa troppo larga)', () => {
  assert.equal(bboxTooLarge([46.3, 11.5, 46.4, 11.6]), false);
  assert.equal(bboxTooLarge([40, 5, 48, 15]), true);
  assert.equal(bboxTooLarge([46.4, 11.5, 46.3, 11.6]), true); // sud > nord
  assert.equal(bboxTooLarge(['a', 1, 2, 3]), true);
  // anche il conteggio delle tile resta ragionevole per un comprensorio normale
  assert.ok(tilesForBbox([46.29, 11.47, 46.405, 11.66], 10, 15).length < 1000);
});
