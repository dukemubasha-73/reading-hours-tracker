// Bump this version string whenever you change index.html (or any cached
// file) so the browser knows to fetch and cache the new version instead of
// serving the stale one forever.
const CACHE_VERSION = "reading-hours-v5";

// The "app shell" - everything needed for the app to load and run offline.
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-192-maskable.png",
  "./icon-512-maskable.png",
  "https://cdn.jsdelivr.net/npm/chart.js"
];

// --- Install: pre-cache the app shell -------------------------------------
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      // addAll fails all-or-nothing; if the Chart.js CDN request fails here
      // (e.g. no network on first install), fall back to caching files
      // individually so the rest of the app shell still gets cached.
      return cache.addAll(APP_SHELL).catch(function () {
        return Promise.all(
          APP_SHELL.map(function (url) {
            return cache.add(url).catch(function (err) {
              console.warn("Failed to cache", url, err);
            });
          })
        );
      });
    })
  );
  self.skipWaiting();
});

// --- Activate: clean up old cache versions --------------------------------
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) { return key !== CACHE_VERSION; })
          .map(function (key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

// --- Fetch: cache-first, falling back to network, then caching the result ---
self.addEventListener("fetch", function (event) {
  // Only handle GET requests; let everything else (POST etc.) pass through.
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;

      return fetch(event.request)
        .then(function (response) {
          // Only cache successful, basic (same-origin) or CDN responses.
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(function (cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(function () {
          // Offline and not cached: for navigations, fall back to the
          // cached index.html so the app still opens.
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
    })
  );
});
