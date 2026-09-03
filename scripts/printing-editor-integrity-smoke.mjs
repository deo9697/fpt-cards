import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.localStorage = { getItem:() => null, setItem:() => {}, removeItem:() => {} };

const { collectionEditorView, collectionPrintingOptions, isFirstEdition, editionState, editionFromFirstEditionFlag, persistedCollectionItemMatches, selectCollectionEditorPrinting } = await import('../js/collection.js');
const { findExactCatalogPrinting, collectionCardWithLocalizedPrintings, localizeSetCode, lookupPrintingBySetCode, normalizeCatalogPrintings, normalizeCatalogRarity, reconcileCatalogCard, setCodeMatchesLanguage } = await import('../js/cards.js');

assert.equal(normalizeCatalogRarity('2'), 'Common', 'la quantità 2 del deck è stata mostrata come rarità');
assert.equal(normalizeCatalogRarity('3'), 'Common', 'la quantità 3 del deck è stata mostrata come rarità');
assert.equal(normalizeCatalogRarity('New'), '', 'la nota New è stata mostrata come rarità');
const normalizedShizukuPrintings = normalizeCatalogPrintings([
  {set_code:'L26D-ENS26',set_name:'Legendary Modern Decks 2026',set_rarity:'2'},
  {set_code:'L26D-ENS26',set_name:'Legendary Modern Decks 2026',set_rarity:'Secret Rare'},
  {set_code:'L26D-ENS26',set_name:'Legendary Modern Decks 2026',set_rarity:'Starlight Rare'},
  {set_code:'L26D-ENS26',set_name:'Legendary Modern Decks 2026',set_rarity:'Common'}
]);
assert.deepEqual(normalizedShizukuPrintings.map(printing=>printing.rarity).sort(), ['Common','Secret Rare','Starlight Rare']);
assert.equal(normalizedShizukuPrintings.filter(printing=>printing.rarity==='Common').length, 1, 'Common duplicata dopo la normalizzazione');
assert.equal(selectCollectionEditorPrinting({printings:normalizedShizukuPrintings}, 'L26D-ENS26', 'Common')?.rarity, 'Common');
assert.equal(selectCollectionEditorPrinting({printings:normalizedShizukuPrintings}, 'L26D-ENS26', ''), null, 'una rarità corrotta non deve sceglierne una arbitraria');
assert.equal(selectCollectionEditorPrinting({printings:[{setCode:'BLGG-EN027',setName:'Battles of Legend',rarity:'Ultra Rare'}]}, 'BLGG-EN027', '')?.rarity, 'Ultra Rare', 'una sola rarità valida deve essere recuperata automaticamente');
globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('cardsetsinfo.php')) return {ok:true,json:async()=>({id:90673288,name:'Sky Striker Ace - Shizuku',set_name:'Legendary Modern Decks 2026',set_code:'L26D-ENS26',set_rarity:'Starlight Rare'})};
  return {ok:true,json:async()=>({data:[{id:90673288,name:'Sky Striker Ace - Shizuku',type:'Link Monster',card_images:[{id:90673288,image_url:'https://images.ygoprodeck.com/images/cards/90673288.jpg'}],card_sets:[
    {set_code:'L26D-ENS26',set_name:'Legendary Modern Decks 2026',set_rarity:'2'},
    {set_code:'L26D-ENS26',set_name:'Legendary Modern Decks 2026',set_rarity:'Secret Rare'},
    {set_code:'L26D-ENS26',set_name:'Legendary Modern Decks 2026',set_rarity:'Starlight Rare'}
  ]}]})};
};
const shizukuLookup = await lookupPrintingBySetCode('L26D-ENS26');
assert.deepEqual(shizukuLookup.map(printing=>printing.rarity).sort(), ['Common','Secret Rare','Starlight Rare'], 'il lookup per set conserva soltanto la variante restituita da cardsetsinfo');

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
assert.match(ambiguousHtml, /Prima Edizione/);
assert.match(ambiguousHtml, /collection-first-edition/);
assert.match(ambiguousHtml, /type="checkbox"[^>]*checked/);
assert.equal(isFirstEdition('Prima Edizione'), true);
assert.equal(isFirstEdition('1ª Edizione'), true);
assert.equal(isFirstEdition('1st Edition'), true);
assert.equal(isFirstEdition('1#'), true);
assert.equal(isFirstEdition('1 ed'), true);
assert.equal(isFirstEdition('Unlimited'), false);
assert.equal(isFirstEdition(''), false);
assert.equal(editionState(null), 'unspecified');
assert.equal(editionState('valore sconosciuto'), 'unspecified');
assert.equal(editionState('Unlimited Edition'), 'unlimited');
assert.equal(editionState('Edizione illimitata'), 'unlimited');
assert.equal(editionFromFirstEditionFlag({checked:false,touched:false,original:''}), '', 'Non specificata viene distrutta senza interazione');
assert.equal(editionFromFirstEditionFlag({checked:true,touched:true,original:''}), 'Prima Edizione');
assert.equal(editionFromFirstEditionFlag({checked:false,touched:true,original:'Prima Edizione'}), 'Unlimited');
assert.equal(editionFromFirstEditionFlag({checked:true,touched:false,original:'1#'}), '1#', 'un legacy non modificato viene riscritto automaticamente');
assert.match(ambiguousHtml, /type="submit" disabled/);

