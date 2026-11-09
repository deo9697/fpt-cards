// Statistiche della mano iniziale (js/deck-stats.js): la simulazione da
// 200.000 mani deve coincidere con il calcolo esatto (ipergeometrica), i
// valori noti devono tornare e il calcolo deve restare veloce sul telefono.
import assert from 'node:assert/strict';
globalThis.localStorage = { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); }, removeItem(k) { delete this.store[k]; } };
const { deckPool, simulateOpeningHands, exactOpeningHands, chanceAtLeastOne, guessRole, readDeckRoles, writeDeckRoles } = await import('../js/deck-stats.js');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('PASS ' + name); };
const card = (id, name, quantity, section = 'main') => ({ catalogCardId: id, cardName: name, quantity, section });
// Mazzo da 40: 12 starter, 6 estensori, 11 hand trap, 2 brick, 9 senza ruolo.
const cards = [
  card('1', 'Starter A', 3), card('2', 'Starter B', 3), card('3', 'Starter C', 3), card('4', 'Starter D', 3),
  card('5', 'Extender A', 3), card('6', 'Extender B', 3),
  card('14558127', 'Ash Blossom & Joyous Spring', 3), card('94145021', 'Droll & Lock Bird', 2), card('42141493', 'Mulcharmy Fuwalos', 3), card('9', 'Infinite Impermanence', 3),
  card('10', 'Garnet', 2), card('11', 'Filler', 3), card('12', 'Filler 2', 3), card('13', 'Filler 3', 3),
  card('99', 'Extra card', 15, 'extra')
];
const roles = { 1: 'starter', 2: 'starter', 3: 'starter', 4: 'starter', 5: 'extender', 6: 'extender', 10: 'brick' };
const pool = deckPool(cards, roles);

check('il pool conta solo il Main e indovina le hand trap note', () => {
  assert.equal(pool.size, 40);
  assert.deepEqual(pool.counts, { starter: 12, extender: 6, handtrap: 11, brick: 2, '': 9 });
  assert.equal(guessRole('Ash Blossom & Joyous Spring'), 'handtrap');
  assert.equal(guessRole('Maxx "C"'), 'handtrap');
  assert.equal(guessRole('Called by the Grave'), '', 'non è una hand trap');
});

check('valore noto: 3 copie su 40, mano da 5 → 33,76%', () => {
  assert.ok(Math.abs(chanceAtLeastOne(40, 3, 5) - 0.33758) < 0.0001);
  assert.ok(Math.abs(chanceAtLeastOne(40, 3, 6) - 0.39433) < 0.0001, 'mano da 6: 1 - C(37,6)/C(40,6)');
});

for (const handSize of [5, 6]) {
  check(`simulazione da 200.000 mani = calcolo esatto (mano da ${handSize})`, () => {
    const started = performance.now();
    const sim = simulateOpeningHands(pool, { handSize, iterations: 200000 });
    const elapsed = performance.now() - started;
    const exact = exactOpeningHands(pool, { handSize });
    for (const key of ['playable', 'brick', 'monoHandTrap', 'ideal', 'twoHandTraps', 'anyBrickCard', 'dead']) {
      assert.ok(Math.abs(sim[key] - exact[key]) < 0.006, `${key}: simulato ${sim[key]} vs esatto ${exact[key]}`);
    }
    assert.ok(Math.abs(sim.avgStarters - exact.avgStarters) < 0.02, 'starter medi');
    assert.ok(Math.abs(exact.playable + exact.brick - 1) < 1e-12, 'giocabile + brick = 100%');
    assert.ok(elapsed < 1500, `200.000 mani in ${elapsed.toFixed(0)} ms`);
  });
}

check('stesso seme → stessi risultati', () => {
  assert.deepEqual(simulateOpeningHands(pool, { iterations: 5000, seed: 7 }), simulateOpeningHands(pool, { iterations: 5000, seed: 7 }));
});

check('mazzo vuoto o senza starter non va in errore', () => {
  assert.equal(simulateOpeningHands(deckPool([], {})).iterations, 0);
  const noStarters = deckPool([card('1', 'A', 40)], {});
  assert.equal(exactOpeningHands(noStarters).brick, 1);
  assert.equal(simulateOpeningHands(noStarters, { iterations: 1000 }).playable, 0);
});

check('i ruoli restano salvati per mazzo sul dispositivo', () => {
  writeDeckRoles('deck-a', { 1: 'starter' });
  writeDeckRoles('deck-b', { 2: 'brick' });
  assert.deepEqual(readDeckRoles('deck-a'), { 1: 'starter' });
  assert.deepEqual(readDeckRoles('deck-b'), { 2: 'brick' });
  assert.equal(deckPool([card('14558127', 'Ash Blossom & Joyous Spring', 3)], { 14558127: '' }).entries[0].role, '', 'un ruolo tolto dall\'utente non torna indovinato');
});

globalThis.window ??= { addEventListener() {} };
globalThis.document ??= { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
const { DeckController } = await import('../js/decks.js');
const deck = { id: 'stats-deck', persisted: true, ownerSlug: 'daniele', name: 'Test', game: 'yugioh', format: 'TCG Avanzato', deckTheme: 'abyss-blue', deckBoxTemplate: 'procedural', cards };
const controller = new DeckController({ api: {}, getState: () => ({ decks: [deck], game: 'yugioh', currentUser: 'daniele', collection: { mine: [], team: [] }, loans: [] }), onRender() {}, onToast() {} });
controller.activeId = deck.id; controller.screen = 'detail';
writeDeckRoles(deck.id, roles);

check('pannello statistiche: percentuali, valore esatto e hand trap già segnate', () => {
  const html = controller.statsView(deck);
  const exact = exactOpeningHands(pool, { handSize: 5 });
  const pct = value => `${(value * 100).toFixed(1).replace('.', ',')}%`;
  assert.match(html, /Statistiche mano/);
  assert.ok(html.includes(`esatto ${pct(exact.playable)}`), 'valore esatto della mano giocabile');
  assert.ok(html.includes(`esatto ${pct(exact.monoHandTrap)}`), 'valore esatto della mono hand trap');
  assert.match(html, /data-deck-stat-role="14558127" data-role="handtrap" aria-pressed="true"/, 'Ash già segnata come hand trap');
  assert.doesNotMatch(html, /Segna i tuoi starter/, 'con starter segnati niente avviso');
});

check('pannello statistiche: vai secondo usa la mano da 6', () => {
  controller.statsHandSize = 6;
  const html = controller.statsView(deck);
  assert.match(html, /data-deck-stats-hand="6" aria-pressed="true"/);
  assert.ok(html.includes(`esatto ${(exactOpeningHands(pool, { handSize: 6 }).playable * 100).toFixed(1).replace('.', ',')}%`));
  controller.statsHandSize = 5;
});

check('senza starter il pannello spiega cosa fare', () => {
  writeDeckRoles('no-starters', {});
  const html = controller.statsView({ ...deck, id: 'no-starters' });
  assert.match(html, /Segna i tuoi starter/);
});

check('menu ⋯: comando Statistiche mano, rombi del tema, elimina da tenere premuto', () => {
  const html = controller.moreMenu(deck);
  assert.match(html, /data-deck-stats-open/);
  assert.equal((html.match(/data-deck-theme-swatch=/g) || []).length, 8, '8 temi');
  assert.match(html, /data-deck-theme-swatch="abyss-blue" aria-checked="true"/);
  assert.match(html, /data-deck-delete[^>]*>[\s\S]*tieni premuto 1 s/);
});

console.log(`Deck stats: ${count}/${count} PASS`);
