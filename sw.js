// Bump this version string whenever you change index.html (or any cached
// file) so the browser knows to fetch and cache the new version instead of
// serving the stale one forever.
const CACHE_VERSION = "reading-hours-v27";

// The "app shell" - everything needed for the app to load and run offline.
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./cloud-sync.js",
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
    }).then(function () {
      // Placed inside the same waitUntil (after cleanup resolves) rather
      // than fired as a side effect alongside it, so the browser doesn't
      // consider "activate" finished — and start routing fetches through
      // this worker — before old caches have actually been cleared.
      return self.clients.claim();
    })
  );
});

// --- Fetch strategy ---------------------------------------------------
// Navigations (loading the app's HTML) use network-first: always try to
// get the latest index.html when online, only falling back to the cached
// copy when offline. This is what prevents a returning visitor from
// getting stuck on an old cached version of the app.
// Everything else (icons, Chart.js, manifest) uses cache-first, since
// those rarely change and cache-first keeps the app feeling instant.
self.addEventListener("fetch", function (event) {
  // Only handle GET requests; let everything else (POST etc.) pass through.
  if (event.request.method !== "GET") return;

  const isNavigation = event.request.mode === "navigate" ||
    event.request.destination === "document";

  if (isNavigation) {
    event.respondWith(
      fetch(event.request)
        .then(function (response) {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(function (cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(function () {
          // Offline (or request failed): fall back to whatever's cached
          // for this exact request, then to the cached index.html shell.
          return caches.match(event.request).then(function (cached) {
            return cached || caches.match("./index.html");
          });
        })
    );
    return;
  }

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
          // Offline and not cached: nothing more we can do for this asset.
          return undefined;
        });
    })
  );
});

// --- Notification click: focus the app (or open it) --------------------
// Used by the timer's progress notification (see index.html) — tapping it
// should bring the running app to the foreground rather than doing
// nothing, which is the default if this isn't handled.
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
