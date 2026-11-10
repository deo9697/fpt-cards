import { createSession, applyAction, validateSession, validateSimulatorDeck, canMoveCardToZone, PHASES } from './simulator-engine.js';
import { SimulatorStorage, simulatorScope } from './simulator-storage.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const safeImage = value => {
  try { const url = new URL(String(value || ''), globalThis.location?.href || 'http://localhost'); return ['https:', 'http:'].includes(url.protocol) ? esc(url.href) : ''; } catch { return ''; }
};
const ZONE_NAMES = { leader:'Leader', characters:'Personaggi', stage:'Stage', hand:'Mano', life:'Life', deck:'Mazzo', trash:'Trash' };
const PHASE_NAMES = { setup:'Preparazione', refresh:'Refresh', draw:'Draw', don:'DON!!', main:'Main', end:'End' };
const btn = (action, label, player, disabled = false) => `<button type="button" class="btn secondary" data-op-action="${action}" ${player == null ? '' : `data-player="${player}"`} ${disabled ? 'disabled' : ''}>${label}</button>`;

export class OnePieceSimulator {
  constructor(options) {
    this.options = options;
    this.context = { ...options.getContext() };
    this.scope = simulatorScope(this.context);
    this.storage = new SimulatorStorage(this.context, options.storage);
    this.session = null;
    this.undo = [];
    this.tab = 'table';
    this.selected = null;
    this.pile = null;
    this.playerFocus = 'both';
    this.revealHands = [false, false];
    this.peekLife = [false, false];
    this.error = '';
    this.saveError = '';
    this.ready = false;
    this.loading = false;
    this.setup = { deck0:'', deck1:'', life0:5, life1:5, name0:'Giocatore A', name1:'Giocatore B', firstPlayer:'0' };
    this.metadata = new Map();
    this.metadataLoading = new Set();
    this.history = [];
    this.generation = 0;
    this.disposed = false;
  }
  allowed() { const context = this.options.getContext(); return !this.disposed && context?.allowed === true && simulatorScope(context) === this.scope; }
  canControl() { return true; }
  render() { if (this.allowed()) this.options.onRender(); }
  selectCard(player, cardId) {
    this.selected = { player, cardId };
    this.render();
    if (globalThis.matchMedia?.('(max-width: 900px)').matches) {
      const inspector = document.querySelector('.op-sim-inspector');
      inspector?.focus({ preventScroll:true });
      inspector?.scrollIntoView({ block:'start', behavior:'instant' });
    }
  }
  async initialize() {
    if (this.loading || this.ready || !this.allowed()) return;
    const generation = this.generation;
    this.loading = true;
    this.error = '';
    try {
      if (!await this.options.verifyAccess()) throw new Error('Accedi con il tuo profilo del team per aprire il tavolo.');
      if (!this.allowed() || generation !== this.generation) return;
      await this.options.loadDecks();
      if (!this.allowed() || generation !== this.generation) return;
      const saved = this.storage.readSession();
      if (saved && validateSession(saved).valid) this.session = saved;
      else if (saved) this.error = 'Il tavolo salvato non è leggibile. Puoi prepararne uno nuovo.';
      this.history = this.storage.readHistory();
      this.ready = true;
    } catch (error) { if (this.allowed()) this.error = error.message || 'Impossibile verificare l’accesso del team. Riprova.'; }
    finally { if (generation === this.generation) { this.loading = false; this.render(); } }
  }
  reset() {
    this.generation++;
    this.disposed = true;
    this.session = null;
    this.selected = null;
    this.pile = null;
    this.undo = [];
    this.history = [];
    this.metadata.clear();
    this.ready = false;
  }
  close() { try { this.storage.clearSession(); } catch {} this.reset(); }
  get decks() { return (this.options.getDecks() || []).filter(deck => deck.game === 'onepiece' && (!deck.ownerSlug || deck.ownerSlug === this.context.member)); }
  persist() {
    try { this.storage.writeSession(this.session); this.saveError = ''; }
    catch { this.saveError = 'Salvataggio locale non disponibile: lascia aperta questa scheda per conservare il tavolo.'; }
  }
  act(action) {
    if (!this.ready || !this.allowed() || !this.session) return;
    try {
      const next = applyAction(this.session, action);
      this.undo.push(this.session);
      if (this.undo.length > 30) this.undo.shift();
      this.session = next;
      if (action.type === 'shuffle') { this.pile = null; this.selected = null; if (action.zone === 'life') this.peekLife[action.player] = false; }
      if (this.selected && !this.selectedCard()) this.selected = null;
      this.error = '';
      this.persist();
    } catch (error) { this.error = error.message || 'Azione non disponibile.'; }
    this.render();
  }
  view() {
    if (!this.allowed()) return '<section class="op-simulator"><div class="op-sim-panel">Il simulatore è riservato ai membri del team nella sezione One Piece.</div></section>';
    // Initialization starts in bind, so an access error never triggers a render/retry loop.
    return `<section class="op-simulator" aria-label="Simulatore manuale One Piece">
      <header class="op-sim-header"><div><span class="op-sim-eyebrow">ONE PIECE · TEAM LAB</span><h1>Il tuo tavolo di prova</h1><p>Due mazzi. Un solo tavolo. Ogni mossa nelle tue mani.</p></div><span class="op-sim-badge">Sessione privata · Manuale</span></header>
      <div class="op-sim-tabs" role="tablist" aria-label="Simulatore"><button type="button" role="tab" aria-selected="${this.tab === 'table'}" data-op-tab="table" class="${this.tab === 'table' ? 'active' : ''}">Tavolo</button><button type="button" role="tab" aria-selected="${this.tab === 'rules'}" data-op-tab="rules" class="${this.tab === 'rules' ? 'active' : ''}">Regole e ruling</button><button type="button" role="tab" aria-selected="${this.tab === 'history'}" data-op-tab="history" class="${this.tab === 'history' ? 'active' : ''}">Test e statistiche</button></div>
      ${this.error ? `<p class="op-sim-error" role="alert">${esc(this.error)}</p>` : ''}${this.saveError ? `<p class="op-sim-notice" role="status">${esc(this.saveError)}</p>` : ''}
      ${!this.ready ? `<div class="op-sim-panel" ${this.loading ? 'aria-busy="true"' : ''}><p>${this.loading ? 'Verifica del profilo e caricamento dei mazzi…' : 'Verifica il tuo accesso al team per preparare il tavolo.'}</p><button type="button" class="btn secondary" data-op-command="reload" ${this.loading ? 'disabled' : ''}>${this.error ? 'Riprova' : 'Carica tavolo'}</button></div>` : this.tab === 'rules' ? this.rulesView() : this.tab === 'history' ? this.historyView() : this.session ? this.tableView() : this.setupView()}
      <p class="op-sim-save-status">Tavolo salvato in questa scheda. Risultati salvati per il tuo profilo su questo dispositivo. Nessuna condivisione della sessione.</p>
    </section>`;
  }
  setupView() {
    const decks = this.decks;
    if (!decks.length) return `<div class="op-sim-panel op-sim-empty"><h2>Porta i tuoi mazzi al tavolo</h2><p>Crea o importa due mazzi One Piece nella sezione Mazzi. Puoi anche usare lo stesso mazzo per un mirror test.</p><button type="button" class="btn" data-page="decks">Apri i mazzi</button><button type="button" class="btn secondary" data-op-command="reload">Ricarica mazzi</button></div>`;
    const picker = player => {
      const value = this.setup[`deck${player}`];
      const deck = decks.find(item => item.id === value);
      const validation = deck ? validateSimulatorDeck(deck) : null;
      return `<fieldset class="op-sim-deck-picker"><legend>Giocatore ${player ? 'B' : 'A'}</legend><label>Nome<input name="name${player}" maxlength="40" required value="${esc(this.setup[`name${player}`])}"></label><label>Mazzo<select name="deck${player}" required><option value="">Scegli un mazzo</option>${decks.map(item => `<option value="${esc(item.id)}" ${item.id === value ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label><label>Life del Leader<input name="life${player}" type="number" min="1" max="10" step="1" required value="${this.setup[`life${player}`]}"></label><small>Controlla il valore Life sul tuo Leader.</small>${validation ? `<div class="op-sim-validation">${validation.valid ? '✓ 1 Leader · 50 carte · 10 DON!! virtuali' : validation.errors.map(esc).join('<br>')}</div>` : ''}</fieldset>`;
    };
    return `<section class="op-sim-panel"><h2>Prepara la sfida</h2><p>Usa i tuoi mazzi One Piece. Carte e varianti vengono copiate sul tavolo, senza modificare il deck builder.</p><form class="op-sim-setup" data-op-setup>${picker(0)}${picker(1)}<div class="op-sim-setup-actions"><label>Chi inizia?<select name="firstPlayer"><option value="0" ${this.setup.firstPlayer === '0' ? 'selected' : ''}>Giocatore A</option><option value="1" ${this.setup.firstPlayer === '1' ? 'selected' : ''}>Giocatore B</option></select></label><button type="submit" class="btn">Avvia tavolo</button></div></form><p class="op-sim-notice">Il tavolo mescola i mazzi e distribuisce 5 carte. Puoi fare un mulligan per lato; le Life vengono distribuite quando inizi il duello. Effetti, costi, attacchi e vittoria si risolvono manualmente.</p></section>`;
  }
  tableView() {
    const session = this.session;
    const setup = session.phase === 'setup';
    const finished = Boolean(session.result);
    return `<div class="op-sim-toolbar"><div><strong>${setup ? 'Preparazione · Mulligan' : `Turno ${session.turn} · ${esc(session.players[session.activePlayer].name)}`}</strong><small>${setup ? 'Controlla le mani prima di distribuire le Life.' : 'Il cambio fase non esegue azioni automatiche.'}</small></div><div class="op-sim-actions"><button type="button" class="btn secondary" data-op-command="undo" ${!this.undo.length || finished ? 'disabled' : ''}>↶ Annulla mossa</button><button type="button" class="btn secondary" data-op-command="new">Nuovo tavolo</button></div></div>
      ${setup ? `<div class="op-sim-panel">${btn('start', 'Distribuisci Life e inizia il duello')}<p>Puoi mostrare ciascuna mano e scegliere il mulligan una sola volta.</p></div>` : `<div class="op-sim-phasebar" aria-label="Fasi del turno">${PHASES.map(phase => `<span class="${session.phase === phase ? 'active' : ''}" ${session.phase === phase ? 'aria-current="step"' : ''}>${PHASE_NAMES[phase]}</span>`).join('')}${btn('nextPhase', 'Fase successiva', null, finished)}${btn('nextTurn', 'Passa il turno', null, finished)}</div>`}
      ${finished ? `<div class="op-sim-result" role="status"><strong>${session.result.winner === 'draw' ? 'Test concluso in pareggio' : `${esc(session.players[session.result.winner].name)} vince il test`}</strong><p>${esc(session.result.notes || '')}</p><button type="button" class="btn secondary" data-op-command="save-result">Salva risultato</button></div>` : ''}
      <div class="op-sim-zones-tabs" role="group" aria-label="Campo da visualizzare">${[['both', 'Entrambi i campi'], ['0', session.players[0].name], ['1', session.players[1].name]].map(([value, name]) => `<button type="button" class="btn secondary ${this.playerFocus === value ? 'active' : ''}" data-op-side="${value}" aria-pressed="${this.playerFocus === value}">${esc(name)}</button>`).join('')}<button type="button" class="btn secondary" data-op-command="cover">Copri tutte le carte private</button></div>
      <div class="op-sim-layout"><div class="op-sim-table">${[1, 0].filter(player => this.playerFocus === 'both' || String(player) === this.playerFocus).map(player => this.playerView(player)).join('')}</div><aside class="op-sim-inspector op-sim-panel" tabindex="-1" aria-label="Carta selezionata e azioni">${this.inspectorView()}</aside></div>
      <details class="op-sim-panel op-sim-log"><summary>Registro azioni · ${session.log.length}</summary><ol>${session.log.slice(-80).reverse().map(entry => `<li><small>T${entry.turn}</small> ${esc(entry.text)}</li>`).join('')}</ol></details>
      ${!setup && !finished ? `<details class="op-sim-panel"><summary>Concludi e registra il test</summary><form data-op-finish><label>Risultato<select name="winner"><option value="0">Vittoria ${esc(session.players[0].name)}</option><option value="1">Vittoria ${esc(session.players[1].name)}</option><option value="draw">Pareggio</option></select></label><label>Note del test<textarea name="notes" maxlength="2000" rows="3" placeholder="Matchup, mano iniziale, scelte da rivedere…"></textarea></label><button type="submit" class="btn">Concludi e salva risultato</button></form><p>Il risultato viene registrato nei test privati, separato dai match del team.</p></details>` : ''}`;
  }
  playerView(player) {
    const session = this.session, p = session.players[player], setup = session.phase === 'setup', finished = Boolean(session.result);
    const zone = (name, cards, hidden = false) => `<section class="op-sim-zone"><h3 class="op-sim-zone-label">${ZONE_NAMES[name]} <span>${cards.length}${name === 'characters' ? '/5' : ''}</span></h3><div class="op-sim-cards">${cards.length ? cards.map(card => this.cardView(card, player, hidden)).join('') : '<span class="op-sim-empty-zone">Zona libera</span>'}</div></section>`;
    return `<section class="op-sim-player ${session.activePlayer === player ? 'is-active' : ''}" aria-label="Campo ${esc(p.name)}"><header class="op-sim-player-head"><div><h2>${esc(p.name)} <small>${player ? 'B' : 'A'}</small></h2><p>${esc(p.deckName)}</p></div><div class="op-sim-actions">${setup ? btn('mulligan', p.mulliganUsed ? 'Mulligan usato' : 'Mulligan', player, p.mulliganUsed) : `${btn('draw', 'Pesca 1', player, finished || !p.deck.length)}${btn('refresh', 'Esegui Refresh', player, finished)}`}</div></header>
      <div class="op-sim-board-row">${zone('leader', [p.leader])}${zone('characters', p.characters)}${zone('stage', p.stage)}</div>
      <div class="op-sim-piles"><div class="op-sim-pile"><b>Mazzo · ${p.deck.length}</b><div class="op-sim-card-back" aria-hidden="true">OP</div><button type="button" class="btn secondary" data-op-pile="deck" data-player="${player}">Cerca nel mazzo</button>${btn('shuffle', 'Mescola', player, finished)}</div><div class="op-sim-pile"><b>Life · ${p.life.length}${setup ? ` / ${p.lifeCount}` : ''}</b><div class="op-sim-cards">${p.life.map((card, index) => `<button type="button" class="op-sim-card ${(this.peekLife[player] || card.faceUp) ? '' : 'op-sim-card-back'}" data-op-life="${index}" data-player="${player}" aria-label="${(this.peekLife[player] || card.faceUp) ? esc(card.cardName) : `Life ${index + 1}${index === 0 ? ' · cima' : ''}`}">${(this.peekLife[player] || card.faceUp) ? this.cardFace(card) : `<span>${index === 0 ? 'Cima' : index + 1}</span>`}</button>`).join('')}</div>${btn('takeLife', 'Life → mano', player, setup || finished || !p.life.length)}<button type="button" class="btn secondary" data-op-peek="${player}" aria-pressed="${this.peekLife[player]}">${this.peekLife[player] ? 'Copri Life' : 'Guarda Life (effetto)'}</button>${btn('shuffleLife', 'Mescola Life', player, setup || finished || p.life.length < 2)}</div><div class="op-sim-pile"><b>Trash · ${p.trash.length}</b>${p.trash.length ? this.cardView(p.trash[p.trash.length - 1], player) : '<span class="op-sim-empty-zone">Vuoto</span>'}<button type="button" class="btn secondary" data-op-pile="trash" data-player="${player}">Apri trash</button></div></div>
      <div class="op-sim-don"><strong>DON!!</strong><span class="op-sim-don-count">Mazzo <b>${p.don.deck}</b></span><span class="op-sim-don-count">Attivi <b>${p.don.active}</b></span><span class="op-sim-don-count">Rested <b>${p.don.rested}</b></span><span class="op-sim-don-count">Assegnati <b>${[p.leader, ...p.characters].reduce((sum, card) => sum + card.don, 0)}</b></span><div class="op-sim-actions">${btn('addDon', '+1 DON!!', player, setup || finished || !p.don.deck)}${btn('addDon2', '+2 DON!!', player, setup || finished || p.don.deck < 2)}${btn('restDon', 'Riposa 1', player, setup || finished || !p.don.active)}${btn('activateDon', 'Attiva 1', player, setup || finished || !p.don.rested)}${btn('returnDon', 'DON!!− attivo', player, setup || finished || !p.don.active)}${btn('returnRestedDon', 'DON!!− rested', player, setup || finished || !p.don.rested)}</div></div>
      <section class="op-sim-hand"><div class="op-sim-player-head"><h3 class="op-sim-zone-label">Mano · ${p.hand.length}</h3><button type="button" class="btn secondary" data-op-hand="${player}" aria-pressed="${this.revealHands[player]}">${this.revealHands[player] ? 'Copri mano' : 'Mostra mano'}</button></div><div class="op-sim-cards">${p.hand.map(card => this.cardView(card, player, !this.revealHands[player])).join('')}</div></section>
      ${this.pile?.player === player ? `<details open class="op-sim-panel"><summary>${ZONE_NAMES[this.pile.zone]} · ricerca manuale</summary><p>Se cerchi nel mazzo, ricordati di mescolarlo dopo aver risolto l’effetto.</p><div class="op-sim-cards">${p[this.pile.zone].map(card => this.cardView(card, player)).join('') || 'Zona vuota'}</div><button type="button" class="btn secondary" data-op-command="close-pile">Chiudi zona</button></details>` : ''}</section>`;
  }
  cardFace(card) {
    const src = safeImage(card.imageUrl);
    return `${src ? `<img src="${src}" alt="" loading="lazy" decoding="async">` : '<span class="op-sim-card-art">ONE PIECE</span>'}<span>${esc(card.cardName)}</span><small>${esc(card.catalogCardId)}</small>${card.don || card.rested || card.powerModifier ? `<span class="op-sim-card-badges">${card.rested ? '<b>REST</b>' : ''}${card.don ? `<b>DON!! ×${card.don}</b>` : ''}${card.powerModifier ? `<b>${card.powerModifier > 0 ? '+' : ''}${card.powerModifier}</b>` : ''}</span>` : ''}`;
  }
  cardView(card, player, hidden = false) {
    if (hidden) return '<span class="op-sim-card op-sim-card-back" aria-label="Carta coperta"><span>OP</span></span>';
    const selected = this.selected?.player === player && this.selected.cardId === card.id;
    return `<button type="button" class="op-sim-card ${card.rested ? 'is-rested' : ''} ${selected ? 'is-selected' : ''}" aria-pressed="${selected}" data-op-card="${esc(card.id)}" data-player="${player}">${this.cardFace(card)}</button>`;
  }
  selectedCard() {
    if (!this.session || !this.selected) return null;
    const p = this.session.players[this.selected.player];
    for (const zone of ['leader', 'hand', 'characters', 'stage', 'life', 'trash', 'deck']) {
      const cards = zone === 'leader' ? [p.leader] : p[zone];
      const card = cards.find(item => item.id === this.selected.cardId);
      if (card) {
        if (zone === 'hand' && !this.revealHands[this.selected.player]) return null;
        if (zone === 'life' && !this.peekLife[this.selected.player] && !card.faceUp) return null;
        if (zone === 'deck' && !(this.pile?.zone === 'deck' && this.pile.player === this.selected.player)) return null;
        return { card, zone, player:this.selected.player };
      }
    }
    return null;
  }
  inspectorView() {
    const selected = this.selectedCard();
    if (!selected) return '<h2>Il banco di regia</h2><p>Mostra una mano e seleziona una carta per giocarla, riposarla, assegnare DON!! o risolvere un effetto.</p><p class="op-sim-notice">Attacchi, Counter, Trigger e costi sono manuali. Usa le zone e il registro per seguire la partita.</p>';
    const { card, zone, player } = selected;
    const metadata = this.metadata.get(card.catalogCardId);
    const board = ['leader', 'characters', 'stage'].includes(zone);
    const finished = Boolean(this.session.result) || !this.canControl(player), setup = this.session.phase === 'setup';
    const effect = metadata?.effect || card.text || '';
    const power = metadata?.power ?? card.power;
    const image = safeImage(card.imageUrl);
    const destinations = Object.entries(ZONE_NAMES).filter(([key]) => canMoveCardToZone(card, key));
    const defaultDestination = ['characters', 'stage', 'trash'].find(zone => canMoveCardToZone(card, zone));
    return `<div class="op-sim-preview">${image ? `<img src="${image}" alt="${esc(card.cardName)}">` : ''}</div><h2>${esc(card.cardName)}</h2><p>${esc(card.catalogCardId)} · ${ZONE_NAMES[zone]} · ${esc(this.session.players[player].name)}</p>${metadata ? `<p>${esc(metadata.cardType || '')} ${metadata.cost != null ? `· Costo ${esc(metadata.cost)}` : ''} ${metadata.counter != null ? `· Counter ${esc(metadata.counter)}` : ''}</p>` : `<button type="button" class="btn secondary" data-op-command="metadata" ${this.metadataLoading.has(card.catalogCardId) ? 'disabled' : ''}>${this.metadataLoading.has(card.catalogCardId) ? 'Caricamento testo…' : 'Carica testo e dettagli'}</button>`}${power != null ? `<p><strong>Potere: ${Number(power) + card.powerModifier + (this.session.activePlayer === player ? card.don * 1000 : 0)}</strong> <small>(inclusi DON!! nel proprio turno)</small></p>` : ''}${effect ? `<p style="white-space:pre-wrap">${esc(effect)}</p>` : '<p>Consulta anche l’immagine della carta per effetti e Trigger.</p>'}${metadata?.trigger ? `<p><b>Trigger:</b> ${esc(metadata.trigger)}</p>` : ''}
      ${!finished && !setup ? `<div class="op-sim-actions">${board ? btn('toggleRest', card.rested ? 'Attiva carta' : 'Riposa carta', player) : ''}${zone === 'life' ? btn('toggleFaceUp', card.faceUp ? 'Metti Life coperta' : 'Metti Life scoperta', player) : ''}${['leader', 'characters'].includes(zone) ? `${btn('attachDon', 'Assegna 1 DON!!', player)}${btn('detachDon', 'Rimuovi 1 DON!!', player)}${btn('returnAttachedDon', 'DON!!− assegnato', player)}${btn('powerUp', '+1000 potere', player)}${btn('powerDown', '−1000 potere', player)}` : ''}</div>${zone !== 'leader' ? `<form data-op-move><label>Sposta in<select name="to">${destinations.map(([key, value]) => `<option value="${key}" ${key === defaultDestination ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Posizione in mazzo / Life<select name="position"><option value="top">Cima</option><option value="bottom">Fondo</option></select></label><button type="submit" class="btn">Sposta carta</button></form>` : ''}` : ''}<button type="button" class="btn secondary" data-op-command="deselect">Chiudi carta</button>`;
  }
  rulesView() {
    return `<section class="op-sim-panel op-sim-rules"><h2>Regole a portata di mano</h2><p>Promemoria per il tavolo manuale. Verifica sempre testo carta, errata e Q&A ufficiali; gli effetti particolari richiedono una risoluzione manuale.</p><details open><summary>Preparazione</summary><p>Un Leader, 50 carte Main e 10 DON!!. Pesca 5: puoi riprendere tutta la mano e ripescarne 5 una sola volta. Distribuisci poi le Life indicate dal Leader, coperte.</p></details><details><summary>Turno e prime mosse</summary><p>Refresh → Draw → DON!! → Main → End. Chi inizia salta la prima pescata e aggiunge un solo DON!!; normalmente si pesca una carta e si aggiungono due DON!!. Nessuno attacca nel proprio primo turno.</p></details><details><summary>DON!! e Refresh</summary><p>I DON!! assegnati valgono +1000 ciascuno durante il turno del loro giocatore. Il Refresh recupera i DON!! assegnati e riattiva Leader, personaggi, Stage e DON!!. Se una carta lascia il campo, i suoi DON!! tornano rested. DON!!− può usare anche DON!! rested o assegnati.</p></details><details><summary>Combattimento, Life e correzioni</summary><p>Risolvi manualmente attacchi, Blocker, Counter, danni e Trigger. Life → mano prende la carta in cima; per un Trigger selezionala dalla mano e risolvi il suo effetto. Fino a 5 personaggi e 1 Stage: libera lo spazio prima di sostituire una carta. Annulla mossa corregge l’ultima azione; bonus di potere temporanei si rimuovono manualmente.</p></details><div class="op-sim-actions"><a class="btn secondary" href="https://en.onepiece-cardgame.com/rules/" target="_blank" rel="noopener noreferrer">Regole ufficiali</a><a class="btn secondary" href="https://en.onepiece-cardgame.com/pdf/rule_comprehensive.pdf" target="_blank" rel="noopener noreferrer">Comprehensive Rules</a><a class="btn secondary" href="https://en.onepiece-cardgame.com/rules/faq/" target="_blank" rel="noopener noreferrer">Q&A ed errata</a><a class="btn secondary" href="https://en.onepiece-cardgame.com/pdf/rule_overview_sheet_it.pdf" target="_blank" rel="noopener noreferrer">Guida in italiano</a></div></section>`;
  }
  historyView() {
    const rows = this.history;
    const summaries = new Map();
    for (const row of rows) row.players.forEach((player, index) => {
      const key = player.deckId || player.deckName;
      const entry = summaries.get(key) || { name:player.deckName, games:0, wins:0, draws:0 };
      entry.games++; if (row.winner === index) entry.wins++; if (row.winner === 'draw') entry.draws++;
      summaries.set(key, entry);
    });
    return `<section class="op-sim-panel"><h2>Il diario dei test</h2><p>Risultati manuali del tuo profilo su questo dispositivo. I mirror contano una presenza per ciascun lato; il win rate usa vittorie / presenze.</p><div class="op-sim-stats"><div><b>${rows.length}</b><span>Test registrati</span></div>${[...summaries.values()].map(entry => `<div><b>${Math.round(entry.wins / entry.games * 100)}%</b><span>${esc(entry.name)}</span><small>${entry.wins}V · ${entry.games - entry.wins - entry.draws}S · ${entry.draws}P / ${entry.games}</small></div>`).join('')}</div>${rows.length ? `<div class="op-sim-actions"><button type="button" class="btn secondary" data-op-command="export">Esporta test JSON</button><button type="button" class="btn secondary" data-op-command="clear-history">Cancella storico locale</button></div><div class="op-sim-history">${rows.map(row => `<article><small>${esc(new Date(row.endedAt).toLocaleString('it-IT'))} · ${row.turns} turni</small><h3>${esc(row.players[0].deckName)} vs ${esc(row.players[1].deckName)}</h3><p>${row.winner === 'draw' ? 'Pareggio' : `Vince ${esc(row.players[row.winner].name)}`} · Inizia ${esc(row.players[row.firstPlayer || 0].name)}</p>${row.notes ? `<p>${esc(row.notes)}</p>` : ''}</article>`).join('')}</div>` : '<p class="op-sim-empty">Concludi una partita dal tavolo per registrare il primo test.</p>'}</section>`;
  }
  async create(form) {
    if (!this.allowed() || !this.ready) return;
    const data = new FormData(form);
    for (const key of Object.keys(this.setup)) this.setup[key] = data.get(key);
    const chosen = [0, 1].map(index => this.decks.find(deck => deck.id === this.setup[`deck${index}`]));
    try {
      this.session = createSession({ decks:chosen, firstPlayer:Number(this.setup.firstPlayer), life:[Number(this.setup.life0), Number(this.setup.life1)], names:[this.setup.name0, this.setup.name1] });
      this.undo = []; this.selected = null; this.pile = null; this.revealHands = [false, false]; this.peekLife = [false, false]; this.error = '';
      this.persist();
    } catch (error) { this.error = error.message || 'Controlla i mazzi selezionati.'; }
    this.render();
  }
  async fetchMetadata() {
    const selected = this.selectedCard();
    if (!selected || !this.allowed()) return;
    const id = selected.card.catalogCardId;
    if (this.metadataLoading.has(id)) return;
    this.metadataLoading.add(id); this.render();
    try {
      const data = await this.options.lookupCard(id);
      if (!this.allowed()) return;
      if (!data) throw new Error('Dettagli non disponibili. Consulta l’immagine o i riferimenti ufficiali.');
      this.metadata.set(id, data);
    } catch (error) { if (this.allowed()) this.error = error.message || 'Dettagli non disponibili.'; }
    finally { this.metadataLoading.delete(id); this.render(); }
  }
  saveResult() {
    if (!this.allowed() || !this.session?.result) return;
    const s = this.session;
    const row = { id:s.id, endedAt:s.updatedAt, firstPlayer:s.firstPlayer, turns:s.turn, winner:s.result.winner, notes:s.result.notes || '', players:s.players.map(player => ({ name:player.name, deckId:player.deckId, deckName:player.deckName, cards:[player.leader, ...player.deck, ...player.hand, ...player.life, ...player.characters, ...player.stage, ...player.trash].map(card => ({ catalogCardId:card.catalogCardId, printingId:card.printingId || null })) })) };
    try { this.history = this.storage.saveResult(row); this.options.onToast('Risultato del test salvato sul dispositivo'); this.saveError = ''; }
    catch { this.saveError = 'Risultato non salvato: spazio locale non disponibile. Puoi riprovare dal tavolo.'; }
    this.render();
  }
  bind(root) {
    if (!this.allowed()) return;
    const element = root.querySelector('.op-simulator');
    if (!element || element.dataset.bound) return;
    element.dataset.bound = 'true';
    if (!this.ready && !this.error) void this.initialize();
    element.addEventListener('change', event => {
      if (!this.allowed()) return;
      if (event.target.closest('[data-op-setup]')) {
        const key = event.target.name;
        if (Object.hasOwn(this.setup, key)) this.setup[key] = event.target.value;
        if (key.startsWith('deck')) this.render();
      }
    });
    element.addEventListener('input', event => {
      if (this.allowed() && event.target.closest('[data-op-setup]') && Object.hasOwn(this.setup, event.target.name)) this.setup[event.target.name] = event.target.value;
    });
    element.addEventListener('submit', event => {
      if (!this.allowed()) return;
      const form = event.target;
      if (form.matches('[data-op-setup]')) { event.preventDefault(); void this.create(form); }
      if (form.matches('[data-op-move]')) {
        event.preventDefault();
        const selected = this.selectedCard(); if (!selected) return;
        const data = new FormData(form);
        this.act({ type:'move', player:selected.player, cardId:selected.card.id, to:data.get('to'), position:data.get('position') });
      }
      if (form.matches('[data-op-finish]')) {
        event.preventDefault(); const data = new FormData(form);
        this.act({ type:'finish', winner:data.get('winner') === 'draw' ? 'draw' : Number(data.get('winner')), notes:data.get('notes') });
        this.saveResult();
      }
    });
    element.addEventListener('click', event => { const button = event.target.closest('button'); if (button && !button.disabled && this.allowed()) void this.click(button); });
  }
  async click(button) {
    if (button.hasAttribute('data-op-side')) { this.playerFocus = button.dataset.opSide; this.selected = null; this.pile = null; this.render(); return; }
    if (button.dataset.opTab) { this.tab = button.dataset.opTab; this.render(); return; }
    if (button.hasAttribute('data-op-card')) { this.selectCard(Number(button.dataset.player), button.dataset.opCard); return; }
    if (button.hasAttribute('data-op-life')) {
      const player = Number(button.dataset.player);
      const card = this.session.players[player].life[Number(button.dataset.opLife)];
      if (!card || (!this.peekLife[player] && !card.faceUp)) return;
      this.selectCard(player, card.id); return;
    }
    if (button.hasAttribute('data-op-hand')) { const player = Number(button.dataset.opHand); this.revealHands[player] = !this.revealHands[player]; if (!this.revealHands[player] && this.selected?.player === player && this.selectedCard()?.zone === 'hand') this.selected = null; this.render(); return; }
    if (button.hasAttribute('data-op-peek')) { const player = Number(button.dataset.opPeek); this.peekLife[player] = !this.peekLife[player]; if (!this.peekLife[player] && this.selected?.player === player && this.selectedCard()?.zone === 'life') this.selected = null; this.render(); return; }
    if (button.dataset.opPile) { this.pile = { player:Number(button.dataset.player), zone:button.dataset.opPile }; this.render(); return; }
    const command = button.dataset.opCommand;
    if (command === 'reload') { this.ready = false; await this.initialize(); return; }
    if (command === 'metadata') { await this.fetchMetadata(); return; }
    if (command === 'close-pile') { this.pile = null; this.selected = null; this.render(); return; }
    if (command === 'cover') { this.pile = null; this.selected = null; this.revealHands = [false, false]; this.peekLife = [false, false]; this.render(); return; }
    if (command === 'deselect') { this.selected = null; this.render(); return; }
    if (command === 'undo' && this.undo.length && !this.session?.result) { this.session = this.undo.pop(); this.selected = null; this.error = ''; this.persist(); this.render(); return; }
    if (command === 'new') {
      if (!await this.options.confirm('Chiudere questo tavolo e prepararne uno nuovo? Il test non concluso non verrà registrato.')) return;
      if (!this.allowed()) return;
      try { this.storage.clearSession(); } catch { this.saveError = 'Impossibile eliminare il salvataggio della scheda.'; }
      this.session = null; this.undo = []; this.selected = null; this.pile = null; this.error = ''; this.render(); return;
    }
    if (command === 'save-result') { this.saveResult(); return; }
    if (command === 'clear-history') {
      if (!await this.options.confirm('Cancellare i risultati dei test di questo profilo su questo dispositivo?')) return;
      if (!this.allowed()) return;
      try { this.storage.clearHistory(); this.history = []; } catch { this.error = 'Impossibile cancellare lo storico locale.'; }
      this.render(); return;
    }
    if (command === 'export') {
      const url = URL.createObjectURL(new Blob([JSON.stringify({ version:1, game:'onepiece', tests:this.history }, null, 2)], { type:'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'onepiece-test-privati.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
    }
    const action = button.dataset.opAction; if (!action || !this.session) return;
    const player = Number(button.dataset.player), selected = this.selectedCard();
    const payload = { type:action, ...(button.hasAttribute('data-player') ? { player } : {}) };
    if (['draw', 'restDon', 'activateDon', 'addDon', 'returnDon'].includes(action)) payload.count = 1;
    if (action === 'shuffle') payload.zone = 'deck';
    if (action === 'shuffleLife') Object.assign(payload, { type:'shuffle', zone:'life' });
    if (action === 'takeLife') Object.assign(payload, { type:'move', cardId:this.session.players[player].life[0]?.id, to:'hand' });
    if (action === 'addDon2') Object.assign(payload, { type:'addDon', count:2 });
    if (action === 'returnDon') payload.source = 'active';
    if (action === 'returnRestedDon') Object.assign(payload, { type:'returnDon', source:'rested', count:1 });
    if (['toggleRest', 'toggleFaceUp', 'attachDon', 'detachDon', 'powerUp', 'powerDown', 'returnAttachedDon'].includes(action)) {
      if (!selected) return;
      payload.player = selected.player; payload.cardId = selected.card.id; payload.count = 1;
      if (action === 'returnAttachedDon') Object.assign(payload, { type:'returnDon', source:selected.card.id });
      if (action.startsWith('power')) Object.assign(payload, { type:'power', delta:action === 'powerUp' ? 1000 : -1000 });
    }
    this.act(payload);
  }
}
