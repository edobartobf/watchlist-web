// Service worker: serve a rendere la pagina installabile e ad aprirla anche senza rete.
// Prima prova sempre la rete (così gli aggiornamenti arrivano subito), se manca usa la copia.
// Le chiamate a GitHub e TMDB non passano di qui: sono su altri domini.

const CACHE = "watchlist-v1";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "api.js", "vault.js", "demo.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(req.url, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.pathname, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = (await caches.match(url.pathname)) || (req.mode === "navigate" ? await caches.match("./") : null);
        return hit || Response.error();
      }),
  );
});
