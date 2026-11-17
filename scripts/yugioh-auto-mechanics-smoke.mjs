// SPDX-License-Identifier: AGPL-3.0-or-later
// Real legal TCG decks and typed player choices only. No field edits, test flags,
// pre-filled graveyards, alternate effects or mocked responses from the engine.
import assert from 'node:assert/strict';
import {createAutoState,applyAutoInput} from '../api/_yugioh-auto-core.js';
import {loadAutoResources} from '../api/_yugioh-auto-resources.js';
import {OcgType,OcgMessageType as M} from 'ocgcore-wasm';

const resources=await loadAutoResources(),seed='f0435612789abcde'.repeat(4);
const base=[...resources.cards.values()].filter(card=>card.ot>=1&&card.ot<=3&&(card.ot&2)&&card.type===(OcgType.MONSTER|OcgType.NORMAL)&&card.level<=4&&card.attack>0).slice(0,40).map(card=>card.code);
const C={RITUAL:41426869,RELINQUISHED:64631466,SKULL:70781052,MAGICIAN:46986414,DOUBLE:43422537,ALEX:43096270,FISH:23771716,JERRY:23635815,TUNER:21615956,STARDUST:44508094,POLY:24094653,AVIAN:21844576,FLAME:35809262,COWBOY:12014404,LINK:98978921,BREAKER:71413901,HIGH:51531505,LOW:15146890,FLASH:17390179,MOKEY:27288416,BLUE:89631139,RAIGEKI:12580477,MST:5318639,RUSH:70046172,TROOPER:85087012,ASH:14558127,UPSTART:70368879,VOID:93946239,SPEAR:31553716,MARSH:31305911,HAYABUSA:21015833,COMPULSE:94192409,JUDGMENT:41420027,PROTO:26439287,PHOENIX:3370104,FORTRESS:79229522,GROUND:90502999,SANGAN:26202165,WITCH:78010363,REDMD:88264978,LUSTER:11091375};
const promptOf=state=>state.publicViews[0].auto.prompt||state.publicViews[1].auto.prompt;
const own=(state,seat)=>state.publicViews[seat].players[seat];
const field=(state,seat)=>own(state,seat).monsters.concat(own(state,seat).extraMonsters);
const idle=seat=>state=>promptOf(state)?.kind==='idle'&&promptOf(state)?.player===seat;
const battle=state=>promptOf(state)?.kind==='battle';
const has=(state,action,code)=>promptOf(state).options.some(option=>option.action===action&&option.card?.code===code);
async function choose(state,choice){const prompt=promptOf(state);assert.ok(prompt,'Expected a live engine prompt');return applyAutoInput(state,{viewer:prompt.player,promptId:prompt.id,choice});}
function sumChoice(prompt){
  const mandatory=(prompt.mandatory||[]).reduce((sum,option)=>sum+(option.contributions?.[0]||0),0);
  const search=(index,sum,ids,amounts)=>{
    const minimal=!amounts.length||sum-Math.min(...amounts)<prompt.amount;
    if(ids.length>=prompt.min&&ids.length<=prompt.max&&(prompt.sumMode==='at-least-minimal'?sum>=prompt.amount&&minimal:sum===prompt.amount))return ids;
    if(index>=prompt.options.length||ids.length>=prompt.max)return null;
    for(const contribution of prompt.options[index].contributions||[0]){const found=search(index+1,sum+contribution,[...ids,prompt.options[index].id],[...amounts,contribution]);if(found)return found;}
    return search(index+1,sum,ids,amounts);
  };const ids=search(0,mandatory,[],[]);assert.ok(ids,JSON.stringify(prompt));return{optionIds:ids};
}
function defaultChoice(prompt){
  if(prompt.kind==='chain')return{optionId:prompt.options.find(option=>option.id==='pass')?.id||prompt.options[0].id};
  if(prompt.kind==='yes-no')return{optionId:'no'};
  if(prompt.kind==='toggle')return prompt.canFinish?{optionId:'finish'}:{optionId:prompt.options.find(option=>!option.selected)?.id||prompt.options[0].id};
  if(prompt.kind==='sum')return sumChoice(prompt);
  if(prompt.kind==='tribute'){let amount=0;const selected=[];for(const option of prompt.options){selected.push(option.id);amount+=option.contribution||1;if(selected.length>=prompt.min&&amount>=prompt.requiredContribution)break;}return{optionIds:selected};}
  if(['select','place','sort','race','attribute'].includes(prompt.kind))return{optionIds:prompt.options.slice(0,prompt.min).map(option=>option.id)};
  if(prompt.kind==='position')return{optionId:prompt.options.find(option=>option.id==='position-1')?.id||prompt.options[0].id};
  return{optionId:prompt.options[0]?.id};
}
async function until(state,predicate,respond=defaultChoice){for(let step=0;step<150;step++){if(predicate(state))return state;const prompt=promptOf(state);assert.ok(prompt,`Duel ended at step ${step}`);assert.ok(!['idle','battle'].includes(prompt.kind),`Unexpected ${prompt.kind}: ${JSON.stringify(prompt)}`);state=await choose(state,respond(prompt,state));}assert.fail('Exceeded fixture prompt budget');}
async function command(state,predicate){const prompt=promptOf(state),option=prompt.options.find(predicate);assert.ok(option,`Missing command ${JSON.stringify(prompt)}`);return choose(state,{optionId:option.id});}
async function play(state,action,code,respond=defaultChoice){const seat=promptOf(state).player;return until(await command(state,option=>option.action===action&&option.card?.code===code),idle(seat),respond);}
async function end(state,target){return until(await command(state,option=>option.id==='to_ep'),idle(target));}
async function round(state,seat=0){return end(await end(state,1-seat),seat);}
async function enterBattle(state){return until(await command(state,option=>option.id==='to_bp'),battle);}
async function attack(state,code,respond=defaultChoice){return until(await command(state,option=>option.action==='attack'&&option.card?.code===code),battle,respond);}
const initial=await createAutoState({decks:[{main:base},{main:base}],seed});
function opening(seat,codes){assert.ok(codes.length<=5);const cards=[...base];own(initial,seat).hand.slice(0,codes.length).forEach((card,index)=>{cards[base.indexOf(card.code)]=codes[index];});return cards;}
async function scenario(codes,extra=[],guest=[]){const state=await createAutoState({decks:[{name:'Mechanics A',main:opening(0,codes),extra},{name:'Mechanics B',main:opening(1,guest)}],seed});for(const code of codes)assert.ok(own(state,0).hand.some(card=>card.code===code),`Opening missing ${code}`);return state;}
async function check(name,test){try{await test();console.log(`PASS ${name}`);}catch(error){error.message=`${name}: ${error.message}`;throw error;}}

