import { OnePieceSimulator } from './simulator.js';
import { validateSimulatorDeck, PHASES } from './simulator-engine.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const phases = { setup:'Preparazione', refresh:'Refresh', draw:'Draw', don:'DON!!', main:'Main', end:'End' };
const zones = { leader:'Leader', characters:'Personaggi', stage:'Stage', hand:'Mano', life:'Life', deck:'Mazzo', trash:'Trash' };
const actionButton = (type, text, player, disabled = false) => `<button type="button" class="btn secondary" data-op-action="${type}" ${player == null ? '' : `data-player="${player}"`} ${disabled ? 'disabled' : ''}>${text}</button>`;
const statusNames = { waiting:'Invito in attesa', setup:'Preparazione', playing:'In partita', finished:'Test concluso', declined:'Invito rifiutato', cancelled:'Invito annullato' };

export class OnePieceMultiplayer extends OnePieceSimulator {
  constructor(options) {
    super(options);
    this.lobby = { members:[], duels:[] };
    this.duel = null;
    this.viewer = null;
    this.pending = false;
    this.connected = true;
    this.timer = null;
    this.polling = false;
    this.lastLobby = 0;
    this.inviteDraft = { opponentSlug:'', deckId:'', lifeCount:5, firstPlayer:'0' };
    this.acceptDraft = { deckId:'', lifeCount:5 };
    this.finishDraft = { winner:'0', notes:'' };
    this.inviteRequestId = null;
    this.privateLife = null;
    this.requested = '';
    this.navigationGeneration = 0;
    this.inspectionGeneration = 0;
  }
  get decks() { return super.decks.filter(deck => deck.persisted !== false && UUID.test(deck.id)); }
  canControl(player) { return player === this.viewer && ['setup','playing'].includes(this.duel?.status); }
  persist() { /* Shared tables are persisted by the server, never in browser storage. */ }
  close() { this.reset(); }
  reset() { this.navigationGeneration++; clearTimeout(this.timer); this.duel = null; this.privateLife = null; super.reset(); }
  async initialize() {
    if (this.loading || this.ready || !this.allowed()) return;
    this.loading = true; this.error = '';
    try {
      if (!await this.options.verifyAccess()) throw new Error('Accedi con il tuo profilo del team.');
      await this.options.loadDecks();
      if (!this.allowed()) return;
      const response = await this.options.call({ op:'lobby' });
      if (!this.allowed()) return;
      this.lobby = response; this.lastLobby = Date.now(); this.ready = true; this.connected = true;
      await this.openRequested();
    } catch (error) { if (this.allowed()) { this.error = error.message || 'Multiplayer non disponibile. Riprova tra poco.'; this.connected = false; } }
    finally { this.loading = false; this.render(); this.schedule(); }
  }
  async openRequested() {
    const id = this.options.requestedDuel?.() || '';
    if (!this.ready || !UUID.test(id) || id === this.requested) return;
    this.requested = id;
    await this.open(id);
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.allowed() || !this.ready) return;
    this.timer = setTimeout(() => { void this.poll(); }, this.duel ? 2200 : 6000);
  }
  async poll() {
    if (!this.allowed()) return;
    if (this.polling || this.pending || globalThis.document?.hidden || this.options.isVisible?.() === false) { this.schedule(); return; }
    this.polling = true;
    const generation = this.navigationGeneration, requestedId = this.duel?.id;
    let changed = false;
    try {
      if (this.duel) {
        const response = await this.options.call({ op:'state', duelId:this.duel.id, knownVersion:this.duel.version });
        if (!this.allowed() || generation !== this.navigationGeneration || this.duel?.id !== requestedId) return;
        changed = (response.unchanged ? false : this.receive(response.duel)) || !this.connected;
      }
      if (!this.duel || Date.now() - this.lastLobby > 12000) {
        const lobby = await this.options.call({ op:'lobby' });
        if (!this.allowed() || generation !== this.navigationGeneration) return;
        changed = changed || JSON.stringify([this.lobby.members, this.lobby.duels]) !== JSON.stringify([lobby.members, lobby.duels]);
        this.lobby = lobby; this.lastLobby = Date.now();
      }
      if (!this.connected) changed = true;
      this.connected = true;
    } catch (error) {
      if (this.allowed() && generation === this.navigationGeneration) {
        if ([401,403,404,410].includes(error.status)) {
          this.navigationGeneration++; this.inspectionGeneration++;
          this.duel = null; this.session = null; this.selected = null; this.pile = null; this.privateLife = null;
          this.error = error.message || 'Il tavolo non è più disponibile per il tuo profilo.';
          if ([401,403].includes(error.status)) this.ready = false;
        }
        this.connected = false; changed = true;
      }
    }
    finally { this.polling = false; if (changed) this.render(); this.schedule(); }
  }
  receive(duel) {
    if (!duel || !this.allowed()) return false;
    if (this.duel?.id === duel.id && duel.version < this.duel.version) return false;
    const changed = !this.duel || this.duel.id !== duel.id || this.duel.version !== duel.version;
    const newTable = this.duel?.id !== duel.id || !this.session;
    this.duel = duel; this.viewer = duel.viewer;
    this.session = ['setup','playing','finished'].includes(duel.status) ? duel.state || null : null;
    if (changed) { this.inspectionGeneration++; this.selected = null; this.pile = null; this.privateLife = null; this.peekLife = [false, false]; }
    if (newTable && [0, 1].includes(this.viewer)) {
      this.revealHands = [false, false]; this.revealHands[this.viewer] = true;
      this.finishDraft = { winner:String(this.viewer), notes:'' };
      this.playerFocus = globalThis.matchMedia?.('(max-width: 700px)').matches ? String(this.viewer) : 'both';
    }
    return changed;
  }
  async perform(payload) {
    if (!this.ready || !this.allowed() || this.pending) return null;
    const generation = this.navigationGeneration;
    this.pending = true; this.error = ''; this.render();
    try {
      const response = await this.options.call(payload);
      if (!this.allowed() || generation !== this.navigationGeneration) return null;
      if (response.duel) this.receive(response.duel);
      this.connected = true;
      return response;
    } catch (error) {
      if (this.allowed() && generation === this.navigationGeneration) {
        if (error.data?.duel) this.receive(error.data.duel);
        this.error = error.message || 'Operazione non riuscita. Riprova.';
      }
      return null;
    } finally { this.pending = false; this.render(); this.schedule(); }
  }
  async open(id) { if (this.pending) return; this.navigationGeneration++; this.selected = null; this.tab = 'table'; await this.perform({ op:'state', duelId:id }); }
  async act(action) {
    if (!this.duel || !this.session || !this.allowed()) return;
    if (Object.hasOwn(action, 'player') && action.player !== this.viewer) { this.error = 'Puoi muovere soltanto le tue carte.'; this.render(); return; }
    await this.perform({ op:'action', duelId:this.duel.id, expectedVersion:this.duel.version, requestId:crypto.randomUUID(), action });
  }
  view() {
    if (!this.allowed()) return '<section class="op-simulator"><div class="surface">Il simulatore è riservato ai membri del team nella sezione One Piece.</div></section>';
    const connected = this.connected ? 'Connesso' : 'Riconnessione in corso';
    return `<section class="op-simulator page-stack ${this.session ? 'is-playing' : ''}" aria-label="Simulatore multiplayer One Piece"><header class="page-header op-sim-header"><div><span class="eyebrow">// One Piece · Team</span><h1>Simulatore One Piece</h1><p>Invita un compagno e prova il tuo mazzo. Ogni mossa resta manuale.</p></div><span class="op-sim-badge">Multiplayer privato</span></header><div class="op-sim-tabs" role="tablist" aria-label="Simulatore">${[['table','Tavolo'],['rules','Regole e ruling'],['history','Test e statistiche']].map(([id, name]) => `<button type="button" role="tab" aria-selected="${this.tab === id}" class="${this.tab === id ? 'active' : ''}" data-op-tab="${id}">${name}</button>`).join('')}</div>${this.error ? `<p class="op-sim-error" role="alert">${esc(this.error)}</p>` : ''}${this.ready ? `<p class="op-sim-connection ${this.connected ? 'is-connected' : 'is-offline'}" role="status">${this.pending ? 'Sincronizzazione…' : connected}${this.duel ? ` · ${esc(statusNames[this.duel.status] || '')}` : ''}</p>` : ''}${!this.ready ? `<section class="op-sim-panel surface" aria-busy="${this.loading}"><p>${this.loading ? 'Caricamento del team e delle partite…' : 'Entra nel tavolo privato del team.'}</p><button type="button" class="btn secondary" data-op-command="reload" ${this.loading ? 'disabled' : ''}>${this.error ? 'Riprova' : 'Carica tavolo'}</button></section>` : this.tab === 'rules' ? this.rulesView() : this.tab === 'history' ? this.historyView() : this.duel ? this.session ? this.tableView() : this.waitingView() : this.lobbyView()}</section>`;
  }
  deckOptions(value) { return `<option value="">Scegli il tuo mazzo</option>${this.decks.map(deck => `<option value="${esc(deck.id)}" ${deck.id === value ? 'selected' : ''}>${esc(deck.name)}</option>`).join('')}`; }
  memberName(slug) { return this.lobby.members.find(member => member.slug === slug)?.name || this.options.getMembers?.().find(member => (member.id || member.slug) === slug)?.name || slug; }
  lobbyView() {
    const opponents = this.lobby.members.filter(member => member.slug !== this.context.member);
    const selected = opponents.find(member => member.slug === this.inviteDraft.opponentSlug);
    const deck = this.decks.find(item => item.id === this.inviteDraft.deckId);
    const validation = deck ? validateSimulatorDeck(deck) : null;
    const rows = this.lobby.duels.filter(duel => ['waiting', 'setup', 'playing'].includes(duel.status));
    return `<section class="op-sim-panel surface"><h2>Invita al tavolo</h2><p>Tu scegli il tuo mazzo; il compagno sceglierà il suo quando accetta.</p><form class="op-sim-setup" data-op-invite><fieldset class="op-sim-deck-picker"><legend>Tu · ${esc(this.memberName(this.context.member))}</legend><label>Il tuo mazzo<select name="deckId" required>${this.deckOptions(this.inviteDraft.deckId)}</select></label><label>Life del tuo Leader<input name="lifeCount" type="number" required min="1" max="10" step="1" value="${esc(this.inviteDraft.lifeCount)}"></label>${validation && !validation.valid ? `<p class="op-sim-validation">${validation.errors.map(esc).join('<br>')}</p>` : ''}${!this.decks.length ? '<p>Salva un mazzo One Piece completo nella sezione Mazzi per poter giocare.</p><button type="button" class="btn secondary" data-page="decks">Apri i mazzi</button>' : ''}</fieldset><fieldset class="op-sim-deck-picker"><legend>Il tuo avversario</legend><label>Membro del team<select name="opponentSlug" required><option value="">Scegli un compagno</option>${opponents.map(member => `<option value="${esc(member.slug)}" ${member.slug === this.inviteDraft.opponentSlug ? 'selected' : ''}>${esc(member.name)}</option>`).join('')}</select></label>${selected ? `<div class="op-sim-member-summary"><span class="op-sim-member-avatar" aria-hidden="true">${esc(selected.name.slice(0, 2).toUpperCase())}</span><div><strong>${esc(selected.name)}</strong><small>${selected.pushEnabled ? 'Notifiche configurate · invito con push' : 'Invito disponibile qui in Altro'}</small></div></div>` : '<p>Scegli una persona del tuo team per invitarla a una partita privata.</p>'}<label>Chi inizia?<select name="firstPlayer"><option value="0" ${this.inviteDraft.firstPlayer === '0' ? 'selected' : ''}>Tu</option><option value="1" ${this.inviteDraft.firstPlayer === '1' ? 'selected' : ''}>Il compagno</option></select></label></fieldset><div class="op-sim-setup-actions"><button type="submit" class="btn" ${this.pending || !this.decks.length || !opponents.length ? 'disabled' : ''}>Invita al tavolo</button></div></form></section><section class="op-sim-lobby"><h2>Inviti e partite</h2>${rows.length ? rows.map(duel => this.invitationView(duel)).join('') : '<div class="op-sim-panel op-sim-empty surface"><p>Nessun invito in attesa. Scegli un compagno per iniziare.</p></div>'}</section>`;
  }
  invitationView(duel) {
    const other = duel.viewer === 0 ? duel.guestName : duel.hostName;
    return `<article class="op-sim-panel op-sim-invite surface"><div><small>${esc(statusNames[duel.status] || duel.status)}</small><h3>${esc(other)}</h3><p>${duel.viewer === 0 ? 'Il tuo invito' : 'Ti ha invitato a giocare'} · One Piece</p></div><button type="button" class="btn secondary" data-op-open="${esc(duel.id)}" ${this.pending ? 'disabled' : ''}>${duel.status === 'waiting' ? 'Apri invito' : 'Rientra al tavolo'}</button></article>`;
  }
  waitingView() {
    const d = this.duel, waiting = d.status === 'waiting';
    return `<section class="op-sim-panel op-sim-waiting surface"><span class="eyebrow">// Tavolo privato</span><h2>${esc(d.hostName)} vs ${esc(d.guestName)}</h2>${waiting ? d.viewer === 0 ? `<p>Invito inviato. Aspettiamo che ${esc(d.guestName)} scelga il suo mazzo.</p><button type="button" class="btn secondary" data-op-response="cancel" data-duel="${esc(d.id)}" ${this.pending ? 'disabled' : ''}>Annulla invito</button>` : `<p>${esc(d.hostName)} ti invita a un test One Piece. Scegli il tuo mazzo per entrare.</p><form data-op-accept><label>Il tuo mazzo<select name="deckId" required>${this.deckOptions(this.acceptDraft.deckId)}</select></label><label>Life del tuo Leader<input type="number" name="lifeCount" required min="1" max="10" step="1" value="${esc(this.acceptDraft.lifeCount)}"></label><div class="op-sim-actions"><button class="btn" type="submit" ${this.pending || !this.decks.length ? 'disabled' : ''}>Accetta e scegli il mazzo</button><button type="button" class="btn secondary" data-op-response="decline" data-duel="${esc(d.id)}" ${this.pending ? 'disabled' : ''}>Rifiuta invito</button></div></form>` : `<p>${esc(statusNames[d.status] || 'Tavolo non disponibile')}</p>`}<button type="button" class="btn secondary" data-op-command="lobby">Torna agli inviti</button></section>`;
  }
  tableView() {
    const s = this.session, d = this.duel, setup = s.phase === 'setup', ended = Boolean(s.result), myTurn = s.activePlayer === this.viewer;
    return `<div class="op-sim-toolbar"><div><strong>${setup ? 'Preparazione · Mulligan' : `Turno ${s.turn} · ${esc(s.players[s.activePlayer].name)}`}</strong><small>${setup ? 'Controlla la tua mano, poi conferma quando sei pronto.' : myTurn ? 'È il tuo turno. Risolvi manualmente azioni ed effetti.' : 'Turno dell’avversario. Puoi risolvere Counter ed effetti sul tuo campo.'}</small></div><button type="button" class="btn secondary" data-op-command="lobby">Inviti e partite</button></div>${setup ? `<section class="op-sim-panel surface"><div class="op-sim-actions">${actionButton('ready', d.ready?.[this.viewer] ? 'Sei pronto · attesa avversario' : 'Sono pronto · inizia il duello', this.viewer, this.pending || d.ready?.[this.viewer])}</div><p>Le Life vengono distribuite quando entrambi siete pronti.</p></section>` : `<div class="op-sim-phasebar" aria-label="Fasi del turno">${PHASES.map(phase => `<span class="${s.phase === phase ? 'active' : ''}">${phases[phase]}</span>`).join('')}${actionButton('nextPhase', 'Fase successiva', null, this.pending || !myTurn || ended)}${actionButton('nextTurn', 'Passa il turno', null, this.pending || !myTurn || ended)}</div>`}${ended ? `<div class="op-sim-result"><strong>${s.result.winner === 'draw' ? 'Pareggio' : `Vince ${esc(s.players[s.result.winner].name)}`}</strong><p>${esc(s.result.notes)}</p></div>` : ''}${this.opponentStripView()}<div class="op-sim-zones-tabs" role="group" aria-label="Campo da visualizzare">${[['both','Entrambi i campi'],[String(this.viewer),'Il mio campo'],[String(1 - this.viewer),'Avversario']].map(([id, name]) => `<button type="button" class="btn secondary ${this.playerFocus === id ? 'active' : ''}" data-op-side="${id}" aria-pressed="${this.playerFocus === id}">${name}</button>`).join('')}<button type="button" class="btn secondary" data-op-command="cover">Copri le mie carte</button></div><div class="op-sim-layout"><div class="op-sim-table">${[1 - this.viewer, this.viewer].filter(player => this.playerFocus === 'both' || String(player) === this.playerFocus).map(player => this.playerView(player)).join('')}</div>${this.inspectorPanelView()}</div><details class="op-sim-panel op-sim-log surface"><summary>Registro condiviso · ${s.log.length}</summary><ol>${s.log.slice(-70).reverse().map(row => `<li><small>T${row.turn}</small> ${esc(row.text)}</li>`).join('')}</ol></details>${!setup && !ended ? `<details class="op-sim-panel surface"><summary>Concludi il test</summary><form data-op-finish><label>Risultato<select name="winner">${s.players.map((p, i) => `<option value="${i}" ${this.finishDraft.winner === String(i) ? 'selected' : ''}>Vittoria ${esc(p.name)}</option>`).join('')}<option value="draw" ${this.finishDraft.winner === 'draw' ? 'selected' : ''}>Pareggio</option></select></label><label>Note condivise<textarea name="notes" rows="3" maxlength="2000">${esc(this.finishDraft.notes)}</textarea></label><button type="submit" class="btn" ${this.pending ? 'disabled' : ''}>Concludi e registra il risultato</button></form></details>` : ''}`;
  }
  opponentStripView() {
    const player = 1 - this.viewer, p = this.session.players[player];
    return `<div class="op-sim-opponent-strip"><div><strong>${esc(p.name)}</strong><small>Life ${p.life.length} · Mano ${p.hand.length} · Personaggi ${p.characters.length}/5</small></div><button type="button" class="btn secondary" data-op-side="${player}">Vedi avversario</button></div>`;
  }
  inspectorPanelView() {
    const selected = this.selectedCard();
    return `${selected ? '<button type="button" class="op-sim-inspector-backdrop" data-op-command="deselect" aria-label="Chiudi azioni carta"></button>' : ''}<aside class="op-sim-inspector op-sim-panel surface ${selected ? 'has-selection' : ''}" tabindex="-1" aria-label="Carta selezionata e azioni">${selected ? '<button type="button" class="btn secondary op-sim-inspector-close" data-op-command="deselect">Chiudi carta</button>' : ''}${this.inspectorView()}</aside>`;
  }
  playerView(player) {
    const p = this.session.players[player], mine = player === this.viewer, setup = this.session.phase === 'setup', disabled = this.pending || !this.canControl(player) || Boolean(this.session.result);
    const zone = (id, cards) => `<section class="op-sim-zone"><h3 class="op-sim-zone-label">${zones[id]} <span>${cards.length}${id === 'characters' ? '/5' : ''}</span></h3><div class="op-sim-cards">${cards.map(card => this.cardView(card, player)).join('') || '<span class="op-sim-empty-zone">Zona libera</span>'}</div></section>`;
    const life = mine && this.privateLife?.version === this.duel.version ? this.privateLife.cards : p.life;
    return `<section class="op-sim-player ${this.session.activePlayer === player ? 'is-active' : ''}" aria-label="Campo ${esc(p.name)}"><header class="op-sim-player-head"><div><h2>${esc(p.name)} <small>${mine ? 'TU' : 'AVVERSARIO'}</small></h2><p>${esc(p.deckName)}</p></div><div class="op-sim-actions">${setup ? actionButton('mulligan', p.mulliganUsed ? 'Mulligan usato' : 'Mulligan', player, disabled || p.mulliganUsed || this.duel.ready?.[player]) : `${actionButton('draw','Pesca 1',player,disabled || !p.deck.length)}${actionButton('refresh','Esegui Refresh',player,disabled)}`}</div></header><div class="op-sim-board-row">${zone('leader',[p.leader])}${zone('characters',p.characters)}${zone('stage',p.stage)}</div><div class="op-sim-piles"><div class="op-sim-pile"><b>Mazzo · ${p.deck.length}</b><div class="op-sim-card-back" aria-hidden="true">FPT</div><button type="button" class="btn secondary" data-op-pile="deck" data-player="${player}" ${!mine || this.pending || setup ? 'disabled' : ''}>Cerca nel mazzo</button>${actionButton('shuffle','Mescola',player,disabled || setup)}</div><div class="op-sim-pile"><b>Life · ${p.life.length}</b><div class="op-sim-cards">${life.map((card, index) => card.hidden ? `<span class="op-sim-card op-sim-card-back" aria-label="Life coperta"><span>${index === 0 ? 'Cima' : index + 1}</span></span>` : `<button type="button" class="op-sim-card" data-op-card="${esc(card.id)}" data-player="${player}">${this.cardFace(card)}</button>`).join('')}</div>${actionButton('takeLife','Life → mano',player,disabled || setup || !p.life.length)}<button type="button" class="btn secondary" data-op-peek="${player}" ${!mine || this.pending || setup ? 'disabled' : ''}>${this.privateLife ? 'Copri Life' : 'Guarda Life (effetto)'}</button>${actionButton('shuffleLife','Mescola Life',player,disabled || setup || p.life.length < 2)}</div><div class="op-sim-pile"><b>Trash · ${p.trash.length}</b>${p.trash.length ? this.cardView(p.trash.at(-1),player) : '<span class="op-sim-empty-zone">Vuoto</span>'}<button type="button" class="btn secondary" data-op-pile="trash" data-player="${player}">Apri trash</button></div></div><div class="op-sim-don"><strong>DON!!</strong>${[['deck','Mazzo'],['active','Attivi'],['rested','Rested']].map(([key, name]) => `<span class="op-sim-don-count">${name} <b>${p.don[key]}</b></span>`).join('')}<span class="op-sim-don-count">Assegnati <b>${[p.leader,...p.characters].reduce((n,c)=>n+c.don,0)}</b></span><div class="op-sim-actions">${[['addDon','+1 DON!!',!p.don.deck],['addDon2','+2 DON!!',p.don.deck < 2],['restDon','Riposa 1',!p.don.active],['activateDon','Attiva 1',!p.don.rested],['returnDon','DON!!− attivo',!p.don.active],['returnRestedDon','DON!!− rested',!p.don.rested]].map(([type,label,empty])=>actionButton(type,label,player,disabled || setup || empty)).join('')}</div></div><section class="op-sim-hand"><div class="op-sim-player-head"><h3 class="op-sim-zone-label">Mano · ${p.hand.length}</h3>${mine ? `<button type="button" class="btn secondary" data-op-hand="${player}">${this.revealHands[player] ? 'Copri mano' : 'Mostra la mia mano'}</button>` : '<small class="op-sim-private">Visibile soltanto al proprietario</small>'}</div><div class="op-sim-cards">${p.hand.map(card=>this.cardView(card,player,!mine || !this.revealHands[player])).join('')}</div></section>${this.pile?.player === player ? `<details open class="op-sim-panel surface"><summary>${zones[this.pile.zone]}</summary><div class="op-sim-cards">${(this.pile.cards || p[this.pile.zone]).map(card=>this.cardView(card,player)).join('')}</div><button type="button" class="btn secondary" data-op-command="close-pile">Chiudi zona</button></details>` : ''}</section>`;
  }
  cardView(card, player, hidden = false) {
    if (card.hidden || hidden) return '<span class="op-sim-card op-sim-card-back" aria-label="Carta coperta"><span>FPT</span></span>';
    return super.cardView(card, player, false);
  }
  selectedCard() {
    if (this.selected?.player === this.viewer) {
      for (const [zone, cards] of [['deck', this.pile?.zone === 'deck' ? this.pile.cards : []], ['life',this.privateLife?.cards]]) {
        const card = cards?.find(item => item.id === this.selected.cardId);
        if (card) return { card, zone, player:this.viewer };
      }
    }
    return super.selectedCard();
  }
  historyView() {
    const rows = this.lobby.duels.filter(d=>d.status === 'finished' && d.result);
    const wins = rows.filter(d=>d.result.winner === d.viewer).length, draws = rows.filter(d=>d.result.winner === 'draw').length;
    return `<section class="op-sim-panel surface"><h2>Test del team</h2><p>Le tue partite private con i compagni. Risultati manuali, separati dai match e dalla progressione.</p><div class="op-sim-stats"><div><b>${rows.length}</b><span>Test conclusi</span></div><div><b>${rows.length ? Math.round(wins / rows.length * 100) : 0}%</b><span>Win rate</span></div><div><b>${wins} / ${rows.length - wins - draws} / ${draws}</b><span>Vittorie / Sconfitte / Pareggi</span></div></div><div class="op-sim-history">${rows.map(d=>`<article><small>${esc(new Date(d.updatedAt).toLocaleString('it-IT'))}</small><h3>${esc(d.hostName)} vs ${esc(d.guestName)}</h3><p>${d.result.winner === 'draw' ? 'Pareggio' : `Vince ${esc(d.result.winner === 0 ? d.hostName : d.guestName)}`}</p><p>${esc(d.result.notes)}</p><button type="button" class="btn secondary" data-op-open="${esc(d.id)}">Apri tavolo concluso</button></article>`).join('') || '<p>Nessun test concluso.</p>'}</div></section>`;
  }
  bind(root) {
    if (!this.allowed()) return;
    const element = root.querySelector('.op-simulator'); if (!element || element.dataset.bound) return;
    element.dataset.bound = 'true'; if (!this.ready && !this.error) void this.initialize();
    element.addEventListener('input', event=>this.updateDraft(event.target));
    element.addEventListener('change', event=>{ this.updateDraft(event.target); if (event.target.name === 'opponentSlug' || event.target.name === 'deckId' && event.target.closest('[data-op-invite]')) this.render(); });
    element.addEventListener('submit', event=>{ event.preventDefault(); if (this.allowed()) void this.submit(event.target); });
    element.addEventListener('click', event=>{ const button = event.target.closest('button'); if (button && !button.disabled && this.allowed()) void this.click(button); });
  }
  updateDraft(field) {
    if (!this.allowed() || !field.name) return;
    const draft = field.closest('[data-op-invite]') ? this.inviteDraft : field.closest('[data-op-accept]') ? this.acceptDraft : field.closest('[data-op-finish]') ? this.finishDraft : null;
    if (draft && Object.hasOwn(draft, field.name)) draft[field.name] = field.value;
  }
  async submit(form) {
    if (this.pending || !this.ready) return;
    const data = new FormData(form);
    if (form.matches('[data-op-invite]')) {
      this.inviteRequestId ||= crypto.randomUUID();
      const result = await this.perform({ op:'invite', opponentSlug:data.get('opponentSlug'), deckId:data.get('deckId'), lifeCount:Number(data.get('lifeCount')), firstPlayer:Number(data.get('firstPlayer')), requestId:this.inviteRequestId });
      if (result) { this.inviteRequestId = null; this.options.onToast(result.notification?.push === 'sent' ? 'Invito inviato · notifica push spedita' : 'Invito inviato · disponibile al compagno in Altro'); }
    }
    if (form.matches('[data-op-accept]')) await this.perform({ op:'accept', duelId:this.duel.id, deckId:data.get('deckId'), lifeCount:Number(data.get('lifeCount')), expectedVersion:this.duel.version, requestId:crypto.randomUUID() });
    if (form.matches('[data-op-move]')) { const selected = this.selectedCard(); if (selected && selected.player === this.viewer) await this.act({ type:'move', player:this.viewer, cardId:selected.card.id, to:data.get('to'), position:data.get('position') }); }
    if (form.matches('[data-op-finish]') && await this.options.confirm('Concludere il test e condividere questo risultato con l’avversario?')) await this.act({ type:'finish', winner:data.get('winner') === 'draw' ? 'draw' : Number(data.get('winner')), notes:data.get('notes') });
  }
  async click(button) {
    if (button.dataset.opOpen) { await this.open(button.dataset.opOpen); return; }
    if (button.dataset.opResponse) { await this.perform({ op:button.dataset.opResponse, duelId:button.dataset.duel, expectedVersion:this.duel.version, requestId:crypto.randomUUID() }); return; }
    if (button.dataset.opCommand === 'lobby') {
      this.navigationGeneration++;
      this.duel = null; this.session = null; this.selected = null; this.pile = null; this.privateLife = null;
      const response = await this.perform({ op:'lobby' }); if (response && this.allowed()) { this.lobby = response; this.render(); } return;
    }
    if (button.dataset.opTab === 'history') {
      this.tab = 'history'; const response = await this.perform({ op:'lobby' }); if (response && this.allowed()) { this.lobby = response; this.render(); } return;
    }
    if (button.dataset.opPile === 'deck' || button.hasAttribute('data-op-peek')) {
      const player = Number(button.dataset.player ?? button.dataset.opPeek); if (player !== this.viewer || !this.duel || this.pending) return;
      const zone = button.dataset.opPile || 'life';
      const duelId = this.duel.id;
      const inspection = this.inspectionGeneration;
      if (zone === 'life' && this.privateLife) { this.privateLife = null; this.peekLife[player] = false; this.selected = null; this.render(); return; }
      const response = await this.perform({ op:'inspect', duelId:this.duel.id, zone });
      if (!response || !this.allowed() || inspection !== this.inspectionGeneration || this.duel?.id !== duelId || response.version !== this.duel.version) return;
      if (zone === 'life') { this.privateLife = { cards:response.cards, version:response.version }; this.peekLife[player] = true; }
      else this.pile = { player, zone, cards:response.cards };
      this.render(); return;
    }
    if (['cover','close-pile'].includes(button.dataset.opCommand) || button.hasAttribute('data-op-side')) { this.inspectionGeneration++; this.privateLife = null; }
    if (button.dataset.opCommand === 'reload') { this.ready = false; await this.initialize(); return; }
    await super.click(button);
  }
}
