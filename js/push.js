import { api } from './api.js';

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function pushConfigured() {
  return localStorage.getItem('fpt-push-configured') === 'true';
}

export async function enablePushNotifications() {
  if (!pushSupported()) throw new Error('Notifiche push non supportate su questo dispositivo');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permesso notifiche non concesso');

  const registration = await navigator.serviceWorker.ready;
  const keyResponse = await fetch('/api/push-public-key');
  if (!keyResponse.ok) throw new Error('Servizio push Vercel non ancora configurato');
  const { publicKey } = await keyResponse.json();
  if (!publicKey) throw new Error('Chiave VAPID pubblica mancante su Vercel');

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
  }
  await api.savePushSubscription(subscription.toJSON());
  localStorage.setItem('fpt-push-configured', 'true');
  return subscription;
}

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
}
