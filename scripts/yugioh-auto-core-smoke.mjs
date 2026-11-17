// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {createAutoState,applyAutoInput,projectAutoState,AUTO_RULES_PROFILE} from '../api/_yugioh-auto-core.js';
import {loadAutoResources} from '../api/_yugioh-auto-resources.js';
import {OcgType} from 'ocgcore-wasm';

const resources=await loadAutoResources();
const SEED='123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0';
const RAIGEKI=12580477,REBORN=83764718,JUDGMENT=41420027;
const normal=[...resources.cards.values()].filter(card=>(card.ot&2)&&card.type===(OcgType.MONSTER|OcgType.NORMAL)&&card.level<=4&&card.attack>0).slice(0,40).map(card=>card.code);
assert.equal(normal.length,40);
const setup={decks:[{name:'Automatic fixture A',main:normal},{name:'Automatic fixture B',main:normal}],seed:SEED,names:['Alice','Bob']};
const initial=await createAutoState(setup);
// Determine the deterministic shuffle permutation, then put ordinary official
// cards in those opening slots. No test-only duel flags or scripted outcomes.
function arrange(seat,codes){const deck=[...normal];initial.publicViews[seat].players[seat].hand.slice(0,codes.length).forEach((card,index)=>deck[normal.indexOf(Number(card.catalogCardId))]=codes[index]);return deck;}
const p0=arrange(0,[RAIGEKI,REBORN]);
const p1=arrange(1,[JUDGMENT]);
const getPrompt=state=>state.publicViews[0].auto.prompt||state.publicViews[1].auto.prompt;
const ownPlayer=(state,seat)=>state.publicViews[seat].players[seat];
const choose=async(state,choice)=>{const prompt=getPrompt(state);assert.ok(prompt,'expected a live core prompt');return applyAutoInput(state,{viewer:prompt.player,promptId:prompt.id,choice});};
function defaultChoice(prompt){
  if(prompt.kind==='chain')return {optionId:prompt.options.find(option=>option.id==='pass')?.id||prompt.options[0].id};
  if(prompt.kind==='yes-no')return {optionId:'no'};
  if(['select','tribute','sum','place','sort','race','attribute'].includes(prompt.kind))return {optionIds:prompt.options.slice(0,prompt.min||1).map(option=>option.id)};
  if(prompt.kind==='position')return {optionId:prompt.options.find(option=>option.id==='position-1')?.id||prompt.options[0].id};
  return {optionId:prompt.options[0]?.id};
}
async function until(state,predicate,respond=defaultChoice){
  for(let step=0;step<100;step++){
    if(predicate(state))return state;
    const prompt=getPrompt(state);assert.ok(prompt,`duel ended before expected condition (${step})`);
    assert.notEqual(prompt.kind,'idle',`unexpected idle prompt: ${JSON.stringify(prompt)}`);
    state=await choose(state,respond(prompt,state));
  }
  assert.fail('core did not reach the expected prompt');
}
const idleFor=seat=>state=>getPrompt(state)?.kind==='idle'&&getPrompt(state).player===seat;
async function command(state,predicate){const option=getPrompt(state).options.find(predicate);assert.ok(option,`missing command: ${JSON.stringify(getPrompt(state))}`);return choose(state,{optionId:option.id});}
async function endTurn(state,seat){state=await command(state,option=>option.id==='to_ep');return until(state,idleFor(seat));}
async function summon(state,seat){state=await command(state,option=>option.action==='summon');return until(state,idleFor(seat));}

