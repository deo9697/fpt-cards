const CACHE = 'fpt-cards-v103';
const OCR_CACHE = 'fpt-cards-ocr-v1';
const PADDLE_CACHE = 'fpt-cards-paddle-v1';
const FILES = ['./', './index.html', './styles.css', './app.js', './js/core.js', './js/api.js', './js/cards.js', './js/icons.js', './js/dashboard.js', './js/collection.js', './js/fast-scan.js', './js/fast-scan-core.js', './js/fast-scan-camera.js', './js/fast-scan-ocr.js', './js/fast-scan-ocr-engine-b.js', './js/fast-scan-storage.js', './js/push.js', './js/easter-egg.js', './js/pwa-update.js', './js/connectivity.js', './assets/fpt-card-hero.png', './assets/fonts/cinzel-latin-variable.woff2', './assets/fonts/manrope-latin-variable.woff2', './assets/HEYYEYAAEYAAAEYAEYAA.mp3', './assets/videoplayback.mp4', './config.js', './icon-192.png', './icon-512.png', './manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())
));
self.addEventListener('activate', event => event.waitUntil(Promise.all([
  caches.keys().then(keys => Promise.all(keys.filter(k => ![CACHE,OCR_CACHE,PADDLE_CACHE].includes(k)).map(k => caches.delete(k)))),
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
    if (['cdn.jsdelivr.net','tessdata.projectnaptha.com','paddle-model-ecology.bj.bcebos.com'].includes(url.hostname)) {
      const isPaddle=url.hostname==='paddle-model-ecology.bj.bcebos.com'||['paddleocr','opencv','onnxruntime','js-yaml','clipper-lib'].some(part=>url.pathname.toLowerCase().includes(part));
      event.respondWith(caches.open(isPaddle?PADDLE_CACHE:OCR_CACHE).then(async cache => {
        const hit=await cache.match(event.request); if(hit)return hit;
        const response=await fetch(event.request); if(response.ok||response.type==='opaque')try{await cache.put(event.request,response.clone());}catch{} return response;
      }));
    } else event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
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
