const CACHE_NAME = "krukkex-shell-v5";
const APP_SHELL = [
  "/icons/krukkex-icon-192x192.png",
  "/icons/krukkex-icon-512x512.png",
  "/icons/krukkex-icon-maskable-192x192.png",
  "/icons/krukkex-icon-maskable-512x512.png",
  "/manifest.webmanifest",
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

  const url = new URL(event.request.url);
  const pathname = url.pathname;
  const accept = event.request.headers.get("accept") || "";
  const isNavigation = event.request.mode === "navigate" || accept.includes("text/html");

  if (isNavigation) {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cachedStream = await caches.match("/stream");
        if (cachedStream) return cachedStream;
        const cachedRoot = await caches.match("/");
        if (cachedRoot) return cachedRoot;
        return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      }),
    );
    return;
  }

  const shouldCache =
    APP_SHELL.includes(pathname)
    || pathname.startsWith("/_next/static/")
    || pathname.startsWith("/icons/")
    || pathname === "/manifest.webmanifest";

  if (!shouldCache) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      });
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
