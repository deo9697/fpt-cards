import { esc } from './core.js';
import { icon } from './icons.js';

// Renders completely outside the normal authenticated app shell — whoever
// opens the link has no account and no session token, so this never touches
// state.currentUser or anything else app.js gates behind login.
export class CollectionShareController {
  constructor({ api, shareId, onRender, onToast } = {}) {
    Object.assign(this, { api, shareId, onRender, onToast });
    this.loading = true; this.error = ''; this.data = null;
    this.selected = new Set();
    this.requesterName = '';
    this.submitting = false; this.submitted = false;
  }
  async load() {
    this.loading = true;
    try { this.data = await this.api.getCollectionShare(this.shareId); this.error = ''; }
    catch (error) { this.error = error?.message || 'Link non valido o scaduto'; }
    finally { this.loading = false; this.onRender?.(); }
  }
  toggle(printingId) {
    if (this.selected.has(printingId)) this.selected.delete(printingId);
    else this.selected.add(printingId);
    this.onRender?.();
  }
  async submit() {
    if (!this.selected.size || this.submitting) return;
    if (!this.requesterName.trim()) { this.onToast?.('Scrivi il tuo nome prima di inviare'); return; }
    this.submitting = true; this.onRender?.();
    try {
      const items = [...this.selected].map(printingId => ({ printingId, quantity: 1 }));
      await this.api.submitCollectionShareRequest(this.shareId, this.requesterName.trim(), items);
      this.submitted = true;
    } catch (error) { this.onToast?.(error?.message || 'Invio non riuscito, riprova'); }
    finally { this.submitting = false; this.onRender?.(); }
  }
  view() {
    if (this.loading) return `<div class="share-guest-shell"><div class="share-guest-loading"><div class="loading-spinner"></div></div></div>`;
    if (this.error) return `<div class="share-guest-shell"><div class="share-guest-message">${icon('bell')}<h2>Link non disponibile</h2><p>${esc(this.error)}</p></div></div>`;
    if (this.submitted) return `<div class="share-guest-shell"><div class="share-guest-message">${icon('card')}<h2>Richiesta inviata!</h2><p>${esc(this.data.ownerName)} riceverà una notifica con le carte che ti interessano.</p></div></div>`;
    const items = this.data.items;
    return `<div class="share-guest-shell">
      <header class="share-guest-header"><span class="eyebrow">Raccolta condivisa</span><h1>${esc(this.data.ownerName)}</h1><p>Tocca le carte che ti interessano, poi manda la richiesta.</p></header>
      ${items.length ? `<div class="share-guest-grid">${items.map(item => this.itemTile(item)).join('')}</div>` : `<div class="share-guest-message">${icon('card')}<h2>Raccolta vuota</h2><p>Non ci sono ancora carte da mostrare qui.</p></div>`}
      ${this.selected.size ? this.cartBar() : ''}
    </div>`;
  }
  itemTile(item) {
    const selected = this.selected.has(item.printingId);
    return `<button type="button" class="share-guest-tile ${selected ? 'selected' : ''}" data-share-toggle="${esc(item.printingId)}">
      <span class="share-guest-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.cardName)}" loading="lazy">` : icon('card')}<b class="share-guest-qty">${item.quantityOwned}×</b>${selected ? '<i class="share-guest-check">✓</i>' : ''}</span>
      <small>${esc(item.cardName)}</small>
    </button>`;
  }
  cartBar() {
    return `<div class="share-guest-cart">
      <span><b>${this.selected.size}</b> ${this.selected.size === 1 ? 'carta selezionata' : 'carte selezionate'}</span>
      <input type="text" placeholder="Il tuo nome" data-share-name value="${esc(this.requesterName)}" maxlength="80">
      <button type="button" class="btn" data-share-submit ${this.submitting ? 'disabled' : ''}>${this.submitting ? 'Invio…' : 'Sono interessato — invia'}</button>
    </div>`;
  }
  bind(root = document) {
    root.querySelectorAll('[data-share-toggle]').forEach(button => button.addEventListener('click', () => this.toggle(button.dataset.shareToggle)));
    const nameField = root.querySelector('[data-share-name]');
    if (nameField) { nameField.addEventListener('input', event => { this.requesterName = event.target.value; }); nameField.focus(); nameField.setSelectionRange(nameField.value.length, nameField.value.length); }
    root.querySelector('[data-share-submit]')?.addEventListener('click', () => void this.submit());
  }
}
