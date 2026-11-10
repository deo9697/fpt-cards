import { validateSimulatorDeck, ZONES, canMoveCardToZone, isMonster } from './simulator-engine.js';
import { arenaView, esc, cardView, actionButton, commandButton } from './simulator-arena.js';

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
    this.inviteDraft={opponentSlug:'',deckId:'',lp:8000,firstPlayer:'0'};this.acceptDraft={deckId:'',lp:8000};this.finishDraft={winner:'0',notes:''};
  }
  allowed(){const context=this.options.getContext();return !this.disposed&&context?.allowed===true&&scope(context)===this.scope;}
  get decks(){return(this.options.getDecks()||[]).filter(deck=>deck.game==='yugioh'&&(!deck.ownerSlug||deck.ownerSlug===this.context.member)&&deck.persisted!==false&&UUID.test(deck.id));}
  canControl(player){return player===this.viewer&&['setup','playing'].includes(this.duel?.status);}
  render(){if(this.allowed())this.options.onRender();}
  reset(){this.navigationGeneration++;this.inspectionGeneration++;clearTimeout(this.timer);this.disposed=true;this.ready=false;this.duel=null;this.session=null;this.selected=null;this.pile=null;this.inspectedCard=null;this.placing=null;this.menu=false;this.metadata.clear();}
  close(){this.reset();}
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
  schedule(){clearTimeout(this.timer);if(this.allowed()&&this.ready)this.timer=setTimeout(()=>void this.poll(),this.duel?2200:6000);}
  async poll(){
    if(!this.allowed())return;
    if(this.polling||this.pending||globalThis.document?.hidden||this.options.isVisible?.()===false){this.schedule();return;}
    const generation=this.navigationGeneration,id=this.duel?.id;this.polling=true;let changed=false;
    try{
      if(this.duel){const response=await this.options.call({op:'state',duelId:id,knownVersion:this.duel.version});if(!this.allowed()||generation!==this.navigationGeneration||id!==this.duel?.id)return;changed=(!response.unchanged&&this.receive(response.duel))||!this.connected;}
      if(!this.duel||Date.now()-this.lastLobby>12000){const response=await this.options.call({op:'lobby'});if(!this.allowed()||generation!==this.navigationGeneration)return;changed=changed||JSON.stringify(response)!==JSON.stringify(this.lobby);this.lobby=response;this.lastLobby=Date.now();}
      changed=changed||!this.connected;this.connected=true;
    }catch(error){if(this.allowed()&&generation===this.navigationGeneration){if([401,403,404,410].includes(error.status)){this.clearTable();if([401,403].includes(error.status))this.ready=false;}this.error=error.message||'Connessione interrotta. Riprovo automaticamente.';this.connected=false;changed=true;}}
    finally{this.polling=false;if(changed)this.render();this.schedule();}
  }
  clearTable(){this.navigationGeneration++;this.inspectionGeneration++;this.duel=null;this.session=null;this.selected=null;this.inspectedCard=null;this.pile=null;this.placing=null;this.menu=false;}
  receive(duel){
    if(!duel||!this.allowed()||(this.duel?.id===duel.id&&duel.version<this.duel.version))return false;
    const newTable=this.duel?.id!==duel.id||!this.session,changed=!this.duel||this.duel.id!==duel.id||this.duel.version!==duel.version;
    this.duel=duel;this.viewer=duel.viewer;this.session=['setup','playing','finished'].includes(duel.status)?duel.state||null:null;
    if(changed){this.selected=null;this.inspectedCard=null;this.pile=null;this.placing=null;}
    if(newTable){this.menu=false;this.revealHand=true;this.finishDraft={winner:String(this.viewer),notes:''};}
    return changed;
  }
  async perform(payload){
    if(!this.ready||!this.allowed()||this.pending)return null;
    const generation=this.navigationGeneration;this.pending=true;this.error='';this.render();
    try{const response=await this.options.call(payload);if(!this.allowed()||generation!==this.navigationGeneration)return null;if(response.duel)this.receive(response.duel);this.connected=true;return response;}
    catch(error){if(this.allowed()&&generation===this.navigationGeneration){if(error.data?.duel)this.receive(error.data.duel);this.error=error.message||'Operazione non riuscita. Riprova.';if([401,403].includes(error.status))this.connected=false;}return null;}
    finally{this.pending=false;this.render();this.schedule();}
  }
  async open(id){if(this.pending||!UUID.test(id))return;this.navigationGeneration++;this.inspectionGeneration++;this.selected=null;this.pile=null;this.inspectedCard=null;this.placing=null;this.menu=false;this.tab='table';await this.perform({op:'state',duelId:id});}
  async act(action){if(!this.duel||!this.session||!this.allowed()||this.pending)return null;if(action.player!==undefined&&action.player!==this.viewer){this.error='Puoi modificare soltanto le tue carte.';this.render();return null;}return this.perform({op:'action',duelId:this.duel.id,expectedVersion:this.duel.version,requestId:crypto.randomUUID(),action});}
  selectedCard(){
    if(!this.selected||!this.session)return null;
    if(this.inspectedCard&&this.inspectedCard.version===this.duel.version&&this.inspectedCard.player===this.selected.player&&this.inspectedCard.card.id===this.selected.cardId)return this.inspectedCard;
    const player=this.session.players[this.selected.player];if(!player)return null;
    for(const zone of [...ZONES,'side']){const card=player[zone]?.find(card=>card.id===this.selected.cardId);if(card&&!card.hidden&&!(zone==='deck')&&!(zone==='hand'&&this.selected.player===this.viewer&&!this.revealHand))return{card,zone,player:this.selected.player};}
    return null;
  }
  selectCard(player,cardId){
    const card=this.pile&&(this.pile.cards||this.session.players[this.pile.player]?.[this.pile.zone])?.find(card=>card.id===cardId);
    this.inspectedCard=card&&!card.hidden?{card,zone:this.pile.zone,player:this.pile.player,version:this.duel.version}:null;
    this.selected={player,cardId};this.pile=null;this.menu=false;this.placing=null;
    if(!this.selectedCard())this.selected=null;
    this.render();
    globalThis.document?.querySelector('.ygo-card-dialog')?.focus({preventScroll:true});
  }
  async inspectDeck(){
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
    return`<section class="ygo-simulator page-stack"><header class="page-header"><div><span class="eyebrow">// Yu-Gi-Oh! · Team</span><h1>Arena del Duellante</h1><p>Un tavolo privato per mettere alla prova i tuoi mazzi.</p></div><span class="ygo-private">Multiplayer manuale</span></header><nav class="ygo-tabs" aria-label="Simulatore">${[['table','Tavolo'],['rules','Regole'],['history','Test e statistiche']].map(([id,name])=>`<button type="button" data-ygo-tab="${id}" class="${id===this.tab?'is-current':''}">${name}</button>`).join('')}</nav>${this.error?`<p class="ygo-error" role="alert">${esc(this.error)}</p>`:''}${!this.ready?`<section class="surface ygo-lobby" aria-busy="${this.loading}"><p>${this.loading?'Caricamento del team e dei mazzi…':'Entra nell’arena privata del team.'}</p>${commandButton('reload',this.error?'Riprova':'Carica tavolo',this.loading)}</section>`:this.tab==='rules'?this.rulesView():this.tab==='history'?this.historyView():this.duel?this.waitingView():this.lobbyView()}</section>`;
  }
  lobbyView(){
    const opponents=this.lobby.members.filter(member=>member.slug!==this.context.member),opponent=opponents.find(member=>member.slug===this.inviteDraft.opponentSlug),deck=this.decks.find(deck=>deck.id===this.inviteDraft.deckId);
    const rows=this.lobby.duels.filter(row=>['waiting','setup','playing'].includes(row.status));
    return`<section class="ygo-lobby surface"><div class="ygo-lobby-title"><span>PRIVATE DUEL</span><h2>Il prossimo duello inizia qui.</h2><p>Scegli il tuo mazzo e invita un compagno del team.</p></div><form data-ygo-invite><div class="ygo-versus"><div class="ygo-versus-side"><small>IL TUO MAZZO</small><label>Mazzo<select name="deckId" required>${this.deckOptions(this.inviteDraft.deckId)}</select></label>${this.deckSummary(deck)}${!this.decks.length?'<button type="button" class="btn secondary" data-page="decks">Apri i mazzi</button>':''}</div><b class="ygo-versus-mark" aria-hidden="true">VS</b><div class="ygo-versus-side"><small>IL TUO AVVERSARIO</small><label>Membro del team<select name="opponentSlug" required><option value="">Scegli un compagno</option>${opponents.map(member=>`<option value="${esc(member.slug)}" ${member.slug===this.inviteDraft.opponentSlug?'selected':''}>${esc(member.name)}</option>`).join('')}</select></label><p>${opponent?`${esc(opponent.name)} sceglierà il proprio mazzo accettando l’invito.`:'Il tavolo resta privato tra voi due.'}</p>${opponent?`<small>${opponent.pushEnabled?'Notifiche attive · riceve l’invito':'L’invito sarà disponibile qui in Altro'}</small>`:''}</div></div><div class="ygo-lobby-settings"><label>LP iniziali<input name="lp" type="number" min="1" max="999999" step="1" required value="${esc(this.inviteDraft.lp)}"></label><label>Chi inizia<select name="firstPlayer"><option value="0" ${this.inviteDraft.firstPlayer==='0'?'selected':''}>Tu</option><option value="1" ${this.inviteDraft.firstPlayer==='1'?'selected':''}>Il compagno</option></select></label><button type="submit" class="ygo-primary" ${this.pending||!this.decks.length||!opponents.length?'disabled':''}>Invita al duello</button></div></form></section><section class="ygo-invitations"><h2>Inviti e duelli</h2>${rows.length?rows.map(row=>this.invitationView(row)).join(''):'<div class="surface"><p>Nessun duello in corso. Invita un compagno per iniziare.</p></div>'}</section>`;
  }
  invitationView(row){const name=row.viewer===0?row.guestName:row.hostName;return`<article class="surface ygo-invitation"><div><small>${esc(status[row.status]||row.status)}</small><h3>${esc(name)}</h3><p>${esc([row.hostDeckName,row.guestDeckName].filter(Boolean).join(' vs '))}</p></div><button type="button" class="ygo-primary" data-ygo-open="${esc(row.id)}" ${this.pending?'disabled':''}>${row.status==='waiting'?'Apri invito':'Rientra al tavolo'}</button></article>`;}
  waitingView(){const d=this.duel;if(d.status==='waiting'&&d.viewer===1)return`<section class="surface ygo-lobby"><span class="eyebrow">// Sfida del team</span><h2>${esc(d.hostName)} ti invita a duellare</h2><p>Il suo mazzo: ${esc(d.hostDeckName||'Yu-Gi-Oh!')}</p><form data-ygo-accept><label>Il tuo mazzo<select name="deckId" required>${this.deckOptions(this.acceptDraft.deckId)}</select></label>${this.deckSummary(this.decks.find(deck=>deck.id===this.acceptDraft.deckId))}<label>I tuoi LP iniziali<input type="number" name="lp" min="1" max="999999" step="1" required value="${esc(this.acceptDraft.lp)}"></label><div class="ygo-form-actions"><button type="submit" class="ygo-primary" ${this.pending||!this.decks.length?'disabled':''}>Accetta il duello</button><button type="button" data-ygo-response="decline" ${this.pending?'disabled':''}>Rifiuta</button></div></form>${commandButton('lobby','Torna agli inviti')}</section>`;return`<section class="surface ygo-lobby"><h2>${esc(d.hostName)} <span class="ygo-muted">vs</span> ${esc(d.guestName)}</h2><p>${d.status==='waiting'?`Invito inviato. Aspettiamo che ${esc(d.guestName)} scelga il mazzo.`:esc(status[d.status]||'Tavolo non disponibile.')}</p>${d.status==='waiting'&&d.viewer===0?'<button type="button" data-ygo-response="cancel">Annulla invito</button>':''}${commandButton('lobby','Torna agli inviti')}</section>`;}
  historyView(){const rows=this.lobby.duels.filter(row=>row.status==='finished'&&row.result),wins=rows.filter(row=>row.result.winner===row.viewer).length,draws=rows.filter(row=>row.result.winner==='draw').length;return`<section class="surface ygo-lobby"><h2>I test del tuo team</h2><p>${rows.length} duelli · ${wins} vittorie · ${draws} pareggi · ${rows.length?Math.round(wins/rows.length*100):0}% vittorie</p>${rows.map(row=>`<article class="ygo-history-row"><div><h3>${esc(row.hostName)} vs ${esc(row.guestName)}</h3><p>${row.result.winner==='draw'?'Pareggio':`Vince ${esc(row.result.winner===0?row.hostName:row.guestName)}`}</p><small>${esc(row.result.notes||'')}</small></div><button type="button" data-ygo-open="${esc(row.id)}">Apri tavolo</button></article>`).join('')||'<p>Concludi un duello per registrare il primo test.</p>'}</section>`;}
  rulesView(){return`<section class="surface ygo-lobby ygo-rules"><h2>Il tuo tavolo, le tue decisioni</h2><p>Il simulatore gestisce carte, posizioni, LP e registro. Risolvi manualmente evocazioni, tributi, costi, effetti, attacchi, catene e timing.</p><details open><summary>Preparazione e turno</summary><p>Entrambi iniziano con cinque carte. Chi inizia salta la prima pescata; nel primo turno non si svolge la Battle Phase. I pulsanti fase cambiano l’indicatore, senza pescare o eseguire effetti.</p></details><details><summary>Carte e zone</summary><p>Seleziona una carta nella mano o nell’Extra Deck e scegli una posizione libera. Puoi evocare, posizionare coperto, cambiare posizione, mandare al Cimitero o bandire. Le carte coperte dell’avversario restano private.</p></details><details><summary>Extra Deck e materiali Xyz</summary><p>Le due Zone Mostri Extra sono condivise. Rispetta manualmente requisiti di evocazione e frecce Link. Dal pannello di una tua carta puoi aggiungerla come materiale di un tuo mostro Xyz; dal mostro puoi staccare i materiali.</p></details><details><summary>Attivazioni e catene</summary><p>Attiva una carta per mostrarla e registrare l’anello. Risolvi gli anelli dall’ultimo e applica manualmente gli effetti. Ricordati di spostare Magie e Trappole al Cimitero quando previsto.</p></details><p><a href="https://www.yugioh-card.com/eu/it/play/" target="_blank" rel="noopener noreferrer">Regole ufficiali Yu-Gi-Oh!</a></p></section>`;}
  bind(root){
    if(!this.allowed())return;const element=root.querySelector('.ygo-simulator');if(!element||element.dataset.bound)return;element.dataset.bound='true';if(!this.ready&&!this.error)void this.initialize();
    element.addEventListener('input',event=>this.updateDraft(event.target));
    element.addEventListener('change',event=>{this.updateDraft(event.target);if(['deckId','opponentSlug'].includes(event.target.name))this.render();});
    element.addEventListener('submit',event=>{event.preventDefault();if(this.allowed())void this.submit(event.target);});
    element.addEventListener('click',event=>{const button=event.target.closest('button');if(button&&!button.disabled&&this.allowed())void this.click(button);});
    element.addEventListener('keydown',event=>{if(event.key==='Escape'){this.inspectionGeneration++;this.selected=null;this.inspectedCard=null;this.pile=null;this.menu=false;this.placing=null;this.render();}});
    element.addEventListener('dragstart',event=>{const card=event.target.closest('[data-ygo-card][draggable=true]');if(!card||!event.dataTransfer||this.pending||!this.session)return;this.selected={player:this.viewer,cardId:card.dataset.ygoCard};event.dataTransfer.setData('application/x-fpt-yugioh',JSON.stringify({cardId:card.dataset.ygoCard,player:this.viewer,duelId:this.duel.id,version:this.duel.version}));event.dataTransfer.effectAllowed='move';});
    element.addEventListener('dragover',event=>{if(event.target.closest('[data-ygo-slot]')?.dataset.player===String(this.viewer))event.preventDefault();});
    element.addEventListener('drop',event=>{const target=event.target.closest('[data-ygo-slot]');if(!target||!event.dataTransfer||!this.allowed())return;event.preventDefault();try{const data=JSON.parse(event.dataTransfer.getData('application/x-fpt-yugioh'));if(data.duelId!==this.duel?.id||data.version!==this.duel.version||data.player!==this.viewer)return;this.selected={player:data.player,cardId:data.cardId};this.placing={position:'attack',faceUp:true};void this.place(Number(target.dataset.player),target.dataset.zone,Number(target.dataset.ygoSlot));}catch{/* Drops from outside this duel have no effect. */}});
  }
  updateDraft(field){if(!this.allowed()||!field.name)return;const draft=field.closest('[data-ygo-invite]')?this.inviteDraft:field.closest('[data-ygo-accept]')?this.acceptDraft:field.closest('[data-ygo-finish]')?this.finishDraft:null;if(draft&&Object.hasOwn(draft,field.name))draft[field.name]=field.value;}
  async submit(form){
    if(this.pending||!this.ready||!this.allowed())return;const data=new FormData(form),selected=this.selectedCard();
    if(form.matches('[data-ygo-invite]')){this.inviteRequestId||=crypto.randomUUID();const result=await this.perform({op:'invite',requestId:this.inviteRequestId,opponentSlug:data.get('opponentSlug'),deckId:data.get('deckId'),lp:Number(data.get('lp')),firstPlayer:Number(data.get('firstPlayer'))});if(result){this.inviteRequestId=null;this.options.onToast(result.notification?.push==='sent'?'Invito inviato · notifica spedita':'Invito inviato al compagno del team');}}
    if(form.matches('[data-ygo-accept]'))await this.perform({op:'accept',duelId:this.duel.id,expectedVersion:this.duel.version,requestId:crypto.randomUUID(),deckId:data.get('deckId'),lp:Number(data.get('lp'))});
    if(form.matches('[data-ygo-move]')&&selected?.player===this.viewer)await this.act({type:'move',player:this.viewer,cardId:selected.card.id,to:data.get('to'),placement:data.get('placement')||'top',faceUp:data.get('faceUp')!=='false',position:data.get('position')||'attack'});
    if(form.matches('[data-ygo-lp]'))await this.act({type:'lp',player:this.viewer,delta:Number(data.get('delta'))});
    if(form.matches('[data-ygo-stats]')&&selected?.player===this.viewer)await this.act({type:'stats',player:this.viewer,cardId:selected.card.id,stat:data.get('stat'),delta:Number(data.get('delta'))});
    if(form.matches('[data-ygo-material]')&&selected?.player===this.viewer)await this.act({type:'attachMaterial',player:this.viewer,cardId:selected.card.id,targetId:data.get('targetId')});
    if(form.matches('[data-ygo-finish]')&&await this.options.confirm('Concludere il duello e condividere questo risultato con l’avversario?'))await this.act({type:'finish',winner:data.get('winner')==='draw'?'draw':Number(data.get('winner')),notes:data.get('notes')});
  }
  async place(player,to,slot){
    const selected=this.selectedCard();if(this.pending||!selected||player!==this.viewer||selected.player!==player||!this.canControl(player)||this.session.phase==='setup'||!canMoveCardToZone(selected.card,to)){this.error='Scegli una tua carta adatta a questa zona.';this.render();return;}
    const placing=this.placing||{position:'attack',faceUp:true},cardId=selected.card.id;
    if(placing.zones&&!placing.zones.includes(to)||placing.to&&placing.to!==to){this.error='Scegli una posizione nella zona evidenziata.';this.render();return;}
    const result=await this.act({type:'move',player,cardId,to,slot,...(placing.position?{position:placing.position}:{}),faceUp:placing.faceUp!==false});
    if(result&&placing.activate)await this.act({type:'activate',player,cardId});
  }
  async click(button){
    const data=button.dataset,command=data.ygoCommand,selected=this.selectedCard();
    if(data.ygoOpen){await this.open(data.ygoOpen);return;}
    if(data.ygoResponse){await this.perform({op:data.ygoResponse,duelId:this.duel.id,expectedVersion:this.duel.version,requestId:crypto.randomUUID()});return;}
    if(data.ygoCard){this.selectCard(Number(data.player),data.ygoCard);return;}
    if(button.hasAttribute('data-ygo-slot')){await this.place(Number(data.player),data.zone,Number(data.ygoSlot));return;}
    if(data.ygoTab){this.tab=data.ygoTab;this.menu=false;this.selected=null;this.pile=null;this.inspectionGeneration++;if(this.tab==='history'){const response=await this.perform({op:'lobby'});if(response)this.lobby=response;}this.render();return;}
    if(command==='reload'){this.ready=false;await this.initialize();return;}
    if(command==='lobby'){this.clearTable();this.tab='table';const response=await this.perform({op:'lobby'});if(response&&this.allowed())this.lobby=response;this.render();return;}
    if(command==='menu'||command==='close-menu'){this.menu=command==='menu';this.selected=null;this.inspectedCard=null;this.pile=null;this.placing=null;this.inspectionGeneration++;this.render();return;}
    if(command==='deselect'||command==='cancel-place'||command==='close-pile'){this.selected=null;this.inspectedCard=null;this.pile=null;this.placing=null;this.inspectionGeneration++;this.render();return;}
    if(command==='cover-hand'){this.revealHand=!this.revealHand;this.selected=null;this.inspectedCard=null;this.render();return;}
    if(command==='metadata'){await this.fetchMetadata();return;}
    if(command==='inspect-deck'){await this.inspectDeck();return;}
    if(data.ygoPile){const player=Number(data.player),zone=data.ygoPile;if(!this.session?.players[player]||!['deck','extra','side','graveyard','banished'].includes(zone)||(zone==='deck'||zone==='side')&&player!==this.viewer)return;this.selected=null;this.inspectedCard=null;this.menu=false;this.placing=null;this.inspectionGeneration++;this.pile={player,zone};this.render();return;}
    if(['summon','defend','set-monster','play-spell','set-spell','place-field','move-position'].includes(command)&&selected?.player===this.viewer){const monster=isMonster(selected.card)||['summon','defend','set-monster'].includes(command);this.placing={zones:['summon','defend','set-monster'].includes(command)?['monsters','extraMonsters']:undefined,to:command==='place-field'?'field':['play-spell','set-spell'].includes(command)?'spells':command==='move-position'?undefined:monster?undefined:'spells',position:['defend','set-monster'].includes(command)?'defense':'attack',faceUp:!['set-monster','set-spell'].includes(command),activate:command==='play-spell'};this.menu=false;this.render();return;}
    if(command==='to-graveyard'||command==='banish'||command==='return-hand'){if(selected?.player===this.viewer)await this.act({type:'move',player:this.viewer,cardId:selected.card.id,to:command==='to-graveyard'?'graveyard':command==='banish'?'banished':'hand',faceUp:true});return;}
    const action=data.ygoAction;if(!action||!this.session||this.pending)return;
    const payload={type:action,...(button.hasAttribute('data-player')?{player:Number(data.player)}:{})};
    if(['activate','flip','setPosition','stats','counter','detachMaterial'].includes(action)){if(selected?.player!==this.viewer)return;payload.player=this.viewer;payload.cardId=selected.card.id;}
    if(action==='flip'&&selected?.card.faceUp&&isMonster(selected.card)&&selected.card.position==='attack'){payload.type='setPosition';payload.position='defense';payload.faceUp=false;}
    if(action==='draw')payload.count=1;
    if(action==='shuffle')payload.zone='deck';
    if(action==='setPosition'){payload.position=data.position;payload.faceUp=data.faceUp!=='false';}
    if(action==='lp'||action==='counter')payload.delta=Number(data.delta);
    if(action==='stats'){payload.stat=data.stat;payload.delta=Number(data.delta);}
    if(action==='detachMaterial')payload.index=Number(data.index);
    if(action==='token'){payload.cardName='Segna-Mostro';payload.atk=0;payload.def=0;}
    await this.act(payload);
  }
}
