/* wuff! – Parser für alle Quellen. Reine Funktionen, damit sie ohne Netz testbar sind. */

export const SPRENG_URL =
  "https://www.berlin.de/polizei/dienststellen/landeskriminalamt/lka-kriminaltechnik/artikel.1556143.php";
export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/* ------------------------------------------------------------------ */
/* Sprengtermine Polizei Berlin                                        */
/* ------------------------------------------------------------------ */

const ENT = { "&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">", "&ndash;": "–", "&mdash;": "—" };

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENT[e.toLowerCase()] ?? " ")
    .replace(/[ \t ]+/g, " ");
}

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (s) => {
  if (!s) return null;
  const [h, m] = s.split(/[:.]/);
  return `${pad(+h)}:${pad(+m)}`;
};

/**
 * Liest die Termine aus der Polizeiseite.
 * Format auf der Seite: „Mittwoch, 11.11.2026, 09:00 bis 14:00 Uhr“.
 * Zeilen mit „entfällt“, „abgesagt“ o. ä. werden als abgesagt markiert.
 */
export function parseSprengtermine(html) {
  let text = htmlToText(html);
  // Nur den Terminblock lesen, damit kein Seitendatum o. ä. als Termin gilt
  const start = text.search(/Termine\s+sind\s+(bislang\s+)?(vorgesehen|geplant)/i);
  if (start >= 0) text = text.slice(start);
  const end = text.search(/Weitere Termine werden|Polizei Berlin\s*\n|Weitere Informationen zu diesem/i);
  if (end > 0) text = text.slice(0, end);

  const out = [];
  const seen = new Set();
  for (const line of text.split("\n")) {
    const re = /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[^\d\n]{0,12}(\d{1,2}[:.]\d{2})\s*(?:Uhr)?\s*(?:bis|-|–)\s*(\d{1,2}[:.]\d{2}))?/g;
    let m;
    while ((m = re.exec(line))) {
      const [, d, mo, y, von, bis] = m;
      const date = `${y}-${pad(+mo)}-${pad(+d)}`;
      if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || seen.has(date)) continue;
      seen.add(date);
      out.push({
        date,
        from: hhmm(von),
        to: hhmm(bis),
        cancelled: /entf[äa]llt|abgesagt|f[äa]llt aus|verschoben/i.test(line),
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/* ------------------------------------------------------------------ */
/* OpenStreetMap über Overpass                                          */
/* ------------------------------------------------------------------ */

export const OVERPASS_QUERY = `
[out:json][timeout:120];
area["ISO3166-2"="DE-BE"]["admin_level"="4"]->.b;
(
  nwr["leisure"="dog_park"](area.b);
)->.dog;
(
  node["amenity"="drinking_water"](area.b);
  node["man_made"="water_tap"]["drinking_water"="yes"](area.b);
)->.wat;
(
  nwr["amenity"="veterinary"](area.b);
)->.vet;
.dog out geom;
.wat out;
.vet out center;
`;

const r5 = (x) => Math.round(x * 1e5) / 1e5;

function thin(ring, max = 120) {
  if (ring.length <= max) return ring;
  const step = Math.ceil(ring.length / max);
  const out = ring.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== ring[ring.length - 1]) out.push(ring[ring.length - 1]);
  return out;
}

function ringOf(geom) {
  return thin((geom || []).filter((p) => p && isFinite(p.lat)).map((p) => [r5(p.lat), r5(p.lon)]));
}

function centroid(rings) {
  let lat = 0, lon = 0, n = 0;
  for (const r of rings) for (const [a, b] of r) { lat += a; lon += b; n++; }
  return n ? [r5(lat / n), r5(lon / n)] : null;
}

/** Fläche eines Rings in Hektar (Näherung, reicht für „klein/groß“) */
function hectares(ring) {
  if (ring.length < 3) return 0;
  const R = 6371000, p = Math.PI / 180;
  const lat0 = ring[0][0] * p;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [a1, b1] = ring[i], [a2, b2] = ring[(i + 1) % ring.length];
    const x1 = b1 * p * R * Math.cos(lat0), y1 = a1 * p * R;
    const x2 = b2 * p * R * Math.cos(lat0), y2 = a2 * p * R;
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2 / 10000;
}

const tagsOf = (el) => el.tags || {};

export function parseOverpass(json) {
  const els = json?.elements || [];
  const dogparks = [], water = [], vets = [];

  for (const el of els) {
    const t = tagsOf(el);

    if (t.leisure === "dog_park") {
      let rings = [];
      if (el.type === "way") rings = [ringOf(el.geometry)];
      else if (el.type === "relation") {
        rings = (el.members || [])
          .filter((m) => m.role !== "inner" && m.geometry)
          .map((m) => ringOf(m.geometry));
      }
      rings = rings.filter((r) => r.length >= 3);
      const c = el.type === "node" ? [r5(el.lat), r5(el.lon)] : centroid(rings);
      if (!c) continue;
      const ha = rings.reduce((a, r) => a + hectares(r), 0);
      dogparks.push({
        id: `${el.type[0]}${el.id}`,
        name: t.name || "",
        c,
        rings,
        ha: Math.round(ha * 10) / 10,
        fenced: t.barrier === "fence" || t.fence === "yes" ? true : t.fence === "no" ? false : null,
      });
      continue;
    }

    if (t.amenity === "drinking_water" || t.man_made === "water_tap") {
      if (!isFinite(el.lat)) continue;
      water.push({
        c: [r5(el.lat), r5(el.lon)],
        name: t.name || "",
        // Viele Berliner Trinkbrunnen sind im Winter abgestellt
        seasonal: t.seasonal && t.seasonal !== "no" ? t.seasonal : null,
      });
      continue;
    }

    if (t.amenity === "veterinary") {
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (!isFinite(lat)) continue;
      const oh = t.opening_hours || "";
      vets.push({
        id: `${el.type[0]}${el.id}`,
        name: t.name || "Tierarztpraxis",
        c: [r5(lat), r5(lon)],
        phone: t.phone || t["contact:phone"] || "",
        web: t.website || t["contact:website"] || "",
        addr: [t["addr:street"] && `${t["addr:street"]} ${t["addr:housenumber"] || ""}`.trim(), t["addr:postcode"]]
          .filter(Boolean).join(", "),
        oh,
        h24: /^\s*24\/7\s*$/.test(oh),
        emergency: t.emergency === "yes" || /notdienst|notfall|klinik/i.test(t.name || ""),
      });
    }
  }

  dogparks.sort((a, b) => b.ha - a.ha);
  vets.sort((a, b) => Number(b.h24) - Number(a.h24) || a.name.localeCompare(b.name, "de"));
  return { dogparks, water, vets };
}

/* ------------------------------------------------------------------ */
/* Badestellen: nur, was für Hunde zählt                               */
/* ------------------------------------------------------------------ */

/** Blaualgen-Risiko aus Chlorophyll a (µg/l), gleiche Schwellen wie in der Badestellen-App */
export function dogRisk(chla) {
  if (chla == null || !isFinite(chla)) return "unbekannt";
  if (chla >= 40) return "hoch";
  if (chla >= 10) return "erhoeht";
  return "gering";
}

export function slimBadestellen(sites, parseNum) {
  return sites.map((s) => {
    const chla = parseNum(s.values?.chla)?.value ?? null;
    return {
      id: s.id,
      name: s.name,
      gew: s.gew,
      c: [s.lat, s.lon],
      date: s.date,
      chla,
      risk: dogRisk(chla),
      warn: s.warn || "",
    };
  });
}

/* ------------------------------------------------------------------ */
/* Kuratierte Inhalte (ändern sich selten, bei Bedarf hier pflegen)     */
/* ------------------------------------------------------------------ */

const F = "https://www.berlin.de/forsten/_assets/walderlebnis/hundeauslauf-im-wald/";
export const FOREST_SOURCE = "https://www.berlin.de/forsten/walderlebnis/hundeauslauf-im-wald/";

export const FOREST_AREAS = [
  { name: "Grunewald", note: "Größtes Auslaufgebiet Berlins, mit Hundebadestelle am Grunewaldsee", pdf: F + "hundeauslaufgebiet_grunewald.pdf" },
  { name: "Wannsee-Düppel", pdf: F + "hundeauslaufgebiet_wannsee_dueppel.pdf" },
  { name: "Düppel", pdf: F + "hundeauslaufgebiet_dueppel.pdf" },
  { name: "Jungfernheide", pdf: F + "hundeauslaufgebiet_jungfernheide.pdf" },
  { name: "Hakenfelde", pdf: F + "hundeauslaufgebiet_hakenfelde.pdf" },
  { name: "Pichelswerder", pdf: F + "hundeauslaufgebiet_pichelswerder.pdf" },
  { name: "Kladow", pdf: F + "hundeauslaufgebiet_kladow.pdf" },
  { name: "Frohnau", pdf: F + "hundeauslaufgebiet_frohnau.pdf" },
  { name: "Blankenfelde", pdf: F + "hundeauslaufgebiet_blankenfelde.pdf" },
];

export const SCHLACHTENSEE_FLYER = F + "flyer_hundeauslaufgebiet.pdf";

/** Amtlich belegte Hundebadestellen. Eine Gesamtliste veröffentlicht Berlin nicht. */
export const DOG_SWIM = [
  {
    name: "Grunewaldsee",
    c: [52.47, 13.259],
    note: "Hunde dürfen baden, Menschen nicht. Liegt im Hundeauslaufgebiet Grunewald.",
    src: "https://www.berlin.de/ba-steglitz-zehlendorf/politik-und-verwaltung/aemter/strassen-und-gruenflaechenamt/gruenflaechen/ueber-uns/hundeflyer.pdf",
  },
];

export const DOG_SWIM_NO = [
  { name: "Schlachtensee", note: "Baden für Hunde und Mitführen auf dem Uferweg verboten" },
  { name: "Krumme Lanke", note: "Baden für Hunde und Mitführen auf dem Uferweg verboten" },
];
