// Synthetic battle tests exercise real state transitions; no production data.
import assert from 'node:assert/strict';
import {createSession,applyAction,validateSession,ZONES} from '../js/games/yugioh/simulator-engine.js';
import {redactState} from '../api/_yugioh-duel-service.js';
import {attackTargets} from '../js/games/yugioh/simulator-battle.js';

const deck={id:'battle-fixture',game:'yugioh',name:'Synthetic battle deck',cards:[
  ...Array.from({length:14},(_,index)=>({catalogCardId:`battle-${index}`,cardName:`Private battle monster ${index}`,section:'main',quantity:index===13?1:3,type:index===6?'Pendulum Effect Monster':'Effect Monster',level:4,
    atk:([2500,3000,1500,2500,0,null,1000,1000,1000,1000,1200,4000,1800,1600])[index],
    def:([1500,2800,1000,2500,0,null,500,3000,2500,1000,1000,4000,1000,1000])[index]})),
  {catalogCardId:'battle-xyz',cardName:'Synthetic battle Xyz',section:'extra',quantity:1,type:'XYZ Monster',rank:4,level:4,text:'2 Level 4 monsters',atk:2000,def:2000},
  {catalogCardId:'battle-fusion',cardName:'Synthetic battle Fusion',section:'extra',quantity:1,type:'Fusion Monster',level:8,atk:2000,def:1500},
  {catalogCardId:'battle-link',cardName:'Synthetic battle Link',section:'extra',quantity:1,type:'Link Monster',atk:1000}
]};
const clone=value=>structuredClone(value);
const act=(state,type,fields={})=>applyAction(state,{type,player:state.activePlayer,...fields});
const check=state=>assert.deepEqual(validateSession(state),{valid:true,errors:[]});
function rejected(state,action,pattern=/./){const before=clone(state);assert.throws(()=>applyAction(state,action),pattern);assert.deepEqual(state,before,'Rejected battle actions must be atomic');check(state);}
function find(state,player,code){for(const zone of ZONES){const card=state.players[player][zone].find(item=>item.catalogCardId===code);if(card)return card;}throw Error('Missing fixture '+code);}
function field(state,player,code,slot=0,{zone='monsters',position='attack',faceUp=true}={}){
  const card=find(state,player,code);return[act(state,'move',{player,cardId:card.id,to:zone,slot,position,faceUp}),card.id];
}
function fresh(prepare=state=>state){
  let state=act(createSession({decks:[deck,deck],firstPlayer:1,names:['Alice','Bob']}),'start');
  state=act(act(state,'nextPhase'),'nextPhase');state=prepare(state);
  state=act(state,'nextTurn');state=act(state,'draw');state=act(act(state,'nextPhase'),'nextPhase');
  return act(state,'setPhase',{phase:'battle'});
}
function pair(attacker='battle-0',defender='battle-2',options={}){
  let state=fresh(),a,b;[state,a]=field(state,0,attacker);[state,b]=field(state,1,defender,options.slot??0,options);return{state,a,b};
}
const declare=(state,cardId,target={zone:'monsters',slot:0})=>act(state,'declareAttack',{cardId,target});
function pass(state){return act(state,'battlePass',{player:state.battle.priority});}
function damage(state){state=pass(state);state=pass(state);assert.equal(state.battle.stage,'damage');return state;}
function resolve(state){state=damage(state);state=pass(state);state=pass(state);assert.equal(state.battle??null,null);check(state);return state;}
const inZone=(state,player,zone,id)=>state.players[player][zone].some(card=>card.id===id);
const byId=(state,player,id)=>ZONES.flatMap(zone=>state.players[player][zone]).find(card=>card.id===id);

