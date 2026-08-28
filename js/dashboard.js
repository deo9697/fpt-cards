import { member, esc, formatDate } from './core.js';
import { icon } from './icons.js';

export function dashboardView(state, game = 'yugioh') {
  const me = member(state.currentUser);
  const firstName = me?.name?.split(' ')[0] || 'duellante';
  const teamLoans = state.loans.filter(loan => loan.game === game);
  const personal = teamLoans.filter(loan => loan.owner === me?.id || loan.borrower === me?.id);
  const active = personal.filter(loan => !['returned','completed','rejected'].includes(loan.status));
  const attention = personal.filter(loan =>
    (loan.borrower === me?.id && ['pending','reserved'].includes(loan.status)) ||
    (loan.owner === me?.id && ['requested','return_pending'].includes(loan.status))
  );
  const tracked = trackedCards(teamLoans);
  const featured = tracked.find(card => card.image) || null;
  const recent = [...teamLoans].reverse().slice(0, 4);
  const teamActive = [...teamLoans].reverse().filter(loan => !['returned','completed','rejected'].includes(loan.status)).slice(0, 4);
  const activeMembers = new Set(teamLoans.flatMap(loan => [loan.owner, loan.borrower]).filter(Boolean)).size;

  return `<section class="dashboard duel-dashboard page-stack">
    <header class="duel-welcome">
      <span class="eyebrow">${greeting()}</span>
      <h1>Bentornato,<br><strong>${esc(firstName)}!</strong> <span aria-hidden="true">👋</span></h1>
      <p>Il tuo team è pronto per un altro duello.</p>
    </header>

    <section class="stat-grid duel-stat-grid" aria-label="Riepilogo team">
      ${metric(icon('collection'), tracked.length, 'Carte tracciate', 'purple', 'Nello storico del team')}
      ${metric(icon('swap'), active.length, 'Prestiti attivi', 'blue', 'Che ti coinvolgono')}
      ${metric(icon('bell'), attention.length, 'Richieste', 'amber', attention.length ? 'In attesa di una tua azione' : 'Tutto sotto controllo')}
      ${metric(icon('team'), activeMembers, 'Membri attivi', 'green', 'Nello storico corrente')}
    </section>

    <div class="duel-dashboard-main">
      ${featuredPanel(featured)}
      ${loanOverview(teamActive, attention)}
    </div>

    <div class="dashboard-columns duel-dashboard-lower">
      <section class="surface duel-panel activity-panel">
        <div class="section-title"><div><span class="eyebrow">Team log</span><h2>Attività recenti</h2></div><button class="text-action" data-page="loans">Vedi tutte ${icon('arrow')}</button></div>
        ${recent.length ? recent.map(activityRow).join('') : `<div class="inline-empty">${icon('swap')}<div><strong>Nessuna attività</strong><span>I movimenti del team compariranno qui.</span></div></div>`}
      </section>
      <section class="surface duel-panel market-preview">
        <div class="section-title"><div><span class="eyebrow">Roadmap</span><h2>Market Watch</h2></div><button class="text-action" data-page="market">Apri ${icon('arrow')}</button></div>
        <div class="market-signal" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div class="market-placeholder">${icon('chart')}<strong>In attesa dei provider</strong><p>Prezzi e trend appariranno solo quando sarà disponibile una fonte dati reale.</p><button class="btn secondary small" data-page="market">Scopri l’anteprima</button></div>
      </section>
    </div>
  </section>`;
}

function trackedCards(loans) {
  const records = new Map();
  loans.forEach(loan => {
    const key = String(loan.externalId || loan.cardName).toLowerCase();
    if (!records.has(key)) records.set(key, {
      key,
      name: loan.cardName,
      image: loan.image || '',
      externalId: loan.externalId || '',
      loans: [],
      owners: new Set()
    });
    const card = records.get(key);
    card.loans.push(loan);
    card.owners.add(loan.owner);
    if (!card.image && loan.image) card.image = loan.image;
  });
  return [...records.values()];
}

