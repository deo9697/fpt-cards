// Accademia del Duellante: tutorial Yu-Gi-Oh! per neofiti guidato da Blattaman.
// Otto capitoli con quiz, un duello d'esempio già scritto con scelte
// ("Cosa faresti?") e, alla fine, il diploma: 500 XP + titolo "Terza Media"
// (RPC claim_academy_reward, una volta sola per membro).
// Lady Sim compare con le sue battute solo sul profilo di Simona Costanzo.
import { CHAPTERS, DUEL, DUEL_UNLOCK_AFTER, FIELD_ZONES, CARDS, LADY_SIM_LINES } from './academy-content.js';

const STORAGE_PREFIX = 'fpt-academy-v1:';
const MOODS = { welcome: 'welcome', who: 'who-laughs', panic: 'panicking' };
const blattaman = mood => `assets/tutorial/blattaman-${MOODS[mood] || MOODS.who}-sm.webp`;
export const ACADEMY_REWARD_XP = 500;
export const ACADEMY_TITLE_ID = 'title_terza_media';

function normalizeName(value) { return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
// Lady Sim: solo per Simona Costanzo (per nome o per slug), nessun altro.
export function isLadySimViewer(member) {
  if (!member) return false;
  const slug = String(member.slug || member.id || '').toLowerCase().replace(/[_\s]+/g, '-');
  return normalizeName(member.name || member.fullName) === 'simona costanzo' || slug === 'simona-costanzo';
}

export function readProgress(slug) {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_PREFIX + slug) || '{}'); return { chapters: value.chapters || {}, duel: Boolean(value.duel), claimed: Boolean(value.claimed) }; }
  catch { return { chapters: {}, duel: false, claimed: false }; }
}
function writeProgress(slug, progress) { try { localStorage.setItem(STORAGE_PREFIX + slug, JSON.stringify(progress)); } catch {} }

export function chapterUnlocked(progress, index) { return CHAPTERS.slice(0, index).every(chapter => progress.chapters[chapter.id]); }
export function duelUnlocked(progress) { return Boolean(progress.chapters[DUEL_UNLOCK_AFTER]); }
export function academyComplete(progress) { return CHAPTERS.every(chapter => progress.chapters[chapter.id]) && progress.duel; }

export class Academy {
  constructor({ getMember, claimReward, onRender, onToast, onRewardClaimed, random = Math.random } = {}) {
    Object.assign(this, { getMember, claimReward, onRender, onToast, onRewardClaimed, random });
    this.screen = { type: 'hub' }; this.claiming = false; this.ladySim = '';
  }
  get member() { return this.getMember?.() || null; }
  get slug() { return this.member?.slug || this.member?.id || 'ospite'; }
  get progress() { return readProgress(this.slug); }
  save(progress) { writeProgress(this.slug, progress); }
  reset() { this.screen = { type: 'hub' }; this.ladySim = ''; }
  go(screen) { this.screen = screen; this.ladySim = ''; this.onRender?.(); }

  // Lady Sim: battuta a caso, solo per Simona e solo quando sbagli.
  tease() { if (!isLadySimViewer(this.member)) return ''; return LADY_SIM_LINES[Math.floor(this.random() * LADY_SIM_LINES.length)] || ''; }

  view() {
    const screen = this.screen;
    let body;
    if (screen.type === 'chapter') body = this.chapterView(screen);
    else if (screen.type === 'duel') body = this.duelView(screen);
    else if (screen.type === 'diploma') body = this.diplomaView();
    else body = this.hubView();
    return `<section class="page-stack academy-page">${body}</section>`;
  }

  bubble(mood, html) { return `<div class="academy-blatta"><img src="${blattaman(mood)}" alt="Blattaman" width="86" height="86" decoding="async"><div class="academy-bubble">${html}</div></div>`; }
  ladySimView() { return this.ladySim ? `<div class="academy-ladysim" role="status"><div class="academy-ladysim-bubble">${this.ladySim}</div><span class="academy-ladysim-av" aria-hidden="true">LS</span></div>` : ''; }

