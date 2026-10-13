// Fast Scan: YGOPRODeck segna la stampa "New"/"Reprint" al posto della rarità
// (2026-10-13, es. BLGG-EN047). La rarità arriva dalla scheda ufficiale Konami
// via funzione konami-card-rarities, solo se il nome carta coincide. Rete finta.
import assert from 'node:assert/strict';
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };
window.supabase ??= { createClient: () => ({}) };
window.FPT_CONFIG = { supabaseUrl: 'https://example.supabase.co', supabaseKey: 'sb_publishable_test' };
const konamiAnswers = new Map();
let konamiCalls = 0;
globalThis.fetch = async input => {
  const url = new URL(input);
  if (url.pathname.endsWith('/functions/v1/konami-card-rarities')) {
    konamiCalls++;
    const answer = konamiAnswers.get(url.searchParams.get('setCode'));
    return answer ? { ok: true, json: async () => answer } : { ok: false, status: 502, json: async () => ({}) };
  }
  if (url.pathname.endsWith('cardsetsinfo.php')) {
    const code = url.searchParams.get('setcode');
    return { ok: true, json: async () => ({ data: code === 'BLGG-EN047' || code === 'BLGG-EN099' ? [{ id: 22502047, name: 'Pair Bear Scare!!', set_code: code, set_name: 'Battles of Legend: Glorious Gallery', set_rarity: 'New' }] : [] }) };
  }
  return { ok: true, json: async () => ({ data: [{ id: 22502047, name: 'Pair Bear Scare!!', card_images: [], card_sets: [{ set_code: 'BLGG-EN047', set_name: 'Battles of Legend: Glorious Gallery', set_rarity: 'New' }] }] }) };
};
const { konamiRaritiesForSetCode, lookupPrintingBySetCode } = await import('../js/cards.js');
const { confirmPrintingFromCatalogSource } = await import('../js/fast-scan.js');

// 1. "New" + scheda Konami con lo stesso nome → la rarità ufficiale diventa proponibile.
konamiAnswers.set('BLGG-EN047', { setCode: 'BLGG-EN047', konamiId: '22502', cardName: 'Pair Bear Scare!!', rarities: ['Ultra Rare'] });
const rows = await lookupPrintingBySetCode('BLGG-EN047');
assert.deepEqual(rows.map(row => row.rarity), ['Ultra Rare'], 'rarità presa dalla scheda Konami');
assert.equal(rows[0].printingId, '', 'nessun id inventato: la riga la crea il server');

// 2. Nome diverso (codice sbagliato lato Konami) → niente, come prima.
konamiAnswers.set('BLGG-EN099', { setCode: 'BLGG-EN099', konamiId: '1', cardName: 'Another Card', rarities: ['Secret Rare'] });
assert.deepEqual(await lookupPrintingBySetCode('BLGG-EN099'), [], 'nome diverso: nessuna rarità proposta');

// 3. Helper: solo codici inglesi, errori non messi in cache, etichette non-rarità scartate.
assert.equal(await konamiRaritiesForSetCode('BLGG-IT047', 'Pair Bear Scare!!'), null, 'solo codici inglesi');
const before = konamiCalls;
assert.equal(await konamiRaritiesForSetCode('XXXX-EN001', 'Pair Bear Scare!!'), null, 'errore della funzione → null');
await konamiRaritiesForSetCode('XXXX-EN001', 'Pair Bear Scare!!');
assert.equal(konamiCalls, before + 2, 'un errore non resta in cache');
konamiAnswers.set('MAMO-EN015', { cardName: 'Astrograph Sorcerer, the Starfrost Magician', rarities: ['Ultra Rare', 'Starlight Rare', 'Grand Master Rare', 'New'] });
assert.deepEqual(await konamiRaritiesForSetCode('MAMO-EN015', 'Astrograph Sorcerer, the Starfrost Magician'), ['Ultra Rare', 'Starlight Rare', 'Grand Master Rare']);

// 4. Conferma al salvataggio: YGOPRODeck non ha la rarità, Konami sì (anche per la copia italiana).
const base = { game: 'yugioh', catalogCardId: '22502047', cardName: 'Pair Bear Scare!!', setCode: 'BLGG-IT047', rarity: 'Ultra Rare' };
const card = { name: 'Pair Bear Scare!!', printings: [] };
const asked = [];
const official = async (code, name) => { asked.push([code, name]); return ['Ultra Rare']; };
assert.equal(await confirmPrintingFromCatalogSource(base, async () => card, official), true, 'confermata dalla scheda Konami');
assert.deepEqual(asked, [['BLGG-EN047', 'Pair Bear Scare!!']], 'chiede il gemello inglese col nome della carta');
assert.equal(await confirmPrintingFromCatalogSource({ ...base, rarity: 'Secret Rare' }, async () => card, official), false, 'rarità diversa da Konami: niente conferma');
assert.equal(await confirmPrintingFromCatalogSource(base, async () => card, async () => { throw new Error('rete'); }), false, 'Konami irraggiungibile: niente conferma');
assert.equal(await confirmPrintingFromCatalogSource(base, async () => null, official), false, 'carta sconosciuta: niente conferma');

console.log('PASS Fast Scan: "New" su YGOPRODeck → rarità dalla scheda Konami solo con nome coincidente · conferma al salvataggio · errori non in cache');
