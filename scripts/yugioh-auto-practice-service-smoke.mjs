// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {createPracticeService} from '../api/_yugioh-practice-service.js';
import {createDuelHandler} from '../api/yugioh-duel.js';
import {projectAutoStateSafe,runAutoOperation} from '../api/_yugioh-auto-executor.js';
import {loadAutoResources} from '../api/_yugioh-auto-resources.js';
const id=n=>`a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`,team=id(1),actor={slug:'owner',teamId:team,name:'Practice Owner'},guest={slug:'guest',teamId:team},outside={slug:'outside',teamId:id(2)},deckId=id(10),clone=value=>value==null?value:structuredClone(value);
let member=true,clock=new Date('2026-11-18T08:00:00Z'),conflict=false,row=null;
const calls=[],store={members:async()=>member?[{slug:'owner',name:'Practice Owner'},{slug:'guest',name:'Guest'}]:[],deck:async(key,owner,options)=>{calls.push(['deck',key,owner,options.mode]);return key===deckId&&owner==='owner'?{id:deckId,ownerSlug:'owner',game:'yugioh',name:'Owned deck',cards:[]}:null;}};
const practices={get:async(t,s)=>clone(row&&row.team_id===t&&row.owner_slug===s?row:null),insert:async next=>{if(row)return null;row=clone(next);return clone(row);},update:async(key,version,t,s,patch)=>{if(conflict){conflict=false;row.version++;return null;}if(!row||row.id!==key||row.version!==version||row.team_id!==t||row.owner_slug!==s)return null;row={...row,...clone(patch)};return clone(row);}};
const fakeState=()=>({mode:'auto',passivePolicy:'passive-v1',seed:'private-seed',initialDecks:[{id:deckId,name:'Owned deck'}],inputs:[],result:null,publicViews:[0,1].map(viewer=>({mode:'auto',players:[{name:'Owner',deckName:'Owned deck',deckId,hand:[],deck:[],monsters:[],extraMonsters:[],spells:[],field:[],graveyard:[],banished:[],side:[],extra:[],lp:8000},{name:'Campo di prova',deckName:'Mirror',hand:[],deck:[],monsters:[],extraMonsters:[],spells:[],field:[],graveyard:[],banished:[],side:[],extra:[],lp:8000}],turn:1,phase:'main1',activePlayer:0,chain:[],log:[],result:null,auto:{prompt:viewer===0?{id:'test-prompt',kind:'idle',options:[]}:null}}))});
const runtime={project:projectAutoStateSafe,run:async(op,payload)=>{calls.push([op,payload.viewer]);if(op==='createPractice')return fakeState();if(op==='apply'){if(payload.viewer!==0||payload.promptId!=='test-prompt')throw Object.assign(new Error('Invalid prompt'),{status:409});const next=clone(payload.state);next.inputs.push(payload.choice);return next;}if(op==='search'){if(payload.viewer!==0||payload.promptId!=='test-prompt')throw Object.assign(new Error('Invalid search'),{status:409});return Array.from({length:45},(_,i)=>({code:i+1,name:'Card'}));}throw Error(op);}};
const service=createPracticeService({store,practices,autoRuntime:runtime,now:()=>clock});
const start=()=>({op:'practiceStart',deckId,requestId:id(20)});
const rejects=(person,payload,status)=>assert.rejects(()=>service.run(person,payload),error=>error.status===status);
await rejects(outside,start(),403);await rejects(guest,start(),404);await rejects(actor,{...start(),deckId:id(999)},404);assert.equal(row,null);
let response=await service.run(actor,start());assert.equal(response.duel.practice,true);assert.equal(response.duel.mode,'auto');assert.equal(response.duel.viewer,0);assert.deepEqual(response.duel.ready,[true,true]);
for(const key of ['seed','inputs','initialDecks','publicViews','passivePolicy'])assert(!Object.hasOwn(response.duel.state,key));
const first=response.duel.id;assert.equal((await service.run(actor,start())).replayed,true);
const action={op:'practiceAction',duelId:first,expectedVersion:1,requestId:id(21),action:{type:'autoRespond',promptId:'test-prompt',choice:{optionId:'to_ep'}}};
response=await service.run(actor,action);assert.equal(response.duel.version,2);assert.equal(row.state.inputs.length,1);assert.equal((await service.run(actor,action)).replayed,true);assert.equal((await service.run(actor,start())).duel.version,2);
await rejects(guest,{op:'practiceState',duelId:first},404);await rejects(outside,{op:'practiceState',duelId:first},403);
await rejects(actor,{...action,requestId:id(22),expectedVersion:1},409);await rejects(actor,{...action,requestId:id(22),expectedVersion:2,action:{type:'move',to:'hand'}},400);await rejects(actor,{...action,requestId:id(22),expectedVersion:2,action:{type:'autoRespond',player:1,promptId:'test-prompt',choice:{optionId:'to_ep'}}},400);
assert.equal((await service.run(actor,{op:'practiceSearch',duelId:first,promptId:'test-prompt',query:'Card'})).cards.length,30);
await rejects(actor,{op:'practiceSearch',duelId:first,promptId:'other',query:'Card'},409);
response=await service.run(actor,{...start(),requestId:id(23)});assert.notEqual(response.duel.id,first);assert.equal(response.duel.version,3);assert.equal((await service.run(actor,start())).duel.id,response.duel.id,'Old startup retry cannot replace a newer practice');
await rejects(actor,{op:'practiceState',duelId:first},409);assert.equal((await service.run(actor,{op:'practiceState',knownVersion:3})).unchanged,true);
conflict=true;await rejects(actor,{op:'practiceAction',duelId:row.id,expectedVersion:3,requestId:id(24),action:{type:'autoRespond',promptId:'test-prompt',choice:{optionId:'to_ep'}}},409);
member=false;await rejects(actor,{op:'practiceState'},403);member=true;
clock=new Date('2026-11-20T08:00:00Z');await rejects(actor,{op:'practiceState'},410);clock=new Date('2026-11-18T08:00:00Z');
console.log('PASS personal practice ownership, safe projection, CAS/idempotency/restart history, expiry, search and engine-only actions.');

