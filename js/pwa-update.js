const CHECK_INTERVAL = 10 * 60 * 1000;

export async function registerAutoUpdates() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache:'none' });
    const check = () => registration.update().catch(() => {});
    await check();
    window.setInterval(check, CHECK_INTERVAL);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  } catch {}
}
