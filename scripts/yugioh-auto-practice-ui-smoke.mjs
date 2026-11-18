// SPDX-License-Identifier: AGPL-3.0-or-later
// Client contract tests; the separate practice browser smoke uses real WASM/API.
import assert from 'node:assert/strict';
import {YugiohMultiplayer} from '../js/games/yugioh/simulator-multiplayer.js';
import {autoPromptView} from '../js/games/yugioh/simulator-auto-ui.js';

const deckId='a0000000-0000-4000-8000-000000000001', code=14785765;
const savedDeck={id:deckId,game:'yugioh',ownerSlug:'me',name:'Personal saved deck',persisted:true,cards:[{catalogCardId:String(code),section:'main',quantity:1,imageUrl:'https://example.invalid/card.jpg" onerror="alert(1)'}]};
const card={id:'auto-0-16-0',catalogCardId:String(code),code,controller:0,location:16,sequence:0,slot:null,cardName:'Blackwing - Zephyros the Elite',imageUrl:`https://images.ygoprodeck.com/images/cards/${code}.jpg`,type:'Effect Monster',faceUp:true,position:'attack',materials:[],counters:0,text:'A real-card source fixture'};
const player=name=>({name,lp:8000,deckId,deckName:savedDeck.name,deck:[],hand:[],extra:[],side:[],monsters:[],spells:[],field:[],extraMonsters:[],graveyard:[],banished:[]});
const copy=value=>structuredClone(value), calls=[];
let serial=0, active, promptNumber=0, assertions=0;
const eq=(actual,expected)=>{assertions++;assert.deepEqual(actual,expected);};
const ok=(value,message)=>{assertions++;assert.ok(value,message);};
function nextPrompt(kind='idle'){
  return{id:`prompt-${++promptNumber}`,promptId:`prompt-${promptNumber}`,kind,player:0,title:'La tua mossa',min:1,max:1,cancelable:false,options:kind==='announce-card'?[]:[{id:'activates-0',label:'Activate',action:'activate',card:{code,controller:0,location:16,sequence:0}}]};
}
function newDuel(){
  const players=[player('Me'),player('Campo di prova')];players[0].graveyard=[copy(card)];
  return{id:`b0000000-0000-4000-8000-${String(++serial).padStart(12,'0')}`,deckId,practice:true,mode:'auto',status:'playing',viewer:0,version:1,ready:[true,true],state:{mode:'auto',format:'tcg',status:'playing',turn:1,activePlayer:0,phase:'main1',players,chain:[],log:[],result:null,auto:{prompt:nextPrompt(),waitingPlayer:0,revealedCards:[]}}};
}
const options={getContext:()=>({team:'team',member:'me',allowed:true}),getDecks:()=>[savedDeck,{...savedDeck,id:'a0000000-0000-4000-8000-000000000002',ownerSlug:'other'}],getMembers:()=>[],onRender(){},onToast(){},confirm:async()=>true,call:async payload=>{
  calls.push(copy(payload));
  if(payload.op==='practiceStart'){eq(payload.deckId,deckId);ok(/^[a-f0-9-]{36}$/.test(payload.requestId));active=newDuel();return{duel:copy(active)};}
  if(payload.op==='practiceState')return{duel:copy(active)};
  if(payload.op==='practiceSearch')return{cards:[{code,name:card.cardName}],version:active.version,promptId:active.state.auto.prompt.id};
  if(payload.op==='practiceAction'){
    eq(payload.duelId,active.id);eq(payload.expectedVersion,active.version);eq(payload.action.type,'autoRespond');eq(payload.action.promptId,active.state.auto.prompt.id);
    active.version++;active.state.auto.prompt=nextPrompt();return{duel:copy(active)};
  }
  throw new Error(`Unexpected non-personal API operation: ${payload.op}`);
}};
const controller=new YugiohMultiplayer(options);controller.ready=true;controller.schedule=()=>{};
const button=(dataset,frame)=>({dataset,hasAttribute:()=>false,closest:()=>frame});
const frame=()=>({dataset:{ygoAutoPrompt:controller.autoPrompt()?.id||'',ygoAutoVersion:String(controller.duel.version),ygoAutoDuel:controller.duel.id}});
const click=(dataset,stamp)=>controller.click(button(dataset,stamp));
const NativeFormData=globalThis.FormData;
try{
  eq(controller.practiceDraft.mode,'auto');
  const picker=controller.practiceView();ok(picker.includes('name="mode"'));ok(picker.includes('value="auto" selected'));ok(picker.includes('value="manual"'));ok(!picker.includes('src="https://example.invalid/card.jpg" onerror="'));
  await controller.startPractice('a0000000-0000-4000-8000-000000000002');eq(calls.length,0);
  await controller.startPractice(deckId);
  eq(controller.practice,true);eq(controller.practiceTable,null);eq(controller.practiceDraft.mode,'auto');eq(calls[0].op,'practiceStart');
  ok(controller.view().includes('TESTA MAZZO'));ok(controller.view().includes('Prova personale'));ok(!controller.view().includes('data-ygo-action="ready"'));ok(controller.view().includes(`data-ygo-auto-prompt="${controller.autoPrompt().id}"`));
  ok(controller.view().includes('ygo-pile-graveyard has-auto-action'));ok(controller.view().includes('effetto disponibile'));
  await click({ygoCommand:'auto-expand'});ok(autoPromptView(controller).includes('Cimitero'));
  await click({ygoCommand:'menu'});ok(controller.view().includes('practice-restart'));ok(controller.view().includes('practice-exit'));ok(!controller.view().includes('auto-surrender'));ok(!controller.view().includes('data-ygo-lp'));
  await click({ygoCommand:'close-menu'});
  const oldFrame=frame(), oldPrompt=controller.autoPrompt().id;
  await click({ygoAutoOption:'activates-0'},oldFrame);eq(calls.at(-1).op,'practiceAction');eq(calls.at(-1).action.promptId,oldPrompt);
  const after=calls.length;await click({ygoAutoOption:'activates-0'},oldFrame);await click({ygoCommand:'auto-confirm'},oldFrame);eq(calls.length,after,'Old frame with a reused option id must not execute a new prompt');
  const currentFrame=frame();await click({ygoAutoOption:'activates-0'},currentFrame);eq(calls.length,after+1);
  const beforeReady=calls.length;await controller.act({type:'ready',player:0});eq(calls.length,beforeReady);

  active.version++;active.state.auto.prompt={...nextPrompt('counter'),count:1,options:[{id:'counter-0',label:'Counter source',available:2,card:{code,controller:0,location:4,sequence:0}}]};controller.receive(copy(active));
  const staleCounterFrame=frame();active.version++;active.state.auto.prompt={...nextPrompt('counter'),count:1,options:[{id:'counter-0',label:'Different counter source',available:2}]};controller.receive(copy(active));
  controller.updateDraft({dataset:{ygoAutoCounter:'counter-0'},value:'1',closest:()=>staleCounterFrame});eq(controller.autoCounts,{});
  controller.updateDraft({dataset:{ygoAutoCounter:'counter-0'},value:'1',closest:()=>frame()});eq(controller.autoCounts,{'counter-0':1});

  globalThis.FormData=class{constructor(form){this.values=form.values;}get(name){return this.values[name];}};
  active.version++;active.state.auto.prompt=nextPrompt('announce-card');controller.receive(copy(active));
  const staleSearchFrame=frame();active.version++;active.state.auto.prompt=nextPrompt('announce-card');controller.receive(copy(active));
  const searchForm=stamp=>({values:{query:'Zephyros'},matches:selector=>selector==='[data-ygo-auto-search]',closest:()=>stamp});
  const beforeSearch=calls.length;await controller.submit(searchForm(staleSearchFrame));eq(calls.length,beforeSearch);
  await controller.submit(searchForm(frame()));eq(calls.at(-1).op,'practiceSearch');eq(controller.autoSearchResults,[{code,name:card.cardName}]);
  globalThis.FormData=NativeFormData;

  const firstId=controller.duel.id;await click({ygoCommand:'practice-restart'});ok(controller.duel.id!==firstId);eq(calls.at(-1).op,'practiceStart');eq(controller.duel.version,1);eq(controller.autoSearchResults,[]);
  const savedId=controller.duel.id;await click({ygoCommand:'practice-exit'});eq(controller.practice,false);eq(controller.session,null);eq(controller.tab,'practice');ok(controller.view().includes('practice-resume'));
  await click({ygoCommand:'practice-resume'});eq(calls.at(-1).op,'practiceState');eq(controller.duel.id,savedId);eq(controller.practice,true);eq(controller.practiceTable,null);eq(controller.practiceDraft.deckId,deckId);
  ok(calls.every(call=>['practiceStart','practiceState','practiceAction','practiceSearch'].includes(call.op)),'Personal tests never use PvP/invite/statistics operations');
  controller.menu=true;active.status='finished';active.state.result={winner:0,notes:'Test finished'};active.version++;controller.receive(copy(active));ok(controller.view().includes('practice-restart'));ok(controller.view().includes('practice-exit'));
  console.log(`Yu-Gi-Oh automatic personal-practice UI smoke: ${assertions} assertions passed.`);
}finally{globalThis.FormData=NativeFormData;controller.reset();}
