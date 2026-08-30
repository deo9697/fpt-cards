import { MEMBERS, GAMES, state, saveState, setMembers, member, initials, esc, formatDate } from './js/core.js';
import { api } from './js/api.js';
import { searchCards, findCard, findCardById, resolveStoredCard, reconcileCatalogCard, lookupPrintingBySetCode, cardImageMatches, normalizeCardImageUrl, canonicalYgoCardImage, tcgBanlistStatuses } from './js/cards.js';
import { icon } from './js/icons.js';
import { dashboardView } from './js/dashboard.js';
import { collectionView as inventoryCollectionView, collectionResultsView, collectionDetailView, collectionEditorView, collectionLoanRequestView } from './js/collection.js';
import { enablePushNotifications, pushSupported, pushConfigured } from './js/push.js';
import { initEasterEgg, triggerRickrollVideo } from './js/easter-egg.js';
import { registerAutoUpdates } from './js/pwa-update.js';
import { watchConnectivity, online } from './js/connectivity.js';
import { FastScanController } from './js/fast-scan.js';
import { DeckController } from './js/decks.js';
import { MarketWatchController } from './js/market-watch.js';

const ROUTES = new Set(['home','cards','collection','fastscan','decks','new','loans','market','team','settings','more']);
let page = routeFromHash();
let loanFilters = { direction: 'all', member: 'all', query: '', status: 'all' };
let collectionFilters = { scope:'mine', query:'', owner:'all', status:'all', layout:'grid' };
let selectedCardKey = '';
let selectedCollectionItem = '';
let collectionEditor = null;
let collectionLoanRequest = null;
let collectionSearchResults = [];
let collectionSearchSequence = 0;
let collectionError = '';
let collectionPending = false;
let draftCards = [];
let loanBuilderDraft = { borrower:'', notes:'', query:'', mode:'lend' };
let loanSearchResults = [];
let loanSearchStatus = 'idle';
let loanSubmitPending = false;
let cardSearchTimer;
let collectionSearchTimer;
let cardSearchSequence = 0;
let enrichingImages = false;
let gameMenuOpen = false;
let secretTaps = 0;
let secretTapTimer;
let appLoading = false;
let cloudError = '';
let loginPending = false;
let loginDraft = { member:'', pin:'' };
let memberLoadError = '';
let loginFeatureCards;
let realtimeSyncTimer;
let realtimeSyncRunning = false;
let realtimeSyncQueued = false;
let catalogRepairRunning = false;
let catalogRepairQueued = false;
const unresolvedCards = new Set();
const fastScan = new FastScanController({
  api, externalLookup:lookupPrintingBySetCode, getCollection:()=>state.collection,
  isOnline:online, onRender:()=>render(true), onSaved:async()=>{await loadCollection();saveState();}, onToast:message=>toast(message),
  onRoute:mode=>setFastScanRoute(mode)
});
const decks = new DeckController({api,getState:()=>state,searchCards,findCard,findCardById,tcgBanlistStatuses,isOnline:online,onRender:()=>render(true),onToast:message=>toast(message),onLoansChanged:async()=>{await Promise.all([loadCloudLoans(),loadCollection()]);saveState();}});
const marketWatch = new MarketWatchController({api,getGame:()=>state.game,onRender:()=>render(true),onToast:message=>toast(message),onNavigate:target=>navigate(target)});
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2200); }
function installCardImageRecovery() {
  document.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || image.dataset.cardImageFailed === 'true') return;
    const current = image.currentSrc || image.src;
    const fullSize = current.replace('/images/cards_small/', '/images/cards/').replace('/images/cards_cropped/', '/images/cards/');
    if (fullSize !== current && image.dataset.cardImageFallback !== 'full') {
      image.dataset.cardImageFallback = 'full';
      image.src = fullSize;
      return;
    }
    image.dataset.cardImageFailed = 'true';
    image.classList.add('card-image-unavailable');
  }, true);
}
function routeFromHash() { const value = location.hash.replace(/^#\/?/, '').split('/')[0]; return ROUTES.has(value) ? value : 'home'; }
function fastScanModeFromHash(){return location.hash.replace(/^#\/?/,'').split('/')[1]==='review'?'review':'scan';}
function setFastScanRoute(mode){
  if(mode==='collection'){navigate('collection');return;}
  page='fastscan'; const hash=mode==='review'?'#/fastscan/review':'#/fastscan';
  if(location.hash!==hash)history.pushState({fastScan:mode},'',hash);
  render(true);
}
function navigate(next) { const previous=page; page = ROUTES.has(next) ? next : 'home'; if(previous==='fastscan'&&page!=='fastscan')void fastScan.leave(); selectedCollectionItem = ''; collectionEditor = null; const hash = `#/${page}`; if (location.hash !== hash) history.pushState(null, '', hash); if(previous==='fastscan'||page==='fastscan')render();else renderRoute(); }

function render(force = false) {
  if (!force && !state.currentUser && document.querySelector('.login-shell #login-form')) return;
  const activeField = document.activeElement;
  const editingLoan = state.currentUser && page === 'new'
    && activeField?.closest?.('#loan-form')
    && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeField.tagName);
  if (!force && editingLoan) return;
  if (!state.currentUser) {
    const memberField = document.querySelector('#member');
    const pinField = document.querySelector('#pin');
    if (memberField) loginDraft.member = memberField.value;
    if (pinField) loginDraft.pin = pinField.value;
  }
  document.body.dataset.game = state.game || 'yugioh';
  document.body.dataset.page = state.currentUser ? page : 'login';
  document.querySelector('#app').innerHTML = state.currentUser ? appView() : loginView();
  bind();
  if (!state.currentUser) void loadLoginFeaturedCards();
}

function renderRoute() {
  const shell = document.querySelector('.app-shell');
  const stage = shell?.querySelector('.page-stage');
  if (!state.currentUser || !shell || !stage) { render(); return; }
  document.body.dataset.page = page;
  stage.innerHTML = pageContent();
  shell.querySelectorAll(':scope > .detail-backdrop').forEach(element => element.remove());
  shell.querySelector(':scope > .fab')?.remove();
  if (page !== 'new') shell.querySelector(':scope > .mobile-nav')?.insertAdjacentHTML('beforebegin', `<button class="fab" data-page="new" aria-label="Nuovo prestito">${icon('plus')}</button>`);
  shell.querySelectorAll('.sidebar nav button[data-page],.mobile-nav button[data-page]').forEach(button => {
    const target = button.dataset.page;
    button.classList.toggle('active', target === page || (target === 'more' && ['decks','market','team','settings'].includes(page)));
  });
  // Questi nodi sono piccoli: clonarli elimina i vecchi listener senza
  // ricostruire la pagina e le sue immagini.
  for (const selector of ['.sidebar','.topbar','.mobile-nav',':scope > .fab']) {
    const node = shell.querySelector(selector);
    if (node) node.replaceWith(node.cloneNode(true));
  }
  bind();
}

function loginView() {
  return `<main class="login-shell"><section class="login-visual" aria-label="F.P.T Cards">
    <div class="brand login-brand"><img src="icon-512.png" alt="Logo F.P.T Cards"><div><h1>F.P.T Cards</h1><p>Team card companion</p></div></div>
    <div class="login-copy"><span class="eyebrow">Il vault del team</span><h2>Carte e prestiti.<br><span>Una squadra sola.</span></h2><p>Gestisci gli scambi, ritrova le carte del team e mantieni ogni movimento sotto controllo.</p></div>
    <div class="login-card-scene" aria-hidden="true"><div class="scene-card back"><span class="scene-placeholder">${icon('card')}</span><img data-login-feature="dark-magician" alt=""></div><div class="scene-card hero"><img src="assets/fpt-card-hero.png" alt=""></div><div class="scene-card front"><span class="scene-placeholder">${icon('card')}</span><img data-login-feature="blue-eyes" alt=""></div></div>
    <div class="value-pills"><span>${icon('collection')}<b>Raccolta</b><small>Archivio condiviso</small></span><span>${icon('swap')}<b>Prestiti</b><small>Tracciati dal team</small></span><span>${icon('chart')}<b>Market Watch</b><small>In arrivo</small></span></div>
  </section><section class="login-panel"><div class="login-form-wrap">
    <div class="brand login-mobile-brand"><img src="icon-512.png" alt="Logo F.P.T Cards"><div><h1>F.P.T Cards</h1></div></div><span class="eyebrow">Area riservata</span><h2>Bentornato</h2><p class="muted">Seleziona il tuo profilo. Al primo accesso creerai il PIN personale.</p>
    <div class="surface login-card">
      <form id="login-form"><label for="member">Membro del team</label><div class="member-select-wrap">${icon('team')}<select id="member" required aria-describedby="member-load-status"><option value="" ${loginDraft.member ? '' : 'selected'} disabled>Seleziona il tuo nome</option>${MEMBERS.map(m => `<option value="${m.id}" ${m.id === loginDraft.member ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>${memberLoadError ? `<p class="member-load-status error" id="member-load-status" role="alert">${esc(memberLoadError)} · mostro gli ultimi profili disponibili.</p>` : `<p class="member-load-status" id="member-load-status">${MEMBERS.length} profili disponibili</p>`}
      <label for="pin">PIN di 4 cifre</label><div class="password-field"><input id="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" value="${esc(loginDraft.pin)}" placeholder="••••" required><button type="button" id="toggle-pin" aria-label="Mostra PIN">${icon('eye')}</button></div>
      <button class="btn wide" type="submit" ${loginPending ? 'disabled' : ''}>${loginPending ? 'Accesso…' : `${icon('logout')} Accedi`}</button></form>
    </div><p class="login-security">${icon('settings')} ${api.configured ? 'PIN protetto e sincronizzazione del team attivi' : 'Supabase non configurato'}</p>
  </div></section></main>`;
}

function loginLoadingView() {
  return `<main class="login-shell"><section class="login-visual"></section><section class="login-panel"><div class="login-form-wrap login-loading" aria-live="polite"><span class="eyebrow">Area riservata</span><h2>Bentornato</h2><div class="surface login-card member-loading-row"><div class="loading-spinner" aria-hidden="true"></div><div><strong>Caricamento membri...</strong><p>Sto sincronizzando i profili del team.</p></div></div></div></section></main>`;
}

async function loadLoginFeaturedCards() {
  loginFeatureCards ||= Promise.all([
    findCard('Dark Magician', 'yugioh'),
    findCard('Blue-Eyes White Dragon', 'yugioh')
  ]).catch(() => []);
  const [darkMagician, blueEyes] = await loginFeatureCards;
  const cards = { 'dark-magician':darkMagician, 'blue-eyes':blueEyes };
  Object.entries(cards).forEach(([slot, card]) => {
    const image = document.querySelector(`[data-login-feature="${slot}"]`);
    if (!image || !card?.image) return;
    image.addEventListener('load', () => image.closest('.scene-card')?.classList.add('loaded'), { once:true });
    image.src = card.fullImage || card.image;
  });
}

function appView() {
  if (page === 'fastscan') return `<main class="fast-scan-route">${fastScan.view()}</main>`;
  const u = member(state.currentUser) || { id:state.currentUser, name:'Membro F.P.T' };
  const game = GAMES[state.game];
  const notifications = state.loans.filter(l => l.game === state.game && ((l.borrower === state.currentUser && ['pending','reserved'].includes(l.status)) || (l.owner === state.currentUser && ['requested','return_pending'].includes(l.status)))).length;
  const desktopNav = [['home','home','Home'],['cards','card','Carte'],['collection','collection','Raccolta'],['decks','deck','Mazzi'],['loans','swap','Prestiti'],['market','chart','Market Watch'],['team','team','Team'],['settings','settings','Impostazioni']];
  const mobileNav = [['home','home','Home'],['cards','card','Carte'],['collection','collection','Raccolta'],['decks','deck','Mazzi'],['loans','swap','Prestiti'],['more','more','Altro']];
  return `<main class="app-shell"><aside class="sidebar"><div class="brand sidebar-brand"><img src="icon-512.png" alt=""><div><h1>F.P.T Cards</h1><p>${game.short}</p></div></div><nav>${desktopNav.map(([id,iconName,label]) => navButton(id, iconName, label, notifications)).join('')}</nav><div class="sidebar-profile"><div class="avatar member-${u.id}">${initials(u.name)}</div><div><strong>${esc(u.name)}</strong><small>${state.role === 'admin' ? 'Amministratore' : 'Membro del team'}</small></div><button data-logout aria-label="Esci">${icon('logout')}</button></div></aside>
    <section class="app-main"><header class="topbar"><div class="game-switcher ${gameMenuOpen ? 'open' : ''}"><button type="button" class="menu-trigger" aria-label="Scegli gioco" aria-expanded="${gameMenuOpen}">${icon('menu')}</button><aside class="game-menu" aria-label="Seleziona gioco"><div class="game-menu-head"><div><small>F.P.T Cards</small><h2>Cambia gioco</h2></div></div><div class="game-options">${Object.values(GAMES).map(g => `<button data-game="${g.id}" class="${state.game === g.id ? 'active' : ''}"><span class="game-mark ${g.id}">${g.mark}</span><span><strong>${g.name}</strong><small>${state.game === g.id ? 'Sezione attiva' : 'Passa a questa sezione'}</small></span><b>${state.game === g.id ? '✓' : '›'}</b></button>`).join('')}</div></aside></div><label class="global-search">${icon('search')}<input id="global-search" type="search" placeholder="Cerca carte o prestiti…" aria-label="Ricerca globale"></label><button class="top-icon" data-quick="attention" aria-label="Notifiche">${icon('bell')}${notifications ? `<i>${notifications}</i>` : ''}</button><button class="mobile-profile" data-page="settings"><span class="avatar member-${u.id}">${initials(u.name)}</span></button></header>
      ${!online() ? '<div class="connection-banner offline">Sei offline · mostro gli ultimi dati salvati</div>' : cloudError ? `<div class="connection-banner error">${esc(cloudError)} <button id="retry-cloud">Riprova</button></div>` : ''}
      <section class="page-stage" aria-live="polite">${pageContent()}</section>
    </section>
    ${page !== 'new' ? `<button class="fab" data-page="new" aria-label="Nuovo prestito">${icon('plus')}</button>` : ''}
    <nav class="nav mobile-nav">${mobileNav.map(([id,iconName,label]) => navButton(id, iconName, label, notifications)).join('')}</nav>
    ${selectedCardKey ? cardDetailView(selectedCardKey) : ''}
    ${selectedCollectionItem ? collectionDetailView(selectedCollectionItem, collectionFilters.scope, state.collection, online(), state.currentUser) : ''}
    ${collectionEditor ? collectionEditorView(collectionEditor, state.game, online()) : ''}
    ${collectionLoanRequest ? collectionLoanRequestView(collectionLoanRequest, online()) : ''}
  </main>`;
}

function navButton(id, iconName, label, notifications) {
  const active = page === id || (id === 'more' && ['decks','market','team','settings'].includes(page));
  return `<button data-page="${id}" class="${active ? 'active' : ''}"><span>${icon(iconName)}${id === 'loans' && notifications ? `<i>${notifications}</i>` : ''}</span>${label}</button>`;
}

function pageContent() {
  if (appLoading) return loadingView();
  if (page === 'new') return newLoanView();
  if (page === 'loans') return loansView();
  if (page === 'team') return teamView();
  if (page === 'cards') return cardsView();
  if (page === 'fastscan') return fastScan.view();
  if (page === 'collection') return inventoryCollectionView(state.collection, collectionFilters, state.game, online(), collectionError);
  if (page === 'market') return marketWatch.view();
  if (page === 'decks') return decks.view();
  if (page === 'settings') return settingsView();
  if (page === 'more') return moreView();
  return dashboardView(state, state.game, marketWatch.dashboardState());
}

function loadingView() {
  return `<section class="loading-view" aria-label="Caricamento"><div class="skeleton hero"></div><div class="skeleton line"></div><div class="skeleton grid"></div></section>`;
}

function trackedCards() {
  const records = new Map();
  state.loans.filter(l => l.game === state.game).forEach(loan => {
    const key = String(loan.externalId || loan.cardName).toLowerCase();
    if (!records.has(key)) records.set(key, { key, name:loan.cardName, image:loan.image || '', externalId:loan.externalId || '', loans:[], owners:new Set() });
    const card = records.get(key);
    card.loans.push(loan); card.owners.add(loan.owner);
    if (!card.image && loan.image) card.image = loan.image;
  });
  return [...records.values()];
}

function cardsView() {
  const cards = trackedCards();
  return `<section class="page-stack"><header class="page-header split"><div><span class="eyebrow">Catalogo operativo</span><h1>Carte</h1><p>Cerca tra le carte già passate dal team oppure aggiungine una a un nuovo prestito.</p></div><button class="btn" data-page="new">${icon('plus')} Cerca nel catalogo</button></header>
    <section class="surface"><div class="filter-search">${icon('search')}<input type="search" data-collection-query placeholder="Cerca nell’archivio del team…" value="${esc(collectionFilters.query)}"></div>${cards.length ? `<div class="collection-grid compact">${cards.filter(collectionMatchesQuery).map(collectionCard).join('')}</div>` : emptyArchive()}</section></section>`;
}

function collectionMatchesQuery(card) { return card.name.toLowerCase().includes(collectionFilters.query.trim().toLowerCase()); }

function collectionCard(card) {
  const active = card.loans.filter(l => l.status !== 'returned').length;
  const ownerNames = [...card.owners].map(id => member(id)?.name).filter(Boolean);
  return `<button class="collection-card" data-card-key="${esc(card.key)}"><span class="collection-art">${card.image ? `<img src="${card.image}" alt="${esc(card.name)}" loading="lazy">` : icon('card')}</span><span class="collection-info"><strong>${esc(card.name)}</strong><small>${card.externalId ? `ID ${esc(card.externalId)}` : 'Inserimento manuale'}</small><span class="rarity-badge">${card.loans.length} ${card.loans.length === 1 ? 'movimento' : 'movimenti'}</span><span class="owner-line">${ownerNames.slice(0,2).map(name => esc(name.split(' ')[0])).join(', ') || 'Proprietario non disponibile'}</span></span><span class="availability ${active ? 'busy' : 'ok'}"><b>${active}</b><small>attivi</small></span></button>`;
}

function emptyArchive() {
  return `<div class="empty-state">${icon('collection')}<h2>Nessuna carta da mostrare</h2><p>Registra un prestito dal catalogo: la carta apparirà qui con i dati realmente disponibili.</p><button class="btn" data-page="new">Nuovo prestito</button></div>`;
}

function cardDetailView(key) {
  const card = trackedCards().find(item => item.key === key);
  if (!card) return '';
  const owners = [...card.owners].map(id => member(id)).filter(Boolean);
  const active = card.loans.filter(l => l.status !== 'returned');
  return `<div class="detail-backdrop" data-close-detail><aside class="card-detail" role="dialog" aria-modal="true" aria-labelledby="card-detail-title"><button class="detail-close" data-close-detail aria-label="Chiudi">×</button><div class="detail-layout"><div class="detail-art">${card.image ? `<img src="${card.image}" alt="${esc(card.name)}">` : icon('card')}</div><div class="detail-copy"><span class="eyebrow">Dettaglio carta</span><h2 id="card-detail-title">${esc(card.name)}</h2><p>${card.externalId ? `ID catalogo ${esc(card.externalId)}` : 'Carta inserita manualmente'}</p><dl><div><dt>Movimenti registrati</dt><dd>${card.loans.length}</dd></div><div><dt>Prestiti non conclusi</dt><dd>${active.length}</dd></div><div><dt>Gioco</dt><dd>${esc(GAMES[state.game].name)}</dd></div></dl><h3>Proprietari nello storico</h3><div class="owner-list">${owners.map(owner => `<span><i class="mini-avatar member-${owner.id}">${initials(owner.name)}</i><b>${esc(owner.name)}</b></span>`).join('')}</div><div class="actions"><button class="btn" data-page="new">${icon('swap')} Crea prestito</button><button class="btn secondary" disabled title="Funzionalità futura">${icon('chart')} Watchlist futura</button></div><p class="data-note">Set, rarità, lingua, condizione e disponibilità reale richiedono campi dati non ancora presenti.</p></div></div></aside></div>`;
}

function futureView(title, iconName, description) {
  return `<section class="page-stack"><header class="page-header"><div><span class="eyebrow">Prossimamente</span><h1>${title}</h1></div></header><section class="surface empty-state">${icon(iconName)}<h2>Spazio predisposto</h2><p>${description}</p></section></section>`;
}

function settingsView() {
  const supported = pushSupported(), configured = supported && pushConfigured();
  return `<section class="page-stack"><header class="page-header"><div><span class="eyebrow">Preferenze</span><h1>Impostazioni</h1><p>Sessione, notifiche e profilo del dispositivo.</p></div></header><section class="surface settings-list"><div><span>${icon('bell')}<b>Notifiche push</b><small>${!supported ? 'Non supportate' : configured ? 'Attive su questo dispositivo' : 'Non ancora attive'}</small></span><button class="btn secondary small" id="enable-notifications">${configured ? 'Riconfigura' : 'Attiva'}</button></div><div><span>${icon('logout')}<b>Sessione</b><small>Esci in sicurezza da F.P.T Cards</small></span><button class="btn secondary small" data-logout>Esci</button></div></section></section>`;
}

function moreView() {
  const links = [['decks','deck','Mazzi','Costruzione e disponibilità'],['market','chart','Market Watch','Prezzi e watchlist'],['team','team','Team','Membri e amministrazione'],['settings','settings','Impostazioni','Notifiche e sessione']];
  return `<section class="page-stack"><header class="page-header"><div><span class="eyebrow">Navigazione</span><h1>Altro</h1></div></header><section class="surface more-grid">${links.map(([id,iconName,label,detail]) => `<button data-page="${id}">${icon(iconName)}<span><strong>${label}</strong><small>${detail}</small></span>${icon('arrow')}</button>`).join('')}</section></section>`;
}

function newLoanView() {
  const recipients = MEMBERS.filter(item => item.id !== state.currentUser);
  const game = GAMES[state.game];
  const requesting = loanBuilderDraft.mode === 'request';
  const recipient = member(loanBuilderDraft.borrower);
  const copies = draftCards.reduce((total, card) => total + card.quantity, 0);
  const submitDisabled = loanSubmitPending || !draftCards.length || !loanBuilderDraft.borrower;
  return `<section class="loan-builder-page">
    <header class="loan-builder-hero"><div class="loan-builder-emblem">${icon('swap')}</div><div><span class="eyebrow">Loan Builder · ${esc(game.short)}</span><h1>${requesting ? 'Richiedi un prestito' : 'Crea un prestito'}</h1><p>${requesting ? 'Scegli il proprietario e le carte che vuoi ricevere.' : 'Prepara le carte da consegnare a un membro del team.'}</p></div><aside><strong>Come funziona</strong><span>${requesting ? 'Le carte disponibili arrivano dalla raccolta del proprietario selezionato. La richiesta sarà attiva dopo la sua conferma.' : 'Cerca le carte, aggiungile al prestito e scegli il destinatario. Il prestito sarà attivo solo dopo la sua conferma.'}</span></aside></header>
    <form id="loan-form" class="loan-builder-grid">
      <div class="loan-builder-column loan-builder-left">
        <section class="surface loan-builder-panel loan-search-stage"><header><span>${icon('search')}</span><h2>1. Cerca carte</h2></header><p>${requesting ? 'Cerca tra le printing disponibili del proprietario selezionato.' : `Cerca nel catalogo ${esc(game.name)}.`}</p>
          <label class="sr-only" for="card-name">Cerca per nome carta, set o rarità</label><div class="loan-builder-search">${icon('search')}<input id="card-name" type="search" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" value="${esc(loanBuilderDraft.query)}" placeholder="Cerca per nome carta, set, rarità..." aria-controls="card-suggestions"></div>
          <div id="card-suggestions" class="loan-search-results ${loanSearchStatus === 'closed' ? 'is-collapsed' : ''}" aria-live="polite">${loanSearchResultsHtml()}</div>
        </section>
        <section class="surface loan-builder-panel loan-notes"><label for="notes">${icon('card')} <span>Note facoltative</span></label><textarea id="notes" rows="3" maxlength="250" placeholder="Aggiungi note su edizione, rarità, condizioni o altre informazioni utili...">${esc(loanBuilderDraft.notes)}</textarea><small id="notes-count">${loanBuilderDraft.notes.length} / 250</small></section>
      </div>
      <div class="loan-builder-column loan-builder-right">
        <section class="surface loan-builder-panel loan-recipient"><header><span>${icon('team')}</span><h2>2. ${requesting ? 'Richiesta' : 'Prestito'}</h2></header><label for="borrower">${requesting ? 'Proprietario' : 'Destinatario'}</label><div class="recipient-picker"><i class="loan-recipient-avatar member-${esc(recipient?.id || 'empty')}">${recipient ? initials(recipient.name) : '?'}</i><div><strong>${recipient ? esc(recipient.name) : 'Seleziona un membro del team'}</strong><small>${recipient ? (recipient.role === 'admin' ? 'Amministratore' : 'Membro F.P.T') : (requesting ? 'Proprietario richiesto' : 'Destinatario richiesto')}</small></div><select id="borrower" required aria-label="${requesting ? 'Proprietario delle carte' : 'Destinatario del prestito'}"><option value="">Seleziona un membro</option>${recipients.map(m => `<option value="${esc(m.id)}" ${m.id === loanBuilderDraft.borrower ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div></section>
        <section class="surface loan-builder-panel selected-loan-cards"><h3>${requesting ? 'Carte che vuoi richiedere' : 'Carte selezionate per il prestito'}</h3><div class="draft-list">${draftCards.length ? draftCards.map(selectedLoanCardHtml).join('') : `<div class="loan-builder-empty">${icon('card')}<strong>Nessuna carta aggiunta</strong><span>${requesting && !recipient ? 'Seleziona prima il proprietario, poi cerca una carta.' : 'Cerca una carta e aggiungila al prestito.'}</span></div>`}</div></section>
        <section class="loan-builder-summary"><div class="loan-totals">${icon('collection')} <strong>${draftCards.length}</strong> ${draftCards.length === 1 ? 'carta' : 'carte'} <i>·</i> <strong>${copies}</strong> ${copies === 1 ? 'copia totale' : 'copie totali'}</div><div class="loan-mode-switch ${requesting ? 'request' : 'lend'}" role="group" aria-label="Direzione prestito"><button type="button" data-loan-mode="request" class="${requesting ? 'active' : ''}" aria-pressed="${requesting}">${icon('collection')} Ricevo in prestito</button><button type="button" data-loan-mode="lend" class="${requesting ? '' : 'active'}" aria-pressed="${!requesting}">${icon('swap')} Do in prestito</button></div><div class="loan-direction-flag ${requesting ? 'request' : 'lend'}" role="status"><span>${icon('swap')}<b>${requesting ? 'Stai richiedendo' : 'Stai prestando'}</b></span><small>${requesting ? `Le carte arriveranno a te${recipient ? ` da ${esc(recipient.name)}` : ' dal proprietario che selezionerai'}.` : `Le carte partiranno da te${recipient ? ` verso ${esc(recipient.name)}` : ' verso il membro che selezionerai'}.`}</small></div><p>${icon('info')} ${requesting ? 'Il proprietario dovrà accettare la richiesta e confermare la quantità.' : 'Il destinatario dovrà accettare prima che il prestito risulti attivo.'}</p><button class="btn wide loan-submit" type="submit" ${submitDisabled ? 'disabled' : ''}>${loanSubmitPending ? '<span class="button-spinner"></span> Invio in corso…' : `${icon('swap')} ${requesting ? 'Invia richiesta di prestito' : 'Invia proposta di prestito'}`}</button></section>
      </div>
    </form>
  </section>`;
}

function loanSearchResultsHtml() {
  if (loanSearchStatus === 'closed') return '';
  if (loanSearchStatus === 'owner-required') return '<div class="loan-search-state">Seleziona prima il proprietario delle carte.</div>';
  if (loanSearchStatus === 'loading') return '<div class="loan-search-state"><span class="loading-spinner"></span> Ricerca nel catalogo…</div>';
  if (loanSearchStatus === 'error') return '<div class="loan-search-state error">Ricerca non disponibile. Riprova.</div>';
  if (loanSearchStatus === 'empty') return '<div class="loan-search-state">Nessuna carta trovata.</div>';
  if (!loanSearchResults.length) return '<div class="loan-search-state quiet">Inserisci almeno 3 caratteri per iniziare.</div>';
  if (loanBuilderDraft.mode === 'request') {
    const rows = loanSearchResults.flatMap((card, index) => requestableInventory(card).map(item => ({card,index,item})));
    if (!rows.length) return '<div class="loan-search-state">Questo membro non possiede printing disponibili per la ricerca.</div>';
    return rows.map(({card,index,item}) => {
      const meta = [item.setCode, item.setName, item.rarity, `${item.quantityAvailable} disponibili`].filter(Boolean).join(' · ');
      return `<article class="loan-search-result">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="">` : `<span class="loan-result-placeholder">${icon('card')}</span>`}<div><strong>${esc(item.cardName || card.name)}</strong><small>${esc(meta)}</small></div>${item.rarity ? `<span class="rarity-chip">${esc(shortRarity(item.rarity))}</span>` : ''}<button type="button" class="btn secondary" data-card-result="${index}" data-inventory-id="${esc(item.id)}">${icon('plus')} Richiedi</button></article>`;
    }).join('');
  }
  return loanSearchResults.map((card, index) => {
    const printing = card.printings?.[0] || {};
    const meta = [printing.setCode || `ID ${card.id}`, printing.setName].filter(Boolean).join(' · ');
    return `<article class="loan-search-result">${card.image ? `<img src="${esc(card.image)}" alt="">` : `<span class="loan-result-placeholder">${icon('card')}</span>`}<div><strong>${esc(card.name)}</strong><small>${esc(meta || card.type || 'Printing non specificata')}</small></div>${printing.rarity ? `<span class="rarity-chip">${esc(shortRarity(printing.rarity))}</span>` : ''}<button type="button" class="btn secondary" data-card-result="${index}">${icon('plus')} Aggiungi</button></article>`;
  }).join('');
}

function requestableInventory(card) {
  const owner = loanBuilderDraft.borrower;
  if (!owner) return [];
  return state.collection.team.filter(item => item.ownerSlug === owner
    && item.ownerSlug !== state.currentUser
    && item.game === state.game
    && String(item.catalogCardId) === String(card.id)
    && item.quantityAvailable > 0
    && !item.legacyAmbiguous);
}

function selectedLoanCardHtml(card, index) {
  const meta = [card.setCode, card.setName].filter(Boolean).join(' · ') || (card.id ? `ID ${card.id}` : 'Carta manuale');
  const atMax = Number.isFinite(card.maxQuantity) && card.quantity >= card.maxQuantity;
  const preview = card.thumbnail || card.image;
  return `<article class="draft-card" data-draft-key="${esc(draftCardKey(card))}">${preview ? `<img src="${esc(preview)}" alt="">` : `<span class="draft-placeholder">${icon('card')}</span>`}<div class="draft-card-copy"><strong>${esc(card.name)}</strong><small>${esc(meta)}</small></div>${card.rarity ? `<span class="rarity-chip">${esc(shortRarity(card.rarity))}</span>` : ''}<div class="draft-stepper"><button type="button" data-draft-quantity="minus" data-index="${index}" aria-label="Riduci quantità di ${esc(card.name)}" ${card.quantity <= 1 ? 'disabled' : ''}>−</button><output aria-live="polite">${card.quantity}</output><button type="button" data-draft-quantity="plus" data-index="${index}" aria-label="Aumenta quantità di ${esc(card.name)}" ${atMax ? 'disabled' : ''}>+</button></div><button type="button" class="draft-remove" data-remove-card="${index}" aria-label="Rimuovi ${esc(card.name)}">${icon('trash')}</button></article>`;
}

function shortRarity(value) {
  const words = String(value).trim().split(/\s+/);
  return words.length > 1 ? words.map(word => word[0]).join('').toUpperCase().slice(0, 3) : value.slice(0, 3).toUpperCase();
}

function loansView() {
  const base = loanBase();
  const relevant = filteredLoans();
  const others = MEMBERS.filter(m => m.id !== state.currentUser);
  const attention = base.filter(loan => ['pending','requested','reserved','return_pending'].includes(loan.status)).length;
  const active = base.filter(loan => loan.status === 'active').length;
  const returned = base.filter(loan => ['returned','completed'].includes(loan.status)).length;
  return `<section class="loan-archive-page">
    <header class="loan-archive-hero"><div class="loan-builder-emblem">${icon('swap')}</div><div><span class="eyebrow">Sala prestiti · ${esc(GAMES[state.game].short)}</span><h1>Prestiti</h1><p>Controlla ogni movimento del team e gestisci consegne e restituzioni.</p></div><aside><strong>${base.length} movimenti registrati</strong><span>${attention ? `${attention} ${attention === 1 ? 'richiede' : 'richiedono'} la tua attenzione.` : 'Tutti i movimenti sono sotto controllo.'}</span><button type="button" class="btn" data-page="new">${icon('plus')} Nuovo prestito</button></aside></header>
    <div class="loan-kpi-strip" aria-label="Riepilogo prestiti"><article class="attention"><span>${icon('bell')}</span><div><small>Da gestire</small><strong>${attention}</strong><em>azioni richieste</em></div></article><article class="active"><span>${icon('swap')}</span><div><small>Prestiti attivi</small><strong>${active}</strong><em>in corso</em></div></article><article class="returned"><span>${icon('collection')}</span><div><small>Restituiti</small><strong>${returned}</strong><em>movimenti conclusi</em></div></article></div>
    <section class="surface loan-manager">
      <header class="loan-manager-head"><div><span class="eyebrow">Archivio operativo</span><h2>Movimenti del team</h2></div><span class="total-pill">${base.length} totali</span></header>
      <div class="loan-toolbar"><div class="search-field"><span aria-hidden="true">${icon('search')}</span><input id="loan-query" type="search" aria-label="Cerca carta" value="${esc(loanFilters.query)}" placeholder="Cerca una carta..."></div>
      <div class="filter-grid"><div><label for="loan-direction">Movimento</label><select id="loan-direction">
        <option value="all" ${loanFilters.direction === 'all' ? 'selected' : ''}>Tutti</option>
        <option value="received" ${loanFilters.direction === 'received' ? 'selected' : ''}>Ricevute da</option>
        <option value="lent" ${loanFilters.direction === 'lent' ? 'selected' : ''}>Prestate a</option>
      </select></div><div><label for="loan-member">Membro</label><select id="loan-member">
        <option value="all" ${loanFilters.member === 'all' ? 'selected' : ''}>Tutti i membri</option>${others.map(m => `<option value="${esc(m.id)}" ${loanFilters.member === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
      </select></div></div></div>
      <div class="filter-chips">${[['all','Tutti'],['attention','Da gestire'],['requested','Richieste'],['reserved','Riservati'],['active','Attivi'],['completed','Conclusi'],['rejected','Rifiutati']].map(([id,label]) => `<button type="button" class="chip ${loanFilters.status === id ? 'active' : ''}" data-status-filter="${id}">${label}</button>`).join('')}</div>
      <div class="list-summary"><span id="loan-result-count"><strong>${relevant.length}</strong> ${relevant.length === 1 ? 'risultato' : 'risultati'}</span><button type="button" class="clear-filters ${loanFilters.direction === 'all' && loanFilters.member === 'all' && loanFilters.status === 'all' && !loanFilters.query ? 'hidden' : ''}" id="clear-filters">Azzera filtri</button></div>
      <div class="loan-list">${loanRowsHtml(relevant)}</div>
    </section>
  </section>`;
}

function loanBase() {
  return [...state.loans]
    .filter(l => l.game === state.game && (l.owner === state.currentUser || l.borrower === state.currentUser))
    .reverse();
}

function filteredLoans() {
  return loanBase().filter(l => {
    const directionOk = loanFilters.direction === 'all'
      || (loanFilters.direction === 'received' && l.borrower === state.currentUser)
      || (loanFilters.direction === 'lent' && l.owner === state.currentUser);
    const otherMember = l.owner === state.currentUser ? l.borrower : l.owner;
    const memberOk = loanFilters.member === 'all' || otherMember === loanFilters.member;
    const queryOk = l.cardName.toLowerCase().includes(loanFilters.query.toLowerCase());
    const statusOk = loanFilters.status === 'all'
      || (loanFilters.status === 'attention' ? ['pending','requested','reserved','return_pending'].includes(l.status) : false)
      || (loanFilters.status === 'requested' ? ['pending','requested'].includes(l.status) : false)
      || (loanFilters.status === 'completed' ? ['returned','completed'].includes(l.status) : l.status === loanFilters.status);
    return directionOk && memberOk && queryOk && statusOk;
  });
}

function loanRowsHtml(loans) { return loans.length ? loans.map(loanListRow).join('') : '<div class="empty">Nessun prestito corrisponde ai filtri.</div>'; }

function loanListRow(l) {
  const outgoing = l.owner === state.currentUser;
  const incoming = l.borrower === state.currentUser;
  const owner = member(l.owner);
  const borrower = member(l.borrower);
  const person = outgoing ? borrower : owner;
  const presentation = loanPresentation(l, outgoing, incoming, owner, borrower);
  let buttons = '';
  const isAdmin = state.role === 'admin';
  const remaining = Math.max(0, (l.acceptedQuantity || l.quantity) - (l.returnedQuantity || 0));
  const inventory = [...(state.collection.mine || []), ...(state.collection.team || [])].find(item => item.id === l.collectionItemId);
  const available = inventory?.quantityAvailable;
  if (l.status === 'requested' && outgoing) buttons = `<div class="request-response"><label>Quantità da accettare<input type="number" min="1" max="${Math.min(l.requestedQuantity, available ?? l.requestedQuantity)}" value="${Math.min(l.requestedQuantity, available ?? l.requestedQuantity)}" data-accept-qty="${l.id}"></label><button class="btn small" data-action="accept-request" data-id="${l.id}">Accetta</button><button class="btn secondary danger small" data-action="reject-request" data-id="${l.id}">Rifiuta</button></div>`;
  if (l.status === 'reserved' && incoming) buttons = `<button class="btn small" data-action="activate" data-id="${l.id}">Conferma ricezione</button>`;
  if (l.status === 'pending' && !outgoing) buttons = `<button class="btn small" data-action="accept" data-id="${l.id}">Accetta</button><button class="btn secondary danger small" data-action="reject" data-id="${l.id}">Rifiuta</button>`;
  if (l.status === 'active' && !outgoing) buttons = `<div class="partial-return"><input type="number" min="1" max="${remaining}" value="${remaining}" data-return-qty="${l.id}" aria-label="Quantità da restituire"><button class="btn secondary small" data-action="return" data-id="${l.id}">Restituisci</button></div>`;
  if (l.status === 'return_pending' && outgoing) buttons = `<button class="btn small" data-action="confirm-return" data-id="${l.id}">Conferma ${l.pendingReturnQuantity || remaining} pz</button>`;
  if (isAdmin && !buttons) buttons = `<button class="btn secondary danger small" data-action="admin-delete" data-id="${l.id}">Elimina</button>`;
  const shownQuantity = ['returned','completed'].includes(l.status) ? l.quantity : remaining;
  const visual = l.image ? `<div class="loan-thumb"><img src="${l.image}" alt="" loading="lazy"><em>${shownQuantity}</em></div>` : `<div class="loan-qty">${shownQuantity}<small>pz</small></div>`;
  const memberMarker = person ? `<i class="member-dot ${person.id}"></i>` : '';
  const printing = [l.setCode,l.setName,l.rarity].filter(Boolean).join(' · ');
  const quantities = l.acceptedQuantity > 0 && l.requestedQuantity !== l.acceptedQuantity ? `<p class="quantity-help">Richieste ${l.requestedQuantity} · accettate ${l.acceptedQuantity} · rimanenti ${remaining}</p>` : l.status === 'requested' ? `<p class="quantity-help">Richieste ${l.requestedQuantity}${Number.isFinite(available) ? ` · disponibili ora ${available}` : ''}</p>` : '';
  return `<details class="loan-row ${presentation.kind}"><summary>${visual}<div class="loan-main"><strong>${esc(l.cardName)}</strong>${printing ? `<small>${esc(printing)}</small>` : ''}<span class="direction-line"><b class="direction-tag ${presentation.kind}">${presentation.direction}</b> ${memberMarker}${presentation.person}</span><small class="next-action ${presentation.urgent ? 'urgent' : ''}">${presentation.action}</small></div><span class="badge ${presentation.badgeClass}">${presentation.shortStatus}</span></summary><div class="loan-detail"><div class="ownership"><span><small>Proprietario</small><b>${owner.name}</b></span><span>→</span><span><small>Richiedente</small><b>${borrower.name}</b></span></div><span>Registrato il ${formatDate(l.createdAt)}</span>${quantities}${l.notes ? `<p>${esc(l.notes)}</p>` : '<p>Nessuna nota</p>'}${buttons ? `<div class="actions loan-actions">${buttons}</div>` : ''}</div></details>`;
}

function loanPresentation(l, outgoing, incoming, owner, borrower) {
  if (outgoing) {
    const states = {
      requested: [`${borrower.name} richiede ${l.cardName} ×${l.requestedQuantity}`, 'Da valutare', 'wait', true],
      reserved: ['Attendi la conferma di ricezione', 'Riservata', 'wait', false],
      pending: ['Attendi che il destinatario accetti', 'In attesa', 'wait', false],
      active: ['La carta deve tornare a te', 'Da ricevere', 'outgoing', false],
      return_pending: ['Conferma di aver ricevuto la carta', 'Conferma resa', 'wait', true],
      returned: ['La carta è tornata a te', 'Restituita', 'ok', false],
      completed: ['Prestito concluso', 'Concluso', 'ok', false],
      rejected: ['Richiesta rifiutata', 'Rifiutata', 'ok', false]
    };
    const [action, shortStatus, badgeClass, urgent] = states[l.status];
    return { direction:'HAI PRESTATO A', person:borrower.name, action, shortStatus, badgeClass, urgent, kind:'outgoing' };
  }
  if (incoming) {
    const states = {
      requested: ['Attendi la risposta del proprietario', 'Richiesta', 'wait', false],
      reserved: ['Conferma di aver ricevuto la carta', 'Riservata', 'wait', true],
      pending: ['Devi accettare la consegna', 'Devi accettare', 'wait', true],
      active: ['Devi restituire questa carta', 'Da restituire', 'incoming', true],
      return_pending: ['Attendi la conferma del proprietario', 'In conferma', 'wait', false],
      returned: ['Hai restituito questa carta', 'Restituita', 'ok', false],
      completed: ['Prestito concluso', 'Concluso', 'ok', false],
      rejected: ['La richiesta è stata rifiutata', 'Rifiutata', 'ok', false]
    };
    const [action, shortStatus, badgeClass, urgent] = states[l.status];
    return { direction:'HAI RICEVUTO DA', person:owner.name, action, shortStatus, badgeClass, urgent, kind:'incoming' };
  }
  return { direction:'SCAMBIO DEL TEAM', person:`${owner.name} → ${borrower.name}`, action:statusLabel(l.status), shortStatus:statusLabel(l.status), badgeClass:l.status === 'returned' ? 'ok' : 'team', urgent:false, kind:'team' };
}

function statusLabel(status) { return ({pending:'In attesa (legacy)',requested:'Richiesta',reserved:'Riservata',active:'In prestito',return_pending:'Resa da confermare',returned:'Restituita',completed:'Conclusa',rejected:'Rifiutata'})[status] || 'Aggiornato'; }
function loanCard(l) {
  const isOwner = l.owner === state.currentUser;
  const isAdmin = state.currentUser === 'daniele';
  let buttons = '';
  if (l.status === 'pending' && !isOwner) buttons = `<button class="btn small" data-action="accept" data-id="${l.id}">Accetta</button><button class="btn secondary danger small" data-action="reject" data-id="${l.id}">Rifiuta</button>`;
  if (l.status === 'active' && !isOwner) buttons = `<button class="btn secondary small" data-action="return" data-id="${l.id}">Segnala restituzione</button>`;
  if (l.status === 'return_pending' && isOwner) buttons = `<button class="btn small" data-action="confirm-return" data-id="${l.id}">Conferma restituzione</button>`;
  if (isAdmin && !buttons) buttons = `<button class="btn secondary danger small" data-action="admin-delete" data-id="${l.id}">Elimina</button>`;
  return `<article class="card loan"><div><p><strong>${esc(l.cardName)}</strong> × ${l.quantity}</p><div class="meta">${isOwner ? `A ${member(l.borrower).name}` : `Da ${member(l.owner).name}`} · ${formatDate(l.createdAt)}</div>${l.notes ? `<div class="meta">${esc(l.notes)}</div>` : ''}</div><span class="badge ${l.status === 'returned' ? 'ok' : l.status.includes('pending') ? 'wait' : ''}">${statusLabel(l.status)}</span>${buttons ? `<div class="actions">${buttons}</div>` : ''}</article>`;
}

function teamView() {
  const supported = pushSupported();
  const configured = supported && pushConfigured();
  const notificationState = !supported ? 'Non supportate' : configured ? 'Push attive anche ad app chiusa' : 'Da configurare su questo dispositivo';
  const admin = state.role === 'admin';
  const manager = admin ? `<section class="card member-manager"><div class="dashboard-title"><div><span class="eyebrow">Amministrazione</span><h3>Gestione membri</h3></div></div><form id="member-form"><input id="new-member-name" maxlength="100" placeholder="Nome e cognome" required><button class="btn small" type="submit">Aggiungi</button></form></section>` : '';
  const rows = MEMBERS.map(m => `<div class="card team-member-row"><div class="avatar member-${m.id}">${initials(m.name)}</div><div><strong>${m.name}</strong><small>${m.id === state.currentUser ? 'Tu' : m.role === 'admin' ? 'Amministratore' : 'Membro F.P.T'}</small></div>${admin && m.role !== 'admin' ? `<div class="member-admin-actions"><button class="btn secondary small" data-member-action="reset-pin" data-member-id="${m.id}">Reset PIN</button><button class="btn secondary danger small" data-member-action="deactivate" data-member-id="${m.id}">Disattiva</button></div>` : ''}</div>`).join('');
  return `<h2>Il team</h2><section class="card notification-setting"><div><strong>Notifiche richieste</strong><small>${notificationState}</small></div><button class="btn secondary small" id="enable-notifications">${configured ? 'Riconfigura' : 'Attiva'}</button></section>${manager}<div class="team-list">${rows}</div>`;
}

function bind() {
  document.querySelector('#login-form')?.addEventListener('submit', login);
  document.querySelector('#member')?.addEventListener('change', event => {
    loginDraft.member = event.currentTarget.value;
  });
  document.querySelector('#pin')?.addEventListener('input', event => { loginDraft.pin = event.target.value.replace(/\D/g, '').slice(0, 4); event.target.value = loginDraft.pin; });
  document.querySelector('#toggle-pin')?.addEventListener('click', event => {
    const input = document.querySelector('#pin');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    event.currentTarget.setAttribute('aria-label', input.type === 'password' ? 'Mostra PIN' : 'Nascondi PIN');
  });
  document.querySelectorAll('[data-logout]').forEach(button => button.addEventListener('click', logout));
  const gameSwitcher = document.querySelector('.game-switcher');
  gameSwitcher?.querySelector('.menu-trigger')?.addEventListener('click', event => {
    event.stopPropagation();
    gameMenuOpen = !gameMenuOpen;
    gameSwitcher.classList.toggle('open', gameMenuOpen);
    event.currentTarget.setAttribute('aria-expanded', String(gameMenuOpen));
  });
  document.querySelectorAll('.game-options button[data-game]').forEach(button => {
    button.addEventListener('click', () => selectGame(button.dataset.game));
  });
  document.querySelectorAll('button[data-page]').forEach(b => b.addEventListener('click', () => { selectedCardKey = ''; navigate(b.dataset.page); }));
  document.querySelectorAll('[data-quick]').forEach(b => b.addEventListener('click', () => quickNavigate(b.dataset.quick)));
  document.querySelector('#global-search')?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    collectionFilters.query = event.currentTarget.value;
    navigate('collection');
  });
  document.querySelectorAll('[data-collection-add]').forEach(button => button.addEventListener('click', () => { if (!online()) return toast('Torna online per modificare la raccolta'); collectionEditor = { item:null, card:null, printing:null }; collectionSearchResults = []; render(); }));
  document.querySelectorAll('[data-fast-scan]').forEach(button => button.addEventListener('click', () => navigate('fastscan')));
  document.querySelectorAll('[data-collection-item]').forEach(button => button.addEventListener('click', () => { selectedCollectionItem = button.dataset.collectionItem; render(); }));
  document.querySelectorAll('[data-close-collection-detail]').forEach(element => element.addEventListener('click', event => { if (event.target !== element && !event.target.closest('.detail-close')) return; selectedCollectionItem = ''; render(); }));
  document.querySelectorAll('[data-close-collection-editor]').forEach(element => element.addEventListener('click', event => { if (event.target !== element && !event.target.closest('.detail-close')) return; collectionEditor = null; collectionSearchResults = []; render(); }));
  document.querySelectorAll('[data-close-collection-request]').forEach(element => element.addEventListener('click', event => { if (event.target !== element && !event.target.closest('.detail-close')) return; collectionLoanRequest = null; render(); }));
  document.querySelectorAll('[data-collection-edit]').forEach(button => button.addEventListener('click', () => openCollectionEditor(button.dataset.collectionEdit)));
  document.querySelectorAll('[data-collection-delete]').forEach(button => button.addEventListener('click', () => deleteCollectionItem(button.dataset.collectionDelete)));
  document.querySelectorAll('[data-market-watch-add]').forEach(button => button.addEventListener('click', async () => { try { await api.setMarketWatchItem(button.dataset.marketWatchAdd,true); await marketWatch.load(); toast('Printing aggiunta alla Watchlist'); } catch (error) { toast(error.message||'Watchlist non disponibile'); } }));
  document.querySelectorAll('[data-collection-loan]').forEach(button => button.addEventListener('click', () => createLoanFromCollection(button.dataset.collectionLoan)));
  document.querySelectorAll('[data-request-collection-loan]').forEach(button => button.addEventListener('click', () => openCollectionLoanRequest(button.dataset.requestCollectionLoan)));
  document.querySelector('#collection-card-search')?.addEventListener('input', onCollectionCardSearch);
  document.querySelector('#collection-printing')?.addEventListener('change', event => { if (!collectionEditor?.card) return; collectionEditor.printing = collectionEditor.card.printings[Number(event.currentTarget.value)] || collectionEditor.card.printings[0]; render(); });
  document.querySelector('#collection-form')?.addEventListener('submit', saveCollectionItem);
  document.querySelector('#collection-request-form')?.addEventListener('submit', submitCollectionLoanRequest);
  document.querySelector('#retry-collection')?.addEventListener('click', retryCollection);
  document.querySelectorAll('[data-card-key]').forEach(button => button.addEventListener('click', () => { selectedCardKey = button.dataset.cardKey; render(); }));
  document.querySelectorAll('[data-close-detail]').forEach(element => element.addEventListener('click', event => { if (event.target !== element && !event.target.closest('.detail-close')) return; selectedCardKey = ''; render(); }));
  document.querySelectorAll('[data-member-shortcut]').forEach(b => b.addEventListener('click', () => { loanFilters.member = b.dataset.memberShortcut; page = 'loans'; render(); }));
  document.querySelector('#loan-form')?.addEventListener('submit', createLoan);
  document.querySelector('#card-name')?.addEventListener('input', onCardSearch);
  document.querySelectorAll('[data-remove-card]').forEach(b => b.addEventListener('click', () => { draftCards.splice(Number(b.dataset.removeCard), 1); render(true); }));
  document.querySelectorAll('[data-card-result]').forEach(b => b.addEventListener('click', () => addCatalogCard(b)));
  document.querySelectorAll('[data-draft-quantity]').forEach(button => button.addEventListener('click', () => updateDraftQuantity(Number(button.dataset.index), button.dataset.draftQuantity === 'plus' ? 1 : -1)));
  document.querySelectorAll('[data-loan-mode]').forEach(button => button.addEventListener('click', () => setLoanBuilderMode(button.dataset.loanMode)));
  document.querySelector('#borrower')?.addEventListener('change', event => changeLoanCounterpart(event.currentTarget.value));
  document.querySelector('#notes')?.addEventListener('input', event => { loanBuilderDraft.notes = event.currentTarget.value.slice(0, 250); const count = document.querySelector('#notes-count'); if (count) count.textContent = `${loanBuilderDraft.notes.length} / 250`; });
  document.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => updateLoan(b.dataset.id, b.dataset.action)));
  document.querySelector('#loan-direction')?.addEventListener('change', e => { loanFilters.direction = e.target.value; refreshLoanRows(); });
  document.querySelector('#loan-member')?.addEventListener('change', e => { loanFilters.member = e.target.value; refreshLoanRows(); });
  document.querySelector('#loan-query')?.addEventListener('input', e => { loanFilters.query = e.target.value; refreshLoanRows(); });
  document.querySelectorAll('[data-status-filter]').forEach(b => b.addEventListener('click', () => { loanFilters.status = b.dataset.statusFilter; refreshLoanRows(); }));
  document.querySelector('#clear-filters')?.addEventListener('click', () => { loanFilters = { direction: 'all', member: 'all', query: '', status: 'all' }; refreshLoanRows(true); });
  document.querySelector('#reset-data')?.addEventListener('click', () => toast('I dati condivisi non si cancellano dal dispositivo'));
  document.querySelector('#enable-notifications')?.addEventListener('click', enableNotifications);
  document.querySelector('#member-form')?.addEventListener('submit', addMember);
  document.querySelectorAll('[data-member-action]').forEach(button => button.addEventListener('click', () => manageMember(button.dataset.memberAction, button.dataset.memberId)));
  document.querySelector('#retry-cloud')?.addEventListener('click', retryCloud);
  document.querySelector('[data-rick-secret]')?.addEventListener('click', secretRickroll);
  if (page === 'decks') decks.bind(document);
  if (page === 'market') marketWatch.bind(document);
  if (page === 'fastscan') fastScan.bind(document);
}

function installCollectionControls() {
  const root = document.querySelector('#app');
  if (!root || root.dataset.collectionControls === 'ready') return;
  root.dataset.collectionControls = 'ready';
  root.addEventListener('input', event => {
    if (!event.target.matches('[data-collection-query]')) return;
    collectionFilters.query = event.target.value;
    if (document.querySelector('[data-collection-results]')) refreshCollectionResults();
    else {
      clearTimeout(collectionSearchTimer);
      collectionSearchTimer = setTimeout(() => {
        render();
        const field = document.querySelector('[data-collection-query]');
        field?.focus();
        field?.setSelectionRange(field.value.length, field.value.length);
      }, 220);
    }
  });
  root.addEventListener('change', event => {
    if (event.target.matches('#collection-owner')) collectionFilters.owner = event.target.value;
    else if (event.target.matches('#collection-status')) collectionFilters.status = event.target.value;
    else return;
    refreshCollectionResults();
  });
  root.addEventListener('click', event => {
    const scope = event.target.closest('[data-collection-scope]');
    if (scope) {
      collectionFilters.scope = scope.dataset.collectionScope;
      collectionFilters.owner = 'all';
      collectionFilters.status = 'all';
      selectedCollectionItem = '';
      render();
      return;
    }
    const layout = event.target.closest('[data-collection-layout]');
    if (!layout) return;
    collectionFilters.layout = layout.dataset.collectionLayout;
    root.querySelectorAll('[data-collection-layout]').forEach(button => button.classList.toggle('active', button === layout));
    refreshCollectionResults();
  });
}

function refreshCollectionResults() {
  const results = document.querySelector('[data-collection-results]');
  if (!results) return;
  results.innerHTML = collectionResultsView(state.collection, collectionFilters, state.game, online());
  results.querySelectorAll('[data-collection-item]').forEach(button => button.addEventListener('click', () => {
    selectedCollectionItem = button.dataset.collectionItem;
    render();
  }));
  results.querySelectorAll('[data-collection-add]').forEach(button => button.addEventListener('click', () => {
    if (!online()) return toast('Torna online per modificare la raccolta');
    collectionEditor = { item:null, card:null, printing:null };
    collectionSearchResults = [];
    render();
  }));
}

function secretRickroll() {
  window.clearTimeout(secretTapTimer);
  secretTaps += 1;
  if (secretTaps >= 5) {
    secretTaps = 0;
    triggerRickrollVideo();
    return;
  }
  secretTapTimer = window.setTimeout(() => { secretTaps = 0; }, 1800);
}

function selectGame(game) {
  if (!GAMES[game]) return;
  const changed = state.game !== game;
  state.game = game; gameMenuOpen = false;
  if (changed) {
    draftCards = [];
    loanBuilderDraft = { borrower:'', notes:'', query:'', mode:'lend' };
    loanSearchResults = []; loanSearchStatus = 'idle';
  }
  loanFilters = { direction:'all', member:'all', query:'', status:'all' };
  saveState(); render();
}

function refreshLoanRows(resetControls = false) {
  const loans = filteredLoans();
  const list = document.querySelector('.loan-list');
  const count = document.querySelector('#loan-result-count');
  const clear = document.querySelector('#clear-filters');
  if (list) list.innerHTML = loanRowsHtml(loans);
  if (count) count.innerHTML = `<strong>${loans.length}</strong> ${loans.length === 1 ? 'risultato' : 'risultati'}`;
  if (clear) clear.classList.toggle('hidden', loanFilters.direction === 'all' && loanFilters.member === 'all' && loanFilters.status === 'all' && !loanFilters.query);
  document.querySelectorAll('[data-status-filter]').forEach(button => button.classList.toggle('active', button.dataset.statusFilter === loanFilters.status));
  if (resetControls) {
    const direction = document.querySelector('#loan-direction');
    const memberField = document.querySelector('#loan-member');
    const query = document.querySelector('#loan-query');
    if (direction) direction.value = loanFilters.direction;
    if (memberField) memberField.value = loanFilters.member;
    if (query) query.value = loanFilters.query;
  }
  document.querySelectorAll('.loan-list [data-action]').forEach(b => b.addEventListener('click', () => updateLoan(b.dataset.id, b.dataset.action)));
}

function quickNavigate(target) {
  if (target === 'new') page = 'new';
  else {
    page = 'loans';
    loanFilters.direction = target === 'received' ? 'received' : target === 'lent' ? 'lent' : 'all';
    loanFilters.status = target === 'attention' ? 'attention' : 'all';
  }
  navigate(page);
}

function mapCollectionItem(item) {
  const storedImage = normalizeCardImageUrl(item.image_url);
  return {
    id:item.id, printingId:item.printing_id, ownerSlug:item.owner_slug,
    ownerName:item.owner_name, game:item.game, catalogCardId:item.catalog_card_id,
    cardName:item.card_name, setCode:item.set_code || '', setName:item.set_name || '',
    rarity:item.rarity || '', language:item.language || 'Italiano',
    condition:item.condition || 'Near Mint', edition:item.edition || '',
    imageUrl:item.game === 'yugioh' ? (storedImage || canonicalYgoCardImage(item.catalog_card_id)) : storedImage, quantityOwned:Number(item.quantity_owned || 0),
    quantityLoaned:Number(item.quantity_loaned || 0),
    quantityReserved:Number(item.quantity_reserved || 0),
    quantityAvailable:Number(item.quantity_physically_available ?? item.quantity_available ?? 0),
    legacyAmbiguous:Boolean(item.legacy_ambiguous), createdAt:item.created_at,
    updatedAt:item.updated_at
  };
}

async function loadCollection() {
  const [mine, team] = await Promise.all([api.myCollection(), api.teamCollection()]);
  state.collection = {
    mine:(mine || []).map(mapCollectionItem),
    team:(team || []).map(mapCollectionItem),
    syncedAt:new Date().toISOString()
  };
  syncLoanImagesFromCollection();
  collectionError = '';
  scheduleCatalogRepairs();
}

async function loadDecks() {
  try { await decks.load(); decks.error=''; }
  catch (error) { decks.error=/list_my_decks/i.test(error.message||'')?'Applica la migrazione Mazzi su Supabase per attivare il salvataggio.':(error.message||'Mazzi non disponibili'); }
}

async function loadPrimaryData() {
  const [loansResult, collectionResult] = await Promise.allSettled([
    loadCloudLoans(),
    loadCollection(),
    loadDecks(),
    marketWatch.load()
  ]);
  if (collectionResult.status === 'rejected') collectionError = collectionResult.reason?.message || 'Raccolta non disponibile';
  if (loansResult.status === 'rejected') cloudError = loansResult.reason?.message || 'Sincronizzazione non riuscita';
  else cloudError = '';
  syncLoanImagesFromCollection();
  return loansResult.status === 'rejected' ? loansResult.reason : null;
}

function syncLoanImagesFromCollection() {
  const items = [...state.collection.mine, ...state.collection.team];
  const byId = new Map(items.map(item => [String(item.id), item]));
  state.loans.forEach(loan => {
    const linked = loan.collectionItemId ? byId.get(String(loan.collectionItemId)) : null;
    const item = linked || items.find(candidate => candidate.game === loan.game
      && normalizeIdentityName(candidate.cardName) === normalizeIdentityName(loan.cardName));
    if (!item?.imageUrl) return;
    const changed = loan.image !== item.imageUrl
      || String(loan.externalId || '') !== String(item.catalogCardId || '');
    loan.image = item.imageUrl;
    loan.externalId = item.catalogCardId || loan.externalId;
    if (changed && loan.id && loan.externalId) {
      void api.enrichLoan(loan.id, {
        id:loan.externalId,
        image:item.imageUrl,
        fullImage:item.imageUrl
      }).catch(() => {});
    }
  });
}

function normalizeIdentityName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
}

async function quarantineMismatchedCollectionImages() {
  const unique = new Map([...state.collection.mine, ...state.collection.team].map(item => [item.id, item]));
  const items = [...unique.values()].filter(item => item.game === 'yugioh' && item.cardName);
  let changed = false;
  await runLimited(items, 4, async item => {
    const card = await resolveStoredCard({ id:item.catalogCardId, name:item.cardName, setCode:item.setCode }, item.game);
    if (!card) return;
    const correctImage = card.fullImage || card.image || '';
    const idMismatch = String(card.id) !== String(item.catalogCardId || '');
    const imageMismatch = cardImageMatches(card, item.imageUrl) === false || (!item.imageUrl && correctImage);
    if (!idMismatch && !imageMismatch) return;
    item.imageUrl = correctImage;
    item.catalogCardId = String(card.id);
    item.imageMismatch = true;
    changed = true;
    if (item.ownerSlug === state.currentUser) void persistCollectionImageRepair(item, card);
  });
  return changed;
}

async function runLimited(items, limit, task) {
  let cursor = 0;
  const workers = Array.from({ length:Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await task(item);
    }
  });
  await Promise.all(workers);
}

function scheduleCatalogRepairs() {
  catalogRepairQueued = true;
  if (catalogRepairRunning) return;
  window.setTimeout(() => void runCatalogRepairs(), 0);
}

async function runCatalogRepairs() {
  if (catalogRepairRunning) return;
  catalogRepairRunning = true;
  try {
    while (catalogRepairQueued && state.currentUser) {
      catalogRepairQueued = false;
      const [collectionChanged, loansChanged] = await Promise.all([
        quarantineMismatchedCollectionImages(),
        quarantineMismatchedLoanImages()
      ]);
      if (!collectionChanged && !loansChanged) continue;
      saveState();
      const editing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
      if (!editing && page !== 'fastscan') renderRoute();
    }
  } catch {} finally {
    catalogRepairRunning = false;
    if (catalogRepairQueued && state.currentUser) scheduleCatalogRepairs();
  }
}

async function persistCollectionImageRepair(item, card) {
  try {
    await api.saveCollection({
      id:item.id, game:item.game, catalogCardId:String(card.id), cardName:card.name,
      setCode:item.setCode, setName:item.setName, rarity:item.rarity,
      language:item.language, condition:item.condition, edition:item.edition,
      imageUrl:card.fullImage || card.image || '', quantityOwned:item.quantityOwned
    });
  } catch {}
}

async function retryCollection() {
  if (!online()) return toast('Sei offline: impossibile sincronizzare la raccolta');
  try { await loadCollection(); saveState(); render(); }
  catch (error) { collectionError = error.message || 'Raccolta non disponibile'; render(); }
}

async function openCollectionEditor(id) {
  if (!online()) return toast('Torna online per modificare la raccolta');
  const item = state.collection.mine.find(entry => entry.id === id);
  if (!item) return;
  const currentPrinting = { setCode:item.setCode, setName:item.setName, rarity:item.rarity };
  const initialCard = { id:item.catalogCardId, name:item.cardName, image:item.imageUrl, fullImage:item.imageUrl, printings:[currentPrinting] };
  collectionEditor = { item, card:initialCard, printing:currentPrinting };
  selectedCollectionItem = '';
  render();
  const expectedId = item.id;
  const catalog = await findCard(item.cardName, item.game);
  if (!catalog || collectionEditor?.item?.id !== expectedId) return;
  if (!catalog.printings.some(printing => printing.setCode === item.setCode && printing.rarity === item.rarity)) catalog.printings.unshift(currentPrinting);
  collectionEditor.card = catalog;
  collectionEditor.printing = catalog.printings.find(printing => printing.setCode === item.setCode && printing.rarity === item.rarity) || catalog.printings[0];
  render();
}

function onCollectionCardSearch(event) {
  clearTimeout(collectionSearchTimer);
  const query = event.currentTarget.value;
  const sequence = ++collectionSearchSequence;
  collectionSearchTimer = setTimeout(async () => {
    const box = document.querySelector('#collection-card-suggestions');
    if (!box || query.trim().length < 3) { if (box) box.innerHTML = ''; return; }
    box.innerHTML = '<div class="suggestion-status">Ricerca nel catalogo…</div>';
    const results = await searchCards(query, state.game);
    if (sequence !== collectionSearchSequence || box !== document.querySelector('#collection-card-suggestions')) return;
    collectionSearchResults = results;
    box.innerHTML = results.length ? results.map((card, index) => `<button type="button" data-collection-card-result="${index}">${card.image ? `<img src="${esc(card.image)}" alt="">` : ''}<span><strong>${esc(card.name)}</strong><small>${esc(card.type || `${card.printings.length} printing`)}</small></span></button>`).join('') : '<div class="suggestion-status error">Nessuna carta trovata. Verifica il nome o riprova.</div>';
    box.querySelectorAll('[data-collection-card-result]').forEach(button => button.addEventListener('click', () => {
      const card = collectionSearchResults[Number(button.dataset.collectionCardResult)];
      if (!card || !collectionEditor) return;
      collectionEditor.card = card;
      collectionEditor.printing = card.printings[0] || { setCode:'', setName:'', rarity:'' };
      render();
    }));
  }, 320);
}

async function saveCollectionItem(event) {
  event.preventDefault();
  if (collectionPending || !collectionEditor?.card) return;
  if (!online()) return toast('Torna online per salvare la raccolta');
  const quantityOwned = Number(document.querySelector('#collection-owned')?.value);
  if (!Number.isInteger(quantityOwned) || quantityOwned < 1 || quantityOwned > 999) return toast('Inserisci una quantità valida');
  const card = collectionEditor.card;
  const printing = collectionEditor.printing || card.printings[0] || {};
  const submit = event.submitter;
  let catalogWarning = '';
  collectionPending = true;
  if (submit) { submit.disabled = true; submit.textContent = 'Salvataggio…'; }
  try {
    const reconciliation = await reconcileCatalogCard({ game:state.game, catalogCardId:card.id, cardName:card.name,
      setCode:printing.setCode || '', rarity:printing.rarity || '', imageUrl:card.fullImage || card.image || '' });
    if (reconciliation.status === 'mismatch') throw new Error(`Dati catalogo incoerenti: ${reconciliation.issues.join('. ')}`);
    if (reconciliation.status === 'warning') catalogWarning = reconciliation.issues.join('. ');
    await api.saveCollection({
      id:collectionEditor.item?.id || null, game:state.game, catalogCardId:card.id,
      cardName:card.name, setCode:printing.setCode || '', setName:printing.setName || '',
      rarity:printing.rarity || '', language:document.querySelector('#collection-language').value,
      condition:document.querySelector('#collection-condition').value,
      edition:document.querySelector('#collection-edition').value.trim(),
      imageUrl:card.fullImage || card.image || '', quantityOwned
    });
    await loadCollection(); saveState(); collectionEditor = null; render(); toast(catalogWarning ? `Raccolta aggiornata · verifica: ${catalogWarning}` : 'Raccolta aggiornata');
  } catch (error) { toast(error.message || 'Salvataggio non riuscito'); }
  finally { collectionPending = false; if (submit?.isConnected) { submit.disabled = false; submit.textContent = 'Salva nella raccolta'; } }
}

async function deleteCollectionItem(id) {
  const item = state.collection.mine.find(entry => entry.id === id);
  if (!item || !online()) return;
  if (!confirm(`Rimuovere ${item.cardName} dalla tua raccolta?`)) return;
  try {
    await api.deleteCollection(id); await loadCollection(); saveState();
    selectedCollectionItem = ''; render(); toast('Carta rimossa dalla raccolta');
  } catch (error) { toast(error.message || 'Rimozione non riuscita'); }
}

function createLoanFromCollection(id) {
  const item = state.collection.mine.find(entry => entry.id === id);
  if (!item || item.quantityAvailable < 1) return toast('Nessuna copia disponibile da prestare');
  draftCards = [{
    id:item.catalogCardId, name:item.cardName, quantity:1, image:item.imageUrl,
    setCode:item.setCode, setName:item.setName, rarity:item.rarity,
    collectionItemId:item.id, maxQuantity:item.quantityAvailable
  }];
  loanBuilderDraft = { borrower:'', notes:'', query:'', mode:'lend' };
  loanSearchResults = []; loanSearchStatus = 'idle';
  selectedCollectionItem = '';
  navigate('new');
}

function openCollectionLoanRequest(id) {
  const item = state.collection.team.find(entry => entry.id === id);
  if (!item || item.ownerSlug === state.currentUser || item.quantityAvailable < 1 || item.legacyAmbiguous || !online()) {
    return toast('Questa printing non è richiedibile in modo sicuro');
  }
  selectedCollectionItem = '';
  collectionLoanRequest = item;
  render();
}

async function submitCollectionLoanRequest(event) {
  event.preventDefault();
  const item = collectionLoanRequest;
  const quantity = Number(document.querySelector('#collection-request-quantity')?.value);
  const notes = document.querySelector('#collection-request-notes')?.value.trim() || '';
  if (!item || !Number.isInteger(quantity) || quantity < 1 || quantity > item.quantityAvailable || notes.length > 500) return toast('Dati richiesta non validi');
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    await api.requestCollectionLoan(item.id, quantity, notes);
    await Promise.all([loadCloudLoans(), loadCollection()]);
    collectionLoanRequest = null; saveState(); render(); toast('Richiesta inviata al proprietario');
  } catch (error) { toast(error.message || 'Richiesta non riuscita'); if (submit?.isConnected) submit.disabled = false; }
}

async function loadMembers() {
  const items = await api.members();
  state.members = items;
  setMembers(items);
}

async function addMember(event) {
  event.preventDefault();
  const name = document.querySelector('#new-member-name').value.trim();
  const slug = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (name.length < 2 || !slug) return toast('Inserisci un nome valido');
  try {
    await api.manageMember('add', slug, name);
    await loadMembers(); render(); toast('Membro aggiunto');
  } catch (error) { toast(error.message); }
}

async function manageMember(action, slug) {
  const target = member(slug);
  if (!target) return;
  if (action === 'deactivate' && !confirm(`Disattivare ${target.name}?`)) return;
  if (action === 'reset-pin' && !confirm(`Azzerare il PIN di ${target.name}?`)) return;
  try {
    await api.manageMember(action, slug);
    await loadMembers(); render();
    toast(action === 'deactivate' ? 'Membro disattivato' : 'PIN azzerato');
  } catch (error) { toast(error.message); }
}

async function retryCloud() {
  appLoading = true; cloudError = ''; render();
  try { await Promise.all([loadMembers(),loadPrimaryData()]); saveState(); }
  catch (error) { cloudError = error.message || 'Sincronizzazione non riuscita'; }
  finally { appLoading = false; render(); }
}

async function login(e) {
  e.preventDefault();
  if (loginPending) return;
  const id = document.querySelector('#member').value;
  const pin = document.querySelector('#pin').value;
  if (!id) return toast('Seleziona il tuo profilo');
  if (!/^\d{4}$/.test(pin)) return toast('Inserisci un PIN di 4 cifre');
  loginDraft = { member:id, pin };
  loginPending = true;
  try {
    const submit = e.submitter;
    if (submit) { submit.disabled = true; submit.textContent = 'Accesso...'; }
    const profile = await api.login(id, pin);
    state.currentUser = profile.slug;
    state.role = profile.role;
    initEasterEgg();
    loginDraft = { member:'', pin:'' };
    saveState();
    render();
    await loadPrimaryData();
    startRealtime();
    saveState();
  } catch (error) {
    const message = /fetch|network|failed to fetch/i.test(error.message || '')
      ? 'Database non raggiungibile. Controlla che il progetto Supabase sia attivo.'
      : (error.message || 'Accesso non riuscito');
    toast(message);
  } finally {
    loginPending = false;
    if (state.currentUser) render();
    else {
      const submit = document.querySelector('#login-form .btn[type="submit"]');
      if (submit) { submit.disabled = false; submit.innerHTML = `${icon('logout')} Accedi`; }
    }
  }
}

async function logout() {
  await fastScan.leave();
  api.unsubscribe();
  await api.logout();
  state.currentUser = null; state.role = null; state.loans = []; state.collection = { mine:[], team:[], syncedAt:null }; state.decks=[]; saveState(); page = 'home'; history.replaceState(null, '', '#/home'); render();
}

async function enableNotifications() {
  try {
    await enablePushNotifications();
    toast('Notifiche push attivate'); render();
  } catch (error) { toast(error.message); }
}

function actionableIds() {
  return new Set(state.loans.filter(l =>
    (l.borrower === state.currentUser && ['pending','reserved'].includes(l.status)) ||
    (l.owner === state.currentUser && ['requested','return_pending'].includes(l.status))
  ).map(l => l.id));
}

function startRealtime() {
  api.subscribe(() => scheduleRealtimeSync('loans'), () => scheduleRealtimeSync('collection'));
}

function scheduleRealtimeSync(source) {
  clearTimeout(realtimeSyncTimer);
  realtimeSyncTimer = setTimeout(() => runRealtimeSync(source), 140);
}

async function runRealtimeSync(source) {
  if (realtimeSyncRunning) { realtimeSyncQueued = true; return; }
  realtimeSyncRunning = true;
  const before = actionableIds();
  try {
    if (source === 'collection') await loadCollection();
    else await Promise.allSettled([loadCloudLoans(),loadCollection()]);
    saveState();
    const added = [...actionableIds()].filter(id => !before.has(id));
    if (added.length) await showLoanNotification(added.length);
    const editing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
    if (!editing) renderRoute();
  } catch {} finally {
    realtimeSyncRunning = false;
    if (realtimeSyncQueued) { realtimeSyncQueued = false; scheduleRealtimeSync('loans'); }
  }
}

async function showLoanNotification(count) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const registration = await navigator.serviceWorker?.ready;
  if (registration) registration.showNotification('F.P.T Cards', {
    body: count === 1 ? 'Hai una nuova richiesta da gestire' : `Hai ${count} nuove richieste da gestire`,
    icon: 'icon-192.png', badge: 'icon-192.png', tag: 'fpt-loans', renotify: true
  });
}

async function loadCloudLoans() {
  const data = await api.loans();
  state.loans = data.map(l => {
    const game = l.game || 'yugioh';
    const externalId = l.card_external_id;
    const storedImage = normalizeCardImageUrl(l.card_image);
    const acceptedQuantity = l.accepted_quantity ?? (l.status === 'requested' ? 0 : l.quantity);
    return { id:l.id, cardName:l.card_name, quantity:l.quantity, requestedQuantity:l.requested_quantity || l.quantity, acceptedQuantity, remainingQuantity:Math.max(acceptedQuantity - (l.returned_quantity || 0), 0), owner:l.owner_slug, borrower:l.borrower_slug, notes:l.notes, status:l.status, createdAt:l.created_at, returnedAt:l.returned_at, image:game === 'yugioh' ? (storedImage || canonicalYgoCardImage(externalId)) : storedImage, externalId, collectionItemId:l.collection_item_id || '', game, returnedQuantity:l.returned_quantity || 0, pendingReturnQuantity:l.pending_return_quantity || 0, requestOrigin:l.request_origin || 'legacy', setCode:l.card_set_code || '', setName:l.card_set_name || '', rarity:l.card_rarity || '' };
  });
  cloudError = '';
  scheduleCatalogRepairs();
  void enrichMissingImages();
}

async function quarantineMismatchedLoanImages() {
  const candidates = state.loans.filter(loan => loan.game === 'yugioh' && loan.cardName);
  let changed = false;
  await runLimited(candidates, 4, async loan => {
    const card = await resolveStoredCard({ id:loan.externalId, name:loan.cardName }, loan.game);
    if (!card) return;
    const correctImage = card.fullImage || card.image || '';
    const idMismatch = String(card.id) !== String(loan.externalId || '');
    const imageMismatch = cardImageMatches(card, loan.image) === false || (!loan.image && correctImage);
    if (!idMismatch && !imageMismatch) return;
    loan.image = correctImage;
    loan.externalId = String(card.id);
    loan.imageMismatch = true;
    changed = true;
    void api.enrichLoan(loan.id, card).catch(() => {});
  });
  return changed;
}

async function createLoan(e) {
  e.preventDefault();
  if (loanSubmitPending) return;
  const borrower = loanBuilderDraft.borrower || document.querySelector('#borrower')?.value || '';
  const notes = loanBuilderDraft.notes.trim();
  const requesting = loanBuilderDraft.mode === 'request';
  if (!draftCards.length || !borrower || notes.length > 250) return toast('Completa destinatario e carte del prestito');
  if (borrower === state.currentUser) {
    triggerRickrollVideo();
    return toast('Non puoi prestare una carta a te stesso');
  }
  loanSubmitPending = true;
  render(true);
  try {
    if (requesting) {
      const results = await Promise.allSettled(draftCards.map(card => api.requestCollectionLoan(card.collectionItemId, card.quantity, notes)));
      const failed = results.map((result,index) => result.status === 'rejected' ? draftCards[index] : null).filter(Boolean);
      if (failed.length) {
        const sent = draftCards.length - failed.length;
        draftCards = failed;
        await Promise.allSettled([loadCloudLoans(),loadCollection()]);
        saveState();render(true);
        return toast(sent ? `${sent} richieste inviate · ${failed.length} da riprovare` : (results.find(result => result.status === 'rejected')?.reason?.message || 'Richiesta non riuscita'));
      }
    } else await api.createMany(draftCards, borrower, notes, state.game);
    draftCards = [];
    loanBuilderDraft = { borrower:'', notes:'', query:'', mode:'lend' };
    loanSearchResults = []; loanSearchStatus = 'idle';
    try { await loadCloudLoans(); } catch {}
    saveState(); page = 'loans'; render(true); toast(requesting ? 'Richiesta inviata al proprietario' : 'Proposta di prestito inviata');
  } catch (error) {
    loanSubmitPending = false; render(true); toast(error.message || 'Invio non riuscito');
  } finally { loanSubmitPending = false; }
}

function addCatalogCard(button) {
  const card = loanSearchResults[Number(button.dataset.cardResult)];
  if (!card) return;
  const source = button.closest('.loan-search-result')?.querySelector('img, .loan-result-placeholder');
  const flight = captureLoanCardFlight(source);
  const printing = card.printings?.[0] || {};
  const requesting = loanBuilderDraft.mode === 'request';
  const inventory = requesting
    ? state.collection.team.find(item => item.id === button.dataset.inventoryId && item.ownerSlug === loanBuilderDraft.borrower)
    : matchingCollectionItem(card, printing);
  if (requesting && (!inventory || inventory.quantityAvailable < 1 || inventory.legacyAmbiguous)) return toast('Questa printing non è richiedibile');
  const candidate = {
    id:String(card.id), name:inventory?.cardName || card.name, image:inventory?.imageUrl || card.fullImage || card.image || '', thumbnail:inventory?.imageUrl || card.image || card.fullImage || '', quantity:1,
    setCode:inventory?.setCode || printing.setCode || '', setName:inventory?.setName || printing.setName || '', rarity:inventory?.rarity || printing.rarity || '',
    collectionItemId:inventory?.id || '', maxQuantity:inventory ? inventory.quantityAvailable : undefined
  };
  const existing = draftCards.find(item => draftCardKey(item) === draftCardKey(candidate));
  if (existing) {
    if (Number.isFinite(existing.maxQuantity) && existing.quantity >= existing.maxQuantity) return toast('Hai raggiunto la disponibilità fisica registrata');
    existing.quantity += 1;
  } else {
    if (candidate.maxQuantity === 0) return toast('Questa printing non ha copie fisicamente disponibili');
    draftCards.push(candidate);
  }
  clearTimeout(cardSearchTimer);
  cardSearchSequence += 1;
  loanBuilderDraft.query = '';
  loanSearchResults = [];
  loanSearchStatus = 'closed';
  render(true);
  animateLoanCardTransfer(flight, draftCardKey(candidate));
  document.querySelector('#card-name')?.focus();
}

function captureLoanCardFlight(source) {
  if (!source || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null;
  const rect = source.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    rect:{ left:rect.left, top:rect.top, width:rect.width, height:rect.height },
    image:source.tagName === 'IMG' ? (source.currentSrc || source.src) : ''
  };
}

function animateLoanCardTransfer(flight, key) {
  if (!flight) return;
  const target = [...document.querySelectorAll('[data-draft-key]')].find(item => item.dataset.draftKey === key);
  const targetVisual = target?.querySelector('img, .draft-placeholder');
  if (!targetVisual) return;
  const destination = targetVisual.getBoundingClientRect();
  const ghost = flight.image ? document.createElement('img') : document.createElement('span');
  ghost.className = 'loan-card-flight';
  if (flight.image) { ghost.src = flight.image; ghost.alt = ''; }
  Object.assign(ghost.style, {
    left:`${flight.rect.left}px`, top:`${flight.rect.top}px`,
    width:`${flight.rect.width}px`, height:`${flight.rect.height}px`
  });
  document.body.append(ghost);
  const translateX = destination.left - flight.rect.left;
  const translateY = destination.top - flight.rect.top;
  const scaleX = destination.width / flight.rect.width;
  const scaleY = destination.height / flight.rect.height;
  const animation = ghost.animate([
    { transform:'translate3d(0,0,0) scale(1)', opacity:.96 },
    { transform:`translate3d(${translateX}px,${translateY}px,0) scale(${scaleX},${scaleY})`, opacity:.72 }
  ], { duration:560, easing:'cubic-bezier(.22,.75,.22,1)', fill:'forwards' });
  target.classList.add('loan-card-arrived');
  setTimeout(() => target.classList.remove('loan-card-arrived'), 720);
  animation.finished.catch(() => {}).finally(() => ghost.remove());
}

function matchingCollectionItem(card, printing) {
  return state.collection.mine.find(item => item.game === state.game
    && String(item.catalogCardId) === String(card.id)
    && item.setCode.toUpperCase() === String(printing.setCode || '').toUpperCase()
    && item.rarity === String(printing.rarity || ''));
}

function draftCardKey(card) {
  if (card.collectionItemId) return `collection:${card.collectionItemId}`;
  return `${card.id || card.name}:${card.setCode || ''}:${card.rarity || ''}`.toLowerCase();
}

function updateDraftQuantity(index, delta) {
  const card = draftCards[index];
  if (!card) return;
  const next = card.quantity + delta;
  if (next < 1) return;
  if (Number.isFinite(card.maxQuantity) && next > card.maxQuantity) return toast('Hai raggiunto la disponibilità fisica registrata');
  card.quantity = next; render(true);
}

function setLoanBuilderMode(mode) {
  if (!['lend','request'].includes(mode) || loanBuilderDraft.mode === mode) return;
  loanBuilderDraft = { borrower:'', notes:loanBuilderDraft.notes, query:'', mode };
  draftCards = [];
  loanSearchResults = [];
  loanSearchStatus = mode === 'request' ? 'owner-required' : 'idle';
  clearTimeout(cardSearchTimer);
  cardSearchSequence += 1;
  render(true);
  document.querySelector('#borrower')?.focus();
}

function changeLoanCounterpart(value) {
  const changed = loanBuilderDraft.borrower !== value;
  loanBuilderDraft.borrower = value;
  if (changed && loanBuilderDraft.mode === 'request') {
    draftCards = [];
    loanBuilderDraft.query = '';
    loanSearchResults = [];
    loanSearchStatus = value ? 'idle' : 'owner-required';
    clearTimeout(cardSearchTimer);
    cardSearchSequence += 1;
    render(true);
    document.querySelector('#card-name')?.focus();
    return;
  }
  updateLoanRecipientUi();
}

function updateLoanRecipientUi() {
  const recipient = member(loanBuilderDraft.borrower);
  const requesting = loanBuilderDraft.mode === 'request';
  const avatar = document.querySelector('.loan-recipient-avatar');
  const title = document.querySelector('.recipient-picker strong');
  const detail = document.querySelector('.recipient-picker small');
  const submit = document.querySelector('.loan-submit');
  const direction = document.querySelector('.loan-direction-flag small');
  if (avatar) { avatar.className = `loan-recipient-avatar member-${recipient?.id || 'empty'}`; avatar.textContent = recipient ? initials(recipient.name) : '?'; }
  if (title) title.textContent = recipient?.name || 'Seleziona un membro del team';
  if (detail) detail.textContent = recipient ? (recipient.role === 'admin' ? 'Amministratore' : 'Membro F.P.T') : (requesting ? 'Proprietario richiesto' : 'Destinatario richiesto');
  if (direction) direction.textContent = requesting
    ? `Le carte arriveranno a te${recipient ? ` da ${recipient.name}` : ' dal proprietario che selezionerai'}.`
    : `Le carte partiranno da te${recipient ? ` verso ${recipient.name}` : ' verso il membro che selezionerai'}.`;
  if (submit) submit.disabled = loanSubmitPending || !draftCards.length || !loanBuilderDraft.borrower;
}

function onCardSearch(e) {
  clearTimeout(cardSearchTimer);
  const query = e.target.value;
  loanBuilderDraft.query = query;
  const sequence = ++cardSearchSequence;
  document.querySelector('#card-suggestions')?.classList.remove('is-collapsed');
  if (loanBuilderDraft.mode === 'request' && !loanBuilderDraft.borrower) {
    loanSearchResults = []; loanSearchStatus = 'owner-required';
    const box = document.querySelector('#card-suggestions');
    if (box) { box.classList.remove('is-collapsed'); box.innerHTML = loanSearchResultsHtml(); }
    return;
  }
  if (query.trim().length < 3) {
    loanSearchResults = []; loanSearchStatus = 'idle';
    const box = document.querySelector('#card-suggestions');
    if (box) box.innerHTML = loanSearchResultsHtml();
    return;
  }
  loanSearchStatus = 'loading';
  const initialBox = document.querySelector('#card-suggestions');
  if (initialBox) initialBox.innerHTML = loanSearchResultsHtml();
  cardSearchTimer = setTimeout(async () => {
    try {
      const results = await searchCards(query, state.game);
      const box = document.querySelector('#card-suggestions');
      if (sequence !== cardSearchSequence || query !== loanBuilderDraft.query || !box) return;
      loanSearchResults = results;
      loanSearchStatus = results.length ? 'results' : 'empty';
      box.innerHTML = loanSearchResultsHtml();
      box.querySelectorAll('[data-card-result]').forEach(button => button.addEventListener('click', () => addCatalogCard(button)));
    } catch {
      const box = document.querySelector('#card-suggestions');
      if (sequence !== cardSearchSequence || !box) return;
      loanSearchResults = []; loanSearchStatus = 'error'; box.innerHTML = loanSearchResultsHtml();
    }
  }, 350);
}

async function enrichMissingImages() {
  if (enrichingImages) return;
  const missing = state.loans.filter(l => l.game === state.game && !l.image && !unresolvedCards.has(`${l.game}:${l.cardName.toLowerCase()}`)).slice(0, 8);
  if (!missing.length) return;
  enrichingImages = true;
  let changed = false;
  try {
    for (const loan of missing) {
      const card = loan.externalId
        ? await resolveStoredCard({ id:loan.externalId, name:loan.cardName }, loan.game)
        : await findCard(loan.cardName, loan.game);
      if (!card?.image) { unresolvedCards.add(`${loan.game}:${loan.cardName.toLowerCase()}`); continue; }
      await api.enrichLoan(loan.id, card);
      loan.image = card.fullImage || card.image;
      loan.externalId = card.id;
      changed = true;
    }
    if (changed) {
      saveState();
      const editing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
      if (!editing) render();
    }
  } catch {} finally { enrichingImages = false; }
}

async function updateLoan(id, action) {
  const l = state.loans.find(x => x.id === id);
  if (!l) return;
  try {
    if (action === 'accept-request') {
      const quantity = Number(document.querySelector(`[data-accept-qty="${id}"]`)?.value);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > l.requestedQuantity) throw new Error('Quantità accettata non valida');
      await api.respondCollectionLoan(id, 'accept', quantity);
    } else if (action === 'reject-request') await api.respondCollectionLoan(id, 'reject');
    else if (action === 'return') {
      const quantity = Number(document.querySelector(`[data-return-qty="${id}"]`)?.value);
      await api.returnQuantity(id, quantity);
    } else await api.transition(id, action);
    await loadCloudLoans(); try { await loadCollection(); } catch {} saveState(); render(); toast('Prestito aggiornato');
  } catch (error) { toast(error.message); }
}

async function start() {
  installCardImageRecovery();
  installCollectionControls();
  await fastScan.restore();
  watchConnectivity(async connected => {
    if (!state.currentUser) return;
    if (!connected) { render(); return; }
    try { await Promise.all([loadMembers(),loadPrimaryData()]); saveState(); }
    catch (error) { cloudError = error.message || 'Sincronizzazione non riuscita'; }
    render();
  });
  if (!state.currentUser) {
    document.body.dataset.game = state.game || 'yugioh';
    document.body.dataset.page = 'login';
    document.querySelector('#app').innerHTML = loginLoadingView();
    const memberRequest = loadMembers();
    const initialLoad = await Promise.race([
      memberRequest.then(() => ({ ok:true })).catch(error => ({ error })),
      new Promise(resolve => window.setTimeout(() => resolve({ timeout:true }), 4000))
    ]);
    if (initialLoad.error) memberLoadError = initialLoad.error.message || 'Caricamento membri non riuscito';
    if (initialLoad.timeout) {
      memberLoadError = 'Il caricamento dei membri sta impiegando più del previsto';
      memberRequest.then(() => {
        memberLoadError = '';
        if (!state.currentUser) render(true);
      }).catch(error => {
        memberLoadError = error.message || 'Caricamento membri non riuscito';
        if (!state.currentUser) render(true);
      });
    }
    render(true);
    void registerAutoUpdates();
    return;
  }
  initEasterEgg();
  render();
  try { await loadMembers(); } catch {}
  if (state.currentUser) {
    try {
      const syncError = await loadPrimaryData();
      if (syncError && /Sessione scaduta/i.test(syncError.message || '')) throw syncError;
      startRealtime(); saveState();
    }
    catch (error) {
      if (/Sessione scaduta/i.test(error.message || '')) { state.currentUser = null; state.role = null; state.loans = []; saveState(); }
      else cloudError = online() ? (error.message || 'Sincronizzazione non riuscita') : '';
    } finally { appLoading = false; }
  }
  void registerAutoUpdates();
  render();
}
start();
window.addEventListener('hashchange', () => {
  const next = routeFromHash();
  if(page==='fastscan'&&next==='fastscan'){
    const mode=fastScanModeFromHash();
    if(mode==='review'&&fastScan.phase!=='review')void fastScan.openReview();
    else if(mode==='scan'&&fastScan.phase==='review')void fastScan.start();
    return;
  }
  if (next === page) return;
  if (page === 'fastscan' && next !== 'fastscan') {
    if(['scanning','paused'].includes(fastScan.phase)&&fastScan.hasScans){history.pushState({fastScan:'scan'},'','#/fastscan');void fastScan.requestExit();return;}
    void fastScan.leave();
  }
  const previous = page;
  page = next; selectedCardKey = ''; selectedCollectionItem = ''; collectionEditor = null;
  if(previous==='fastscan'||page==='fastscan')render();else renderRoute();
});
setInterval(async () => {
  if (!state.currentUser) return;
  try {
    await loadPrimaryData();
    saveState();
    const editing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
    if (!editing) renderRoute();
  } catch {}
}, 120000);
