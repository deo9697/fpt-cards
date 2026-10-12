// Tutorial "Blattaman" per i nuovi arrivati: fumetto a schede sopra l'app.
// Modulo caricato solo quando serve (import dinamico da app.js): mai nel
// percorso del login. Vive in un overlay su <body>, quindi i render() di #app
// non lo toccano. Chiusura: Salta, Esc, clic fuori o fine delle schede.

const IMG = name => `assets/tutorial/blattaman-${name}.webp`;

// Testi in calabrese "ignorante" di proposito: è il personaggio.
const STEPS = [
  {
    img:'welcome', tag:'Benvenutu', title:'Uè cumpà, trasi!',
    text:'Iu sugnu <b>Blattaman</b>, a blatta chiù forte d\'u Sud. Prima ca cumbini guai ti fazzu vidiri comu funziona st\'app. Pigghia u mazzu, mischia bonu e statti attentu, ca nun u ripetu.'
  },
  {
    img:'sexy', tag:'Raccolta', title:'Ogni carta, \'nta Raccolta',
    text:'Tutti i carti chi teni vannu ccà. Puru i Common chi usi pi \'ncalzari u tavulu. Ndai centu? Usa u <b>Fast Scan</b>: punti a fotocamera supra u codici d\'u set e iddu leggi sulu. Chiù veloci di quandu <i>rivelu Abakiri</i>.'
  },
  {
    img:'welcome', tag:'Mazzi', title:'Fatti i mazzi, ma boni',
    text:'Nei <b>Mazzi</b> ti costruisci i deck e vidi subitu chi carti ti mancanu d\'a raccolta. E no frate, quaranta <i>Vasi dell\'Avidità</i> nun fannu nu mazzu: fannu nu ricorsu a\'u TAR.'
  },
  {
    img:'panicking', tag:'Prestiti', title:'Mannaja, SEGNALA I PRESTITI!',
    text:'Nu cumpari ti \'mpresta na carta? Segnala supra i <b>Prestiti</b>, ca sennò sparisci e succedi nu manicomiu peggiu di quandu ti negano a combo cu n\'<i>Ash Blossom</i> ô primu turnu. Chiedi d\'a raccolta d\'u team e quandu a restituisci, u signi.'
  },
  {
    img:'sexy', tag:'Market Watch', title:'Quantu vali a roba toa?',
    text:'Su <b>Market Watch</b> vidi i prezzi d\'i carti toi, pigghiati di Cardmarket. Si una schizza \'n cielu ti n\'adduni subitu. Si scindi... eh, <i>u cori d\'i carti</i> nun ti paga a bolletta d\'a luci.'
  },
  {
    img:'who-laughs', tag:'Duelli', title:'Perdisti? Ridu iò',
    text:'Registra i duelli nelle <b>Statistiche</b>: pigghi XP, livelli, titoli e avatar segreti. Si perdi cincu voti di fila iò sugnu ccà chi ridu, comu quandu unu cala <i>Exodia</i> e ci manca u brazzu mancu.'
  },
  {
    img:'welcome', tag:'Team', title:'Chiama i cumpari toi',
    text:'D\'a pagina <b>Team</b> vidi a to\' squadra. Si si tu u capu, ti fai u <b>link d\'invitu</b> e u mandi a cu vo\' tu. Mo vai, e ricorda: <i>"metto una carta coperta e passo il turno"</i> nun è na strategia.',
    done:'Mi movu, Blattaman!'
  }
];

let open = null;

export function openTutorial({ onClose } = {}) {
  if (open) return;
  let index = 0;
  const previousFocus = document.activeElement;
  const root = document.createElement('div');
  root.className = 'blatta-tutorial';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'blatta-title');
  document.body.append(root);
  document.body.classList.add('blatta-tutorial-open');

  const close = () => {
    if (!open) return;
    document.removeEventListener('keydown', onKey);
    root.classList.add('is-leaving');
    setTimeout(() => root.remove(), 180);
    document.body.classList.remove('blatta-tutorial-open');
    open = null;
    try { previousFocus?.focus?.(); } catch {}
    onClose?.();
  };
  const go = next => {
    if (next >= STEPS.length) return close();
    index = Math.max(0, next);
    draw();
  };
  const onKey = event => {
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowRight') go(index + 1);
    else if (event.key === 'ArrowLeft') go(index - 1);
  };

  function draw() {
    const step = STEPS[index], last = index === STEPS.length - 1;
    root.innerHTML = `<div class="blatta-backdrop" data-blatta-close></div>
      <article class="blatta-card" data-step="${index}">
        <button type="button" class="blatta-skip" data-blatta-close>Salta</button>
        <figure class="blatta-figure"><img src="${IMG(step.img)}" alt="Blattaman" width="640" height="640" decoding="async"></figure>
        <div class="blatta-bubble">
          <span class="blatta-tag">${step.tag}</span>
          <h2 id="blatta-title">${step.title}</h2>
          <p>${step.text}</p>
        </div>
        <footer class="blatta-nav">
          <button type="button" class="btn secondary small" data-blatta-prev ${index ? '' : 'disabled'}>Indietro</button>
          <ol class="blatta-dots" aria-label="Scheda ${index + 1} di ${STEPS.length}">${STEPS.map((_, i) => `<li class="${i === index ? 'active' : ''}"></li>`).join('')}</ol>
          <button type="button" class="btn small" data-blatta-next>${last ? (step.done || 'Fine') : 'Avanti'}</button>
        </footer>
      </article>`;
    root.querySelectorAll('[data-blatta-close]').forEach(el => el.addEventListener('click', close));
    root.querySelector('[data-blatta-prev]').addEventListener('click', () => go(index - 1));
    const next = root.querySelector('[data-blatta-next]');
    next.addEventListener('click', () => go(index + 1));
    next.focus({ preventScroll:true });
    // Scheda successiva già in cache: niente immagine vuota al cambio.
    const upcoming = STEPS[index + 1];
    if (upcoming) { const preload = new Image(); preload.src = IMG(upcoming.img); }
  }

  open = { close };
  document.addEventListener('keydown', onKey);
  draw();
}

export const TUTORIAL_STEPS = STEPS.length;
