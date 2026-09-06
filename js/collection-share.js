import { esc } from './core.js';
import { icon } from './icons.js';

// Renders completely outside the normal authenticated app shell — whoever
// opens the link has no account and no session token, so this never touches
// state.currentUser or anything else app.js gates behind login.
export class CollectionShareController {
  constructor({ api, shareId, onRender, onToast } = {}) {
    Object.assign(this, { api, shareId, onRender, onToast });
    this.loading = true; this.error = ''; this.data = null;
    this.query = '';
    this.selected = new Map(); // printingId -> quantity
    this.reviewing = false;
    this.requesterName = '';
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
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.onRender?.(), 180);
  }
  toggle(printingId) {
    if (this.selected.has(printingId)) this.selected.delete(printingId);
    else this.selected.set(printingId, 1);
    this.onRender?.();
  }
  setQuantity(printingId, quantity) {
    const item = this.data?.items.find(row => row.printingId === printingId);
    if (!item) return;
    const max = item.quantityOwned || 1;
    const clamped = Math.max(0, Math.min(max, quantity));
    if (clamped <= 0) this.selected.delete(printingId);
    else this.selected.set(printingId, clamped);
    if (!this.selected.size) this.reviewing = false;
    this.onRender?.();
  }
  openReview() { if (!this.selected.size) return; this.reviewing = true; this._focusName = true; this.onRender?.(); }
  closeReview() { this.reviewing = false; this.onRender?.(); }
  async submit() {
    if (!this.selected.size || this.submitting) return;
    if (!this.requesterName.trim()) { this.onToast?.('Scrivi il tuo nome prima di inviare'); return; }
    this.submitting = true; this.onRender?.();
    try {
      const items = [...this.selected].map(([printingId, quantity]) => ({ printingId, quantity }));
      await this.api.submitCollectionShareRequest(this.shareId, this.requesterName.trim(), items);
      this.submitted = true;
    } catch (error) { this.onToast?.(error?.message || 'Invio non riuscito, riprova'); }
    finally { this.submitting = false; this.onRender?.(); }
  }
  filteredItems() {
    const items = this.data?.items || [];
    const query = this.query.trim().toLowerCase();
    if (!query) return items;
    return items.filter(item => item.cardName.toLowerCase().includes(query) || (item.setName || '').toLowerCase().includes(query));
  }
  view() {
    if (this.loading) return `<div class="share-guest-shell"><div class="share-guest-loading"><div class="loading-spinner"></div></div></div>`;
    if (this.error) return `<div class="share-guest-shell"><div class="share-guest-message">${icon('bell')}<h2>Link non disponibile</h2><p>${esc(this.error)}</p></div></div>`;
    if (this.submitted) return `<div class="share-guest-shell"><div class="share-guest-message">${icon('card')}<h2>Richiesta inviata!</h2><p>${esc(this.data.ownerName)} riceverà una notifica con le carte che ti interessano.</p></div></div>`;
    const allItems = this.data.items;
    const items = this.filteredItems();
    return `<div class="share-guest-shell">
      <header class="share-guest-header"><span class="eyebrow">Raccolta condivisa</span><h1>${esc(this.data.ownerName)}</h1><p>Tocca le carte che ti interessano, poi manda la richiesta.</p></header>
      ${allItems.length ? `<div class="share-guest-search"><span class="icon-wrap">${icon('search')}</span><input type="search" placeholder="Cerca carta o set…" data-share-query value="${esc(this.query)}"></div>` : ''}
      ${allItems.length ? (items.length ? `<div class="share-guest-grid">${items.map(item => this.itemTile(item)).join('')}</div>` : `<div class="share-guest-message compact">${icon('search')}<p>Nessuna carta corrisponde a "${esc(this.query)}"</p></div>`) : `<div class="share-guest-message">${icon('card')}<h2>Raccolta vuota</h2><p>Non ci sono ancora carte da mostrare qui.</p></div>`}
      ${this.selected.size ? this.cartBar() : ''}
      ${this.reviewing ? this.reviewView() : ''}
    </div>`;
  }
  itemTile(item) {
    const quantity = this.selected.get(item.printingId) || 0;
    return `<button type="button" class="share-guest-tile ${quantity ? 'selected' : ''}" data-share-toggle="${esc(item.printingId)}">
      <span class="share-guest-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.cardName)}" loading="lazy">` : icon('card')}<b class="share-guest-qty">${item.quantityOwned}×</b>${quantity ? `<i class="share-guest-check">${quantity > 1 ? `${quantity}×` : '✓'}</i>` : ''}</span>
      <small>${esc(item.cardName)}</small>
    </button>`;
  }
  cartBar() {
    return `<div class="share-guest-cart">
      <span><b>${this.selected.size}</b> ${this.selected.size === 1 ? 'carta selezionata' : 'carte selezionate'}</span>
      <button type="button" class="btn" data-share-review-open>Rivedi e invia</button>
    </div>`;
  }
  reviewView() {
    const rows = [...this.selected.entries()]
      .map(([printingId, quantity]) => ({ item: this.data.items.find(row => row.printingId === printingId), quantity }))
      .filter(row => row.item);
    return `<div class="detail-backdrop" data-share-review-close><aside class="card-detail share-review-modal" role="dialog" aria-modal="true" aria-labelledby="share-review-title">
      <button class="detail-close" data-share-review-close aria-label="Chiudi">×</button>
      <span class="eyebrow">Richiesta</span><h2 id="share-review-title">Cosa ti interessa</h2>
      <div class="share-review-list">${rows.map(row => this.reviewRow(row.item, row.quantity)).join('')}</div>
      <input type="text" placeholder="Il tuo nome" data-share-name value="${esc(this.requesterName)}" maxlength="80">
      <button type="button" class="btn share-review-submit" data-share-submit ${this.submitting || !rows.length ? 'disabled' : ''}>${this.submitting ? 'Invio…' : 'Invia richiesta'}</button>
    </aside></div>`;
  }
  reviewRow(item, quantity) {
    return `<div class="share-review-row">
      <span class="share-review-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" loading="lazy">` : icon('card')}</span>
      <div class="share-review-info"><b>${esc(item.cardName)}</b><small>${esc(item.setName || '')}</small></div>
      <div class="share-review-qty">
        <button type="button" data-share-qty-dec="${esc(item.printingId)}" aria-label="Diminuisci quantità">−</button>
        <span>${quantity}</span>
        <button type="button" data-share-qty-inc="${esc(item.printingId)}" aria-label="Aumenta quantità" ${quantity >= item.quantityOwned ? 'disabled' : ''}>+</button>
      </div>
      <button type="button" class="share-review-remove" data-share-remove="${esc(item.printingId)}" aria-label="Rimuovi">${icon('trash')}</button>
    </div>`;
  }
  bind(root = document) {
    root.querySelectorAll('[data-share-toggle]').forEach(button => button.addEventListener('click', () => this.toggle(button.dataset.shareToggle)));
    root.querySelector('[data-share-query]')?.addEventListener('input', event => this.search(event.target.value));
    root.querySelector('[data-share-review-open]')?.addEventListener('click', () => this.openReview());
    root.querySelectorAll('[data-share-review-close]').forEach(element => element.addEventListener('click', event => { if (event.target !== element && !event.target.closest('.detail-close')) return; this.closeReview(); }));
    root.querySelectorAll('[data-share-qty-inc]').forEach(button => button.addEventListener('click', () => this.setQuantity(button.dataset.shareQtyInc, (this.selected.get(button.dataset.shareQtyInc) || 0) + 1)));
    root.querySelectorAll('[data-share-qty-dec]').forEach(button => button.addEventListener('click', () => this.setQuantity(button.dataset.shareQtyDec, (this.selected.get(button.dataset.shareQtyDec) || 0) - 1)));
    root.querySelectorAll('[data-share-remove]').forEach(button => button.addEventListener('click', () => this.setQuantity(button.dataset.shareRemove, 0)));
    const nameField = root.querySelector('[data-share-name]');
    if (nameField) nameField.addEventListener('input', event => { this.requesterName = event.target.value; });
    root.querySelector('[data-share-submit]')?.addEventListener('click', () => void this.submit());

    if (this._focusName) {
      this._focusName = false;
      const field = root.querySelector('[data-share-name]');
      if (field) { field.focus(); field.setSelectionRange(field.value.length, field.value.length); }
    }
  }
}
