// Rete di piste e impianti + calcolo del percorso migliore (Dijkstra)
import { dist, GridIndex } from './geo.js';
import { DIFF_RANK, LIFT_TYPES, pisteKey, liftKey, pisteLabel, liftLabel } from './osm.js';

// Velocità medie di discesa (m/s, in pianta) per categoria: servono solo a stimare i tempi
const SKI_SPEED = { blue: 6, red: 7, black: 6, unknown: 6, freeride: 4, connection: 3.5 };
const WALK_SPEED = 0.8; // a piedi / spingendo con gli sci (lento: si preferisce sciare)
const SNAP_PISTE = 40; // m: aggancio tra fine/inizio pista e altre piste
const SNAP_LIFT = 100; // m: aggancio tra stazioni degli impianti e piste
const SNAP_PARKING = 400; // m: parcheggio -> piste/impianti
const SNAP_HUT = 150; // m: rifugio -> piste
const PARKING_TO_LIFT = 500; // m: parcheggio considerato "dell'impianto" se così vicino a una partenza
const PARKING_TO_PISTE = 150; // m: oppure così vicino a una pista

export function buildGraph(model) {
  const idx = new Map(); // chiave nodo -> indice
  const lon = [], lat = [], adj = [];
  const nodeInfo = []; // per ogni nodo: {ways:Set} utile per l'aggancio

  const addNode = (key, c) => {
    let n = idx.get(key);
    if (n === undefined) {
      n = lon.length;
      idx.set(key, n);
      lon.push(c[0]);
      lat.push(c[1]);
      adj.push([]);
      nodeInfo.push(new Set());
    }
    return n;
  };
  const addEdge = (a, b, e) => {
    if (a === b) return;
    adj[a].push({ t: b, ...e });
  };
  const xy = (n) => [lon[n], lat[n]];

  // 1. Piste
  model.pistes.forEach((p, i) => {
    if (p.area) return;
    const speed = SKI_SPEED[p.diff] || 6;
    const ns = p.nodes.map((id, j) => {
      const n = addNode(id, p.coords[j]);
      nodeInfo[n].add('p' + i);
      return n;
    });
    for (let j = 0; j < ns.length - 1; j++) {
      const d = dist(p.coords[j], p.coords[j + 1]);
      addEdge(ns[j], ns[j + 1], { k: 'piste', i, s: j, d, c: d / speed });
      if (p.bidir) addEdge(ns[j + 1], ns[j], { k: 'piste', i, s: j, d, c: d / speed, rev: true });
    }
  });

  // 2. Impianti (un arco per tratta tra fermate)
  model.lifts.forEach((l, i) => {
    const info = LIFT_TYPES[l.type];
    const ns = l.stops.map((s) => {
      const n = addNode(l.nodes[s], l.coords[s]);
      nodeInfo[n].add('l' + i);
      return n;
    });
    for (let k = 0; k < ns.length - 1; k++) {
      const a = l.stops[k], b = l.stops[k + 1];
      let d = 0;
      for (let j = a; j < b; j++) d += dist(l.coords[j], l.coords[j + 1]);
      const ride = l.duration ? (l.duration * d) / Math.max(1, l.length) : d / (l.detachable ? Math.max(info.speed, 5) : info.speed);
      const c = info.wait + ride;
      addEdge(ns[k], ns[k + 1], { k: 'lift', i, a, b, d, c, ride });
      if (l.bidir) addEdge(ns[k + 1], ns[k], { k: 'lift', i, a, b, d, c, ride, rev: true });
    }
  });

  // Indice spaziale dei nodi reali
  const grid = new GridIndex(60);
  for (let n = 0; n < lon.length; n++) grid.insert(lon[n], lat[n], n);

  /** Nodi vicini, al massimo uno per ogni pista/impianto (il più vicino), escluse le vie "self". */
  const nearPerWay = (c, radius, self) => {
    const seen = new Set();
    const out = [];
    for (const { item: n, d } of grid.near(c[0], c[1], radius)) {
      const ways = [...nodeInfo[n]];
      if (self && ways.some((w) => w === self)) continue;
      const fresh = ways.filter((w) => !seen.has(w));
      if (!fresh.length) continue;
      fresh.forEach((w) => seen.add(w));
      out.push({ n, d });
    }
    return out;
  };
  const walk = (d, extra = 15) => ({ k: 'walk', d, c: extra + d / WALK_SPEED });

  // 3. Agganci: dove le piste non condividono nodi con altre piste o con gli impianti
  model.pistes.forEach((p, i) => {
    if (p.area) return;
    const self = 'p' + i;
    const S = idx.get(p.nodes[0]);
    const E = idx.get(p.nodes[p.nodes.length - 1]);
    for (const { n, d } of nearPerWay(xy(S), SNAP_PISTE, self)) {
      addEdge(n, S, walk(d, 5)); // da un'altra pista/impianto si entra all'inizio di questa
      if (p.bidir) addEdge(S, n, walk(d, 5));
    }
    for (const { n, d } of nearPerWay(xy(E), SNAP_PISTE, self)) {
      addEdge(E, n, walk(d, 5)); // a fine pista si prosegue su ciò che c'è vicino
      if (p.bidir) addEdge(n, E, walk(d, 5));
    }
  });
  model.lifts.forEach((l, i) => {
    const self = 'l' + i;
    l.stops.forEach((s, k) => {
      const st = idx.get(l.nodes[s]);
      const isBottom = k < l.stops.length - 1;
      const isTop = k > 0;
      for (const { n, d } of nearPerWay(xy(st), SNAP_LIFT, self)) {
        if (isBottom || l.bidir) addEdge(n, st, walk(d)); // arrivo alla partenza dell'impianto
        if (isTop || l.bidir) addEdge(st, n, walk(d)); // sceso dall'impianto, vado sulle piste
      }
    });
  });

  // da qui in poi i nodi sono "virtuali" (parcheggi, rifugi): si può partire o arrivare lì,
  // ma non passarci attraverso (altrimenti diventano scorciatoie a piedi tra piste)
  const realCount = lon.length;

  // 4. Parcheggi (solo quelli vicini a impianti o piste)
  const liftStops = new GridIndex(200); // partenze di tutti gli impianti
  const mainStops = new GridIndex(200); // solo impianti "veri" (per dare un nome al parcheggio)
  const minor = new Set(['magic_carpet', 'rope_tow']);
  model.lifts.forEach((l, i) => {
    const s = l.coords[l.stops[0]];
    liftStops.insert(s[0], s[1], i);
    if (!minor.has(l.type) && (l.name || l.ref)) mainStops.insert(s[0], s[1], i);
  });
  const parkingNode = new Map();
  model.parkings.forEach((p, i) => {
    const c = [p.lon, p.lat];
    const nearLift = liftStops.near(c[0], c[1], PARKING_TO_LIFT)[0];
    const near = nearPerWay(c, SNAP_PARKING).slice(0, 10);
    p.nearLift = !!nearLift || near.some((x) => x.d < PARKING_TO_PISTE);
    const named = mainStops.near(c[0], c[1], 1500)[0] || nearLift;
    p.liftName = named ? liftLabel(model.lifts[named.item]) : null;
    p.liftDist = named ? Math.round(named.d) : null;
    if (!p.nearLift || !near.length) {
      p.nearLift = false;
      return;
    }
    const pn = addNode('P' + p.id, c);
    parkingNode.set(i, pn);
    for (const { n, d } of near) {
      addEdge(pn, n, walk(d, 30));
      addEdge(n, pn, walk(d, 30));
    }
  });

  // 5. Rifugi e ristoranti
  const hutNode = new Map();
  model.huts.forEach((h, i) => {
    const c = [h.lon, h.lat];
    const near = nearPerWay(c, SNAP_HUT).slice(0, 8);
    if (!near.length) return;
    const hn = addNode('H' + h.id, c);
    hutNode.set(i, hn);
    for (const { n, d } of near) {
      addEdge(hn, n, walk(d, 20));
      addEdge(n, hn, walk(d, 20));
    }
  });

  return { model, idx, lon, lat, adj, grid, parkingNode, hutNode, xy, realCount };
}

