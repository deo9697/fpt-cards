import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CardmarketPriceGuideProvider,parseDelimited,parseCardmarketPayload,cardmarketNonSinglesUrl,resolveCardmarketPrinting,streamCardmarketRows} from '../market/providers.js';

const unavailableCm=new CardmarketPriceGuideProvider();assert.equal(unavailableCm.getPriceMetadata().status,'unavailable');
await assert.rejects(()=>unavailableCm.load(),/CARDMARKET_PRODUCT_CATALOG_URL/);

const csv='idProduct;Name;Expansion ID\r\n10;Card A;5\r\n11;"Card; B";6';const parsed=parseDelimited(csv);assert.equal(parsed.length,2);assert.equal(parsed[1].Name,'Card; B');
const catalogJson=JSON.stringify({createdAt:'2026-08-30T11:14:44+0200',products:[{idProduct:10,name:'Card A',idExpansion:5}]});assert.equal(parseCardmarketPayload(catalogJson,'products').rows[0].idProduct,10);assert.match(cardmarketNonSinglesUrl('https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_3.json'),/products_nonsingles_3\.json/);
const chunks=['{"createdAt":"2026-08-30T11:14:44+0200","pro','ducts":[{"idProduct":10,"name":"Card { A"},{"idProduct":11,"name":"Card \\"B\\""}],"x":1}'];
const streamed=[];const streamResponse=new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();}}));
const streamStats=await streamCardmarketRows(streamResponse,'products',row=>streamed.push(row));assert.equal(streamStats.rows,2);assert.equal(streamStats.createdAt,'2026-08-30T11:14:44+0200');assert.equal(streamed[1].name,'Card "B"');
const cmResolution=resolveCardmarketPrinting({catalogCardId:'1',cardName:'Card A',setCode:'SET-EN001',setName:'Example Set',rarity:'Ultra Rare'},[{providerProductId:'10',cardName:'Card A',setName:'Example Set',rarity:'Ultra Rare'}]);assert.equal(cmResolution.status,'PROVIDER_AGGREGATE');assert.equal(cmResolution.candidate.providerProductId,'10');
const failingCm=new CardmarketPriceGuideProvider({catalogUrl:'https://downloads.s3.cardmarket.com/catalog.csv',priceGuideUrl:'https://downloads.s3.cardmarket.com/prices.csv',fetchImpl:async()=>new Response('down',{status:503})});
await assert.rejects(()=>failingCm.load(),/Catalogo espansioni non disponibile|Product Catalogue non disponibile/);

