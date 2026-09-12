// Artwork Resolver — pannello per i casi multi-artwork del Yu-Gi-Oh!
// Printing Registry (js/ygo-printing-registry.js): identità carta certa, ma
// più artwork Konami validi e nessuna fonte automatica dice quale
// appartenga a quale stampa. Qui un admin o un Artwork Curator sceglie,
// l'app non indovina mai.
//
// Accesso: admin O can_verify_ygo_artwork (state.canVerifyYgoArtwork in
// app.js) — entrambi vedono la stessa coda; le RPC (list_ygo_artwork_review_queue,
// confirm_ygo_printing_artwork) applicano lo stesso controllo lato server,
// quindi nascondere la voce di menu a un membro normale è solo UX, non
// l'unica barriera.
import { esc } from './core.js';
import { icon } from './icons.js';

export function renderAdminPage(model) {
  const { loading, error, queue, hasMore, selections, filters, setPrefixes, view, history, historyLoading, isAdmin } = model;
  if (view === 'history') return renderHistoryView(model);

  const rows = queue.map(item => artworkQueueRow(item, selections.get(item.setCode), isAdmin)).join('');
  return `<section class="page-stack admin-page">
    <header class="page-header"><div><span class="eyebrow">Artwork Resolver</span><h1>Printing multi-artwork</h1>
      <p>Identità carta certa, più artwork Konami validi: scegli quello corretto e conferma. Nessuna scelta automatica.</p></div>
      <button type="button" class="btn secondary" data-admin-view-history>${icon('collection')} Il mio storico</button>
    </header>
    ${renderFilters(filters, setPrefixes)}
    ${error ? `<div class="admin-error surface">${icon('bell')} ${esc(error)}</div>` : ''}
    ${loading && !queue.length ? '<div class="empty">Caricamento coda...</div>' : ''}
    ${!loading && !queue.length && !error ? '<div class="empty">Nessuna printing da revisionare con questi filtri.</div>' : ''}
    <div class="admin-artwork-queue">${rows}</div>
    ${hasMore ? `<div class="admin-load-more"><button type="button" class="btn secondary" data-admin-load-more ${loading ? 'disabled' : ''}>${loading ? 'Caricamento...' : 'Carica altri'}</button></div>` : ''}
  </section>`;
}

