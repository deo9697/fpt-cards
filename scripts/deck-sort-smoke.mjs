// Deck builder: One Piece per costo, Yu-Gi-Oh per livello dei mostri.
// One Piece: le carte del Main devono stare in ordine di costo
// (crescente, a parità per nome, senza costo in fondo). Copre i tre casi che
// rompevano l'ordine: ordinamento "Manuale" ereditato da un altro mazzo,
// costi non ancora noti per carte appena aggiunte, chiamata costi fallita
// memorizzata come "nessun costo".
import assert from 'node:assert/strict';
globalThis.localStorage = { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); }, removeItem(k) { delete this.store[k]; } };
globalThis.window ??= { addEventListener() {} };
globalThis.document ??= { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
const { api } = await import('../js/api.js');
const { DeckController } = await import('../js/decks.js');

const COSTS = { 'OP01-016': 1, 'OP01-013': 1, 'OP05-119': 10, 'OP02-004': 3, 'OP01-121': null, 'EB05-028': 4 };
let failNext = false, calls = 0;
api.onePieceCardCosts = async ids => {
  calls++;
  if (failNext) { failNext = false; throw new Error('timeout'); }
  return ids.filter(id => id in COSTS).map(id => ({ catalog_card_id: id, cost: COSTS[id] }));
};

const card = (id, name, quantity = 4, section = 'main') => ({ catalogCardId: id, cardName: name, quantity, section, imageUrl: '', printingId: null });
const deck = {
  id: 'op-deck', persisted: true, dirty: false, ownerSlug: 'daniele', name: 'Rossi Luffy', game: 'onepiece', format: 'Standard', deckTheme: 'abyss-blue', deckBoxTemplate: 'classic', cover: '',
  cards: [card('OP05-119', 'Monkey.D.Luffy'), card('OP01-121', 'Thousand Sunny (Stage)', 1), card('OP02-004', 'Edward Newgate'), card('OP01-016', 'Nami'), card('OP01-013', 'Sanji'), card('OP01-001', 'Leader Zoro', 1, 'leader')]
};
const state = { decks: [deck], game: 'onepiece', currentUser: 'daniele', collection: { mine: [], team: [] }, loans: [] };
const controller = new DeckController({ api: {}, getState: () => state, onRender() {}, onToast() {} });
const main = () => controller.sortCards(deck.cards.filter(item => item.section === 'main')).map(item => item.cardName);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let count = 0;
const check = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };

await check('un mazzo One Piece si apre SEMPRE per costo, anche se prima era "Manuale"', async () => {
  controller.cardSort = 'manual';
  controller.open('op-deck');
  assert.equal(controller.cardSort, 'cost-asc');
  await settle();
});

await check('ordine: costo crescente, a parità per nome, senza costo (Stage) in fondo', async () => {
  assert.deepEqual(main(), ['Nami', 'Sanji', 'Edward Newgate', 'Monkey.D.Luffy', 'Thousand Sunny (Stage)']);
});

await check('carta aggiunta dopo: va subito al suo posto per costo', async () => {
  controller.add({ id: 'EB05-028', name: 'Boa Hancock', image: '', cost: 4 }, 'main', 1);
  assert.deepEqual(main(), ['Nami', 'Sanji', 'Edward Newgate', 'Boa Hancock', 'Monkey.D.Luffy', 'Thousand Sunny (Stage)']);
});

await check('carta aggiunta senza costo nel risultato: lo chiede al catalogo invece di finire in fondo', async () => {
  delete controller.cardCosts['EB05-028'];
  deck.cards = deck.cards.filter(item => item.catalogCardId !== 'EB05-028');
  const { cardCostsByIds } = await import('../js/games/onepiece/catalog.js');
  controller.add({ id: 'EB05-028', name: 'Boa Hancock', image: '' }, 'main', 1);
  await settle(); await settle(); await cardCostsByIds(['EB05-028']);
  assert.equal(controller.cardCosts['EB05-028'], 4);
  assert.deepEqual(main().slice(3, 4), ['Boa Hancock']);
});

await check('chiamata costi fallita: non memorizza "nessun costo", alla riapertura si riprova', async () => {
  const other = { ...deck, id: 'op-deck-2', cards: [card('OP99-001', 'Carta Nuova'), card('OP99-002', 'Altra Nuova')] };
  COSTS['OP99-001'] = 2; COSTS['OP99-002'] = 1;
  state.decks = [deck, other];
  failNext = true;
  controller.open('op-deck-2'); await settle(); await settle();
  assert.ok(!('OP99-001' in controller.cardCosts), 'dopo un errore il costo non deve risultare "assente"');
  const before = calls;
  controller.open('op-deck-2'); await settle(); await settle();
  assert.ok(calls > before, 'alla riapertura deve richiedere di nuovo i costi');
  assert.equal(controller.cardCosts['OP99-001'], 2);
  assert.deepEqual(controller.sortCards(other.cards).map(item => item.cardName), ['Altra Nuova', 'Carta Nuova']);
});

