// Market Variant Resolver — pannello per le printing Yu-Gi-Oh! che il feed
// bulk Cardmarket non riesce a distinguere da solo (stesso nome+espansione,
// rarità diverse: es. Rarity Collection). Stesso modello di js/admin.js
// (Artwork Resolver): l'app non sceglie mai un candidato al posto
// dell'admin, sceglie solo tra le opzioni che il resolver ha già trovato.
import { esc } from './core.js';
import { icon } from './icons.js';
import { resolveYgoMarketVariantBySetTemplate } from '../market/providers.js';

const STATUS_LABELS = { ambiguous: 'Ambiguous', conflict: 'Conflict', unresolved: 'Unresolved' };

export function renderMarketVariantPage(model) {
  const { loading, error, queue, hasMore, selections, filters, coverage, candidateMetadata, refreshingMetadata, setTemplates } = model;
  const rows = queue.map(item => marketVariantRow(item, selections.get(item.printingId), candidateMetadata?.get(item.printingId), refreshingMetadata?.has(item.printingId), setTemplates)).join('');
  return `<section class="page-stack admin-page" data-market-variant-page>
    <header class="page-header"><div><span class="eyebrow">Market Variant Resolver</span><h1>Rarity Cardmarket ambigue</h1>
      <p>Stesso set_code, più rarità diverse: il feed Cardmarket non basta a distinguerle da solo. Scegli il prodotto corretto per ciascuna — nessuna scelta automatica.</p></div>
    </header>
    ${renderExactPricingCoverage(coverage)}
    ${renderExactPriceShadowSection(model)}
    ${renderMarketVariantFilters(filters)}
    ${error ? `<div class="admin-error surface">${icon('bell')} ${esc(error)}</div>` : ''}
    ${loading && !queue.length ? '<div class="empty">Caricamento coda...</div>' : ''}
    ${!loading && !queue.length && !error ? '<div class="empty">Nessuna market variant da revisionare con questi filtri.</div>' : ''}
    <div class="admin-variant-queue">${rows}</div>
    ${hasMore ? `<div class="admin-load-more"><button type="button" class="btn secondary" data-variant-load-more ${loading ? 'disabled' : ''}>${loading ? 'Caricamento...' : 'Carica altri'}</button></div>` : ''}
  </section>`;
}

// Micro-feature: lancio manuale di run_ygo_market_variant_price_shadow() su
// printing già resolved/verified (stessa regola di isExactPriceEligible()),
// SOLA diagnostica — nessun prezzo live/Market Watch cambia qui, la RPC
// scrive solo in ygo_market_variant_price_shadow. Sezione separata dalla
// coda di revisione sopra: quella esclude sempre verified=true, questa
// mostra ESATTAMENTE l'opposto.
function renderExactPriceShadowSection(model) {
  const { exactPriceLoading, exactPriceError, exactPriceHasMore, exactPriceRunning, exactPriceSummary } = model;
  const exactPriceQueue = model.exactPriceQueue || [];
  const rows = exactPriceQueue.map(item => exactPriceShadowRow(item, exactPriceRunning)).join('');
  return `<section class="surface admin-variant-shadow-section">
    <header><span class="eyebrow">Solo diagnostica — nessun prezzo live cambia</span><h2>Exact Price Shadow</h2>
      <p>Confronta, per printing già risolte o verificate, il prezzo del prodotto Cardmarket esatto contro quello mostrato oggi in Market Watch. Scrive solo nella shadow table, mai nel pricing live.</p>
    </header>
    ${exactPriceSummary ? renderExactPriceShadowSummary(exactPriceSummary) : ''}
    ${exactPriceError ? `<div class="admin-error surface">${icon('bell')} ${esc(exactPriceError)}</div>` : ''}
    ${exactPriceLoading && !exactPriceQueue.length ? '<div class="empty">Caricamento elenco...</div>' : ''}
    ${!exactPriceLoading && !exactPriceQueue.length && !exactPriceError ? '<div class="empty">Nessuna printing resolved/verified con questi filtri.</div>' : ''}
    <div class="admin-variant-shadow-queue">${rows}</div>
    ${exactPriceHasMore ? `<div class="admin-load-more"><button type="button" class="btn secondary" data-variant-exact-price-load-more ${exactPriceLoading ? 'disabled' : ''}>${exactPriceLoading ? 'Caricamento...' : 'Carica altre'}</button></div>` : ''}
  </section>`;
}

