/* Badewasser — gemeinsame Parse- und Bewertungslogik (Node, ohne Abhängigkeiten) */

export const BE_CSV_URL = "https://www.data.lageso.de/baden/00_History_gesamt/History.csv";
export const BE_SEITE = "https://www.berlin.de/lageso/gesundheit/gesundheitsschutz/badegewaesser/liste-der-badestellen/";
export const BB_KML_URL = "https://badestellen.brandenburg.de/web/badestellen/badestellen/-/export/badestellen.kml";
export const BB_SEITE = "https://badestellen.brandenburg.de/";
export const bbDetail = (nr) => `https://badestellen.brandenburg.de/badestelle/-/details/${nr}`;

/* ---------------------------- Grundlagen --------------------------- */

const ENT = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü",
  szlig: "ß", deg: "°", ndash: "–", mdash: "—", bdquo: "„", ldquo: "“",
  rdquo: "”", sbquo: "‚", lsquo: "‘", rsquo: "’", hellip: "…", micro: "µ",
};

export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => (n in ENT ? ENT[n] : m));
}

const stripTags = (s) => decodeEntities(String(s ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

export function parseNum(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || /^n\.?\s?a\.?$/i.test(s) || s === "-") return null;
  const m = s.match(/^([<>])?\s*([\d.,]+)/);
  if (!m) return null;
  const num = parseFloat(m[2].replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  if (!isFinite(num)) return null;
  return { value: num, qual: m[1] || "=", raw: s };
}

export function sightValue(p) {
  if (!p) return null;
  if (p.qual === "<") return p.value * 0.9;
  if (p.qual === ">") return p.value * 1.1;
  return p.value;
}

export function parseDeDate(s) {
  const m = String(s ?? "").trim().match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`; // ISO, damit sich das im Browser sauber sortiert
}

export function hasText(s) {
  const t = String(s ?? "").trim();
  return !!t && t !== "-" && !/^keine$/i.test(t) && !/^n\.?\s?a\.?$/i.test(t);
}

export function normColor(farbe) {
  const f = String(farbe ?? "").trim().toLowerCase();
  if (f.startsWith("gruen") || f.startsWith("grün")) return "gruen";
  if (f.startsWith("gelb")) return "gelb";
  if (f.startsWith("rot")) return "rot";
  return "unbekannt";
}

/* ----------------------------- Bewertung --------------------------- */

export const ZONES = [
  { key: "abgeraten", from: 0, to: 35, label: "Abgeraten", verb: "Baden wird nicht empfohlen", c: "#A32C2C" },
  { key: "eing", from: 35, to: 55, label: "Eingeschränkt", verb: "Nur mit Vorbehalt baden", c: "#C4652A" },
  { key: "mittel", from: 55, to: 70, label: "Mittel", verb: "Baden möglich, Wasser auffällig", c: "#D99A21" },
  { key: "gut", from: 70, to: 85, label: "Gut", verb: "Unbedenklich baden", c: "#7A9E37" },
  { key: "sehrgut", from: 85, to: 100, label: "Sehr gut", verb: "Rein damit", c: "#137360" },
];

export function zoneKey(score) {
  if (score == null) return "keine";
  for (let i = ZONES.length - 1; i >= 0; i--) if (score >= ZONES[i].from) return ZONES[i].key;
  return "abgeraten";
}

export const CAP = { gruen: 100, gelb: 58, rot: 25, unbekannt: null };
const FLOOR = { gruen: 40, gelb: 20, rot: 0, unbekannt: 0 };

export function scoreRow(row) {
  const pe = parseNum(row.ecoli), pi = parseNum(row.entero), pc = parseNum(row.colif);
  const ps = parseNum(row.sicht), pa = parseNum(row.chla);
  const ec = pe?.value ?? null, ie = pi?.value ?? null, cb = pc?.value ?? null;
  const st = sightValue(ps), chla = pa?.value ?? null;
  const color = normColor(row.farbe);
  const reasons = [];
  let score = 100;

  if (ec != null) {
    let p = ec > 1800 ? 48 : ec > 1000 ? 28 : ec > 500 ? 14 : ec > 100 ? 4 : 0;
    if (p >= 14) reasons.push({ w: p, t: `Erhöhte E.-coli-Werte (${row.ecoli} KBE/100 ml)` });
    else if (p > 0) reasons.push({ w: p, t: `Leicht erhöhte E.-coli-Werte (${row.ecoli} KBE/100 ml)` });
    score -= p;
  }
  if (ie != null) {
    let p = ie > 700 ? 48 : ie > 400 ? 28 : ie > 200 ? 14 : ie > 50 ? 4 : 0;
    if (p >= 14) reasons.push({ w: p, t: `Erhöhte Enterokokken (${row.entero} KBE/100 ml)` });
    else if (p > 0) reasons.push({ w: p, t: `Leicht erhöhte Enterokokken (${row.entero} KBE/100 ml)` });
    score -= p;
  }
  if (cb != null) {
    const p = cb > 5000 ? 7 : cb > 1000 ? 3 : 0;
    if (p > 0) reasons.push({ w: p, t: `Erhöhte coliforme Bakterien (${row.colif} KBE/100 ml)` });
    score -= p;
  }
  if (chla != null) {
    const p = chla >= 100 ? 42 : chla >= 40 ? 26 : chla >= 20 ? 14 : chla >= 10 ? 6 : 0;
    if (p >= 26) reasons.push({ w: p, t: `Blaualgenblüte (${row.chla} µg/l Chlorophyll a)` });
    else if (p > 0) reasons.push({ w: p, t: `Vermehrt Blaualgen (${row.chla} µg/l Chlorophyll a)` });
    score -= p;
  }
  if (st != null) {
    const p = st < 0.5 ? 18 : st < 1 ? 8 : st < 1.5 ? 2 : 0;
    if (p >= 18) reasons.push({ w: p, t: `Sehr trübes Wasser (Sichttiefe ${row.sicht} m)` });
    else if (p > 0) reasons.push({ w: p, t: `Eingeschränkte Sicht (Sichttiefe ${row.sicht} m)` });
    score -= p;
  }
  if (hasText(row.warn)) { score -= 18; reasons.push({ w: 18, t: "Amtlicher Warnhinweis" }); }
  if (hasText(row.info) && /vermehrt blaualgen|trüben|erschwert|nachkontrollen|verschmutzung/i.test(row.info)) {
    score -= 5; reasons.push({ w: 5, t: "Amtlicher Hinweis zum Zustand" });
  }

  const cap = CAP[color];
  if (cap == null) return { score: null, color, capped: false, reasons, sicht: st };
  let capped = false;
  if (score > cap) { score = cap; capped = true; }
  if (score < FLOOR[color]) score = FLOOR[color];
  score = Math.max(0, Math.min(100, Math.round(score)));
  reasons.sort((a, b) => b.w - a.w);
  return { score, color, capped, reasons, sicht: st };
}

/* --------------------------- Berlin: CSV --------------------------- */

export function parseBerlinCSV(text) {
  const lines = String(text).replace(/\r/g, "").split("\n").filter((l) => l.trim().length);
  if (!/BadName/.test(lines[0] || "")) throw new Error("Berlin: unerwarteter CSV-Kopf");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(";");
    if (c.length < 11) continue;
    const iso = parseDeDate(c[1]);
    if (!iso) continue;
    rows.push({
      name: c[0].trim(), date: iso,
      ecoli: c[2].trim(), entero: c[3].trim(), colif: c[4].trim(),
      sicht: c[5].trim(), chla: c[6].trim(), temp: c[7].trim(),
      warn: c[8].trim(), info: c[9].trim(), farbe: c[10].trim(),
    });
  }
  if (rows.length < 20) throw new Error(`Berlin: nur ${rows.length} Zeilen gelesen`);
  return rows;
}

export const BE_META = {
  "Sandhauser Straße": { g: "Havel · Spandau", lat: 52.5578, lon: 13.2075 },
  "Bürgerablage": { g: "Havel · Spandau", lat: 52.5624, lon: 13.213 },
  "Tegeler See, Strandbad": { g: "Tegeler See", lat: 52.5836, lon: 13.262 },
  "Tegeler See, gegenüber Scharfenberg": { g: "Tegeler See", lat: 52.59, lon: 13.2545 },
  "Tegeler See, gegenüber Reiswerder": { g: "Tegeler See", lat: 52.5866, lon: 13.2503 },
  "Tegeler See, Saatwinkel": { g: "Tegeler See", lat: 52.5716, lon: 13.2565 },
  "Tegeler See, Reiherwerder": { g: "Tegeler See", lat: 52.5878, lon: 13.2676 },
  "Kleine Badewiese": { g: "Unterhavel · Grunewald", lat: 52.4869, lon: 13.1907 },
  "Grunewaldturm": { g: "Unterhavel · Grunewald", lat: 52.493, lon: 13.1936 },
  "Lieper Bucht": { g: "Unterhavel · Grunewald", lat: 52.4826, lon: 13.1866 },
  "Radfahrerwiese": { g: "Unterhavel · Grunewald", lat: 52.47, lon: 13.183 },
  "Breitehorn": { g: "Unterhavel · Wannsee", lat: 52.4563, lon: 13.1747 },
  "Große Steinlanke": { g: "Unterhavel · Wannsee", lat: 52.4402, lon: 13.1781 },
  "Alter Hof": { g: "Unterhavel · Wannsee", lat: 52.4341, lon: 13.1836 },
  "Wannsee, Strandbad": { g: "Großer Wannsee", lat: 52.4356, lon: 13.1783 },
  "Teufelssee": { g: "Teufelssee · Grunewald", lat: 52.4752, lon: 13.234 },
  "Krumme Lanke": { g: "Krumme Lanke · Zehlendorf", lat: 52.4404, lon: 13.234 },
  "Schlachtensee": { g: "Schlachtensee · Zehlendorf", lat: 52.4381, lon: 13.2132 },
  "Kleiner Müggelsee": { g: "Kleiner Müggelsee · Köpenick", lat: 52.4401, lon: 13.618 },
  "Müggelsee, Strandbad": { g: "Großer Müggelsee · Rahnsdorf", lat: 52.4342, lon: 13.652 },
  "Friedrichshagen, Strandbad": { g: "Großer Müggelsee · Friedrichshagen", lat: 52.4468, lon: 13.6272 },
  "Schmöckwitz": { g: "Zeuthener See · Schmöckwitz", lat: 52.3727, lon: 13.6424 },
  "Seddinsee": { g: "Seddinsee · Schmöckwitz", lat: 52.3806, lon: 13.6603 },
  "Große Krampe": { g: "Große Krampe · Müggelheim", lat: 52.4021, lon: 13.648 },
  "Bammelecke": { g: "Langer See · Schmöckwitz", lat: 52.3903, lon: 13.642 },
  "Grünau, Strandbad": { g: "Langer See · Grünau", lat: 52.4133, lon: 13.5763 },
  "Wendenschloss, Strandbad": { g: "Langer See · Köpenick", lat: 52.4328, lon: 13.578 },
  "Gartenstraße, Flussbad": { g: "Müggelspree · Köpenick", lat: 52.456, lon: 13.582 },
  "Dämeritzsee": { g: "Dämeritzsee · Rahnsdorf", lat: 52.4288, lon: 13.682 },
  "Orankesee, Strandbad": { g: "Orankesee · Hohenschönhausen", lat: 52.5528, lon: 13.4702 },
  "Weißensee, Strandbad": { g: "Weißer See · Weißensee", lat: 52.556, lon: 13.4642 },
  "Plötzensee, Strandbad": { g: "Plötzensee · Wedding", lat: 52.5443, lon: 13.3352 },
  "Flughafensee": { g: "Flughafensee · Tegel", lat: 52.5718, lon: 13.3022 },
  "Jungfernheide, Strandbad": { g: "Jungfernheidesee · Charlottenburg", lat: 52.539, lon: 13.276 },
  "Heiligensee, Strandbad": { g: "Heiligensee · Reinickendorf", lat: 52.6048, lon: 13.2352 },
  "Lübars, Strandbad (Ziegeleisee)": { g: "Ziegeleisee · Lübars", lat: 52.61, lon: 13.3618 },
  "Halensee, Strandbad": { g: "Halensee · Wilmersdorf", lat: 52.493, lon: 13.29 },
  "Groß Glienicker See, nördlich": { g: "Groß Glienicker See · Kladow", lat: 52.4702, lon: 13.1128 },
  "Groß Glienicker See, südlich": { g: "Groß Glienicker See · Kladow", lat: 52.4632, lon: 13.113 },
};

export function buildBerlinSites(csvText) {
  const rows = parseBerlinCSV(csvText);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.name)) by.set(r.name, []);
    by.get(r.name).push(r);
  }
  const sites = [];
  for (const [name, rs] of by) {
    rs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const last = rs[rs.length - 1];
    const s = scoreRow(last);
    const meta = BE_META[name] || { g: "Berlin", lat: null, lon: null };
    sites.push({
      id: "BE:" + name, land: "BE", name, gew: meta.g, lat: meta.lat, lon: meta.lon,
      date: last.date, score: s.score, zone: zoneKey(s.score), color: s.color,
      capped: s.capped, reasons: s.reasons, sichtM: s.sicht,
      values: {
        ecoli: last.ecoli, entero: last.entero, colif: last.colif,
        sicht: last.sicht, chla: last.chla, temp: last.temp,
      },
      warn: hasText(last.warn) ? last.warn : "",
      info: hasText(last.info) ? last.info : "",
      history: rs.map((r) => ({ d: r.date, s: scoreRow(r).score })),
      url: BE_SEITE,
    });
  }
  return sites;
}

/* ------------------------ Brandenburg: KML ------------------------- */

const levelOf = (s) => {
  const m = String(s ?? "").match(/level([1-5])/i);
  return m ? +m[1] : null;
};

export function buildBrandenburgSites(kmlText) {
  const txt = String(kmlText);
  if (!/<Placemark/i.test(txt)) throw new Error("Brandenburg: kein Placemark im KML");

  // Ampel-Icons aus den Stil-Definitionen
  const styleLevel = {};
  for (const m of txt.matchAll(/<Style\b[^>]*\bid="([^"]+)"([\s\S]*?)<\/Style>/gi)) {
    const lvl = levelOf(m[2]) ?? levelOf(m[1]);
    if (lvl) styleLevel["#" + m[1]] = lvl;
  }
  for (const m of txt.matchAll(/<StyleMap\b[^>]*\bid="([^"]+)"([\s\S]*?)<\/StyleMap>/gi)) {
    const ref = (m[2].match(/<styleUrl>\s*([^<]+?)\s*<\/styleUrl>/i) || [])[1];
    if (ref && styleLevel[ref.trim()]) styleLevel["#" + m[1]] = styleLevel[ref.trim()];
  }

  const one = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return m ? m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim() : "";
  };

  const sites = [];
  for (const pm of txt.match(/<Placemark\b[\s\S]*?<\/Placemark>/gi) || []) {
    const rawName = decodeEntities(one(pm, "name"));
    if (!rawName) continue;

    const coords = one(pm, "coordinates").split(",").map((x) => parseFloat(x));
    const lon = Number.isFinite(coords[0]) ? +coords[0].toFixed(5) : null;
    const lat = Number.isFinite(coords[1]) ? +coords[1].toFixed(5) : null;

    const styleUrl = one(pm, "styleUrl").trim();
    const desc = one(pm, "description");
    const lvl = styleLevel[styleUrl] ?? levelOf(styleUrl) ?? levelOf(desc) ?? levelOf(pm);

    let date = "", temp = "", sicht = "", bem = "", nr = null;
    if (desc) {
      const dm = desc.match(/class="[^"]*lastMeasurementDate[^"]*"[^>]*>([\s\S]*?)</i);
      date = parseDeDate(dm ? dm[1] : desc) || "";
      for (const p of desc.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/gi)) {
        const k = stripTags(p[1]).toLowerCase(), v = stripTags(p[2]);
        if (k.startsWith("temp")) temp = v;
        else if (k.startsWith("sicht")) sicht = v;
        else if (k.startsWith("bemerk")) bem = v;
      }
      const nm = desc.match(/details\/(\d+)/);
      if (nm) nr = +nm[1];
    }

    const komma = rawName.lastIndexOf(", ");
    const name = komma > 0 ? rawName.slice(0, komma) : rawName;
    const gew = komma > 0 ? rawName.slice(komma + 2) : "";
    const ps = parseNum(sicht);

    sites.push({
      id: "BB:" + (nr ?? rawName), land: "BB", name, gew, nr, lat, lon,
      date, lvl: lvl ?? null, temp, sicht,
      sichtM: ps ? +sightValue(ps).toFixed(2) : null,
      bem: hasText(bem) ? bem : "",
      url: nr ? bbDetail(nr) : BB_SEITE,
    });
  }
  if (sites.length < 20) throw new Error(`Brandenburg: nur ${sites.length} Badestellen gelesen`);
  return sites;
}
