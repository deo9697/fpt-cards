import assert from 'node:assert/strict';
import {createSession,applyAction,validateSession,ZONES} from '../js/games/yugioh/simulator-engine.js';
import {redactState} from '../api/_yugioh-duel-service.js';
import {requiredTributes,canDrawNormally,canSelectPhase} from '../js/games/yugioh/simulator-turn-rules.js';
import {YugiohMultiplayer} from '../js/games/yugioh/simulator-multiplayer.js';

const deck={id:'turn-rules-fixture',game:'yugioh',name:'Synthetic standard turns',cards:[
  ...Array.from({length:14},(_,index)=>({catalogCardId:`turn-${index}`,cardName:`Private monster ${index}`,section:'main',quantity:index===13?1:3,type:index===3?'Pendulum Effect Monster':'Effect Monster',level:index===1?5:index===2?7:index===4?6:index===5?null:4,atk:1500,def:1000})),
  {catalogCardId:'xyz',cardName:'Public Xyz Four',section:'extra',quantity:1,type:'XYZ Monster',rank:4,level:4,text:'2 Level 4 monsters',atk:2500,def:2000},
  {catalogCardId:'link',cardName:'Public Link',section:'extra',quantity:1,type:'Link Monster',atk:1000}
]};
const copy=value=>structuredClone(value),act=(state,type,fields={})=>applyAction(state,{type,player:state.activePlayer,...fields});
const fresh=(firstPlayer=0)=>act(createSession({decks:[deck,deck],firstPlayer,autoPhases:false}),'start');
const main=state=>act(act(state,'nextPhase'),'nextPhase');
const integrity=state=>assert.deepEqual(validateSession(state),{valid:true,errors:[]});
function rejected(state,action,pattern){const before=copy(state);assert.throws(()=>applyAction(state,action),pattern);assert.deepEqual(state,before,'Rejected commands must preserve cards, counters, phases and logs');integrity(state);}
function find(state,player,code){for(const zone of ZONES){const card=state.players[player][zone].find(card=>card.catalogCardId===code);if(card)return card;}throw Error('Missing fixture '+code);}
function hand(state,code,player=state.activePlayer){const card=find(state,player,code);if(state.players[player].hand.some(item=>item.id===card.id))return[state,card.id];return[act(state,'move',{player,cardId:card.id,to:'hand'}),card.id];}
function field(state,code,slot,{player=state.activePlayer,faceUp=true}={}){const card=find(state,player,code);return[act(state,'move',{player,cardId:card.id,to:'monsters',slot,faceUp,position:faceUp?'attack':'defense'}),card.id];}
function trim(state,player=state.activePlayer){while(state.players[player].hand.length>6)state=act(state,'move',{player,cardId:state.players[player].hand[0].id,to:'graveyard'});return state;}
const normal=(state,cardId,slot,fields={})=>act(state,'move',{cardId,to:'monsters',slot,faceUp:true,position:'attack',intent:'normal',...fields});

