import { api } from './api.js';

let account = null, generation = 0, pending = null, status = 'unconfigured';
const listeners = new Set();
const setStatus = value => { status = value; listeners.forEach(fn => fn(value)); };
const stored = (key, value) => { try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch {} };
export const iosNeedsInstall = () => (/iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) && !(navigator.standalone || window.matchMedia?.('(display-mode: standalone)').matches);
export function pushSupported() { return !iosNeedsInstall() && window.isSecureContext !== false && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
export function pushConfigured() { return status === 'active' && pushSupported() && Notification.permission === 'granted'; }
export const pushStatus = () => iosNeedsInstall() ? 'install' : !pushSupported() ? 'unsupported' : Notification.permission === 'denied' ? 'denied' : status;
export const onPushStatus = fn => { listeners.add(fn); return () => listeners.delete(fn); };
async function bindDevice(member) {
  const cache = await caches.open('fpt-push-state-v1');
  await cache.put('/__push_owner', new Response(member || ''));
}
export function shouldOfferPush() { return account && ['unconfigured','install'].includes(pushStatus()) && Number(stored(`fpt-push-later:${account}`) || 0) < Date.now(); }
export function deferPush() { stored(`fpt-push-later:${account}`, String(Date.now() + 7 * 86400000)); }
export async function setPushAccount(member) {
  if (account !== member) {
    account = member; generation++; setStatus('unconfigured');
    if ('caches' in window) await bindDevice(null);
    const registration = await navigator.serviceWorker?.getRegistration?.();
    const notifications = await registration?.getNotifications?.();
    notifications?.forEach(item => item.close());
  }
  if (member) { await pending?.catch(() => {}); if (account === member) return reconcilePush(); return; }
  if ('caches' in window) await bindDevice(null);
}
const current = (epoch, snapshot) => epoch === generation && account && api.pushSession() === snapshot;
const timed = promise => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Service Worker non pronto. Riapri l’app e riprova.')), 15000); })]).finally(() => clearTimeout(timer)); };

export function reconcilePush() {
  if (!account || !pushSupported() || Notification.permission !== 'granted') { setStatus(pushSupported() && Notification.permission === 'denied' ? 'denied' : 'unconfigured'); return Promise.resolve(); }
  if (pending) return pending;
  const epoch = generation, snapshot = api.pushSession();
  const task = async () => {
    let subscription;
    try {
      const registration = await timed(navigator.serviceWorker.ready);
      if (!current(epoch, snapshot)) return;
      const response = await fetch('/api/push-public-key', { cache:'no-store', signal:AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Servizio push non configurato');
      const { publicKey } = await response.json();
      const key = urlBase64ToUint8Array(publicKey);
      subscription = await registration.pushManager.getSubscription();
      if (!current(epoch, snapshot)) return;
      const previousKey = subscription?.options?.applicationServerKey;
      const changedKey = previousKey && (new Uint8Array(previousKey).length !== key.length || new Uint8Array(previousKey).some((v,i) => v !== key[i]));
      if (subscription && (changedKey || subscription.expirationTime && subscription.expirationTime <= Date.now())) {
        await api.removePushSubscription(subscription.endpoint, snapshot);
        await subscription.unsubscribe(); subscription = null;
      }
      if (!current(epoch, snapshot)) return;
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:key });
      if (!current(epoch, snapshot)) return;
      await timed(api.savePushSubscription(subscription.toJSON(), snapshot, account));
      if (current(epoch, snapshot)) {
        await bindDevice(account);
        if (current(epoch, snapshot)) setStatus('active');
        else await bindDevice(null);
      }
    } catch (error) {
      if (current(epoch, snapshot)) { setStatus('error'); throw new Error('Registrazione notifiche non riuscita. Controlla la connessione e premi Ripara.'); }
    }
  };
  pending = (navigator.locks ? navigator.locks.request('fpt-push-registration', task) : task()).finally(() => { pending = null; });
  return pending;
}
export async function enablePushNotifications() {
  if (!pushSupported()) throw new Error(iosNeedsInstall() ? 'Apri Condividi, scegli Aggiungi alla schermata Home, poi apri F.P.T. Cards dalla nuova icona.' : 'Notifiche non supportate su questo dispositivo');
  if (!account) throw new Error('Accedi prima di attivare le notifiche');
  // Invoked directly by the click handler, before any network/worker await.
  const epoch = generation;
  const permissionPromise = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
  setStatus('requesting');
  const permission = await permissionPromise;
  if (epoch !== generation || !account) return;
  if (permission !== 'granted') { setStatus(permission === 'denied' ? 'denied' : 'unconfigured'); deferPush(); throw new Error(permission === 'denied' ? 'Consenti le notifiche nelle impostazioni del browser o del dispositivo, poi premi Ripara.' : 'Autorizzazione non concessa'); }
  return reconcilePush();
}
export async function stopPush() {
  const snapshot = api.pushSession();
  account = null; generation++; setStatus('unconfigured');
  if ('caches' in window) await bindDevice(null);
  await pending?.catch(() => {});
  const task = async () => {
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    if (subscription) {
      // Unsubscribe even when offline; server logout also revokes the binding.
      try { await timed(subscription.unsubscribe()); } finally { await timed(api.removePushSubscription(subscription.endpoint, snapshot)); }
    }
    const notifications = await registration?.getNotifications?.();
    notifications?.forEach(item => item.close());
  };
  return navigator.locks ? navigator.locks.request('fpt-push-registration', task) : task();
}
export async function testPush() {
  if (!pushConfigured()) throw new Error('Attiva o ripara prima le notifiche');
  const registration = await timed(navigator.serviceWorker.ready);
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) throw new Error('Sottoscrizione mancante: premi Ripara');
  return api.testPush(subscription.endpoint);
}
function urlBase64ToUint8Array(value) {
  if (typeof value !== 'string' || !value) throw new Error('Chiave pubblica mancante');
  const raw = atob((value + '='.repeat((4 - value.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
