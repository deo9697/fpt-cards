// Synthetic PostgREST/public-catalogue responses; no account or live database.
import assert from 'node:assert/strict';
import {createDatabase} from '../api/yugioh-duel.js';

const deckId='a0000000-0000-4000-8000-000000000001',owner='synthetic-owner';
const row=(code,printing)=>({catalog_card_id:code,card_name:`Card ${code}`,printing_id:printing,image_url:'/synthetic.png',quantity:1,section:'main',position:0});
const cards=[row('11110001','selected-incomplete'),row('11110002','xyz'),row('11110003','link'),row('11110004','normal'),row('11110005','spell'),row('11110006','synchro'),row('11110007','missing'),row('11110008','precise')];
const printings=[
  {id:'other-printing',catalog_card_id:'11110001',game_metadata:{type:'Tuner Monster',level:3,desc:'Other printing metadata'}},
  {id:'selected-incomplete',catalog_card_id:'11110001',game_metadata:{cardType:'Effect Monster',level:null,atk:null,def:'',effect:'',race:null}},
  {id:'xyz',catalog_card_id:'11110002',game_metadata:{type:'XYZ Monster',level:null,rank:null,desc:null}},
  {id:'link',catalog_card_id:'11110003',game_metadata:{type:'Link Monster',level:null,atk:1000}},
  {id:'normal',catalog_card_id:'11110004',game_metadata:{type:'Normal Monster',level:4,atk:1500,def:1000,text:'Stored text'}},
  {id:'spell',catalog_card_id:'11110005',game_metadata:{type:'Spell Card',race:null}},
  {id:'synchro',catalog_card_id:'11110006',game_metadata:{type:'Synchro Monster',level:8,text:null}},
  {id:'missing',catalog_card_id:'11110007',game_metadata:null},
  {id:'precise',catalog_card_id:'11110008',game_metadata:{cardType:'Monster',type:'Synchro Tuner Monster',level:8,text:'1 Tuner + 1+ non-Tuner monsters'}}
];
const canonical=[
  {id:11110001,type:'Tuner Monster',level:3,atk:1800,def:0,race:'Zombie',desc:'Canonical Tuner effect'},
  {id:11110002,type:'XYZ Monster',level:4,atk:2500,def:2000,desc:'2 Level 4 monsters\nYou can detach 1 material from this card; apply an effect.'},
  {id:11110005,type:'Spell Card',race:'Field',desc:'Canonical Field Spell'},
  {id:11110006,type:'Synchro Monster',level:8,desc:'1 Tuner + 1+ non-Tuner monsters\nApply an effect.'},
  {id:11110007,type:'Effect Monster',level:2,atk:500,def:100,desc:'Canonical missing-printing data'}
];
const originalFetch=globalThis.fetch,requests=[],catalogueRequests=[];
globalThis.fetch=async(input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url||String(input));
  requests.push(url.href);
  const json=body=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  if(url.hostname==='synthetic.invalid'){
    assert.equal((init.method||'GET'),'GET','Hydrating a saved deck must not write data');
    if(url.pathname==='/rest/v1/decks'){
      assert.equal(url.searchParams.get('owner_slug'),`eq.${owner}`);assert.equal(url.searchParams.get('game'),'eq.yugioh');
      return json(url.searchParams.get('id')===`eq.${deckId}`?{id:deckId,owner_slug:owner,game:'yugioh',name:'Metadata fixture'}:null);
    }
    if(url.pathname==='/rest/v1/deck_cards'){assert.equal(url.searchParams.get('deck_id'),`eq.${deckId}`);return json(cards);}
    if(url.pathname==='/rest/v1/card_printings')return json(printings);
  }
  if(url.hostname==='db.ygoprodeck.com'){
    assert.equal(url.pathname,'/api/v7/cardinfo.php');const codes=url.searchParams.get('id').split(',');catalogueRequests.push(...codes);
    return json({data:canonical.filter(card=>codes.includes(String(card.id)))});
  }
  throw Error('Unexpected external request: '+url.href);
};
try{
  const database=createDatabase({SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-test-key'});
  const deck=await database.store.deck(deckId,owner),byCode=Object.fromEntries(deck.cards.map(card=>[card.catalogCardId,card]));
  assert.equal(deck.ownerSlug,owner);assert.equal(byCode['11110001'].level,3);assert.equal(byCode['11110001'].isTuner,true);
  assert.equal(byCode['11110001'].atk,1800);assert.equal(byCode['11110001'].def,0);assert.equal(byCode['11110001'].race,'Zombie');assert.equal(byCode['11110001'].text,'Canonical Tuner effect');
  assert.equal(byCode['11110002'].rank,4);assert.equal(byCode['11110002'].level,4);assert.match(byCode['11110002'].text,/2 Level 4/);
  assert.equal(byCode['11110003'].level,null);assert.equal(byCode['11110003'].rank,null);assert.equal(byCode['11110003'].atk,1000);
  assert.equal(byCode['11110004'].level,4);assert.equal(byCode['11110004'].text,'Stored text');assert.equal(byCode['11110004'].isTuner,false);
  assert.equal(byCode['11110005'].race,'Field');assert.equal(byCode['11110006'].level,8);assert.match(byCode['11110006'].text,/1 Tuner/);
  assert.equal(byCode['11110007'].level,2);
  assert.equal(byCode['11110008'].type,'Synchro Tuner Monster');assert.equal(byCode['11110008'].isTuner,true);assert.equal(byCode['11110008'].level,8);
  assert.deepEqual(catalogueRequests.sort(),['11110001','11110002','11110005','11110006','11110007']);
  const before=requests.length;assert.equal(await database.store.deck('missing',owner),null);assert.equal(requests.length,before+1,'Unresolved owner/deck must stop before reading cards or public metadata');
  console.log('PASS authorized deck hydration fills missing Level/Rank/Tuner/recipe data without null overrides');
  console.log('PASS selected printing gaps trigger fallback, complete/Link metadata avoids unnecessary lookups and missing decks stop before hydration');
}finally{globalThis.fetch=originalFetch;}
console.log('yugioh-metadata-smoke: OK (no real account, database or request)');