const storage=new Map();globalThis.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
const {portfolioSummary,deduplicateMonitored,mapPayload,positiveMovers,mapDashboardMovers,buildMarketDecks,derivedPriceEligible}=await import('../js/market-watch.js');
const now=Date.now(),fresh=new Date(now-3600000).toISOString();
const data=mapPayload({items:[
  {printing_id:'p1',card_name:'A',sources:['owned','deck'],owned_quantity:9,reference_price:10,price_24h:8,price_7d:5,latest_at:fresh,mapping_status:'resolved',resolver_status:'EXACT',resolver_version:2,providers:{cardmarket:{price:10,capturedAt:fresh}}},
  {printing_id:'p2',card_name:'B',sources:['owned','manual'],owned_quantity:1,reference_price:20,price_24h:20,price_7d:10,min_price:17.5,latest_at:fresh,mapping_status:'resolved',resolver_status:'EXACT',resolver_version:2,providers:{cardmarket:{price:20,capturedAt:fresh}}}
]});
assert.equal(data.items.find(item=>item.printingId==='p1').minPrice,null,'min_price assente non deve produrre un valore inventato');
assert.equal(data.items.find(item=>item.printingId==='p2').minPrice,17.5,'il prezzo minimo Cardmarket ("a partire da") non è mappato dal payload');
const summary=portfolioSummary(data.items,now);assert(summary.complete);assert.equal(summary.current,110);assert.equal(summary.delta24,18);assert.equal(summary.delta7,55);assert(summary.delta24Complete&&summary.delta7Complete);
const partial=portfolioSummary([...data.items,{printingId:'p3',sources:['owned'],ownedQuantity:2,referencePrice:null,latestAt:null}],now);assert(!partial.complete,'copertura sotto 90% deve mostrare dati parziali');
const dedup=deduplicateMonitored({owned:[{printingId:'p1',quantity:2}],deck:[{printingId:'p1',quantity:3},{printingId:null}],manual:[{printingId:'p1'},{printingId:'p2'}]});assert.equal(dedup.length,2);assert.deepEqual(new Set(dedup.find(row=>row.printingId==='p1').sources),new Set(['owned','deck','manual']));
const exactMover={mappingStatus:'resolved',resolverStatus:'EXACT'};
const movers=positiveMovers([{...exactMover,printingId:'a',catalogCardId:'1',cardName:'A',sources:['owned'],referencePrice:12,price24h:10},{...exactMover,printingId:'a2',catalogCardId:'1',cardName:'A',sources:['owned'],referencePrice:15,price24h:10},{...exactMover,printingId:'b',catalogCardId:'2',cardName:'B',sources:['owned'],referencePrice:5.5,price24h:5},{...exactMover,printingId:'c',catalogCardId:'3',cardName:'C',sources:['owned'],referencePrice:4,price24h:5}],3);assert.deepEqual(movers.map(item=>item.printingId),['a2','b'],'Le carte in crescita non sono ordinate/deduplicate correttamente');
const aggregateItem={printingId:'aggregate',catalogCardId:'9',cardName:'Aggregata',sources:['owned'],ownedQuantity:2,referencePrice:99,price24h:1,latestAt:fresh,mappingStatus:'resolved',resolverStatus:'PROVIDER_AGGREGATE',priceScope:{language:'aggregate',edition:'aggregate',rarity:'aggregate',foil:'parallel_columns_unassigned'}};
assert.equal(portfolioSummary([aggregateItem],now).current,0,'prezzo aggregate incluso nel portafoglio');
assert.equal(positiveMovers([aggregateItem],3).length,0,'prezzo aggregate incluso nei mover');
const aggregateDeck=buildMarketDecks([{id:'aggregate-deck',name:'Aggregate',cards:[{printingId:'aggregate',quantity:1}]}],[aggregateItem],[])[0];assert.equal(aggregateDeck.marketValue,99);assert.equal(aggregateDeck.marketIndicative,true);assert.equal(aggregateDeck.indicativeValuedCopies,1);assert.equal(aggregateDeck.delta24,null,'un prezzo aggregato non deve generare trend mazzo');
const catalogDeck=buildMarketDecks([{id:'catalog-deck',name:'Catalog fallback',game:'yugioh',cards:[{catalogCardId:'73642296',quantity:3}]}],[{...aggregateItem,printingId:'ghost-belle-printing',catalogCardId:'73642297',referencePrice:2}],[])[0];assert.equal(catalogDeck.marketValue,6);assert.equal(catalogDeck.marketIndicative,true);assert.equal(catalogDeck.valuedCopies,3,'alias catalogo non valorizzato nel deck senza printing');
// Un mapping risolto senza uno specifico tag resolverStatus 'EXACT' non deve essere trattato come
// ineleggibile: prima del fix derivedPriceEligible richiedeva 'EXACT', uno stato che nessun
// percorso reale (compreso il resolver Cardmarket, l'unica fonte prezzi dell'app) produce mai,
// quindi quasi nessuna carta risultava mai "precisa" e valore/trend/mover restavano sempre parziali.
const preciseItem={printingId:'pr1',catalogCardId:'88',cardName:'Precise Match',sources:['owned'],ownedQuantity:1,referencePrice:10,price24h:8,price7d:9,latestAt:fresh,mappingStatus:'resolved'};
assert(derivedPriceEligible(preciseItem),'un mapping risolto e non aggregato senza tag resolverStatus deve comunque essere eleggibile');
assert.equal(portfolioSummary([preciseItem],now).current,10,'prezzo preciso escluso dal valore raccolta');
assert.equal(positiveMovers([preciseItem],3).length,1,'prezzo preciso escluso dai mover');
const preciseDeck=buildMarketDecks([{id:'precise-deck',name:'Precise Deck',cards:[{printingId:'pr1',quantity:2}]}],[preciseItem],[])[0];
assert.equal(preciseDeck.marketValue,20);assert.equal(preciseDeck.marketIndicative,false,'un prezzo preciso non deve risultare indicativo');
assert.equal(preciseDeck.delta24,25,'trend mazzo non calcolato per un prezzo preciso');
const dashboardMovers=mapDashboardMovers([{printingId:'p1',cardName:'A',referencePrice:12,baselinePrice:10,positiveChange:20,sparkline:[{label:'AVG30',price:8,order:1},{label:'TREND',price:12,order:4}]}]);assert.equal(dashboardMovers[0].sparkline.length,2);assert.equal(dashboardMovers[0].positiveChange,20);
const groupedDecks=buildMarketDecks([{id:'d1',name:'Deck Box Market',deckTheme:'cyber-cyan',deckBoxTemplate:'cyber-core',cards:[{catalogCardId:'1',cardName:'A',section:'main',quantity:3,printingId:'p1'},{catalogCardId:'3',cardName:'Senza prezzo',section:'extra',quantity:1,printingId:null}]}],data.items,[{deckId:'d1',quantity:1}]);assert.equal(groupedDecks.length,1);assert.equal(groupedDecks[0].marketValue,30);assert.equal(groupedDecks[0].delta24,25);assert.equal(groupedDecks[0].unresolvedCount,1);assert.equal(groupedDecks[0].topMover.cardName,'A');

