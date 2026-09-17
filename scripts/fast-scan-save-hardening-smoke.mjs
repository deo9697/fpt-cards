// F.P.T Cards — P0 hardening 2026-09-17: rarity "New artwork" contaminata e
// batch save non isolato. Copre:
// 1) js/cards.js: sanitizeYugiohRarity/normalizeCatalogRarity riconoscono la
//    famiglia "new"/"reprint"/"new artwork" e ricadono su Common, mai su una
//    stringa artwork letterale nel campo rarity.
// 2) ScanSessionBuffer.printing()/rebuild(): ogni entry confermata — scan
//    fresco, ripristino da IndexedDB, import legacy — passa dalla stessa
//    sanitizzazione, e due copie della stessa carta con rarity grezza
//    diversa (contaminata vs già pulita) si aggregano in una sola entry.
// 3) canonicalizeFastScanEntries: un'identità irrisolvibile viene isolata in
//    `rejected`, mai propagata come eccezione che farebbe fallire l'intero
//    batch.
// 4) FastScanController.save(): 10 entry valide + 1 rarity contaminata (auto-
//    sanata) salvano tutte e 11 in un'unica chiamata; 10 valide + 1
//    davvero irrecuperabile salvano le 10 e lasciano l'undicesima nel buffer
//    locale, mai perse silenziosamente.
import assert from 'node:assert/strict';
import {ScanSessionBuffer} from '../js/fast-scan-core.js';
import {normalizeCatalogRarity, sanitizeYugiohRarity} from '../js/cards.js';

// --- 1) normalizzazione rarity -------------------------------------------
assert.equal(normalizeCatalogRarity('New artwork'), '', 'New artwork non è una rarità reale');
assert.equal(normalizeCatalogRarity('New'), '');
assert.equal(normalizeCatalogRarity('Reprint'), '');
assert.equal(normalizeCatalogRarity('Ultra Rare'), 'Ultra Rare', 'una rarità reale non deve essere alterata');
assert.equal(normalizeCatalogRarity('Starlight Rare'), 'Starlight Rare');
assert.equal(sanitizeYugiohRarity('New artwork'), 'Common', 'artwork contaminato ricade su Common, mai vuoto o letterale');
assert.equal(sanitizeYugiohRarity('New Artwork'), 'Common', 'case-insensitive');
assert.equal(sanitizeYugiohRarity('Reprint (new artwork)'), 'Common');
assert.equal(sanitizeYugiohRarity('Ultra Rare'), 'Ultra Rare');
assert.equal(sanitizeYugiohRarity(''), '', 'un campo davvero vuoto resta vuoto, non forzato a Common');
console.log('PASS sanitizeYugiohRarity/normalizeCatalogRarity: "New artwork" e famiglia non sopravvivono come rarità letterale');

// --- 2) ScanSessionBuffer: sanitizzazione su ogni percorso ----------------
const contaminated = {printingId:'', game:'yugioh', catalogCardId:'89777841', cardName:'Dogmatika Fleurdelis, the Knighted', setCode:'CH01-EN015', setName:'Championship Pack', rarity:'New artwork', imageUrl:'https://images.ygoprodeck.com/images/cards/89777841.jpg'};

const freshBuffer = new ScanSessionBuffer();
freshBuffer.add(contaminated);
assert.equal(freshBuffer.entries.size, 1);
assert.equal([...freshBuffer.entries.values()][0].rarity, 'Common', 'printing() deve sanitizzare la rarity di un nuovo scan confermato');

// Sessione ripristinata da IndexedDB (structuredClone di scanEvents, non
// passa da printing()): il gap reale trovato in questo turno.
const persistedSnapshot = {
  version: 2,
  scanEvents: [{
    id: 'evt-1', sequence: 1, createdAt: new Date().toISOString(), status: 'CONFIRMED',
    rawCode: 'CH01-EN015', normalizedCode: 'CH01-EN015', ocrConfidence: 96,
    matchType: 'high_confidence', printingId: '', cardName: contaminated.cardName,
    setCode: contaminated.setCode, rarity: contaminated.rarity, imageUrl: contaminated.imageUrl,
    source: 'camera', failureReason: '', resolutionVersion: 0, countsAsScan: true,
    printing: {...contaminated, key: [contaminated.game, contaminated.catalogCardId, contaminated.setCode, contaminated.rarity].join(':')}
  }],
  review: [], total: 1, scanned: 1,
  settings: {game:'yugioh', language:'Italiano', condition:'Near Mint', edition:'', autoAdd:true, vibration:true, sound:false},
  updatedAt: new Date().toISOString()
};
const restored = new ScanSessionBuffer(persistedSnapshot);
assert.equal(restored.entries.size, 1);
const restoredEntry = [...restored.entries.values()][0];
assert.equal(restoredEntry.rarity, 'Common', 'una sessione ripristinata da IndexedDB deve sanitizzare la rarity al rebuild, non solo alla creazione');
console.log('PASS ScanSessionBuffer: rarity contaminata sanata sia su scan fresco sia su sessione ripristinata da IndexedDB');

// Due copie della stessa carta, una con rarity grezza contaminata e una già
// pulita: devono aggregarsi in UNA entry con quantity 2, non restare separate
// per una differenza di chiave dovuta alla sola rarity grezza.
const mergeBuffer = new ScanSessionBuffer();
mergeBuffer.add({...contaminated});
mergeBuffer.add({...contaminated, rarity:'Common'});
assert.equal(mergeBuffer.entries.size, 1, 'rarity grezza diversa ma equivalente dopo sanitizzazione non deve produrre due entry');
assert.equal([...mergeBuffer.entries.values()][0].quantity, 2);
console.log('PASS ScanSessionBuffer: due copie con rarity grezza diversa ma sanitizzazione equivalente si aggregano correttamente');

