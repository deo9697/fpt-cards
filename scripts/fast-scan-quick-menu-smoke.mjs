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

// 2026-11-15: con le stampe non ancora nell'indice locale la conferma arriva
// dalla verifica in rete (percorso "pendingId") e il menu non si apriva mai:
// agli utenti sembrava che si aprisse "a caso".
const pendingRun = async ({ moveOn = false } = {}) => {
  const c = controller();
  c.persist = async () => {}; c.showDetection = () => {}; c.showResolvedFeedback = () => {}; c.setStatus = () => {}; c.refreshHud = () => {}; c.feedback = () => {};
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  c.resolve = async code => { await gate; return { status:'high_confidence', decision:'EXACT_UNIQUE', matches:[blueEyes], code, ocrConfidence:95 }; };
  const result = await c.resolveCapturedReading({ text:'SDBE-IT001', confidence:95 });
  assert.equal(result.status, 'pending_async', 'la carta passa dalla verifica in rete');
  assert.equal(c.quickMenu, null, 'nessun menu mentre la verifica è in corso');
  if (moveOn) c.currentScanId = 'altra-carta';
  release();
  await c.pendingResolution;
  return c;
};
await check('verifica in rete: a conferma arrivata il menu si apre sulla carta in mano', async () => {
  const c = await pendingRun();
  assert.ok(c.quickMenu, 'menu aperto anche dopo la conferma remota');
  assert.equal(c.buffer.getScan(c.quickMenu.scanId).status, 'CONFIRMED');
  assert.equal(c.timer, 0, 'la cattura resta in pausa');
  clearTimeout(c.persistTimer);
});
await check('verifica in rete: se nel frattempo sei passato a un\'altra carta il menu non salta fuori', async () => {
  const c = await pendingRun({ moveOn:true });
  assert.equal(c.quickMenu, null);
  clearTimeout(c.persistTimer);
});
await check('fotocamera: sui telefoni con più obiettivi si sceglie il principale ("camera2 0")', async () => {
  const { preferredBackCamera } = await import('../js/fast-scan-camera.js');
  const device = (deviceId, label) => ({ deviceId, label, kind:'videoinput' });
  const samsung = [device('front', 'camera2 1, facing front'), device('wide', 'camera2 2, facing back'), device('main', 'camera2 0, facing back'), device('tele', 'camera2 3, facing back')];
  assert.equal(preferredBackCamera(samsung)?.deviceId, 'main');
  assert.equal(preferredBackCamera([device('a', 'Back Camera'), device('b', 'Front Camera')]), null, 'etichette senza numero (iPhone): nessun cambio');
  assert.equal(preferredBackCamera([device('main', 'camera2 0, facing back'), device('front', 'camera2 1, facing front')]), null, 'un solo obiettivo posteriore: nessun cambio');
  assert.equal(preferredBackCamera([]), null);
});

