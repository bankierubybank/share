// Service worker (v0.8 PWA #11; v0.9 offline #8). Deliberately small:
// - Install: precache the app shell ("/") and every hashed bundle of this build (vite.config.ts writes the list
//   into this file at build time), so lazy chunks — trip page, bill dialog — work offline too. Fetched by the
//   worker itself, so it doesn't depend on the page's own requests passing through it.
// - Hashed bundles under /assets/ are immutable: cache first.
// - Page loads: network first, untouched (Cloudflare Access sign-in redirects pass straight through); only when the
//   network is down is the cached shell served — the app then shows the trip's offline copy.
// - Everything else (/api, the manifest, icons) goes to the network, never cached.
const BUILD = "__BUILD__";
const PRECACHE = ["/" /*__PRECACHE__*/];
const CACHE = `share-${BUILD}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(PRECACHE.map(async (path) => {
        const res = await fetch(path, { cache: "reload", credentials: "same-origin" });
        // Only real 200s from us: a sign-in redirect or an error must never be cached as the app.
        if (res.ok && res.type === "basic" && !res.redirected) await cache.put(path, res);
      })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (req.mode === "navigate" && !url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(req).catch(async () => (await caches.match("/", { cacheName: CACHE })) ?? Response.error()));
    return;
  }
  if (!url.pathname.startsWith("/assets/")) return;
  const work = caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req);
    if (hit) return { res: hit, put: null };
    const res = await fetch(req);
    return { res, put: res.ok && res.type === "basic" ? cache.put(req, res.clone()) : null };
  });
  event.respondWith(work.then((w) => w.res));
  // Keep the worker alive until the copy is written: a fire-and-forget put can be cut off.
  event.waitUntil(work.then((w) => w.put).catch(() => undefined));
});
