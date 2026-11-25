// Test sui dati reali del Comprensorio del Cimone (OpenStreetMap, scaricati il 25/11/2026)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildGraph, focusModel, route, reachable } from '../js/graph.js';
import { dist } from '../js/geo.js';
import { RESORTS } from '../js/resorts.js';

const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/cimone.json', import.meta.url)));
const resort = RESORTS.find((r) => r.id === 'cimone');
const { model, excluded } = focusModel(raw, { areas: resort.areas });
const g = buildGraph(model);

const liftNode = (name, top = false) => {
  const l = model.lifts.find((x) => x.name === name);
  assert.ok(l, `impianto ${name} presente`);
  return g.idx.get(l.nodes[top ? l.stops[l.stops.length - 1] : l.stops[0]]);
};
const hutNode = (name) => g.hutNode.get(model.huts.findIndex((h) => h.name === name));
const names = (r, type) => r.steps.filter((s) => s.type === type).map((s) => s.label);

test('vengono tenuti solo gli impianti del Cimone', () => {
  const lifts = model.lifts.map((l) => l.name);
  for (const n of ['Del Cimone', 'Lamaccione', 'Lago della Ninfa', 'Cimoncino (1° Tronco)', 'Polle - Valcava', 'Ariete', 'Colombaccio', 'Sestola - Pian del Falco']) {
    assert.ok(lifts.includes(n), `manca ${n}`);
  }
  assert.ok(!lifts.includes("Ca' del Cucco - Pulicchio"), 'Abetone escluso');
  assert.equal(excluded.lifts, 1);
  assert.ok(!model.pistes.some((p) => /Coppi|Luciano Seghi/.test(p.name || '')), 'piste di Abetone escluse');
});

test('parcheggi solo vicino agli impianti del comprensorio', () => {
  const kept = model.parkings.filter((_, i) => g.parkingNode.has(i));
  assert.ok(kept.length >= 5 && kept.length <= 20, `parcheggi: ${kept.length}`);
  for (const p of kept) {
    const near = model.lifts.some((l) => dist([p.lon, p.lat], l.coords[0]) <= 500);
    assert.ok(near, `${p.name || p.id} lontano dagli impianti`);
    assert.ok(p.lat > 44.18, `${p.name || p.id} è dalle parti di Abetone`);
  }
  // le Polle hanno un parcheggio collegato
  assert.ok(kept.some((p) => p.liftName === 'Polle - Valcava'));
});

test('Le Polle → Baita Lago della Ninfa', () => {
  const r = route(g, liftNode('Polle - Valcava'), hutNode('Baita Lago della Ninfa'), { maxRank: 3 });
  assert.ok(r && !r.relaxed);
  assert.deepEqual(names(r, 'lift'), ['Polle - Valcava', 'Lamaccione']);
  assert.ok(names(r, 'piste').some((n) => n.includes('Raccordo Polle - Passo del Lupo')));
  assert.ok(r.total < 45 * 60, `troppo lungo: ${Math.round(r.total / 60)} min`);
});

test('Passo del Lupo → Cimoncino con blu e rosse usa il raccordo B', () => {
  const r = route(g, liftNode('Del Cimone'), liftNode('Cimoncino (1° Tronco)'), { maxRank: 2 });
  assert.ok(r && !r.relaxed);
  assert.ok(names(r, 'piste').some((n) => n.startsWith('B · Raccordo')));
  assert.ok(!r.steps.some((s) => s.diff === 'black'));
});

test('solo blu: se serve una rossa viene segnalata, mai una nera', () => {
  const r = route(g, liftNode('Del Cimone'), liftNode('Cimoncino (1° Tronco)'), { maxRank: 1 });
  assert.ok(r && r.relaxed);
  const over = r.steps.filter((s) => s.over);
  assert.ok(over.length > 0);
  assert.ok(over.every((s) => s.diff === 'red' || s.diff === 'unknown'));
});

test('Pian del Falco non è collegato sugli sci al resto', () => {
  const a = liftNode('Lago della Ninfa');
  const b = liftNode('Sestola - Pian del Falco', true);
  assert.equal(route(g, a, b, { maxRank: 3 }), null);
  assert.equal(reachable(g, a, b), false);
});

test('impianto chiuso: il percorso lo evita', () => {
  const a = liftNode('Polle - Valcava');
  const b = hutNode('Baita Lago della Ninfa');
  const lam = model.lifts.find((l) => l.name === 'Lamaccione');
  const r = route(g, a, b, { maxRank: 3, closedLifts: new Set([`l:w${lam.id}`]) });
  assert.ok(r, 'esiste un’alternativa');
  assert.ok(!names(r, 'lift').includes('Lamaccione'));
});

test('tutti i percorsi tra stazioni: niente scorciatoie a piedi, niente nere con "blu e rosse"', () => {
  const stations = [];
  model.lifts.forEach((l) => {
    if (l.type === 'magic_carpet') return;
    stations.push(g.idx.get(l.nodes[0]), g.idx.get(l.nodes[l.nodes.length - 1]));
  });
  let found = 0;
  for (const a of stations) {
    for (const b of stations) {
      if (a === b) continue;
      const r = route(g, a, b, { maxRank: 2 });
      if (!r) continue;
      found++;
      for (const s of r.steps) {
        if (s.type === 'walk') assert.ok(s.dist < 350, `tratto a piedi di ${Math.round(s.dist)} m`);
      }
      if (!r.relaxed) assert.ok(!r.steps.some((s) => s.diff === 'black'), 'nera con limite rosse');
      const last = r.geojson.features.at(-1).geometry.coordinates.at(-1);
      assert.ok(dist(last, g.xy(b)) < 1, 'il percorso arriva a destinazione');
    }
  }
  assert.ok(found > 200, `percorsi trovati: ${found}`);
});