await check('Ritual Summon: matching Ritual Spell/monster and real hand Tribute',async()=>{
  let state=await scenario([C.RITUAL,C.RELINQUISHED,C.ALEX]);let paid=false;
  state=await play(state,'activate',C.RITUAL,prompt=>{if(['sum','tribute','select'].includes(prompt.kind)){const material=prompt.options.find(option=>option.card?.code===C.ALEX);if(material){paid=true;return{optionIds:[material.id]};}const ritual=prompt.options.find(option=>option.card?.code===C.RELINQUISHED);if(ritual)return{optionIds:[ritual.id]};}return defaultChoice(prompt);});
  assert.ok(paid);assert.ok(field(state,0).some(card=>card.code===C.RELINQUISHED));assert.ok(own(state,0).graveyard.some(card=>card.code===C.ALEX));assert.ok(own(state,0).graveyard.some(card=>card.code===C.RITUAL));assert.ok(!own(state,0).hand.some(card=>card.code===C.RELINQUISHED));
  const impossible=await scenario([C.RITUAL,C.ALEX]);assert.ok(!has(impossible,'activate',C.RITUAL),'Ritual Spell cannot activate without the matching Ritual Monster');
});

await check('Normal Summon/Set shared quota and one-/two-Tribute Level requirements',async()=>{
  let state=await scenario([C.SKULL,C.ALEX,C.FISH]);assert.ok(!has(state,'summon',C.SKULL));assert.ok(!promptOf(state).options.some(option=>option.id==='to_bp'),'first-turn Battle Phase is forbidden');
  state=await play(state,'summon',C.ALEX);assert.ok(!has(state,'summon',C.FISH));assert.ok(!has(state,'monster-set',C.FISH));assert.ok(!has(state,'position',C.ALEX),'no position change in the summon turn');
  state=await round(state);assert.ok(has(state,'summon',C.SKULL));state=await play(state,'summon',C.SKULL);assert.ok(field(state,0).some(card=>card.code===C.SKULL));assert.ok(own(state,0).graveyard.some(card=>card.code===C.ALEX));assert.equal(field(state,0).length,1);
  state=await scenario([C.DOUBLE,C.MAGICIAN,C.ALEX,C.FISH]);state=await play(state,'activate',C.DOUBLE);state=await play(state,'summon',C.ALEX);assert.ok(!has(state,'summon',C.MAGICIAN),'Level 7 cannot use just one Tribute');state=await play(state,'summon',C.FISH);state=await round(state);let tributeCount=0;
  state=await play(state,'summon',C.MAGICIAN,prompt=>{const response=defaultChoice(prompt);if(prompt.kind==='tribute')tributeCount=response.optionIds.length;return response;});assert.equal(tributeCount,2);assert.ok(field(state,0).some(card=>card.code===C.MAGICIAN));assert.ok([C.ALEX,C.FISH].every(code=>own(state,0).graveyard.some(card=>card.code===code)));
});

