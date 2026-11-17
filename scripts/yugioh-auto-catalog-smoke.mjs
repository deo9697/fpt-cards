// SPDX-License-Identifier: AGPL-3.0-or-later
// Catalog compatibility only: compile/initialize every released standard TCG
// card, including Forbidden cards. This does not certify all effect interactions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import createCore, {OcgDuelMode as D, OcgLocation as L, OcgPosition as P, OcgType as T} from 'ocgcore-wasm';
import {loadAutoResources,LEGACY_AUTO_RESOURCE_VERSION} from '../api/_yugioh-auto-resources.js';
import {createAutoState,applyAutoInput} from '../api/_yugioh-auto-core.js';

const resources=await loadAutoResources();
const legacy=await loadAutoResources(LEGACY_AUTO_RESOURCE_VERSION);
assert(!legacy.scripts.has('c88264978.lua'),'Keep the previous immutable resource profile intact');
assert(resources.scripts.has('c88264978.lua'),'Current TCG errata must be included in the new profile');
const cards=[...resources.cards.values()].filter(card=>[2,3].includes(card.ot)&&!(card.type&(T.TOKEN|T.MAXIMUM))&&[1,2,4].includes(card.type&7));
assert(cards.length>10000,'Unexpectedly incomplete TCG catalog');
const core=await createCore({sync:true,print:()=>{},printErr:()=>{}}),failures=[];
let initialized=0;
for(let offset=0;offset<cards.length;offset+=128){
  const errors=[],chunk=cards.slice(offset,offset+128);
  const duel=core.createDuel({flags:D.MODE_MR5|D.TCG_SEGOC_NONPUBLIC|D.TCG_SEGOC_FIRSTTRIGGER,seed:[1n,2n,3n,4n],team1:{startingLP:8000,startingDrawCount:5,drawCountPerTurn:1},team2:{startingLP:8000,startingDrawCount:5,drawCountPerTurn:1},cardReader:code=>resources.cards.get(code)||null,scriptReader:name=>resources.scripts.get(name)||null,errorHandler:(type,message)=>{if(type===0)errors.push(String(message));}});
  assert(duel);
  try{
    for(const name of ['constant.lua','utility.lua'])assert(core.loadScript(duel,name,resources.scripts.get(name)),name);
    for(const card of chunk){
      const before=errors.length;
      core.duelNewCard(duel,{code:card.code,team:0,duelist:0,controller:0,location:card.type&(T.FUSION|T.SYNCHRO|T.XYZ|T.LINK)?L.EXTRA:L.DECK,sequence:0,position:P.FACEDOWN_DEFENSE});
      if(errors.length>before)failures.push({code:card.code,name:card.name,errors:errors.slice(before)});
      initialized++;
    }
  }finally{core.destroyDuel(duel);}
}
const report={kind:'catalog-compile-and-initialization',engine:'ocgcore-wasm@0.1.6',resources:resources.version,initialized,failures};
fs.mkdirSync('artifacts/yugioh-auto',{recursive:true});
fs.writeFileSync('artifacts/yugioh-auto/catalog-verification.json',JSON.stringify(report,null,2));
assert.deepEqual(failures,[],`${failures.length} cards fail to initialize: ${JSON.stringify(failures.slice(0,5))}`);
console.log(`PASS actual core initialization of all ${initialized} released standard TCG cards (Forbidden included); zero Lua errors.`);
// A saved game must resume with the same resource version and prompt IDs after
// deployment. The API never accepts this internal setup option from a client.
const main=cards.filter(card=>card.type===17&&card.level<=4&&!card.alias).slice(0,40).map(card=>card.code);
const saved=await createAutoState({decks:[{main},{main}],resourceVersion:LEGACY_AUTO_RESOURCE_VERSION,seed:'123456789abcdef0'.repeat(4)});
assert.equal(saved.resourceVersion,LEGACY_AUTO_RESOURCE_VERSION);
const prompt=saved.publicViews[0].auto.prompt;
const input={viewer:0,promptId:prompt.id,choice:{optionId:'to_ep'}};
const [next,replayed]=await Promise.all([applyAutoInput(saved,input),applyAutoInput(JSON.parse(JSON.stringify(saved)),input)]);
assert.equal(next.resourceVersion,LEGACY_AUTO_RESOURCE_VERSION);assert.deepEqual(next,replayed);
assert.equal((await createAutoState({decks:[{main},{main}]})).resourceVersion,resources.version);
console.log('PASS previous resource profile resumes with deterministic inputs; new tables use the repaired profile.');