// --- 3) canonicalizeFastScanEntries: isolamento, mai un'eccezione globale ---
// js/fast-scan.js importa (transitivamente) js/core.js, che legge
// localStorage al top-level: lo shim va pronto prima di questo import.
const localStore = new Map();
globalThis.localStorage = {getItem:key=>localStore.get(key)||null, setItem:(key,value)=>localStore.set(key,value), removeItem:key=>localStore.delete(key)};
globalThis.window = {addEventListener(){}};
globalThis.document = {hidden:false, addEventListener(){}, querySelector:()=>null, querySelectorAll:()=>[], createElement:()=>({getContext:()=>({})})};
const {canonicalizeFastScanEntries, FastScanController} = await import('../js/fast-scan.js');

function validEntry(index) {
  return {printingId:'', game:'yugioh', catalogCardId:String(90000000+index), cardName:`Carta valida ${index}`, setCode:`ABCD-IT${String(index).padStart(3,'0')}`, setName:'Set di test', rarity:'Common', imageUrl:'', quantity:1, language:'Italiano', condition:'Near Mint', edition:''};
}
const tenValid = Array.from({length:10}, (_, i) => validEntry(i));
const oneUnrecoverable = {printingId:'', game:'yugioh', catalogCardId:'', cardName:'', setCode:'', quantity:1, language:'Italiano', condition:'Near Mint', edition:''};

const mixedResult = await canonicalizeFastScanEntries([...tenValid, oneUnrecoverable]);
assert.equal(mixedResult.items.length, 10, 'le 10 entry valide non devono andare perse per colpa di una sola entry irrecuperabile');
assert.equal(mixedResult.rejected.length, 1);
assert.match(mixedResult.rejected[0].message, /non valid|non compatibile/i);
console.log('PASS canonicalizeFastScanEntries: 10 entry valide + 1 irrecuperabile -> 10 salvabili isolando la sola entry rotta, nessuna eccezione');

const rarityHealResult = await canonicalizeFastScanEntries([{...validEntry(99), rarity:'New artwork'}]);
assert.equal(rarityHealResult.items.length, 1);
assert.equal(rarityHealResult.rejected.length, 0);
assert.equal(rarityHealResult.items[0].rarity, 'Common', 'una rarity contaminata sopravvissuta fino a qui va sanata, non isolata: Common è un valore reale e sicuro');
console.log('PASS canonicalizeFastScanEntries: rarity "New artwork" ancora presente a questo punto viene sanata automaticamente, non rifiutata');

// --- 4) FastScanController.save(): integrazione end-to-end ----------------
function makeController(api) {
  return new FastScanController({camera:{stream:{}, stop(){}}, api, paddleOcr:{prepare:async()=>{}, dispose:async()=>{}}, getCollection:()=>({mine:[], team:[]}), isOnline:()=>true, onRender(){}, onRoute(){}, onToast(){}});
}

// 4a) tutte e 11 salvabili (rarity contaminata auto-sanata).
{
  let savedItems = null, toastMessage = '';
  const controller = makeController({saveCollectionBatch: async items => {savedItems = items; return {savedItems: items.length, totalQuantity: items.length};}});
  controller.onToast = message => {toastMessage = message;};
  for (const entry of tenValid) controller.buffer.add(entry);
  controller.buffer.add({...validEntry(100), rarity:'New artwork'});
  await controller.save();
  assert.equal(savedItems?.length, 11, 'tutte le 11 entry devono arrivare in un\'unica chiamata RPC dopo la sanitizzazione automatica');
  assert(savedItems.every(item => item.rarity !== 'New artwork'), 'nessun payload verso il backend deve contenere una rarity artwork letterale');
  assert.equal(controller.buffer.entries.size, 0, 'salvataggio completo: la sessione locale deve essere svuotata');
  assert.match(toastMessage, /Sessione salvata/);
  clearTimeout(controller.persistTimer);
}

// 4b) 10 valide + 1 davvero irrecuperabile: salvataggio parziale, nulla perso.
{
  let savedItems = null, toastMessage = '';
  const controller = makeController({saveCollectionBatch: async items => {savedItems = items; return {savedItems: items.length, totalQuantity: items.length};}});
  controller.onToast = message => {toastMessage = message;};
  for (const entry of tenValid) controller.buffer.add(entry);
  controller.buffer.add(oneUnrecoverable);
  assert.equal(controller.buffer.entries.size, 11, 'precondizione: 11 entry nel buffer prima del salvataggio');
  await controller.save();
  assert.equal(savedItems?.length, 10, 'solo le 10 entry valide devono raggiungere la RPC');
  assert.equal(controller.buffer.entries.size, 1, 'la sola entry irrecuperabile deve restare nel buffer locale, non essere persa');
  const remaining = [...controller.buffer.entries.values()][0];
  assert.equal(remaining.cardName, '', 'la entry rimasta è proprio quella irrecuperabile, non una delle 10 valide');
  assert.match(toastMessage, /10 carte salvate/, 'il messaggio deve distinguere il salvataggio parziale da uno completo');
  assert.match(toastMessage, /da correggere/);
  clearTimeout(controller.persistTimer);
}

console.log('PASS FastScanController.save(): rarity contaminata sanata automaticamente; entry davvero irrecuperabile isolata senza perdere le altre 10');
