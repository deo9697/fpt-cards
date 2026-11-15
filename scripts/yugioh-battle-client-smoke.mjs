import assert from 'node:assert/strict';
import {createSession,applyAction} from '../js/games/yugioh/simulator-engine.js';
import {YugiohMultiplayer} from '../js/games/yugioh/simulator-multiplayer.js';
import {redactState} from '../api/_yugioh-duel-service.js';
import {createPracticeTable} from '../js/games/yugioh/simulator-practice.js';

const deck={id:'a0000000-0000-4000-8000-000000000001',game:'yugioh',name:'Synthetic battle client',cards:Array.from({length:14},(_,i)=>({catalogCardId:`battle-client-${i}`,cardName:`Synthetic battle ${i}`,section:'main',quantity:i===13?1:3,type:'Effect Monster',level:i===13?5:4,atk:2000,def:1000}))};
let state=createSession({decks:[deck,deck]}),version=1;
const mutate=action=>{state=applyAction(state,action);version++;};
mutate({type:'start'});mutate({type:'nextPhase',player:0});mutate({type:'nextPhase',player:0});mutate({type:'nextTurn',player:0});
mutate({type:'draw',player:1});mutate({type:'nextPhase',player:1});mutate({type:'nextPhase',player:1});mutate({type:'nextTurn',player:1});
mutate({type:'draw',player:0});mutate({type:'nextPhase',player:0});mutate({type:'nextPhase',player:0});mutate({type:'setPhase',player:0,phase:'battle'});
const attacker=state.players[0].hand[0],defender=state.players[1].hand[0];
mutate({type:'move',player:0,cardId:attacker.id,to:'monsters',slot:0,position:'attack',faceUp:true});
mutate({type:'move',player:1,cardId:defender.id,to:'monsters',slot:1,position:'defense',faceUp:false});
const calls=[],id='b0000000-0000-4000-8000-000000000001',snapshot=()=>({id,version,viewer:0,status:state.result?'finished':'playing',state:redactState(state,0)});
const saved=new Map(),listeners=new Map();
for(const key of ['innerWidth','innerHeight','navigator','matchMedia','addEventListener','removeEventListener'])saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'Synthetic Mobile'}});
Object.assign(globalThis,{innerWidth:844,innerHeight:390,matchMedia:query=>({matches:query==='(pointer: coarse)'}),addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)});
const controller=new YugiohMultiplayer({getContext:()=>({allowed:true,team:'synthetic-team',member:'host'}),getDecks:()=>[],getMembers:()=>[],onRender:()=>{},onToast:()=>{},call:async payload=>{calls.push(payload);mutate(payload.action);return{duel:snapshot()};}});
controller.ready=true;controller.receive(snapshot());
const button=dataset=>({dataset,hasAttribute:name=>Object.hasOwn(dataset,name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase()))});
try{
  controller.selectCard(0,attacker.id,{quick:true});assert(controller.dropMenu.actions.some(action=>action.id==='attack'&&!action.disabled));
  await controller.applyDropAction('attack');assert(controller.attackSelection);assert.equal(calls.length,0);
  const choosing=controller.view();assert(choosing.includes('data-ygo-battle-target'));assert(!choosing.includes(`Attacca ${defender.cardName}`));
  await controller.click(button({ygoCommand:'cancel-attack-selection'}));assert.equal(controller.attackSelection,null);assert.equal(calls.length,0);assert.equal(state.players[0].monsters[0].attackedTurn,undefined);
  controller.beginAttack(attacker.id);mutate({type:'drawEffect',player:1});controller.receive(snapshot());
  assert.equal(controller.attackSelection,null);await controller.chooseAttackTarget({zone:'monsters',slot:1});assert.equal(calls.length,0);
  controller.beginAttack(attacker.id);await controller.click(button({ygoBattleTarget:'',player:'1',zone:'monsters',slot:'1'}));
  assert.equal(calls.length,1);assert.deepEqual(calls[0].action.target,{zone:'monsters',slot:1});assert(!JSON.stringify(calls[0]).includes(defender.id));assert.equal(state.players[1].monsters[0].faceUp,false);
  assert(controller.view().includes('ygo-battle-controls'));
  mutate({type:'battlePass',player:1});controller.receive(snapshot());await controller.act({type:'battlePass',player:0});
  assert.equal(state.battle.stage,'damage');assert.equal(state.players[1].monsters[0].faceUp,true);
  const form={matches:selector=>selector==='[data-ygo-stats]'};
  const OriginalFormData=globalThis.FormData;
  try{
    controller.selectCard(0,attacker.id);
    globalThis.FormData=class{get(name){return{mode:'value',stat:'atk',delta:'2300'}[name]??null;}};
    await controller.submit(form);assert.equal(calls.at(-1).action.value,2300);assert.equal(calls.at(-1).action.delta,undefined);assert.equal(state.players[0].monsters[0].atkOverride,2300);
  }finally{globalThis.FormData=OriginalFormData;}
  await controller.act({type:'battlePass',player:0});mutate({type:'battlePass',player:1});controller.receive(snapshot());
  assert.equal(state.battle,null);assert(state.players[1].graveyard.some(card=>card.id===defender.id));assert.equal(state.players[1].lp,8000);
  controller.selectCard(0,attacker.id,{quick:true});assert(controller.dropMenu.actions.find(action=>action.id==='attack').disabled);
  console.log('PASS deferred/public-coordinate target selection, cancellation, stale state, hidden defender, absolute statistics and shared battle outcome');

  await controller.orientation.enter();
  controller.rulesDialog={kind:'tribute',cardId:state.players[0].hand[0].id,tributeIds:[],version,duelId:id};controller.selected={player:0,cardId:state.players[0].hand[0].id};controller.placing={zones:['monsters']};
  globalThis.innerWidth=390;globalThis.innerHeight=844;listeners.get('resize')?.();await new Promise(resolve=>setTimeout(resolve,0));
  assert(controller.orientation.isPortraitBlocked());assert.equal(controller.rulesDialog,null);assert.equal(controller.selected,null);assert.equal(controller.placing,null);
  globalThis.innerWidth=844;globalThis.innerHeight=390;listeners.get('resize')?.();await new Promise(resolve=>setTimeout(resolve,0));
  assert(!controller.orientation.isPortraitBlocked());
  controller.attackSelection={cardId:attacker.id,replay:false,duelId:id,version};
  globalThis.innerWidth=390;globalThis.innerHeight=844;listeners.get('resize')?.();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(controller.attackSelection,null);
  console.log('PASS rotating to portrait clears both selection and dependent dialogs without leaving a broken draft');
}finally{
  controller.reset();
  for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
}
{
  const table=createPracticeTable({deck});let duel=table.snapshot();
  const act=action=>{duel=table.run({op:'action',duelId:duel.id,expectedVersion:duel.version,action}).duel;};
  const card=duel.state.players[0].hand[0];act({type:'move',cardId:card.id,to:'monsters',slot:0,faceUp:true,position:'attack'});
  act({type:'nextTurn'});act({type:'draw'});act({type:'nextPhase'});act({type:'nextPhase'});act({type:'setPhase',phase:'battle'});
  act({type:'declareAttack',cardId:card.id,target:null});assert.equal(duel.state.battle.passes,1);
  act({type:'battlePass'});assert.equal(duel.state.battle.stage,'damage');
  act({type:'battleManual'});assert.equal(duel.state.battle,null);assert(duel.state.lastBattle.summary.includes('manualmente'));
  assert.equal(duel.state.players[1].lp,8000);assert.equal(duel.state.players[0].monsters[0].attackedTurn,duel.state.turn);
  console.log('PASS passive practice agrees to manual battle outcomes without applying standard damage or freeing the attack');
}
console.log('yugioh-battle-client-smoke: OK');
