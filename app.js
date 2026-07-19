import { MEMBERS, GAMES, state, saveState, setMembers, member, initials, esc, formatDate } from './js/core.js';
import { api } from './js/api.js';
import { searchCards, findCard } from './js/cards.js';
import { icon } from './js/icons.js';
import { dashboardView } from './js/dashboard.js';
import { enablePushNotifications, pushSupported, pushConfigured } from './js/push.js';
import { initEasterEgg, triggerRickrollVideo } from './js/easter-egg.js';
import { registerAutoUpdates } from './js/pwa-update.js';
import { watchConnectivity, online } from './js/connectivity.js';
import { prepareUi, paintWithTransition, animateInterface } from './js/ui-motion.js';

let page = 'home';
let loanFilters = { direction: 'all', member: 'all', query: '', status: 'all' };
let draftCards = [];
let cardSearchTimer;
let enrichingImages = false;
let gameMenuOpen = false;
let secretTaps = 0;
let secretTapTimer;
let appLoading = false;
let cloudError = '';
let loginPending = false;
let loginDraft = { member:'', pin:'' };
const unresolvedCards = new Set();
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2200); }

function render() {
  if (!state.currentUser) {
    const memberField = document.querySelector('#member');
    const pinField = document.querySelector('#pin');
    if (memberField) loginDraft.member = memberField.value;
    if (pinField) loginDraft.pin = pinField.value;
  }
  const ui = prepareUi(state.game || 'yugioh', page, Boolean(state.currentUser));
  paintWithTransition(ui, () => {
    document.querySelector('#app').innerHTML = state.currentUser ? appView() : loginView();
    bind();
    requestAnimationFrame(() => animateInterface(ui));
  });
}

function loginView() {
  return `<main class="shell"><section class="login">
    <div class="brand"><img src="icon-512.png" alt="Logo F.P.T Cards"><div><h1>F.P.T Cards</h1><p>Le carte del team, sempre sotto controllo</p></div></div>
    <div class="card"><h2>Accedi</h2><p class="muted">Seleziona il tuo profilo. Al primo accesso creerai un PIN personale.</p>
      <form id="login-form"><label for="member">Membro del team</label><select id="member" required><option value="">Seleziona il tuo nome</option>${MEMBERS.map(m => `<option value="${m.id}" ${m.id === loginDraft.member ? 'selected' : ''}>${m.name}</option>`).join('')}</select>
      <label for="pin">PIN di 4 cifre</label><input id="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" value="${esc(loginDraft.pin)}" placeholder="••••" required>
      <button class="btn wide" type="submit" ${loginPending ? 'disabled' : ''}>${loginPending ? 'Accesso…' : 'Continua'}</button></form>
    </div><p class="notice">${api.configured ? 'PIN protetto e sincronizzazione del team attivi.' : 'Supabase non configurato.'}</p>
  </section></main>`;
}

function loginLoadingView() {
  return `<main class="shell"><section class="login">
    <div class="brand"><img src="icon-512.png" alt="Logo F.P.T Cards"><div><h1>F.P.T Cards</h1><p>Le carte del team, sempre sotto controllo</p></div></div>
    <div class="card login-loading"><div class="skeleton line"></div><div class="skeleton line"></div><div class="skeleton line"></div></div>
  </section></main>`;
}

