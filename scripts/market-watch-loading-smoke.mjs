import assert from 'node:assert/strict';
// 2026-09-11: list_market_watch (unica RPC, payload intero) sostituita da 4
// RPC mirate — vedi supabase/migrations/20260911145101_market_watch_owned_pagination.sql
// e js/market-watch.js.
// 2026-09-14 (P0 performance): owned_page (~2s, la più lenta) ora parte in
// PARALLELO a extra/summary invece che dopo — vedi load() in
// js/market-watch.js. window va stubbato PRIMA dell'import di
// js/market-watch.js (legge window.FPT_CONFIG a livello di modulo via la
// catena di import che porta a js/api.js).
globalThis.window ??= {addEventListener(){},FPT_CONFIG:undefined};
globalThis.localStorage ??= {getItem(){return null;},setItem(){}};
// refreshAfterLoad()/refreshBoardSection() cercano '[data-market-board-section]'
// nel DOM reale per aggiornare la pagina sul posto invece di un render pieno
// (vedi js/market-watch.js) — qui nessuna sezione è mai montata, quindi
// devono ricadere su onRender() come se il componente non fosse a schermo.
globalThis.document ??= {querySelector(){return null;},querySelectorAll(){return [];}};
const {MarketWatchController}=await import('../js/market-watch.js');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const emptyExtraPayload=()=>({items:[],deckUnresolved:[]});
const emptySummaryPayload=()=>({portfolioValue:{current:0,complete:false},confirmCount:0,aggregatePendingCount:0,catalogPriceFloor:{},lastSync:null});
const emptyOwnedPayload=()=>({items:[],total:0,limit:60,offset:0});

// 1) owned/summary/extra partono nello stesso tick logico: nessuno aspetta
//    gli altri per essere INVOCATO (non solo per essere applicato). Un solo
//    load() concorrente per lo stesso gioco condivide comunque la stessa
//    richiesta (dedup invariato).
{
  const extraD=deferred(),summaryD=deferred(),ownedD=deferred();
  let ownedCalls=0,extraCalls=0,summaryCalls=0;
  const controller=new MarketWatchController({getGame:()=>'yugioh',onRender:()=>{},api:{
    marketWatchExtra:()=>{extraCalls++;return extraD.promise;},marketWatchSummary:()=>{summaryCalls++;return summaryD.promise;},
    marketWatchOwnedPage:()=>{ownedCalls++;return ownedD.promise;},
    marketDashboardMovers:async()=>[],marketPriceAnomalies:async()=>[]
  }});
  const first=controller.load(),second=controller.load();
  await flush();
  assert.equal(extraCalls,1);assert.equal(summaryCalls,1);
  assert.equal(ownedCalls,1,'owned_page deve partire nello stesso giro di extra/summary, non dopo che si sono risolte');
  extraD.resolve(emptyExtraPayload());summaryD.resolve(emptySummaryPayload());ownedD.resolve(emptyOwnedPayload());
  await Promise.all([first,second]);
  assert.equal(ownedCalls,1,'un secondo load() concorrente per lo stesso gioco condivide la stessa richiesta, non ne fa doppie');
  console.log('PASS owned_page parte in parallelo a extra/summary (stesso tick), load() concorrenti condividono la richiesta');
}

