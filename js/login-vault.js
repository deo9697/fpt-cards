// Login "Vetrina dei Rari": vetrina delle carte più rare del team e
// tastierino del PIN a carte coperte. Modulo caricato da app.js solo dopo che
// la schermata di accesso è già disegnata (mai nel percorso critico).
//
// - fillShowcase(): mette le carte nella vetrina (prima quelle in cache, poi
//   quelle fresche della RPC pubblica list_login_showcase).
// - openPinPad(): al tocco del campo PIN apre, al posto della tastiera del
//   telefono, un pannello con le carte coperte sullo sfondo: ogni cifra gira
//   una carta e Blattaman reagisce. Il valore va nel vero <input id="pin">,
//   quindi il form di login resta quello di sempre.

const CACHE_KEY = 'fpt-login-showcase';
const FACE = mood => `assets/tutorial/blattaman-${mood}-sm.webp`;
const EURO = new Intl.NumberFormat('it-IT', { style:'currency', currency:'EUR' });
const safeUrl = value => (/^https?:\/\//i.test(String(value || '')) ? String(value) : '');
const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]);

function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); } catch { return []; } }
function writeCache(cards) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(cards)); } catch {} }

let showcase = readCache();

function paint(cards) {
  const fan = document.querySelector('[data-vault-fan]');
  if (!fan || !cards.length) return;
  // Carta più pregiata al centro, le altre ai lati.
  const order = [3, 1, 0, 2, 4];
  fan.querySelectorAll('.vault-card').forEach((slot, i) => {
    const card = cards[order[i]];
    const img = slot.querySelector('img');
    const src = safeUrl(card?.image_url);
    if (!card || !src || img.dataset.src === src) return;
    img.dataset.src = src;
    img.alt = card.card_name || '';
    img.onload = () => slot.classList.add('is-loaded');
    img.src = src;
  });
  const top = cards[0], badge = document.querySelector('[data-vault-badge]');
  if (badge && top) {
    const price = Number(top.price);
    const detail = price > 0 ? EURO.format(price) : top.copies > 1 ? `${top.copies} copie nel team` : '';
    badge.textContent = [top.rarity, top.card_name, detail].filter(Boolean).join(' · ');
    badge.hidden = false;
  }
}

export async function fillShowcase(api) {
  paint(showcase);
  try {
    const fresh = (await api.loginShowcase(6)) || [];
    if (fresh.length) { showcase = fresh; writeCache(fresh); paint(fresh); }
  } catch {}
}

// --- Tastierino a carte ------------------------------------------------------
let pad = null;

export function openPinPad({ input, onSubmit }) {
  if (pad || !input) return;
  // Si riparte sempre da zero (es. dopo un PIN sbagliato).
  let pin = '', bump = 0;
  const previousFocus = document.activeElement;
  const fronts = showcase.map(card => safeUrl(card.image_url)).filter(Boolean);
  const root = document.createElement('div');
  root.className = 'pinpad';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Inserisci il PIN');
  const tiles = Array.from({ length: 35 }, (_, i) => `<i style="--r:${((i * 37) % 11) - 5}deg;--y:${(i % 2) * 18}px"></i>`).join('');
  const slots = [0, 1, 2, 3].map(i => `<div class="pinpad-slot"><div class="pinpad-flip"><div class="pinpad-face pinpad-back"></div><div class="pinpad-face pinpad-front">${fronts[i] ? `<img src="${esc(fronts[i])}" alt="">` : ''}<b class="pinpad-digit"></b></div></div></div>`).join('');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => `<button type="button" class="pinpad-key" data-digit="${d}">${d}</button>`).join('')
    + '<button type="button" class="pinpad-key is-soft" data-pad="del">Cancella</button><button type="button" class="pinpad-key" data-digit="0">0</button><button type="button" class="pinpad-key is-go" data-pad="go" disabled>Entra</button>';
  root.innerHTML = `<div class="pinpad-tiles" aria-hidden="true">${tiles}</div><div class="pinpad-shade"></div>
    <div class="pinpad-body">
      <div class="pinpad-top"><button type="button" class="pinpad-close" data-pad="close">Chiudi</button></div>
      <div class="pinpad-talk"><div class="pinpad-mascot"><img alt="Blattaman" width="200" height="200"></div><p class="pinpad-line" aria-live="polite"></p></div>
      <div class="pinpad-slots" aria-hidden="true">${slots}</div>
      <p class="sr-only pinpad-count" aria-live="polite"></p>
      <div class="pinpad-keys">${keys}</div>
    </div>`;
  document.body.append(root);
  document.body.classList.add('pinpad-open');
  const mascot = root.querySelector('.pinpad-mascot'), face = mascot.querySelector('img'), line = root.querySelector('.pinpad-line'), go = root.querySelector('[data-pad="go"]');

  const sync = () => {
    input.value = pin;
    input.dispatchEvent(new Event('input', { bubbles:true }));
    // Ogni carta girata mostra la cifra inserita in quella posizione.
    root.querySelectorAll('.pinpad-slot').forEach((slot, i) => {
      slot.classList.toggle('is-up', i < pin.length);
      slot.querySelector('.pinpad-digit').textContent = pin[i] || '';
    });
    const [mood, text] = pin.length === 0 ? ['sexy', 'Mo gira i carti cu u PIN, compà.']
      : pin.length < 4 ? ['panicking', ['Chianu chianu...', 'N’atra, dai!', 'Ancora una e trasi!'][pin.length - 1]]
      : ['who-laughs', 'Trasisti! Rivelu Abakiri!'];
    if (!face.src.endsWith(FACE(mood))) face.src = FACE(mood);
    line.textContent = text;
    root.querySelector('.pinpad-count').textContent = `${pin.length} cifre su 4`;
    go.disabled = pin.length !== 4;
    mascot.classList.remove('is-jolt-a', 'is-jolt-b'); void mascot.offsetWidth;
    mascot.classList.add(++bump % 2 ? 'is-jolt-a' : 'is-jolt-b');
  };
  const close = () => {
    if (!pad) return;
    document.removeEventListener('keydown', onKey, true);
    root.classList.add('is-leaving');
    setTimeout(() => root.remove(), 180);
    document.body.classList.remove('pinpad-open');
    pad = null;
    try { (previousFocus === input ? input : previousFocus)?.focus?.({ preventScroll:true }); } catch {}
  };
  const press = digit => { if (pin.length < 4) { pin += digit; sync(); } };
  const submit = () => { if (pin.length !== 4) return; close(); onSubmit?.(); };
  const onKey = event => {
    if (/^[0-9]$/.test(event.key)) { event.preventDefault(); press(event.key); }
    else if (event.key === 'Backspace') { event.preventDefault(); pin = pin.slice(0, -1); sync(); }
    else if (event.key === 'Enter') { if (event.target.closest?.('.pinpad-key, .pinpad-close')) return; event.preventDefault(); submit(); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
  };
  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.digit) press(button.dataset.digit);
    else if (button.dataset.pad === 'del') { pin = pin.slice(0, -1); sync(); }
    else if (button.dataset.pad === 'go') submit();
    else if (button.dataset.pad === 'close') close();
  });
  document.addEventListener('keydown', onKey, true);
  pad = { close };
  sync();
  root.querySelector('.pinpad-key')?.focus({ preventScroll:true });
}

export function closePinPad() { pad?.close(); }
