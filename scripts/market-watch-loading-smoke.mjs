import assert from 'node:assert/strict';
// 2026-09-11: list_market_watch (unica RPC, payload intero) sostituita da 4
// RPC mirate — vedi supabase/migrations/20260911145101_market_watch_owned_pagination.sql
// e js/market-watch.js. load() ora fa marketWatchExtra+marketWatchSummary in
// parallelo (piccoli, "main" ai fini di questo test) poi loadOwnedPage() per
// la tab Raccolta (paginata davvero, non più uno slice locale di un array
// già interamente scaricato). window va stubbato PRIMA dell'import di
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

const extraD=deferred(),summaryD=deferred(),ownedD=deferred(),movers=deferred(),anomalies=deferred();
let ownedCalls=0,renders=0;
const controller=new MarketWatchController({getGame:()=>'yugioh',onRender:()=>renders++,api:{
  marketWatchExtra:()=>extraD.promise,marketWatchSummary:()=>summaryD.promise,
  marketWatchOwnedPage:()=>{ownedCalls++;return ownedD.promise;},
  marketDashboardMovers:()=>movers.promise,marketPriceAnomalies:()=>anomalies.promise
}});
const first=controller.load(),second=controller.load();
extraD.resolve(emptyExtraPayload());summaryD.resolve(emptySummaryPayload());
await flush();
ownedD.resolve({items:[{printing_id:'one',card_name:'Ready'}],total:1,limit:60,offset:0});
await Promise.all([first,second]);
assert.equal(controller.loading,false);
assert.equal(controller.ownedPage.items[0].cardName,'Ready');
assert(renders>0,'main data must render independently of accessory panels');
assert.equal(ownedCalls,1,'a second concurrent load() for the same game must share the in-flight request, not fetch the page twice');
anomalies.reject(new Error('optional unavailable'));movers.resolve([]);await flush();
assert.equal(controller.error,'');assert.deepEqual(controller.anomalies,[]);

// Il guard di generazione scatta già a livello di load() (extra/summary),
// prima ancora di arrivare a loadOwnedPage: una richiesta resa stale dal
// cambio gioco non arriva nemmeno a interrogare la propria pagina Raccolta.
let game='yugioh',ownedRequests=[];
const switching=new MarketWatchController({getGame:()=>game,api:{
  marketWatchExtra:async()=>emptyExtraPayload(),marketWatchSummary:async()=>emptySummaryPayload(),
  marketWatchOwnedPage:async g=>{ownedRequests.push(g);return g==='yugioh'?{items:[{printing_id:'old',card_name:'Yu-Gi-Oh'}],total:1,limit:60,offset:0}:{items:[{printing_id:'new',card_name:'One Piece'}],total:1,limit:60,offset:0};},
  marketDashboardMovers:async()=>[],marketPriceAnomalies:async()=>[]
}});
const stale=switching.load();game='onepiece';const latest=switching.load();
await Promise.all([stale,latest]);
assert.equal(switching.ownedPage.items[0].printingId,'new','stale game responses must not replace current data');
assert.deepEqual(ownedRequests,['onepiece'],'a load() made stale by a game switch must skip its owned-page fetch entirely, not just discard the result');
assert.equal(switching.loading,false);
console.log('PASS immediate main-list rendering, shared requests, optional failure and game-switch race');

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