function renderExactPriceShadowSummary(summary) {
  return `<div class="admin-variant-shadow-summary">
    <strong>Exact price shadow completato</strong>
    <dl>
      <div><dt>Printing elaborate</dt><dd>${summary.printingCount}</dd></div>
      <div><dt>Exact disponibili</dt><dd>${summary.exactAvailable}</dd></div>
      <div><dt>Same</dt><dd>${summary.same}</dd></div>
      <div><dt>Close</dt><dd>${summary.close}</dd></div>
      <div><dt>Different</dt><dd>${summary.different}</dd></div>
      <div><dt>Exact mancante</dt><dd>${summary.exactMissing}</dd></div>
      <div><dt>Legacy mancante</dt><dd>${summary.legacyMissing}</dd></div>
    </dl>
  </div>`;
}

function formatEuro(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `€${value.toFixed(2)}` : null;
}

const COMPARISON_STATUS_LABELS = { same: 'SAME', close: 'CLOSE', different: 'DIFFERENT', exact_missing: 'EXACT MANCANTE', legacy_missing: 'LEGACY MANCANTE' };

// Nessun numero inventato: se manca legacy o exact il blocco mostra
// esplicitamente "non disponibile" invece di un delta/percentuale calcolato
// su un valore nullo (classifyPriceComparison lato server già garantisce
// che exact_missing/legacy_missing abbiano precedenza sul calcolo numerico).
function exactPriceShadowResultBlock(item) {
  if (!item.comparisonStatus) return '<p class="admin-variant-shadow-hint">Nessun confronto ancora eseguito.</p>';
  const legacy = formatEuro(item.legacyPrice);
  const exact = formatEuro(item.exactPrice);
  const delta = formatEuro(item.absoluteDelta);
  const deltaPct = typeof item.percentageDelta === 'number' && Number.isFinite(item.percentageDelta) ? `${item.percentageDelta.toFixed(1)}%` : null;
  const statusLabel = COMPARISON_STATUS_LABELS[item.comparisonStatus] || item.comparisonStatus;
  return `<dl class="admin-variant-shadow-result">
    <div><dt>Legacy</dt><dd>${legacy ?? 'non disponibile'}</dd></div>
    <div><dt>Exact</dt><dd>${exact ?? 'non disponibile'}</dd></div>
    <div><dt>Delta</dt><dd>${delta ?? '—'}</dd></div>
    <div><dt>Delta %</dt><dd>${deltaPct ?? '—'}</dd></div>
    <div><dt>Status</dt><dd><b class="admin-variant-badge is-${esc(item.comparisonStatus)}">${esc(statusLabel)}</b></dd></div>
  </dl>`;
}

