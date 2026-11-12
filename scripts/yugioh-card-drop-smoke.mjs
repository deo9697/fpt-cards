import assert from 'node:assert/strict';
import {cardDropActions} from '../js/games/yugioh/simulator-card-actions.js';
import {createSession,applyAction} from '../js/games/yugioh/simulator-engine.js';
import {YugiohMultiplayer} from '../js/games/yugioh/simulator-multiplayer.js';
import {redactState} from '../api/_yugioh-duel-service.js';

const monster={type:'Effect Monster',faceUp:true,position:'attack'},spell={type:'Spell Card',faceUp:false,position:'attack'},link={type:'Link Monster',faceUp:false,position:'attack'};
assert.deepEqual(cardDropActions(monster,'hand','monsters').map(action=>action.id),['normal','special','set']);
assert.deepEqual(cardDropActions(link,'extra','extraMonsters').map(action=>action.id),['special']);
assert.deepEqual(cardDropActions(spell,'hand','monsters'),[]);
assert(cardDropActions(spell,'spells','spells',{samePosition:true}).find(action=>action.id==='activate').changes.activateOnly);
assert(cardDropActions(monster,'hand','deck').some(action=>action.id==='bottom'));
console.log('PASS contextual choices respect card kinds, locations, Link positions and in-place activations');

const deck={id:'a0000000-0000-4000-8000-000000000001',game:'yugioh',name:'Synthetic deck',cards:Array.from({length:14},(_,i)=>({catalogCardId:String(10000000+i),cardName:`Hidden monster ${i}`,section:'main',type:'Normal Monster',quantity:i===13?1:3,atk:1800,def:1000}))};
let full=applyAction(createSession({decks:[deck,deck]}),{type:'start'}),version=1;
const id='b0000000-0000-4000-8000-000000000001',calls=[];
const snapshot=()=>({id,status:'playing',viewer:0,version,ready:[true,true],state:redactState(full,0)});
const controller=new YugiohMultiplayer({getContext:()=>({member:'host',team:'team',allowed:true}),getDecks:()=>[],onRender:()=>{},getMembers:()=>[],onToast:()=>{},confirm:async()=>true,call:async payload=>{calls.push(payload);full=applyAction(full,payload.action);version++;return{duel:snapshot()};}});
controller.ready=true;controller.receive(snapshot());
try{
  const card=controller.session.players[0].hand[0];
  controller.showDropMenu({cardId:card.id,player:0,zone:'monsters',slot:2,x:100,y:100});
  assert.equal(calls.length,0,'Dropping must not play a card before its action is chosen');
  assert.equal(controller.session.players[0].monsters.length,0);
  assert(controller.view().includes('class="ygo-drop-menu"'));
  assert(!controller.view().includes('class="ygo-card-dialog"'),'The contextual flow must not open the large details dialog');
  await controller.click({dataset:{ygoCommand:'close-drop-menu'},hasAttribute:()=>false});
  assert.equal(controller.dropMenu,null);assert.equal(calls.length,0);
  controller.showDropMenu({cardId:card.id,player:0,zone:'monsters',slot:2,x:100,y:100});
  full=applyAction(full,{type:'draw',player:1});version++;controller.receive(snapshot());
  assert.equal(controller.dropMenu,null,'An opponent update must invalidate the previous action menu');
  await controller.applyDropAction('normal');assert.equal(calls.length,0);
  controller.showDropMenu({cardId:card.id,player:0,zone:'monsters',slot:2,x:100,y:100});
  await controller.applyDropAction('normal');
  assert.equal(calls.length,1);assert.equal(calls[0].action.intent,'normal');
  assert.equal(controller.session.players[0].monsters[0].slot,2);
  assert.equal(controller.selected,null);assert.equal(controller.dropMenu,null);
  assert.match(full.log.at(-1).text,/evoca normalmente/);
  const hidden=controller.session.players[0].hand.find(item=>item.cardName!==card.cardName);
  controller.showDropMenu({cardId:hidden.id,player:0,zone:'monsters',slot:1,x:100,y:100});await controller.applyDropAction('set');
  assert.equal(full.players[0].monsters.find(item=>item.id===hidden.id).faceUp,false);
  assert(!full.log.at(-1).text.includes(hidden.cardName),'The Set declaration must not reveal a private card identity');
  console.log('PASS deferred play, cancellation, stale-menu rejection, declared Normal Summon and private Set');
}finally{controller.reset();}
console.log('yugioh-card-drop-smoke: OK');
