const CACHE_VERSION = 'workout-logger-ai-v22';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './activity-comparison.css',
  './app.js',
  './auth-client.js',
  './session-delete-fix.js',
  './exercise-picker.js',
  './activity-comparison.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const isAppFile = request.mode === 'navigate' || /\/(index\.html|app\.js|auth-client\.js|session-delete-fix\.js|exercise-picker\.js|activity-comparison\.js|styles\.css|activity-comparison\.css|manifest\.webmanifest|service-worker\.js)$/.test(url.pathname);
  event.respondWith(isAppFile ? networkFirst(request) : cacheFirst(request));
});
async function networkFirst(request) {
  try {
    const fresh = await fetch(request, {cache:'no-store'});
    if (fresh && fresh.ok) (await caches.open(CACHE_VERSION)).put(request, fresh.clone());
    return fresh;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') return caches.match('./index.html');
    throw error;
  }
}
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) (await caches.open(CACHE_VERSION)).put(request, response.clone());
  return response;
}
