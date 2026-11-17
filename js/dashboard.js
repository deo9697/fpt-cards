import { member, esc, formatDate, GAMES } from './core.js';
import { icon } from './icons.js';
import { positiveMovers, changePercent } from './market-movers.js';

// Home "Vetrina compatta" (variante B scelta 2026-11-17, seconda versione):
// un solo riquadro d'apertura (logo del gioco, saluto, livello e la carta di
// maggior valore intera), 3 numeri in griglia, "Da fare oggi", i pezzi forti,
// i prestiti attivi e il log del team. La carta più preziosa compare una
// volta sola; il pannello Market Watch completo resta nella sua pagina
// (featuredPanel è ancora esportato e testato, non più montato qui).
// `profile` arriva da app.js con dati GIÀ caricati: nessuna query nuova.
export function dashboardView(state, game = 'yugioh', market = {}, profile = null) {
  const me = member(state.currentUser);
  const teamLoans = state.loans.filter(loan => loan.game === game);
  const personal = teamLoans.filter(loan => loan.owner === me?.id || loan.borrower === me?.id);
  const attention = personal.filter(loan =>
    (loan.borrower === me?.id && ['pending','reserved'].includes(loan.status)) ||
    (loan.owner === me?.id && ['requested','return_pending'].includes(loan.status))
  );
  const open = loan => !['returned','completed','rejected'].includes(loan.status);
  const recent = [...teamLoans].reverse().slice(0, 3);
  const active = [...personal].reverse().filter(loan => open(loan) && !attention.includes(loan)).slice(0, 3);

  return `<section class="dashboard duel-dashboard page-stack mm-dashboard hv-home">
    ${welcomeHero(profile, me, market, game)}
    ${profile ? statsRow(profile, market, { loans: personal.filter(open).length, attention: attention.length }) : ''}
    ${todoPanel(attention, me)}
    ${showcaseStrip(market)}
    ${loansPanel(active)}
    ${activityPanel(recent)}
  </section>`;
}

// useGrouping 'always': in it-IT i numeri a 4 cifre non avrebbero il
// separatore delle migliaia ("2314" invece di "2.314").
const wholeNumber = value => new Intl.NumberFormat('it-IT', { useGrouping:'always' }).format(Math.round(Number(value) || 0));
function compactMoney(value) {
  const n = Number(value) || 0;
  return n >= 10000 ? new Intl.NumberFormat('it-IT', { maximumFractionDigits:1 }).format(n / 1000) + 'k €' : marketMoney(n);
}
const homeSection = (title, action = '', extra = '') => '<div class="hv-sec"><h2>'+esc(title)+extra+'</h2>'+action+'</div>';
const homeLink = (page, label) => '<button type="button" class="hv-link" data-page="'+page+'">'+esc(label)+' ▸</button>';

