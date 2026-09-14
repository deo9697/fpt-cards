import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { collectionSearchAliases, matchesCollectionQuery, normalizeCollectionSearch } from '../js/collection-search.js';

globalThis.window = { addEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };
let requests = 0;
globalThis.fetch = () => { requests++; throw Error('Search must be local'); };
const { collectionResultsView } = await import('../js/collection.js');
const item = { id:'fixture', printingId:'print', game:'yugioh', catalogCardId:'44265115', cardName:'Brain Controller', setCode:'ALIN-IT033', setName:'Alliance Insight', rarity:'Common', ownerSlug:'me', quantityAvailable:1, quantityOwned:1, quantityLoaned:0, quantityReserved:0 };
const matches = (row, query) => matchesCollectionQuery(row, normalizeCollectionSearch(query));
for (const query of ['Brain Controller','Controlla Cervello','controlla cervello','ALIN-IT033','alin it033','Alliance Insight','Common']) assert(matches(item,query),query);
assert(matches({...item, localizedName:'Drago dell’Abìsso'}, "drago dell'abisso"));
assert(matches({...item, localizedName:"Drago dell'Abisso"}, '  DRAGO   DELL’ABISSO  '));
const legacy = {...item, catalogCardId:'unknown'};
assert(matches(legacy,'Brain Controller'));
assert(matches(legacy,'ALIN IT033'));
assert(!matches(legacy,'Controlla Cervello'));
assert(!matches({...item,game:'onepiece'},'Controlla Cervello'), 'Aliases are game scoped');
assert(!matches(item,'Drago Bianco'));
assert(!matches(item,'Controller ALIN'), 'Do not match across separate fields');
assert(matches({...legacy,searchAliases:[null,undefined,'Controlla Cervello','Controlla Cervello']},'controlla cervello'));
const enriched = collectionSearchAliases({game:'yugioh',catalog_card_id:'44265115',card_name:'Brain Controller',game_metadata:{searchAliases:['Controlla Cervello']}});
assert.equal(enriched.filter(name=>name==='Controlla Cervello').length,1);
for (const scope of ['mine','team']) {
  const filters={scope,query:'controlla cervello',owner:'all',status:'all',sort:'name-asc',layout:'grid',facets:{}};
  assert(collectionResultsView({mine:[item],team:[item]},filters,'yugioh',true).includes('data-collection-item='),scope);
  assert(!collectionResultsView({mine:[item],team:[item]}, {...filters,query:'carta inesistente'},'yugioh',true).includes('data-collection-item='));
}
const rows=Array.from({length:5000},(_,i)=>({...item,id:String(i)}));
const start=performance.now();
for(const query of ['c','controlla','controlla cervello','alin it033']) {
  const normalized=normalizeCollectionSearch(query);
  assert.equal(rows.filter(row=>matchesCollectionQuery(row,normalized)).length,5000);
}
assert.equal(requests,0);
console.log(`PASS bilingual collection search, legacy, normalization, mine/team, no network; 4 queries × 5000 items: ${(performance.now()-start).toFixed(1)} ms`);
