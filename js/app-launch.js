// Runs before the application/module graph and remote SDK. It observes the
// first usable UI, not network completion, so slow sync never blocks entry.
(() => {
  const splash = document.getElementById('app-launch');
  if (!splash) return;
  let finished = false;
  let fallback;
  const observer = new MutationObserver(() => {
    const app = document.getElementById('app');
    if (!app?.firstElementChild) return;
    if (app.querySelector('.login-loading')) return;
    dismiss();
  });
  function dismiss() {
    if (finished) return;
    finished = true;
    observer.disconnect();
    clearTimeout(fallback);
    splash.setAttribute('aria-hidden', 'true');
    splash.classList.add('is-ready');
    setTimeout(() => splash.remove(), 450);
  }
  observer.observe(document.body, {childList:true, subtree:true});
  // Escape hatch also works when the application module/SDK fails to load.
  fallback = setTimeout(dismiss, 6000);
  window.addEventListener('pagehide', dismiss, {once:true});
})();