// Carta INTERA (non il ritaglio dell'arte): nella vetrina si vede la carta.
// Lista di ripieghi consumata da bindHomeImages() sull'errore dell'immagine.
export function fullCardCandidates(item) {
  const source = String(item?.imageUrl || ''), id = String(item?.catalogCardId || '');
  const proxied = url => '/api/card-image-proxy?url=' + encodeURIComponent(url);
  const list = [];
  if (/^\d+$/.test(id)) { const full = `https://images.ygoprodeck.com/images/cards/${id}.jpg`; list.push(full, proxied(full)); }
  if (source && /\/images\/cards_cropped\//i.test(source)) list.push(source.replace(/\/images\/cards_cropped\//i, '/images/cards/'));
  else if (source) list.push(source);
  return [...new Set(list)];
}
function cardImage(item, loading = 'lazy', className = 'hv-card-img') {
  const [first, ...rest] = fullCardCandidates(item);
  if (!first) return '<span class="'+className+' hv-card-empty">'+icon('card')+'</span>';
  return '<img class="'+className+'" src="'+esc(first)+'" data-card-fallbacks="'+esc(JSON.stringify(rest))+'" alt="" loading="'+loading+'" decoding="async">';
}
function priceChange(item) {
  const price = Number(item?.price), base = Number(item?.price7) > 0 ? { value: Number(item.price7), label: '7 gg' } : Number(item?.price30) > 0 ? { value: Number(item.price30), label: '30 gg' } : null;
  if (!(price > 0) || !base) return '';
  const pct = (price / base.value - 1) * 100;
  return '<small class="'+(pct > 0 ? 'mv-up' : pct < 0 ? 'mv-down' : 'mv-flat')+'">'+(pct > 0 ? '▲' : pct < 0 ? '▼' : '=')+' '+percent(Math.abs(pct)).replace(/^[+−-]/, '')+' · '+base.label+'</small>';
}

// Riquadro d'apertura: logo, saluto, livello e la carta di maggior valore.
function welcomeHero(p, me, market, game) {
  const g = GAMES[game] || GAMES.yugioh;
  const top = market?.overview?.top?.[0] || null;
  const firstName = String(me?.name || '').split(' ')[0] || 'duellante';
  const pct = p ? Math.max(0, Math.min(100, Number(p.progress) || 0)) : 0;
  const level = p ? '<button type="button" class="hv-lv" data-dashboard-progression aria-label="Livello '+p.level+': apri la progressione e le missioni"><b>LV '+p.level+'</b><i style="--p:'+pct+'%"></i><span>'+(p.nextXp ? wholeNumber(p.currentXp)+'/'+wholeNumber(p.nextXp) : 'MAX')+'</span></button>' : '';
  const card = top
    ? '<button type="button" class="hv-card" data-page="market" aria-label="La tua carta più preziosa: '+esc(top.cardName)+', '+esc(marketMoney(top.price))+'"><span class="hv-card-frame">'+cardImage(top, 'eager')+'</span><b>'+marketMoney(top.price)+'</b>'+priceChange(top)+'</button>'
    : (p ? '<button type="button" class="hv-avatar" data-dashboard-progression aria-label="Apri il profilo">'+p.avatarHtml+'</button>' : '');
  return '<section class="hv-hero'+(top ? '' : ' no-card')+'">'+(top ? '<span class="hv-bg" aria-hidden="true">'+cardImage(top, 'eager', 'hv-bg-img')+'</span>' : '')+
    '<div class="hv-copy"><img class="hv-logo" src="'+esc(g.logo)+'" alt="'+esc(g.name)+'" decoding="async">'+
      '<h2>Bentornato,<br>'+esc(firstName)+'</h2>'+(p?.title ? '<small class="hv-title">'+esc(p.title)+'</small>' : '')+level+'</div>'+card+'</section>';
}

// Tre numeri in griglia: non scorrono mai fuori dallo schermo.
function statsRow(p, market, counts) {
  const value = Number(market?.portfolioValue) > 0 ? market.portfolioValue : Number(market?.overview?.value) > 0 ? market.overview.value : p.portfolio;
  const week = market?.overview ? changeOf(market.overview.change7) : null;
  return '<div class="hv-stats">'+
    '<button type="button" data-page="market"><b class="hv-gold">'+(value ? compactMoney(value) : '—')+'</b><i class="'+(week ? trendClass(week.eur) : 'mv-flat')+'">'+(week ? signedMoney(week.eur)+' · 7 gg' : wholeNumber(p.cardCount)+' carte')+'</i><small>Valore</small></button>'+
    '<button type="button" data-page="loans"><b>'+wholeNumber(counts.loans)+'</b><i class="'+(counts.attention ? 'hv-pink' : 'mv-flat')+'">'+(counts.attention ? counts.attention+' da gestire' : 'tutto in ordine')+'</i><small>Prestiti</small></button>'+
    '<button type="button" data-page="stats"><b>'+(p.winRate == null ? '—' : p.winRate+'%')+'</b><i class="mv-flat">'+(p.matches ? wholeNumber(p.matches)+' match' : 'nessun match')+'</i><small>Vittorie</small></button>'+
  '</div>';
}

// "Da fare oggi": i prestiti che aspettano una tua azione, come biglietti.
function todoPanel(attention, me) {
  if (!attention.length) return '';
  const row = loan => {
    const incoming = loan.owner === me?.id;
    const other = member(incoming ? loan.borrower : loan.owner)?.name?.split(' ')[0] || 'Il team';
    const [title, hint, chip] = loan.status === 'return_pending' ? [other+' restituisce '+loan.cardName, 'Conferma il rientro', 'Conferma']
      : incoming ? [other+' vuole '+loan.cardName, 'Accetta o rifiuta il prestito', 'Valuta']
      : ['Ritira '+loan.cardName, 'Da '+other, 'Apri'];
    return '<button type="button" class="hv-ticket" data-page="loans"><span class="hv-ticket-art">'+(loan.image ? '<img src="'+esc(loan.image)+'" alt="" loading="lazy">' : icon('card'))+'</span><span><strong>'+esc(title)+'</strong><small>'+esc(hint)+'</small></span><em>'+chip+'</em></button>';
  };
  return '<section class="hv-block" aria-label="Da fare oggi">'+homeSection('Da fare oggi', '', ' <span class="hv-count">'+attention.length+'</span>')+'<div class="hv-list">'+attention.slice(0, 4).map(row).join('')+'</div></section>';
}

// I pezzi forti dopo la carta del riquadro d'apertura (mai ripetuta).
function showcaseStrip(market) {
  const cards = (market?.overview?.top || []).slice(1, 7);
  if (!cards.length) return '';
  return '<section class="hv-block">'+homeSection('I tuoi pezzi forti', homeLink('market', 'Market'))+
    '<div class="hv-strip" role="list">'+cards.map(card => '<button type="button" class="hv-tile" role="listitem" data-page="market" aria-label="'+esc(card.cardName+' · '+marketMoney(card.price))+'">'+cardImage(card)+'<b>'+marketMoney(card.price)+'</b><small class="hv-tile-name">'+esc(card.cardName)+'</small>'+priceChange(card)+'</button>').join('')+'</div></section>';
}

function loansPanel(loans) {
  const status = { pending:'In attesa', requested:'Richiesta', reserved:'Riservata', active:'Attivo', return_pending:'Da restituire' };
  const rows = loans.map(loan => {
    const other = member(loan.borrower)?.name || member(loan.owner)?.name || 'Team';
    return '<button type="button" class="hv-ticket is-ok" data-page="loans"><span class="hv-ticket-art">'+(loan.image ? '<img src="'+esc(loan.image)+'" alt="" loading="lazy">' : icon('card'))+'</span><span><strong>'+esc(loan.cardName)+'</strong><small>'+esc(String(other).split(' ')[0])+' · '+loan.quantity+'×</small></span><em>'+(status[loan.status] || 'Attivo')+'</em></button>';
  }).join('');
  return '<section class="hv-block">'+homeSection('Prestiti attivi', homeLink('loans', 'Gestisci'))+
    (rows ? '<div class="hv-list">'+rows+'</div>' : '<p class="hv-empty">Nessun prestito in corso.</p>')+
    '<button type="button" class="btn hv-cta" data-page="new">'+icon('plus')+' Nuovo prestito</button></section>';
}

function activityPanel(loans) {
  const labels = { pending:'Richiesta', requested:'Richiesta', reserved:'Riservata', active:'Prestito', return_pending:'Rientro', returned:'Restituita', completed:'Concluso', rejected:'Rifiutata' };
  const rows = loans.map(loan => {
    const owner = member(loan.owner)?.name?.split(' ')[0] || '', borrower = member(loan.borrower)?.name?.split(' ')[0] || '';
    return '<p><time>'+formatDate(loan.createdAt)+'</time><span><b>'+(labels[loan.status] || 'Aggiornato')+'</b> '+esc(loan.cardName)+(owner || borrower ? ' · '+esc(owner)+' → <em>'+esc(borrower)+'</em>' : '')+'</span></p>';
  }).join('');
  return '<section class="hv-block">'+homeSection('Attività del team', homeLink('loans', 'Tutte'))+
    (rows ? '<div class="hv-log">'+rows+'</div>' : '<p class="hv-empty">I movimenti del team compariranno qui.</p>')+'</section>';
}

// Ripieghi delle immagini della Home (carta intera → proxy → immagine salvata).
export function bindHomeImages(root = document) {
  for (const img of root.querySelectorAll('img[data-card-fallbacks]')) {
    if (img.dataset.fallbackBound) continue;
    img.dataset.fallbackBound = 'true';
    img.addEventListener('error', () => {
      let rest = []; try { rest = JSON.parse(img.dataset.cardFallbacks || '[]'); } catch { rest = []; }
      if (rest.length) { img.dataset.cardFallbacks = JSON.stringify(rest.slice(1)); img.src = rest[0]; return; }
      img.removeAttribute('data-card-fallbacks'); img.hidden = true;
    });
  }
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
export function featuredPanel(market) {
  if (market.overview && Array.isArray(market.overview.top) && market.overview.top.length) return vetrinaPanel(market);
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
// "Vetrina" (2026-10-25, scelta dall'utente fra 3 mockup, nello stile
// Millennium di questa card). Sostituisce il carosello "in crescita %": la
// carta da 0,02 € passata a 0,09 € (+400%) non dice niente. Dati da
// market.overview (RPC get_market_dashboard_overview, precalcolata ogni notte):
// la carta più preziosa in evidenza, le altre 4 in fila, il valore della
// collezione con la variazione A PARITÀ DI CARTE, chi ha mosso il valore in
// euro sulle copie possedute (≥1 €, ≥0,50 €/copia, mai prezzi stimati), segnali.
// Senza overview (migration non applicata, membro nuovo) resta il carosello.
// data-featured-track sulla radice: bindDashboardCarousel() aggancia così il
// fallback degli artwork (con una sola "slide" non attiva la navigazione).
function vetrinaPanel(market) {
  const o = market.overview, [hero, ...shelf] = o.top, history = market.featuredHistory instanceof Map ? market.featuredHistory.get(hero.printingId) || [] : [];
  const value = Number.isFinite(market.portfolioValue) && market.portfolioValue > 0 ? market.portfolioValue : o.value;
  const heading = MILLENNIUM_CORNERS+'<div class="market-featured-head"><h2>Market Watch</h2><button class="text-action" data-page="market">Vedi mercato '+icon('arrow')+'</button></div>';
  const past = Number(hero.price30) > 0 ? { price: hero.price30, label: '30 giorni fa' } : Number(hero.price7) > 0 ? { price: hero.price7, label: '7 giorni fa' } : null;
  const heroMeta = [hero.setCode, hero.rarity, copies(hero.quantity)].filter(Boolean).map(esc).join(' &#183; ');
  const heroCard = '<button type="button" class="mv-hero" data-page="market" aria-label="Apri Market Watch: '+esc(hero.cardName)+'">'+
    '<span class="mv-art mv-hero-art">'+artwork(hero, 'eager')+'<span class="mv-scrim" aria-hidden="true"></span>'+
      '<span class="mv-badge">La tua carta più preziosa</span>'+(hero.estimated?'<span class="mv-badge mv-badge-estimate">Prezzo stimato</span>':'')+
      '<span class="mv-hero-copy">'+
        '<strong class="mv-hero-name">'+esc(hero.cardName)+'</strong>'+(heroMeta?'<span class="mv-hero-meta">'+heroMeta+'</span>':'')+
        '<span class="mv-hero-price"><b>'+marketMoney(hero.price)+'</b>'+(past?'<small>'+marketMoney(past.price)+' '+past.label+'<br>'+percent((hero.price/past.price-1)*100)+'</small>':'')+'</span>'+
      '</span>'+
    '</span>'+heroChart(history)+'</button>';
  const shelfRow = shelf.length ? '<div class="mv-shelf" role="list" aria-label="Le altre carte di valore">'+shelf.slice(0, 4).map(card =>
    '<button type="button" class="mv-shelf-card" role="listitem" data-page="market" aria-label="'+esc(card.cardName+' · '+marketMoney(card.price))+'">'+
      '<span class="mv-art mv-shelf-art">'+artwork(card)+'</span><b>'+marketMoney(card.price)+'</b></button>').join('')+'</div>' : '';
  const week = changeOf(o.change7), month = changeOf(o.change30);
  const valueRow = '<div class="mv-value"><div><span>Collezione</span><strong>'+marketMoney(value)+'</strong></div>'+
    '<div class="mv-value-change">'+(week?'<strong class="'+trendClass(week.eur)+'">'+signedMoney(week.eur)+' in 7 gg</strong>':'<strong class="mv-flat">Variazione dalla prossima settimana</strong>')+
    (month?'<span>'+signedMoney(month.eur)+' in 30 gg ('+percent(month.pct)+')</span>':week?'<span>'+percent(week.pct)+' sulle carte già prezzate</span>':'')+'</div></div>';
  const movers = (o.movers || []).length ? '<div class="mv-section"><h3>Questa settimana</h3><div class="mv-movers">'+o.movers.map(item =>
    '<button type="button" class="mv-mover" data-page="market" aria-label="'+esc(item.cardName+' · '+signedMoney(item.deltaEur))+'">'+
      '<span class="mv-art mv-mover-art">'+artwork(item)+'</span>'+
      '<span class="mv-mover-copy"><strong>'+esc(item.cardName)+'</strong><small>'+esc(copies(item.quantity))+' &#183; '+marketMoney(item.price)+(item.quantity>1?' a copia':'')+'</small>'+
      '<b class="'+trendClass(item.deltaEur)+'">'+signedMoney(item.deltaEur)+'</b></span></button>').join('')+'</div></div>'
    : '<p class="mv-quiet">Settimana tranquilla: nessuna carta da almeno 1 € si è mossa di più di 0,50 €.</p>';
  // "Da sapere" a lista compatta (richiesta 2026-10-25: niente pulsanti a pillola).
  const s = o.signals || {}, signalRow = (tone, title, detail, value) =>
    '<button type="button" class="mv-signal mv-signal-'+tone+'" data-page="market"><span class="mv-signal-dot" aria-hidden="true"></span>'+
    '<span class="mv-signal-text"><strong>'+title+'</strong>'+(detail?'<small>'+detail+'</small>':'')+'</span>'+
    '<b class="mv-signal-value">'+value+'</b><span class="mv-signal-go" aria-hidden="true">&#8250;</span></button>';
  const chips = [
    s.aboveMonthAverage > 0 ? signalRow('up', 'Carte STONKS', 'Prezzo almeno 20% sopra la media a 30 giorni', wholeNumber(s.aboveMonthAverage)+(s.aboveMonthAverage===1?' carta':' carte')) : '',
    s.duplicatesValue > 0 ? signalRow('dupes', 'Doppioni di valore', esc((s.duplicates||[]).map(d => d.cardName+' ×'+d.quantity).join(', ')), marketMoney(s.duplicatesValue)) : '',
  ].filter(Boolean);
  return '<section class="surface duel-panel featured-card-panel market-millennium market-vetrina" data-featured-track>'+heading+
    heroCard+shelfRow+valueRow+movers+
    (chips.length?'<div class="mv-section"><h3>Da sapere</h3><div class="mv-signals">'+chips.join('')+'</div></div>':'')+
  '</section>';
}
function artwork(item, loading = 'lazy') {
  const candidates = moverArtworkCandidates(item);
  const placeholder = '<span class="market-featured-art market-featured-art-placeholder"'+(candidates.length?' hidden':'')+'>'+icon('card')+'</span>';
  return candidates.length
    ? '<img class="market-featured-art'+(isFullCardImage(candidates[0])?' is-full-card':'')+'" data-art-fallback="'+esc(JSON.stringify(candidates.slice(1)))+'" src="'+esc(candidates[0])+'" alt="" loading="'+loading+'" decoding="async">'+placeholder
    : placeholder;
}
function changeOf(change) {
  const eur = Number(change?.eur), base = Number(change?.base);
  return change && Number.isFinite(eur) && base > 0 ? { eur, pct: eur / base * 100 } : null;
}
const copies = quantity => (Number(quantity) || 1) === 1 ? '1 copia' : wholeNumber(quantity)+' copie';
const trendClass = value => Number(value) > 0 ? 'mv-up' : Number(value) < 0 ? 'mv-down' : 'mv-flat';
// Segno esplicito e meno tipografico: "+3,76 €" / "−3,11 €".
function signedMoney(value) { const n = Number(value) || 0; return (n > 0 ? '+' : n < 0 ? '−' : '')+marketMoney(Math.abs(n)); }
function percent(value) { const n = Number(value) || 0; return (n > 0 ? '+' : n < 0 ? '−' : '')+new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1, minimumFractionDigits: Math.abs(n) < 10 ? 1 : 0 }).format(Math.abs(n))+'%'; }
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
  bindHomeImages(root);
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




