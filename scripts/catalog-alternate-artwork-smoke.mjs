// Regressione: lookupPrintingBySetCode() non deve più lasciare che un id
// artwork alternativo di YGOPRODeck diventi l'identità (catalog_card_id)
// salvata per una stampa. Prima della fix, ogni riga del set lookup usava
// row.id "grezzo" come catalogCardId — per le carte con più artwork per lo
// stesso set/rarità, l'API assegna un id diverso a ciascuna variante pur
// trattandosi della stessa identità carta (vedi YUGIOH_CATALOG_ALIASES in
// js/cards.js). SDDC-IT013 è il caso reale che ha innescato l'audit.
//
// Nessuna chiamata di rete reale: fetch è mockato con dati strutturalmente
// validi ma inventati, stesso pattern di scripts/collection-loans-2-1-smoke.mjs.
import assert from 'node:assert/strict';

const SET_ENDPOINT = 'https://db.ygoprodeck.com/api/v7/cardsetsinfo.php';
const ENDPOINT = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

// 94145022 -> 94145021 è un alias già confermato e presente in
// YUGIOH_CATALOG_ALIASES: usiamo dati reali del catalogo, non inventati, per
// verificare la canonicalizzazione contro il comportamento di produzione.
const ALT_ART_ID = 94145022;
const CANONICAL_ID = '94145021';
// Un id qualsiasi NON presente nella tabella alias: deve passare invariato —
// prova che la fix non "risolve" alla cieca le carte ambigue non ancora
// confermate (Ghost Ogre, Aleister, Foolish Burial, DMG the Dragon Knight,
// El Shaddoll Winda — lasciate fuori scope deliberatamente).
const UNMAPPED_ALT_ART_ID = 11111111;

function fixture(id, setCode) {
  return {
    id, name: 'Carta di prova', type: 'Spell Card',
    card_images: [{ id, image_url: `https://images.ygoprodeck.com/images/cards/${id}.jpg`, image_url_small: `https://images.ygoprodeck.com/images/cards_small/${id}.jpg` }],
    card_sets: [{ set_code: setCode, set_name: 'Set di prova', set_rarity: 'Ultra Rare' }],
    banlist_info: {}
  };
}

function installFetchMock(altArtId, setCode) {
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('cardsetsinfo.php')) {
      if (parsed.searchParams.get('setcode') !== setCode) return { ok: true, json: async () => ({ data: [] }) };
      return { ok: true, json: async () => ({ data: [{ id: altArtId, name: 'Carta di prova', set_code: setCode, set_name: 'Set di prova', set_rarity: 'Ultra Rare' }] }) };
    }
    if (parsed.pathname.endsWith('cardinfo.php')) {
      const id = Number(parsed.searchParams.get('id'));
      if (id !== altArtId) return { ok: true, json: async () => ({ data: [] }) };
      return { ok: true, json: async () => ({ data: [fixture(altArtId, setCode)] }) };
    }
    return { ok: false, json: async () => ({}) };
  };
}

const { lookupPrintingBySetCode, canonicalCatalogCardId } = await import('../js/cards.js');

// 1) Artwork alternativo confermato in YUGIOH_CATALOG_ALIASES: l'identità
// salvata deve essere quella canonica, non l'id grezzo restituito dal set
// lookup.
installFetchMock(ALT_ART_ID, 'TEST-EN001');
const resolved = await lookupPrintingBySetCode('TEST-EN001', 'yugioh');
assert.equal(resolved.length, 1, `attesa 1 printing risolta, trovate ${resolved.length}`);
assert.equal(resolved[0].catalogCardId, CANONICAL_ID, `catalog_card_id non canonicalizzato: ${resolved[0].catalogCardId}`);
assert.notEqual(resolved[0].catalogCardId, String(ALT_ART_ID), 'l\'id artwork alternativo non deve restare l\'identità salvata');
// L'immagine resta quella reale e verificata di QUESTA riga (non inventata,
// non sostituita alla cieca con l'immagine del canonico): solo l'identità
// viene canonicalizzata, l'artwork specifico della stampa resta quello vero.
assert.ok(resolved[0].imageUrl.includes(String(ALT_ART_ID)), `immagine non verificata per questa riga: ${resolved[0].imageUrl}`);

// 2) Un id NON presente nella tabella alias (carta ambigua non ancora
// confermata) deve passare invariato: la fix non deve "risolvere" alla
// cieca identità non certe.
installFetchMock(UNMAPPED_ALT_ART_ID, 'TEST-EN002');
const unmapped = await lookupPrintingBySetCode('TEST-EN002', 'yugioh');
assert.equal(unmapped.length, 1, `attesa 1 printing risolta, trovate ${unmapped.length}`);
assert.equal(unmapped[0].catalogCardId, String(UNMAPPED_ALT_ART_ID), 'un id non mappato non deve essere alterato');

// 3) canonicalCatalogCardId resta la stessa funzione usata ovunque nel
// catalogo (nessuna logica di canonicalizzazione duplicata/divergente).
assert.equal(canonicalCatalogCardId(String(ALT_ART_ID), 'yugioh'), CANONICAL_ID);
assert.equal(canonicalCatalogCardId(String(UNMAPPED_ALT_ART_ID), 'yugioh'), String(UNMAPPED_ALT_ART_ID));

console.log('PASS lookupPrintingBySetCode canonicalizza gli artwork alternativi confermati (94145022→94145021) · lascia invariate le identità non mappate · immagine reale della riga preservata, non inventata');
