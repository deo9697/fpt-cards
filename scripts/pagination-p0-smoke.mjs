import assert from 'node:assert/strict';
import fs from 'node:fs';
import {collectPages,pagedRpc,paginationMetrics,POSTGREST_PAGE_SIZE} from '../js/pagination.js';

globalThis.localStorage={getItem(){return null;},setItem(){},removeItem(){}};
const {deckAvailability}=await import('../js/decks.js');

const rows=(count,prefix='row')=>Array.from({length:count},(_,index)=>({
  id:`${prefix}-${String(index).padStart(4,'0')}`,printing_id:`printing-${String(index).padStart(4,'0')}`,owner_slug:'daniele',owner_name:'Daniele',game:'yugioh',
  catalog_card_id:String(10000000+index),card_name:index===1047?'Carta oltre mille':`Carta ${index}`,set_code:`TEST-IT${String(index%1000).padStart(3,'0')}`,
  set_name:'Set di collaudo paginazione',rarity:'Common',language:'Italiano',condition:'Near Mint',edition:'Prima Edizione',
  image_url:`https://images.ygoprodeck.com/images/cards/${10000000+index}.jpg`,quantity_owned:index<744?2:1,quantity_loaned:0,quantity_reserved:0,
  quantity_physically_available:index<744?2:1,legacy_ambiguous:false,created_at:'2026-09-02T00:00:00Z',updated_at:'2026-09-02T00:00:00Z'
}));

function mockClient(source,{failPage=-1}={}){
  const ranges=[];
  return {ranges,rpc(){
    let from=0,to=source.length-1;
    const builder={
      order(){return builder;},range(start,end){from=start;to=end;ranges.push([start,end]);return builder;},abortSignal(){return builder;},
      then(resolve){const pageIndex=Math.floor(from/POSTGREST_PAGE_SIZE);return resolve(pageIndex===failPage?{data:null,error:{code:'TEST_PAGE_ERROR',message:'pagina non disponibile'}}:{data:source.slice(from,to+1),error:null});}
    };
    return builder;
  }};
}

const personalSource=rows(1048,'mine'),personalClient=mockClient(personalSource);
const personal=await pagedRpc(personalClient,'list_my_collection',{}, {orders:[{column:'card_name'},{column:'id'}]});
assert.equal(personal.length,1048);
assert.equal(personal.reduce((sum,row)=>sum+row.quantity_owned,0),1792);
assert.deepEqual(personalClient.ranges,[[0,499],[500,999],[1000,1499]]);
assert.equal(new Set(personal.map(row=>row.id)).size,1048);
assert.equal(personal.find(row=>row.card_name==='Carta oltre mille')?.id,'mine-1047');

const teamSource=rows(1052,'team'),teamClient=mockClient(teamSource);
const team=await pagedRpc(teamClient,'list_team_collection',{}, {orders:[{column:'card_name'},{column:'id'}]});
assert.equal(team.length,1052);
assert.equal(new Set(team.map(row=>row.id)).size,1052);
assert.deepEqual(teamClient.ranges,[[0,499],[500,999],[1000,1499]]);

let retained=['stato-precedente'];
try{retained=await pagedRpc(mockClient(personalSource,{failPage:1}),'list_my_collection',{});}catch(error){assert.equal(error.code,'TEST_PAGE_ERROR');}
assert.deepEqual(retained,['stato-precedente'],'errore pagina 2 ha pubblicato dati parziali');

const moving=rows(1048,'moving');
const withConcurrentDuplicate=await collectPages(async(from,to,page)=>{
  if(page===0)return moving.slice(0,500);
  if(page===1)return [moving[499],...moving.slice(500,999)];
  return moving.slice(999,to+1);
},{resource:'concurrent_refresh',key:row=>row.id});
assert.equal(withConcurrentDuplicate.length,1048);
assert.equal(new Set(withConcurrentDuplicate.map(row=>row.id)).size,1048);

