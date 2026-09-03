import { esc, initials, member } from './core.js';
import { icon } from './icons.js';
import { canonicalCatalogCardId, validCatalogCardId } from './cards.js';
import { DEFAULT_DECK_BOX_TEMPLATE, DEFAULT_DECK_THEME, DECK_BOX_TEMPLATES, deckThemeOptions, normalizeDeckBoxTemplate, preferredDeckArtwork, renderDeckBoxCard, renderDeckBoxVisual, resolveDeckSignature } from './deck-box.js';

const SECTIONS = ['main', 'extra', 'side'];
const LABELS = { main: 'Main Deck', extra: 'Extra Deck', side: 'Side Deck' };
const DRAFTS_KEY = 'fpt-cards-deck-drafts-v1';
const CARD_TYPE_CACHE_KEY = 'fpt-cards-type-index-v1';
const TYPE_FILTERS = [
  { value: 'all', label: 'Tutte' },
  { value: 'monster', label: 'Mostri' },
  { value: 'spell', label: 'Magie' },
  { value: 'trap', label: 'Trappole' }
];
const BAN_LABELS = { limited: 'Limitata a 1 copia', 'semi-limited': 'Semi-limitata a 2 copie', forbidden: 'Proibita' };

export class DeckController {
  constructor({ api, getState, searchCards, findCard, findCardById, tcgBanlistStatuses, isOnline, onRender, onToast, onLoansChanged } = {}) {
    Object.assign(this, { api, getState, searchCards, findCard, findCardById, tcgBanlistStatuses, isOnline, onRender, onToast, onLoansChanged });
    this.activeId = ''; this.previewId = ''; this.screen = 'gallery'; this.targetSection = 'main'; this.searchResults = []; this.searchTimer = 0; this.importOpen = false; this.coverPickerOpen = false; this.printingPicker = null; this.busy = false; this.error = ''; this.loadInFlight = null;
    this.scope = 'mine'; this.teamDecksAll = []; this.teamDetailId = ''; this.teamLoadInFlight = null; this.teamError = '';
    this.activeSection = 'main'; this.cardTypeFilter = 'all'; this.selectedCard = null; this.missingPanelOpen = false; this.moreMenuOpen = false;
    this.cardTypes = readTypeCache(); this.typeResolveInFlight = new Set();
  }
  get state() { return this.getState(); }
  get decks() { return (this.state.decks || []).filter(deck => deck.game === this.state.game); }
  get teamDecks() { return (this.teamDecksAll || []).filter(deck => deck.game === this.state.game); }
  active() { return this.decks.find(deck => deck.id === this.activeId) || this.decks[0] || null; }
  activeTeamDeck() { return this.teamDecks.find(deck => deck.id === this.teamDetailId) || null; }
  async load() { if (this.loadInFlight) return this.loadInFlight; const request = (async () => { let remote = [], failure = null; try { remote = (await this.api.decks() || []).map(mapDeck); } catch (error) { failure = error; remote = this.state.decks || []; } const local = readDrafts().filter(deck => deck.ownerSlug === this.state.currentUser), merged = new Map(remote.map(deck => [deck.id, deck])); for (const draft of local) if (draft.dirty || !draft.persisted) merged.set(draft.id, draft); this.state.decks = [...merged.values()]; await this.refreshTcgBanlist(); if (!this.decks.some(deck => deck.id === this.activeId)) this.activeId = this.decks[0]?.id || ''; if (!this.decks.some(deck => deck.id === this.previewId)) this.previewId = this.activeId; if (failure) throw failure; return this.state.decks; })(); this.loadInFlight = request; try { return await request; } finally { if (this.loadInFlight === request) this.loadInFlight = null; } }
  async loadTeam() { if (this.teamLoadInFlight) return this.teamLoadInFlight; const request = (async () => { try { this.teamDecksAll = (await this.api.teamDecks() || []).map(mapTeamDeck); this.teamError = ''; } catch (error) { this.teamError = error.message || 'Mazzi del team non disponibili'; } return this.teamDecksAll; })(); this.teamLoadInFlight = request; try { return await request; } finally { if (this.teamLoadInFlight === request) this.teamLoadInFlight = null; } }
  async refreshTcgBanlist() { if (!this.tcgBanlistStatuses || !(this.state.decks || []).some(deck => deck.game === 'yugioh')) return; const statuses = await this.tcgBanlistStatuses(); if (!statuses) return; for (const deck of this.state.decks || []) { if (deck.game !== 'yugioh') continue; for (const card of deck.cards || []) card.banTcg = statuses[String(card.catalogCardId)] || ''; } }
  view() { const deck = this.active(), detail = this.screen === 'detail' && deck, teamDeck = this.screen === 'team-detail' ? this.activeTeamDeck() : null; return `<section class="page-stack deck-page ${detail || teamDeck ? 'is-editor' : 'is-gallery'}">${this.error ? `<div class="connection-banner error">${esc(this.error)}</div>` : ''}${teamDeck ? this.teamDetailView(teamDeck) : detail ? this.detailView(deck) : this.galleryView()}${this.importOpen ? this.importView() : ''}${this.coverPickerOpen && deck ? this.coverPickerView(deck) : ''}${this.printingPicker ? this.printingPickerView() : ''}</section>`; }
  galleryView() {
    const scope = this.scope, mineCount = this.decks.length, teamCount = this.teamDecks.length;
    const tabs = `<div class="tabs" role="tablist" aria-label="Ambito mazzi"><button type="button" data-deck-scope="mine" class="${scope === 'mine' ? 'active' : ''}" role="tab" aria-selected="${scope === 'mine'}">I miei mazzi <span>${mineCount}</span></button><button type="button" data-deck-scope="team" class="${scope === 'team' ? 'active' : ''}" role="tab" aria-selected="${scope === 'team'}">Mazzi del team <span>${teamCount}</span></button></div>`;
    if (scope === 'team') {
      const decks = this.teamDecks;
      return `<header class="deck-hero deck-gallery-hero"><div><span class="eyebrow">Mazzi</span><h1>Mazzi del team</h1><p>Sfoglia i mazzi degli altri membri, in sola lettura.</p></div></header>${tabs}${this.teamError ? `<div class="connection-banner error">${esc(this.teamError)}</div>` : ''}${decks.length ? `<div class="deck-box-grid" aria-label="Mazzi del team">${decks.map(deck => renderDeckBoxCard(deck, { mode:'team', ownerName:deck.ownerName, availability: deckAvailability(deck, this.state.collection, this.state.currentUser, { ownerSlug:deck.ownerSlug }).percent })).join('')}</div>` : `<section class="surface deck-empty">${icon('team')}<h2>Nessun mazzo condiviso</h2><p>I mazzi salvati dagli altri membri del team appariranno qui.</p></section>`}`;
    }
    const decks = this.decks, preview = decks.find(deck => deck.id === this.previewId) || decks[0] || null;
    return `<header class="deck-hero deck-gallery-hero"><div><span class="eyebrow">Mazzi</span><h1>Scegli il tuo mazzo</h1><p>Apri o gestisci uno dei tuoi mazzi esistenti oppure creane uno nuovo.</p></div><div class="deck-hero-actions"><button class="btn" data-deck-new>${icon('plus')} Nuovo mazzo</button><button class="btn secondary" data-deck-import-new>${icon('logout')} Importa lista / YDK</button></div></header>${tabs}${decks.length ? `<div class="deck-gallery-layout"><div class="deck-box-grid" aria-label="I tuoi mazzi">${decks.map(deck => this.galleryCard(deck, deck.id === preview?.id)).join('')}</div>${preview ? this.galleryPreview(preview) : ''}</div>` : this.emptyView()}`;
  }
  galleryCard(deck, selected = false) { const report = deckAvailability(deck, this.state.collection, this.state.currentUser); return renderDeckBoxCard(deck, { availability: report.percent, selected }); }
  galleryPreview(deck) { const report = deckAvailability(deck, this.state.collection, this.state.currentUser), total = deck.cards.reduce((sum, item) => sum + item.quantity, 0); return `<aside class="deck-gallery-preview surface" aria-label="Anteprima ${esc(deck.name)}"><span class="eyebrow">Mazzo selezionato</span>${renderDeckBoxVisual(deck)}<h2>${esc(deck.name)}</h2><p>${deck.dirty ? 'Bozza salvata sul dispositivo' : `Formato: ${esc(deck.format || 'TCG Avanzato')}`}</p><div class="deck-preview-counts"><span><small>Totale</small><b>${total}</b></span><span><small>Main</small><b>${sectionTotal(deck, 'main')}</b></span><span><small>Extra</small><b>${sectionTotal(deck, 'extra')}</b></span><span><small>Side</small><b>${sectionTotal(deck, 'side')}</b></span></div><div class="deck-preview-ready"><span><small>Disponibilità personale</small><strong>${report.percent}%</strong></span><i style="--ready:${report.percent}"></i></div><button class="btn wide" data-deck-open="${esc(deck.id)}">Apri mazzo ${icon('arrow')}</button></aside>`; }
  teamDetailView(deck) {
    const report = deckAvailability(deck, this.state.collection, this.state.currentUser, { ownerSlug:deck.ownerSlug }), total = deck.cards.reduce((sum, item) => sum + item.quantity, 0), signature = resolveDeckSignature(deck), artwork = preferredDeckArtwork(signature);
    return `<header class="deck-detail-heading"><button class="deck-back-button" data-deck-gallery aria-label="Torna alla scelta dei mazzi">← <span>Tutti i mazzi</span></button><div><span class="eyebrow">Mazzo di ${esc(deck.ownerName)}</span><h1>${esc(deck.name)}</h1><p>Sola lettura · le modifiche restano riservate al proprietario.</p></div></header>
    <div class="deck-workspace"><div class="deck-main"><section class="surface deck-titlebar"><div>${artwork ? `<img src="${esc(artwork)}" alt="Cover ${esc(deck.name)}">` : icon('deck')}<span><strong>${esc(deck.name)}</strong><small>Formato: ${esc(deck.format || 'TCG Avanzato')} · Proprietario: ${esc(deck.ownerName)}</small></span></div></section>
      <section class="surface deck-summary"><div><small>Totale carte</small><strong>${total}</strong></div>${SECTIONS.map(section => `<div><small>${LABELS[section]}</small><strong>${sectionTotal(deck, section)}</strong></div>`).join('')}<div class="deck-ready"><small>Disponibilità di ${esc(deck.ownerName)}</small><strong>${report.percent}%</strong><i style="--ready:${report.percent}"></i></div></section>
      <section class="deck-builder surface"><div class="deck-all-sections">${SECTIONS.map(section => this.readonlyCardGrid(deck, section)).join('')}</div></section>
    </div><aside class="deck-availability"><section class="surface availability-head"><span>${icon('collection')}</span><div><small>Disponibilità</small><strong>${report.percent}% pronto</strong></div><i style="--ready:${report.percent}"></i></section><section class="surface"><div class="section-heading"><div><h2>Carte mancanti o parziali</h2><p>Solo ${esc(deck.ownerName)} può inviare una richiesta per queste carte.</p></div></div><div class="missing-card-list">${report.rows.length ? report.rows.map(row => missingRow(row, deck.ownerSlug, { readonly:true })).join('') : '<div class="deck-all-ready">✓ Tutte le carte sono disponibili per il proprietario.</div>'}</div></section></aside></div>`;
  }
  readonlyCardGrid(deck, section) { const cards = deck.cards.filter(item => item.section === section); return `<section class="deck-zone ${section}"><header><strong>${LABELS[section]}</strong><span>${sectionTotal(deck, section)}</span></header>${cards.length ? `<div class="deck-card-grid">${cards.map(item => `<article><div class="deck-card-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.cardName)}" loading="lazy">` : icon('card')}${restrictionBadge(item.banTcg)}<b>${item.quantity}</b></div><strong>${esc(item.cardName)}</strong><small>${esc(item.catalogCardId)}</small></article>`).join('')}</div>` : `<div class="deck-section-empty">${icon('card')}<span>Nessuna carta</span></div>`}</section>`; }
  detailView(deck) { return this.editor(deck); }
  emptyView() { return `<section class="surface deck-empty">${icon('deck')}<h2>Il tuo primo mazzo parte da qui</h2><p>Aggiungi le carte dal catalogo oppure importa un file .ydk o una lista testuale.</p><button class="btn" data-deck-new>${icon('plus')} Crea mazzo</button></section>`; }
  editor(deck) {
    const report = deckAvailability(deck, this.state.collection, this.state.currentUser), total = deck.cards.reduce((sum, item) => sum + item.quantity, 0);
    const sheetCard = this.selectedCard ? deck.cards.find(item => item.catalogCardId === this.selectedCard.catalogCardId && item.section === this.selectedCard.section) : null;
    if (this.selectedCard && !sheetCard) this.selectedCard = null;
    return `<div class="deck-mobile">
      ${this.editorHeader(deck, total, report)}
      <div class="deck-mh-search"><label>${icon('search')}<input data-deck-search autocomplete="off" placeholder="Cerca una carta da aggiungere…"></label><div data-deck-search-results class="deck-search-results"></div></div>
      <div class="deck-mh-tabs" role="tablist" aria-label="Sezioni mazzo">${SECTIONS.map(section => `<button type="button" data-deck-section="${section}" class="${this.activeSection === section ? 'active' : ''}" role="tab" aria-selected="${this.activeSection === section}">${LABELS[section].replace(' Deck', '')} <i>${sectionTotal(deck, section)}</i></button>`).join('')}</div>
      ${deck.game === 'yugioh' ? `<div class="deck-mh-filters" role="group" aria-label="Filtra per tipo">${TYPE_FILTERS.map(f => `<button type="button" class="chip ${this.cardTypeFilter === f.value ? 'active' : ''}" data-deck-type-filter="${f.value}">${f.label}</button>`).join('')}</div>` : ''}
      ${this.sectionGrid(deck)}
      ${sheetCard ? this.cardSheet(sheetCard, report) : this.availabilityPeek(report)}
      ${this.moreMenuOpen ? this.moreMenu(deck) : ''}
      ${this.missingPanelOpen ? this.missingOverlay(report) : ''}
    </div>`;
  }
  editorHeader(deck, total, report) {
    return `<header class="deck-mh-head">
      <button type="button" class="deck-mh-icon" data-deck-gallery aria-label="Torna alla scelta dei mazzi">${icon('arrow')}</button>
      <span class="deck-mh-title"><small>Editor mazzo</small><input data-deck-name value="${esc(deck.name)}" maxlength="80" aria-label="Nome mazzo"></span>
      <button type="button" class="btn secondary small" data-deck-save ${this.busy ? 'disabled' : ''}>${this.busy ? 'Salvataggio…' : 'Salva'}</button>
      <button type="button" class="deck-mh-icon" data-deck-more aria-label="Altre azioni" aria-expanded="${this.moreMenuOpen}">${icon('more')}</button>
    </header>
    <div class="deck-mh-stats">
      <div class="c-total"><small>Totale</small><b>${total}</b></div>
      <div class="c-main"><small>Main</small><b>${sectionTotal(deck, 'main')}</b></div>
      <div class="c-extra"><small>Extra</small><b>${sectionTotal(deck, 'extra')}</b></div>
      <div class="c-side"><small>Side</small><b>${sectionTotal(deck, 'side')}</b></div>
      <div class="c-ready"><small>Pronto</small><b>${report.percent}%</b></div>
    </div>`;
  }
  sectionGrid(deck) {
    const cards = deck.cards.filter(item => item.section === this.activeSection && this.matchesTypeFilter(item));
    if (!cards.length) return `<div class="deck-section-empty">${icon('card')}<span>Nessuna carta${this.cardTypeFilter !== 'all' ? ' per questo filtro' : ' in questa sezione'}</span></div>`;
    return `<div class="deck-mobile-grid">${cards.map(item => this.cardTile(item)).join('')}</div>`;
  }
  matchesTypeFilter(item) { return this.cardTypeFilter === 'all' || this.cardTypes[item.catalogCardId] === this.cardTypeFilter; }
  cardTile(item) {
    const selected = this.selectedCard && this.selectedCard.catalogCardId === item.catalogCardId && this.selectedCard.section === item.section;
    return `<button type="button" class="deck-tile ${selected ? 'selected' : ''}" data-deck-card-select="${esc(item.catalogCardId)}" data-deck-card-select-section="${item.section}" aria-label="${esc(item.cardName)}, quantità ${item.quantity}"><span class="deck-tile-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" loading="lazy">` : icon('card')}${restrictionBadge(item.banTcg)}<b>${item.quantity}</b></span></button>`;
  }
  cardSheet(item, report) {
    const otherSections = SECTIONS.filter(section => section !== item.section);
    return `<div class="deck-sheet" role="dialog" aria-label="Dettaglio carta ${esc(item.cardName)}">
      <button type="button" class="deck-sheet-close" data-deck-sheet-close aria-label="Chiudi dettaglio">${icon('arrow')}</button>
      <div class="deck-sheet-body">
        <span class="deck-sheet-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="">` : icon('card')}</span>
        <span class="deck-sheet-copy"><strong>${esc(item.cardName)}</strong><small>${LABELS[item.section]}${item.printingSetCode ? ` · ${esc(item.printingSetCode)}` : ''}</small>${item.banTcg ? `<i class="deck-sheet-badge ${item.banTcg}">${esc(BAN_LABELS[item.banTcg] || '')}</i>` : ''}</span>
      </div>
      <div class="deck-sheet-stepper"><button type="button" data-deck-sheet-qty="minus" aria-label="Rimuovi una copia">−</button><span>${item.quantity}</span><button type="button" data-deck-sheet-qty="plus" aria-label="Aggiungi una copia">+</button></div>
      <div class="deck-sheet-actions">${otherSections.map(section => `<button type="button" data-deck-sheet-move="${section}">${icon('swap')} In ${LABELS[section].replace(' Deck', '')}</button>`).join('')}<button type="button" class="danger" data-deck-sheet-remove>${icon('trash')} Rimuovi</button></div>
      ${this.availabilityFoot(report)}
    </div>`;
  }
  availabilityFoot(report) { return `<button type="button" class="deck-sheet-foot" data-deck-missing-open><span class="deck-sheet-dot ${report.percent === 100 ? 'ok' : 'warn'}"></span><b>${report.percent}% pronto per il team</b><small>${report.rows.length} ${report.rows.length === 1 ? 'mancante' : 'mancanti'}</small></button>`; }
  availabilityPeek(report) { return `<button type="button" class="deck-peek" data-deck-missing-open aria-label="Apri carte mancanti"><span class="deck-peek-ring" style="--ready:${report.percent}"><i>${report.percent}%</i></span><span class="deck-peek-copy"><b>${report.percent}% pronto per il team</b><small>${report.rows.length} carte mancanti o parziali</small></span><span class="deck-peek-chev">${icon('arrow')}</span></button>`; }
  moreMenu(deck) {
    const signature = resolveDeckSignature(deck), artwork = preferredDeckArtwork(signature);
    return `<div class="detail-backdrop" data-deck-more-close><aside class="card-detail deck-more-menu" role="dialog" aria-modal="true" aria-label="Altre azioni sul mazzo">
      <button class="detail-close" data-deck-more-close aria-label="Chiudi">×</button>
      <span class="eyebrow">Mazzo</span><h2>${esc(deck.name)}</h2>
      <div class="deck-more-box"><span class="deck-more-box-art">${artwork ? `<img src="${esc(artwork)}" alt="">` : icon('deck')}</span><div><strong>Deck Box</strong><small>${DECK_BOX_TEMPLATES[normalizeDeckBoxTemplate(deck.deckBoxTemplate)].label} · ${signature ? `Signature: ${esc(signature.cardName)}` : 'cover F.P.T generica'}</small><label>Tema Deck Box<select data-deck-theme>${deckThemeOptions(deck.deckTheme)}</select></label></div></div>
      <div class="deck-more-actions">
        <button type="button" class="btn secondary" data-deck-cover-open>${icon('deck')} Personalizza Deck Box</button>
        <button type="button" class="btn secondary" data-deck-new>${icon('plus')} Nuovo mazzo</button>
        <button type="button" class="btn secondary" data-deck-import>${icon('logout')} Importa lista / YDK</button>
        <button type="button" class="btn secondary danger" data-deck-delete ${deck.persisted ? '' : 'disabled'}>${icon('trash')} Elimina mazzo</button>
      </div>
    </aside></div>`;
  }
  missingOverlay(report) {
    return `<div class="detail-backdrop" data-deck-missing-close><aside class="card-detail deck-missing-panel" role="dialog" aria-modal="true" aria-label="Carte mancanti">
      <button class="detail-close" data-deck-missing-close aria-label="Chiudi">×</button>
      <span class="eyebrow">Disponibilità</span><h2>${report.percent}% pronto per il team</h2>
      <div class="missing-card-list">${report.rows.length ? report.rows.map(row => missingRow(row, this.state.currentUser)).join('') : '<div class="deck-all-ready">✓ Tutte le carte sono disponibili nella tua raccolta.</div>'}</div>
      ${report.requestable ? `<button type="button" class="btn wide" data-deck-request-all ${this.busy || !this.isOnline() ? 'disabled' : ''}>${icon('swap')} Richiedi tutte le carte mancanti</button>` : ''}
    </aside></div>`;
  }
  importView() { return `<div class="detail-backdrop" data-deck-import-close><aside class="card-detail deck-import" role="dialog" aria-modal="true"><button class="detail-close" data-deck-import-close aria-label="Chiudi">×</button><span class="eyebrow">Importazione</span><h2>Carica un mazzo</h2><p>Supporta file .ydk, passcode Yu-Gi-Oh! e liste del tipo “3 Nome carta”.</p><label>File YDK o testo<input type="file" data-deck-file accept=".ydk,.txt,text/plain"></label><label>Oppure incolla la lista<textarea data-deck-import-text rows="12" placeholder="#main&#10;46986414&#10;46986414&#10;#extra&#10;..."></textarea></label><button class="btn wide" data-deck-import-run ${this.busy ? 'disabled' : ''}>${this.busy ? 'Importazione…' : 'Importa nel mazzo'}</button></aside></div>`; }
  coverPickerView(deck) { const cards = uniqueDeckCards(deck.cards), template = normalizeDeckBoxTemplate(deck.deckBoxTemplate); return `<div class="detail-backdrop" data-deck-cover-close><aside class="card-detail deck-cover-picker" role="dialog" aria-modal="true" aria-labelledby="deck-cover-title"><button class="detail-close" data-deck-cover-close aria-label="Chiudi">×</button><span class="eyebrow">Deck Box</span><h2 id="deck-cover-title">Personalizza la Deck Box</h2><p>Scegli uno dei tre modelli F.P.T oppure mantieni la versione dinamica con la carta signature.</p><h3>Modello Deck Box</h3><div class="deck-template-options">${Object.entries(DECK_BOX_TEMPLATES).map(([value, option]) => `<button data-deck-box-template="${value}" class="${template === value ? 'active' : ''}">${option.image ? `<img src="${esc(option.image)}" alt="${esc(option.label)}" loading="lazy">` : `<span>${icon('deck')}</span>`}<strong>${esc(option.label)}</strong>${template === value ? '<b>Selezionato</b>' : ''}</button>`).join('')}</div><div class="deck-signature-heading"><h3>Carta signature</h3><p>Usata dal modello dinamico. Deve essere già presente nel mazzo.</p></div>${cards.length ? `<div class="deck-cover-options">${cards.map(card => `<button data-deck-cover-card="${esc(card.catalogCardId)}" class="${String(deck.signatureCardId || '') === String(card.catalogCardId) ? 'active' : ''}">${card.imageUrl ? `<img src="${esc(card.imageUrl)}" alt="${esc(card.cardName)}" loading="lazy">` : icon('card')}<span><strong>${esc(card.cardName)}</strong><small>${LABELS[card.section] || card.section}</small></span>${String(deck.signatureCardId || '') === String(card.catalogCardId) ? '<b>Signature</b>' : icon('arrow')}</button>`).join('')}</div>` : '<div class="deck-signature-empty">Aggiungi almeno una carta al mazzo per scegliere la signature.</div>'}<button class="btn secondary wide deck-cover-back" data-deck-cover-close>Torna al mazzo</button></aside></div>`; }
  printingPickerView() { const picker = this.printingPicker; return `<div class="detail-backdrop" data-deck-printing-close><aside class="card-detail deck-printing-picker" role="dialog" aria-modal="true"><button class="detail-close" data-deck-printing-close aria-label="Chiudi">×</button><span class="eyebrow">Market Watch</span><h2>Seleziona la printing</h2><p>${esc(picker.cardName)} · nessuna scelta viene effettuata automaticamente.</p>${picker.loading ? '<div class="deck-printing-loading"><span class="loading-spinner"></span> Caricamento printing…</div>' : picker.error ? `<div class="connection-banner error">${esc(picker.error)}</div>` : picker.options.length ? `<div class="deck-printing-options">${picker.options.map(option => `<button data-deck-printing-option="${esc(option.printingId)}">${option.imageUrl ? `<img src="${esc(option.imageUrl)}" alt="">` : icon('card')}<span><strong>${esc(option.setCode || 'Set non indicato')}</strong><small>${esc(option.setName || 'Espansione non indicata')} · ${esc(option.rarity || 'Rarità non indicata')}</small></span>${icon('arrow')}</button>`).join('')}</div>` : '<div class="empty-state compact"><h3>Nessuna printing disponibile</h3><p>Aggiungi prima una copia precisa alla Raccolta.</p></div>'}</aside></div>`; }
  bind(root = document) {
    root.querySelectorAll('[data-deck-new]').forEach(button => button.addEventListener('click', () => this.create()));
    root.querySelector('[data-deck-gallery]')?.addEventListener('click', () => this.showGallery());
    root.querySelectorAll('[data-deck-scope]').forEach(button => button.addEventListener('click', () => { this.scope = button.dataset.deckScope; if (this.scope === 'team' && !this.teamDecksAll.length && !this.teamLoadInFlight) void this.loadTeam().then(() => this.onRender()); this.onRender(); }));
    root.querySelectorAll('[data-deck-open-team]').forEach(button => button.addEventListener('click', () => this.openTeam(button.dataset.deckOpenTeam)));
    root.querySelector('[data-deck-save]')?.addEventListener('click', () => void this.save()); root.querySelector('[data-deck-delete]')?.addEventListener('click', () => void this.remove());
    root.querySelector('[data-deck-name]')?.addEventListener('input', event => { const deck = this.active(); if (deck) { deck.name = event.target.value; this.markDirty(deck); } });
    root.querySelector('[data-deck-theme]')?.addEventListener('change', event => { const deck = this.active(); if (!deck) return; deck.deckTheme = event.target.value; this.markDirty(deck); this.onRender(); });
    root.querySelector('[data-deck-cover-open]')?.addEventListener('click', () => { this.coverPickerOpen = true; this.moreMenuOpen = false; this.onRender(); });
    root.querySelectorAll('[data-deck-cover-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.coverPickerOpen = false; this.onRender(); }));
    root.querySelectorAll('[data-deck-cover-card]').forEach(button => button.addEventListener('click', () => this.chooseCover(button.dataset.deckCoverCard)));
    root.querySelectorAll('[data-deck-box-template]').forEach(button => button.addEventListener('click', () => this.chooseDeckBoxTemplate(button.dataset.deckBoxTemplate)));
    root.querySelectorAll('[data-deck-open]').forEach(button => button.addEventListener('click', () => this.open(button.dataset.deckOpen)));
    root.querySelector('[data-deck-search]')?.addEventListener('input', event => this.search(event.target.value));
    root.querySelectorAll('[data-deck-printing]').forEach(button => button.addEventListener('click', () => void this.openPrintingPicker(button.dataset.deckPrinting, button.dataset.deckPrintingSection)));
    root.querySelectorAll('[data-deck-printing-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.printingPicker = null; this.onRender(); }));
    root.querySelectorAll('[data-deck-printing-option]').forEach(button => button.addEventListener('click', () => void this.choosePrinting(button.dataset.deckPrintingOption)));
    root.querySelectorAll('[data-deck-request]').forEach(button => button.addEventListener('click', () => void this.request(button.dataset.deckRequest)));
    root.querySelector('[data-deck-request-all]')?.addEventListener('click', () => void this.requestAll());
    root.querySelectorAll('[data-deck-import]').forEach(button => button.addEventListener('click', () => { if (!this.active()) this.create(false); this.importOpen = true; this.moreMenuOpen = false; this.onRender(); }));
    root.querySelector('[data-deck-import-new]')?.addEventListener('click', () => { this.create(false); this.importOpen = true; this.onRender(); });
    root.querySelectorAll('[data-deck-import-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.importOpen = false; this.onRender(); }));
    root.querySelector('[data-deck-file]')?.addEventListener('change', async event => { const text = await event.target.files?.[0]?.text(); const field = root.querySelector('[data-deck-import-text]'); if (field && text != null) field.value = text; });
    root.querySelector('[data-deck-import-run]')?.addEventListener('click', () => void this.importText(root.querySelector('[data-deck-import-text]')?.value || ''));
    root.querySelectorAll('[data-deck-section]').forEach(button => button.addEventListener('click', () => this.setSection(button.dataset.deckSection)));
    root.querySelectorAll('[data-deck-type-filter]').forEach(button => button.addEventListener('click', () => this.setTypeFilter(button.dataset.deckTypeFilter)));
    root.querySelectorAll('[data-deck-card-select]').forEach(button => button.addEventListener('click', () => this.selectCard(button.dataset.deckCardSelect, button.dataset.deckCardSelectSection)));
    root.querySelector('[data-deck-sheet-close]')?.addEventListener('click', () => this.closeSheet());
    root.querySelectorAll('[data-deck-sheet-qty]').forEach(button => button.addEventListener('click', () => this.sheetQuantity(button.dataset.deckSheetQty === 'plus' ? 1 : -1)));
    root.querySelectorAll('[data-deck-sheet-move]').forEach(button => button.addEventListener('click', () => this.moveSelectedCard(button.dataset.deckSheetMove)));
    root.querySelector('[data-deck-sheet-remove]')?.addEventListener('click', () => this.removeSelectedCard());
    root.querySelectorAll('[data-deck-missing-open]').forEach(button => button.addEventListener('click', () => this.toggleMissingPanel(true)));
    root.querySelectorAll('[data-deck-missing-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.toggleMissingPanel(false); }));
    root.querySelector('[data-deck-more]')?.addEventListener('click', () => this.toggleMoreMenu());
    root.querySelectorAll('[data-deck-more-close]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; this.moreMenuOpen = false; this.onRender(); }));
  }
  open(id) { if (!this.decks.some(deck => deck.id === id)) return; this.activeId = id; this.previewId = id; this.screen = 'detail'; this.resetEditorView(); void this.resolveCardTypes(this.active()); this.onRender(); }
  openTeam(id) { if (!this.teamDecks.some(deck => deck.id === id)) return; this.teamDetailId = id; this.screen = 'team-detail'; this.onRender(); }
  showGallery(render = true) { this.screen = 'gallery'; this.teamDetailId = ''; this.importOpen = false; this.coverPickerOpen = false; this.printingPicker = null; if (render) this.onRender(); }
  create(render = true) { const deck = { id: `draft-${Date.now()}`, persisted: false, dirty: true, ownerSlug: this.state.currentUser, name: 'Nuovo mazzo', format: 'TCG Avanzato', game: this.state.game, cards: [], cover: '', signatureCardId: null, deckTheme: DEFAULT_DECK_THEME, deckBoxTemplate: DEFAULT_DECK_BOX_TEMPLATE }; this.state.decks = [deck, ...(this.state.decks || [])]; this.activeId = deck.id; this.previewId = deck.id; this.screen = 'detail'; this.resetEditorView(); this.persistDrafts(); if (render) this.onRender(); }
  resetEditorView() { this.activeSection = 'main'; this.targetSection = 'main'; this.cardTypeFilter = 'all'; this.selectedCard = null; this.missingPanelOpen = false; this.moreMenuOpen = false; }
  setSection(section) { if (!SECTIONS.includes(section)) return; this.activeSection = section; this.targetSection = section; this.selectedCard = null; this.onRender(); }
  setTypeFilter(value) { if (!TYPE_FILTERS.some(f => f.value === value)) return; this.cardTypeFilter = value; this.onRender(); }
  selectCard(catalogCardId, section) { const deck = this.active(); if (!deck?.cards.some(item => item.catalogCardId === catalogCardId && item.section === section)) return; this.selectedCard = { catalogCardId, section }; this.missingPanelOpen = false; this.onRender(); }
  closeSheet() { this.selectedCard = null; this.onRender(); }
  sheetQuantity(delta) { const sel = this.selectedCard; if (!sel) return; this.quantity(sel.catalogCardId, sel.section, delta); if (!this.active()?.cards.some(card => card.catalogCardId === sel.catalogCardId && card.section === sel.section)) this.selectedCard = null; this.onRender(); }
  moveSelectedCard(toSection) {
    const deck = this.active(), sel = this.selectedCard;
    if (!deck || !sel || !SECTIONS.includes(toSection) || toSection === sel.section) return;
    const item = deck.cards.find(card => card.catalogCardId === sel.catalogCardId && card.section === sel.section);
    if (!item) return;
    const destination = deck.cards.find(card => card.catalogCardId === sel.catalogCardId && card.section === toSection);
    if (destination) { destination.quantity = Math.min(99, destination.quantity + item.quantity); deck.cards = deck.cards.filter(card => card !== item); }
    else item.section = toSection;
    this.selectedCard = { catalogCardId: sel.catalogCardId, section: toSection };
    this.activeSection = toSection;
    this.markDirty(deck); this.onRender();
  }
  removeSelectedCard() {
    const deck = this.active(), sel = this.selectedCard;
    if (!deck || !sel) return;
    deck.cards = deck.cards.filter(card => !(card.catalogCardId === sel.catalogCardId && card.section === sel.section));
    if (String(deck.signatureCardId || '') === String(sel.catalogCardId) && !deck.cards.some(card => String(card.catalogCardId) === String(sel.catalogCardId))) deck.signatureCardId = null;
    this.selectedCard = null;
    this.markDirty(deck); this.onRender();
  }
  toggleMissingPanel(open) { this.missingPanelOpen = open; if (open) this.selectedCard = null; this.onRender(); }
  toggleMoreMenu() { this.moreMenuOpen = !this.moreMenuOpen; this.onRender(); }
  async resolveCardTypes(deck) {
    if (!deck || deck.game !== 'yugioh') return;
    const ids = [...new Set(deck.cards.map(card => card.catalogCardId))].filter(id => !(id in this.cardTypes) && !this.typeResolveInFlight.has(id));
    if (!ids.length) return;
    ids.forEach(id => this.typeResolveInFlight.add(id));
    let changed = false;
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try { const card = await this.findCardById(id, '', deck.game); this.cardTypes[id] = card ? coarseCardType(card.type) : ''; changed = true; }
        catch { this.cardTypes[id] = this.cardTypes[id] || ''; }
        finally { this.typeResolveInFlight.delete(id); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
    if (changed) { writeTypeCache(this.cardTypes); this.onRender(); }
  }
  search(query) { clearTimeout(this.searchTimer); const box = document.querySelector('[data-deck-search-results]'); if (!box) return; if (query.trim().length < 3) { box.innerHTML = ''; return; } box.innerHTML = '<span>Ricerca…</span>'; this.searchTimer = setTimeout(async () => { const results = await this.searchCards(query, this.state.game); this.searchResults = results; const current = document.querySelector('[data-deck-search-results]'); if (!current) return; current.innerHTML = results.map((card, index) => `<button data-deck-result="${index}">${card.image ? `<img src="${esc(card.image)}" alt="">` : ''}<span><strong>${esc(card.name)}</strong><small>${esc(card.type || 'Carta')}</small></span>${icon('plus')}</button>`).join('') || '<span>Nessuna carta trovata</span>'; current.querySelectorAll('[data-deck-result]').forEach(button => button.addEventListener('click', () => this.add(this.searchResults[Number(button.dataset.deckResult)]))); }, 260); }
  add(card, section = this.targetSection, quantity = 1) { const deck = this.active(); if (!deck || !card) return; const destination = section === 'main' && isExtraDeckCard(card) ? 'extra' : section, id = String(card.id), existing = deck.cards.find(item => item.catalogCardId === id && item.section === destination); if (existing) { existing.quantity = Math.min(99, existing.quantity + quantity); existing.banTcg = card.banTcg || existing.banTcg || ''; } else deck.cards.push({ catalogCardId: id, cardName: card.name, imageUrl: card.fullImage || card.image || '', banTcg: card.banTcg || '', section: destination, quantity }); deck.cover = deck.cover || card.fullImage || card.image || ''; this.rememberCardType(id, card.type); this.searchResults = []; this.markDirty(deck); this.onRender(); }
  rememberCardType(id, rawType) { if (!rawType) return; const bucket = coarseCardType(rawType); if (this.cardTypes[id] === bucket) return; this.cardTypes[id] = bucket; writeTypeCache(this.cardTypes); }
  quantity(id, section, delta) { const deck = this.active(), item = deck?.cards.find(card => card.catalogCardId === id && card.section === section); if (!item) return; item.quantity += delta; if (item.quantity <= 0) { deck.cards = deck.cards.filter(card => card !== item); if (String(deck.signatureCardId || '') === String(id) && !deck.cards.some(card => String(card.catalogCardId) === String(id))) deck.signatureCardId = null; } this.markDirty(deck); this.onRender(); }
  chooseCover(catalogCardId) { const deck = this.active(); if (!deck?.cards.some(card => String(card.catalogCardId) === String(catalogCardId))) return this.onToast('La cover deve appartenere al mazzo'); deck.signatureCardId = String(catalogCardId); this.coverPickerOpen = false; this.markDirty(deck); this.onToast('Carta signature aggiornata'); this.onRender(); }
  chooseDeckBoxTemplate(value) { const deck = this.active(), template = normalizeDeckBoxTemplate(value), preset = DECK_BOX_TEMPLATES[template]; if (!deck) return; deck.deckBoxTemplate = template; if (preset.theme) deck.deckTheme = preset.theme; this.coverPickerOpen = false; this.markDirty(deck); this.onToast(`Deck Box: ${preset.label}`); this.onRender(); }
  async openPrintingPicker(catalogCardId, section) { const deck = this.active(), card = deck?.cards.find(item => item.catalogCardId === catalogCardId && item.section === section); if (!deck?.persisted) return this.onToast('Salva il mazzo prima di selezionare la printing'); this.printingPicker = { catalogCardId, section, cardName: card?.cardName || 'Carta', loading: true, error: '', options: [] }; this.onRender(); try { const rows = await this.api.deckPrintingOptions(deck.id, catalogCardId); if (!this.printingPicker) return; this.printingPicker.options = (rows || []).map(row => ({ printingId: row.printing_id || row.printingId, setCode: row.set_code || row.setCode || '', setName: row.set_name || row.setName || '', rarity: row.rarity || '', imageUrl: row.image_url || row.imageUrl || '' })); } catch (error) { if (this.printingPicker) this.printingPicker.error = error.message || 'Printing non disponibili'; } finally { if (this.printingPicker) this.printingPicker.loading = false; this.onRender(); } }
  async choosePrinting(printingId) { const picker = this.printingPicker, deck = this.active(); if (!picker || !deck) return; const option = picker.options.find(item => item.printingId === printingId); this.busy = true; try { await this.api.setDeckCardPrinting(deck.id, picker.catalogCardId, picker.section, printingId); const card = deck.cards.find(item => item.catalogCardId === picker.catalogCardId && item.section === picker.section); if (card) { card.printingId = printingId; card.printingSetCode = option?.setCode || ''; card.printingRarity = option?.rarity || ''; } this.printingPicker = null; this.onToast('Printing collegata al mazzo'); } catch (error) { this.onToast(error.message || 'Selezione non riuscita'); } finally { this.busy = false; this.onRender(); } }
  async save() { const deck = this.active(); if (!deck || !deck.name.trim() || !this.isOnline()) return this.onToast('Nome del mazzo o connessione non disponibili'); const oldId = deck.id; this.busy = true; this.onRender(); try { const result = await this.api.saveDeck(deck), id = String(result?.id || result || oldId); this.clearDraft(oldId); if (result?.deckBoxPersisted === false) { deck.id = id; deck.persisted = true; deck.dirty = true; this.persistDrafts(); await this.load(); this.onToast('Mazzo salvato · Deck Box locale fino alla migration'); } else { await this.load(); this.onToast('Mazzo salvato'); } this.activeId = id; this.previewId = id; } catch (error) { this.error = error.message || 'Salvataggio non riuscito'; } finally { this.busy = false; this.onRender(); } }
  async remove() { const deck = this.active(); if (!deck?.persisted || !confirm(`Eliminare “${deck.name}”?`)) return; this.moreMenuOpen = false; this.busy = true; try { await this.api.deleteDeck(deck.id); this.clearDraft(deck.id); await this.load(); this.activeId = this.decks[0]?.id || ''; this.previewId = this.activeId; this.screen = 'gallery'; this.onToast('Mazzo eliminato'); } catch (error) { this.onToast(error.message || 'Eliminazione non riuscita'); } finally { this.busy = false; this.onRender(); } }
  async importText(text) { if (!text.trim()) return this.onToast('Incolla una lista o seleziona un file'); this.busy = true; this.onRender(); try { const parsed = parseDeckList(text), resolved = new Map(); for (const item of parsed) { const key = item.id ? `id:${item.id}` : `name:${item.name.toLowerCase()}`; if (resolved.has(key)) continue; const card = item.id ? await this.findCardById(item.id, '', this.state.game) : await this.findCard(item.name, this.state.game); if (card) resolved.set(key, card); } for (const item of parsed) { const card = resolved.get(item.id ? `id:${item.id}` : `name:${item.name.toLowerCase()}`); if (card) this.addSilent(card, item.section, item.quantity); } if (!resolved.size) throw new Error('Nessuna carta valida trovata nella lista'); this.importOpen = false; this.onToast(`${resolved.size} carte importate`); } catch (error) { this.onToast(error.message || 'Importazione non riuscita'); } finally { this.busy = false; this.onRender(); } }
  addSilent(card, section, quantity) { const deck = this.active(), id = String(card.id), existing = deck.cards.find(item => item.catalogCardId === id && item.section === section); if (existing) { existing.quantity += quantity; existing.banTcg = card.banTcg || existing.banTcg || ''; } else deck.cards.push({ catalogCardId: id, cardName: card.name, imageUrl: card.fullImage || card.image || '', banTcg: card.banTcg || '', section, quantity }); deck.cover = deck.cover || card.fullImage || card.image || ''; this.rememberCardType(id, card.type); this.markDirty(deck); }
  markDirty(deck) { deck.dirty = true; deck.ownerSlug = this.state.currentUser; this.persistDrafts(); }
  persistDrafts() { const current = readDrafts().filter(deck => deck.ownerSlug !== this.state.currentUser), dirty = (this.state.decks || []).filter(deck => deck.ownerSlug === this.state.currentUser && (deck.dirty || !deck.persisted)); localStorage.setItem(DRAFTS_KEY, JSON.stringify([...current, ...dirty])); }
  clearDraft(id) { const next = readDrafts().filter(deck => !(deck.ownerSlug === this.state.currentUser && deck.id === id)); localStorage.setItem(DRAFTS_KEY, JSON.stringify(next)); }
  async request(cardId) { const row = deckAvailability(this.active(), this.state.collection, this.state.currentUser).rows.find(item => item.catalogCardId === cardId); if (!row?.best) return; this.busy = true; this.onRender(); try { let remaining = row.missing; for (const item of row.best.items) { const quantity = Math.min(remaining, item.quantityAvailable); if (quantity > 0) await this.api.requestCollectionLoan(item.id, quantity, `Richiesta automatica dal mazzo ${this.active().name}`); remaining -= quantity; if (!remaining) break; } await this.onLoansChanged?.(); this.onToast(`Richiesta inviata a ${row.best.ownerName}`); } catch (error) { this.onToast(error.message || 'Richiesta non riuscita'); } finally { this.busy = false; this.onRender(); } }
  async requestAll() { const rows = deckAvailability(this.active(), this.state.collection, this.state.currentUser).rows.filter(row => row.best); for (const row of rows) await this.request(row.catalogCardId); }
}

export function deckAvailability(deck, collection, currentUser, { ownerSlug = '' } = {}) {
  // ownerSlug lets a viewer browse a teammate's deck read-only: "owned" is computed
  // from that owner's own collection rows instead of the viewer's, and the
  // teammate suggestions exclude the owner instead of the current viewer.
  const reference = ownerSlug || currentUser;
  const cards = deck?.cards || [], team = collection?.team || [], mine = ownerSlug ? team.filter(item => item.ownerSlug === reference) : (collection?.mine || []), required = new Map();
  for (const card of cards) { const key = deckCardIdentityKey(card), entry = required.get(key) || { ...card, quantity: 0 }; entry.quantity += Number(card.quantity || 0); required.set(key, entry); }
  let total = 0, covered = 0, requestable = 0; const rows = [];
  for (const card of required.values()) {
    const owned = mine.filter(item => sameDeckCardIdentity(card, item)).reduce((sum, item) => sum + Number(item.quantityAvailable || 0), 0);
    const owners = new Map();
    for (const item of team) {
      if (item.ownerSlug === reference || Number(item.quantityAvailable || 0) <= 0 || !sameDeckCardIdentity(card, item)) continue;
      const entry = owners.get(item.ownerSlug) || { ownerSlug: item.ownerSlug, ownerName: item.ownerName, quantity: 0, items: [] };
      entry.quantity += Number(item.quantityAvailable || 0); entry.items.push(item); owners.set(item.ownerSlug, entry);
    }
    const missing = Math.max(0, card.quantity - owned), best = [...owners.values()].sort((a, b) => b.quantity - a.quantity)[0] || null;
    total += card.quantity; covered += Math.min(card.quantity, owned);
    if (missing) { if (best) requestable += 1; rows.push({ ...card, owned, missing, best }); }
  }
  return { total, covered, percent: total ? Math.round(covered / total * 100) : 0, rows, requestable };
}

function deckCardIdentityKey(card) { const game = card?.game || 'yugioh', id = canonicalCatalogCardId(card?.catalogCardId, game), name = normalizeDeckCardName(card?.cardName); return id ? `id:${game}:${id}` : `name:${game}:${name}`; }
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
function coarseCardType(rawType) { const type = String(rawType || '').toLowerCase(); if (!type) return ''; if (type.includes('spell')) return 'spell'; if (type.includes('trap')) return 'trap'; return 'monster'; }
function readTypeCache() { try { const value = JSON.parse(localStorage.getItem(CARD_TYPE_CACHE_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
function writeTypeCache(map) { try { localStorage.setItem(CARD_TYPE_CACHE_KEY, JSON.stringify(map)); } catch {} }
function restrictionBadge(status) { const badges = { limited: ['1', 'Limitata a 1 copia'], 'semi-limited': ['2', 'Semi-limitata a 2 copie'], forbidden: ['⊘', 'Proibita'] }, badge = badges[status]; return badge ? `<i class="deck-ban-badge ${status}" title="${badge[1]} nel formato TCG Advanced" aria-label="${badge[1]} nel formato TCG Advanced">${badge[0]}</i>` : ''; }
function missingRow(row, currentUser, { readonly = false } = {}) { const owner = row.best, profile = owner ? member(owner.ownerSlug) : null; return `<article class="missing-card"><div>${row.imageUrl ? `<img src="${esc(row.imageUrl)}" alt="">` : icon('card')}<span><strong>${esc(row.cardName)}</strong><small>Disponibili per il mazzo ${row.owned} di ${row.quantity} · mancano ${row.missing}</small>${owner ? `<em><i class="mini-avatar member-${esc(owner.ownerSlug)}">${initials(profile?.name || owner.ownerName || '?')}</i>${esc(owner.ownerName)} ne ha ${owner.quantity}</em>` : '<em>Nessuna copia disponibile nel team</em>'}</span></div>${owner && !readonly ? `<button class="btn secondary small" data-deck-request="${esc(row.catalogCardId)}" ${owner.ownerSlug === currentUser ? 'disabled' : ''}>Richiedi</button>` : ''}</article>`; }