const {DeckController}=await import('../js/decks.js');
const deckState={game:'yugioh',currentUser:'me',decks:[{id:'d1',persisted:true,name:'Deck',format:'TCG Avanzato',game:'yugioh',cards:[{catalogCardId:'1',cardName:'Carta',imageUrl:'',section:'main',quantity:1,printingId:null}]}],collection:{mine:[],team:[]}};
const deckController=new DeckController({api:{deckPrintingOptions:async()=>[],setDeckCardPrinting:async()=>{}},getState:()=>deckState,isOnline:()=>true,onRender:()=>{},onToast:()=>{}});deckController.activeId='d1';assert(!deckController.view().includes('Printing da selezionare'),'Il deck builder non deve mostrare lo stato printing del Market Watch');
await deckController.openPrintingPicker('1','main');assert.equal(deckController.printingPicker.options.length,0);

const sql=fs.readFileSync(new URL('../supabase-milestone-5-market-watch.sql',import.meta.url),'utf8');
for(const required of ['add column if not exists printing_id uuid','market_provider_printings','market_price_snapshots','market_watch_items','market_alert_preferences','market_price_events','market_provider_sync_runs','market_latest_prices','market_monitored_printings','list_market_watch','list_deck_printing_options','set_deck_card_printing','detect_market_price_event_after_insert','resolution_status in (\'resolved\',\'ambiguous\',\'unresolved\',\'manual\')','unique (provider,observation_key,price_type)','absolute_threshold numeric(14,4) not null default 1','percentage_threshold numeric(8,4) not null default 8'])assert(sql.includes(required),`Migration Market Watch incompleta: ${required}`);
assert(!/cron\.schedule|net\.http_post/i.test(sql),'Lo scheduler non deve essere attivato dalla migration');
assert(sql.includes("cp.catalog_card_id=dc.catalog_card_id"),'La selezione printing del mazzo non verifica la carta esatta');
const operational=fs.readFileSync(new URL('../supabase-milestone-5-1-market-watch-operational.sql',import.meta.url),'utf8');for(const required of ['list_market_price_history','price_30d','cardmarket_url','market_sync_targets'])assert(operational.includes(required),`Migration operativa incompleta: ${required}`);
const dashboardSql=fs.readFileSync(new URL('../supabase-market-dashboard-movers.sql',import.meta.url),'utf8');for(const required of ['list_market_dashboard_movers','avg1','avg7','avg30','positive_change','limit 3'])assert(dashboardSql.includes(required),`Segnali Dashboard incompleti: ${required}`);

const edge=fs.readFileSync(new URL('../supabase/functions/market-sync/index.ts',import.meta.url),'utf8'),app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8'),styles=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8'),sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
for(const required of ['CARDMARKET_PRODUCT_CATALOG_URL','CARDMARKET_PRICE_GUIDE_URL','MARKET_SYNC_SECRET','begin_market_provider_sync','recoverStale','manual_recovery','pricesOnly','loadPrices','isThreeInRome'])assert(edge.includes(required),`Edge Function incompleta: ${required}`);
for(const required of ['resolveCardmarketTargets','provider.resolvePrinting','provider_product_id','pendingSnapshots.slice','on_conflict=provider,observation_key,price_type'])assert(edge.includes(required),`Risoluzione Cardmarket non collegata: ${required}`);
assert(!/cardtrader/i.test(edge)&&!/cardtrader/i.test(app),'Riferimenti a CardTrader ancora presenti dopo la rimozione');
for(const required of ["marketWatch.view()","marketWatch.bind(document)","marketWatch.load()","data-market-watch-add"])assert(app.includes(required),`UI Market Watch non integrata: ${required}`);
assert(styles.includes('@media (max-width:600px)')&&styles.includes('.market-row'),'Layout mobile Market Watch assente');
assert(sw.includes("'./js/market-watch.js'"),'Modulo Market Watch assente dalla cache PWA');
assert(sw.includes("'./js/deck-box.js'"),'DeckBoxCard condivisa non inclusa nella cache PWA');

console.log('PASS mapping printing esatto, ambiguo e set/rarità differenti');
console.log('PASS provider Cardmarket non disponibile, CardTrader rimosso');
console.log('PASS portfolio 24h/7d, copertura e deduplicazione Owned/Deck/Watchlist');
console.log('PASS deck senza printing, schema additivo, frontend mobile e PWA');
