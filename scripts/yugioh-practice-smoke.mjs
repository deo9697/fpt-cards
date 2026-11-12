import assert from 'node:assert/strict';
import {createPracticeTable} from '../js/games/yugioh/simulator-practice.js';
import {YugiohMultiplayer} from '../js/games/yugioh/simulator-multiplayer.js';

const deck={id:'a0000000-0000-4000-8000-000000000001',ownerSlug:'synthetic-host',name:'Saved practice deck',game:'yugioh',persisted:true,cards:Array.from({length:14},(_,i)=>({catalogCardId:String(10000000+i),cardName:`Monster ${i}`,type:'Normal Monster',section:'main',quantity:i===13?1:3,atk:1800,def:1000}))};
const original=JSON.stringify(deck),table=createPracticeTable({deck,name:'Solo tester'});
let duel=table.snapshot();
assert.equal(duel.status,'playing');assert.equal(duel.state.phase,'main1');assert.equal(duel.state.players[0].hand.length,5);
assert(duel.state.players[0].deck.every(card=>card.hidden));assert(duel.state.players[1].hand.every(card=>card.hidden));
const action=payload=>{const response=table.run({op:'action',duelId:duel.id,expectedVersion:duel.version,action:payload});duel=response.duel;return duel;};
action({type:'draw',player:0});assert.equal(duel.state.players[0].hand.length,6);
const card=duel.state.players[0].hand[0];action({type:'move',player:0,cardId:card.id,to:'monsters',slot:4,faceUp:true,position:'attack'});
assert.equal(duel.state.players[0].monsters[0].slot,4);
action({type:'nextTurn',player:0});assert.equal(duel.state.activePlayer,0);assert.equal(duel.state.turn,3);
const before=JSON.stringify(duel);
assert.throws(()=>action({type:'lp',player:1,delta:-1000}),/soltanto/);
assert.throws(()=>table.run({op:'action',duelId:duel.id,expectedVersion:duel.version-1,action:{type:'draw'}}),/cambiato/);
assert.equal(JSON.stringify(table.snapshot()),before);
assert.throws(()=>table.run({op:'invite'}),/non disponibile/);
assert.throws(()=>table.run({op:'inspect',zone:'deck',player:1}),/soltanto/);
const cards=table.run({op:'inspect',zone:'deck'}).cards;assert(cards.every(card=>card.catalogCardId&&!card.hidden));
const id=duel.id;duel=table.restart().duel;assert.equal(duel.id,id);assert.equal(duel.state.players[0].hand.length,5);assert.equal(duel.state.players[0].monsters.length,0);
assert.equal(JSON.stringify(deck),original,'A test must never change the saved deck');
console.log('PASS solo table integrity, passive opponent, deck inspection, skipped turns and restart');

const calls=[];const instance=new YugiohMultiplayer({getContext:()=>({member:'synthetic-host',team:'synthetic-team',allowed:true}),getDecks:()=>[deck,{...deck,id:'a0000000-0000-4000-8000-000000000002',ownerSlug:'someone-else'}],getMembers:()=>[],verifyAccess:async()=>true,loadDecks:async()=>{},lookupCard:async()=>null,onRender:()=>{},onToast:()=>{},confirm:async()=>true,call:async payload=>{calls.push(payload);return{deck:JSON.parse(original)};}});
instance.ready=true;
try{
  await instance.startPractice('a0000000-0000-4000-8000-000000000002');assert.equal(calls.length,0);assert.equal(instance.practice,false);
  await instance.startPractice(deck.id);assert.equal(instance.practice,true);assert.deepEqual(calls.map(call=>call.op),['practice']);
  await instance.act({type:'draw',player:0});assert.equal(instance.session.players[0].hand.length,6);assert.equal(calls.length,1,'Solo moves must never use the multiplayer API');
  await instance.click({dataset:{ygoCommand:'practice-restart'},hasAttribute:()=>false});assert.equal(instance.session.players[0].hand.length,5);
  instance.showPractice();assert.equal(instance.practice,false);assert.equal(instance.session,null);assert.equal(instance.tab,'practice');
  console.log('PASS owned saved-deck selection, read-only preparation and local-only practice commands');
}finally{instance.reset();}
console.log('yugioh-practice-smoke: OK');
