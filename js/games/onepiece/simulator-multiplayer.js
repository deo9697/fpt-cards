import { OnePieceSimulator } from './simulator.js';
import { validateSimulatorDeck, PHASES } from './simulator-engine.js';
import { battlefieldView, canPlace } from './simulator-arena.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const phases = { setup:'Preparazione', refresh:'Refresh', draw:'Draw', don:'DON!!', main:'Main', end:'End' };
const zones = { leader:'Leader', characters:'Personaggi', stage:'Stage', hand:'Mano', life:'Life', deck:'Mazzo', trash:'Trash' };
const actionButton = (type, text, player, disabled = false) => `<button type="button" class="btn secondary" data-op-action="${type}" ${player == null ? '' : `data-player="${player}"`} ${disabled ? 'disabled' : ''}>${text}</button>`;
const initials = name => esc(String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?');
const leaderImage = value => { try { const url = new URL(value || '', globalThis.location?.href || 'http://localhost'); return value && ['http:','https:'].includes(url.protocol) ? esc(url.href) : ''; } catch { return ''; } };
const leaderArt = value => { const src = leaderImage(value); return src && !/['"()\\\s]/.test(src) ? src : ''; };
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
    this.battlePlacing = false;
    this.battleTools = false;
    this.battleInspectedCard = null;
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
    if (changed) { this.inspectionGeneration++; this.selected = null; this.pile = null; this.privateLife = null; this.peekLife = [false, false]; this.battlePlacing = false; this.battleInspectedCard = null; }
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
  deckSummary(deck) {
    if (!deck) return '<div class="op-vs-deck is-empty"><span class="op-vs-deck-art" aria-hidden="true">?</span><div><b>Nessun mazzo scelto</b><small>Scegli uno dei tuoi mazzi One Piece</small></div></div>';
    const leader = deck.cards?.find(card => card.section === 'leader');
    const count = (deck.cards || []).filter(card => card.section !== 'leader').reduce((sum, card) => sum + Number(card.quantity || 0), 0);
    const validation = validateSimulatorDeck(deck);
    const src = leaderImage(leader?.imageUrl);
    return `<div class="op-vs-deck">${src ? `<img class="op-vs-deck-art" src="${src}" alt="">` : '<span class="op-vs-deck-art" aria-hidden="true">OP</span>'}<div><b>${leader ? `Leader · ${esc(leader.cardName)}` : esc(deck.name)}</b><small>${count} carte${leader?.colors?.length ? ` · ${esc(leader.colors.join(' / '))}` : ''}</small><small class="${validation.valid ? 'is-valid' : 'is-invalid'}">${validation.valid ? 'Mazzo valido' : 'Mazzo da completare'}</small></div></div>`;
  }
  lifePicker(value) {
    const current = Number(value);
    return `<div class="op-vs-field"><span>Life del tuo Leader</span><div class="op-vs-seg" role="group" aria-label="Life del tuo Leader">${[4,5,6].map(n => `<button type="button" class="${current === n ? 'is-on' : ''}" data-op-life-pick="${n}" aria-pressed="${current === n}">${n}</button>`).join('')}<label class="op-vs-life-custom"><span class="sr-only">Altro valore di Life</span><input name="lifeCount" type="number" required min="1" max="10" step="1" value="${esc(value)}" aria-label="Life del tuo Leader"></label></div></div>`;
  }
  vsCard({ side, eyebrow, name, art = '', body }) {
    return `<div class="op-vs-card is-${side}" ${art ? `style="--vs-art:url('${art}')"` : ''}><div class="op-vs-who"><span class="op-vs-avatar" aria-hidden="true">${initials(name)}</span><div><small>${eyebrow}</small><strong>${esc(name)}</strong></div></div>${body}</div>`;
  }
  lobbyView() {
    const opponents = this.lobby.members.filter(member => member.slug !== this.context.member);
    const selected = opponents.find(member => member.slug === this.inviteDraft.opponentSlug);
    const deck = this.decks.find(item => item.id === this.inviteDraft.deckId);
    const validation = deck ? validateSimulatorDeck(deck) : null;
    const leader = deck?.cards?.find(card => card.section === 'leader');
    const rows = this.lobby.duels.filter(duel => ['waiting', 'setup', 'playing'].includes(duel.status));
    const me = this.vsCard({ side:'self', eyebrow:'Tu', name:this.memberName(this.context.member), art:leaderArt(leader?.imageUrl), body:`<label class="op-vs-field"><span>Il tuo mazzo</span><select name="deckId" required>${this.deckOptions(this.inviteDraft.deckId)}</select></label>${this.deckSummary(deck)}${validation && !validation.valid ? `<p class="op-sim-validation">${validation.errors.map(esc).join('<br>')}</p>` : ''}${!this.decks.length ? '<p class="op-vs-note">Salva un mazzo One Piece completo nella sezione Mazzi per poter giocare.</p><button type="button" class="btn secondary" data-page="decks">Apri i mazzi</button>' : ''}` });
    const them = this.vsCard({ side:'opponent', eyebrow:'Avversario', name:selected?.name || 'Scegli un compagno', body:`<label class="op-vs-field"><span>Membro del team</span><select name="opponentSlug" required><option value="">Scegli un compagno</option>${opponents.map(member => `<option value="${esc(member.slug)}" ${member.slug === this.inviteDraft.opponentSlug ? 'selected' : ''}>${esc(member.name)}</option>`).join('')}</select></label>${selected ? `<div class="op-vs-deck is-empty op-sim-member-summary"><span class="op-vs-deck-art" aria-hidden="true">?</span><div><b>Mazzo a sorpresa</b><small>${esc(selected.name)} lo sceglie quando accetta</small><small class="op-vs-push ${selected.pushEnabled ? 'is-on' : ''}">${selected.pushEnabled ? 'Notifiche attive · riceve il push' : 'Vede l’invito qui in Altro'}</small></div></div>` : `<p class="op-vs-note">${opponents.length ? 'Scegli una persona del tuo team per invitarla a una partita privata.' : 'Nel team non ci sono altri membri da invitare.'}</p>`}` });
    const first = this.inviteDraft.firstPlayer === '1' ? '1' : '0';
    return `<section class="op-sim-panel op-lobby surface"><div class="op-lobby-head"><h2>Invita al tavolo</h2><p>Tu scegli il tuo mazzo; il compagno sceglierà il suo quando accetta.</p></div><form class="op-sim-setup op-lobby-form" data-op-invite><div class="op-versus">${me}<div class="op-vs-mark" aria-hidden="true"><i></i><b>VS</b><i></i></div>${them}</div><div class="op-vs-settings">${this.lifePicker(this.inviteDraft.lifeCount)}<fieldset class="op-vs-field op-vs-first"><legend>Chi inizia?</legend><div class="op-vs-seg"><label class="${first === '0' ? 'is-on' : ''}"><input type="radio" name="firstPlayer" value="0" ${first === '0' ? 'checked' : ''}>Tu</label><label class="${first === '1' ? 'is-on' : ''}"><input type="radio" name="firstPlayer" value="1" ${first === '1' ? 'checked' : ''}>${esc(selected?.name || 'Il compagno')}</label></div></fieldset><div class="op-sim-setup-actions op-vs-cta"><button type="submit" class="btn" ${this.pending || !this.decks.length || !opponents.length ? 'disabled' : ''}>Invita al tavolo</button></div></div></form></section><section class="op-sim-lobby op-lobby-list"><h2>Inviti e partite${rows.length ? ` · ${rows.length}` : ''}</h2>${rows.length ? rows.map(duel => this.invitationView(duel)).join('') : '<div class="op-sim-panel op-sim-empty surface"><p>Nessun invito in attesa. Scegli un compagno per iniziare.</p></div>'}</section>`;
  }
  invitationView(duel) {
    const other = duel.viewer === 0 ? duel.guestName : duel.hostName;
    const tone = duel.status === 'waiting' ? duel.viewer === 0 ? 'wait' : 'new' : duel.status === 'playing' ? 'play' : 'setup';
    const chip = { wait:'In attesa', new:'Nuovo invito', play:'In partita', setup:'Preparazione' }[tone];
    const detail = tone === 'wait' ? `Il tuo invito · ${esc(other)} deve scegliere il mazzo` : tone === 'new' ? 'Ti ha invitato a giocare · One Piece' : [duel.hostDeckName, duel.guestDeckName].filter(Boolean).map(esc).join(' vs ') || 'One Piece';
    return `<article class="op-sim-panel op-sim-invite op-invite-tile is-${tone} surface"><span class="op-invite-avatar" aria-hidden="true">${initials(other)}</span><div><span class="op-invite-chip">${chip}</span><h3>${esc(other)}</h3><p>${detail}</p></div><button type="button" class="btn secondary" data-op-open="${esc(duel.id)}" ${this.pending ? 'disabled' : ''}>${duel.status === 'waiting' ? 'Apri invito' : 'Rientra al tavolo'}</button></article>`;
  }
  waitingView() {
    const d = this.duel, waiting = d.status === 'waiting';
    if (waiting && d.viewer === 1) {
      const deck = this.decks.find(item => item.id === this.acceptDraft.deckId), leader = deck?.cards?.find(card => card.section === 'leader');
      const host = this.vsCard({ side:'opponent', eyebrow:'Ti invita', name:d.hostName, body:`<div class="op-vs-deck is-empty"><span class="op-vs-deck-art" aria-hidden="true">OP</span><div><b>${esc(d.hostDeckName || 'Mazzo One Piece')}</b><small>Ha già scelto il suo mazzo</small></div></div>` });
      const me = this.vsCard({ side:'self', eyebrow:'Tu', name:d.guestName, art:leaderArt(leader?.imageUrl), body:`<label class="op-vs-field"><span>Il tuo mazzo</span><select name="deckId" required>${this.deckOptions(this.acceptDraft.deckId)}</select></label>${this.deckSummary(deck)}` });
      return `<section class="op-sim-panel op-sim-waiting op-lobby surface"><div class="op-lobby-head"><span class="eyebrow">// Tavolo privato</span><h2>${esc(d.hostName)} ti sfida</h2><p>Scegli il tuo mazzo per entrare nel test One Piece.</p></div><form class="op-lobby-form" data-op-accept><div class="op-versus">${host}<div class="op-vs-mark" aria-hidden="true"><i></i><b>VS</b><i></i></div>${me}</div><div class="op-vs-settings">${this.lifePicker(this.acceptDraft.lifeCount)}<div class="op-sim-actions op-vs-cta"><button class="btn" type="submit" ${this.pending || !this.decks.length ? 'disabled' : ''}>Accetta la sfida</button><button type="button" class="btn secondary" data-op-response="decline" data-duel="${esc(d.id)}" ${this.pending ? 'disabled' : ''}>Rifiuta invito</button></div></div></form><button type="button" class="btn secondary" data-op-command="lobby">Torna agli inviti</button></section>`;
    }
    const body = waiting ? `<p>Invito inviato. Aspettiamo che ${esc(d.guestName)} scelga il suo mazzo.</p><button type="button" class="btn secondary" data-op-response="cancel" data-duel="${esc(d.id)}" ${this.pending ? 'disabled' : ''}>Annulla invito</button>` : `<p>${esc(statusNames[d.status] || 'Tavolo non disponibile')}</p>`;
    const versus = waiting ? `<div class="op-versus">${this.vsCard({ side:'self', eyebrow:'Tu', name:d.hostName, body:`<div class="op-vs-deck is-empty"><span class="op-vs-deck-art" aria-hidden="true">OP</span><div><b>${esc(d.hostDeckName || 'Il tuo mazzo')}</b><small>Pronto per il tavolo</small></div></div>` })}<div class="op-vs-mark" aria-hidden="true"><i></i><b>VS</b><i></i></div>${this.vsCard({ side:'opponent', eyebrow:'In attesa', name:d.guestName, body:'<div class="op-vs-deck is-empty is-pending"><span class="op-vs-deck-art" aria-hidden="true">?</span><div><b>Sta scegliendo il mazzo</b><small>Il tavolo si apre appena accetta</small></div></div>' })}</div>` : '';
    return `<section class="op-sim-panel op-sim-waiting op-lobby surface"><div class="op-lobby-head"><span class="eyebrow">// Tavolo privato</span><h2>${esc(d.hostName)} vs ${esc(d.guestName)}</h2></div>${versus}${body}<button type="button" class="btn secondary" data-op-command="lobby">Torna agli inviti</button></section>`;
  }
  tableView() { return battlefieldView(this); }
  cardView(card, player, hidden = false) {
    if (card.hidden || hidden) return '<span class="op-sim-card op-sim-card-back" aria-label="Carta coperta"><span>FPT</span></span>';
    return super.cardView(card, player, false);
  }
  selectedCard() {
    if (this.battleInspectedCard && this.battleInspectedCard.version === this.duel?.version && this.battleInspectedCard.card.id === this.selected?.cardId) return this.battleInspectedCard;
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
    element.addEventListener('dragstart', event=>{
      const card = event.target.closest('[data-op-card][draggable="true"]');
      if (!card || !this.allowed() || Number(card.dataset.player) !== this.viewer || !event.dataTransfer) return;
      event.dataTransfer.setData('application/x-fpt-onepiece', JSON.stringify({ cardId:card.dataset.opCard, player:this.viewer, duelId:this.duel.id, version:this.duel.version }));
      event.dataTransfer.effectAllowed = 'move';
      this.selected = { cardId:card.dataset.opCard, player:this.viewer };
    });
    element.addEventListener('dragover', event=>{ if (event.target.closest('[data-op-slot],[data-op-zone]')?.dataset.player === String(this.viewer)) event.preventDefault(); });
    element.addEventListener('drop', event=>{
      const target = event.target.closest('[data-op-slot],[data-op-zone]'); if (!target || !this.allowed() || !event.dataTransfer) return;
      event.preventDefault();
      try {
        const card = JSON.parse(event.dataTransfer.getData('application/x-fpt-onepiece'));
        if (card.duelId !== this.duel?.id || card.version !== this.duel.version || card.player !== this.viewer) return;
        this.selected = { cardId:card.cardId, player:card.player };
        void this.placeBattleCard(Number(target.dataset.player), target.hasAttribute('data-op-slot') ? 'characters' : target.dataset.opZone, Number(target.dataset.opSlot));
      } catch { /* A drop from outside the private table has no effect. */ }
    });
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
    if (button.dataset.opLifePick) {
      const draft = button.closest('[data-op-accept]') ? this.acceptDraft : this.inviteDraft;
      draft.lifeCount = Number(button.dataset.opLifePick); this.render(); return;
    }
    if (button.hasAttribute('data-op-slot') || button.hasAttribute('data-op-zone')) {
      await this.placeBattleCard(Number(button.dataset.player), button.hasAttribute('data-op-slot') ? 'characters' : button.dataset.opZone, Number(button.dataset.opSlot)); return;
    }
    if (button.hasAttribute('data-op-card')) {
      const selected = this.pile && (this.pile.cards || this.session.players[this.pile.player][this.pile.zone]).find(card=>card.id === button.dataset.opCard);
      this.battleInspectedCard = selected ? { card:selected, zone:this.pile.zone, player:this.pile.player, version:this.duel.version } : null;
      this.pile = null; this.battlePlacing = false; this.battleTools = false;
    }
    const battle = button.dataset.opCommand;
    if (battle === 'battle-tools' || battle === 'battle-tools-close') { this.battleTools = battle === 'battle-tools'; this.selected = null; this.battlePlacing = false; this.render(); return; }
    if (battle === 'battle-place') { this.battlePlacing = true; this.battleTools = false; this.render(); return; }
    if (battle === 'battle-to-trash') { const selected=this.selectedCard(); if(selected?.player===this.viewer)await this.act({type:'move',player:this.viewer,cardId:selected.card.id,to:'trash'}); return; }
    if (battle === 'battle-life' || battle === 'battle-deck' || battle === 'battle-trash') {
      const player=Number(button.dataset.player), zone=battle.slice('battle-'.length);
      this.selected=null;this.battlePlacing=false;this.battleTools=false;
      this.pile={player,zone,cards:zone==='life' && this.privateLife?.version===this.duel.version ? this.privateLife.cards : undefined};this.render();return;
    }
    if (battle === 'battle-inspect-deck' || battle === 'battle-inspect-life') {
      this.battleTools=false;
      const zone=battle.endsWith('life')?'life':'deck';
      const target={dataset:{opPile:zone==='deck'?'deck':undefined,opPeek:zone==='life'?String(this.viewer):undefined,player:String(this.viewer)},hasAttribute:name=>zone==='life' && name==='data-op-peek'};
      await this.click(target);
      if (zone==='life' && this.privateLife) { this.pile={player:this.viewer,zone,cards:this.privateLife.cards};this.render(); }
      return;
    }
    if (battle === 'deselect') { this.battlePlacing=false;this.battleInspectedCard=null; }
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
  async placeBattleCard(player, destination, slot) {
    if (!canPlace(this,player,destination) || this.pending) { this.error='Seleziona una tua carta adatta a questa zona.';this.render();return; }
    const selected=this.selectedCard();
    await this.act({type:'move',player,cardId:selected.card.id,to:destination,...(destination==='characters'?{slot}:{})});
  }
}