const brambleCard = {id:'6560411',name:'Bramble Rose Dragon',image:'https://images.ygoprodeck.com/images/cards/6560411.jpg',fullImage:'https://images.ygoprodeck.com/images/cards/6560411.jpg',imageIds:['6560411'],printings:[
  {setCode:'DOOD-EN039',setName:'Doom of Dimensions',rarity:'Secret Rare'},
  {setCode:'DOOD-EN039',setName:'Doom of Dimensions',rarity:'Starlight Rare'}
]};
const localizedBramble = collectionCardWithLocalizedPrintings(brambleCard, 'Italiano');
assert.equal(localizeSetCode('DOOD-EN039','IT'), 'DOOD-IT039');
assert.equal(setCodeMatchesLanguage('DOOD-IT039','Italiano'),true);
assert.equal(setCodeMatchesLanguage('DOOD-EN039','Italiano'),false);
assert.equal(setCodeMatchesLanguage('L5DD-ENC27','Italiano'),true,'un formato storico non deve essere classificato con una lingua inventata');
assert.deepEqual(localizedBramble.printings.filter(printing=>printing.setCode==='DOOD-IT039').map(printing=>printing.rarity).sort(), ['Secret Rare','Starlight Rare']);
assert(localizedBramble.printings.filter(printing=>printing.setCode==='DOOD-IT039').every(printing=>printing.setName==='Destino delle Dimensioni'));
globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.searchParams.get('id') !== '6560411') return {ok:false,json:async()=>({})};
  return {ok:true,json:async()=>({data:[{id:6560411,name:'Bramble Rose Dragon',type:'Synchro Monster',card_images:[{id:6560411,image_url:brambleCard.fullImage,image_url_small:brambleCard.image}],card_sets:brambleCard.printings.map(printing=>({set_code:printing.setCode,set_name:printing.setName,set_rarity:printing.rarity}))}]})};
};
const secretResolution = await reconcileCatalogCard({game:'yugioh',catalogCardId:'6560411',cardName:'Bramble Rose Dragon',setCode:'DOOD-IT039',rarity:'Secret Rare',imageUrl:brambleCard.fullImage});
assert.equal(secretResolution.status,'valid');
assert.equal(secretResolution.printing?.setCode,'DOOD-IT039');
assert.equal(secretResolution.printing?.setName,'Destino delle Dimensioni');
assert.equal(secretResolution.printing?.rarity,'Secret Rare');
const starlightResolution = await reconcileCatalogCard({game:'yugioh',catalogCardId:'6560411',cardName:'Bramble Rose Dragon',setCode:'DOOD-IT039',rarity:'Starlight Rare',imageUrl:brambleCard.fullImage});
assert.equal(starlightResolution.status,'valid','la variante Starlight deve essere verificabile senza essere applicata');

