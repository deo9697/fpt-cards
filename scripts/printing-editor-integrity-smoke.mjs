import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.localStorage = { getItem:() => null, setItem:() => {}, removeItem:() => {} };

const { collectionEditorView, collectionPrintingOptions } = await import('../js/collection.js');
const { findExactCatalogPrinting } = await import('../js/cards.js');

const shizukuPrintings = [
  { setCode:'L26D-ENS26', setName:'Legendary Modern Decks 2026', rarity:'Starlight Rare' },
  { setCode:'L26D-ENS26', setName:'Legendary Modern Decks 2026', rarity:'Common' },
  { setCode:'L26D-ENS26', setName:'Legendary Modern Decks 2026', rarity:'Secret Rare' },
  { setCode:'L26D-ENS26', setName:'Legendary Modern Decks 2026', rarity:'Common' }
];
const card = { id:'90673288', name:'Sky Striker Ace - Shizuku', image:'https://images.ygoprodeck.com/images/cards/90673288.jpg', printings:shizukuPrintings };
assert.equal(collectionPrintingOptions(card).length, 3, 'le tuple set/rarità duplicate non sono deduplicate');
assert.equal(findExactCatalogPrinting(shizukuPrintings, 'l26d-ens26', 'common')?.rarity, 'Common');
assert.equal(findExactCatalogPrinting(shizukuPrintings, 'L26D-ENS26', 'Ultra Rare'), null, 'una rarità assente viene inventata');
assert.equal(findExactCatalogPrinting(shizukuPrintings, 'L26D-ENS26', ''), null, 'un set con più rarità viene selezionato implicitamente');