function appView() {
  const u = member(state.currentUser) || { id:state.currentUser, name:'Membro F.P.T' };
  const game = GAMES[state.game];
  const notifications = state.loans.filter(l => l.game === state.game && ((l.borrower === state.currentUser && l.status === 'pending') || (l.owner === state.currentUser && l.status === 'return_pending'))).length;
  return `<main class="shell"><header class="topbar"><button class="menu-trigger" id="game-menu-trigger" aria-label="Scegli gioco" aria-expanded="${gameMenuOpen}">${icon('menu')}</button><div class="user"><div class="avatar member-${u.id}">${initials(u.name)}</div><div><strong>${u.name}</strong><small>${game.short} · F.P.T Team</small></div></div><button class="btn secondary small" id="logout">Esci</button></header>
    ${!online() ? '<div class="connection-banner offline">Sei offline · mostro gli ultimi dati salvati</div>' : cloudError ? `<div class="connection-banner error">${esc(cloudError)} <button id="retry-cloud">Riprova</button></div>` : ''}
    <div class="menu-backdrop ${gameMenuOpen ? 'open' : ''}" id="menu-backdrop"></div>
    <aside class="game-menu ${gameMenuOpen ? 'open' : ''}" aria-hidden="${!gameMenuOpen}" aria-label="Seleziona gioco"><div class="game-menu-head"><div><small>F.P.T Cards</small><h2>Cambia gioco</h2></div><button id="game-menu-close" aria-label="Chiudi">×</button></div><div class="game-options">${Object.values(GAMES).map(g => `<button data-game="${g.id}" class="${state.game === g.id ? 'active' : ''}"><span class="game-mark ${g.id}">${g.mark}</span><span><strong>${g.name}</strong><small>${state.game === g.id ? 'Sezione attiva' : 'Passa a questa sezione'}</small></span><b>${state.game === g.id ? '✓' : '›'}</b></button>`).join('')}</div></aside>
    <section class="page-stage" aria-live="polite">${pageContent()}</section>
    ${page !== 'new' ? `<button class="fab" data-page="new" aria-label="Nuovo prestito">${icon('plus')}</button>` : ''}
    <nav class="nav">${[['home','home','Home'],['new','plus','Presta'],['loans','swap','Prestiti'],['team','team','Team']].map(([id,iconName,label]) => `<button data-page="${id}" class="${page === id ? 'active' : ''}"><span>${icon(iconName)}${id === 'loans' && notifications ? `<i>${notifications}</i>` : ''}</span>${label}</button>`).join('')}</nav>
  </main>`;
}

function pageContent() {
  if (appLoading) return loadingView();
  if (page === 'new') return newLoanView();
  if (page === 'loans') return loansView();
  if (page === 'team') return teamView();
  return dashboardView(state, state.game);
}

function loadingView() {
  return `<section class="loading-view" aria-label="Caricamento"><div class="skeleton hero"></div><div class="skeleton line"></div><div class="skeleton grid"></div></section>`;
}

function newLoanView() {
  const recipients = MEMBERS;
  const game = GAMES[state.game];
  const hint = state.game === 'yugioh' ? 'Nome italiano o inglese...' : 'Nome inglese o codice carta...';
  return `<div class="section-heading"><div><h2>Nuovo prestito</h2><p>${game.name}</p></div><span class="game-pill ${state.game}">${game.mark}</span></div><div class="card"><form id="loan-form"><label for="card-name">Cerca nel catalogo ${game.short}</label><div class="catalog-search"><input id="card-name" autocomplete="off" placeholder="${hint}"><div id="card-suggestions" class="suggestions"></div></div>
    <div class="add-manual"><input id="quantity" aria-label="Quantità" type="number" min="1" max="99" value="1"><button type="button" class="btn secondary" id="add-manual-card">Aggiungi</button></div>
    <div class="draft-list">${draftCards.length ? draftCards.map((c, i) => `<div class="draft-card">${c.image ? `<img src="${c.image}" alt="">` : '<span class="draft-placeholder">▧</span>'}<div><strong>${esc(c.name)}</strong><small>${c.quantity} copie</small></div><button type="button" data-remove-card="${i}" aria-label="Rimuovi">×</button></div>`).join('') : '<p>Nessuna carta aggiunta</p>'}</div>
    <label for="borrower">A chi la stai dando?</label><select id="borrower" required><option value="">Seleziona un membro</option>${recipients.map(m => `<option value="${m.id}">${m.name}${m.id === state.currentUser ? ' (tu)' : ''}</option>`).join('')}</select>
    <label for="notes">Note facoltative</label><textarea id="notes" rows="3" placeholder="Edizione, rarità, condizioni..."></textarea><button class="btn wide" type="submit" ${draftCards.length ? '' : 'disabled'}>Invia ${draftCards.length || ''} ${draftCards.length === 1 ? 'carta' : 'carte'}</button></form></div>
    <p class="notice">Il destinatario dovrà accettare prima che il prestito risulti attivo.</p>`;
}

