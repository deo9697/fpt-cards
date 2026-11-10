import assert from 'node:assert/strict';
import { YugiohMultiplayer } from '../js/games/yugioh/simulator-multiplayer.js';
import { createSession, applyAction } from '../js/games/yugioh/simulator-engine.js';
import { redactState } from '../api/_yugioh-duel-service.js';
import { cardView } from '../js/games/yugioh/simulator-arena.js';

const deck={id:'a0000000-0000-4000-8000-000000000001',name:'Synthetic YGO deck',game:'yugioh',cards:Array.from({length:14},(_,i)=>({catalogCardId:String(10000000+i),cardName:`Private monster ${i}`,type:'Normal Monster',section:'main',quantity:i===13?1:3,atk:1800,def:1000}))};
const full=applyAction(createSession({decks:[deck,deck]}),{type:'start'});
const id='b0000000-0000-4000-8000-000000000001';
const snapshot=version=>({id,status:'playing',version,viewer:0,ready:[true,true],state:redactState(full,0)});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const button=dataset=>({dataset,hasAttribute:name=>Object.hasOwn(dataset,name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase()))});
const controllers=[];
function controller(call){
  const context={member:'synthetic-host',team:'synthetic-team',allowed:true};
  const instance=new YugiohMultiplayer({getContext:()=>({...context}),getDecks:()=>[],getMembers:()=>[],call,onRender:()=>{},onToast:()=>{},confirm:async()=>true,verifyAccess:async()=>true,loadDecks:async()=>{},lookupCard:async()=>null});
  instance.ready=true;instance.lastLobby=Date.now();instance.receive(snapshot(1));controllers.push(instance);return{instance,context};
}
try{
  const old=deferred(),{instance:current}=controller(async()=>old.promise);
  const poll=current.poll();current.receive(snapshot(2));old.resolve({duel:snapshot(1)});await poll;
  assert.equal(current.duel.version,2,'Delayed polls cannot undo an accepted action');
  console.log('PASS delayed polling cannot roll back the duel');

  const late=deferred(),{instance:navigation}=controller(async payload=>payload.op==='lobby'?{members:[],duels:[]}:late.promise);
  const pending=navigation.poll();navigation.menu=true;await navigation.click(button({ygoCommand:'lobby'}));late.resolve({duel:snapshot(1)});await pending;
  assert.equal(navigation.duel,null);assert.equal(navigation.menu,false);
  console.log('PASS leaving the duel invalidates responses and dialogs');

  const inspection=deferred(),{instance:privacy}=controller(async()=>inspection.promise);
  const inspect=privacy.inspectDeck();await privacy.click(button({ygoCommand:'close-pile'}));
  inspection.resolve({duel:snapshot(1),version:1,cards:full.players[0].deck});await inspect;
  assert.equal(privacy.pile,null,'A closed private inspection must not reopen from a delayed response');
  assert.equal(privacy.inspectedCard,null);
  console.log('PASS private deck inspections respect close and version guards');

  const{instance:updatedInspection}=controller(async()=>({duel:snapshot(2),version:2,cards:full.players[0].deck}));
  await updatedInspection.inspectDeck();
  assert.equal(updatedInspection.duel.version,2);
  assert.deepEqual(updatedInspection.pile?.cards,full.players[0].deck,'Inspecting after an opponent move must open the current private deck without requiring a retry');
  console.log('PASS current private inspection may advance a stale table version');

  let calls=0;const{instance:ownership}=controller(async()=>{calls++;return{};});
  await ownership.act({type:'lp',player:1,delta:-1000});
  assert.equal(calls,0);assert.match(ownership.error,/soltanto/);
  assert.equal(ownership.canControl(1),false);
  assert(ownership.session.players[1].hand.every(card=>card.hidden&&!card.catalogCardId));
  console.log('PASS opponent commands stay blocked and hidden hands remain redacted');

  const{instance:positions}=controller(async()=>({}));
  let board=applyAction(full,{type:'move',player:0,cardId:full.players[0].hand[0].id,to:'monsters',slot:0,position:'attack',faceUp:true});
  positions.receive({...snapshot(2),state:redactState(board,0)});
  const monster=positions.session.players[0].monsters[0];
  positions.selected={player:0,cardId:monster.id};
  let dispatched;
  positions.options.call=async payload=>{dispatched=payload.action;board=applyAction(board,payload.action);return{duel:{...snapshot(3),state:redactState(board,0)}};};
  await positions.click(button({ygoAction:'flip',player:'0'}));
  assert.equal(dispatched.type,'setPosition');assert.equal(dispatched.position,'defense');assert.equal(dispatched.faceUp,false);
  const facedown=positions.session.players[0].monsters[0];
  assert.equal(facedown.position,'defense');assert.equal(facedown.faceUp,false);
  assert(cardView(positions,facedown,0,{board:true}).includes('yugioh-duel-card-back.jpg'),'Own set monsters show a card back on the board');
  positions.selected={player:0,cardId:facedown.id};assert.equal(positions.selectedCard().card.cardName,facedown.cardName,'The owner may still inspect their set card');
  console.log('PASS covering an attack monster sets it in Defense and preserves owner inspection');

  const{instance:quiet}=controller(async payload=>{assert.equal(payload.knownVersion,1);return{unchanged:true,version:1};});
  const original=quiet.session;quiet.menu=true;await quiet.poll();assert.equal(quiet.session,original);assert.equal(quiet.menu,true);
  const{instance:revoked}=controller(async()=>{throw Object.assign(new Error('Accesso scaduto'),{status:403});});
  await revoked.poll();assert.equal(revoked.session,null);assert.equal(revoked.ready,false);
  const{instance:scoped,context}=controller(async()=>({}));context.member='another-member';assert.equal(scoped.allowed(),false);
  console.log('PASS unchanged polling, revoked access and member changes preserve private boundaries');

  const{instance:finished}=controller(async()=>({}));finished.menu=true;finished.receive({...snapshot(2),status:'finished'});
  assert.equal(finished.canControl(0),false);assert.equal(finished.canControl(1),false);
  finished.receive({...snapshot(3),id:'b0000000-0000-4000-8000-000000000002'});assert.equal(finished.menu,false);assert.equal(finished.finishDraft.notes,'');
  console.log('PASS finished tables are read-only and new duels clear dialog state');
  console.log('yugioh-duel-client-smoke: OK');
}finally{controllers.forEach(instance=>instance.reset());}
