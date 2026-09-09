import { esc, initials, formatDate, MEMBERS } from './core.js';
import { icon } from './icons.js';
import { progressForXp, titleForLevel, xpAmountForResult, titleForHeadToHead } from './progression.js';
import { newlyUnlockedCosmetics, findCosmetic } from './cosmetics.js';
import { renderDeckBoxVisual } from './deck-box.js';
import { triggerLossStreakZoomVideo } from './easter-egg.js';

const RESULT_LABEL = { win:'Vittoria', loss:'Sconfitta', draw:'Pareggio' };
const STREAK_PLURAL = { win:'vittorie', loss:'sconfitte', draw:'pareggi' };
function ringColor(winRate) { return winRate >= 70 ? '#9cf07a' : winRate >= 45 ? '#f2c974' : '#ff8fa0'; }
const PERIODS = [{ value:'all', label:'Sempre' }, { value:'30d', label:'30 giorni' }, { value:'7d', label:'7 giorni' }];
const SCOPES = ['mine', 'team', 'board'];
const NEW_DECK_VALUE = '__new__';

export class StatsController {
  constructor({ api, getState, onRender, onModalRender, onToast } = {}) {
    Object.assign(this, { api, getState, onRender, onModalRender: onModalRender || onRender, onToast });
    this.scope = 'mine'; this.memberFilter = 'all'; this.deckFilter = 'all'; this.periodFilter = 'all';
    this.progression = null; this.cosmetics = null; this.missions = []; this.streak = null; this.myRows = []; this.teamRows = []; this.error = ''; this.rivalWins = {};
    this.matchModalOpen = false; this.matchForm = emptyForm(); this.opponentMode = 'external'; this.busy = false; this.lastResult = null;
    this.matchDetailOpen = false; this.matchDetail = null;
    this.loadInFlight = null;
    this.teamDecksAll = []; this.teamDecksLoaded = false; this.teamDecksLoadInFlight = null;
    this.boardRows = []; this.boardError = ''; this.boardLoadInFlight = null;
    this.timeline = []; this.timelineError = ''; this.chartPeriod = 30;
    this.mineDecksExpanded = false; this.mineMatchesExpanded = false;
  }
  get state() { return this.getState(); }
  get decks() { return (this.state.decks || []).filter(deck => deck.game === this.state.game); }
  get teammates() { return MEMBERS.filter(m => m.id !== this.state.currentUser); }
  get teamDeckOptions() {
    return [...new Map(this.teamRows.map(row => [row.deckId, row.deckName])).entries()].map(([id, name]) => ({ id, name }));
  }
  get teamMemberOptions() {
    return [...new Map(this.teamRows.map(row => [row.memberSlug, row.memberName])).entries()].map(([slug, name]) => ({ slug, name }));
  }
  get visibleRows() {
    if (this.scope === 'mine') return this.myRows;
    return this.teamRows.filter(row => (this.memberFilter === 'all' || row.memberSlug === this.memberFilter)
      && (this.deckFilter === 'all' || row.deckId === this.deckFilter));
  }
  get totals() {
    return this.visibleRows.reduce((sum, row) => ({
      matches: sum.matches + row.matches, wins: sum.wins + row.wins, losses: sum.losses + row.losses, draws: sum.draws + row.draws
    }), { matches:0, wins:0, losses:0, draws:0 });
  }
  opponentDecksForMember(slug) {
    return this.teamDecksAll.filter(deck => deck.owner_slug === slug && deck.game === this.state.game).map(deck => ({ id:deck.id, name:deck.name }));
  }
  get timelineRolling() {
    let wins = 0;
    return this.timeline.map((match, index) => {
      if (match.result === 'win') wins += 1;
      return { index: index + 1, playedAt: match.playedAt, winRate: Math.round((wins / (index + 1)) * 1000) / 10 };
    });
  }
  get periodComparison() {
    const winRateOf = rows => rows.length ? Math.round((rows.filter(m => m.result === 'win').length / rows.length) * 1000) / 10 : 0;
    return { last10: winRateOf(this.timeline.slice(-10)), last30: winRateOf(this.timeline.slice(-30)), overall: winRateOf(this.timeline) };
  }
  get recentMatches() { return [...this.timeline].reverse(); }
  async load() {
    if (this.loadInFlight) return this.loadInFlight;
    const request = (async () => {
      // Tutte le chiamate IN PARALLELO in un solo Promise.allSettled — core
      // (progression/streak/loadStats) e opzionali (cosmetics/missions/
      // timeline) sono separati solo per decidere se mostrare il banner
      // d'errore quando uno degli opzionali fallisce (RPC non ancora
      // deployata, errore transitorio), MAI per l'ordine delle richieste:
      // due Promise.allSettled sequenziali qui raddoppiavano il tempo di
      // caricamento reale della pagina (e dell'avatar, caricato dai
      // cosmetics) senza alcun bisogno, visto che nessuna di queste chiamate
      // dipende dal risultato di un'altra.
      const [progressionResult, streakResult, statsResult, cosmeticsResult, missionsResult, timelineResult, rivalWinsResult] = await Promise.allSettled([
        this.api.progression(), this.api.matchStreak(this.state.game), this.loadStats(),
        this.api.myCosmetics(), this.api.dailyMissions(), this.api.matchTimeline(this.state.game),
        this.api.rivalWins()
      ]);
      if (progressionResult.status === 'fulfilled') this.progression = progressionResult.value;
      if (streakResult.status === 'fulfilled') this.streak = streakResult.value;
      const coreFailure = [progressionResult, streakResult, statsResult].find(result => result.status === 'rejected');
      this.error = coreFailure ? (coreFailure.reason?.message || 'Statistiche non disponibili') : '';
      if (cosmeticsResult.status === 'fulfilled') this.cosmetics = cosmeticsResult.value;
      if (missionsResult.status === 'fulfilled') this.missions = missionsResult.value;
      if (rivalWinsResult.status === 'fulfilled') this.rivalWins = rivalWinsResult.value;
      if (timelineResult.status === 'fulfilled') { this.timeline = normalizeTimeline(timelineResult.value); this.timelineError = ''; }
      else this.timelineError = timelineResult.reason?.message || 'Andamento non disponibile';
      await this.claimNewCosmetics();
    })();
    this.loadInFlight = request;
    try { return await request; } finally { if (this.loadInFlight === request) this.loadInFlight = null; }
  }
  // Sblocco silenzioso: appena il livello aggiorna copre un cosmetic non
  // ancora "claim"-ato, lo registra subito lato server senza bisogno di un
  // popup dedicato — l'utente lo trova già disponibile in Personalizza.
  async claimNewCosmetics() {
    if (!this.progression || !this.cosmetics) return;
    const fresh = newlyUnlockedCosmetics(this.progression, this.cosmetics.unlocked, { rivalWins:this.rivalWins });
    if (!fresh.length) return;
    try {
      await Promise.all(fresh.map(item => this.api.claimCosmetic(item.id)));
      this.cosmetics = { ...this.cosmetics, unlocked: [...this.cosmetics.unlocked, ...fresh.map(item => item.id)] };
    } catch {}
  }
  // register_match aggiorna il progresso missione lato server via trigger
  // (vedi supabase-milestone-10-daily-missions.sql) — qui rileggiamo solo
  // per riflettere subito il cambiamento in UI senza un load() completo.
  async refreshMissions() {
    try { this.missions = await this.api.dailyMissions(); } catch {}
  }
  // Easter egg: chiamato da app.js SOLO quando si entra nella pagina
  // Statistiche (non ad ogni re-render interno), così parte "appena si
  // accede alla page" e non ad ogni cambio filtro/tab. this.streak arriva
  // già caricato da load() nella maggior parte dei casi (scope di default è
  // 'mine', quindi i dati ci sono già dal boot dell'app). Il flag si
  // riarma da solo appena la striscia smette di essere una sconfitta,
  // quindi la battuta si ripete alla prossima serie negativa senza
  // infastidire ad ogni singola visita mentre la striscia attuale continua.
  checkLossStreakEasterEgg() {
    if (this.streak?.result !== 'loss') { this._lossStreakEggShown = false; return; }
    if ((this.streak.count || 0) < 3 || this._lossStreakEggShown) return;
    this._lossStreakEggShown = true;
    if (this.scope !== 'mine') { this.scope = 'mine'; this.onRender(); }
    requestAnimationFrame(() => triggerLossStreakZoomVideo(document.querySelector('[data-stats-streak-badge]')));
    void this.claimEasterEggTitle('title_skill_issue', 'Skill Issue');
  }
  // Titoli "easter egg" (vedi js/cosmetics.js): nessuna condizione da
  // ricalcolare, si sbloccano nel momento esatto in cui l'utente vede il
  // rispettivo easter egg — claim_cosmetic è idempotente lato server
  // (on conflict do nothing), quindi richiamarla più volte non fa danni,
  // ma evitiamo comunque un secondo toast se è già nella lista sbloccati.
  async claimEasterEggTitle(id, label) {
    if (this.cosmetics?.unlocked?.includes(id)) return;
    try {
      await this.api.claimCosmetic(id);
      if (this.cosmetics) this.cosmetics = { ...this.cosmetics, unlocked:[...this.cosmetics.unlocked, id] };
      this.onToast?.(`Titolo sbloccato: ${label}`);
    } catch {}
  }
  async loadStats() {
    if (this.scope === 'mine') {
      // La panoramica "Io" mostra sempre lo storico completo (niente filtri
      // mazzo/periodo lì, vedi mock approvato) — i filtri restano solo per Team.
      this.myRows = normalizeRows(await this.api.stats(this.state.game, { deckId:null, period:'all' }));
    } else if (this.scope === 'team') {
      this.teamRows = normalizeTeamRows(await this.api.teamStats(this.state.game, { period:this.periodFilter }));
    }
  }
  async loadBoard() {
    if (this.boardLoadInFlight) return this.boardLoadInFlight;
    const request = (async () => {
      try { this.boardRows = normalizeH2HRows(await this.api.headToHead(this.state.game, { period:this.periodFilter })); this.boardError = ''; }
      catch (error) { this.boardError = error.message || 'Tabellone non disponibile'; }
    })();
    this.boardLoadInFlight = request;
    try { return await request; } finally { if (this.boardLoadInFlight === request) this.boardLoadInFlight = null; }
  }
  async loadTeamDecks() {
    if (this.teamDecksLoaded) return;
    if (this.teamDecksLoadInFlight) return this.teamDecksLoadInFlight;
    const request = (async () => { try { this.teamDecksAll = await this.api.teamDecks() || []; } catch { this.teamDecksAll = []; } this.teamDecksLoaded = true; })();
    this.teamDecksLoadInFlight = request;
    try { return await request; } finally { if (this.teamDecksLoadInFlight === request) this.teamDecksLoadInFlight = null; }
  }
  setScope(value) {
    if (!SCOPES.includes(value) || value === this.scope) return;
    this.scope = value; this.deckFilter = 'all'; this.memberFilter = 'all'; this.onRender();
    if (value === 'board') void this.loadBoard().then(() => this.onRender());
    else void this.loadStats().then(() => this.onRender());
  }
  setMemberFilter(value) { this.memberFilter = value; this.onRender(); }
  // Filtro mazzo/periodo: solo Team li usa (filtro client-side su teamRows già
  // caricate). "Io" non ha più filtri — mostra sempre lo storico completo.
  setDeckFilter(value) { this.deckFilter = value; this.onRender(); }
  setPeriodFilter(value) {
    if (!PERIODS.some(p => p.value === value) || value === this.periodFilter) return;
    this.periodFilter = value; this.onRender();
    if (this.scope === 'board') void this.loadBoard().then(() => this.onRender());
    else if (this.scope === 'team') void this.loadStats().then(() => this.onRender());
  }
  setChartPeriod(value) {
    const normalized = value === 'all' ? 'all' : Number(value);
    if (![10, 30, 'all'].includes(normalized)) return;
    this.chartPeriod = normalized; this.onRender();
  }
  toggleMineDecks() { this.mineDecksExpanded = !this.mineDecksExpanded; this.onRender(); }
  toggleMineMatches() { this.mineMatchesExpanded = !this.mineMatchesExpanded; this.onRender(); }
  openMatchDialog() { this.matchForm = emptyForm(this.decks[0]?.id); this.opponentMode = 'external'; this.lastResult = null; this.matchModalOpen = true; this.onModalRender(); }
  closeMatchDialog() { this.matchModalOpen = false; this.lastResult = null; this.onModalRender(); }
  setMatchDeck(deckId) { this.matchForm.deckId = deckId; this.onModalRender(); }
  setMatchResult(result) { if (!RESULT_LABEL[result]) return; this.matchForm.result = result; this.onModalRender(); }
  setMatchField(field, value) { this.matchForm[field] = value; }
  toggleMatchWentFirst(checked) { this.matchForm.wentFirst = checked; }
  openMatchDetail(id) {
    const match = this.timeline.find(item => item.id === id);
    if (!match) return;
    this.matchDetail = match; this.matchDetailOpen = true; this.onModalRender();
  }
  closeMatchDetail() { this.matchDetailOpen = false; this.matchDetail = null; this.onModalRender(); }
  setOpponentMode(mode) {
    if (!['external','team'].includes(mode) || mode === this.opponentMode) return;
    this.opponentMode = mode; this.matchForm.opponentMemberSlug = ''; this.matchForm.opponentDeckId = '';
    if (mode === 'team') void this.loadTeamDecks().then(() => this.onModalRender());
    this.onModalRender();
  }
  setOpponentMember(slug) {
    this.matchForm.opponentMemberSlug = slug;
    const decks = this.opponentDecksForMember(slug);
    this.matchForm.opponentDeckId = decks[0]?.id || (slug ? NEW_DECK_VALUE : '');
    this.matchForm.opponentDeckName = '';
    this.onModalRender();
  }
  setOpponentDeck(deckId) { this.matchForm.opponentDeckId = deckId; if (deckId !== NEW_DECK_VALUE) this.matchForm.opponentDeckName = ''; this.onModalRender(); }
  get teamOpponentValid() {
    if (this.opponentMode !== 'team') return true;
    if (!this.matchForm.opponentMemberSlug) return false;
    if (this.matchForm.opponentDeckId === NEW_DECK_VALUE) return this.matchForm.opponentDeckName.trim().length > 0;
    return !!this.matchForm.opponentDeckId;
  }
  async registerMatch() {
    const form = this.matchForm;
    if (this.busy || !form.deckId || !form.result || !this.teamOpponentValid) return;
    const isNewOpponentDeck = this.opponentMode === 'team' && form.opponentDeckId === NEW_DECK_VALUE;
    this.busy = true; this.onModalRender();
    try {
      const response = await this.api.registerMatch({
        game:this.state.game, deckId:form.deckId, result:form.result,
        opponentLabel:form.opponentLabel, opponentDeck:this.opponentMode === 'external' ? form.opponentDeck : '', notes:form.notes,
        opponentMemberSlug:this.opponentMode === 'team' ? form.opponentMemberSlug : null,
        opponentDeckId:this.opponentMode === 'team' && !isNewOpponentDeck ? form.opponentDeckId : null,
        opponentDeckName:isNewOpponentDeck ? form.opponentDeckName.trim() : '',
        wentFirst:form.wentFirst
      });
      this.progression = { ...this.progression, totalXp:response.totalXp, level:response.level };
      this.lastResult = { result:form.result, wentFirst:form.wentFirst, ...response };
      // Solo una vittoria contro un compagno reale può far scattare un avatar
      // "rivalità" (vedi js/cosmetics.js) — evita una RPC in più per ogni
      // altro esito, ma aggiorna il conteggio subito quando può contare,
      // invece di aspettare il prossimo load() della pagina.
      if (form.result === 'win' && this.opponentMode === 'team' && form.opponentMemberSlug) {
        try { this.rivalWins = await this.api.rivalWins(); } catch {}
      }
      void this.claimNewCosmetics();
      void this.refreshMissions();
      const [, streak, timelineRows] = await Promise.all([this.loadStats(), this.api.matchStreak(this.state.game), this.api.matchTimeline(this.state.game).catch(() => null)]);
      this.streak = streak;
      if (timelineRows) { this.timeline = normalizeTimeline(timelineRows); this.timelineError = ''; }
      if (this.opponentMode === 'team') { this.boardRows = []; } // il tabellone verrà ricaricato al prossimo accesso alla tab
      if (isNewOpponentDeck) { this.teamDecksLoaded = false; this.teamDecksAll = []; } // il mazzo appena creato per il compagno deve comparire nel prossimo dialog
    } catch (error) { this.onToast?.(error.message || 'Registrazione match non riuscita'); }
    finally { this.busy = false; this.onModalRender(); }
  }
  // Il modal "Registra match" NON viene emesso qui dentro: .page-stage ha
  // view-transition-name, che in Chrome intrappola i figli position:fixed nel
  // proprio containing block invece della viewport (stesso motivo per cui gli
  // altri modal top-level dell'app — prestito, drawer progressione, pannello
  // avatar — sono renderizzati fuori da .page-stage in appView()). Lo rende
  // app.js leggendo stats.matchModalOpen/stats.matchModalView(); per questo
  // le azioni del modal chiamano onModalRender (render(true) completo) invece
  // di onRender (renderRoute, che tocca solo .page-stage e non
  // aggiornerebbe mai un modal fuori da lì).
  view() {
    return `<section class="page-stack stats-page">
      ${this.error ? `<div class="connection-banner error">${esc(this.error)}</div>` : ''}
      <header class="page-header split"><div><span class="eyebrow">Statistiche</span><h1>${this.state.game === 'onepiece' ? 'One Piece Card Game' : 'Yu-Gi-Oh!'}</h1></div><button class="btn" data-stats-new-match>${icon('plus')} Registra match</button></header>
      <div class="tabs" role="tablist" aria-label="Ambito statistiche"><button type="button" data-stats-scope="mine" class="${this.scope === 'mine' ? 'active' : ''}" role="tab" aria-selected="${this.scope === 'mine'}">Io</button><button type="button" data-stats-scope="team" class="${this.scope === 'team' ? 'active' : ''}" role="tab" aria-selected="${this.scope === 'team'}">Team</button><button type="button" data-stats-scope="board" class="${this.scope === 'board' ? 'active' : ''}" role="tab" aria-selected="${this.scope === 'board'}">${icon('trophy')} Tabellone</button></div>
      ${this.scope === 'mine' ? this.mineOverviewView() : this.scope === 'board' ? this.boardView() : `${this.heroView()}${this.filtersView()}${this.deckListView()}`}
    </section>`;
  }
  // Solo Team la usa ormai: "Io" non ha più filtri, mostra sempre lo storico completo.
  filtersView() {
    return `<div class="stats-filters">
      <label>Filtra membro<select data-stats-member><option value="all">Tutti</option>${this.teamMemberOptions.map(opt => `<option value="${esc(opt.slug)}" ${this.memberFilter === opt.slug ? 'selected' : ''}>${esc(opt.name)}</option>`).join('')}</select></label>
      <label>Filtra mazzo<select data-stats-deck><option value="all">Tutti</option>${this.teamDeckOptions.map(opt => `<option value="${esc(opt.id)}" ${this.deckFilter === opt.id ? 'selected' : ''}>${esc(opt.name)}</option>`).join('')}</select></label>
      <div class="filter-chips" role="group" aria-label="Periodo">${PERIODS.map(p => `<button type="button" class="chip ${this.periodFilter === p.value ? 'active' : ''}" data-stats-period="${p.value}">${p.label}</button>`).join('')}</div>
    </div>`;
  }
  heroView() {
    const t = this.totals, winRate = t.matches ? Math.round((t.wins / t.matches) * 1000) / 10 : 0;
    const streak = this.scope === 'mine' ? this.streak : null;
    const streakLabel = streak?.count > 1 ? `Striscia: ${streak.count} ${STREAK_PLURAL[streak.result] || streak.result}` : '';
    return `<section class="stats-hero foil-frame">
      <div class="stats-ring" style="--pct:${winRate};--ring-color:${ringColor(winRate)}"><div class="stats-ring-inner"><strong class="foil-text">${winRate}%</strong><small>win rate</small></div></div>
      <div class="stats-hero-side">
        <div class="stats-hero-match"><strong>${t.matches}</strong><small>match</small></div>
        <div class="stats-wld"><span class="win">${t.wins}V</span><span class="loss">${t.losses}S</span><span class="draw">${t.draws}P</span></div>
        ${streakLabel ? `<div class="stats-streak ${streak.result}">${icon('flash')} ${esc(streakLabel)}</div>` : ''}
      </div>
    </section>`;
  }
  mineOverviewView() {
    const t = this.totals, winRate = t.matches ? Math.round((t.wins / t.matches) * 1000) / 10 : 0;
    const streak = this.streak;
    const playerName = MEMBERS.find(m => m.id === this.state.currentUser)?.name || 'Tu';
    const progress = progressForXp(this.progression?.totalXp || 0), level = this.progression?.level || 1;
    const equippedAvatar = findCosmetic(this.cosmetics?.activeAvatar);
    const avatarMarkup = equippedAvatar?.image
      ? `<span class="avatar large has-image"><img src="${esc(equippedAvatar.image)}" alt="${esc(equippedAvatar.label)}"></span>`
      : `<i class="mini-avatar lg member-${esc(this.state.currentUser)}">${initials(playerName)}</i>`;
    return `<section class="stats-player-card foil-frame">
      <div class="stats-player-row">
        ${avatarMarkup}
        <div class="stats-player-copy"><strong>${esc(playerName)}<i class="stats-online-dot" aria-hidden="true"></i></strong><small>${esc(titleForLevel(level))}</small></div>
        <div class="stats-player-level"><b>LV ${level}</b><div class="xp-bar"><i style="--progress:${progress.progress}"></i></div><small>${progress.currentLevelXp} / ${progress.nextLevelXp || progress.currentLevelXp} XP</small></div>
      </div>
    </section>
    <div class="stats-tile-row">
      <div class="stats-tile"><b>${t.matches}</b><small>Match totali</small></div>
      <div class="stats-tile win"><b>${t.wins}</b><small>Vittorie</small></div>
      <div class="stats-tile loss"><b>${t.losses}</b><small>Sconfitte</small></div>
      <div class="stats-tile ${streak?.result === 'win' ? 'win' : streak?.result === 'loss' ? 'loss' : ''}" data-stats-streak-badge><b>${streak?.count || 0}</b><small>Streak</small></div>
      <div class="stats-tile accent"><b>${winRate}%</b><small>Win Rate</small></div>
    </div>
    ${this.chartCardView()}
    ${this.deckPerformanceView()}
    ${this.recentMatchesView()}`;
  }
  chartCardView() {
    const points = this.chartPeriod === 'all' ? this.timelineRolling : this.timelineRolling.slice(-this.chartPeriod);
    const cmp = this.periodComparison;
    return `<section class="stats-chart-card foil-frame">
      <div class="stats-chart-head">
        <div><h2>${icon('chart')} Andamento giocatore</h2><small>Win rate progressivo nel tempo</small></div>
        <select data-chart-period>${[10, 30, 'all'].map(value => `<option value="${value}" ${this.chartPeriod === value ? 'selected' : ''}>${value === 'all' ? 'Tutti i match' : `Ultimi ${value} match`}</option>`).join('')}</select>
      </div>
      ${this.timelineError ? `<p class="stats-chart-empty">${esc(this.timelineError)}</p>`
        : points.length < 2 ? `<p class="stats-chart-empty">Registra almeno 2 match per vedere l'andamento.</p>`
        : lineChartSvg(points)}
      <div class="stats-compare-row">
        <div><small>Ultimi 10</small><b>${cmp.last10}%</b></div>
        <div><small>Ultimi 30</small><b>${cmp.last30}%</b></div>
        <div><small>Sempre</small><b>${cmp.overall}%</b></div>
      </div>
    </section>`;
  }
  deckBoxThumb(deckId) {
    const deck = (this.state.decks || []).find(item => String(item.id) === String(deckId));
    return deck ? renderDeckBoxVisual(deck, { className:'stats-deck-bar-thumb' }) : `<span class="stats-deck-bar-thumb">${icon('deck')}</span>`;
  }
  deckPerformanceView() {
    const rows = this.myRows;
    const visible = this.mineDecksExpanded ? rows : rows.slice(0, 4);
    return `<section class="stats-section foil-frame">
      <div class="stats-section-head"><h2>${icon('deck')} Performance mazzi</h2>${rows.length > 4 ? `<button type="button" data-mine-decks-toggle>${this.mineDecksExpanded ? 'Mostra meno' : 'Vedi tutti'} ${icon('arrow')}</button>` : ''}</div>
      ${rows.length ? `<div class="stats-deck-bars">${visible.map(row => `<button type="button" class="stats-deck-bar-row" data-stats-deck-row="${esc(row.deckId)}">
        ${this.deckBoxThumb(row.deckId)}
        <span class="stats-deck-bar-copy">
          <strong>${esc(row.deckName)}</strong><small>${row.matches} match</small>
          <span class="stats-deck-bar-track"><i style="width:${row.winRate}%"></i></span>
        </span>
        <span class="stats-deck-bar-figures"><b>${row.winRate}%</b><small>${row.wins}V - ${row.losses}S - ${row.draws}P</small></span>
      </button>`).join('')}</div>` : `<p class="stats-chart-empty">Nessun mazzo con match registrati.</p>`}
    </section>`;
  }
  recentMatchesView() {
    const matches = this.recentMatches;
    const visible = matches.slice(0, this.mineMatchesExpanded ? 20 : 4);
    return `<section class="stats-section foil-frame">
      <div class="stats-section-head"><h2>${icon('flash')} Ultimi match</h2>${matches.length > 4 ? `<button type="button" data-mine-matches-toggle>${this.mineMatchesExpanded ? 'Mostra meno' : 'Vedi tutti'} ${icon('arrow')}</button>` : ''}</div>
      ${visible.length ? `<div class="stats-recent-list">${visible.map(match => `<button type="button" class="stats-recent-row" data-stats-match-open="${esc(match.id)}">
        <small class="stats-recent-date">${esc(formatDate(match.playedAt))}</small>
        <span class="stats-recent-matchup"><strong>${esc(match.deckName)}</strong> <i>vs</i> <strong>${esc(match.opponentDeck || match.opponentLabel || 'Avversario esterno')}</strong>${match.opponentLabel && match.opponentDeck ? `<small>(${esc(match.opponentLabel)})</small>` : ''}</span>
        <span class="stats-recent-outcome"><span class="badge-result ${match.result}">${RESULT_LABEL[match.result]}</span>${matchDieBadge(match.wentFirst)}</span>
        <span class="badge-scope ${match.isTeamMatch ? 'team' : 'external'}">${match.isTeamMatch ? 'Team' : 'Esterno'}</span>
      </button>`).join('')}</div>` : `<p class="stats-chart-empty">Nessun match registrato.</p>`}
    </section>`;
  }
  deckListView() {
    if (!this.visibleRows.length) return `<div class="empty-state">${icon('chart')}<h2>Nessun match registrato</h2><p>Registra il primo match per iniziare a costruire le statistiche.</p></div>`;
    return `<div class="stats-deck-list">${this.visibleRows.map(row => `<button type="button" class="stats-deck-row foil-frame" data-stats-deck-row="${esc(row.deckId)}">
      <div class="stats-ring small" style="--pct:${row.winRate};--ring-color:${ringColor(row.winRate)}"><div class="stats-ring-inner"><b>${row.winRate}%</b></div></div>
      ${row.memberName ? `<i class="mini-avatar member-${esc(row.memberSlug)}">${initials(row.memberName)}</i>` : ''}
      <span class="stats-deck-info"><strong>${esc(row.deckName)}</strong>${row.memberName ? `<small>${esc(row.memberName)}</small>` : ''}
        <span class="stats-wld small"><b class="win">${row.wins} V</b>${row.losses ? ` · <b class="loss">${row.losses} S</b>` : ''}${row.draws ? ` · <b class="draw">${row.draws} P</b>` : ''}</span>
      </span>
      <small class="stats-deck-matches">${row.matches} match</small>
      ${icon('arrow')}
    </button>`).join('')}</div>`;
  }
  boardView() {
    const periodChips = `<div class="stats-filters"><div class="filter-chips" role="group" aria-label="Periodo">${PERIODS.map(p => `<button type="button" class="chip ${this.periodFilter === p.value ? 'active' : ''}" data-stats-period="${p.value}">${p.label}</button>`).join('')}</div></div>`;
    if (this.boardError) return `${periodChips}<div class="connection-banner error">${esc(this.boardError)}</div>`;
    if (!this.boardRows.length) return `${periodChips}<div class="empty-state">${icon('trophy')}<h2>Nessuna sfida interna al team</h2><p>Registra un match scegliendo "Compagno di squadra" come avversario per iniziare a popolare il tabellone.</p></div>`;
    const members = [...new Map(this.boardRows.flatMap(r => [[r.memberSlug, r.memberName], [r.opponentSlug, r.opponentName]])).entries()]
      .map(([slug, name]) => ({ slug, name }));
    const totalsBySlug = new Map(members.map(m => [m.slug, { wins:0, losses:0, draws:0 }]));
    this.boardRows.forEach(row => { const t = totalsBySlug.get(row.memberSlug); if (t) { t.wins += row.wins; t.losses += row.losses; t.draws += row.draws; } });
    members.sort((a, b) => (totalsBySlug.get(b.slug).wins - totalsBySlug.get(b.slug).losses) - (totalsBySlug.get(a.slug).wins - totalsBySlug.get(a.slug).losses));
    const cell = (rowSlug, colSlug) => {
      const found = this.boardRows.find(r => r.memberSlug === rowSlug && r.opponentSlug === colSlug);
      if (!found) return '<td class="h2h-empty">–</td>';
      const draws = found.draws ? `<small>${found.draws}P</small>` : '';
      return `<td class="${found.wins > found.losses ? 'h2h-ahead' : found.wins < found.losses ? 'h2h-behind' : 'h2h-even'}"><b class="win">${found.wins}</b>-<b class="loss">${found.losses}</b>${draws}</td>`;
    };
    return `${periodChips}<div class="h2h-scroll foil-frame"><table class="h2h-table">
      <thead><tr><th class="h2h-corner"></th>${members.map(m => `<th><i class="mini-avatar member-${esc(m.slug)}">${initials(m.name)}</i></th>`).join('')}</tr></thead>
      <tbody>${members.map(rowMember => `<tr>
        <th class="h2h-row-head"><i class="mini-avatar member-${esc(rowMember.slug)}">${initials(rowMember.name)}</i><span><strong>${esc(rowMember.name)}</strong><small>${esc(titleForHeadToHead(totalsBySlug.get(rowMember.slug).wins))}</small></span></th>
        ${members.map(colMember => colMember.slug === rowMember.slug ? '<td class="h2h-self">—</td>' : cell(rowMember.slug, colMember.slug)).join('')}
      </tr>`).join('')}</tbody>
    </table></div>`;
  }
  matchModalView() {
    if (this.lastResult) return this.feedbackView();
    const form = this.matchForm;
    const opponentDecks = form.opponentMemberSlug ? this.opponentDecksForMember(form.opponentMemberSlug) : [];
    const opponentName = this.teammates.find(m => m.id === form.opponentMemberSlug)?.name || 'il compagno';
    const showNewDeckField = this.opponentMode === 'team' && form.opponentMemberSlug && form.opponentDeckId === NEW_DECK_VALUE;
    return `<div class="detail-backdrop deck-dialog-backdrop" data-match-close><aside class="card-detail foil-frame stats-modal-glow" role="dialog" aria-modal="true" aria-label="Registra match">
      <button class="detail-close" data-match-close aria-label="Chiudi">×</button>
      <span class="eyebrow">Registra match</span><h2>Nuovo risultato</h2>
      <label>Mazzo<select data-match-deck>${this.decks.map(deck => `<option value="${esc(deck.id)}" ${form.deckId === deck.id ? 'selected' : ''}>${esc(deck.name)}</option>`).join('') || '<option value="">Nessun mazzo disponibile</option>'}</select></label>
      <div class="match-result-group" role="group" aria-label="Risultato">${Object.entries(RESULT_LABEL).map(([value, label]) => `<button type="button" class="match-result-btn ${value} ${form.result === value ? 'active' : ''}" data-match-result="${value}">${label}</button>`).join('')}</div>
      <label class="match-went-first">${icon('dice')}<span>Sei andato primo? <small>(hai vinto il tiro di dado)</small></span><input type="checkbox" data-match-went-first ${form.wentFirst ? 'checked' : ''}></label>
      <div class="opponent-mode-group" role="group" aria-label="Tipo avversario">
        <button type="button" class="chip ${this.opponentMode === 'external' ? 'active' : ''}" data-opponent-mode="external">Avversario esterno</button>
        <button type="button" class="chip ${this.opponentMode === 'team' ? 'active' : ''}" data-opponent-mode="team">${icon('team')} Compagno di squadra</button>
      </div>
      ${this.opponentMode === 'team' ? `
      <label>Compagno<select data-match-opponent-member><option value="">Scegli un compagno</option>${this.teammates.map(m => `<option value="${esc(m.id)}" ${form.opponentMemberSlug === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
      ${form.opponentMemberSlug && opponentDecks.length ? `<label>Mazzo del compagno<select data-match-opponent-deck>${opponentDecks.map(d => `<option value="${esc(d.id)}" ${form.opponentDeckId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}<option value="${NEW_DECK_VALUE}" ${form.opponentDeckId === NEW_DECK_VALUE ? 'selected' : ''}>+ Nuovo mazzo…</option></select></label>` : ''}
      ${showNewDeckField ? `<label>${opponentDecks.length ? `Nome del nuovo mazzo di ${esc(opponentName)}` : `Che mazzo sta usando ${esc(opponentName)}? (non ha ancora un mazzo salvato)`}<input data-match-opponent-deck-name maxlength="80" value="${esc(form.opponentDeckName)}" placeholder="Es. Blue-Eyes"></label>` : ''}
      ` : `<label>Avversario / Deck<input data-match-field="opponentDeck" maxlength="120" value="${esc(form.opponentDeck)}" placeholder="Es. Labrynth"></label>`}
      <label>Note<textarea data-match-field="notes" maxlength="500" placeholder="Facoltative">${esc(form.notes)}</textarea></label>
      <button class="btn wide" data-match-submit ${this.busy || !form.deckId || !form.result || !this.teamOpponentValid ? 'disabled' : ''}>${this.busy ? 'Registro…' : 'Registra'}</button>
    </aside></div>`;
  }
  feedbackView() {
    const result = this.lastResult, progress = progressForXp(result.totalXp), title = titleForLevel(result.level);
    const capped = result.xpAwarded < xpAmountForResult(result.result);
    return `<div class="detail-backdrop deck-dialog-backdrop" data-match-close><aside class="card-detail match-feedback foil-frame stats-modal-glow" role="dialog" aria-modal="true" aria-label="Match registrato">
      <button class="detail-close" data-match-close aria-label="Chiudi">×</button>
      <span class="eyebrow">✓ Match registrato</span><h2 class="match-feedback-result ${result.result}">${RESULT_LABEL[result.result]} ${matchDieBadge(result.wentFirst)}</h2>
      <p class="match-feedback-xp foil-text">+${result.xpAwarded} XP</p>
      ${capped ? `<p class="match-feedback-cap">${icon('info')} Limite giornaliero raggiunto</p>` : ''}
      <div class="xp-bar-block"><small>LV ${result.level}</small><div class="xp-bar"><i style="--progress:${progress.progress}"></i></div><small>${progress.currentLevelXp} / ${progress.nextLevelXp || progress.currentLevelXp} XP</small></div>
      ${result.levelUp ? `<div class="level-up-banner foil-frame">${icon('star')} LEVEL UP!<b>LV ${result.level}</b><small>${esc(title)}</small></div>` : ''}
      <button class="btn wide" data-match-close>Chiudi</button>
    </aside></div>`;
  }
  matchDetailView() {
    const match = this.matchDetail;
    if (!match) return '';
    return `<div class="detail-backdrop deck-dialog-backdrop" data-match-detail-close><aside class="card-detail foil-frame stats-modal-glow" role="dialog" aria-modal="true" aria-label="Resoconto match">
      <button class="detail-close" data-match-detail-close aria-label="Chiudi">×</button>
      <span class="eyebrow">Resoconto match</span><h2 class="match-feedback-result ${match.result}">${RESULT_LABEL[match.result]} ${matchDieBadge(match.wentFirst)}</h2>
      <div class="match-detail-row"><small>Data</small><b>${esc(formatDate(match.playedAt))}</b></div>
      <div class="match-detail-row"><small>Il tuo mazzo</small><b>${esc(match.deckName)}</b></div>
      <div class="match-detail-row"><small>Avversario</small><b>${esc(match.opponentDeck || match.opponentLabel || 'Avversario esterno')}${match.opponentLabel && match.opponentDeck ? ` (${esc(match.opponentLabel)})` : ''}</b></div>
      <div class="match-detail-row"><small>Tipo</small><b>${match.isTeamMatch ? 'Compagno di squadra' : 'Avversario esterno'}</b></div>
      ${match.wentFirst !== null ? `<div class="match-detail-row"><small>Ordine di turno</small><b>${match.wentFirst ? 'Sei andato primo' : 'Sei andato secondo'}</b></div>` : ''}
      <div class="match-detail-row"><small>XP guadagnati</small><b>+${match.xpAwarded}</b></div>
      ${match.notes ? `<p class="match-detail-notes">${esc(match.notes)}</p>` : ''}
      <button class="btn wide" data-match-detail-close>Chiudi</button>
    </aside></div>`;
  }
  bind(root) {
    root.querySelector('[data-stats-new-match]')?.addEventListener('click', () => this.openMatchDialog());
    root.querySelectorAll('[data-stats-scope]').forEach(button => button.addEventListener('click', () => this.setScope(button.dataset.statsScope)));
    root.querySelector('[data-stats-member]')?.addEventListener('change', event => this.setMemberFilter(event.currentTarget.value));
    root.querySelector('[data-stats-deck]')?.addEventListener('change', event => this.setDeckFilter(event.currentTarget.value));
    root.querySelectorAll('[data-stats-period]').forEach(button => button.addEventListener('click', () => this.setPeriodFilter(button.dataset.statsPeriod)));
    root.querySelectorAll('[data-stats-deck-row]').forEach(button => button.addEventListener('click', () => this.setDeckFilter(this.deckFilter === button.dataset.statsDeckRow ? 'all' : button.dataset.statsDeckRow)));
    root.querySelector('[data-chart-period]')?.addEventListener('change', event => this.setChartPeriod(event.currentTarget.value));
    root.querySelector('[data-mine-decks-toggle]')?.addEventListener('click', () => this.toggleMineDecks());
    root.querySelector('[data-mine-matches-toggle]')?.addEventListener('click', () => this.toggleMineMatches());
    root.querySelectorAll('[data-match-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.closeMatchDialog(); }));
    root.querySelector('[data-match-deck]')?.addEventListener('change', event => this.setMatchDeck(event.currentTarget.value));
    root.querySelectorAll('[data-match-result]').forEach(button => button.addEventListener('click', () => this.setMatchResult(button.dataset.matchResult)));
    root.querySelectorAll('[data-opponent-mode]').forEach(button => button.addEventListener('click', () => this.setOpponentMode(button.dataset.opponentMode)));
    root.querySelector('[data-match-opponent-member]')?.addEventListener('change', event => this.setOpponentMember(event.currentTarget.value));
    root.querySelector('[data-match-opponent-deck]')?.addEventListener('change', event => this.setOpponentDeck(event.currentTarget.value));
    root.querySelector('[data-match-opponent-deck-name]')?.addEventListener('input', event => {
      this.matchForm.opponentDeckName = event.currentTarget.value;
      const submit = root.querySelector('[data-match-submit]');
      if (submit) submit.disabled = this.busy || !this.matchForm.deckId || !this.matchForm.result || !this.teamOpponentValid;
    });
    root.querySelectorAll('[data-match-field]').forEach(field => field.addEventListener('input', event => this.setMatchField(event.currentTarget.dataset.matchField, event.currentTarget.value)));
    root.querySelector('[data-match-went-first]')?.addEventListener('change', event => this.toggleMatchWentFirst(event.currentTarget.checked));
    root.querySelector('[data-match-submit]')?.addEventListener('click', () => void this.registerMatch());
    root.querySelectorAll('[data-stats-match-open]').forEach(button => button.addEventListener('click', () => this.openMatchDetail(button.dataset.statsMatchOpen)));
    root.querySelectorAll('[data-match-detail-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.closeMatchDetail(); }));
  }
}

function emptyForm(deckId = '') { return { deckId, result:'', opponentLabel:'', opponentDeck:'', notes:'', opponentMemberSlug:'', opponentDeckId:'', opponentDeckName:'', wentFirst:false }; }

function normalizeRows(rows) {
  return (rows || []).map(row => ({ deckId:row.deck_id, deckName:row.deck_name, matches:row.matches, wins:row.wins, losses:row.losses, draws:row.draws, winRate:Number(row.win_rate) }));
}
function normalizeTeamRows(rows) {
  return (rows || []).map(row => ({ memberSlug:row.member_slug, memberName:row.member_name, deckId:row.deck_id, deckName:row.deck_name, matches:row.matches, wins:row.wins, losses:row.losses, draws:row.draws, winRate:Number(row.win_rate) }));
}
function normalizeH2HRows(rows) {
  return (rows || []).map(row => ({ memberSlug:row.member_slug, memberName:row.member_name, opponentSlug:row.opponent_slug, opponentName:row.opponent_name, wins:row.wins, losses:row.losses, draws:row.draws, matches:row.matches }));
}
// Nessun badge per i match registrati prima di questa feature (went_first
// è null in DB, non false): meglio non mostrare nulla che mostrare un dato
// inventato.
function matchDieBadge(wentFirst) {
  if (wentFirst === null || wentFirst === undefined) return '';
  return `<span class="match-die-badge ${wentFirst ? 'first' : 'second'}" title="${wentFirst ? 'Sei andato primo' : 'Sei andato secondo'}">${icon(wentFirst ? 'dice' : 'diceOff')}</span>`;
}
function normalizeTimeline(rows) {
  return (rows || []).map(row => ({
    id:row.id, playedAt:row.played_at, result:row.result, deckName:row.deck_name,
    opponentLabel:row.opponent_label || '', opponentDeck:row.opponent_deck || '', isTeamMatch:Boolean(row.is_team_match),
    notes:row.notes || '', xpAwarded:row.xp_awarded ?? 0, wentFirst:row.went_first === null || row.went_first === undefined ? null : Boolean(row.went_first)
  }));
}

// Grafico "Andamento giocatore": una sola serie (win rate cumulativo), quindi
// niente palette categorica da validare — un solo hue (--accent, già quello
// del brand). Marcatori diradati + un target d'hover più largo di ognuno con
// <title> nativo (tooltip a basso costo, nessun JS di interazione da cablare)
// più una callout statica sull'ultimo punto, come nel mock approvato.
function lineChartSvg(points) {
  const width = 300, height = 132, padL = 26, padR = 8, padT = 10, padB = 18;
  const innerW = width - padL - padR, innerH = height - padT - padB, n = points.length;
  const x = index => padL + (n === 1 ? innerW : (index / (n - 1)) * innerW);
  const y = value => padT + innerH - (value / 100) * innerH;
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.winRate).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${x(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;
  const gridLines = [0, 25, 50, 75, 100].map(value => `<line x1="${padL}" x2="${width - padR}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}" class="stats-chart-grid"/><text x="1" y="${(y(value) + 3).toFixed(1)}" class="stats-chart-axis">${value}%</text>`).join('');
  const markerStep = Math.max(1, Math.round(n / 6));
  const markers = points.map((point, index) => (index % markerStep === 0 || index === n - 1) ? `<circle cx="${x(index).toFixed(1)}" cy="${y(point.winRate).toFixed(1)}" r="2.6" class="stats-chart-dot"/>` : '').join('');
  const hits = points.map((point, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(point.winRate).toFixed(1)}" r="9" class="stats-chart-hit"><title>Match ${point.index} · Win rate ${point.winRate}%</title></circle>`).join('');
  const last = points[n - 1], calloutX = x(n - 1), calloutY = y(last.winRate);
  return `<div class="stats-chart-wrap">
    <svg viewBox="0 0 ${width} ${height}" class="stats-chart-svg" role="img" aria-label="Andamento win rate: ${points.map(p => `match ${p.index} ${p.winRate}%`).join(', ')}">
      <defs><linearGradient id="statsChartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      ${gridLines}
      <path d="${areaPath}" class="stats-chart-area"/>
      <path d="${linePath}" class="stats-chart-line"/>
      ${markers}
      <circle cx="${calloutX.toFixed(1)}" cy="${calloutY.toFixed(1)}" r="4" class="stats-chart-dot current"/>
      ${hits}
    </svg>
    <div class="stats-chart-callout" style="right:${(100 - (calloutX / width) * 100).toFixed(1)}%;top:${((calloutY / height) * 100).toFixed(1)}%"><small>Match ${last.index}</small><b>Win Rate: ${last.winRate}%</b></div>
  </div>`;
}
