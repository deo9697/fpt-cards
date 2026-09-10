import { esc } from './core.js';
import { icon } from './icons.js';
import { deckNamesForCollectionItem } from './decks.js';
import { getGameAdapter } from './games/index.js';

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

export function collectionView(collection, filters, game, connected, error = '', visibleCount = COLLECTION_PAGE_SIZE, deckIndex = null) {
  const mine = (collection.mine || []).filter(item => item.game === game);
  const team = (collection.team || []).filter(item => item.game === game);
  const owners = [...new Map(team.map(item => [item.ownerSlug, item.ownerName])).entries()];
  const scopeSource = filters.scope === 'mine' ? mine : groupTeamItems(team);

  return `<section class="page-stack collection-page">
    <header class="page-header split"><div><span class="eyebrow">Inventario persistente</span><h1>Raccolta</h1><p>Carte possedute e copie realmente disponibili per il team.</p></div><div class="actions collection-add-actions"><button class="btn secondary" data-collection-share ${connected ? '' : 'disabled title="Disponibile quando torni online"'}>${icon('share')} Condividi</button><button class="btn secondary" data-fast-scan>${icon('search')} Scansione rapida</button><button class="btn" data-collection-add ${connected ? '' : 'disabled title="Disponibile quando torni online"'}>${icon('plus')} Aggiungi carta</button></div></header>
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
        ${facetFiltersView(game, scopeSource, filters)}
        <div class="inventory-sort-row">
          <select id="collection-sort" aria-label="Ordina">${SORT_OPTIONS.map(option => `<option value="${option.value}" ${filters.sort === option.value ? 'selected' : ''}>Ordina: ${option.label}</option>`).join('')}</select>
          <div class="view-toggle" aria-label="Visualizzazione"><button type="button" data-collection-layout="grid" class="${filters.layout === 'grid' ? 'active' : ''}" aria-label="Griglia">▦</button><button type="button" data-collection-layout="list" class="${filters.layout === 'list' ? 'active' : ''}" aria-label="Lista">☷</button></div>
        </div>
      </div>
      <div data-collection-results>${collectionResultsView(collection, filters, game, connected, visibleCount, deckIndex)}</div>
    </section>
  </section>`;
}

// Rendering every matching card into one innerHTML string used to mean
// thousands of DOM nodes at once for a large collection. visibleCount caps
// what actually gets built; a sentinel element (app.js observes it) grows
// it in batches as the user scrolls, so the full sorted/filtered list still
// exists for correctness (counts, the A-Z jump index) but only a slice of
// it ever becomes real DOM.
export const COLLECTION_PAGE_SIZE = 60;

function computeCollectionItems(collection, filters, game) {
  const mine = (collection.mine || []).filter(item => item.game === game);
  const team = (collection.team || []).filter(item => item.game === game);
  const source = filters.scope === 'mine' ? mine : groupTeamItems(team);
  const facetDefs = getGameAdapter(game).collectionFilters || [];
  return { source, all: sortItems(source.filter(item => matches(item, filters, facetDefs)), filters.sort) };
}

// Filtri dichiarati dall'adapter di gioco (Color/Set/Rarity/Cost/Power/... per
// One Piece, nessuno per Yu-Gi-Oh oggi): collection.js resta generico, non
// conosce i nomi dei campi. `ready:false` = il dato non è ancora persistito
// sull'item di raccolta (serve il catalog sync, Fase 2-4) — il filtro esiste
// già in UI ma resta disabilitato finché getValue non trova mai un valore.
function facetFiltersView(game, source, filters) {
  const defs = getGameAdapter(game).collectionFilters || [];
  if (!defs.length) return '';
  return `<div class="inventory-facet-row" role="group" aria-label="Filtri carta">${defs.map(def => facetSelect(def, source, filters)).join('')}</div>`;
}
function facetSelect(def, source, filters) {
  if (!def.ready) return `<select disabled title="Disponibile dopo l'import del catalogo"><option>${esc(def.label)} · in arrivo</option></select>`;
  const values = [...new Set(source.flatMap(item => facetValues(def, item)))].sort((a, b) => a.localeCompare(b, 'it'));
  const selected = filters.facets?.[def.key] || 'all';
  return `<select data-collection-facet="${def.key}" aria-label="${esc(def.label)}"><option value="all" ${selected === 'all' ? 'selected' : ''}>${esc(def.label)}: tutti</option>${values.map(value => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select>`;
}
// `def.multi` = getValue restituisce un array (es. i colori di un Leader
// bicolore) invece di un valore singolo: normalizza sempre a un array di
// stringhe, così il resto del motore filtri non deve sapere la differenza —
// un facet non-multi con un solo valore è semplicemente un array a 1 elemento.
function facetValues(def, item) {
  const raw = def.getValue(item);
  const list = def.multi ? (Array.isArray(raw) ? raw : []) : [raw];
  return list.map(value => String(value ?? '').trim()).filter(Boolean);
}

