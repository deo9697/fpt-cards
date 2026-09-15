// Decklist Image Generator V1.1 — layout leggibile (logica pura, nessun
// canvas/browser reale necessario: computeDeckImageLayout produce solo
// coordinate numeriche). Verifica qui la richiesta esplicita di questo
// task: Main dominante e più grande rispetto alla V1 precedente (griglia
// UNICA condivisa da tutte le sezioni), Extra/Side più compatti, Readable/
// Poster, enfasi Leader in Poster Mode, nessun overflow su nessuno
// scenario richiesto. La pipeline artwork/fetch/proxy NON è toccata da
// questo task ed è già coperta da deck-image-export-progressive-smoke.mjs
// e deck-image-export-browser-smoke.mjs (entrambi ri-verificati qui non
// necessari, invariati).
import assert from 'node:assert/strict';
globalThis.window ??= { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { normalizeDeckForImage, computeDeckImageLayout, DECK_IMAGE_WIDTH, DECK_IMAGE_HEIGHT } = await import('../js/deck-image-export.js');

function ygoDeck(cards, overrides = {}) {
  return { name: 'V1.1 Test', game: 'yugioh', format: 'TCG Avanzato', deckTheme: 'arcane-purple', signatureCardId: null, cards, ...overrides };
}
// catalogCardId non puramente numerico: preferredDeckArtwork() (riusata,
// mai duplicata) forzerebbe altrimenti un URL ygoprodeck ignorando i dati
// sintetici di questo test — irrilevante qui (il layout non guarda gli URL).
const many = (n, section, prefix, quantity = 1) => Array.from({ length: n }, (_, i) => ({ catalogCardId: `${prefix}${i}`, cardName: `${prefix}${i}`, section, quantity, imageUrl: '' }));

function assertNoOverflow(layout, label) {
  let maxRight = 0, maxBottom = 0, minCell = Infinity;
  for (const section of layout.sections) for (const card of section.cards) {
    maxRight = Math.max(maxRight, card.x + card.w);
    maxBottom = Math.max(maxBottom, card.y + card.h);
    minCell = Math.min(minCell, card.w, card.h);
  }
  assert(maxRight <= layout.width - layout.padding + 0.01, `${label}: overflow a destra (${maxRight})`);
  assert(maxBottom <= layout.height - layout.padding + 0.01, `${label}: overflow in basso (${maxBottom})`);
  assert(minCell > 0, `${label}: una cella ha dimensione zero/negativa`);
}

// --- Yu-Gi-Oh: 40 main / 15 extra / 15 side — Main dominante e più grande
// della V1 precedente (griglia UNICA condivisa: ~70px per questo dataset,
// calcolato a mano con la stessa formula prima di questa modifica) --------
{
  const deck = ygoDeck([...many(40, 'main', 'm'), ...many(15, 'extra', 'e'), ...many(15, 'side', 's')]);
  const model = normalizeDeckForImage(deck);
  const layout = computeDeckImageLayout(model, { layoutMode: 'readable' });
  assertNoOverflow(layout, '40/15/15 readable');
  const mainSection = layout.sections.find(s => s.key === 'main');
  const extraSection = layout.sections.find(s => s.key === 'extra');
  const sideSection = layout.sections.find(s => s.key === 'side');
  assert(mainSection.cards[0].w > 80, `Main deve essere sensibilmente più grande della V1 precedente (griglia unica ~70px per questo mazzo): ${mainSection.cards[0].w}`);
  assert(mainSection.cards[0].w > extraSection.cards[0].w, 'Main deve restare più grande di Extra');
  assert(mainSection.cards[0].w > sideSection.cards[0].w, 'Main deve restare più grande di Side');
  assert.equal(layout.width, DECK_IMAGE_WIDTH); assert.equal(layout.height, DECK_IMAGE_HEIGHT);
  console.log(`PASS Yu-Gi-Oh 40/15/15: Main dominante (${mainSection.cards[0].w.toFixed(1)}px, >80px atteso vs ~70px della griglia unica precedente), Extra/Side più compatti (${extraSection.cards[0].w.toFixed(1)}px/${sideSection.cards[0].w.toFixed(1)}px), nessun overflow, canvas 1080x1350`);
}

// --- Molte carte uniche: mai un overflow, mai uno shrink fino a zero -----
{
  for (const count of [60, 120, 250]) {
    const deck = ygoDeck(many(count, 'main', 'u'));
    const layout = computeDeckImageLayout(normalizeDeckForImage(deck));
    assertNoOverflow(layout, `${count} carte uniche`);
    assert.equal(layout.sections[0].cards.length, count, 'tutte le carte devono comparire');
  }
  console.log('PASS Yu-Gi-Oh molte carte uniche (60/120/250): Main fitto, nessun overflow, nessuna cella collassata');
}

// --- Molte quantità ×2/×3: badge leggibili (quantity portata nel layout) -
{
  const deck = ygoDeck([
    ...many(20, 'main', 'm', 2),
    ...many(5, 'main', 'x', 3)
  ]);
  const layout = computeDeckImageLayout(normalizeDeckForImage(deck));
  assertNoOverflow(layout, 'quantità x2/x3');
  const main = layout.sections.find(s => s.key === 'main');
  assert(main.cards.every(card => card.quantity === 2 || card.quantity === 3), 'la quantità deve restare portata su ogni carta del layout, pronta per il badge');
  assert(main.cards[0].w > 40, `celle troppo piccole per un badge leggibile: ${main.cards[0].w}`);
  console.log('PASS Yu-Gi-Oh quantità ×2/×3: quantità preservata per ogni carta, celle abbastanza grandi per badge leggibili');
}

// --- Readable vs Poster: Readable dà più spazio alle card (header/footer
// più sobri, quota Main maggiore) -----------------------------------------
{
  const deck = ygoDeck([...many(30, 'main', 'm'), ...many(10, 'extra', 'e'), ...many(10, 'side', 's')]);
  const model = normalizeDeckForImage(deck);
  const readable = computeDeckImageLayout(model, { layoutMode: 'readable' });
  const poster = computeDeckImageLayout(model, { layoutMode: 'poster' });
  assertNoOverflow(readable, 'readable'); assertNoOverflow(poster, 'poster');
  const mainReadable = readable.sections.find(s => s.key === 'main').cards[0].w;
  const mainPoster = poster.sections.find(s => s.key === 'main').cards[0].w;
  assert(mainReadable >= mainPoster, `Readable deve dare al Main celle uguali o più grandi di Poster (priorità alla leggibilità): readable=${mainReadable} poster=${mainPoster}`);
  assert(readable.header.height < poster.header.height, 'Readable deve avere un header più sobrio (più basso) di Poster');
  console.log(`PASS Readable vs Poster: Readable dà al Main celle >= Poster (${mainReadable.toFixed(1)}px vs ${mainPoster.toFixed(1)}px), header più sobrio`);
}

// --- One Piece: Leader/Main/DON, 50 carte nel Main -------------------------
{
  const deck = { name: 'One Piece V1.1', game: 'onepiece', format: '', deckTheme: null, signatureCardId: null, cards: [
    { catalogCardId: 'OP01-001', cardName: 'Leader', section: 'leader', quantity: 1, imageUrl: '' },
    ...many(50, 'main', 'm'),
    { catalogCardId: 'don-1', cardName: 'DON!!', section: 'don', quantity: 10, imageUrl: '' }
  ] };
  const model = normalizeDeckForImage(deck);
  assert.equal(model.sections.map(s => s.key).join(','), 'leader,main,don', 'le sezioni reali dell\'adapter One Piece devono restare leader/main/don, mai main/extra/side');

  const readable = computeDeckImageLayout(model, { layoutMode: 'readable' });
  assertNoOverflow(readable, 'One Piece readable');
  assert.equal(readable.sections[0].key, 'leader', 'in Readable il Leader resta una sezione compatta come le altre: nessuna riordinazione speciale');

  const poster = computeDeckImageLayout(model, { layoutMode: 'poster' });
  assertNoOverflow(poster, 'One Piece poster');
  assert.equal(poster.sections[0].key, 'leader', 'in Poster il Leader va sempre per primo (enfasi visiva in cima)');
  const leaderCardPoster = poster.sections[0].cards[0];
  const leaderCardReadable = readable.sections.find(s => s.key === 'leader').cards[0];
  assert(leaderCardPoster.w > leaderCardReadable.w, `il Leader deve avere una cornice dedicata più grande in Poster Mode rispetto a Readable: poster=${leaderCardPoster.w} readable=${leaderCardReadable.w}`);
  const mainSectionPoster = poster.sections.find(s => s.key === 'main');
  assert.equal(mainSectionPoster.cards.length, 50, 'tutte le 50 carte del Main devono comparire');
  console.log(`PASS One Piece: Leader/Main/DON riusati dall'adapter, 50 carte nel Main, Leader più grande in Poster (${leaderCardPoster.w.toFixed(1)}px) che in Readable (${leaderCardReadable.w.toFixed(1)}px), nessun overflow`);
}

// --- One Piece: artwork mancanti — il layout non dipende mai dagli URL ----
{
  const deck = { name: 'Senza artwork', game: 'onepiece', format: '', deckTheme: null, signatureCardId: null, cards: [
    { catalogCardId: 'OP01-001', cardName: 'Leader', section: 'leader', quantity: 1, imageUrl: '' },
    ...many(20, 'main', 'm').map(card => ({ ...card, imageUrl: '' })),
    { catalogCardId: 'don-1', cardName: 'DON!!', section: 'don', quantity: 10, imageUrl: '' }
  ] };
  const layout = computeDeckImageLayout(normalizeDeckForImage(deck), { layoutMode: 'poster' });
  assertNoOverflow(layout, 'One Piece artwork mancanti');
  assert(layout.sections.every(section => section.cards.every(card => Number.isFinite(card.w) && Number.isFinite(card.h))), 'ogni carta deve avere coordinate valide anche senza alcun artwork');
  console.log('PASS One Piece con artwork mancanti: il layout resta valido e senza overflow indipendentemente dagli URL delle carte');
}

// --- Nessuna sezione Main (solo compatte): nessun crash, nessun overflow -
{
  const deck = ygoDeck(many(6, 'side', 's'));
  const layout = computeDeckImageLayout(normalizeDeckForImage(deck));
  assertNoOverflow(layout, 'solo Side, nessun Main');
  console.log('PASS edge case: un mazzo senza Main (solo sezioni compatte) non genera errori né overflow');
}

console.log('PASS Decklist Image Generator V1.1: Main dominante e più grande, Extra/Side compatti, Readable/Poster, enfasi Leader in Poster, Yu-Gi-Oh e One Piece, nessun overflow su nessuno scenario richiesto');
