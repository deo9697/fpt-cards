import { esc } from './core.js';
import { icon } from './icons.js';

const STATUS_CHIPS = [
  { value:'all', label:'Tutte' },
  { value:'available', label:'Disponibili' },
  { value:'partial', label:'Parziali' },
  { value:'unavailable', label:'Non disponibili' }
];
const SORT_OPTIONS = [
  { value:'name-asc', label:'A–Z' },
  { value:'name-desc', label:'Z–A' },
  { value:'available-desc', label:'Più disponibili' },
  { value:'quantity-desc', label:'Più possedute' }
];

export function collectionView(collection, filters, game, connected, error = '') {
  const mine = (collection.mine || []).filter(item => item.game === game);
  const team = (collection.team || []).filter(item => item.game === game);
  const owners = [...new Map(team.map(item => [item.ownerSlug, item.ownerName])).entries()];

  return `<section class="page-stack collection-page">
    <header class="page-header split"><div><span class="eyebrow">Inventario persistente</span><h1>Raccolta</h1><p>Carte possedute e copie realmente disponibili per il team.</p></div><div class="actions collection-add-actions"><button class="btn secondary" data-fast-scan>${icon('search')} Scansione rapida</button><button class="btn" data-collection-add ${connected ? '' : 'disabled title="Disponibile quando torni online"'}>${icon('plus')} Aggiungi carta</button></div></header>
    ${error ? `<div class="connection-banner error">${icon('bell')} ${esc(error)} <button id="retry-collection">Riprova</button></div>` : ''}
    ${!connected ? `<div class="connection-banner offline">Sei offline · mostro l’ultima raccolta sincronizzata. Le modifiche sono disabilitate.</div>` : ''}
    <section class="surface collection-surface inventory-surface">
      <div class="tabs" role="tablist" aria-label="Ambito raccolta"><button type="button" data-collection-scope="mine" class="${filters.scope === 'mine' ? 'active' : ''}" role="tab" aria-selected="${filters.scope === 'mine'}">La mia raccolta <span>${mine.length}</span></button><button type="button" data-collection-scope="team" class="${filters.scope === 'team' ? 'active' : ''}" role="tab" aria-selected="${filters.scope === 'team'}">Raccolta team <span>${team.length}</span></button></div>
      <div class="collection-toolbar inventory-toolbar">
        <label class="filter-search sticky-search">${icon('search')}<input type="search" data-collection-query placeholder="Cerca carta, set o codice…" value="${esc(filters.query)}" aria-label="Cerca nella raccolta"></label>
        <div class="inventory-filter-row">
          <div class="filter-chips" role="group" aria-label="Disponibilità">${STATUS_CHIPS.map(chip => `<button type="button" class="chip ${filters.status === chip.value ? 'active' : ''}" data-collection-status-chip="${chip.value}">${chip.label}</button>`).join('')}</div>
          ${filters.scope === 'team' ? `<select id="collection-owner" aria-label="Proprietario"><option value="all">Tutti</option>${owners.map(([id,name]) => `<option value="${esc(id)}" ${filters.owner === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>` : ''}
        </div>
        <div class="inventory-sort-row">
          <select id="collection-sort" aria-label="Ordina">${SORT_OPTIONS.map(option => `<option value="${option.value}" ${filters.sort === option.value ? 'selected' : ''}>Ordina: ${option.label}</option>`).join('')}</select>
          <div class="view-toggle" aria-label="Visualizzazione"><button type="button" data-collection-layout="grid" class="${filters.layout === 'grid' ? 'active' : ''}" aria-label="Griglia">▦</button><button type="button" data-collection-layout="list" class="${filters.layout === 'list' ? 'active' : ''}" aria-label="Lista">☷</button></div>
        </div>
      </div>
      <div data-collection-results>${collectionResultsView(collection, filters, game, connected)}</div>
    </section>
  </section>`;
}

export function collectionResultsView(collection, filters, game, connected) {
  const mine = (collection.mine || []).filter(item => item.game === game);
  const team = (collection.team || []).filter(item => item.game === game);
  const source = filters.scope === 'mine' ? mine : groupTeamItems(team);
  const visible = sortItems(source.filter(item => matches(item, filters)), filters.sort);
  return `${visible.length ? `<div class="inventory-grid ${filters.layout === 'list' ? 'list' : ''}">${visible.map(item => inventoryCard(item, filters.scope)).join('')}</div>` : emptyState(source.length, filters.scope, connected)}
    <div class="collection-count"><strong>${visible.length}</strong> printing · disponibilità calcolata dai prestiti</div>`;
}

export function collectionDetailView(id, scope, collection, connected, currentUser = '') {
  const mine = collection.mine || [];
  const team = collection.team || [];
  const item = scope === 'mine' ? mine.find(entry => entry.id === id) : groupTeamItems(team).find(entry => entry.id === id);
  if (!item) return '';
  const rows = scope === 'team' ? item.items : team.filter(entry => entry.printingId === item.printingId);
  const meta = [item.setCode, item.rarity, item.language, item.condition, item.edition].filter(Boolean);
  return `<div class="detail-backdrop" data-close-collection-detail><aside class="card-detail inventory-detail" role="dialog" aria-modal="true" aria-labelledby="collection-detail-title"><button class="detail-close" data-close-collection-detail aria-label="Chiudi">×</button>
    <div class="detail-layout"><div class="detail-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.cardName)}">` : icon('card')}</div><div class="detail-copy"><span class="eyebrow">${scope === 'mine' ? 'La mia raccolta' : 'Raccolta team'}</span><h2 id="collection-detail-title">${esc(item.cardName)}</h2><p>${meta.length ? meta.map(esc).join(' · ') : 'Printing senza metadati aggiuntivi'}</p>
      <dl>${scope === 'mine' ? quantityDefinition(item) : `<div><dt>In prestito</dt><dd>${item.quantityLoaned}</dd></div><div><dt>Prenotate</dt><dd>${item.quantityReserved}</dd></div><div><dt>Disponibili</dt><dd>${item.quantityAvailable}</dd></div>`}</dl>
      ${item.legacyAmbiguous ? `<div class="data-note warning">${icon('bell')} Esistono vecchi prestiti non attribuibili con certezza a questa printing: non sono stati sottratti automaticamente.</div>` : ''}
      ${scope === 'team' ? `<h3>Disponibilità nel team</h3><div class="team-availability">${rows.map(row => ownerAvailability(row, connected, currentUser)).join('')}</div><div class="actions"><button class="btn secondary" data-market-watch-add="${esc(item.printingId)}" ${connected?'':'disabled'}>${icon('chart')} Segui printing</button></div>` : `<div class="actions"><button class="btn" data-collection-loan="${esc(item.id)}" ${item.quantityAvailable > 0 && connected ? '' : 'disabled'}>${icon('swap')} Crea prestito</button><button class="btn secondary" data-market-watch-add="${esc(item.printingId)}" ${connected?'':'disabled'}>${icon('chart')} Segui</button><button class="btn secondary" data-collection-edit="${esc(item.id)}" ${connected ? '' : 'disabled'}>Modifica</button><button class="btn secondary danger" data-collection-delete="${esc(item.id)}" ${connected ? '' : 'disabled'}>Rimuovi</button></div>`}
    </div></div>
  </aside></div>`;
}

export function collectionLoanRequestView(item, connected) {
  if (!item) return '';
  const disabled = !connected || item.quantityAvailable < 1 || item.legacyAmbiguous;
  return `<div class="detail-backdrop" data-close-collection-request><aside class="card-detail collection-request" role="dialog" aria-modal="true" aria-labelledby="collection-request-title"><button class="detail-close" data-close-collection-request aria-label="Chiudi">×</button>
    <span class="eyebrow">Richiesta dalla Raccolta Team</span><h2 id="collection-request-title">Richiedi ${esc(item.cardName)}</h2>
    <div class="selected-catalog-card">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="">` : icon('card')}<span><strong>${esc(item.cardName)}</strong><small>${esc([item.setCode,item.setName,item.rarity].filter(Boolean).join(' · ') || 'Printing non specificata')}</small></span></div>
    <p>Proprietario: <strong>${esc(item.ownerName)}</strong> · ${item.quantityAvailable} ${item.quantityAvailable === 1 ? 'copia disponibile' : 'copie disponibili'}</p>
    ${item.legacyAmbiguous ? `<div class="data-note warning">${icon('bell')} Printing ambigua per prestiti storici: richiesta disabilitata.</div>` : ''}
    <form id="collection-request-form"><label>Quantità richiesta<input id="collection-request-quantity" type="number" min="1" max="${item.quantityAvailable}" value="1" required></label><label>Nota facoltativa<textarea id="collection-request-notes" maxlength="500" rows="3" placeholder="Dettagli per il proprietario…"></textarea></label><button class="btn wide" type="submit" ${disabled ? 'disabled' : ''}>${icon('swap')} Invia richiesta</button></form>
  </aside></div>`;
}

export function collectionEditorView(editor, game, connected) {
  if (!editor) return '';
  const item = editor.item;
  const card = editor.card;
  const selected = card || (item ? {
    id:item.catalogCardId, name:item.cardName, image:item.imageUrl,
    printings:[{ setCode:item.setCode, setName:item.setName, rarity:item.rarity }]
  } : null);
  const printings = collectionPrintingOptions(selected);
  const selectedPrinting = Object.hasOwn(editor, 'printing')
    ? editor.printing
    : printings.find(printing => samePrinting(printing, item)) || null;
  const selectedSetCode = editor.setCode ?? selectedPrinting?.setCode ?? printings[0]?.setCode ?? '';
  const sets = [...new Map(printings.map(printing => [normalizeSetCode(printing.setCode), printing])).values()];
  const rarities = printings.filter(printing => normalizeSetCode(printing.setCode) === normalizeSetCode(selectedSetCode));
  const edition = item?.edition || '';
  const firstEdition = isFirstEdition(edition);
  const editionStatus = editionState(edition);
  const owned = item?.quantityOwned ?? 1;
  return `<div class="detail-backdrop" data-close-collection-editor><aside class="card-detail collection-editor" role="dialog" aria-modal="true" aria-labelledby="collection-editor-title"><button class="detail-close" data-close-collection-editor aria-label="Chiudi">×</button><span class="eyebrow">${item ? 'Modifica inventario' : 'Nuova carta'}</span><h2 id="collection-editor-title">${item ? esc(item.cardName) : 'Aggiungi alla raccolta'}</h2>
    <form id="collection-form">
      <label for="collection-card-search">Carta dal catalogo</label><div class="catalog-search"><input id="collection-card-search" autocomplete="off" value="${selected ? esc(selected.name) : ''}" placeholder="Cerca almeno 3 caratteri…" ${item ? 'disabled' : 'required'}><div id="collection-card-suggestions" class="suggestions"></div></div>
      ${selected ? `<div class="selected-catalog-card">${selected.image ? `<img src="${esc(selected.image)}" alt="">` : icon('card')}<span><strong>${esc(selected.name)}</strong><small>ID ${esc(selected.id)}</small></span></div>
      <div class="printing-editor-grid"><label for="collection-set">Set / codice<select id="collection-set">${sets.map(printing => `<option value="${esc(printing.setCode)}" ${normalizeSetCode(printing.setCode) === normalizeSetCode(selectedSetCode) ? 'selected' : ''}>${esc([printing.setCode || 'Set non specificato', printing.setName].filter(Boolean).join(' · '))}</option>`).join('')}</select></label><label for="collection-rarity">Rarità<select id="collection-rarity" ${rarities.length ? '' : 'disabled'}>${rarities.length > 1 && !selectedPrinting ? '<option value="" selected>Scegli la rarità…</option>' : ''}${rarities.map(printing => `<option value="${esc(printing.rarity)}" ${selectedPrinting && samePrinting(printing, selectedPrinting) ? 'selected' : ''}>${esc(printing.rarity || 'Non specificata')}</option>`).join('')}</select></label></div>
      ${rarities.length > 1 && !selectedPrinting ? `<div class="data-note warning">${icon('bell')} Questo set contiene più rarità: seleziona esplicitamente quella posseduta.</div>` : ''}
      <div class="printing-preview"><span><small>Codice set</small><b>${esc(selectedPrinting?.setCode || selectedSetCode || 'Non specificato')}</b></span><span><small>Set</small><b>${esc(selectedPrinting?.setName || rarities[0]?.setName || 'Non specificato')}</b></span><span><small>Rarità selezionata</small><b>${esc(selectedPrinting?.rarity || 'Da selezionare')}</b></span></div>` : `<div class="catalog-required">${icon('search')} Cerca e seleziona una carta per continuare.</div>`}
      <div class="inventory-form-grid"><label>Quantità posseduta<input id="collection-owned" type="number" min="1" max="999" value="${owned}" required></label><label>Lingua<select id="collection-language">${['Italiano','Inglese','Giapponese','Francese','Tedesco','Spagnolo'].map(value => `<option ${value === (item?.language || 'Italiano') ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Condizione<select id="collection-condition">${['Mint','Near Mint','Excellent','Good','Played','Poor'].map(value => `<option ${value === (item?.condition || 'Near Mint') ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="wide-field edition-flag"><input id="collection-first-edition" type="checkbox" data-edition-touched="false" data-edition-original="${esc(edition)}" ${firstEdition ? 'checked' : ''}><span><strong>Prima Edizione</strong><small data-edition-status>${editionStatus === 'first' ? 'Prima Edizione' : editionStatus === 'unlimited' ? 'Non Prima Edizione / Unlimited' : 'Non specificata'}</small></span></label></div>
      <p class="quantity-help">La disponibilità fisica viene calcolata automaticamente sottraendo copie prestate e prenotate.</p>
      <div id="collection-save-status" class="collection-save-status" role="status" aria-live="polite" hidden></div>
      <button class="btn wide" type="submit" ${selected && selectedPrinting && connected ? '' : 'disabled'}>Salva nella raccolta</button>
    </form>
  </aside></div>`;
}

export function isFirstEdition(value) {
  return editionState(value) === 'first';
}

export function editionState(value) {
  const source = String(value ?? '').trim();
  if (!source) return 'unspecified';
  const normalized = source.toLocaleLowerCase('it').replace(/[^a-z0-9]+/g, '');
  return ['1','1ed','1edizione','1edition','1sted','1stedition','primaedizione','firstedition'].includes(normalized)
    ? 'first'
    : ['unlimited','unlimitededition','illimitata','edizioneillimitata','nonprimaedizione','nonfirstedition'].includes(normalized) ? 'unlimited' : 'unspecified';
}

export function editionFromFirstEditionFlag({ checked = false, touched = false, original = '' } = {}) {
  if (!touched) return String(original ?? '');
  return checked ? 'Prima Edizione' : 'Unlimited';
}

export function persistedCollectionItemMatches(item, expected = {}) {
  if (!item?.printingId) return false;
  return normalizeSetCode(item.setCode) === normalizeSetCode(expected.setCode)
    && (!expected.setName || String(item.setName || '').trim() === String(expected.setName).trim())
    && normalizeRarity(item.rarity) === normalizeRarity(expected.rarity)
    && item.language === expected.language
    && item.condition === expected.condition
    && item.edition === expected.edition
    && Number(item.quantityOwned) === Number(expected.quantityOwned)
    && (!expected.printingId || item.printingId === expected.printingId);
}

export function collectionPrintingOptions(card) {
  const rows = card?.printings?.length ? card.printings : [{ setCode:'', setName:'', rarity:'' }];
  return [...new Map(rows.map(printing => {
    const normalized = {
      setCode:String(printing.setCode || '').trim().toUpperCase(),
      setName:String(printing.setName || '').trim(),
      rarity:String(printing.rarity || '').trim()
    };
    return [`${normalizeSetCode(normalized.setCode)}\u0000${normalized.rarity.toLocaleLowerCase('it')}`, normalized];
  })).values()];
}

export function selectCollectionEditorPrinting(card, setCode, rarity = '') {
  const options = collectionPrintingOptions(card).filter(printing => normalizeSetCode(printing.setCode) === normalizeSetCode(setCode));
  const exact = options.find(printing => normalizeRarity(printing.rarity) === normalizeRarity(rarity));
  return exact || (options.length === 1 ? options[0] : null);
}

function normalizeSetCode(value) { return String(value || '').trim().toUpperCase(); }
function normalizeRarity(value) { return String(value || '').trim().toLocaleLowerCase('it'); }
function samePrinting(left, right) {
  return Boolean(left && right)
    && normalizeSetCode(left.setCode) === normalizeSetCode(right.setCode)
    && normalizeRarity(left.rarity) === normalizeRarity(right.rarity);
}

function groupTeamItems(items) {
  const groups = new Map();
  items.forEach(item => {
    const key = item.printingId;
    if (!groups.has(key)) groups.set(key, { ...item, id:key, items:[], quantityLoaned:0, quantityReserved:0, quantityAvailable:0, ownerSlug:'all', ownerName:'Team' });
    const group = groups.get(key);
    group.items.push(item);
    group.quantityLoaned += item.quantityLoaned;
    group.quantityReserved += item.quantityReserved;
    group.quantityAvailable += item.quantityAvailable;
    group.legacyAmbiguous ||= item.legacyAmbiguous;
  });
  return [...groups.values()];
}

function matches(item, filters) {
  const needle = filters.query.trim().toLowerCase();
  const text = [item.cardName,item.setCode,item.setName,item.rarity].join(' ').toLowerCase();
  const queryOk = !needle || text.includes(needle);
  const ownerOk = filters.owner === 'all' || item.ownerSlug === filters.owner || item.items?.some(entry => entry.ownerSlug === filters.owner);
  const committed = item.quantityLoaned + item.quantityReserved;
  const statusOk = filters.status === 'all'
    || (filters.status === 'available' && item.quantityAvailable > 0)
    || (filters.status === 'partial' && item.quantityAvailable > 0 && committed > 0)
    || (filters.status === 'unavailable' && item.quantityAvailable === 0);
  return queryOk && ownerOk && statusOk;
}

function sortItems(items, sort) {
  const sorted = [...items];
  switch (sort) {
    case 'name-desc': return sorted.sort((a, b) => b.cardName.localeCompare(a.cardName, 'it'));
    case 'available-desc': return sorted.sort((a, b) => b.quantityAvailable - a.quantityAvailable || a.cardName.localeCompare(b.cardName, 'it'));
    case 'quantity-desc': return sorted.sort((a, b) => (b.quantityOwned || 0) - (a.quantityOwned || 0) || a.cardName.localeCompare(b.cardName, 'it'));
    default: return sorted.sort((a, b) => a.cardName.localeCompare(b.cardName, 'it'));
  }
}

function inventoryCard(item, scope) {
  const availability = item.quantityAvailable === 0 ? 'unavailable' : item.quantityLoaned + item.quantityReserved > 0 ? 'partial' : 'available';
  const owner = scope === 'team' ? `${item.items.length} ${item.items.length === 1 ? 'proprietario' : 'proprietari'}` : esc(item.ownerName);
  return `<button type="button" class="inventory-card ${availability}" data-collection-item="${esc(item.id)}">
    <span class="inventory-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.cardName)}" loading="lazy">` : icon('card')}</span>
    <span class="inventory-card-copy">
      <strong>${esc(item.cardName)}</strong>
      <small>${esc([item.setCode || 'Set non specificato', item.rarity].filter(Boolean).join(' · '))}</small>
      <em>${item.setName ? esc(item.setName) : owner}</em>
      <span class="inventory-quantities">${scope === 'mine' ? `<b>Possedute <i>${item.quantityOwned}</i></b>` : ''}<b>Disponibili <i>${item.quantityAvailable}</i></b></span>
      <i class="inventory-status-pill ${availability}">${availabilityLabel(availability)}</i>
    </span>
    <span class="inventory-chevron" aria-hidden="true">${icon('arrow')}</span>
  </button>`;
}

function quantityDefinition(item) {
  return `<div><dt>Possedute</dt><dd>${item.quantityOwned}</dd></div><div><dt>In prestito</dt><dd>${item.quantityLoaned}</dd></div><div><dt>Prenotate</dt><dd>${item.quantityReserved}</dd></div><div><dt>Disponibili</dt><dd>${item.quantityAvailable}</dd></div>`;
}

function ownerAvailability(item, connected, currentUser) {
  const label = item.quantityAvailable === 1 ? 'disponibile' : 'disponibili';
  const disabled = !connected || item.quantityAvailable < 1 || item.ownerSlug === currentUser || item.legacyAmbiguous;
  const reason = item.ownerSlug === currentUser ? 'Questa carta è tua' : item.legacyAmbiguous ? 'Printing legacy ambigua' : item.quantityAvailable < 1 ? 'Nessuna copia disponibile' : !connected ? 'Sessione offline' : '';
  return `<div><span><strong>${esc(item.ownerName)}</strong><small>${esc([item.language,item.condition].filter(Boolean).join(' · '))}</small></span><b class="${item.quantityAvailable ? 'ok' : 'none'}">${item.quantityAvailable} ${label}</b><button type="button" class="btn small" data-request-collection-loan="${esc(item.id)}" ${disabled ? `disabled title="${esc(reason)}"` : ''}>${icon('swap')} Richiedi prestito</button></div>`;
}

function availabilityLabel(status) {
  return ({ available:'Disponibile', partial:'Parziale', unavailable:'Non disponibile' })[status];
}

function emptyState(hasSource, scope, connected) {
  if (hasSource) return `<div class="empty-state">${icon('search')}<h2>Nessun risultato</h2><p>Prova a modificare ricerca o filtri.</p></div>`;
  if (scope === 'mine') return `<div class="empty-state">${icon('collection')}<h2>La tua raccolta è vuota</h2><p>Cerca una carta nel catalogo e registra le copie che possiedi.</p><button class="btn" data-collection-add ${connected ? '' : 'disabled'}>Aggiungi la prima carta</button></div>`;
  return `<div class="empty-state">${icon('team')}<h2>Nessuna carta nel team</h2><p>Le carte registrate dai membri appariranno qui.</p></div>`;
}