await check('Set/Flip Summon and once-per-turn battle-position limits/reset',async()=>{
  let state=await scenario([C.ALEX,C.FISH]);state=await play(state,'monster-set',C.FISH);assert.ok(!has(state,'summon',C.ALEX));assert.ok(!has(state,'position',C.FISH));assert.equal(own(state,0).monsters[0].position,'defense');assert.ok(state.publicViews[1].players[0].monsters[0].hidden);
  state=await round(state);assert.ok(has(state,'position',C.FISH));state=await play(state,'position',C.FISH);assert.equal(own(state,0).monsters[0].position,'attack');assert.equal(own(state,0).monsters[0].faceUp,true);assert.ok(!has(state,'position',C.FISH));
  state=await round(state);assert.ok(has(state,'position',C.FISH));state=await play(state,'position',C.FISH);assert.equal(own(state,0).monsters[0].position,'defense');assert.ok(!has(state,'position',C.FISH));
});

await check('Fusion/Synchro/Xyz/Link reject missing materials, Tuner, Levels and Normal type',async()=>{
  let state=await scenario([C.POLY,C.AVIAN,C.ALEX],[C.FLAME]);assert.ok(!has(state,'activate',C.POLY),'Fusion lacks the second named material');
  state=await scenario([C.DOUBLE,C.ALEX,C.FISH],[C.STARDUST]);state=await play(state,'activate',C.DOUBLE);state=await play(state,'summon',C.ALEX);state=await play(state,'summon',C.FISH);assert.ok(!has(state,'special-summon',C.STARDUST),'8 total Levels without a Tuner is not Synchro eligible');
  state=await scenario([C.DOUBLE,C.TUNER,C.FISH],[C.STARDUST]);state=await play(state,'activate',C.DOUBLE);state=await play(state,'summon',C.TUNER);state=await play(state,'summon',C.FISH);assert.ok(!has(state,'special-summon',C.STARDUST),'Tuner plus incorrect total Level is forbidden');
  state=await scenario([C.DOUBLE,C.ALEX,C.JERRY],[C.COWBOY]);state=await play(state,'activate',C.DOUBLE);state=await play(state,'summon',C.ALEX);state=await play(state,'summon',C.JERRY);assert.ok(!has(state,'special-summon',C.COWBOY),'Level 4 and Level 3 cannot make a Rank 4 Xyz');
  state=await scenario([C.BREAKER],[C.LINK]);state=await play(state,'summon',C.BREAKER);assert.ok(!has(state,'special-summon',C.LINK),'Link Spider requires a Normal Monster');
});
await check('Contact Fusion uses a live name change and sends actual field materials to the GY',async()=>{
  let state=await scenario([C.DOUBLE,C.PROTO,C.PHOENIX],[C.FORTRESS]);state=await play(state,'activate',C.DOUBLE);state=await play(state,'summon',C.PROTO);assert.ok(!has(state,'special-summon',C.FORTRESS),'Contact Fusion still needs another Machine material');state=await play(state,'summon',C.PHOENIX);assert.ok(has(state,'special-summon',C.FORTRESS));state=await play(state,'special-summon',C.FORTRESS);const fusion=field(state,0).find(card=>card.code===C.FORTRESS);assert.ok(fusion);assert.equal(fusion.atk,2000);assert.ok([C.PROTO,C.PHOENIX].every(code=>own(state,0).graveyard.some(card=>card.code===code)));assert.equal(field(state,0).length,1);
});

