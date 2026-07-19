const CACHE = 'fpt-cards-v51';
const FILES = ['./', './index.html', './styles.css', './app.js', './js/core.js', './js/api.js', './js/cards.js', './js/icons.js', './js/dashboard.js', './js/push.js', './js/easter-egg.js', './js/pwa-update.js', './js/connectivity.js', './assets/fonts/cinzel-latin-variable.woff2', './assets/fonts/manrope-latin-variable.woff2', './assets/HEYYEYAAEYAAAEYAEYAA.mp3', './assets/videoplayback.mp4', './config.js', './icon-192.png', './icon-512.png', './manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())
));
self.addEventListener('activate', event => event.waitUntil(Promise.all([
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))),
  self.clients.claim()
])));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put('./index.html', copy));
      return response;
    }).catch(() => caches.match('./index.html').then(hit => hit || caches.match('./'))));
    return;
  }
  event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request)));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => list[0] ? list[0].focus() : clients.openWindow('./')));
});
self.addEventListener('push', event => {
  let data = { title:'F.P.T Cards', body:'Hai una nuova richiesta da gestire' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(data.title, {
    body:data.body, icon:'icon-192.png', badge:'icon-192.png', tag:data.tag || 'fpt-push', renotify:true,
    data:{ url:data.url || './' }
  }));
});
