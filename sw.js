const CACHE = 'fpt-cards-v169';
const PADDLE_CACHE = 'fpt-cards-paddle-v1';
// Cache separata e a versione stabile per gli asset grandi che cambiano di
// rado (immagini, font, video). Prima erano nello stesso elenco del guscio
// app: bump della cache per un fix minimo di JS/CSS => cache.addAll ri-
// scaricava anche ~6MB di media invariati ad ogni singolo aggiornamento.
// ensureMediaCache() aggiunge solo i file non già presenti, quindi un
// bump di CACHE non tocca più questi file.
const MEDIA_CACHE = 'fpt-cards-media-v1';
const FILES = ['./', './index.html', './styles.css', './app.js', './js/core.js', './js/api.js', './js/pagination.js', './js/cards.js', './js/catalog-verification.js', './js/icons.js', './js/dashboard.js', './js/collection.js', './js/decks.js', './js/deck-box.js', './js/market-watch.js', './js/fast-scan.js', './js/fast-scan-core.js', './js/fast-scan-camera.js', './js/fast-scan-ocr-engine-b.js', './js/fast-scan-storage.js', './js/fast-scan-sync.js', './js/push.js', './js/easter-egg.js', './js/pwa-update.js', './js/connectivity.js', './config.js', './icon-192.png', './icon-512.png', './manifest.webmanifest'];
const MEDIA_FILES = ['./assets/fpt-card-hero.png', './assets/market-watch-dan.jpg', './assets/deck-boxes/arcane-vault.png', './assets/deck-boxes/infernal-dragon.png', './assets/deck-boxes/cyber-core.png', './assets/fonts/cinzel-latin-variable.woff2', './assets/fonts/manrope-latin-variable.woff2', './assets/ester-eggs/videoplayback.mp4', './assets/ester-eggs/skelet_roar.mp4'];
async function ensureMediaCache() {
  const cache = await caches.open(MEDIA_CACHE);
  const missing = [];
  for (const file of MEDIA_FILES) { if (!(await cache.match(file))) missing.push(file); }
  if (missing.length) await cache.addAll(missing);
}
self.addEventListener('install', event => event.waitUntil(
  Promise.all([
    caches.open(CACHE).then(cache => cache.addAll(FILES)),
    ensureMediaCache()
  ]).then(() => self.skipWaiting())
));
self.addEventListener('activate', event => event.waitUntil(Promise.all([
  caches.keys().then(keys => Promise.all(keys.filter(k => ![CACHE,PADDLE_CACHE,MEDIA_CACHE].includes(k)).map(k => caches.delete(k)))),
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
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    if (['cdn.jsdelivr.net','paddle-model-ecology.bj.bcebos.com'].includes(url.hostname)) {
      event.respondWith(caches.open(PADDLE_CACHE).then(async cache => {
        const hit=await cache.match(event.request); if(hit)return hit;
        const response=await fetch(event.request); if(response.ok||response.type==='opaque')try{await cache.put(event.request,response.clone());}catch{} return response;
      }));
    } else event.respondWith(fetch(event.request));
    return;
  }
  const isMedia = MEDIA_FILES.some(file => url.pathname.endsWith(file.slice(1)));
  if (isMedia) {
    event.respondWith(caches.open(MEDIA_CACHE).then(async cache => {
      const hit = await cache.match(event.request); if (hit) return hit;
      const response = await fetch(event.request);
      if (response.ok) try { await cache.put(event.request, response.clone()); } catch {}
      return response;
    }));
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
self.addEventListener('notificationclick', event => {
  const url = event.notification.data?.url || './';
  event.notification.close();
  event.waitUntil(clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
    const existing = list.find(c => c.url.startsWith(self.location.origin));
    if (existing) { existing.postMessage({ type:'fpt-notification-click', url }); return existing.focus(); }
    return clients.openWindow(url);
  }));
});
self.addEventListener('push', event => {
  let data = { title:'F.P.T Cards', body:'Hai una nuova richiesta da gestire' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(data.title, {
    body:data.body, icon:'icon-192.png', badge:'icon-192.png', tag:data.tag || 'fpt-push', renotify:true,
    data:{ url:data.url || './' }
  }));
});
