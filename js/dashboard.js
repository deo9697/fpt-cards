import { member, esc, formatDate, GAMES } from './core.js';
import { icon } from './icons.js';
import { positiveMovers, changePercent } from './market-watch.js';

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

// Hero carousel dominante (solo artwork, in stile cover — mai la carta
// intera con cornice/testo/ATK-DEF), con un grafico dell'andamento prezzo
// per ogni slide. Solo le carte in crescita (niente più liste Up/Down
// sotto: rimosse su richiesta, non necessarie). Zero query nuove: le carte
// vengono da market.featuredMovers (RPC esistente list_market_dashboard_movers,
// invariata) con lo stesso fallback client-side a positiveMovers(market.items,3)
// di prima; lo storico prezzi viene da market.featuredHistory, già caricato
// da MarketWatchController per le sole carte mostrate (max 3, mai una fetch
// per ogni render).
//
// Nota sui nomi di classe: NON riusare il prefisso .market-hero-* — è già
// la testata della pagina Market Watch (.market-hero, particelle, monete,
// "La tua collezione vale" con lo sfondo assets/market-watch-dan.jpg). Una
// precedente versione di questo file riusava per errore lo stesso nome per
// l'artwork del carousel: lo z-index impostato qui finiva per nascondere
// quello sfondo (stessa classe, proprietà in conflitto). Prefisso dedicato
// .market-featured-* per tutto ciò che appartiene a QUESTA card.
//
// `Array.isArray` invece di `.length`: market.featuredMovers è `undefined`
// finché la RPC non ha ancora risposto, ma un `[]` esplicito È una risposta
// valida ("nessuna carta in crescita adesso") — ricadere comunque su
// positiveMovers(market.items,3) in quel caso significherebbe classificare
// da un sottoinsieme PARZIALE (ownedPage è paginata) invece di fidarsi
// della risposta completa già arrivata.
function featuredPanel(market) {
  const upMovers = Array.isArray(market.featuredMovers) ? market.featuredMovers.slice(0, 3) : positiveMovers(market.items || [], 3);
  const heading = '<div class="section-title"><div><span class="eyebrow">Market Watch</span><h2>Il mercato, nelle tue carte</h2></div><button class="text-action" data-page="market">Vedi mercato '+icon('arrow')+'</button></div>';
  if (!upMovers.length) {
    const title = market.trendsError ? 'Trend non disponibili' : market.trendsLoading ? 'Caricamento trend…' : 'Nessuna variazione da mostrare';
    const message = market.trendsError ? 'Apri Market Watch per riprovare il caricamento.' : market.trendsLoading ? 'Controlliamo le carte della tua raccolta.' : 'Le carte con un prezzo recente e un confronto a 24h appariranno qui.';
    return '<section class="surface duel-panel featured-card-panel featured-empty">'+heading+'<div class="inline-empty">'+icon('chart')+'<div><strong>'+title+'</strong><span>'+message+'</span></div></div></section>';
  }
  const history = market.featuredHistory instanceof Map ? market.featuredHistory : new Map();
  const multi = upMovers.length > 1;
  return '<section class="surface duel-panel featured-card-panel market-movers-panel">'+heading+
    '<div class="market-featured-carousel">'+
      '<div class="market-featured-track" data-featured-track role="listbox" aria-label="Carte in evidenza">'+upMovers.map((item, index) => heroSlide(item, index, history.get(item.printingId)||[])).join('')+'</div>'+
      (multi ? '<div class="market-featured-nav">'+
        '<button type="button" class="market-featured-nav-btn" data-featured-prev aria-label="Carta precedente">&#8249;</button>'+
        '<div class="market-featured-dots" data-featured-dots>'+upMovers.map((_, i) => '<button type="button" class="market-featured-dot'+(i===0?' active':'')+'" data-featured-dot="'+i+'" aria-label="Vai alla carta '+(i+1)+'"></button>').join('')+'</div>'+
        '<button type="button" class="market-featured-nav-btn" data-featured-next aria-label="Carta successiva">&#8250;</button>'+
      '</div>' : '')+
    '</div>'+
  '</section>';
}
function heroSlide(item, index, history) {
  const candidates = moverArtworkCandidates(item), change = Number(item.positiveChange);
  const previous = Number.isFinite(item.price24h) ? item.price24h : (Number.isFinite(item.baselinePrice) ? item.baselinePrice : null);
  // Il placeholder esiste sempre nel markup (solo nascosto via [hidden] se
  // c'è un candidato) così bindHeroArtworkFallback() può scoprirlo senza
  // toccare l'innerHTML durante un evento error — vedi styles.css per la
  // regola [hidden] che vince su .market-featured-art-placeholder{display:grid}.
  const placeholder = '<span class="market-featured-art market-featured-art-placeholder"'+(candidates.length?' hidden':'')+'>'+icon('card')+'</span>';
  const art = candidates.length
    ? '<img class="market-featured-art" data-art-fallback="'+esc(JSON.stringify(candidates.slice(1)))+'" src="'+esc(candidates[0])+'" alt="" loading="'+(index===0?'eager':'lazy')+'" decoding="async">'+placeholder
    : placeholder;
  return '<button type="button" class="market-featured-slide" data-page="market" data-featured-slide="'+index+'" aria-label="Apri Market Watch: '+esc(item.cardName)+'">'+
    art+
    '<span class="market-featured-scrim" aria-hidden="true"></span>'+
    '<span class="market-featured-copy">'+
      '<span class="market-featured-badge">In salita &#183; '+changePercent(change)+'</span>'+
      '<strong class="market-featured-name">'+esc(item.cardName)+'</strong>'+
      '<span class="market-featured-price"><b>'+marketMoney(item.referencePrice)+'</b>'+(previous!=null?'<small>'+marketMoney(previous)+' &#8594; '+marketMoney(item.referencePrice)+'</small>':'')+'</span>'+
      heroChart(history)+
    '</span></button>';
}
// Andamento mensile finché la storia disponibile copre meno di un mese;
// superato il mese, l'asse passa automaticamente a una lettura annuale
// (stessi punti, solo l'etichetta e la granularità delle date cambiano —
// mai una nuova RPC: riusa lo storico già caricato da featuredHistory).
function heroChart(history) {
  const points = (history||[]).filter(p=>Number.isFinite(p.price)&&Number.isFinite(Date.parse(p.capturedAt))).slice().sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt));
  if (points.length < 2) return '<span class="market-featured-chart-empty">Storico prezzi non ancora disponibile</span>';
  const values = points.map(p=>p.price), low = Math.min(...values), high = Math.max(...values), range = high-low || 1;
  const first = Date.parse(points[0].capturedAt), last = Date.parse(points.at(-1).capturedAt), duration = (last-first) || 1;
  const yearly = duration / 86400000 > 31;
  const coords = points.map(p => [8+(Date.parse(p.capturedAt)-first)/duration*304, 58-((p.price-low)/range)*44]);
  const path = coords.map(([x,y],i)=>(i?'L':'M')+x.toFixed(2)+' '+y.toFixed(2)).join(' '), lastPoint = coords.at(-1);
  const dateLabel = ts => new Date(ts).toLocaleDateString('it-IT', yearly ? {month:'short',year:'2-digit'} : {day:'2-digit',month:'short'});
  return '<span class="market-featured-chart"><svg viewBox="0 0 320 70" role="img" aria-label="Andamento prezzo '+(yearly?'annuale':'mensile')+'">'+
    '<path class="market-featured-chart-grid" d="M8 12H312 M8 35H312 M8 58H312"/>'+
    '<path class="market-featured-chart-area" d="'+path+' L'+lastPoint[0].toFixed(2)+' 70 L8 70Z"/>'+
    '<path class="market-featured-chart-line" d="'+path+'"/>'+
    '<circle cx="'+lastPoint[0].toFixed(2)+'" cy="'+lastPoint[1].toFixed(2)+'" r="3"/>'+
  '</svg><span class="market-featured-chart-dates"><small>'+dateLabel(first)+'</small><small>'+(yearly?'Andamento annuale':'Andamento mensile')+'</small><small>'+dateLabel(last)+'</small></span></span>';
}
// Navigazione semplice (frecce + indicatori a pallino), niente autoplay:
// mai un timer che ricarichi/ridisegni da solo. Una sola slide -> nessun
// controllo di navigazione montato (return immediato, meno di 2 slide).
export function bindDashboardCarousel(root=document) {
  const track=root.querySelector('[data-featured-track]');
  if(!track||track.dataset.bound)return;
  track.dataset.bound='true';
  bindHeroArtworkFallback(track);
  const slides=[...track.querySelectorAll('.market-featured-slide')];
  if(slides.length<2)return;
  const dots=[...root.querySelectorAll('[data-featured-dot]')];
  const prevBtn=root.querySelector('[data-featured-prev]'),nextBtn=root.querySelector('[data-featured-next]');
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
// Priorità artwork per Yu-Gi-Oh! (fix 2026-09-15: nel DB reale ~2798/2994
// printing hanno già un image_url YGOResources, artwork-only e senza bisogno
// di crop — la versione precedente lo ignorava ogni volta che catalogCardId
// era numerico, cioè quasi sempre, forzando YGOPRODeck sulla stragrande
// maggioranza delle carte):
//   1) YGOResources (artworks-*.ygoresources.com) già presente: usato diretto.
//   2) imageUrl già in /images/cards_cropped/ (qualunque origine l'abbia
//      prodotto): usato diretto.
//   3) YGOPRODeck "carta intera" (/images/cards/<id>.jpg): mai nell'hero,
//      trasformato nel crop.
//   4) catalogCardId numerico: SOLO fallback finale se non c'è nessun
//      artwork affidabile sopra (era la sorgente primaria, ora è l'ultima).
// Ogni candidato ha al massimo UN fallback (mai un secondo tentativo dopo
// quello): per un ygoprodeck diretto, il fallback è la stessa immagine via
// /api/card-image-proxy (fetch server-side con cache 7gg, utile se l'hotlink
// diretto fallisce); YGOResources non passa dal proxy — la whitelist server
// non lo include e il browser la mostra già senza problemi diretto.
// bindHeroArtworkFallback() consuma questa lista in ordine sull'evento
// error dell'<img>; se anche l'ultimo candidato fallisce, resta il
// placeholder FPT già nel markup — mai un <img> rotto o uno spazio vuoto.
function moverArtworkCandidates(item){
  const source=String(item.imageUrl||''), id=String(item.catalogCardId||'');
  const idFallback=/^\d+$/.test(id)?`https://images.ygoprodeck.com/images/cards_cropped/${id}.jpg`:'';
  const proxied=url=>'/api/card-image-proxy?url='+encodeURIComponent(url);
  if(/artworks-[^/]*\.ygoresources\.com/i.test(source))return idFallback?[source,idFallback]:[source];
  if(/\/images\/cards_cropped\//i.test(source))return /images\.ygoprodeck\.com/i.test(source)?[source,proxied(source)]:[source];
  if(/\/images\/cards\/\d+\.jpg(?:\?|$)/i.test(source)){const cropped=source.replace(/\/images\/cards\//i,'/images/cards_cropped/');return[cropped,proxied(cropped)];}
  if(idFallback)return[idFallback,proxied(idFallback)];
  return source?[source]:[];
}
// Consuma un candidato alla volta sull'evento error dell'<img>: al massimo
// un fallback per sorgente (data-art-fallback parte già con un solo
// elemento al più), poi resta il placeholder già presente nel markup.
// Nessun retry infinito: la lista si accorcia e non si ricrea mai.
function bindHeroArtworkFallback(track){
  for(const img of track.querySelectorAll('.market-featured-art[data-art-fallback]')){
    img.addEventListener('error',()=>{
      let remaining=[];try{remaining=JSON.parse(img.dataset.artFallback||'[]');}catch{remaining=[];}
      if(remaining.length){const next=remaining.shift();img.dataset.artFallback=JSON.stringify(remaining);img.src=next;return;}
      img.hidden=true;const placeholder=img.nextElementSibling;if(placeholder)placeholder.hidden=false;
    });
  }
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
