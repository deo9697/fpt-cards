const AUDIO_URL = './assets/HEYYEYAAEYAAAEYAEYAA.mp3';
const FIVE_MINUTES = 5 * 60 * 1000;

let audio;
let primed = false;

export function initEasterEgg() {
  audio = new Audio(AUDIO_URL);
  audio.preload = 'auto';
  audio.volume = 0.85;
  document.addEventListener('pointerdown', primeAudio, { once:true, capture:true });
  window.setTimeout(() => triggerRickroll('Sei rimasto qui abbastanza a lungo.'), FIVE_MINUTES);
}

export async function triggerRickroll(message = 'Hai trovato il segreto.') {
  if (!audio) initEasterEgg();
  showSurprise(message);
  try {
    audio.muted = false;
    audio.currentTime = 0;
    await audio.play();
    primed = true;
  } catch {
    const panel = document.querySelector('#rickroll');
    panel?.classList.add('needs-tap');
    document.addEventListener('pointerdown', retryPlayback, { once:true, capture:true });
  }
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
    document.querySelector('#rickroll')?.classList.remove('needs-tap');
  } catch {}
}

function showSurprise(message) {
  document.querySelector('#rickroll')?.remove();
  const panel = document.createElement('aside');
  panel.id = 'rickroll';
  panel.className = 'rickroll';
  panel.innerHTML = `<div class="rick-avatar">?</div><div><strong>F.P.T secret unlocked</strong><small>${message}</small><em>Tocca se l'audio non parte</em></div><button type="button" aria-label="Ferma e chiudi">×</button>`;
  panel.querySelector('button').addEventListener('click', () => {
    audio.pause(); audio.currentTime = 0; panel.remove();
  });
  document.body.append(panel);
}
