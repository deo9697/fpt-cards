// Synthetic adapters verify request shape, current authorization and CAS.
// No account, network, production row or notification is used by this script.
import assert from 'node:assert/strict';
import {createRequestTimings,timeDatabase} from '../api/_yugioh-timing.js';
import {createDuelHandler,createDatabase} from '../api/yugioh-duel.js';
import {createPracticeService} from '../api/_yugioh-practice-service.js';
import {projectAutoStateSafe} from '../api/_yugioh-auto-executor.js';

const id=index=>'a2000000-0000-4000-8000-'+String(index).padStart(12,'0');
const actor={slug:'perf-owner',name:'Owner',teamId:id(1)},clone=value=>structuredClone(value);
const decode=header=>Object.fromEntries(header.split(', ').map(item=>{const[name,value]=item.split(';dur=');return[name,Number(value)];}));
let clock=0,releaseA,releaseB;
const timing=createRequestTimings({clock:()=>clock});
const a=timing.measure('db',()=>new Promise(resolve=>{releaseA=resolve;}));clock=5;
const b=timing.measure('db',()=>new Promise(resolve=>{releaseB=resolve;}));clock=10;releaseA();await a;clock=15;releaseB();await b;
assert.deepEqual(decode(timing.header()),{total:15,auth:0,db:15,engine:0},'Concurrent DB operations measure their wall-span union, not double-counted sum');
await assert.rejects(()=>timing.measure('engine',async()=>{clock=19;throw Error('private failed operation');}));
assert.equal(decode(timing.header()).engine,4);
const wrapped=timeDatabase({store:{label:'bound-store',async members(){assert.equal(this.label,'bound-store');return[];}}},timing);
await wrapped.store.members();
console.log('PASS anonymous request-local timing, overlapping DB spans, exception accounting and adapter context');

