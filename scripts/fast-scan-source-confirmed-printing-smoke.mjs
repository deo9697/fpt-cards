// Fast Scan: stampa assente dal catalogo (card_printings), creata al
// salvataggio SOLO se YGOPRODeck conferma esattamente codice e rarità
// (2026-10-13, caso reale BLZD-EN004/012/017/086). Senza conferma esplicita
// nessuna creazione implicita, come prima.
import assert from 'node:assert/strict';
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };
const { canonicalizeFastScanEntries, confirmPrintingFromCatalogSource } = await import('../js/fast-scan.js');

const entry = { game: 'yugioh', printingId: '', catalogCardId: '82933935', cardName: 'Mimighoul Flower', setCode: 'BLZD-EN017', setName: 'Blazing Dominion', rarity: 'Common', language: 'Inglese', condition: 'Near Mint', edition: '', quantity: 1 };
const none = async () => [];

// 1. Assente + conferma → passa al server senza printingId (lo crea con la sua verifica d'identità).
const created = await canonicalizeFastScanEntries([entry], none, async () => null, async () => true);
assert.equal(created.items.length, 1, 'stampa confermata dalla fonte: deve essere salvabile');
assert.equal(created.items[0].printingId, '', 'il server crea la riga: nessun printingId inventato');
assert.equal(created.decisions[0].validationResult, 'CREATE_FROM_VERIFIED_SOURCE', 'la decisione deve dichiarare la creazione da fonte verificata');

// 2. Assente senza conferma (o conferma negativa / in errore) → rifiutata col motivo.
for (const confirm of [undefined, async () => false, async () => { throw new Error('rete'); }]) {
  const result = await canonicalizeFastScanEntries([entry], none, async () => null, confirm);
  assert.equal(result.items.length, 0, 'senza conferma nessuna creazione implicita');
  assert.equal(result.rejected[0].code, 'REQUIRES_CATALOG_REPAIR');
  assert.match(result.rejected[0].message, /non ancora nel catalogo/, 'il messaggio deve spiegare il motivo');
}

// 3. Codice noto ma senza questa rarità (c'è l'Ultra, manca la Starlight) + conferma → salvabile.
const ultraRow = { printing_id: '11111111-1111-4111-8111-111111111111', game: 'yugioh', catalog_card_id: '19144622', card_name: 'Fairy Tail - Matchgiru', set_code: 'BLZD-EN016', set_name: 'Blazing Dominion', rarity: 'Ultra Rare' };
const starlight = { ...entry, catalogCardId: '19144622', cardName: 'Fairy Tail - Matchgiru', setCode: 'BLZD-EN016', rarity: 'Starlight Rare' };
assert.equal((await canonicalizeFastScanEntries([starlight], async () => [ultraRow], async () => null, async () => true)).items.length, 1, 'rarità mancante confermata: salvabile');
assert.equal((await canonicalizeFastScanEntries([starlight], async () => [ultraRow])).items.length, 0, 'rarità mancante senza conferma: rifiutata come prima');

// 4. Varianti di artwork: mai create automaticamente.
assert.equal((await canonicalizeFastScanEntries([{ ...entry, variantId: 'b' }], none, async () => null, async () => true)).items.length, 0, 'variante di artwork: niente creazione automatica');

// 5. La conferma: stesso codice o gemello inglese, stessa rarità, stessa carta.
const card = { id: 82933935, printings: [{ setCode: 'BLZD-EN017', rarity: 'Common' }, { setCode: 'BLZD-EN099', rarity: 'Super Rare' }] };
const find = async id => (String(id) === '82933935' ? card : null);
assert.equal(await confirmPrintingFromCatalogSource(entry, find), true, 'stesso codice e rarità');
assert.equal(await confirmPrintingFromCatalogSource({ ...entry, setCode: 'BLZD-IT017', language: 'Italiano' }, find), true, 'copia italiana: gemello inglese con la stessa numerazione');
assert.equal(await confirmPrintingFromCatalogSource({ ...entry, rarity: 'Secret Rare' }, find), false, 'rarità diversa: niente conferma');
assert.equal(await confirmPrintingFromCatalogSource({ ...entry, setCode: 'BLZD-EN018' }, find), false, 'numero diverso (OCR sbagliato): niente conferma');
assert.equal(await confirmPrintingFromCatalogSource({ ...entry, catalogCardId: '1' }, find), false, 'carta sconosciuta alla fonte: niente conferma');

console.log('PASS Fast Scan: stampa assente creata solo con conferma YGOPRODeck (codice o gemello inglese + rarità) · senza conferma rifiutata col motivo · artwork mai automatici');
