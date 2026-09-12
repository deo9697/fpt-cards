import {renderTeamPage, bindTeamPage} from './js/team.js';
import {renderAdminPage, bindAdminPage} from './js/admin.js';
import {renderMarketVariantPage, bindMarketVariantPage} from './js/market-variant-admin.js';
import { MEMBERS, GAMES, FUTURE_GAMES, state, saveState, setMembers, member, initials, esc, formatDate } from './js/core.js';
import { api } from './js/api.js';
import { findCardById, cardTypesByIds, resolveStoredCard, reconcileCatalogCard, cardImageMatches, normalizeCardImageUrl, canonicalYgoCardImage, tcgBanlistStatuses, catalogImageNeedsRepair, collectionCardWithLocalizedPrintings, normalizeCatalogRarity, setCodeMatchesLanguage, canonicalCatalogCardId, mergeAuthoritativePrintings } from './js/cards.js';
import { externalLookupViaRegistry } from './js/ygo-printing-registry.js';
import { getGameAdapter } from './js/games/index.js';
import { verifyPendingCollectionCatalog } from './js/catalog-verification.js';
import { icon } from './js/icons.js';
import { dashboardView } from './js/dashboard.js';
import { collectionView as inventoryCollectionView, collectionResultsView, collectionDetailView, collectionEditorView, collectionLoanRequestView, collectionPrintingOptions, editionFromFirstEditionFlag, persistedCollectionItemMatches, selectCollectionEditorPrinting, COLLECTION_PAGE_SIZE, collectionJumpTarget } from './js/collection.js';
import { enablePushNotifications, pushSupported, pushConfigured } from './js/push.js';
import { triggerRickrollVideo, isLossStreakZoomActive, onLossStreakZoomEnd } from './js/easter-egg.js';
import { registerAutoUpdates } from './js/pwa-update.js';
import { watchConnectivity, online } from './js/connectivity.js';
import { FastScanController } from './js/fast-scan.js';
import { DeckController, deckUsageIndex } from './js/decks.js';
import { MarketWatchController } from './js/market-watch.js';
import { CollectionShareController } from './js/collection-share.js';
import { StatsController } from './js/stats.js';
import { progressForXp, titleForLevel } from './js/progression.js';
import { cosmeticsByType, cosmeticPacks, findCosmetic, isCosmeticUnlocked } from './js/cosmetics.js';
import { DAILY_MISSIONS_META } from './js/missions.js';

// Routing catalogo per gioco: da qui in poi lo YGO ygoprodeck e l'OPTCG
// One Piece sono due adapter separati (js/games/), niente più `if (game ===
// 'onepiece')` sparsi nel motore cards.js.
function searchCards(query, game = 'yugioh') { return getGameAdapter(game).searchCards(query); }
function findCard(name, game = 'yugioh') { return getGameAdapter(game).findCard(name); }

const ROUTES = new Set(['home','cards','collection','fastscan','decks','new','loans','market','team','settings','more','requests','stats','admin','market-variants']);
const SHARE_HASH = /^#\/share\/([0-9a-f-]{36})$/i;
let guestShare;
const displayedXpProgress = new Map();
let page = routeFromHash();
let loanFilters = { direction: 'all', member: 'all', query: '', status: 'all' };
let selectedLoanId = '';
let loanFiltersExpanded = false;
let collectionFilters = { scope:'mine', query:'', owner:'all', status:'all', layout:'grid', sort:'name-asc', facets:{} };
let collectionVisibleCount = COLLECTION_PAGE_SIZE;
let collectionSentinelObserver;
let collectionShareModal = false;
let collectionShareLink = null;
let collectionSharePending = false;
let collectionShareRequests = [];
let requestsTab = 'pending';
let selectedCardKey = '';
let selectedCollectionItem = '';
// tipo YGOPRODeck (Spell/Trap/Fusion/...) per catalogCardId, solo per lo
// sfondo del dettaglio carta — nessun dato di raccolta lo porta già con sé.
const cardTypeCache = new Map();
const cardTypeInFlight = new Set();
let collectionEditor = null;
let collectionLoanRequest = null;
let collectionSearchResults = [];
let collectionSearchSequence = 0;
let collectionError = '';
let collectionPending = false;
let draftCards = [];
let loanBuilderDraft = { borrower:'', notes:'', query:'', mode:'lend' };
let loanBuilderStep = 1;
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
const realtimeSyncSources = new Set();
let collectionLoadInFlight = null;
let collectionLoadGeneration = 0;
let collectionLoadAbortController = null;
let loansLoadInFlight = null;
let catalogRepairRunning = false;
let catalogRepairQueued = false;
// loadPrimaryData() non e' "solo bootstrap": login(), start() (sessione
// ripristinata), watchConnectivity() (ogni evento online/offline reale del
// browser) e retryCloud() la richiamano tutte nella stessa sessione. Senza
// questa guardia, ognuna di quelle richieste rifà scheduleCatalogRepairs()
// da capo: osservato in produzione (2026-09-12) 4 chiamate reali a
// list_collection_catalog_verification_queue in una singola apertura
// dell'app, invece di 1 — il browser aveva emesso più eventi 'online' oltre
// al login stesso. Una sola pianificazione per sessione (resettata al
// logout), non una per ogni refresh legittimo dei dati.
let catalogRepairBootstrapped = false;
// Diagnostica solo in sviluppo (mai in produzione, mai token/segreti): quale
// riga/RPC/provider ha fallito e con quale errore, per il repair automatico
// del catalogo (vedi quarantineMismatchedCollectionImages).
const DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
function logCatalogRepairIssue(event) {
  if (!DEV) return;
  console.warn('[catalog-repair]', event.stage, { collectionItemId:event.collectionItemId, game:event.game, error:event.error?.message || event.error?.code || String(event.error || '') });
}
const unresolvedCards = new Set();
const fastScan = new FastScanController({
  api, externalLookup:externalLookupViaRegistry, getCollection:()=>state.collection,
  isOnline:online, onRender:()=>render(true), onSaved:async()=>{await loadCollection();saveState();}, onToast:message=>toast(message),
  onRoute:mode=>setFastScanRoute(mode)
});
const decks = new DeckController({api,getState:()=>state,searchCards,findCard,findCardById,cardTypesByIds,tcgBanlistStatuses,isOnline:online,onRender:()=>renderRoute(),onToast:message=>toast(message),onLoansChanged:async()=>{await Promise.all([loadCloudLoans(),loadCollection()]);saveState();},getCosmetics:()=>stats.cosmetics});
const marketWatch = new MarketWatchController({api,getGame:()=>state.game,getDecks:()=>state.decks.filter(deck=>deck.game===state.game),onRender:()=>renderRoute(),onToast:message=>toast(message),onNavigate:target=>navigate(target)});
const stats = new StatsController({api,getState:()=>state,onRender:()=>renderRoute(),onModalRender:()=>render(true),onToast:message=>toast(message)});
let progressionDrawerOpen = false;
let avatarPanelOpen = false;
let profileCustomizeOpen = false;
let profileCustomizeTab = 'avatar';
let cosmeticActionPending = '';
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
function navigate(next) { const previous=page; page = ROUTES.has(next) ? next : 'home'; if(page==='decks')decks.showGallery(false); if(previous==='fastscan'&&page!=='fastscan')void fastScan.leave(); selectedCollectionItem = ''; collectionEditor = null; selectedLoanId = ''; const hash = `#/${page}`; if (location.hash !== hash) history.pushState(null, '', hash); if(previous==='fastscan'||page==='fastscan')render();else renderRoute(); dispatchPageEnterRefresh(previous, page); }

// Niente più poll globale ogni 2 minuti: ogni pagina che non ha copertura
// Realtime si aggiorna da sola quando l'utente la apre, invece di dipendere
// da un timer cieco che ricaricava tutto indipendentemente da cosa serviva
// davvero. Collection/loans restano coperti da Realtime (vedi startRealtime
// più sotto); requests/market/decks/stats non hanno un canale dedicato e si
// aggiornano quindi qui, all'ingresso nella rispettiva pagina.
function dispatchPageEnterRefresh(previous, next) {
  if (next === 'requests') void refreshCollectionShareRequests();
  if (next === 'market') void marketWatch.load();
  if (next === 'decks') void loadDecks().then(() => renderRoute());
  if (previous !== 'stats' && next === 'stats') void stats.load().then(() => { stats.refreshBody(); stats.checkLossStreakEasterEgg(); });
  if (next === 'admin' && canManageArtwork()) void loadAdminArtworkQueue(true);
  if (next === 'market-variants' && state.role === 'admin') void loadMarketVariantQueue(true);
}

function animateXpFill() {
  const key = state.currentUser;
  if (!key) return;
  const fills = [...document.querySelectorAll('.xp-strip .xp-bar > i')];
  if (!fills.length) return;
  const target = Math.max(0, Math.min(100, Number(fills[0].style.getPropertyValue('--progress')) || 0));
  const previous = displayedXpProgress.get(key);
  displayedXpProgress.set(key, target);
  if (previous == null || previous === target || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const fill of fills) {
    if (!fill.animate) continue;
    const next = Math.max(0, Math.min(100, Number(fill.style.getPropertyValue('--progress')) || 0));
    fill.animate([{width:previous+'%'},{width:next+'%'}], {duration:1100,easing:'cubic-bezier(.22,.68,.16,1)'});
  }
}
function render(force = false) {
  if (SHARE_HASH.test(location.hash)) { if (guestShare && !document.querySelector('.share-guest-shell')) renderGuestShare(); return; }
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
  animateXpFill();
  if (!state.currentUser) void loadLoginFeaturedCards();
}

function renderRoute() {
  if (isLossStreakZoomActive()) { onLossStreakZoomEnd(renderRoute); return; }
  if (SHARE_HASH.test(location.hash)) { if (guestShare && !document.querySelector('.share-guest-shell')) renderGuestShare(); return; }
  const shell = document.querySelector('.app-shell');
  const stage = shell?.querySelector('.page-stage');
  if (!state.currentUser || !shell || !stage) { render(); return; }
  document.body.dataset.page = page;
  stage.innerHTML = pageContent();
  shell.querySelectorAll(':scope > .detail-backdrop').forEach(element => element.remove());
  shell.querySelectorAll('.sidebar nav button[data-page],.mobile-nav button[data-page]').forEach(button => {
    const target = button.dataset.page;
    button.classList.toggle('active', target === page || (target === 'more' && ['team','settings','requests','stats'].includes(page)));
  });
  // Questi nodi sono piccoli: clonarli elimina i vecchi listener senza
  // ricostruire la pagina e le sue immagini.
  for (const selector of ['.sidebar','.topbar','.mobile-nav']) {
    const node = shell.querySelector(selector);
    if (node) node.replaceWith(node.cloneNode(true));
  }
  bind();
  animateXpFill();
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
  const desktopNav = [['home','home','Home'],['cards','card','Carte'],['collection','collection','Raccolta'],['decks','deck','Mazzi'],['stats','trophy','Statistiche'],['loans','swap','Prestiti'],['market','chart','Market Watch'],['team','team','Team'],['settings','settings','Impostazioni']];
  const mobileNav = [['home','home','Home'],['market','chart','Market Watch'],['collection','collection','Raccolta'],['decks','deck','Mazzi'],['loans','swap','Prestiti'],['more','more','Altro']];
  // Va renderizzato qui (fuori da .page-stage), non dentro loansView(): .page-stage
  // ha view-transition-name, che in Chrome le dà una propria stacking context.
  // Un .detail-backdrop con z-index:50 annidato lì dentro resta comunque
  // intrappolato sotto quella stacking context, e la bottom nav (z-index:30,
  // fuori da .page-stage) ci finiva visivamente sopra tagliando la scheda.
  const selectedLoan = selectedLoanId ? loanBase().find(loan => loan.id === selectedLoanId) : null;
  return `<main class="app-shell"><aside class="sidebar"><div class="brand sidebar-brand"><img src="icon-512.png" alt=""><div><h1>F.P.T Cards</h1><p>${game.short}</p></div></div><nav>${desktopNav.map(([id,iconName,label]) => navButton(id, iconName, label, notifications)).join('')}</nav><div class="sidebar-profile"><button type="button" class="sidebar-profile-trigger" data-open-avatar>${profileAvatarMarkup(u, activeCosmetics())}<div><strong>${esc(u.name)}</strong><small>${state.role === 'admin' ? 'Amministratore' : 'Membro del team'}</small></div></button><button data-logout aria-label="Esci">${icon('logout')}</button></div></aside>
    <section class="app-main"><header class="topbar"><div class="game-switcher ${gameMenuOpen ? 'open' : ''}"><button type="button" class="menu-trigger" aria-label="Scegli gioco" aria-expanded="${gameMenuOpen}">${icon('menu')}<span class="game-trigger-chip"><img src="${game.logo}" alt=""></span></button><aside class="game-menu" aria-label="Seleziona gioco"><div class="game-menu-head"><div><small>F.P.T Cards</small><h2>Cambia gioco</h2></div></div><div class="game-options">${Object.values(GAMES).map(g => `<button data-game="${g.id}" class="${state.game === g.id ? 'active' : ''}"><span class="game-logo"><img src="${g.logo}" alt="${esc(g.name)}"></span><span><strong>${g.name}</strong><small>${state.game === g.id ? 'Sezione attiva' : 'Passa a questa sezione'}</small></span><b>${state.game === g.id ? '✓' : '›'}</b></button>`).join('')}${FUTURE_GAMES.map(g => `<div class="game-option-locked" aria-disabled="true"><span class="game-logo"><img src="${g.logo}" alt="${esc(g.name)}"></span><span><strong>${g.name}</strong><small>In arrivo</small></span><b>${icon('lock')}</b></div>`).join('')}</div></aside></div>${xpStripView(u)}<button class="top-icon" data-quick="attention" aria-label="Notifiche">${icon('bell')}${notifications ? `<i>${notifications}</i>` : ''}</button><button class="mobile-profile" data-open-avatar aria-label="Profilo">${profileAvatarMarkup(u, activeCosmetics())}</button></header>
      ${!online() ? '<div class="connection-banner offline">Sei offline · mostro gli ultimi dati salvati</div>' : cloudError ? `<div class="connection-banner error">${esc(cloudError)} <button id="retry-cloud">Riprova</button></div>` : ''}
      <section class="page-stage" aria-live="polite">${pageContent()}</section>
    </section>
    <nav class="nav mobile-nav">${mobileNav.map(([id,iconName,label]) => navButton(id, iconName, label, notifications)).join('')}</nav>
    ${selectedCardKey ? cardDetailView(selectedCardKey) : ''}
    ${selectedLoan ? loanDetailSheetView(selectedLoan) : ''}
    ${selectedCollectionItem ? collectionDetailView(selectedCollectionItem, collectionFilters.scope, state.collection, online(), state.currentUser, marketWatch.allLoadedItems?.() || [], cardTypeForDetail(selectedCollectionItem), cardTypeReadyForDetail(selectedCollectionItem)) : ''}
    ${collectionEditor ? collectionEditorView(collectionEditor, state.game, online()) : ''}
    ${collectionLoanRequest ? collectionLoanRequestView(collectionLoanRequest, online()) : ''}
    ${collectionShareModal ? collectionShareModalView() : ''}
    ${progressionDrawerOpen ? progressionDrawerView() : ''}
    ${avatarPanelOpen ? avatarPanelView(u) : ''}
    <div data-stats-modal-root>${page === 'stats' ? `${stats.matchModalOpen ? stats.matchModalView() : ''}${stats.matchDetailOpen ? stats.matchDetailView() : ''}` : ''}</div>
  </main>`;
}