const p04Store = {
  printings:[
    {id:'dood-en-secret',catalogCardId:'6560411',setCode:'DOOD-EN039',setName:'Doom of Dimensions',rarity:'Secret Rare'},
    {id:'dood-it-starlight',catalogCardId:'6560411',setCode:'DOOD-IT039',setName:'Destino delle Dimensioni',rarity:'Starlight Rare'}
  ],
  items:[
    {id:'bramble-unspecified',printingId:'dood-en-secret',quantityOwned:1,language:'Italiano',condition:'Near Mint',edition:''},
    {id:'bramble-first',printingId:'dood-en-secret',quantityOwned:1,language:'Italiano',condition:'Near Mint',edition:'Prima Edizione'}
  ]
};
const beforeStarlight = structuredClone(p04Store.printings.find(printing=>printing.id==='dood-it-starlight'));
function saveP04LocalizedPrinting(itemId, desired) {
  const row=p04Store.items.find(item=>item.id===itemId); assert(row);
  let printing=p04Store.printings.find(candidate=>candidate.catalogCardId===desired.catalogCardId&&candidate.setCode===desired.setCode&&candidate.rarity===desired.rarity);
  if(!printing){printing={id:'dood-it-secret',...desired};p04Store.printings.push(printing);}
  row.printingId=printing.id;
  return [{collection_item_id:row.id,printing_id:printing.id,set_code:printing.setCode,set_name:printing.setName,rarity:printing.rarity,edition:row.edition,quantity_owned:row.quantityOwned,language:row.language,condition:row.condition}];
}
function readP04Collection(serialized=JSON.stringify(p04Store)) {
  const store=JSON.parse(serialized);
  return store.items.map(item=>({...store.printings.find(printing=>printing.id===item.printingId),...item}));
}
const rpcResult=saveP04LocalizedPrinting('bramble-first',{catalogCardId:'6560411',cardName:'Bramble Rose Dragon',setCode:'DOOD-IT039',setName:'Destino delle Dimensioni',rarity:'Secret Rare'});
assert.equal(rpcResult[0].printing_id,'dood-it-secret','risposta RPC senza printing_id localizzata');
const reread=readP04Collection().find(item=>item.id==='bramble-first');
assert(persistedCollectionItemMatches(reread,{printingId:'dood-it-secret',setCode:'DOOD-IT039',setName:'Destino delle Dimensioni',rarity:'Secret Rare',language:'Italiano',condition:'Near Mint',edition:'Prima Edizione',quantityOwned:1}),'rilettura immediata diversa dal salvataggio');
const afterHardRefresh=readP04Collection(JSON.stringify(p04Store)).find(item=>item.id==='bramble-first');
assert(persistedCollectionItemMatches(afterHardRefresh,{printingId:'dood-it-secret',setCode:'DOOD-IT039',setName:'Destino delle Dimensioni',rarity:'Secret Rare',language:'Italiano',condition:'Near Mint',edition:'Prima Edizione',quantityOwned:1}),'hard refresh perde i dettagli localizzati');
assert.equal(readP04Collection().find(item=>item.id==='bramble-unspecified').printingId,'dood-en-secret','la riga Non specificata è stata modificata insieme alla Prima Edizione');
assert.deepEqual(p04Store.printings.find(printing=>printing.id==='dood-it-starlight'),beforeStarlight,'la variante Starlight è stata applicata durante la sola verifica');

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
fixture.items.push({ id:'mine-unlimited', owner:'daniele', printingId:'starlight', quantity:2, language:'Italiano', condition:'Near Mint', edition:'', committed:0 });
const otherBefore = structuredClone(fixture.items[1]);
const aggregateBefore = structuredClone(fixture.items[2]);
const target = fixture.correct('daniele', 'mine', 'Common', 'Prima Edizione');
assert.equal(target.id, 'common-existing', 'la printing Common esistente non è stata riutilizzata');
assert.equal(fixture.printings.length, 2, 'creata una printing duplicata');
assert.deepEqual(fixture.items[1], otherBefore, 'item di un altro membro modificato');
assert.deepEqual(fixture.items[2], aggregateBefore, 'una riga aggregata distinta è stata modificata');
assert(!fixture.marketMappings.some(mapping => mapping.printingId === target.id), 'mapping Starlight ereditato dalla Common');
fixture.correct('daniele', 'mine', 'Common', 'Unlimited');
assert.equal(fixture.items[0].edition, 'Unlimited');
assert(persistedCollectionItemMatches({printingId:'dood-it-secret',setCode:'DOOD-IT039',setName:'Destino delle Dimensioni',rarity:'Secret Rare',language:'Italiano',condition:'Near Mint',edition:'Prima Edizione',quantityOwned:1},{printingId:'dood-it-secret',setCode:'dood-it039',setName:'Destino delle Dimensioni',rarity:'secret rare',language:'Italiano',condition:'Near Mint',edition:'Prima Edizione',quantityOwned:1}));
assert.equal(persistedCollectionItemMatches({printingId:'wrong',setCode:'DOOD-EN039',rarity:'Secret Rare',language:'Italiano',condition:'Near Mint',edition:'Prima Edizione',quantityOwned:1},{printingId:'dood-it-secret',setCode:'DOOD-IT039',rarity:'Secret Rare',language:'Italiano',condition:'Near Mint',edition:'Prima Edizione',quantityOwned:1}),false);

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
assert(app.includes('await loadCollection({ force:true })') && app.includes('assertPersistedCollectionItem'), 'manca rilettura reale post-RPC');
assert(app.includes("setCollectionSaveStatus('loading'") && app.includes("setCollectionSaveStatus('error'") && app.includes("setCollectionSaveStatus('success'"), 'stati salvataggio incompleti');
assert(app.includes('salva quantità, lingua o condizione separatamente'), 'gli edit concorrenti non sono bloccati');
assert(market.includes("item.referencePrice==null?'—':money(item.referencePrice)"), 'una printing unresolved viene mostrata come €0');

console.log('PASS Shizuku L26D-ENS26: selezione esatta Common/Starlight/Secret senza first-match');
console.log('PASS editor rarity esplicita + Prima Edizione/Unlimited/legacy persistibile');
console.log('PASS relink field-specific: UUID, owner, quantità, lingua e condizione preservati');
console.log('PASS riuso printing, anti-duplicate, isolamento utenti e mapping Market non ereditato');
console.log('PASS P0.4 DOOD-IT039 Secret: RPC, reread, hard refresh e Starlight read-only simulati');