export function collectionResultsView(collection, filters, game, connected, visibleCount = COLLECTION_PAGE_SIZE, deckIndex = null) {
  const { source, all } = computeCollectionItems(collection, filters, game);
  const visible = all.slice(0, visibleCount);
  const isList = filters.layout === 'list';
  // L'indicazione "nel mazzo X" ha senso solo per la propria raccolta: in
  // "team" un item è già un aggregato di più proprietari, quindi il mazzo
  // di uno solo di loro non è un'informazione affidabile da mostrare lì.
  const withDeckNames = filters.scope === 'mine' && deckIndex
    ? item => deckNamesForCollectionItem(deckIndex, item)
    : () => [];
  return `${all.length ? `${!isList ? azIndexView(all) : ''}<div class="inventory-grid ${isList ? 'list' : 'tiles'}">${visible.map(item => isList ? inventoryCard(item, filters.scope, withDeckNames(item)) : inventoryTile(item, filters.scope, withDeckNames(item))).join('')}</div>${visible.length < all.length ? `<div class="inventory-load-more" data-collection-sentinel><span class="loading-spinner"></span></div>` : ''}` : emptyState(source.length, filters.scope, connected)}
    <div class="collection-count"><strong>${all.length}</strong> printing · disponibilità calcolata dai prestiti</div>`;
}

// Finds where a letter would land in the sorted/filtered list even though
// most of it hasn't been rendered yet — app.js uses this to know how many
// items visibleCount needs to reveal before it can scroll the tile into view.
export function collectionJumpTarget(collection, filters, game, letter) {
  const { all } = computeCollectionItems(collection, filters, game);
  const index = all.findIndex(item => firstLetter(item.cardName) === letter);
  return index < 0 ? null : { index, id: all[index].id };
}

function firstLetter(name) {
  const char = String(name || '').trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(char) ? char : '#';
}

function azIndexView(items) {
  const present = new Set(items.map(item => firstLetter(item.cardName)));
  return `<div class="inventory-az-index" role="group" aria-label="Salta alla lettera">${[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'].map(letter => `<button type="button" data-collection-jump="${letter}" ${present.has(letter) ? '' : 'disabled'}>${letter}</button>`).join('')}</div>`;
}

