const CACHE = 'fpt-cards-v18';
const FILES = ['./', './index.html', './styles.css', './app.js', './js/core.js', './js/api.js', './js/cards.js', './js/icons.js', './js/dashboard.js', './config.js', './icon.svg', './manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', event => event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request))));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => list[0] ? list[0].focus() : clients.openWindow('./')));
});
