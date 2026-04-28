const CACHE_NAME = 'arbe-tracking-v1';
const urlsToCache = [
    '/',  // Añade esto
    '/tracker.html',
    '/manifest.json',
    '/icon-192x192.png',
    '/icon-512x512.png',
    '/ARBE_TRANSPORTES.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(urlsToCache))
            .catch((error) => console.error('Error en install:', error))  // Añade esto para depurar
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request)
            .then((response) => response || fetch(event.request))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.filter((cacheName) => cacheName !== CACHE_NAME)
                    .map((cacheName) => caches.delete(cacheName))
            );
        })
    );
});