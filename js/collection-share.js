import { esc, GAMES } from './core.js';
import { icon } from './icons.js';

const PAGE_SIZE = 60;
const SORT_OPTIONS = [
  { value: 'name-asc', label: 'Nome A-Z' },
  { value: 'name-desc', label: 'Nome Z-A' },
  { value: 'qty-desc', label: 'Quantità disponibile' }
];
const FACETS = [
  { key: 'rarity', label: 'Rarità' },
  { key: 'edition', label: 'Edizione' },
  { key: 'condition', label: 'Condizione' },
  { key: 'language', label: 'Lingua' }
];
const LANGUAGE_SHORT = {
  italiano: 'ITA', inglese: 'ENG', english: 'ENG', giapponese: 'JAP', japanese: 'JAP',
  tedesco: 'GER', german: 'GER', francese: 'FRA', french: 'FRA', spagnolo: 'SPA', spanish: 'SPA',
  coreano: 'KOR', korean: 'KOR'
};

function languageShort(language) {
  const value = (language || '').trim();
  if (!value) return '';
  return LANGUAGE_SHORT[value.toLowerCase()] || value.slice(0, 3).toUpperCase();
}
function rarityClass(rarity) {
  const value = (rarity || '').toLowerCase();
  if (value.includes('secret')) return 'secret';
  if (value.includes('ultra')) return 'ultra';
  if (value.includes('super')) return 'super';
  if (value.includes('common')) return 'common';
  if (value.includes('rare')) return 'rare';
  return 'plain';
}
// Sempre lo stesso numero mostrato al guest per decidere quanto chiedere:
// quantityAvailable (netta di prestiti/prenotazioni) se la RPC aggiornata la
// espone, altrimenti quantityOwned finché la migration non è ancora applicata.
function availableQuantity(item) {
  return item.quantityAvailable ?? item.quantityOwned ?? 0;
}
function sortItems(items, sort) {
  const copy = [...items];
  if (sort === 'name-desc') copy.sort((a, b) => b.cardName.localeCompare(a.cardName, 'it'));
  else if (sort === 'qty-desc') copy.sort((a, b) => availableQuantity(b) - availableQuantity(a) || a.cardName.localeCompare(b.cardName, 'it'));
  else copy.sort((a, b) => a.cardName.localeCompare(b.cardName, 'it'));
  return copy;
}

