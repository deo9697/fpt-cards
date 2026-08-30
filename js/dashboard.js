import { member, esc, formatDate } from './core.js';
import { icon } from './icons.js';
import { positiveMovers } from './market-watch.js';

export function dashboardView(state, game = 'yugioh', market = {}) {
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

function featuredPanel(market) {
  const movers=market.featuredMovers?.length?market.featuredMovers:positiveMovers(market.items,3),history=market.featuredHistory instanceof Map?market.featuredHistory:new Map();
  if (!movers.length) return `<section class="surface duel-panel featured-card-panel featured-empty">
    <div class="section-title"><div><span class="eyebrow">Market Watch</span><h2>Carte in evidenza</h2></div><button class="text-action" data-page="market">Vedi mercato ${icon('arrow')}</button></div>
    <div class="inline-empty">${icon('chart')}<div><strong>Trend in preparazione</strong><span>Le carte con crescita positiva appariranno dopo il secondo snapshot giornaliero.</span></div></div>
  </section>`;
  return `<section class="surface duel-panel featured-card-panel market-movers-panel">
    <div class="section-title"><div><span class="eyebrow">Market Watch</span><h2>Carte in evidenza</h2></div><button class="text-action" data-page="market">Vedi mercato ${icon('arrow')}</button></div>
    <div class="market-movers-carousel slides-${movers.length}">${movers.map((item,index)=>featuredMover(item,history.get(item.printingId)||[],index)).join('')}</div>
  </section>`;
}

function featuredMover(item,history,index){const points=marketMoverPoints(item,history),chart=marketMoverChart(points,index),artwork=moverArtwork(item),change=Number(item.positiveChange);return `<button class="market-mover-slide" style="--mover-image:url(&quot;${esc(artwork)}&quot;)" data-page="market" aria-label="Apri ${esc(item.cardName)} nel Market Watch"><span class="market-mover-head"><h3>${esc(item.cardName)}</h3><span class="market-mover-price"><b>${marketMoney(item.referencePrice)}</b><small>Trend Cardmarket${Number.isFinite(change)?` · +${change.toFixed(1)}%`:''}</small></span></span>${chart}</button>`;}
function moverArtwork(item){const source=String(item.imageUrl||'');if(/\/images\/cards\/\d+\.jpg(?:\?|$)/i.test(source))return source.replace(/\/images\/cards\//i,'/images/cards_cropped/');const id=String(item.catalogCardId||'');return /^\d+$/.test(id)?`https://images.ygoprodeck.com/images/cards_cropped/${id}.jpg`:source;}
function marketMoney(value){return new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'}).format(Number(value)||0);}
function marketMoverPoints(item,history){if(item.sparkline?.length>1)return item.sparkline.map(point=>({price:Number(point.price),capturedAt:new Date(Date.now()-(4-point.order)*86400000).toISOString()}));const rows=(history||[]).filter(row=>Number.isFinite(row.price)).map(row=>({price:Number(row.price),capturedAt:row.capturedAt}));if(rows.length>1)return rows.sort((a,b)=>new Date(a.capturedAt)-new Date(b.capturedAt));const now=Date.now(),fallback=[[item.price30d,30],[item.price7d,7],[item.price24h,1],[item.referencePrice,0]].filter(([price])=>Number.isFinite(price)).map(([price,days])=>({price:Number(price),capturedAt:new Date(now-days*86400000).toISOString()}));return fallback;}
function marketMoverChart(points,index){if(points.length<2)return `<span class="market-mover-chart empty">${icon('chart')}</span>`;const values=points.map(point=>point.price),min=Math.min(...values),max=Math.max(...values),span=max-min||1,width=520,height=150,pad=8,path=points.map((point,position)=>`${position?'L':'M'} ${pad+(position/(points.length-1))*(width-pad*2)} ${height-pad-((point.price-min)/span)*(height-pad*2)}`).join(' '),area=`${path} L ${width-pad} ${height-pad} L ${pad} ${height-pad} Z`,gradient=`mover-gradient-${index}`;return `<span class="market-mover-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Grafico prezzi Cardmarket"><defs><linearGradient id="${gradient}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5ee49a" stop-opacity=".46"/><stop offset="1" stop-color="#5ee49a" stop-opacity="0"/></linearGradient></defs><g class="mover-grid"><path d="M 0 38 H ${width} M 0 75 H ${width} M 0 112 H ${width}"/></g><path class="mover-area" d="${area}" fill="url(#${gradient})"/><path class="mover-line" d="${path}"/><circle cx="${width-pad}" cy="${height-pad-((values.at(-1)-min)/span)*(height-pad*2)}" r="5"/></svg></span>`;}

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