// 2) owned_page può completare PRIMA di summary/extra e viene già mostrata
//    (refreshBoardSection — il refresh mirato riusato, mai un renderRoute
//    globale) senza aspettare gli altri due. document.querySelector è
//    stubbato a null in questo harness (nessuna sezione mai montata), quindi
//    refreshBoardSection() da sola non arriva a onRender() qui (fa solo un
//    innerHTML su una sezione reale, verificato invece dal test browser
//    market-watch-browser-smoke.mjs) — qui si verifica che VENGA CHIAMATA
//    appena owned_page è pronta, non che produca un render pieno.
{
  const extraD=deferred(),summaryD=deferred(),ownedD=deferred();
  const controller=new MarketWatchController({getGame:()=>'yugioh',onRender:()=>{},api:{
    marketWatchExtra:()=>extraD.promise,marketWatchSummary:()=>summaryD.promise,
    marketWatchOwnedPage:()=>ownedD.promise,
    marketDashboardMovers:async()=>[],marketPriceAnomalies:async()=>[]
  }});
  let boardRefreshes=0;const originalRefresh=controller.refreshBoardSection.bind(controller);
  controller.refreshBoardSection=()=>{boardRefreshes++;return originalRefresh();};
  const loadPromise=controller.load();
  ownedD.resolve({items:[{printing_id:'fast',card_name:'Fast Owned'}],total:1,limit:60,offset:0});
  await flush();
  assert.equal(controller.ownedPage.items[0]?.cardName,'Fast Owned','owned_page applicata subito, senza aspettare extra/summary');
  assert(boardRefreshes>0,'refreshBoardSection() (il refresh mirato riusato) deve scattare appena owned_page è pronta, non solo a fine load()');
  assert.equal(controller.summary.lastSync,null,'summary non è ancora arrivata: nessun dato inventato nel frattempo');
  extraD.resolve(emptyExtraPayload());summaryD.resolve(emptySummaryPayload());
  await loadPromise;
  console.log('PASS owned_page completata prima di summary viene visualizzata subito (refreshBoardSection), senza attendere');
}

// 3) summary/extra possono fallire senza cancellare una ownedPage valida
//    (owned riuscita nello stesso giro): l'errore si vede, la lista resta.
{
  const controller=new MarketWatchController({getGame:()=>'yugioh',onRender:()=>{},api:{
    marketWatchExtra:async()=>{throw new Error('extra down');},
    marketWatchSummary:async()=>{throw new Error('extra down');},
    marketWatchOwnedPage:async()=>({items:[{printing_id:'ok',card_name:'Still Fine'}],total:1,limit:60,offset:0}),
    marketDashboardMovers:async()=>[],marketPriceAnomalies:async()=>[]
  }});
  await controller.load();
  assert.equal(controller.ownedPage.items[0]?.cardName,'Still Fine','un fallimento di extra/summary non deve svuotare una ownedPage riuscita');
  assert.equal(controller.error,'extra down','l\'errore di extra/summary resta visibile anche se owned_page è andata bene');
  console.log('PASS il fallimento di summary/extra non cancella una ownedPage già valida');
}

// 4) Race di fusione errori: owned_page fallisce, extra/summary riescono
//    DOPO — il successo dell'uno non deve mai cancellare l'errore genuino
//    dell'altro solo perché arrivato più tardi (motivo di
//    extraSummaryError/ownedPageError/syncError() in js/market-watch.js).
{
  const extraD=deferred(),summaryD=deferred();
  const controller=new MarketWatchController({getGame:()=>'yugioh',onRender:()=>{},api:{
    marketWatchExtra:()=>extraD.promise,marketWatchSummary:()=>summaryD.promise,
    marketWatchOwnedPage:async()=>{throw new Error('owned down');},
    marketDashboardMovers:async()=>[],marketPriceAnomalies:async()=>[]
  }});
  const loadPromise=controller.load();
  await flush();
  assert.equal(controller.error,'owned down','owned_page ha fallito per prima: l\'errore deve essere già visibile');
  extraD.resolve(emptyExtraPayload());summaryD.resolve(emptySummaryPayload());
  await loadPromise;
  assert.equal(controller.error,'owned down','un successo di extra/summary arrivato dopo non deve cancellare l\'errore genuino di owned_page');
  console.log('PASS un successo tardivo di extra/summary non cancella un errore genuino di owned_page arrivato prima');
}