// 2026-11-21: la parte HTTP usa l'orologio vero (il gestore non riceve `now`):
// la prova creata con l'orologio finto del 18/11 risultava già scaduta.
if(row)row.expires_at=new Date(Date.now()+86400000).toISOString();
// The HTTP route shares authentication/no-store with PvP, but never dispatches
// through the PvP service and never calls an invitation/push/statistics method.
const handler=createDuelHandler({env:{SUPABASE_URL:'https://test.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic'},databaseFactory:()=>({authenticate:async token=>{if(token!=='own-token')throw Error('Unauthorized');return actor;},store,practices}),autoRuntime:runtime,notify:async()=>{throw Error('Practice must not send notifications');}});
async function http(body){const headers={};let result;await handler({method:'POST',headers:{'content-type':'application/json'},body},{setHeader:(key,value)=>headers[key]=value,status(code){this.code=code;return this;},json(value){result={status:this.code,headers,body:value};return this;}});return result;}
assert.equal((await http({op:'practiceState'})).status,401);let actual=await http({op:'practiceState',token:'own-token'});assert.equal(actual.status,200);assert.match(actual.headers['Cache-Control'],/no-store/);
console.log('PASS authenticated no-store HTTP practice dispatch without invitation or notification paths.');

// Real saved-deck data, real worker and passive core. No user-selected state,
// hand edits or simplified duel flags enter the practice engine.
const resources=await loadAutoResources(),main=[...resources.cards.values()].filter(card=>card.ot===3&&card.type===17&&!card.alias&&card.level<=4).slice(0,40).map(card=>card.code);
const realDeck={id:deckId,ownerSlug:'owner',game:'yugioh',name:'Real personal deck',main};row=null;
const real=createPracticeService({store:{...store,deck:async()=>realDeck},practices,autoRuntime:{project:projectAutoStateSafe,run:runAutoOperation},now:()=>clock});
response=await real.run(actor,{...start(),requestId:id(30)});assert.equal(row.state.passivePolicy,'passive-v1');assert.equal(response.duel.state.auto.prompt.player,0);assert.equal(response.duel.state.phase,'main1');
response=await real.run(actor,{op:'practiceAction',duelId:response.duel.id,expectedVersion:response.duel.version,requestId:id(31),action:{type:'autoRespond',promptId:response.duel.state.auto.prompt.id,choice:{optionId:'to_ep'}}});
for(let step=0;step<40&&!(response.duel.state.turn>=3&&response.duel.state.phase==='main1');step++){
  const prompt=response.duel.state.auto.prompt;assert(prompt&&prompt.player===0);
  const option=prompt.options.find(option=>option.id==='pass')||prompt.options.find(option=>option.id==='no');assert(option,JSON.stringify(prompt));
  response=await real.run(actor,{op:'practiceAction',duelId:response.duel.id,expectedVersion:response.duel.version,requestId:id(50+step),action:{type:'autoRespond',promptId:prompt.id,choice:{optionId:option.id}}});
}
assert(response.duel.state.turn>=3);assert(!response.duel.state.auto.prompt||response.duel.state.auto.prompt.player===0);assert.equal(response.duel.practice,true);assert(row.state.inputs.some(input=>input.viewer===1),'Passive responses must be persisted for replay');
console.log('PASS actual practice worker creates an automatic personal field and records passive opponent responses.');
