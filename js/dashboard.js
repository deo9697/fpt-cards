import { member, esc, formatDate, GAMES } from './core.js';
import { icon } from './icons.js';
import { changePercent, tone } from './market-watch.js';

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

// Both rankings cover the complete collection, using the same seven-day baseline.
function featuredPanel(market) {
  const rows = (market.featuredMovers || []).filter(item => Number.isFinite(item.positiveChange) && Number.isFinite(item.referencePrice));
  const upMovers = rows.filter(item => item.positiveChange > 0).sort((a,b) => b.positiveChange-a.positiveChange).slice(0,3);
  const downMovers = rows.filter(item => item.positiveChange < 0).sort((a,b) => a.positiveChange-b.positiveChange).slice(0,3);
  const heading = '<div class="section-title"><div><span class="eyebrow">Market Watch · La tua raccolta</span><h2>Il mercato, nelle tue carte</h2></div><button class="text-action" data-page="market">Vedi mercato '+icon('arrow')+'</button></div>';
  if (!upMovers.length && !downMovers.length) {
    const title = market.trendsError ? 'Trend non disponibili' : market.trendsLoading ? 'Caricamento trend' : 'Nessuna variazione da mostrare';
    const message = market.trendsError ? 'Apri Market Watch per riprovare il caricamento.' : market.trendsLoading ? 'Controlliamo le carte della tua raccolta.' : 'Servono prezzi recenti e una media a 7 giorni. Le carte stabili non entrano in classifica.';
    return '<section class="surface duel-panel featured-card-panel featured-empty">'+heading+'<div class="inline-empty">'+icon('chart')+'<div><strong>'+title+'</strong><span>'+message+'</span></div></div></section>';
  }
  return '<section class="surface duel-panel featured-card-panel market-movers-panel">'+heading+
    '<p class="market-movers-context">Prezzo indicativo Cardmarket rispetto alla media degli ultimi 7 giorni.</p><div class="market-movers-lists">'+
    moverGroup('In salita','up',upMovers,'Nessuna carta in crescita al momento.')+
    moverGroup('In discesa','down',downMovers,'Nessuna variazione negativa al momento.')+
    '</div><p class="market-movers-footnote">Solo carte possedute · Fino a 3 per classifica · Prezzi indicativi</p></section>';
}
function moverGroup(label, direction, movers, emptyText) {
  return '<section class="market-movers-group '+direction+'" aria-label="'+label+'"><h3><span>'+(direction==='up'?'↗':'↘')+' '+label+'</span><small>TOP 3</small></h3>'+(movers.length ? movers.map(moverRow).join('') : '<p class="market-movers-group-empty">'+esc(emptyText)+'</p>')+'</section>';
}
function moverRow(item, index) {
  const artwork = String(item.imageUrl||''), change = item.positiveChange;
  const metadata = [item.setCode, item.rarity].filter(Boolean).join(' · ');
  return '<button class="market-mover-row" data-page="market" aria-label="Apri Market Watch: '+esc(item.cardName)+'">'+
    '<span class="market-mover-rank">'+(index+1)+'</span>'+
    (artwork ? '<img class="market-mover-row-art" src="'+esc(artwork)+'" alt="" loading="lazy" decoding="async">' : '<span class="market-mover-row-art market-mover-row-art-placeholder">'+icon('card')+'</span>')+
    '<span class="market-mover-row-body"><strong class="market-mover-row-name">'+esc(item.cardName)+'</strong><small class="market-mover-row-meta">'+esc(metadata)+'</small>'+
    (Number.isFinite(item.baselinePrice) ? '<small class="market-mover-row-history">Media 7g '+marketMoney(item.baselinePrice)+'</small>' : '')+'</span>'+
    '<span class="market-mover-row-price"><b>'+marketMoney(item.referencePrice)+'</b><small class="'+tone(change)+'">'+(change>0?'↗ ':'↘ ')+changePercent(change)+'</small></span></button>';
}
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