for(const [level,count]of[[1,0],[4,0],[5,1],[6,1],[7,2],[12,2]])assert.equal(requiredTributes({level,type:'Effect Monster'}),count);
assert.equal(requiredTributes({type:'Effect Monster',level:null}),null);
{
  let state=fresh(1);assert(state.turnState);assert.equal(canDrawNormally(state,1),false);assert.equal(canSelectPhase(state,1,'battle'),false);
  rejected(state,{type:'draw',player:1},/primo|pesca/i);
  state=main(state);state=act(trim(state),'nextTurn');assert.equal(state.activePlayer,0);assert.equal(canDrawNormally(state,0),true);
  rejected(state,{type:'draw',player:1},/turno|attivo/i);
  rejected(state,{type:'draw',player:0,count:2},/una|1|pesca/i);
  state=act(state,'draw');assert.equal(state.players[0].hand.length,6);assert.equal(canDrawNormally(state,0),false);
  rejected(state,{type:'draw',player:0},/già|pesca/i);
  state=act(state,'drawEffect',{player:1,count:2});assert.equal(state.players[1].hand.length,7,'Effect draws remain explicit and do not consume the normal draw');
  state=act(act(state,'nextPhase'),'nextPhase');rejected(state,{type:'draw',player:0},/Draw|fase|pesca/i);
  integrity(state);console.log('PASS first-player skip, one normal active Draw, out-of-turn rejection and explicit effect draws');
}
{
  let state=main(fresh()),card,second;[state,card]=hand(state,'turn-0');[state,second]=hand(state,'turn-6');
  state=normal(state,card,0);assert.equal(state.turnState.normalUsed,1);
  rejected(state,{type:'move',player:0,cardId:second,to:'monsters',slot:1,intent:'normal',faceUp:true,position:'attack'},/normale|Normal|turno/i);
  rejected(state,{type:'move',player:0,cardId:second,to:'monsters',slot:1,intent:'set',faceUp:false,position:'defense'},/normale|Normal|turno/i);
  state=act(state,'normalAllowance',{delta:1});state=normal(state,second,1);assert.equal(state.turnState.normalUsed,2);
  state=act(trim(state),'nextTurn');assert.equal(state.turnState.normalLimit,1);state=act(state,'draw');state=main(state);assert.equal(state.turnState.normalUsed,0);
  let opponent;[state,opponent]=hand(state,'turn-0',1);state=normal(state,opponent,0);assert.equal(state.turnState.normalUsed,1);
  integrity(state);console.log('PASS Normal Summon and Set share a turn allowance, explicit extra allowances and per-turn reset');
}
{
  let state=main(fresh()),target,material,enemy;[state,target]=hand(state,'turn-1');[state,material]=field(state,'turn-0',0);[state,enemy]=field(state,'turn-0',0,{player:1});
  const command={type:'move',player:0,cardId:target,to:'monsters',slot:0,intent:'normal',position:'attack',faceUp:true};
  rejected(state,command,/tribut/i);rejected(state,{...command,tributeIds:[enemy]},/tribut|tuoi|terreno/i);
  rejected(state,{...command,tributeIds:[material,material]},/tribut|distinti/i);rejected(state,{...command,tributeIds:[target]},/tribut|terreno/i);
  state=applyAction(state,{...command,tributeIds:[material]});assert(state.players[0].graveyard.some(card=>card.id===material));assert(state.players[0].monsters.some(card=>card.id===target&&card.slot===0));
  assert.equal(state.turnState.normalUsed,1);integrity(state);console.log('PASS Level 5 tribute ownership/count/atomicity and placement in the released slot');
}
{
  let state=main(fresh()),target,a,b;[state,target]=hand(state,'turn-2');[state,a]=field(state,'turn-0',0);[state,b]=field(state,'turn-6',1,{faceUp:false});
  for(const[slot,code]of[[2,'turn-7'],[3,'turn-8'],[4,'turn-9']])[state]=field(state,code,slot);
  rejected(state,{type:'move',player:0,cardId:target,to:'monsters',slot:0,intent:'normal',faceUp:true,position:'attack',tributeIds:[a]},/tribut/i);
  state=normal(state,target,0,{tributeIds:[a,b]});assert.equal(state.players[0].monsters.length,4);assert(state.players[0].graveyard.some(card=>card.id===a)&&state.players[0].graveyard.some(card=>card.id===b));
  integrity(state);console.log('PASS Level 7 requires two Tributes, accepts covered own monsters and works on a full field');
}
{
  let state=main(fresh()),target,pendulum;[state,target]=hand(state,'turn-4');[state,pendulum]=field(state,'turn-3',0,{faceUp:false});
  state=normal(state,target,0,{intent:'set',position:'defense',faceUp:false,tributeIds:[pendulum]});
  assert(state.players[0].extra.some(card=>card.id===pendulum&&card.faceUp));
  assert(!state.log.at(-1).text.includes(find(state,0,'turn-4').cardName),'Tribute Set must not expose the new hidden monster in the public log');
  const opponent=redactState(state,1).players[0].monsters.find(card=>card.slot===0);assert(opponent.hidden&&!opponent.catalogCardId);
  let tokenState=main(fresh()),five;[tokenState,five]=hand(tokenState,'turn-1');tokenState=act(tokenState,'token',{slot:0});const token=tokenState.players[0].monsters.find(card=>card.token);
  tokenState=normal(tokenState,five,0,{tributeIds:[token.id]});assert(!ZONES.some(zone=>tokenState.players[0][zone].some(card=>card.id===token.id)));
  integrity(state);integrity(tokenState);console.log('PASS private Tribute Set, Pendulum Extra destination and Token removal');
}
{
  let state=main(fresh()),a,b,target;[state,a]=field(state,'turn-0',0);[state,b]=field(state,'turn-6',1);const xyz=find(state,0,'xyz');
  state=act(state,'summon',{cardId:xyz.id,materialIds:[a,b],to:'extraMonsters',slot:0,position:'attack',confirmRequirements:true});[state,target]=hand(state,'turn-1');
  state=normal(state,target,0,{tributeIds:[xyz.id]});assert([a,b,xyz.id].every(id=>state.players[0].graveyard.some(card=>card.id===id)));assert.equal(state.players[0].graveyard.find(card=>card.id===xyz.id).materials.length,0);
  let unknown=main(fresh()),missing;[unknown,missing]=hand(unknown,'turn-5');rejected(unknown,{type:'move',player:0,cardId:missing,to:'monsters',slot:0,intent:'normal',faceUp:true,position:'attack'},/Livello|livello/i);
  let chain=main(fresh()),low;[chain,low]=hand(chain,'turn-0');chain=act(chain,'activate',{cardId:low});rejected(chain,{type:'move',player:0,cardId:low,to:'monsters',slot:0,intent:'normal',faceUp:true,position:'attack'},/catena/i);
  integrity(state);console.log('PASS Tributing Xyz releases attached materials; missing Levels and unresolved chains reject atomically');
}
{
  let state=main(fresh()),id;[state,id]=field(state,'turn-0',0);
  rejected(state,{type:'setPosition',player:0,cardId:id,position:'defense',faceUp:true},/turno|evocat|posizion/i);
  state=act(state,'positionEffect',{cardId:id,position:'defense',faceUp:true});assert.equal(state.players[0].monsters[0].position,'defense');
  state=act(trim(state),'nextTurn');state=main(act(state,'draw'));state=act(trim(state),'nextTurn');state=main(act(state,'draw'));
  state=act(state,'setPosition',{cardId:id,position:'attack',faceUp:true});
  rejected(state,{type:'setPosition',player:0,cardId:id,position:'defense',faceUp:true},/turno|posizion/i);
  rejected(state,{type:'setPosition',player:1,cardId:find(state,1,'turn-0').id,position:'attack',faceUp:true},/turno|attivo|presente/i);
  const link=find(state,0,'link');state=act(state,'move',{cardId:link.id,to:'extraMonsters',slot:0,position:'attack',faceUp:true});rejected(state,{type:'positionEffect',player:0,cardId:link.id,position:'defense',faceUp:true},/Orientamento|Posizione/i);
  integrity(state);console.log('PASS manual position limits, newly played monster restriction and explicit effect changes');
}
{
  let state=main(fresh()),id;[state,id]=field(state,'turn-0',0,{faceUp:false});
  rejected(state,{type:'flip',player:0,cardId:id},/turno|evocat|posizion/i);
  state=act(trim(state),'nextTurn');state=main(act(state,'draw'));state=act(trim(state),'nextTurn');state=main(act(state,'draw'));
  state=act(state,'flip',{cardId:id});const flipped=state.players[0].monsters.find(card=>card.id===id);assert(flipped.faceUp);assert.equal(flipped.position,'attack');
  rejected(state,{type:'setPosition',player:0,cardId:id,position:'defense',faceUp:true},/turno|posizion/i);
  integrity(state);console.log('PASS a later-turn Flip Summon reveals in Attack and consumes the manual position change');
}
{
  let state=main(fresh());state=act(state,'drawEffect',{count:3});assert.equal(state.players[0].hand.length,8);
  rejected(state,{type:'nextTurn',player:0},/mano|scart|6/i);
  const ids=state.players[0].hand.slice(0,2).map(card=>card.id),enemy=state.players[1].hand[0].id;
  for(const cardIds of[[ids[0]],[ids[0],ids[0]],[ids[0],enemy]])rejected(state,{type:'discardEnd',player:0,cardIds},/scart|carte|mano|distint/i);
  state=act(state,'discardEnd',{cardIds:ids});assert.equal(state.turn,2);assert.equal(state.activePlayer,1);assert.equal(state.phase,'draw');assert.equal(state.players[0].hand.length,6);assert(ids.every(id=>state.players[0].graveyard.some(card=>card.id===id)));
  const view=redactState(state,1);assert(view.players[0].hand.every(card=>card.hidden&&!card.catalogCardId));assert(view.players[0].graveyard.filter(card=>ids.includes(card.id)).every(card=>card.cardName));
  integrity(state);console.log('PASS exact end-hand discards and turn advancement commit atomically without revealing the remaining hand');
}
{
  let legacy=act(createSession({decks:[deck,deck],turnRules:false}),'start');assert(!legacy.turnState);legacy=act(legacy,'draw');legacy=act(legacy,'setPhase',{phase:'battle'});legacy=act(legacy,'setPhase',{phase:'draw'});integrity(legacy);
  console.log('PASS existing manual sessions keep legacy draws and phase corrections');
}
{
  let state=main(fresh()),version=1,target,material;[state,target]=hand(state,'turn-1');[state,material]=field(state,'turn-0',0);
  const calls=[],id='d0000000-0000-4000-8000-000000000001',snapshot=()=>({id,status:'playing',viewer:0,version,ready:[true,true],state:redactState(state,0)});
  const controller=new YugiohMultiplayer({getContext:()=>({member:'host',team:'team',allowed:true}),getDecks:()=>[],getMembers:()=>[],onRender:()=>{},onToast:()=>{},call:async payload=>{calls.push(payload);state=applyAction(state,payload.action);version++;return{duel:snapshot()};}});
  const button=dataset=>({dataset,hasAttribute:name=>Object.hasOwn(dataset,name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase()))});
  const form=(kind,values)=>({values,matches:selector=>selector.includes(`[data-ygo-${kind}]`),querySelector:()=>null});
  const NativeFormData=globalThis.FormData;
  globalThis.FormData=class{constructor(form){this.values=form.values;}getAll(key){return this.values[key]||[];}get(key){return this.getAll(key)[0]??null;}has(key){return this.getAll(key).length>0;}};
  controller.ready=true;controller.receive(snapshot());
  try{
    let metadataLow;[state,metadataLow]=hand(state,'turn-6');version++;controller.receive(snapshot());
    controller.metadata.set('turn-6',{id:'catalogue-row-6',level:null,type:'Effect Monster'});
    controller.metadata.set('turn-1',{id:'catalogue-row-1',level:12,type:'Effect Monster'});
    await controller.click(button({ygoCard:metadataLow,player:'0'}));
    assert.equal(controller.dropMenu.actions.find(action=>action.id==='normal').disabled,undefined,'Catalog metadata must not replace the playable instance ID or erase its Level');
    await controller.applyDropAction('normal');assert.equal(controller.rulesDialog,null);assert.equal(controller.placing.intent,'normal');assert.equal(calls.length,0);
    await controller.click(button({ygoCommand:'cancel-place'}));assert.equal(state.turnState.normalUsed,0);
    assert.equal(requiredTributes(controller.cardForActions(state.players[0].hand.find(card=>card.id===target))),1,'An authoritative Level 5 snapshot must retain one Tribute despite conflicting catalog data');
    await controller.click(button({ygoCard:target,player:'0'}));await controller.applyDropAction('normal');
    assert.equal(controller.rulesDialog?.kind,'tribute');assert.equal(calls.length,0);
    await controller.submit(form('tribute',{tributeIds:[]}));assert(controller.rulesDialog.error);assert.equal(calls.length,0);
    await controller.submit(form('tribute',{tributeIds:[material]}));assert.equal(controller.rulesDialog,null);assert.deepEqual(controller.placing.tributeIds,[material]);assert.equal(calls.length,0);
    await controller.place(0,'monsters',0);assert.equal(calls.length,1);assert.deepEqual(calls[0].action.tributeIds,[material]);assert.equal(state.players[0].monsters[0].id,target);
    let low;[state,low]=hand(state,'turn-6');version++;controller.receive(snapshot());await controller.click(button({ygoCard:low,player:'0'}));
    assert(controller.dropMenu.actions.find(action=>action.id==='normal').disabled);await controller.applyDropAction('normal');assert.equal(calls.length,1,'An exhausted Normal Summon stays blocked in the quick menu');
    await controller.act({type:'normalAllowance',player:0,delta:1});let high;[state,high]=hand(state,'turn-4');version++;controller.receive(snapshot());
    controller.showDropMenu({cardId:high,player:0,zone:'monsters',slot:0,x:100,y:100});await controller.applyDropAction('set');assert.equal(controller.rulesDialog?.kind,'tribute');
    const beforeDrop=calls.length;await controller.submit(form('tribute',{tributeIds:[target]}));assert.equal(calls.length,beforeDrop+1);assert.equal(calls.at(-1).action.intent,'set');assert.deepEqual(calls.at(-1).action.tributeIds,[target]);assert.equal(state.players[0].monsters.find(card=>card.id===high).faceUp,false);assert(!state.log.at(-1).text.includes(find(state,0,'turn-4').cardName));
    if(state.players[0].hand.length<8)await controller.act({type:'drawEffect',player:0,count:8-state.players[0].hand.length});
    const beforeEnd=calls.length;await controller.click(button({ygoAction:'nextTurn',player:'0'}));assert.equal(controller.rulesDialog?.kind,'discard');assert.equal(calls.length,beforeEnd);
    await controller.submit(form('discard',{cardIds:[state.players[0].hand[0].id]}));assert(controller.rulesDialog.error);assert.equal(calls.length,beforeEnd);
    await controller.click(button({ygoCommand:'close-rules'}));assert.equal(controller.rulesDialog,null);assert.equal(state.turn,1);
    await controller.click(button({ygoAction:'nextTurn',player:'0'}));const discards=state.players[0].hand.slice(0,2).map(card=>card.id);await controller.submit(form('discard',{cardIds:discards}));
    assert.equal(calls.at(-1).action.type,'discardEnd');assert.equal(state.turn,2);assert.equal(state.players[0].hand.length,6);
    state=main(fresh());[state,target]=hand(state,'turn-1');[state,material]=field(state,'turn-0',0);version++;controller.receive(snapshot());
    await controller.click(button({ygoCard:target,player:'0'}));await controller.applyDropAction('normal');assert.equal(controller.rulesDialog?.kind,'tribute');
    state=act(state,'drawEffect',{player:1});version++;controller.receive(snapshot());const beforeStale=calls.length;
    await controller.submit(form('tribute',{tributeIds:[material]}));assert.equal(calls.length,beforeStale);assert.equal(controller.rulesDialog,null);
    console.log('PASS standard controller snapshot identity/Level precedence, tribute forms, deferred placements, atomic dragged Set, quota feedback, exact end-discard and stale-form rejection');
  }finally{controller.reset();globalThis.FormData=NativeFormData;}
}
console.log('yugioh-turn-rules-smoke: OK');
