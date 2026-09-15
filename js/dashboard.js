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

// Soluzione ibrida: un hero carousel dominante (solo artwork, in stile
// cover — mai la carta intera con cornice/testo/ATK-DEF) con le carte in
// salita come featured movers, e sotto due liste compatte Top 3 Up/Top 3
// Down (già esistenti, riusate senza modifiche). Zero query nuove: le
// carte in salita vengono da market.featuredMovers (RPC esistente
// list_market_dashboard_movers, invariata) con lo stesso fallback
// client-side già esistente; quelle in discesa restano sempre
// negativeMovers(market.items,3), la RPC non le fornisce.
//
// `Array.isArray` invece di `.length`: market.featuredMovers è `undefined`
// finché la RPC non ha ancora risposto, ma un `[]` esplicito È una risposta
// valida ("nessuna carta in crescita adesso") — ricadere comunque su
// positiveMovers(market.items,3) in quel caso significherebbe classificare
// da un sottoinsieme PARZIALE (ownedPage è paginata) invece di fidarsi
// della risposta completa già arrivata.
function featuredPanel(market) {
  const upMovers = Array.isArray(market.featuredMovers) ? market.featuredMovers.slice(0, 3) : positiveMovers(market.items || [], 3);
  const downMovers = negativeMovers(market.items || [], 3);
  const heading = '<div class="section-title"><div><span class="eyebrow">Market Watch</span><h2>Il mercato, nelle tue carte</h2></div><button class="text-action" data-page="market">Vedi mercato '+icon('arrow')+'</button></div>';
  if (!upMovers.length && !downMovers.length) {
    const title = market.trendsError ? 'Trend non disponibili' : market.trendsLoading ? 'Caricamento trend…' : 'Nessuna variazione da mostrare';
    const message = market.trendsError ? 'Apri Market Watch per riprovare il caricamento.' : market.trendsLoading ? 'Controlliamo le carte della tua raccolta.' : 'Le carte con un prezzo recente e un confronto a 24h appariranno qui.';
    return '<section class="surface duel-panel featured-card-panel featured-empty">'+heading+'<div class="inline-empty">'+icon('chart')+'<div><strong>'+title+'</strong><span>'+message+'</span></div></div></section>';
  }
  return '<section class="surface duel-panel featured-card-panel market-movers-panel">'+heading+
    heroCarousel(upMovers)+
    '<div class="market-movers-lists">'+
      moverGroup('In salita', 'up', upMovers, 'Nessuna carta in crescita al momento.')+
      moverGroup('In discesa', 'down', downMovers, 'Nessuna variazione negativa al momento.')+
    '</div></section>';
}
// Solo le carte in crescita diventano hero slide (coerente con "usando le
// carte in crescita come featured movers" — la lista "In discesa" resta
// sotto, mai promossa nel carousel).
function heroCarousel(upMovers) {
  if (!upMovers.length) return '<div class="market-hero-empty">'+icon('chart')+'<span>Nessuna carta in crescita al momento — le carte in discesa restano comunque visibili sotto.</span></div>';
  const multi = upMovers.length > 1;
  return '<div class="market-hero-carousel">'+
    '<div class="market-hero-track" data-hero-track role="listbox" aria-label="Carte in evidenza">'+upMovers.map((item, index) => heroSlide(item, index)).join('')+'</div>'+
    (multi ? '<div class="market-hero-nav">'+
      '<button type="button" class="market-hero-nav-btn" data-hero-prev aria-label="Carta precedente">&#8249;</button>'+
      '<div class="market-hero-dots" data-hero-dots>'+upMovers.map((_, i) => '<button type="button" class="market-hero-dot'+(i===0?' active':'')+'" data-hero-dot="'+i+'" aria-label="Vai alla carta '+(i+1)+'"></button>').join('')+'</div>'+
      '<button type="button" class="market-hero-nav-btn" data-hero-next aria-label="Carta successiva">&#8250;</button>'+
    '</div>' : '')+
  '</div>';
}
function heroSlide(item, index) {
  const artwork = moverArtwork(item), change = Number(item.positiveChange);
  const previous = Number.isFinite(item.price24h) ? item.price24h : (Number.isFinite(item.baselinePrice) ? item.baselinePrice : null);
  return '<button type="button" class="market-hero-slide" data-page="market" data-hero-slide="'+index+'" aria-label="Apri Market Watch: '+esc(item.cardName)+'">'+
    (artwork ? '<img class="market-hero-art" src="'+esc(artwork)+'" alt="" loading="'+(index===0?'eager':'lazy')+'" decoding="async">' : '<span class="market-hero-art market-hero-art-placeholder">'+icon('card')+'</span>')+
    '<span class="market-hero-scrim" aria-hidden="true"></span>'+
    '<span class="market-hero-copy">'+
      '<span class="market-hero-badge">In salita &#183; '+changePercent(change)+'</span>'+
      '<strong class="market-hero-name">'+esc(item.cardName)+'</strong>'+
      '<span class="market-hero-price"><b>'+marketMoney(item.referencePrice)+'</b>'+(previous!=null?'<small>'+marketMoney(previous)+' &#8594; '+marketMoney(item.referencePrice)+'</small>':'')+'</span>'+
    '</span></button>';
}
// Navigazione semplice (frecce + indicatori a pallino), niente autoplay:
// mai un timer che ricarichi/ridisegni da solo. Una sola slide -> nessun
// controllo di navigazione montato (return immediato, meno di 2 slide).
export function bindDashboardCarousel(root=document) {
  const track=root.querySelector('[data-hero-track]');
  if(!track||track.dataset.bound)return;
  track.dataset.bound='true';
  const slides=[...track.querySelectorAll('.market-hero-slide')];
  if(slides.length<2)return;
  const dots=[...root.querySelectorAll('[data-hero-dot]')];
  const prevBtn=root.querySelector('[data-hero-prev]'),nextBtn=root.querySelector('[data-hero-next]');
  const slideWidth=()=>slides[0].getBoundingClientRect().width+12;
  const currentIndex=()=>Math.round(track.scrollLeft/slideWidth());
  const goTo=index=>{const clamped=Math.max(0,Math.min(slides.length-1,index));track.scrollTo({left:clamped*slideWidth(),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});};
  const update=()=>{const i=currentIndex();dots.forEach((dot,index)=>dot.classList.toggle('active',index===i));if(prevBtn)prevBtn.disabled=i===0;if(nextBtn)nextBtn.disabled=i>=slides.length-1;};
  prevBtn?.addEventListener('click',()=>goTo(currentIndex()-1));
  nextBtn?.addEventListener('click',()=>goTo(currentIndex()+1));
  dots.forEach((dot,index)=>dot.addEventListener('click',()=>goTo(index)));
  track.addEventListener('scroll',update,{passive:true});
  track.addEventListener('keydown',event=>{if(event.key==='ArrowRight'){event.preventDefault();goTo(currentIndex()+1);}else if(event.key==='ArrowLeft'){event.preventDefault();goTo(currentIndex()-1);}});
  update();
}
function moverGroup(label, direction, movers, emptyText) {
  return '<div class="market-movers-group '+direction+'"><h3>'+esc(label)+'</h3>'+(movers.length ? movers.map(moverRow).join('') : '<p class="market-movers-group-empty">'+esc(emptyText)+'</p>')+'</div>';
}
function moverRow(item) {
  const artwork = moverArtwork(item), change = Number(item.positiveChange), hasPrevious = Number.isFinite(item.price24h);
  return '<button class="market-mover-row" data-page="market" aria-label="Apri '+esc(item.cardName)+' nel Market Watch">'+
    (artwork ? '<img class="market-mover-row-art" src="'+esc(artwork)+'" alt="" loading="lazy">' : '<span class="market-mover-row-art market-mover-row-art-placeholder">'+icon('card')+'</span>')+
    '<span class="market-mover-row-body"><strong class="market-mover-row-name">'+esc(item.cardName)+'</strong>'+
    (hasPrevious?'<small class="market-mover-row-history">'+marketMoney(item.price24h)+' &#8594; '+marketMoney(item.referencePrice)+'</small>':'')+'</span>'+
    '<span class="market-mover-row-price"><b>'+marketMoney(item.referencePrice)+'</b><small class="'+tone(change)+'">'+changePercent(change)+'</small></span></button>';
}
// Preferire il crop per Yu-Gi-Oh! (mai la carta intera nell'hero): un URL
// già in forma images/cards/<id>.jpg diventa cards_cropped/<id>.jpg, un
// catalogCardId puramente numerico forza direttamente l'URL cropped
// (stessa regola già usata altrove nel modulo, qui riusata senza
// duplicarne la logica in forma diversa). Altrimenti (es. One Piece, che
// non ha una variante "cropped") resta l'URL affidabile già nei dati;
// se manca del tutto, mostrare un placeholder è responsabilità di chi
// chiama questa funzione (mai un <img src=""> rotto).
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
