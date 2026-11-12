import assert from 'node:assert/strict';
import {createSession,applyAction,validateSession,ZONES} from '../js/games/yugioh/simulator-engine.js';
import {redactState} from '../api/_yugioh-duel-service.js';

const copy=value=>structuredClone(value);
const deck={id:'rules-fixture',name:'Synthetic summon and chain deck',game:'yugioh',cards:[
  ...Array.from({length:14},(_,index)=>({catalogCardId:`main-${index}`,cardName:`Private main ${index}`,section:'main',quantity:index===13?1:3,
    type:index===0?'Tuner Effect Monster':'Effect Monster',level:index===0?3:index===1?5:index===4?3:4,atk:1500,def:1000,imageUrl:`/main-${index}.jpg`})),
  {catalogCardId:'synchro',cardName:'Synchro Eight',section:'extra',quantity:1,type:'Synchro Monster',level:8,text:'1 Tuner + 1+ non-Tuner monsters',atk:2500,def:2000},
  {catalogCardId:'xyz',cardName:'Xyz Four',section:'extra',quantity:1,type:'XYZ Monster',level:4,text:'2 Level 4 monsters',atk:2400,def:1800},
  {catalogCardId:'fusion',cardName:'Fusion fixture',section:'extra',quantity:1,type:'Fusion Monster',level:8,atk:2800,def:2000},
  {catalogCardId:'link',cardName:'Link fixture',section:'extra',quantity:1,type:'Link Monster',atk:1000}
]};
const fresh=()=>applyAction(applyAction(createSession({decks:[deck,deck],names:['Alice','Bob']}),{type:'start'}),{type:'setPhase',player:0,phase:'main1'});
const act=(state,type,fields={})=>applyAction(state,{type,player:0,...fields});
const integrity=state=>assert.deepEqual(validateSession(state),{valid:true,errors:[]});
function unchanged(state,action,pattern){const before=copy(state);assert.throws(()=>applyAction(state,action),pattern);assert.deepEqual(state,before);integrity(state);}
function locate(state,player,code){for(const zone of ZONES){const card=state.players[player][zone].find(card=>card.catalogCardId===code);if(card)return card;}throw Error('Fixture card absent: '+code);}
function field(state,code,slot,{player=0,faceUp=true}={}){return act(state,'move',{player,cardId:locate(state,player,code).id,to:'monsters',slot,faceUp,position:faceUp?'attack':'defense'});}
function summon(state,code,materialIds,fields={}){return act(state,'summon',{cardId:locate(state,0,code).id,materialIds,to:'monsters',slot:0,position:'attack',confirmRequirements:true,...fields});}
function closeChain(state){const first=state.chainState.priority;state=act(state,'passChain',{player:first});return act(state,'passChain',{player:1-first});}