{
  let first=act(createSession({decks:[deck,deck]}),'start');first=act(act(first,'nextPhase'),'nextPhase');let a;[first,a]=field(first,0,'battle-0');
  rejected(first,{type:'declareAttack',player:0,cardId:a,target:null},/primo|Battle|battaglia|fase/i);
  const fixture=pair();let state=fixture.state;
  rejected(state,{type:'declareAttack',player:1,cardId:fixture.b,target:{zone:'monsters',slot:0}},/turno|attivo/i);
  rejected(state,{type:'declareAttack',player:0,cardId:fixture.a,target:null},/diretto|Mostr|mostr|bersagl/i);
  for(const target of [{zone:'spells',slot:0},{zone:'monsters',slot:5},{zone:'monsters',slot:2},{zone:'extraMonsters',slot:2},'private-id'])rejected(state,{type:'declareAttack',player:0,cardId:fixture.a,target});
  state=act(state,'positionEffect',{cardId:fixture.a,position:'defense',faceUp:true});rejected(state,{type:'declareAttack',player:0,cardId:fixture.a,target:{zone:'monsters',slot:0}},/Attacco|attacco|scopert/i);
  state=act(state,'positionEffect',{cardId:fixture.a,position:'defense',faceUp:false});rejected(state,{type:'declareAttack',player:0,cardId:fixture.a,target:{zone:'monsters',slot:0}},/Attacco|attacco|scopert/i);
  const unknown=pair('battle-5');rejected(unknown.state,{type:'declareAttack',player:0,cardId:unknown.a,target:{zone:'monsters',slot:0}},/ATK|statistic|valore|dati/i);
  check(state);console.log('PASS attack declarations reject first-turn, inactive, Defense/covered, missing-stat and invalid public targets atomically');
}
for(const[attackCode,defenseCode,expectedLP,destroyA,destroyB]of[
  ['battle-0','battle-2',[8000,7000],false,true],
  ['battle-2','battle-0',[7000,8000],true,false],
  ['battle-0','battle-3',[8000,8000],true,true],
  ['battle-4','battle-4',[8000,8000],false,false]
]){
  const{state,a,b}=pair(attackCode,defenseCode),next=resolve(declare(state,a));
  assert.deepEqual(next.players.map(player=>player.lp),expectedLP);
  assert.equal(inZone(next,0,'graveyard',a),destroyA);assert.equal(inZone(next,1,'graveyard',b),destroyB);
  assert.equal(inZone(next,0,'monsters',a),!destroyA);assert.equal(inZone(next,1,'monsters',b),!destroyB);
}
console.log('PASS Attack versus Attack damage, both positive equal attacks and zero-versus-zero destruction rules');

for(const[defender,expectedLP,destroy]of[['battle-9',[8000,8000],true],['battle-8',[8000,8000],false],['battle-7',[7500,8000],false]]){
  const{state,a,b}=pair('battle-0',defender,{position:'defense'}),next=resolve(declare(state,a));
  assert.deepEqual(next.players.map(player=>player.lp),expectedLP);assert.equal(inZone(next,1,'graveyard',b),destroy);assert(inZone(next,0,'monsters',a),'A stronger Defense does not destroy the attacker');
}
console.log('PASS Attack versus Defense applies no piercing, correct damage and defender-only destruction');

{
  let state=fresh(),a;[state,a]=field(state,0,'battle-0');const initial=clone(state);
  state=declare(state,a,null);assert.equal(state.players[0].monsters[0].attackedTurn,state.turn);
  rejected(state,{type:'declareAttack',player:0,cardId:a,target:null},/attacc|battaglia|combatt|corso/i);
  state=resolve(state);assert.deepEqual(state.players.map(player=>player.lp),[8000,5500]);assert.equal(initial.players[1].lp,8000);
  rejected(state,{type:'declareAttack',player:0,cardId:a,target:null},/attacc|turno/i);
  state=act(state,'setPhase',{phase:'main2'});rejected(state,{type:'setPosition',player:0,cardId:a,position:'defense',faceUp:true},/attacc|turno/i);
  state=act(state,'positionEffect',{cardId:a,position:'defense',faceUp:true});assert.equal(state.players[0].monsters[0].position,'defense');
  let lethal=fresh(),killer;[lethal,killer]=field(lethal,0,'battle-11');lethal=act(lethal,'lp',{player:1,delta:-5000});lethal=resolve(declare(lethal,killer,null));
  assert.equal(lethal.players[1].lp,0);assert.equal(lethal.result.winner,0);rejected(lethal,{type:'drawEffect',player:1},/concluso/i);
  check(state);console.log('PASS direct damage, per-turn attack usage, post-attack position limit and automatic lethal-battle result');
}

