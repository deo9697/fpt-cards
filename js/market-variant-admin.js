// Market Variant Resolver — pannello per le printing Yu-Gi-Oh! che il feed
// bulk Cardmarket non riesce a distinguere da solo (stesso nome+espansione,
// rarità diverse: es. Rarity Collection). Stesso modello di js/admin.js
// (Artwork Resolver): l'app non sceglie mai un candidato al posto
// dell'admin, sceglie solo tra le opzioni che il resolver ha già trovato.
import { esc } from './core.js';
import { icon } from './icons.js';

const STATUS_LABELS = { ambiguous: 'Ambiguous', conflict: 'Conflict', unresolved: 'Unresolved' };

export function renderMarketVariantPage(model) {
  const { loading, error, queue, hasMore, selections, filters, coverage } = model;
  const rows = queue.map(item => marketVariantRow(item, selections.get(item.printingId))).join('');
  return `<section class="page-stack admin-page" data-market-variant-page>
    <header class="page-header"><div><span class="eyebrow">Market Variant Resolver</span><h1>Rarity Cardmarket ambigue</h1>
      <p>Stesso set_code, più rarità diverse: il feed Cardmarket non basta a distinguerle da solo. Scegli il prodotto corretto per ciascuna — nessuna scelta automatica.</p></div>
    </header>
    ${renderExactPricingCoverage(coverage)}
    ${renderMarketVariantFilters(filters)}
    ${error ? `<div class="admin-error surface">${icon('bell')} ${esc(error)}</div>` : ''}
    ${loading && !queue.length ? '<div class="empty">Caricamento coda...</div>' : ''}
    ${!loading && !queue.length && !error ? '<div class="empty">Nessuna market variant da revisionare con questi filtri.</div>' : ''}
    <div class="admin-variant-queue">${rows}</div>
    ${hasMore ? `<div class="admin-load-more"><button type="button" class="btn secondary" data-variant-load-more ${loading ? 'disabled' : ''}>${loading ? 'Caricamento...' : 'Carica altri'}</button></div>` : ''}
  </section>`;
}

// Fase finale dello shadow pricing — sola diagnostica (js/api.js:
// marketVariantExactPriceReport). "different"/"still ambiguous" sono la
// stessa scala del report SQL: diff.different arriva dall'ultima
// run_ygo_market_variant_price_shadow eseguita (0 finché nessuna è ancora
// girata, non un placeholder), registry.ambiguous+conflict dal registry
// corrente. Non mostra MAI un prezzo — nessun cambiamento a Market Watch.
function renderExactPricingCoverage(coverage) {
  if (!coverage) return '';
  const { total_used_printings, registry, exact_price_coverage, coverage_pct, diff } = coverage;
  const stillAmbiguous = (registry?.ambiguous || 0) + (registry?.conflict || 0);
  return `<section class="surface admin-variant-coverage">
    <header><span class="eyebrow">Fase finale shadow pricing</span><h2>Exact Pricing Coverage</h2></header>
    <div class="admin-variant-coverage-grid">
      <div><strong>${total_used_printings}</strong><span>Used printings</span></div>
      <div><strong>${exact_price_coverage.eligible_exact}</strong><span>Exact eligible</span></div>
      <div><strong>${exact_price_coverage.exact_price_available}</strong><span>Exact price available</span></div>
      <div><strong>${coverage_pct.all_used}%</strong><span>Coverage</span></div>
      <div><strong>${diff.different}</strong><span>Different from legacy</span></div>
      <div><strong>${stillAmbiguous}</strong><span>Still ambiguous/conflict</span></div>
    </div>
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