// ------- One Piece con la RPC costo+tipo: Character → Event → Stage -------
await check('One Piece: Character → Event → Stage, ognuno dal costo più basso', async () => {
  const META = { 'OP20-001': [5, 'Character'], 'OP20-002': [1, 'Event'], 'OP20-003': [2, 'Character'], 'OP20-004': [1, 'Stage'], 'OP20-005': [3, 'Event'], 'OP20-006': [7, 'Character'] };
  api.onePieceCardMeta = async ids => ids.filter(id => id in META).map(id => ({ catalog_card_id: id, cost: META[id][0], card_type: META[id][1] }));
  const metaDeck = { ...deck, id: 'op-meta', cards: [card('OP20-001', 'Kaido'), card('OP20-002', 'Gum-Gum Red Hawk'), card('OP20-003', 'Zoro'), card('OP20-004', 'Thousand Sunny'), card('OP20-005', 'Radical Beam'), card('OP20-006', 'Big Mom')] };
  state.decks = [metaDeck]; state.game = 'onepiece';
  controller.open('op-meta'); await settle(); await settle();
  assert.deepEqual(controller.sortCards(metaDeck.cards).map(item => item.cardName), ['Zoro', 'Kaido', 'Big Mom', 'Gum-Gum Red Hawk', 'Radical Beam', 'Thousand Sunny']);
  delete api.onePieceCardMeta;
});

await check('One Piece: carta Event aggiunta dalla ricerca va subito tra gli Event', async () => {
  const metaDeck = state.decks[0];
  controller.add({ id: 'OP20-007', name: 'Divine Departure', image: '', cost: 2, type: 'Event' }, 'main', 1);
  assert.deepEqual(controller.sortCards(metaDeck.cards.filter(item => item.section === 'main')).map(item => item.cardName).slice(3, 6), ['Gum-Gum Red Hawk', 'Divine Departure', 'Radical Beam']);
});

// ------- Immagine della lista: stesso ordine del Deck Builder -------
const { normalizeDeckForImage } = await import('../js/deck-image-export.js');
const imageOrder = (ctrl, d) => {
  const sections = d.game === 'onepiece' ? ['leader', 'main'] : ['main', 'extra', 'side'];
  const ordered = { ...d, cards: sections.flatMap(section => ctrl.sortCards(d.cards.filter(c => c.section === section))) };
  return normalizeDeckForImage(ordered, { cardTypes: ctrl.cardTypes, keepOrder: true }).sections.find(s => s.key === 'main').cards.map(c => c.cardName);
};
await check('immagine One Piece: il Main esce nello stesso ordine del Deck Builder (tipo + costo)', async () => {
  const metaDeck = state.decks[0];
  assert.deepEqual(imageOrder(controller, metaDeck), controller.sortCards(metaDeck.cards.filter(c => c.section === 'main')).map(c => c.cardName));
  assert.deepEqual(imageOrder(controller, metaDeck).slice(0, 3), ['Zoro', 'Kaido', 'Big Mom']);
});

// ---------------- Yu-Gi-Oh: mostri dal livello più alto ----------------
const LEVELS = { '1': 8, '2': 4, '3': 4, '4': 1, '5': 12, '6': null, '7': null, '8': 4, '9': 2 };
const ygoController = new DeckController({ api: {}, getState: () => state, onRender() {}, onToast() {},
  cardTypesByIds: async ids => Object.fromEntries(ids.map(id => [id, ['6'].includes(id) ? 'Spell Card' : id === '7' ? 'Trap Card' : 'Effect Monster'])),
  cardLevelsByIds: async ids => Object.fromEntries(ids.filter(id => id in LEVELS).map(id => [id, LEVELS[id]])) });
const ygoDeck = { ...deck, id: 'ygo-deck', game: 'yugioh', cards: [
  card('4', 'Ash Blossom'), card('6', 'Called by the Grave'), card('2', 'Bystial Druiswurm'), card('1', 'Blue-Eyes White Dragon'),
  card('7', 'Infinite Impermanence'), card('3', 'Aluber the Jester'), card('5', 'Mekk-Knight Crusadia'), card('9', 'Effect Veiler'),
  card('8', 'Xyz Rank Four', 1, 'extra'), card('5', 'Mekk-Knight Crusadia', 1, 'extra')
] };
const ygoMain = () => ygoController.sortCards(ygoDeck.cards.filter(item => item.section === 'main')).map(item => item.cardName);

await check('Yu-Gi-Oh: mostri dal livello più alto al più basso, poi Magie e Trappole', async () => {
  state.decks = [ygoDeck]; state.game = 'yugioh';
  ygoController.open('ygo-deck');
  assert.equal(ygoController.cardSort, 'type', 'il default Yu-Gi-Oh resta "Tipo"');
  await ygoController.resolveCardTypes(ygoDeck); await ygoController.resolveCardLevels(ygoDeck);
  assert.deepEqual(ygoMain(), ['Mekk-Knight Crusadia', 'Blue-Eyes White Dragon', 'Aluber the Jester', 'Bystial Druiswurm', 'Effect Veiler', 'Ash Blossom', 'Called by the Grave', 'Infinite Impermanence']);
});