{
  const{state:base,a,b}=pair('battle-0','battle-9',{position:'defense',faceUp:false});let state=declare(base,a);
  const before=redactState(state,0),enemy=before.players[1].monsters[0];assert(enemy.hidden&&!enemy.catalogCardId);
  const choices=attackTargets(base,0);assert.equal(choices[0].cardName,'Mostro coperto');assert(!JSON.stringify(choices).includes(b));assert.equal(choices[0].faceUp,false);
  assert(!JSON.stringify(before.battle).includes(b));assert(!JSON.stringify(before.battle).includes(find(base,1,'battle-9').cardName));
  assert(!state.log.at(-1).text.includes(find(base,1,'battle-9').cardName),'Declaration must not reveal the covered target');
  state=pass(state);assert(redactState(state,0).players[1].monsters[0].hidden,'One response pass cannot reveal a defender');
  state=pass(state);assert.equal(state.battle.stage,'damage');
  rejected(state,{type:'battleCancel',player:0},/Damage|danno|rinunci/i);
  assert.equal(state.players[1].monsters[0].position,'defense');assert(state.players[1].monsters[0].faceUp);
  assert.equal(redactState(state,0).players[1].monsters[0].catalogCardId,'battle-9');
  assert.equal(state.players[1].monsters[0].positionChangedTurn,undefined,'Damage reveal is not a manual Flip Summon');
  state=pass(state);state=pass(state);assert(inZone(state,1,'graveyard',b));
  assert(!JSON.stringify(state.lastBattle).includes(b),'Public battle feedback carries no hidden instance IDs');check(state);
  const extra=pair('battle-0','battle-fusion',{zone:'extraMonsters',slot:1});const resolved=resolve(declare(extra.state,extra.a,{zone:'extraMonsters',slot:1}));assert(inZone(resolved,1,'graveyard',extra.b));
  console.log('PASS covered target stays private until Damage Step, public-coordinate Extra targets and public result feedback');
}

{
  let{state,a}=pair();state=declare(state,a);
  for(const action of[{type:'setPhase',phase:'main2'},{type:'nextPhase'},{type:'nextTurn'},{type:'discardEnd',cardIds:[]}])rejected(state,{player:0,...action},/attacc|battaglia|combatt|corso/i);
  rejected(state,{type:'battlePass',player:0},/risposta|priorit|attendi/i);
  const own=find(state,0,'battle-10');rejected(state,{type:'activate',player:0,cardId:own.id},/risposta|priorit|attendi/i);
  const reply=state.players[1].hand[0];state=act(state,'activate',{player:1,cardId:reply.id});assert.equal(state.chain.length,1);
  rejected(state,{type:'battlePass',player:0},/catena/i);
  state=act(state,'passChain',{player:0});state=act(state,'passChain',{player:1});state=act(state,'resolveChain',{player:0});
  assert.equal(state.battle.priority,0);assert.equal(state.battle.passes,0);state=resolve(state);
  check(state);console.log('PASS pending battles block phase/turn changes, response priority and chains resume before damage');
}