  hubView() {
    const progress = this.progress, done = CHAPTERS.filter(chapter => progress.chapters[chapter.id]).length, complete = academyComplete(progress);
    const rows = CHAPTERS.map((chapter, index) => {
      const isDone = Boolean(progress.chapters[chapter.id]), open = chapterUnlocked(progress, index);
      return `<button type="button" class="academy-chap ${isDone ? 'done' : ''} ${open ? '' : 'lock'}" data-academy-chapter="${chapter.id}" ${open ? '' : 'disabled aria-disabled="true"'}><span class="n">${index + 1}</span><span><strong>${chapter.title}</strong><small>${chapter.blurb}</small></span><em>${isDone ? '✓ Fatto' : open ? 'Inizia ›' : '🔒'}</em></button>`;
    }).join('');
    const duelOpen = duelUnlocked(progress);
    const greeting = complete ? (progress.claimed ? 'Diploma preso! Puoi ripassare i capitoli quando vuoi, recluta… anzi, <b>Terza Media</b>.' : 'Hai finito tutto! Vai a ritirare il <b>diploma</b>: 500 XP e un titolo nuovo.') : done ? `Ottimo lavoro: <b>${done} capitoli su ${CHAPTERS.length}</b>. Andiamo avanti!` : 'Benvenuto, recluta! Qui impari a duellare <b>da zero</b>. Parti dal capitolo 1: in tre minuti sai cosa c\'è nel mazzo e come si vince.';
    return `<header class="page-header"><div><span class="eyebrow">Yu-Gi-Oh! · Tutorial</span><h1>Accademia del Duellante</h1></div></header>
      ${this.bubble(complete ? 'welcome' : 'welcome', greeting)}
      <div class="academy-hud"><div><small>Capitoli</small><b class="g">${done}/${CHAPTERS.length}</b></div><div><small>Duello</small><b class="v">${progress.duel ? '✓' : duelOpen ? 'Pronto' : '🔒'}</b></div><div><small>Diploma</small><b>${progress.claimed ? '✓' : `${ACADEMY_REWARD_XP} XP`}</b></div></div>
      <div class="academy-chapters">${rows}</div>
      <div class="academy-duel-cta"><strong>Duello guidato · ${DUEL.title}</strong><p>Un duello già scritto e commentato da Blattaman. Nei momenti chiave scegli tu cosa fare.</p><button type="button" class="academy-btn gold wide" data-academy-duel ${duelOpen ? '' : 'disabled'}>${progress.duel ? 'Rigioca il duello' : duelOpen ? 'Inizia il duello' : 'Si sblocca col capitolo 6'}</button></div>
      ${complete ? `<button type="button" class="academy-btn gold wide academy-diploma-cta" data-academy-diploma>🎓 ${progress.claimed ? 'Rivedi il diploma' : `Ritira il diploma · ${ACADEMY_REWARD_XP} XP + "Terza Media"`}</button>` : ''}`;
  }