async function selectPendulum(state,code,onPrompt=()=>{}){
  state=await command(state,option=>option.action==='special-summon');return until(state,idle(0),prompt=>{onPrompt(prompt);if(prompt.kind==='toggle'){const selected=prompt.options.find(option=>!option.selected&&option.card?.code===code);if(selected)return{optionId:selected.id};return{optionId:'finish'};}if(prompt.kind==='select'){const selected=prompt.options.find(option=>option.card?.code===code);if(selected)return{optionIds:[selected.id]};}return defaultChoice(prompt);});
}
await check('Pendulum strict scale bounds and once-per-turn Summon',async()=>{
  for(const excluded of [C.MOKEY,C.BLUE]){let state=await scenario([C.HIGH,C.LOW,C.FLASH,excluded]);state=await play(state,'activate',C.HIGH);state=await play(state,'activate',C.LOW);let candidates=false;state=await selectPendulum(state,C.FLASH,prompt=>{if(['select','toggle'].includes(prompt.kind)){candidates=true;assert.ok(!prompt.options.some(option=>option.card?.code===excluded),'Scale endpoints are not legal Levels');}});assert.ok(candidates);assert.ok(field(state,0).some(card=>card.code===C.FLASH));assert.ok(!promptOf(state).options.some(option=>option.action==='special-summon'),'second Pendulum Summon is forbidden while eligible ordinary monsters remain in hand');}
});
await check('Face-up Extra Pendulum uses a linked Main Monster Zone and Link is Attack-only',async()=>{
  let state=await scenario([C.HIGH,C.LOW,C.FLASH],[C.LINK]);state=await play(state,'summon',C.FLASH);state=await play(state,'special-summon',C.LINK,prompt=>{if(prompt.kind==='position')assert.deepEqual(prompt.options.map(option=>option.id),['position-1']);return defaultChoice(prompt);});
  const link=own(state,0).extraMonsters.find(card=>card.code===C.LINK);assert.ok(link);assert.equal(link.position,'attack');assert.ok(own(state,0).extra.some(card=>card.code===C.FLASH&&card.faceUp),'Pendulum Link material goes face-up to Extra Deck');state=await play(state,'activate',C.HIGH);state=await play(state,'activate',C.LOW);let sawPlace=false;
  state=await selectPendulum(state,C.FLASH,prompt=>{if(prompt.kind==='place'){sawPlace=true;assert.ok(prompt.options.every(option=>option.place.player===0&&option.place.location===4&&option.place.sequence===1),'the downward Link Spider arrow permits only its linked Main Monster Zone');}});assert.ok(sawPlace);assert.ok(own(state,0).monsters.some(card=>card.code===C.FLASH&&card.slot===1));assert.equal(own(state,0).extraMonsters.length,1);assert.ok(!has(state,'position',C.LINK),'Link Monsters cannot switch into Defense');
});
await check('Face-up Extra Pendulum without a Link must use an Extra Monster Zone',async()=>{
  let state=await scenario([C.HIGH,C.LOW,C.FLASH],[],[C.RAIGEKI]);state=await play(state,'activate',C.HIGH);state=await play(state,'activate',C.LOW);state=await play(state,'summon',C.FLASH);state=await end(state,1);state=await play(state,'activate',C.RAIGEKI);assert.ok(own(state,0).extra.some(card=>card.code===C.FLASH&&card.faceUp));state=await end(state,0);let sawPlace=false;
  state=await selectPendulum(state,C.FLASH,prompt=>{if(prompt.kind==='place'){sawPlace=true;assert.ok(prompt.options.every(option=>option.place.player===0&&option.place.location===4&&[5,6].includes(option.place.sequence)),'unlinked Main Monster Zones cannot receive face-up Extra Pendulum Monsters');}});assert.ok(sawPlace);assert.ok(own(state,0).extraMonsters.some(card=>card.code===C.FLASH));
});

