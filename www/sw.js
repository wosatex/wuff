/* wuff! — Service Worker.
   Hülle aus dem Cache, Daten aus dem Netz mit Cache als Rückfall.
   VERSION bei jeder Änderung an den Dateien unten hochzählen. */

const VERSION = "v1";
const SHELL = `wf-shell-${VERSION}`;
const DATA = `wf-data-${VERSION}`;
const TILES = "wf-tiles"; // ohne Versionsnummer: Kartenkacheln überleben App-Updates

const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon-180.png",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
  "./vendor/leaflet/images/marker-icon.png",
  "./vendor/leaflet/images/marker-icon-2x.png",
  "./vendor/leaflet/images/marker-shadow.png",
  "./vendor/leaflet/images/layers.png",
  "./vendor/leaflet/images/layers-2x.png",
];

const DATA_PATH = "data/wuff.json";
const TILE_HOST = "tile.openstreetmap.org";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith("wf-") && k !== SHELL && k !== DATA && k !== TILES).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* Netz zuerst, aber nicht ewig warten – am See ist der Empfang oft nur zäh, nicht weg */
async function networkFirst(req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const net = await Promise.race([
      fetch(req, { cache: "no-store" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Zeitüberschreitung")), timeoutMs)),
    ]);
    if (net && net.ok) {
      cache.put(req, net.clone());
      return net;
    }
    throw new Error("Antwort nicht ok");
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Kartenkacheln: einmal gesehen, bleiben sie im eigenen Cache liegen.
  // Ein Kachel-Bild ändert sich für dieselbe Position praktisch nie,
  // deshalb genügt "einmal laden", statt bei jedem Aufruf erneut zu fragen.
  if (url.hostname === TILE_HOST) {
    e.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch (err) {
          return new Response(null, { status: 504, statusText: "Kachel offline nicht verfügbar" });
        }
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return; // amtliche Seiten nie abfangen

  // Datendatei: möglichst frisch, sonst der letzte bekannte Stand
  if (url.pathname.endsWith(DATA_PATH)) {
    e.respondWith(networkFirst(req, DATA, 6000));
    return;
  }

  // Seitenaufruf: offline die gecachte Hülle ausliefern
  if (req.mode === "navigate") {
    e.respondWith(
      networkFirst(req, SHELL, 4000).catch(() =>
        caches.match("./index.html", { cacheName: SHELL }).then((r) => r || caches.match("./index.html"))
      )
    );
    return;
  }

  // Rest: Cache zuerst, im Hintergrund auffrischen
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
