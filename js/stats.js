import { esc, initials, MEMBERS } from './core.js';
import { icon } from './icons.js';
import { progressForXp, titleForLevel, xpAmountForResult, titleForHeadToHead } from './progression.js';
import { newlyUnlockedCosmetics } from './cosmetics.js';

const RESULT_LABEL = { win:'Vittoria', loss:'Sconfitta', draw:'Pareggio' };
const STREAK_PLURAL = { win:'vittorie', loss:'sconfitte', draw:'pareggi' };
function ringColor(winRate) { return winRate >= 70 ? '#9cf07a' : winRate >= 45 ? '#f2c974' : '#ff8fa0'; }
const PERIODS = [{ value:'all', label:'Sempre' }, { value:'30d', label:'30 giorni' }, { value:'7d', label:'7 giorni' }];
const SCOPES = ['mine', 'team', 'board'];
const NEW_DECK_VALUE = '__new__';

export class StatsController {
  constructor({ api, getState, onRender, onToast } = {}) {
    Object.assign(this, { api, getState, onRender, onToast });
    this.scope = 'mine'; this.memberFilter = 'all'; this.deckFilter = 'all'; this.periodFilter = 'all';
    this.progression = null; this.cosmetics = null; this.missions = []; this.streak = null; this.myRows = []; this.teamRows = []; this.error = '';
    this.matchModalOpen = false; this.matchForm = emptyForm(); this.opponentMode = 'external'; this.busy = false; this.lastResult = null;
    this.loadInFlight = null;
    this.teamDecksAll = []; this.teamDecksLoaded = false; this.teamDecksLoadInFlight = null;
    this.boardRows = []; this.boardError = ''; this.boardLoadInFlight = null;
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
  async load() {
    if (this.loadInFlight) return this.loadInFlight;
    const request = (async () => {
      try {
        const [progression, cosmetics, missions, streak] = await Promise.all([this.api.progression(), this.api.myCosmetics(), this.api.dailyMissions(), this.api.matchStreak(this.state.game), this.loadStats()]);
        this.progression = progression; this.cosmetics = cosmetics; this.missions = missions; this.streak = streak; this.error = '';
        await this.claimNewCosmetics();
      } catch (error) { this.error = error.message || 'Statistiche non disponibili'; }
    })();
    this.loadInFlight = request;
    try { return await request; } finally { if (this.loadInFlight === request) this.loadInFlight = null; }
  }
  // Sblocco silenzioso: appena il livello aggiorna copre un cosmetic non
  // ancora "claim"-ato, lo registra subito lato server senza bisogno di un
  // popup dedicato — l'utente lo trova già disponibile in Personalizza.
  async claimNewCosmetics() {
    if (!this.progression || !this.cosmetics) return;
    const fresh = newlyUnlockedCosmetics(this.progression, this.cosmetics.unlocked);
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
  async loadStats() {
    const period = this.periodFilter;
    if (this.scope === 'mine') {
      const deckId = this.deckFilter !== 'all' ? this.deckFilter : null;
      this.myRows = normalizeRows(await this.api.stats(this.state.game, { deckId, period }));
    } else if (this.scope === 'team') {
      this.teamRows = normalizeTeamRows(await this.api.teamStats(this.state.game, { period }));
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
  setDeckFilter(value) { this.deckFilter = value; this.onRender(); if (this.scope === 'mine') void this.loadStats().then(() => this.onRender()); }
  setPeriodFilter(value) {
    if (!PERIODS.some(p => p.value === value) || value === this.periodFilter) return;
    this.periodFilter = value; this.onRender();
    if (this.scope === 'board') void this.loadBoard().then(() => this.onRender());
    else void this.loadStats().then(() => this.onRender());
  }
  openMatchDialog() { this.matchForm = emptyForm(this.decks[0]?.id); this.opponentMode = 'external'; this.lastResult = null; this.matchModalOpen = true; this.onRender(); }
  closeMatchDialog() { this.matchModalOpen = false; this.lastResult = null; this.onRender(); }
  setMatchDeck(deckId) { this.matchForm.deckId = deckId; this.onRender(); }
  setMatchResult(result) { if (!RESULT_LABEL[result]) return; this.matchForm.result = result; this.onRender(); }
  setMatchField(field, value) { this.matchForm[field] = value; }
  setOpponentMode(mode) {
    if (!['external','team'].includes(mode) || mode === this.opponentMode) return;
    this.opponentMode = mode; this.matchForm.opponentMemberSlug = ''; this.matchForm.opponentDeckId = '';
    if (mode === 'team') void this.loadTeamDecks().then(() => this.onRender());
    this.onRender();
  }
  setOpponentMember(slug) {
    this.matchForm.opponentMemberSlug = slug;
    const decks = this.opponentDecksForMember(slug);
    this.matchForm.opponentDeckId = decks[0]?.id || (slug ? NEW_DECK_VALUE : '');
    this.matchForm.opponentDeckName = '';
    this.onRender();
  }
  setOpponentDeck(deckId) { this.matchForm.opponentDeckId = deckId; if (deckId !== NEW_DECK_VALUE) this.matchForm.opponentDeckName = ''; this.onRender(); }
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
    this.busy = true; this.onRender();
    try {
      const response = await this.api.registerMatch({
        game:this.state.game, deckId:form.deckId, result:form.result,
        opponentLabel:form.opponentLabel, opponentDeck:this.opponentMode === 'external' ? form.opponentDeck : '', notes:form.notes,
        opponentMemberSlug:this.opponentMode === 'team' ? form.opponentMemberSlug : null,
        opponentDeckId:this.opponentMode === 'team' && !isNewOpponentDeck ? form.opponentDeckId : null,
        opponentDeckName:isNewOpponentDeck ? form.opponentDeckName.trim() : ''
      });
      this.progression = { ...this.progression, totalXp:response.totalXp, level:response.level };
      this.lastResult = { result:form.result, ...response };
      void this.claimNewCosmetics();
      void this.refreshMissions();
      const [, streak] = await Promise.all([this.loadStats(), this.api.matchStreak(this.state.game)]);
      this.streak = streak;
      if (this.opponentMode === 'team') { this.boardRows = []; } // il tabellone verrà ricaricato al prossimo accesso alla tab
      if (isNewOpponentDeck) { this.teamDecksLoaded = false; this.teamDecksAll = []; } // il mazzo appena creato per il compagno deve comparire nel prossimo dialog
    } catch (error) { this.onToast?.(error.message || 'Registrazione match non riuscita'); }
    finally { this.busy = false; this.onRender(); }
  }
  view() {
    return `<section class="page-stack stats-page">
      ${this.error ? `<div class="connection-banner error">${esc(this.error)}</div>` : ''}
      <header class="page-header split"><div><span class="eyebrow">Statistiche</span><h1>${this.state.game === 'onepiece' ? 'One Piece Card Game' : 'Yu-Gi-Oh!'}</h1></div><button class="btn" data-stats-new-match>${icon('plus')} Registra match</button></header>
      ${this.heroView()}
      <div class="tabs" role="tablist" aria-label="Ambito statistiche"><button type="button" data-stats-scope="mine" class="${this.scope === 'mine' ? 'active' : ''}" role="tab" aria-selected="${this.scope === 'mine'}">Io</button><button type="button" data-stats-scope="team" class="${this.scope === 'team' ? 'active' : ''}" role="tab" aria-selected="${this.scope === 'team'}">Team</button><button type="button" data-stats-scope="board" class="${this.scope === 'board' ? 'active' : ''}" role="tab" aria-selected="${this.scope === 'board'}">${icon('trophy')} Tabellone</button></div>
      ${this.scope === 'board' ? this.boardView() : `${this.filtersView()}${this.deckListView()}`}
      ${this.matchModalOpen ? this.matchModalView() : ''}
    </section>`;
  }
  filtersView() {
    const deckOptions = this.scope === 'mine' ? this.decks.map(deck => ({ id:deck.id, name:deck.name })) : this.teamDeckOptions;
    return `<div class="stats-filters">
      ${this.scope === 'team' ? `<label>Filtra membro<select data-stats-member><option value="all">Tutti</option>${this.teamMemberOptions.map(opt => `<option value="${esc(opt.slug)}" ${this.memberFilter === opt.slug ? 'selected' : ''}>${esc(opt.name)}</option>`).join('')}</select></label>` : ''}
      <label>Filtra mazzo<select data-stats-deck><option value="all">Tutti</option>${deckOptions.map(opt => `<option value="${esc(opt.id)}" ${this.deckFilter === opt.id ? 'selected' : ''}>${esc(opt.name)}</option>`).join('')}</select></label>
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
      <span class="eyebrow">✓ Match registrato</span><h2 class="match-feedback-result ${result.result}">${RESULT_LABEL[result.result]}</h2>
      <p class="match-feedback-xp foil-text">+${result.xpAwarded} XP</p>
      ${capped ? `<p class="match-feedback-cap">${icon('info')} Limite giornaliero raggiunto</p>` : ''}
      <div class="xp-bar-block"><small>LV ${result.level}</small><div class="xp-bar"><i style="--progress:${progress.progress}"></i></div><small>${progress.currentLevelXp} / ${progress.nextLevelXp || progress.currentLevelXp} XP</small></div>
      ${result.levelUp ? `<div class="level-up-banner foil-frame">${icon('star')} LEVEL UP!<b>LV ${result.level}</b><small>${esc(title)}</small></div>` : ''}
      <button class="btn wide" data-match-close>Chiudi</button>
    </aside></div>`;
  }
  bind(root) {
    root.querySelector('[data-stats-new-match]')?.addEventListener('click', () => this.openMatchDialog());
    root.querySelectorAll('[data-stats-scope]').forEach(button => button.addEventListener('click', () => this.setScope(button.dataset.statsScope)));
    root.querySelector('[data-stats-member]')?.addEventListener('change', event => this.setMemberFilter(event.currentTarget.value));
    root.querySelector('[data-stats-deck]')?.addEventListener('change', event => this.setDeckFilter(event.currentTarget.value));
    root.querySelectorAll('[data-stats-period]').forEach(button => button.addEventListener('click', () => this.setPeriodFilter(button.dataset.statsPeriod)));
    root.querySelectorAll('[data-stats-deck-row]').forEach(button => button.addEventListener('click', () => this.setDeckFilter(this.deckFilter === button.dataset.statsDeckRow ? 'all' : button.dataset.statsDeckRow)));
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
    root.querySelector('[data-match-submit]')?.addEventListener('click', () => void this.registerMatch());
  }
}

function emptyForm(deckId = '') { return { deckId, result:'', opponentLabel:'', opponentDeck:'', notes:'', opponentMemberSlug:'', opponentDeckId:'', opponentDeckName:'' }; }

function normalizeRows(rows) {
  return (rows || []).map(row => ({ deckId:row.deck_id, deckName:row.deck_name, matches:row.matches, wins:row.wins, losses:row.losses, draws:row.draws, winRate:Number(row.win_rate) }));
}
function normalizeTeamRows(rows) {
  return (rows || []).map(row => ({ memberSlug:row.member_slug, memberName:row.member_name, deckId:row.deck_id, deckName:row.deck_name, matches:row.matches, wins:row.wins, losses:row.losses, draws:row.draws, winRate:Number(row.win_rate) }));
}
function normalizeH2HRows(rows) {
  return (rows || []).map(row => ({ memberSlug:row.member_slug, memberName:row.member_name, opponentSlug:row.opponent_slug, opponentName:row.opponent_name, wins:row.wins, losses:row.losses, draws:row.draws, matches:row.matches }));
}