function xpStripView(u) {
  const progress = progressForXp(stats.progression?.totalXp || 0);
  const titleLabel = findCosmetic(activeCosmetics().activeTitle)?.label || titleForLevel(progress.level);
  return `<button type="button" class="xp-strip" data-open-progression aria-label="Progressione"><span class="xp-strip-row"><span class="xp-strip-level">LV ${progress.level}</span><span class="xp-bar"><i style="--progress:${progress.progress}"></i></span><span class="xp-strip-detail">${progress.currentLevelXp} / ${progress.nextLevelXp || progress.currentLevelXp} XP</span></span><span class="xp-strip-identity">${esc(u.name)} · ${esc(titleLabel)}</span></button>`;
}

function progressionDrawerView() {
  const progression = stats.progression || { totalXp:0, level:1, xpToday:0, dailyCap:100 };
  const progress = progressForXp(progression.totalXp), title = titleForLevel(progress.level);
  return `<div class="detail-backdrop" data-close-progression><aside class="card-detail progression-drawer" role="dialog" aria-modal="true" aria-label="Progressione">
    <button class="detail-close" data-close-progression aria-label="Chiudi">×</button>
    <span class="eyebrow">Progression</span><h2>LV ${progress.level}</h2>
    <div class="xp-bar-block"><div class="xp-bar large"><i style="--progress:${progress.progress}"></i></div><small>${progress.currentLevelXp} / ${progress.nextLevelXp || progress.currentLevelXp} XP · ${Math.max(0, (progress.nextLevelXp || 0) - progress.currentLevelXp)} XP al prossimo livello</small></div>
    ${dailyMissionsView(stats.missions || [])}
    <p class="progression-title">Titolo attuale: <b>${esc(title)}</b></p>
  </aside></div>`;
}
function dailyMissionsView(missions) {
  if (!missions.length) return '';
  return `<section class="progression-section daily-missions"><span class="eyebrow">Missioni di oggi</span>
    <div class="mission-list">${missions.map(missionRowView).join('')}</div>
  </section>`;
}
function missionRowView(mission) {
  const meta = DAILY_MISSIONS_META[mission.id] || { icon:'star', label:mission.id, description:'' };
  const pct = Math.round(Math.min(100, (mission.progress / mission.target) * 100));
  return `<div class="mission-row ${mission.completed ? 'completed' : ''}">
    <span class="mission-icon">${mission.completed ? '✓' : icon(meta.icon)}</span>
    <div class="mission-copy"><strong>${esc(meta.label)}</strong><small>${esc(meta.description)}</small>
      <div class="mission-bar"><i style="--progress:${pct}"></i></div>
    </div>
    <span class="mission-count">${mission.progress}/${mission.target}</span>
  </div>`;
}

