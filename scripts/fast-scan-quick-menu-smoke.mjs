// Menu rapido Fast Scan (2026-11-09): dopo ogni carta riconosciuta si
// scelgono condizione, 1ª edizione, copie e, se la carta ha più illustrazioni
// note, quale art. Verifica che le scelte arrivino alla sessione e al
// payload di salvataggio, che l'art scelta non venga mai ricondotta a quella
// principale e che la cattura resti in pausa finché il menu è aperto.
import assert from 'node:assert/strict';
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {} };
globalThis.document = { hidden: false, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
const { FastScanController, canonicalizeFastScanEntries } = await import('../js/fast-scan.js');

let count = 0;
const check = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };

const MAIN = '89631139', ALT = '89631140';
const blueEyes = { printingId: 'db-sdbe-it001', catalogCardId: MAIN, game: 'yugioh', cardName: 'Blue-Eyes White Dragon', setCode: 'SDBE-IT001', setName: 'Saga of Blue-Eyes White Dragon', rarity: 'Ultra Rare', imageUrl: `https://images.ygoprodeck.com/images/cards/${MAIN}.jpg` };
const artworkCard = { artworkVariants: [MAIN, ALT, '89631141'].map(id => ({ id, imageUrl: `https://images.ygoprodeck.com/images/cards/${id}.jpg` })) };
const controller = (findArtworkCard = async () => artworkCard) => {
  const c = new FastScanController({ camera: {}, api: {}, paddleOcr: {}, getCollection: () => ({ mine: [], team: [] }), isOnline: () => true, onRender() {}, onRoute() {}, onToast() {}, findArtworkCard });
  c.phase = 'scanning';
  return c;
};
const scanOf = (c, printing) => { const scan = c.buffer.createScan(); c.buffer.confirmScan(scan.id, printing, 'EXACT_UNIQUE'); return scan; };

await check('si apre dopo la scansione e mette in pausa la cattura', async () => {
  const c = controller(); c.timer = 123;
  const scan = scanOf(c, blueEyes);
  c.openQuickMenu(scan.id);
  assert.ok(c.quickMenu, 'menu aperto');
  assert.equal(c.timer, 0, 'il ciclo di cattura si ferma');
  assert.equal(c.quickMenu.condition, 'Near Mint');
  assert.equal(c.quickMenu.quantity, 1);
  assert.match(c.quickMenuView(), /Condizione/);
  clearTimeout(c.persistTimer);
});

await check('illustrazioni: la riga compare solo con più art note, preselezionata quella della stampa', async () => {
  const c = controller();
  const scan = scanOf(c, blueEyes);
  c.openQuickMenu(scan.id);
  await c.loadQuickMenuArts(scan.id);
  assert.equal(c.quickMenu.arts.length, 3);
  assert.equal(c.quickMenu.art, 0, 'preselezionata l\'art della stampa riconosciuta');
  assert.match(c.quickMenuView(), /Quale art ha la carta\?/);
  assert.match(c.quickMenuView(), /cards_cropped\/89631140\.jpg/, 'miniature dal ritaglio dell\'illustrazione');
  const single = controller(async () => ({ artworkVariants: [{ id: MAIN, imageUrl: 'x' }] }));
  const scan2 = scanOf(single, blueEyes);
  single.openQuickMenu(scan2.id);
  await single.loadQuickMenuArts(scan2.id);
  assert.doesNotMatch(single.quickMenuView(), /Quale art/, 'una sola illustrazione: nessuna domanda');
  clearTimeout(c.persistTimer); clearTimeout(single.persistTimer);
});

await check('OK applica condizione, 1ª edizione, copie e art alla sessione', async () => {
  const c = controller();
  const scan = scanOf(c, blueEyes);
  c.openQuickMenu(scan.id);
  await c.loadQuickMenuArts(scan.id);
  c.quickMenu.condition = 'Played'; c.quickMenu.firstEdition = true; c.quickMenu.quantity = 3; c.quickMenu.art = 1;
  await c.confirmQuickMenu();
  assert.equal(c.quickMenu, null, 'menu chiuso');
  const entries = [...c.buffer.entries.values()];
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.catalogCardId, ALT, 'id dell\'art scelta');
  assert.equal(entry.printingId, '', 'nessun printingId della stampa con l\'art principale');
  assert.equal(entry.userArtwork, true);
  assert.equal(entry.artworkOf, MAIN);
  assert.equal(entry.condition, 'Played');
  assert.equal(entry.edition, 'Prima Edizione');
  assert.equal(entry.quantity, 3);
  assert.equal(c.buffer.settings.condition, 'Played', 'ultima scelta ricordata per la carta successiva');
  assert.equal(c.buffer.settings.edition, 'Prima Edizione');
  clearTimeout(c.persistTimer);
});

