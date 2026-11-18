// SPDX-License-Identifier: AGPL-3.0-or-later
// Genuine off-field effects and procedures using the pinned TCG core/scripts.
// Every graveyard/banished/material state is produced by legal player inputs.
import assert from 'node:assert/strict';
import { createAutoState,applyAutoInput,projectAutoState } from '../api/_yugioh-auto-core.js';
import { loadAutoResources } from '../api/_yugioh-auto-resources.js';
import { AUTO_TCG_LIMITS } from '../api/_yugioh-auto-deck-rules.js';
import { OcgType } from 'ocgcore-wasm';
import { cardView } from '../js/games/yugioh/simulator-arena.js';

const resources = await loadAutoResources(), seed = 'c1435612789abcde'.repeat(4);
const C = { GOLD:75500286,REX:80280944,DARK:56713174,MATRIX:20318029,VEILER:97268402,BREAKER:71413901,ZEPHYROS:14785765,DEALINGS:74117290,GRAPHA:34230233,BROWW:79126789,SANGAN:26202165,JERRY:23635815,LEVIATHAN:69610924,CLOWN:67696066,COWBOY:12014404,DOUBLE:43422537,ALEX:43096270,HOLE:53129443,DESIRES:35261759 };
const base = [...resources.cards.values()].filter(card => card.ot > 0 && card.ot <= 3 && (card.ot & 2) && card.type === (OcgType.MONSTER|OcgType.NORMAL) && card.level <= 4 && card.attack > 0 && !Object.values(C).includes(card.code) && (AUTO_TCG_LIMITS[card.code] ?? 3) === 3).slice(0,40).map(card => card.code);
const clone = value => JSON.parse(JSON.stringify(value));
const promptOf = state => state.publicViews[0].auto.prompt || state.publicViews[1].auto.prompt;
const own = (state,player) => state.publicViews[player].players[player];
const field = (state,player) => own(state,player).monsters.concat(own(state,player).extraMonsters);
const idle = player => state => promptOf(state)?.kind === 'idle' && promptOf(state).player === player;
const has = (state,action,code,location) => promptOf(state).options.some(option => option.action === action && option.card?.code === code && (location === undefined || option.card.location === location));
function handMarkup(state, viewer, owner, card) {
  const session=projectAutoState(state,viewer);
  return cardView({viewer,session,duel:{status:'playing'},revealHand:true,isAuto:()=>true,autoPrompt:()=>session.auto.prompt},card,owner,{hand:true});
}
async function choose(state,choice) { const prompt = promptOf(state); assert(prompt,'Expected an engine prompt'); return applyAutoInput(state,{ viewer:prompt.player,promptId:prompt.id,choice }); }
function defaultChoice(prompt) {
  if (prompt.kind === 'chain') return { optionId:prompt.options.find(option => option.id === 'pass')?.id || prompt.options[0].id };
  if (prompt.kind === 'yes-no') return { optionId:'no' };
  if (prompt.kind === 'toggle') return prompt.canFinish ? { optionId:'finish' } : { optionId:prompt.options.find(option => !option.selected)?.id || prompt.options[0].id };
  if (['select','tribute','place','sort','race','attribute'].includes(prompt.kind)) return { optionIds:prompt.options.slice(0,prompt.min).map(option => option.id) };
  if (prompt.kind === 'position') return { optionId:prompt.options.find(option => option.id === 'position-1')?.id || prompt.options[0].id };
  return { optionId:prompt.options[0]?.id };
}
async function until(state,predicate,respond=defaultChoice) {
  for (let step=0;step<150;step++) {
    if (predicate(state)) return state;
    const prompt=promptOf(state); assert(prompt,`Unexpected terminal result ${JSON.stringify(state.result)}`);
    assert(!['idle','battle'].includes(prompt.kind),`Unexpected prompt ${JSON.stringify(prompt)}`);
    state=await choose(state,respond(prompt,state));
  }
  assert.fail('Exceeded scenario prompt budget');
}
async function command(state,predicate) { const option=promptOf(state).options.find(predicate); assert(option,`Missing command ${JSON.stringify(promptOf(state))}`); return choose(state,{ optionId:option.id }); }
async function play(state,action,code,respond=defaultChoice) { const player=promptOf(state).player; return until(await command(state,option => option.action===action && option.card?.code===code),idle(player),respond); }
async function end(state,player) { return until(await command(state,option => option.id==='to_ep'),idle(player)); }
const reference=await createAutoState({ decks:[{main:base},{main:base}],seed });
const openingPositions=[0,1].map(player => own(reference,player).hand.map(card => base.indexOf(card.code)));
function main(player,codes,deckCards=[]) {
  assert(codes.length<=5);
  const result=[...base]; openingPositions[player].slice(0,codes.length).forEach((position,index) => { result[position]=codes[index]; });
  const available=result.map((_,index)=>index).filter(index=>!openingPositions[player].includes(index));
  deckCards.forEach((code,index) => { result[available[index]]=code; }); return result;
}
async function scenario(codes,guest=[],{ deckCards=[],guestDeckCards=[],extra=[],hostMain }={}) {
  let state=await createAutoState({ decks:[{name:'Off-field A',main:hostMain || main(0,codes,deckCards),extra},{name:'Off-field B',main:main(1,guest,guestDeckCards)}],seed });
  state=await until(state,idle(0));
  for (const code of codes) assert(own(state,0).hand.some(card=>card.code===code),`Missing opening ${code}`);
  return state;
}
function trigger(code,onSelection=()=>null,location) {
  return (prompt,state) => {
    const matches=option=>option.card?.code===code && (location===undefined || option.card.location===location);
    if (prompt.kind==='yes-no' && prompt.options.some(matches)) return {optionId:'yes'};
    if (prompt.kind==='chain') { const option=prompt.options.find(matches); if(option)return {optionId:option.id}; }
    return onSelection(prompt,state) || defaultChoice(prompt);
  };
}
async function check(name,test) { try { await test(); console.log(`PASS ${name}`); } catch(error) { error.message=`${name}: ${error.message}`; throw error; } }

