// Service Worker for Progressive Web App (PWA) Offline Caching & Background Resilience
const CACHE_NAME = 'tracker-pwa-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// Cache-First with Network Fallback strategy
self.addEventListener('fetch', event => {
  // Pass through external dynamic API requests (ntfy, IP geocoders, tiles)
  if (event.request.url.includes('ntfy.sh') ||
      event.request.url.includes('ipwho.is') ||
      event.request.url.includes('freeipapi.com') ||
      event.request.url.includes('nominatim') ||
      event.request.url.includes('arcgisonline') ||
      event.request.url.includes('tile.openstreetmap.org')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      return cachedResponse || fetch(event.request);
    })
  );
});