function activeCosmetics() { return stats.cosmetics || { activeTitle:'', activeAvatar:'', unlocked:[] }; }
// L'avatar equipaggiato sostituisce il cerchio con le iniziali solo dove
// mostriamo l'identità del membro CORRENTE (pannello profilo, header) — le
// liste che mostrano altri membri del team restano con le iniziali, non è
// necessario propagare i cosmetici ovunque per questa prima versione.
function profileAvatarMarkup(u, cosmetics, size = '') {
  const equipped = findCosmetic(cosmetics.activeAvatar);
  const cls = `avatar member-${u.id} ${size}`.trim();
  if (equipped?.image) return `<span class="${cls} has-image"><img src="${esc(equipped.image)}" alt="${esc(equipped.label)}"></span>`;
  return `<div class="${cls}">${initials(u.name)}</div>`;
}
function avatarPanelView(u) {
  const cosmetics = activeCosmetics();
  const progression = stats.progression || { totalXp:0, level:1 };
  const progress = progressForXp(progression.totalXp || 0);
  const unlockedTitles = cosmeticsByType('title').filter(item => cosmetics.unlocked.includes(item.id) || isCosmeticUnlocked(item, progress));
  const equippedTitle = findCosmetic(cosmetics.activeTitle);
  const titleLabel = equippedTitle?.label || titleForLevel(progress.level);
  return `<div class="detail-backdrop" data-close-avatar><aside class="card-detail avatar-panel profile-panel" role="dialog" aria-modal="true" aria-label="Profilo">
    <button class="detail-close" data-close-avatar aria-label="Chiudi">×</button>
    <span class="eyebrow">Profilo</span>
    <button type="button" class="profile-header" data-open-customize>${profileAvatarMarkup(u, cosmetics, 'large')}<div class="profile-header-copy"><h2>${esc(u.name)}</h2><small>LV ${progress.level} · ${esc(titleLabel)}</small></div><b class="profile-header-chevron">›</b></button>
    <div class="xp-bar-block"><div class="xp-bar large"><i style="--progress:${progress.progress}"></i></div><small>${progress.currentLevelXp} / ${progress.nextLevelXp || progress.currentLevelXp} XP</small></div>
    <div class="profile-selects">
      <label>Titolo equipaggiato<select data-equip-title ${cosmeticActionPending ? 'disabled' : ''}>${unlockedTitles.map(item => `<option value="${esc(item.id)}" ${cosmetics.activeTitle === item.id ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>
      <label>Frame<select disabled title="Presto disponibile"><option>Default</option><option>Bronze</option><option>Silver</option><option>Gold</option></select></label>
    </div>
    <div class="avatar-panel-actions">
      <button type="button" class="btn secondary wide" data-avatar-goto="stats">${icon('chart')} Statistiche</button>
      <button type="button" class="btn secondary wide" data-avatar-goto="settings">${icon('settings')} Impostazioni</button>
      <button type="button" class="btn wide" data-open-customize>${icon('star')} Personalizza</button>
    </div>
  </aside></div>${profileCustomizeOpen ? customizePanelView(cosmetics, progress) : ''}`;
}
function customizePanelView(cosmetics, progress) {
  const tab = profileCustomizeTab;
  return `<div class="detail-backdrop" data-close-customize><aside class="card-detail customize-panel" role="dialog" aria-modal="true" aria-label="Personalizza profilo">
    <button class="detail-close" data-close-customize aria-label="Chiudi">×</button>
    <span class="eyebrow">Personalizza profilo</span><h2>Aspetto</h2>
    <nav class="tabs" role="tablist"><button type="button" data-customize-tab="avatar" class="${tab === 'avatar' ? 'active' : ''}" role="tab">Avatar</button><button type="button" data-customize-tab="title" class="${tab === 'title' ? 'active' : ''}" role="tab">Titolo</button></nav>
    ${tab === 'avatar' ? cosmeticPacks('avatar').map(pack => customizeAvatarPackView(pack, cosmetics, progress)).join('') : customizeTitleListView(cosmeticsByType('title'), cosmetics, progress)}
  </aside></div>`;
}
function customizeAvatarPackView(pack, cosmetics, progress) {
  // Come i titoli: niente anteprime bloccate, un pack sbloccato solo in
  // parte mostra soltanto le facce già ottenute (mistero sul resto).
  const unlockedItems = pack.items.filter(item => cosmetics.unlocked.includes(item.id) || isCosmeticUnlocked(item, progress));
  if (!unlockedItems.length) return '';
  return `<div class="cosmetic-pack"><h3>${esc(pack.label)}</h3><div class="cosmetic-avatar-grid">${unlockedItems.map(item => avatarTileView(item, cosmetics)).join('')}</div></div>`;
}
function avatarTileView(item, cosmetics) {
  const equipped = cosmetics.activeAvatar === item.id;
  return `<button type="button" class="cosmetic-avatar-tile ${equipped ? 'equipped' : ''}" data-equip-avatar="${esc(item.id)}" title="${esc(item.label)}">
    <span class="cosmetic-avatar-img"><img src="${esc(item.image)}" alt="${esc(item.label)}"></span>
    <small>${esc(item.label)}</small>${equipped ? '<i class="cosmetic-equipped-badge">✓</i>' : ''}
  </button>`;
}
function customizeTitleListView(titles, cosmetics, progress) {
  // A differenza degli avatar, i titoli non mostrano quelli ancora da
  // sbloccare: niente lucchetti/anteprime, restano un piccolo mistero
  // finché non si raggiunge il livello giusto.
  const unlockedTitles = titles.filter(item => cosmetics.unlocked.includes(item.id) || isCosmeticUnlocked(item, progress));
  return `<div class="cosmetic-title-list">${unlockedTitles.map(item => {
    const equipped = cosmetics.activeTitle === item.id;
    return `<button type="button" class="cosmetic-title-row ${equipped ? 'equipped' : ''}" data-equip-title-row="${esc(item.id)}">
      <span class="cosmetic-title-mark">${equipped ? '✓' : ''}</span>
      <span>${esc(item.label)}</span>
    </button>`;
  }).join('')}</div>`;
}
async function equipCosmeticAndRefresh(type, id) {
  if (cosmeticActionPending) return;
  cosmeticActionPending = type; render();
  try {
    await api.equipCosmetic(type, id);
    const field = type === 'avatar' ? 'activeAvatar' : 'activeTitle';
    stats.cosmetics = { ...activeCosmetics(), [field]: id };
    // La sezione Team legge memberProfiles (fetchata da loadMembers, non da
    // stats.cosmetics): senza questo la propria riga lì resterebbe con
    // l'avatar/titolo vecchio finché l'app non ricarica i membri da zero.
    if (memberProfiles.has(state.currentUser)) memberProfiles.set(state.currentUser, { ...memberProfiles.get(state.currentUser), [field]: id });
  } catch (error) { toast(error.message || 'Operazione non riuscita'); }
  finally { cosmeticActionPending = ''; render(); }
}

function bindProgressionHeader(root) {
  root.querySelector('[data-open-progression]')?.addEventListener('click', () => { progressionDrawerOpen = true; render(); });
  root.querySelectorAll('[data-close-progression]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; progressionDrawerOpen = false; render(); }));
  root.querySelectorAll('[data-open-avatar]').forEach(button => button.addEventListener('click', () => { avatarPanelOpen = true; render(); }));
  root.querySelectorAll('[data-close-avatar]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; avatarPanelOpen = false; render(); }));
  root.querySelectorAll('[data-avatar-goto]').forEach(button => button.addEventListener('click', () => { avatarPanelOpen = false; navigate(button.dataset.avatarGoto); }));
  root.querySelectorAll('[data-open-customize]').forEach(button => button.addEventListener('click', () => { profileCustomizeOpen = true; render(); }));
  root.querySelectorAll('[data-close-customize]').forEach(node => node.addEventListener('click', event => { if (event.target !== node && !event.target.closest('.detail-close')) return; profileCustomizeOpen = false; render(); }));
  root.querySelectorAll('[data-customize-tab]').forEach(button => button.addEventListener('click', () => { profileCustomizeTab = button.dataset.customizeTab; render(); }));
  root.querySelector('[data-equip-title]')?.addEventListener('change', event => void equipCosmeticAndRefresh('title', event.target.value));
  root.querySelectorAll('[data-equip-avatar]').forEach(button => button.addEventListener('click', () => void equipCosmeticAndRefresh('avatar', button.dataset.equipAvatar)));
  root.querySelectorAll('[data-equip-title-row]').forEach(button => button.addEventListener('click', () => void equipCosmeticAndRefresh('title', button.dataset.equipTitleRow)));
}

function navButton(id, iconName, label, notifications) {
  const active = page === id || (id === 'more' && ['team','settings','requests','stats'].includes(page));
  return `<button data-page="${id}" class="${active ? 'active' : ''}"><span>${icon(iconName)}${id === 'loans' && notifications ? `<i>${notifications}</i>` : ''}</span>${label}</button>`;
}

function pageContent() {
  if (appLoading) return loadingView();
  if (page === 'new') return newLoanView();
  if (page === 'loans') return loansView();
  if (page === 'team') return teamView();
  if (page === 'cards') return cardsView();
  if (page === 'fastscan') return fastScan.view();
  if (page === 'collection') return inventoryCollectionView(state.collection, collectionFilters, state.game, online(), collectionError, collectionVisibleCount, deckUsageIndex(state.decks, state.currentUser, state.game));
  if (page === 'market') return marketWatch.view();
  if (page === 'decks') return decks.view();
  if (page === 'stats') return stats.view();
  if (page === 'requests') return requestsView();
  if (page === 'settings') return settingsView();
  if (page === 'admin') return adminView();
  if (page === 'market-variants') return marketVariantView();
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
  const pendingRequests = collectionShareRequests.filter(request => request.status === 'pending').length;
  const links = [['requests','bell','Richieste',pendingRequests ? `${pendingRequests} in attesa` : 'Interesse dalla raccolta condivisa'],['stats','trophy','Statistiche','Match, mazzi e progressione'],['team','team','Team','Membri e amministrazione'],['settings','settings','Impostazioni','Notifiche e sessione']];
  if (canManageArtwork()) links.push(['admin','card','Artwork Resolver','Printing multi-artwork da revisionare']);
  if (state.role === 'admin') links.push(['market-variants','chart','Market Variant Resolver','Rarity Cardmarket ambigue da revisionare']);
  return `<section class="page-stack"><header class="page-header"><div><span class="eyebrow">Navigazione</span><h1>Altro</h1></div></header><section class="surface more-grid">${links.map(([id,iconName,label,detail]) => `<button data-page="${id}">${icon(iconName)}<span><strong>${label}</strong><small>${detail}</small></span>${id === 'requests' && pendingRequests ? `<i class="more-badge">${pendingRequests}</i>` : ''}${icon('arrow')}</button>`).join('')}</section></section>`;
}

function newLoanView() {
  const recipients = MEMBERS.filter(item => item.id !== state.currentUser);
  const requesting = loanBuilderDraft.mode === 'request';
  const recipient = member(loanBuilderDraft.borrower);
  const copies = draftCards.reduce((total, card) => total + card.quantity, 0);
  const submitDisabled = loanSubmitPending || !draftCards.length || !loanBuilderDraft.borrower;
  const step = Math.min(3, Math.max(1, loanBuilderStep));
  const stepMeta = [{ n:1, label:'Cerca' }, { n:2, label: requesting ? 'Proprietario' : 'Destinatario' }, { n:3, label:'Riepilogo' }];
  const stepper = `<div class="loan-wizard-stepper" aria-label="Passi prestito">${stepMeta.map((s, i) => `${i ? '<i class="loan-step-connector"></i>' : ''}<button type="button" class="loan-step-node ${s.n === step ? 'active' : s.n < step ? 'done' : ''}" data-loan-step="${s.n}" ${s.n === step ? 'aria-current="step"' : ''}><b>${s.n}</b><small>${esc(s.label)}</small></button>`).join('')}</div>`;
  const modeSwitch = `<div class="loan-mode-switch ${requesting ? 'request' : 'lend'}" role="group" aria-label="Direzione prestito"><button type="button" data-loan-mode="request" class="${requesting ? 'active' : ''}" aria-pressed="${requesting}">${icon('collection')} Ricevo in prestito</button><button type="button" data-loan-mode="lend" class="${requesting ? '' : 'active'}" aria-pressed="${!requesting}">${icon('swap')} Do in prestito</button></div>`;

  const searchPanel = `<section class="surface loan-builder-panel loan-step-panel loan-search-stage">
    <label class="sr-only" for="card-name">Cerca per nome carta, set o rarità</label><div class="loan-builder-search">${icon('search')}<input id="card-name" type="search" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" value="${esc(loanBuilderDraft.query)}" placeholder="Cerca per nome carta, set, rarità..." aria-controls="card-suggestions"></div>
    <div id="card-suggestions" class="loan-search-results ${loanSearchStatus === 'closed' ? 'is-collapsed' : ''}" aria-live="polite">${loanSearchResultsHtml()}</div>
  </section>`;
  const recipientPanel = `<section class="surface loan-builder-panel loan-step-panel loan-recipient">
    <label for="borrower">${requesting ? 'Proprietario' : 'Destinatario'}</label>
    <div class="recipient-picker"><i class="loan-recipient-avatar member-${esc(recipient?.id || 'empty')}">${recipient ? initials(recipient.name) : '?'}</i><div><strong>${recipient ? esc(recipient.name) : 'Seleziona un membro del team'}</strong><small>${recipient ? (recipient.role === 'admin' ? 'Amministratore' : 'Membro F.P.T') : (requesting ? 'Proprietario richiesto' : 'Destinatario richiesto')}</small></div><select id="borrower" required aria-label="${requesting ? 'Proprietario delle carte' : 'Destinatario del prestito'}"><option value="">Seleziona un membro</option>${recipients.map(m => `<option value="${esc(m.id)}" ${m.id === loanBuilderDraft.borrower ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
  </section>`;
  const summaryPanel = `<section class="surface loan-builder-panel loan-step-panel loan-summary-panel">
    <h3>${requesting ? 'Carte che vuoi richiedere' : 'Carte selezionate per il prestito'}</h3>
    <div class="draft-list">${draftCards.length ? draftCards.map(selectedLoanCardHtml).join('') : `<div class="loan-builder-empty">${icon('card')}<strong>Nessuna carta aggiunta</strong><span>Torna al passo 1 per cercarne una.</span></div>`}</div>
    <label for="notes" class="loan-notes-label">${icon('card')} <span>Note facoltative</span></label><textarea id="notes" rows="3" maxlength="250" placeholder="Aggiungi note su edizione, rarità, condizioni o altre informazioni utili...">${esc(loanBuilderDraft.notes)}</textarea><small id="notes-count">${loanBuilderDraft.notes.length} / 250</small>
    <div class="loan-totals">${icon('collection')} <strong>${draftCards.length}</strong> ${draftCards.length === 1 ? 'carta' : 'carte'} <i>·</i> <strong>${copies}</strong> ${copies === 1 ? 'copia totale' : 'copie totali'}</div>
    <div class="loan-direction-flag ${requesting ? 'request' : 'lend'}" role="status"><span>${icon('swap')}<b>${requesting ? 'Stai richiedendo' : 'Stai prestando'}</b></span><small>${requesting ? `Le carte arriveranno a te${recipient ? ` da ${esc(recipient.name)}` : ' dal proprietario che selezionerai'}.` : `Le carte partiranno da te${recipient ? ` verso ${esc(recipient.name)}` : ' verso il membro che selezionerai'}.`}</small></div>
    <p class="loan-confirm-hint">${icon('info')} ${requesting ? 'Il proprietario dovrà accettare la richiesta e confermare la quantità.' : 'Il destinatario dovrà accettare prima che il prestito risulti attivo.'}</p>
    <button class="btn wide loan-submit" type="submit" ${submitDisabled ? 'disabled' : ''}>${loanSubmitPending ? '<span class="button-spinner"></span> Invio in corso…' : `${icon('swap')} ${requesting ? 'Invia richiesta di prestito' : 'Invia proposta di prestito'}`}</button>
  </section>`;

  const collapsedRow = (n, label, detail) => `<button type="button" class="loan-step-collapsed" data-loan-step="${n}"><span><i>${n}</i>${esc(label)} — ${esc(detail)}</span>${icon('arrow')}</button>`;
  const step1 = step === 1 ? searchPanel : collapsedRow(1, 'Cerca carte', draftCards.length ? `${draftCards.length} ${draftCards.length === 1 ? 'carta aggiunta' : 'carte aggiunte'}` : 'nessuna carta ancora');
  const step2 = step === 2 ? recipientPanel : collapsedRow(2, requesting ? 'Proprietario' : 'Destinatario', recipient ? recipient.name : 'non selezionato');
  const step3 = step === 3 ? summaryPanel : collapsedRow(3, 'Riepilogo', `${draftCards.length} ${draftCards.length === 1 ? 'carta selezionata' : 'carte selezionate'}`);
  const continueLabel = step === 1 ? (requesting ? 'Proprietario' : 'Destinatario') : 'Riepilogo';
  const continueButton = step < 3 ? `<button type="button" class="loan-continue-btn" data-loan-continue>Continua · ${esc(continueLabel)} ${icon('arrow')}</button>` : '';

  return `<section class="loan-builder-page loan-wizard">
    <header class="loan-builder-hero"><span class="eyebrow">Loan Builder · Passo ${step} di 3</span><h1>${requesting ? 'Richiedi un prestito' : 'Crea un prestito'}</h1><p>Un passo alla volta: prima le carte, poi ${requesting ? 'il proprietario' : 'il destinatario'}, infine il riepilogo.</p></header>
    ${stepper}
    ${modeSwitch}
    <form id="loan-form">${step1}${step2}${step3}</form>
    ${continueButton}
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
    return `<div class="loan-result-tiles">${rows.map(({card,index,item}) => {
      const meta = [item.setCode, `${item.quantityAvailable} disp.`].filter(Boolean).join(' · ');
      return `<article class="loan-search-result">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="">` : `<span class="loan-result-placeholder">${icon('card')}</span>`}<div><strong>${esc(item.cardName || card.name)}</strong><small>${esc(meta)}</small></div>${item.rarity ? `<span class="rarity-chip">${esc(shortRarity(item.rarity))}</span>` : ''}<button type="button" class="btn secondary" data-card-result="${index}" data-inventory-id="${esc(item.id)}">${icon('plus')} Richiedi</button></article>`;
    }).join('')}</div>`;
  }
  return `<div class="loan-result-tiles">${loanSearchResults.map((card, index) => {
    const printing = card.printings?.[0] || {};
    const meta = [printing.setCode || `ID ${card.id}`].filter(Boolean).join(' · ');
    return `<article class="loan-search-result">${card.image ? `<img src="${esc(card.image)}" alt="">` : `<span class="loan-result-placeholder">${icon('card')}</span>`}<div><strong>${esc(card.name)}</strong><small>${esc(meta || card.type || 'Printing non specificata')}</small></div>${printing.rarity ? `<span class="rarity-chip">${esc(shortRarity(printing.rarity))}</span>` : ''}<button type="button" class="btn secondary" data-card-result="${index}">${icon('plus')} Aggiungi</button></article>`;
  }).join('')}</div>`;
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
    <header class="loan-hero-compact"><div class="loan-hero-emblem">${icon('swap')}</div><div class="loan-hero-copy"><h1>Prestiti</h1><span>${esc(GAMES[state.game].short)} · Sala prestiti del team</span></div><button type="button" class="loan-hero-new" data-page="new" aria-label="Nuovo prestito">${icon('plus')}</button></header>
    <div class="loan-stat-strip" aria-label="Riepilogo prestiti"><div class="loan-stat-chip attn"><b>${attention}</b><small>Da gestire</small></div><div class="loan-stat-chip active"><b>${active}</b><small>Attivi</small></div><div class="loan-stat-chip done"><b>${returned}</b><small>Conclusi</small></div></div>
    <section class="surface loan-manager">
      <div class="loan-search-row"><div class="search-field"><span aria-hidden="true">${icon('search')}</span><input id="loan-query" type="search" aria-label="Cerca carta" value="${esc(loanFilters.query)}" placeholder="Cerca una carta..."></div><button type="button" class="loan-more-filters ${loanFiltersExpanded ? 'active' : ''}" id="loan-filters-toggle" aria-label="Altri filtri" aria-expanded="${loanFiltersExpanded}">${icon('more')}</button></div>
      <div class="filter-grid loan-extra-filters" ${loanFiltersExpanded ? '' : 'hidden'}><div><label for="loan-direction">Movimento</label><select id="loan-direction">
        <option value="all" ${loanFilters.direction === 'all' ? 'selected' : ''}>Tutti</option>
        <option value="received" ${loanFilters.direction === 'received' ? 'selected' : ''}>Ricevute da</option>
        <option value="lent" ${loanFilters.direction === 'lent' ? 'selected' : ''}>Prestate a</option>
      </select></div><div><label for="loan-member">Membro</label><select id="loan-member">
        <option value="all" ${loanFilters.member === 'all' ? 'selected' : ''}>Tutti i membri</option>${others.map(m => `<option value="${esc(m.id)}" ${loanFilters.member === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
      </select></div></div>
      <div class="filter-chips loan-status-chips">${[['all','Tutti',null],['attention','Da gestire',attention],['active','Attivi',active],['history','Storico',null]].map(([id,label,count]) => `<button type="button" class="chip ${loanFilters.status === id ? 'active' : ''}" data-status-filter="${id}">${label}${count ? `<span class="count">${count}</span>` : ''}</button>`).join('')}</div>
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
      || (loanFilters.status === 'attention' && ['pending','requested','reserved','return_pending'].includes(l.status))
      || (loanFilters.status === 'active' && l.status === 'active')
      || (loanFilters.status === 'history' && ['returned','completed','rejected'].includes(l.status));
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
  const remaining = Math.max(0, (l.acceptedQuantity || l.quantity) - (l.returnedQuantity || 0));
  const shownQuantity = ['returned','completed'].includes(l.status) ? l.quantity : remaining;
  const visual = l.image ? `<div class="loan-thumb"><img src="${l.image}" alt="" loading="lazy"><em>${shownQuantity}</em></div>` : `<div class="loan-qty">${shownQuantity}<small>pz</small></div>`;
  const memberMarker = person ? `<i class="member-dot ${person.id}"></i>` : '';
  const printing = [l.setCode,l.setName,l.rarity].filter(Boolean).join(' · ');
  return `<button type="button" class="loan-row ${presentation.kind}" data-loan-open="${l.id}">${visual}<div class="loan-main"><strong>${esc(l.cardName)}</strong>${printing ? `<small>${esc(printing)}</small>` : ''}<span class="direction-line"><b class="direction-tag ${presentation.kind}">${presentation.direction}</b> ${memberMarker}${presentation.person}</span><small class="next-action ${presentation.urgent ? 'urgent' : ''}">${presentation.action}</small></div><span class="badge ${presentation.badgeClass}">${presentation.shortStatus}</span></button>`;
}

function loanDetailSheetView(l) {
  const outgoing = l.owner === state.currentUser;
  const incoming = l.borrower === state.currentUser;
  const owner = member(l.owner);
  const borrower = member(l.borrower);
  const presentation = loanPresentation(l, outgoing, incoming, owner, borrower);
  let buttons = '';
  const isAdmin = state.role === 'admin';
  const remaining = Math.max(0, (l.acceptedQuantity || l.quantity) - (l.returnedQuantity || 0));
  const inventory = [...(state.collection.mine || []), ...(state.collection.team || [])].find(item => item.id === l.collectionItemId);
  const available = inventory?.quantityAvailable;
  if (l.status === 'requested' && outgoing) buttons = l.preAgreed
    ? `<div class="request-response"><input type="hidden" data-accept-qty="${l.id}" value="${Math.min(l.requestedQuantity, available ?? l.requestedQuantity)}"><button class="btn small" data-action="accept-request" data-id="${l.id}">${icon('check')} Conferma prestito già concordato</button><button class="btn secondary danger small" data-action="reject-request" data-id="${l.id}">Rifiuta</button></div>`
    : `<div class="request-response"><label>Quantità da accettare<input type="number" min="1" max="${Math.min(l.requestedQuantity, available ?? l.requestedQuantity)}" value="${Math.min(l.requestedQuantity, available ?? l.requestedQuantity)}" data-accept-qty="${l.id}"></label><button class="btn small" data-action="accept-request" data-id="${l.id}">Accetta</button><button class="btn secondary danger small" data-action="reject-request" data-id="${l.id}">Rifiuta</button></div>`;
  if (l.status === 'reserved' && incoming) buttons = `<button class="btn small" data-action="activate" data-id="${l.id}">Conferma ricezione</button>`;
  if (l.status === 'pending' && !outgoing) buttons = `<button class="btn small" data-action="accept" data-id="${l.id}">Accetta</button><button class="btn secondary danger small" data-action="reject" data-id="${l.id}">Rifiuta</button>`;
  // value="1" (non "${remaining}"): un prestito da più copie si restituisce
  // quasi sempre un pezzo alla volta (le carte fisiche tornano una a una).
  // Precompilare con l'INTERA quantità rimanente induceva a restituire tutto
  // per sbaglio — bastava premere "Restituisci" senza toccare il numero,
  // la RPC lo accettava (era comunque <= max) e il prestito si chiudeva
  // per intero invece che del solo pezzo effettivamente reso.
  if (l.status === 'active' && !outgoing) buttons = `<div class="partial-return"><input type="number" min="1" max="${remaining}" value="1" data-return-qty="${l.id}" aria-label="Quantità da restituire"><button class="btn secondary small" data-action="return" data-id="${l.id}">Restituisci</button></div>`;
  if (l.status === 'return_pending' && outgoing) buttons = `<button class="btn small" data-action="confirm-return" data-id="${l.id}">Conferma ${l.pendingReturnQuantity || remaining} pz</button>`;
  if (isAdmin && !buttons) buttons = `<button class="btn secondary danger small" data-action="admin-delete" data-id="${l.id}">Elimina</button>`;
  const printing = [l.setCode,l.setName,l.rarity].filter(Boolean).join(' · ');
  const quantities = l.acceptedQuantity > 0 && l.requestedQuantity !== l.acceptedQuantity ? `<p class="quantity-help">Richieste ${l.requestedQuantity} · accettate ${l.acceptedQuantity} · rimanenti ${remaining}</p>` : l.status === 'requested' ? `<p class="quantity-help">Richieste ${l.requestedQuantity}${Number.isFinite(available) ? ` · disponibili ora ${available}` : ''}</p>` : '';
  return `<div class="detail-backdrop" data-close-loan-detail><aside class="card-detail loan-detail-sheet" role="dialog" aria-modal="true"><button class="detail-close" data-close-loan-detail aria-label="Chiudi">×</button>
    <div class="deck-sheet-body"><span class="deck-sheet-art">${l.image ? `<img src="${l.image}" alt="">` : icon('card')}</span><span class="deck-sheet-copy"><strong>${esc(l.cardName)}</strong>${printing ? `<small>${esc(printing)}</small>` : ''}<span class="badge ${presentation.badgeClass}">${presentation.shortStatus}</span></span></div>
    <div class="ownership"><span><small>Proprietario</small><b>${owner.name}</b></span><span>→</span><span><small>Richiedente</small><b>${borrower.name}</b></span></div>
    <p class="quantity-help">Registrato il ${formatDate(l.createdAt)}</p>
    ${quantities}
    <p>${l.notes ? esc(l.notes) : 'Nessuna nota'}</p>
    ${buttons ? `<div class="actions loan-actions">${buttons}</div>` : ''}
  </aside></div>`;
}

function loanPresentation(l, outgoing, incoming, owner, borrower) {
  if (outgoing) {
    const states = {
      requested: l.preAgreed
        ? [`${borrower.name} conferma il prestito già concordato di ${l.cardName} ×${l.requestedQuantity}`, 'Da confermare', 'wait', true]
        : [`${borrower.name} richiede ${l.cardName} ×${l.requestedQuantity}`, 'Da valutare', 'wait', true],
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

function teamModel() {
  const supported=pushSupported();
  return {members:MEMBERS,currentUser:state.currentUser,admin:state.role==='admin',supported,configured:supported&&pushConfigured(),
    openLoans:state.loans.filter(loan=>!['returned','completed','rejected'].includes(loan.status)).length,
    avatar:m=>profileAvatarMarkup(m,memberProfiles.get(m.id)||{}),
    title:m=>{const profile=memberProfiles.get(m.id)||{};return findCosmetic(profile.activeTitle)?.label||titleForLevel(profile.level||1);}
  };
}
function teamView() { return renderTeamPage(teamModel()); }

// Artwork Resolver: stato locale della coda, mai persistito (si ricarica ogni
// volta che la pagina si apre — è un elenco di lavoro, non dati utente).
// canManageArtwork = admin O can_verify_ygo_artwork (Artwork Curator): la UI
// nascosta è solo comodità, le RPC applicano lo stesso controllo lato server.
function canManageArtwork() { return state.role === 'admin' || Boolean(state.canVerifyYgoArtwork); }

const adminArtworkState = {
  loading: false, error: '', queue: [], offset: 0, hasMore: false,
  selections: new Map(), confirming: new Set(), setPrefixes: [],
  filters: { query: '', setPrefix: '', usedOnly: true, orderBy: 'usage_count' },
  view: 'queue', history: [], historyLoading: false
};
const ADMIN_ARTWORK_PAGE_SIZE = 30;

function adminModel() {
  return {
    loading: adminArtworkState.loading, error: adminArtworkState.error, queue: adminArtworkState.queue,
    hasMore: adminArtworkState.hasMore, selections: adminArtworkState.selections,
    filters: adminArtworkState.filters, setPrefixes: adminArtworkState.setPrefixes,
    view: adminArtworkState.view, history: adminArtworkState.history, historyLoading: adminArtworkState.historyLoading,
    isAdmin: state.role === 'admin', currentUserName: member(state.currentUser)?.name || ''
  };
}
function adminView() { return renderAdminPage(adminModel()); }

async function loadAdminArtworkQueue(reset = true) {
  if (!canManageArtwork()) return;
  if (reset) { adminArtworkState.queue = []; adminArtworkState.offset = 0; adminArtworkState.selections.clear(); }
  adminArtworkState.loading = true; adminArtworkState.error = ''; render();
  try {
    const { query, setPrefix, usedOnly, orderBy } = adminArtworkState.filters;
    const rows = await api.ygoArtworkReviewQueue({ limit:ADMIN_ARTWORK_PAGE_SIZE, offset:adminArtworkState.offset, query, setPrefix, usedOnly, orderBy });
    const mapped = rows.map(row => ({
      setCode: row.set_code, cardName: row.card_name, setNames: row.set_names || [], rarities: row.rarities || [],
      konamiCardId: row.konami_card_id, artworkCount: row.artwork_count, currentArtworkUrl: row.current_artwork_url,
      candidates: Array.isArray(row.candidates) ? row.candidates : [],
      collectionUsage: row.collection_usage, deckUsage: row.deck_usage, loanUsage: row.loan_usage,
      usageCount: row.usage_count
    }));
    adminArtworkState.queue = adminArtworkState.queue.concat(mapped);
    adminArtworkState.offset += mapped.length;
    const total = rows[0]?.total_count ?? adminArtworkState.queue.length;
    adminArtworkState.hasMore = adminArtworkState.queue.length < total;
    if (reset) api.ygoArtworkReviewSetPrefixes().then(prefixes => { adminArtworkState.setPrefixes = prefixes; render(); }).catch(() => {});
  } catch (error) { adminArtworkState.error = error.message || 'Coda non disponibile'; }
  finally { adminArtworkState.loading = false; render(); }
}

function setAdminArtworkFilter(key, value) {
  adminArtworkState.filters[key] = value;
  void loadAdminArtworkQueue(true);
}

function selectAdminArtworkCandidate(setCode, index, url) {
  adminArtworkState.selections.set(setCode, { index, url });
  render();
}

async function confirmAdminArtworkSelection(setCode, advanceToNext) {
  const selection = adminArtworkState.selections.get(setCode);
  const item = adminArtworkState.queue.find(row => row.setCode === setCode);
  if (!selection || !item || adminArtworkState.confirming.has(setCode)) return;
  adminArtworkState.confirming.add(setCode); render();
  try {
    // Nessun optimistic success: la riga resta in coda finché la RPC non
    // conferma di aver persistito — un fallimento lascia la selezione intatta.
    await api.confirmYgoPrintingArtwork(setCode, selection.index);
    adminArtworkState.queue = adminArtworkState.queue.filter(row => row.setCode !== setCode);
    adminArtworkState.selections.delete(setCode);
    toast(`Artwork confermato per ${setCode}`);
    render();
    if (advanceToNext) document.querySelector('.admin-artwork-queue')?.scrollIntoView({ behavior:'smooth', block:'start' });
  } catch (error) { toast(error.message || 'Conferma non riuscita'); }
  finally { adminArtworkState.confirming.delete(setCode); render(); }
}

async function loadMyArtworkHistory() {
  adminArtworkState.view = 'history'; adminArtworkState.historyLoading = true; render();
  try {
    const rows = await api.myYgoArtworkVerifications();
    adminArtworkState.history = rows.map(row => ({
      setCode: row.set_code, konamiCardId: row.konami_card_id, previousArtworkIndex: row.previous_artwork_index,
      newArtworkIndex: row.new_artwork_index, verificationSource: row.verification_source, verifiedAt: row.verified_at
    }));
  } catch (error) { toast(error.message || 'Storico non disponibile'); }
  finally { adminArtworkState.historyLoading = false; render(); }
}

// Market Variant Resolver: stessa filosofia di adminArtworkState (coda di
// lavoro non persistita, ricaricata a ogni apertura pagina). Solo admin —
// le RPC (20260912170000_ygo_market_variant_review_resolver.sql) sono
// role='admin' puro, nessun capability-equivalente al curator artwork
// esiste ancora per i market variant.
const marketVariantState = {
  loading: false, error: '', queue: [], offset: 0, hasMore: false,
  selections: new Map(), confirming: new Set(),
  filters: { query: '', usedOnly: true }
};
const MARKET_VARIANT_PAGE_SIZE = 30;

function marketVariantModel() {
  return {
    loading: marketVariantState.loading, error: marketVariantState.error, queue: marketVariantState.queue,
    hasMore: marketVariantState.hasMore, selections: marketVariantState.selections, filters: marketVariantState.filters
  };
}
function marketVariantView() { return renderMarketVariantPage(marketVariantModel()); }

async function loadMarketVariantQueue(reset = true) {
  if (state.role !== 'admin') return;
  if (reset) { marketVariantState.queue = []; marketVariantState.offset = 0; marketVariantState.selections.clear(); }
  marketVariantState.loading = true; marketVariantState.error = ''; render();
  try {
    const { query, usedOnly } = marketVariantState.filters;
    const rows = await api.ygoMarketVariantReviewQueue({ limit:MARKET_VARIANT_PAGE_SIZE, offset:marketVariantState.offset, query, usedOnly });
    const mapped = rows.map(row => ({
      printingId: row.printing_id, cardName: row.card_name, setCode: row.set_code, setName: row.set_name, rarity: row.rarity,
      mappingStatus: row.mapping_status, mappingSource: row.mapping_source, mappingConfidence: row.mapping_confidence,
      cardmarketProductId: row.cardmarket_product_id,
      candidateProductIds: Array.isArray(row.candidate_product_ids) ? row.candidate_product_ids : [],
      resolutionReason: row.resolution_reason, verified: row.verified,
      collectionUsage: row.collection_usage, deckUsage: row.deck_usage, loanUsage: row.loan_usage, usageCount: row.usage_count
    }));
    marketVariantState.queue = marketVariantState.queue.concat(mapped);
    marketVariantState.offset += mapped.length;
    const total = rows[0]?.total_count ?? marketVariantState.queue.length;
    marketVariantState.hasMore = marketVariantState.queue.length < total;
  } catch (error) { marketVariantState.error = error.message || 'Coda non disponibile'; }
  finally { marketVariantState.loading = false; render(); }
}

function setMarketVariantFilter(key, value) {
  marketVariantState.filters[key] = value;
  void loadMarketVariantQueue(true);
}

function selectMarketVariantCandidate(printingId, productId) {
  marketVariantState.selections.set(printingId, productId);
  render();
}

async function confirmMarketVariantSelection(printingId) {
  const productId = marketVariantState.selections.get(printingId);
  const item = marketVariantState.queue.find(row => row.printingId === printingId);
  if (!productId || !item || marketVariantState.confirming.has(printingId)) return;
  marketVariantState.confirming.add(printingId); render();
  try {
    // Nessun optimistic success: la riga resta in coda finché la RPC non
    // conferma di aver persistito (stesso pattern di confirmAdminArtworkSelection).
    await api.confirmYgoMarketVariant(printingId, productId);
    marketVariantState.queue = marketVariantState.queue.filter(row => row.printingId !== printingId);
    marketVariantState.selections.delete(printingId);
    toast(`Market variant confermata per ${item.setCode} · ${item.rarity}`);
    render();
  } catch (error) { toast(error.message || 'Conferma non riuscita'); }
  finally { marketVariantState.confirming.delete(printingId); render(); }
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
  document.querySelectorAll('[data-collection-add]').forEach(button => button.addEventListener('click', () => { if (!online()) return toast('Torna online per modificare la raccolta'); collectionEditor = { item:null, card:null, printing:null }; collectionSearchResults = []; render(); }));
  document.querySelectorAll('[data-fast-scan]').forEach(button => button.addEventListener('click', () => navigate('fastscan')));
  document.querySelectorAll('[data-collection-share]').forEach(button => button.addEventListener('click', () => { if (!online()) return toast('Torna online per condividere la raccolta'); void openCollectionShareModal(); }));
  document.querySelectorAll('[data-close-collection-share]').forEach(element => element.addEventListener('click', event => { if (event.target !== element && !event.target.closest('.detail-close')) return; collectionShareModal = false; render(); }));
  document.querySelector('[data-generate-share]')?.addEventListener('click', () => void generateCollectionShareLink());
  document.querySelector('[data-regenerate-share]')?.addEventListener('click', () => void generateCollectionShareLink());
  document.querySelector('[data-revoke-share]')?.addEventListener('click', () => void revokeCollectionShareLink());
  document.querySelector('[data-copy-share-link]')?.addEventListener('click', async () => {
    const field = document.querySelector('[data-share-url]');
    try { await navigator.clipboard.writeText(field.value); toast('Link copiato'); }
    catch { field.select(); toast('Seleziona e copia il link'); }
  });
  document.querySelector('[data-share-collection-link]')?.addEventListener('click', () => void shareCollectionShareLink());
  document.querySelectorAll('[data-mark-request-seen]').forEach(button => button.addEventListener('click', async () => {
    try { await api.markCollectionShareRequestSeen(button.dataset.markRequestSeen); await loadCollectionShareRequests(); requestsTab = 'confirmed'; render(); }
    catch (error) { toast(error.message || 'Operazione non riuscita'); }
  }));
  document.querySelectorAll('[data-requests-tab]').forEach(button => button.addEventListener('click', () => { requestsTab = button.dataset.requestsTab; render(); }));
  document.querySelectorAll('[data-collection-item]').forEach(button => button.addEventListener('click', () => openCollectionDetail(button.dataset.collectionItem)));
  if (page === 'collection') observeCollectionSentinel();
  document.querySelectorAll('[data-close-collection-detail]').forEach(element => element.addEventListener('click', event => { if (event.target !== element && !event.target.closest('.detail-close')) return; closeCollectionDetail(); }));
  document.querySelectorAll('[data-close-collection-editor]').forEach(element => element.addEventListener('click', event => { if (event.target !== element && !event.target.closest('.detail-close')) return; collectionEditor = null; collectionSearchResults = []; render(); }));
  document.querySelectorAll('[data-close-collection-request]').forEach(element => element.addEventListener('click', event => { if (event.target !== element && !event.target.closest('.detail-close')) return; collectionLoanRequest = null; render(); }));
  document.querySelectorAll('[data-collection-edit]').forEach(button => button.addEventListener('click', () => openCollectionEditor(button.dataset.collectionEdit)));
  document.querySelectorAll('[data-collection-delete]').forEach(button => button.addEventListener('click', () => deleteCollectionItem(button.dataset.collectionDelete)));
  document.querySelectorAll('[data-market-watch-add]').forEach(button => button.addEventListener('click', async () => { try { await api.setMarketWatchItem(button.dataset.marketWatchAdd,true); await marketWatch.load(); toast('Printing aggiunta alla Watchlist'); } catch (error) { toast(error.message||'Watchlist non disponibile'); } }));
  document.querySelectorAll('[data-collection-loan]').forEach(button => button.addEventListener('click', () => createLoanFromCollection(button.dataset.collectionLoan)));
  document.querySelectorAll('[data-request-collection-loan]').forEach(button => button.addEventListener('click', () => openCollectionLoanRequest(button.dataset.requestCollectionLoan)));
  document.querySelector('#collection-card-search')?.addEventListener('input', onCollectionCardSearch);
  document.querySelector('#collection-set')?.addEventListener('change', event => {
    if (!collectionEditor?.card) return;
    collectionEditor.setCode = event.currentTarget.value;
    const options = collectionPrintingOptions(collectionEditor.card).filter(printing => sameCollectionSet(printing.setCode, collectionEditor.setCode));
    collectionEditor.printing = options.length === 1 ? options[0] : null;
    render();
  });
  document.querySelector('#collection-rarity')?.addEventListener('change', event => {
    if (!collectionEditor?.card) return;
    collectionEditor.printing = collectionPrintingOptions(collectionEditor.card).find(printing =>
      sameCollectionSet(printing.setCode, collectionEditor.setCode) && sameCollectionRarity(printing.rarity, event.currentTarget.value)
    ) || null;
    render();
  });
  document.querySelectorAll('[data-collection-printing-option]').forEach(button => button.addEventListener('click', () => {
    if (!collectionEditor?.card) return;
    const option = collectionPrintingOptions(collectionEditor.card).find(printing => String(printing.printingId || '') === button.dataset.collectionPrintingOption);
    if (!option) return;
    collectionEditor.printing = option;
    collectionEditor.setCode = option.setCode;
    render();
  }));
  document.querySelector('#collection-first-edition')?.addEventListener('change', event => {
    event.currentTarget.dataset.editionTouched = 'true';
    const status = document.querySelector('[data-edition-status]');
    if (status) status.textContent = event.currentTarget.checked ? 'Prima Edizione' : 'Non Prima Edizione / Unlimited';
  });
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
  document.querySelectorAll('[data-loan-step]').forEach(button => button.addEventListener('click', () => { loanBuilderStep = Number(button.dataset.loanStep); render(true); }));
  document.querySelector('[data-loan-continue]')?.addEventListener('click', () => { loanBuilderStep = Math.min(3, loanBuilderStep + 1); render(true); });
  document.querySelector('#borrower')?.addEventListener('change', event => changeLoanCounterpart(event.currentTarget.value));
  document.querySelector('#notes')?.addEventListener('input', event => { loanBuilderDraft.notes = event.currentTarget.value.slice(0, 250); const count = document.querySelector('#notes-count'); if (count) count.textContent = `${loanBuilderDraft.notes.length} / 250`; });
  document.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => updateLoan(b.dataset.id, b.dataset.action)));
  document.querySelector('#loan-direction')?.addEventListener('change', e => { loanFilters.direction = e.target.value; refreshLoanRows(); });
  document.querySelector('#loan-member')?.addEventListener('change', e => { loanFilters.member = e.target.value; refreshLoanRows(); });
  document.querySelector('#loan-query')?.addEventListener('input', e => { loanFilters.query = e.target.value; refreshLoanRows(); });
  document.querySelectorAll('[data-status-filter]').forEach(b => b.addEventListener('click', () => { loanFilters.status = b.dataset.statusFilter; refreshLoanRows(); }));
  document.querySelector('#clear-filters')?.addEventListener('click', () => { loanFilters = { direction: 'all', member: 'all', query: '', status: 'all' }; refreshLoanRows(true); });
  document.querySelector('#loan-filters-toggle')?.addEventListener('click', () => { loanFiltersExpanded = !loanFiltersExpanded; render(); });
  document.querySelectorAll('[data-loan-open]').forEach(button => button.addEventListener('click', () => { selectedLoanId = button.dataset.loanOpen; render(); }));
  document.querySelectorAll('[data-close-loan-detail]').forEach(element => element.addEventListener('click', event => { if (event.target !== element && !event.target.closest('.detail-close')) return; selectedLoanId = ''; render(); }));
  document.querySelector('#reset-data')?.addEventListener('click', () => toast('I dati condivisi non si cancellano dal dispositivo'));
  document.querySelector('#enable-notifications')?.addEventListener('click', enableNotifications);
  document.querySelector('#member-form')?.addEventListener('submit', addMember);
  bindTeamPage(document, teamModel(), manageMember);
  bindAdminPage(document, adminModel(), {
    onSelectCandidate: selectAdminArtworkCandidate, onConfirm: confirmAdminArtworkSelection,
    onLoadMore: () => loadAdminArtworkQueue(false), onFilterChange: setAdminArtworkFilter,
    onViewHistory: loadMyArtworkHistory, onViewQueue: () => { adminArtworkState.view = 'queue'; render(); }
  });
  bindMarketVariantPage(document, marketVariantModel(), {
    onSelectCandidate: selectMarketVariantCandidate, onConfirm: confirmMarketVariantSelection,
    onLoadMore: () => loadMarketVariantQueue(false), onFilterChange: setMarketVariantFilter
  });
  document.querySelector('#retry-cloud')?.addEventListener('click', retryCloud);
  document.querySelector('[data-rick-secret]')?.addEventListener('click', secretRickroll);
  if (page === 'decks') decks.bind(document);
  if (page === 'market') marketWatch.bind(document);
  if (page === 'fastscan') fastScan.bind(document);
  if (page === 'stats') stats.bind(document);
  bindProgressionHeader(document);
}

function installCollectionControls() {
  const root = document.querySelector('#app');
  if (!root || root.dataset.collectionControls === 'ready') return;
  root.dataset.collectionControls = 'ready';
  root.addEventListener('input', event => {
    if (!event.target.matches('[data-collection-query]')) return;
    collectionFilters.query = event.target.value;
    collectionVisibleCount = COLLECTION_PAGE_SIZE;
    // Filtering+sorting+re-rendering the whole grid on every keystroke was
    // visibly janky on a large collection — debounce both paths the same way
    // instead of only the (rarer) first-render path.
    clearTimeout(collectionSearchTimer);
    collectionSearchTimer = setTimeout(() => {
      if (document.querySelector('[data-collection-results]')) refreshCollectionResults();
      else {
        render();
        const field = document.querySelector('[data-collection-query]');
        field?.focus();
        field?.setSelectionRange(field.value.length, field.value.length);
      }
    }, 220);
  });
  root.addEventListener('change', event => {
    const facetKey = event.target.dataset.collectionFacet;
    if (event.target.matches('#collection-owner')) collectionFilters.owner = event.target.value;
    else if (event.target.matches('#collection-status')) collectionFilters.status = event.target.value;
    else if (event.target.matches('#collection-sort')) collectionFilters.sort = event.target.value;
    else if (facetKey) collectionFilters.facets[facetKey] = event.target.value;
    else return;
    collectionVisibleCount = COLLECTION_PAGE_SIZE;
    refreshCollectionResults();
  });
  root.addEventListener('click', event => {
    const scope = event.target.closest('[data-collection-scope]');
    if (scope) {
      collectionFilters.scope = scope.dataset.collectionScope;
      collectionFilters.owner = 'all';
      collectionFilters.status = 'all';
      selectedCollectionItem = '';
      collectionVisibleCount = COLLECTION_PAGE_SIZE;
      render();
      return;
    }
    const statusChip = event.target.closest('[data-collection-status-chip]');
    if (statusChip) {
      collectionFilters.status = statusChip.dataset.collectionStatusChip;
      root.querySelectorAll('[data-collection-status-chip]').forEach(button => button.classList.toggle('active', button === statusChip));
      collectionVisibleCount = COLLECTION_PAGE_SIZE;
      refreshCollectionResults();
      return;
    }
    const layout = event.target.closest('[data-collection-layout]');
    if (layout) {
      collectionFilters.layout = layout.dataset.collectionLayout;
      root.querySelectorAll('[data-collection-layout]').forEach(button => button.classList.toggle('active', button === layout));
      refreshCollectionResults();
      return;
    }
    const jump = event.target.closest('[data-collection-jump]');
    if (!jump || jump.disabled) return;
    const letter = jump.dataset.collectionJump;
    const target = collectionJumpTarget(state.collection, collectionFilters, state.game, letter);
    if (!target) return;
    // The tapped letter's card may be well past what's currently rendered —
    // grow the window just enough to include it (plus a page of headroom)
    // before re-rendering and scrolling, rather than revealing everything.
    if (target.index >= collectionVisibleCount) collectionVisibleCount = target.index + COLLECTION_PAGE_SIZE;
    refreshCollectionResults();
    requestAnimationFrame(() => {
      document.querySelector(`[data-collection-item="${CSS.escape(target.id)}"]`)?.scrollIntoView({ block:'center', behavior:'smooth' });
    });
  });
}

function refreshCollectionResults() {
  const results = document.querySelector('[data-collection-results]');
  if (!results) return;
  results.innerHTML = collectionResultsView(state.collection, collectionFilters, state.game, online(), collectionVisibleCount, deckUsageIndex(state.decks, state.currentUser, state.game));
  results.querySelectorAll('[data-collection-item]').forEach(button => button.addEventListener('click', () => openCollectionDetail(button.dataset.collectionItem)));
  results.querySelectorAll('[data-collection-add]').forEach(button => button.addEventListener('click', () => {
    if (!online()) return toast('Torna online per modificare la raccolta');
    collectionEditor = { item:null, card:null, printing:null };
    collectionSearchResults = [];
    render();
  }));
  observeCollectionSentinel();
}

async function loadCollectionShareRequests() {
  // Best-effort: the sharing migration may not be applied yet on some
  // installs, and this is a secondary feature — never let a failure here
  // block the rest of loadPrimaryData()'s Promise.allSettled batch.
  try { collectionShareRequests = await api.collectionShareRequests(); }
  catch {}
}
async function refreshCollectionShareRequests() {
  // Unlike loadCollectionShareRequests() above, this one is a deliberate,
  // visible refresh (tapping the Richieste tab) — errors here should be
  // seen, not swallowed, since a silent failure here looks identical to
  // "no new requests" and is impossible to tell apart from the UI alone.
  try { collectionShareRequests = await api.collectionShareRequests(); renderRoute(); }
  catch (error) { toast(error.message || 'Impossibile aggiornare le richieste'); }
}

function collectionShareUrl(id) { return `${location.origin}${location.pathname}#/share/${id}`; }

async function openCollectionShareModal() {
  collectionShareModal = true; collectionShareLink = null; render();
  try {
    const shares = await api.collectionShares();
    collectionShareLink = shares.find(share => share.game === state.game && share.active) || null;
    if (!collectionShareLink) {
      const id = await api.createCollectionShare(state.game);
      collectionShareLink = { id, game: state.game, active:true };
    }
  } catch (error) { toast(error.message || 'Impossibile caricare il link di condivisione'); }
  render();
  // The whole point of tapping "Condividi" is to hand the link to someone —
  // jump straight to the native share sheet instead of making that a second
  // tap inside the modal, which stays open underneath for copy/regenerate/revoke.
  if (collectionShareLink) void shareCollectionShareLink();
}

async function generateCollectionShareLink() {
  collectionSharePending = true; render();
  try {
    const id = await api.createCollectionShare(state.game);
    collectionShareLink = { id, game: state.game, active:true };
  } catch (error) { toast(error.message || 'Generazione del link non riuscita'); }
  finally { collectionSharePending = false; render(); }
}

async function shareCollectionShareLink() {
  if (!collectionShareLink) return;
  const url = collectionShareUrl(collectionShareLink.id);
  try {
    if (navigator.share) { await navigator.share({ title:'La mia raccolta F.P.T Cards', text:'Dai un\'occhiata alle mie carte e dimmi cosa ti interessa', url }); return; }
    await navigator.clipboard.writeText(url); toast('Link copiato negli appunti');
  } catch (error) { if (error?.name !== 'AbortError') toast('Condivisione non riuscita'); }
}

async function revokeCollectionShareLink() {
  if (!collectionShareLink) return;
  collectionSharePending = true; render();
  try { await api.revokeCollectionShare(collectionShareLink.id); collectionShareLink = null; toast('Link revocato'); }
  catch (error) { toast(error.message || 'Revoca non riuscita'); }
  finally { collectionSharePending = false; render(); }
}

function collectionShareModalView() {
  const url = collectionShareLink ? collectionShareUrl(collectionShareLink.id) : '';
  return `<div class="detail-backdrop" data-close-collection-share><aside class="card-detail share-owner-modal" role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
    <button class="detail-close" data-close-collection-share aria-label="Chiudi">×</button>
    <span class="eyebrow">Condividi raccolta</span><h2 id="share-modal-title">Link pubblico</h2>
    <p>Chi apre questo link vede le tue carte (${esc(GAMES[state.game]?.short || state.game)}) e può segnalarti quali gli interessano — non serve un account F.P.T Cards.</p>
    ${collectionShareLink ? `
      <div class="share-link-box"><input type="text" readonly value="${esc(url)}" data-share-url onclick="this.select()"><button type="button" class="btn secondary small" data-copy-share-link>Copia</button></div>
      <button type="button" class="btn share-send-btn" data-share-collection-link>${icon('share')} Condividi con…</button>
      <div class="share-owner-actions"><button type="button" class="btn secondary" data-regenerate-share ${collectionSharePending ? 'disabled' : ''}>Rigenera</button><button type="button" class="btn secondary danger" data-revoke-share ${collectionSharePending ? 'disabled' : ''}>Revoca</button></div>
    ` : `<button type="button" class="btn" data-generate-share ${collectionSharePending ? 'disabled' : ''}>${collectionSharePending ? 'Genero…' : 'Genera link'}</button>`}
  </aside></div>`;
}

function requestsView() {
  const pending = collectionShareRequests.filter(request => request.status === 'pending');
  const confirmed = collectionShareRequests.filter(request => request.status === 'seen');
  const list = requestsTab === 'confirmed' ? confirmed : pending;
  const emptyCopy = requestsTab === 'confirmed'
    ? { title:'Nessuna richiesta confermata', body:'Le richieste che confermi finiscono qui: un archivio di tutti gli scambi conclusi con chi ha visto la tua raccolta.' }
    : { title:'Nessuna richiesta in attesa', body:'Condividi la tua raccolta da Raccolta per iniziare a ricevere richieste.' };
  return `<section class="page-stack"><header class="page-header"><div><span class="eyebrow">Interesse ricevuto</span><h1>Richieste</h1><p>Chi ha visto la tua raccolta condivisa e ti ha segnalato interesse.</p></div></header>
    <nav class="market-tabs" aria-label="Filtri richieste">
      <button type="button" data-requests-tab="pending" class="${requestsTab === 'pending' ? 'active' : ''}">In attesa <span>${pending.length}</span></button>
      <button type="button" data-requests-tab="confirmed" class="${requestsTab === 'confirmed' ? 'active' : ''}">Confermate <span>${confirmed.length}</span></button>
    </nav>
    <section class="surface">${list.length ? `<div class="share-request-list">${list.map(requestRowHtml).join('')}</div>` : `<div class="inline-empty">${icon('bell')}<div><strong>${emptyCopy.title}</strong><span>${emptyCopy.body}</span></div></div>`}</section>
  </section>`;
}

function requestRowHtml(request) {
  const items = request.items || [];
  return `<article class="share-request-row ${request.status}"><header><div><strong>${esc(request.requesterName)}</strong><small>${formatDate(request.createdAt)} · ${items.length} ${items.length === 1 ? 'carta' : 'carte'}</small></div>${request.status === 'pending' ? `<button type="button" class="btn secondary small" data-mark-request-seen="${esc(request.id)}">Conferma</button>` : ''}</header>
    ${request.message ? `<p class="share-request-message">${icon('message')} ${esc(request.message)}</p>` : ''}
    <div class="share-receipt">
      ${items.map(requestReceiptRowHtml).join('')}
      <div class="share-receipt-total"><span>Totale stimato · Market Watch</span><b>${formatEuro(request.totalPrice) || 'n/d'}</b></div>
    </div>
  </article>`;
}
function requestReceiptRowHtml(item) {
  const unit = formatEuro(item.unitPrice);
  const lineTotal = typeof item.unitPrice === 'number' ? formatEuro(item.unitPrice * item.quantity) : null;
  return `<div class="share-receipt-row">
    <span class="share-receipt-art">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" loading="lazy">` : icon('card')}</span>
    <div class="share-receipt-info"><b>${esc(item.cardName)}</b><small>${item.quantity}× ${unit ? `· ${unit} cad.` : '· prezzo n/d'}</small></div>
    <b class="share-receipt-price">${lineTotal || '—'}</b>
  </div>`;
}
function formatEuro(value) {
  return typeof value === 'number' ? value.toLocaleString('it-IT', { style:'currency', currency:'EUR' }) : null;
}

// The results grid only ever renders collectionVisibleCount items — this
// grows the window in batches as the sentinel (rendered right after the
// last visible tile whenever more items remain) scrolls into view, instead
// of building thousands of DOM nodes for a large collection up front. The
// sentinel node is replaced on every render, so the observer needs
// reattaching each time rather than being set up once.
function observeCollectionSentinel() {
  collectionSentinelObserver?.disconnect();
  const sentinel = document.querySelector('[data-collection-sentinel]');
  if (!sentinel) return;
  collectionSentinelObserver = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    collectionSentinelObserver.disconnect();
    collectionVisibleCount += COLLECTION_PAGE_SIZE;
    refreshCollectionResults();
  }, { rootMargin: '400px' });
  collectionSentinelObserver.observe(sentinel);
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
  document.querySelectorAll('.loan-list [data-loan-open]').forEach(button => button.addEventListener('click', () => { selectedLoanId = button.dataset.loanOpen; render(); }));
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

// Il dettaglio carta è un overlay sopra la Raccolta, non una pagina: gli si
// dà comunque una voce di history (stesso hash, state dedicato) così il tasto
// Indietro chiude solo il dettaglio invece di saltare alla pagina precedente
// (es. Home). Vedi il listener "popstate" più sotto.
function openCollectionDetail(id) {
  selectedCollectionItem = id;
  ensureCardTypeForDetail(id);
  history.pushState({ collectionDetail: id }, '', location.hash || '#/collection');
  render();
}
function closeCollectionDetail() {
  if (!selectedCollectionItem) return;
  if (history.state && history.state.collectionDetail === selectedCollectionItem) {
    history.back();
  } else {
    selectedCollectionItem = '';
    render();
  }
}
function cardTypeForDetail(id) {
  const item = [...(state.collection.mine || []), ...(state.collection.team || [])].find(entry => entry.id === id);
  return item?.catalogCardId ? cardTypeCache.get(String(item.catalogCardId)) || '' : '';
}
// Sfondo pronto solo quando non serve un tipo YGOPRODeck (One Piece, o carta
// senza catalogCardId) oppure quando il tipo è già in cache: evita di mostrare
// per errore lo sfondo di default mentre il fetch del tipo è ancora in corso.
function cardTypeReadyForDetail(id) {
  const item = [...(state.collection.mine || []), ...(state.collection.team || [])].find(entry => entry.id === id);
  if (!item || item.game !== 'yugioh' || !item.catalogCardId) return true;
  return cardTypeCache.has(String(item.catalogCardId));
}
// Pre-carica in background il tipo di TUTTE le carte Yu-Gi-Oh! della
// raccolta (mine+team) appena questa viene sincronizzata, invece di aspettare
// che l'utente apra un dettaglio: così, quando lo apre, il tipo è quasi
// sempre già in cache e cardTypeReadyForDetail torna true da subito — niente
// più stato "is-type-pending" visibile nel caso comune. cardTypesByIds
// raggruppa già gli id a blocchi di 40, pensata apposta per centinaia di id
// in un colpo solo (vedi js/cards.js). Fire-and-forget: non deve rallentare
// loadCollection, e ids già in cache/in-flight vengono filtrati per non
// duplicare richieste tra sync successivi.
function prefetchCollectionCardTypes() {
  const items = [...(state.collection.mine || []), ...(state.collection.team || [])];
  const ids = [...new Set(items.filter(item => item.game === 'yugioh' && item.catalogCardId).map(item => String(item.catalogCardId)))]
    .filter(id => !cardTypeCache.has(id) && !cardTypeInFlight.has(id));
  if (!ids.length) return;
  ids.forEach(id => cardTypeInFlight.add(id));
  cardTypesByIds(ids, 'yugioh').then(map => {
    ids.forEach(id => cardTypeCache.set(id, map[id] || ''));
    render();
  }).finally(() => ids.forEach(id => cardTypeInFlight.delete(id)));
}
// Sfondo del dettaglio per tipo (magia/trappola/mostro fusione): nessun dato
// di raccolta porta già il tipo YGOPRODeck, va risolto al volo la prima
// volta che si apre quella carta e messo in cache (mai per One Piece) — resta
// come rete di sicurezza per una carta appena aggiunta/non ancora pre-caricata.
function ensureCardTypeForDetail(id) {
  const item = [...(state.collection.mine || []), ...(state.collection.team || [])].find(entry => entry.id === id);
  if (!item || item.game !== 'yugioh' || !item.catalogCardId) return;
  const key = String(item.catalogCardId);
  if (cardTypeCache.has(key) || cardTypeInFlight.has(key)) return;
  cardTypeInFlight.add(key);
  cardTypesByIds([key], 'yugioh').then(map => {
    cardTypeCache.set(key, map[key] || '');
    if (selectedCollectionItem === id) render();
  }).finally(() => cardTypeInFlight.delete(key));
}

function mapCollectionItem(item) {
  const storedImage = normalizeCardImageUrl(item.image_url);
  return {
    id:item.id, printingId:item.printing_id, ownerSlug:item.owner_slug,
    ownerName:item.owner_name, game:item.game, catalogCardId:item.catalog_card_id,
    cardName:item.card_name, setCode:item.set_code || '', setName:item.set_name || '',
    rarity:normalizeCatalogRarity(item.rarity) || item.rarity || '', language:item.language || 'Italiano',
    condition:item.condition || 'Near Mint', edition:item.edition || '',
    // Niente fallback a canonicalYgoCardImage(catalogCardId) quando manca
    // image_url: quello sarebbe l'artwork "principale" della CARD per
    // YGOPRODeck, non necessariamente quello di QUESTA printing (set_code
    // specifico) — esattamente il bug che il Printing Registry risolve
    // (vedi js/ygo-printing-registry.js). Meglio il placeholder (già gestito
    // da ogni vista, vedi js/collection.js) che un artwork sbagliato.
    imageUrl:storedImage, quantityOwned:Number(item.quantity_owned || 0),
    quantityLoaned:Number(item.quantity_loaned || 0),
    quantityReserved:Number(item.quantity_reserved || 0),
    quantityAvailable:Number(item.quantity_physically_available ?? item.quantity_available ?? 0),
    legacyAmbiguous:Boolean(item.legacy_ambiguous), createdAt:item.created_at,
    updatedAt:item.updated_at, variantId:item.variant_id || '',
    // game_metadata è '{}' per ogni riga Yu-Gi-Oh (default colonna): questi
    // campi restano semplicemente vuoti/null per loro, non serve un ramo
    // per gioco qui — i filtri Collection One Piece (js/games/onepiece/
    // collection.js) sono gli unici a leggerli davvero.
    colors:Array.isArray(item.game_metadata?.colors) ? item.game_metadata.colors : [],
    cardType:item.game_metadata?.cardType || '',
    cost:item.game_metadata?.cost ?? null,
    power:item.game_metadata?.power ?? null,
    counter:item.game_metadata?.counter ?? null
  };
}

async function loadCollection({ force = false } = {}) {
  if(collectionLoadInFlight){
    if(!force)return collectionLoadInFlight;
    collectionLoadGeneration+=1;
    collectionLoadAbortController?.abort();
    try{await collectionLoadInFlight;}catch{}
  }
  const generation=++collectionLoadGeneration;
  const controller=new AbortController();
  collectionLoadAbortController=controller;
  const request=(async()=>{
    const [mine, team] = await Promise.all([api.myCollection({signal:controller.signal}), api.teamCollection({signal:controller.signal})]);
    if(generation!==collectionLoadGeneration)return state.collection;
    state.collection = {
      mine:(mine || []).map(mapCollectionItem),
      team:(team || []).map(mapCollectionItem),
      syncedAt:new Date().toISOString()
    };
    syncLoanImagesFromCollection();
    collectionError = '';
    prefetchCollectionCardTypes();
    return state.collection;
  })();
  collectionLoadInFlight=request;
  try{return await request;}
  catch(error){if(generation===collectionLoadGeneration&&!controller.signal.aborted)collectionError=error.message||'Raccolta non disponibile';throw error;}
  finally{if(collectionLoadInFlight===request)collectionLoadInFlight=null;if(collectionLoadAbortController===controller)collectionLoadAbortController=null;}
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
    marketWatch.load(),
    loadCollectionShareRequests(),
    // stats.load() (progression/avatar/statistiche) è quasi sempre il più
    // veloce dei sei, ma restava invisibile fino al completamento anche del
    // più lento (Raccolta/Market Watch) perché nessuno ridisegnava finché
    // TUTTO Promise.allSettled non si risolveva. Ridisegna appena i SUOI
    // dati sono pronti, senza aspettare gli altri.
    stats.load().then(() => render())
  ]);
  if (collectionResult.status === 'rejected') collectionError = collectionResult.reason?.message || 'Raccolta non disponibile';
  if (loansResult.status === 'rejected') cloudError = loansResult.reason?.message || 'Sincronizzazione non riuscita';
  else cloudError = '';
  syncLoanImagesFromCollection();
  // Una sola pianificazione per l'intera sessione (vedi catalogRepairBootstrapped
  // sopra): loadPrimaryData() viene richiamata da più punti (login, sessione
  // ripristinata, ogni evento online/offline, retry manuale) e non deve far
  // ripartire scheduleCatalogRepairs() a ogni chiamata.
  if (collectionResult.status === 'fulfilled' && !catalogRepairBootstrapped) {
    catalogRepairBootstrapped = true;
    scheduleCatalogRepairs();
  }
  return loansResult.status === 'rejected' ? loansResult.reason : null;
}

// enrich_loan_card scrive solo quando card_image è NULL lato server (un
// prestito già arricchito è immutabile via questa RPC per design): chiamarla
// per un prestito che ha già un'immagine persistita è garantito essere un
// no-op, e se la nuova immagine non rispetta il pattern ygoprodeck.com
// diventa comunque un 400 di validazione per nulla. Il correttivo locale
// (loan.image/loan.externalId) resta utile per la resa a schermo anche
// quando non c'è nulla da persistere.
const YGOPRODECK_IMAGE_PATTERN = /^https:\/\/images\.ygoprodeck\.com\//i;
function syncLoanImagesFromCollection() {
  const items = [...state.collection.mine, ...state.collection.team];
  const byId = new Map(items.map(item => [String(item.id), item]));
  state.loans.forEach(loan => {
    const linked = loan.collectionItemId ? byId.get(String(loan.collectionItemId)) : null;
    const item = linked || items.find(candidate => candidate.game === loan.game
      && normalizeIdentityName(candidate.cardName) === normalizeIdentityName(loan.cardName));
    if (!item?.imageUrl) return;
    const persistable = !loan.hasStoredImage;
    const changed = loan.image !== item.imageUrl
      || String(loan.externalId || '') !== String(item.catalogCardId || '');
    loan.image = item.imageUrl;
    loan.externalId = item.catalogCardId || loan.externalId;
    if (changed && persistable && loan.id && loan.externalId && YGOPRODECK_IMAGE_PATTERN.test(item.imageUrl)) {
      loan.hasStoredImage = true;
      void api.enrichLoan(loan.id, {
        id:loan.externalId,
        image:item.imageUrl,
        fullImage:item.imageUrl
      }).catch(error => logCatalogRepairIssue({ stage:'enrich-loan-sync', collectionItemId:loan.id, error }));
    }
  });
}

function normalizeIdentityName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
}

async function quarantineMismatchedCollectionImages() {
  const result = await verifyPendingCollectionCatalog({
    api, resolveCard:resolveStoredCard, log:logCatalogRepairIssue,
    onVerified:(row, repaired, card) => {
      const id = row.collection_item_id || row.collectionItemId || row.id;
      const payload = Array.isArray(repaired) ? repaired[0] : repaired;
      [...state.collection.mine, ...state.collection.team].filter(item => item.id === id).forEach(item => {
        item.printingId = payload?.printing_id || payload?.printingId || item.printingId;
        item.catalogCardId = String(payload?.catalog_card_id || payload?.catalogCardId || card.id);
        item.cardName = payload?.card_name || payload?.cardName || card.name;
        item.imageUrl = payload?.image_url || payload?.imageUrl || card.fullImage || card.image || item.imageUrl;
      });
    }
  });
  return result.verified > 0;
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
  } catch (error) {
    logCatalogRepairIssue({ stage:'catalog-repair-cycle', error });
  } finally {
    catalogRepairRunning = false;
    if (catalogRepairQueued && state.currentUser) scheduleCatalogRepairs();
  }
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
  const normalizedCurrentRarity = normalizeCatalogRarity(item.rarity);
  // printingId/variantId già noti dall'item salvato: la printing corrente
  // resta identificabile con certezza anche se il refetch del catalogo sotto
  // fallisce o non trova più un match esatto per nome (Fase 4 — One Piece
  // salva sempre tramite printing_id, mai per nome/set/rarità).
  const currentPrinting = { printingId:item.printingId || null, variantId:item.variantId || '', setCode:item.setCode, setName:item.setName, rarity:normalizedCurrentRarity || item.rarity };
  const initialCard = { id:item.catalogCardId, name:item.cardName, image:item.imageUrl, fullImage:item.imageUrl, printings:[currentPrinting] };
  collectionEditor = { item, card:initialCard, printing:currentPrinting, setCode:item.setCode };
  selectedCollectionItem = '';
  render();
  const expectedId = item.id;
  let catalog = await findCard(item.cardName, item.game);
  if (!catalog || collectionEditor?.item?.id !== expectedId) return;
  // card_printings (il nostro catalogo, verificato nel tempo da Fast Scan/
  // Market Watch) ha priorità su YGOPRODeck per elencare le rarità/set reali
  // di questa carta: YGOPRODeck resta solo un fallback per printing che il
  // DB non conosce ancora.
  if (item.game === 'yugioh') {
    try {
      const canonicalId = canonicalCatalogCardId(item.catalogCardId || catalog.id, item.game) || String(item.catalogCardId || catalog.id);
      const dbPrintings = await api.lookupPrintingsByCatalogId(canonicalId, item.game);
      if (collectionEditor?.item?.id !== expectedId) return;
      catalog = mergeAuthoritativePrintings(catalog, dbPrintings);
    } catch {}
  }
  const alreadyListed = catalog.printings.some(printing => (currentPrinting.printingId && printing.printingId)
    ? String(printing.printingId) === String(currentPrinting.printingId)
    : (sameCollectionSet(printing.setCode,item.setCode) && sameCollectionRarity(printing.rarity,currentPrinting.rarity)));
  if (!alreadyListed) catalog.printings.unshift(currentPrinting);
  collectionEditor.card = collectionCardWithLocalizedPrintings(catalog, item.language || 'Italiano');
  collectionEditor.printing = selectCollectionEditorPrinting(collectionEditor.card, item.setCode, normalizedCurrentRarity, item.printingId);
  collectionEditor.setCode = collectionEditor.printing?.setCode || item.setCode;
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
      const applyCard = catalogCard => {
        if (!collectionEditor) return;
        collectionEditor.card = collectionCardWithLocalizedPrintings(catalogCard, document.querySelector('#collection-language')?.value || 'Italiano');
        const options = collectionPrintingOptions(collectionEditor.card);
        collectionEditor.setCode = options[0]?.setCode || '';
        const firstSetOptions = options.filter(printing => sameCollectionSet(printing.setCode, collectionEditor.setCode));
        collectionEditor.printing = firstSetOptions.length === 1 ? firstSetOptions[0] : null;
        render();
      };
      applyCard(card);
      // card_printings ha priorità su YGOPRODeck (vedi la stessa nota sopra,
      // riga ~1284): la selezione appare subito coi dati YGOPRODeck, poi si
      // completa con le rarità/set verificati dal DB non appena arrivano.
      if (state.game === 'yugioh') {
        (async () => {
          try {
            const canonicalId = canonicalCatalogCardId(card.id, state.game) || String(card.id);
            const dbPrintings = await api.lookupPrintingsByCatalogId(canonicalId, state.game);
            // Nessun click successivo (stesso o altro risultato) deve essere
            // sovrascritto da un merge in arrivo in ritardo.
            if (!collectionEditor || collectionEditor.card?.id !== card.id) return;
            applyCard(mergeAuthoritativePrintings(card, dbPrintings));
          } catch {}
        })();
      }
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
  const printing = collectionEditor.printing;
  if (!printing) return toast('Seleziona esplicitamente la rarità della printing');
  const language = document.querySelector('#collection-language').value;
  const condition = document.querySelector('#collection-condition').value;
  const editionInput = document.querySelector('#collection-first-edition');
  const firstEdition = Boolean(editionInput?.checked);
  const edition = editionFromFirstEditionFlag({
    checked:firstEdition,
    touched:editionInput?.dataset.editionTouched === 'true',
    original:editionInput?.dataset.editionOriginal ?? collectionEditor.item?.edition ?? ''
  });
  const item = collectionEditor.item;
  const printingChanged = Boolean(item) && (!sameCollectionSet(item.setCode, printing.setCode) || !sameCollectionRarity(item.rarity, printing.rarity));
  const editionChanged = Boolean(item) && item.edition !== edition;
  if ((!item || printingChanged) && !setCodeMatchesLanguage(printing.setCode, language)) {
    return toast(`Il codice ${printing.setCode} non è coerente con la lingua ${language}`);
  }
  if ((printingChanged || editionChanged) && (quantityOwned !== item.quantityOwned || language !== item.language || condition !== item.condition)) {
    return toast('Per sicurezza, salva quantità, lingua o condizione separatamente dalla correzione printing');
  }
  if ((printingChanged || editionChanged) && !confirm(`Confermi il collegamento a ${printing.setCode} · ${printing.rarity || 'rarità non specificata'}${edition ? ` · ${edition}` : ''}?`)) return;
  const submit = event.submitter;
  let catalogWarning = '';
  collectionPending = true;
  if (submit) { submit.disabled = true; submit.textContent = 'Salvataggio…'; }
  setCollectionSaveStatus('loading', 'Salvataggio e verifica sul database…');
  try {
    const reconciliation = await reconcileCatalogCard({ game:state.game, catalogCardId:card.id, cardName:card.name,
      setCode:printing.setCode || '', rarity:printing.rarity || '', imageUrl:card.fullImage || card.image || '' });
    if (reconciliation.status === 'mismatch') throw new Error(`Dati catalogo incoerenti: ${reconciliation.issues.join('. ')}`);
    if (state.game === 'yugioh' && (printing.setCode || printing.rarity) && !reconciliation.printing) {
      throw new Error('La combinazione set e rarità non è presente nel catalogo verificato');
    }
    if (reconciliation.status === 'warning') catalogWarning = reconciliation.issues.join('. ');
    let savedResult;
    // La correzione printing "legacy" ricostruisce la riga per nome/set/
    // rarità: va bene per Yu-Gi-Oh (dove il catalog-verification esiste
    // apposta), ma per One Piece rischierebbe di fondere regular e parallel
    // che condividono set_code/rarity. One Piece passa sempre da
    // saveCollection con il printingId già risolto, anche per un cambio
    // printing su un item esistente.
    if (item && (printingChanged || editionChanged) && state.game === 'yugioh') {
      savedResult = await api.correctCollectionPrinting({
        collectionItemId:item.id, catalogCardId:card.id, cardName:card.name,
        setCode:printing.setCode || '', setName:printing.setName || '', rarity:printing.rarity || '',
        imageUrl:card.fullImage || card.image || '', edition, verificationVersion:1
      });
    } else {
      savedResult = await api.saveCollection({
        id:item?.id || null, game:state.game, catalogCardId:card.id,
        cardName:card.name, setCode:printing.setCode || '', setName:printing.setName || '',
        rarity:printing.rarity || '', language, condition, edition,
        imageUrl:card.fullImage || card.image || '', quantityOwned,
        printingId:printing.printingId || null
      });
    }
    const savedRow = Array.isArray(savedResult) ? savedResult[0] : savedResult;
    const savedId = item?.id || (typeof savedResult === 'string' ? savedResult : savedRow?.collection_item_id || savedRow?.id);
    await loadCollection({ force:true });
    const persisted = state.collection.mine.find(entry => entry.id === savedId);
    assertPersistedCollectionItem(persisted, {
      id:savedId, printingId:savedRow?.printing_id || '', setCode:printing.setCode || '', setName:printing.setName || '', rarity:printing.rarity || '',
      language, condition, edition, quantityOwned
    });
    saveState();
    setCollectionSaveStatus('success', 'Salvataggio verificato sul database.');
    collectionEditor = null; render(); toast(catalogWarning ? `Raccolta aggiornata · verifica: ${catalogWarning}` : 'Raccolta aggiornata e verificata');
  } catch (error) { setCollectionSaveStatus('error', error.message || 'Salvataggio non riuscito'); toast(error.message || 'Salvataggio non riuscito'); }
  finally { collectionPending = false; if (submit?.isConnected) { submit.disabled = false; submit.textContent = 'Salva nella raccolta'; } }
}

function setCollectionSaveStatus(stateName, message) {
  const status = document.querySelector('#collection-save-status');
  if (!status) return;
  status.hidden = false;
  status.className = `collection-save-status ${stateName}`;
  status.textContent = message;
}

function assertPersistedCollectionItem(item, expected) {
  if (!item?.printingId) throw new Error('Salvataggio non confermato dal database');
  if (!persistedCollectionItemMatches(item, expected)) throw new Error('Il database ha restituito dettagli diversi da quelli salvati');
  return item;
}

function sameCollectionSet(left, right) { return String(left || '').trim().toUpperCase() === String(right || '').trim().toUpperCase(); }
function sameCollectionRarity(left, right) { return String(left || '').trim().toLocaleLowerCase('it') === String(right || '').trim().toLocaleLowerCase('it'); }

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
  loanBuilderStep = 2; // la carta è già scelta: si parte dal destinatario
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
    await api.requestCollectionLoan(item.id, quantity, notes, false, crypto.randomUUID());
    await Promise.all([loadCloudLoans(), loadCollection()]);
    collectionLoanRequest = null; saveState(); render(); toast('Richiesta inviata al proprietario');
  } catch (error) { toast(error.message || 'Richiesta non riuscita'); if (submit?.isConnected) submit.disabled = false; }
}

let memberProfiles = new Map();
async function loadMembers() {
  const [items, profiles] = await Promise.all([api.members(), api.memberProfiles().catch(() => [])]);
  state.members = items;
  setMembers(items);
  memberProfiles = new Map(profiles.map(row => [row.member_slug, { activeAvatar:row.active_avatar || '', activeTitle:row.active_title || '', level:row.level || 1 }]));
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
    state.canVerifyYgoArtwork = Boolean(profile.canVerifyYgoArtwork);
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
  state.currentUser = null; state.role = null; state.canVerifyYgoArtwork = false; state.loans = []; state.collection = { mine:[], team:[], syncedAt:null }; state.decks=[]; catalogRepairBootstrapped = false; saveState(); page = 'home'; history.replaceState(null, '', '#/home'); render();
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
  if (source) realtimeSyncSources.add(source);
  clearTimeout(realtimeSyncTimer);
  realtimeSyncTimer = setTimeout(() => runRealtimeSync(), 250);
}

async function runRealtimeSync() {
  if (realtimeSyncRunning) return;
  realtimeSyncRunning = true;
  const sources=new Set(realtimeSyncSources);
  realtimeSyncSources.clear();
  const before = actionableIds();
  try {
    if (!sources.has('loans')) await loadCollection();
    else await Promise.allSettled([loadCloudLoans(),loadCollection()]);
    saveState();
    const added = [...actionableIds()].filter(id => !before.has(id));
    if (added.length) await showLoanNotification(added.length);
    const editing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
    if (!editing) renderRoute();
  } catch {} finally {
    realtimeSyncRunning = false;
    if (realtimeSyncSources.size) scheduleRealtimeSync();
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
  if(loansLoadInFlight)return loansLoadInFlight;
  const request=fetchCloudLoans();
  loansLoadInFlight=request;
  try{return await request;}finally{if(loansLoadInFlight===request)loansLoadInFlight=null;}
}

async function fetchCloudLoans() {
  const data = await api.loans();
  state.loans = data.map(l => {
    const game = l.game || 'yugioh';
    const externalId = l.card_external_id;
    const storedImage = normalizeCardImageUrl(l.card_image);
    const acceptedQuantity = l.accepted_quantity ?? (l.status === 'requested' ? 0 : l.quantity);
    return { id:l.id, cardName:l.card_name, quantity:l.quantity, requestedQuantity:l.requested_quantity || l.quantity, acceptedQuantity, remainingQuantity:Math.max(acceptedQuantity - (l.returned_quantity || 0), 0), owner:l.owner_slug, borrower:l.borrower_slug, notes:l.notes, status:l.status, createdAt:l.created_at, returnedAt:l.returned_at, image:game === 'yugioh' ? (storedImage || canonicalYgoCardImage(externalId)) : storedImage,
      // enrich_loan_card scrive solo quando card_image è NULL lato DB: questo
      // flag riflette lo storage reale, non il fallback calcolato sopra
      // (canonicalYgoCardImage), così il repair sa quando la RPC può davvero
      // avere effetto invece di essere un no-op garantito.
      hasStoredImage:Boolean(storedImage),
      externalId, collectionItemId:l.collection_item_id || '', game, returnedQuantity:l.returned_quantity || 0, pendingReturnQuantity:l.pending_return_quantity || 0, requestOrigin:l.request_origin || 'legacy', setCode:l.card_set_code || '', setName:l.card_set_name || '', rarity:l.card_rarity || '', preAgreed:l.pre_agreed || false };
  });
  cloudError = '';
  void enrichMissingImages();
}

async function quarantineMismatchedLoanImages() {
  // Un prestito con card_image già persistita non può essere corretto da
  // enrich_loan_card (no-op garantito lato RPC, vedi syncLoanImagesFromCollection):
  // limitare la coda ai soli "dato mancante" evita chiamate scritte che
  // falliscono per validazione (400) senza alcuna possibilità di successo,
  // solo perché catalogImageNeedsRepair considera l'immagine "sospetta".
  const candidates = state.loans.filter(loan => loan.game === 'yugioh' && loan.cardName
    && !loan.hasStoredImage && catalogImageNeedsRepair(loan.externalId, loan.image, loan.game));
  let changed = false;
  await runLimited(candidates, 4, async loan => {
    const card = await resolveStoredCard({ id:loan.externalId, name:loan.cardName }, loan.game);
    if (!card) return;
    const correctImage = card.fullImage || card.image || '';
    const idMismatch = String(card.id) !== String(loan.externalId || '');
    const imageMismatch = cardImageMatches(card, loan.image) === false || (!loan.image && correctImage);
    if (!idMismatch && !imageMismatch) return;
    if (!YGOPRODECK_IMAGE_PATTERN.test(correctImage)) return;
    loan.image = correctImage;
    loan.externalId = String(card.id);
    loan.imageMismatch = true;
    loan.hasStoredImage = true;
    changed = true;
    void api.enrichLoan(loan.id, card).catch(error => logCatalogRepairIssue({ stage:'enrich-loan-quarantine', collectionItemId:loan.id, error }));
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
      const results = await Promise.allSettled(draftCards.map(card => api.requestCollectionLoan(card.collectionItemId, card.quantity, notes, false, crypto.randomUUID())));
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
    loanSearchResults = []; loanSearchStatus = 'idle'; loanBuilderStep = 1;
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
  // Il riepilogo (passo 3) non è a schermo mentre si cerca (passo 1): la
  // carta vola verso il pallino dello step "Riepilogo" invece che verso la
  // riga .draft-card, visibile solo quando quel passo è quello attivo.
  const target = [...document.querySelectorAll('[data-draft-key]')].find(item => item.dataset.draftKey === key);
  const targetVisual = target?.querySelector('img, .draft-placeholder') || document.querySelector('.loan-step-node[data-loan-step="3"] b');
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
  target?.classList.add('loan-card-arrived');
  setTimeout(() => target?.classList.remove('loan-card-arrived'), 720);
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
  loanBuilderStep = 1;
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
    // Le due liste sono indipendenti (nessuna delle due usa l'output
    // dell'altra): eseguirle in parallelo invece che in sequenza dimezza
    // l'attesa percepita dopo ogni azione sul prestito, senza cambiare la
    // gestione errori — un fallimento di loadCollection resta silenzioso
    // come prima, uno di loadCloudLoans va comunque al catch esterno.
    await Promise.all([loadCloudLoans(), loadCollection().catch(() => {})]);
    saveState(); selectedLoanId = ''; render(); toast('Prestito aggiornato');
  } catch (error) { toast(error.message); }
}

async function startGuestShare(shareId) {
  if (guestShare?.shareId === shareId) { renderGuestShare(); return; }
  guestShare?.dispose();
  document.body.dataset.page = 'share';
  guestShare = new CollectionShareController({ api, shareId, onRender:renderGuestShare, onToast:toast });
  renderGuestShare();
  await guestShare.load();
}
function renderGuestShare() {
  if (!guestShare || location.hash.match(SHARE_HASH)?.[1] !== guestShare.shareId) return;
  document.body.dataset.page = 'share';
  document.body.dataset.game = guestShare.data?.game || 'yugioh';
  // The focused field (e.g. the search box) has to be read BEFORE innerHTML
  // wipes it out — by the time bind() runs afterward, document.activeElement
  // has already reverted to <body>, so restoring focus there is always too late.
  const active = document.activeElement;
  const focusedAttr = ['data-share-query', 'data-share-name'].find(attr => active?.hasAttribute?.(attr));
  const focusedPos = focusedAttr ? active.selectionStart : null;
  document.querySelector('#app').innerHTML = guestShare.view();
  guestShare.bind(document);
  if (focusedAttr) {
    const field = document.querySelector(`[${focusedAttr}]`);
    if (field) { field.focus(); if (focusedPos != null) field.setSelectionRange(focusedPos, focusedPos); }
  }
}

async function start() {
  // A share link has no session at all — never let it fall into the normal
  // login-gated boot below, which would otherwise show a login screen to
  // someone who was never meant to need an account.
  const shareMatch = location.hash.match(SHARE_HASH);
  if (shareMatch) { await startGuestShare(shareMatch[1]); return; }
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
  render();
  try { await loadMembers(); render(); } catch {}
  if (state.currentUser) {
    try {
      const syncError = await loadPrimaryData();
      if (syncError && /Sessione scaduta/i.test(syncError.message || '')) throw syncError;
      startRealtime(); saveState();
    }
    catch (error) {
      if (/Sessione scaduta/i.test(error.message || '')) { state.currentUser = null; state.role = null; state.canVerifyYgoArtwork = false; state.loans = []; catalogRepairBootstrapped = false; saveState(); }
      else cloudError = online() ? (error.message || 'Sincronizzazione non riuscita') : '';
    } finally { appLoading = false; }
  }
  void registerAutoUpdates();
  render();
}
start();
window.addEventListener('hashchange', () => {
  const shareMatch = location.hash.match(SHARE_HASH);
  if (shareMatch) { void startGuestShare(shareMatch[1]); return; }
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
  dispatchPageEnterRefresh(previous, page);
});
// Il dettaglio carta della Raccolta pusha una entry di history senza cambiare
// hash (vedi openCollectionDetail): quando la si "pop-a" all'indietro, l'hash
// resta #/collection quindi non scatta "hashchange" sopra, solo "popstate".
// Chiude solo il dettaglio: non torna mai alla pagina precedente (Home).
window.addEventListener('popstate', event => {
  if (selectedCollectionItem && !(event.state && event.state.collectionDetail === selectedCollectionItem)) {
    selectedCollectionItem = '';
    render();
  }
});
// Niente più mega-refresh ogni 2 minuti (ricaricava tutti e 6 i domini +
// render completo, anche a schermo spento/app in background — una causa
// comune di surriscaldamento/consumo batteria per una PWA "aperta" ma non
// in primo piano). Al ritorno in foreground riconciliamo solo collection e
// loans: sono gli unici due domini con un canale Realtime (vedi
// startRealtime più sotto), ma quel canale è un broadcast Supabase
// (fire-and-forget) — un evento arrivato mentre il socket era sospeso in
// background va perso per sempre e non viene ri-consegnato alla
// riconnessione, quindi questa riconciliazione mirata resta necessaria per
// correttezza. Le altre pagine (market/decks/stats/requests) si aggiornano
// da sole quando l'utente le apre (vedi dispatchPageEnterRefresh).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.currentUser && !SHARE_HASH.test(location.hash)) scheduleRealtimeSync('loans');
});

// Fallback leggero SOLO per i domini senza copertura Realtime (market/decks/
// stats squadra), e SOLO per la pagina che l'utente ha davvero aperta in quel
// momento — non loadPrimaryData() travestito da polling più raro (sarebbe
// lo stesso problema, solo più raro): niente loans/collection (coperti da
// Realtime + riconciliazione al foreground), niente "Io" in Stats (si
// aggiorna da sé dopo ogni match registrato), niente altre pagine.
setInterval(() => {
  if (document.hidden || !state.currentUser || SHARE_HASH.test(location.hash)) return;
  if (page === 'market') void marketWatch.load();
  // Decks non ha (ancora) un aggiornamento mirato come refreshBoardSection()/
  // refreshBody(): un renderRoute() incondizionato qui potrebbe interrompere
  // l'utente a metà modifica di un mazzo (editor aperto, picker, import in
  // corso). Ricarica comunque i dati in background, ma mostra il render solo
  // se si è fermi sulla gallery e non si sta scrivendo da nessuna parte —
  // altrimenti i dati freschi arrivano comunque al prossimo render naturale.
  else if (page === 'decks') void loadDecks().then(() => {
    const editing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
    if (!editing && decks.screen === 'gallery') renderRoute();
  });
  else if (page === 'stats' && stats.scope !== 'mine') void stats.load().then(() => stats.refreshBody());
}, 15 * 60 * 1000);

// Deep link dal tap su una notifica di sistema: sw.js manda un postMessage
// invece di navigare da solo, perché è la pagina già aperta a sapere come
// interpretare la rotta (vedi notificationclick in sw.js).
navigator.serviceWorker?.addEventListener('message', event => {
  if (event.data?.type !== 'fpt-notification-click' || !state.currentUser) return;
  const url = new URL(event.data.url, location.href);
  const target = url.hash.replace(/^#\//, '').split('?')[0] || 'home';
  const params = new URLSearchParams(url.hash.split('?')[1] || '');
  if (target === 'market' && params.get('printingId')) { navigate('market'); marketWatch.selected = params.get('printingId'); render(true); }
  else navigate(target);
});