export function collectionDetailView(id, scope, collection, connected, currentUser = '', marketItems = []) {
  const mine = collection.mine || [], team = collection.team || [];
  const item = scope === 'mine' ? mine.find(entry => entry.id === id) : groupTeamItems(team).find(entry => entry.id === id);
  if (!item) return '';
  const rows = scope === 'team' ? item.items : team.filter(entry => entry.printingId === item.printingId);
  const market = item.printingId ? marketItems.find(row => row.printingId === item.printingId) : null;
  const price = market?.referencePrice;
  const hasPrice = typeof price === 'number' && Number.isFinite(price) && price >= 0;
  const stats = scope === 'mine'
    ? [['collection','Possedute',item.quantityOwned],['swap','In prestito',item.quantityLoaned],['lock','Prenotate',item.quantityReserved],['deck','Disponibili',item.quantityAvailable]]
    : [['swap','In prestito',item.quantityLoaned],['lock','Prenotate',item.quantityReserved],['deck','Disponibili',item.quantityAvailable]];
  const meta = [[item.setCode,'code'],[item.rarity,'rarity'],[item.language,'language'],[item.condition,'condition'],[item.edition,'edition']].filter(([value])=>value);
  return '<div class="detail-backdrop inventory-detail-backdrop" data-close-collection-detail><aside class="card-detail inventory-detail" role="dialog" aria-modal="true" aria-labelledby="collection-detail-title">'
    + `<header class="inventory-detail-heading"><span class="eyebrow">${scope==='mine'?'La mia raccolta':'Raccolta team'}</span><button type="button" class="detail-close" data-close-collection-detail aria-label="Chiudi dettaglio carta">×</button></header>
    <div class="detail-layout"><div class="inventory-art-stage"><div class="detail-art">${item.imageUrl?`<img src="${esc(item.imageUrl)}" alt="${esc(item.cardName)}">`:icon('card')}</div></div>
    <div class="detail-copy"><h2 id="collection-detail-title">${esc(item.cardName)}</h2>
      <div class="inventory-printing-meta">${meta.map(([value,kind])=>`<span class="inventory-meta-badge is-${kind}">${esc(value)}</span>`).join('')}<span class="inventory-availability ${item.quantityAvailable>0?'is-available':''}">${icon(item.quantityAvailable>0?'check':'lock')} ${item.quantityAvailable>0?'Disponibile':'Non disponibile'}</span></div>
      <dl class="${scope==='mine'?'stat-grid-4':'stat-grid-3'} inventory-quantity-stats">${stats.map(([symbol,label,value])=>`<div><dt>${icon(symbol)}<span>${label}</span></dt><dd>${Number(value)||0}</dd></div>`).join('')}</dl>
      ${item.legacyAmbiguous?`<div class="data-note warning">${icon('bell')} Esistono vecchi prestiti non attribuibili con certezza a questa printing: non sono stati sottratti automaticamente.</div>`:''}
      <div class="inventory-market-summary">${icon('chart')}<div><small>${hasPrice?'Valore indicativo per copia':'Valore di mercato'}</small><strong>${hasPrice?new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'}).format(price):'Prezzo non disponibile'}</strong></div><button type="button" class="text-action" data-page="market">Vedi mercato ${icon('arrow')}</button></div>
      ${scope==='team'?`<h3>Disponibilità nel team</h3><div class="team-availability">${rows.map(row=>ownerAvailability(row,connected,currentUser)).join('')}</div><div class="detail-actions"><button type="button" class="btn wide" data-market-watch-add="${esc(item.printingId)}" ${connected&&item.printingId?'':'disabled'}>${icon('chart')} Segui printing</button></div>`:`<div class="detail-actions"><button type="button" class="btn wide inventory-loan-cta" data-collection-loan="${esc(item.id)}" ${item.quantityAvailable>0&&connected?'':'disabled'}>${icon('swap')} Crea prestito</button><div class="detail-actions-row"><button type="button" class="btn secondary" data-market-watch-add="${esc(item.printingId)}" ${connected&&item.printingId?'':'disabled'}>${icon('chart')} Segui</button><button type="button" class="btn secondary" data-collection-edit="${esc(item.id)}" ${connected?'':'disabled'}>${icon('settings')} Modifica</button><button type="button" class="btn secondary danger" data-collection-delete="${esc(item.id)}" ${connected?'':'disabled'}>${icon('trash')} Rimuovi</button></div></div>`}
      ${!connected?'<p class="inventory-offline-note">Sei offline. Torna online per modificare la raccolta o creare un prestito.</p>':''}
    </div></div></aside></div>`;
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
    printings:[{ printingId:item.printingId || null, variantId:item.variantId || '', setCode:item.setCode, setName:item.setName, rarity:item.rarity }]
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
      ${game === 'onepiece' ? onePiecePrintingPickerView(printings, selectedPrinting, selected.id) : `<div class="printing-editor-grid"><label for="collection-set">Set / codice<select id="collection-set">${sets.map(printing => `<option value="${esc(printing.setCode)}" ${normalizeSetCode(printing.setCode) === normalizeSetCode(selectedSetCode) ? 'selected' : ''}>${esc([printing.setCode || 'Set non specificato', printing.setName].filter(Boolean).join(' · '))}</option>`).join('')}</select></label><label for="collection-rarity">Rarità<select id="collection-rarity" ${rarities.length ? '' : 'disabled'}>${rarities.length > 1 && !selectedPrinting ? '<option value="" selected>Scegli la rarità…</option>' : ''}${rarities.map(printing => `<option value="${esc(printing.rarity)}" ${selectedPrinting && samePrinting(printing, selectedPrinting) ? 'selected' : ''}>${esc(printing.rarity || 'Non specificata')}</option>`).join('')}</select></label></div>
      ${rarities.length > 1 && !selectedPrinting ? `<div class="data-note warning">${icon('bell')} Questo set contiene più rarità: seleziona esplicitamente quella posseduta.</div>` : ''}
      <div class="printing-preview"><span><small>Codice set</small><b>${esc(selectedPrinting?.setCode || selectedSetCode || 'Non specificato')}</b></span><span><small>Set</small><b>${esc(selectedPrinting?.setName || rarities[0]?.setName || 'Non specificato')}</b></span><span><small>Rarità selezionata</small><b>${esc(selectedPrinting?.rarity || 'Da selezionare')}</b></span></div>`}` : `<div class="catalog-required">${icon('search')} Cerca e seleziona una carta per continuare.</div>`}
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

// One Piece non usa la cascata Set -> Rarità di Yu-Gi-Oh (sotto): regular e
// parallel condividono spesso set_code e rarity, quindi l'unica scelta che
// ha senso è direttamente tra le printing fisiche (Fase 4C). L'etichetta
// mostra il variant_id grezzo invece di una categoria indovinata tipo
// "Regular"/"Parallel"/"Alt Art": non c'è ancora una tassonomia confermata
// dei suffissi OPTCG, e un'etichetta sbagliata sarebbe peggio di una meno
// elegante ma sempre corretta.
function onePiecePrintingPickerView(printings, selectedPrinting, baseCardId = '') {
  if (!printings.length) return `<div class="catalog-required">${icon('search')} Nessuna printing trovata per questa carta.</div>`;
  return `<div class="collection-printing-options" role="group" aria-label="Printing">${printings.map(printing => {
    const active = Boolean(selectedPrinting && samePrinting(printing, selectedPrinting));
    const { main, suffix } = onePiecePrintingLabel(printing, baseCardId);
    return `<button type="button" data-collection-printing-option="${esc(printing.printingId || '')}" class="${active ? 'active' : ''}">${printing.image ? `<img src="${esc(printing.image)}" alt="" loading="lazy">` : icon('card')}<span><strong>${esc(main)}${suffix ? ` <i class="op-variant-tag">${esc(suffix)}</i>` : ''}</strong><small>${esc([printing.setCode, printing.rarity].filter(Boolean).join(' · ') || 'Rarità non indicata')}</small></span>${active ? icon('arrow') : ''}</button>`;
  }).join('')}</div>`;
}

// Divide il variant_id grezzo in "numero carta" (uguale per tutte le
// printing) + suffisso che le differenzia (es. "_p1"), così il suffisso
// risalta senza inventare una categoria indovinata (vedi nota sopra).
function onePiecePrintingLabel(printing, baseCardId) {
  const variantId = String(printing.variantId || '').trim();
  if (!variantId || variantId === baseCardId) return { main: baseCardId || 'Base', suffix: '' };
  if (baseCardId && variantId.startsWith(baseCardId)) {
    const suffix = variantId.slice(baseCardId.length).replace(/^[_-]+/, '');
    if (suffix) return { main: baseCardId, suffix };
  }
  return { main: variantId, suffix: '' };
}

// printingId (una vera UUID risolta dal catalogo, Fase 4) è la chiave di
// dedup preferita quando disponibile: due printing possono benissimo
// condividere set_code e rarity (es. regular e parallel One Piece dello
// stesso set) ed essere comunque righe distinte — deduplicare solo su
// set_code+rarity le fonderebbe per errore. Per Yu-Gi-Oh (ricerca
// ygoprodeck, nessun printingId noto) resta il vecchio comportamento.
export function collectionPrintingOptions(card) {
  const rows = card?.printings?.length ? card.printings : [{ setCode:'', setName:'', rarity:'' }];
  return [...new Map(rows.map(printing => {
    const normalized = {
      printingId:printing.printingId || null,
      variantId:String(printing.variantId || '').trim(),
      setCode:String(printing.setCode || '').trim().toUpperCase(),
      setName:String(printing.setName || '').trim(),
      rarity:String(printing.rarity || '').trim(),
      image:String(printing.image || printing.imageUrl || '').trim()
    };
    const key = normalized.printingId
      ? `id:${normalized.printingId}`
      : `${normalizeSetCode(normalized.setCode)} ${normalized.rarity.toLocaleLowerCase('it')} ${normalized.variantId}`;
    return [key, normalized];
  })).values()];
}

export function selectCollectionEditorPrinting(card, setCode, rarity = '', printingId = '') {
  const options = collectionPrintingOptions(card);
  if (printingId) {
    const exact = options.find(printing => String(printing.printingId || '') === String(printingId));
    if (exact) return exact;
  }
  const bySet = options.filter(printing => normalizeSetCode(printing.setCode) === normalizeSetCode(setCode));
  const exact = bySet.find(printing => normalizeRarity(printing.rarity) === normalizeRarity(rarity));
  return exact || (bySet.length === 1 ? bySet[0] : null);
}

function normalizeSetCode(value) { return String(value || '').trim().toUpperCase(); }
function normalizeRarity(value) { return String(value || '').trim().toLocaleLowerCase('it'); }
function samePrinting(left, right) {
  if (left?.printingId && right?.printingId) return String(left.printingId) === String(right.printingId);
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

function matches(item, filters, facetDefs = []) {
  const needle = filters.query.trim().toLowerCase();
  const text = [item.cardName,item.setCode,item.setName,item.rarity].join(' ').toLowerCase();
  const queryOk = !needle || text.includes(needle);
  const ownerOk = filters.owner === 'all' || item.ownerSlug === filters.owner || item.items?.some(entry => entry.ownerSlug === filters.owner);
  const committed = item.quantityLoaned + item.quantityReserved;
  const statusOk = filters.status === 'all'
    || (filters.status === 'available' && item.quantityAvailable > 0)
    || (filters.status === 'partial' && item.quantityAvailable > 0 && committed > 0)
    || (filters.status === 'unavailable' && item.quantityAvailable === 0);
  const facetsOk = facetDefs.every(def => {
    const selected = filters.facets?.[def.key];
    return !selected || selected === 'all' || facetValues(def, item).includes(selected);
  });
  return queryOk && ownerOk && statusOk && facetsOk;
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

function itemAvailability(item) {
  return item.quantityAvailable === 0 ? 'unavailable' : item.quantityLoaned + item.quantityReserved > 0 ? 'partial' : 'available';
}

function inventoryTile(item, scope, deckNames = []) {
  const availability = itemAvailability(item);
  return `<button type="button" class="inventory-tile" data-collection-item="${esc(item.id)}">
    <span class="inventory-tile-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.cardName)}" loading="lazy">` : icon('card')}${scope === 'mine' ? `<b class="inventory-tile-qty">${item.quantityOwned}×</b>` : ''}<i class="inventory-tile-status ${availability}" title="${esc(availabilityLabel(availability))}"></i></span>
    <small class="inventory-tile-name">${esc(item.cardName)}</small>
    ${deckNames.length ? `<small class="inventory-tile-deck" title="${esc(deckHintText(deckNames))}">${icon('deck')} ${esc(deckNames[0])}${deckNames.length > 1 ? ` +${deckNames.length - 1}` : ''}</small>` : ''}
  </button>`;
}

