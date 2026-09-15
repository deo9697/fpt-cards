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
  const movers=[...upMovers,...downMovers];
  return '<section class="surface duel-panel featured-card-panel market-movers-panel">'+heading+
    '<p class="market-movers-context">Top 3 in salita e in discesa rispetto alla media a 7 giorni.</p>'+
    '<div class="market-art-carousel" tabindex="0" aria-label="Carte in evidenza: scorri orizzontalmente">'+movers.map((item,index)=>moverRow(item,index,market,movers.length)).join('')+'</div>'+
    '<div class="market-carousel-controls"><button type="button" data-mover-step="-1" aria-label="Carta precedente">&#8592;</button><span data-mover-position aria-live="polite">1 / '+movers.length+'</span><button type="button" data-mover-step="1" aria-label="Carta successiva">&#8594;</button></div></section>';
}
export function bindDashboardCarousel(root=document) {
  const track=root.querySelector('.market-art-carousel');
  if(!track||track.dataset.bound)return;
  track.dataset.bound='true';
  const cards=[...track.querySelectorAll('.market-art-card')],controls=root.querySelectorAll('[data-mover-step]'),position=root.querySelector('[data-mover-position]');
  const index=()=>Math.round(track.scrollLeft/(cards[0].getBoundingClientRect().width+12));
  const update=()=>{const i=index();if(position)position.textContent=(i+1)+' / '+cards.length;controls.forEach(button=>button.disabled=Number(button.dataset.moverStep)<0?i===0:i>=cards.length-1);};
  const move=step=>{const i=Math.max(0,Math.min(cards.length-1,index()+step));track.scrollTo({left:i*(cards[0].getBoundingClientRect().width+12),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});};
  controls.forEach(button=>button.onclick=()=>move(Number(button.dataset.moverStep)));
  track.addEventListener('scroll',update,{passive:true});
  track.addEventListener('keydown',event=>{if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();move(event.key==='ArrowRight'?1:-1);}});
  update();
}
function moverRow(item, index, market, total) {
  const source = String(item.imageUrl||'');
  const artwork = source.replace(/\/images\/cards\/(\d+\.jpg)/i,'/images/cards_cropped/$1'), change = item.positiveChange;
  const metadata = [item.setCode, item.rarity].filter(Boolean).join(' · ');
  const history = market.featuredHistory?.get?.(item.printingId)||[];
  return '<button class="market-art-card '+(change>0?'up':'down')+'" data-page="market" aria-label="Apri Market Watch: '+esc(item.cardName)+'">'+
    (artwork ? '<img class="market-art-background" src="'+esc(artwork)+'" alt="" loading="lazy" decoding="async">' : '<span class="market-art-placeholder">'+icon('card')+'</span>')+
    '<span class="market-art-copy"><span class="market-art-rank">'+(change>0?'In salita':'In discesa')+' &#183; '+(index+1)+' / '+total+'</span><strong class="market-art-name">'+esc(item.cardName)+'</strong><small>'+esc(metadata)+'</small></span>'+
    '<span class="market-art-bottom"><span class="market-art-price"><b>'+marketMoney(item.referencePrice)+'</b><span class="'+tone(change)+'">'+(change>0?'↗ ':'↘ ')+changePercent(change)+'<small>vs media 7g</small></span></span>'+
    moverHistoryChart(history)+
    (Number.isFinite(item.baselinePrice)?'<small class="market-mover-row-history">Media 7g '+marketMoney(item.baselinePrice)+'</small>':'')+'</span></button>';
}
function moverHistoryChart(history) {
  const points=history.filter(p=>Number.isFinite(p.price)&&Number.isFinite(Date.parse(p.capturedAt))).slice().sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt));
  if(points.length<2)return '<span class="market-art-chart-empty">Storico prezzi non ancora disponibile</span>';
  const values=points.map(p=>p.price),low=Math.min(...values),high=Math.max(...values),range=high-low||1;
  const first=Date.parse(points[0].capturedAt),duration=Date.parse(points.at(-1).capturedAt)-first||1;
  const coords=points.map(p=>[8+(Date.parse(p.capturedAt)-first)/duration*304,high===low?48:80-(p.price-low)/range*64]);
  const path=coords.map(([x,y],i)=>(i?'L':'M')+x.toFixed(2)+' '+y.toFixed(2)).join(' '),last=coords.at(-1);
  const date=p=>new Date(p.capturedAt).toLocaleDateString('it-IT',{day:'2-digit',month:'short'});
  return '<span class="market-art-chart"><svg viewBox="0 0 320 96" role="img" aria-label="Storico reale dei prezzi Cardmarket"><path class="market-chart-grid" d="M8 16H312 M8 48H312 M8 80H312"/><path class="market-chart-area" d="'+path+' L'+last[0]+' 96 L8 96Z"/><path class="market-chart-line" d="'+path+'"/><circle cx="'+last[0]+'" cy="'+last[1]+'" r="3.5"/></svg><span class="market-chart-dates"><small>'+date(points[0])+'</small><small>'+date(points.at(-1))+'</small></span></span>';
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