let state=await createAutoState({...setup,decks:[{main:p0},{main:normal}]});
assert.equal(state.publicViews[0].turn,1);assert.equal(state.publicViews[0].phase,'main1');
assert.equal(AUTO_RULES_PROFILE.format,'tcg');
assert.ok(ownPlayer(state,0).hand.some(card=>card.code===RAIGEKI));assert.ok(ownPlayer(state,0).hand.some(card=>card.code===REBORN));
assert.equal(ownPlayer(state,0).deck.length,35);
assert.ok(state.publicViews[0].players[1].hand.every(card=>card.hidden&&!card.code&&!card.catalogCardId));
assert.equal(state.publicViews[1].auto.prompt,null);
for(const viewer of [0,1]){
  const publicState=projectAutoState(state,viewer);
  for(const key of ['seed','initialDecks','inputs','pendingMessage','pendingPromptId','publicViews'])assert.equal(Object.hasOwn(publicState,key),false,`${key} leaked`);
  assert.ok(publicState.players.every(player=>player.deck.every(card=>card.hidden&&!card.code)));
}
const original=JSON.stringify(state),prompt=getPrompt(state),choice={optionId:'to_ep'};
await assert.rejects(()=>applyAutoInput(state,{viewer:1,promptId:prompt.id,choice}),/richiesta|giocatore/);
await assert.rejects(()=>applyAutoInput(state,{viewer:0,promptId:'old',choice}),/richiesta/);
await assert.rejects(()=>applyAutoInput(state,{viewer:0,promptId:prompt.id,choice:{optionId:'summons-999'}}));
assert.equal(JSON.stringify(state),original,'rejected inputs must not mutate state');
const nextA=await applyAutoInput(state,{viewer:0,promptId:prompt.id,choice});
const nextB=await applyAutoInput(JSON.parse(original),{viewer:0,promptId:prompt.id,choice});
assert.deepEqual(nextA,nextB,'JSON round-trip/replay must be deterministic');
state=await until(nextA,idleFor(1));
assert.equal(ownPlayer(state,1).hand.length,6,'normal turn draw comes from core');
state=await summon(state,1);const target=ownPlayer(state,1).monsters[0].code;
state=await endTurn(state,0);
state=await command(state,option=>option.action==='activate'&&option.card.code===RAIGEKI);
let sawRaigeki=false;
state=await until(state,idleFor(0),(prompt,current)=>{
  if(current.publicViews[0].chain.some(link=>link.card.code===RAIGEKI)){
    sawRaigeki=true;assert.equal(current.publicViews[0].chain[0].number,1);assert.deepEqual(current.publicViews[0].chain,current.publicViews[1].chain);
  }
  return defaultChoice(prompt);
});
assert.ok(sawRaigeki||state.publicViews[0].auto.lastActivation?.card.code===RAIGEKI);
assert.equal(ownPlayer(state,1).monsters.length,0,'Raigeki must destroy the opposing monster without a manual outcome');
assert.ok(ownPlayer(state,1).graveyard.some(card=>card.code===target));
assert.ok(ownPlayer(state,0).graveyard.some(card=>card.code===RAIGEKI));
state=await command(state,option=>option.action==='activate'&&option.card.code===REBORN);
let sawTarget=false,sawPosition=false;
state=await until(state,idleFor(0),(prompt)=>{
  if(prompt.kind==='select'){sawTarget=true;return {optionIds:[prompt.options.find(option=>option.card.code===target).id]};}
  if(prompt.kind==='position'){sawPosition=true;return {optionId:prompt.options.find(option=>option.id==='position-4')?.id||prompt.options[0].id};}
  return defaultChoice(prompt);
});
assert.ok(sawTarget,'Monster Reborn must ask for a legal graveyard target');assert.ok(sawPosition,'Monster Reborn must ask for summon position');
assert.ok(ownPlayer(state,0).monsters.some(card=>card.code===target&&card.position==='defense'));
assert.equal(ownPlayer(state,1).graveyard.some(card=>card.code===target),false);
assert.ok(ownPlayer(state,0).graveyard.some(card=>card.code===REBORN));

// A real counter-trap pays its own cost, creates chain link 2, negates link 1
// and leaves the monster alive. Both clients see the same public chain cards.
state=await createAutoState({...setup,decks:[{main:p0},{main:p1}]});
state=await endTurn(state,1);
state=await summon(state,1);
state=await command(state,option=>option.action==='spell-set'&&option.card.code===JUDGMENT);
state=await until(state,idleFor(1));
assert.ok(state.publicViews[0].players[1].spells.every(card=>card.hidden&&!card.code));
state=await endTurn(state,0);
state=await command(state,option=>option.action==='activate'&&option.card.code===RAIGEKI);
let sawTwo=false,responded=false;
state=await until(state,idleFor(0),(prompt,current)=>{
  const response=prompt.kind==='chain'&&prompt.player===1&&prompt.options.find(option=>option.card?.code===JUDGMENT);
  if(response){responded=true;return {optionId:response.id};}
  if(current.publicViews[0].chain.length===2){sawTwo=true;assert.deepEqual(current.publicViews[0].chain,current.publicViews[1].chain);assert.deepEqual(current.publicViews[0].chain.map(link=>link.number),[1,2]);}
  return defaultChoice(prompt);
});
assert.ok(responded,'Solemn Judgment must be offered in the legal response window');
assert.ok(sawTwo||state.publicViews[0].log.some(entry=>entry.text.includes('Catena 2')));
assert.equal(ownPlayer(state,1).lp,4000,'counter-trap half-LP cost is authoritative');
assert.equal(ownPlayer(state,1).monsters.length,1,'negated Raigeki must not destroy the monster');
assert.ok(state.publicViews[0].log.some(entry=>entry.text==='Catena 1 negata'));
assert.ok(ownPlayer(state,0).graveyard.some(card=>card.code===RAIGEKI));
assert.ok(ownPlayer(state,1).graveyard.some(card=>card.code===JUDGMENT));

const reversed=await createAutoState({...setup,firstPlayer:1});
assert.equal(reversed.publicViews[0].activePlayer,1);assert.equal(reversed.publicViews[0].auto.prompt,null);assert.equal(reversed.publicViews[1].auto.prompt.player,1);
const reversedSummon=await summon(reversed,1);assert.equal(ownPlayer(reversedSummon,1).monsters[0].controller,1);
assert.ok(reversedSummon.publicViews[0].players[1].monsters[0].faceUp);
await assert.rejects(()=>createAutoState({...setup,decks:[{main:[...normal.slice(0,39),999999999]},{main:normal}]}),/non presente/);
await assert.rejects(()=>createAutoState({...setup,decks:[{main:normal.slice(0,39)},{main:normal}]}),/40/);
console.log('Yu-Gi-Oh! actual WASM core smoke passed: deterministic replay/privacy, real TCG turns/draws/summons, Raigeki, Monster Reborn target+Defense, Solemn Judgment chain/cost/negation, reversed starting player.');