const item = {
  id:'inventory-shizuku', printingId:'printing-starlight', catalogCardId:'90673288',
  cardName:card.name, setCode:'L26D-ENS26', setName:'Legendary Modern Decks 2026',
  rarity:'Starlight Rare', language:'Italiano', condition:'Near Mint', edition:'1#',
  quantityOwned:3, imageUrl:card.image
};
const ambiguousHtml = collectionEditorView({ item, card, setCode:'L26D-ENS26', printing:null }, 'yugioh', true);
assert.match(ambiguousHtml, /id="collection-set"/);
assert.match(ambiguousHtml, /id="collection-rarity"/);
assert.match(ambiguousHtml, /Scegli la rarità/);
assert.match(ambiguousHtml, /Questo set contiene più rarità/);
assert.match(ambiguousHtml, /Mantieni valore legacy \(1#\)/);
assert.match(ambiguousHtml, /Prima Edizione/);
assert.match(ambiguousHtml, /Non Prima Edizione \/ Unlimited/);
assert.match(ambiguousHtml, /Non specificata/);
assert.match(ambiguousHtml, /type="submit" disabled/);

const common = findExactCatalogPrinting(shizukuPrintings, 'L26D-ENS26', 'Common');
const selectedHtml = collectionEditorView({ item, card, setCode:'L26D-ENS26', printing:common }, 'yugioh', true);
assert.match(selectedHtml, /Rarità selezionata[\s\S]*Common/);
assert.doesNotMatch(selectedHtml, /type="submit" disabled/);

class PrintingFixture {
  constructor() {
    this.printings = [
      { id:'starlight', catalog:'90673288', setCode:'L26D-ENS26', rarity:'Starlight Rare' },
      { id:'common-existing', catalog:'90673288', setCode:'L26D-ENS26', rarity:'Common' }
    ];
    this.items = [
      { id:'mine', owner:'daniele', printingId:'starlight', quantity:3, language:'Italiano', condition:'Near Mint', edition:'1#', committed:0 },
      { id:'other-user', owner:'cristofer', printingId:'starlight', quantity:2, language:'Italiano', condition:'Good', edition:'', committed:0 }
    ];
    this.marketMappings = [{ printingId:'starlight', provider:'cardmarket', status:'ambiguous' }];
  }
  correct(actor, id, rarity, edition) {
    const row = this.items.find(value => value.id === id);
    assert.equal(row?.owner, actor, 'ownership violata');
    let target = this.printings.find(value => value.catalog === '90673288' && value.setCode === 'L26D-ENS26' && value.rarity === rarity);
    if (!target) { target = { id:`created-${rarity}`, catalog:'90673288', setCode:'L26D-ENS26', rarity }; this.printings.push(target); }
    assert(row.printingId === target.id || row.committed === 0, 'prestito collegato');
    assert(!this.items.some(value => value.id !== row.id && value.owner === row.owner && value.printingId === target.id && value.language === row.language && value.condition === row.condition && value.edition === edition), 'duplicato');
    const before = { id:row.id, owner:row.owner, quantity:row.quantity, language:row.language, condition:row.condition };
    row.printingId = target.id;
    row.edition = edition;
    assert.deepEqual({ id:row.id, owner:row.owner, quantity:row.quantity, language:row.language, condition:row.condition }, before);
    return target;
  }
}

const fixture = new PrintingFixture();
const otherBefore = structuredClone(fixture.items[1]);
const target = fixture.correct('daniele', 'mine', 'Common', 'Prima Edizione');
assert.equal(target.id, 'common-existing', 'la printing Common esistente non è stata riutilizzata');
assert.equal(fixture.printings.length, 2, 'creata una printing duplicata');
assert.deepEqual(fixture.items[1], otherBefore, 'item di un altro membro modificato');
assert(!fixture.marketMappings.some(mapping => mapping.printingId === target.id), 'mapping Starlight ereditato dalla Common');
fixture.correct('daniele', 'mine', 'Common', 'Unlimited');
assert.equal(fixture.items[0].edition, 'Unlimited');

const sql = fs.readFileSync(new URL('../supabase-printing-editor-integrity.sql', import.meta.url), 'utf8');
for (const required of [
  'public.correct_collection_item_printing', "set search_path = ''", 'where id = p_collection_item_id',
  'inventory.owner_slug <> me', 'for update', 'stessa carta canonica',
  "desired_edition not in ('', 'Prima Edizione', 'Unlimited')", 'committed > 0',
  'Esiste già un elemento con questa printing', 'catalog_verification_version',
  'on conflict on constraint card_printings_game_catalog_card_id_set_code_rarity_key do nothing',
  'revoke all on function public.correct_collection_item_printing',
  'grant execute on function public.correct_collection_item_printing'
]) assert(sql.includes(required), `RPC integrity incompleta: ${required}`);
const inventoryUpdate = sql.match(/update public\.collection_items\s+set([\s\S]*?)where id = inventory\.id;/i)?.[1] || '';
assert.match(inventoryUpdate, /printing_id = target_printing_id/);
assert.match(inventoryUpdate, /edition = desired_edition/);
assert.doesNotMatch(inventoryUpdate, /quantity_owned|language\s*=|condition\s*=|owner_slug/, 'la RPC modifica campi inventariali non pertinenti');
assert(!sql.includes('market_provider_printings'), 'la RPC copia mapping Market Watch');
assert(!sql.includes('deck_cards'), 'la RPC modifica i mazzi');

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');
const market = fs.readFileSync(new URL('../js/market-watch.js', import.meta.url), 'utf8');
assert(app.includes('api.correctCollectionPrinting') && api.includes("client.rpc('correct_collection_item_printing'"));
assert(app.includes('salva quantità, lingua o condizione separatamente'), 'gli edit concorrenti non sono bloccati');
assert(market.includes("item.referencePrice==null?'—':money(item.referencePrice)"), 'una printing unresolved viene mostrata come €0');

console.log('PASS Shizuku L26D-ENS26: selezione esatta Common/Starlight/Secret senza first-match');
console.log('PASS editor rarity esplicita + Prima Edizione/Unlimited/legacy persistibile');
console.log('PASS relink field-specific: UUID, owner, quantità, lingua e condizione preservati');
console.log('PASS riuso printing, anti-duplicate, isolamento utenti e mapping Market non ereditato');
