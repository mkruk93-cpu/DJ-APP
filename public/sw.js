const CACHE_NAME = "krukkex-shell-v4";
const APP_SHELL = [
  "/", 
  "/stream", 
  "/icons/krukkex-icon-192x192.png", 
  "/icons/krukkex-icon-512x512.png",
  "/icons/krukkex-icon-maskable-192x192.png",
  "/icons/krukkex-icon-maskable-512x512.png",
  "/manifest.webmanifest", 
  "/stream?v=1.1.1"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[SW] Caching app shell");
      return cache.addAll(APP_SHELL);
    }).catch((err) => {
      console.error("[SW] Install error:", err);
      return Promise.resolve();
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log("[SW] Deleting old cache:", key);
            return caches.delete(key);
          }
          return Promise.resolve();
        }),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  
  // Skip cross-origin requests
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful GET requests for shell resources
        if (response && response.status === 200 && APP_SHELL.includes(new URL(event.request.url).pathname)) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      });
    }).catch(() => {
      // Fallback if network fails
      return caches.match("/");
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