  chapterView(screen) {
    const chapter = CHAPTERS.find(item => item.id === screen.id); if (!chapter) return this.hubView();
    const index = CHAPTERS.indexOf(chapter), total = chapter.pages.length + chapter.quiz.length;
    const position = screen.quiz == null ? screen.page : chapter.pages.length + screen.quiz;
    const bar = `<div class="academy-stepbar" aria-hidden="true">${Array.from({ length: total }, (_, i) => `<i class="${i <= position ? 'on' : ''}"></i>`).join('')}</div>`;
    const head = `<header class="page-header"><div><span class="eyebrow">Capitolo ${index + 1} di ${CHAPTERS.length}</span><h1>${chapter.title}</h1></div><button type="button" class="academy-close" data-academy-hub aria-label="Torna all'Accademia">×</button></header>`;
    if (screen.quiz == null) {
      const page = chapter.pages[screen.page];
      const zone = chapter.field && screen.zone ? FIELD_ZONES[screen.zone] : null;
      const text = zone ? `<b>${zone[0]}.</b> ${zone[1]}` : page.text;
      return `${head}${this.bubble(zone ? 'who' : page.mood, text)}${chapter.field ? this.fieldView(screen.zone) : ''}${bar}
        <div class="academy-nav">${screen.page > 0 ? '<button type="button" class="academy-btn ghost" data-academy-prev>‹ Indietro</button>' : '<span></span>'}<button type="button" class="academy-btn gold" data-academy-next>${screen.page < chapter.pages.length - 1 ? 'Avanti ›' : 'Al quiz ›'}</button></div>`;
    }
    const question = chapter.quiz[screen.quiz], answered = screen.answer;
    const correct = answered === question.answer;
    const feedback = answered == null ? `Quiz <b>${screen.quiz + 1} di ${chapter.quiz.length}</b>: ${question.text}` : correct ? `<b>Giusto!</b> ${question.why}` : `<b>Non proprio.</b> ${question.why} Riprova!`;
    return `${head}${this.bubble(answered == null ? 'who' : correct ? 'welcome' : 'panic', feedback)}${this.ladySimView()}
      <div class="academy-question">${question.text}</div>
      <div class="academy-choices">${question.options.map((option, i) => `<button type="button" class="academy-choice ${answered === i ? (correct ? 'right' : 'wrong') : ''}" data-academy-answer="${i}" ${correct ? 'disabled' : ''}><span>${String.fromCharCode(65 + i)}</span>${option}</button>`).join('')}</div>${bar}
      ${correct ? `<div class="academy-nav"><span></span><button type="button" class="academy-btn gold" data-academy-next>${screen.quiz < chapter.quiz.length - 1 ? 'Prossima domanda ›' : 'Completa il capitolo ✓'}</button></div>` : ''}`;
  }

  fieldView(selected) {
    const z = (zone, label, cls = '') => `<button type="button" class="academy-zone ${cls}" data-academy-zone="${zone}" aria-pressed="${selected === zone}">${label}</button>`;
    const gap = '<span class="academy-zone gap" aria-hidden="true"></span>';
    return `<div class="academy-field" aria-label="Il terreno di gioco">
      <span class="academy-field-label">Lato avversario ↑ · zone condivise</span>
      ${gap}${gap}${z('emz', 'Zona Mostro Extra', 'emz')}${gap}${z('emz', 'Zona Mostro Extra', 'emz')}${gap}${gap}
      <span class="academy-field-label">Il tuo lato ↓</span>
      ${z('field', 'Zona Terreno')}${z('monster', 'Mostro', 'm').repeat(5)}${z('gy', 'Cimitero')}
      ${z('extra', 'Extra Deck')}${z('pendulum', 'Magia/ Trappola · Scala P')}${z('st', 'Magia/ Trappola').repeat(3)}${z('pendulum', 'Magia/ Trappola · Scala P')}${z('deck', 'Deck')}
    </div>`;
  }

