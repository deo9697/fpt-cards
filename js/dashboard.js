import { member, esc, formatDate, GAMES } from './core.js';
import { icon } from './icons.js';
import { positiveMovers, changePercent } from './market-movers.js';

// Dashboard "Millennium totale" (2026-10-11, scelta dall'utente fra 3 mockup
// mobile): bandiera del gioco che sventola, carta del duellante (anello XP
// attorno all'avatar, titolo, raccolta/carte/vittorie), prove del giorno a
// sigilli, poi Market Watch, prestiti e attività. `profile` è costruito da
// app.js con dati GIÀ caricati (stats, cosmetici, Market Watch, raccolta):
// nessuna query nuova. Senza profile (test, utente non ancora caricato) la
// carta del duellante e le prove semplicemente non compaiono.
export function dashboardView(state, game = 'yugioh', market = {}, profile = null) {
  const me = member(state.currentUser);
  const teamLoans = state.loans.filter(loan => loan.game === game);
  const personal = teamLoans.filter(loan => loan.owner === me?.id || loan.borrower === me?.id);
  const attention = personal.filter(loan =>
    (loan.borrower === me?.id && ['pending','reserved'].includes(loan.status)) ||
    (loan.owner === me?.id && ['requested','return_pending'].includes(loan.status))
  );
  const recent = [...teamLoans].reverse().slice(0, 4);
  const teamActive = [...teamLoans].reverse().filter(loan => !['returned','completed','rejected'].includes(loan.status)).slice(0, 4);

  return `<section class="dashboard duel-dashboard page-stack mm-dashboard">
    ${gameFlag(game)}

    ${profile ? `<div class="mm-top">${duelistPanel(profile)}${missionsPanel(profile.missions)}</div>` : ''}

    <div class="duel-dashboard-main">
      ${featuredPanel(market)}
      ${loanOverview(teamActive, attention)}
    </div>

    <div class="dashboard-columns duel-dashboard-lower activity-only">
      <section class="surface duel-panel activity-panel mm-activity">
        ${mmHeading('Attività del team', `<button class="text-action" data-page="loans">Vedi tutte ${icon('arrow')}</button>`)}
        ${recent.length ? recent.map(activityRow).join('') : `<div class="inline-empty">${icon('swap')}<div><strong>Nessuna attività</strong><span>I movimenti del team compariranno qui.</span></div></div>`}
      </section>
    </div>
  </section>`;
}

// Bandiera del gioco attivo: un unico drappo diviso in FLAG_STRIPS strisce
// verticali, ognuna con una copia del drappo spostata (container query units,
// 100cqw = larghezza della bandiera) e animata con uno sfasamento: fissata
// all'asta in alto, ondeggia verso la coda di rondine. Solo transform/opacity
// (niente filtri SVG): leggero anche su telefoni economici. Con
// prefers-reduced-motion resta ferma. .duel-game-logo resta la classe del
// banner (stessa larghezza piena di prima).
const FLAG_STRIPS = 24;
function gameFlag(game) {
  const g = GAMES[game] || GAMES.yugioh, tagline = dashboardTagline(game);
  const cloth = '<svg class="game-flag-trim" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="2.4,4 97.6,4 97.6,90 50,76 2.4,90"/><polygon class="inner" points="4,7 96,7 96,85.5 50,72.5 4,85.5"/></svg>'+
    '<span class="game-flag-plate"><img src="'+esc(g.logo)+'" alt="" decoding="async"></span>'+
    '<span class="game-flag-tagline">'+esc(tagline)+'</span>';
  const strips = Array.from({ length: FLAG_STRIPS }, (_, i) => '<span class="game-flag-strip" style="--i:'+i+'"><span class="game-flag-cloth">'+cloth+'<span class="game-flag-shade"></span></span></span>').join('');
  return '<header class="duel-welcome duel-welcome-logo game-flag-wrap game-flag-'+esc(g.id)+'">'+
    '<span class="game-flag-rod" aria-hidden="true"></span>'+
    '<div class="duel-game-logo game-flag" style="--n:'+FLAG_STRIPS+'" role="img" aria-label="'+esc(g.name+' · '+tagline)+'">'+strips+'</div>'+
  '</header>';
}

