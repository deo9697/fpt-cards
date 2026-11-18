import { validateSimulatorDeck, ZONES, canMoveCardToZone, isMonster } from './simulator-engine.js';
import { arenaView, esc, cardView, actionButton, commandButton } from './simulator-arena.js';
import { createPracticeTable } from './simulator-practice.js';
import { createDuelOrientation } from './simulator-orientation.js';
import { createDuelCardGestures } from './simulator-touch.js';
import {createActivationReveals} from './simulator-reveal.js';
import {deriveChainState} from './simulator-chain.js';
import {getSummonKind,validateSummonMaterials,materialLevel} from './simulator-summoning.js';
import { cardDropActions, cardTapActions, specialSummonPositions } from './simulator-card-actions.js';
import {getTurnState,normalPlayError,requiredTributes,validateNormalTributes,positionChangeError} from './simulator-turn-rules.js';
import {attackError} from './simulator-battle.js';
import { arenaHeader, deckTiles, deckIssues, memberChips, segmented, duelTicket, historyTicket, deckRecords, sampleHand, arenaStats } from './simulator-lobby-view.js';
import { autoIsMulti, autoOptionsForCard, autoPlaceOption } from './simulator-auto-ui.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scope = context => `${context?.team || ''}:${context?.member || ''}`;
const status = {waiting:'Invito in attesa',setup:'Preparazione',playing:'Duello in corso',finished:'Duello concluso',declined:'Invito rifiutato',cancelled:'Invito annullato'};

