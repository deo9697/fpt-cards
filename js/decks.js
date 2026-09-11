import { esc, initials, member } from './core.js';
import { icon } from './icons.js';
import { canonicalCatalogCardId, validCatalogCardId } from './cards.js';
import { DEFAULT_DECK_BOX_TEMPLATE, DEFAULT_DECK_THEME, DECK_BOX_TEMPLATES, deckThemeOptions, normalizeDeckBoxTemplate, preferredDeckArtwork, renderDeckBoxCard, renderDeckBoxVisual, resolveDeckSignature } from './deck-box.js';
import { getGameAdapter } from './games/index.js';

// Chiavi di DECK_BOX_TEMPLATES che richiedono uno sblocco (js/cosmetics.js,
// deckbox_<key>) invece di essere sempre disponibili — vedi isDeckBoxUnlocked().
const ARCHETYPE_DECK_BOX_KEYS = new Set(['sacred_beast_orcust', 'mitsurugi', 'skystriker']);

// Sezioni/etichette dipendono dal gioco del mazzo (Main/Extra/Side per YGO,
// Leader/Main/DON!! per One Piece) — mai un elenco fisso, sempre l'adapter.
function sectionsFor(deck) { return getGameAdapter(deck?.game).sections; }
function labelsFor(deck) { return getGameAdapter(deck?.game).labels; }
const DRAFTS_KEY = 'fpt-cards-deck-drafts-v1';
const DECK_100_CELEBRATED_KEY = 'fpt-cards-deck-100-celebrated-v1';
const BATTLE_READY_CLAIMED_KEY = 'fpt-cards-title-battle-ready-claimed-v1';
const CARD_TYPE_CACHE_KEY = 'fpt-cards-type-index-v1';
const TYPE_FILTERS = [
  { value: 'all', label: 'Tutte' },
  { value: 'monster', label: 'Mostri' },
  { value: 'spell', label: 'Magie' },
  { value: 'trap', label: 'Trappole' }
];
const TYPE_RANK = { monster: 0, spell: 1, trap: 2, '': 3 };
const SORT_OPTIONS = [
  { value: 'type', label: 'Tipo', title: 'Ordina per tipo: Mostri → Magie → Trappole' },
  { value: 'name-asc', label: 'A–Z', title: 'Ordina per nome, A–Z' },
  { value: 'name-desc', label: 'Z–A', title: 'Ordina per nome, Z–A' },
  { value: 'qty-desc', label: 'Copie', title: 'Ordina per quantità, più copie prima' },
  { value: 'manual', label: 'Manuale', title: 'Tieni premuta una carta e trascinala per riordinarla' }
];
// One Piece non ha Mostri/Magie/Trappole: "Tipo" non ha senso, al suo posto
// c'è "Costo" (crescente) — ed è anche il default all'apertura del mazzo,
// non solo un'opzione da scegliere (richiesta utente 2026-09-10).
const ONE_PIECE_SORT_OPTIONS = [
  { value: 'cost-asc', label: 'Costo', title: 'Ordina per costo, dal più basso al più alto' },
  { value: 'name-asc', label: 'A–Z', title: 'Ordina per nome, A–Z' },
  { value: 'name-desc', label: 'Z–A', title: 'Ordina per nome, Z–A' },
  { value: 'qty-desc', label: 'Copie', title: 'Ordina per quantità, più copie prima' },
  { value: 'manual', label: 'Manuale', title: 'Tieni premuta una carta e trascinala per riordinarla' }
];
function sortOptionsFor(game) { return game === 'onepiece' ? ONE_PIECE_SORT_OPTIONS : SORT_OPTIONS; }
const BAN_LABELS = { limited: 'Limitata a 1 copia', 'semi-limited': 'Semi-limitata a 2 copie', forbidden: 'Proibita' };

