// Decklist Image Generator — logica pura (normalizzazione + layout + nome
// file), nessun DOM/canvas/Image reale necessario qui: normalizeDeckForImage/
// computeDeckImageLayout/sanitizeDeckFileNamePart non toccano mai document/
// Image/navigator. Il rendering/export reale (canvas, blob, artwork,
// condivisione) è coperto da scripts/deck-image-export-browser-smoke.mjs
// (Chrome reale via CDP).
import assert from 'node:assert/strict';
// js/deck-image-export.js -> games/index.js -> onepiece/catalog.js ->
// js/api.js, che legge window.FPT_CONFIG a livello di modulo (stesso gap
// già risolto in scripts/decks-milestone-smoke.mjs) — senza questi stub
// l'import fallisce prima di eseguire una sola assertion.
globalThis.window ??= { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { normalizeDeckForImage, computeDeckImageLayout, sectionTotalQuantity, sanitizeDeckFileNamePart, deckImageFileName, resolveImageAccent, DECK_IMAGE_WIDTH, DECK_IMAGE_HEIGHT } = await import('../js/deck-image-export.js');

function ygoDeck(cards, overrides = {}) {
  return { name: 'Blue-Eyes Control', ownerSlug: 'daniele', game: 'yugioh', format: 'TCG Avanzato', deckTheme: 'arcane-purple', signatureCardId: null, cards, ...overrides };
}

{
  const cards = [
    {catalogCardId:'11111',section:'main',cardType:'Trap Card',quantity:1},
    {catalogCardId:'22222',section:'main',cardType:'Effect Monster',quantity:2},
    {catalogCardId:'33333',section:'main',quantity:1},
    {catalogCardId:'44444',section:'main',cardType:'Fusion Monster',quantity:1},
    {catalogCardId:'55555',section:'side',cardType:'Trap Card',quantity:1},
    {catalogCardId:'66666',section:'side',cardType:'Spell Card',quantity:1}
  ];
  const before = JSON.stringify(cards);
  const model = normalizeDeckForImage(ygoDeck(cards),{cardTypes:{33333:'spell'}});
  assert.deepEqual(model.main.map(card=>card.catalogCardId),['22222','44444','33333','11111']);
  assert.deepEqual(model.side.map(card=>card.catalogCardId),['66666','55555']);
  assert.equal(JSON.stringify(cards),before,'Export must not reorder the saved deck');
  const compact = computeDeckImageLayout(normalizeDeckForImage(ygoDeck(cards.slice(0,4))));
  assert(compact.sections[0].cards[0].w > 200, 'Small decks should use larger cards instead of eight fixed columns');
  assert.deepEqual(normalizeDeckForImage(ygoDeck(cards,{game:'onepiece'})).main.map(card=>card.catalogCardId),['11111','22222','33333','44444']);
}

// --- Normalizzazione ------------------------------------------------------
{
  const deck = ygoDeck([
    { catalogCardId: '1', cardName: 'Ash Blossom', section: 'main', quantity: 1, imageUrl: 'https://images.ygoprodeck.com/images/cards/1.jpg' },
    { catalogCardId: '1', cardName: 'Ash Blossom', section: 'main', quantity: 1, imageUrl: 'https://images.ygoprodeck.com/images/cards/1.jpg' },
    { catalogCardId: '1', cardName: 'Ash Blossom', section: 'main', quantity: 1, imageUrl: 'https://images.ygoprodeck.com/images/cards/1.jpg' },
    { catalogCardId: '2', cardName: 'Effect Veiler', section: 'main', quantity: 1, imageUrl: '' },
    { catalogCardId: '10', cardName: 'Called by the Grave', section: 'extra', quantity: 2, imageUrl: '' },
    { catalogCardId: '20', cardName: 'Droll & Lock Bird', section: 'side', quantity: 3, imageUrl: '' }
  ], { signatureCardId: '2' });
  const model = normalizeDeckForImage(deck, { ownerName: 'Daniele' });

  assert.equal(model.owner, 'Daniele');
  assert.equal(model.game, 'yugioh');
  assert.equal(model.format, 'TCG Avanzato');
  assert.equal(model.main.length, 2, '3 copie di Ash Blossom devono collassare in UNA riga, non tre');
  const ash = model.main.find(c => c.catalogCardId === '1');
  assert.equal(ash.quantity, 3, 'la quantità aggregata deve sommare le 3 righe originali');
  assert.equal(ash.imageUrl, 'https://images.ygoprodeck.com/images/cards/1.jpg', 'export preserves complete card URL');
  assert.equal(model.extra.length, 1); assert.equal(model.extra[0].quantity, 2);
  assert.equal(model.side.length, 1); assert.equal(model.side[0].quantity, 3);
  assert.equal(model.signatureCard.catalogCardId, '2', 'la signature card deve riusare resolveDeckSignature(), non un lookup separato');
  console.log('PASS normalizzazione: quantità aggregate per catalogCardId (3x Ash Blossom -> 1 riga x3), sezioni main/extra/side, signature card');
}

// --- Sezione vuota ---------------------------------------------------------
{
  const deck = ygoDeck([{ catalogCardId: '1', cardName: 'Ash Blossom', section: 'main', quantity: 40, imageUrl: '' }]);
  const model = normalizeDeckForImage(deck);
  assert.equal(model.extra.length, 0); assert.equal(model.side.length, 0);
  const layout = computeDeckImageLayout(model);
  assert.equal(layout.sections.length, 1, 'una sezione vuota non deve produrre un blocco nel layout');
  assert.equal(layout.sections[0].key, 'main');
  console.log('PASS sezione vuota: extra/side assenti dal modello e dal layout, nessun blocco fantasma');
}

// --- Signature card assente --------------------------------------------
{
  const deck = ygoDeck([{ catalogCardId: '1', cardName: 'Solo Carta', section: 'main', quantity: 1, imageUrl: '' }], { signatureCardId: null });
  const model = normalizeDeckForImage(deck);
  assert.notEqual(model.signatureCard, undefined);
  // resolveDeckSignature() ricade sulla prima carta di main/extra quando non
  // c'è un signatureCardId esplicito (comportamento esistente, riusato) —
  // quindi qui NON è null: il vero test "nessuna signature" è un mazzo senza
  // alcuna carta in main/extra/leader.
  assert.equal(normalizeDeckForImage(ygoDeck([{ catalogCardId: '9', cardName: 'Solo Side', section: 'side', quantity: 1 }])).signatureCard, null, 'un mazzo senza main/extra non deve avere una signature card');
  console.log('PASS signature card assente: fallback gestito da resolveDeckSignature() già esistente, mai duplicato');
}

// --- One Piece: sezioni diverse (leader/main/don), mai un dato perso ------
{
  const deck = { name: 'Luffy Rush', game: 'onepiece', format: '', deckTheme: null, signatureCardId: null, cards: [
    { catalogCardId: 'OP01-001', cardName: 'Monkey.D.Luffy', section: 'leader', quantity: 1, imageUrl: '' },
    { catalogCardId: 'OP01-016', cardName: 'Roronoa Zoro', section: 'main', quantity: 4, imageUrl: '' },
    { catalogCardId: 'don-1', cardName: 'DON!!', section: 'don', quantity: 10, imageUrl: '' }
  ] };
  const model = normalizeDeckForImage(deck);
  const totalCards = model.sections.reduce((sum, s) => sum + sectionTotalQuantity(s.cards), 0);
  assert.equal(totalCards, 15, 'nessuna carta deve andare persa bucketizzando per le sezioni reali del gioco (leader/main/don, non main/extra/side)');
  assert.equal(model.sections.map(s => s.key).join(','), 'leader,main,don');
  assert.equal(model.extra.length, 0, 'One Piece non ha una sezione extra: la vista di comodo resta vuota, ma i dati vivono in sections');
  console.log('PASS One Piece: sezioni leader/main/don riusate dall\'adapter, nessuna carta persa, main/extra/side restano solo un alias di comodo');
}

// --- Layout: 40 main / 15 extra / 15 side, nessun overflow ---------------
{
  const many = (n, section, prefix) => Array.from({ length: n }, (_, i) => ({ catalogCardId: `${prefix}${i}`, cardName: `Card ${i}`, section, quantity: 1, imageUrl: '' }));
  const deck = ygoDeck([...many(40, 'main', 'm'), ...many(15, 'extra', 'e'), ...many(15, 'side', 's')]);
  const model = normalizeDeckForImage(deck);
  const layout = computeDeckImageLayout(model);
  let maxBottom = 0, maxRight = 0;
  for (const section of layout.sections) for (const card of section.cards) { maxBottom = Math.max(maxBottom, card.y + card.h); maxRight = Math.max(maxRight, card.x + card.w); }
  assert(maxRight <= layout.width - layout.padding + 0.01, `una carta esce a destra: ${maxRight} > ${layout.width - layout.padding}`);
  assert(maxBottom <= layout.height - layout.padding + 0.01, `una carta esce in basso: ${maxBottom} > ${layout.height - layout.padding}`);
  assert.equal(layout.sections.reduce((sum, s) => sum + s.cards.length, 0), 70, 'tutte le 70 carte uniche devono comparire nel layout');
  console.log('PASS layout 40 main + 15 extra + 15 side: nessuna carta esce dal canvas 1080x1350');
}

// --- Layout: 60 main (deck sovradimensionato), molte carte uniche --------
{
  const many = (n, prefix) => Array.from({ length: n }, (_, i) => ({ catalogCardId: `${prefix}${i}`, cardName: `Card ${i}`, section: 'main', quantity: 1, imageUrl: '' }));
  for (const count of [60, 120, 250]) {
    const model = normalizeDeckForImage(ygoDeck(many(count, 'u')));
    const layout = computeDeckImageLayout(model);
    let maxBottom = 0, maxRight = 0, minCell = Infinity;
    for (const card of layout.sections[0].cards) { maxBottom = Math.max(maxBottom, card.y + card.h); maxRight = Math.max(maxRight, card.x + card.w); minCell = Math.min(minCell, card.w); }
    assert(maxRight <= layout.width - layout.padding + 0.01, `count=${count}: overflow a destra`);
    assert(maxBottom <= layout.height - layout.padding + 0.01, `count=${count}: overflow in basso (${maxBottom} vs ${layout.height - layout.padding})`);
    assert(minCell > 0, `count=${count}: le celle non devono mai collassare a dimensione zero/negativa`);
  }
  console.log('PASS layout con molte carte uniche (60/120/250): le celle si restringono, mai un overflow, mai una dimensione invalida');
}

// --- Badge quantità (derivato dal modello, disegnato solo se quantity>1) --
{
  const deck = ygoDeck([
    { catalogCardId: '1', cardName: 'Solo1', section: 'main', quantity: 1, imageUrl: '' },
    { catalogCardId: '2', cardName: 'Due', section: 'main', quantity: 1, imageUrl: '' },
    { catalogCardId: '2', cardName: 'Due', section: 'main', quantity: 1, imageUrl: '' },
    { catalogCardId: '3', cardName: 'Tre', section: 'main', quantity: 3, imageUrl: '' }
  ]);
  const model = normalizeDeckForImage(deck);
  const byId = id => model.main.find(c => c.catalogCardId === id);
  assert.equal(byId('1').quantity, 1); assert.equal(byId('2').quantity, 2); assert.equal(byId('3').quantity, 3);
  console.log('PASS badge quantità: x1 (nessun badge atteso, quantity=1), x2 e x3 aggregati correttamente — il disegno reale del badge è verificato nel test browser');
}

// --- Export: dimensioni canvas attese e nome file sanitizzato -------------
{
  assert.equal(DECK_IMAGE_WIDTH, 1080); assert.equal(DECK_IMAGE_HEIGHT, 1350);
  assert.equal(sanitizeDeckFileNamePart('Blue-Eyes Control!! 2026'), 'blue-eyes-control-2026');
  assert.equal(sanitizeDeckFileNamePart('Mazzo à la Française / Special'), 'mazzo-a-la-francaise-special');
  assert.equal(sanitizeDeckFileNamePart(''), 'mazzo');
  assert.equal(deckImageFileName('Blue-Eyes Control'), 'fpt-deck-blue-eyes-control.png');
  assert.equal(deckImageFileName(''), 'fpt-deck-mazzo.png');
  console.log('PASS export: canvas 1080x1350 dichiarato, nome file sanitizzato (accenti/simboli/spazi rimossi, mai vuoto)');
}

// --- Tema: accento riusato da DECK_THEMES in modo conservativo -----------
// normalizeDeckTheme() (js/deck-box.js, non toccata) ricade già SEMPRE su
// DEFAULT_DECK_THEME ('arcane-purple') per un valore sconosciuto/assente —
// quindi resolveImageAccent() la eredita: un tema mai visto o null risolve
// comunque a un colore valido, mai un errore, mai undefined. Il fallback
// interno a resolveImageAccent() (palette FPT fissa) resta una rete di
// sicurezza aggiuntiva se in futuro DECK_THEMES/normalizeDeckTheme
// cambiassero comportamento — non raggiungibile con l'attuale
// implementazione di quelle due funzioni, verificato qui.
{
  assert.equal(resolveImageAccent('arcane-purple'), '#c66cff');
  assert.equal(resolveImageAccent('tema-inesistente'), '#c66cff', 'un tema sconosciuto eredita il fallback di normalizeDeckTheme() (arcane-purple), mai un errore');
  assert.equal(resolveImageAccent(null), '#c66cff');
  assert.equal(typeof resolveImageAccent(undefined), 'string');
  console.log('PASS tema: accento sempre risolto (via normalizeDeckTheme, mai un errore/undefined), riuso conservativo di DECK_THEMES');
}

console.log('PASS deck-image-export (logica pura): normalizzazione, sezioni multi-gioco, layout senza overflow su dataset piccoli/grandi, badge, filename, tema');