{
  let{state,a}=pair();state=declare(state,a);rejected(state,{type:'battleCancel',player:1},/attacc|giocatore|turno/i);
  state=act(state,'battleCancel');assert.equal(state.battle??null,null);rejected(state,{type:'declareAttack',player:0,cardId:a,target:{zone:'monsters',slot:0}},/attacc|turno/i);
  let replay=pair();state=declare(replay.state,replay.a);let added;[state,added]=field(state,1,'battle-12',1);
  assert.equal(state.battle.stage,'replay');rejected(state,{type:'battlePass',player:0},/bersagl|replay|scegli|ripet/i);
  rejected(state,{type:'replayAttack',player:1,target:{zone:'monsters',slot:1}},/attacc|giocatore|turno|bersaglio/i);
  state=act(state,'replayAttack',{target:{zone:'monsters',slot:1},cardId:'forged-attacker'});assert.equal(state.battle.attackerId,replay.a);
  state=resolve(state);assert(inZone(state,1,'graveyard',added));assert(inZone(state,1,'monsters',replay.b));
  rejected(state,{type:'declareAttack',player:0,cardId:replay.a,target:{zone:'monsters',slot:0}},/attacc|turno/i);check(state);
  let direct=fresh(),directId;[direct,directId]=field(direct,0,'battle-0');direct=declare(direct,directId,null);[direct]=field(direct,1,'battle-2',0);assert.equal(direct.battle.stage,'replay');direct=act(direct,'battleCancel');assert.equal(direct.battle??null,null);
  console.log('PASS attack cancellation consumes usage and field changes require a replay without changing the attacker');
}

{
  let{state,a,b}=pair();state=declare(state,a);state=act(state,'positionEffect',{cardId:a,position:'defense',faceUp:true});assert.equal(state.battle??null,null);assert.equal(byId(state,0,a).attackedTurn,state.turn);
  let second=pair();state=damage(declare(second.state,second.a));const points=state.players.map(player=>player.lp);state=act(state,'move',{player:1,cardId:second.b,to:'graveyard'});assert.equal(state.battle??null,null);assert.deepEqual(state.players.map(player=>player.lp),points);
  rejected(state,{type:'declareAttack',player:0,cardId:second.a,target:null},/attacc|turno/i);
  let removed=pair();state=declare(removed.state,removed.a);state=act(state,'move',{cardId:removed.a,to:'graveyard'});assert.equal(state.battle??null,null);
  state=act(state,'move',{cardId:removed.a,to:'monsters',slot:0,position:'attack',faceUp:true});assert.equal(byId(state,0,removed.a).attackedTurn,undefined,'A card returning to the field is a new attack instance');
  check(state);console.log('PASS missing/turned attackers cancel, targets leaving Damage Step do not retarget and field re-entry resets usage');
}

{
  const pendulum=pair('battle-0','battle-6');const defeated=resolve(declare(pendulum.state,pendulum.a));assert(inZone(defeated,1,'extra',pendulum.b));assert(byId(defeated,1,pendulum.b).faceUp);
  let tokenId;let token=fresh(state=>{state=act(state,'token',{player:1,slot:0,atk:1000,def:1000});tokenId=state.players[1].monsters[0].id;return state;}),a;[token,a]=field(token,0,'battle-0');token=resolve(declare(token,a));assert(!ZONES.some(zone=>token.players[1][zone].some(card=>card.id===tokenId)));
  let xyzId,materials;let xyz=fresh(state=>{
    let x,y;[state,x]=field(state,1,'battle-2',0);[state,y]=field(state,1,'battle-10',1);materials=[x,y];const target=find(state,1,'battle-xyz');xyzId=target.id;
    return act(state,'summon',{player:1,cardId:xyzId,materialIds:materials,to:'extraMonsters',slot:1,position:'attack',confirmRequirements:true});
  });[xyz,a]=field(xyz,0,'battle-1');xyz=resolve(declare(xyz,a,{zone:'extraMonsters',slot:1}));assert([xyzId,...materials].every(id=>inZone(xyz,1,'graveyard',id)));assert.equal(find(xyz,1,'battle-xyz').materials.length,0);
  check(defeated);check(token);check(xyz);console.log('PASS battle destruction preserves Pendulum, Token and Xyz attached-material destinations');
}