// Renders completely outside the normal authenticated app shell — whoever
// opens the link has no account and no session token, so this never touches
// state.currentUser or anything else app.js gates behind login.
export class CollectionShareController {
  constructor({ api, shareId, onRender, onToast } = {}) {
    Object.assign(this, { api, shareId, onRender, onToast });
    this.loading = true; this.error = ''; this.data = null;
    this.query = '';
    this.filters = { rarity: 'all', edition: 'all', condition: 'all', language: 'all', availability: 'all' };
    this.sort = 'name-asc';
    this.visibleCount = PAGE_SIZE;
    this.selected = new Map(); // printingId -> quantity
    this.reviewing = false;
    this.requesterName = '';
    this.message = '';
    this.submitting = false; this.submitted = false;
  }
  async load() {
    this.loading = true;
    try { this.data = await this.api.getCollectionShare(this.shareId); this.error = ''; }
    catch (error) { this.error = error?.message || 'Link non valido o scaduto'; }
    finally { this.loading = false; this.onRender?.(); }
  }
  search(value) {
    this.query = value;
    this.visibleCount = PAGE_SIZE;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.refreshGrid(), 180);
  }
  setFilter(key, value) {
    if (!(key in this.filters)) return;
    this.filters[key] = value;
    this.visibleCount = PAGE_SIZE;
    this.refreshGrid();
  }
  setSort(value) {
    this.sort = value;
    this.refreshGrid();
  }
  showMore() {
    this.visibleCount += PAGE_SIZE;
    this.refreshGrid();
  }
  // Digitare/filtrare non deve ridisegnare l'intera pagina (perde focus/cursore
  // sull'input, ricarica le immagini): solo il contenuto della griglia
  // filtrata si aggiorna, stesso pattern di market-watch.js/decks.js.
  refreshGrid() {
    const content = document.querySelector('[data-share-grid-content]');
    if (!content) return;
    content.innerHTML = this.gridContent();
    this.bindGridContent(content);
  }
  toggle(printingId) {
    if (this.selected.has(printingId)) { this.selected.delete(printingId); this.onRender?.(); return; }
    const item = this.data?.items.find(row => row.printingId === printingId);
    if (!item || availableQuantity(item) <= 0) return;
    this.selected.set(printingId, 1);
    this.onRender?.();
  }
  setQuantity(printingId, quantity) {
    const item = this.data?.items.find(row => row.printingId === printingId);
    if (!item) return;
    const max = availableQuantity(item);
    const clamped = Math.max(0, Math.min(max, Math.round(quantity) || 0));
    if (clamped <= 0) this.selected.delete(printingId);
    else this.selected.set(printingId, clamped);
    if (!this.selected.size) this.reviewing = false;
    this.onRender?.();
  }
  openReview() { if (!this.selected.size) return; this.reviewing = true; this._focusName = !this.requesterName.trim(); this.onRender?.(); }
  closeReview() { this.reviewing = false; this.onRender?.(); }
  async submit() {
    if (!this.selected.size || this.submitting) return;
    if (!this.requesterName.trim()) { this.onToast?.('Scrivi il tuo nome prima di inviare'); return; }
    this.submitting = true; this.onRender?.();
    try {
      const items = [...this.selected].map(([printingId, quantity]) => ({ printingId, quantity }));
      await this.api.submitCollectionShareRequest(this.shareId, this.requesterName.trim(), items, this.message.trim());
      this.submitted = true;
    } catch (error) { this.onToast?.(error?.message || 'Invio non riuscito, riprova'); }
    finally { this.submitting = false; this.onRender?.(); }
  }
  // Cerca in cardName/alternateNames/setName/setCode: alternateNames arriva
  // da get_collection_share (altri nomi noti per lo stesso catalog_card_id,
  // es. "Sintonizzare" per una stampa posseduta come "Tuning" — non una
  // traduzione, solo nomi che il catalogo ha già registrato altrove per la
  // stessa carta).
  matchesQuery(item, query) {
    if (!query) return true;
    if (item.cardName.toLowerCase().includes(query)) return true;
    if ((item.setName || '').toLowerCase().includes(query)) return true;
    if ((item.setCode || '').toLowerCase().includes(query)) return true;
    return (item.alternateNames || []).some(name => name.toLowerCase().includes(query));
  }
  visibleItems() {
    const query = this.query.trim().toLowerCase();
    const { rarity, edition, condition, language, availability } = this.filters;
    const items = (this.data?.items || []).filter(item => {
      if (!this.matchesQuery(item, query)) return false;
      if (rarity !== 'all' && (item.rarity || '') !== rarity) return false;
      if (edition !== 'all' && (item.edition || '') !== edition) return false;
      if (condition !== 'all' && (item.condition || '') !== condition) return false;
      if (language !== 'all' && (item.language || '') !== language) return false;
      if (availability === 'available' && availableQuantity(item) <= 0) return false;
      return true;
    });
    return sortItems(items, this.sort);
  }
  view() {
    if (this.loading) return `<div class="share-guest-shell"><div class="share-guest-loading"><div class="loading-spinner"></div></div></div>`;
    if (this.error) return `<div class="share-guest-shell"><div class="share-guest-message">${icon('bell')}<h2>Link non disponibile</h2><p>${esc(this.error)}</p></div></div>`;
    if (this.submitted) return `<div class="share-guest-shell"><div class="share-guest-success">
      <span class="share-guest-success-icon">${icon('send')}</span>
      <h2>Richiesta inviata!</h2>
      <p>${esc(this.data.ownerName)} riceverà una notifica con le carte che ti interessano.</p>
    </div></div>`;
    const allItems = this.data.items;
    return `<div class="share-guest-shell"><div class="share-guest-inner">
      ${this.heroView()}
      ${allItems.length ? `<div class="share-guest-search"><span class="icon-wrap">${icon('search')}</span><input type="search" placeholder="Cerca carta, set o codice..." data-share-query value="${esc(this.query)}"><span class="share-guest-scan-decoy" aria-hidden="true">${icon('scan')}</span></div>` : ''}
      <div data-share-grid-content>${this.gridContent()}</div>
      ${this.footerView()}
    </div>
      ${this.selected.size ? this.selectionBar() : ''}
      ${this.reviewing ? this.reviewView() : ''}
    </div>`;
  }
  heroView() {
    const data = this.data;
    const game = GAMES[data.game];
    const cardCount = data.cardCount ?? data.items.length;
    const printingCount = data.printingCount ?? data.items.length;
    // Sfondo decorativo solo per Yu-Gi-Oh: è l'unico asset di background
    // esistente oggi (assets/background/yugioh-01.png) — niente da mostrare
    // per One Piece finché non esiste un equivalente, meglio nessuno sfondo
    // che inventarne uno.
    const heroBg = data.game === 'yugioh' ? ' style="background-image:url(assets/background/yugioh-01.png)"' : '';
    return `<header class="share-guest-hero">
      <div class="share-guest-hero-bg"${heroBg} aria-hidden="true"></div>
      <div class="share-guest-hero-top">
        <div class="share-guest-brand"><img src="icon-512.png" alt="F.P.T Cards"><b>F.P.T<small>CARDS</small></b></div>
        <span class="share-guest-payoff">MORE THAN CARDS<br>A HIGHER PASSION</span>
      </div>
      <span class="eyebrow">Raccolta condivisa</span>
      <h1>Collezione di ${esc(data.ownerName)}</h1>
      <p>Sfoglia la collezione e scegli le carte che ti interessano.</p>
      <div class="share-guest-stats">
        <span class="share-guest-pill">${icon('card')}${cardCount} carte</span>
        <span class="share-guest-pill">${icon('collection')}${printingCount} stampe</span>
        <span class="share-guest-pill">${game?.logo ? `<img src="${esc(game.logo)}" alt="">` : icon('star')}${esc(game?.short || data.game)}</span>
      </div>
    </header>`;
  }
  footerView() {
    return `<footer class="share-guest-footer">
      <button type="button" class="share-guest-footer-link" data-share-advanced>${icon('filter')} Filtri avanzati</button>
      <span>Le grandi collezioni<br>uniscono le persone</span>
    </footer>`;
  }
  facetOptions(key) {
    return [...new Set(this.data.items.map(item => (item[key] || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'it'));
  }
  filterBar() {
    const facets = FACETS.map(facet => ({ ...facet, values: this.facetOptions(facet.key) })).filter(facet => facet.values.length);
    return `<div class="share-guest-filters" data-share-filters>
      ${facets.map(facet => `<select class="share-guest-chip ${this.filters[facet.key] !== 'all' ? 'active' : ''}" data-share-filter="${facet.key}" aria-label="${facet.label}">
        <option value="all">${facet.label}</option>
        ${facet.values.map(value => `<option value="${esc(value)}" ${this.filters[facet.key] === value ? 'selected' : ''}>${esc(value)}</option>`).join('')}
      </select>`).join('')}
      <select class="share-guest-chip ${this.filters.availability !== 'all' ? 'active' : ''}" data-share-filter="availability" aria-label="Disponibilità">
        <option value="all" ${this.filters.availability === 'all' ? 'selected' : ''}>Disponibilità</option>
        <option value="available" ${this.filters.availability === 'available' ? 'selected' : ''}>Solo disponibili</option>
      </select>
    </div>
    <div class="share-guest-sort-row">
      <select data-share-sort aria-label="Ordina">${SORT_OPTIONS.map(option => `<option value="${option.value}" ${this.sort === option.value ? 'selected' : ''}>Ordina: ${option.label}</option>`).join('')}</select>
    </div>`;
  }
  gridContent() {
    const allItems = this.data.items;
    if (!allItems.length) return `<div class="share-guest-message">${icon('card')}<h2>Raccolta vuota</h2><p>Non ci sono ancora carte da mostrare qui.</p></div>`;
    const items = this.visibleItems();
    const filterBar = this.filterBar();
    const resultCount = `<div class="share-guest-result-count">${items.length} ${items.length === 1 ? 'risultato' : 'risultati'}</div>`;
    if (!items.length) return `${filterBar}${resultCount}<div class="share-guest-message compact">${icon('search')}<p>Nessuna carta corrisponde ${this.query.trim() ? `a "${esc(this.query.trim())}"` : 'ai filtri selezionati'}</p></div>`;
    // Un tetto sulle immagini renderizzate in una volta: senza, una raccolta
    // grande (anche migliaia di stampe) ricostruisce/ricarica centinaia di
    // <img> ad ogni tasto premuto o filtro cambiato — "Mostra altre" carica
    // altre PAGE_SIZE senza mai buttare giù 500+ immagini insieme.
    const shown = items.slice(0, this.visibleCount);
    const grid = `<div class="share-guest-grid">${shown.map(item => this.itemTile(item)).join('')}</div>`;
    const showMore = items.length > this.visibleCount
      ? `<button type="button" class="btn secondary share-guest-more" data-share-show-more>Mostra altre (${items.length - this.visibleCount})</button>` : '';
    return `${filterBar}${resultCount}${grid}${showMore}`;
  }
  itemTile(item) {
    const quantity = this.selected.get(item.printingId) || 0;
    const available = availableQuantity(item);
    const exhausted = available <= 0;
    const meta = [item.edition, item.condition, item.language ? languageShort(item.language) : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="share-guest-tile ${quantity ? 'selected' : ''} ${exhausted ? 'exhausted' : ''}" data-share-toggle="${esc(item.printingId)}" ${exhausted ? 'disabled' : ''}>
      <span class="share-guest-art">
        ${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.cardName)}" loading="lazy">` : icon('card')}
        <b class="share-guest-qty">${exhausted ? 'Esaurita' : `x${available}`}</b>
        <i class="share-guest-select ${quantity ? 'on' : ''}">${quantity ? (quantity > 1 ? `${quantity}×` : icon('check')) : icon('plus')}</i>
      </span>
      <strong class="share-guest-name">${esc(item.cardName)}</strong>
      ${item.setCode ? `<small class="share-guest-setcode">${esc(item.setCode)}</small>` : ''}
      ${item.rarity ? `<span class="share-guest-rarity ${rarityClass(item.rarity)}">${esc(item.rarity)}</span>` : ''}
      ${meta ? `<small class="share-guest-meta">${esc(meta)}</small>` : ''}
    </button>`;
  }
  selectionBar() {
    return `<div class="share-guest-selection-bar">
      <span class="share-guest-selection-icon">${icon('collection')}</span>
      <span class="share-guest-selection-text"><b>${this.selected.size}</b> ${this.selected.size === 1 ? 'carta selezionata' : 'carte selezionate'}<small>Da inviare come richiesta</small></span>
      <button type="button" class="btn share-guest-selection-cta" data-share-review-open>${icon('send')} Invia richiesta</button>
    </div>`;
  }
  reviewView() {
    const rows = [...this.selected.entries()]
      .map(([printingId, quantity]) => ({ item: this.data.items.find(row => row.printingId === printingId), quantity }))
      .filter(row => row.item);
    const nameFilled = this.requesterName.trim();
    const canSubmit = !!nameFilled && rows.length > 0 && !this.submitting;
    return `<div class="detail-backdrop" data-share-review-close><aside class="card-detail share-review-modal" role="dialog" aria-modal="true" aria-labelledby="share-review-title">
      <button class="detail-close" data-share-review-close aria-label="Chiudi">×</button>
      <div class="share-review-head">
        <span class="share-review-divider" aria-hidden="true"></span>
        <span class="share-review-icon">${icon('send')}</span>
        <h2 id="share-review-title">Richiesta pronta</h2>
        <p>Controlla il riepilogo prima di inviarla a ${esc(this.data.ownerName)}.</p>
      </div>
      <div class="share-review-summary">
        <label class="share-review-summary-item"><span class="share-review-icon-wrap">${icon('team')}</span><span>Nome<input type="text" placeholder="Il tuo nome" data-share-name value="${esc(this.requesterName)}" maxlength="80"></span></label>
        <span class="share-review-summary-item"><span class="share-review-icon-wrap">${icon('team')}</span><span>A<b>${esc(this.data.ownerName)}</b></span></span>
        <span class="share-review-summary-item"><span class="share-review-icon-wrap">${icon('collection')}</span><span>Selezionate<b>${rows.length} ${rows.length === 1 ? 'carta' : 'carte'}</b></span></span>
      </div>
      <h3 class="share-review-section-title">Carte incluse nella richiesta</h3>
      <div class="share-review-list">${rows.map(row => this.reviewRow(row.item, row.quantity)).join('')}</div>
      <h3 class="share-review-section-title">${icon('message')} Messaggio opzionale</h3>
      <textarea class="share-review-message" data-share-message maxlength="250" placeholder="Scrivi un messaggio per accompagnare la richiesta...">${esc(this.message)}</textarea>
      <div class="share-review-message-count">${this.message.length}/250</div>
      <p class="share-review-note">${icon('bell')} ${esc(this.data.ownerName)} riceverà una notifica con questa richiesta.</p>
      <div class="share-review-actions">
        <button type="button" class="btn secondary" data-share-review-close>Torna indietro</button>
        <button type="button" class="btn share-review-submit" data-share-submit ${canSubmit ? '' : 'disabled'}>${this.submitting ? 'Invio...' : 'Conferma invio'}</button>
      </div>
    </aside></div>`;
  }
  reviewRow(item, quantity) {
    const available = availableQuantity(item);
    const meta = [item.edition, item.condition, item.language ? languageShort(item.language) : ''].filter(Boolean).join(' · ');
    return `<div class="share-review-row">
      <span class="share-review-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" loading="lazy">` : icon('card')}</span>
      <div class="share-review-info">
        <b>${esc(item.cardName)}</b>
        <small>${[item.setCode, meta].filter(Boolean).join(' · ')}</small>
        ${item.rarity ? `<span class="share-guest-rarity ${rarityClass(item.rarity)}">${esc(item.rarity)}</span>` : ''}
      </div>
      <label class="share-review-qty">Quantità<input type="number" inputmode="numeric" min="1" max="${available}" value="${quantity}" data-share-qty="${esc(item.printingId)}"></label>
      <button type="button" class="share-review-remove" data-share-remove="${esc(item.printingId)}" aria-label="Rimuovi">${icon('trash')}</button>
    </div>`;
  }
  // Condiviso tra il bind iniziale (root=document) e refreshGrid()
  // (root=solo [data-share-grid-content]): va ri-agganciato ogni volta che
  // quel solo pezzo di HTML viene ricostruito.
  bindGridContent(root) {
    root.querySelectorAll('[data-share-toggle]').forEach(button => button.addEventListener('click', () => this.toggle(button.dataset.shareToggle)));
    root.querySelectorAll('[data-share-filter]').forEach(select => select.addEventListener('change', () => this.setFilter(select.dataset.shareFilter, select.value)));
    root.querySelector('[data-share-sort]')?.addEventListener('change', event => this.setSort(event.target.value));
    root.querySelector('[data-share-show-more]')?.addEventListener('click', () => this.showMore());
  }
  bind(root = document) {
    this.bindGridContent(root);
    root.querySelector('[data-share-query]')?.addEventListener('input', event => this.search(event.target.value));
    root.querySelector('[data-share-advanced]')?.addEventListener('click', () => document.querySelector('[data-share-filters]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    root.querySelector('[data-share-review-open]')?.addEventListener('click', () => this.openReview());
    root.querySelectorAll('[data-share-review-close]').forEach(element => element.addEventListener('click', event => { if (event.target !== element && !event.target.closest('.detail-close')) return; this.closeReview(); }));
    root.querySelectorAll('[data-share-qty]').forEach(input => input.addEventListener('change', () => this.setQuantity(input.dataset.shareQty, Number(input.value))));
    root.querySelectorAll('[data-share-remove]').forEach(button => button.addEventListener('click', () => this.setQuantity(button.dataset.shareRemove, 0)));
    // Il pulsante "Conferma invio" deve abilitarsi mentre si digita il nome,
    // ma un onRender() completo ad ogni tasto premuto farebbe perdere il
    // focus sul campo — si aggiorna quindi solo l'attributo disabled, non
    // tutto il modal.
    const syncSubmitState = () => {
      const submitButton = root.querySelector('[data-share-submit]');
      if (submitButton) submitButton.disabled = !this.requesterName.trim() || !this.selected.size || this.submitting;
    };
    const nameField = root.querySelector('[data-share-name]');
    if (nameField) nameField.addEventListener('input', event => { this.requesterName = event.target.value; syncSubmitState(); });
    const messageField = root.querySelector('[data-share-message]');
    if (messageField) messageField.addEventListener('input', event => {
      this.message = event.target.value.slice(0, 250);
      root.querySelector('.share-review-message-count').textContent = `${this.message.length}/250`;
      syncSubmitState();
    });
    root.querySelector('[data-share-submit]')?.addEventListener('click', () => void this.submit());

    if (this._focusName) {
      this._focusName = false;
      const field = root.querySelector('[data-share-name]');
      if (field) { field.focus(); field.setSelectionRange(field.value.length, field.value.length); }
    }
  }
}
