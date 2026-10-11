import assert from 'node:assert/strict';
import {ScanSessionBuffer} from '../js/fast-scan-core.js';
import {normalizeCatalogRarity, sanitizeYugiohRarity} from '../js/cards.js';

assert.equal(normalizeCatalogRarity('New artwork'), '', 'New artwork non è una rarità reale');
assert.equal(normalizeCatalogRarity('New'), '');
assert.equal(normalizeCatalogRarity('Reprint'), '');
assert.equal(normalizeCatalogRarity('Ultra Rare'), 'Ultra Rare', 'una rarità reale non deve essere alterata');
assert.equal(normalizeCatalogRarity('Starlight Rare'), 'Starlight Rare');
assert.equal(sanitizeYugiohRarity('New artwork'), '', 'metadata is not a physical rarity');
assert.equal(sanitizeYugiohRarity('New Artwork'), '', 'metadata is not a physical rarity');
assert.equal(sanitizeYugiohRarity('Reprint (new artwork)'), '', 'metadata is not a physical rarity');
assert.equal(sanitizeYugiohRarity('Ultra Rare'), 'Ultra Rare');
assert.equal(sanitizeYugiohRarity(''), '', 'un campo davvero vuoto resta vuoto, non forzato a Common');

const contaminated = {printingId:'', game:'yugioh', catalogCardId:'89777841', cardName:'Dogmatika Fleurdelis, the Knighted', setCode:'CH01-EN015', setName:'Championship Pack', rarity:'New artwork', imageUrl:'https://images.ygoprodeck.com/images/cards/89777841.jpg'};

const freshBuffer = new ScanSessionBuffer();
freshBuffer.add(contaminated);
assert.equal(freshBuffer.entries.size, 1);
assert.equal([...freshBuffer.entries.values()][0].rarity, '', 'printing() deve sanitizzare la rarity di un nuovo scan confermato');

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
assert.equal(restoredEntry.rarity, '', 'una sessione ripristinata da IndexedDB deve sanitizzare la rarity al rebuild, non solo alla creazione');

const mergeBuffer = new ScanSessionBuffer();
mergeBuffer.add({...contaminated});
mergeBuffer.add({...contaminated, rarity:'Common'});
assert.equal(mergeBuffer.entries.size, 2, 'unknown and explicit Common must remain distinct');
assert.equal([...mergeBuffer.entries.values()][0].quantity, 1);

const localStore = new Map();
globalThis.localStorage = {getItem:key=>localStore.get(key)||null, setItem:(key,value)=>localStore.set(key,value), removeItem:key=>localStore.delete(key)};
globalThis.window = {addEventListener(){}};
globalThis.document = {hidden:false, addEventListener(){}, querySelector:()=>null, querySelectorAll:()=>[], createElement:()=>({getContext:()=>({})})};
const {canonicalizeFastScanEntries, FastScanController} = await import('../js/fast-scan.js');

function validEntry(index) {
  return {printingId:'', game:'yugioh', catalogCardId:String(90000000+index), cardName:`Carta valida ${index}`, setCode:`ABCD-IT${String(index).padStart(3,'0')}`, setName:'Set di test', rarity:'Common', imageUrl:'', quantity:1, language:'Italiano', condition:'Near Mint', edition:''};
}
const tenValid = Array.from({length:10}, (_, i) => validEntry(i));
const lookupPrintings = async code => tenValid.filter(row=>row.setCode===code).map(row=>({...row,printingId:`db-${row.catalogCardId}`}));
const oneUnrecoverable = {printingId:'', game:'yugioh', catalogCardId:'', cardName:'', setCode:'', quantity:1, language:'Italiano', condition:'Near Mint', edition:''};

const mixedResult = await canonicalizeFastScanEntries([...tenValid, oneUnrecoverable],lookupPrintings);
assert.equal(mixedResult.items.length, 10, 'le 10 entry valide non devono andare perse per colpa di una sola entry irrecuperabile');
assert.equal(mixedResult.rejected.length, 1);
assert.match(mixedResult.rejected[0].message, /non valid|non compatibile/i);

const rarityHealResult = await canonicalizeFastScanEntries([{...validEntry(99), rarity:'New artwork'}]);
assert.equal(rarityHealResult.items.length, 0);
assert.equal(rarityHealResult.rejected.length, 1);
assert.equal(rarityHealResult.rejected[0].code, 'REQUIRES_CATALOG_REPAIR');

function makeController(api) {
  return new FastScanController({camera:{stream:{}, stop(){}}, api, paddleOcr:{prepare:async()=>{}, dispose:async()=>{}}, getCollection:()=>({mine:[], team:[]}), isOnline:()=>true, onRender(){}, onRoute(){}, onToast(){}});
}

{
  let savedItems = null, toastMessage = '';
  const controller = makeController({lookupPrintings,saveCollectionBatch: async items => {savedItems = items; return {savedItems: items.length, totalQuantity: items.length};}});
  controller.onToast = message => {toastMessage = message;};
  for (const entry of tenValid) controller.buffer.add(entry);
  controller.buffer.add({...validEntry(100), rarity:'New artwork'});
  await controller.save();
  assert.equal(savedItems?.length, 10, 'unknown rarity must not reach the RPC');
  assert(savedItems.every(item => item.rarity !== 'New artwork'), 'nessun payload verso il backend deve contenere una rarity artwork letterale');
  assert.equal(controller.buffer.entries.size, 1, 'unknown rarity remains locally for correction');
  assert.match(toastMessage, /10 carte salvate/);
  clearTimeout(controller.persistTimer);
}

{
  let savedItems = null, toastMessage = '';
  const controller = makeController({lookupPrintings,saveCollectionBatch: async items => {savedItems = items; return {savedItems: items.length, totalQuantity: items.length};}});
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


console.log('PASS unknown rarity rejected, explicit Common preserved, valid partial saves retain unresolved entries');