  duelView(screen) {
    const step = DUEL.steps[screen.step], b = step.board, choice = step.choice;
    const picked = screen.answer, right = picked != null && choice?.options[picked]?.[1];
    const cardImg = key => key === 'back' ? '<span class="academy-slot back"></span>' : `<span class="academy-slot ${b.active === key ? 'active' : ''}"><img src="${CARDS[key].image}" alt="${CARDS[key].name}" loading="lazy" decoding="async"></span>`;
    const row = (cards, size = 5) => `<div class="academy-row">${Array.from({ length: size }, (_, i) => cards[i] ? cardImg(cards[i]) : '<span class="academy-slot"></span>').join('')}</div>`;
    const text = picked == null ? step.text : choice.options[picked][2];
    const bar = `<div class="academy-stepbar" aria-hidden="true">${DUEL.steps.map((_, i) => `<i class="${i <= screen.step ? 'on' : ''}"></i>`).join('')}</div>`;
    const canAdvance = !choice || right;
    const last = screen.step === DUEL.steps.length - 1;
    return `<header class="page-header"><div><span class="eyebrow">Duello guidato · ${b.phase}</span><h1>${step.title}</h1></div><button type="button" class="academy-close" data-academy-hub aria-label="Torna all'Accademia">×</button></header>
      <div class="academy-duel-head"><span class="lp opp">Avversario <b>${b.lpOpp}</b></span><span class="lp">Tu <b>${b.lpYou}</b></span></div>
      <div class="academy-board">
        <span class="academy-board-label">Avversario</span>${row(b.oppSpells)}${row(b.oppMonsters)}
        <div class="academy-emz">${b.youEmz ? cardImg(b.youEmz) : '<span class="academy-slot emz"></span>'}<small>Zona Mostro Extra</small></div>
        ${row(b.youMonsters)}${row(b.youSpells)}<span class="academy-board-label">Tu</span>
      </div>
      <span class="academy-board-label">La tua mano</span><div class="academy-hand">${b.hand.map(cardImg).join('')}</div>
      ${this.bubble(picked == null ? step.mood : right ? 'welcome' : 'panic', text)}${this.ladySimView()}
      ${choice ? `<div class="academy-choices">${choice.options.map(([label], i) => `<button type="button" class="academy-choice ${picked === i ? (right ? 'right' : 'wrong') : ''}" data-academy-duel-answer="${i}" ${right ? 'disabled' : ''}><span>${String.fromCharCode(65 + i)}</span>${label}</button>`).join('')}</div>` : ''}${bar}
      <div class="academy-nav">${screen.step > 0 ? '<button type="button" class="academy-btn ghost" data-academy-duel-prev>‹ Indietro</button>' : '<span></span>'}${canAdvance ? `<button type="button" class="academy-btn gold" data-academy-duel-next>${last ? 'Concludi il duello ✓' : 'Avanti ›'}</button>` : ''}</div>`;
  }

  diplomaView() {
    const progress = this.progress, member = this.member;
    return `<header class="page-header"><div><span class="eyebrow">Accademia del Duellante</span><h1>Diploma</h1></div><button type="button" class="academy-close" data-academy-hub aria-label="Torna all'Accademia">×</button></header>
      <div class="academy-diploma"><small>F.P.T Cards · Yu-Gi-Oh!</small><strong>Terza Media</strong><p>${member?.name ? `Si certifica che <b>${escapeHtml(member.name)}</b>` : 'Si certifica che il duellante'} ha completato gli otto capitoli e il duello guidato dell'Accademia di Blattaman.</p><span class="academy-diploma-xp">+${ACADEMY_REWARD_XP} XP</span></div>
      ${this.bubble('welcome', progress.claimed ? 'Diploma già ritirato: il titolo <b>Terza Media</b> lo trovi nel profilo, tra i titoli da equipaggiare.' : 'Ce l\'hai fatta, recluta! Ritira il diploma: <b>500 XP</b> e il titolo <b>Terza Media</b>.')}
      <button type="button" class="academy-btn gold wide" data-academy-claim ${progress.claimed || this.claiming ? 'disabled' : ''}>${progress.claimed ? '✓ Ritirato' : this.claiming ? 'Ritiro in corso…' : `Ritira ${ACADEMY_REWARD_XP} XP + "Terza Media"`}</button>`;
  }

  async claim() {
    const progress = this.progress;
    if (this.claiming || progress.claimed || !academyComplete(progress) || !this.claimReward) return;
    this.claiming = true; this.onRender?.();
    try {
      const result = await this.claimReward();
      this.save({ ...this.progress, claimed: true });
      const xp = Number(result?.xpAwarded ?? ACADEMY_REWARD_XP);
      this.onToast?.(xp > 0 ? `Diploma: +${xp} XP · "Terza Media"` : 'Diploma già ritirato: "Terza Media" attivo', 'ok');
      await this.onRewardClaimed?.(result);
    } catch (error) {
      this.onToast?.(error?.message ? `Ritiro non riuscito: ${error.message}` : 'Ritiro non riuscito, riprova', 'err');
    } finally { this.claiming = false; this.onRender?.(); }
  }

