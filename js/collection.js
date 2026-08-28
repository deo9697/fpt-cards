import { esc } from './core.js';
import { icon } from './icons.js';

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
      <div class="collection-toolbar inventory-toolbar"><label class="filter-search">${icon('search')}<input type="search" data-collection-query placeholder="Cerca nome, set o codice…" value="${esc(filters.query)}" aria-label="Cerca nella raccolta"></label>
        ${filters.scope === 'team' ? `<select id="collection-owner" aria-label="Proprietario"><option value="all">Tutti i proprietari</option>${owners.map(([id,name]) => `<option value="${esc(id)}" ${filters.owner === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>` : ''}
        <select id="collection-status" aria-label="Disponibilità"><option value="all">Tutte le disponibilità</option><option value="available" ${filters.status === 'available' ? 'selected' : ''}>Disponibili</option><option value="partial" ${filters.status === 'partial' ? 'selected' : ''}>Parziali</option><option value="unavailable" ${filters.status === 'unavailable' ? 'selected' : ''}>Non disponibili</option></select>
        <div class="view-toggle" aria-label="Visualizzazione"><button type="button" data-collection-layout="grid" class="${filters.layout === 'grid' ? 'active' : ''}" aria-label="Griglia">▦</button><button type="button" data-collection-layout="list" class="${filters.layout === 'list' ? 'active' : ''}" aria-label="Lista">☷</button></div>
      </div>
      <div data-collection-results>${collectionResultsView(collection, filters, game, connected)}</div>
    </section>
  </section>`;
}

export function collectionResultsView(collection, filters, game, connected) {
  const mine = (collection.mine || []).filter(item => item.game === game);
  const team = (collection.team || []).filter(item => item.game === game);
  const source = filters.scope === 'mine' ? mine : groupTeamItems(team);
  const visible = source.filter(item => matches(item, filters));
  return `<div class="collection-count"><strong>${visible.length}</strong> ${visible.length === 1 ? 'printing' : 'printing'} · disponibilità calcolata dai prestiti</div>
    ${visible.length ? `<div class="inventory-grid ${filters.layout === 'list' ? 'list' : ''}">${visible.map(item => inventoryCard(item, filters.scope)).join('')}</div>` : emptyState(source.length, filters.scope, connected)}`;
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
      ${scope === 'team' ? `<h3>Disponibilità nel team</h3><div class="team-availability">${rows.map(row => ownerAvailability(row, connected, currentUser)).join('')}</div>` : `<div class="actions"><button class="btn" data-collection-loan="${esc(item.id)}" ${item.quantityAvailable > 0 && connected ? '' : 'disabled'}>${icon('swap')} Crea prestito</button><button class="btn secondary" data-collection-edit="${esc(item.id)}" ${connected ? '' : 'disabled'}>Modifica</button><button class="btn secondary danger" data-collection-delete="${esc(item.id)}" ${connected ? '' : 'disabled'}>Rimuovi</button></div>`}
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
  const printings = selected?.printings?.length ? selected.printings : [{ setCode:'', setName:'', rarity:'' }];
  const selectedPrinting = editor.printing || printings.find(printing => printing.setCode === item?.setCode && printing.rarity === item?.rarity) || printings[0];
  const owned = item?.quantityOwned ?? 1;
  return `<div class="detail-backdrop" data-close-collection-editor><aside class="card-detail collection-editor" role="dialog" aria-modal="true" aria-labelledby="collection-editor-title"><button class="detail-close" data-close-collection-editor aria-label="Chiudi">×</button><span class="eyebrow">${item ? 'Modifica inventario' : 'Nuova carta'}</span><h2 id="collection-editor-title">${item ? esc(item.cardName) : 'Aggiungi alla raccolta'}</h2>
    <form id="collection-form">
      <label for="collection-card-search">Carta dal catalogo</label><div class="catalog-search"><input id="collection-card-search" autocomplete="off" value="${selected ? esc(selected.name) : ''}" placeholder="Cerca almeno 3 caratteri…" ${item ? '' : 'required'}><div id="collection-card-suggestions" class="suggestions"></div></div>
      ${selected ? `<div class="selected-catalog-card">${selected.image ? `<img src="${esc(selected.image)}" alt="">` : icon('card')}<span><strong>${esc(selected.name)}</strong><small>ID ${esc(selected.id)}</small></span></div>
      <label for="collection-printing">Printing / set</label><select id="collection-printing">${printings.map((printing,index) => `<option value="${index}" ${printing === selectedPrinting || (printing.setCode === selectedPrinting.setCode && printing.rarity === selectedPrinting.rarity) ? 'selected' : ''}>${esc([printing.setCode || 'Set non specificato', printing.setName, printing.rarity].filter(Boolean).join(' · '))}</option>`).join('')}</select>
      <div class="printing-preview"><span><small>Set</small><b>${esc(selectedPrinting.setCode || 'Non specificato')}</b></span><span><small>Rarità</small><b>${esc(selectedPrinting.rarity || 'Non specificata')}</b></span></div>` : `<div class="catalog-required">${icon('search')} Cerca e seleziona una carta per continuare.</div>`}
      <div class="inventory-form-grid"><label>Quantità posseduta<input id="collection-owned" type="number" min="1" max="999" value="${owned}" required></label><label>Lingua<select id="collection-language">${['Italiano','Inglese','Giapponese','Francese','Tedesco','Spagnolo'].map(value => `<option ${value === (item?.language || 'Italiano') ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Condizione<select id="collection-condition">${['Mint','Near Mint','Excellent','Good','Played','Poor'].map(value => `<option ${value === (item?.condition || 'Near Mint') ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="wide-field">Edizione<input id="collection-edition" maxlength="100" value="${esc(item?.edition || '')}" placeholder="es. 1ª Edizione"></label></div>
      <p class="quantity-help">La disponibilità fisica viene calcolata automaticamente sottraendo copie prestate e prenotate.</p>
      <button class="btn wide" type="submit" ${selected && connected ? '' : 'disabled'}>Salva nella raccolta</button>
    </form>
  </aside></div>`;
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

function inventoryCard(item, scope) {
  const availability = item.quantityAvailable === 0 ? 'unavailable' : item.quantityLoaned + item.quantityReserved > 0 ? 'partial' : 'available';
  return `<button type="button" class="inventory-card ${availability}" data-collection-item="${esc(item.id)}"><span class="inventory-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.cardName)}" loading="lazy">` : icon('card')}<i>${availabilityLabel(availability)}</i></span><span class="inventory-card-copy"><strong>${esc(item.cardName)}</strong><small>${esc([item.setCode || 'Set non specificato', item.rarity].filter(Boolean).join(' · '))}</small>${scope === 'team' ? `<em>${item.items.length} ${item.items.length === 1 ? 'proprietario' : 'proprietari'}</em>` : `<em>${esc(item.ownerName)}</em>`}<span class="inventory-quantities">${scope === 'mine' ? `<b>Possedute <i>${item.quantityOwned}</i></b>` : ''}<b>Disponibili <i>${item.quantityAvailable}</i></b></span></span></button>`;
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
