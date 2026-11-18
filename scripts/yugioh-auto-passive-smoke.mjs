// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import {OcgMessageType as M,OcgOpCode as OP} from 'ocgcore-wasm';
import {choosePassiveChoice,PASSIVE_POLICY_VERSION} from '../api/_yugioh-auto-passive.js';
import {normalizePrompt,resolveChoice} from '../api/_yugioh-auto-prompts.js';
import {createAutoState,applyAutoInput,projectAutoState} from '../api/_yugioh-auto-core.js';
import {loadAutoResources} from '../api/_yugioh-auto-resources.js';
import {AUTO_TCG_LIMITS} from '../api/_yugioh-auto-deck-rules.js';
import {runAutoOperation} from '../api/_yugioh-auto-executor.js';

// Protocol fixtures exercise every supported decision family. They do not
// simulate card effects; genuine core games below verify the replay lifecycle.
const card=(extra={})=>({code:101,controller:1,location:4,sequence:0,position:1,...extra});
const cards=new Map([[101,{code:101,name:'WATER fixture',ot:3,type:17,alias:0,race:1n,attribute:2,setcodes:[]}],[102,{code:102,name:'FIRE fixture',ot:3,type:17,alias:0,race:2n,attribute:4,setcodes:[]}]]);
const ctx={cards,strings:new Map()},single={player:1};
const families=[
  {...single,type:M.SELECT_IDLECMD,summons:[card()],activates:[card()],to_ep:true,to_bp:true},
  {...single,type:M.SELECT_BATTLECMD,chains:[card()],attacks:[card()],to_ep:true,to_m2:true},
  {...single,...card(),type:M.SELECT_EFFECTYN,description:0n},
  {...single,type:M.SELECT_YESNO,description:0n},
  {...single,type:M.SELECT_OPTION,options:[0n,1n]},
  {...single,type:M.SELECT_CARD,can_cancel:false,min:1,max:2,selects:[card(),card({code:102})]},
  {...single,type:M.SELECT_TRIBUTE,can_cancel:false,min:2,max:2,selects:[card({release_param:1}),card({code:102,release_param:2})]},
  {...single,type:M.SELECT_SUM,select_max:0,amount:8,min:1,max:2,selects_must:[card({amount:2})],selects:[card({amount:4|(6<<16)}),card({code:102,amount:2})]},
  {...single,type:M.SELECT_UNSELECT_CARD,can_finish:true,can_cancel:false,min:1,max:2,select_cards:[card()],unselect_cards:[card({code:102})]},
  {...single,type:M.SELECT_CHAIN,forced:false,selects:[card({description:0n})]},
  {...single,type:M.SELECT_PLACE,count:1,field_mask:(0xffffffff^1)>>>0},
  {...single,type:M.SELECT_DISFIELD,count:1,field_mask:(0xffffffff^1)>>>0},
  {...single,type:M.SELECT_POSITION,code:101,positions:5},
  {...single,type:M.SELECT_COUNTER,count:4,counter_type:1,cards:[card({count:2}),card({code:102,count:3})]},
  {...single,type:M.SORT_CARD,cards:[card(),card({code:102})]},
  {...single,type:M.SORT_CHAIN,cards:[card(),card({code:102})]},
  {...single,type:M.ANNOUNCE_RACE,count:1,available:3n},
  {...single,type:M.ANNOUNCE_ATTRIB,count:1,available:6},
  {...single,type:M.ANNOUNCE_CARD,opcodes:[2n,OP.ISATTRIBUTE]},
  {...single,type:M.ANNOUNCE_NUMBER,options:[20n,40n]},
  {...single,type:M.ROCK_PAPER_SCISSORS}
];
for(const message of families){const choice=choosePassiveChoice(message,ctx);assert.deepEqual(choice,choosePassiveChoice(message,ctx));assert.doesNotThrow(()=>resolveChoice(message,choice,ctx));}
assert.equal(families.length,21);
assert.deepEqual(choosePassiveChoice(families[0],ctx),{optionId:'to_ep'});
assert.deepEqual(choosePassiveChoice(families[9],ctx),{optionId:'pass'});
assert.deepEqual(choosePassiveChoice({...families[9],forced:true},ctx),{optionId:'chain-0'});
assert.equal(choosePassiveChoice(families[6],ctx).optionIds.length,1,'One double Tribute is the minimal mandatory payment');
assert.deepEqual(choosePassiveChoice(families[7],ctx),{optionIds:['card-0']},'Alternate Level 6 plus mandatory Level 2');
assert.deepEqual(choosePassiveChoice({...families[5],can_cancel:true},ctx),{cancel:true});
assert.deepEqual(choosePassiveChoice({...families[8],can_finish:false,can_cancel:false},ctx),{optionId:'select-0'});
const minimumSum={...families[7],select_max:1,amount:5,min:0,max:0,selects_must:[],selects:[card({amount:4}),card({amount:3}),card({amount:1})]};
const chosenMinimum=choosePassiveChoice(minimumSum,ctx);assert.equal(chosenMinimum.optionIds.length,2);assert.doesNotThrow(()=>resolveChoice(minimumSum,chosenMinimum,ctx));
assert.deepEqual(choosePassiveChoice({...minimumSum,amount:0,selects:[]},ctx),{optionIds:[]});
const signedSum={...minimumSum,amount:2,selects:[card({amount:0x80000001}),card({amount:2})]};
assert.deepEqual(choosePassiveChoice(signedSum,ctx),{optionIds:['card-1']});
const trailingZero={...families[7],amount:4,min:2,max:2,selects_must:[],selects:[card({amount:4}),card({amount:0}),card({amount:2}),card({amount:2})]};
assert.deepEqual(choosePassiveChoice(trailingZero,ctx),{optionIds:['card-2','card-3']},'An invalid exhausted-target/zero candidate must not stop the subset search');
assert.deepEqual(choosePassiveChoice({...families[7],amount:6,selects_must:[card({amount:2|(4<<16)})],selects:[card({amount:2})]},ctx),{optionIds:['card-0']});
assert.throws(()=>choosePassiveChoice({...families[7],amount:99},ctx),error=>error.status===503&&error.code==='passive_choice_unavailable');
assert.throws(()=>choosePassiveChoice({...families[0],player:0},ctx),error=>error.status===503);
console.log('PASS passive-v1 validates deterministic choices for all 21 prompt families, forced effects, alternate-Level sums and minimal mandatory selections');

