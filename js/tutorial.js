// Tour guidato "Blattaman" per i nuovi arrivati. Modulo caricato solo quando
// serve (import dinamico da app.js), mai nel percorso del login.
//
// Come funziona: ogni passo porta l'app sulla pagina giusta (navigate() del
// router vero), illumina il pulsante da usare e Blattaman lo spiega in un
// fumetto. Nessun pulsante avanti/indietro: qualunque tocco o clic va al
// dialogo successivo (se il testo sta ancora comparendo, il primo tocco lo
// completa). L'overlay intercetta i tocchi, quindi durante il tour l'app non
// reagisce ai clic. Esci con "Salta" o Esc. Spiegazioni in italiano chiaro;
// la battuta in cosentino arriva solo nei momenti chiave.

const IMG = name => `assets/tutorial/blattaman-${name}.webp`;
const NAV = page => [`.mobile-nav [data-page="${page}"]`, `.sidebar [data-page="${page}"]`];

// mood: welcome | sexy (dito alzato) | panicking | who-laughs
const STEPS = [
  { page:'home', mood:'welcome',
    text:'Ciao! Sono Blattaman, la mascotte di F.P.T Cards. Ti faccio fare un giro veloce dell\'app: tocca dove vuoi per andare avanti.',
    punch:'Statti accortu, ca un u ripetu!' },
  { page:'home', mood:'sexy', target:NAV('collection'),
    text:'Questo è il menu. Partiamo dalla «Raccolta»: è il posto dove tieni tutte le carte che possiedi.' },
  { page:'collection', mood:'sexy', target:['[data-collection-add]'],
    text:'Per registrare una carta tocca «Aggiungi carta»: cerchi il nome, scegli set, rarità, lingua e condizione, e salvi.' },
  { page:'collection', mood:'who-laughs', target:['[data-fast-scan]'],
    text:'Tante carte da caricare? Usa «Scansione rapida»: inquadri il codice del set con la fotocamera e la carta viene riconosciuta da sola.',
    punch:'Chiù veloci di quandu rivelu Abakiri!' },
  { page:'decks', mood:'welcome', target:['[data-deck-new]'],
    text:'Nei «Mazzi» tocca «Nuovo mazzo» per costruire un deck: vedi subito quali carte hai già in raccolta e quali ti mancano.',
    punch:'E no frate, quaranta Vasi dell\'Avidità nun fannu nu mazzu: fannu nu ricorsu a\'u TAR.' },
  { page:'loans', mood:'panicking', target:['.loan-hero-new', '[data-page="new"]'],
    text:'Presti una carta a un compagno o te la fai prestare? Registralo nei «Prestiti» con il tasto «+». L\'altro conferma, e quando la carta torna lo segni.',
    punch:'Si un u signi, a carta sparisci e succedi nu manicomiu!' },
  { page:'market', mood:'sexy', target:['.market-hero'],
    text:'«Market Watch» ti mostra quanto vale la tua collezione, con i prezzi di Cardmarket aggiornati ogni giorno, carta per carta.',
    punch:'Si scindi, u cori d\'i carti un ti paga a bolletta d\'a luci.' },
  { page:'stats', mood:'who-laughs', target:['[data-stats-new-match]'],
    text:'Nelle «Statistiche» tocca «Registra match» dopo ogni duello: guadagni XP, sali di livello e sblocchi titoli e avatar.',
    punch:'E si perdi cincu voti di fila... ridu iò!' },
  { page:'team', mood:'welcome', target:['[data-invite-create]', '.team-invites', '.team-members'],
    text:'Nella pagina «Team» vedi la tua squadra. Se il team l\'hai creato tu, da qui generi il link d\'invito per far entrare i tuoi amici.' },
  { page:'settings', mood:'sexy', target:['[data-tutorial-open]'],
    text:'Fine del giro! Se vuoi rivedermi, mi trovi sempre in «Impostazioni» → «Tutorial».',
    punch:'Mo vai, e ricorda: «metto una carta coperta e passo il turno» un è na strategia.' }
];

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const findTarget = selectors => { for (const selector of selectors || []) { const el = [...document.querySelectorAll(selector)].find(visible); if (el) return el; } return null; };
const escapeHtml = value => String(value).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]);

// Testo parola per parola (effetto "sta parlando"); «Nome» = elemento
// dell'interfaccia, evidenziato.
function wordsHtml(text, offset = 0) {
  let inUi = false;
  return text.split(/\s+/).map((word, i) => {
    const opens = word.includes('«'), closes = word.includes('»');
    const ui = inUi || opens; if (opens) inUi = true; if (closes) inUi = false;
    return `<span class="blatta-word${ui ? ' is-ui' : ''}" style="--i:${offset + i}">${escapeHtml(word.replace(/[«»]/g, ''))}</span>`;
  }).join(' ');
}

let active = null;

