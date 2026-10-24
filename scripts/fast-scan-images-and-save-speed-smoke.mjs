// Fast Scan (2026-10-24, due segnalazioni reali):
// 1. in revisione a volte compariva l'icona di riserva al posto della carta: le
//    stampe riconosciute dall'indice locale del catalogo (list_catalog_printings_index)
//    non hanno image_url, quelle dal server sì;
// 2. salvataggio nella Raccolta lentissimo: la verifica faceva una richiesta per
//    carta, in fila. Ora i codici partono in parallelo (max 6) con la stessa cache.
import assert from 'node:assert/strict';
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.document ??= { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
const { FastScanController, canonicalizeFastScanEntries } = await import('../js/fast-scan.js');

// 1. Immagini.
const c = new FastScanController({ camera: { stream: {}, stop() {}, focusSupported: false }, paddleOcr: { prepare: async () => {} }, isOnline: () => true, onRender() {}, onRoute() {}, onToast() {} });
c.mergeCatalogIndexRows([{ printing_id: '11111111-1111-4111-8111-111111111111', catalog_card_id: '40235813', card_name: 'Dark Time Wizard', set_code: 'BETB-IT052', set_name: 'Beyond the Brave', rarity: 'Ultra Rare' }]);
const [fromIndex] = c.lookupMemory('BETB-IT052').matches;
assert.equal(fromIndex.imageUrl, 'https://images.ygoprodeck.com/images/cards/40235813.jpg', 'stampa dall\'indice: immagine ricostruita dall\'id carta');
// Sessione già aperta con una carta senza immagine (salvata prima della correzione).
c.buffer.add({ printingId: 'p1', game: 'yugioh', catalogCardId: '40235813', cardName: 'Dark Time Wizard', setCode: 'BETB-IT052', rarity: 'Ultra Rare', imageUrl: '' });
c.phase = 'review';
const grid = c.reviewView();
assert.match(grid, /images\/cards_small\/40235813\.jpg/, 'tessera: miniatura leggera');
assert.doesNotMatch(grid, /class="fsx-tile-art"><span class="fsx-thumb-empty"/, 'niente icona di riserva');
c.reviewSheetKey = [...c.buffer.entries.keys()][0];
assert.match(c.reviewView(), /class="fsx-entry-art" src="https:\/\/images\.ygoprodeck\.com\/images\/cards\/40235813\.jpg"/, 'dettaglio: immagine grande');
c.phase = 'scanning';
assert.match(c.scannerView(), /cards_small\/40235813\.jpg/, 'tray dello scanner con la miniatura');
assert.match(c.detectionContent({ tone: 'ok', code: 'BETB-IT052', detail: 'Aggiunta', card: { ...fromIndex, imageUrl: '' } }), /cards_small\/40235813\.jpg/, 'riquadro dell\'esito con la miniatura');
// Un'immagine vera salvata vince sempre su quella ricostruita.
c.buffer.add({ printingId: 'p2', game: 'yugioh', catalogCardId: '1', cardName: 'X', setCode: 'TEST-EN001', rarity: 'Common', imageUrl: 'https://images.ygoprodeck.com/images/cards/99999.jpg' });
assert.match(c.scannerView(), /cards_small\/99999\.jpg/);

// 2. Verifica al salvataggio in parallelo.
const entries = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, game: 'yugioh', printingId: `p${i}`, catalogCardId: `10${i}`, cardName: `Card ${i}`, setCode: `TEST-EN0${String(i).padStart(2, '0')}`, setName: 'Test', rarity: 'Common', condition: 'Near Mint', language: 'Inglese', edition: '', quantity: 1 }));
let inFlight = 0, maxInFlight = 0, calls = 0;
const lookup = async code => {
  calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise(resolve => setTimeout(resolve, 40));
  inFlight--;
  const entry = entries.find(item => item.setCode === code);
  return [{ printing_id: entry.printingId, game: 'yugioh', catalog_card_id: entry.catalogCardId, card_name: entry.cardName, set_code: entry.setCode, set_name: 'Test', rarity: 'Common' }];
};
const started = Date.now();
const result = await canonicalizeFastScanEntries(entries, lookup);
const elapsed = Date.now() - started;
assert.equal(result.items.length, 12, 'tutte le carte verificate come prima');
assert.equal(result.rejected.length, 0);
assert.equal(calls, 12, 'una richiesta per codice, nessuna doppia');
assert.ok(maxInFlight > 1 && maxInFlight <= 6, `richieste in parallelo, al massimo 6 (viste ${maxInFlight})`);
assert.ok(elapsed < 12 * 40 * 0.6, `molto più veloce della fila (${elapsed} ms contro ${12 * 40} ms)`);
// Un codice in errore resta isolato su quella carta, come prima.
const failing = await canonicalizeFastScanEntries(entries.slice(0, 3), async code => { if (code === entries[1].setCode) throw new Error('rete'); return lookup(code); });
assert.equal(failing.items.length + failing.rejected.length, 3, 'ogni carta ha un esito, l\'errore non blocca le altre');
console.log(`PASS Fast Scan: immagini anche per le stampe dall'indice · verifica al salvataggio in parallelo (${elapsed} ms invece di ~${12 * 40} ms)`);
