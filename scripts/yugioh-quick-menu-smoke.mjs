import assert from 'node:assert/strict';
import {createSession,applyAction} from '../js/games/yugioh/simulator-engine.js';
import {YugiohMultiplayer} from '../js/games/yugioh/simulator-multiplayer.js';
import {deriveChainState} from '../js/games/yugioh/simulator-chain.js';
import {redactState} from '../api/_yugioh-duel-service.js';

const deck={id:'a0000000-0000-4000-8000-000000000001',game:'yugioh',name:'Quick menu fixture',cards:[
  ...Array.from({length:12},(_,i)=>({catalogCardId:`monster-${i}`,cardName:`Monster ${i}`,section:'main',type:'Effect Monster',quantity:3,atk:1800,def:1000})),
  {catalogCardId:'spell',cardName:'Test Spell',section:'main',type:'Spell Card',quantity:2},
  {catalogCardId:'trap',cardName:'Test Trap',section:'main',type:'Trap Card',quantity:1},
  {catalogCardId:'field',cardName:'Test Field',section:'main',type:'Spell Card',race:'Field',quantity:1},
  ...['Fusion','Link','Synchro','XYZ'].map(kind=>({catalogCardId:kind.toLowerCase(),cardName:`Test ${kind}`,section:'extra',type:`${kind} Monster`,quantity:1,level:kind==='Synchro'?8:kind==='XYZ'?4:null,atk:2000,def:1500,text:kind==='Synchro'?'1 Tuner + 1+ non-Tuner monsters':kind==='XYZ'?'2 Level 4 monsters':''}))
]};
let state=applyAction(createSession({decks:[deck,deck],turnRules:false}),{type:'start'}),version=1;
const calls=[],id='b0000000-0000-4000-8000-000000000001';
const snapshot=()=>({id,status:'playing',viewer:0,version,ready:[true,true],state:redactState(state,0)});
const button=dataset=>({dataset,hasAttribute:name=>Object.hasOwn(dataset,name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase()))});
const controller=new YugiohMultiplayer({getContext:()=>({member:'host',team:'team',allowed:true}),getDecks:()=>[],getMembers:()=>[],onRender:()=>{},onToast:()=>{},call:async payload=>{
  calls.push(payload);state=applyAction(state,payload.action);version++;return{duel:snapshot()};
}});
controller.ready=true;controller.receive(snapshot());
function hand(code){
  const card=state.players[0].hand.find(card=>card.catalogCardId===code)||state.players[0].deck.find(card=>card.catalogCardId===code);
  if(!state.players[0].hand.some(item=>item.id===card.id)){state=applyAction(state,{type:'move',player:0,cardId:card.id,to:'hand'});version++;controller.receive(snapshot());}
  return card.id;
}
async function closeChain(){
  while(deriveChainState(state).stage==='building'){
    const player=deriveChainState(state).priority;
    if(player===0)await controller.act({type:'passChain',player});
    else{state=applyAction(state,{type:'passChain',player});version++;controller.receive(snapshot());}
  }
  await controller.act({type:'resolveChain',player:0});
}
const tap=cardId=>controller.click(button({ygoCard:cardId,player:'0'}));
const choose=id=>controller.click(button({ygoDropAction:id}));
try{
  const monster=hand('monster-0'),before=calls.length;
  await tap(monster);
  assert(controller.dropMenu?.mode==='tap');assert.equal(calls.length,before);
  assert(controller.view().includes('class="ygo-drop-menu"'));
  assert(!controller.view().includes('class="ygo-card-dialog"'));
  await choose('normal');assert(controller.placing);assert.equal(calls.length,before);
  await controller.place(0,'spells',0);assert.equal(calls.length,before,'A wrong destination must not play the card');
  await controller.place(0,'monsters',2);
  assert.equal(calls.length,before+1);assert.equal(calls.at(-1).action.intent,'normal');
  assert.equal(controller.selected,null);assert.equal(controller.placing,null);
  assert.equal(state.players[0].monsters[0].slot,2);
  await tap(monster);assert(controller.dropMenu.actions.some(action=>action.id==='activate'));
  await choose('activate');assert.equal(state.chain.at(-1).cardId,monster);
  await closeChain();
  await tap(monster);await choose('position');assert.equal(state.players[0].monsters[0].position,'defense');
  console.log('PASS short tap, delayed target selection, Normal Summon and in-place effect/position commands');

  const special=hand('monster-1'),beforeSpecial=calls.length;
  await tap(special);
  const primaryMenu=controller.dropMenu;
  await controller.place(0,'monsters',0);
  assert.equal(calls.length,beforeSpecial,'A target tap must not play a card before a primary action is chosen');
  assert.equal(controller.dropMenu,primaryMenu);assert.equal(controller.selected.cardId,special);
  await choose('special');
  assert.equal(controller.dropMenu?.stage,'position');
  assert.deepEqual(controller.dropMenu.actions.map(action=>action.id),['special-attack','special-defense']);
  assert(controller.view().includes('aria-label="Posizione di evocazione"'));
  assert(!controller.view().includes('class="ygo-card-dialog"'),'Position choice must stay in the small contextual menu');
  assert.equal(calls.length,beforeSpecial);assert.equal(controller.placing,null);
  const positionMenu=controller.dropMenu;
  await controller.place(0,'monsters',0);
  assert.equal(calls.length,beforeSpecial,'A target tap must not bypass Attack/Defense selection');
  assert.equal(controller.dropMenu,positionMenu);assert.equal(controller.selected.cardId,special);
  assert(!state.players[0].monsters.some(card=>card.id===special));
  await controller.click(button({ygoCommand:'back-summon-position'}));
  assert.notEqual(controller.dropMenu?.stage,'position');
  assert.deepEqual(controller.dropMenu.actions.map(action=>action.id),['normal','special','set','activate']);
  await choose('special');await choose('special-defense');
  assert.equal(calls.length,beforeSpecial);assert.equal(controller.placing.position,'defense');
  await controller.place(0,'monsters',0);
  assert.equal(calls.length,beforeSpecial+1);assert.equal(calls.at(-1).action.intent,'special');
  assert.equal(state.players[0].monsters.find(card=>card.id===special).position,'defense');
  assert.equal(state.players[0].monsters.find(card=>card.id===special).faceUp,true);
  const attack=hand('monster-2');await tap(attack);await choose('special');await choose('special-attack');
  assert.equal(controller.placing.position,'attack');await controller.place(0,'monsters',1);
  assert.equal(state.players[0].monsters.find(card=>card.id===attack).position,'attack');
  console.log('PASS compact Attack/Defense choice, back navigation and face-up Special Summon after a target tap');

  const link=state.players[0].extra.find(card=>card.catalogCardId==='link');
  await tap(link.id);await choose('special');
  assert.equal(controller.dropMenu?.stage,'position');
  assert.deepEqual(controller.dropMenu.actions.map(action=>action.id),['special-attack']);
  const beforeLink=calls.length;await choose('special-defense');
  assert.equal(calls.length,beforeLink);assert.equal(controller.dropMenu?.stage,'position','An unavailable Link Defense action must not bypass the choice');
  await choose('special-attack');await controller.place(0,'extraMonsters',0);
  assert.equal(state.players[0].extraMonsters.find(card=>card.id===link.id).position,'attack');
  for(const code of ['synchro','xyz']){
    const extra=state.players[0].extra.find(card=>card.catalogCardId===code),beforeDraft=calls.length;
    await tap(extra.id);await choose('special');await choose('special-defense');
    assert.equal(controller.rulesDialog?.kind,'summon');assert.equal(controller.rulesDialog.cardId,extra.id);
    assert.equal(controller.rulesDialog.position,'defense');assert.equal(controller.rulesDialog.to,null);
    assert.equal(calls.length,beforeDraft,'Opening the material picker must not summon or consume materials');
    const materialDialog=controller.rulesDialog;
    await controller.place(0,'monsters',4);
    assert.equal(calls.length,beforeDraft,'A target tap must not bypass the material picker');
    assert.equal(controller.rulesDialog,materialDialog);assert.equal(controller.selected.cardId,extra.id);
    assert(state.players[0].extra.some(card=>card.id===extra.id));
    await controller.click(button({ygoCommand:'close-rules'}));
    controller.showDropMenu({cardId:extra.id,player:0,zone:'monsters',slot:4,x:100,y:100});
    await choose('special');await choose('special-attack');
    assert.equal(controller.rulesDialog.position,'attack');assert.equal(controller.rulesDialog.to,'monsters');assert.equal(controller.rulesDialog.slot,4);
    await controller.click(button({ygoCommand:'close-rules'}));
  }
  console.log('PASS Link Attack-only choice and position propagation to Synchro/Xyz material selection for taps and drags');

  for(const [code,zone,slot] of [['spell','spells',0],['trap','spells',1],['field','field',0]]){
    const cardId=hand(code);await tap(cardId);
    assert.deepEqual(controller.dropMenu.actions.map(action=>action.id),['activate','set']);
    await choose('set');assert(controller.placing.zones.includes(zone));
    await controller.place(0,zone,slot);
    assert.equal(state.players[0][zone].find(card=>card.id===cardId).faceUp,false);
    const opponent=redactState(state,1).players[0][zone].find(card=>card.slot===slot);
    assert(opponent.hidden&&!opponent.catalogCardId,'Set stays private until Activate');
    await tap(cardId);await choose('activate');
    assert.equal(state.players[0][zone].find(card=>card.id===cardId).faceUp,true);
    assert.equal(state.chain.at(-1).cardId,cardId);
    await closeChain();
  }
  console.log('PASS Spell, Trap and Field Spell Set/Activate with private identity and manual shared chain');

  await tap(monster);
  assert.equal(controller.dropMenu.actions.length,3);
  assert(!controller.view().includes('ygo-drop-footer'));
  assert(!controller.view().includes('ygo-drop-title'));
  controller.showCardDescription({player:0,cardId:monster});
  assert.equal(controller.dropMenu,null);assert(controller.view().includes('class="ygo-card-dialog"'));
  assert(controller.view().includes('<details data-ygo-advanced>'),'Advanced controls stay collapsed in the reading view');
  await tap(monster);state=applyAction(state,{type:'draw',player:1});version++;controller.receive(snapshot());
  assert.equal(controller.dropMenu,null);assert.equal(controller.selected,null);
  const unchanged=calls.length;await choose('activate');assert.equal(calls.length,unchanged);
  await controller.click(button({ygoAction:'setPhase',phase:'battle'}));
  assert.equal(calls.at(-1).action.phase,'battle');assert.equal(state.phase,'battle');
  console.log('PASS optional details, invalidated menus and direct phase payload');
}finally{controller.reset();}
console.log('yugioh-quick-menu-smoke: OK');
