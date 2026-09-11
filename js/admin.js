// Admin Artwork Resolver — pannello interno per i casi multi-artwork del
// Yu-Gi-Oh! Printing Registry (js/ygo-printing-registry.js): identità carta
// certa, ma più artwork Konami validi e nessuna fonte automatica dice quale
// appartenga a quale stampa. Qui l'admin sceglie, l'app non indovina mai.
//
// Sola lettura/scrittura tramite RPC admin-gated (list_ygo_artwork_review_queue,
// upsert_ygo_printing_override): un membro non-admin non vede nemmeno la voce
// di menu (state.role in app.js) e le RPC rifiutano comunque lato server.
import { esc } from './core.js';
import { icon } from './icons.js';

export function renderAdminPage(model) {
  const { loading, error, queue, hasMore, selections } = model;
  const rows = queue.map(item => artworkQueueRow(item, selections.get(item.setCode))).join('');
  return `<section class="page-stack admin-page">
    <header class="page-header"><div><span class="eyebrow">Admin</span><h1>Artwork Resolver</h1>
      <p>Printing con identità carta certa ma più artwork Konami validi. Nessuna scelta automatica: seleziona l'artwork corretto e conferma.</p></div>
    </header>
    ${error ? `<div class="admin-error surface">${icon('bell')} ${esc(error)}</div>` : ''}
    ${loading && !queue.length ? '<div class="empty">Caricamento coda...</div>' : ''}
    ${!loading && !queue.length && !error ? '<div class="empty">Nessuna printing multi-artwork da revisionare.</div>' : ''}
    <div class="admin-artwork-queue">${rows}</div>
    ${hasMore ? `<div class="admin-load-more"><button type="button" class="btn secondary" data-admin-load-more ${loading ? 'disabled' : ''}>${loading ? 'Caricamento...' : 'Carica altri'}</button></div>` : ''}
  </section>`;
}

function artworkQueueRow(item, selected) {
  const usage = [
    item.collectionUsage ? `${item.collectionUsage} in raccolta` : '',
    item.deckUsage ? `${item.deckUsage} in mazzi` : '',
    item.loanUsage ? `${item.loanUsage} in prestiti` : ''
  ].filter(Boolean).join(' · ') || 'Non ancora posseduta da nessuno';
  const candidates = (item.candidates || []).map(candidate => {
    const isSelected = selected?.index === candidate.index;
    return `<button type="button" class="admin-artwork-candidate ${isSelected ? 'is-selected' : ''}"
      data-artwork-candidate data-artwork-set-code="${esc(item.setCode)}" data-artwork-index="${esc(candidate.index)}" data-artwork-url="${esc(candidate.url)}">
      <img src="${esc(candidate.url)}" alt="Artwork ${esc(candidate.index)}" loading="lazy">
      <small>#${esc(candidate.index)}</small>
    </button>`;
  }).join('');
  return `<article class="admin-artwork-card surface" data-admin-artwork-card="${esc(item.setCode)}">
    <header>
      <div><strong>${esc(item.setCode)}</strong><span>${esc(item.cardName || 'Nome sconosciuto')}</span></div>
      <div class="admin-artwork-usage" title="${esc(usage)}">${icon('collection')} ${esc(usage)}</div>
    </header>
    <div class="admin-artwork-meta"><span>Konami ID: ${esc(item.konamiCardId)}</span><span>${item.artworkCount} artwork noti</span></div>
    <div class="admin-artwork-candidates">${candidates || '<p class="empty">Nessun candidato sincronizzato.</p>'}</div>
    <footer>
      <button type="button" class="btn" data-artwork-confirm data-artwork-set-code="${esc(item.setCode)}" ${selected ? '' : 'disabled'}>
        ${icon('check') || ''} Conferma artwork selezionato
      </button>
    </footer>
  </article>`;
}

export function bindAdminPage(root, model, handlers) {
  const page = root.querySelector('.admin-page');
  if (!page) return;
  page.addEventListener('click', event => {
    const candidate = event.target.closest('[data-artwork-candidate]');
    if (candidate) {
      handlers.onSelectCandidate(candidate.dataset.artworkSetCode, candidate.dataset.artworkIndex, candidate.dataset.artworkUrl);
      return;
    }
    const confirmButton = event.target.closest('[data-artwork-confirm]');
    if (confirmButton && !confirmButton.disabled) { handlers.onConfirm(confirmButton.dataset.artworkSetCode); return; }
    const loadMore = event.target.closest('[data-admin-load-more]');
    if (loadMore && !loadMore.disabled) handlers.onLoadMore();
  });
}