{
  let{state,a}=pair('battle-2','battle-0');state=act(state,'stats',{cardId:a,stat:'atk',delta:1500});state=resolve(declare(state,a));assert.deepEqual(state.players.map(player=>player.lp),[8000,7500]);
  let lower=pair('battle-4','battle-4');state=act(lower.state,'stats',{cardId:lower.a,stat:'atk',delta:-500});state=resolve(declare(state,lower.a));assert.equal(state.players[0].lp,8000);assert(inZone(state,0,'monsters',lower.a)&&inZone(state,1,'monsters',lower.b));
  check(state);console.log('PASS current ATK modifiers are applied server-side and values cannot produce negative damage');
}

{
  let{state,a}=pair('battle-5','battle-2');state=act(state,'stats',{cardId:a,stat:'atk',value:1700});state=act(state,'stats',{cardId:a,stat:'atk',delta:300});
  assert.equal(byId(state,0,a).atkOverride,1700);assert.equal(byId(state,0,a).atkModifier,300);
  state=resolve(declare(state,a));assert.deepEqual(state.players.map(player=>player.lp),[8000,7500]);
  let current=pair('battle-1','battle-2');state=act(current.state,'stats',{cardId:current.a,stat:'atk',delta:1500});state=act(state,'stats',{cardId:current.a,stat:'atk',value:1800});assert.equal(byId(state,0,current.a).atkModifier,0);
  state=resolve(declare(state,current.a));assert.equal(state.players[1].lp,7700);
  let missing=pair('battle-0','battle-5',{position:'defense',faceUp:false});state=damage(declare(missing.state,missing.a));state=pass(state);
  rejected(state,{type:'battlePass',player:state.battle.priority},/ATK|DEF|valore|dati/i);
  state=act(state,'stats',{player:1,cardId:missing.b,stat:'def',value:1600});state=pass(state);assert(inZone(state,1,'graveyard',missing.b));assert.deepEqual(state.players.map(player=>player.lp),[8000,8000]);
  check(state);console.log('PASS explicit current-value overrides repair missing statistics, reset old modifiers and never silently treat unknown DEF as zero');
}

{
  let state=fresh(),a;[state,a]=field(state,0,'battle-0');state=damage(declare(state,a,null));let added;[state,added]=field(state,1,'battle-2',0);
  assert.equal(state.battle.stage,'damage','A direct attack already in Damage Step does not replay for a newly appearing monster');state=pass(state);state=pass(state);
  assert.equal(state.players[1].lp,5500);assert(inZone(state,1,'monsters',added));
  state=act(state,'nextTurn');state=act(state,'draw');state=act(act(state,'nextPhase'),'nextPhase');state=act(state,'nextTurn');state=act(state,'draw');state=act(act(state,'nextPhase'),'nextPhase');state=act(state,'setPhase',{phase:'battle'});
  assert.equal(byId(state,0,a).attackedTurn,2);state=declare(state,a);assert.equal(byId(state,0,a).attackedTurn,4);state=resolve(state);assert(inZone(state,1,'graveyard',added));
  let legacy=act(createSession({decks:[deck,deck],turnRules:false}),'start'),old;[legacy,old]=field(legacy,0,'battle-0');legacy=act(legacy,'setPhase',{phase:'battle'});
  rejected(legacy,{type:'declareAttack',player:0,cardId:old,target:null},/nuova partita|combattimento/i);
  check(state);console.log('PASS direct-Damage-Step field changes, attack availability on a new turn and explicit legacy-table compatibility');
}