function featuredPanel(card) {
  if (!card) return `<section class="surface duel-panel featured-card-panel featured-empty">
    <div class="section-title"><div><span class="eyebrow">Archivio del team</span><h2>Carta in evidenza</h2></div><button class="text-action" data-page="collection">Vedi raccolta ${icon('arrow')}</button></div>
    <div class="inline-empty">${icon('collection')}<div><strong>La vetrina è pronta</strong><span>La prima carta catalogata con immagine diventerà la protagonista della Home.</span></div></div>
    <button class="btn secondary small" data-page="new">${icon('plus')} Registra un prestito</button>
  </section>`;

  const ownerNames = [...card.owners].map(id => member(id)?.name).filter(Boolean);
  const openLoans = card.loans.filter(loan => !['returned','completed','rejected'].includes(loan.status)).length;
  return `<section class="surface duel-panel featured-card-panel">
    <img class="featured-card-ghost" src="${esc(card.image)}" alt="" aria-hidden="true">
    <div class="section-title"><div><span class="eyebrow">Archivio del team</span><h2>Carta in evidenza</h2></div><button class="text-action" data-page="collection">Vedi raccolta ${icon('arrow')}</button></div>
    <div class="featured-card-content">
      <button class="featured-card-art" data-card-key="${esc(card.key)}" aria-label="Apri ${esc(card.name)}"><img src="${esc(card.image)}" alt="${esc(card.name)}"></button>
      <div class="featured-card-copy">
        <span class="feature-kicker">Carta del team</span>
        <h3>${esc(card.name)}</h3>
        <p>${card.externalId ? `ID catalogo ${esc(card.externalId)}` : 'Carta inserita manualmente'}</p>
        <div class="feature-chips"><span>${card.loans.length} ${card.loans.length === 1 ? 'movimento' : 'movimenti'}</span><span>${openLoans} non conclusi</span></div>
        <p class="feature-owner">${ownerNames.length ? `Nello storico di ${esc(ownerNames.slice(0, 2).join(', '))}` : 'Proprietario non disponibile'}</p>
        <button class="btn secondary small" data-card-key="${esc(card.key)}">Visualizza carta</button>
      </div>
    </div>
  </section>`;
}

function loanOverview(loans, attention) {
  const list = attention.length ? [...attention, ...loans.filter(loan => !attention.includes(loan))].slice(0, 4) : loans;
  return `<section class="surface duel-panel loan-overview-panel">
    <div class="section-title"><div><span class="eyebrow">Sala operativa</span><h2>Prestiti del team</h2></div><button class="text-action" data-page="loans">Gestisci ${icon('arrow')}</button></div>
    ${attention.length ? `<div class="duel-alert">${icon('bell')} <span><strong>${attention.length} ${attention.length === 1 ? 'azione richiede' : 'azioni richiedono'} attenzione</strong><small>Apri Prestiti per completarle.</small></span></div>` : ''}
    <div class="loan-overview-list">${list.length ? list.map(loanSnapshot).join('') : `<div class="inline-empty">${icon('swap')}<div><strong>Nessun prestito attivo</strong><span>Il prossimo movimento comparirà qui.</span></div></div>`}</div>
    <button class="btn loan-overview-cta" data-page="new">${icon('plus')} Nuovo prestito</button>
  </section>`;
}

function loanSnapshot(loan) {
  const other = member(loan.borrower)?.name || member(loan.owner)?.name || 'Team';
  const status = { pending:'In attesa', requested:'Richiesta', reserved:'Riservata', active:'Attivo', return_pending:'Da restituire', completed:'Concluso', rejected:'Rifiutato' }[loan.status] || 'Aggiornato';
  return `<button class="loan-snapshot" data-page="loans">
    <span class="loan-snapshot-art">${loan.image ? `<img src="${esc(loan.image)}" alt="" loading="lazy">` : icon('card')}</span>
    <span><strong>${esc(loan.cardName)}</strong><small>${esc(other)} · ${loan.quantity}×</small></span>
    <em class="${loan.status}">${status}</em>
  </button>`;
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Buongiorno' : hour < 18 ? 'Buon pomeriggio' : 'Buonasera';
}

function metric(symbol, value, label, color, detail) {
  return `<article class="stat-card ${color}"><div class="stat-icon">${symbol}</div><div><span>${label}</span><strong>${value}</strong><small>${detail}</small></div></article>`;
}

function activityRow(loan) {
  const owner = member(loan.owner), borrower = member(loan.borrower);
  const labels = { pending:'Prestito richiesto (legacy)', requested:'Nuova richiesta', reserved:'Carta riservata', active:'Prestito attivo', return_pending:'Restituzione richiesta', returned:'Carta restituita', completed:'Prestito concluso', rejected:'Richiesta rifiutata' };
  return `<button class="activity-row" data-page="loans"><span class="activity-icon">${icon(loan.status === 'returned' ? 'card' : 'swap')}</span><span><strong>${labels[loan.status] || 'Prestito aggiornato'}</strong><small>${esc(loan.cardName)} · ${esc(owner?.name || '')} → ${esc(borrower?.name || '')}</small></span><time>${formatDate(loan.createdAt)}</time></button>`;
}
