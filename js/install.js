let installPrompt;

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  window.dispatchEvent(new Event('pwa-install-change'));
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  window.dispatchEvent(new Event('pwa-install-change'));
});

export function installMode() {
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) return null;
  if (installPrompt) return 'prompt';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios ? 'ios' : null;
}

export async function requestInstall() {
  if (!installPrompt) return 'ios';
  const prompt = installPrompt;
  await prompt.prompt();
  const result = await prompt.userChoice;
  if (result.outcome === 'accepted') installPrompt = null;
  return result.outcome;
}
