// Funzioni geografiche di base (nessuna dipendenza esterna)

const R = 6371008.8; // raggio medio terrestre in metri
const toRad = (d) => (d * Math.PI) / 180;

/** Distanza in metri tra due punti [lon, lat]. */
export function dist(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Lunghezza di una linea [[lon,lat],...] in metri. */
export function lineLength(coords) {
  let l = 0;
  for (let i = 1; i < coords.length; i++) l += dist(coords[i - 1], coords[i]);
  return l;
}

/**
 * Indice spaziale a griglia per trovare rapidamente i punti vicini.
 * cellMeters: dimensione approssimativa della cella.
 */
export class GridIndex {
  constructor(cellMeters = 100) {
    this.cellLat = cellMeters / 111320;
    this.cellLon = null; // calcolata al primo inserimento (dipende dalla latitudine)
    this.cells = new Map();
  }
  _key(lon, lat) {
    if (this.cellLon === null) {
      this.cellLon = this.cellLat / Math.max(0.2, Math.cos(toRad(lat)));
    }
    return Math.floor(lon / this.cellLon) + ':' + Math.floor(lat / this.cellLat);
  }
  insert(lon, lat, item) {
    const k = this._key(lon, lat);
    let c = this.cells.get(k);
    if (!c) this.cells.set(k, (c = []));
    c.push({ lon, lat, item });
  }
  /** Restituisce [{item, d}] entro radius metri, ordinati per distanza. */
  near(lon, lat, radius) {
    if (this.cellLon === null) return [];
    const rx = Math.ceil(radius / 111320 / this.cellLon / Math.max(0.2, Math.cos(toRad(lat)))) + 1;
    const ry = Math.ceil(radius / 111320 / this.cellLat) + 1;
    const cx = Math.floor(lon / this.cellLon);
    const cy = Math.floor(lat / this.cellLat);
    const out = [];
    for (let x = cx - rx; x <= cx + rx; x++) {
      for (let y = cy - ry; y <= cy + ry; y++) {
        const c = this.cells.get(x + ':' + y);
        if (!c) continue;
        for (const p of c) {
          const d = dist([lon, lat], [p.lon, p.lat]);
          if (d <= radius) out.push({ item: p.item, d });
        }
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }
}

/** Tile x/y per lon/lat a zoom z (schema XYZ / Web Mercator). */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latR = toRad(lat);
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
  return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}

/** Elenco tile [z,x,y] che coprono il bbox [sud, ovest, nord, est]. */
export function tilesForBbox(bbox, zMin, zMax) {
  const [s, w, n, e] = bbox;
  const out = [];
  for (let z = zMin; z <= zMax; z++) {
    const [x0, y0] = lonLatToTile(w, n, z);
    const [x1, y1] = lonLatToTile(e, s, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  }
  return out;
}
