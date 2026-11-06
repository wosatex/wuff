# wuff! Berlin für Hunde

Eine PWA für Hundebesitzer in Berlin. Zeigt auf einen Blick, ob heute im Grunewald gesprengt wird,
dazu Auslaufgebiete, Hundebadestellen, Blaualgenwerte, Trinkbrunnen und Tierärzte.

Aufbau wie bei der Badestellen-App: eine statische Seite plus ein Skript, das die Daten zweimal
täglich holt. Läuft kostenlos über GitHub Actions und GitHub Pages, ohne eigenen Server.

```
scripts/build-data.mjs      holt alle Quellen, schreibt www/data/wuff.json
scripts/lib/wuff.mjs        Parser (Sprengtermine, OpenStreetMap) und gepflegte Listen
scripts/lib/badewasser.mjs  Lageso-Parser aus der Badestellen-App
www/                        die Seite, genau dieses Verzeichnis wird ausgeliefert
.github/workflows/          täglicher Datenabruf und Veröffentlichung
```

## Quellen

| Inhalt | Quelle | Wie |
|---|---|---|
| Sprengtermine | [Polizei Berlin, LKA KT](https://www.berlin.de/polizei/dienststellen/landeskriminalamt/lka-kriminaltechnik/artikel.1556143.php) | Seite wird ausgelesen, 2x täglich |
| Blaualgen | [Lageso, Messwerte als CSV](https://www.data.lageso.de/baden/00_History_gesamt/History.csv) | Chlorophyll a, ab 10 µg/l Warnung |
| Auslaufflächen, Trinkbrunnen, Tierärzte | OpenStreetMap über Overpass | `leisure=dog_park`, `amenity=drinking_water`, `amenity=veterinary` |
| Waldauslaufgebiete | [Berliner Forsten](https://www.berlin.de/forsten/walderlebnis/hundeauslauf-im-wald/) | von Hand gepflegt, Links auf die PDF-Karten |
| Hundebadestellen | Faltblatt Bezirksamt Steglitz-Zehlendorf | von Hand gepflegt |
| Hitze, Glätte, Unwetter | Deutscher Wetterdienst | live in der App, nur online |

Fällt eine Quelle aus, bleibt ihr letzter Stand stehen, die App zeigt dann oben einen Hinweis.
Findet das Skript auf der Polizeiseite plötzlich keine Termine mehr, obwohl vorher welche
anstanden, gilt das als Formatänderung: Der alte Stand bleibt, der Lauf meldet eine Warnung.

## Einrichten

1. Auf GitHub ein leeres Repo anlegen und diesen Ordner hineinpushen.
2. **Settings → Pages → Source: GitHub Actions** wählen.
3. **Actions → „wuff-Daten aktualisieren“ → Run workflow** für den ersten Lauf.

Danach läuft der Abruf jeden Morgen und jeden Nachmittag automatisch.

Lokal testen:

```bash
node scripts/build-data.mjs   # braucht Internet
cd www && python3 -m http.server 8080
```

## Pflegen

- Hundebadestellen und Waldauslaufgebiete stehen in `scripts/lib/wuff.mjs`.
- Nach Änderungen an `index.html`, `app.js`, `app.css` oder den Icons in `www/sw.js` die
  Versionsnummer hochzählen, sonst behalten installierte Handys die alte Fassung.

## Aufs Handy

**iPhone:** in Safari öffnen, Teilen, „Zum Home-Bildschirm“.
**Android:** in Chrome öffnen, Menü, „App installieren“.
