/* wuff! Berlin für Hunde — Oberfläche.
   Alle Daten außer den Wetterwarnungen kommen fertig aus data/wuff.json,
   das eine GitHub Action jeden Morgen neu schreibt. */

const DATA_URL = "data/wuff.json";
const DWD_URL = "https://www.dwd.de/DWD/warnungen/warnapp/json/warnings.json";
const MONTHS = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
const DAYS = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
const RISK = {
  hoch: { label: "Blaualgen stark erhöht", c: "#A32C2C", cls: "bad" },
  erhoeht: { label: "Blaualgen erhöht", c: "#C4652A", cls: "mid" },
  gering: { label: "Blaualgen unauffällig", c: "#137360", cls: "" },
  unbekannt: { label: "Kein Blaualgenwert", c: "#7E8F97", cls: "" },
};
const LAYER_DEF = {
  auslauf: { label: "Auslaufflächen", c: "#3F7D3A" },
  wasser: { label: "Trinkbrunnen", c: "#2A6FB0" },
  tierarzt: { label: "Tierärzte", c: "#A32C2C" },
  baden: { label: "Badestellen", c: "#0D5C63" },
};

let DATA = null;
let WARN = null; // DWD-Warnungen für Berlin, null = nicht geladen
const state = { tab: "karte", geo: null, geoState: "idle", layers: { auslauf: true, wasser: false, tierarzt: false, baden: false } };
let map = null, groups = {}, meMarker = null;

/* ------------------------------ Helfer ----------------------------- */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

/** Heute in Berlin als JJJJ-MM-TT, unabhängig von der Zeitzone des Geräts */
const berlinIso = (d = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(d);
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);

function fmtDay(iso, withWeekday = true) {
  const d = new Date(iso + "T12:00:00Z");
  const s = `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}`;
  return withWeekday ? `${DAYS[d.getUTCDay()]}, ${s}` : s;
}
const shortTime = (t) => (t ? t.replace(/^0/, "").replace(/:00$/, "") : "");
const timeRange = (t) => (t.from && t.to ? `${shortTime(t.from)} bis ${shortTime(t.to)} Uhr` : "Uhrzeit nicht angegeben");

function agoLabel(isoTs) {
  const mins = Math.round((Date.now() - Date.parse(isoTs)) / 60000);
  if (!isFinite(mins)) return "";
  if (mins < 60) return "vor wenigen Minuten";
  const h = Math.round(mins / 60);
  if (h < 24) return `vor ${h} ${h === 1 ? "Stunde" : "Stunden"}`;
  const d = Math.round(h / 24);
  return `vor ${d} ${d === 1 ? "Tag" : "Tagen"}`;
}

