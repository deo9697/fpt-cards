import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CardTraderProvider,CardmarketPriceGuideProvider,resolveExactPrinting,parseDelimited,parseCardmarketPayload,cardmarketNonSinglesUrl,resolveCardmarketPrinting,streamCardmarketRows} from '../market/providers.js';

const exact={game:'yugioh',catalogCardId:'24224830',setCode:'DUDE-EN044',setName:'Duel Devastator',rarity:'Ultra Rare',language:'English',edition:'1st Edition',foil:true};
const candidates=[
  {id:'a',game:'yugioh',catalogCardId:'24224830',setCode:'DUDE-EN044',setName:'Duel Devastator',rarity:'Ultra Rare',language:'English',edition:'1st Edition',foil:true},
  {id:'b',game:'yugioh',catalogCardId:'24224830',setCode:'FLOD-EN065',setName:'Flames of Destruction',rarity:'Common',language:'English',edition:'1st Edition',foil:false}
];
let resolution=resolveExactPrinting(exact,candidates,'test');
assert.equal(resolution.status,'resolved');assert.equal(resolution.candidate.id,'a','stessa carta ma set diverso non deve essere selezionata');
resolution=resolveExactPrinting(exact,[candidates[0],{...candidates[0],id:'duplicate'}],'test');assert.equal(resolution.status,'ambiguous');
resolution=resolveExactPrinting(exact,[{...candidates[0],rarity:'Common'}],'test');assert.equal(resolution.status,'unresolved','rarità diversa non deve produrre mapping');
resolution=resolveExactPrinting(exact,[{...candidates[0],setCode:''}],'test');assert.equal(resolution.status,'unresolved','mapping senza set code non deve essere inventato');

const unavailableCt=new CardTraderProvider();assert.equal(unavailableCt.getPriceMetadata().status,'unavailable');
await assert.rejects(()=>unavailableCt.getCurrentPrice({providerBlueprintId:'1'}),/CARDTRADER_API_TOKEN/);
const unavailableCm=new CardmarketPriceGuideProvider();assert.equal(unavailableCm.getPriceMetadata().status,'unavailable');
await assert.rejects(()=>unavailableCm.load(),/CARDMARKET_PRODUCT_CATALOG_URL/);

let calls=0;const waits=[];
const cardTrader=new CardTraderProvider({token:'test-token',sleep:async ms=>waits.push(ms),fetchImpl:async()=>{
  calls++;if(calls===1)return new Response('rate limit',{status:429,headers:{'retry-after':'0.01'}});
  return new Response(JSON.stringify({'123':[
    {id:1,blueprint_id:123,quantity:2,price:{cents:390,currency:'EUR'},properties_hash:{condition:'Near Mint',foil:false}},
    {id:2,blueprint_id:123,quantity:1,price:{cents:410,currency:'EUR'},properties_hash:{condition:'Near Mint',foil:false}},
    {id:3,blueprint_id:123,quantity:1,price:{cents:100,currency:'EUR'},properties_hash:{condition:'Played',foil:false}}
  ]}),{status:200,headers:{'content-type':'application/json'}});
}});
const current=await cardTrader.getCurrentPrice({providerBlueprintId:'123',conditionReference:'Near Mint',foil:false});
assert.equal(calls,2);assert(waits.some(ms=>ms===10),'Retry-After non rispettato');assert.equal(current.availableQuantity,3);assert.equal(current.prices.find(row=>row.type==='lowest').value,3.9);assert.equal(current.prices.find(row=>row.type==='reference').value,4);

