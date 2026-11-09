// Avvisi FPT "gotico cyber": il toast si apre come una barretta luminosa che
// si allarga, scrive il messaggio e si chiude con uno zap glitch; la conferma
// sostituisce il confirm() nativo con un pannello che si apre allo stesso modo.
//
// Il testo completo del toast è nel DOM sin da subito (l'effetto "scrittura"
// è solo CSS), così chi legge #toast — screen reader e smoke test — trova il
// messaggio intero.

const TOAST_LIFE_MS = 2600;
const ZAP_MS = 480;
const TAGS = { ok:'OK', warn:'!', err:'ERR' };
const ERROR_WORDS = /non riuscit|errore|non disponibil|non valid|scadut|non corrett|impossibil|fallit|negat|rifiutat/i;
const WARN_WORDS = /tieni premuto|tocca di nuovo|prima|attenzione|offline|connessione|non ancora|manca|controlla|separatamente|già/i;

// Se window.confirm è stato sostituito (automazione, smoke test che rispondono
// da soli, prima o dopo il caricamento) rispettiamo la sostituzione invece di
// aprire il pannello. Il confirm vero del browser è sempre "[native code]".
function replacedConfirm() {
  const fn = globalThis.confirm;
  if (typeof fn !== 'function') return null;
  try { return Function.prototype.toString.call(fn).includes('[native code]') ? null : fn; } catch { return null; }
}

export function toastTone(message) {
  const text = String(message || '');
  if (ERROR_WORDS.test(text)) return 'err';
  if (WARN_WORDS.test(text)) return 'warn';
  return 'ok';
}

let hideTimer = 0, removeTimer = 0;
export function showToast(message, tone = toastTone(message)) {
  const el = typeof document !== 'undefined' && document.querySelector('#toast');
  if (!el) return;
  const text = String(message || '');
  const safeTone = TAGS[tone] ? tone : 'ok';
  clearTimeout(hideTimer); clearTimeout(removeTimer);
  el.className = `toast fpt-toast ${safeTone}`;
  el.setAttribute('role', safeTone === 'err' ? 'alert' : 'status');
  el.replaceChildren();
  const line = document.createElement('span'); line.className = 'fpt-toast-line'; line.setAttribute('aria-hidden', 'true');
  const body = document.createElement('span'); body.className = 'fpt-toast-body';
  const tag = document.createElement('span'); tag.className = 'fpt-toast-tag'; tag.setAttribute('aria-hidden', 'true'); tag.textContent = `[${TAGS[safeTone]}]`;
  const msg = document.createElement('span'); msg.className = 'fpt-toast-msg'; msg.textContent = text;
  msg.style.setProperty('--chars', String(Math.max(1, Math.min(text.length, 60))));
  const timer = document.createElement('i'); timer.className = 'fpt-toast-timer'; timer.setAttribute('aria-hidden', 'true');
  body.append(tag, msg, timer); el.append(line, body);
  void el.offsetWidth; // riparte l'animazione anche se il toast era già aperto
  el.classList.add('show');
  hideTimer = setTimeout(() => {
    el.classList.add('zap');
    removeTimer = setTimeout(() => el.classList.remove('show', 'zap'), ZAP_MS);
  }, TOAST_LIFE_MS);
}

// Pannello di conferma. Ritorna una Promise<boolean>.
// options: { title, confirmLabel, cancelLabel, danger }
export function fptConfirm(message, options = {}) {
  const replaced = replacedConfirm();
  if (replaced) return Promise.resolve(Boolean(replaced(message)));
  if (typeof document === 'undefined') return Promise.resolve(false);
  const { title = 'Confermi?', confirmLabel = 'Conferma', cancelLabel = 'Annulla', danger = true } = options;
  return new Promise(resolve => {
    document.querySelector('.fpt-confirm-backdrop')?.remove();
    const previous = document.activeElement;
    const back = document.createElement('div');
    back.className = `fpt-confirm-backdrop ${danger ? 'danger' : ''}`.trim();
    const box = document.createElement('div'); box.className = 'fpt-confirm';
    box.innerHTML = '<span class="fpt-toast-line" aria-hidden="true"></span><div class="fpt-confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="fpt-confirm-title" aria-describedby="fpt-confirm-text"><small></small><h3 id="fpt-confirm-title"></h3><p id="fpt-confirm-text"></p><div class="fpt-confirm-actions"><button type="button" class="fpt-confirm-no"></button><button type="button" class="fpt-confirm-yes"></button></div></div>';
    box.querySelector('small').textContent = danger ? '// Azione da confermare' : '// Conferma';
    box.querySelector('h3').textContent = title;
    box.querySelector('p').textContent = String(message || '');
    const no = box.querySelector('.fpt-confirm-no'), yes = box.querySelector('.fpt-confirm-yes');
    no.textContent = cancelLabel; yes.textContent = confirmLabel;
    back.append(box); document.body.append(back);
    let settled = false;
    const close = answer => {
      if (settled) return; settled = true;
      document.removeEventListener('keydown', onKey, true);
      box.classList.add('zap');
      setTimeout(() => { back.remove(); try { previous?.focus?.({ preventScroll:true }); } catch {} }, ZAP_MS);
      resolve(answer);
    };
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false); }
      else if (event.key === 'Tab') { event.preventDefault(); (document.activeElement === yes ? no : yes).focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    no.addEventListener('click', () => close(false));
    yes.addEventListener('click', () => close(true));
    back.addEventListener('click', event => { if (event.target === back) close(false); });
    setTimeout(() => no.focus({ preventScroll:true }), 30);
  });
}