function mmHeading(title, action = '') {
  return '<div class="mm-heading"><span aria-hidden="true"></span><h2>'+esc(title)+'</h2><span aria-hidden="true"></span>'+action+'</div>';
}

const RING = 2 * Math.PI * 60, SEAL = 2 * Math.PI * 25;
// useGrouping 'always': in it-IT i numeri a 4 cifre non avrebbero il
// separatore delle migliaia ("2314" invece di "2.314").
const wholeNumber = value => new Intl.NumberFormat('it-IT', { useGrouping:'always' }).format(Math.round(Number(value) || 0));
function duelistPanel(p) {
  const pct = Math.max(0, Math.min(100, Number(p.progress) || 0));
  const maxLevel = !p.nextXp;
  const xpLine = maxLevel ? 'Livello massimo raggiunto' : wholeNumber(p.currentXp)+' / '+wholeNumber(p.nextXp)+' XP · '+wholeNumber(p.nextXp - p.currentXp)+' al prossimo livello';
  const portfolio = p.portfolio && p.portfolio.complete ? new Intl.NumberFormat('it-IT', { style:'currency', currency:'EUR', maximumFractionDigits:0, useGrouping:'always' }).format(p.portfolio.current || 0) : '—';
  const winRate = p.winRate == null ? '—' : p.winRate+'%';
  return '<section class="surface duel-panel mm-panel mm-duelist">'+MILLENNIUM_CORNERS+
    '<button type="button" class="mm-duelist-ring" data-dashboard-progression aria-label="Livello '+p.level+': apri la progressione">'+
      '<svg class="mm-ring-svg" viewBox="0 0 132 132" aria-hidden="true"><circle class="track" cx="66" cy="66" r="60"/><circle class="fill" cx="66" cy="66" r="60" stroke-dasharray="'+(pct / 100 * RING).toFixed(1)+' '+RING.toFixed(1)+'"/><circle class="inner" cx="66" cy="66" r="50"/></svg>'+
      p.avatarHtml+
      '<span class="mm-duelist-level">LV '+p.level+'</span>'+
    '</button>'+
    '<strong class="mm-duelist-title">'+esc(p.title)+'</strong>'+
    '<small class="mm-duelist-xp">'+xpLine+'</small>'+
    '<span class="mm-divider" aria-hidden="true"></span>'+
    '<div class="mm-duelist-stats">'+
      '<button type="button" data-page="market"><b>'+portfolio+'</b><small>Raccolta</small></button>'+
      '<button type="button" data-page="collection"><b>'+wholeNumber(p.cardCount)+'</b><small>Carte</small></button>'+
      '<button type="button" data-page="stats"><b>'+winRate+'</b><small>Vittorie</small></button>'+
    '</div>'+
  '</section>';
}

