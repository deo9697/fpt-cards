const AUDIO_URL = './assets/HEYYEYAAEYAAAEYAEYAA.mp3';
const FIVE_MINUTES = 5 * 60 * 1000;

let audio;
let primed = false;

export function initEasterEgg() {
  audio = new Audio(AUDIO_URL);
  audio.preload = 'auto';
  audio.volume = 0.85;
  document.addEventListener('pointerdown', primeAudio, { once:true, capture:true });
  window.setTimeout(triggerRickroll, FIVE_MINUTES);
}

export async function triggerRickroll() {
  if (!audio) initEasterEgg();
  try {
    audio.muted = false;
    audio.currentTime = 0;
    await audio.play();
    primed = true;
  } catch {
    document.addEventListener('pointerdown', retryPlayback, { once:true, capture:true });
  }
}

export function triggerRickrollVideo() {
  if (audio) { audio.pause(); audio.currentTime = 0; }
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

async function primeAudio() {
  if (primed || !audio) return;
  try {
    audio.muted = true;
    await audio.play();
    audio.pause();
    audio.currentTime = 0;
    audio.muted = false;
    primed = true;
  } catch {}
}

async function retryPlayback() {
  try {
    audio.muted = false;
    await audio.play();
  } catch {}
}
