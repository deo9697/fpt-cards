// Synthetic service/HTTP tests only. No production account, push or database.
import assert from 'node:assert/strict';
import { createDuelService, DuelError, redactState } from '../api/_yugioh-duel-service.js';
import { createDuelHandler, sendInvitePush, lookupYugiohMetadata } from '../api/yugioh-duel.js';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const id = index => `30000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
const team = id(1), otherTeam = id(2);
const host = { slug:'ygo-host', name:'Host', teamId:team };
const guest = { slug:'ygo-guest', name:'Guest', teamId:team };
const third = { slug:'ygo-third', name:'Third', teamId:team };
const outsider = { slug:'ygo-outside', name:'Outside', teamId:otherTeam };
const actors = [host, guest, third, outsider];
const fixture = (owner, index) => ({ id:id(index), ownerSlug:owner.slug, game:'yugioh', name:`${owner.name} deck`, cards:[
  ...Array.from({ length:12 },(_,i)=>({ section:'main',catalogCardId:String(10000000+i),cardName:`Secret ${owner.slug} ${i}`,quantity:3,type:'Effect Monster',level:4,atk:1800,def:1000 })),
  { section:'main',catalogCardId:'11000001',cardName:'Secret Spell',quantity:3,type:'Spell Card' },
  { section:'main',catalogCardId:'11000002',cardName:'Secret Trap',quantity:1,type:'Trap Card' },
  { section:'extra',catalogCardId:'12000001',cardName:'Secret Xyz',quantity:1,type:'XYZ Monster',level:4,rank:4,text:'2 Level 4 monsters',atk:2500,def:2000 },
  { section:'extra',catalogCardId:'12000002',cardName:'Secret Link',quantity:1,type:'Link Monster',atk:2000 },
  { section:'side',catalogCardId:'13000001',cardName:'Secret Side',quantity:1,type:'Effect Monster',atk:1000,def:1000 }
] });
const decks = [fixture(host,10),fixture(guest,11)];
const records = new Map(), pushes = [];
let clock = new Date('2026-11-10T16:00:00Z'), fullReads=0, metaReads=0;
const store = {
  members:async teamId=>actors.filter(actor=>actor.teamId===teamId).map(({slug,name})=>({slug,name})),
  pushMembers:async()=>[guest.slug],
  list:async(teamId,slug)=>clone([...records.values()].filter(row=>row.team_id===teamId && [row.host_slug,row.guest_slug].includes(slug))),
  get:async key=>{ fullReads++; return clone(records.get(key)||null); },
  meta:async key=>{ metaReads++; const row=records.get(key); return row ? Object.fromEntries(['id','team_id','host_slug','guest_slug','status','version','ready','expires_at'].map(field=>[field,clone(row[field])])) : null; },
  deck:async(key,ownerSlug)=>clone(decks.find(deck=>deck.id===key && deck.ownerSlug===ownerSlug)||null),
  recentCount:async(slug,since)=>[...records.values()].filter(row=>row.host_slug===slug && row.created_at>=since).length,
  insert:async row=>{ if(records.has(row.id))return null; records.set(row.id,clone(row)); return clone(row); },
  update:async(key,version,patch)=>{ const row=records.get(key); if(!row||row.version!==version)return null; const next={...row,...clone(patch)}; records.set(key,next); return clone(next); }
};
const service = createDuelService({ store,now:()=>clock,notify:async invitation=>{ pushes.push(invitation); return {push:'sent'}; } });
const run = (actor,payload)=>service.run(actor,payload);
const rejects = (actor,payload,status,code)=>assert.rejects(()=>run(actor,payload),error=>error instanceof DuelError && error.status===status && (!code||error.code===code));
const duelId=id(20);
const invitation={ op:'invite',requestId:duelId,opponentSlug:guest.slug,deckId:decks[0].id,firstPlayer:0 };
await rejects({}, {op:'lobby'},401);
const practiceDeck=await run(host,{op:'practice',deckId:decks[0].id});
assert.equal(practiceDeck.deck.id,decks[0].id);
await rejects(host,{op:'practice',deckId:decks[1].id},404,'deck_not_found');
await rejects(outsider,{op:'practice',deckId:decks[0].id},404,'deck_not_found');
assert.equal(records.size,0,'Preparing solo practice must not create a multiplayer table');
assert.equal(pushes.length,0,'Preparing solo practice must not send invitations');
assert.equal((await run(host,{op:'lobby'})).members.length,3);
await rejects(host,{...invitation,opponentSlug:outsider.slug},400,'invalid_opponent');
await rejects(host,{...invitation,deckId:decks[1].id},404,'deck_not_found');
await rejects(host,{...invitation,lp:0},400,'invalid_setup');
let response=await run(host,invitation);
assert.equal(response.duel.status,'waiting'); assert.equal(records.get(duelId).host_lp,8000);
assert.equal(response.notification.push,'sent');
assert.equal((await run(host,invitation)).replayed,true); assert.equal(pushes.length,1);
await rejects(host,{...invitation,requestId:id(21)},409,'already_invited');
await rejects(third,{op:'state',duelId},404); await rejects(outsider,{op:'state',duelId},404);
await rejects(host,{op:'accept',duelId,expectedVersion:1,requestId:id(22),deckId:decks[0].id},403);
response=await run(guest,{op:'accept',duelId,expectedVersion:1,requestId:id(23),deckId:decks[1].id});
assert.equal(response.duel.status,'setup'); assert.equal(response.duel.viewer,1);
assert.equal(response.duel.state.players[1].hand.length,5);
assert(response.duel.state.players[0].hand.every(card=>card.hidden && !card.catalogCardId));
assert(response.duel.state.players[0].extra.every(card=>card.hidden && !card.catalogCardId));
assert(response.duel.state.players[0].side.every(card=>card.hidden && !card.catalogCardId));
assert(response.duel.state.players[1].extra.every(card=>!card.hidden && card.cardName));
assert(response.duel.state.players.every(player=>player.deck.every(card=>card.hidden)));
assert.equal(records.get(duelId).host_deck,null);
await rejects(guest,{op:'inspect',duelId,zone:'deck'},409,'not_started');
let request=100;
const action=async(actor,command)=>run(actor,{op:'action',duelId,expectedVersion:records.get(duelId).version,requestId:id(++request),action:command});
await action(host,{type:'ready'});
await rejects(host,{op:'action',duelId,expectedVersion:3,requestId:id(24),action:{type:'draw'}},409,'already_ready');
response=await action(guest,{type:'ready'});
assert.equal(response.duel.status,'playing'); assert.notEqual(response.duel.state.phase,'setup');
assert.deepEqual(response.duel.state.players.map(player=>player.lp),[8000,8000]);
const version=records.get(duelId).version, beforeReads=fullReads;
assert.deepEqual(await run(host,{op:'state',duelId,knownVersion:version}),{unchanged:true,duelId,version});
assert.equal(fullReads,beforeReads); assert.equal(metaReads,1);
await rejects(third,{op:'state',duelId,knownVersion:version},404);
await rejects(guest,{op:'inspect',duelId,zone:'deck',player:0},403,'opponent_zone');
await rejects(guest,{op:'inspect',duelId,zone:'side'},400,'invalid_zone');
response=await run(guest,{op:'inspect',duelId,zone:'deck'});
assert.equal(response.cards.length,35); assert(response.cards.every(card=>card.cardName.startsWith('Secret')));
await rejects(guest,{op:'action',duelId,expectedVersion:version,requestId:id(25),action:{type:'nextTurn'}},403,'not_your_turn');
await rejects(guest,{op:'action',duelId,expectedVersion:version,requestId:id(26),action:{type:'draw',player:0}},403,'opponent_action');
await rejects(host,{op:'action',duelId,expectedVersion:version,requestId:id(27),action:{type:'move',cardId:'hidden-1-deck-0',to:'hand'}},403,'hidden_card');
// Real own hand IDs are available; concealed draws never upload card identity.
const draw={op:'action',duelId,expectedVersion:version,requestId:id(28),action:{type:'draw',count:1}};
await run(host,draw); assert.equal((await run(host,draw)).replayed,true);
assert.equal(records.get(duelId).state.players[0].hand.length,6);
await assert.rejects(()=>run(guest,{...draw,requestId:id(29)}),error=>error.status===409 && error.duel.state.players[0].hand.every(card=>card.hidden));
const beforePhase=clone(records.get(duelId).state);
await rejects(guest,{op:'action',duelId,expectedVersion:records.get(duelId).version,requestId:id(++request),action:{type:'setPhase',phase:'battle'}},403,'not_your_turn');
await rejects(host,{op:'action',duelId,expectedVersion:records.get(duelId).version,requestId:id(++request),action:{type:'setPhase',phase:'invalid'}},400,'invalid_action');
assert.deepEqual(records.get(duelId).state,beforePhase);
await action(host,{type:'setPhase',phase:'main1'});
assert.equal(records.get(duelId).state.phase,'main1');
assert.deepEqual(records.get(duelId).state.players,beforePhase.players);
assert.equal(records.get(duelId).state.turn,beforePhase.turn);
assert.equal((await run(guest,{op:'state',duelId})).duel.state.phase,'main1');
await action(host,{type:'setPhase',phase:'draw'});
console.log('PASS direct phase declarations synchronize, preserve cards and reject inactive/invalid changes');
let full=records.get(duelId).state;
let card=full.players[0].hand.find(card=>/Monster/.test(card.type));
if(!card){ const found=full.players[0].deck.find(card=>/Monster/.test(card.type)); await action(host,{type:'move',cardId:found.id,to:'hand'}); card=found; }
await action(host,{type:'move',cardId:card.id,to:'monsters',slot:3,faceUp:false,position:'defense'});
let view=(await run(guest,{op:'state',duelId})).duel;
let covered=view.state.players[0].monsters[0];
assert(covered.hidden && !covered.catalogCardId && !covered.type && covered.atk===undefined);
assert.equal(covered.slot,3); assert.equal(covered.position,'defense');
assert(!view.state.log.at(-1).text.includes(card.cardName),'Setting a card must not reveal its name through the shared log');
const privateCard=records.get(duelId).state.players[0].hand[0];
await action(host,{type:'move',cardId:privateCard.id,to:'deck',placement:'bottom'});
view=(await run(guest,{op:'state',duelId})).duel;
assert(!view.state.log.at(-1).text.includes(privateCard.cardName),'Returning a private hand card to the deck must not reveal its identity');
await action(host,{type:'flip',cardId:card.id});
view=(await run(guest,{op:'state',duelId})).duel;
assert.equal(view.state.players[0].monsters[0].catalogCardId,card.catalogCardId);
await action(host,{type:'activate',cardId:card.id});
view=(await run(guest,{op:'state',duelId})).duel;
assert.equal(view.state.chain.length,1); assert.equal(view.state.chain[0].cardName,card.cardName);
assert.equal(view.state.chain[0].number,1);
const beforePriority=clone(records.get(duelId).state);
await rejects(host,{op:'action',duelId,expectedVersion:records.get(duelId).version,requestId:id(++request),action:{type:'activate',cardId:card.id}},400,'invalid_action');
await rejects(host,{op:'action',duelId,expectedVersion:records.get(duelId).version,requestId:id(++request),action:{type:'passChain'}},400,'invalid_action');
await rejects(host,{op:'action',duelId,expectedVersion:records.get(duelId).version,requestId:id(++request),action:{type:'setPhase',phase:'main1'}},400,'invalid_action');
assert.deepEqual(records.get(duelId).state,beforePriority);
const responseCard=records.get(duelId).state.players[1].hand[0],responseHandLength=records.get(duelId).state.players[1].hand.length;
await action(guest,{type:'activate',cardId:responseCard.id});
const bothViews=await Promise.all([run(host,{op:'state',duelId}),run(guest,{op:'state',duelId})]);
assert.deepEqual(bothViews[0].duel.state.chain,bothViews[1].duel.state.chain);
assert.deepEqual(bothViews[0].duel.state.chain.map(link=>link.number),[1,2]);
assert.equal(bothViews[0].duel.state.chain[1].cardName,responseCard.cardName);
assert.equal(records.get(duelId).state.players[1].hand.length,responseHandLength,'Hand-effect declaration does not remove its source card');
assert(bothViews[0].duel.state.players[1].hand.every(item=>item.hidden&&!item.catalogCardId));
await action(host,{type:'passChain'});await action(guest,{type:'passChain'});
await action(guest,{type:'resolveChain'});
assert.deepEqual(records.get(duelId).state.chain.map(link=>link.number),[1]);
await action(host,{type:'resolveChain'});
assert.equal(records.get(duelId).state.chain.length,0);
console.log('PASS public numbered hand-effect chains, response priority, phase guards and descending resolution');
await action(host,{type:'lp',delta:-1200});
assert.equal(records.get(duelId).state.players[0].lp,6800);
await action(host,{type:'move',cardId:card.id,to:'banished',faceUp:false});
view=(await run(guest,{op:'state',duelId})).duel;
assert(view.state.players[0].banished[0].hidden);
const xyz=records.get(duelId).state.players[0].extra.find(card=>/XYZ/i.test(card.type));
const sourceMonsters=records.get(duelId).state.players[0].hand.concat(records.get(duelId).state.players[0].deck).filter(item=>/Monster/.test(item.type)).slice(0,2);
assert.equal(sourceMonsters.length,2);
await action(host,{type:'setPhase',phase:'main1'});
for(const[slot,material]of sourceMonsters.entries())await action(host,{type:'move',cardId:material.id,to:'monsters',slot,faceUp:true});
const foreignMaterial=records.get(duelId).state.players[1].hand[0].id,beforeForeignMaterials=clone(records.get(duelId).state);
await rejects(host,{op:'action',duelId,expectedVersion:records.get(duelId).version,requestId:id(++request),action:{type:'summon',cardId:xyz.id,materialIds:[sourceMonsters[0].id,foreignMaterial],to:'extraMonsters',slot:0,confirmRequirements:true}},400,'invalid_action');
await rejects(host,{op:'action',duelId,expectedVersion:records.get(duelId).version,requestId:id(++request),action:{type:'move',cardId:xyz.id,to:'extraMonsters',slot:0,faceUp:true}},400,'invalid_action');
assert.deepEqual(records.get(duelId).state,beforeForeignMaterials);
await action(host,{type:'summon',cardId:xyz.id,materialIds:sourceMonsters.map(item=>item.id),to:'extraMonsters',slot:0,position:'attack',confirmRequirements:true});
view=(await run(guest,{op:'state',duelId})).duel;
assert.equal(view.state.players[0].extraMonsters[0].cardName,xyz.cardName);
assert(view.state.players[0].extra.every(card=>card.hidden));
// Recursive material state is public while the remaining deck/hand stays hidden.
const material=records.get(duelId).state.players[0].hand.find(card=>/Monster/.test(card.type));
if(material){
  await action(host,{type:'move',cardId:material.id,to:'monsters',slot:0,faceUp:true});
  await action(host,{type:'attachMaterial',cardId:material.id,targetId:xyz.id});
  view=(await run(guest,{op:'state',duelId})).duel;
  assert.equal(view.state.players[0].extraMonsters[0].materials.at(-1).cardName,material.cardName);
  assert(view.state.players[0].hand.every(card=>card.hidden));
}
await action(host,{type:'finish',winner:0,notes:'Partita sintetica YGO'});
assert.equal((await run(guest,{op:'lobby'})).duels[0].result.notes,'Partita sintetica YGO');
await rejects(guest,{op:'action',duelId,expectedVersion:records.get(duelId).version,requestId:id(30),action:{type:'draw'}},409,'not_playing');
const expired=await run(host,{...invitation,requestId:id(31)});
clock=new Date(clock.getTime()+86400001);
await rejects(guest,{op:'state',duelId:expired.duel.id,knownVersion:1},410,'expired');
assert.equal(redactState(null,0),null);
console.log('PASS YGO invitations, own saved decks, readiness, private hand/Extra/Side, face-down fields, CAS replay/conflicts, chain, LP and results');

const env={SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-not-a-key'};
const handler=createDuelHandler({env,databaseFactory:()=>({authenticate:async token=>{if(token!=='synthetic-token')throw Error('raw private error');return host;},store}),notify:async()=>({push:'disabled'})});
const call=async(body,options={})=>{const res={headers:{},statusCode:200,setHeader(key,value){this.headers[key]=value;},status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};await handler({method:options.method||'POST',headers:{host:'localhost','content-type':'application/json',...options.headers},body},res);return res;};
assert.equal((await call({op:'lobby',token:'synthetic-token'})).statusCode,200);
assert.equal((await call({op:'lobby',token:'invalid'})).statusCode,401);
assert.equal((await call({},{method:'GET'})).statusCode,405);
assert.equal((await call('{bad')).statusCode,400);
assert.equal((await call({},{headers:{origin:'https://foreign.invalid'}})).statusCode,403);
assert.equal((await call({},{headers:{authorization:'bad'}})).statusCode,401);
assert.equal((await call(' '.repeat(16001))).statusCode,413);
assert.equal((await call({op:'lobby',token:'synthetic-token'})).headers['Cache-Control'],'private, no-store, max-age=0');
const notifications=[],deleted=[];
const pushDatabase={subscriptions:async()=>[{endpoint:'https://push.synthetic.invalid/good',p256dh:'key',auth:'auth'},{endpoint:'https://push.synthetic.invalid/expired',p256dh:'key',auth:'auth'}],removeExpired:async values=>deleted.push(...values)};
const push={setVapidDetails(){},async sendNotification(subscription,message){if(subscription.endpoint.endsWith('expired'))throw {statusCode:410};notifications.push(JSON.parse(message));}};
assert.equal((await sendInvitePush(pushDatabase,{id:duelId,recipient:guest.slug,senderName:host.name},{VAPID_PUBLIC_KEY:'synthetic',VAPID_PRIVATE_KEY:'synthetic'},push)).push,'sent');
assert.equal(notifications[0].url,`/#/simulator?game=yugioh&duel=${duelId}`);
assert.deepEqual(deleted,['https://push.synthetic.invalid/expired']);
assert.equal((await sendInvitePush({subscriptions:async()=>[]},{},env,push)).push,'disabled');
const urls=[];
const metadata=await lookupYugiohMetadata(['12345678','87654321','bad&secret=1'],async url=>{urls.push(url);return {ok:true,json:async()=>({data:[{id:12345678,type:'Link Monster',atk:2000,desc:'Example'},{id:55555555,type:'Effect Monster'}]})};});
assert.equal(urls.length,1); assert(urls[0].endsWith('?id=12345678,87654321')); assert(!urls[0].includes('secret'));
assert.equal(metadata.get('12345678').type,'Link Monster'); assert(!metadata.has('55555555'));
assert.equal((await lookupYugiohMetadata(['12345678'],async()=>{throw Error('offline');})).size,0);
console.log('PASS YGO HTTP authentication/no-store, synthetic push deep link, expired subscription cleanup and bounded public card metadata lookup');
console.log('yugioh-duel-server-smoke: OK (no real account, database or notification)');