function missionsPanel(missions = []) {
  if (!missions.length) return '';
  return '<section class="mm-missions" aria-label="Prove del giorno">'+mmHeading('Prove del giorno')+
    '<div class="mm-missions-grid">'+missions.slice(0, 3).map(m => {
      const pct = m.completed ? 100 : Math.max(0, Math.min(100, (Number(m.progress) || 0) / (Number(m.target) || 1) * 100));
      return '<button type="button" class="mm-mission'+(m.completed?' done':'')+'" data-dashboard-progression aria-label="'+esc(m.label)+': '+(m.completed?'completata':m.progress+' su '+m.target)+'">'+
        '<span class="mm-mission-ring"><svg class="mm-ring-svg" viewBox="0 0 58 58" aria-hidden="true"><circle class="track" cx="29" cy="29" r="25"/><circle class="fill" cx="29" cy="29" r="25" stroke-dasharray="'+(pct / 100 * SEAL).toFixed(1)+' '+SEAL.toFixed(1)+'"/></svg>'+icon(m.completed ? 'check' : (m.icon || 'star'))+'</span>'+
        '<strong>'+esc(m.label)+'</strong>'+
        '<small>'+(m.completed ? 'Completata' : wholeNumber(m.progress)+' / '+wholeNumber(m.target))+'</small>'+
      '</button>';
    }).join('')+'</div>'+
  '</section>';
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
// Stile "Millennium" (2026-10-11, scelto dall'utente fra 3 mockup): pannello
// scuro con doppia cornice e angoli dorati, artwork in una cornice d'oro,
// nome in Cinzel, prezzo e grafico oro, pallini a rombo. Solo l'etichetta
// "Market Watch" in testata (il vecchio titolo "Il mercato, nelle tue carte"
// è stato rimosso su richiesta).
const MILLENNIUM_CORNERS = '<span class="mm-corner mm-tl" aria-hidden="true"></span><span class="mm-corner mm-tr" aria-hidden="true"></span><span class="mm-corner mm-bl" aria-hidden="true"></span><span class="mm-corner mm-br" aria-hidden="true"></span>';
function featuredPanel(market) {
  const upMovers = Array.isArray(market.featuredMovers) ? market.featuredMovers.slice(0, 3) : positiveMovers(market.items || [], 3);
  const heading = MILLENNIUM_CORNERS+'<div class="market-featured-head"><h2>Market Watch</h2><button class="text-action" data-page="market">Vedi mercato '+icon('arrow')+'</button></div>';
  if (!upMovers.length) {
    const title = market.trendsError ? 'Trend non disponibili' : market.trendsLoading ? 'Caricamento trend…' : 'Nessuna variazione da mostrare';
    const message = market.trendsError ? 'Apri Market Watch per riprovare il caricamento.' : market.trendsLoading ? 'Controlliamo le carte della tua raccolta.' : 'Le carte con un prezzo recente e un confronto a 24h appariranno qui.';
    return '<section class="surface duel-panel featured-card-panel featured-empty market-millennium">'+heading+'<div class="inline-empty">'+icon('chart')+'<div><strong>'+title+'</strong><span>'+message+'</span></div></div></section>';
  }
  const history = market.featuredHistory instanceof Map ? market.featuredHistory : new Map();
  const multi = upMovers.length > 1;
  return '<section class="surface duel-panel featured-card-panel market-movers-panel market-millennium">'+heading+
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
    ? '<img class="market-featured-art'+(isFullCardImage(candidates[0])?' is-full-card':'')+'" data-art-fallback="'+esc(JSON.stringify(candidates.slice(1)))+'" src="'+esc(candidates[0])+'" alt="" loading="'+(index===0?'eager':'lazy')+'" decoding="async">'+placeholder
    : placeholder;
  const setLine = [item.setCode, item.rarity].filter(Boolean).map(esc).join(' &#183; ');
  return '<button type="button" class="market-featured-slide" data-page="market" data-featured-slide="'+index+'" aria-label="Apri Market Watch: '+esc(item.cardName)+'">'+
    '<span class="market-featured-frame"><span class="market-featured-window">'+
      art+
      '<span class="market-featured-scrim" aria-hidden="true"></span>'+
      '<span class="market-featured-badge"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1l4 7H1z"/></svg>'+changePercent(change)+'</span>'+
      (setLine?'<span class="market-featured-set">'+setLine+'</span>':'')+
    '</span></span>'+
    '<span class="market-featured-copy">'+
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
  // preserveAspectRatio="none": il grafico riempie tutta la larghezza del
  // riquadro. Il punto finale è un tratto di lunghezza zero con
  // vector-effect non-scaling-stroke, così resta rotondo anche stirato.
  return '<span class="market-featured-chart"><svg viewBox="0 0 320 70" preserveAspectRatio="none" role="img" aria-label="Andamento prezzo '+(yearly?'annuale':'mensile')+'">'+
    '<path class="market-featured-chart-grid" d="M8 12H312 M8 35H312 M8 58H312"/>'+
    '<path class="market-featured-chart-area" d="'+path+' L'+lastPoint[0].toFixed(2)+' 70 L8 70Z"/>'+
    '<path class="market-featured-chart-line" d="'+path+'"/>'+
    '<path class="market-featured-chart-dot" d="M'+lastPoint[0].toFixed(2)+' '+lastPoint[1].toFixed(2)+'h0"/>'+
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
// Priorità artwork per Yu-Gi-Oh! — CORRETTA 2026-10-11. Il fix del
// 2026-09-15 dava la precedenza agli image_url YGOResources credendoli
// "artwork-only": verificato scaricandone diversi a caso, sono invece la
// CARTA INTERA (256x372, cornice + nome + box testo) ed è per questo che
// l'hero mostrava la carta completa per ~84% del catalogo. Nuovo ordine:
//   1) imageUrl già in /images/cards_cropped/: usato diretto.
//   2) YGOPRODeck "carta intera" (/images/cards/<id>.jpg): trasformato nel crop.
//   3) catalogCardId numerico -> cards_cropped/<id>.jpg (il crop ufficiale,
//      disponibile per tutte le carte campionate). Se l'imageUrl è
//      YGOResources resta come ultimo fallback, mostrato con un ritaglio
//      CSS sulla finestra dell'arte (.is-full-card), mai la carta intera.
//   4) Solo YGOResources senza id numerico: ritaglio CSS.
// Per un ygoprodeck diretto il fallback è la stessa immagine via
// /api/card-image-proxy (fetch server-side con cache 7gg, utile se l'hotlink
// diretto fallisce); YGOResources non passa dal proxy — la whitelist server
// non lo include e il browser la mostra già senza problemi diretto.
// bindHeroArtworkFallback() consuma questa lista in ordine sull'evento
// error dell'<img>; se anche l'ultimo candidato fallisce, resta il
// placeholder FPT già nel markup — mai un <img> rotto o uno spazio vuoto.
function isFullCardImage(url){return /artworks-[^/]*\.ygoresources\.com/i.test(String(url||''));}
function moverArtworkCandidates(item){
  const source=String(item.imageUrl||''), id=String(item.catalogCardId||'');
  const idFallback=/^\d+$/.test(id)?`https://images.ygoprodeck.com/images/cards_cropped/${id}.jpg`:'';
  const proxied=url=>'/api/card-image-proxy?url='+encodeURIComponent(url);
  if(/\/images\/cards_cropped\//i.test(source))return /images\.ygoprodeck\.com/i.test(source)?[source,proxied(source)]:[source];
  if(/\/images\/cards\/\d+\.jpg(?:\?|$)/i.test(source)){const cropped=source.replace(/\/images\/cards\//i,'/images/cards_cropped/');return[cropped,proxied(cropped)];}
  if(isFullCardImage(source))return idFallback?[idFallback,source]:[source];
  if(idFallback)return[idFallback,proxied(idFallback)];
  return source?[source]:[];
}
// Consuma un candidato alla volta sull'evento error dell'<img>, poi resta il
// placeholder già presente nel markup. Nessun retry infinito: la lista si
// accorcia e non si ricrea mai. Passando a un'immagine YGOResources (carta
// intera) attiva il ritaglio CSS .is-full-card.
function bindHeroArtworkFallback(track){
  for(const img of track.querySelectorAll('.market-featured-art[data-art-fallback]')){
    img.addEventListener('error',()=>{
      let remaining=[];try{remaining=JSON.parse(img.dataset.artFallback||'[]');}catch{remaining=[];}
      if(remaining.length){const next=remaining.shift();img.dataset.artFallback=JSON.stringify(remaining);img.classList.toggle('is-full-card',isFullCardImage(next));img.src=next;return;}
      img.hidden=true;const placeholder=img.nextElementSibling;if(placeholder)placeholder.hidden=false;
    });
  }
}
function marketMoney(value){return new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR',useGrouping:true}).format(Number(value)||0);}

function loanOverview(loans, attention) {
  const list = attention.length ? [...attention, ...loans.filter(loan => !attention.includes(loan))].slice(0, 4) : loans;
  return `<section class="surface duel-panel loan-overview-panel mm-loans">
    ${mmHeading('Prestiti', `<button class="text-action" data-page="loans">Gestisci ${icon('arrow')}</button>`)}
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

function activityRow(loan) {
  const owner = member(loan.owner), borrower = member(loan.borrower);
  const labels = { pending:'Prestito richiesto (legacy)', requested:'Nuova richiesta', reserved:'Carta riservata', active:'Prestito attivo', return_pending:'Restituzione richiesta', returned:'Carta restituita', completed:'Prestito concluso', rejected:'Richiesta rifiutata' };
  return `<button class="activity-row" data-page="loans"><span class="activity-icon">${icon(loan.status === 'returned' ? 'card' : 'swap')}</span><span><strong>${labels[loan.status] || 'Prestito aggiornato'}</strong><small>${esc(loan.cardName)} · ${esc(owner?.name || '')} → ${esc(borrower?.name || '')}</small></span><time>${formatDate(loan.createdAt)}</time></button>`;
}