await check('immagine Yu-Gi-Oh: mostri dal livello più alto anche nella foto, come nel Deck Builder', async () => {
  assert.deepEqual(imageOrder(ygoController, ygoDeck), ygoMain());
  assert.equal(imageOrder(ygoController, ygoDeck)[0], 'Mekk-Knight Crusadia');
});

await check('Yu-Gi-Oh: carta aggiunta dalla ricerca va subito al suo livello', async () => {
  ygoController.cardTypes['10'] = 'monster';
  ygoController.add({ id: '10', name: 'Dark Magician', image: '', type: 'Normal Monster', level: 7 }, 'main', 1);
  assert.equal(ygoMain()[2], 'Dark Magician', 'livello 7 tra il 8 e i 4');
});

await check('Yu-Gi-Oh: livello non ancora noto in fondo ai mostri, non mischiato', async () => {
  ygoController.cardTypes['11'] = 'monster';
  ygoDeck.cards.push(card('11', 'Aaa Unknown'));
  const order = ygoMain();
  assert.equal(order.indexOf('Aaa Unknown'), order.indexOf('Ash Blossom') + 1, 'dopo l\'ultimo mostro con livello, prima delle Magie');
});

await check('Yu-Gi-Oh: ogni mazzo riparte da "Tipo" anche se prima era Z–A', async () => {
  ygoController.cardSort = 'name-desc';
  ygoController.open('ygo-deck');
  assert.equal(ygoController.cardSort, 'type');
});

// ---------------- Yu-Gi-Oh: Extra Deck Fusione → Synchro → Xyz → Link ----------------
const FRAMES = { '21': 'Link Monster', '22': 'XYZ Monster', '23': 'Synchro Tuner Monster', '24': 'Fusion Monster', '25': 'XYZ Monster', '26': 'Pendulum Effect Fusion Monster', '27': 'Synchro Monster', '28': 'Link Monster' };
const EXTRA_LEVELS = { '21': 4, '22': 4, '23': 6, '24': 8, '25': 12, '26': 10, '27': 8, '28': 2 };
const extraController = new DeckController({ api: {}, getState: () => state, onRender() {}, onToast() {},
  cardTypesByIds: async ids => Object.fromEntries(ids.filter(id => id in FRAMES).map(id => [id, FRAMES[id]])),
  cardLevelsByIds: async ids => Object.fromEntries(ids.filter(id => id in EXTRA_LEVELS).map(id => [id, EXTRA_LEVELS[id]])) });
const extraDeck = { ...deck, id: 'ygo-extra', game: 'yugioh', cards: [
  card('21', 'I:P Masquerena', 1, 'extra'), card('22', 'Number 41 Bagooska', 1, 'extra'), card('23', 'Crystal Wing Synchro Dragon', 1, 'extra'),
  card('24', 'Garura, Wings of Resonant Life', 1, 'extra'), card('25', 'Divine Arsenal AA-ZEUS', 1, 'extra'), card('26', 'Odd-Eyes Venom Dragon', 1, 'extra'),
  card('27', 'Baronne de Fleur', 1, 'extra'), card('28', 'Linkuriboh', 1, 'extra')
] };
const extraOrder = () => extraController.sortCards(extraDeck.cards.filter(item => item.section === 'extra')).map(item => item.cardName);
await check('Yu-Gi-Oh: Extra Deck ordinato Fusione → Synchro → Xyz → Link, poi dal livello più alto', async () => {
  state.decks = [extraDeck]; state.game = 'yugioh';
  extraController.open('ygo-extra');
  await extraController.resolveCardTypes(extraDeck); await extraController.resolveCardLevels(extraDeck);
  assert.deepEqual(extraOrder(), ['Odd-Eyes Venom Dragon', 'Garura, Wings of Resonant Life', 'Baronne de Fleur', 'Crystal Wing Synchro Dragon', 'Divine Arsenal AA-ZEUS', 'Number 41 Bagooska', 'I:P Masquerena', 'Linkuriboh']);
});
await check('immagine Yu-Gi-Oh: l\'Extra Deck esce nello stesso ordine del Deck Builder', async () => {
  const ordered = { ...extraDeck, cards: extraController.sortCards(extraDeck.cards.filter(c => c.section === 'extra')) };
  const names = normalizeDeckForImage(ordered, { cardTypes: extraController.cardTypes, keepOrder: true }).sections.find(s => s.key === 'extra').cards.map(c => c.cardName);
  assert.deepEqual(names, extraOrder());
});

console.log(`Deck sort (One Piece tipo+costo + Yu-Gi-Oh livello ed Extra Deck): ${count}/${count} PASS`);
