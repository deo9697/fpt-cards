export function triggerRickrollVideo() {
  document.querySelector('#rickroll-video')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'rickroll-video';
  overlay.className = 'rickroll-video';
  overlay.innerHTML = `<video src="./assets/videoplayback.mp4" autoplay playsinline preload="auto"></video><div class="rickroll-video-label"><strong>Autoprestito rilevato</strong><small>GET RIKROLLED</small></div><button type="button" aria-label="Chiudi">×</button>`;
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