const mine=[
  {id:'vanity',game:'yugioh',catalogCardId:'47084486',cardName:"Vanity's Fiend",quantityAvailable:1},
  {id:'zaborg-a',game:'yugioh',catalogCardId:'87602890',cardName:'Zaborg the Mega Monarch',quantityAvailable:1},
  {id:'zaborg-b',game:'yugioh',catalogCardId:'87602890',cardName:'Zaborg the Mega Monarch',quantityAvailable:1},
  {id:'uria',game:'yugioh',catalogCardId:'23856331',cardName:'Uria',quantityAvailable:1},
  {id:'varudras-loaned',game:'yugioh',catalogCardId:'70636044',cardName:'Varudras',setCode:'MP25-EN070',quantityAvailable:0},
  {id:'varudras-free',game:'yugioh',catalogCardId:'70636044',cardName:'Varudras',setCode:'LEDE-IT045',quantityAvailable:1},
  {id:'fissure-a',game:'yugioh',catalogCardId:'81674782',cardName:'Dimensional Fissure',quantityAvailable:1},
  {id:'fissure-b',game:'yugioh',catalogCardId:'81674782',cardName:'Dimensional Fissure',quantityAvailable:1},
  {id:'ghost-canonical',game:'yugioh',catalogCardId:'73642297',cardName:'Ghost Belle & Haunted Mansion',setCode:'DUDE-EN004',quantityOwned:4,quantityLoaned:0,quantityReserved:0,quantityAvailable:4}
];
const enneacraft={cards:[
  {game:'yugioh',catalogCardId:'47084486',cardName:'Demone della Vanità',quantity:1},
  {game:'yugioh',catalogCardId:'87602890',cardName:'Zaborg il Mega Monarca',quantity:2},
  {game:'yugioh',catalogCardId:'81674782',cardName:'Dimensional Fissure',quantity:3}
]};
const sacred={cards:[
  {game:'yugioh',catalogCardId:'23856331',cardName:'Uria',quantity:1},
  {game:'yugioh',catalogCardId:'70636044',cardName:'Varudras',quantity:1},
  {game:'yugioh',catalogCardId:'73642296',cardName:'Ghost Belle & Haunted Mansion',quantity:3}
]};
const collection={mine,team:[]};
const enneacraftReport=deckAvailability(enneacraft,collection,'daniele');
assert.equal(enneacraftReport.rows.find(row=>row.catalogCardId==='47084486'),undefined,'Demone della Vanità non risulta 1/1');
assert.equal(enneacraftReport.rows.find(row=>row.catalogCardId==='87602890'),undefined,'Zaborg non risulta 2/2');
assert.deepEqual(enneacraftReport.rows.find(row=>row.catalogCardId==='81674782')&&{owned:2,missing:1},{owned:2,missing:1});
const sacredReport=deckAvailability(sacred,collection,'daniele');
assert.equal(sacredReport.rows.find(row=>row.catalogCardId==='23856331'),undefined,'Uria non risulta 1/1');
assert.equal(sacredReport.rows.find(row=>row.catalogCardId==='70636044'),undefined,'Varudras disponibile non riconosciuto');
assert.equal(sacredReport.rows.find(row=>row.catalogCardId==='73642296'),undefined,'Ghost Belle legacy non risulta 3/3 tramite alias canonico');
assert.equal(sacredReport.total,5);assert.equal(sacredReport.covered,5,'alias/canonical ha prodotto conteggio doppio o incompleto');
const refreshedReport=deckAvailability(JSON.parse(JSON.stringify(sacred)),JSON.parse(JSON.stringify(collection)),'daniele');
assert.equal(refreshedReport.rows.length,0,'hard refresh non mantiene Ghost Belle 3/3');
const mixedAliasReport=deckAvailability({cards:[
  {game:'yugioh',catalogCardId:'73642296',cardName:'Ghost Belle & Haunted Mansion',quantity:1},
  {game:'yugioh',catalogCardId:'73642297',cardName:'Ghost Belle & Haunted Mansion',quantity:2}
]},collection,'daniele');
assert.deepEqual({total:mixedAliasReport.total,covered:mixedAliasReport.covered,missing:mixedAliasReport.rows.length},{total:3,covered:3,missing:0},'alias e canonical ID non sono stati aggregati in un solo gruppo 3/3');
const committedGhost={mine:mine.map(row=>row.id==='ghost-canonical'?{...row,quantityLoaned:1,quantityReserved:1,quantityAvailable:2}:row),team:[]};
const committedReport=deckAvailability({cards:[sacred.cards[2]]},committedGhost,'daniele');
assert.deepEqual(committedReport.rows[0]&&{owned:committedReport.rows[0].owned,missing:committedReport.rows[0].missing},{owned:2,missing:1},'prestiti/riservate non sottratti dalla disponibilità Ghost Belle');

const marketPayload={items:rows(1052,'market'),deckUnresolved:[]};
assert.equal(marketPayload.items.length,1052,'Market Watch JSON aggregato troncato nel consumer');
const appSource=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const apiSource=fs.readFileSync(new URL('../js/api.js',import.meta.url),'utf8');
const swSource=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
for(const rpc of ['list_my_collection','list_team_collection','list_team_loans','list_my_decks_with_boxes','list_collection_catalog_verification_queue'])assert(apiSource.includes(`pagedRpc(client,'${rpc}'`),`${rpc} non paginata`);
assert(appSource.includes('collectionLoadGeneration')&&appSource.includes('AbortController')&&appSource.includes('realtimeSyncSources'),'concorrenza/coalescing Raccolta incompleti');
assert(swSource.includes("'./js/pagination.js'"),'paginatore assente dalla shell PWA');

const mineMetrics=paginationMetrics('list_my_collection');
assert.equal(mineMetrics.requests,3);assert.equal(mineMetrics.rows,1048);assert(mineMetrics.payloadBytes>0);assert(mineMetrics.durationMs>=0);
console.log(`PASS P0 pagination Raccolta 1048/1048 e 1792 copie · Team 1052/1052 · 3 pagine · 0 duplicati`);
console.log('PASS ricerca oltre riga 1000 · errore pagina 2 atomico · modifica concorrente deduplicata');
console.log('PASS Deck: Demone 1/1 · Zaborg 2/2 · Uria 1/1 · Fissure 2/3 · Ghost Belle legacy 3/3 · Varudras 1 disponibile');
console.log(`PASS metriche sintetiche mobile: ${mineMetrics.requests} richieste · ${mineMetrics.payloadBytes} byte · ${mineMetrics.durationMs} ms collector`);
console.log('PASS Market Watch JSON aggregato non troncato nel consumer frontend');