export function openTutorial({ navigate, onClose } = {}) {
  if (active) return;
  let index = 0, revealTimer = 0, findTimer = 0, revealed = false, closed = false;
  const previousFocus = document.activeElement;
  const root = document.createElement('div');
  root.className = 'blatta-tour';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Tutorial di F.P.T Cards');
  root.innerHTML = `<div class="blatta-shade"></div><div class="blatta-spot" hidden></div>
    <button type="button" class="blatta-skip">Salta</button>
    <div class="blatta-stage">
      <div class="blatta-speech" aria-live="polite"><p class="blatta-line"></p><p class="blatta-punch"></p>
        <span class="blatta-hint"><b class="blatta-count"></b> · Tocca per continuare</span></div>
      <div class="blatta-mascot"><img alt="Blattaman" width="640" height="640" decoding="async"></div>
    </div>`;
  document.body.append(root);
  document.body.classList.add('blatta-tour-open');
  const $ = selector => root.querySelector(selector);
  const spot = $('.blatta-spot'), shade = $('.blatta-shade'), stage = $('.blatta-stage'), mascot = $('.blatta-mascot'), img = $('.blatta-mascot img');
  let target = null;

  const close = () => {
    if (closed) return;
    closed = true; active = null;
    clearTimeout(revealTimer); clearInterval(findTimer);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
    root.classList.add('is-leaving');
    setTimeout(() => root.remove(), 200);
    document.body.classList.remove('blatta-tour-open');
    try { previousFocus?.focus?.(); } catch {}
    onClose?.();
  };

  // Spotlight sul pulsante + Blattaman/fumetto sempre sopra la zona
  // illuminata quando questa è in basso (es. menu del telefono).
  function place() {
    if (closed) return;
    const vh = window.innerHeight;
    if (target && target.isConnected && visible(target)) {
      const r = target.getBoundingClientRect(), pad = 8;
      Object.assign(spot.style, { left:`${r.left - pad}px`, top:`${r.top - pad}px`, width:`${r.width + pad * 2}px`, height:`${r.height + pad * 2}px` });
      spot.hidden = false; shade.classList.add('is-clear');
      const bottomGap = r.top > vh * 0.62 ? vh - r.top + pad + 24 : 0;
      stage.style.bottom = `${Math.max(bottomGap, 0)}px`;
      stage.classList.toggle('is-raised', bottomGap > 0);
    } else {
      spot.hidden = true; shade.classList.remove('is-clear');
      stage.style.bottom = '0px'; stage.classList.remove('is-raised');
    }
  }

  function reveal(all) {
    revealed = true; clearTimeout(revealTimer);
    root.classList.add('is-revealed');
    if (all) root.querySelectorAll('.blatta-word').forEach(w => w.style.animation = 'none');
  }

  function show(next) {
    if (next >= STEPS.length) { navigate?.('home'); return close(); }
    index = next; revealed = false;
    const step = STEPS[index];
    root.classList.remove('is-revealed');
    if (step.page) navigate?.(step.page);
    // Blattaman: cambia faccia e sussulta a ogni battuta.
    mascot.dataset.mood = step.mood;
    img.src = IMG(step.mood);
    mascot.classList.remove('is-jolt'); void mascot.offsetWidth; mascot.classList.add('is-jolt');
    const speech = $('.blatta-speech');
    speech.classList.remove('is-pop'); void speech.offsetWidth; speech.classList.add('is-pop');
    const words = step.text.split(/\s+/).length;
    $('.blatta-line').innerHTML = wordsHtml(step.text);
    $('.blatta-punch').innerHTML = step.punch ? wordsHtml(step.punch, words + 3) : '';
    $('.blatta-punch').hidden = !step.punch;
    $('.blatta-count').textContent = `${index + 1}/${STEPS.length}`;
    const total = words + (step.punch ? step.punch.split(/\s+/).length + 3 : 0);
    if (reducedMotion()) reveal(true);
    else revealTimer = setTimeout(() => reveal(false), total * 45 + 300);
    // Il pulsante può comparire dopo il render (moduli lazy): lo cerco per ~3 s.
    target = null; place(); clearInterval(findTimer);
    let tries = 0;
    findTimer = setInterval(() => {
      const found = findTarget(step.target);
      if (found || ++tries > 30) {
        clearInterval(findTimer);
        target = found;
        if (found) found.scrollIntoView({ block:'center', behavior:reducedMotion() ? 'auto' : 'smooth' });
        setTimeout(place, reducedMotion() ? 0 : 260); place();
      }
    }, 100);
    const upcoming = STEPS[index + 1];
    if (upcoming) { const preload = new Image(); preload.src = IMG(upcoming.mood); }
  }

  const advance = () => { if (!revealed) reveal(true); else show(index + 1); };
  const onKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if ([' ', 'Enter', 'ArrowRight'].includes(event.key)) { event.preventDefault(); advance(); }
    else if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); show(index - 1); }
  };

  $('.blatta-skip').addEventListener('click', event => { event.stopPropagation(); close(); });
  root.addEventListener('click', advance);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  active = { close };
  show(0);
  $('.blatta-skip').focus({ preventScroll:true });
}

export const TUTORIAL_STEPS = STEPS.length;