/**
 * Tiene solo la rete del comprensorio: impianti e piste collegati tra loro.
 * Gli impianti di altre località che cadono nel riquadro (ma non sono collegati)
 * vengono esclusi, insieme ai loro parcheggi e rifugi.
 * minShare: una rete separata viene tenuta se ha almeno questa quota
 * della lunghezza impianti della rete principale.
 */
export function focusModel(model, { minShare = 0.2, areas = null } = {}) {
  const g = buildGraph({ ...model, parkings: [], huts: [] });
  const N = g.lon.length;
  const parent = new Int32Array(N).map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  g.adj.forEach((list, a) => list.forEach((e) => { parent[find(a)] = find(e.t); }));

  const liftComp = model.lifts.map((l) => find(g.idx.get(l.nodes[l.stops[0]])));
  const score = new Map();
  model.lifts.forEach((l, i) => score.set(liftComp[i], (score.get(liftComp[i]) || 0) + l.length));
  const copy = (arr) => arr.map((x) => ({ ...x }));
  if (!score.size) {
    return { model: { ...model, parkings: copy(model.parkings), huts: copy(model.huts) }, excluded: { lifts: 0, pistes: 0 } };
  }
  let keep = null;
  if (Array.isArray(areas) && areas.length) {
    // zone del comprensorio indicate in resorts.js: si tiene ogni rete con almeno
    // una stazione dentro una zona (anche se non collegata alle altre, es. Pian del Falco)
    keep = new Set();
    model.lifts.forEach((l, i) => {
      const inside = l.stops.some((s) => areas.some((a) => Array.isArray(a?.center) && dist(l.coords[s], a.center) <= a.radius));
      if (inside) keep.add(liftComp[i]);
    });
  }
  if (!keep?.size) {
    // nessuna zona configurata (o zone sbagliate): si tiene la rete principale e quelle grandi
    const max = Math.max(...score.values());
    keep = new Set([...score].filter(([, v]) => v >= max * minShare).map(([c]) => c));
  }

  // indice dei nodi tenuti: serve per non perdere tratti di pista vicini ma non agganciati
  const kept = new GridIndex(100);
  for (let n = 0; n < N; n++) if (keep.has(find(n))) kept.insert(g.lon[n], g.lat[n], n);
  const nearKept = (c, r) => kept.near(c[0], c[1], r).length > 0;

  const lifts = model.lifts.filter((_, i) => keep.has(liftComp[i]));
  const pistes = model.pistes.filter((p) => {
    if (!p.area) {
      const n = g.idx.get(p.nodes[0]);
      if (n !== undefined && keep.has(find(n))) return true;
    }
    // aree e frammenti isolati: tenuti se sono a ridosso della rete del comprensorio
    return nearKept(p.coords[0], 300) || nearKept(p.coords[Math.floor(p.coords.length / 2)], 300);
  });
  const [s, w, n, e] = model.bbox || [-90, -180, 90, 180];
  const peaks = model.peaks.filter((pk) => nearKept([pk.lon, pk.lat], 1500) && pk.lat >= s && pk.lat <= n && pk.lon >= w && pk.lon <= e);
  return {
    model: { ...model, lifts, pistes, peaks, parkings: copy(model.parkings), huts: copy(model.huts) },
    excluded: { lifts: model.lifts.length - lifts.length, pistes: model.pistes.length - pistes.length },
  };
}

