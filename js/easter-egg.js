// Striscia di 3+ sconfitte consecutive su Statistiche > Io: zoom lento verso
// il badge Streak, poi il video parte con l'audio. targetElement è il badge
// stesso (già nel DOM, renderizzato appena prima da chi chiama questa
// funzione) — se manca (badge non ancora disponibile) lo zoom resta
// centrato sulla pagina invece di puntare a un elemento inesistente.
export function triggerLossStreakZoomVideo(targetElement) {
  const stage = document.querySelector('.page-stage') || document.body;
  if (targetElement) {
    const stageRect = stage.getBoundingClientRect(), badgeRect = targetElement.getBoundingClientRect();
    const originX = stageRect.width ? ((badgeRect.left + badgeRect.width / 2 - stageRect.left) / stageRect.width) * 100 : 50;
    const originY = stageRect.height ? ((badgeRect.top + badgeRect.height / 2 - stageRect.top) / stageRect.height) * 100 : 50;
    stage.style.transformOrigin = `${originX}% ${originY}%`;
  }
  document.body.classList.add('loss-streak-zoom-active');
  stage.classList.add('loss-streak-zoom');
  window.setTimeout(() => triggerLossStreakVideo(() => {
    stage.classList.remove('loss-streak-zoom');
    stage.style.transformOrigin = '';
    document.body.classList.remove('loss-streak-zoom-active');
  }), 1650);
}

function triggerLossStreakVideo(onClose) {
  document.querySelector('#loss-streak-video')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'loss-streak-video';
  overlay.className = 'rickroll-video';
  const src = encodeURI('./assets/ester-eggs/Cat Laughing At You.mp4');
  overlay.innerHTML = `<video src="${src}" autoplay playsinline preload="auto"></video><div class="rickroll-video-label"><strong>3 sconfitte di fila…</strong><small>Ride bene chi ride ultimo</small></div><button type="button" aria-label="Chiudi">×</button>`;
  document.body.append(overlay);
  const video = overlay.querySelector('video'), close = overlay.querySelector('button');
  video.muted = false; video.volume = 1;
  const finish = () => { overlay.remove(); onClose?.(); };
  close.addEventListener('click', () => { video.pause(); finish(); });
  video.addEventListener('ended', () => close.classList.add('ready'));
  // Stesso fallback del rickroll: se il browser blocca l'autoplay con audio
  // (nessuna interazione recente sufficiente), un tap qualsiasi sull'overlay
  // lo sblocca invece di restare mutu/silenzioso senza che nessuno se ne accorga.
  video.play().catch(() => {
    overlay.classList.add('needs-tap');
    overlay.addEventListener('click', () => video.play().then(() => overlay.classList.remove('needs-tap')).catch(() => {}), { once:true });
  });
  window.setTimeout(() => close.classList.add('ready'), 8000);
}

export function triggerRickrollVideo() {
  document.querySelector('#rickroll-video')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'rickroll-video';
  overlay.className = 'rickroll-video';
  overlay.innerHTML = `<video src="./assets/ester-eggs/videoplayback.mp4" autoplay playsinline preload="auto"></video><div class="rickroll-video-label"><strong>Autoprestito rilevato</strong><small>GET RIKROLLED</small></div><button type="button" aria-label="Chiudi">×</button>`;
  document.body.append(overlay);
  const video = overlay.querySelector('video');
  const close = overlay.querySelector('button');
  close.addEventListener('click', () => { video.pause(); overlay.remove(); });
  video.addEventListener('ended', () => close.classList.add('ready'));
  video.play().catch(() => {
    overlay.classList.add('needs-tap');
    overlay.addEventListener('click', () => video.play().then(() => overlay.classList.remove('needs-tap')).catch(() => {}), { once:true });
  });
  window.setTimeout(() => close.classList.add('ready'), 8000);
}
