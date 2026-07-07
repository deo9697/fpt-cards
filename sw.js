const CACHE = 'fpt-cards-v25';
const FILES = ['./', './index.html', './styles.css', './app.js', './js/core.js', './js/api.js', './js/cards.js', './js/icons.js', './js/dashboard.js', './js/push.js', './config.js', './icon.svg', './manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', event => event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request))));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => list[0] ? list[0].focus() : clients.openWindow('./')));
});
self.addEventListener('push', event => {
  let data = { title:'F.P.T Cards', body:'Hai una nuova richiesta da gestire' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(data.title, {
    body:data.body, icon:'icon.svg', badge:'icon.svg', tag:data.tag || 'fpt-push', renotify:true,
    data:{ url:data.url || './' }
  }));
});
