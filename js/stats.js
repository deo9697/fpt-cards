import { esc, initials } from './core.js';
import { icon } from './icons.js';
import { progressForXp, titleForLevel, xpAmountForResult } from './progression.js';

const RESULT_LABEL = { win:'Vittoria', loss:'Sconfitta', draw:'Pareggio' };
const STREAK_PLURAL = { win:'vittorie', loss:'sconfitte', draw:'pareggi' };
function ringColor(winRate) { return winRate >= 70 ? '#9cf07a' : winRate >= 45 ? '#f2c974' : '#ff8fa0'; }
const PERIODS = [{ value:'all', label:'Sempre' }, { value:'30d', label:'30 giorni' }, { value:'7d', label:'7 giorni' }];

export class StatsController {
  constructor({ api, getState, onRender, onToast } = {}) {
    Object.assign(this, { api, getState, onRender, onToast });
    this.scope = 'mine'; this.memberFilter = 'all'; this.deckFilter = 'all'; this.periodFilter = 'all';
    this.progression = null; this.streak = null; this.myRows = []; this.teamRows = []; this.error = '';
    this.matchModalOpen = false; this.matchForm = emptyForm(); this.busy = false; this.lastResult = null;
    this.loadInFlight = null;
  }
  get state() { return this.getState(); }
  get decks() { return (this.state.decks || []).filter(deck => deck.game === this.state.game); }
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
  async load() {
    if (this.loadInFlight) return this.loadInFlight;
    const request = (async () => {
      try {
        const [progression, streak] = await Promise.all([this.api.progression(), this.api.matchStreak(this.state.game), this.loadStats()]);
        this.progression = progression; this.streak = streak; this.error = '';
      } catch (error) { this.error = error.message || 'Statistiche non disponibili'; }
    })();
    this.loadInFlight = request;
    try { return await request; } finally { if (this.loadInFlight === request) this.loadInFlight = null; }
  }
  async loadStats() {
    const period = this.periodFilter;
    if (this.scope === 'mine') {
      const deckId = this.deckFilter !== 'all' ? this.deckFilter : null;
      this.myRows = normalizeRows(await this.api.stats(this.state.game, { deckId, period }));
    } else {
      this.teamRows = normalizeTeamRows(await this.api.teamStats(this.state.game, { period }));
    }
  }
  setScope(value) { if (!['mine','team'].includes(value) || value === this.scope) return; this.scope = value; this.deckFilter = 'all'; this.memberFilter = 'all'; this.onRender(); void this.loadStats().then(() => this.onRender()); }
  setMemberFilter(value) { this.memberFilter = value; this.onRender(); }
  setDeckFilter(value) { this.deckFilter = value; this.onRender(); if (this.scope === 'mine') void this.loadStats().then(() => this.onRender()); }
  setPeriodFilter(value) { if (!PERIODS.some(p => p.value === value) || value === this.periodFilter) return; this.periodFilter = value; this.onRender(); void this.loadStats().then(() => this.onRender()); }
  openMatchDialog() { this.matchForm = emptyForm(this.decks[0]?.id); this.lastResult = null; this.matchModalOpen = true; this.onRender(); }
  closeMatchDialog() { this.matchModalOpen = false; this.lastResult = null; this.onRender(); }
  setMatchDeck(deckId) { this.matchForm.deckId = deckId; this.onRender(); }
  setMatchResult(result) { if (!RESULT_LABEL[result]) return; this.matchForm.result = result; this.onRender(); }
  setMatchField(field, value) { this.matchForm[field] = value; }
  async registerMatch() {
    if (this.busy || !this.matchForm.deckId || !this.matchForm.result) return;
    this.busy = true; this.onRender();
    try {
      const response = await this.api.registerMatch({ game:this.state.game, deckId:this.matchForm.deckId, result:this.matchForm.result, opponentLabel:this.matchForm.opponentLabel, opponentDeck:this.matchForm.opponentDeck, notes:this.matchForm.notes });
      this.progression = { ...this.progression, totalXp:response.totalXp, level:response.level };
      this.lastResult = { result:this.matchForm.result, ...response };
      const [, streak] = await Promise.all([this.loadStats(), this.api.matchStreak(this.state.game)]);
      this.streak = streak;
    } catch (error) { this.onToast?.(error.message || 'Registrazione match non riuscita'); }
    finally { this.busy = false; this.onRender(); }
  }
  view() {
    return `<section class="page-stack stats-page">
      ${this.error ? `<div class="connection-banner error">${esc(this.error)}</div>` : ''}
      <header class="page-header split"><div><span class="eyebrow">Statistiche</span><h1>${this.state.game === 'onepiece' ? 'One Piece Card Game' : 'Yu-Gi-Oh!'}</h1></div><button class="btn" data-stats-new-match>${icon('plus')} Registra match</button></header>
      ${this.heroView()}
      <div class="tabs" role="tablist" aria-label="Ambito statistiche"><button type="button" data-stats-scope="mine" class="${this.scope === 'mine' ? 'active' : ''}" role="tab" aria-selected="${this.scope === 'mine'}">Io</button><button type="button" data-stats-scope="team" class="${this.scope === 'team' ? 'active' : ''}" role="tab" aria-selected="${this.scope === 'team'}">Team</button></div>
      ${this.filtersView()}
      ${this.deckListView()}
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
    return `<section class="stats-hero">
      <div class="stats-ring" style="--pct:${winRate};--ring-color:${ringColor(winRate)}"><div class="stats-ring-inner"><strong>${winRate}%</strong><small>win rate</small></div></div>
      <div class="stats-hero-side">
        <div class="stats-hero-match"><strong>${t.matches}</strong><small>match</small></div>
        <div class="stats-wld"><span class="win">${t.wins}V</span><span class="loss">${t.losses}S</span><span class="draw">${t.draws}P</span></div>
        ${streakLabel ? `<div class="stats-streak ${streak.result}">${icon('flash')} ${esc(streakLabel)}</div>` : ''}
      </div>
    </section>`;
  }
  deckListView() {
    if (!this.visibleRows.length) return `<div class="empty-state">${icon('chart')}<h2>Nessun match registrato</h2><p>Registra il primo match per iniziare a costruire le statistiche.</p></div>`;
    return `<div class="stats-deck-list">${this.visibleRows.map(row => `<button type="button" class="stats-deck-row" data-stats-deck-row="${esc(row.deckId)}">
      <div class="stats-ring small" style="--pct:${row.winRate};--ring-color:${ringColor(row.winRate)}"><div class="stats-ring-inner"><b>${row.winRate}%</b></div></div>
      ${row.memberName ? `<i class="mini-avatar member-${esc(row.memberSlug)}">${initials(row.memberName)}</i>` : ''}
      <span class="stats-deck-info"><strong>${esc(row.deckName)}</strong>${row.memberName ? `<small>${esc(row.memberName)}</small>` : ''}
        <span class="stats-wld small"><b class="win">${row.wins} V</b>${row.losses ? ` · <b class="loss">${row.losses} S</b>` : ''}${row.draws ? ` · <b class="draw">${row.draws} P</b>` : ''}</span>
      </span>
      <small class="stats-deck-matches">${row.matches} match</small>
      ${icon('arrow')}
    </button>`).join('')}</div>`;
  }
  matchModalView() {
    if (this.lastResult) return this.feedbackView();
    const form = this.matchForm;
    return `<div class="detail-backdrop" data-match-close><aside class="card-detail" role="dialog" aria-modal="true" aria-label="Registra match">
      <button class="detail-close" data-match-close aria-label="Chiudi">×</button>
      <span class="eyebrow">Registra match</span><h2>Nuovo risultato</h2>
      <label>Mazzo<select data-match-deck>${this.decks.map(deck => `<option value="${esc(deck.id)}" ${form.deckId === deck.id ? 'selected' : ''}>${esc(deck.name)}</option>`).join('') || '<option value="">Nessun mazzo disponibile</option>'}</select></label>
      <div class="match-result-group" role="group" aria-label="Risultato">${Object.entries(RESULT_LABEL).map(([value, label]) => `<button type="button" class="match-result-btn ${value} ${form.result === value ? 'active' : ''}" data-match-result="${value}">${label}</button>`).join('')}</div>
      <label>Avversario / Deck<input data-match-field="opponentDeck" maxlength="120" value="${esc(form.opponentDeck)}" placeholder="Es. Labrynth"></label>
      <label>Note<textarea data-match-field="notes" maxlength="500" placeholder="Facoltative">${esc(form.notes)}</textarea></label>
      <button class="btn wide" data-match-submit ${this.busy || !form.deckId || !form.result ? 'disabled' : ''}>${this.busy ? 'Registro…' : 'Registra'}</button>
    </aside></div>`;
  }
  feedbackView() {
    const result = this.lastResult, progress = progressForXp(result.totalXp), title = titleForLevel(result.level);
    const capped = result.xpAwarded < xpAmountForResult(result.result);
    return `<div class="detail-backdrop" data-match-close><aside class="card-detail match-feedback" role="dialog" aria-modal="true" aria-label="Match registrato">
      <button class="detail-close" data-match-close aria-label="Chiudi">×</button>
      <span class="eyebrow">✓ Match registrato</span><h2 class="match-feedback-result ${result.result}">${RESULT_LABEL[result.result]}</h2>
      <p class="match-feedback-xp">+${result.xpAwarded} XP</p>
      ${capped ? `<p class="match-feedback-cap">${icon('info')} Limite giornaliero raggiunto</p>` : ''}
      <div class="xp-bar-block"><small>LV ${result.level}</small><div class="xp-bar"><i style="--progress:${progress.progress}"></i></div><small>${progress.currentLevelXp} / ${progress.nextLevelXp || progress.currentLevelXp} XP</small></div>
      ${result.levelUp ? `<div class="level-up-banner">${icon('star')} LEVEL UP!<b>LV ${result.level}</b><small>${esc(title)}</small></div>` : ''}
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
    root.querySelectorAll('[data-match-field]').forEach(field => field.addEventListener('input', event => this.setMatchField(event.currentTarget.dataset.matchField, event.currentTarget.value)));
    root.querySelector('[data-match-submit]')?.addEventListener('click', () => void this.registerMatch());
  }
}

function emptyForm(deckId = '') { return { deckId, result:'', opponentLabel:'', opponentDeck:'', notes:'' }; }

function normalizeRows(rows) {
  return (rows || []).map(row => ({ deckId:row.deck_id, deckName:row.deck_name, matches:row.matches, wins:row.wins, losses:row.losses, draws:row.draws, winRate:Number(row.win_rate) }));
}
function normalizeTeamRows(rows) {
  return (rows || []).map(row => ({ memberSlug:row.member_slug, memberName:row.member_name, deckId:row.deck_id, deckName:row.deck_name, matches:row.matches, wins:row.wins, losses:row.losses, draws:row.draws, winRate:Number(row.win_rate) }));
}