function renderFilters(filters, setPrefixes) {
  const chips = (setPrefixes || []).slice(0, 12).map(p => `<button type="button" class="admin-prefix-chip ${filters.setPrefix === p.set_prefix ? 'active' : ''}" data-admin-prefix-chip="${esc(p.set_prefix)}">${esc(p.set_prefix)} <b>${p.unresolved_count}</b></button>`).join('');
  return `<section class="surface admin-filters">
    <div class="admin-filters-row">
      <label class="admin-filter-search">${icon('search')}<input type="search" data-admin-filter-query placeholder="Cerca per nome carta o set_code..." value="${esc(filters.query)}"></label>
      <input type="text" class="admin-filter-prefix" data-admin-filter-prefix placeholder="Prefisso set (es. L26D)" value="${esc(filters.setPrefix)}" maxlength="10">
      <select data-admin-filter-order>
        <option value="usage_count" ${filters.orderBy === 'usage_count' ? 'selected' : ''}>Più usate prima</option>
        <option value="set_code" ${filters.orderBy === 'set_code' ? 'selected' : ''}>Set code</option>
        <option value="card_name" ${filters.orderBy === 'card_name' ? 'selected' : ''}>Nome carta</option>
      </select>
      <label class="admin-filter-toggle"><input type="checkbox" data-admin-filter-used-only ${filters.usedOnly ? 'checked' : ''}> Solo usate</label>
    </div>
    ${chips ? `<div class="admin-prefix-chips">${chips}${filters.setPrefix ? '<button type="button" class="admin-prefix-chip is-clear" data-admin-prefix-chip="">Tutti</button>' : ''}</div>` : ''}
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

function artworkQueueRow(item, selected, isAdmin) {
  const candidates = (item.candidates || []).map(candidate => {
    const isSelected = selected?.index === candidate.index;
    const isCurrent = item.currentArtworkUrl && item.currentArtworkUrl === candidate.url;
    return `<button type="button" class="admin-artwork-candidate ${isSelected ? 'is-selected' : ''}"
      data-artwork-candidate data-artwork-set-code="${esc(item.setCode)}" data-artwork-index="${esc(candidate.index)}" data-artwork-url="${esc(candidate.url)}">
      <img src="${esc(candidate.url)}" alt="Artwork ${esc(candidate.index)}" loading="lazy">
      <small>#${esc(candidate.index)}${isCurrent ? ' · attuale' : ''}</small>
    </button>`;
  }).join('');
  const rarities = (item.rarities || []).filter(Boolean).join(', ');
  const setNames = (item.setNames || []).filter(Boolean).join(', ');
  return `<article class="admin-artwork-card surface" data-admin-artwork-card="${esc(item.setCode)}">
    <header>
      <div>
        <strong>${esc(item.cardName || 'Nome sconosciuto')}</strong>
        <span>${esc(item.setCode)}${setNames ? ' · ' + esc(setNames) : ''}${rarities ? ' · ' + esc(rarities) : ''}</span>
      </div>
      <div class="admin-artwork-usage">${icon('collection')} ${esc(usageLabel(item))}</div>
    </header>
    <div class="admin-artwork-meta"><span>Konami ID: ${esc(item.konamiCardId)}</span><span>${item.artworkCount} artwork noti</span></div>
    <div class="admin-artwork-candidates">${candidates || '<p class="empty">Nessun candidato sincronizzato.</p>'}</div>
    <footer>
      <button type="button" class="btn secondary" data-artwork-confirm data-artwork-set-code="${esc(item.setCode)}" ${selected ? '' : 'disabled'}>Conferma</button>
      <button type="button" class="btn" data-artwork-confirm-next data-artwork-set-code="${esc(item.setCode)}" ${selected ? '' : 'disabled'}>${icon('check') || ''} Conferma e prossima</button>
    </footer>
  </article>`;
}

function renderHistoryView(model) {
  const rows = (model.history || []).map(entry => `<article class="admin-history-row surface">
    <div><strong>${esc(entry.setCode)}</strong><span>Konami ${esc(entry.konamiCardId)}</span></div>
    <div>${entry.previousArtworkIndex ? `#${esc(entry.previousArtworkIndex)} → ` : ''}#${esc(entry.newArtworkIndex)}</div>
    <div><span class="admin-history-source">${entry.verificationSource === 'admin_manual' ? 'Admin' : 'Curator'}</span><time>${esc(new Date(entry.verifiedAt).toLocaleString('it-IT'))}</time></div>
  </article>`).join('');
  return `<section class="page-stack admin-page">
    <header class="page-header"><div><span class="eyebrow">Artwork Resolver</span><h1>Storico di ${esc(model.currentUserName || 'te')}</h1>
      <p>${model.isAdmin ? 'Verified by Admin' : 'Verified by Curator'} · ${model.history?.length || 0} verifiche</p></div>
      <button type="button" class="btn secondary" data-admin-view-queue>${icon('arrow')} Torna alla coda</button>
    </header>
    ${model.historyLoading ? '<div class="empty">Caricamento...</div>' : ''}
    ${!model.historyLoading && !rows ? '<div class="empty">Nessuna verifica ancora effettuata.</div>' : ''}
    <div class="admin-history-list">${rows}</div>
  </section>`;
}

export function bindAdminPage(root, model, handlers) {
  const page = root.querySelector('.admin-page');
  if (!page) return;
  page.addEventListener('click', event => {
    if (event.target.closest('[data-admin-view-history]')) { handlers.onViewHistory(); return; }
    if (event.target.closest('[data-admin-view-queue]')) { handlers.onViewQueue(); return; }
    const chip = event.target.closest('[data-admin-prefix-chip]');
    if (chip) { handlers.onFilterChange('setPrefix', chip.dataset.adminPrefixChip); return; }
    const candidate = event.target.closest('[data-artwork-candidate]');
    if (candidate) { handlers.onSelectCandidate(candidate.dataset.artworkSetCode, candidate.dataset.artworkIndex, candidate.dataset.artworkUrl); return; }
    const confirmButton = event.target.closest('[data-artwork-confirm]');
    if (confirmButton && !confirmButton.disabled) { handlers.onConfirm(confirmButton.dataset.artworkSetCode, false); return; }
    const confirmNextButton = event.target.closest('[data-artwork-confirm-next]');
    if (confirmNextButton && !confirmNextButton.disabled) { handlers.onConfirm(confirmNextButton.dataset.artworkSetCode, true); return; }
    const loadMore = event.target.closest('[data-admin-load-more]');
    if (loadMore && !loadMore.disabled) handlers.onLoadMore();
  });
  page.querySelector('[data-admin-filter-query]')?.addEventListener('input', event => handlers.onFilterChange('query', event.target.value));
  page.querySelector('[data-admin-filter-prefix]')?.addEventListener('change', event => handlers.onFilterChange('setPrefix', event.target.value));
  page.querySelector('[data-admin-filter-order]')?.addEventListener('change', event => handlers.onFilterChange('orderBy', event.target.value));
  page.querySelector('[data-admin-filter-used-only]')?.addEventListener('change', event => handlers.onFilterChange('usedOnly', event.target.checked));
}
