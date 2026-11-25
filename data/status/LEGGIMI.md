# Stato aperto/chiuso automatico

L'app, quando è online, prova a leggere `data/status/<id-comprensorio>.json`.
Il file viene usato solo se `updated` è di oggi.

```json
{
  "updated": "2026-12-20T08:15:00+01:00",
  "source": "https://www.cimonesci.it/impianti-aperti",
  "lifts":  { "Seggiovia Cimoncino": "open", "Pian del Falco": "closed" },
  "pistes": { "Direttissima": "closed", "5": "open" }
}
```

- Le chiavi sono i nomi (o i numeri) di impianti e piste come in OpenStreetMap;
  maiuscole, accenti e punteggiatura vengono ignorati nel confronto.
- I valori sono `open` oppure `closed`.
- Le scelte fatte a mano nell'app (scheda "Piste") hanno la precedenza e valgono solo per il giorno in cui le fai.

Il passo successivo è uno script automatico (GitHub Actions) che ogni 15 minuti
legge il sito ufficiale e aggiorna questi file.
