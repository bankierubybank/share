// Service worker (v0.8, PWA install #11). Deliberately small:
// - Hashed bundles under /assets/ are immutable: serve them from cache, fill the cache on first use.
// - Everything else (pages, /api, the manifest, icons) goes straight to the network, untouched — so Cloudflare
//   Access sign-in redirects, fresh data and the no-store API keep working exactly as without a worker.
const CACHE = "share-assets-v1";

self.addEventListener("install", () => self.skipWaiting());

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
  if (req.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith("/assets/")) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      // Only real 200s (an Access redirect or error must never be cached as a bundle).
      if (res.ok && res.type === "basic") void cache.put(req, res.clone());
      return res;
    }),
  );
});