const resources=await loadAutoResources(),seed='e1435612789abcde'.repeat(4),DEALINGS=74117290,BROWW=79126789,EXODIA=[33396948,7902349,70903634,44519536,8124921];
const base=[...resources.cards.values()].filter(card=>card.ot>0&&card.ot<=3&&(card.ot&2)&&card.type===17&&card.level<=4&&card.attack>0&&!EXODIA.includes(card.code)&&(AUTO_TCG_LIMITS[card.code]??3)===3).slice(0,40).map(card=>card.code);
const initial=await createAutoState({decks:[{main:base},{main:base}],seed});
const own=(state,player)=>state.publicViews[player].players[player];
const promptOf=state=>state.publicViews[0].auto.prompt||state.publicViews[1].auto.prompt;
const clone=value=>JSON.parse(JSON.stringify(value));
function opening(player,codes){const deck=[...base];own(initial,player).hand.slice(0,codes.length).forEach((card,index)=>{deck[base.indexOf(card.code)]=codes[index];});return deck;}
const options={decks:[{name:'Personal legal deck',main:base},{name:'Mirrored passive deck',main:base}],seed,passivePlayer:1};
const userChoice=prompt=>prompt.kind==='chain'?{optionId:prompt.options.find(option=>option.id==='pass')?.id||prompt.options[0].id}:prompt.kind==='yes-no'?{optionId:'no'}:['select','place','sort','tribute'].includes(prompt.kind)?{optionIds:prompt.options.slice(0,prompt.min).map(option=>option.id)}:{optionId:prompt.options.find(option=>option.id==='to_ep')?.id||prompt.options[0].id};
async function choose(state,choice){const prompt=promptOf(state);assert(prompt);assert.equal(prompt.player,0,'The practice service must never have to expose the passive actor prompt');return applyAutoInput(state,{viewer:0,promptId:prompt.id,choice});}
async function settle(state){for(let index=0;index<100;index++){const prompt=promptOf(state);if(state.result||prompt?.kind==='idle')return state;state=await choose(state,userChoice(prompt));}assert.fail('User response budget exceeded');}
let state=await createAutoState(options);assert.equal(state.passivePolicy,PASSIVE_POLICY_VERSION);
for(let round=0;round<5;round++){
  state=await settle(await choose(state,{optionId:'to_ep'}));
  assert.equal(state.publicViews[0].activePlayer,0);assert.equal(promptOf(state).player,0);assert.equal(state.publicViews[0].turn,3+round*2);
  assert(own(state,1).hand.length<=6,'Passive compulsory End Phase discard is applied');assert.equal(own(state,1).monsters.length,0,'Passive policy does not voluntarily summon');
}
assert(state.inputs.some(input=>input.viewer===1));assert(own(state,1).graveyard.length>0);
const before=clone(state),nextA=await choose(state,{optionId:'to_ep'}),nextB=await choose(before,{optionId:'to_ep'});
assert.deepEqual(nextA,nextB,'Automatically appended choices replay identically from JSON state');
const projection=projectAutoState(nextA,0);assert(projection.players[1].hand.every(card=>card.hidden));for(const key of ['passivePolicy','passivePlayer','seed','inputs','initialDecks'])assert(!Object.hasOwn(projection,key));
console.log('PASS actual passive turns, standard draws, compulsory discards, no voluntary summons, transcript persistence and deterministic JSON replay');