function loansView() {
  const base = loanBase();
  const relevant = filteredLoans();
  const others = MEMBERS.filter(m => m.id !== state.currentUser);
  return `<div class="section-heading"><div><h2>Prestiti</h2><p>${GAMES[state.game].name}</p></div><span class="total-pill">${base.length} totali</span></div>
    <section class="card loan-manager">
      <div class="loan-toolbar"><div class="search-field"><span aria-hidden="true">${icon('search')}</span><input id="loan-query" aria-label="Cerca carta" value="${esc(loanFilters.query)}" placeholder="Cerca una carta..."></div>
      <div class="filter-grid"><div><label for="loan-direction">Movimento</label><select id="loan-direction">
        <option value="all" ${loanFilters.direction === 'all' ? 'selected' : ''}>Tutti</option>
        <option value="received" ${loanFilters.direction === 'received' ? 'selected' : ''}>Ricevute da</option>
        <option value="lent" ${loanFilters.direction === 'lent' ? 'selected' : ''}>Prestate a</option>
      </select></div><div><label for="loan-member">Membro</label><select id="loan-member">
        <option value="all">Tutti i membri</option>${others.map(m => `<option value="${m.id}" ${loanFilters.member === m.id ? 'selected' : ''}>${m.name}</option>`).join('')}
      </select></div></div></div>
      <div class="filter-chips">${[['all','Tutti'],['attention','Da gestire'],['active','Attivi'],['returned','Restituiti']].map(([id,label]) => `<button class="chip ${loanFilters.status === id ? 'active' : ''}" data-status-filter="${id}">${label}</button>`).join('')}</div>
      <div class="list-summary"><span id="loan-result-count"><strong>${relevant.length}</strong> ${relevant.length === 1 ? 'risultato' : 'risultati'}</span><button class="clear-filters ${loanFilters.direction === 'all' && loanFilters.member === 'all' && loanFilters.status === 'all' && !loanFilters.query ? 'hidden' : ''}" id="clear-filters">Azzera filtri</button></div>
      <div class="loan-list">${loanRowsHtml(relevant)}</div>
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
    const statusOk = loanFilters.status === 'all' || (loanFilters.status === 'attention' ? ['pending','return_pending'].includes(l.status) : l.status === loanFilters.status);
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
  const remaining = Math.max(0, l.quantity - (l.returnedQuantity || 0));
  if (l.status === 'pending' && !outgoing) buttons = `<button class="btn small" data-action="accept" data-id="${l.id}">Accetta</button><button class="btn secondary danger small" data-action="reject" data-id="${l.id}">Rifiuta</button>`;
  if (l.status === 'active' && !outgoing) buttons = `<div class="partial-return"><input type="number" min="1" max="${remaining}" value="${remaining}" data-return-qty="${l.id}" aria-label="Quantità da restituire"><button class="btn secondary small" data-action="return" data-id="${l.id}">Restituisci</button></div>`;
  if (l.status === 'return_pending' && outgoing) buttons = `<button class="btn small" data-action="confirm-return" data-id="${l.id}">Conferma ${l.pendingReturnQuantity || remaining} pz</button>`;
  if (isAdmin && !buttons) buttons = `<button class="btn secondary danger small" data-action="admin-delete" data-id="${l.id}">Elimina</button>`;
  const shownQuantity = l.status === 'returned' ? l.quantity : remaining;
  const visual = l.image ? `<div class="loan-thumb"><img src="${l.image}" alt=""><em>${shownQuantity}</em></div>` : `<div class="loan-qty">${shownQuantity}<small>pz</small></div>`;
  const memberMarker = person ? `<i class="member-dot ${person.id}"></i>` : '';
  return `<details class="loan-row ${presentation.kind}"><summary>${visual}<div class="loan-main"><strong>${esc(l.cardName)}</strong><span class="direction-line"><b class="direction-tag ${presentation.kind}">${presentation.direction}</b> ${memberMarker}${presentation.person}</span><small class="next-action ${presentation.urgent ? 'urgent' : ''}">${presentation.action}</small></div><span class="badge ${presentation.badgeClass}">${presentation.shortStatus}</span></summary><div class="loan-detail"><div class="ownership"><span><small>Proprietario</small><b>${owner.name}</b></span><span>→</span><span><small>Consegnata a</small><b>${borrower.name}</b></span></div><span>Registrato il ${formatDate(l.createdAt)}</span>${l.notes ? `<p>${esc(l.notes)}</p>` : '<p>Nessuna nota</p>'}${buttons ? `<div class="actions loan-actions">${buttons}</div>` : ''}</div></details>`;
}

function loanPresentation(l, outgoing, incoming, owner, borrower) {
  if (outgoing) {
    const states = {
      pending: ['Attendi che il destinatario accetti', 'In attesa', 'wait', false],
      active: ['La carta deve tornare a te', 'Da ricevere', 'outgoing', false],
      return_pending: ['Conferma di aver ricevuto la carta', 'Conferma resa', 'wait', true],
      returned: ['La carta è tornata a te', 'Restituita', 'ok', false]
    };
    const [action, shortStatus, badgeClass, urgent] = states[l.status];
    return { direction:'HAI PRESTATO A', person:borrower.name, action, shortStatus, badgeClass, urgent, kind:'outgoing' };
  }
  if (incoming) {
    const states = {
      pending: ['Devi accettare la consegna', 'Devi accettare', 'wait', true],
      active: ['Devi restituire questa carta', 'Da restituire', 'incoming', true],
      return_pending: ['Attendi la conferma del proprietario', 'In conferma', 'wait', false],
      returned: ['Hai restituito questa carta', 'Restituita', 'ok', false]
    };
    const [action, shortStatus, badgeClass, urgent] = states[l.status];
    return { direction:'HAI RICEVUTO DA', person:owner.name, action, shortStatus, badgeClass, urgent, kind:'incoming' };
  }
  return { direction:'SCAMBIO DEL TEAM', person:`${owner.name} → ${borrower.name}`, action:statusLabel(l.status), shortStatus:statusLabel(l.status), badgeClass:l.status === 'returned' ? 'ok' : 'team', urgent:false, kind:'team' };
}

function statusLabel(status) { return ({pending:'In attesa', active:'In prestito', return_pending:'Resa da confermare', returned:'Restituita'})[status]; }
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
  document.querySelector('#member')?.addEventListener('change', event => { loginDraft.member = event.target.value; });
  document.querySelector('#pin')?.addEventListener('input', event => { loginDraft.pin = event.target.value.replace(/\D/g, '').slice(0, 4); event.target.value = loginDraft.pin; });
  document.querySelector('#logout')?.addEventListener('click', logout);
  document.querySelector('#game-menu-trigger')?.addEventListener('click', () => { gameMenuOpen = !gameMenuOpen; render(); });
  document.querySelector('#game-menu-close')?.addEventListener('click', closeGameMenu);
  document.querySelector('#menu-backdrop')?.addEventListener('click', closeGameMenu);
  document.querySelectorAll('[data-game]').forEach(b => b.addEventListener('click', () => selectGame(b.dataset.game)));
  document.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => { page = b.dataset.page; render(); }));
  document.querySelectorAll('[data-quick]').forEach(b => b.addEventListener('click', () => quickNavigate(b.dataset.quick)));
  document.querySelectorAll('[data-member-shortcut]').forEach(b => b.addEventListener('click', () => { loanFilters.member = b.dataset.memberShortcut; page = 'loans'; render(); }));
  document.querySelector('#loan-form')?.addEventListener('submit', createLoan);
  document.querySelector('#card-name')?.addEventListener('input', onCardSearch);
  document.querySelector('#add-manual-card')?.addEventListener('click', addManualCard);
  document.querySelectorAll('[data-remove-card]').forEach(b => b.addEventListener('click', () => { draftCards.splice(Number(b.dataset.removeCard), 1); render(); }));
  document.querySelectorAll('[data-card-result]').forEach(b => b.addEventListener('click', () => addCatalogCard(b)));
  document.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => updateLoan(b.dataset.id, b.dataset.action)));
  document.querySelector('#loan-direction')?.addEventListener('change', e => { loanFilters.direction = e.target.value; render(); });
  document.querySelector('#loan-member')?.addEventListener('change', e => { loanFilters.member = e.target.value; render(); });
  document.querySelector('#loan-query')?.addEventListener('input', e => { loanFilters.query = e.target.value; refreshLoanRows(); });
  document.querySelectorAll('[data-status-filter]').forEach(b => b.addEventListener('click', () => { loanFilters.status = b.dataset.statusFilter; render(); }));
  document.querySelector('#clear-filters')?.addEventListener('click', () => { loanFilters = { direction: 'all', member: 'all', query: '', status: 'all' }; render(); });
  document.querySelector('#reset-data')?.addEventListener('click', () => toast('I dati condivisi non si cancellano dal dispositivo'));
  document.querySelector('#enable-notifications')?.addEventListener('click', enableNotifications);
  document.querySelector('#member-form')?.addEventListener('submit', addMember);
  document.querySelectorAll('[data-member-action]').forEach(button => button.addEventListener('click', () => manageMember(button.dataset.memberAction, button.dataset.memberId)));
  document.querySelector('#retry-cloud')?.addEventListener('click', retryCloud);
  document.querySelector('[data-rick-secret]')?.addEventListener('click', secretRickroll);
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

function closeGameMenu() { gameMenuOpen = false; render(); }
function selectGame(game) {
  if (!GAMES[game]) return;
  state.game = game; gameMenuOpen = false; page = 'home'; draftCards = [];
  loanFilters = { direction:'all', member:'all', query:'', status:'all' };
  saveState(); render();
}

function refreshLoanRows() {
  const loans = filteredLoans();
  const list = document.querySelector('.loan-list');
  const count = document.querySelector('#loan-result-count');
  const clear = document.querySelector('#clear-filters');
  if (list) list.innerHTML = loanRowsHtml(loans);
  if (count) count.innerHTML = `<strong>${loans.length}</strong> ${loans.length === 1 ? 'risultato' : 'risultati'}`;
  if (clear) clear.classList.toggle('hidden', loanFilters.direction === 'all' && loanFilters.member === 'all' && loanFilters.status === 'all' && !loanFilters.query);
  document.querySelectorAll('.loan-list [data-action]').forEach(b => b.addEventListener('click', () => updateLoan(b.dataset.id, b.dataset.action)));
}

function quickNavigate(target) {
  if (target === 'new') page = 'new';
  else {
    page = 'loans';
    loanFilters.direction = target === 'received' ? 'received' : target === 'lent' ? 'lent' : 'all';
    loanFilters.status = target === 'attention' ? 'attention' : 'all';
  }
  render();
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
  try { await loadMembers(); await loadCloudLoans(); saveState(); }
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
    await loadCloudLoans();
    state.currentUser = profile.slug;
    state.role = profile.role;
    startRealtime();
    loginDraft = { member:'', pin:'' };
    saveState();
  } catch (error) {
    const message = /fetch|network|failed to fetch/i.test(error.message || '')
      ? 'Database non raggiungibile. Controlla che il progetto Supabase sia attivo.'
      : (error.message || 'Accesso non riuscito');
    toast(message);
  } finally {
    loginPending = false;
    render();
  }
}

async function logout() {
  api.unsubscribe();
  await api.logout();
  state.currentUser = null; state.role = null; state.loans = []; saveState(); page = 'home'; render();
}

async function enableNotifications() {
  try {
    await enablePushNotifications();
    toast('Notifiche push attivate'); render();
  } catch (error) { toast(error.message); }
}

function actionableIds() {
  return new Set(state.loans.filter(l =>
    (l.borrower === state.currentUser && l.status === 'pending') ||
    (l.owner === state.currentUser && l.status === 'return_pending')
  ).map(l => l.id));
}

function startRealtime() {
  api.subscribe(async () => {
    const before = actionableIds();
    try {
      await loadCloudLoans(); saveState();
      const added = [...actionableIds()].filter(id => !before.has(id));
      if (added.length) await showLoanNotification(added.length);
      const editing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
      if (!editing) render();
    } catch {}
  });
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
  state.loans = data.map(l => ({ id:l.id, cardName:l.card_name, quantity:l.quantity, owner:l.owner_slug, borrower:l.borrower_slug, notes:l.notes, status:l.status, createdAt:l.created_at, returnedAt:l.returned_at, image:l.card_image, externalId:l.card_external_id, game:l.game || 'yugioh', returnedQuantity:l.returned_quantity || 0, pendingReturnQuantity:l.pending_return_quantity || 0 }));
  cloudError = '';
  void enrichMissingImages();
}

async function createLoan(e) {
  e.preventDefault();
  try {
    const borrower = document.querySelector('#borrower').value;
    if (borrower === state.currentUser) {
      triggerRickrollVideo();
      return toast('Non puoi prestare una carta a te stesso');
    }
    const notes = document.querySelector('#notes').value.trim();
    await api.createMany(draftCards, borrower, notes, state.game);
    draftCards = []; await loadCloudLoans(); saveState(); page = 'loans'; render(); toast('Prestito multiplo registrato');
  } catch (error) { toast(error.message); }
}

async function addManualCard() {
  const input = document.querySelector('#card-name');
  const name = input.value.trim();
  if (!name) return toast('Inserisci il nome della carta');
  const quantity = Number(document.querySelector('#quantity').value) || 1;
  const match = await findCard(name, state.game);
  draftCards.push(match
    ? { id:match.id, name:match.name, quantity, image:match.image }
    : { name, quantity, image:'' });
  render();
}

function addCatalogCard(button) {
  draftCards.push({ id:button.dataset.id, name:button.dataset.name, image:button.dataset.image, quantity:Number(document.querySelector('#quantity').value) || 1 }); render();
}

function onCardSearch(e) {
  clearTimeout(cardSearchTimer);
  const query = e.target.value;
  cardSearchTimer = setTimeout(async () => {
    const box = document.querySelector('#card-suggestions');
    if (!box) return;
    const results = await searchCards(query, state.game);
    box.innerHTML = results.map(c => `<button type="button" data-card-result data-id="${c.id}" data-name="${esc(c.name)}" data-image="${c.image}">${c.image ? `<img src="${c.image}" alt="">` : ''}<span><strong>${esc(c.name)}</strong><small>${esc(c.type)}</small></span></button>`).join('');
    box.querySelectorAll('[data-card-result]').forEach(b => b.addEventListener('click', () => addCatalogCard(b)));
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
      const card = await findCard(loan.cardName, loan.game);
      if (!card?.image) { unresolvedCards.add(`${loan.game}:${loan.cardName.toLowerCase()}`); continue; }
      await api.enrichLoan(loan.id, card);
      loan.image = card.image;
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
    if (action === 'return') {
      const quantity = Number(document.querySelector(`[data-return-qty="${id}"]`)?.value);
      await api.returnQuantity(id, quantity);
    } else await api.transition(id, action);
    await loadCloudLoans(); saveState(); render(); toast('Prestito aggiornato');
  } catch (error) { toast(error.message); }
}

async function start() {
  initEasterEgg();
  watchConnectivity(async connected => {
    if (!state.currentUser) return;
    if (!connected) { render(); return; }
    try { await loadMembers(); await loadCloudLoans(); saveState(); cloudError = ''; }
    catch (error) { cloudError = error.message || 'Sincronizzazione non riuscita'; }
    render();
  });
  if (!state.currentUser) {
    document.body.dataset.game = state.game || 'yugioh';
    document.body.dataset.page = 'login';
    document.querySelector('#app').innerHTML = loginLoadingView();
    await Promise.race([
      loadMembers().catch(() => {}),
      new Promise(resolve => window.setTimeout(resolve, 2500))
    ]);
    render();
    void registerAutoUpdates();
    return;
  }
  appLoading = true;
  render();
  try { await loadMembers(); } catch {}
  if (state.currentUser) {
    appLoading = true; render();
    try { await loadCloudLoans(); startRealtime(); saveState(); }
    catch (error) {
      if (/Sessione scaduta/i.test(error.message || '')) { state.currentUser = null; state.role = null; state.loans = []; saveState(); }
      else cloudError = online() ? (error.message || 'Sincronizzazione non riuscita') : '';
    } finally { appLoading = false; }
  }
  void registerAutoUpdates();
  render();
}
start();
setInterval(async () => {
  if (!state.currentUser) return;
  try {
    await loadCloudLoans(); saveState();
    const editing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
    if (!editing) render();
  } catch {}
}, 30000);