await check('Set Quick-Play delay, opponent-turn hand prohibition and reverse chain resolution',async()=>{
  let state=await scenario([C.ALEX,C.RUSH,C.MST],[],[C.RAIGEKI]);state=await play(state,'summon',C.ALEX);state=await play(state,'spell-set',C.RUSH);assert.ok(!has(state,'activate',C.RUSH),'set Quick-Play cannot activate in the same turn');state=await end(state,1);state=await command(state,option=>option.action==='activate'&&option.card?.code===C.RAIGEKI);let rushResponse=false;
  state=await until(state,idle(1),(prompt,current)=>{if(prompt.kind==='chain'&&prompt.player===0){assert.ok(!prompt.options.some(option=>option.card?.code===C.MST),'Quick-Play in hand is unavailable during the opponent turn');const rush=prompt.options.find(option=>option.card?.code===C.RUSH);if(rush){rushResponse=true;return{optionId:rush.id};}}return defaultChoice(prompt);});assert.ok(rushResponse,'set Quick-Play may respond in the next turn');assert.equal(field(state,0).length,0);const resolved=state.publicViews[0].log.filter(entry=>entry.text.startsWith('Risolve catena ')).map(entry=>entry.text);assert.deepEqual(resolved.slice(-2),['Risolve catena 2','Risolve catena 1'],'chain resolves from highest to lowest');
});
await check('Normal Spell can activate in its set turn; Spell Speed 2 cannot answer a Counter Trap',async()=>{
  let state=await scenario([C.UPSTART]);state=await play(state,'spell-set',C.UPSTART);assert.ok(has(state,'activate',C.UPSTART));state=await play(state,'activate',C.UPSTART);assert.equal(own(state,1).lp,9000);assert.equal(own(state,0).hand.length,5,'Upstart resolves a real draw after being set');
  state=await scenario([C.RAIGEKI,C.RUSH,C.ALEX],[],[C.JUDGMENT,C.FISH]);state=await play(state,'summon',C.ALEX);state=await end(state,1);state=await play(state,'summon',C.FISH);state=await play(state,'spell-set',C.JUDGMENT);state=await end(state,0);assert.ok(has(state,'activate',C.RUSH),'the Quick-Play is otherwise legal in this turn');state=await command(state,option=>option.action==='activate'&&option.card?.code===C.RAIGEKI);let counterChosen=false;
  state=await until(state,idle(0),(prompt,current)=>{if(prompt.kind==='chain'&&prompt.player===1){const counter=prompt.options.find(option=>option.card?.code===C.JUDGMENT);if(counter){counterChosen=true;return{optionId:counter.id};}}if(counterChosen&&prompt.kind==='chain'&&prompt.player===0&&current.publicViews[0].chain.some(link=>link.card?.code===C.JUDGMENT&&link.status==='pending'))assert.ok(!prompt.options.some(option=>option.card?.code===C.RUSH),'Speed 2 must not respond to unresolved Speed 3; later response windows after CHAIN_END are allowed');return defaultChoice(prompt);});assert.ok(counterChosen);assert.equal(own(state,1).lp,4000);assert.ok(field(state,1).some(card=>card.code===C.FISH));assert.ok(own(state,0).hand.some(card=>card.code===C.RUSH));assert.ok(!state.publicViews[0].log.some(entry=>entry.type==='activate'&&entry.text.includes('Rush Recklessly')));
});
await check('Disabled Main Monster Zones are selected by the core and reject later placement',async()=>{
  let state=await scenario([C.GROUND,C.ALEX]);let disabled=false;state=await play(state,'activate',C.GROUND,(prompt,current)=>{if(current.pendingMessage.type===M.SELECT_DISFIELD){disabled=true;const zones=prompt.options.filter(option=>option.place?.player===0&&option.place.location===4&&[0,1].includes(option.place.sequence));assert.equal(zones.length,2);return{optionIds:zones.map(option=>option.id)};}return defaultChoice(prompt);});assert.ok(disabled);let placement=false;
  state=await play(state,'summon',C.ALEX,prompt=>{if(prompt.kind==='place'){placement=true;assert.ok(prompt.options.every(option=>option.place.location!==4||option.place.player!==0||![0,1].includes(option.place.sequence)),'disabled zones cannot be a legal placement choice');}return defaultChoice(prompt);});assert.ok(placement);assert.equal(own(state,0).monsters[0].slot,2);
});
await check('Simultaneous mandatory triggers allow choosing their order and both searches resolve',async()=>{
  let state=await scenario([C.DOUBLE,C.SANGAN,C.WITCH],[],[C.RAIGEKI]);state=await play(state,'activate',C.DOUBLE);state=await play(state,'summon',C.SANGAN);state=await play(state,'summon',C.WITCH);state=await end(state,1);let ordered=false,searches=0;state=await play(state,'activate',C.RAIGEKI,(prompt,current)=>{if(current.pendingMessage.type===M.SORT_CHAIN){ordered=true;assert.equal(prompt.options.length,2);return{optionIds:prompt.options.map(option=>option.id).reverse()};}if(prompt.kind==='chain'&&current.pendingMessage.forced&&prompt.options.filter(option=>option.card).length===2){ordered=true;const witch=prompt.options.find(option=>option.card?.code===C.WITCH);assert.ok(witch);return{optionId:witch.id};}if(prompt.kind==='select'&&prompt.player===0)searches++;return defaultChoice(prompt);});assert.ok(ordered,'two distinct compulsory search effects permit choosing their chain order');assert.equal(searches,2);assert.equal(own(state,0).hand.length,4);assert.ok([C.SANGAN,C.WITCH].every(code=>own(state,0).graveyard.some(card=>card.code===code)));
});
await check('Card Trooper per-turn activation limit and End Phase ATK reset',async()=>{
  let state=await scenario([C.TROOPER]);state=await play(state,'summon',C.TROOPER);state=await play(state,'activate',C.TROOPER,prompt=>prompt.kind==='announce-number'?{optionId:prompt.options.find(option=>option.label==='3').id}:defaultChoice(prompt));assert.equal(field(state,0).find(card=>card.code===C.TROOPER).atk,1900);assert.equal(own(state,0).graveyard.length,3);assert.ok(!has(state,'activate',C.TROOPER));state=await end(state,1);assert.equal(field(state,0).find(card=>card.code===C.TROOPER).atk,400);state=await end(state,0);assert.ok(has(state,'activate',C.TROOPER),'activation allowance resets on a new turn');
});
await check('Ash Blossom hard once-per-turn is shared by same-name hand copies',async()=>{
  let state=await scenario([C.ASH,C.ASH],[],[C.UPSTART,C.VOID]);state=await end(state,1);state=await command(state,option=>option.action==='activate'&&option.card?.code===C.UPSTART);let ashResponse=false;
  state=await until(state,idle(1),prompt=>{if(prompt.kind==='chain'&&prompt.player===0){const ash=prompt.options.find(option=>option.card?.code===C.ASH);if(ash){ashResponse=true;return{optionId:ash.id};}}return defaultChoice(prompt);});assert.ok(ashResponse);assert.equal(own(state,0).graveyard.filter(card=>card.code===C.ASH).length,1);assert.equal(own(state,0).hand.filter(card=>card.code===C.ASH).length,1);assert.equal(own(state,0).lp,8000,'negated Upstart does not grant LP');state=await command(state,option=>option.action==='activate'&&option.card?.code===C.VOID);
  state=await until(state,idle(1),prompt=>{if(prompt.kind==='chain'&&prompt.player===0)assert.ok(!prompt.options.some(option=>option.card?.code===C.ASH),'a second Ash copy cannot activate this turn');return defaultChoice(prompt);});assert.equal(own(state,0).graveyard.filter(card=>card.code===C.ASH).length,1);assert.ok(own(state,1).graveyard.some(card=>card.code===C.VOID));
});