function distKm([a, b], [c, d]) {
  const R = 6371, p = Math.PI / 180;
  const x = (c - a) * p, y = (d - b) * p;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin(y / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 10) * 100} m` : `${km.toFixed(km < 10 ? 1 : 0).replace(".", ",")} km`);
const distTag = (c) => (state.geo ? `<span class="tag">${fmtKm(distKm(state.geo, c))}</span>` : "");
const byDist = (arr, get = (x) => x.c) => (state.geo ? [...arr].sort((a, b) => distKm(state.geo, get(a)) - distKm(state.geo, get(b))) : arr);

/* -------------------- Öffnungszeiten (vereinfacht) ------------------
 * Versteht die häufigen OSM-Formen „24/7“ und „Mo-Fr 09:00-18:00; Sa 10:00-13:00“.
 * Alles andere ergibt null = unbekannt, damit die App nie falsch „geöffnet“ sagt. */

const OH_DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
function openNow(oh, now = new Date()) {
  if (!oh) return null;
  if (/^\s*24\/7\s*$/.test(oh)) return true;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).reduce((o, p) => ((o[p.type] = p.value), o), {});
  const day = OH_DAYS.indexOf(parts.weekday.slice(0, 2));
  const mins = +parts.hour * 60 + +parts.minute;
  let open = false;
  for (const rule of oh.split(";").map((r) => r.trim()).filter(Boolean)) {
    const m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?\s*)+)\s+(.+)$/);
    if (!m) return null; // PH, Monatsangaben, Kommentare: lieber nichts behaupten
    const days = new Set();
    for (const seg of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const [a, b] = seg.split("-").map((x) => OH_DAYS.indexOf(x));
      if (a < 0) return null;
      if (b == null || b < 0) days.add(a);
      else for (let i = a; ; i = (i + 1) % 7) { days.add(i); if (i === b) break; }
    }
    if (!days.has(day)) continue;
    const times = m[2].trim();
    if (/^off|closed$/i.test(times)) { open = false; continue; }
    let any = false;
    for (const span of times.split(",")) {
      const t = span.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
      if (!t) return null;
      const from = +t[1] * 60 + +t[2], to = +t[3] * 60 + +t[4];
      if (to > from ? mins >= from && mins < to : mins >= from || mins < to) any = true;
    }
    open = any; // spätere Regeln überschreiben frühere, wie in der OSM-Spezifikation
  }
  return open;
}

/* ------------------------------ Laden ------------------------------ */

async function load(force) {
  $("refresh").disabled = true;
  try {
    const res = await fetch(DATA_URL + (force ? `?t=${Date.now()}` : ""), { cache: force ? "no-store" : "default" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
    render();
  } catch (e) {
    $("stand").textContent = "Daten konnten nicht geladen werden.";
    $("banners").innerHTML = `<p class="banner bad">Keine Verbindung und noch kein gespeicherter Stand. Bitte später erneut öffnen.</p>`;
  } finally {
    $("refresh").disabled = false;
  }
  loadWarnings();
}

/* DWD liefert JSONP. Ein Script-Tag umgeht CORS, das Ergebnis landet in warnWetter.loadWarnings. */
function loadWarnings() {
  window.warnWetter = {
    loadWarnings(d) {
      const all = Object.entries(d?.warnings || {}).filter(([cell]) => cell.startsWith("111")).flatMap(([, w]) => w);
      const seen = new Set();
      const now = Date.now(), soon = now + 12 * 3600000;
      WARN = all
        // Nur, was für Hunde zählt. Bloßer Frost ist ausgenommen: Den warnt der DWD schon bei leichtem
        // Nachtfrost, für Pfoten relevant wird es erst bei Glätte, weil dann gestreut wird.
        // Sturm und Gewitter erst ab Unwetterstufe (3).
        .filter((w) => /HITZE|GLÄTTE|GLATTEIS/i.test(w.event || "") || (/UNWETTER|ORKAN|GEWITTER|STURM/i.test(w.event || "") && (w.level || 0) >= 3))
        // Gilt schon oder beginnt in den nächsten 12 Stunden, und ist noch nicht vorbei
        .filter((w) => (!w.start || w.start <= soon) && (!w.end || w.end > now))
        .filter((w) => !seen.has(w.event) && seen.add(w.event))
        .map((w) => ({ event: w.event, headline: w.headline, desc: w.description, start: w.start, end: w.end, level: w.level }));
      renderToday();
    },
  };
  const s = document.createElement("script");
  s.src = DWD_URL + "?t=" + Math.floor(Date.now() / 600000);
  s.onerror = () => { WARN = null; };
  s.onload = () => s.remove();
  document.head.appendChild(s);
}

/* ------------------------------ Rendern ---------------------------- */

function render() {
  renderHead();
  renderToday();
  renderChips();
  renderPane();
  renderSources();
}

function renderHead() {
  const age = DATA.generatedAt ? `Stand ${agoLabel(DATA.generatedAt)}` : "";
  $("stand").textContent = `${age} · Termine, Messwerte und Karten werden jeden Morgen neu geholt`;
  const stale = Object.entries(DATA.sources || {}).filter(([, s]) => !s.ok);
  const names = { sprengungen: "Sprengtermine", badestellen: "Badestellen", osm: "Kartendaten" };
  $("banners").innerHTML = stale.length
    ? `<p class="banner">${stale.map(([k]) => names[k] || k).join(", ")}: letzter Abruf fehlgeschlagen, angezeigt wird der vorherige Stand.</p>`
    : "";
}

function renderToday() {
  if (!DATA) return;
  const today = berlinIso();
  const termine = (DATA.sprengungen || []).filter((t) => t.date >= today);
  const t0 = termine.find((t) => t.date === today && !t.cancelled);
  const t1 = termine.find((t) => t.date === addDays(today, 1) && !t.cancelled);
  const next = termine.find((t) => !t.cancelled && t.date > today);
  const src = DATA.sources?.sprengungen?.url;

  let spreng;
  if (t0) {
    spreng = `<article class="alert red">
      <p class="alert-kicker">Heute · ${esc(timeRange(t0))}</p>
      <h2>Sprengungen im Grunewald</h2>
      <p>Auf dem Sprengplatz in Nikolassee wird gesprengt. Die Detonationen sind weit über den Platz hinaus zu hören,
         auch im Hundeauslaufgebiet. Hunde können sich stark erschrecken.</p>
      <p class="alert-tip">Besser heute auf ein anderes Auslaufgebiet ausweichen, etwa Jungfernheide, Frohnau oder Kladow.</p>
    </article>`;
  } else if (t1) {
    spreng = `<article class="alert amber">
      <p class="alert-kicker">Morgen · ${esc(fmtDay(t1.date))} · ${esc(timeRange(t1))}</p>
      <h2>Morgen Sprengungen im Grunewald</h2>
      <p>Heute ist es im Grunewald ruhig. Für morgen den Spaziergang am besten woanders planen.</p>
    </article>`;
  } else {
    spreng = `<article class="alert calm">
      <p class="alert-kicker">Heute · ${esc(fmtDay(today))}</p>
      <h2>Heute keine Sprengung im Grunewald</h2>
      <p>${next ? `Nächster Termin: <strong>${esc(fmtDay(next.date))}</strong>, ${esc(timeRange(next))}${dayDiff(today, next.date) <= 7 ? ` (in ${dayDiff(today, next.date)} Tagen)` : ""}.` : "Derzeit sind keine weiteren Termine angekündigt."}</p>
    </article>`;
  }

  const list = termine.length
    ? `<div class="termine">${termine.map((t) => `<span class="termin${t.date === today && !t.cancelled ? " now" : ""}${t.cancelled ? " off" : ""}">
        <b>${esc(fmtDay(t.date))}</b>${t.cancelled ? "abgesagt" : esc(timeRange(t))}</span>`).join("")}</div>`
    : "";

  const warn = (WARN || []).map((w) => `<article class="alert ${/HITZE/i.test(w.event) ? "amber" : "blue"}">
      <p class="alert-kicker">Deutscher Wetterdienst · ${esc(warnWhen(w))}</p>
      <h2>${esc(warnTitle(w))}</h2>
      <p>${esc(warnTip(w))}</p>
    </article>`).join("");

  const algen = blaualgenAktuell();
  const algenHtml = algen.length
    ? `<article class="alert amber small">
        <p class="alert-kicker">Lageso-Messung · ${esc(algen.length)} ${algen.length === 1 ? "Badestelle" : "Badestellen"}</p>
        <h2>Blaualgen: Hunde nicht ins Wasser lassen</h2>
        <p>${algen.slice(0, 6).map((b) => esc(b.name)).join(", ")}${algen.length > 6 ? " und weitere" : ""}.
           <button type="button" class="linky" data-goto="wasser">Alle Werte ansehen</button></p>
      </article>`
    : "";

  $("today").innerHTML = spreng + list + warn + algenHtml +
    (src ? `<p class="today-src">Sprengtermine: <a href="${esc(src)}" target="_blank" rel="noreferrer">Polizei Berlin</a></p>` : "");
}

const fmtWarnTime = (ms) => new Date(ms).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }) + " Uhr";
function warnWhen(w) {
  const active = !w.start || w.start <= Date.now();
  if (active) return w.end ? `gilt bis ${fmtWarnTime(w.end)}` : "gilt jetzt";
  return `ab ${fmtWarnTime(w.start)}${w.end ? ` bis ${fmtWarnTime(w.end)}` : ""}`;
}
function warnTitle(w) {
  const e = (w.event || "").toLowerCase();
  if (e.includes("hitze")) return "Hitzewarnung für Berlin";
  if (/glätte|glatteis/.test(e)) return "Glättewarnung für Berlin";
  return w.headline || w.event;
}
function warnTip(w) {
  const e = (w.event || "").toLowerCase();
  if (e.includes("hitze")) return "Asphalt kann für Pfoten zu heiß werden. Lange Runden früh am Morgen oder spät am Abend, Wasser mitnehmen, Schatten suchen.";
  if (/glätte|glatteis/.test(e)) return "Bei Glätte wird auf Gehwegen gestreut. Pfoten nach dem Spaziergang mit Wasser abspülen, bei empfindlichen Pfoten Pfotenschutz.";
  return w.desc || "";
}

/** Badestellen mit erhöhtem Blaualgenwert aus einer Messung der letzten drei Wochen */
function blaualgenAktuell() {
  const today = berlinIso();
  return (DATA.badestellen || [])
    .filter((b) => (b.risk === "hoch" || b.risk === "erhoeht") && b.date && dayDiff(b.date, today) <= 21)
    .sort((a, b) => (b.chla || 0) - (a.chla || 0));
}

/* ------------------------------ Tabs ------------------------------- */

function renderChips() {
  const geoLabel = { idle: "In meiner Nähe", busy: "Ort wird gesucht …", ok: "Nach Entfernung sortiert", err: "Standort nicht verfügbar" }[state.geoState];
  const geoChip = `<button type="button" class="chip${state.geo ? " on" : ""}" data-geo="1">${esc(geoLabel)}</button>`;
  if (state.tab === "karte") {
    $("chips").innerHTML = Object.entries(LAYER_DEF)
      .map(([k, d]) => `<button type="button" class="chip layer${state.layers[k] ? " on" : ""}" data-layer="${k}" style="--lc:${d.c}">${esc(d.label)}</button>`)
      .join("") + geoChip;
  } else {
    $("chips").innerHTML = geoChip;
  }
}

function renderPane() {
  for (const t of ["karte", "auslauf", "wasser", "tierarzt"]) $("pane-" + t).hidden = t !== state.tab;
  document.querySelectorAll("#tabs .vt").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));
  if (state.tab === "karte") renderMap();
  if (state.tab === "auslauf") renderAuslauf();
  if (state.tab === "wasser") renderWasser();
  if (state.tab === "tierarzt") renderTierarzt();
}

function mapBtn(kind, idx) {
  return `<button type="button" class="linky" data-show="${kind}:${idx}">Auf der Karte</button>`;
}

function renderAuslauf() {
  const w = DATA.wald || { areas: [] };
  const parks = byDist((DATA.osm?.dogparks || []).map((p, i) => ({ ...p, i })));
  const swim = DATA.hundebaden || { ja: [], nein: [] };

  $("pane-auslauf").innerHTML = `
    <h2 class="sec">Waldauslaufgebiete der Berliner Forsten</h2>
    <p class="sec-note">Hier dürfen Hunde ohne Leine laufen, solange sie in Rufweite bleiben. Die genauen Grenzen zeigen die Karten der Forsten.</p>
    ${w.areas.map((a) => `<div class="row">
        <span class="row-main"><b>${esc(a.name)}</b>${a.note ? `<s>${esc(a.note)}</s>` : ""}</span>
        <a class="row-act" href="${esc(a.pdf)}" target="_blank" rel="noreferrer">Karte (PDF)</a>
      </div>`).join("")}
    <p class="sec-note">Rund um Schlachtensee und Krumme Lanke gelten eigene Regeln: <a href="${esc(w.flyer)}" target="_blank" rel="noreferrer">Faltblatt der Forsten</a>.</p>

    <h2 class="sec">Hundebaden</h2>
    ${swim.ja.map((s) => `<div class="row ok">
        <span class="row-main"><b>${esc(s.name)}</b><s>${esc(s.note)}</s></span>
        <a class="row-act" href="${esc(s.src)}" target="_blank" rel="noreferrer">Quelle</a>
      </div>`).join("")}
    ${swim.nein.map((s) => `<div class="row no"><span class="row-main"><b>${esc(s.name)}</b><s>${esc(s.note)}</s></span></div>`).join("")}
    <p class="sec-note">An den amtlichen Badestellen ist das Mitbringen von Hunden in der Badesaison in der Regel verboten. Eine vollständige Liste der Hundebadestellen veröffentlicht Berlin nicht.</p>

    <h2 class="sec">Auslaufflächen in der Stadt <em>${parks.length}</em></h2>
    <p class="sec-note">Aus OpenStreetMap. ${state.geo ? "Die nächsten zuerst." : "Die größten zuerst. Mit „In meiner Nähe“ nach Entfernung sortieren."}</p>
    ${parks.slice(0, 40).map((p) => `<div class="row">
        <span class="row-main"><b>${esc(p.name || "Hundeauslauf ohne Namen")}</b>
          <span class="row-tags">${distTag(p.c)}${p.ha ? `<span class="tag">${p.ha >= 1 ? `${String(p.ha).replace(".", ",")} ha` : `${Math.round(p.ha * 10000)} m²`}</span>` : ""}${p.fenced ? `<span class="tag">eingezäunt</span>` : ""}</span></span>
        ${mapBtn("auslauf", p.i)}
      </div>`).join("") || `<p class="empty">Noch keine Kartendaten geladen.</p>`}
  `;
}

function renderWasser() {
  const today = berlinIso();
  const riskOrder = { hoch: 0, erhoeht: 1, gering: 2, unbekannt: 3 };
  const bade = state.geo
    ? byDist((DATA.badestellen || []).filter((b) => b.c?.[0]).map((b, i) => ({ ...b, i })))
    : (DATA.badestellen || []).map((b, i) => ({ ...b, i })).filter((b) => b.c?.[0])
        .sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk] || (b.chla || 0) - (a.chla || 0));
  const newest = bade.reduce((a, b) => (b.date > a ? b.date : a), "");
  const offSeason = !newest || dayDiff(newest, today) > 21;
  const water = DATA.osm?.water || [];
  const nearWater = state.geo ? byDist(water).slice(0, 5) : [];

  $("pane-wasser").innerHTML = `
    <h2 class="sec">Blaualgen an den Badestellen</h2>
    <p class="sec-note">${offSeason
      ? `Die Badesaison ist vorbei, die letzten Messungen stammen vom ${esc(fmtDay(newest || today, false))}. Blaualgen können auch außerhalb der Saison auftreten. Bei grünlich-trübem Wasser oder Schlieren den Hund draußen lassen.`
      : "Gemessen als Chlorophyll a vom Lageso. Bei erhöhten Werten den Hund nicht ins Wasser lassen und nicht trinken lassen."}</p>
    ${bade.map((b) => {
      const r = RISK[b.risk] || RISK.unbekannt;
      return `<div class="row risk ${r.cls}" style="--zone:${r.c}">
        <span class="row-main"><b>${esc(b.name)}</b><s>${esc(b.gew)}</s>
          <span class="row-tags"><span class="tag dogtag ${r.cls}">${esc(r.label)}</span>${b.chla != null ? `<span class="tag">${String(b.chla).replace(".", ",")} µg/l</span>` : ""}<span class="tag">${esc(fmtDay(b.date, false))}</span>${distTag(b.c)}</span></span>
        ${mapBtn("baden", b.i)}
      </div>`;
    }).join("")}

    <h2 class="sec">Trinkbrunnen <em>${water.length}</em></h2>
    <p class="sec-note">Öffentliche Trinkbrunnen aus OpenStreetMap. Viele sind im Winter abgestellt, meist von Oktober bis April.
      ${state.geo ? "" : `<button type="button" class="linky" data-geo="1">Die nächsten anzeigen</button>`}</p>
    ${nearWater.map((w) => `<div class="row"><span class="row-main"><b>${esc(w.name || "Trinkbrunnen")}</b>
        <span class="row-tags">${distTag(w.c)}${w.seasonal ? `<span class="tag stale">saisonal</span>` : ""}</span></span>
        ${mapBtn("wasser", water.indexOf(w))}</div>`).join("")}
  `;
}

function renderTierarzt() {
  const vets = (DATA.osm?.vets || []).map((v, i) => ({ ...v, i, open: openNow(v.oh) }));
  const order = (v) => (v.h24 ? 0 : v.open === true ? 1 : v.open === null ? 2 : 3);
  let list = byDist(vets);
  list = [...list].sort((a, b) => order(a) - order(b));
  if (state.geo) list = list.slice(0, 40);

  $("pane-tierarzt").innerHTML = `
    <p class="notice alarm"><strong>Im Notfall vorher anrufen.</strong> Die Öffnungszeiten stammen aus OpenStreetMap und können
      veraltet sein. Nachts und am Wochenende hat in Berlin ein tierärztlicher Notdienst geöffnet, die Praxis wechselt.</p>
    <p class="sec-note">${state.geo ? "Rund um die Uhr geöffnete und jetzt geöffnete Praxen zuerst, danach nach Entfernung." : "Mit „In meiner Nähe“ nach Entfernung sortieren."}</p>
    ${list.map((v) => `<div class="row vet">
        <span class="row-main"><b>${esc(v.name)}</b>${v.addr ? `<s>${esc(v.addr)}</s>` : ""}
          <span class="row-tags">${v.h24 ? `<span class="tag alarm">24 Stunden</span>` : v.open === true ? `<span class="tag ok">jetzt geöffnet</span>` : v.open === false ? `<span class="tag">jetzt geschlossen</span>` : `<span class="tag">Öffnungszeiten unbekannt</span>`}${distTag(v.c)}</span></span>
        <span class="row-acts">${v.phone ? `<a class="call" href="tel:${esc(v.phone.split(";")[0].replace(/[^\d+]/g, ""))}">Anrufen</a>` : ""}${mapBtn("tierarzt", v.i)}</span>
      </div>`).join("") || `<p class="empty">Noch keine Kartendaten geladen.</p>`}
  `;
}

/* ------------------------------ Karte ------------------------------ */

function ensureMap() {
  if (map || typeof L === "undefined") return;
  map = L.map("map", { zoomControl: true, attributionControl: true }).setView([52.5, 13.4], 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
  for (const k of Object.keys(LAYER_DEF)) groups[k] = L.layerGroup();
}

function dot(c, r = 6) { return { radius: r, color: "#fff", weight: 1.5, fillColor: c, fillOpacity: 0.95 }; }

function buildLayers() {
  for (const g of Object.values(groups)) g.clearLayers();
  const o = DATA.osm || {};
  (o.dogparks || []).forEach((p, i) => {
    const pop = `<span class="pop-name">${esc(p.name || "Hundeauslauf")}</span><span class="pop-sub">${p.ha ? `${String(p.ha).replace(".", ",")} ha · ` : ""}OpenStreetMap</span>`;
    const lyr = p.rings?.length
      ? L.polygon(p.rings, { color: LAYER_DEF.auslauf.c, weight: 1.5, fillOpacity: 0.25 })
      : L.circleMarker(p.c, dot(LAYER_DEF.auslauf.c));
    lyr.bindPopup(pop); lyr._key = "auslauf:" + i; groups.auslauf.addLayer(lyr);
  });
  (o.water || []).forEach((w, i) => {
    const m = L.circleMarker(w.c, dot(LAYER_DEF.wasser.c, 5)).bindPopup(`<span class="pop-name">${esc(w.name || "Trinkbrunnen")}</span>${w.seasonal ? `<span class="pop-sub">nur saisonal in Betrieb</span>` : ""}`);
    m._key = "wasser:" + i; groups.wasser.addLayer(m);
  });
  (o.vets || []).forEach((v, i) => {
    const open = openNow(v.oh);
    const m = L.circleMarker(v.c, dot(LAYER_DEF.tierarzt.c, v.h24 ? 8 : 6)).bindPopup(
      `<span class="pop-name">${esc(v.name)}</span><span class="pop-sub">${v.h24 ? "24 Stunden geöffnet" : open === true ? "laut OSM jetzt geöffnet" : open === false ? "laut OSM jetzt geschlossen" : "Öffnungszeiten unbekannt"}</span>${v.phone ? `<a class="pop-btn" href="tel:${esc(v.phone.split(";")[0].replace(/[^\d+]/g, ""))}">Anrufen</a>` : ""}`);
    m._key = "tierarzt:" + i; groups.tierarzt.addLayer(m);
  });
  (DATA.badestellen || []).forEach((b, i) => {
    if (!b.c?.[0]) return;
    const r = RISK[b.risk] || RISK.unbekannt;
    const m = L.circleMarker(b.c, dot(r.c, 7)).bindPopup(`<span class="pop-name">${esc(b.name)}</span><span class="pop-sub">${esc(r.label)}${b.chla != null ? ` · ${String(b.chla).replace(".", ",")} µg/l` : ""} · ${esc(fmtDay(b.date, false))}</span>`);
    m._key = "baden:" + i; groups.baden.addLayer(m);
  });
  (DATA.hundebaden?.ja || []).forEach((s) => {
    L.circleMarker(s.c, dot("#137360", 9)).bindPopup(`<span class="pop-name">${esc(s.name)}: Hundebadestelle</span><span class="pop-sub">${esc(s.note)}</span>`).addTo(groups.auslauf);
  });
}

let builtFor = null;
function renderMap() {
  ensureMap();
  if (!map) return;
  if (builtFor !== DATA.generatedAt) { buildLayers(); builtFor = DATA.generatedAt; }
  for (const [k, g] of Object.entries(groups)) {
    if (state.layers[k]) g.addTo(map); else g.remove();
  }
  setTimeout(() => map.invalidateSize(), 50);
}

function showOnMap(key) {
  const [kind] = key.split(":");
  state.layers[kind] = true;
  state.tab = "karte";
  renderChips(); renderPane();
  const lyr = groups[kind]?.getLayers().find((l) => l._key === key);
  if (!lyr) return;
  setTimeout(() => {
    if (lyr.getBounds) map.fitBounds(lyr.getBounds(), { maxZoom: 16, padding: [30, 30] });
    else map.setView(lyr.getLatLng(), 16);
    lyr.openPopup();
    $("pane-karte").scrollIntoView({ behavior: "smooth", block: "start" });
  }, 80);
}

/* ---------------------------- Standort ----------------------------- */

function locate() {
  if (state.geo) { state.geo = null; state.geoState = "idle"; if (meMarker) meMarker.remove(); renderChips(); renderPane(); return; }
  if (!navigator.geolocation) { state.geoState = "err"; renderChips(); return; }
  state.geoState = "busy"; renderChips();
  navigator.geolocation.getCurrentPosition(
    (p) => {
      state.geo = [p.coords.latitude, p.coords.longitude];
      state.geoState = "ok";
      if (map) {
        if (meMarker) meMarker.remove();
        meMarker = L.circleMarker(state.geo, { radius: 7, color: "#fff", weight: 2, fillColor: "#0C2530", fillOpacity: 1 }).addTo(map);
        if (state.tab === "karte") map.setView(state.geo, 14);
      }
      renderChips(); renderPane();
    },
    () => { state.geoState = "err"; renderChips(); },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

/* ----------------------------- Quellen ----------------------------- */

function renderSources() {
  const s = DATA.sources || {};
  $("quellen").innerHTML = `Quellen: <a href="${esc(s.sprengungen?.url)}" target="_blank" rel="noreferrer">Polizei Berlin</a> ·
    <a href="${esc(s.badestellen?.url)}" target="_blank" rel="noreferrer">Lageso</a> ·
    <a href="${esc(DATA.wald?.src)}" target="_blank" rel="noreferrer">Berliner Forsten</a> ·
    <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap-Mitwirkende</a> ·
    <a href="https://www.dwd.de/warnungen" target="_blank" rel="noreferrer">Deutscher Wetterdienst</a>`;
}

/* ----------------------------- Ereignisse -------------------------- */

document.addEventListener("click", (e) => {
  const t = e.target.closest("button, [data-geo]");
  if (!t) return;
  if (t.dataset.tab) { state.tab = t.dataset.tab; renderChips(); renderPane(); return; }
  if (t.dataset.layer) { state.layers[t.dataset.layer] = !state.layers[t.dataset.layer]; renderChips(); renderMap(); return; }
  if (t.dataset.geo) { locate(); return; }
  if (t.dataset.show) { showOnMap(t.dataset.show); return; }
  if (t.dataset.goto) { state.tab = t.dataset.goto; renderChips(); renderPane(); $("tabs").scrollIntoView({ behavior: "smooth" }); return; }
});
$("refresh").addEventListener("click", () => load(true));

// iOS: Hinweis zum Installieren, einmalig
(() => {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  let dismissed = false;
  try { dismissed = localStorage.getItem("wuff-ios-tip") === "1"; } catch {}
  if (ios && !standalone && !dismissed) $("iosTip").hidden = false;
  $("iosTipClose").addEventListener("click", () => {
    $("iosTip").hidden = true;
    try { localStorage.setItem("wuff-ios-tip", "1"); } catch {}
  });
})();

// Um Mitternacht oder nach dem Aufwecken des Handys das Tagesbanner neu berechnen
document.addEventListener("visibilitychange", () => { if (!document.hidden && DATA) { renderToday(); loadWarnings(); } });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
load(false);
