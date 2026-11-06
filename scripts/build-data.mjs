#!/usr/bin/env node
/**
 * wuff! – holt alle Quellen und schreibt www/data/wuff.json.
 * Läuft ohne Abhängigkeiten auf Node 18 oder neuer.
 *
 *   node scripts/build-data.mjs
 *   node scripts/build-data.mjs --spreng-file seite.html --berlin-file History.csv --osm-file osm.json
 *
 * Grundregel wie bei der Badestellen-App: Fällt eine Quelle aus, bleibt ihr letzter Stand stehen.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BE_CSV_URL, BE_SEITE, buildBerlinSites, parseNum } from "./lib/badewasser.mjs";
import {
  SPRENG_URL, OVERPASS_URL, OVERPASS_QUERY,
  parseSprengtermine, parseOverpass, slimBadestellen,
  FOREST_AREAS, FOREST_SOURCE, SCHLACHTENSEE_FLYER, DOG_SWIM, DOG_SWIM_NO,
} from "./lib/wuff.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };

const OUT = resolve(arg("--out") || resolve(ROOT, "www/data/wuff.json"));
const UA = "wuff-pwa/1.0 (privates Projekt; liest oeffentliche Daten einmal taeglich)";
const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), "WARN", ...a);

async function grab(url, { file, method = "GET", body, timeout = 30000, min = 300 } = {}) {
  if (file) return readFile(resolve(file), "utf8");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method, body, signal: ctl.signal, redirect: "follow",
      headers: { "user-agent": UA, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length < min) throw new Error(`nur ${text.length} Bytes`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

async function previous() {
  try { return existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")) : null; } catch { return null; }
}

/** Führt eine Quelle aus; bei Fehler oder Plausibilitätsproblem bleibt der alte Stand. */
async function source(key, prev, fn, check) {
  try {
    const data = await fn();
    const problem = check?.(data);
    if (problem) throw new Error(problem);
    log(`${key}: ok`);
    return { data, status: { ok: true, at: new Date().toISOString() } };
  } catch (e) {
    warn(`${key} fehlgeschlagen: ${e.message}`);
    return {
      data: prev?.[key] ?? null,
      status: { ok: false, at: prev?.sources?.[key]?.at || null, note: e.message },
    };
  }
}

async function main() {
  const prev = await previous();

  const spreng = await source("sprengungen", prev,
    async () => parseSprengtermine(await grab(SPRENG_URL, { file: arg("--spreng-file"), min: 1000 })),
    // Die Seite kann auch einmal keine Termine haben. Leer nur akzeptieren, wenn auch vorher leer war.
    (d) => (!d.length && prev?.sprengungen?.some((t) => t.date >= today()) ? "keine Termine gefunden, Seitenformat geändert?" : null),
  );

  const bade = await source("badestellen", prev,
    async () => slimBadestellen(buildBerlinSites(await grab(BE_CSV_URL, { file: arg("--berlin-file"), min: 500 })), parseNum),
    (d) => (d.length < 10 ? `nur ${d.length} Badestellen` : null),
  );

  const osm = await source("osm", prev,
    async () => parseOverpass(JSON.parse(await grab(OVERPASS_URL, {
      file: arg("--osm-file"), method: "POST", body: "data=" + encodeURIComponent(OVERPASS_QUERY), timeout: 150000,
    }))),
    (d) => (d.dogparks.length < 5 || d.vets.length < 20 ? `unplausibel wenig Daten (${d.dogparks.length} Auslaufflächen, ${d.vets.length} Tierärzte)` : null),
  );

  if (!spreng.data && !bade.data && !osm.data) {
    warn("Keine Quelle lieferte Daten und es gibt keinen alten Stand. Es wird nichts geschrieben.");
    process.exit(1);
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sources: {
      sprengungen: { ...spreng.status, url: SPRENG_URL },
      badestellen: { ...bade.status, url: BE_SEITE },
      osm: { ...osm.status, url: "https://www.openstreetmap.org/copyright" },
    },
    sprengungen: spreng.data || [],
    badestellen: bade.data || [],
    osm: osm.data || { dogparks: [], water: [], vets: [] },
    wald: { areas: FOREST_AREAS, src: FOREST_SOURCE, flyer: SCHLACHTENSEE_FLYER },
    hundebaden: { ja: DOG_SWIM, nein: DOG_SWIM_NO },
  };

  const json = JSON.stringify(payload);
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT + ".tmp", json, "utf8");
  await rename(OUT + ".tmp", OUT);
  log(`geschrieben: ${OUT} (${(json.length / 1024).toFixed(0)} KB)`);
}

function today() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());
}

main().catch((e) => { console.error("FEHLER", e); process.exit(1); });