function inventoryCard(item, scope, deckNames = []) {
  const availability = itemAvailability(item);
  const owner = scope === 'team' ? `${item.items.length} ${item.items.length === 1 ? 'proprietario' : 'proprietari'}` : esc(item.ownerName);
  return `<button type="button" class="inventory-card ${availability}" data-collection-item="${esc(item.id)}">
    <span class="inventory-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.cardName)}" loading="lazy">` : icon('card')}</span>
    <span class="inventory-card-copy">
      <strong>${esc(item.cardName)}</strong>
      <small>${esc([item.setCode || 'Set non specificato', item.rarity].filter(Boolean).join(' · '))}</small>
      <em>${item.setName ? esc(item.setName) : owner}</em>
      <span class="inventory-quantities">${scope === 'mine' ? `<b>Possedute <i>${item.quantityOwned}</i></b>` : ''}<b>Disponibili <i>${item.quantityAvailable}</i></b></span>
      <i class="inventory-status-pill ${availability}">${availabilityLabel(availability)}</i>
      ${deckNames.length ? `<i class="inventory-deck-pill">${icon('deck')} ${esc(deckHintText(deckNames))}</i>` : ''}
    </span>
    <span class="inventory-chevron" aria-hidden="true">${icon('arrow')}</span>
  </button>`;
}

function deckHintText(deckNames) {
  return deckNames.length === 1 ? `Nel mazzo ${deckNames[0]}` : `Nei mazzi ${deckNames.join(', ')}`;
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