// 2026-11-15: CORI-EN027 esiste in Ultra/Secret/Starlight con la stessa
// immagine; una Ultra Rare era finita in Raccolta come Secret (prezzo 40 € invece di 5 €).
const { quickMenuRarityOptions } = await import('../js/fast-scan.js');
const coriRow = (rarity, printingId) => ({ printingId, game: 'yugioh', catalogCardId: '44001993', cardName: 'Magician of Dark Chaos - Black Chaos', setCode: 'CORI-EN027', setName: 'Chaos Origins', rarity, imageUrl: 'https://images.ygoprodeck.com/images/cards/44001993.jpg' });
const coriRows = [coriRow('Starlight Rare', 'p-star'), coriRow('Secret Rare', 'p-secret'), coriRow('Ultra Rare', 'p-ultra'), { ...coriRow('Ultra Rare', ''), printingId: '' }];
await check('rarità: opzioni uniche per codice e carta, in ordine Ultra < Secret < Starlight', async () => {
  const options = quickMenuRarityOptions(coriRows, coriRow('Secret Rare', 'p-secret'));
  assert.deepEqual(options.map(option => option.rarity), ['Ultra Rare', 'Secret Rare', 'Starlight Rare']);
  assert.equal(options[0].printing.printingId, 'p-ultra', 'tra due righe uguali vince quella con printingId');
  assert.equal(quickMenuRarityOptions([coriRow('Ultra Rare', 'x'), { ...coriRow('Secret Rare', 'y'), catalogCardId: '999' }], coriRow('Ultra Rare', 'x')).length, 1, 'mai rarità di un\'altra carta');
});
await check('rarità: nel menu si corregge Secret → Ultra e la sessione usa la stampa Ultra esatta', async () => {
  const c = controller(async () => null);
  c.lookupDetailed = async () => ({ matches: coriRows });
  const scan = scanOf(c, coriRow('Secret Rare', 'p-secret'));
  c.openQuickMenu(scan.id);
  await c.loadQuickMenuRarities(scan.id);
  assert.equal(c.quickMenu.rarities.length, 3);
  assert.equal(c.quickMenu.rarities[c.quickMenu.rarity].rarity, 'Secret Rare', 'preselezionata la rarità scelta allo scanner');
  assert.match(c.quickMenuView(), /Che rarità è\?/);
  c.quickMenu.rarity = 0;
  await c.confirmQuickMenu();
  const entries = [...c.buffer.entries.values()];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rarity, 'Ultra Rare');
  assert.equal(entries[0].printingId, 'p-ultra');
  clearTimeout(c.persistTimer);
});
await check('rarità: un codice con una sola rarità non mostra la riga', async () => {
  const c = controller(async () => null);
  c.lookupDetailed = async () => ({ matches: [blueEyes] });
  const scan = scanOf(c, blueEyes);
  c.openQuickMenu(scan.id);
  await c.loadQuickMenuRarities(scan.id);
  assert.doesNotMatch(c.quickMenuView(), /Che rarità è/);
  clearTimeout(c.persistTimer);
});
await check('salvataggio: la rarità scelta non cambia mai in silenzio', async () => {
  const chosen = { ...coriRow('Ultra Rare', ''), printingId: '', quantity: 1, language: 'Inglese', condition: 'Near Mint', edition: '', key: 'k' };
  const lookup = async () => [{ printing_id: 'p-secret', game: 'yugioh', catalog_card_id: '44001993', card_name: chosen.cardName, set_code: 'CORI-EN027', set_name: 'Chaos Origins', rarity: 'Secret Rare', image_url: chosen.imageUrl }];
  const result = await canonicalizeFastScanEntries([chosen], lookup);
  assert.equal(result.items.filter(item => item.rarity === 'Secret Rare').length, 0, 'mai salvata come Secret');
  assert.equal(result.rejected.length, 1, 'resta in sessione con il motivo');
  const ok = await canonicalizeFastScanEntries([chosen], async () => [...(await lookup()), { printing_id: 'p-ultra', game: 'yugioh', catalog_card_id: '44001993', card_name: chosen.cardName, set_code: 'CORI-EN027', set_name: 'Chaos Origins', rarity: 'Ultra Rare', image_url: chosen.imageUrl }]);
  assert.equal(ok.items[0]?.rarity, 'Ultra Rare'); assert.equal(ok.items[0]?.printingId, 'p-ultra');
});
await check('dopo il salvataggio: avviso se in Raccolta la rarità non è quella scelta', async () => {
  const toasts = [];
  const c = new FastScanController({ camera: {}, api: {}, paddleOcr: {}, getCollection: () => ({ mine: [{ setCode: 'CORI-EN027', rarity: 'Secret Rare' }, { setCode: 'SDBE-IT001', rarity: 'Ultra Rare' }], team: [] }), isOnline: () => true, onRender() {}, onRoute() {}, onToast: m => toasts.push(m) });
  const missing = c.verifySavedRarities([{ cardName: 'Black Chaos', setCode: 'CORI-EN027', rarity: 'Ultra Rare' }, { cardName: 'Blue-Eyes', setCode: 'SDBE-IT001', rarity: 'Ultra Rare' }]);
  assert.equal(missing.length, 1); assert.match(toasts[0], /CORI-EN027 Ultra Rare/);
  clearTimeout(c.persistTimer);
});

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
