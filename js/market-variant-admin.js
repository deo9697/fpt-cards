// Market Variant Resolver — pannello per le printing Yu-Gi-Oh! che il feed
// bulk Cardmarket non riesce a distinguere da solo (stesso nome+espansione,
// rarità diverse: es. Rarity Collection). Stesso modello di js/admin.js
// (Artwork Resolver): l'app non sceglie mai un candidato al posto
// dell'admin, sceglie solo tra le opzioni che il resolver ha già trovato.
import { esc } from './core.js';
import { icon } from './icons.js';

const STATUS_LABELS = { ambiguous: 'Ambiguous', conflict: 'Conflict', unresolved: 'Unresolved' };

export function renderMarketVariantPage(model) {
  const { loading, error, queue, hasMore, selections, filters } = model;
  const rows = queue.map(item => marketVariantRow(item, selections.get(item.printingId))).join('');
  return `<section class="page-stack admin-page" data-market-variant-page>
    <header class="page-header"><div><span class="eyebrow">Market Variant Resolver</span><h1>Rarity Cardmarket ambigue</h1>
      <p>Stesso set_code, più rarità diverse: il feed Cardmarket non basta a distinguerle da solo. Scegli il prodotto corretto per ciascuna — nessuna scelta automatica.</p></div>
    </header>
    ${renderMarketVariantFilters(filters)}
    ${error ? `<div class="admin-error surface">${icon('bell')} ${esc(error)}</div>` : ''}
    ${loading && !queue.length ? '<div class="empty">Caricamento coda...</div>' : ''}
    ${!loading && !queue.length && !error ? '<div class="empty">Nessuna market variant da revisionare con questi filtri.</div>' : ''}
    <div class="admin-variant-queue">${rows}</div>
    ${hasMore ? `<div class="admin-load-more"><button type="button" class="btn secondary" data-variant-load-more ${loading ? 'disabled' : ''}>${loading ? 'Caricamento...' : 'Carica altri'}</button></div>` : ''}
  </section>`;
}

function renderMarketVariantFilters(filters) {
  return `<section class="surface admin-filters">
    <div class="admin-filters-row">
      <label class="admin-filter-search">${icon('search')}<input type="search" data-variant-filter-query placeholder="Cerca per nome carta o set_code..." value="${esc(filters.query)}"></label>
      <label class="admin-filter-toggle"><input type="checkbox" data-variant-filter-used-only ${filters.usedOnly ? 'checked' : ''}> Solo usate</label>
    </div>
  </section>`;
}

function usageLabel(item) {
  const parts = [
    item.collectionUsage ? `${item.collectionUsage} in raccolta` : '',
    item.deckUsage ? `${item.deckUsage} in mazzi` : '',
    item.loanUsage ? `${item.loanUsage} in prestiti` : ''
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Non ancora posseduta da nessuno';
}

function marketVariantRow(item, selectedProductId) {
  const candidateIds = item.candidateProductIds || [];
  const candidates = candidateIds.map(productId => {
    const isSelected = selectedProductId === productId;
    return `<label class="admin-variant-candidate ${isSelected ? 'is-selected' : ''}">
      <input type="radio" name="variant-candidate-${esc(item.printingId)}" data-variant-candidate
        data-variant-printing-id="${esc(item.printingId)}" data-variant-product-id="${esc(productId)}" ${isSelected ? 'checked' : ''}>
      <span>${esc(productId)}</span>
      <a href="https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(productId)}" target="_blank" rel="noopener noreferrer" class="text-action">Vedi ${icon('arrow')}</a>
    </label>`;
  }).join('');
  return `<article class="admin-variant-card surface" data-admin-variant-card="${esc(item.printingId)}">
    <header>
      <div>
        <strong>${esc(item.cardName || 'Nome sconosciuto')}</strong>
        <span>${esc(item.setCode)}${item.setName ? ' · ' + esc(item.setName) : ''}${item.rarity ? ' · ' + esc(item.rarity) : ''}</span>
      </div>
      <div class="admin-variant-usage">${icon('collection')} ${esc(usageLabel(item))}</div>
    </header>
    <div class="admin-variant-meta">
      <span class="admin-variant-badge is-${esc(item.mappingStatus)}">${esc(STATUS_LABELS[item.mappingStatus] || item.mappingStatus)}</span>
      <span>${candidateIds.length} candidat${candidateIds.length === 1 ? 'o' : 'i'}</span>
      ${item.resolutionReason ? `<span class="admin-variant-reason">${esc(item.resolutionReason)}</span>` : ''}
    </div>
    <div class="admin-variant-candidates">${candidates || '<p class="empty">Nessun candidato: esegui prima il resolver (canary) su questa printing.</p>'}</div>
    <footer>
      <button type="button" class="btn" data-variant-confirm data-variant-printing-id="${esc(item.printingId)}" ${selectedProductId ? '' : 'disabled'}>Conferma selezionato</button>
    </footer>
  </article>`;
}

export function bindMarketVariantPage(root, model, handlers) {
  const page = root.querySelector('[data-market-variant-page]');
  if (!page) return;
  page.addEventListener('click', event => {
    const candidate = event.target.closest('[data-variant-candidate]');
    if (candidate) { handlers.onSelectCandidate(candidate.dataset.variantPrintingId, candidate.dataset.variantProductId); return; }
    const confirmButton = event.target.closest('[data-variant-confirm]');
    if (confirmButton && !confirmButton.disabled) { handlers.onConfirm(confirmButton.dataset.variantPrintingId); return; }
    const loadMore = event.target.closest('[data-variant-load-more]');
    if (loadMore && !loadMore.disabled) handlers.onLoadMore();
  });
  page.querySelector('[data-variant-filter-query]')?.addEventListener('input', event => handlers.onFilterChange('query', event.target.value));
  page.querySelector('[data-variant-filter-used-only]')?.addEventListener('change', event => handlers.onFilterChange('usedOnly', event.target.checked));
}
