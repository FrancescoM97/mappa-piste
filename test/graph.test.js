import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOverpass, toGeoJSON, buildQuery, pisteKey, liftKey } from '../js/osm.js';
import { buildGraph, route, nearestNode, costsTo } from '../js/graph.js';

const way = (id, nodes, coords, tags) => ({
  type: 'way', id, nodes, tags,
  geometry: coords.map(([lon, lat]) => ({ lon, lat })),
});
const sample = {
  elements: [
    // seggiovia: partenza (1) -> arrivo (2)
    way(100, [1, 3, 2], [[11.5, 46.3], [11.5, 46.305], [11.5, 46.31]], { aerialway: 'chair_lift', name: 'Seggiovia Test' }),
    // pista rossa diretta: 10 -> 11
    way(200, [10, 12, 11], [[11.5003, 46.3098], [11.5003, 46.305], [11.5003, 46.3002]], { 'piste:type': 'downhill', 'piste:difficulty': 'intermediate', name: 'Rossa', ref: '5' }),
    // pista blu lunga: 10 -> 21 -> 22 (senza nome propria: lo eredita dalla relazione)
    way(300, [10, 21, 22], [[11.5003, 46.3098], [11.51, 46.305], [11.5004, 46.3001]], { 'piste:type': 'downhill' }),
    { type: 'relation', id: 900, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'easy', name: 'Blu Panoramica', ref: '3' }, members: [{ type: 'way', ref: 300, role: '' }] },
    // pista nera isolata dall'arrivo: 30 -> 31
    way(400, [30, 31], [[11.4996, 46.3099], [11.4996, 46.3003]], { 'piste:type': 'downhill', 'piste:difficulty': 'advanced', name: 'Nera' }),
    { type: 'node', id: 1, lat: 46.3, lon: 11.5, tags: { aerialway: 'station' } },
    { type: 'node', id: 2, lat: 46.31, lon: 11.5, tags: { aerialway: 'station' } },
    { type: 'node', id: 500, lat: 46.2995, lon: 11.5005, tags: { amenity: 'parking', name: 'Parcheggio Valle', capacity: '200' } },
    { type: 'node', id: 501, lat: 46.2, lon: 11.6, tags: { amenity: 'parking', name: 'Lontano' } },
    { type: 'node', id: 600, lat: 46.3050, lon: 11.5095, tags: { tourism: 'alpine_hut', name: 'Rifugio Test' } },
  ],
};

test('query contiene bbox', () => {
  assert.match(buildQuery([1, 2, 3, 4]), /\(1,2,3,4\)/);
});

test('parsing', () => {
  const m = parseOverpass(sample);
  assert.equal(m.lifts.length, 1);
  assert.equal(m.pistes.length, 3);
  const blu = m.pistes.find((p) => p.id === 300);
  assert.equal(blu.diff, 'blue');
  assert.equal(blu.name, 'Blu Panoramica');
  assert.equal(m.parkings.length, 2);
  assert.equal(m.huts.length, 1);
  const gj = toGeoJSON(m);
  assert.equal(gj.pisteLines.features.length, 3);
});

test('percorsi e difficoltà', () => {
  const m = parseOverpass(sample);
  const g = buildGraph(m);
  const bottom = g.idx.get(1);
  const top = g.idx.get(2);
  // dall'arrivo seggiovia alla partenza, con le rosse: prende la rossa
  let r = route(g, top, bottom, { maxRank: 2 });
  assert.ok(r, 'percorso trovato');
  const piste = r.steps.filter((s) => s.type === 'piste').map((s) => s.label);
  assert.ok(piste[0].includes('Rossa') || piste[0].includes('Nera'), piste.join());
  // solo blu
  r = route(g, top, bottom, { maxRank: 1 });
  assert.ok(r && !r.relaxed);
  assert.deepEqual(r.steps.filter((s) => s.type === 'piste').map((s) => s.label), ['3 · Blu Panoramica']);
  // dal parcheggio al rifugio: serve la seggiovia
  const park = g.parkingNode.get(0);
  const hut = g.hutNode.get(0);
  assert.ok(park !== undefined && hut !== undefined);
  r = route(g, park, hut, { maxRank: 1 });
  assert.ok(r, 'parcheggio -> rifugio');
  assert.equal(r.steps.find((s) => s.type === 'lift').label, 'Seggiovia Test');
  // impianto chiuso: dal basso non si sale
  r = route(g, park, hut, { maxRank: 3, closedLifts: new Set([liftKey(m.lifts[0])]) });
  assert.equal(r, null);
  // pista blu chiusa e solo blu -> percorso "rilassato" su rossa/nera
  r = route(g, top, bottom, { maxRank: 1, closedPistes: new Set([pisteKey(m.pistes.find((p) => p.id === 300))]) });
  assert.ok(r && r.relaxed);
  assert.ok(r.steps.some((s) => s.over));
  // parcheggio lontano escluso
  assert.equal(m.parkings[1].nearLift, false);
  // costi verso il rifugio dai parcheggi
  const costs = costsTo(g, hut, { maxRank: 3 });
  assert.ok(Number.isFinite(costs[park]));
  assert.equal(nearestNode(g, 11.5, 46.3), bottom);
});