const fakeState=()=>({mode:'auto',seed:'PRIVATE_SEED',inputs:[],initialDecks:[{id:id(2),name:'Personal deck'}],result:null,publicViews:[0,1].map(viewer=>({mode:'auto',status:'playing',turn:1,phase:'main1',activePlayer:0,chain:[],log:[],result:null,players:[0,1].map(player=>({name:player?'Passive':'Owner',deckName:'Deck',lp:8000,hand:player===viewer?[{id:'own',cardName:'Known card'}]:[{hidden:true}],deck:Array.from({length:35},()=>({hidden:true})),monsters:[],extraMonsters:[],spells:[],field:[],graveyard:[],banished:[],extra:[],side:[]})),auto:{prompt:viewer===0?{id:'prompt',kind:'idle',options:[]}:null}}))});
let row={id:id(3),team_id:actor.teamId,owner_slug:actor.slug,status:'playing',version:1,state:fakeState(),start_request_id:id(4),last_action_id:id(4),created_at:'2026-11-18T00:00:00Z',updated_at:'2026-11-18T00:00:00Z',expires_at:'2099-01-01T00:00:00Z'};
let active=true,membersRelease,ownerReads=0,updates=0,engineCalls=0;
const parallelStore={members(){return new Promise(resolve=>{membersRelease=resolve;});}};
const parallelPractices={
  async get(team,slug){assert.equal(team,actor.teamId);assert.equal(slug,actor.slug);ownerReads++;membersRelease(active?[{slug:actor.slug,name:actor.name}]:[]);return clone(row);},
  async update(key,version,team,slug,patch){
    updates++;assert.equal(key,row.id);assert.equal(version,row.version);assert.equal(team,actor.teamId);assert.equal(slug,actor.slug);
    row={...row,...clone(patch),updated_at:'2026-11-18T00:00:00.123Z'};
    return{id:row.id,version:row.version,updated_at:row.updated_at,state:{seed:'ACK_SHOULD_NOT_REPLACE_STATE'},owner_slug:'wrong-ack-owner'};
  }
};
const runtime={project:projectAutoStateSafe,async run(operation,payload){engineCalls++;assert.equal(operation,'apply');const next=clone(payload.state);next.inputs.push(payload.choice);next.publicViews[0].players[0].lp=7600;return next;}};
const service=createPracticeService({store:parallelStore,practices:parallelPractices,autoRuntime:runtime});
let response=await Promise.race([service.run(actor,{op:'practiceState'}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Scoped reads were serialized instead of started together')),1000))]);
assert.equal(response.duel.id,row.id);assert.equal(ownerReads,1);
response=await service.run(actor,{op:'practiceAction',duelId:row.id,expectedVersion:1,requestId:id(5),action:{type:'autoRespond',promptId:'prompt',choice:{optionId:'to_ep'}}});
assert.equal(updates,1);assert.equal(response.duel.version,2);assert.equal(response.duel.updatedAt,row.updated_at);assert.equal(response.duel.state.players[0].lp,7600);assert.equal(row.state.seed,'PRIVATE_SEED');
assert(!JSON.stringify(response).includes('PRIVATE_SEED'));assert(!JSON.stringify(response).includes('ACK_SHOULD_NOT_REPLACE_STATE'));
active=false;const callsBeforeRevocation=engineCalls;
await assert.rejects(()=>service.run(actor,{op:'practiceState'}),error=>error.status===403);
assert.equal(engineCalls,callsBeforeRevocation);active=true;
console.log('PASS parallel scoped membership/owner reads, minimal CAS acknowledgement merge and immediate membership revocation');

const env={SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-test-key'};
let authAllowed=false,authCalls=0,dbCalls=0;
const handler=createDuelHandler({env,databaseFactory:()=>({
  authenticate:async token=>{authCalls++;if(!authAllowed||token!=='own-token')throw Error('PRIVATE_AUTH_FAILURE');return actor;},
  store:{members:async()=>{dbCalls++;return[{slug:actor.slug,name:actor.name}];}},
  practices:{get:async()=>{dbCalls++;return clone(row);},update:async(...args)=>{dbCalls++;return parallelPractices.update(...args);}}
}),autoRuntime:{...runtime,run:async(...args)=>{await new Promise(resolve=>setTimeout(resolve,5));return runtime.run(...args);}}});
async function http(body){
  const headers={};let result;
  await handler({method:'POST',headers:{host:'localhost','content-type':'application/json'},body},{setHeader:(key,value)=>{headers[key]=value;},status(code){this.code=code;return this;},json(value){result={status:this.code,headers,body:value,serialized:JSON.stringify(value)};return this;}});
  return result;
}
response=await http({op:'practiceState'});assert.equal(response.status,401);assert.equal(dbCalls,0);assert.equal(authCalls,1);
assert.match(response.headers['Server-Timing'],/^total;dur=\d+\.\d{2}, auth;dur=\d+\.\d{2}, db;dur=0\.00, engine;dur=0\.00$/);
assert(!response.headers['Server-Timing'].includes(actor.slug));assert(!response.serialized.includes('PRIVATE_AUTH_FAILURE'));
authAllowed=true;response=await http({op:'practiceState',token:'own-token'});assert.equal(response.status,200);assert.match(response.headers['Cache-Control'],/no-store/);assert.equal(dbCalls,2);
assert(decode(response.headers['Server-Timing']).total>=decode(response.headers['Server-Timing']).auth);
const engineBeforeHttp=engineCalls;
response=await http({op:'practiceAction',token:'own-token',duelId:row.id,expectedVersion:row.version,requestId:id(6),action:{type:'autoRespond',promptId:'prompt',choice:{optionId:'to_ep'}}});
assert.equal(response.status,200);assert.equal(engineCalls,engineBeforeHttp+1);assert(decode(response.headers['Server-Timing']).engine>=4,'HTTP engine wait must be measured separately from database time');assert.equal(dbCalls,5);
assert(!response.serialized.includes('PRIVATE_SEED'));assert(!response.serialized.includes('ACK_SHOULD_NOT_REPLACE_STATE'));
const samples=[];
for(let index=0;index<50;index++){const begin=performance.now();await http({op:'practiceState',token:'own-token'});samples.push(performance.now()-begin);}
samples.sort((a,b)=>a-b);
console.log('PASS Server-Timing on 401 and success without sensitive labels; warm synthetic API mean '+(samples.reduce((sum,value)=>sum+value,0)/samples.length).toFixed(3)+'ms / p95 '+samples[Math.floor(samples.length*.95)].toFixed(3)+'ms (no network/engine)');

const originalFetch=globalThis.fetch,requests=[];
globalThis.fetch=async(input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url||String(input));assert.equal(url.hostname,'synthetic.invalid');
  requests.push({path:url.pathname,select:url.searchParams.get('select'),method:init.method||'GET',team:url.searchParams.get('team_id'),owner:url.searchParams.get('owner_slug'),version:url.searchParams.get('version')});
  const json=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
  if(url.pathname==='/rest/v1/decks')return json(url.searchParams.get('owner_slug')==='eq.'+actor.slug?{id:id(2),owner_slug:actor.slug,game:'yugioh',name:'Saved deck'}:null);
  if(url.pathname==='/rest/v1/deck_cards')return json([{catalog_card_id:'43096270',card_name:'Alexandrite Dragon',image_url:'',section:'main',quantity:1,printing_id:'printing',position:0,ban_tcg:''}]);
  if(url.pathname==='/rest/v1/card_printings')return json([{id:'printing',catalog_card_id:'43096270',game_metadata:{type:'Normal Monster',level:4,atk:2000,def:100,text:'Complete stored text'}}]);
  if(url.pathname==='/rest/v1/yugioh_practice_sessions')return json({id:row.id,version:3,updated_at:'2026-11-18T00:00:01Z'});
  throw Error('Unexpected adapter request');
};
try{
  const database=createDatabase(env);
  let before=requests.length;const auto=await database.store.deck(id(2),actor.slug,{mode:'auto'});
  assert.equal(auto.cards[0].catalogCardId,'43096270');assert.deepEqual(requests.slice(before).map(request=>request.path),['/rest/v1/decks','/rest/v1/deck_cards']);
  before=requests.length;const manual=await database.store.deck(id(2),actor.slug,{mode:'manual'});assert.equal(manual.cards[0].atk,2000);assert.equal(requests.length-before,3,'Manual metadata hydration remains available');
  before=requests.length;assert.equal(await database.store.deck(id(2),'wrong-owner',{mode:'auto'}),null);assert.equal(requests.length-before,1);
  const ack=await database.practices.update(row.id,2,actor.teamId,actor.slug,{version:3,state:row.state});
  assert.equal(ack.version,3);assert.equal(requests.at(-1).select,'id,version,updated_at');assert.equal(requests.at(-1).owner,'eq.'+actor.slug);assert.equal(requests.at(-1).team,'eq.'+actor.teamId);assert.equal(requests.at(-1).version,'eq.2');
}finally{globalThis.fetch=originalFetch;}
console.log('PASS automatic deck hydration needs exactly two authorized reads; manual hydration preserved; CAS returns only scoped metadata');
console.log('yugioh-api-performance-smoke: OK (no real account, database or notification)');