// 5) Movers/anomalies restano non bloccanti e opzionali: un fallimento non
//    tocca error/ownedPage, il rendering principale non li aspetta.
{
  const extraD=deferred(),summaryD=deferred(),ownedD=deferred(),movers=deferred(),anomalies=deferred();
  let renders=0;
  const controller=new MarketWatchController({getGame:()=>'yugioh',onRender:()=>renders++,api:{
    marketWatchExtra:()=>extraD.promise,marketWatchSummary:()=>summaryD.promise,marketWatchOwnedPage:()=>ownedD.promise,
    marketDashboardMovers:()=>movers.promise,marketPriceAnomalies:()=>anomalies.promise
  }});
  const loadPromise=controller.load();
  extraD.resolve(emptyExtraPayload());summaryD.resolve(emptySummaryPayload());
  ownedD.resolve({items:[{printing_id:'one',card_name:'Ready'}],total:1,limit:60,offset:0});
  await loadPromise;
  assert.equal(controller.loading,false);
  assert.equal(controller.ownedPage.items[0].cardName,'Ready');
  assert(renders>0,'main data must render independently of accessory panels');
  anomalies.reject(new Error('optional unavailable'));movers.resolve([]);await flush();
  assert.equal(controller.error,'');assert.deepEqual(controller.anomalies,[]);
  console.log('PASS movers/anomalies restano non bloccanti e il loro fallimento non tocca error/ownedPage');
}

// 6) Cambio gioco durante il fetch: il guard di generazione scarta SEMPRE
//    la risposta stale (per extra/summary come per owned_page), qualunque
//    sia l'ordine di arrivo delle risposte di rete. Trade-off esplicito di
//    questo fix (P0 performance, vedi commento in js/market-watch.js:load()):
//    owned_page ora parte SUBITO insieme a extra/summary, quindi una
//    richiesta resa stale da un cambio gioco fulmineo può comunque aver già
//    interrogato la propria pagina Raccolta (prima la sequenzialità la
//    saltava del tutto) — quello che DEVE restare vero è che il risultato
//    finale rifletta SEMPRE e SOLO l'ultimo gioco selezionato, mai un mix.
{
  let game='yugioh',ownedRequests=[];
  const switching=new MarketWatchController({getGame:()=>game,onRender:()=>{},api:{
    marketWatchExtra:async()=>emptyExtraPayload(),marketWatchSummary:async()=>emptySummaryPayload(),
    marketWatchOwnedPage:async g=>{ownedRequests.push(g);return g==='yugioh'?{items:[{printing_id:'old',card_name:'Yu-Gi-Oh'}],total:1,limit:60,offset:0}:{items:[{printing_id:'new',card_name:'One Piece'}],total:1,limit:60,offset:0};},
    marketDashboardMovers:async()=>[],marketPriceAnomalies:async()=>[]
  }});
  const stale=switching.load();game='onepiece';const latest=switching.load();
  await Promise.all([stale,latest]);
  // La richiesta owned_page del gioco vecchio parte comunque (trade-off
  // esplicito, vedi commento sopra): quello che conta è che il suo
  // risultato non sostituisca MAI quello del gioco corrente nello stato finale.
  assert(ownedRequests.includes('yugioh'),'la richiesta stale parte comunque (trade-off accettato per il P0 performance)');
  assert.equal(switching.ownedPage.items[0].printingId,'new','ma il suo risultato non deve mai sostituire quello del gioco corrente');
  assert.equal(switching.loading,false);
  console.log('PASS un cambio gioco durante il fetch non sporca mai lo stato finale, anche se la richiesta stale parte comunque');
}

