// Editor Raccolta: stampe localizzate (EN → IT/FR/DE/SP) quando la carta è
// già nel nostro catalogo (card_printings).
// Caso reale (tester, 2026-10-13): PGLD-EN021 "Number C88: Gimmick Puppet
// Disaster Leo" in italiano. Il catalogo conosceva solo PGLD-EN021: la versione
// IT021 ricavata dall'inglese ereditava il printingId della riga inglese, quindi
// (1) l'elenco la fondeva con EN021 (dedup per printingId) e mostrava solo
// l'inglese, (2) un salvataggio avrebbe collegato la riga inglese. In più il
// cambio lingua nel form non ricalcolava l'elenco.
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };
const { collectionCardWithLocalizedPrintings, mergeAuthoritativePrintings, printingSetCodeForLanguage } = await import('../js/cards.js');
const { collectionPrintingOptions } = await import('../js/collection.js');

const ygoprodeck = { id: 6165656, name: 'Number C88: Gimmick Puppet Disaster Leo',
  printings: [{ setCode: 'PGLD-EN021', setName: 'Premium Gold', rarity: 'Gold Secret Rare' }] };
const enRow = { printing_id: 'db-en021', set_code: 'PGLD-EN021', set_name: 'Premium Gold', rarity: 'Gold Secret Rare' };
const options = (card, language) => collectionPrintingOptions(collectionCardWithLocalizedPrintings(card, language));

// 1. Carta già nel catalogo solo in inglese: l'italiano deve comparire, senza id.
const known = options(mergeAuthoritativePrintings(ygoprodeck, [enRow]), 'Italiano');
assert.deepEqual(known.map(o => o.setCode), ['PGLD-IT021', 'PGLD-EN021'], 'Italiano: IT021 prima, EN021 dopo: ' + JSON.stringify(known.map(o => o.setCode)));
assert.equal(known[0].printingId, null, 'la stampa IT021 ricavata dall\'inglese non deve portarsi dietro il printingId di EN021');
assert.equal(known[1].printingId, 'db-en021', 'EN021 resta collegata alla sua riga del catalogo');

// 2. Catalogo con entrambe le righe: nessun doppione, vince la riga vera.
const both = options(mergeAuthoritativePrintings(ygoprodeck, [enRow, { printing_id: 'db-it021', set_code: 'PGLD-IT021', set_name: 'Premium Gold', rarity: 'Gold Secret Rare' }]), 'Italiano');
assert.equal(both.filter(o => o.setCode === 'PGLD-IT021').length, 1, 'IT021 non deve comparire due volte: ' + JSON.stringify(both));
assert.equal(both.find(o => o.setCode === 'PGLD-IT021').printingId, 'db-it021', 'la riga IT021 del catalogo vince su quella ricavata');

// 3. Inglese: niente stampe aggiunte; solo YGOPRODeck: comportamento di sempre.
assert.deepEqual(options(mergeAuthoritativePrintings(ygoprodeck, [enRow]), 'Inglese').map(o => o.setCode), ['PGLD-EN021']);
assert.deepEqual(options(ygoprodeck, 'Italiano').map(o => o.setCode), ['PGLD-IT021', 'PGLD-EN021']);
assert.deepEqual(options(ygoprodeck, 'Francese').map(o => o.setCode), ['PGLD-FR021', 'PGLD-EN021']);

// 4. Cambio lingua: stessa stampa nella nuova lingua.
const it021 = known[0];
assert.equal(printingSetCodeForLanguage(it021, 'Inglese'), 'PGLD-EN021');
assert.equal(printingSetCodeForLanguage(it021, 'Tedesco'), 'PGLD-DE021');
assert.equal(printingSetCodeForLanguage(known[1], 'Italiano'), 'PGLD-IT021');
assert.equal(printingSetCodeForLanguage(it021, 'Giapponese'), 'PGLD-EN021', 'senza codice europeo si torna al codice d\'origine');

// 5. Collegamento nel form.
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
assert(/#collection-language'\)\?\.addEventListener\('change'[\s\S]{0,200}relocalizeCollectionEditor\(/.test(app), 'il cambio lingua deve ricalcolare le stampe (relocalizeCollectionEditor)');
assert((app.match(/collectionEditor\.baseCard = /g) || []).length >= 2, 'baseCard va impostata sia per una carta nuova sia per una già in raccolta');

console.log('PASS editor Raccolta: PGLD-EN021 nel catalogo → PGLD-IT021 proposta e salvabile (senza printingId inglese) · nessun doppione con la riga IT · cambio lingua ricalcola le stampe');