export class YugiohMultiplayer {
  constructor(options) {
    this.options=options; this.context={...options.getContext()}; this.scope=scope(this.context);
    this.ready=false;this.loading=false;this.disposed=false;this.pending=false;this.connected=true;
    this.lobby={members:[],duels:[]};this.duel=null;this.session=null;this.viewer=null;this.error='';
    this.timer=null;this.polling=false;this.lastLobby=0;this.navigationGeneration=0;this.inspectionGeneration=0;
    this.requested='';this.tab='table';this.selected=null;this.inspectedCard=null;this.pile=null;this.placing=null;this.menu=false;this.revealHand=true;
    this.metadata=new Map();this.metadataLoading=new Set();this.inviteRequestId=null;
    this.inviteDraft={opponentSlug:'',deckId:'',lp:8000,firstPlayer:'0',mode:'auto'};this.acceptDraft={deckId:'',lp:8000};this.finishDraft={winner:'0',notes:''};
    this.autoSelected=[];this.autoCounts={};this.autoExpanded=false;this.autoSearchResults=[];
    this.practice=false;this.practiceTable=null;this.practiceStarting=false;this.practiceDraft={deckId:'',mode:'auto'};this.handSeed=1;
    this.dropMenu=null;this.dragBackup=null;this.rulesDialog=null;this.attackSelection=null;
    this.activationReveals=createActivationReveals({onHide:key=>{for(const node of globalThis.document?.querySelectorAll?.('.ygo-activation-reveal')||[])if(node.dataset.revealKey===key)node.remove();}});
    this.orientation=createDuelOrientation({onChange:()=>{if(this.orientation.isPortraitBlocked()){this.cardGestures?.cancel();this.dropMenu=null;this.rulesDialog=null;this.attackSelection=null;this.placing=null;this.selected=null;this.inspectedCard=null;}this.render();}});
    this.cardGestures=createDuelCardGestures({
      canStart:element=>!this.isAuto()&&this.allowed()&&!this.pending&&!this.dropMenu&&!this.rulesDialog&&!this.attackSelection&&!this.orientation.isPortraitBlocked()&&this.session?.phase!=='setup'&&this.canControl(this.viewer)&&Number(element.dataset.player)===this.viewer&&element.getAttribute('draggable')==='true',
      canInspect:element=>this.allowed()&&!this.pending&&!this.dropMenu&&!this.rulesDialog&&Boolean(this.session)&&!this.orientation.isPortraitBlocked()&&Boolean(element.dataset.ygoCard),
      onInspect:source=>this.showCardDescription(source),
      getRevision:()=>this.gestureRevision(),onStart:source=>this.beginCardDrag(source.player,source.cardId),
      onDrop:target=>this.showDropMenu(target),onCancel:()=>this.cancelCardDrag()
    });
    if(options.requestedPractice?.())this.tab='practice';
  }
  allowed(){const context=this.options.getContext();return !this.disposed&&context?.allowed===true&&scope(context)===this.scope;}
  get decks(){return(this.options.getDecks()||[]).filter(deck=>deck.game==='yugioh'&&(!deck.ownerSlug||deck.ownerSlug===this.context.member)&&deck.persisted!==false&&UUID.test(deck.id));}
  canControl(player){return player===this.viewer&&['setup','playing'].includes(this.duel?.status);}
  isAuto(){return this.session?.mode==='auto'||this.duel?.mode==='auto';}
  autoPrompt(){return this.session?.auto?.prompt;}
  autoFrameCurrent(element){
    if(!this.isAuto())return true;
    const frame=element?.dataset?.ygoAutoPrompt!==undefined?element:element?.closest?.('[data-ygo-auto-prompt]');
    if(!frame)return true;
    return frame.dataset.ygoAutoPrompt===(this.autoPrompt()?.id||'')&&Number(frame.dataset.ygoAutoVersion)===this.duel?.version&&(!frame.dataset.ygoAutoDuel||frame.dataset.ygoAutoDuel===this.duel?.id);
  }
  async respondAuto(choice){const prompt=this.autoPrompt();if(!this.isAuto()||this.duel?.status!=='playing'||!prompt||this.pending)return;this.dropMenu=null;this.selected=null;this.inspectedCard=null;this.pile=null;await this.act({type:'autoRespond',promptId:prompt.id,choice});}
  async chooseAutoOption(id){
    const prompt=this.autoPrompt();if(!prompt||this.pending||this.orientation.isPortraitBlocked())return;
    if(prompt.kind==='announce-card'){const row=this.autoSearchResults.find(row=>`announce-${row.code}`===id);if(row)await this.respondAuto({value:row.code});return;}
    if(!prompt.options.some(option=>option.id===id))return;
    if(autoIsMulti(prompt)){
      this.autoSelected=this.autoSelected.includes(id)?this.autoSelected.filter(value=>value!==id):[...this.autoSelected,id];
      this.dropMenu=null;this.selected=null;this.inspectedCard=null;this.render();return;
    }
    if(prompt.kind!=='counter')await this.respondAuto({optionId:id});
  }
  render(){if(this.allowed())this.options.onRender();}
  reset(){this.activationReveals.dispose();this.rulesDialog=null;this.attackSelection=null;this.navigationGeneration++;this.inspectionGeneration++;clearTimeout(this.timer);this.cardGestures.dispose();this.orientation.dispose();this.disposed=true;this.ready=false;this.duel=null;this.session=null;this.selected=null;this.pile=null;this.inspectedCard=null;this.placing=null;this.menu=false;this.dropMenu=null;this.practice=false;this.practiceTable=null;this.metadata.clear();}
  close(){this.reset();}
  suspend(){this.activationReveals.clear();this.rulesDialog=null;this.attackSelection=null;this.selected=null;this.inspectedCard=null;this.placing=null;this.cardGestures.cancel();this.dropMenu=null;this.orientation.exit();}
  async initialize(){
    if(this.loading||this.ready||!this.allowed())return;
    const generation=this.navigationGeneration;this.loading=true;this.error='';
    try{
      if(!await this.options.verifyAccess())throw new Error('Accedi con il tuo profilo del team.');
      if(!this.allowed()||generation!==this.navigationGeneration)return;
      await this.options.loadDecks();
      if(!this.allowed()||generation!==this.navigationGeneration)return;
      const response=await this.options.call({op:'lobby'});
      if(!this.allowed()||generation!==this.navigationGeneration)return;
      this.lobby=response;this.lastLobby=Date.now();this.ready=true;this.connected=true;await this.openRequested();
    }catch(error){if(this.allowed()&&generation===this.navigationGeneration){this.error=error.message||'Il tavolo non è disponibile. Riprova.';this.connected=false;}}
    finally{this.loading=false;this.render();this.schedule();}
  }
  async openRequested(){const id=this.options.requestedDuel?.()||'';if(this.ready&&UUID.test(id)&&id!==this.requested){this.requested=id;await this.open(id);}}
  schedule(){clearTimeout(this.timer);if(this.allowed()&&this.ready&&!this.practice)this.timer=setTimeout(()=>void this.poll(),this.duel?2200:6000);}
  async poll(){
    if(!this.allowed()||this.practice||this.practiceStarting)return;
    if(this.polling||this.pending||globalThis.document?.hidden||this.options.isVisible?.()===false){this.schedule();return;}
    const generation=this.navigationGeneration,id=this.duel?.id;this.polling=true;let changed=false;
    try{
      if(this.duel){const response=await this.options.call({op:'state',duelId:id,knownVersion:this.duel.version});if(!this.allowed()||generation!==this.navigationGeneration||id!==this.duel?.id)return;changed=(!response.unchanged&&this.receive(response.duel))||!this.connected;}
      if(!this.duel||Date.now()-this.lastLobby>12000){const response=await this.options.call({op:'lobby'});if(!this.allowed()||generation!==this.navigationGeneration)return;const lobbyChanged=JSON.stringify([response.members,response.duels])!==JSON.stringify([this.lobby.members,this.lobby.duels]);changed=changed||((!this.session||this.tab!=='table')&&lobbyChanged);this.lobby=response;this.lastLobby=Date.now();}
      changed=changed||!this.connected;this.connected=true;
    }catch(error){if(this.allowed()&&generation===this.navigationGeneration){if([401,403,404,410].includes(error.status)){this.clearTable();if([401,403].includes(error.status))this.ready=false;}this.error=error.message||'Connessione interrotta. Riprovo automaticamente.';this.connected=false;changed=true;}}
    finally{this.polling=false;if(changed)this.render();this.schedule();}
  }
  clearTable(){this.activationReveals.clear();this.rulesDialog=null;this.attackSelection=null;this.navigationGeneration++;this.inspectionGeneration++;this.cardGestures.cancel();this.dropMenu=null;this.orientation.exit();this.duel=null;this.session=null;this.selected=null;this.inspectedCard=null;this.pile=null;this.placing=null;this.menu=false;this.practice=false;this.practiceTable=null;}
  gestureRevision(){return`${this.navigationGeneration}:${this.duel?.id}:${this.duel?.version}:${globalThis.innerWidth||0}x${globalThis.innerHeight||0}`;}
  beginCardDrag(player,cardId){this.dragBackup={selected:this.selected,inspectedCard:this.inspectedCard,revision:this.gestureRevision()};this.selected={player,cardId};const inspected=this.pile&&(this.pile.cards||this.session.players[this.pile.player][this.pile.zone]).find(card=>card.id===cardId);this.inspectedCard=inspected&&!inspected.hidden?{card:inspected,zone:this.pile.zone,player:this.pile.player,version:this.duel.version}:null;}
  cancelCardDrag(){const previous=this.dragBackup;this.dragBackup=null;if(previous?.revision===this.gestureRevision()){this.selected=previous.selected;this.inspectedCard=previous.inspectedCard;}}
  cardForActions(card){const metadata=this.metadata.get(card.catalogCardId)||{},type=card.type||card.cardType||'';return{...metadata,...card,type:/monster|mostro|token|spell|magia|trap|trappola/i.test(type)?type:metadata.type||metadata.cardType||type,level:card.level??metadata.level};}
  constrainPlayActions(actions,card,from,to){
    const choices=actions.map(action=>{
      const normal=from==='hand'&&isMonster(card)&&['normal','set'].includes(action.changes?.intent)&&(action.zones?.includes('monsters')||to==='monsters');
      const effectPosition=action.changes?.positionOnly&&(action.changes.faceUp===false||!card.faceUp&&action.changes.position==='defense');
      const reason=normal?normalPlayError(this.session,this.viewer,card):action.changes?.positionOnly&&!effectPosition?positionChangeError(this.session,this.viewer,card,from,action.changes):null;
      return reason?{...action,disabled:true,reason}:action;
    });
    if(getTurnState(this.session)&&this.session.phase==='battle'&&['monsters','extraMonsters'].includes(from)&&isMonster(card)&&card.faceUp){const reason=attackError(this.session,this.viewer,card);choices.unshift({id:'attack',label:'Attacca',changes:{},disabled:Boolean(reason),reason});}
    return choices;
  }
  beginAttack(cardId,{replay=false}={}){
    if(!this.allowed()||this.pending||!this.canControl(this.viewer)||this.orientation.isPortraitBlocked())return;
    const card=[...this.session.players[this.viewer].monsters,...this.session.players[this.viewer].extraMonsters].find(card=>card.id===cardId);
    const error=replay?this.session.battle?.player!==this.viewer||this.session.battle?.stage!=='replay'||this.session.chain.length?'Completa la catena prima di scegliere il bersaglio.':null:attackError(this.session,this.viewer,card);
    if(error){this.error=error;this.render();return;}
    this.dropMenu=null;this.rulesDialog=null;this.placing=null;this.selected=null;this.inspectedCard=null;this.pile=null;this.menu=false;
    this.attackSelection={cardId,replay,duelId:this.duel.id,version:this.duel.version};this.error='';this.render();
  }
  async chooseAttackTarget(target){
    const choice=this.attackSelection;
    if(!choice||this.pending||!this.allowed()||this.orientation.isPortraitBlocked()||choice.duelId!==this.duel?.id||choice.version!==this.duel?.version)return;
    this.attackSelection=null;await this.act({type:choice.replay?'replayAttack':'declareAttack',player:this.viewer,...(!choice.replay?{cardId:choice.cardId}:{}),target});
  }
  showDropMenu({cardId,player,zone,slot,x,y}){
    if(this.isAuto())return;
    this.dragBackup=null;
    if(!this.allowed()||this.pending||this.orientation.isPortraitBlocked()||player!==this.viewer||!this.canControl(player)||this.session?.phase==='setup')return;
    this.selected={player,cardId};const selected=this.selectedCard();if(!selected)return;
    const board=['monsters','spells','field','extraMonsters'];
    if(board.includes(zone)){
      const occupied=this.session.players.flatMap((p,index)=>(zone==='extraMonsters'||index===player)?p[zone]:[]).find(card=>card.slot===slot&&card.id!==cardId);
      const canVacate=getSummonKind(selected.card)||selected.zone==='hand'&&isMonster(selected.card)&&requiredTributes(selected.card)>0;
      if(occupied&&!(zone!=='extraMonsters'||this.session.players[player].extraMonsters.some(card=>card.id===occupied.id))||occupied&&!canVacate){this.selected=null;return;}
    }
    const samePosition=selected.zone===zone&&selected.card.slot===slot;
    const card=this.cardForActions(selected.card);
    const actions=this.constrainPlayActions(cardDropActions(card,selected.zone,zone,{samePosition}),card,selected.zone,zone);
    if(!actions.length){this.selected=null;this.inspectedCard=null;return;}
    this.dropMenu={cardId,player,to:zone,slot,actions,version:this.duel.version,duelId:this.duel.id,x:Number.isFinite(x)?x:20,y:Number.isFinite(y)?y:20,cardName:selected.card.cardName};
    this.placing=null;this.pile=null;this.menu=false;this.render();
  }
  async applyDropAction(id){
    if(this.isAuto()){const menu=this.dropMenu;if(!menu||menu.version!==this.duel?.version||menu.duelId!==this.duel?.id||menu.promptId!==this.autoPrompt()?.id)return;await this.chooseAutoOption(id);return;}
    const menu=this.dropMenu,choice=menu?.actions.find(action=>action.id===id);
    if(!choice||choice.disabled||!this.allowed()||!this.canControl(menu.player)||this.pending||menu.duelId!==this.duel?.id||menu.version!==this.duel?.version||menu.player!==this.viewer||this.orientation.isPortraitBlocked())return;
    const{activateOnly,activateAfter,positionOnly,...changes}=choice.changes;
    const selected=this.selectedCard();
    if(id==='attack'){this.beginAttack(menu.cardId);return;}
    if(getTurnState(this.session)&&selected?.zone==='hand'&&isMonster(selected.card)&&['normal','set'].includes(changes.intent)&&(choice.zones?.includes('monsters')||menu.to==='monsters')&&requiredTributes(selected.card)>0){
      this.dropMenu=null;this.pile=null;this.menu=false;
      this.rulesDialog={kind:'tribute',cardId:menu.cardId,to:menu.mode==='tap'?null:menu.to,slot:menu.mode==='tap'?undefined:menu.slot,position:changes.position,faceUp:changes.faceUp,intent:changes.intent,tributeIds:[],version:this.duel.version,duelId:this.duel.id};this.render();return;
    }
    if(id==='special'){
      if(!selected)return;
      this.dropMenu={...menu,stage:'position',parentMenu:menu,actions:specialSummonPositions(this.cardForActions(selected.card),choice)};
      this.error='';this.render();return;
    }
    if(changes.intent==='special'&&selected?.zone==='extra'&&getSummonKind(selected.card)){this.openSummonDraft(menu.cardId,{to:menu.mode==='tap'?null:menu.to,slot:menu.mode==='tap'?undefined:menu.slot,position:changes.position});return;}
    if(menu.mode==='tap'&&(choice.zones||['monsters','spells','field','extraMonsters'].includes(choice.to))){
      this.dropMenu=null;this.placing={zones:choice.zones,to:choice.zones?undefined:choice.to,...changes,activate:activateAfter===true};
      this.error='';this.render();return;
    }
    this.dropMenu=null;this.selected=null;this.inspectedCard=null;this.placing=null;
    if(activateOnly){await this.activateCard(menu.player,menu.cardId);return;}
    if(positionOnly){const effect=getTurnState(this.session)&&isMonster(selected?.card)&&(changes.faceUp===false||!selected?.card.faceUp&&changes.position==='defense');await this.act({type:effect?'positionEffect':'setPosition',player:menu.player,cardId:menu.cardId,...changes});return;}
    if(activateAfter){await this.act({type:'activate',player:menu.player,cardId:menu.cardId,playTo:choice.to||menu.to,...(menu.slot===undefined?{}:{slot:menu.slot})});return;}
    await this.act({type:'move',player:menu.player,cardId:menu.cardId,to:choice.to||menu.to,...(choice.to&&choice.to!==menu.to||menu.slot===undefined?{}:{slot:menu.slot}),...changes});
  }
  openSummonDraft(cardId,{to=null,slot,position='attack'}={}){
    this.dropMenu=null;this.pile=null;this.menu=false;this.selected={player:this.viewer,cardId};
    this.rulesDialog={kind:'summon',cardId,to,slot,position,materialIds:[],confirmRequirements:false,version:this.duel.version,duelId:this.duel.id};this.render();
  }
  async activateCard(player,cardId){
    const own=this.session?.players[player],card=own&&[...own.monsters,...own.extraMonsters].find(card=>card.id===cardId);
    if(card&&/xyz/i.test(card.type)){
      const count=Number(card.text?.match(/(?:detach|stacc\w*)[^.;]{0,30}?(\d+)/i)?.[1]||1);
      this.rulesDialog={kind:'xyz-cost',cardId,costMode:'detach',materialIds:card.materials.slice(0,count).map(card=>card.id),version:this.duel.version,duelId:this.duel.id};
      this.dropMenu=null;this.selected={player,cardId};this.render();return;
    }
    await this.act({type:'activate',player,cardId});
  }
  updateRulesDraft(form){
    const draft=this.rulesDialog;if(!draft)return;const data=new FormData(form);
    if(draft.kind==='tribute'||draft.kind==='discard'){
      const key=draft.kind==='tribute'?'tributeIds':'cardIds';draft[key]=data.getAll(key);
      const output=form.querySelector('[data-ygo-selection-summary]');if(output)output.textContent=`${draft[key].length} selezionate / ${draft.kind==='tribute'?requiredTributes(this.selectedCard()?.card):Math.max(0,this.session.players[this.viewer].hand.length-6)} richieste`;
      return;
    }
    draft.materialIds=data.getAll('materialIds');draft.position=data.get('position')||'attack';draft.confirmRequirements=data.has('confirmRequirements');
    if(draft.kind==='xyz-cost'){
      draft.costMode=data.get('costMode');
      for(const input of form.querySelectorAll('[name=materialIds]')){input.disabled=draft.costMode==='none';if(input.disabled)input.checked=false;}
      if(draft.costMode==='none')draft.materialIds=[];
    }
    const output=form.querySelector('[data-ygo-material-summary]');
    if(output){const cards=[...this.session.players[this.viewer].monsters,...this.session.players[this.viewer].extraMonsters].filter(card=>draft.materialIds.includes(card.id));const target=this.session.players[this.viewer].extra.find(card=>card.id===draft.cardId);output.textContent=getSummonKind(target)==='xyz'?cards.length+' materiali di Livello '+(cards[0]?materialLevel(cards[0]):'?')+' · Rango '+(target.rank??target.level??'?'):cards.length+' materiali · somma Livelli '+cards.reduce((sum,card)=>sum+(materialLevel(card)||0),0);}
  }
  call(payload){
    if(this.practiceTable)return Promise.resolve().then(()=>this.practiceTable.run(payload));
    const operation=this.practice&&this.isAuto()?{action:'practiceAction',search:'practiceSearch',state:'practiceState'}[payload.op]:null;
    return this.options.call(operation?{...payload,op:operation}:payload);
  }
  syncOrientation(){if(this.allowed()&&((this.session&&this.tab==='table')||this.practiceStarting))void this.orientation.enter();else this.orientation.exit();}
  openRequestedPractice(){if(this.options.requestedPractice?.()&&this.tab!=='practice'&&!this.practice)this.showPractice();}
  showPractice({render=true}={}){this.clearTable();this.tab='practice';this.error='';this.options.onPracticeMode?.(true);if(!this.practiceDraft.deckId)this.practiceDraft.deckId=this.decks[0]?.id||'';if(render)this.render();this.schedule();}
  acceptPracticeDuel(duel,deckId){
    if(!duel||duel.practice!==true||duel.mode!=='auto'||duel.viewer!==0||!['playing','finished'].includes(duel.status)||duel.state?.mode!=='auto')throw new Error('Questa prova personale non è disponibile.');
    this.practiceTable=null;this.practice=true;this.practiceDraft.mode='auto';
    this.practiceDraft.deckId=deckId||duel.deckId||duel.state.players?.[0]?.deckId||this.practiceDraft.deckId;
    this.tab='table';this.receive(duel);this.options.onPracticeMode?.(true);
  }
  async startPractice(deckId,mode=this.practiceDraft.mode){
    if(this.pending||!this.ready||!this.allowed())return;
    const deck=this.decks.find(item=>item.id===deckId);
    if(!deck){this.error='Scegli uno dei tuoi mazzi salvati.';this.render();return;}
    const automatic=mode!=='manual';
    if(!automatic){const checked=validateSimulatorDeck(deck);if(!deck.dirty&&!checked.valid){this.error=checked.errors.join(' ');this.render();return;}}
    const generation=++this.navigationGeneration;this.pending=true;this.practiceStarting=true;this.error='';
    void this.orientation.enter({userGesture:true});this.render();
    try{
      const response=await this.options.call(automatic?{op:'practiceStart',deckId,requestId:crypto.randomUUID()}:{op:'practice',deckId});
      if(!this.allowed()||generation!==this.navigationGeneration)return;
      if(automatic){this.acceptPracticeDuel(response.duel,deckId);return;}
      if(!response.deck||response.deck.id!==deckId||response.deck.ownerSlug!==this.context.member||response.deck.game!=='yugioh')throw new Error('Questo mazzo non è disponibile per il tuo profilo.');
      this.practiceTable=createPracticeTable({deck:response.deck,name:this.options.getMembers?.().find(member=>(member.slug||member.id)===this.context.member)?.name||'Il tuo test'});
      this.practice=true;this.practiceDraft.deckId=deckId;this.practiceDraft.mode='manual';this.tab='table';this.receive(this.practiceTable.snapshot());
    }catch(error){if(this.allowed()&&generation===this.navigationGeneration)this.error=error.message||'Non è stato possibile preparare il test.';}
    finally{this.pending=false;this.practiceStarting=false;this.render();this.syncOrientation();this.schedule();}
  }
  async resumePractice(){
    if(this.pending||!this.ready||!this.allowed())return;
    const generation=++this.navigationGeneration;this.pending=true;this.practiceStarting=true;this.error='';
    void this.orientation.enter({userGesture:true});this.render();
    try{const response=await this.options.call({op:'practiceState'});if(this.allowed()&&generation===this.navigationGeneration)this.acceptPracticeDuel(response.duel);}
    catch(error){if(this.allowed()&&generation===this.navigationGeneration)this.error=error.message||'Non ci sono prove personali da riprendere.';}
    finally{this.pending=false;this.practiceStarting=false;this.render();this.syncOrientation();this.schedule();}
  }
  practiceView(){
    if(!this.practiceDraft.deckId)this.practiceDraft.deckId=this.decks[0]?.id||'';
    const selected=this.decks.find(deck=>deck.id===this.practiceDraft.deckId),hand=sampleHand(selected,this.handSeed),automatic=this.practiceDraft.mode!=='manual';
    return`<div class="ygo-arena-sec">Campo di prova <em>solo per te</em></div><form data-ygo-practice class="ygo-composer"><label class="ygo-arena-field"><span class="ygo-step">Modalità di prova</span><select name="mode"><option value="auto" ${automatic?'selected':''}>Automatico · Regole TCG</option><option value="manual" ${automatic?'':'selected'}>Manuale · Tavolo locale</option></select></label><select name="deckId" class="ygo-native" tabindex="-1" aria-hidden="true" required>${this.deckOptions(this.practiceDraft.deckId)}</select><span class="ygo-step">Scegli il mazzo</span>${deckTiles(this.decks,this.practiceDraft.deckId,'deckId')}${automatic?'<p class="ygo-arena-hint">Il motore verifica il mazzo e gestisce regole, costi ed effetti.</p>':deckIssues(selected)}${hand.length?`<span class="ygo-step">Anteprima carte</span><div class="ygo-sample-hand" data-hand-seed="${this.handSeed}">${hand.map((src,index)=>`<img src="${esc(src)}" alt="" style="--i:${index}">`).join('')}</div><button type="button" class="ygo-ticket-action is-ghost" data-ygo-redeal>Rimescola anteprima</button>`:''}<ul class="ygo-arena-points"><li>Pescate, evocazioni e combo senza un altro giocatore.</li><li>Nessun invito e nessun risultato registrato.</li><li>${automatic?'Prova personale automatica con un avversario passivo.':'Il turno avversario viene saltato: gli effetti li gestisci tu.'}</li></ul><button type="submit" class="ygo-primary ygo-cta" ${this.pending||!selected?'disabled':''}>${this.pending?'Preparazione…':'Apri il campo'}</button>${automatic?commandButton('practice-resume','Riprendi ultima prova',this.pending):''}</form>`;
  }
  receive(duel){
    if(!duel||!this.allowed()||(this.duel?.id===duel.id&&duel.version<this.duel.version))return false;
    const newTable=this.duel?.id!==duel.id||!this.session,changed=!this.duel||this.duel.id!==duel.id||this.duel.version!==duel.version;
    this.activationReveals.observe(duel);
    this.duel=duel;this.viewer=duel.viewer;this.session=['setup','playing','finished'].includes(duel.status)?duel.state||null:null;
    this.practice=duel.practice===true||Boolean(this.practiceTable);
    if(changed){this.attackSelection=null;this.rulesDialog=null;this.dropMenu=null;this.selected=null;this.inspectedCard=null;this.pile=null;this.placing=null;this.autoSelected=[];this.autoCounts={};this.autoExpanded=false;this.autoSearchResults=[];}
    if(newTable){this.autoDismissedReveal='';this.menu=false;this.revealHand=true;this.finishDraft={winner:String(this.viewer),notes:''};}
    return changed;
  }
  async perform(payload){
    if(!this.ready||!this.allowed()||this.pending)return null;
    const generation=this.navigationGeneration;this.pending=true;this.error='';this.render();
    try{const response=await this.call(payload);if(!this.allowed()||generation!==this.navigationGeneration)return null;if(response.duel)this.receive(response.duel);this.connected=true;return response;}
    catch(error){if(this.allowed()&&generation===this.navigationGeneration){if(error.data?.duel)this.receive(error.data.duel);this.error=error.message||'Operazione non riuscita. Riprova.';if([401,403].includes(error.status))this.connected=false;}return null;}
    finally{this.pending=false;this.render();this.schedule();}
  }
  async open(id){if(this.pending||!UUID.test(id))return;this.attackSelection=null;this.activationReveals.clear();this.navigationGeneration++;this.inspectionGeneration++;this.practice=false;this.practiceTable=null;this.selected=null;this.pile=null;this.inspectedCard=null;this.placing=null;this.menu=false;this.tab='table';await this.perform({op:'state',duelId:id});}
  async act(action){
    if(!this.duel||!this.session||!this.allowed()||this.pending)return null;
    if(this.isAuto()&&(!['autoRespond','surrender','ready'].includes(action.type)||this.practice&&action.type==='ready'))return null;
    if(this.orientation.isPortraitBlocked()){this.error='Ruota il telefono per giocare in orizzontale.';this.render();return null;}
    if(action.player!==undefined&&action.player!==this.viewer){this.error='Puoi modificare soltanto le tue carte.';this.render();return null;}
    return this.perform({op:'action',duelId:this.duel.id,expectedVersion:this.duel.version,requestId:crypto.randomUUID(),action});
  }
  selectedCard(){
    if(!this.selected||!this.session)return null;
    if(this.inspectedCard&&this.inspectedCard.version===this.duel.version&&this.inspectedCard.player===this.selected.player&&this.inspectedCard.card.id===this.selected.cardId)return this.inspectedCard;
    const player=this.session.players[this.selected.player];if(!player)return null;
    for(const zone of [...ZONES,'side']){const card=player[zone]?.find(card=>card.id===this.selected.cardId);if(card&&!card.hidden&&!(zone==='deck')&&!(zone==='hand'&&this.selected.player===this.viewer&&!this.revealHand))return{card,zone,player:this.selected.player};}
    return null;
  }
  showCardDescription({player,cardId}){
    if(!this.allowed()||this.pending||!this.session||this.orientation.isPortraitBlocked())return;
    this.dragBackup=null;this.selectCard(player,cardId);
    const selected=this.selectedCard();
    if(selected&&!selected.card.text&&!this.metadata.has(selected.card.catalogCardId)&&typeof this.options.lookupCard==='function')void this.fetchMetadata();
  }
  selectCard(player,cardId,{quick=false,x=20,y=20,anchor=null}={}){
    this.attackSelection=null;this.dropMenu=null;
    const card=this.pile&&(this.pile.cards||this.session.players[this.pile.player]?.[this.pile.zone])?.find(card=>card.id===cardId);
    this.inspectedCard=card&&!card.hidden?{card,zone:this.pile.zone,player:this.pile.player,version:this.duel.version}:null;
    this.selected={player,cardId};this.pile=null;this.menu=false;this.placing=null;
    const selected=this.selectedCard();
    if(!selected)this.selected=null;
    else if(quick&&this.isAuto()){
      const options=autoOptionsForCard(this.autoPrompt(),selected.card);
      if(options.length&&this.duel.status==='playing')this.dropMenu={mode:'auto',cardId,player,to:selected.zone,actions:options.map(option=>({id:option.id,label:option.effect?`${option.label} · ${option.effect}`:option.label})),version:this.duel.version,duelId:this.duel.id,promptId:this.autoPrompt().id,x,y,anchor,cardName:selected.card.cardName};
      else{this.selected=null;this.inspectedCard=null;}
    }
    else if(quick&&!this.pending&&this.canControl(player)&&this.session.phase!=='setup'){
      const card=this.cardForActions(selected.card);
      const actions=this.constrainPlayActions(cardTapActions(card,selected.zone),card,selected.zone);
      if(actions.length)this.dropMenu={mode:'tap',cardId,player,to:selected.zone,slot:selected.card.slot,actions,version:this.duel.version,duelId:this.duel.id,x,y,anchor,cardName:selected.card.cardName};
      else{this.selected=null;this.inspectedCard=null;}
    }else if(quick){this.selected=null;this.inspectedCard=null;}
    this.render();
    globalThis.document?.querySelector('.ygo-card-dialog')?.focus({preventScroll:true});
  }
  async inspectDeck(){
    if(this.isAuto())return;
    if(!this.canControl(this.viewer)||this.pending)return;
    const id=this.duel.id,generation=this.inspectionGeneration;this.menu=false;
    const response=await this.perform({op:'inspect',duelId:id,zone:'deck'});
    if(!response||!this.allowed()||this.duel?.id!==id||this.inspectionGeneration!==generation||response.version!==this.duel.version)return;
    this.selected=null;this.inspectedCard=null;this.pile={player:this.viewer,zone:'deck',cards:response.cards,version:response.version};this.render();
  }
  async fetchMetadata(){const selected=this.selectedCard();if(!selected||!this.allowed())return;const id=selected.card.catalogCardId;if(this.metadataLoading.has(id))return;this.metadataLoading.add(id);this.render();try{const data=await this.options.lookupCard(id);if(this.allowed()){if(!data)throw new Error('Dettagli non disponibili. Consulta l’immagine della carta.');this.metadata.set(id,data);}}catch(error){if(this.allowed())this.error=error.message||'Dettagli non disponibili.';}finally{this.metadataLoading.delete(id);this.render();}}
  deckOptions(value){return'<option value="">Scegli il tuo mazzo</option>'+this.decks.map(deck=>`<option value="${esc(deck.id)}" ${deck.id===value?'selected':''}>${esc(deck.name)}</option>`).join('');}
  deckSummary(deck){if(!deck)return'<p class="ygo-muted">Seleziona un mazzo Yu-Gi-Oh! salvato.</p>';const validation=validateSimulatorDeck(deck),count=section=>(deck.cards||[]).filter(card=>card.section===section).reduce((sum,card)=>sum+Number(card.quantity||0),0);return`<div class="ygo-deck-summary"><strong>${esc(deck.name)}</strong><span>${count('main')} Main · ${count('extra')} Extra · ${count('side')} Side</span><small class="${validation.valid?'is-valid':'is-invalid'}">${validation.valid?'Mazzo pronto':validation.errors.map(esc).join('<br>')}</small></div>`;}
  view(){
    if(!this.allowed())return'<section class="ygo-simulator"><div class="surface">Il simulatore Yu-Gi-Oh! è riservato ai membri del team.</div></section>';
    if(this.session&&this.tab==='table')return`<section class="ygo-simulator is-playing">${arenaView(this)}</section>`;
    return`<section class="ygo-simulator ygo-arena-page">${arenaHeader(this)}<div class="ygo-arena-body">${this.error?`<p class="ygo-error" role="alert">${esc(this.error)}</p>`:''}${!this.ready?`<section class="surface ygo-lobby" aria-busy="${this.loading}"><p>${this.loading?'Caricamento del team e dei mazzi…':'Entra nell’arena privata del team.'}</p>${commandButton('reload',this.error?'Riprova':'Carica tavolo',this.loading)}</section>`:this.tab==='practice'?this.practiceView():this.tab==='rules'?this.rulesView():this.tab==='history'?this.historyView():this.duel?this.waitingView():this.lobbyView()}</div></section>`;
  }
  lobbyView(){
    const opponents=this.lobby.members.filter(member=>member.slug!==this.context.member),opponent=opponents.find(member=>member.slug===this.inviteDraft.opponentSlug),deck=this.decks.find(deck=>deck.id===this.inviteDraft.deckId);
    const rows=this.lobby.duels.filter(row=>['waiting','setup','playing'].includes(row.status));
    const lpPreset=['8000','4000'].includes(String(this.inviteDraft.lp));
    const coin=this.inviteCoin?`<p class="ygo-arena-hint">Moneta: ${this.inviteDraft.firstPlayer==='0'?'inizi tu':'inizia '+esc(opponent?.name||'il compagno')}.</p>`:'';
    return`<div class="ygo-arena-sec">Tavoli attivi <em>${rows.length}</em></div>${rows.length?rows.map(row=>duelTicket(row,this.pending)).join(''):'<p class="ygo-arena-muted">Nessun duello in corso. Lancia la prima sfida qui sotto.</p>'}
      <div class="ygo-arena-sec">Nuova sfida</div>
      <form data-ygo-invite class="ygo-composer"><label class="ygo-arena-field"><span class="ygo-step">Modalità di gioco</span><select name="mode"><option value="auto" ${this.inviteDraft.mode==='auto'?'selected':''}>Automatico · Regole TCG</option><option value="manual" ${this.inviteDraft.mode==='manual'?'selected':''}>Manuale guidato</option></select></label>
        <select name="deckId" class="ygo-native" tabindex="-1" aria-hidden="true" required>${this.deckOptions(this.inviteDraft.deckId)}</select>
        <select name="opponentSlug" class="ygo-native" tabindex="-1" aria-hidden="true" required><option value="">Scegli un compagno</option>${opponents.map(member=>`<option value="${esc(member.slug)}" ${member.slug===this.inviteDraft.opponentSlug?'selected':''}>${esc(member.name)}</option>`).join('')}</select>
        <input name="lp" type="number" class="ygo-native" tabindex="-1" aria-hidden="true" min="1" max="999999" step="1" required value="${esc(this.inviteDraft.lp)}">
        <select name="firstPlayer" class="ygo-native" tabindex="-1" aria-hidden="true"><option value="0" ${this.inviteDraft.firstPlayer==='0'?'selected':''}>Tu</option><option value="1" ${this.inviteDraft.firstPlayer==='1'?'selected':''}>Il compagno</option></select>
        <span class="ygo-step">01 · Il tuo mazzo</span>${deckTiles(this.decks,this.inviteDraft.deckId,'deckId')}${this.inviteDraft.mode==='auto'?'<p class="ygo-arena-hint">Il mazzo viene verificato con il formato TCG automatico prima dell’invito.</p>':deckIssues(deck)}
        <span class="ygo-step">02 · L'avversario</span>${memberChips(opponents,this.inviteDraft.opponentSlug)}
        <div class="ygo-versus-plate"><div class="is-me"><small>TU</small><b>${esc(deck?.name||'Scegli un mazzo')}</b></div><span class="ygo-vs-hex" aria-hidden="true">VS</span><div class="is-op"><small>AVVERSARIO</small><b>${esc(opponent?.name||'Scegli un compagno')}</b></div></div>
        <div class="ygo-arena-row2"><div><span class="ygo-step">03 · LP</span><div class="ygo-seg ygo-lp-seg" role="radiogroup">${[['8000','8000'],['4000','4000']].map(([value,label])=>`<button type="button" role="radio" data-ygo-pick="lp" data-value="${value}" aria-checked="${String(this.inviteDraft.lp)===value}">${label}</button>`).join('')}<label class="${lpPreset?'':'is-current'}"><span class="ygo-native-label">LP personalizzati</span><input type="number" inputmode="numeric" min="1" max="999999" step="1" placeholder="Altro" data-ygo-lp-custom value="${lpPreset?'':esc(this.inviteDraft.lp)}"></label></div></div>
          <div><span class="ygo-step">04 · Inizia</span>${segmented('firstPlayer',this.inviteCoin?'coin':this.inviteDraft.firstPlayer,[['0','Tu'],['1','Lui'],['coin','Moneta']])}</div></div>${coin}
        <button type="submit" class="ygo-primary ygo-cta" ${this.pending||!this.decks.length||!opponents.length||!deck||!opponent?'disabled':''}>Invia la sfida ▸</button>
        <p class="ygo-arena-hint">${opponent?(opponent.pushEnabled?`${esc(opponent.name)} ha le notifiche attive: riceve la sfida sul telefono e sceglie il suo mazzo.`:`${esc(opponent.name)} non ha le notifiche: vedrà la sfida aprendo l’Arena.`):'Il tavolo resta privato tra voi due.'}</p>
      </form>`;
  }
  invitationView(row){return duelTicket(row,this.pending);}
  legacyInvitationView(row){const name=row.viewer===0?row.guestName:row.hostName;return`<article class="surface ygo-invitation"><div><small>${esc(status[row.status]||row.status)}</small><h3>${esc(name)}</h3><p>${esc([row.hostDeckName,row.guestDeckName].filter(Boolean).join(' vs '))}</p></div><button type="button" class="ygo-primary" data-ygo-open="${esc(row.id)}" ${this.pending?'disabled':''}>${row.status==='waiting'?'Apri invito':'Rientra al tavolo'}</button></article>`;}
  waitingView(){const d=this.duel;if(d.status==='waiting'&&d.viewer===1){const deck=this.decks.find(deck=>deck.id===this.acceptDraft.deckId);return`<div class="ygo-arena-sec">Sfida ricevuta <em>${d.mode==='auto'?'Automatico TCG':'Manuale guidato'}</em></div><form data-ygo-accept class="ygo-composer"><select name="deckId" class="ygo-native" tabindex="-1" aria-hidden="true" required>${this.deckOptions(this.acceptDraft.deckId)}</select><div class="ygo-versus-plate"><div class="is-op"><small>TI SFIDA</small><b>${esc(d.hostName)}</b></div><span class="ygo-vs-hex" aria-hidden="true">VS</span><div class="is-me"><small>IL SUO MAZZO</small><b>${esc(d.hostDeckName||'Yu-Gi-Oh!')}</b></div></div><span class="ygo-step">01 · Rispondi con</span>${deckTiles(this.decks,this.acceptDraft.deckId,'deckId')}${d.mode==='auto'?'<p class="ygo-arena-hint">Il mazzo viene verificato con il formato TCG automatico.</p>':deckIssues(deck)}<label class="ygo-arena-field"><span class="ygo-step">02 · I tuoi LP iniziali</span><input type="number" name="lp" min="1" max="999999" step="1" required value="${esc(this.acceptDraft.lp)}"></label><button type="submit" class="ygo-primary ygo-cta" ${this.pending||!this.decks.length||!deck?'disabled':''}>Accetta il duello ▸</button><div class="ygo-arena-row2"><button type="button" class="ygo-ticket-action is-danger" data-ygo-response="decline" ${this.pending?'disabled':''}>Rifiuta</button>${commandButton('lobby','Torna agli inviti')}</div></form>`;}return`<div class="ygo-arena-sec">${d.status==='waiting'?'Sfida inviata':'Tavolo'} <em>${d.mode==='auto'?'Automatico TCG':'Manuale guidato'}</em></div><section class="ygo-composer ygo-lobby"><div class="ygo-versus-plate"><div class="is-me"><small>HOST</small><b>${esc(d.hostName)}</b></div><span class="ygo-vs-hex" aria-hidden="true">VS</span><div class="is-op"><small>OSPITE</small><b>${esc(d.guestName)}</b></div></div><p class="ygo-arena-hint">${d.status==='waiting'?`Aspettiamo che ${esc(d.guestName)} scelga il mazzo.`:esc(status[d.status]||'Tavolo non disponibile.')}</p><div class="ygo-arena-row2">${d.status==='waiting'&&d.viewer===0?'<button type="button" class="ygo-ticket-action is-danger" data-ygo-response="cancel">Annulla invito</button>':''}${commandButton('lobby','Torna agli inviti')}</div></section>`;}
  historyView(){
    const rows=this.lobby.duels.filter(row=>row.status==='finished'&&row.result),stats=arenaStats(this.lobby.duels),records=deckRecords(this.lobby.duels);
    return`<div class="ygo-arena-ring-box"><div class="ygo-arena-ring" style="--v:${stats.rate}"><div><b>${stats.rate}%</b><small>VITTORIE</small></div></div><div class="ygo-arena-bars">${records.length?records.map(record=>{const total=record.wins+record.losses;return`<div><span>${esc(record.name)} <b>${record.wins}–${record.losses}</b></span><i style="--w:${total?Math.max(4,Math.round(record.wins/total*100)):4}%"></i></div>`;}).join(''):'<p class="ygo-arena-muted">I risultati per mazzo compaiono dopo il primo duello concluso.</p>'}<small>${rows.length} duelli · ${stats.wins} vittorie · ${stats.draws} pareggi</small></div></div>
      <div class="ygo-arena-sec">Ultimi duelli <em>${rows.length}</em></div>${rows.map(row=>historyTicket(row)).join('')||'<p class="ygo-arena-muted">Concludi un duello per registrare il primo test.</p>'}`;
  }
  rulesView(){return`<section class="ygo-rules ygo-arena-rules"><div class="ygo-arena-sec">Come funziona il tavolo</div><details open><summary><b>AUTO</b>Duello automatico TCG</summary><p>Scegli Automatico quando inviti un compagno. Il motore gestisce effetti, costi, evocazioni, materiali, combattimento e timing TCG. Tocca le carte illuminate per le mosse consentite; scegli i bersagli e conferma le selezioni richieste. Per leggere una carta tienila premuta. La banlist e la disponibilità delle carte sono controllate dal server. Entrambi confermano la mano iniziale per cominciare.</p><p><a href="/assets/licenses/yugioh-auto.html" target="_blank" rel="noopener noreferrer">Versioni, licenze e codice sorgente</a></p></details><h3>Modalità manuale guidata</h3><p>Le nuove partite controllano turni, pescate, Evocazioni Normali/Set, tributi e cambi posizione. Effetti, timing e costi non guidati restano manuali. Il combattimento standard controlla attacchi, danni e distruzione. Catene e materiali Synchro/Xyz hanno controlli dedicati.</p><details open><summary><b>01</b>Preparazione e turno</summary><p>Entrambi iniziano con cinque carte. Chi inizia salta la prima pescata; nel primo turno non si svolge la Battle Phase. Le fasi avanzano in ordine. Esegui la pescata dovuta prima di continuare; a fine turno scegli le carte da scartare se ne hai più di sei. Gli effetti restano da dichiarare. I tavoli già iniziati prima di questi controlli mantengono i comandi manuali: avvia una nuova partita per usare le regole guidate.</p></details><details><summary><b>02</b>Carte e zone</summary><p>Tocca una carta per il menu rapido oppure tienila premuta e trascinala in una zona libera. Scegli la giocata. Tenendo premuta la carta senza spostarla ne leggi la descrizione. Normal Summon e Set condividono la quota del turno. I Mostri di Livello 5–6 richiedono un tributo, dal Livello 7 ne richiedono due. Puoi offrire anche i tuoi Mostri coperti. Il cambio posizione normale è disponibile dalla propria Main Phase, una volta per turno, dopo il turno di ingresso. I comandi per effetto sono fra quelli avanzati. Puoi anche mandare al Cimitero o bandire. Le carte coperte dell’avversario restano private.</p></details><details><summary><b>03</b>Extra Deck e materiali Xyz</summary><p>Le due Zone Mostri Extra sono condivise. Per Synchro e Xyz scegli i tuoi materiali scoperti e una casella: vengono controllati Tuner, Livelli e Rango della procedura standard. I materiali Xyz restano attaccati al mostro. Rispetta anche i requisiti specifici della carta e le frecce Link.</p></details><details><summary><b>04</b>Combattimento</summary><p>Durante la tua Battle Phase, tocca un Mostro scoperto in Attacco e scegli Attacca. Tocca un bersaglio illuminato oppure Attacco diretto se il campo avversario è vuoto. Entrambi possono rispondere: due passaggi aprono il Damage Step e scoprono il difensore; altri due applicano i danni e la distruzione standard. Le catene vanno completate prima di proseguire. Se cambiano i Mostri avversari prima del Damage Step, scegli di nuovo il bersaglio o rinuncia. Nel Damage Step, per protezioni o effetti particolari, proponi Esito manuale: serve l’accordo dell’altro giocatore. Poi applicate l’effetto con i comandi manuali.</p></details><details><summary><b>05</b>Attivazioni e catene</summary><p>Activate registra un anello numerato, anche per effetti dalla mano. Entrambi scelgono Non rispondo per iniziare la risoluzione, dall’anello maggiore al minore. Gli effetti restano manuali. Per uno Xyz scegli i materiali richiesti dal costo; sposta Magie e Trappole al Cimitero quando previsto.</p></details><p class="ygo-arena-hint"><a href="https://www.yugioh-card.com/eu/it/play/" target="_blank" rel="noopener noreferrer">Regole ufficiali Yu-Gi-Oh! ↗</a></p></section>`;}
  bind(root){
    this.syncOrientation();
    const arena=root.querySelector('.ygo-arena');
    if(arena){const blocked=this.orientation.isPortraitBlocked();for(const child of arena.children)if(!child.classList.contains('ygo-orientation-gate'))child.inert=blocked;arena.querySelector('.ygo-orientation-gate')?.classList.toggle('is-required',blocked);}
    if(!this.allowed())return;const element=root.querySelector('.ygo-simulator');if(!element||element.dataset.bound)return;element.dataset.bound='true';if(!this.ready&&!this.error)void this.initialize();
    this.cardGestures.bind(element);
    const reveal=element.querySelector('.ygo-activation-reveal');if(reveal&&reveal.dataset.revealKey!==this.lastAnimatedRevealKey){this.lastAnimatedRevealKey=reveal.dataset.revealKey;reveal.classList.add('is-entering');}
    const chainLinks=element.querySelector('.ygo-chain-links');if(chainLinks)chainLinks.scrollLeft=chainLinks.scrollWidth;
    const drop=element.querySelector('.ygo-drop-menu');if(drop){const box=drop.getBoundingClientRect(),anchor=this.dropMenu.anchor;const left=anchor?(anchor.right+6+box.width<=innerWidth-8?anchor.right+6:anchor.left-box.width-6):this.dropMenu.x,top=anchor?anchor.top:this.dropMenu.y;drop.style.left=Math.max(8,Math.min(left,innerWidth-box.width-8))+'px';drop.style.top=Math.max(8,Math.min(top,innerHeight-box.height-8))+'px';drop.querySelector('button')?.focus({preventScroll:true});}
    element.addEventListener('input',event=>this.updateDraft(event.target));
    element.addEventListener('change',event=>{this.updateDraft(event.target);const form=event.target.closest('[data-ygo-summon],[data-ygo-xyz-cost],[data-ygo-tribute],[data-ygo-discard]');if(form)this.updateRulesDraft(form);if(['deckId','opponentSlug','mode'].includes(event.target.name))this.render();});
    element.addEventListener('submit',event=>{event.preventDefault();if(this.allowed())void this.submit(event.target);});
    element.addEventListener('click',event=>{const button=event.target.closest('button');if(button&&!button.disabled&&this.allowed())void this.click(button,event);});
    element.addEventListener('keydown',event=>{if(event.key==='Escape'){this.attackSelection=null;this.rulesDialog=null;this.dropMenu=null;this.cardGestures.cancel();this.inspectionGeneration++;this.selected=null;this.inspectedCard=null;this.pile=null;this.menu=false;this.placing=null;this.render();}});
    element.addEventListener('dragstart',event=>{const card=event.target.closest('[data-ygo-card][draggable=true]');if(!card||!event.dataTransfer||this.pending||!this.session)return;this.beginCardDrag(this.viewer,card.dataset.ygoCard);event.dataTransfer.setData('application/x-fpt-yugioh',JSON.stringify({cardId:card.dataset.ygoCard,player:this.viewer,duelId:this.duel.id,version:this.duel.version}));event.dataTransfer.effectAllowed='move';});
    element.addEventListener('dragover',event=>{if(event.target.closest('[data-ygo-slot],[data-ygo-drop-zone]')?.dataset.player===String(this.viewer))event.preventDefault();});
    element.addEventListener('drop',event=>{const target=event.target.closest('[data-ygo-slot],[data-ygo-drop-zone]');if(!target||!event.dataTransfer||!this.allowed())return;event.preventDefault();try{const data=JSON.parse(event.dataTransfer.getData('application/x-fpt-yugioh'));if(data.duelId!==this.duel?.id||data.version!==this.duel.version||data.player!==this.viewer)return;if(Number(target.dataset.player)!==this.viewer)return;this.showDropMenu({cardId:data.cardId,player:this.viewer,zone:target.dataset.zone||target.dataset.ygoDropZone,slot:target.dataset.ygoSlot!==undefined?Number(target.dataset.ygoSlot):target.dataset.ygoDropSlot!==undefined?Number(target.dataset.ygoDropSlot):undefined,x:event.clientX,y:event.clientY});}catch{/* Drops from outside this duel have no effect. */}});
  }
  // Tessere mazzo, compagni e pulsanti LP/inizio: scrivono nel controllo nativo
  // del modulo (stesso name di prima), così draft, submit e test restano invariati.
  pickLobbyValue(button){
    const form=button.closest('form');if(!form)return;let field=button.dataset.ygoPick,value=button.dataset.value;
    if(field==='firstPlayer'){this.inviteCoin=value==='coin';if(this.inviteCoin)value=Math.random()<.5?'0':'1';}
    const control=form.querySelector(`[name="${field}"]`);if(!control)return;control.value=value;this.updateDraft(control);if(this.inviteRequestId&&form.matches('[data-ygo-invite]'))this.inviteRequestId=null;this.render();
  }
  updateDraft(field){if(!this.autoFrameCurrent(field))return;if(field?.dataset?.ygoAutoCounter!==undefined){const option=this.autoPrompt()?.options.find(option=>option.id===field.dataset.ygoAutoCounter);const value=Number(field.value);if(option&&Number.isInteger(value)&&value>=0&&value<=option.available)this.autoCounts[option.id]=value;return;}if(field?.dataset?.ygoLpCustom!==undefined){const lp=field.closest('form')?.querySelector('[name="lp"]');if(lp&&Number(field.value)>0){lp.value=field.value;this.inviteDraft.lp=field.value;}return;}if(!this.allowed()||!field.name)return;const draft=field.closest('[data-ygo-practice]')?this.practiceDraft:field.closest('[data-ygo-invite]')?this.inviteDraft:field.closest('[data-ygo-accept]')?this.acceptDraft:field.closest('[data-ygo-finish]')?this.finishDraft:null;if(draft&&Object.hasOwn(draft,field.name)){draft[field.name]=field.value;if(draft===this.practiceDraft)this.error='';}}
  async submit(form){
    if(this.pending||!this.ready||!this.allowed()||!this.autoFrameCurrent(form))return;const data=new FormData(form),selected=this.selectedCard();
    if(form.matches('[data-ygo-auto-search]')){
      const prompt=this.autoPrompt();if(!prompt||prompt.kind!=='announce-card')return;
      const response=await this.perform({op:'search',duelId:this.duel.id,promptId:prompt.id,query:String(data.get('query')||'')});
      if(response&&response.promptId===this.autoPrompt()?.id&&response.version===this.duel.version){this.autoSearchResults=response.cards||[];this.render();}return;
    }
    if(this.isAuto()&&this.session)return;
    if(form.matches('[data-ygo-tribute],[data-ygo-discard]')){
      const draft=this.rulesDialog;if(!draft||draft.version!==this.duel?.version||draft.duelId!==this.duel?.id)return;
      this.updateRulesDraft(form);
      if(draft.kind==='discard'){
        if(draft.cardIds.length!==this.session.players[this.viewer].hand.length-6){draft.error='Seleziona esattamente le carte in eccesso.';this.render();return;}
        this.rulesDialog=null;this.selected=null;this.inspectedCard=null;await this.act({type:'discardEnd',player:this.viewer,cardIds:draft.cardIds});return;
      }
      try{validateNormalTributes(this.session,this.viewer,selected?.card,draft.tributeIds);}
      catch(error){draft.error=error.message;this.render();return;}
      this.rulesDialog=null;
      const changes={position:draft.position,faceUp:draft.faceUp,intent:draft.intent,tributeIds:draft.tributeIds};
      if(draft.to){this.selected=null;this.inspectedCard=null;await this.act({type:'move',player:this.viewer,cardId:draft.cardId,to:draft.to,slot:draft.slot,...changes});}
      else{this.placing={zones:['monsters'],...changes};this.render();}return;
    }
    if(form.matches('[data-ygo-summon],[data-ygo-xyz-cost]')){
      const draft=this.rulesDialog;if(!draft||draft.version!==this.duel?.version||draft.duelId!==this.duel?.id)return;
      this.updateRulesDraft(form);
      if(draft.kind==='xyz-cost'){
        if(draft.costMode==='detach'&&!draft.materialIds.length){draft.error='Seleziona almeno un materiale da staccare.';this.render();return;}
        this.rulesDialog=null;this.selected=null;this.inspectedCard=null;
        await this.act({type:'activate',player:this.viewer,cardId:draft.cardId,detachCount:draft.materialIds.length,detachMaterialIds:draft.materialIds});return;
      }
      const p=this.session.players[this.viewer],target=p.extra.find(card=>card.id===draft.cardId),materials=[...p.monsters,...p.extraMonsters].filter(card=>draft.materialIds.includes(card.id));
      try{validateSummonMaterials(target,materials,{confirmRequirements:draft.confirmRequirements});}
      catch(error){draft.error=error.message;this.render();return;}
      this.rulesDialog=null;
      const summon={cardId:draft.cardId,materialIds:draft.materialIds,confirmRequirements:draft.confirmRequirements,position:draft.position};
      if(draft.to){this.selected=null;this.inspectedCard=null;await this.act({type:'summon',player:this.viewer,...summon,to:draft.to,slot:draft.slot});}
      else{this.placing={zones:['monsters','extraMonsters'],position:draft.position,faceUp:true,summon};this.render();}return;
    }
    if(form.matches('[data-ygo-practice]')){await this.startPractice(data.get('deckId'),data.get('mode')||this.practiceDraft.mode);return;}
    if(form.matches('[data-ygo-invite]')){this.inviteRequestId||=crypto.randomUUID();const result=await this.perform({op:'invite',mode:data.get('mode')||this.inviteDraft.mode,requestId:this.inviteRequestId,opponentSlug:data.get('opponentSlug'),deckId:data.get('deckId'),lp:Number(data.get('lp')),firstPlayer:Number(data.get('firstPlayer'))});if(result){this.inviteRequestId=null;this.options.onToast(result.notification?.push==='sent'?'Invito inviato · notifica spedita':'Invito inviato al compagno del team');}}
    if(form.matches('[data-ygo-accept]'))await this.perform({op:'accept',duelId:this.duel.id,expectedVersion:this.duel.version,requestId:crypto.randomUUID(),deckId:data.get('deckId'),lp:Number(data.get('lp'))});
    if(form.matches('[data-ygo-move]')&&selected?.player===this.viewer)await this.act({type:'move',player:this.viewer,cardId:selected.card.id,to:data.get('to'),placement:data.get('placement')||'top',faceUp:data.get('faceUp')!=='false',position:data.get('position')||'attack'});
    if(form.matches('[data-ygo-lp]'))await this.act({type:'lp',player:this.viewer,delta:Number(data.get('delta'))});
    if(form.matches('[data-ygo-stats]')&&selected?.player===this.viewer)await this.act({type:'stats',player:this.viewer,cardId:selected.card.id,stat:data.get('stat'),...(data.get('mode')==='value'?{value:Number(data.get('delta'))}:{delta:Number(data.get('delta'))})});
    if(form.matches('[data-ygo-material]')&&selected?.player===this.viewer)await this.act({type:'attachMaterial',player:this.viewer,cardId:selected.card.id,targetId:data.get('targetId')});
    if(form.matches('[data-ygo-finish]')&&await this.options.confirm('Concludere il duello e condividere questo risultato con l’avversario?'))await this.act({type:'finish',winner:data.get('winner')==='draw'?'draw':Number(data.get('winner')),notes:data.get('notes')});
  }
  async place(player,to,slot){
    if(this.isAuto()){const option=autoPlaceOption(this.autoPrompt(),player,to,slot);if(option)await this.chooseAutoOption(option.id);return;}
    if(this.dropMenu||this.rulesDialog)return;
    const selected=this.selectedCard();if(this.pending||!selected||player!==this.viewer||selected.player!==player||!this.canControl(player)||this.session.phase==='setup'||!canMoveCardToZone(selected.card,to)){this.error='Scegli una tua carta adatta a questa zona.';this.render();return;}
    const placing=this.placing||{position:'attack',faceUp:true},cardId=selected.card.id;
    if(placing.zones&&!placing.zones.includes(to)||placing.to&&placing.to!==to){this.error='Scegli una posizione nella zona evidenziata.';this.render();return;}
    this.selected=null;this.inspectedCard=null;this.placing=null;
    await this.act(placing.summon?{type:'summon',player,...placing.summon,to,slot}:placing.activate?{type:'activate',player,cardId,playTo:to,slot}:{type:'move',player,cardId,to,slot,...(placing.position?{position:placing.position}:{}),faceUp:placing.faceUp!==false,...(placing.intent?{intent:placing.intent}:{}),...(placing.tributeIds?{tributeIds:placing.tributeIds}:{})});
  }
  async click(button,event){
    const data=button.dataset,command=data.ygoCommand,selected=this.selectedCard();
    if(!this.autoFrameCurrent(button))return;
    if(data.ygoPick!==undefined&&!this.session){this.pickLobbyValue(button);return;}
    if(data.ygoRedeal!==undefined){this.handSeed=(this.handSeed%9973)+Math.floor(Math.random()*97)+1;this.render();return;}
    if(data.ygoDropAction){await this.applyDropAction(data.ygoDropAction);return;}
    if(command==='close-rules'){this.rulesDialog=null;this.selected=null;this.inspectedCard=null;this.render();return;}
    if(command==='close-drop-menu'){this.dropMenu=null;this.selected=null;this.inspectedCard=null;this.render();return;}
    if(this.session&&this.orientation.isPortraitBlocked()&&!['orientation','lobby','practice-exit'].includes(command))return;
    if(command==='auto-close-reveals'){this.autoDismissedReveal=(this.session.auto?.revealedCards||[]).map(card=>card.revealId).join(':');this.render();return;}
    if(data.ygoAutoRevealIndex!==undefined){
      const card=this.session?.auto?.revealedCards?.[Number(data.ygoAutoRevealIndex)];if(!card)return;
      const player=card.controller===0||card.controller===1?card.controller:this.viewer;
      this.dropMenu=null;this.pile=null;this.menu=false;this.selected={player,cardId:card.id};this.inspectedCard={card,zone:'hand',player,version:this.duel.version};this.render();return;
    }
    if(data.ygoAutoOption!==undefined){await this.chooseAutoOption(data.ygoAutoOption);return;}
    if(command==='auto-confirm'){await this.respondAuto({optionIds:this.autoSelected});return;}
    if(command==='auto-counters'){await this.respondAuto({counts:this.autoCounts});return;}
    if(command==='auto-finish'){await this.respondAuto({optionId:'finish'});return;}
    if(command==='auto-cancel'){await this.respondAuto({optionId:'cancel'});return;}
    if(command==='auto-expand'||command==='auto-collapse'){this.autoExpanded=command==='auto-expand';this.render();return;}
    if(command==='auto-surrender'){if(await this.options.confirm('Vuoi arrenderti e assegnare la vittoria al compagno?'))await this.act({type:'surrender'});return;}
    if(command==='cancel-attack-selection'){this.attackSelection=null;this.render();return;}
    if(command==='attack-direct'){await this.chooseAttackTarget(null);return;}
    if(command==='battle-replay-select'){this.beginAttack(this.session.battle?.attackerId,{replay:true});return;}
    if(button.hasAttribute('data-ygo-battle-target')){if(Number(data.player)===1-this.viewer)await this.chooseAttackTarget({zone:data.zone,slot:Number(data.slot)});return;}
    if(command==='back-summon-position'){
      const menu=this.dropMenu;
      if(menu?.stage==='position'&&this.allowed()&&!this.pending&&this.canControl(menu.player)&&menu.player===this.viewer&&menu.duelId===this.duel?.id&&menu.version===this.duel?.version){this.dropMenu=menu.parentMenu;this.render();}
      return;
    }
    if(command==='orientation'){await this.orientation.enter({userGesture:true});this.render();return;}
    if(command==='practice-resume'){await this.resumePractice();return;}
    if(command==='practice-restart'&&this.practice&&this.isAuto()){this.menu=false;await this.startPractice(this.practiceDraft.deckId,'auto');return;}
    if(command==='practice-restart'&&this.practiceTable){this.menu=false;this.receive(this.practiceTable.restart().duel);this.render();return;}
    if(command==='practice-exit'){this.showPractice();return;}
    if(data.ygoOpen){await this.open(data.ygoOpen);return;}
    if(data.ygoResponse){await this.perform({op:data.ygoResponse,duelId:this.duel.id,expectedVersion:this.duel.version,requestId:crypto.randomUUID()});return;}
    if(data.ygoCard&&(this.placing?.summon?.materialIds.includes(data.ygoCard)||this.placing?.tributeIds?.includes(data.ygoCard))){const p=this.session.players[this.viewer];for(const zone of ['monsters','extraMonsters']){const card=p[zone].find(card=>card.id===data.ygoCard);if(card){await this.place(this.viewer,zone,card.slot);return;}}}
    if(data.ygoCard){const box=button.getBoundingClientRect?.();this.selectCard(Number(data.player),data.ygoCard,{quick:true,x:event?.detail?event.clientX:box?.right??20,y:event?.detail?event.clientY:box?.top??20,anchor:box?{left:box.left,right:box.right,top:box.top,bottom:box.bottom}:null});return;}
    if(button.hasAttribute('data-ygo-slot')){await this.place(Number(data.player),data.zone,Number(data.ygoSlot));return;}
    if(data.ygoTab==='practice'){this.showPractice();return;}
    if(data.ygoTab){this.attackSelection=null;if(data.ygoTab!=='table')this.activationReveals.clear();if(data.ygoTab==='history'&&this.practice)this.clearTable();if(!this.practice)this.options.onPracticeMode?.(false);this.tab=data.ygoTab;this.menu=false;this.selected=null;this.pile=null;this.inspectionGeneration++;if(this.tab==='history'){const response=await this.perform({op:'lobby'});if(response)this.lobby=response;}this.render();return;}
    if(command==='reload'){this.ready=false;await this.initialize();return;}
    if(command==='lobby'){this.clearTable();this.tab='table';this.options.onPracticeMode?.(false);const response=await this.perform({op:'lobby'});if(response&&this.allowed())this.lobby=response;this.render();return;}
    if(command==='menu'||command==='close-menu'){this.attackSelection=null;this.menu=command==='menu';this.selected=null;this.inspectedCard=null;this.pile=null;this.placing=null;this.inspectionGeneration++;this.render();return;}
    if(command==='deselect'||command==='cancel-place'||command==='close-pile'){this.attackSelection=null;this.selected=null;this.inspectedCard=null;this.pile=null;this.placing=null;this.inspectionGeneration++;this.render();return;}
    if(command==='cover-hand'){this.revealHand=!this.revealHand;this.selected=null;this.inspectedCard=null;this.render();return;}
    if(command==='metadata'){await this.fetchMetadata();return;}
    if(command==='inspect-deck'){await this.inspectDeck();return;}
    if(data.ygoMaterials&&this.isAuto()){
      const player=Number(data.player),p=this.session?.players[player],parent=p&&[...p.monsters,...p.extraMonsters].find(card=>card.id===data.ygoMaterials);
      if(!parent?.materials?.length)return;
      this.selected=null;this.inspectedCard=null;this.menu=false;this.placing=null;this.inspectionGeneration++;
      this.pile={player,zone:'monsters',cards:parent.materials,title:'Materiali Xyz'};this.render();return;
    }
    if(data.ygoPile){
      this.attackSelection=null;const player=Number(data.player),zone=data.ygoPile,p=this.session?.players[player];
      if(!p||!['deck','extra','side','graveyard','banished'].includes(zone)||zone==='side'&&player!==this.viewer)return;
      const publicTop=zone==='deck'&&this.isAuto()?p.deck.filter(card=>!card.hidden&&card.faceUp):null;
      if(zone==='deck'&&player!==this.viewer&&!publicTop?.length)return;
      this.selected=null;this.inspectedCard=null;this.menu=false;this.placing=null;this.inspectionGeneration++;
      this.pile={player,zone,...(publicTop?{cards:publicTop,title:publicTop.length?'Cima pubblica del mazzo':'Mazzo coperto'}:{})};this.render();return;
    }
    if(['summon','set-monster','special-summon'].includes(command)&&selected?.player===this.viewer){
      const id=selected.card.id,normal=selected.zone==='hand'&&!/ritual/i.test(selected.card.type)&&!getSummonKind(selected.card)&&!/(fusion|link)/i.test(selected.card.type);
      this.selectCard(this.viewer,id,{quick:true});await this.applyDropAction(command==='set-monster'?'set':command==='summon'&&normal?'normal':'special');return;
    }
    if(['summon','defend'].includes(command)&&selected?.zone==='extra'&&getSummonKind(selected.card)){this.openSummonDraft(selected.card.id,{position:command==='defend'?'defense':'attack'});return;}
    if(['summon','defend','set-monster','play-spell','set-spell','place-field','move-position'].includes(command)&&selected?.player===this.viewer){const monster=isMonster(selected.card)||['summon','defend','set-monster'].includes(command);this.placing={zones:['summon','defend','set-monster'].includes(command)?['monsters','extraMonsters']:undefined,to:command==='place-field'?'field':['play-spell','set-spell'].includes(command)?'spells':command==='move-position'?undefined:monster?undefined:'spells',position:['defend','set-monster'].includes(command)?'defense':'attack',faceUp:!['set-monster','set-spell'].includes(command),activate:command==='play-spell'};this.menu=false;this.render();return;}
    if(command==='to-graveyard'||command==='banish'||command==='return-hand'){if(selected?.player===this.viewer)await this.act({type:'move',player:this.viewer,cardId:selected.card.id,to:command==='to-graveyard'?'graveyard':command==='banish'?'banished':'hand',faceUp:true});return;}
    const action=data.ygoAction;if(!action||!this.session||this.pending)return;if(this.isAuto()&&action!=='ready')return;
    if((action==='nextTurn'||action==='nextPhase'&&this.session.phase==='end')&&getTurnState(this.session)&&this.session.activePlayer===this.viewer&&['main1','battle','main2','end'].includes(this.session.phase)&&!this.session.chain.length&&this.session.players[this.viewer].hand.length>6){
      this.rulesDialog={kind:'discard',cardIds:[],version:this.duel.version,duelId:this.duel.id};this.menu=false;this.dropMenu=null;this.selected=null;this.inspectedCard=null;this.render();return;
    }
    const payload={type:action,...(button.hasAttribute('data-player')?{player:Number(data.player)}:{})};
    if(['activate','flip','setPosition','positionEffect','stats','counter','detachMaterial'].includes(action)){if(selected?.player!==this.viewer)return;payload.player=this.viewer;payload.cardId=selected.card.id;}
    if(action==='activate'){await this.activateCard(this.viewer,selected.card.id);return;}
    if(action==='flip'&&selected?.card.faceUp&&isMonster(selected.card)){payload.type=getTurnState(this.session)?'positionEffect':'setPosition';payload.position='defense';payload.faceUp=false;}
    if(action==='setPhase')payload.phase=data.phase;
    if(action==='draw'||action==='drawEffect')payload.count=1;
    if(action==='normalAllowance')payload.delta=1;
    if(action==='shuffle')payload.zone='deck';
    if(action==='setPosition'||action==='positionEffect'){payload.position=data.position;payload.faceUp=data.faceUp!=='false';}
    if(action==='lp'||action==='counter')payload.delta=Number(data.delta);
    if(action==='stats'){payload.stat=data.stat;payload.delta=Number(data.delta);}
    if(action==='detachMaterial')payload.index=Number(data.index);
    if(action==='token'){payload.cardName='Segna-Mostro';payload.atk=0;payload.def=0;}
    await this.act(payload);
  }
}
