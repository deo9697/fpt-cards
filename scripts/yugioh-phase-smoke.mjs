import assert from 'node:assert/strict';
import {createSession,applyAction,validateSession,PHASES} from '../js/games/yugioh/simulator-engine.js';

const deck={id:'phase-fixture',game:'yugioh',name:'Synthetic phase deck',cards:Array.from({length:14},(_,index)=>({
  catalogCardId:`phase-monster-${index}`,cardName:`Phase monster ${index}`,section:'main',quantity:index===13?1:3,type:'Effect Monster',atk:1000,def:1000
}))};
const table=createSession({decks:[deck,deck],firstPlayer:0,names:['Alice','Bob']});
assert.throws(()=>applyAction(table,{type:'setPhase',player:0,phase:'main1'}),/pronti/);
let state=applyAction(table,{type:'start'});
const players=structuredClone(state.players);
// Direct changes may skip and revisit phases on a manual table. They must not
// perform an implicit Draw or hand control to the other player.
for(const phase of ['main1','battle','main2','end','draw','standby']){
  const before=structuredClone(state);
  state=applyAction(state,{type:'setPhase',player:0,phase});
  assert.equal(state.phase,phase);
  assert.equal(state.turn,1);
  assert.equal(state.activePlayer,0);
  assert.deepEqual(state.players,players);
  assert.deepEqual(state.chain,before.chain);
  assert.deepEqual(validateSession(state),{valid:true,errors:[]});
  assert.equal(before.log.length+1,state.log.length);
  assert.equal(state.log.at(-1).type,'setPhase');
  assert.equal(state.log.at(-1).player,0);
  assert(state.log.at(-1).text.includes(phase));
}
console.log('PASS direct phase selection preserves cards, turn, player and unresolved effects');

for(const phase of [undefined,null,'setup','main3','Draw',0,{},['draw']]){
  const before=structuredClone(state);
  assert.throws(()=>applyAction(state,{type:'setPhase',player:0,phase}),/Fase di gioco/);
  assert.deepEqual(state,before,'An invalid phase must leave the original state intact');
}
const before=structuredClone(state);
assert.throws(()=>applyAction(state,{type:'setPhase',player:1,phase:'battle'}),/giocatore attivo/);
assert.deepEqual(state,before);
console.log('PASS invalid phases and inactive-player changes are rejected without mutations');

state=applyAction(state,{type:'setPhase',player:0,phase:'main1'});
state=applyAction(state,{type:'nextPhase',player:0});
assert.equal(state.phase,PHASES[PHASES.indexOf('main1')+1]);
state=applyAction(state,{type:'setPhase',player:0,phase:'end'});
state=applyAction(state,{type:'nextPhase',player:0});
assert.equal(state.turn,2);assert.equal(state.activePlayer,1);assert.equal(state.phase,'draw');
assert.deepEqual(state.players,players);
assert.throws(()=>applyAction(state,{type:'setPhase',player:0,phase:'main1'}),/giocatore attivo/);
state=applyAction(state,{type:'setPhase',player:1,phase:'main2'});
state=applyAction(state,{type:'nextTurn',player:1});
assert.equal(state.turn,3);assert.equal(state.activePlayer,0);assert.equal(state.phase,'draw');
state=applyAction(state,{type:'finish',player:0,winner:0});
assert.throws(()=>applyAction(state,{type:'setPhase',player:0,phase:'draw'}),/concluso/);
console.log('PASS sequential phase and turn controls still work after direct selection');
console.log('yugioh-phase-smoke: OK');