// Paginazione reale: ogni pagina è una richiesta di rete separata con offset
// crescente (niente più slice locale di un array di 2132 righe già in
// memoria) — "Mostra altre" deve incrementare offset ed accodare.
let pageCalls=[];
const paged=new MarketWatchController({getGame:()=>'yugioh',api:{
  marketWatchExtra:async()=>emptyExtraPayload(),marketWatchSummary:async()=>emptySummaryPayload(),
  marketWatchOwnedPage:async(game,opts)=>{pageCalls.push({...opts});
    const total=2132,start=opts.offset,items=Array.from({length:Math.min(60,total-start)},(_,i)=>({printing_id:`card-${start+i}`,card_name:`Card ${start+i}`}));
    return {items,total,limit:60,offset:start};
  },
  marketDashboardMovers:async()=>[],marketPriceAnomalies:async()=>[]
}});
await paged.load();
assert.equal(pageCalls.length,1,'initial load must fetch only the first page, not the whole set');
assert.equal(pageCalls[0].offset,0);
assert.equal(paged.ownedPage.items.length,60);
assert.equal(paged.ownedPage.total,2132);
let html=paged.rows(paged.itemsForTab(),[]);
assert.equal((html.match(/data-market-card=/g)||[]).length,60);
assert(html.includes('60/2132'));
let more;
paged.observeRows=()=>{};
paged.bindBoardContent({querySelector:()=>({addEventListener:(_,callback)=>{more=callback;}}),querySelectorAll:()=>[]});
more();await flush();
assert.equal(pageCalls.length,2,'"Mostra altre" must issue a real second network request');
assert.equal(pageCalls[1].offset,60,'the second page request must use the accumulated offset, not restart from 0');
assert.equal(paged.ownedPage.items.length,120,'the second page must be appended to the first, not replace it');
console.log('PASS bounded initial page, real "show more" network request with incremented offset');

// Ordina/cerca sulla tab Raccolta sono parametri della richiesta, non un
// filtro locale: cambiarli deve ripartire da offset 0 con reset=true.
paged.sort='price';await paged.loadOwnedPage({reset:true});
assert.equal(pageCalls.at(-1).sort,'price');assert.equal(pageCalls.at(-1).offset,0);
assert.equal(paged.ownedPage.items.length,60,'a sort change must replace the page, not append to the previous one');
paged.query='Card 2000';await paged.loadOwnedPage({reset:true});
assert.equal(pageCalls.at(-1).query,'Card 2000');assert.equal(pageCalls.at(-1).offset,0);
console.log('PASS sort/search on the owned tab re-fetch server-side instead of filtering an in-memory array');

// Timeout transitorio: un solo retry automatico, poi si arrende; i dati già
// mostrati restano quando un refresh (reset incluso) fallisce, non vengono
// cancellati subito solo perché è ripartito da offset 0 (vedi fix
// js/market-watch.js:loadOwnedPage — reset non svuota più ownedPage prima
// del tentativo, solo alla riuscita).
let retryCalls=0;
const timeout=()=>Object.assign(new Error('canceling statement due to statement timeout'),{code:'57014'});
const retry=new MarketWatchController({getGame:()=>'yugioh',api:{
  marketWatchExtra:async()=>emptyExtraPayload(),marketWatchSummary:async()=>emptySummaryPayload(),
  marketDashboardMovers:async()=>[],marketPriceAnomalies:async()=>[],
  marketWatchOwnedPage:async()=>{if(++retryCalls===1)throw timeout();return {items:[{printing_id:'recovered',card_name:'Recovered'}],total:1,limit:60,offset:0};}
}});
await retry.load();assert.equal(retryCalls,2);assert.equal(retry.error,'');
assert.equal(retry.ownedPage.items[0].printingId,'recovered');
retryCalls=0;retry.api.marketWatchOwnedPage=async()=>{retryCalls++;throw timeout();};
await retry.loadOwnedPage({reset:true});
assert.equal(retryCalls,2,'persistent timeouts must not retry indefinitely');
assert.equal(retry.ownedPage.items[0]?.printingId,'recovered','keep the previously shown page when a background refresh fails');
assert.match(retry.error,/Riprova tra poco/);assert(!retry.error.includes('statement timeout'));
retryCalls=0;retry.api.marketWatchOwnedPage=async()=>{retryCalls++;throw new Error('Sessione scaduta');};
await retry.loadOwnedPage({reset:true});
assert.equal(retryCalls,1,'a non-timeout error must not be retried');
assert.equal(retry.error,'Sessione scaduta');
console.log('PASS transient timeout recovery, bounded retries, retained page and visible persistent errors');