const csv='idProduct;Name;Expansion ID\r\n10;Card A;5\r\n11;"Card; B";6';const parsed=parseDelimited(csv);assert.equal(parsed.length,2);assert.equal(parsed[1].Name,'Card; B');
const catalogJson=JSON.stringify({createdAt:'2026-08-30T11:14:44+0200',products:[{idProduct:10,name:'Card A',idExpansion:5}]});assert.equal(parseCardmarketPayload(catalogJson,'products').rows[0].idProduct,10);assert.match(cardmarketNonSinglesUrl('https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_3.json'),/products_nonsingles_3\.json/);
const chunks=['{"createdAt":"2026-08-30T11:14:44+0200","pro','ducts":[{"idProduct":10,"name":"Card { A"},{"idProduct":11,"name":"Card \\"B\\""}],"x":1}'];
const streamed=[];const streamResponse=new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();}}));
const streamStats=await streamCardmarketRows(streamResponse,'products',row=>streamed.push(row));assert.equal(streamStats.rows,2);assert.equal(streamStats.createdAt,'2026-08-30T11:14:44+0200');assert.equal(streamed[1].name,'Card "B"');
const cmResolution=resolveCardmarketPrinting({catalogCardId:'1',cardName:'Card A',setCode:'SET-EN001',setName:'Example Set',rarity:'Ultra Rare'},[{providerProductId:'10',cardName:'Card A',setName:'Example Set',rarity:'Ultra Rare'}]);assert.equal(cmResolution.status,'resolved');assert.equal(cmResolution.candidate.providerProductId,'10');
const failingCm=new CardmarketPriceGuideProvider({catalogUrl:'https://downloads.s3.cardmarket.com/catalog.csv',priceGuideUrl:'https://downloads.s3.cardmarket.com/prices.csv',fetchImpl:async()=>new Response('down',{status:503})});
await assert.rejects(()=>failingCm.load(),/Catalogo espansioni non disponibile|Product Catalogue non disponibile/);

const storage=new Map();globalThis.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
const {portfolioSummary,deduplicateMonitored,providerWarning,mapPayload,positiveMovers,mapDashboardMovers}=await import('../js/market-watch.js');
const now=Date.now(),fresh=new Date(now-3600000).toISOString();
const data=mapPayload({items:[
  {printing_id:'p1',card_name:'A',sources:['owned','deck'],owned_quantity:9,reference_price:10,price_24h:8,price_7d:5,latest_at:fresh,providers:{cardtrader:{price:10,capturedAt:fresh}}},
  {printing_id:'p2',card_name:'B',sources:['owned','manual'],owned_quantity:1,reference_price:20,price_24h:20,price_7d:10,latest_at:fresh,providers:{cardmarket:{price:20,capturedAt:fresh}}}
]});
const summary=portfolioSummary(data.items,now);assert(summary.complete);assert.equal(summary.current,110);assert.equal(summary.delta24,18);assert.equal(summary.delta7,55);assert(summary.delta24Complete&&summary.delta7Complete);
const partial=portfolioSummary([...data.items,{printingId:'p3',sources:['owned'],ownedQuantity:2,referencePrice:null,latestAt:null}],now);assert(!partial.complete,'copertura sotto 90% deve mostrare dati parziali');
const dedup=deduplicateMonitored({owned:[{printingId:'p1',quantity:2}],deck:[{printingId:'p1',quantity:3},{printingId:null}],manual:[{printingId:'p1'},{printingId:'p2'}]});assert.equal(dedup.length,2);assert.deepEqual(new Set(dedup.find(row=>row.printingId==='p1').sources),new Set(['owned','deck','manual']));
assert.equal(providerWarning({cardtrader:{price:12},cardmarket:{price:20}}),67);assert.equal(providerWarning({cardtrader:{price:19},cardmarket:{price:20}}),null);
const movers=positiveMovers([{printingId:'a',catalogCardId:'1',cardName:'A',sources:['owned'],referencePrice:12,price24h:10},{printingId:'a2',catalogCardId:'1',cardName:'A',sources:['owned'],referencePrice:15,price24h:10},{printingId:'b',catalogCardId:'2',cardName:'B',sources:['owned'],referencePrice:5.5,price24h:5},{printingId:'c',catalogCardId:'3',cardName:'C',sources:['owned'],referencePrice:4,price24h:5}],3);assert.deepEqual(movers.map(item=>item.printingId),['a2','b'],'Le carte in crescita non sono ordinate/deduplicate correttamente');
const dashboardMovers=mapDashboardMovers([{printingId:'p1',cardName:'A',referencePrice:12,baselinePrice:10,positiveChange:20,sparkline:[{label:'AVG30',price:8,order:1},{label:'TREND',price:12,order:4}]}]);assert.equal(dashboardMovers[0].sparkline.length,2);assert.equal(dashboardMovers[0].positiveChange,20);