export class DeckController {
  constructor({ api, getState, searchCards, findCard, findCardById, cardTypesByIds, tcgBanlistStatuses, isOnline, onRender, onToast, onLoansChanged, getCosmetics } = {}) {
    Object.assign(this, { api, getState, searchCards, findCard, findCardById, cardTypesByIds, tcgBanlistStatuses, isOnline, onRender, onToast, onLoansChanged, getCosmetics });
    this.activeId = ''; this.previewId = ''; this.screen = 'gallery'; this.targetSection = 'main'; this.searchResults = []; this.searchQuery = ''; this.searchOpen = false; this.searchTimer = 0; this.importOpen = false; this.coverPickerOpen = false; this.printingPicker = null; this.busy = false; this.error = ''; this.loadInFlight = null;
    // Import/export OPTCGSim (P1.1) sono un flusso a parte dal generico YDK,
    // non lo riusano: formati e logiche di risoluzione troppo diversi.
    this.optcgImportOpen = false; this.optcgImportBusy = false; this.optcgImportResult = null;
    this.scope = 'mine'; this.teamDecksAll = []; this.teamDetailId = ''; this.teamLoadInFlight = null; this.teamError = ''; this.teamLoaded = false; this.teamMemberFilter = '';
    this.activeSection = 'main'; this.cardTypeFilter = 'all'; this.cardSort = 'type'; this.selectedCard = null; this.missingPanelOpen = false; this.moreMenuOpen = false;
    // Scelta prestatore + "già concordato" per riga di carta mancante: transiente,
    // non fa parte dello stato del mazzo, si azzera quando il pannello si chiude.
    this.missingRowChoices = new Map();
    // Filtri catalogo One Piece (P1.0.1): Espansione è sempre manuale, Colore
    // parte "automatico" sui colori del Leader finché l'utente non tocca un
    // chip (catalogColorsTouched) — a quel punto diventa un set esplicito.
    this.catalogExpansion = 'all'; this.catalogColors = new Set(); this.catalogColorsTouched = false;
    this.cardTypes = readTypeCache(); this.typesLoading = false;
    // Costo carte One Piece (per l'ordinamento "Costo", default del Main
    // Deck): non è cache-su-disco come cardTypes, si risolve al volo ad ogni
    // apertura mazzo — dataset piccolo, nessun bisogno di persisterlo.
    this.cardCosts = {}; this.costsLoading = false;
    // La ricerca carte del deck editor resta aperta finché non la chiudi
    // esplicitamente (X o indietro) — selezionare una carta da aggiungere
    // NON la chiude più, così se ne possono aggiungere più di seguito
    // senza ridigitare la query ogni volta.
    if (typeof window !== 'undefined') window.addEventListener('popstate', event => { if (!event.state?.deckSearch && this.searchOpen) { this.closeSearch(); this.onRender?.(); } });
  }
  get state() { return this.getState(); }
  get decks() { return (this.state.decks || []).filter(deck => deck.game === this.state.game); }
  get teamDecks() { return (this.teamDecksAll || []).filter(deck => deck.game === this.state.game); }
  active() { return this.decks.find(deck => deck.id === this.activeId) || this.decks[0] || null; }
  activeTeamDeck() { return this.teamDecks.find(deck => deck.id === this.teamDetailId) || null; }
  async load() { if (this.loadInFlight) return this.loadInFlight; const request = (async () => { let remote = [], failure = null; try { remote = (await this.api.decks() || []).map(mapDeck); } catch (error) { failure = error; remote = this.state.decks || []; } const local = readDrafts().filter(deck => deck.ownerSlug === this.state.currentUser), merged = new Map(remote.map(deck => [deck.id, deck])); for (const draft of local) if (draft.dirty || !draft.persisted) merged.set(draft.id, draft); this.state.decks = [...merged.values()]; await this.refreshTcgBanlist(); if (!this.decks.some(deck => deck.id === this.activeId)) this.activeId = this.decks[0]?.id || ''; if (!this.decks.some(deck => deck.id === this.previewId)) this.previewId = this.activeId; if (failure) throw failure; return this.state.decks; })(); this.loadInFlight = request; try { return await request; } finally { if (this.loadInFlight === request) this.loadInFlight = null; } }
  async loadTeam() { if (this.teamLoadInFlight) return this.teamLoadInFlight; const request = (async () => { try { this.teamDecksAll = (await this.api.teamDecks() || []).map(mapTeamDeck); this.teamError = ''; } catch (error) { this.teamError = error.message || 'Mazzi del team non disponibili'; } finally { this.teamLoaded = true; } return this.teamDecksAll; })(); this.teamLoadInFlight = request; try { return await request; } finally { if (this.teamLoadInFlight === request) this.teamLoadInFlight = null; } }
  async refreshTcgBanlist() { if (!this.tcgBanlistStatuses || !(this.state.decks || []).some(deck => deck.game === 'yugioh')) return; const statuses = await this.tcgBanlistStatuses(); if (!statuses) return; for (const deck of this.state.decks || []) { if (deck.game !== 'yugioh') continue; for (const card of deck.cards || []) card.banTcg = statuses[String(card.catalogCardId)] || ''; } }
  view() { const deck = this.active(), detail = this.screen === 'detail' && deck, teamDeck = this.screen === 'team-detail' ? this.activeTeamDeck() : null; return `<section class="page-stack deck-page ${detail || teamDeck ? 'is-editor' : 'is-gallery'}">${this.error ? `<div class="connection-banner error">${esc(this.error)}</div>` : ''}${teamDeck ? this.teamDetailView(teamDeck) : detail ? this.detailView(deck) : this.galleryView()}${this.importOpen ? this.importView() : ''}${this.optcgImportOpen ? this.optcgImportView() : ''}${this.coverPickerOpen && deck ? this.coverPickerView(deck) : ''}${this.printingPicker ? this.printingPickerView() : ''}</section>`; }
  galleryView() {
    const scope = this.scope, mineCount = this.decks.length, teamCount = this.teamDecks.length;
    const tabs = `<div class="tabs" role="tablist" aria-label="Ambito mazzi"><button type="button" data-deck-scope="mine" class="${scope === 'mine' ? 'active' : ''}" role="tab" aria-selected="${scope === 'mine'}">I miei mazzi <span>${mineCount}</span></button><button type="button" data-deck-scope="team" class="${scope === 'team' ? 'active' : ''}" role="tab" aria-selected="${scope === 'team'}">Mazzi del team <span>${teamCount}</span></button></div>`;
    if (scope === 'team') return this.teamGalleryView(tabs);
    const decks = this.decks, preview = decks.find(deck => deck.id === this.previewId) || decks[0] || null;
    const isOnePiece = this.state.game === 'onepiece';
    return `<header class="deck-hero deck-gallery-hero"><div><span class="eyebrow">Mazzi</span><h1>Scegli il tuo mazzo</h1><p>La tua strategia, il tuo stile. Prepara il mazzo per la prossima sfida.</p></div><div class="deck-hero-actions"><button class="btn" data-deck-new>${icon('plus')} Nuovo mazzo</button>${isOnePiece ? `<button class="btn secondary" data-deck-optcg-import-new>${icon('logout')} Importa da OPTCGSim</button>` : `<button class="btn secondary" data-deck-import-new>${icon('logout')} Importa lista / YDK</button>`}</div></header>${tabs}${decks.length ? `<div class="deck-gallery-layout"><div class="deck-box-grid" aria-label="I tuoi mazzi">${decks.map(deck => this.galleryCard(deck, deck.id === preview?.id)).join('')}</div>${preview ? this.galleryPreview(preview) : ''}</div>` : this.emptyView()}`;
  }
  teamGalleryView(tabs) {
    const allDecks = this.teamDecks;
    const owners = [...new Map(allDecks.map(deck => [deck.ownerSlug, deck.ownerName])).entries()]
      .map(([slug, name]) => ({ slug, name, count: allDecks.filter(deck => deck.ownerSlug === slug).length }))
      .sort((a, b) => a.name.localeCompare(b.name, 'it'));
    // Default to a single member's decks instead of dumping everyone's mazzi
    // in one flat grid — heal the selection if it points at a member who no
    // longer has decks for the current game (or was never set).
    if (this.teamMemberFilter !== 'all' && !owners.some(owner => owner.slug === this.teamMemberFilter)) this.teamMemberFilter = owners[0]?.slug || '';
    const decks = this.teamMemberFilter === 'all' ? allDecks : allDecks.filter(deck => deck.ownerSlug === this.teamMemberFilter);
    const loading = this.teamLoadInFlight && !this.teamLoaded;
    const chips = owners.length ? `<div class="deck-mh-chip-scroll team-member-chips" role="group" aria-label="Membro del team">${owners.map(owner => `<button type="button" class="chip ${this.teamMemberFilter === owner.slug ? 'active' : ''}" data-deck-team-member="${esc(owner.slug)}" aria-pressed="${this.teamMemberFilter === owner.slug}"><i class="mini-avatar member-${esc(owner.slug)}">${initials(owner.name)}</i>${esc(owner.name)} <b>${owner.count}</b></button>`).join('')}${owners.length > 1 ? `<button type="button" class="chip ${this.teamMemberFilter === 'all' ? 'active' : ''}" data-deck-team-member="all" aria-pressed="${this.teamMemberFilter === 'all'}">Tutti <b>${allDecks.length}</b></button>` : ''}</div>` : '';
    const body = loading
      ? `<div class="deck-team-loading"><span class="loading-spinner"></span> Carico i mazzi del team…</div>`
      : chips
        ? `${chips}${decks.length ? `<div class="deck-box-grid" aria-label="Mazzi del team">${decks.map(deck => renderDeckBoxCard(deck, { mode:'team', ownerName:deck.ownerName, availability: deckAvailability(deck, this.state.collection, this.state.currentUser, { ownerSlug:deck.ownerSlug, loans:this.state.loans }).percent })).join('')}</div>` : `<section class="surface deck-empty">${icon('team')}<h2>Nessun mazzo qui</h2><p>Questo membro non ha ancora mazzi per questo gioco.</p></section>`}`
        : `<section class="surface deck-empty">${icon('team')}<h2>Nessun mazzo condiviso</h2><p>I mazzi salvati dagli altri membri del team appariranno qui.</p></section>`;
    return `<header class="deck-hero deck-gallery-hero"><div><span class="eyebrow">Mazzi</span><h1>Mazzi del team</h1><p>Scegli un membro per sfogliare i suoi mazzi, in sola lettura.</p></div></header>${tabs}${this.teamError ? `<div class="connection-banner error">${esc(this.teamError)}</div>` : ''}${body}`;
  }
  galleryCard(deck, selected = false) { const report = deckAvailability(deck, this.state.collection, this.state.currentUser, { loans:this.state.loans }); return renderDeckBoxCard(deck, { availability: report.percent, selected, celebrate: this.checkDeck100Celebration(deck.id, report.percent) }); }
  // Il video/audio del deck box al 100% deve partire una volta sola, esattamente
  // quando il mazzo raggiunge il completamento — non ogni volta che lo si
  // riguarda. Un set persistito in localStorage ricorda quali mazzi hanno già
  // festeggiato: la prima volta che un mazzo tocca il 100% viene marcato subito
  // (prima ancora che l'utente lo veda), così anche un secondo render nella
  // stessa sessione non lo fa ripartire. Se scende sotto il 100% viene tolto
  // dal set, così un futuro nuovo 100% festeggia di nuovo.
  checkDeck100Celebration(deckId, percent) {
    const celebrated = readCelebratedDecks();
    if (percent !== 100) { if (celebrated.has(deckId)) { celebrated.delete(deckId); writeCelebratedDecks(celebrated); } return false; }
    if (celebrated.has(deckId)) return false;
    celebrated.add(deckId); writeCelebratedDecks(celebrated); return true;
  }
  // Titolo "easter egg" Battle Ready (vedi js/cosmetics.js): claim_cosmetic è
  // idempotente lato server, ma il toast di sblocco deve comparire una volta
  // sola nella vita del membro, non ad ogni ri-celebrazione dello stesso o di
  // un altro mazzo — da qui il guard locale, separato da quello per-mazzo
  // di checkDeck100Celebration.
  claimBattleReadyTitle() {
    let claimed; try { claimed = localStorage.getItem(BATTLE_READY_CLAIMED_KEY) === '1'; } catch { claimed = false; }
    this.api.claimCosmetic('title_battle_ready').then(() => {
      if (claimed) return;
      try { localStorage.setItem(BATTLE_READY_CLAIMED_KEY, '1'); } catch {}
      this.onToast?.('Titolo sbloccato: Battle Ready');
    }).catch(() => {});
  }
  galleryPreview(deck) { const report = deckAvailability(deck, this.state.collection, this.state.currentUser, { loans:this.state.loans }), total = deck.cards.reduce((sum, item) => sum + item.quantity, 0); return `<aside class="deck-gallery-preview surface" aria-label="Anteprima ${esc(deck.name)}"><span class="eyebrow">Mazzo selezionato</span>${renderDeckBoxVisual(deck)}<h2>${esc(deck.name)}</h2><p>${deck.dirty ? 'Bozza salvata sul dispositivo' : `Formato: ${esc(deck.format || 'TCG Avanzato')}`}</p><div class="deck-preview-counts"><span><small>Totale</small><b>${total}</b></span>${sectionsFor(deck).map(section => `<span><small>${esc(labelsFor(deck)[section].replace(' Deck', ''))}</small><b>${sectionTotal(deck, section)}</b></span>`).join('')}</div><div class="deck-preview-ready"><span><small>Disponibilità personale</small><strong>${report.percent}%</strong></span><i style="--ready:${report.percent}"></i></div><button class="btn wide" data-deck-open="${esc(deck.id)}">Apri mazzo ${icon('arrow')}</button></aside>`; }
  teamDetailView(deck) {
    const report = deckAvailability(deck, this.state.collection, this.state.currentUser, { ownerSlug:deck.ownerSlug, loans:this.state.loans }), total = deck.cards.reduce((sum, item) => sum + item.quantity, 0);
    const sheetCard = this.selectedCard ? deck.cards.find(item => item.catalogCardId === this.selectedCard.catalogCardId && item.section === this.selectedCard.section && (item.printingId || null) === (this.selectedCard.printingId || null)) : null;
    if (this.selectedCard && !sheetCard) this.selectedCard = null;
    const isOnePiece = deck.game === 'onepiece';
    return `<div class="deck-mobile">
      ${this.teamEditorHeader(deck, total, report)}
      ${isOnePiece ? this.leaderHero(deck, { readonly:true }) : `<div class="deck-mh-tabs" role="tablist" aria-label="Sezioni mazzo">${sectionsFor(deck).map(section => `<button type="button" data-deck-section="${section}" class="${this.activeSection === section ? 'active' : ''}" role="tab" aria-selected="${this.activeSection === section}">${labelsFor(deck)[section].replace(' Deck', '')} <i>${sectionTotal(deck, section)}</i></button>`).join('')}</div>`}
      ${deck.game === 'yugioh' ? `<div class="deck-mh-filters" role="group" aria-label="Filtra e ordina"><div class="deck-mh-chip-scroll">${this.typeChips(deck)}</div>${this.sortButton(deck)}</div>${this.typesLoading ? '<div class="deck-mh-types-loading"><span class="loading-spinner"></span> Sto identificando i tipi delle carte…</div>' : ''}` : isOnePiece ? `<div class="deck-mh-filters" role="group" aria-label="Ordina">${this.sortButton(deck)}</div>${this.costsLoading && this.cardSort === 'cost-asc' ? '<div class="deck-mh-types-loading"><span class="loading-spinner"></span> Sto calcolando i costi…</div>' : this.cardSort === 'manual' ? '<div class="data-note deck-manual-sort-hint">Tieni premuta una carta e trascinala per riordinarla</div>' : ''}` : ''}
      ${isOnePiece ? `<div class="section-head"><h2>Main Deck</h2><small>${sectionTotal(deck, 'main')}/50</small></div>` : ''}
      ${this.sectionGrid(deck, report)}
      ${sheetCard ? this.cardSheet(sheetCard, report, deck, { readonly:true }) : this.availabilityPeek(report)}
      ${this.missingPanelOpen ? this.missingOverlay(report, { readonly:true, ownerName:deck.ownerName }) : ''}
    </div>`;
  }
  teamEditorHeader(deck, total, report) {
    return `<header class="deck-mh-head">
      <button type="button" class="deck-mh-icon" data-deck-gallery aria-label="Torna alla scelta dei mazzi">${icon('arrow')}</button>
      <span class="deck-mh-title"><small>Mazzo di ${esc(deck.ownerName)} · sola lettura</small><strong class="deck-mh-title-static">${esc(deck.name)}</strong></span>
    </header>
    <div class="deck-mh-stats">${this.sectionStats(deck)}
      <div class="c-ready"><small>Pronto</small><b>${report.percent}%</b></div>
    </div>${this.legalityBadge(deck)}`;
  }
  // Riusa le classi c-main/c-extra/c-side (e la loro griglia a 5 colonne) per
  // qualunque gioco: cambiano solo etichetta e conteggio mostrato.
  sectionStats(deck) {
    if (deck.game !== 'onepiece') return `
      <div class="c-total"><small>Totale</small><b>${sectionTotal(deck, 'main') + sectionTotal(deck, 'extra') + sectionTotal(deck, 'side')}</b></div>
      <div class="c-main"><small>Main</small><b>${sectionTotal(deck, 'main')}</b></div>
      <div class="c-extra"><small>Extra</small><b>${sectionTotal(deck, 'extra')}</b></div>
      <div class="c-side"><small>Side</small><b>${sectionTotal(deck, 'side')}</b></div>`;
    const { counts } = getGameAdapter('onepiece').validateDeck(deck);
    return `
      <div class="c-total"><small>Leader</small><b>${counts.leader.count}/${counts.leader.target}${counts.leader.count === counts.leader.target ? ' ✓' : ''}</b></div>
      <div class="c-main"><small>Main</small><b>${counts.main.count}/${counts.main.target}</b></div>
      <div class="c-extra"><small>DON!!</small><b>${counts.don.count}/${counts.don.target}${counts.don.count === counts.don.target ? ' ✓' : ''}</b></div>
      <div class="c-side"><small>Totale</small><b>${counts.leader.count + counts.main.count + counts.don.count}</b></div>`;
  }
  legalityBadge(deck) {
    if (deck.game !== 'onepiece') return '';
    const { valid, errors } = getGameAdapter('onepiece').validateDeck(deck);
    if (valid) return `<span class="badge ok deck-legality-badge">✓ Mazzo regolare</span>`;
    return `<div class="data-note warning deck-legality-note"><div><strong>${errors.length} ${errors.length === 1 ? 'problema' : 'problemi'} da correggere</strong><ul>${errors.map(error => `<li>${esc(error)}</li>`).join('')}</ul></div></div>`;
  }
  detailView(deck) { return this.editor(deck); }
  emptyView() { return `<section class="surface deck-empty">${icon('deck')}<h2>Il tuo primo mazzo parte da qui</h2><p>Aggiungi le carte dal catalogo oppure importa un file .ydk o una lista testuale.</p><button class="btn" data-deck-new>${icon('plus')} Crea mazzo</button></section>`; }
  editor(deck) {
    const report = deckAvailability(deck, this.state.collection, this.state.currentUser, { loans:this.state.loans }), total = deck.cards.reduce((sum, item) => sum + item.quantity, 0);
    const sheetCard = this.selectedCard ? deck.cards.find(item => item.catalogCardId === this.selectedCard.catalogCardId && item.section === this.selectedCard.section && (item.printingId || null) === (this.selectedCard.printingId || null)) : null;
    if (this.selectedCard && !sheetCard) this.selectedCard = null;
    const isOnePiece = deck.game === 'onepiece';
    return `<div class="deck-mobile">
      ${this.editorHeader(deck, total, report)}
      <div class="deck-mh-search"><label>${icon('search')}<input data-deck-search autocomplete="off" placeholder="Cerca una carta da aggiungere…" value="${esc(this.searchQuery || '')}"><button type="button" class="deck-search-clear ${this.searchOpen ? '' : 'hidden'}" data-deck-search-close aria-label="Chiudi ricerca">×</button></label>${isOnePiece ? '<div data-deck-catalog-filters></div>' : ''}<div data-deck-search-results class="deck-search-results"></div></div>
      ${isOnePiece ? this.leaderHero(deck) : `<div class="deck-mh-tabs" role="tablist" aria-label="Sezioni mazzo">${sectionsFor(deck).map(section => `<button type="button" data-deck-section="${section}" class="${this.activeSection === section ? 'active' : ''}" role="tab" aria-selected="${this.activeSection === section}">${labelsFor(deck)[section].replace(' Deck', '')} <i>${sectionTotal(deck, section)}</i></button>`).join('')}</div>`}
      ${deck.game === 'yugioh' ? `<div class="deck-mh-filters" role="group" aria-label="Filtra e ordina"><div class="deck-mh-chip-scroll">${this.typeChips(deck)}</div>${this.sortButton(deck)}</div>${this.typesLoading ? '<div class="deck-mh-types-loading"><span class="loading-spinner"></span> Sto identificando i tipi delle carte…</div>' : ''}` : isOnePiece ? `<div class="deck-mh-filters" role="group" aria-label="Ordina">${this.sortButton(deck)}</div>${this.costsLoading && this.cardSort === 'cost-asc' ? '<div class="deck-mh-types-loading"><span class="loading-spinner"></span> Sto calcolando i costi…</div>' : this.cardSort === 'manual' ? '<div class="data-note deck-manual-sort-hint">Tieni premuta una carta e trascinala per riordinarla</div>' : ''}` : ''}
      ${isOnePiece ? `<div class="section-head"><h2>Main Deck</h2><small>${sectionTotal(deck, 'main')}/50</small></div>` : ''}
      ${this.sectionGrid(deck, report)}
      ${sheetCard ? this.cardSheet(sheetCard, report, deck) : this.availabilityPeek(report)}
      ${this.moreMenuOpen ? this.moreMenu(deck) : ''}
      ${this.missingPanelOpen ? this.missingOverlay(report) : ''}
    </div>`;
  }
  // Leader "hero" pinnata sopra la griglia Main (P1.0, opzione A scelta
  // dall'utente dopo il mockup): niente più tab dedicato, il Leader resta
  // sempre visibile. "Cambia" targetizza la ricerca generica sul Leader
  // invece che sul Main; tappare la card apre il dettaglio (stepper/rimuovi)
  // come una qualunque altra carta del mazzo.
  leaderHero(deck, { readonly = false } = {}) {
    const leader = deck.cards.find(item => item.section === 'leader');
    if (!leader) return `<div class="leader-hero leader-hero-empty">
      <span class="leader-hero-art">${icon('card')}</span>
      <span class="leader-hero-copy"><small>Leader</small><strong>Nessuno scelto</strong></span>
      ${readonly ? '' : `<button type="button" class="leader-change" data-deck-pick-leader>Scegli</button>`}
    </div>`;
    return `<div class="leader-hero">
      <button type="button" class="leader-hero-main" data-deck-card-select="${esc(leader.catalogCardId)}" data-deck-card-select-section="leader" data-deck-card-select-printing="${esc(leader.printingId || '')}">
        <span class="leader-hero-art">${leader.imageUrl ? `<img src="${esc(leader.imageUrl)}" alt="">` : icon('card')}</span>
        <span class="leader-hero-copy"><small>Leader</small><strong>${esc(leader.cardName)}</strong>${(leader.colors || []).length ? `<span class="leader-hero-meta">${leader.colors.map(color => `<i class="leader-color-dot ${esc(String(color).toLowerCase())}" title="${esc(colorLabel(color))}"></i>`).join('')}</span>` : ''}</span>
      </button>
      ${readonly ? '' : `<button type="button" class="leader-change" data-deck-pick-leader>Cambia</button>`}
    </div>`;
  }
  editorHeader(deck, total, report) {
    return `<header class="deck-mh-head">
      <button type="button" class="deck-mh-icon" data-deck-gallery aria-label="Torna alla scelta dei mazzi">${icon('arrow')}</button>
      <span class="deck-mh-title"><small>Editor mazzo</small><input data-deck-name value="${esc(deck.name)}" maxlength="80" aria-label="Nome mazzo"></span>
      <button type="button" class="btn secondary small" data-deck-save ${this.busy ? 'disabled' : ''}>${this.busy ? 'Salvataggio…' : 'Salva'}</button>
      <button type="button" class="deck-mh-icon" data-deck-more aria-label="Altre azioni" aria-expanded="${this.moreMenuOpen}">${icon('more')}</button>
    </header>
    <div class="deck-mh-stats">${this.sectionStats(deck)}
      <div class="c-ready"><small>Pronto</small><b>${report.percent}%</b></div>
    </div>${this.legalityBadge(deck)}`;
  }
  sectionGrid(deck, report) {
    // One Piece non ha più un tab attivo da seguire (P1.0): la griglia mostra
    // sempre il Main, Leader e DON!! vivono altrove (hero card / riepilogo).
    const section = deck.game === 'onepiece' ? 'main' : this.activeSection;
    const cards = this.sortCards(deck.cards.filter(item => item.section === section && this.matchesTypeFilter(item)));
    if (!cards.length) return `<div class="deck-section-empty">${icon('card')}<span>Nessuna carta${this.cardTypeFilter !== 'all' ? ' per questo filtro' : ' in questa sezione'}</span></div>`;
    return `<div class="deck-mobile-grid">${cards.map(item => this.cardTile(item, report)).join('')}</div>`;
  }
  matchesTypeFilter(item) { return this.cardTypeFilter === 'all' || this.cardTypes[item.catalogCardId] === this.cardTypeFilter; }
  typeChips(deck) {
    const sectionCards = deck.cards.filter(item => item.section === this.activeSection);
    const counts = { monster: 0, spell: 0, trap: 0 };
    for (const item of sectionCards) { const type = this.cardTypes[item.catalogCardId]; if (type in counts) counts[type] += item.quantity; }
    return TYPE_FILTERS.map(f => `<button type="button" class="chip ${f.value !== 'all' ? `deck-type-chip ${f.value}` : ''} ${this.cardTypeFilter === f.value ? 'active' : ''}" data-deck-type-filter="${f.value}">${f.value !== 'all' ? '<i class="deck-type-dot"></i>' : ''}${f.label}${f.value !== 'all' ? ` <b>${counts[f.value]}</b>` : ''}</button>`).join('');
  }
  sortButton(deck) {
    const options = sortOptionsFor(deck?.game);
    const current = options.find(option => option.value === this.cardSort) || options[0];
    return `<button type="button" class="deck-mh-sort" data-deck-sort-cycle title="${esc(current.title)} (tocca per cambiare)" aria-label="${esc(current.title)}">${icon('chart')}<span>${esc(current.label)}</span></button>`;
  }
  sortCards(cards) {
    const sorted = [...cards];
    switch (this.cardSort) {
      // Ordine manuale: l'array arriva già nell'ordine voluto dall'utente
      // (deck.cards viene riordinato in place dal drag&drop, vedi
      // reorderCard) — qui non si tocca nulla.
      case 'manual': return sorted;
      // Costo crescente (default One Piece): le carte senza costo risolto
      // (es. Stage, o non ancora sincronizzate) finiscono in fondo per
      // nome invece che mischiate a caso in mezzo alle altre.
      case 'cost-asc': return sorted.sort((a, b) => {
        const costA = this.cardCosts[a.catalogCardId], costB = this.cardCosts[b.catalogCardId];
        const rankA = typeof costA === 'number' ? costA : Infinity, rankB = typeof costB === 'number' ? costB : Infinity;
        return rankA - rankB || a.cardName.localeCompare(b.cardName, 'it');
      });
      case 'name-desc': return sorted.sort((a, b) => b.cardName.localeCompare(a.cardName, 'it'));
      case 'qty-desc': return sorted.sort((a, b) => b.quantity - a.quantity || a.cardName.localeCompare(b.cardName, 'it'));
      case 'name-asc': return sorted.sort((a, b) => a.cardName.localeCompare(b.cardName, 'it'));
      default: return sorted.sort((a, b) => {
        const rank = (TYPE_RANK[this.cardTypes[a.catalogCardId] || ''] ?? 3) - (TYPE_RANK[this.cardTypes[b.catalogCardId] || ''] ?? 3);
        return rank || a.cardName.localeCompare(b.cardName, 'it');
      });
    }
  }
  cardTile(item, report) {
    const selected = this.selectedCard && this.selectedCard.catalogCardId === item.catalogCardId && this.selectedCard.section === item.section && (this.selectedCard.printingId || null) === (item.printingId || null);
    const info = report?.perCard.get(deckCardIdentityKey(item));
    // Più printing della stessa carta logica (regular/parallel, Fase 4.1)
    // diventano più tile distinte in griglia: data-deck-card-select-printing
    // è ciò che le distingue quando si seleziona/modifica/rimuove.
    return `<button type="button" class="deck-tile ${selected ? 'selected' : ''} ${this.cardSort === 'manual' ? 'manual-sort' : ''}" data-card-type="${esc(this.cardTypes[item.catalogCardId] || '')}" data-deck-card-select="${esc(item.catalogCardId)}" data-deck-card-select-section="${item.section}" data-deck-card-select-printing="${esc(item.printingId || '')}" aria-label="${esc(item.cardName)}, quantità ${item.quantity}"><span class="deck-tile-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" loading="lazy">` : icon('card')}${restrictionBadge(item.banTcg)}${info?.borrowed > 0 ? `<i class="deck-loan-badge" title="In prestito">${icon('swap')}</i>` : ''}<b>${item.quantity}</b></span></button>`;
  }
  cardSheet(item, report, deck, { readonly = false } = {}) {
    // DON!! non è più raggiungibile dalla griglia (P1.0, gestito in automatico):
    // non ha senso offrirlo come destinazione di uno spostamento manuale.
    const otherSections = sectionsFor(deck).filter(section => section !== item.section && !(deck.game === 'onepiece' && section === 'don'));
    const info = report?.perCard.get(deckCardIdentityKey(item));
    return `<div class="deck-sheet" role="dialog" aria-label="Dettaglio carta ${esc(item.cardName)}">
      <button type="button" class="deck-sheet-close" data-deck-sheet-close aria-label="Chiudi dettaglio">${icon('arrow')}</button>
      <div class="deck-sheet-body">
        <span class="deck-sheet-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="">` : icon('card')}</span>
        <span class="deck-sheet-copy"><strong>${esc(item.cardName)}</strong><small>${labelsFor(deck)[item.section]}${item.printingSetCode ? ` · ${esc(item.printingSetCode)}` : ''}</small>${item.banTcg ? `<i class="deck-sheet-badge ${item.banTcg}">${esc(BAN_LABELS[item.banTcg] || '')}</i>` : ''}${info?.borrowed > 0 ? `<i class="deck-sheet-badge loan">${icon('swap')} ${ownershipLabel(info)}</i>` : ''}</span>
      </div>
      <div class="deck-sheet-stepper">${readonly ? '' : `<button type="button" data-deck-sheet-qty="minus" aria-label="Rimuovi una copia">−</button>`}<span>${item.quantity}</span>${readonly ? '' : `<button type="button" data-deck-sheet-qty="plus" aria-label="Aggiungi una copia">+</button>`}</div>
      ${readonly ? '' : `<div class="deck-sheet-actions">${otherSections.map(section => `<button type="button" data-deck-sheet-move="${section}">${icon('swap')} In ${labelsFor(deck)[section].replace(' Deck', '')}</button>`).join('')}<button type="button" data-deck-printing="${esc(item.catalogCardId)}" data-deck-printing-section="${esc(item.section)}">${icon('card')} ${item.printingSetCode ? `${esc(item.printingSetCode)} · ${esc(item.printingRarity || 'Rarità')}` : 'Scegli rarità/edizione'}</button><button type="button" class="danger" data-deck-sheet-remove>${icon('trash')} Rimuovi</button></div>`}
      ${this.availabilityFoot(report)}
    </div>`;
  }
  availabilityFoot(report) { return `<button type="button" class="deck-sheet-foot" data-deck-missing-open><span class="deck-sheet-dot ${report.percent === 100 ? 'ok' : 'warn'}"></span><b>${report.percent}% pronto per il team</b><small>${report.rows.length} ${report.rows.length === 1 ? 'mancante' : 'mancanti'}</small></button>`; }
  availabilityPeek(report) { return `<button type="button" class="deck-peek" data-deck-missing-open aria-label="Apri carte mancanti"><span class="deck-peek-ring" style="--ready:${report.percent}"><i>${report.percent}%</i></span><span class="deck-peek-copy"><b>${report.percent}% pronto per il team</b><small>${report.rows.length} carte mancanti o parziali</small></span><span class="deck-peek-chev">${icon('arrow')}</span></button>`; }
  moreMenu(deck) {
    const signature = resolveDeckSignature(deck), artwork = preferredDeckArtwork(signature);
    return `<div class="detail-backdrop deck-dialog-backdrop" data-deck-more-close><aside class="card-detail deck-more-menu" role="dialog" aria-modal="true" aria-label="Altre azioni sul mazzo">
      <button class="detail-close" data-deck-more-close aria-label="Chiudi">×</button>
      <span class="eyebrow">Mazzo</span><h2>${esc(deck.name)}</h2>
      <div class="deck-more-box"><span class="deck-more-box-art">${artwork ? `<img src="${esc(artwork)}" alt="">` : icon('deck')}</span><div><strong>Deck Box</strong><small>${DECK_BOX_TEMPLATES[normalizeDeckBoxTemplate(deck.deckBoxTemplate)].label} · ${signature ? `Signature: ${esc(signature.cardName)}` : 'cover F.P.T generica'}</small><label>Tema Deck Box<select data-deck-theme>${deckThemeOptions(deck.deckTheme)}</select></label></div></div>
      <div class="deck-more-actions">
        <button type="button" class="btn secondary" data-deck-cover-open>${icon('deck')} Personalizza Deck Box</button>
        <button type="button" class="btn secondary" data-deck-new>${icon('plus')} Nuovo mazzo</button>
        ${deck.game === 'onepiece' ? `<button type="button" class="btn secondary" data-deck-optcg-import>${icon('logout')} Importa da OPTCGSim</button><button type="button" class="btn secondary" data-deck-optcg-export>${icon('share')} Copia per OPTCGSim</button>` : `<button type="button" class="btn secondary" data-deck-import>${icon('logout')} Importa lista / YDK</button>`}
        <button type="button" class="btn secondary danger" data-deck-delete ${deck.persisted ? '' : 'disabled'}>${icon('trash')} Elimina mazzo</button>
      </div>
    </aside></div>`;
  }
  optcgImportView() {
    const result = this.optcgImportResult;
    return `<div class="detail-backdrop deck-dialog-backdrop" data-deck-optcg-import-close><aside class="card-detail deck-import" role="dialog" aria-modal="true"><button class="detail-close" data-deck-optcg-import-close aria-label="Chiudi">×</button><span class="eyebrow">OPTCGSim</span><h2>Importa da OPTCGSim</h2><p>Incolla la decklist copiata da OPTCGSim (una riga per carta, es. <code>4xOP17-086</code>).</p><label>Decklist<textarea data-deck-optcg-import-text rows="12" placeholder="1xOP13-004&#10;4xOP17-086&#10;3xOP01-016"></textarea></label><button class="btn wide" data-deck-optcg-import-run ${this.optcgImportBusy ? 'disabled' : ''}>${this.optcgImportBusy ? 'Importazione…' : 'Importa nel mazzo'}</button>${result ? `<div class="collection-save-status optcg-import-result"><strong>${result.resolved}/${result.total} carte riconosciute</strong>${result.unresolved.length ? `<p>Codici non riconosciuti: ${result.unresolved.map(code => esc(code)).join(', ')}</p>` : ''}${result.errors.length ? `<p>${result.errors.length} ${result.errors.length === 1 ? 'problema' : 'problemi'} di validazione: ${result.errors.map(esc).join(' · ')}</p>` : '<p>✓ Mazzo regolare</p>'}</div>` : ''}</aside></div>`;
  }
  missingOverlay(report, { readonly = false, ownerName = '' } = {}) {
    return `<div class="detail-backdrop deck-dialog-backdrop" data-deck-missing-close><aside class="card-detail deck-missing-panel" role="dialog" aria-modal="true" aria-label="Carte mancanti">
      <button class="detail-close" data-deck-missing-close aria-label="Chiudi">×</button>
      <span class="eyebrow">Disponibilità</span><h2>${report.percent}% pronto per il team</h2>
      ${readonly ? `<p class="deck-missing-readonly-note">Solo ${esc(ownerName || 'il proprietario')} può inviare una richiesta per queste carte.</p>` : ''}
      <div class="missing-card-list">${report.rows.length ? report.rows.map(row => missingRow(row, this.state.currentUser, { readonly, choice: this.missingRowChoices.get(row.catalogCardId) })).join('') : `<div class="deck-all-ready">✓ Tutte le carte sono disponibili ${readonly ? 'per il proprietario' : 'nella tua raccolta'}.</div>`}</div>
      ${!readonly && report.requestable ? `<button type="button" class="btn wide" data-deck-request-all ${this.busy || !this.isOnline() ? 'disabled' : ''}>${icon('swap')} Richiedi tutte le carte mancanti</button>` : ''}
    </aside></div>`;
  }
  importView() { return `<div class="detail-backdrop deck-dialog-backdrop" data-deck-import-close><aside class="card-detail deck-import" role="dialog" aria-modal="true"><button class="detail-close" data-deck-import-close aria-label="Chiudi">×</button><span class="eyebrow">Importazione</span><h2>Carica un mazzo</h2><p>Supporta file .ydk, passcode Yu-Gi-Oh! e liste del tipo “3 Nome carta”.</p><label>File YDK o testo<input type="file" data-deck-file accept=".ydk,.txt,text/plain"></label><label>Oppure incolla la lista<textarea data-deck-import-text rows="12" placeholder="#main&#10;46986414&#10;46986414&#10;#extra&#10;..."></textarea></label><button class="btn wide" data-deck-import-run ${this.busy ? 'disabled' : ''}>${this.busy ? 'Importazione…' : 'Importa nel mazzo'}</button></aside></div>`; }
  // Bloccati senza rivelare la condizione di sblocco (stesso principio già
  // usato per gli avatar di rivalità in js/cosmetics.js): solo un lucchetto
  // e un'etichetta oscurata, mai un hint sull'archetipo/streak richiesti.
  deckBoxTemplateOptionView(value, option, activeTemplate) {
    const unlocked = this.isDeckBoxUnlocked(value);
    return `<button data-deck-box-template="${value}" class="${activeTemplate === value ? 'active' : ''} ${unlocked ? '' : 'locked'}" ${unlocked ? '' : 'disabled aria-label="Deck Box bloccata"'}>${option.image ? `<img src="${esc(option.image)}" alt="${esc(unlocked ? option.label : 'Deck Box bloccata')}" loading="lazy">` : `<span>${icon('deck')}</span>`}${unlocked ? '' : `<i class="deck-box-lock">${icon('lock')}</i>`}<strong>${esc(unlocked ? option.label : '???')}</strong>${activeTemplate === value ? '<b>Selezionato</b>' : ''}</button>`;
  }
  coverPickerView(deck) { const cards = uniqueDeckCards(deck.cards), template = normalizeDeckBoxTemplate(deck.deckBoxTemplate); return `<div class="detail-backdrop deck-dialog-backdrop" data-deck-cover-close><aside class="card-detail deck-cover-picker" role="dialog" aria-modal="true" aria-labelledby="deck-cover-title"><button class="detail-close" data-deck-cover-close aria-label="Chiudi">×</button><span class="eyebrow">Deck Box Studio</span><h2 id="deck-cover-title">Personalizza la Deck Box</h2><p>Scegli modello, colore e carta firma. Anteprima immediata; modifiche conservate nella bozza del mazzo.</p><div class="deck-studio-layout"><div class="deck-studio-preview">${renderDeckBoxVisual(deck)}<strong>${esc(deck.name)}</strong><small>Anteprima in tempo reale</small></div><div class="deck-studio-controls"><label class="deck-studio-theme">Colore & cornice<select data-deck-theme>${deckThemeOptions(deck.deckTheme)}</select></label><h3>Modello Deck Box</h3><div class="deck-template-options">${Object.entries(DECK_BOX_TEMPLATES).map(([value, option]) => this.deckBoxTemplateOptionView(value, option, template)).join('')}</div></div><div class="deck-studio-signature"><div class="deck-signature-heading"><h3>Carta signature</h3><p>Usata dal modello dinamico. Deve essere già presente nel mazzo.</p></div>${cards.length ? `<div class="deck-cover-options">${cards.map(card => `<button data-deck-cover-card="${esc(card.catalogCardId)}" class="${String(deck.signatureCardId || '') === String(card.catalogCardId) ? 'active' : ''}">${card.imageUrl ? `<img src="${esc(card.imageUrl)}" alt="${esc(card.cardName)}" loading="lazy">` : icon('card')}<span><strong>${esc(card.cardName)}</strong><small>${labelsFor(deck)[card.section] || card.section}</small></span>${String(deck.signatureCardId || '') === String(card.catalogCardId) ? '<b>Signature</b>' : icon('arrow')}</button>`).join('')}</div>` : '<div class="deck-signature-empty">Aggiungi almeno una carta al mazzo per scegliere la signature.</div>'}</div></div><button class="btn wide deck-cover-back" data-deck-cover-close>Fatto · Torna al mazzo</button></aside></div>`; }
  printingPickerView() { const picker = this.printingPicker; return `<div class="detail-backdrop deck-dialog-backdrop" data-deck-printing-close><aside class="card-detail deck-printing-picker" role="dialog" aria-modal="true"><button class="detail-close" data-deck-printing-close aria-label="Chiudi">×</button><span class="eyebrow">Mazzo</span><h2>Seleziona la printing</h2><p>${esc(picker.cardName)} · nessuna scelta viene effettuata automaticamente.</p>${picker.loading ? '<div class="deck-printing-loading"><span class="loading-spinner"></span> Caricamento printing…</div>' : picker.error ? `<div class="connection-banner error">${esc(picker.error)}</div>` : picker.options.length ? `<div class="deck-printing-options">${picker.options.map(option => `<button data-deck-printing-option="${esc(option.printingId)}">${option.imageUrl ? `<img src="${esc(option.imageUrl)}" alt="">` : icon('card')}<span><strong>${esc(option.setCode || 'Set non indicato')}</strong><small>${esc(option.setName || 'Espansione non indicata')} · ${esc(option.rarity || 'Rarità non indicata')}</small></span>${icon('arrow')}</button>`).join('')}</div>` : '<div class="empty-state compact"><h3>Nessuna printing disponibile</h3><p>Aggiungi prima una copia precisa alla Raccolta.</p></div>'}</aside></div>`; }
  bind(root = document) {
    // L'attributo HTML autoplay funziona solo per video muti: per avere
    // l'audio il play() va chiamato da JS. Prova con audio, e solo se il
    // browser lo blocca (nessuna interazione recente) riprova muto così
    // almeno il video parte — non lasciarlo semplicemente fermo.
    root.querySelectorAll('[data-deck-celebrate]').forEach(video => {
      video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
      this.claimBattleReadyTitle();
    });
    root.querySelectorAll('[data-deck-new]').forEach(button => button.addEventListener('click', () => this.create()));
    root.querySelector('[data-deck-gallery]')?.addEventListener('click', () => this.showGallery());
    root.querySelectorAll('[data-deck-scope]').forEach(button => button.addEventListener('click', () => { this.scope = button.dataset.deckScope; if (this.scope === 'team' && !this.teamDecksAll.length && !this.teamLoadInFlight) void this.loadTeam().then(() => this.onRender()); this.onRender(); }));
    root.querySelectorAll('[data-deck-team-member]').forEach(button => button.addEventListener('click', () => { this.teamMemberFilter = button.dataset.deckTeamMember; this.onRender(); }));
    root.querySelectorAll('[data-deck-open-team]').forEach(button => button.addEventListener('click', () => this.openTeam(button.dataset.deckOpenTeam)));
    root.querySelector('[data-deck-save]')?.addEventListener('click', () => void this.save()); root.querySelector('[data-deck-delete]')?.addEventListener('click', () => void this.remove());
    root.querySelector('[data-deck-name]')?.addEventListener('input', event => { const deck = this.active(); if (deck) { deck.name = event.target.value; this.markDirty(deck); } });
    root.querySelector('select[data-deck-theme]')?.addEventListener('change', event => { const deck = this.active(); if (!deck) return; deck.deckTheme = event.target.value; this.markDirty(deck); this.onRender(); });
    root.querySelector('[data-deck-cover-open]')?.addEventListener('click', () => { this.coverPickerOpen = true; this.moreMenuOpen = false; this.onRender(); });
    root.querySelectorAll('[data-deck-cover-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.coverPickerOpen = false; this.onRender(); }));
    root.querySelectorAll('[data-deck-cover-card]').forEach(button => button.addEventListener('click', () => this.chooseCover(button.dataset.deckCoverCard)));
    root.querySelectorAll('[data-deck-box-template]').forEach(button => button.addEventListener('click', () => this.chooseDeckBoxTemplate(button.dataset.deckBoxTemplate)));
    root.querySelectorAll('[data-deck-open]').forEach(button => button.addEventListener('click', () => this.open(button.dataset.deckOpen)));
    root.querySelector('[data-deck-search]')?.addEventListener('input', event => this.search(event.target.value));
    root.querySelector('[data-deck-search-close]')?.addEventListener('click', () => { if (history.state?.deckSearch) history.back(); else { this.closeSearch(); this.onRender(); } });
    root.querySelectorAll('[data-deck-printing]').forEach(button => button.addEventListener('click', () => void this.openPrintingPicker(button.dataset.deckPrinting, button.dataset.deckPrintingSection)));
    root.querySelectorAll('[data-deck-printing-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.printingPicker = null; this.onRender(); }));
    root.querySelectorAll('[data-deck-printing-option]').forEach(button => button.addEventListener('click', () => void this.choosePrinting(button.dataset.deckPrintingOption)));
    root.querySelectorAll('[data-deck-request]').forEach(button => button.addEventListener('click', () => void this.request(button.dataset.deckRequest)));
    root.querySelector('[data-deck-request-all]')?.addEventListener('click', () => void this.requestAll());
    root.querySelectorAll('[data-deck-owner]').forEach(select => select.addEventListener('change', () => this.setMissingRowChoice(select.dataset.deckOwner, { ownerSlug: select.value })));
    root.querySelectorAll('[data-deck-pre-agreed]').forEach(checkbox => checkbox.addEventListener('change', () => this.setMissingRowChoice(checkbox.dataset.deckPreAgreed, { preAgreed: checkbox.checked })));
    root.querySelectorAll('[data-deck-import]').forEach(button => button.addEventListener('click', () => { if (!this.active()) this.create(false); this.importOpen = true; this.moreMenuOpen = false; this.onRender(); }));
    root.querySelector('[data-deck-import-new]')?.addEventListener('click', () => { this.create(false); this.importOpen = true; this.onRender(); });
    root.querySelectorAll('[data-deck-import-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.importOpen = false; this.onRender(); }));
    root.querySelector('[data-deck-file]')?.addEventListener('change', async event => { const text = await event.target.files?.[0]?.text(); const field = root.querySelector('[data-deck-import-text]'); if (field && text != null) field.value = text; });
    root.querySelector('[data-deck-import-run]')?.addEventListener('click', () => void this.importText(root.querySelector('[data-deck-import-text]')?.value || ''));
    root.querySelectorAll('[data-deck-optcg-import]').forEach(button => button.addEventListener('click', () => { if (!this.active()) this.create(false); this.optcgImportResult = null; this.optcgImportOpen = true; this.moreMenuOpen = false; this.onRender(); }));
    root.querySelector('[data-deck-optcg-import-new]')?.addEventListener('click', () => { this.create(false); this.optcgImportResult = null; this.optcgImportOpen = true; this.onRender(); });
    root.querySelectorAll('[data-deck-optcg-import-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.optcgImportOpen = false; this.optcgImportResult = null; this.onRender(); }));
    root.querySelector('[data-deck-optcg-import-run]')?.addEventListener('click', () => void this.importOptcgList(root.querySelector('[data-deck-optcg-import-text]')?.value || ''));
    root.querySelectorAll('[data-deck-optcg-export]').forEach(button => button.addEventListener('click', () => { this.moreMenuOpen = false; this.onRender(); void this.copyOptcgExport(); }));
    root.querySelectorAll('[data-deck-section]').forEach(button => button.addEventListener('click', () => this.setSection(button.dataset.deckSection)));
    root.querySelector('[data-deck-pick-leader]')?.addEventListener('click', () => this.pickLeader());
    root.querySelectorAll('[data-deck-type-filter]').forEach(button => button.addEventListener('click', () => this.setTypeFilter(button.dataset.deckTypeFilter)));
    root.querySelector('[data-deck-sort-cycle]')?.addEventListener('click', () => this.cycleSort());
    root.querySelectorAll('[data-deck-card-select]').forEach(button => button.addEventListener('click', () => this.selectCard(button.dataset.deckCardSelect, button.dataset.deckCardSelectSection, button.dataset.deckCardSelectPrinting || null)));
    root.querySelector('[data-deck-sheet-close]')?.addEventListener('click', () => this.closeSheet());
    root.querySelectorAll('[data-deck-sheet-qty]').forEach(button => button.addEventListener('click', () => this.sheetQuantity(button.dataset.deckSheetQty === 'plus' ? 1 : -1)));
    root.querySelectorAll('[data-deck-sheet-move]').forEach(button => button.addEventListener('click', () => this.moveSelectedCard(button.dataset.deckSheetMove)));
    root.querySelector('[data-deck-sheet-remove]')?.addEventListener('click', () => this.removeSelectedCard());
    root.querySelectorAll('[data-deck-missing-open]').forEach(button => button.addEventListener('click', () => this.toggleMissingPanel(true)));
    root.querySelectorAll('[data-deck-missing-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.toggleMissingPanel(false); }));
    root.querySelector('[data-deck-more]')?.addEventListener('click', () => this.toggleMoreMenu());
    root.querySelectorAll('[data-deck-more-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.moreMenuOpen = false; this.onRender(); }));
    // Drag&drop solo nel proprio editor (mai sul mazzo di un compagno in
    // sola lettura) e solo quando l'ordinamento "Manuale" è attivo.
    if (this.screen === 'detail' && this.cardSort === 'manual') {
      root.querySelectorAll('.deck-mobile-grid .deck-tile').forEach(tile => tile.addEventListener('pointerdown', event => this.startTileDrag(event, tile)));
    }
  }
  // Tieni premuto (touch) o trascina subito (mouse) una tile in modalità
  // "Manuale" per riordinarla dentro la sua sezione. Il ritardo per il touch
  // esiste apposta per non rubare lo scroll verticale della griglia: se il
  // dito si muove prima che scatti, si interpreta come uno scroll e si
  // annulla tutto senza mai chiamare preventDefault.
  startTileDrag(event, tile) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const deck = this.active();
    if (!deck) return;
    const grid = tile.closest('.deck-mobile-grid');
    if (!grid) return;
    const catalogCardId = tile.dataset.deckCardSelect, section = tile.dataset.deckCardSelectSection, printingId = tile.dataset.deckCardSelectPrinting || null;
    const startX = event.clientX, startY = event.clientY, pointerId = event.pointerId;
    let armed = event.pointerType === 'mouse', moved = false, cancelled = false, lastTarget = null;
    const armTimer = event.pointerType === 'mouse' ? null : setTimeout(() => {
      if (cancelled) return;
      armed = true;
      try { tile.setPointerCapture(pointerId); } catch {}
      tile.classList.add('dragging');
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch {} }
    }, 160);
    if (armed) { try { tile.setPointerCapture(pointerId); } catch {} tile.classList.add('dragging'); }
    const cleanup = () => {
      cancelled = true;
      if (armTimer) clearTimeout(armTimer);
      tile.removeEventListener('pointermove', onMove);
      tile.removeEventListener('pointerup', onUp);
      tile.removeEventListener('pointercancel', onCancel);
      tile.classList.remove('dragging');
      tile.style.transform = ''; tile.style.zIndex = ''; tile.style.pointerEvents = '';
      if (lastTarget) { lastTarget.classList.remove('drop-target'); lastTarget = null; }
    };
    const onMove = moveEvent => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX, dy = moveEvent.clientY - startY;
      if (!armed) { if (Math.hypot(dx, dy) > 8) cleanup(); return; }
      moved = true;
      moveEvent.preventDefault();
      tile.style.zIndex = '5';
      tile.style.transform = `translate(${dx}px, ${dy}px) scale(1.05)`;
      tile.style.pointerEvents = 'none';
      const hovered = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest('.deck-tile');
      tile.style.pointerEvents = '';
      if (lastTarget && lastTarget !== hovered) lastTarget.classList.remove('drop-target');
      lastTarget = hovered && hovered !== tile && grid.contains(hovered) ? hovered : null;
      if (lastTarget) lastTarget.classList.add('drop-target');
    };
    const onUp = upEvent => {
      if (upEvent.pointerId !== pointerId) return;
      const shouldCommit = armed && moved && lastTarget;
      const target = lastTarget;
      cleanup();
      if (shouldCommit) this.reorderCard(deck, section, { catalogCardId, printingId }, { catalogCardId: target.dataset.deckCardSelect, printingId: target.dataset.deckCardSelectPrinting || null });
    };
    const onCancel = () => cleanup();
    tile.addEventListener('pointermove', onMove);
    tile.addEventListener('pointerup', onUp);
    tile.addEventListener('pointercancel', onCancel);
  }
  // Riordina `from` alla posizione di `to` dentro la stessa sezione: sposta
  // l'oggetto nella slice della sezione, poi lo reinserisce in deck.cards
  // sostituendo ogni occorrenza della sezione nell'ordine originale — così
  // l'interleaving con le altre sezioni resta intatto, cambia solo l'ordine
  // interno di questa.
  reorderCard(deck, section, from, to) {
    const items = deck.cards.filter(card => card.section === section);
    const fromIndex = items.findIndex(card => card.catalogCardId === from.catalogCardId && (card.printingId || null) === (from.printingId || null));
    const toIndex = items.findIndex(card => card.catalogCardId === to.catalogCardId && (card.printingId || null) === (to.printingId || null));
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
    const [moved] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, moved);
    let cursor = 0;
    deck.cards = deck.cards.map(card => card.section === section ? items[cursor++] : card);
    this.markDirty(deck);
    this.onRender();
  }
  open(id) { if (!this.decks.some(deck => deck.id === id)) return; this.activeId = id; this.previewId = id; this.screen = 'detail'; this.resetEditorView(); void this.resolveCardTypes(this.active()); void this.resolveCardCosts(this.active()); this.onRender(); }
  openTeam(id) { if (!this.teamDecks.some(deck => deck.id === id)) return; this.teamDetailId = id; this.screen = 'team-detail'; this.resetEditorView(); void this.resolveCardTypes(this.activeTeamDeck()); void this.resolveCardCosts(this.activeTeamDeck()); this.onRender(); }
  showGallery(render = true) { this.screen = 'gallery'; this.teamDetailId = ''; this.importOpen = false; this.coverPickerOpen = false; this.printingPicker = null; if (render) this.onRender(); }
  create(render = true) { const deck = { id: `draft-${Date.now()}`, persisted: false, dirty: true, ownerSlug: this.state.currentUser, name: 'Nuovo mazzo', format: 'TCG Avanzato', game: this.state.game, cards: [], cover: '', signatureCardId: null, deckTheme: DEFAULT_DECK_THEME, deckBoxTemplate: DEFAULT_DECK_BOX_TEMPLATE }; this.state.decks = [deck, ...(this.state.decks || [])]; this.activeId = deck.id; this.previewId = deck.id; this.screen = 'detail'; this.resetEditorView(); this.persistDrafts(); if (deck.game === 'onepiece') void this.autofillDon(deck); if (render) this.onRender(); }
  // Le 10 carte DON!! (P1.0) non passano più da un tab dedicato: ogni mazzo
  // One Piece nuovo le riceve subito in automatico cercandole nel catalogo.
  // Se il catalogo non è ancora sincronizzato la ricerca torna vuota — resta
  // semplicemente 0/10 nel riepilogo finché il sync non gira, nessun errore
  // mostrato all'utente.
  async autofillDon(deck) {
    const adapter = getGameAdapter(deck.game);
    if (!adapter.donSearchQuery || !adapter.donDeckSize || deck.cards.some(card => card.section === 'don')) return;
    try {
      const results = await this.searchCards(adapter.donSearchQuery, deck.game);
      const card = results.find(adapter.isDonCard) || results[0];
      if (!card || !this.decks.some(d => d.id === deck.id)) return;
      this.addSilent(card, 'don', adapter.donDeckSize);
      this.persistDrafts();
      this.onRender();
    } catch {}
  }
  // Riparte sempre dalla prima sezione dell'adapter per Yu-Gi-Oh (Main). Per
  // One Piece il Leader ha ora la sua card dedicata (P1.0) fuori dai tab, così
  // la ricerca generica targetizza subito il Main invece del Leader.
  // L'ordinamento resta quello scelto dall'utente quando si riapre un mazzo
  // dello STESSO gioco (persiste apposta, non va azzerato ogni volta) — ma
  // se non è un'opzione valida per questo gioco (es. si arriva da un mazzo
  // Yu-Gi-Oh con "Tipo" e si apre un mazzo One Piece) si torna al default di
  // quel gioco, che per One Piece è "Costo" crescente su richiesta esplicita
  // dell'utente (non va scelto a mano ogni volta).
  resetEditorView() {
    const deck = this.screen === 'team-detail' ? this.activeTeamDeck() : this.active(), first = deck?.game === 'onepiece' ? 'main' : (sectionsFor(deck)[0] || 'main');
    this.activeSection = first; this.targetSection = first; this.cardTypeFilter = 'all'; this.selectedCard = null; this.missingPanelOpen = false; this.moreMenuOpen = false; this.catalogExpansion = 'all'; this.catalogColors = new Set(); this.catalogColorsTouched = false;
    const sortOptions = sortOptionsFor(deck?.game);
    if (!sortOptions.some(option => option.value === this.cardSort)) this.cardSort = sortOptions[0].value;
  }
  setSection(section) { const deck = this.screen === 'team-detail' ? this.activeTeamDeck() : this.active(); if (!sectionsFor(deck).includes(section)) return; this.activeSection = section; this.targetSection = section; this.selectedCard = null; this.onRender(); }
  // Apre la ricerca generica targetizzata sul Leader (bottone "Scegli"/"Cambia"
  // della hero, P1.0) — stessa apertura che fa `search()` digitando, così il
  // tasto indietro/la X la chiudono allo stesso modo.
  pickLeader() {
    const deck = this.active(); if (!deck) return;
    this.targetSection = 'leader';
    if (!this.searchOpen) { this.searchOpen = true; history.pushState({ deckSearch:true }, '', location.href); }
    this.onRender();
    this.renderSearchResultsList();
    setTimeout(() => document.querySelector('[data-deck-search]')?.focus(), 0);
  }
  setTypeFilter(value) { if (!TYPE_FILTERS.some(f => f.value === value)) return; this.cardTypeFilter = value; this.onRender(); }
  selectCard(catalogCardId, section, printingId = null) { const deck = this.screen === 'team-detail' ? this.activeTeamDeck() : this.active(); if (!deck?.cards.some(item => item.catalogCardId === catalogCardId && item.section === section && (item.printingId || null) === (printingId || null))) return; this.selectedCard = { catalogCardId, section, printingId: printingId || null }; this.missingPanelOpen = false; this.onRender(); }
  closeSheet() { this.selectedCard = null; this.onRender(); }
  sheetQuantity(delta) { const sel = this.selectedCard; if (!sel) return; this.quantity(sel.catalogCardId, sel.section, delta, sel.printingId); if (!this.active()?.cards.some(card => card.catalogCardId === sel.catalogCardId && card.section === sel.section && (card.printingId || null) === (sel.printingId || null))) this.selectedCard = null; this.onRender(); }
  moveSelectedCard(toSection) {
    const deck = this.active(), sel = this.selectedCard;
    if (!deck || !sel || !sectionsFor(deck).includes(toSection) || toSection === sel.section) return;
    const item = deck.cards.find(card => card.catalogCardId === sel.catalogCardId && card.section === sel.section && (card.printingId || null) === (sel.printingId || null));
    if (!item) return;
    if (deck.game === 'onepiece' && toSection === 'leader') deck.cards = deck.cards.filter(card => card === item || card.section !== 'leader');
    const destination = deck.cards.find(card => card.catalogCardId === sel.catalogCardId && card.section === toSection && (card.printingId || null) === (sel.printingId || null));
    const budget = copyBudget(deck, toSection, sel.catalogCardId, destination);
    if (destination) { destination.quantity = Math.min(budget, destination.quantity + item.quantity); deck.cards = deck.cards.filter(card => card !== item); }
    else { item.section = toSection; item.quantity = Math.min(budget, item.quantity); }
    this.selectedCard = { catalogCardId: sel.catalogCardId, section: toSection, printingId: sel.printingId };
    this.activeSection = toSection;
    this.markDirty(deck); this.onRender();
  }
  removeSelectedCard() {
    const deck = this.active(), sel = this.selectedCard;
    if (!deck || !sel) return;
    deck.cards = deck.cards.filter(card => !(card.catalogCardId === sel.catalogCardId && card.section === sel.section && (card.printingId || null) === (sel.printingId || null)));
    if (String(deck.signatureCardId || '') === String(sel.catalogCardId) && !deck.cards.some(card => String(card.catalogCardId) === String(sel.catalogCardId))) deck.signatureCardId = null;
    // Leader rimosso: il prefiltro Colore (P1.0.1) torna "automatico" così si
    // riallinea subito al prossimo Leader scelto, invece di restare bloccato
    // sui colori di quello appena tolto.
    if (deck.game === 'onepiece' && sel.section === 'leader') { this.catalogColors = new Set(); this.catalogColorsTouched = false; }
    this.selectedCard = null;
    this.markDirty(deck); this.onRender();
  }
  toggleMissingPanel(open) { this.missingPanelOpen = open; if (open) this.selectedCard = null; else this.missingRowChoices.clear(); this.onRender(); }
  toggleMoreMenu() { this.moreMenuOpen = !this.moreMenuOpen; this.onRender(); }
  setSort(value) { const deck = this.screen === 'team-detail' ? this.activeTeamDeck() : this.active(); if (!sortOptionsFor(deck?.game).some(option => option.value === value)) return; this.cardSort = value; this.onRender(); }
  cycleSort() { const deck = this.screen === 'team-detail' ? this.activeTeamDeck() : this.active(); const options = sortOptionsFor(deck?.game); const index = options.findIndex(option => option.value === this.cardSort); this.setSort(options[(index + 1) % options.length].value); }
  async resolveCardTypes(deck) {
    if (!deck || deck.game !== 'yugioh' || !this.cardTypesByIds || this.typesLoading) return;
    const ids = [...new Set(deck.cards.map(card => card.catalogCardId))].filter(id => !(id in this.cardTypes));
    if (!ids.length) return;
    this.typesLoading = true;
    try {
      const resolved = await this.cardTypesByIds(ids, deck.game);
      for (const id of ids) this.cardTypes[id] = coarseCardType(resolved[id] || '');
      writeTypeCache(this.cardTypes);
    } finally {
      this.typesLoading = false;
      this.onRender();
    }
  }
  // Costo One Piece per l'ordinamento "Costo" (default del Main): stesso
  // ruolo di resolveCardTypes, ma la fonte è l'adapter di gioco
  // (card_printings) invece di YGOPRODeck, e non c'è nulla da fare per
  // Yu-Gi-Oh (l'adapter non espone cardCostsByIds).
  async resolveCardCosts(deck) {
    const adapter = getGameAdapter(deck?.game);
    if (!deck || !adapter.cardCostsByIds || this.costsLoading) return;
    const ids = [...new Set(deck.cards.map(card => card.catalogCardId))].filter(id => !(id in this.cardCosts));
    if (!ids.length) return;
    this.costsLoading = true;
    try {
      const resolved = await adapter.cardCostsByIds(ids);
      for (const id of ids) this.cardCosts[id] = resolved[id] ?? null;
    } finally {
      this.costsLoading = false;
      this.onRender();
    }
  }
  search(query) {
    this.searchQuery = query;
    if (query.trim().length >= 3 && !this.searchOpen) {
      this.searchOpen = true;
      history.pushState({ deckSearch:true }, '', location.href);
      // Niente full render qui (romperebbe il focus mentre si digita): la X
      // va mostrata a mano sull'elemento già in pagina.
      document.querySelector('[data-deck-search-close]')?.classList.remove('hidden');
    }
    clearTimeout(this.searchTimer);
    const box = document.querySelector('[data-deck-search-results]');
    if (!box) return;
    if (query.trim().length < 3) { box.innerHTML = ''; this.searchResults = []; document.querySelector('[data-deck-catalog-filters]')?.replaceChildren(); return; }
    box.innerHTML = '<span>Ricerca…</span>';
    this.searchTimer = setTimeout(async () => {
      this.searchResults = await this.searchCards(query, this.state.game);
      this.renderSearchResultsList();
    }, 260);
  }
  // Filtri catalogo One Piece (P1.0.1): applicati lato client sui risultati
  // già scaricati da questa ricerca, mai una nuova chiamata di rete. Il
  // filtro Colore vale solo quando si cerca per il Main (targetSection) — non
  // ha senso filtrare la scelta del Leader sui colori del Leader stesso.
  activeCatalogColors(deck) {
    if (this.targetSection !== 'main') return new Set();
    if (this.catalogColorsTouched) return this.catalogColors;
    const leaderColors = deck?.cards.find(item => item.section === 'leader')?.colors;
    return new Set(Array.isArray(leaderColors) ? leaderColors : []);
  }
  filteredCatalogResults() {
    const deck = this.active();
    if (!deck || deck.game !== 'onepiece') return this.searchResults;
    let list = this.searchResults;
    if (this.catalogExpansion !== 'all') list = list.filter(card => (card.setCode || '') === this.catalogExpansion);
    const colors = this.activeCatalogColors(deck);
    if (colors.size) list = list.filter(card => !Array.isArray(card.colors) || !card.colors.length || card.colors.some(color => colors.has(color)));
    return list;
  }
  // Espansione + Colore vivono nella stessa zona imperativa dei risultati
  // (data-deck-catalog-filters), mai nel template dichiarativo: un onRender()
  // pieno qui romperebbe il focus dell'input mentre si digita, esattamente
  // come per data-deck-search-results.
  catalogFiltersView(deck) {
    const codes = [...new Set(this.searchResults.map(card => card.setCode || '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'it'));
    const expansionRow = codes.length ? `<div class="deck-mh-filters" role="group" aria-label="Filtra per espansione"><div class="deck-mh-chip-scroll"><button type="button" class="chip ${this.catalogExpansion === 'all' ? 'active' : ''}" data-deck-catalog-expansion="all">Tutte</button>${codes.map(code => `<button type="button" class="chip ${this.catalogExpansion === code ? 'active' : ''}" data-deck-catalog-expansion="${esc(code)}">${esc(code)}</button>`).join('')}</div></div>` : '';
    if (this.targetSection !== 'main') return expansionRow;
    const active = this.activeCatalogColors(deck);
    const colorRow = `<div class="deck-mh-filters" role="group" aria-label="Filtra per colore"><div class="deck-mh-chip-scroll">${ONE_PIECE_COLORS.map(color => `<button type="button" class="chip ${active.has(color) ? 'active' : ''}" data-deck-catalog-color="${esc(color)}"><i class="leader-color-dot ${esc(color.toLowerCase())}"></i>${esc(colorLabel(color))}</button>`).join('')}</div>${this.catalogColorsTouched && active.size ? `<button type="button" class="clear-filters" data-deck-catalog-color-reset>Mostra tutti</button>` : ''}</div>`;
    const leader = deck.cards.find(item => item.section === 'leader');
    const note = !this.catalogColorsTouched && active.size ? `<div class="data-note catalog-prefilter-note">${icon('info')}<span>Prefiltrato sui colori del Leader (${esc(leader?.cardName || '')}). <button type="button" class="clear-filters" data-deck-catalog-color-reset>Mostra tutti i colori</button></span></div>` : '';
    return `${expansionRow}${colorRow}${note}`;
  }
  toggleCatalogColor(color) {
    if (!this.catalogColorsTouched) { this.catalogColors = new Set(this.activeCatalogColors(this.active())); this.catalogColorsTouched = true; }
    if (this.catalogColors.has(color)) this.catalogColors.delete(color); else this.catalogColors.add(color);
  }
  bindCatalogFilters(root) {
    root.querySelectorAll('[data-deck-catalog-expansion]').forEach(button => button.addEventListener('click', () => { this.catalogExpansion = button.dataset.deckCatalogExpansion; this.renderSearchResultsList(); }));
    root.querySelectorAll('[data-deck-catalog-color]').forEach(button => button.addEventListener('click', () => { this.toggleCatalogColor(button.dataset.deckCatalogColor); this.renderSearchResultsList(); }));
    root.querySelector('[data-deck-catalog-color-reset]')?.addEventListener('click', () => { this.catalogColorsTouched = true; this.catalogColors = new Set(); this.renderSearchResultsList(); });
  }
  renderSearchResultsList() {
    const deck = this.active();
    const filtersBox = document.querySelector('[data-deck-catalog-filters]');
    if (filtersBox && deck?.game === 'onepiece') { filtersBox.innerHTML = this.catalogFiltersView(deck); this.bindCatalogFilters(filtersBox); }
    const current = document.querySelector('[data-deck-search-results]');
    if (!current) return;
    const list = this.filteredCatalogResults();
    current.innerHTML = list.map((card, index) => `<button data-deck-result="${index}">${card.image ? `<img src="${esc(card.image)}" alt="">` : ''}<span><strong>${esc(card.name)}</strong><small>${esc(card.type || 'Carta')}</small></span>${icon('plus')}</button>`).join('') || '<span>Nessuna carta trovata</span>';
    current.querySelectorAll('[data-deck-result]').forEach(button => button.addEventListener('click', () => this.add(list[Number(button.dataset.deckResult)])));
  }
  closeSearch() { this.searchOpen = false; this.searchQuery = ''; this.searchResults = []; this.catalogExpansion = 'all'; this.catalogColorsTouched = false; this.catalogColors = new Set(); clearTimeout(this.searchTimer); }
  add(card, section = this.targetSection, quantity = 1) {
    const deck = this.active(); if (!deck || !card) return;
    const destination = section === 'main' && isExtraDeckCard(card) ? 'extra' : section, id = canonicalCatalogCardId(card.id, deck.game) || String(card.id);
    // One Piece: il Leader è uno slot unico (sostituisce, non si accumula).
    // Una volta scelto, la ricerca torna a targetizzare il Main di default
    // (P1.0 — "Cambia" sulla hero è l'unico modo per riaprirla sul Leader).
    if (deck.game === 'onepiece' && destination === 'leader') { deck.cards = deck.cards.filter(item => item.section !== 'leader'); this.targetSection = 'main'; this.catalogColors = new Set(); this.catalogColorsTouched = false; }
    const colors = Array.isArray(card.colors) && card.colors.length ? card.colors : undefined;
    // La ricerca/aggiunta rapida non chiede quale printing fisica scegliere:
    // finisce sempre nella riga "non risolta" (printingId assente) per
    // questa carta logica — altre printing specifiche (Fase 4.1) restano
    // righe separate e non vengono toccate qui.
    const existing = deck.cards.find(item => item.catalogCardId === id && item.section === destination && !item.printingId);
    const budget = copyBudget(deck, destination, id, existing);
    if (existing) { existing.quantity = Math.min(budget, existing.quantity + quantity); existing.banTcg = card.banTcg || existing.banTcg || ''; if (colors) existing.colors = colors; }
    else deck.cards.push({ catalogCardId: id, cardName: card.name, imageUrl: card.fullImage || card.image || '', banTcg: card.banTcg || '', section: destination, quantity: Math.min(budget, quantity), ...(colors ? { colors } : {}) });
    deck.cover = deck.cover || card.fullImage || card.image || '';
    this.rememberCardType(id, card.type);
    this.rememberCardCost(id, card.cost);
    this.markDirty(deck);
    this.onRender();
    // La ricerca resta aperta: dopo il re-render pieno (che rimette l'input
    // e il box risultati vuoti) ripristina query, focus e la lista appena
    // aggiunta, così si può continuare ad aggiungere senza ridigitare nulla.
    if (this.searchOpen) {
      const input = document.querySelector('[data-deck-search]');
      if (input) { input.focus(); const pos = input.value.length; input.setSelectionRange(pos, pos); }
      this.renderSearchResultsList();
    }
  }
  rememberCardType(id, rawType) { if (!rawType) return; const bucket = coarseCardType(rawType); if (this.cardTypes[id] === bucket) return; this.cardTypes[id] = bucket; writeTypeCache(this.cardTypes); }
  // Il risultato di ricerca One Piece porta già il costo (catalog.js): non
  // serve aspettare resolveCardCosts (pensato per backfillare le carte di
  // un mazzo già salvato, che non lo portano con sé) per una carta appena
  // aggiunta in questa sessione.
  rememberCardCost(id, cost) { if (!(id in this.cardCosts)) this.cardCosts[id] = typeof cost === 'number' ? cost : null; }
  quantity(id, section, delta, printingId = null) { const deck = this.active(), item = deck?.cards.find(card => card.catalogCardId === id && card.section === section && (card.printingId || null) === (printingId || null)); if (!item) return; item.quantity = Math.min(copyBudget(deck, section, id, item), item.quantity + delta); if (item.quantity <= 0) { deck.cards = deck.cards.filter(card => card !== item); if (String(deck.signatureCardId || '') === String(id) && !deck.cards.some(card => String(card.catalogCardId) === String(id))) deck.signatureCardId = null; } this.markDirty(deck); this.onRender(); }
  chooseCover(catalogCardId) { const deck = this.active(); if (!deck?.cards.some(card => String(card.catalogCardId) === String(catalogCardId))) return this.onToast('La cover deve appartenere al mazzo'); deck.signatureCardId = String(catalogCardId); this.markDirty(deck); this.onToast('Carta signature aggiornata'); this.onRender(); }
  // I 4 modelli storici (procedural/arcane-vault/infernal-dragon/cyber-core)
  // restano sempre disponibili (nessuna regressione) — solo i modelli
  // "archetipo" (js/cosmetics.js, deckbox_<key>) richiedono lo sblocco.
  // getCosmetics è opzionale (undefined durante il boot prima che
  // StatsController abbia caricato i cosmetic): finché non è disponibile, i
  // modelli sbloccabili restano bloccati per sicurezza, mai aperti per default.
  isDeckBoxUnlocked(templateKey) {
    if (!Object.hasOwn(DECK_BOX_TEMPLATES, templateKey)) return false;
    if (!ARCHETYPE_DECK_BOX_KEYS.has(templateKey)) return true;
    const unlocked = this.getCosmetics?.()?.unlocked;
    return Boolean(unlocked?.includes(`deckbox_${templateKey}`));
  }
  chooseDeckBoxTemplate(value) { const deck = this.active(), template = normalizeDeckBoxTemplate(value), preset = DECK_BOX_TEMPLATES[template]; if (!deck || !this.isDeckBoxUnlocked(template)) return; deck.deckBoxTemplate = template; if (preset.theme) deck.deckTheme = preset.theme; this.markDirty(deck); this.onToast(`Deck Box: ${preset.label}`); this.onRender(); }
  async openPrintingPicker(catalogCardId, section) { const deck = this.active(), card = deck?.cards.find(item => item.catalogCardId === catalogCardId && item.section === section); if (!deck?.persisted) return this.onToast('Salva il mazzo prima di selezionare la printing'); this.printingPicker = { catalogCardId, section, cardName: card?.cardName || 'Carta', loading: true, error: '', options: [] }; this.onRender(); try { const rows = await this.api.deckPrintingOptions(deck.id, catalogCardId); if (!this.printingPicker) return; this.printingPicker.options = (rows || []).map(row => ({ printingId: row.printing_id || row.printingId, setCode: row.set_code || row.setCode || '', setName: row.set_name || row.setName || '', rarity: row.rarity || '', imageUrl: row.image_url || row.imageUrl || '' })); } catch (error) { if (this.printingPicker) this.printingPicker.error = error.message || 'Printing non disponibili'; } finally { if (this.printingPicker) this.printingPicker.loading = false; this.onRender(); } }
  async choosePrinting(printingId) { const picker = this.printingPicker, deck = this.active(); if (!picker || !deck) return; const option = picker.options.find(item => item.printingId === printingId); this.busy = true; try { await this.api.setDeckCardPrinting(deck.id, picker.catalogCardId, picker.section, printingId); const card = deck.cards.find(item => item.catalogCardId === picker.catalogCardId && item.section === picker.section); if (card) { card.printingId = printingId; card.printingSetCode = option?.setCode || ''; card.printingRarity = option?.rarity || ''; } this.printingPicker = null; this.onToast('Printing collegata al mazzo'); } catch (error) { this.onToast(error.message || 'Selezione non riuscita'); } finally { this.busy = false; this.onRender(); } }
  async save() { const deck = this.active(); if (!deck || !deck.name.trim() || !this.isOnline()) return this.onToast('Nome del mazzo o connessione non disponibili'); for (const card of deck.cards) card.catalogCardId = canonicalCatalogCardId(card.catalogCardId, deck.game) || card.catalogCardId; const oldId = deck.id; this.busy = true; this.onRender(); try { const result = await this.api.saveDeck(deck), id = String(result?.id || result || oldId); this.clearDraft(oldId); if (result?.deckBoxPersisted === false) { deck.id = id; deck.persisted = true; deck.dirty = true; this.persistDrafts(); await this.load(); this.onToast('Mazzo salvato · Deck Box locale fino alla migration'); } else { await this.load(); this.onToast('Mazzo salvato'); } this.activeId = id; this.previewId = id; } catch (error) { this.error = error.message || 'Salvataggio non riuscito'; } finally { this.busy = false; this.onRender(); } }
  async remove() { const deck = this.active(); if (!deck?.persisted || !confirm(`Eliminare “${deck.name}”?`)) return; this.moreMenuOpen = false; this.busy = true; try { await this.api.deleteDeck(deck.id); this.clearDraft(deck.id); await this.load(); this.activeId = this.decks[0]?.id || ''; this.previewId = this.activeId; this.screen = 'gallery'; this.onToast('Mazzo eliminato'); } catch (error) { this.onToast(error.message || 'Eliminazione non riuscita'); } finally { this.busy = false; this.onRender(); } }
  async importText(text) { if (!text.trim()) return this.onToast('Incolla una lista o seleziona un file'); this.busy = true; this.onRender(); try { const parsed = parseDeckList(text), resolved = new Map(); for (const item of parsed) { const key = item.id ? `id:${item.id}` : `name:${item.name.toLowerCase()}`; if (resolved.has(key)) continue; const card = item.id ? await this.findCardById(item.id, '', this.state.game) : await this.findCard(item.name, this.state.game); if (card) resolved.set(key, card); } for (const item of parsed) { const card = resolved.get(item.id ? `id:${item.id}` : `name:${item.name.toLowerCase()}`); if (card) this.addSilent(card, item.section, item.quantity); } if (!resolved.size) throw new Error('Nessuna carta valida trovata nella lista'); this.importOpen = false; this.onToast(`${resolved.size} carte importate`); } catch (error) { this.onToast(error.message || 'Importazione non riuscita'); } finally { this.busy = false; this.onRender(); } }
  addSilent(card, section, quantity) { const deck = this.active(), id = canonicalCatalogCardId(card.id, deck.game) || String(card.id); if (deck.game === 'onepiece' && section === 'leader') deck.cards = deck.cards.filter(item => item.section !== 'leader'); const colors = Array.isArray(card.colors) && card.colors.length ? card.colors : undefined, existing = deck.cards.find(item => item.catalogCardId === id && item.section === section && !item.printingId), budget = copyBudget(deck, section, id, existing); if (existing) { existing.quantity = Math.min(budget, existing.quantity + quantity); existing.banTcg = card.banTcg || existing.banTcg || ''; if (colors) existing.colors = colors; } else deck.cards.push({ catalogCardId: id, cardName: card.name, imageUrl: card.fullImage || card.image || '', banTcg: card.banTcg || '', section, quantity: Math.min(budget, quantity), ...(colors ? { colors } : {}) }); deck.cover = deck.cover || card.fullImage || card.image || ''; this.rememberCardType(id, card.type); this.rememberCardCost(id, card.cost); this.markDirty(deck); }
  // Import OPTCGSim (P1.1): formato "4xOP17-086", una carta logica per riga —
  // niente printing fisica assunta (resta printingId null, la Fase 4.1 la
  // aggancerà eventualmente dalla Raccolta). Leader/Main si distinguono dal
  // `type` risolto dal catalogo, non da un marcatore nella lista: OPTCGSim
  // non ne usa uno. Le righe DON!! (se presenti) sono ignorate: il DON!! è
  // già auto-riempito alla creazione del mazzo (P1.0).
  async importOptcgList(text) {
    const deck = this.active();
    if (!deck || deck.game !== 'onepiece') return;
    const adapter = getGameAdapter('onepiece');
    const parsed = adapter.parseOptcgList(text);
    if (!parsed.length) return this.onToast('Incolla una decklist OPTCGSim valida');
    this.optcgImportBusy = true; this.onRender();
    const unresolved = [];
    let resolved = 0;
    try {
      for (const { code, quantity } of parsed) {
        const card = await adapter.findCardById(code);
        if (!card) { unresolved.push(code); continue; }
        if (adapter.isDonCard(card)) continue;
        this.addSilent(card, adapter.isLeaderCard(card) ? 'leader' : 'main', quantity);
        resolved++;
      }
      const { errors } = adapter.validateDeck(deck);
      this.optcgImportResult = { total: parsed.length, resolved, unresolved, errors };
    } finally {
      this.optcgImportBusy = false;
      this.onRender();
    }
  }
  // Export FPT -> OPTCGSim (P1.1): aggrega tutte le printing (regular,
  // parallel, ecc.) della stessa carta logica in una sola riga, perché
  // OPTCGSim vuole l'identità della carta, non l'inventario fisico di FPT.
  // Non blocca la copia se il mazzo non è regolare: avvisa e lascia scegliere.
  async copyOptcgExport() {
    const deck = this.active();
    if (!deck || deck.game !== 'onepiece') return;
    const adapter = getGameAdapter('onepiece');
    const { valid, errors } = adapter.validateDeck(deck);
    if (!valid && !confirm(`Mazzo non conforme:\n${errors.join('\n')}\n\nCopiare comunque?`)) return;
    const leader = deck.cards.find(item => item.section === 'leader');
    const mainByCard = new Map();
    for (const card of deck.cards) {
      if (card.section !== 'main') continue;
      const entry = mainByCard.get(card.catalogCardId) || { catalogCardId: card.catalogCardId, quantity: 0 };
      entry.quantity += Number(card.quantity || 0);
      mainByCard.set(card.catalogCardId, entry);
    }
    const lines = [];
    if (leader) lines.push(`1x${leader.catalogCardId}`);
    for (const entry of mainByCard.values()) lines.push(`${entry.quantity}x${entry.catalogCardId}`);
    if (!lines.length) return this.onToast('Il mazzo è vuoto, niente da copiare');
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      this.onToast('Lista copiata per OPTCGSim');
    } catch {
      this.onToast('Copia non riuscita: il browser ha negato l\'accesso agli appunti');
    }
  }
  markDirty(deck) { deck.dirty = true; deck.ownerSlug = this.state.currentUser; this.persistDrafts(); }
  persistDrafts() { const current = readDrafts().filter(deck => deck.ownerSlug !== this.state.currentUser), dirty = (this.state.decks || []).filter(deck => deck.ownerSlug === this.state.currentUser && (deck.dirty || !deck.persisted)); localStorage.setItem(DRAFTS_KEY, JSON.stringify([...current, ...dirty])); }
  clearDraft(id) { const next = readDrafts().filter(deck => !(deck.ownerSlug === this.state.currentUser && deck.id === id)); localStorage.setItem(DRAFTS_KEY, JSON.stringify(next)); }
  setMissingRowChoice(cardId, patch) { if (!cardId) return; this.missingRowChoices.set(cardId, { ...this.missingRowChoices.get(cardId), ...patch }); }
  async request(cardId) {
    const row = deckAvailability(this.active(), this.state.collection, this.state.currentUser, { loans:this.state.loans }).rows.find(item => item.catalogCardId === cardId);
    const choice = this.missingRowChoices.get(cardId);
    const owner = (row?.owners || []).find(candidate => candidate.ownerSlug === choice?.ownerSlug) || row?.best;
    if (!row || !owner) return;
    const preAgreed = Boolean(choice?.preAgreed);
    this.busy = true; this.onRender();
    try {
      let remaining = row.missing;
      const note = preAgreed ? `Prestito già concordato per il mazzo ${this.active().name}` : `Richiesta automatica dal mazzo ${this.active().name}`;
      for (const item of owner.items) {
        const quantity = Math.min(remaining, item.quantityAvailable);
        if (quantity > 0) await this.api.requestCollectionLoan(item.id, quantity, note, preAgreed, crypto.randomUUID());
        remaining -= quantity; if (!remaining) break;
      }
      await this.onLoansChanged?.();
      this.onToast(preAgreed ? `${owner.ownerName} deve solo confermare: prestito segnato come già concordato` : `Richiesta inviata a ${owner.ownerName}`);
    } catch (error) { this.onToast(error.message || 'Richiesta non riuscita'); } finally { this.busy = false; this.onRender(); }
  }
  async requestAll() { const rows = deckAvailability(this.active(), this.state.collection, this.state.currentUser, { loans:this.state.loans }).rows.filter(row => row.best); for (const row of rows) await this.request(row.catalogCardId); }
}

export function deckAvailability(deck, collection, currentUser, { ownerSlug = '', loans = [] } = {}) {
  // ownerSlug lets a viewer browse a teammate's deck read-only: "owned" is computed
  // from that owner's own collection rows instead of the viewer's, and the
  // teammate suggestions exclude the owner instead of the current viewer.
  const reference = ownerSlug || currentUser;
  const cards = deck?.cards || [], team = collection?.team || [], mine = ownerSlug ? team.filter(item => item.ownerSlug === reference) : (collection?.mine || []), required = new Map();
  for (const card of cards) { const key = deckCardIdentityKey(card), entry = required.get(key) || { ...card, quantity: 0 }; entry.quantity += Number(card.quantity || 0); required.set(key, entry); }
  let total = 0, covered = 0, requestable = 0; const rows = [], perCard = new Map();
  for (const card of required.values()) {
    const ownedMine = mine.filter(item => sameDeckCardIdentity(card, item)).reduce((sum, item) => sum + Number(item.quantityAvailable || 0), 0);
    const borrowed = borrowedForCard(card, loans, reference, deck?.game || card.game || 'yugioh');
    const owned = ownedMine + borrowed.quantity;
    const owners = new Map();
    for (const item of team) {
      if (item.ownerSlug === reference || Number(item.quantityAvailable || 0) <= 0 || !sameDeckCardIdentity(card, item)) continue;
      const entry = owners.get(item.ownerSlug) || { ownerSlug: item.ownerSlug, ownerName: item.ownerName, quantity: 0, items: [] };
      entry.quantity += Number(item.quantityAvailable || 0); entry.items.push(item); owners.set(item.ownerSlug, entry);
    }
    const missing = Math.max(0, card.quantity - owned), sortedOwners = [...owners.values()].sort((a, b) => b.quantity - a.quantity), best = sortedOwners[0] || null;
    total += card.quantity; covered += Math.min(card.quantity, owned);
    const entry = { ...card, owned, ownedMine, borrowed: borrowed.quantity, borrowedFrom: borrowed.sources, missing, best, owners: sortedOwners };
    perCard.set(deckCardIdentityKey(card), entry);
    if (missing) { if (best) requestable += 1; rows.push(entry); }
  }
  return { total, covered, percent: total ? Math.round(covered / total * 100) : 0, rows, requestable, perCard };
}
function borrowedForCard(card, loans, reference, game) {
  const bySource = new Map();
  for (const loan of loans || []) {
    if (loan.game !== game || loan.status !== 'active' || loan.borrower !== reference) continue;
    if (!sameDeckCardIdentity(card, { catalogCardId: loan.externalId, cardName: loan.cardName, game: loan.game })) continue;
    const remaining = Math.max(0, (loan.acceptedQuantity || loan.quantity || 0) - (loan.returnedQuantity || 0));
    if (!remaining) continue;
    const source = bySource.get(loan.owner) || { ownerSlug: loan.owner, ownerName: member(loan.owner)?.name || loan.owner, quantity: 0 };
    source.quantity += remaining;
    bySource.set(loan.owner, source);
  }
  const sources = [...bySource.values()];
  return { quantity: sources.reduce((sum, source) => sum + source.quantity, 0), sources };
}

function deckCardIdentityKey(card) { const game = card?.game || 'yugioh', id = canonicalCatalogCardId(card?.catalogCardId, game), name = normalizeDeckCardName(card?.cardName); return id ? `id:${game}:${id}` : `name:${game}:${name}`; }

// Reverse of deckAvailability: for a Raccolta card, which of the owner's own
// mazzi already use it. Keyed with the same identity as deckAvailability so
// a card matches a deck slot regardless of which printing is on file.
export function deckUsageIndex(decks, ownerSlug, game) {
  const index = new Map();
  for (const deck of decks || []) {
    if (deck.game !== game || (deck.ownerSlug || '') !== ownerSlug) continue;
    for (const card of deck.cards || []) {
      const key = deckCardIdentityKey({ ...card, game });
      const names = index.get(key) || new Set();
      names.add(deck.name);
      index.set(key, names);
    }
  }
  return index;
}
export function deckNamesForCollectionItem(index, item) {
  return [...(index?.get(deckCardIdentityKey(item)) || [])];
}
export function sameDeckCardIdentity(card, item) {
  const game = card?.game || item?.game || 'yugioh';
  const cardHasId = validCatalogCardId(card?.catalogCardId, game), itemHasId = validCatalogCardId(item?.catalogCardId, game);
  if (cardHasId && itemHasId) return canonicalCatalogCardId(card.catalogCardId, game) === canonicalCatalogCardId(item.catalogCardId, game);
  const cardName = normalizeDeckCardName(card?.cardName), itemName = normalizeDeckCardName(item?.cardName);
  return Boolean(cardName && itemName) && cardName === itemName;
}
function normalizeDeckCardName(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase(); }
export function parseDeckList(text) { let section = 'main'; const merged = new Map(); for (const raw of String(text).split(/\r?\n/)) { const line = raw.trim(); if (!line) continue; const marker = line.toLowerCase(); if (marker === '#main' || marker === 'main deck' || marker === 'main:') { section = 'main'; continue; } if (marker === '#extra' || marker === 'extra deck' || marker === 'extra:') { section = 'extra'; continue; } if (marker === '!side' || marker === '#side' || marker === 'side deck' || marker === 'side:') { section = 'side'; continue; } if (line.startsWith('#') || line.startsWith('!')) continue; const match = line.match(/^(?:(\d{1,2})\s*[x×]?\s+)?(.+)$/), quantity = Math.max(1, Number(match?.[1] || 1)), value = (match?.[2] || line).trim(), id = /^\d{5,10}$/.test(value) ? value : ''; const key = `${section}:${id || value.toLowerCase()}`, existing = merged.get(key); if (existing) existing.quantity += quantity; else merged.set(key, { section, quantity, id, name: id ? '' : value }); } return [...merged.values()]; }
function mapDeck(row) { return { id: String(row.id), persisted: true, dirty: false, ownerSlug: row.owner_slug || row.ownerSlug || '', name: row.name, format: row.format || 'TCG Avanzato', game: row.game, signatureCardId: row.signature_card_id || row.signatureCardId || null, deckTheme: row.deck_theme || row.deckTheme || DEFAULT_DECK_THEME, deckBoxTemplate: row.deck_box_template || row.deckBoxTemplate || DEFAULT_DECK_BOX_TEMPLATE, createdAt: row.created_at || row.createdAt || '', updatedAt: row.updated_at || row.updatedAt || '', cards: (row.cards || []).map(card => ({ catalogCardId: String(card.catalog_card_id || card.catalogCardId), cardName: card.card_name || card.cardName, imageUrl: card.image_url || card.imageUrl || '', croppedImageUrl: card.cropped_image_url || card.croppedImageUrl || '', banTcg: card.ban_tcg || card.banTcg || '', section: card.section || 'main', quantity: Number(card.quantity || 1), printingId: card.printing_id || card.printingId || null, printingSetCode: card.printing_set_code || card.printingSetCode || '', printingRarity: card.printing_rarity || card.printingRarity || '' })), cover: row.cover_image_url || row.coverImageUrl || '' }; }
function mapTeamDeck(row) { return { ...mapDeck(row), ownerName: row.owner_name || row.ownerName || 'Membro del team' }; }
function uniqueDeckCards(cards = []) { const seen = new Set(); return cards.filter(card => { const key = String(card.catalogCardId); if (seen.has(key)) return false; seen.add(key); return true; }); }
function readDrafts() { try { const value = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
export function isExtraDeckCard(card) { return /fusion|synchro|xyz|link/i.test(String(card?.type || '')); }
function sectionTotal(deck, section) { return deck.cards.filter(card => card.section === section).reduce((sum, card) => sum + card.quantity, 0); }
// Limite copie per singolo catalogCardId in una sezione: 1 per il Leader
// (slot unico), 4 per il Main One Piece, 99 (invariato) per tutto il resto.
function copyCap(deck, section) {
  if (deck?.game === 'onepiece') { if (section === 'leader') return 1; if (section === 'main') return 4; }
  return 99;
}
// Quanto puoi ancora aggiungere a `excludeItem` (riga esistente, o null per
// una riga nuova) prima di superare copyCap: il tetto è per carta logica
// (catalogCardId), non per singola riga printing — 2x regular + 2x parallel
// dello stesso catalogCardId contano 4, non 2+2 "carte diverse" (Fase 4.1).
function copyBudget(deck, section, catalogCardId, excludeItem) {
  const usedElsewhere = deck.cards
    .filter(card => card.section === section && card.catalogCardId === catalogCardId && card !== excludeItem)
    .reduce((sum, card) => sum + Number(card.quantity || 0), 0);
  return Math.max(0, copyCap(deck, section) - usedElsewhere);
}
const ONE_PIECE_COLOR_LABELS = { Red: 'Rosso', Blue: 'Blu', Green: 'Verde', Purple: 'Viola', Black: 'Nero', Yellow: 'Giallo' };
const ONE_PIECE_COLORS = Object.keys(ONE_PIECE_COLOR_LABELS);
function colorLabel(color) { return ONE_PIECE_COLOR_LABELS[color] || color; }
function coarseCardType(rawType) { const type = String(rawType || '').toLowerCase(); if (!type) return ''; if (type.includes('spell')) return 'spell'; if (type.includes('trap')) return 'trap'; return 'monster'; }
function readTypeCache() { try { const value = JSON.parse(localStorage.getItem(CARD_TYPE_CACHE_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
function writeTypeCache(map) { try { localStorage.setItem(CARD_TYPE_CACHE_KEY, JSON.stringify(map)); } catch {} }
function readCelebratedDecks() { try { const value = JSON.parse(localStorage.getItem(DECK_100_CELEBRATED_KEY) || '[]'); return new Set(Array.isArray(value) ? value : []); } catch { return new Set(); } }
function writeCelebratedDecks(set) { try { localStorage.setItem(DECK_100_CELEBRATED_KEY, JSON.stringify([...set])); } catch {} }
function restrictionBadge(status) { const badges = { limited: ['1', 'Limitata a 1 copia'], 'semi-limited': ['2', 'Semi-limitata a 2 copie'], forbidden: ['⊘', 'Proibita'] }, badge = badges[status]; return badge ? `<i class="deck-ban-badge ${status}" title="${badge[1]} nel formato TCG Advanced" aria-label="${badge[1]} nel formato TCG Advanced">${badge[0]}</i>` : ''; }
function ownershipLabel(info) {
  const parts = [];
  if (info.ownedMine > 0) parts.push(`${info.ownedMine} possedute`);
  if (info.borrowed > 0) {
    const names = (info.borrowedFrom || []).map(source => source.ownerName);
    parts.push(`${info.borrowed} in prestito${names.length === 1 ? ` da ${names[0]}` : names.length ? ` da ${names.length} membri` : ''}`);
  }
  return parts.join(' · ');
}
function missingRow(row, currentUser, { readonly = false, choice = null } = {}) {
  const owners = row.owners || (row.best ? [row.best] : []);
  const owner = owners.find(candidate => candidate.ownerSlug === choice?.ownerSlug) || row.best;
  const profile = owner ? member(owner.ownerSlug) : null, ownership = ownershipLabel(row);
  const picker = !readonly && owners.length > 1
    ? `<select class="missing-owner-select" data-deck-owner="${esc(row.catalogCardId)}" aria-label="Scegli da chi richiedere ${esc(row.cardName)}">${owners.map(candidate => `<option value="${esc(candidate.ownerSlug)}" ${candidate.ownerSlug === owner?.ownerSlug ? 'selected' : ''}>${esc(candidate.ownerName)} · ne ha ${candidate.quantity}</option>`).join('')}</select>`
    : owner ? `<em><i class="mini-avatar member-${esc(owner.ownerSlug)}">${initials(profile?.name || owner.ownerName || '?')}</i>${esc(owner.ownerName)} ne ha ${owner.quantity}</em>` : '<em>Nessuna copia disponibile nel team</em>';
  const preAgreed = !readonly && owner ? `<label class="missing-pre-agreed"><input type="checkbox" data-deck-pre-agreed="${esc(row.catalogCardId)}" ${choice?.preAgreed ? 'checked' : ''}> Ci siamo già accordati</label>` : '';
  return `<article class="missing-card"><div>${row.imageUrl ? `<img src="${esc(row.imageUrl)}" alt="">` : icon('card')}<span><strong>${esc(row.cardName)}</strong><small>Disponibili per il mazzo ${row.owned} di ${row.quantity} · mancano ${row.missing}${ownership ? ` (${esc(ownership)})` : ''}</small>${picker}${preAgreed}</span></div>${owner && !readonly ? `<button class="btn secondary small" data-deck-request="${esc(row.catalogCardId)}" ${owner.ownerSlug === currentUser ? 'disabled' : ''}>Richiedi</button>` : ''}</article>`;
}