await check('banished Giant Rex trigger starts its own chain and Special Summons from banishment',async()=>{
  let state=await scenario([C.GOLD],[],{deckCards:[C.REX]}); let offered=false;
  state=await play(state,'activate',C.GOLD,trigger(C.REX,prompt=>{
    if (prompt.kind==='select') { const rex=prompt.options.find(option=>option.card?.code===C.REX); if(rex)return {optionIds:[rex.id]}; }
    return null;
  },32));
  offered=state.publicViews[0].log.some(entry=>entry.type==='activate' && entry.text.includes('Giant Rex'));
  assert(offered); assert(field(state,0).some(card=>card.code===C.REX && card.faceUp)); assert(!own(state,0).banished.some(card=>card.code===C.REX));
  assert(state.publicViews[0].auto.lastActivation.location===32,'The activated trigger source is the banished zone');
  assert(state.publicViews[1].players[0].monsters.some(card=>card.code===C.REX));
});

await check('face-down banished Giant Rex cannot trigger and stays unidentified to the opponent',async()=>{
  const ordinary=await scenario([C.DESIRES]);
  const probed=await play(ordinary,'activate',C.DESIRES);
  const removedCode=own(probed,0).banished[0].code;
  const concealedMain=main(0,[C.DESIRES]); concealedMain[base.indexOf(removedCode)]=C.REX;
  let state=await scenario([C.DESIRES],[],{hostMain:concealedMain}); let illegalTrigger=false;
  state=await play(state,'activate',C.DESIRES,(prompt)=>{
    if(prompt.options.some(option=>option.card?.code===C.REX))illegalTrigger=true;
    return defaultChoice(prompt);
  });
  assert(!illegalTrigger); assert(!field(state,0).some(card=>card.code===C.REX));
  assert(own(state,0).banished.some(card=>card.code===C.REX && !card.faceUp));
  const opponent=projectAutoState(state,1);
  assert(opponent.players[0].banished.every(card=>card.hidden && !card.code && !card.catalogCardId));
  assert(!JSON.stringify([opponent.log,opponent.auto.revealedCards]).includes('Giant Rex'));
});

