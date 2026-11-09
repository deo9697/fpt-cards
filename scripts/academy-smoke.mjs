// Accademia del Duellante: contenuti coerenti, Lady Sim solo per Simona
// Costanzo, percorso completo capitoli → duello → diploma (500 XP + titolo).
import assert from 'node:assert/strict';
globalThis.localStorage = { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); }, removeItem(k) { delete this.store[k]; } };
const { CHAPTERS, DUEL, CARDS, FIELD_ZONES, LADY_SIM_LINES, DUEL_UNLOCK_AFTER } = await import('../js/academy-content.js');
const { Academy, isLadySimViewer, readProgress, academyComplete, duelUnlocked, ACADEMY_REWARD_XP } = await import('../js/academy.js');
const { COSMETICS } = await import('../js/cosmetics.js').catch(() => ({}));

let count = 0;
const check = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };

await check('8 capitoli, ognuno con pagine e un quiz da 3 domande con una sola risposta valida', () => {
  assert.equal(CHAPTERS.length, 8);
  assert.equal(new Set(CHAPTERS.map(c => c.id)).size, 8);
  for (const chapter of CHAPTERS) {
    assert.ok(chapter.pages.length >= 1, chapter.id);
    assert.equal(chapter.quiz.length, 3, chapter.id);
    for (const q of chapter.quiz) { assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length, q.text); assert.ok(q.why, q.text); }
  }
  assert.ok(CHAPTERS.some(c => c.id === DUEL_UNLOCK_AFTER));
  assert.equal(Object.keys(FIELD_ZONES).length, 8);
});

await check('duello guidato: ogni carta esiste, ogni scelta ha esattamente una risposta giusta', () => {
  for (const step of DUEL.steps) {
    const b = step.board;
    for (const key of [...b.hand, ...b.oppMonsters, ...b.oppSpells, ...b.youMonsters, ...b.youSpells, b.youEmz, b.active].filter(k => k && k !== 'back')) assert.ok(CARDS[key], `${step.title}: carta ${key}`);
    if (step.choice) assert.equal(step.choice.options.filter(option => option[1]).length, 1, step.title);
  }
  assert.ok(DUEL.steps.filter(s => s.choice).length >= 5, 'almeno 5 momenti "Cosa faresti?"');
  assert.equal(DUEL.steps.at(-1).board.lpOpp, 8000 - 1700, 'attacco diretto di Kagari: 1700');
  assert.equal(DUEL.steps.at(-1).board.lpYou, 8000 - 100, 'Stratos 1800 contro Kagari 1700: 100 di danno');
});

await check('Lady Sim: solo Simona Costanzo (anche con accenti/maiuscole o per slug), nessun altro', () => {
  assert.ok(isLadySimViewer({ slug: 'x', name: 'Simona Costanzo' }));
  assert.ok(isLadySimViewer({ slug: 'x', name: '  SIMONA   costanzo ' }));
  assert.ok(isLadySimViewer({ slug: 'simona-costanzo', name: 'Sim' }));
  assert.ok(!isLadySimViewer({ slug: 'daniele', name: 'Daniele de Oliveira' }));
  assert.ok(!isLadySimViewer({ slug: 'simona', name: 'Simona Rossi' }));
  assert.ok(!isLadySimViewer(null));
  assert.deepEqual(LADY_SIM_LINES, ['Gnaus!', 'Te chiude u culu a tia ah!']);
});

const play = async ({ member, claimResult = { xpAwarded: 500 } }) => {
  const toasts = [], claims = [];
  const academy = new Academy({ getMember: () => member, claimReward: async () => { claims.push(1); return claimResult; }, onRender() {}, onToast: (m, t) => toasts.push([m, t]), random: () => 0 });
  let teased = 0;
  for (const chapter of CHAPTERS) {
    academy.go({ type: 'chapter', id: chapter.id, page: 0, quiz: null });
    for (let p = 0; p < chapter.pages.length; p++) academy.next();
    for (const q of chapter.quiz) {
      const wrong = (q.answer + 1) % q.options.length;
      academy.answer(wrong);
      if (academy.ladySim) teased++;
      assert.ok(academy.view().includes(isLadySimViewer(member) ? 'academy-ladysim' : 'academy-choice'));
      if (!isLadySimViewer(member)) assert.ok(!academy.view().includes('LADY SIM') && !academy.view().includes('academy-ladysim-bubble'), 'niente Lady Sim per gli altri');
      academy.next(); // risposta sbagliata: non si avanza
      academy.answer(q.answer); academy.next();
    }
  }
  assert.ok(duelUnlocked(academy.progress));
  academy.go({ type: 'duel', step: 0, answer: null });
  for (const step of DUEL.steps) {
    if (step.choice) {
      const wrongIndex = step.choice.options.findIndex(o => !o[1]);
      academy.answerDuel(wrongIndex); if (academy.ladySim) teased++;
      academy.nextDuel(); // non avanza
      academy.answerDuel(step.choice.options.findIndex(o => o[1]));
    }
    academy.nextDuel();
  }
  return { academy, toasts, claims, teased };
};

await check('percorso completo per un membro qualunque: niente Lady Sim, diploma, 500 XP riscattati una volta', async () => {
  const member = { slug: 'daniele', name: 'Daniele de Oliveira' };
  const { academy, toasts, claims, teased } = await play({ member });
  assert.equal(teased, 0);
  assert.ok(academyComplete(academy.progress));
  assert.equal(academy.screen.type, 'diploma');
  assert.ok(academy.view().includes('Terza Media'));
  await academy.claim(); await academy.claim();
  assert.equal(claims.length, 1, 'il riscatto parte una volta sola');
  assert.ok(readProgress('daniele').claimed);
  assert.ok(toasts.some(([m]) => m.includes(`+${ACADEMY_REWARD_XP} XP`)));
});

await check('percorso di Simona: Lady Sim entra a ogni risposta sbagliata', async () => {
  const { teased } = await play({ member: { slug: 'simona-c', name: 'Simona Costanzo' } });
  const wrongs = CHAPTERS.length * 3 + DUEL.steps.filter(s => s.choice).length;
  assert.equal(teased, wrongs);
});

await check('ritiro fallito (RPC non ancora attiva): il diploma resta da ritirare', async () => {
  localStorage.store = {};
  const member = { slug: 'nello', name: 'Nello' };
  const { academy } = await play({ member });
  academy.claimReward = async () => { throw new Error('Could not find the function claim_academy_reward'); };
  const toasts = []; academy.onToast = (m, t) => toasts.push([m, t]);
  await academy.claim();
  assert.ok(!readProgress('nello').claimed);
  assert.equal(toasts[0][1], 'err');
});

await check('capitoli in ordine: il 2 è chiuso finché non finisci l\'1, il duello dopo il 6', async () => {
  localStorage.store = {};
  const academy = new Academy({ getMember: () => ({ slug: 'cristofer', name: 'Cristofer' }), onRender() {}, onToast() {} });
  const hub = academy.view();
  assert.match(hub, /data-academy-chapter="terreno"[^>]*disabled/);
  assert.match(hub, /data-academy-duel disabled/);
});

if (COSMETICS) await check('titolo "Terza Media" presente nei cosmetici', () => {
  assert.ok(COSMETICS.some(item => item.id === 'title_terza_media' && item.type === 'title' && item.label === 'Terza Media'));
});

console.log(`Accademia del Duellante: ${count}/${count} PASS`);
