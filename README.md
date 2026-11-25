# mappa-piste

Web app (PWA) per orientarsi sulle piste da sci: mappa 3D, percorsi da A a B con impianti e piste,
filtro per difficoltà, parcheggi consigliati, funzionamento offline.

**Indirizzo dell'app:** https://francescom97.github.io/mappa-piste/

## Comprensori inclusi

- Comprensorio del Cimone (Sestola, Passo del Lupo, Cimoncino, Lago della Ninfa, Le Polle)
- Ski Center Latemar (Obereggen, Pampeago, Predazzo)

## Installazione sul telefono (Android)

1. Apri l'indirizzo qui sopra con **Chrome**.
2. Menu ⋮ → **Aggiungi a schermata Home** → **Installa**.
3. Apri l'app, scegli il comprensorio, vai nella scheda **Info** e premi
   **Salva per l'uso senza internet** (meglio con il wifi).

## Cosa fa

- **Mappa 3D** con rilievo reale, piste colorate per difficoltà, impianti, rifugi e parcheggi.
- **Percorso**: scegli partenza e arrivo (dalla lista, toccando la mappa o con il GPS).
  L'app indica quali impianti prendere e quali piste scendere, con i tempi stimati.
  Puoi limitarlo a **solo blu**, **blu e rosse** o **tutte**.
- **Piste**: evidenzia blu, rosse o nere e segna impianti o piste chiusi (il percorso li evita).
- **Parcheggi**: quelli vicini agli impianti, ordinati per tempo fino alla destinazione, con il pulsante
  per avviare la navigazione in auto.
- **Offline**: piste, rilievo e mappa restano salvati sul telefono; il GPS funziona senza rete.

## Aggiungere un comprensorio

Due modi:

1. **Dall'app**, solo sul tuo telefono: scheda Info → **Aggiungi un comprensorio**, inquadra l'area e conferma.
2. **Per sempre, per tutti**: aggiungi un blocco in [`js/resorts.js`](js/resorts.js):

```js
{
  id: 'cervinia',                      // identificativo breve, senza spazi
  name: 'Breuil-Cervinia',
  bbox: [45.90, 7.60, 45.98, 7.75],    // [sud, ovest, nord, est]
  center: [7.66, 45.94],               // [lon, lat]
  zoom: 12.5,
  statusUrl: 'https://…',              // facoltativo: pagina ufficiale impianti aperti
},
```

Tutti i dati (piste, impianti, parcheggi, rifugi) vengono scaricati automaticamente da OpenStreetMap.

## Struttura

| File | Contenuto |
| --- | --- |
| `js/resorts.js` | elenco comprensori |
| `js/osm.js` | download e lettura dati OpenStreetMap |
| `js/graph.js` | rete piste/impianti e calcolo del percorso |
| `js/offline.js` | salvataggio dati e mappe sul telefono |
| `js/app.js` | interfaccia e mappa (MapLibre GL) |
| `sw.js` | service worker per l'uso offline |
| `data/status/` | stato aperto/chiuso automatico (vedi LEGGIMI) |

Test: `npm test` (Node 20+).

## Fonti dei dati

Piste, impianti e parcheggi © contributori [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL).
Mappa: OpenTopoMap (CC-BY-SA). Rilievo: Terrain Tiles (AWS Open Data). Satellite: Esri.
I tempi sono stime e i dati possono contenere errori: segui sempre la segnaletica in pista.