{
  let state=fresh();const hand=state.players[0].hand[0],response=state.players[1].hand[0],hands=copy(state.players.map(player=>player.hand));
  state=act(state,'activate',{cardId:hand.id});
  assert.equal(state.chain[0].number,1);assert.equal(state.chain[0].imageUrl,hand.imageUrl);
  assert.deepEqual(state.players.map(player=>player.hand),hands,'A hand-effect declaration leaves both hands in place');
  const publicView=redactState(state,1);
  assert.equal(publicView.chain[0].cardName,hand.cardName);assert(publicView.players[0].hand.every(card=>card.hidden&&!card.catalogCardId));
  unchanged(state,{type:'activate',player:0,cardId:hand.id},/risposta/);
  unchanged(state,{type:'resolveChain',player:0},/Entrambi/);
  for(const type of ['setPhase','nextPhase','nextTurn'])unchanged(state,{type,player:0,phase:'battle'},/catena/);
  state=act(state,'activate',{player:1,cardId:response.id});
  assert.deepEqual(state.chain.map(link=>link.number),[1,2]);
  state=closeChain(state);assert.equal(state.chainState.stage,'resolving');
  unchanged(state,{type:'activate',player:0,cardId:hand.id},/risolvendo/);
  state=act(state,'resolveChain');assert.deepEqual(state.chain.map(link=>link.number),[1]);assert.match(state.log.at(-1).text,/anello 2/);
  state=act(state,'resolveChain',{player:1});assert.equal(state.chain.length,0);assert.equal(state.chainState,null);assert.match(state.log.at(-1).text,/anello 1/);
  integrity(state);console.log('PASS hand-effect declarations reveal only the activated card and both players close/resolve numbered chains in reverse order');
}
{
  let state=fresh();
  state=field(state,'main-2',0);state=field(state,'main-3',1);
  const noTuner=state.players[0].monsters.map(card=>card.id),target=locate(state,0,'synchro');
  unchanged(state,{type:'summon',player:0,cardId:target.id,materialIds:noTuner,to:'monsters',slot:0,confirmRequirements:true},/Tuner/);
  state=act(state,'move',{cardId:noTuner[0],to:'graveyard'});state=field(state,'main-0',0);
  const tuner=state.players[0].monsters.find(card=>card.isTuner),wrongSum=[tuner.id,noTuner[1]];
  assert.equal(tuner.level,3);assert.equal(tuner.isTuner,true);
  unchanged(state,{type:'summon',player:0,cardId:target.id,materialIds:wrongSum,to:'monsters',slot:0,confirmRequirements:true},/somma/);
  state=act(state,'move',{cardId:noTuner[1],to:'graveyard'});state=field(state,'main-1',1);
  const nonTuner=state.players[0].monsters.find(card=>!card.isTuner),materials=[tuner.id,nonTuner.id];
  const missingTarget=copy(state);locate(missingTarget,0,'synchro').level=null;
  unchanged(missingTarget,{type:'summon',player:0,cardId:target.id,materialIds:materials,to:'monsters',slot:0,confirmRequirements:true},/Livello.*non disponibile/);
  const missingMaterial=copy(state);missingMaterial.players[0].monsters[0].level=null;
  unchanged(missingMaterial,{type:'summon',player:0,cardId:target.id,materialIds:materials,to:'monsters',slot:0,confirmRequirements:true},/Livello dei materiali non disponibile/);
  unchanged(state,{type:'move',player:0,cardId:target.id,to:'monsters',slot:2,intent:'special'},/material|evocazione|Evocazione/i);
  state=summon(state,'synchro',materials);
  assert.equal(state.players[0].monsters[0].id,target.id);assert.equal(state.players[0].monsters[0].level,8);
  assert.deepEqual(state.players[0].graveyard.filter(card=>materials.includes(card.id)).map(card=>card.id).sort(),materials.sort());
  assert(state.players[0].graveyard.filter(card=>materials.includes(card.id)).every(card=>card.slot===null&&card.faceUp));
  assert.equal(state.chain.length,0,'A Synchro Summon does not itself create a chain');
  integrity(state);console.log('PASS Synchro requires the field Tuner and correct Level sum, preserves rejected states and sends valid materials to the Graveyard');
}
{
  let state=fresh();state=field(state,'main-2',0);state=field(state,'main-3',1);
  const materials=state.players[0].monsters.map(card=>card.id),xyz=locate(state,0,'xyz');
  assert.equal(xyz.rank,4);assert.equal(xyz.level,null,'Xyz rank is not a material Level');
  const generic={type:'summon',player:0,cardId:xyz.id,materialIds:materials,to:'monsters',slot:0,position:'attack',confirmRequirements:true};
  unchanged(state,{...generic,materialIds:[materials[0],materials[0]]},/distinti/);
  unchanged(state,{...generic,materialIds:[materials[0],state.players[1].hand[0].id]},/terreno/);
  const covered=copy(state);covered.players[0].monsters[0].faceUp=false;covered.players[0].monsters[0].position='defense';
  unchanged(covered,generic,/scoperti/);
  const mismatch=copy(state);mismatch.players[0].monsters[1].level=3;unchanged(mismatch,generic,/Livello 4/);
  const sameWrongRank=copy(state);sameWrongRank.players[0].monsters.forEach(card=>card.level=3);unchanged(sameWrongRank,generic,/Livello 4/);
  const absentRank=copy(state);locate(absentRank,0,'xyz').rank=null;unchanged(absentRank,generic,/Rango.*non disponibile/);
  const wrongPhase=copy(state);wrongPhase.phase='battle';unchanged(wrongPhase,generic,/Main Phase/);
  let tokenState=act(state,'token',{slot:2});const token=tokenState.players[0].monsters.find(card=>card.token);token.level=4;
  unchanged(tokenState,{...generic,materialIds:[materials[0],token.id]},/Segna-Mostro/);
  const specialRecipe=copy(state);locate(specialRecipe,0,'xyz').text='2 Level 4 Warrior monsters';
  unchanged(specialRecipe,{...generic,confirmRequirements:false},/requisiti specifici/);
  unchanged(state,{type:'move',player:0,cardId:xyz.id,to:'extraMonsters',slot:0,faceUp:true},/material|evocazione|Evocazione/i);
  unchanged(state,{type:'move',player:0,cardId:xyz.id,to:'extraMonsters',slot:0,faceUp:true,summoning:true},/material|evocazione|Evocazione/i);
  const enemyFusion=locate(state,1,'fusion');state=act(state,'move',{player:1,cardId:enemyFusion.id,to:'extraMonsters',slot:1,faceUp:true});
  unchanged(state,{...generic,to:'extraMonsters',slot:1},/occupata/);
  const graveyardBefore=state.players[0].graveyard.length;
  state=summon(state,'xyz',materials,{to:'extraMonsters',slot:0,position:'defense'});
  const summoned=state.players[0].extraMonsters[0];assert.equal(summoned.id,xyz.id);assert.equal(summoned.position,'defense');
  assert.deepEqual(summoned.materials.map(card=>card.id),materials);assert(summoned.materials.every(card=>card.slot===null&&card.faceUp));
  assert.equal(state.players[0].monsters.length,0);assert.equal(state.players[0].graveyard.length,graveyardBefore);
  assert.deepEqual(redactState(state,1).players[0].extraMonsters[0].materials.map(card=>card.id),materials);
  assert.equal(state.chain.length,0,'An Xyz Summon does not itself create a chain');
  integrity(state);console.log('PASS Xyz validates face-up owned same-Level materials against printed Rank and overlays them without a Graveyard move');

  for(const count of [-1,1.5,3,'1'])unchanged(state,{type:'activate',player:0,cardId:xyz.id,detachCount:count},/material|Material|Numero/);
  unchanged(state,{type:'activate',player:0,cardId:xyz.id,detachCount:1,detachMaterialIds:['foreign-material']},/materiali Xyz/);
  state=act(state,'activate',{cardId:xyz.id,detachCount:1,detachMaterialIds:[materials[1]]});
  assert.deepEqual(state.players[0].extraMonsters[0].materials.map(card=>card.id),[materials[0]]);
  assert.equal(state.players[0].graveyard.at(-1).id,materials[1]);assert.equal(state.chain[0].number,1);
  const stillAttached=state.players[0].extraMonsters[0].materials.length;
  unchanged(state,{type:'activate',player:0,cardId:xyz.id,detachCount:1},/risposta/);
  assert.equal(state.players[0].extraMonsters[0].materials.length,stillAttached,'A rejected chain response cannot spend a detach cost');
  state=closeChain(state);state=act(state,'resolveChain');
  state=act(state,'activate',{cardId:xyz.id,detachCount:1});state=closeChain(state);state=act(state,'resolveChain');
  assert.equal(state.players[0].extraMonsters[0].materials.length,0);
  unchanged(state,{type:'activate',player:0,cardId:xyz.id,detachCount:1},/insufficienti/);
  state=act(state,'activate',{cardId:xyz.id,detachCount:0});assert.equal(state.chain.length,1,'Xyz effects without detach costs remain declarable');
  state=closeChain(state);state=act(state,'resolveChain');integrity(state);
  console.log('PASS explicit Xyz detach costs are paid atomically before the chain; insufficient or foreign material costs reject without mutations');
}
{
  const spellDeck=copy(deck),spellRow=spellDeck.cards.find(card=>card.catalogCardId==='main-13');
  Object.assign(spellRow,{type:'Spell Card',level:null,race:'Normal',cardName:'Atomic Spell'});
  const freshSpell=()=>applyAction(applyAction(createSession({decks:[spellDeck,spellDeck],names:['Alice','Bob']}),{type:'start'}),{type:'setPhase',player:0,phase:'main1'});
  let state=freshSpell();const spell=locate(state,0,'main-13');state=act(state,'move',{cardId:spell.id,to:'hand'});
  const before=copy(state),originalLog=state.log.length;
  const played=act(state,'activate',{cardId:spell.id,playTo:'spells',slot:2});
  assert.deepEqual(state,before,'Atomic activation must preserve the original input');
  assert(!played.players[0].hand.some(card=>card.id===spell.id));
  assert(played.players[0].spells.some(card=>card.id===spell.id&&card.slot===2&&card.faceUp));
  assert.equal(played.chain.length,1);assert.equal(played.chain[0].cardId,spell.id);assert.equal(played.log.length,originalLog+1);
  const publicSpell=redactState(played,1).players[0].spells.find(card=>card.id===spell.id);
  assert.equal(publicSpell.cardName,'Atomic Spell');assert.equal(publicSpell.hidden,undefined);integrity(played);

  const occupied=act(state,'move',{cardId:state.players[0].hand.find(card=>card.id!==spell.id).id,to:'spells',slot:2,faceUp:false});
  unchanged(occupied,{type:'activate',player:0,cardId:spell.id,playTo:'spells',slot:2},/occupata/);
  unchanged(state,{type:'activate',player:0,cardId:spell.id,playTo:'monsters',slot:0},/Zona di attivazione/);
  unchanged(state,{type:'activate',player:0,cardId:spell.id,playTo:'field',slot:0},/zona scelta/);
  unchanged(state,{type:'activate',player:0,cardId:spell.id,playTo:'spells',slot:2,detachCount:1},/Materiali Xyz/);

  let waiting=act(state,'activate',{cardId:state.players[0].hand.find(card=>card.id!==spell.id).id});
  unchanged(waiting,{type:'activate',player:0,cardId:spell.id,playTo:'spells',slot:2},/risposta/);
  assert(waiting.players[0].hand.some(card=>card.id===spell.id&&!card.faceUp));
  assert(redactState(waiting,1).players[0].hand.every(card=>card.hidden&&!card.catalogCardId));
  waiting=closeChain(waiting);
  unchanged(waiting,{type:'activate',player:0,cardId:spell.id,playTo:'spells',slot:2},/risolvendo/);
  assert.equal(waiting.players[0].spells.length,0,'A rejected activation must not move or reveal the hand card');
  const field=copy(state);locate(field,0,'main-13').race='Field';
  const fieldPlayed=act(field,'activate',{cardId:spell.id,playTo:'field',slot:0});
  assert.equal(fieldPlayed.players[0].field[0].id,spell.id);assert.equal(fieldPlayed.chain.length,1);integrity(fieldPlayed);
  console.log('PASS hand Spell/Field activation moves and declares exactly one atomic link; invalid priority, resolution, slots or costs never move/reveal/pay');
}
console.log('yugioh-rules-integration-smoke: OK');
