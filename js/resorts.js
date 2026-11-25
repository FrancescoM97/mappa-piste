// ===================================================================
//  ELENCO DEI COMPRENSORI
//  Per aggiungerne uno basta copiare un blocco e cambiare i valori.
//  bbox = [sud, ovest, nord, est] in gradi (lat/lon): il rettangolo
//  che contiene tutte le piste. Si legge facilmente da
//  https://boundingbox.klokantech.com (formato "CSV" -> ovest,sud,est,nord).
//  Tutto il resto (piste, impianti, parcheggi, rifugi, rilievo 3D)
//  l'app lo scarica da sola da OpenStreetMap.
// ===================================================================

export const RESORTS = [
  {
    id: 'cimone',
    name: 'Comprensorio del Cimone',
    subtitle: 'Sestola · Passo del Lupo · Cimoncino · Lago della Ninfa · Le Polle',
    bbox: [44.15, 10.6, 44.26, 10.82],
    center: [10.72, 44.195],
    zoom: 12.6,
    // facoltativo: zone del comprensorio [lon, lat] + raggio in metri.
    // Si tengono solo gli impianti con una stazione in una zona (esclude es. Abetone).
    areas: [
      { name: 'Passo del Lupo · Cimoncino · Lago della Ninfa · Le Polle', center: [10.712, 44.205], radius: 3500 },
      { name: 'Pian del Falco', center: [10.764, 44.225], radius: 1200 },
    ],
    statusUrl: 'https://www.cimonesci.it/impianti-aperti',
    website: 'https://www.cimonesci.it',
    // opzionale: file JSON con lo stato aperto/chiuso (vedi data/status/LEGGIMI.md)
    statusFile: 'data/status/cimone.json',
  },
  {
    id: 'latemar',
    name: 'Ski Center Latemar',
    subtitle: 'Obereggen · Pampeago · Predazzo',
    bbox: [46.29, 11.47, 46.405, 11.66],
    center: [11.56, 46.355],
    zoom: 12.4,
    statusUrl: 'https://www.dolomitisuperski.com/it/live-info/impianti/val-di-fiemme-obereggen',
    website: 'https://www.latemar.it',
    mapPdf: 'https://www.dolomitisuperski.com/dam/jcr:e210fb18-d523-49b0-9b15-2205d9b7d631/08_Val_di_Fiemme_DSS_Karte_fuer_web_2025-2026.pdf',
    statusFile: 'data/status/latemar.json',
  },
];