await check('Piercing damage and post-attack Defense effect from Spear Dragon',async()=>{
  let state=await scenario([C.SPEAR],[],[C.FISH]);state=await play(state,'summon',C.SPEAR);state=await end(state,1);state=await play(state,'monster-set',C.FISH);state=await end(state,0);state=await enterBattle(state);state=await attack(state,C.SPEAR);assert.equal(own(state,1).lp,6900);assert.ok(own(state,1).graveyard.some(card=>card.code===C.FISH));assert.equal(field(state,0).find(card=>card.code===C.SPEAR).position,'defense');
});
await check('Battle destruction protection and hidden defender burn from Marshmallon',async()=>{
  let state=await scenario([C.ALEX],[],[C.MARSH]);state=await play(state,'summon',C.ALEX);state=await end(state,1);state=await play(state,'monster-set',C.MARSH);state=await end(state,0);assert.ok(state.publicViews[0].players[1].monsters[0].hidden);state=await enterBattle(state);state=await attack(state,C.ALEX);assert.equal(own(state,1).lp,8000);assert.equal(own(state,0).lp,7000);assert.ok(field(state,1).some(card=>card.code===C.MARSH&&card.faceUp),'protected monster stays on the field and becomes public');
});
await check('Hayabusa Knight permits exactly two attacks in one Battle Phase',async()=>{
  let state=await scenario([C.HAYABUSA]);state=await play(state,'summon',C.HAYABUSA);state=await round(state);state=await enterBattle(state);state=await attack(state,C.HAYABUSA);assert.equal(own(state,1).lp,7000);assert.ok(has(state,'attack',C.HAYABUSA));state=await attack(state,C.HAYABUSA);assert.equal(own(state,1).lp,6000);assert.ok(!has(state,'attack',C.HAYABUSA));
});
await check('Battle replay after target leaves the field in the response chain',async()=>{
  let state=await scenario([C.ALEX],[],[C.FISH,C.COMPULSE]);state=await play(state,'summon',C.ALEX);state=await end(state,1);state=await play(state,'monster-set',C.FISH);state=await play(state,'spell-set',C.COMPULSE);assert.ok(!has(state,'activate',C.COMPULSE),'set Trap cannot activate during its set turn');state=await end(state,0);state=await enterBattle(state);let responded=false,replayed=false;
  state=await attack(state,C.ALEX,(prompt,current)=>{if(prompt.kind==='chain'&&prompt.player===1){const trap=prompt.options.find(option=>option.card?.code===C.COMPULSE);if(trap){responded=true;return{optionId:trap.id};}}if(prompt.kind==='select'&&prompt.player===1){const fish=prompt.options.find(option=>option.card?.code===C.FISH);if(fish)return{optionIds:[fish.id]};}if(prompt.kind==='yes-no'&&responded){replayed=true;assert.equal(current.pendingMessage.type,M.SELECT_YESNO);return{optionId:'yes'};}return defaultChoice(prompt);});assert.ok(responded);assert.ok(replayed,'core asks whether to continue the attack after the field changes');assert.equal(field(state,1).length,0);assert.ok(own(state,1).hand.some(card=>card.code===C.FISH));assert.equal(own(state,1).lp,6000,'replayed direct attack inflicts the real 2000 ATK');
});
await check('TCG Red-Eyes Darkness Metal Dragon pays a face-up Dragon banish and enforces both limits',async()=>{
  let state=await scenario([C.LUSTER,C.REDMD,C.ALEX,C.REDMD]);state=await play(state,'summon',C.LUSTER);assert.ok(has(state,'special-summon',C.REDMD));let paid=false;state=await play(state,'special-summon',C.REDMD,prompt=>{if(['select','toggle'].includes(prompt.kind)){const dragon=prompt.options.find(option=>option.card?.code===C.LUSTER);if(dragon){paid=true;return prompt.kind==='toggle'?{optionId:dragon.id}:{optionIds:[dragon.id]};}}return defaultChoice(prompt);});assert.ok(paid);assert.ok(own(state,0).banished.some(card=>card.code===C.LUSTER&&card.faceUp));assert.ok(field(state,0).some(card=>card.code===C.REDMD));assert.ok(!has(state,'special-summon',C.REDMD),'the second same-name copy cannot reuse the once-per-turn Summon procedure');
  state=await play(state,'activate',C.REDMD,prompt=>{if(prompt.kind==='select'){const dragon=prompt.options.find(option=>option.card?.code===C.ALEX);if(dragon)return{optionIds:[dragon.id]};}return defaultChoice(prompt);});assert.ok(field(state,0).some(card=>card.code===C.ALEX));assert.ok(!has(state,'activate',C.REDMD),'Dragon revival cannot be reused in this turn');assert.ok(!has(state,'special-summon',C.REDMD));assert.equal(own(state,0).hand.filter(card=>card.code===C.REDMD).length,1);
});

console.log('yugioh-auto-mechanics-smoke: OK (representative real TCG mechanics; not an exhaustive certification of every card combination)');