/** Nodo della rete più vicino a un punto (entro maxD metri). */
export function nearestNode(g, lonv, latv, maxD = 300) {
  const r = g.grid.near(lonv, latv, maxD)[0];
  return r ? r.item : null;
}

// ---- Dijkstra ----

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(c, n) {
    const a = this.a;
    a.push([c, n]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * opts: { maxRank: 1|2|3, closedPistes:Set, closedLifts:Set, penalize:boolean }
 * Restituisce il costo dell'arco oppure null se l'arco non è percorribile.
 */
function edgeCost(g, e, opts) {
  if (e.k === 'piste') {
    const p = g.model.pistes[e.i];
    if (opts.closedPistes?.has(pisteKey(p))) return null;
    const rank = DIFF_RANK[p.diff] ?? 2;
    if (rank > opts.maxRank) {
      if (p.diff === 'freeride') return null;
      return opts.penalize ? e.c * 3 + 30 : null;
    }
    return e.c;
  }
  if (e.k === 'lift') {
    const l = g.model.lifts[e.i];
    if (opts.closedLifts?.has(liftKey(l))) return null;
    return e.rev ? e.c * 1.3 : e.c; // scendere in cabinovia solo se conviene
  }
  return e.c;
}

function dijkstra(g, from, to, opts) {
  const N = g.lon.length;
  const best = new Float64Array(N).fill(Infinity);
  const prevEdge = new Array(N);
  const prevNode = new Int32Array(N).fill(-1);
  const h = new Heap();
  best[from] = 0;
  h.push(0, from);
  while (h.size) {
    const [c, n] = h.pop();
    if (c > best[n]) continue;
    if (n === to) break;
    if (n !== from && n >= g.realCount) continue; // niente transito da parcheggi/rifugi
    for (const e of g.adj[n]) {
      const ec = edgeCost(g, e, opts);
      if (ec === null) continue;
      const nc = c + ec;
      if (nc < best[e.t]) {
        best[e.t] = nc;
        prevEdge[e.t] = e;
        prevNode[e.t] = n;
        h.push(nc, e.t);
      }
    }
  }
  if (best[to] === Infinity) return null;
  const path = [];
  for (let n = to; n !== from; n = prevNode[n]) path.push({ from: prevNode[n], e: prevEdge[n] });
  path.reverse();
  return path;
}

/** true se b è raggiungibile da a ignorando difficoltà e chiusure (zone collegate sugli sci). */
export function reachable(g, a, b) {
  if (!validNode(g, a) || !validNode(g, b)) return false;
  return !!dijkstra(g, a, b, { maxRank: 99 });
}

/** Costi verso il nodo "to" da tutti i nodi (Dijkstra sul grafo inverso). */
export function costsTo(g, to, opts) {
  if (!validNode(g, to)) return new Float64Array(g.lon.length).fill(Infinity);
  if (!g.radj) {
    g.radj = g.adj.map(() => []);
    g.adj.forEach((list, a) => list.forEach((e) => g.radj[e.t].push({ ...e, t: a })));
  }
  const N = g.lon.length;
  const best = new Float64Array(N).fill(Infinity);
  const h = new Heap();
  best[to] = 0;
  h.push(0, to);
  while (h.size) {
    const [c, n] = h.pop();
    if (c > best[n]) continue;
    if (n !== to && n >= g.realCount) continue;
    for (const e of g.radj[n]) {
      const ec = edgeCost(g, e, opts);
      if (ec === null) continue;
      if (c + ec < best[e.t]) {
        best[e.t] = c + ec;
        h.push(best[e.t], e.t);
      }
    }
  }
  return best;
}

/**
 * Calcola il percorso. Se con il limite di difficoltà non esiste,
 * riprova permettendo piste più difficili (segnalate con over=true).
 */
const validNode = (g, n) => Number.isInteger(n) && n >= 0 && n < g.lon.length;

export function route(g, from, to, opts) {
  if (!validNode(g, from) || !validNode(g, to)) return null;
  let path = dijkstra(g, from, to, { ...opts, penalize: false });
  let relaxed = false;
  if (!path) {
    path = dijkstra(g, from, to, { ...opts, penalize: true });
    relaxed = !!path;
  }
  if (!path) return null;
  return { ...describe(g, path, opts), relaxed };
}

function edgeCoords(g, from, e) {
  const m = g.model;
  if (e.k === 'piste') {
    const c = m.pistes[e.i].coords;
    const seg = [c[e.s], c[e.s + 1]];
    return e.rev ? seg.reverse() : seg;
  }
  if (e.k === 'lift') {
    const seg = m.lifts[e.i].coords.slice(e.a, e.b + 1);
    return e.rev ? seg.reverse() : seg;
  }
  return [g.xy(from), g.xy(e.t)];
}

/** Trasforma il percorso in passi leggibili + geometria. */
export function describe(g, path, opts = { maxRank: 3 }) {
  const m = g.model;
  const steps = [];
  const features = [];
  let total = 0, skied = 0, liftsCount = 0;
  for (const { from, e } of path) {
    const coords = edgeCoords(g, from, e);
    features.push({ type: 'Feature', properties: { k: e.k }, geometry: { type: 'LineString', coordinates: coords } });
    const time = e.c;
    total += time;
    const last = steps[steps.length - 1];
    if (e.k === 'piste') {
      const p = m.pistes[e.i];
      skied += e.d;
      const key = pisteKey(p);
      const over = (DIFF_RANK[p.diff] ?? 2) > opts.maxRank;
      if (last && last.type === 'piste' && (last.key === key || (!p.name && !p.ref && !last.named && last.diff === p.diff))) {
        last.dist += e.d;
        last.time += time;
        last.end = coords[coords.length - 1];
      } else {
        steps.push({ type: 'piste', key, named: !!(p.name || p.ref), label: pisteLabel(p), diff: p.diff, dist: e.d, time, over, start: coords[0], end: coords[coords.length - 1], i: e.i });
      }
    } else if (e.k === 'lift') {
      const l = m.lifts[e.i];
      if (last && last.type === 'lift' && last.i === e.i && last.rev === !!e.rev) {
        last.dist += e.d;
        last.time += e.ride;
        last.end = coords[coords.length - 1];
        total -= e.c - e.ride; // nessuna nuova attesa alla stazione intermedia
      } else {
        liftsCount++;
        steps.push({ type: 'lift', i: e.i, label: liftLabel(l), liftType: LIFT_TYPES[l.type]?.label || 'Impianto', rev: !!e.rev, dist: e.d, time, start: coords[0], end: coords[coords.length - 1] });
      }
    } else {
      if (last && last.type === 'walk') {
        last.dist += e.d;
        last.time += time;
        last.end = coords[1];
      } else {
        steps.push({ type: 'walk', dist: e.d, time, start: coords[0], end: coords[1] });
      }
    }
  }
  // i piccoli spostamenti a piedi (<60 m) non vengono mostrati come passi separati
  // i piccoli spostamenti (<60 m, es. dall'arrivo dell'impianto all'inizio pista) non sono passi separati
  let visible = steps.filter((s) => s.type !== 'walk' || s.dist >= 60);
  // i brevi raccordi senza nome (<150 m) vengono uniti alla pista vicina
  const merged = [];
  visible.forEach((s, k) => {
    const tiny = s.type === 'piste' && !s.named && s.dist < 150 && !s.over;
    const prev = merged[merged.length - 1];
    const next = visible[k + 1];
    if (tiny && prev?.type === 'piste') {
      prev.dist += s.dist; prev.time += s.time; prev.end = s.end;
    } else if (tiny && next?.type === 'piste') {
      next.dist += s.dist; next.time += s.time; next.start = s.start;
    } else merged.push(s);
  });
  visible = [];
  for (const s of merged) {
    const prev = visible[visible.length - 1];
    if (prev && s.type === 'piste' && prev.type === 'piste' && prev.key === s.key) {
      prev.dist += s.dist; prev.time += s.time; prev.end = s.end; prev.over = prev.over || s.over;
    } else visible.push(s);
  }
  return {
    steps: visible,
    total,
    skied,
    liftsCount,
    geojson: { type: 'FeatureCollection', features },
  };
}
