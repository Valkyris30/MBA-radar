/* Offline support: always try the network first so the edition is fresh,
   and fall back to the last copy we saw when there is no connection. */
const CACHE = 'mba-radar-v7';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'vault.js', 'freight.js', 'data/ports.json', 'data/freight.json', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'data/articles.json', 'data/archive.json', 'data/maritime.json', 'data/maritime-archive.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Revalidate with the server every time, so a new edition or app update is never hidden by the HTTP cache.
  const fresh = req.mode === 'navigate' ? fetch(req) : fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
  event.respondWith(
    fresh
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
