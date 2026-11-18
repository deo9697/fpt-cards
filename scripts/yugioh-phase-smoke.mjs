import assert from 'node:assert/strict';
import {createSession,applyAction,validateSession} from '../js/games/yugioh/simulator-engine.js';

const deck={id:'phase-fixture',game:'yugioh',name:'Synthetic phase deck',cards:Array.from({length:14},(_,index)=>({catalogCardId:`phase-${index}`,cardName:`Phase monster ${index}`,section:'main',quantity:index===13?1:3,type:'Effect Monster',level:4,atk:1000,def:1000}))};
const table=createSession({decks:[deck,deck],names:["Alice","Bob"],autoPhases:false});
const act=(state,type,fields={})=>applyAction(state,{type,player:state.activePlayer,...fields});
function rejected(state,action,pattern){const before=structuredClone(state);assert.throws(()=>applyAction(state,action),pattern);assert.deepEqual(state,before);}
assert.throws(()=>applyAction(table,{type:'setPhase',player:0,phase:'main1'}),/pronti/);
let state=act(table,'start'),players=structuredClone(state.players);
rejected(state,{type:'setPhase',player:0,phase:'main1'},/fase|Standby/i);
state=act(state,'nextPhase');assert.equal(state.phase,'standby');
rejected(state,{type:'setPhase',player:0,phase:'draw'},/fase|Phase|indietro/i);
state=act(state,'setPhase',{phase:'main1'});assert.equal(state.phase,'main1');
assert.deepEqual(state.players,players,'Phase changes never draw or resolve effects implicitly');
for(const phase of ['battle','main2'])rejected(state,{type:'setPhase',player:0,phase},/primo|fase|Battle/i);
state=act(state,'nextPhase');assert.equal(state.phase,'end','The first turn skips Battle and Main Phase 2');
state=act(state,'nextPhase');assert.equal(state.turn,2);assert.equal(state.activePlayer,1);assert.equal(state.phase,'draw');
rejected(state,{type:'nextPhase',player:1},/pesca/i);
rejected(state,{type:'nextTurn',player:1},/pesca|Draw|fase/i);
state=act(state,'draw');assert.equal(state.players[1].hand.length,6);
state=act(state,'nextPhase');state=act(state,'nextPhase');assert.equal(state.phase,'main1');
rejected(state,{type:'setPhase',player:1,phase:'main2'},/Battle|fase/i);
state=act(state,'setPhase',{phase:'battle'});state=act(state,'nextPhase');assert.equal(state.phase,'main2');
state=act(state,'nextPhase');assert.equal(state.phase,'end');
state=act(state,'nextTurn');assert.equal(state.turn,3);assert.equal(state.activePlayer,0);assert.equal(state.phase,'draw');
for(const phase of [undefined,null,'setup','main3','Draw',0,{},['draw']])rejected(state,{type:'setPhase',player:0,phase},/Fase di gioco|fase/i);
rejected(state,{type:'setPhase',player:1,phase:'standby'},/giocatore attivo/i);
assert.deepEqual(validateSession(state),{valid:true,errors:[]});
console.log('PASS ordered phases, mandatory draw, skipped first Battle/Main 2 and active-player controls');

let legacy=act(createSession({decks:[deck,deck],turnRules:false}),'start');
const legacyPlayers=structuredClone(legacy.players);
for(const phase of ['main1','battle','main2','end','draw','standby']){legacy=act(legacy,'setPhase',{phase});assert.equal(legacy.phase,phase);assert.deepEqual(legacy.players,legacyPlayers);}
legacy=act(legacy,'setPhase',{phase:'end'});legacy=act(legacy,'nextPhase');assert.equal(legacy.turn,2);assert.equal(legacy.activePlayer,1);
console.log('PASS old manual sessions retain direct phase declarations without implicit actions');
console.log('yugioh-phase-smoke: OK');