function exactPriceShadowRow(item, runningSet) {
  const isRunning = runningSet?.has?.(item.printingId);
  return `<article class="admin-variant-card surface" data-variant-exact-price-card="${esc(item.printingId)}">
    <header>
      <div>
        <strong>${esc(item.cardName || 'Nome sconosciuto')}</strong>
        <span>${esc(item.setCode)}${item.setName ? ' · ' + esc(item.setName) : ''}${item.rarity ? ' · ' + esc(item.rarity) : ''}</span>
      </div>
      <div class="admin-variant-usage">${icon('collection')} ${esc(usageLabel(item))}</div>
    </header>
    <div class="admin-variant-meta">
      <span class="admin-variant-badge is-${item.verified ? 'verified' : 'resolved'}">${item.verified ? 'Verified' : 'Resolved'}</span>
      <span class="admin-variant-candidate-id">product_id ${esc(item.cardmarketProductId)}</span>
      <span class="admin-variant-reason">${esc(item.mappingSource || '')}</span>
    </div>
    ${exactPriceShadowResultBlock(item)}
    <footer>
      <button type="button" class="btn secondary" data-variant-run-exact-price data-variant-printing-id="${esc(item.printingId)}" ${isRunning ? 'disabled' : ''}>${isRunning ? 'Confronto prezzi in corso…' : 'Confronta prezzo esatto'}</button>
    </footer>
  </article>`;
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

// meta.fetch_status: pending/undefined (mai richiesto) | resolved | incomplete
// | not_found | blocked | parse_error — vedi market/providers.js:
// classifyCandidateMetadataFetchOutcome(). Nessuno di questi stati mostra mai
// una rarity inventata: se non è nota resta "non ancora acquisita"/lo stato
// del fetch, punto.
function candidateMetadataLine(productId, meta) {
  if (!meta || !meta.fetch_status || meta.fetch_status === 'pending') {
    return `<span class="admin-variant-candidate-id">${esc(productId)}</span><small class="admin-variant-candidate-hint">Rarity: non ancora acquisita</small>`;
  }
  if (meta.fetch_status !== 'resolved' && meta.fetch_status !== 'incomplete') {
    const label = { not_found: 'Prodotto non trovato', blocked: 'Fetch bloccato dal provider', parse_error: 'Pagina non leggibile' }[meta.fetch_status] || meta.fetch_status;
    return `<span class="admin-variant-candidate-id">${esc(productId)}</span><small class="admin-variant-candidate-hint">${esc(label)}</small>`;
  }
  const matchBadge = meta.rarity_match === 'exact_match'
    ? '<b class="admin-variant-match is-match">MATCH</b>'
    : meta.rarity_match === 'mismatch' ? '<b class="admin-variant-match is-mismatch">MISMATCH</b>' : '';
  const detailParts = [meta.rarity_raw || 'Rarity non riconosciuta', meta.variant_number ? `V.${meta.variant_number}` : '', meta.expansion_name || ''].filter(Boolean);
  return `<span class="admin-variant-candidate-id">${esc(productId)}</span> ${matchBadge}<small>${esc(detailParts.join(' · '))}</small>`;
}

// Resolver deterministico V.n->rarity (RA01/RA02 per ora) applicato lato
// client con la STESSA funzione pura del server (market/providers.js) —
// nessuna logica duplicata, solo un suggerimento visivo. NON auto-conferma
// mai: l'admin deve comunque premere "Conferma selezionato" per persistere
// qualunque cosa (vedi sezione 17 del task: confirm resta l'unica autorità).
function autoMatchBlock(item, setTemplates) {
  const match = resolveYgoMarketVariantBySetTemplate({
    setCode: item.setCode, rarityCanonical: item.rarityCanonical,
    candidateProductIds: item.candidateProductIds || [], setTemplates: setTemplates || []
  });
  if (!match) return '';
  return `<div class="admin-variant-auto-match">
    <span class="admin-variant-badge is-auto-match">SET TEMPLATE MATCH</span>
    <dl>
      <div><dt>Set template</dt><dd>${esc(match.setPrefix)}</dd></div>
      <div><dt>FPT rarity</dt><dd>${esc(item.rarity || item.rarityCanonical || '')}</dd></div>
      <div><dt>Variant</dt><dd>V.${match.variantNumber}</dd></div>
      <div><dt>Selected Cardmarket product</dt><dd>${esc(match.productId)}</dd></div>
      <div><dt>Source</dt><dd>Verified set template</dd></div>
    </dl>
  </div>`;
}

function marketVariantRow(item, selectedProductId, metadata, isRefreshingMetadata, setTemplates) {
  const candidateIds = item.candidateProductIds || [];
  const metadataByProduct = new Map((metadata?.candidates || []).map(candidate => [candidate.product_id, candidate]));
  const candidates = candidateIds.map(productId => {
    const isSelected = selectedProductId === productId;
    return `<label class="admin-variant-candidate ${isSelected ? 'is-selected' : ''}">
      <input type="radio" name="variant-candidate-${esc(item.printingId)}" data-variant-candidate
        data-variant-printing-id="${esc(item.printingId)}" data-variant-product-id="${esc(productId)}" ${isSelected ? 'checked' : ''}>
      <div class="admin-variant-candidate-info">${candidateMetadataLine(productId, metadataByProduct.get(productId))}</div>
      <a href="https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(productId)}" target="_blank" rel="noopener noreferrer" class="text-action">Apri pagina ${icon('arrow')}</a>
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
    ${autoMatchBlock(item, setTemplates)}
    <div class="admin-variant-candidates">${candidates || '<p class="empty">Nessun candidato: esegui prima il resolver (canary) su questa printing.</p>'}</div>
    <footer>
      <button type="button" class="btn secondary" data-variant-refresh-metadata data-variant-printing-id="${esc(item.printingId)}" ${candidateIds.length && !isRefreshingMetadata ? '' : 'disabled'}>${isRefreshingMetadata ? 'Aggiornamento...' : 'Aggiorna metadata candidati'}</button>
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
    const refreshMetadataButton = event.target.closest('[data-variant-refresh-metadata]');
    if (refreshMetadataButton && !refreshMetadataButton.disabled) { handlers.onRefreshMetadata(refreshMetadataButton.dataset.variantPrintingId); return; }
    const loadMore = event.target.closest('[data-variant-load-more]');
    if (loadMore && !loadMore.disabled) { handlers.onLoadMore(); return; }
    const runExactPrice = event.target.closest('[data-variant-run-exact-price]');
    if (runExactPrice && !runExactPrice.disabled) { handlers.onRunExactPriceShadow(runExactPrice.dataset.variantPrintingId); return; }
    const exactPriceLoadMore = event.target.closest('[data-variant-exact-price-load-more]');
    if (exactPriceLoadMore && !exactPriceLoadMore.disabled) handlers.onLoadMoreExactPrice();
  });
  page.querySelector('[data-variant-filter-query]')?.addEventListener('input', event => handlers.onFilterChange('query', event.target.value));
  page.querySelector('[data-variant-filter-used-only]')?.addEventListener('change', event => handlers.onFilterChange('usedOnly', event.target.checked));
}
