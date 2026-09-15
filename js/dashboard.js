import { member, esc, formatDate, GAMES } from './core.js';
import { icon } from './icons.js';
import { positiveMovers, negativeMovers, changePercent, tone } from './market-watch.js';

export function dashboardView(state, game = 'yugioh', market = {}) {
  const me = member(state.currentUser);
  const teamLoans = state.loans.filter(loan => loan.game === game);
  const personal = teamLoans.filter(loan => loan.owner === me?.id || loan.borrower === me?.id);
  const active = personal.filter(loan => !['returned','completed','rejected'].includes(loan.status));
  const attention = personal.filter(loan =>
    (loan.borrower === me?.id && ['pending','reserved'].includes(loan.status)) ||
    (loan.owner === me?.id && ['requested','return_pending'].includes(loan.status))
  );
  const tracked = trackedCards(teamLoans);
  const recent = [...teamLoans].reverse().slice(0, 4);
  const teamActive = [...teamLoans].reverse().filter(loan => !['returned','completed','rejected'].includes(loan.status)).slice(0, 4);
  const activeMembers = new Set(teamLoans.flatMap(loan => [loan.owner, loan.borrower]).filter(Boolean)).size;

  return `<section class="dashboard duel-dashboard page-stack">
    <header class="duel-welcome duel-welcome-logo">
      <div class="duel-game-logo"><img src="${GAMES[game].logo}" alt="${esc(GAMES[game].name)}"></div>
      <p>${esc(dashboardTagline(game))}</p>
    </header>

    <section class="stat-grid duel-stat-grid" aria-label="Riepilogo team">
      ${metric(icon('collection'), tracked.length, 'Carte tracciate', 'purple', 'Nello storico del team')}
      ${metric(icon('swap'), active.length, 'Prestiti attivi', 'blue', 'Che ti coinvolgono')}
      ${metric(icon('bell'), attention.length, 'Richieste', 'amber', attention.length ? 'In attesa di una tua azione' : 'Tutto sotto controllo')}
      ${metric(icon('team'), activeMembers, 'Membri attivi', 'green', 'Nello storico corrente')}
    </section>

    <div class="duel-dashboard-main">
      ${featuredPanel(market)}
      ${loanOverview(teamActive, attention)}
    </div>

    <div class="dashboard-columns duel-dashboard-lower activity-only">
      <section class="surface duel-panel activity-panel">
        <div class="section-title"><div><span class="eyebrow">Team log</span><h2>Attività recenti</h2></div><button class="text-action" data-page="loans">Vedi tutte ${icon('arrow')}</button></div>
        ${recent.length ? recent.map(activityRow).join('') : `<div class="inline-empty">${icon('swap')}<div><strong>Nessuna attività</strong><span>I movimenti del team compariranno qui.</span></div></div>`}
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

// Due classifiche leggibili (Top 3 Up / Top 3 Down) al posto del vecchio
// carousel con grafico per riga — niente carousel obbligatorio, righe
// mobile-first, mai un re-render pesante: riusa `market.items`/
// `market.featuredMovers` già caricati per Market Watch, nessuna nuova RPC.
// Le carte in salita usano la RPC list_market_dashboard_movers quando
// disponibile (market.featuredMovers), altrimenti lo stesso fallback
// client-side già esistente; le carte in discesa non hanno una RPC dedicata
// (quella esistente filtra SOLO trend>baseline) e sono quindi SEMPRE
// calcolate lato client con negativeMovers() sugli stessi dati.
function featuredPanel(market) {
  const upMovers = market.featuredMovers?.length ? market.featuredMovers : positiveMovers(market.items, 3);
  const downMovers = negativeMovers(market.items, 3);
  if (!upMovers.length && !downMovers.length) return `<section class="surface duel-panel featured-card-panel featured-empty">
    <div class="section-title"><div><span class="eyebrow">Market Watch</span><h2>Carte in evidenza</h2></div><button class="text-action" data-page="market">Vedi mercato ${icon('arrow')}</button></div>
    <div class="inline-empty">${icon('chart')}<div><strong>Trend in preparazione</strong><span>Le variazioni di prezzo appariranno dopo il secondo snapshot giornaliero.</span></div></div>
  </section>`;
  return `<section class="surface duel-panel featured-card-panel market-movers-panel">
    <div class="section-title"><div><span class="eyebrow">Market Watch</span><h2>Carte in evidenza</h2></div><button class="text-action" data-page="market">Vedi mercato ${icon('arrow')}</button></div>
    <div class="market-movers-lists">
      ${moverGroup('In salita', 'up', upMovers, 'Nessuna carta in crescita al momento.')}
      ${moverGroup('In discesa', 'down', downMovers, 'Nessuna variazione negativa al momento.')}
    </div>
  </section>`;
}
function moverGroup(label, direction, movers, emptyText) {
  return `<div class="market-movers-group ${direction}"><h3>${esc(label)}</h3>${movers.length ? movers.map(moverRow).join('') : `<p class="market-movers-group-empty">${esc(emptyText)}</p>`}</div>`;
}
function moverRow(item) {
  const artwork = moverArtwork(item), change = Number(item.positiveChange), hasPrevious = Number.isFinite(item.price24h);
  return `<button class="market-mover-row" data-page="market" aria-label="Apri ${esc(item.cardName)} nel Market Watch">
    ${artwork ? `<img class="market-mover-row-art" src="${esc(artwork)}" alt="" loading="lazy">` : `<span class="market-mover-row-art market-mover-row-art-placeholder">${icon('card')}</span>`}
    <span class="market-mover-row-body">
      <strong class="market-mover-row-name">${esc(item.cardName)}</strong>
      ${hasPrevious ? `<small class="market-mover-row-history">${marketMoney(item.price24h)} → ${marketMoney(item.referencePrice)}</small>` : ''}
    </span>
    <span class="market-mover-row-price"><b>${marketMoney(item.referencePrice)}</b><small class="${tone(change)}">${changePercent(change)}</small></span>
  </button>`;
}
function moverArtwork(item){const source=String(item.imageUrl||'');if(/\/images\/cards\/\d+\.jpg(?:\?|$)/i.test(source))return source.replace(/\/images\/cards\//i,'/images/cards_cropped/');const id=String(item.catalogCardId||'');return /^\d+$/.test(id)?`https://images.ygoprodeck.com/images/cards_cropped/${id}.jpg`:source;}
function marketMoney(value){return new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR',useGrouping:true}).format(Number(value)||0);}

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

function dashboardTagline(game) {
  return game === 'onepiece' ? 'Il tuo equipaggio è pronto a salpare.' : 'Il tuo team è pronto per un altro duello.';
}

function metric(symbol, value, label, color, detail) {
  return `<article class="stat-card ${color}"><div class="stat-icon">${symbol}</div><div><span>${label}</span><strong>${value}</strong><small>${detail}</small></div></article>`;
}

function activityRow(loan) {
  const owner = member(loan.owner), borrower = member(loan.borrower);
  const labels = { pending:'Prestito richiesto (legacy)', requested:'Nuova richiesta', reserved:'Carta riservata', active:'Prestito attivo', return_pending:'Restituzione richiesta', returned:'Carta restituita', completed:'Prestito concluso', rejected:'Richiesta rifiutata' };
  return `<button class="activity-row" data-page="loans"><span class="activity-icon">${icon(loan.status === 'returned' ? 'card' : 'swap')}</span><span><strong>${labels[loan.status] || 'Prestito aggiornato'}</strong><small>${esc(loan.cardName)} · ${esc(owner?.name || '')} → ${esc(borrower?.name || '')}</small></span><time>${formatDate(loan.createdAt)}</time></button>`;
}