{
  const fixture=pair();let state=declare(fixture.state,fixture.a);
  rejected(state,{type:'battleManual',player:1},/Damage|danno|manual|disponibil/i);
  state=damage(state);rejected(state,{type:'battleManual',player:1},/risposta|priorit|attendi|manual/i);
  const points=state.players.map(player=>player.lp),fieldBefore=clone(state.players.map(player=>({monsters:player.monsters,extraMonsters:player.extraMonsters,graveyard:player.graveyard})));
  state=act(state,'battleManual');assert.equal(state.battle.stage,'manual');assert.equal(state.battle.priority,1);assert.equal(state.battle.passes,0);
  assert.deepEqual(Object.keys(state.battle).sort(),['id','player','attackerId','target','stage','priority','passes'].sort(),'Manual confirmation cannot add hidden identity or client-chosen calculation fields');
  rejected(state,{type:'battleManualConfirm',player:0},/risposta|priorit|attendi|conferm|manual/i);
  rejected(state,{type:'battleManualReject',player:0},/risposta|priorit|attendi|conferm|manual/i);
  rejected(state,{type:'battlePass',player:1},/manual|conferm/i);
  rejected(state,{type:'battleCancel',player:0},/manual|conferm|Damage|rinunci/i);
  rejected(state,{type:'activate',player:1,cardId:state.players[1].hand[0].id},/manual|conferm/i);
  state=act(state,'battleManualConfirm',{player:1});assert.equal(state.battle??null,null);
  assert.deepEqual(state.players.map(player=>player.lp),points);assert.deepEqual(state.players.map(player=>({monsters:player.monsters,extraMonsters:player.extraMonsters,graveyard:player.graveyard})),fieldBefore);
  assert.equal(state.lastBattle.canceled,true);assert.deepEqual(state.lastBattle.damage,[0,0]);assert.deepEqual(state.lastBattle.destroyed,[]);assert.match(state.lastBattle.summary,/manual/i);
  rejected(state,{type:'declareAttack',player:0,cardId:fixture.a,target:{zone:'monsters',slot:0}},/attacc|turno/i);check(state);
  console.log('PASS manual battle exception needs the other player’s agreement and never applies automatic damage or destruction');
}

{
  const fixture=pair();let state=damage(declare(fixture.state,fixture.a));
  state=act(state,'battleManual');state=act(state,'battleManualReject',{player:1});assert.equal(state.battle.stage,'damage');assert.equal(state.battle.priority,0);assert.equal(state.battle.passes,0);
  rejected(state,{type:'battleManualConfirm',player:0},/manual|conferm|disponibil/i);
  state=pass(state);state=pass(state);assert.equal(state.players[1].lp,7000);assert(inZone(state,1,'graveyard',fixture.b));
  const requestByDefender=pair();state=damage(declare(requestByDefender.state,requestByDefender.a));state=pass(state);assert.equal(state.battle.priority,1);
  state=act(state,'battleManual',{player:1});assert.equal(state.battle.priority,0);state=act(state,'battleManualConfirm',{player:0});assert.equal(state.battle??null,null);assert.equal(state.players[1].lp,8000);
  let chain=pair();state=damage(declare(chain.state,chain.a));const effect=state.players[0].hand[0];state=act(state,'activate',{cardId:effect.id});
  rejected(state,{type:'battleManual',player:0},/catena/i);
  check(state);console.log('PASS rejecting a manual exception restores Damage Step, either responder can request it and unresolved chains block the handshake');
}

{
  let fixture=pair(),state=damage(declare(fixture.state,fixture.a));state=act(state,'battleManual');[state]=field(state,1,'battle-12',1);
  assert.equal(state.battle.stage,'manual','A manual Damage-Step agreement cannot create a replay');state=act(state,'battleManualConfirm',{player:1});assert.equal(state.battle??null,null);
  fixture=pair();state=damage(declare(fixture.state,fixture.a));state=act(state,'battleManual');state=act(state,'move',{player:1,cardId:fixture.b,to:'graveyard'});
  assert.equal(state.battle??null,null);assert.equal(byId(state,0,fixture.a).attackedTurn,state.turn);assert.deepEqual(state.players.map(player=>player.lp),[8000,8000]);
  check(state);console.log('PASS manual-exception field changes do not replay and a vanished combatant ends the attack without extra damage');
}

console.log('yugioh-battle-smoke: OK');