await check('1ª edizione spenta su una carta che era 1ª la rimette non specificata', async () => {
  const c = controller(async () => null);
  const scan = scanOf(c, { ...blueEyes, edition: 'Prima Edizione' });
  c.openQuickMenu(scan.id);
  assert.equal(c.quickMenu.firstEdition, true);
  c.quickMenu.firstEdition = false;
  await c.confirmQuickMenu();
  assert.equal([...c.buffer.entries.values()][0].edition, '');
  assert.equal([...c.buffer.entries.values()][0].catalogCardId, MAIN, 'nessuna art scelta: stampa invariata');
  clearTimeout(c.persistTimer);
});

await check('il menu si può spegnere dalle impostazioni', async () => {
  const c = controller();
  assert.equal(c.quickMenuEnabled(), true, 'acceso di default');
  c.buffer.settings = { ...c.buffer.settings, quickMenu: false };
  assert.equal(c.quickMenuEnabled(), false);
  clearTimeout(c.persistTimer);
});

await check('uscendo con il menu aperto valgono le scelte fatte', async () => {
  const c = controller(async () => null);
  const scan = scanOf(c, blueEyes);
  c.openQuickMenu(scan.id);
  c.quickMenu.condition = 'Excellent'; c.quickMenu.quantity = 2;
  c.flushQuickMenu();
  const entry = [...c.buffer.entries.values()][0];
  assert.equal(entry.condition, 'Excellent');
  assert.equal(entry.quantity, 2);
  assert.equal(c.quickMenu, null);
  clearTimeout(c.persistTimer);
});

const mainRow = { printing_id: 'db-sdbe-it001', game: 'yugioh', catalog_card_id: MAIN, card_name: 'Blue-Eyes White Dragon', set_code: 'SDBE-IT001', set_name: 'Saga', rarity: 'Ultra Rare', image_url: blueEyes.imageUrl };
const altEntry = { ...blueEyes, printingId: '', catalogCardId: ALT, imageUrl: `https://images.ygoprodeck.com/images/cards/${ALT}.jpg`, userArtwork: true, artworkOf: MAIN, quantity: 1, language: 'Italiano', condition: 'Near Mint', edition: '' };

await check('salvataggio: art scelta assente a catalogo → si crea accanto a quella principale', async () => {
  const result = await canonicalizeFastScanEntries([altEntry], async () => [mainRow]);
  assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
  assert.equal(result.items[0].catalogCardId, ALT, 'mai ricondotta all\'art principale');
  assert.equal(result.items[0].printingId, '');
  assert.equal(result.decisions[0].validationResult, 'CREATE_ARTWORK_PRINTING');
});

await check('salvataggio: art scelta già a catalogo → usa quella stampa', async () => {
  const altRow = { ...mainRow, printing_id: 'db-sdbe-it001-alt', catalog_card_id: ALT, image_url: altEntry.imageUrl };
  const result = await canonicalizeFastScanEntries([altEntry], async () => [mainRow, altRow]);
  assert.equal(result.items[0].printingId, 'db-sdbe-it001-alt');
  assert.equal(result.items[0].catalogCardId, ALT);
});

await check('salvataggio: art di un\'altra carta o rarità assente restano bloccate', async () => {
  const wrongBase = await canonicalizeFastScanEntries([{ ...altEntry, artworkOf: '12345' }], async () => [mainRow]);
  assert.notEqual(wrongBase.decisions[0]?.validationResult, 'CREATE_ARTWORK_PRINTING', 'artworkOf che non corrisponde alla stampa: niente creazione');
  assert.equal(wrongBase.items[0]?.printingId || '', mainRow.printing_id, 'ricade sulla stampa esistente, mai una riga nuova');
  const otherRarity = await canonicalizeFastScanEntries([{ ...altEntry, rarity: 'Secret Rare' }], async () => [mainRow]);
  assert.equal(otherRarity.items.length, 0, 'rarità non a catalogo per quel codice: resta un errore');
});

console.log(`Fast Scan quick menu: ${count}/${count} PASS`);
