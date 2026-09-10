// L'editor Raccolta elencava rarità/set di una carta usando solo YGOPRODeck:
// quando YGOPRODeck non conosce (ancora, o mai) una rarità che il nostro
// card_printings ha già verificato altrove, l'editor mostrava un
// sottoinsieme incompleto. Caso reale che ha innescato la correzione:
// CH01-EN019 — The Fallen & The Virtuous, che deve elencare Ultra Rare,
// Secret Rare e Starlight Rare (YGOPRODeck da solo non le elenca tutte).
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { mergeAuthoritativePrintings } = await import('../js/cards.js');

// DB (card_printings): fonte autorevole, le tre rarità reali del caso reale.
const dbRows = [
  { printingId: 'db-ultra', setCode: 'CH01-EN019', setName: 'Chaos Impact', rarity: 'Ultra Rare', imageUrl: 'https://images.ygoprodeck.com/images/cards/12345678.jpg' },
  { printingId: 'db-secret', setCode: 'CH01-EN019', setName: 'Chaos Impact', rarity: 'Secret Rare', imageUrl: 'https://images.ygoprodeck.com/images/cards/12345678.jpg' },
  { printingId: 'db-starlight', setCode: 'CH01-EN019', setName: 'Chaos Impact', rarity: 'Starlight Rare', imageUrl: 'https://images.ygoprodeck.com/images/cards/12345678.jpg' }
];
// YGOPRODeck: incompleto per questa carta (manca Secret e Starlight Rare),
// più una stampa di un set diverso che il DB non conosce ancora.
const ygoprodeckCard = {
  id: 12345678, name: 'The Fallen & The Virtuous',
  printings: [
    { setCode: 'CH01-EN019', setName: 'Chaos Impact', rarity: 'Ultra Rare' },
    { setCode: 'OTHR-EN001', setName: 'Altro Set', rarity: 'Common' }
  ]
};

const merged = mergeAuthoritativePrintings(ygoprodeckCard, dbRows);
const rarities = merged.printings.filter(p => p.setCode === 'CH01-EN019').map(p => p.rarity).sort();
assert.deepEqual(rarities, ['Secret Rare', 'Starlight Rare', 'Ultra Rare'], `CH01-EN019 deve elencare tutte e tre le rarità dal DB: ${JSON.stringify(rarities)}`);

// Il DB vince: nessuna riga YGOPRODeck duplicata per set+rarità già coperti.
assert.equal(merged.printings.filter(p => p.setCode === 'CH01-EN019' && p.rarity === 'Ultra Rare').length, 1, 'Ultra Rare non deve comparire due volte (DB + YGOPRODeck)');
assert.equal(merged.printings.find(p => p.setCode === 'CH01-EN019' && p.rarity === 'Ultra Rare').printingId, 'db-ultra', 'per una printing coperta dal DB deve vincere il printingId del DB, non quello (assente) di YGOPRODeck');

// YGOPRODeck resta fallback per ciò che il DB non conosce ancora — nessuna
// riga persa.
assert(merged.printings.some(p => p.setCode === 'OTHR-EN001' && p.rarity === 'Common'), 'una printing nota solo a YGOPRODeck non deve sparire (fallback)');
assert(!merged.printings.find(p => p.setCode === 'OTHR-EN001').printingId, 'una printing di fallback non ha un printingId reale');

// Nessun accesso rete/DB qui: verifica anche che il client sia effettivamente
// collegato, non solo che la funzione di merge esista.
const api = fs.readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');
assert(api.includes("client.rpc('lookup_card_printings_by_catalog_id'"), 'js/api.js: lookupPrintingsByCatalogId non collegata alla RPC');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
assert((app.match(/api\.lookupPrintingsByCatalogId\(/g) || []).length >= 2, 'app.js: attesi 2 call site (modifica carta esistente + ricerca nuova carta) collegati a lookupPrintingsByCatalogId');
assert(app.includes('mergeAuthoritativePrintings'), 'app.js: mergeAuthoritativePrintings non importata/usata');
const sql = fs.readFileSync(new URL('../supabase/migrations/20260910100000_lookup_card_printings_by_catalog_id.sql', import.meta.url), 'utf8');
assert(sql.includes('create or replace function public.lookup_card_printings_by_catalog_id'), 'migration: funzione lookup_card_printings_by_catalog_id mancante');
assert(sql.includes("grant execute on function public.lookup_card_printings_by_catalog_id(text,text,text) to anon,authenticated"), 'migration: grant mancante o incompleto');

console.log('PASS editor Raccolta: card_printings (DB) autorevole su YGOPRODeck · CH01-EN019 mostra Ultra/Secret/Starlight Rare · YGOPRODeck resta fallback per printing non ancora note al DB · nessuna riga duplicata o persa');