await check('banished Thunder Dragondark search applies its shared once-per-turn name limit across copies',async()=>{
  let state=await scenario([C.GOLD,C.DARK],[],{deckCards:[C.DARK,C.DARK,C.MATRIX]});
  state=await play(state,'activate',C.GOLD,trigger(C.DARK,prompt=>{
    if(prompt.kind==='select') {
      const desired=prompt.options.find(option=>option.card?.code===C.DARK) || prompt.options.find(option=>option.card?.code===C.MATRIX);
      if(desired)return {optionIds:[desired.id]};
    }
    return null;
  },32));
  assert(own(state,0).banished.some(card=>card.code===C.DARK)); assert(own(state,0).hand.some(card=>card.code===C.MATRIX),JSON.stringify({hand:own(state,0).hand.map(card=>card.code),log:state.publicViews[0].log}));
  assert(!has(state,'activate',C.DARK,2),'A second copy in hand cannot use the other effect that same turn');
  state=await command(state,option=>option.id==='to_ep');
  state=await until(state,current=>current.publicViews[0].turn===2 && promptOf(current)?.kind==='chain' && promptOf(current).options.some(option=>option.card?.code===C.DARK));
  const handBefore=own(state,0).hand.length;
  state=await command(state,option=>option.card?.code===C.DARK && option.card.location===2);
  state=await until(state,idle(1),prompt=>{
    if(prompt.kind==='select'){const dark=prompt.options.find(option=>option.card?.code===C.DARK);if(dark)return {optionIds:[dark.id]};}
    return defaultChoice(prompt);
  });
  assert(own(state,0).graveyard.some(card=>card.code===C.DARK)); assert.equal(own(state,0).hand.length,handBefore,'Discard one as cost, add exactly one legal copy');
});

await check('Effect Veiler hand Quick Effect pays cost, targets publicly and negates the summon trigger in Chain 2',async()=>{
  let state=await scenario([C.VEILER],[C.BREAKER]); state=await end(state,1);
  const beforeSummon=clone(state); let veiler=false,twoLinks=false;
  state=await play(state,'summon',C.BREAKER,(prompt,current)=>{
    if(current.publicViews[0].chain.length===2)twoLinks=true;
    if(prompt.kind==='chain' && prompt.player===0){
      const option=prompt.options.find(item=>item.card?.code===C.VEILER);
      if(option){
        veiler=true;assert.equal(option.card.location,2);
        const hand=own(current,0).hand,card=hand.find(card=>card.code===C.VEILER);
        assert.match(handMarkup(current,0,0,card),/has-hand-activation.*effetto attivabile/);
        for(const other of hand.filter(other=>other.id!==card.id))assert.doesNotMatch(handMarkup(current,0,0,other),/has-hand-activation/);
        for(const hidden of current.publicViews[1].players[0].hand)assert.doesNotMatch(handMarkup(current,1,0,hidden),/has-hand-activation|Effect Veiler/);
        return {optionId:option.id};
      }
    }
    if(prompt.kind==='select'){const breaker=prompt.options.find(item=>item.card?.code===C.BREAKER);if(breaker)return {optionIds:[breaker.id]};}
    return defaultChoice(prompt);
  });
  assert(veiler && twoLinks); assert(own(state,0).graveyard.some(card=>card.code===C.VEILER));
  const negated=field(state,1).find(card=>card.code===C.BREAKER); assert.equal(negated.counters,0); assert.equal(negated.atk,1600);
  const unspent=await end(await play(beforeSummon,'summon',C.BREAKER),0);
  assert(own(unspent,0).hand.some(card=>card.code===C.VEILER)); assert(!has(unspent,'activate',C.VEILER),'Veiler is unavailable in its controller\'s own Main Phase');
  assert.doesNotMatch(handMarkup(unspent,0,0,own(unspent,0).hand.find(card=>card.code===C.VEILER)),/has-hand-activation/);
});

await check('Zephyros GY ignition returns a face-up card as cost and its once-per-Duel use survives another turn',async()=>{
  let state=await scenario([C.DEALINGS,C.ZEPHYROS,C.ALEX,C.HOLE]);
  state=await play(state,'activate',C.DEALINGS,prompt=>{
    if(prompt.kind==='select' && prompt.player===0){const card=prompt.options.find(option=>option.card?.code===C.ZEPHYROS);if(card)return {optionIds:[card.id]};}
    return defaultChoice(prompt);
  });
  state=await play(state,'summon',C.ALEX); assert(has(state,'activate',C.ZEPHYROS,16));
  state=await play(state,'activate',C.ZEPHYROS);
  assert(own(state,0).hand.some(card=>card.code===C.ALEX)); assert(field(state,0).some(card=>card.code===C.ZEPHYROS)); assert.equal(own(state,0).lp,7600);
  state=await play(state,'activate',C.HOLE); assert(own(state,0).graveyard.some(card=>card.code===C.ZEPHYROS));
  state=await end(await end(state,1),0);
  state=await play(state,'summon',C.ALEX); assert(!has(state,'activate',C.ZEPHYROS),'A new turn and a new legal return cost do not reset a once-per-Duel effect');
});

