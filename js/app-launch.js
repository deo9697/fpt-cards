// Runs before the application/module graph and remote SDK. It observes the
// first usable UI, not network completion, so slow sync never blocks entry.
(() => {
  const splash = document.getElementById('app-launch');
  if (!splash) return;
  let finished = false;
  let fallback;
  // Il primo frame deve restare identico allo splash Android (solo logo, sfondo
  // pieno) — la classe che rivela halo/branding/progress arriva solo dopo che
  // il browser ha già dipinto quel frame (requestAnimationFrame), più un piccolo
  // ritardo deliberato (non un requisito tecnico) per far sembrare la
  // transizione una continuazione e non un secondo schermo che scatta subito.
  // Indipendente dal dismiss: un boot fulmineo può chiudere lo splash prima che
  // questa fase scatti, ed è corretto così — vedi il vincolo "niente minimum
  // display duration" più sotto.
  requestAnimationFrame(() => {
    setTimeout(() => { if (!finished) splash.classList.add('is-branded'); }, 120);
  });
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
    // Il meta theme-color parte allineato allo sfondo dello splash (#050711,
    // stesso valore di manifest background_color/theme_color) per non creare
    // un flash di colore nella barra di stato durante il boot. Una volta che
    // l'app reale prende il controllo, la barra deve tornare al colore di
    // sfondo effettivo dell'interfaccia (il :root/--bg "Milestone 1" in
    // styles.css, #07080d — non il vecchio #070a17 del manifest, che non
    // corrisponde a nessun colore realmente usato nell'app).
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#07080d');
    setTimeout(() => splash.remove(), 450);
  }
  observer.observe(document.body, {childList:true, subtree:true});
  // Escape hatch also works when the application module/SDK fails to load.
  fallback = setTimeout(dismiss, 6000);
  window.addEventListener('pagehide', dismiss, {once:true});
})();