const {DeckController}=await import('../js/decks.js');
const deckState={game:'yugioh',currentUser:'me',decks:[{id:'d1',persisted:true,name:'Deck',format:'TCG Avanzato',game:'yugioh',cards:[{catalogCardId:'1',cardName:'Carta',imageUrl:'',section:'main',quantity:1,printingId:null}]}],collection:{mine:[],team:[]}};
const deckController=new DeckController({api:{deckPrintingOptions:async()=>[],setDeckCardPrinting:async()=>{}},getState:()=>deckState,isOnline:()=>true,onRender:()=>{},onToast:()=>{}});deckController.activeId='d1';assert(deckController.view().includes('Printing da selezionare'));
await deckController.openPrintingPicker('1','main');assert.equal(deckController.printingPicker.options.length,0);

const sql=fs.readFileSync(new URL('../supabase-milestone-5-market-watch.sql',import.meta.url),'utf8');
for(const required of ['add column if not exists printing_id uuid','market_provider_printings','market_price_snapshots','market_watch_items','market_alert_preferences','market_price_events','market_provider_sync_runs','market_latest_prices','market_monitored_printings','list_market_watch','list_deck_printing_options','set_deck_card_printing','detect_market_price_event_after_insert','resolution_status in (\'resolved\',\'ambiguous\',\'unresolved\',\'manual\')','unique (provider,observation_key,price_type)','absolute_threshold numeric(14,4) not null default 1','percentage_threshold numeric(8,4) not null default 8'])assert(sql.includes(required),`Migration Market Watch incompleta: ${required}`);
assert(!/cron\.schedule|net\.http_post/i.test(sql),'Lo scheduler non deve essere attivato dalla migration');
assert(sql.includes("cp.catalog_card_id=dc.catalog_card_id"),'La selezione printing del mazzo non verifica la carta esatta');
const operational=fs.readFileSync(new URL('../supabase-milestone-5-1-market-watch-operational.sql',import.meta.url),'utf8');for(const required of ['list_market_price_history','price_30d','cardmarket_url','market_sync_targets'])assert(operational.includes(required),`Migration operativa incompleta: ${required}`);
const dashboardSql=fs.readFileSync(new URL('../supabase-market-dashboard-movers.sql',import.meta.url),'utf8');for(const required of ['list_market_dashboard_movers','avg1','avg7','avg30','positive_change','limit 3'])assert(dashboardSql.includes(required),`Segnali Dashboard incompleti: ${required}`);

const edge=fs.readFileSync(new URL('../supabase/functions/market-sync/index.ts',import.meta.url),'utf8'),app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8'),styles=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8'),sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
for(const required of ['CARDTRADER_API_TOKEN','CARDMARKET_PRODUCT_CATALOG_URL','CARDMARKET_PRICE_GUIDE_URL','MARKET_SYNC_SECRET','begin_market_provider_sync','recoverStale','manual_recovery'])assert(edge.includes(required),`Edge Function incompleta: ${required}`);
for(const required of ['resolveCardmarketTargets','provider.resolvePrinting','provider_product_id','pendingSnapshots.slice','on_conflict=provider,observation_key,price_type'])assert(edge.includes(required),`Risoluzione Cardmarket non collegata: ${required}`);
assert(!app.includes('CARDTRADER_API_TOKEN'),'Il secret CardTrader è finito nel frontend');
for(const required of ["marketWatch.view()","marketWatch.bind(document)","marketWatch.load()","data-market-watch-add"])assert(app.includes(required),`UI Market Watch non integrata: ${required}`);
assert(styles.includes('@media (max-width:600px)')&&styles.includes('.market-row'),'Layout mobile Market Watch assente');
assert(sw.includes("'./js/market-watch.js'"),'Modulo Market Watch assente dalla cache PWA');

console.log('PASS mapping printing esatto, ambiguo e set/rarità differenti');
console.log('PASS provider unavailable, retry CardTrader e file Cardmarket non disponibile');
console.log('PASS portfolio 24h/7d, copertura e deduplicazione Owned/Deck/Watchlist');
console.log('PASS deck senza printing, schema additivo, frontend mobile e PWA');