await check('Grapha is a non-activating GY Special Summon procedure with an actual Dark World return cost',async()=>{
  let state=await scenario([C.DEALINGS,C.GRAPHA,C.BROWW]);
  state=await play(state,'activate',C.DEALINGS,prompt=>{
    if(prompt.kind==='select' && prompt.player===0){const grapha=prompt.options.find(option=>option.card?.code===C.GRAPHA);if(grapha)return {optionIds:[grapha.id]};}
    return defaultChoice(prompt);
  });
  assert(!has(state,'special-summon',C.GRAPHA),'A Dark World monster on the field is required for the procedure');
  state=await play(state,'summon',C.BROWW); assert(has(state,'special-summon',C.GRAPHA,16));
  const activationsBefore=state.publicViews[0].log.filter(entry=>entry.type==='activate' && entry.text.includes('Grapha')).length;
  state=await play(state,'special-summon',C.GRAPHA);
  assert(field(state,0).some(card=>card.code===C.GRAPHA)); assert(own(state,0).hand.some(card=>card.code===C.BROWW));
  assert(!own(state,0).graveyard.some(card=>card.code===C.GRAPHA));
  assert.equal(state.publicViews[0].log.filter(entry=>entry.type==='activate' && entry.text.includes('Grapha')).length,activationsBefore,'The summon procedure does not create an activation chain');
});

await check('detaching Sangan does not satisfy sent-from-field-to-GY and does not search',async()=>{
  let state=await scenario([C.DOUBLE,C.SANGAN,C.JERRY],[],{extra:[C.LEVIATHAN]});
  state=await play(state,'activate',C.DOUBLE); state=await play(state,'summon',C.SANGAN); state=await play(state,'summon',C.JERRY); state=await play(state,'special-summon',C.LEVIATHAN);
  assert.equal(field(state,0).find(card=>card.code===C.LEVIATHAN).materials.length,2);
  const beforeHand=own(state,0).hand.length; let sanganTriggered=false;
  state=await play(state,'activate',C.LEVIATHAN,(prompt)=>{
    if(['chain','yes-no'].includes(prompt.kind) && prompt.options.some(option=>option.card?.code===C.SANGAN))sanganTriggered=true;
    if(prompt.kind==='select'){const sangan=prompt.options.find(option=>option.card?.code===C.SANGAN);if(sangan)return {optionIds:[sangan.id]};}
    return defaultChoice(prompt);
  });
  assert(!sanganTriggered); assert.equal(own(state,0).hand.length,beforeHand); assert(own(state,0).graveyard.some(card=>card.code===C.SANGAN));
  assert.equal(field(state,0).find(card=>card.code===C.LEVIATHAN).atk,2500);
  assert.equal(field(state,0).find(card=>card.code===C.LEVIATHAN).materials.length,1);
});

await check('detached Trick Clown does trigger from GY, revives at 0/0 with damage and cannot trigger twice after moving',async()=>{
  let state=await scenario([C.DOUBLE,C.CLOWN,C.ALEX,C.HOLE],[],{extra:[C.COWBOY]});
  state=await play(state,'activate',C.DOUBLE); state=await play(state,'summon',C.CLOWN); state=await play(state,'summon',C.ALEX);
  state=await play(state,'special-summon',C.COWBOY,prompt=>prompt.kind==='position'?{optionId:'position-4'}:defaultChoice(prompt));
  state=await play(state,'activate',C.COWBOY,trigger(C.CLOWN,prompt=>{
    if(prompt.kind==='select'){const clown=prompt.options.find(option=>option.card?.code===C.CLOWN);if(clown)return {optionIds:[clown.id]};}
    return null;
  }));
  const revived=field(state,0).find(card=>card.code===C.CLOWN); assert(revived); assert.equal(revived.atk,0); assert.equal(revived.def,0);
  assert.equal(own(state,0).lp,7000); assert.equal(own(state,1).lp,7200);
  let secondTrigger=false;
  state=await play(state,'activate',C.HOLE,prompt=>{
    if(['chain','yes-no'].includes(prompt.kind) && prompt.options.some(option=>option.card?.code===C.CLOWN))secondTrigger=true;
    return defaultChoice(prompt);
  });
  assert(!secondTrigger); assert.equal(field(state,0).length,0); assert(own(state,0).graveyard.some(card=>card.code===C.CLOWN)); assert.equal(own(state,0).lp,7000);
});

console.log('yugioh-auto-offfield-smoke: OK (real pinned core, legal TCG inputs, no prefilled zones or runtime network)');