  bind(root = document) {
    const on = (selector, handler) => root.querySelectorAll(selector).forEach(node => node.addEventListener('click', event => handler(node, event)));
    on('[data-academy-hub]', () => this.go({ type: 'hub' }));
    on('[data-academy-chapter]', node => this.go({ type: 'chapter', id: node.dataset.academyChapter, page: 0, quiz: null }));
    on('[data-academy-zone]', node => { this.screen = { ...this.screen, zone: node.dataset.academyZone }; this.onRender?.(); });
    on('[data-academy-prev]', () => this.go({ ...this.screen, page: Math.max(0, this.screen.page - 1), zone: '' }));
    on('[data-academy-next]', () => this.next());
    on('[data-academy-answer]', node => this.answer(Number(node.dataset.academyAnswer)));
    on('[data-academy-duel]', () => this.go({ type: 'duel', step: 0, answer: null }));
    on('[data-academy-duel-answer]', node => this.answerDuel(Number(node.dataset.academyDuelAnswer)));
    on('[data-academy-duel-prev]', () => this.go({ type: 'duel', step: Math.max(0, this.screen.step - 1), answer: null }));
    on('[data-academy-duel-next]', () => this.nextDuel());
    on('[data-academy-diploma]', () => this.go({ type: 'diploma' }));
    on('[data-academy-claim]', () => void this.claim());
  }

  next() {
    const screen = this.screen, chapter = CHAPTERS.find(item => item.id === screen.id); if (!chapter) return this.go({ type: 'hub' });
    if (screen.quiz == null) {
      if (screen.page < chapter.pages.length - 1) return this.go({ ...screen, page: screen.page + 1, zone: '' });
      return this.go({ ...screen, quiz: 0, answer: null });
    }
    if (screen.answer !== chapter.quiz[screen.quiz].answer) return;
    if (screen.quiz < chapter.quiz.length - 1) return this.go({ ...screen, quiz: screen.quiz + 1, answer: null });
    const progress = this.progress; progress.chapters[chapter.id] = true; this.save(progress);
    this.onToast?.(`Capitolo "${chapter.title}" completato`, 'ok');
    this.go({ type: academyComplete(progress) && !progress.claimed ? 'diploma' : 'hub' });
  }
  answer(index) {
    const screen = this.screen, chapter = CHAPTERS.find(item => item.id === screen.id); if (!chapter || screen.quiz == null) return;
    const question = chapter.quiz[screen.quiz]; if (screen.answer === question.answer) return;
    this.screen = { ...screen, answer: index };
    this.ladySim = index === question.answer ? '' : this.tease();
    this.onRender?.();
  }
  answerDuel(index) {
    const screen = this.screen, step = DUEL.steps[screen.step]; if (!step?.choice) return;
    if (screen.answer != null && step.choice.options[screen.answer][1]) return;
    this.screen = { ...screen, answer: index };
    this.ladySim = step.choice.options[index]?.[1] ? '' : this.tease();
    this.onRender?.();
  }
  nextDuel() {
    const screen = this.screen, step = DUEL.steps[screen.step];
    if (step.choice && !(screen.answer != null && step.choice.options[screen.answer][1])) return;
    if (screen.step < DUEL.steps.length - 1) return this.go({ type: 'duel', step: screen.step + 1, answer: null });
    const progress = this.progress; progress.duel = true; this.save(progress);
    this.onToast?.('Duello guidato completato', 'ok');
    this.go({ type: academyComplete(progress) && !progress.claimed ? 'diploma' : 'hub' });
  }
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
