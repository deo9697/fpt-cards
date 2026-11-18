// Manual table pile sheet (2026-11-18): deck search / GY / banished open in the
// horizontal bottom panel; a double tap takes the card to the hand, and a deck
// search ends with a shuffle. The Extra Deck keeps its window (summon drag).
import assert from 'node:assert/strict';
import { YugiohMultiplayer } from '../js/games/yugioh/simulator-multiplayer.js';
import { arenaView } from '../js/games/yugioh/simulator-arena.js';

const deck = { id: 'a0000000-0000-4000-8000-000000000001', ownerSlug: 'synthetic-host', name: 'Pile', game: 'yugioh', persisted: true, cards: Array.from({ length: 14 }, (_, i) => ({ catalogCardId: String(10000000 + i), cardName: `Monster ${i}`, type: 'Normal Monster', level: 4, section: 'main', quantity: i === 13 ? 1 : 3, atk: 1800, def: 1000 })) };
const instance = new YugiohMultiplayer({ getContext: () => ({ member: 'synthetic-host', team: 'synthetic-team', allowed: true }), getDecks: () => [deck], getMembers: () => [], verifyAccess: async () => true, loadDecks: async () => {}, lookupCard: async () => null, onRender: () => {}, onToast: () => {}, confirm: async () => true, call: async () => ({ deck: JSON.parse(JSON.stringify(deck)) }) });
instance.ready = true; instance.practiceDraft.mode = 'manual';
await instance.startPractice(deck.id);
assert.equal(instance.practice, true);

await instance.inspectDeck();
assert.equal(instance.pile?.zone, 'deck'); assert(instance.pile.cards.length > 30);
const html = arenaView(instance);
assert.match(html, /ygo-pile-sheet/, 'la ricerca nel mazzo apre il pannello in basso');
assert.match(html, /doppio tocco: in mano/);
const target = instance.pile.cards[7], handBefore = instance.session.players[0].hand.length;
const fakeButton = { closest: () => null };
await instance.tapPileCard(fakeButton, target.id);
assert.equal(instance.session.players[0].hand.length, handBefore, 'un tocco solo evidenzia');
await instance.tapPileCard(fakeButton, target.id);
assert(instance.session.players[0].hand.some(card => card.id === target.id), 'doppio tocco: la carta va in mano');
assert.equal(instance.pile, null, 'il pannello si chiude');
assert.match(instance.session.log.at(-1).text, /mescola il mazzo/, 'la ricerca si chiude mescolando');
console.log('PASS ricerca nel mazzo: pannello in basso, doppio tocco → in mano, mazzo mescolato');

// Graveyard: "In mano" button, no shuffle.
await instance.act({ type: 'move', player: 0, cardId: instance.session.players[0].hand[0].id, to: 'graveyard' });
const grave = instance.session.players[0].graveyard[0];
instance.pile = { player: 0, zone: 'graveyard' };
assert.match(arenaView(instance), new RegExp(`data-ygo-pile-hand="${grave.id}"`));
const logBefore = instance.session.log.length;
await instance.takePileCard(grave.id);
assert(instance.session.players[0].hand.some(card => card.id === grave.id));
assert.equal(instance.session.log.length, logBefore + 1, 'dal Cimitero nessun mescolamento');
console.log('PASS Cimitero: «In mano» riporta la carta, senza mescolare');

// Extra Deck keeps the classic window (summons and drag to the field).
instance.pile = { player: 0, zone: 'extra' };
assert(!/ygo-pile-sheet/.test(arenaView(instance)), 'Extra Deck: finestra classica');
console.log('PASS Extra Deck: finestra classica invariata');
console.log('yugioh-pile-sheet-smoke: OK');