const deal=async passiveDeck=>{
  let current=await createAutoState({...options,decks:[{main:opening(0,[DEALINGS])},{main:passiveDeck}]});
  const activation=promptOf(current).options.find(option=>option.action==='activate'&&option.card?.code===DEALINGS);assert(activation);
  return settle(await choose(current,{optionId:activation.id}));
};
const discardProbe=await deal(base),discarded=own(discardProbe,1).graveyard[0].code;
const forcedDeck=base.map(code=>code===discarded?BROWW:code);
state=await deal(forcedDeck);
assert(own(state,1).graveyard.some(card=>card.code===BROWW),'The passive player pays the real discard choice');
assert(state.publicViews[0].log.some(entry=>entry.player===1&&entry.type==='activate'&&entry.text.includes('Broww')),'A mandatory passive GY trigger is activated');
assert(state.publicViews[0].log.some(entry=>entry.player===1&&entry.type==='draw'&&entry.text==='Pesca 2 carta/e'),'Opponent-caused Broww discard resolves the actual draw-two effect');
assert.equal(promptOf(state).player,0);assert.equal(promptOf(state).kind,'idle');
console.log('PASS genuine Dark World Dealings passive discard and compulsory Broww GY effect/correct draw-two');

const pvp=await createAutoState({...options,passivePlayer:undefined});
const pvpPrompt=promptOf(pvp),pvpNext=await applyAutoInput(pvp,{viewer:0,promptId:pvpPrompt.id,choice:{optionId:'to_ep'}});
assert.equal(promptOf(pvpNext).player,1);assert(!Object.hasOwn(pvpNext,'passivePolicy'));
await assert.rejects(()=>createAutoState({...options,passivePlayer:0}),error=>error.code==='invalid_passive_setup');
await assert.rejects(()=>createAutoState({...options,passivePolicy:'unknown'}),error=>error.code==='invalid_passive_setup');
const invalid=clone(state);invalid.passivePolicy='passive-next';
await assert.rejects(()=>choose(invalid,{optionId:'to_ep'}),error=>error.code==='passive_policy_changed'&&error.status===409);
const exodia=await createAutoState({...options,decks:[{main:base},{main:opening(1,EXODIA)}]});
assert.equal(exodia.result.winner,1,'Standard opening Exodia remains a real passive-seat win');
assert.equal(promptOf(exodia),null);
const worker=await runAutoOperation('createPractice',{decks:[{main:base},{main:base}],seed});
assert.equal(worker.passivePolicy,'passive-v1');assert.equal(promptOf(worker).player,0);
console.log('PASS PvP unchanged, internal-seat/pinned-policy guards, standard passive Exodia and actual createPractice worker');
console.log('yugioh-auto-passive-smoke: OK (21 protocol families plus actual legal TCG games, no runtime network)');
