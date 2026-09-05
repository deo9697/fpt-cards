import {esc} from './core.js';
import {icon} from './icons.js';
import {renderDeckBoxCard,renderDeckBoxVisual} from './deck-box.js';
import {canonicalCatalogCardId} from './cards.js';

const TABS=['owned','deck','manual'];
const LABELS={owned:'Raccolta',deck:'Mazzi',manual:'Watchlist'};
const RANGES=[{days:7,label:'7g'},{days:30,label:'30g'},{days:90,label:'90g'},{days:365,label:'1a'}];
const FRESH_MS=48*60*60*1000;

export class MarketWatchController {
  constructor({api,getGame,getDecks,onRender,onToast,onNavigate}={}){Object.assign(this,{api,getGame,getDecks,onRender,onToast,onNavigate});this.data={items:[],deckUnresolved:[],lastSync:null};this.tab='owned';this.sort='value';this.loading=false;this.error='';this.selected='';this.selectedDeck='';this.history=new Map();this.featuredHistory=new Map();this.featuredLoading=new Set();this.featuredSync='';this.historyLoading=false;this.historyRange=30;this.loadInFlight=null;this.rowHistoryLoading=new Set();this.rowObserver=null;}
  async load(){if(this.loadInFlight)return this.loadInFlight;this.loading=true;const request=(async()=>{try{const game=this.getGame(),moversRequest=this.api.marketDashboardMovers?this.api.marketDashboardMovers(game).catch(()=>[]):Promise.resolve([]),[payload,movers]=await Promise.all([this.api.marketWatch(game),moversRequest]),next=mapPayload(payload);next.featuredMovers=mapDashboardMovers(movers);if(next.lastSync&&next.lastSync!==this.featuredSync){this.featuredHistory.clear();this.featuredSync=next.lastSync;}this.data=next;this.error='';void this.loadFeaturedHistories();}catch(error){this.error=/list_market_watch/i.test(error.message||'')?'Applica la migration Market Watch per attivare i dati.':(error.message||'Market Watch non disponibile');}finally{this.loading=false;}return this.data;})();this.loadInFlight=request;try{return await request;}finally{if(this.loadInFlight===request)this.loadInFlight=null;}}
  dashboardState(){return {...this.data,error:this.error,featuredHistory:this.featuredHistory};}
  async loadFeaturedHistories(){if(this.data.featuredMovers?.length)return;const missing=positiveMovers(this.data.items,3).filter(item=>!this.featuredHistory.has(item.printingId)&&!this.featuredLoading.has(item.printingId));if(!missing.length)return;missing.forEach(item=>this.featuredLoading.add(item.printingId));await Promise.all(missing.map(async item=>{try{const rows=await this.api.marketPriceHistory(item.printingId,30),history=(rows||[]).map(row=>({provider:row.provider,type:row.price_type||row.priceType,price:Number(row.price),capturedAt:row.captured_at||row.capturedAt})).filter(row=>row.provider==='cardmarket'&&row.type==='trend'&&Number.isFinite(row.price));this.featuredHistory.set(item.printingId,history);this.history.set(item.printingId,history);}catch{this.featuredHistory.set(item.printingId,[]);}finally{this.featuredLoading.delete(item.printingId);}}));this.onRender?.();}
  view(){const summary=portfolioSummary(this.data.items),items=sortItems(this.data.items.filter(item=>item.sources.includes(this.tab)),this.sort),unresolved=this.tab==='deck'?this.data.deckUnresolved:[],marketDecks=this.marketDecks(),hasSnapshots=this.data.items.some(item=>item.referencePrice!=null);
    return `<section class="page-stack market-page"><header class="market-hero"><div><span class="eyebrow">Valore e andamento</span><h1>Market Watch</h1><p>Segui le printing esatte della raccolta, dei mazzi e della watchlist.</p></div><div class="market-sync-state"><i class="${this.error?'error':this.data.lastSync?'ok':'waiting'}"></i><span><small>Ultimo aggiornamento</small><strong>${this.data.lastSync?formatTimestamp(this.data.lastSync):'In attesa del primo sync'}</strong></span></div></header>
      ${this.error?`<div class="connection-banner error"><span>${esc(this.error)}</span><button class="btn secondary small" data-market-retry>Riprova</button></div>`:''}
      <section class="market-kpis">
        ${kpi('Valore raccolta',summary.complete?money(summary.current):'Dati parziali',summary.complete?`${summary.coveredUnits}/${summary.totalUnits} copie valorizzate`:`Dati parziali · ${summary.coveredPrintings}/${summary.totalPrintings} printing valorizzate`,'value')}
        ${kpi('Variazione 24h',summary.delta24Complete?changeMoney(summary.delta24):'Dati parziali',summary.delta24Complete?changePercent(summary.delta24Percent):'Snapshot non sufficiente',tone(summary.delta24))}
        ${kpi('Variazione 7d',summary.delta7Complete?changeMoney(summary.delta7):'Dati parziali',summary.delta7Complete?changePercent(summary.delta7Percent):'Snapshot non sufficiente',tone(summary.delta7))}
        ${kpi('Printing monitorate',String(this.data.items.length),`${summary.freshPrintings} aggiornate entro 48h`,'count')}
      </section>
      <section class="surface market-board"><div class="market-board-tools"><nav class="market-tabs" aria-label="Filtri Market Watch">${TABS.map(tab=>`<button data-market-tab="${tab}" class="${this.tab===tab?'active':''}">${LABELS[tab]} <span>${countFor(this.data,tab,marketDecks.length)}</span></button>`).join('')}</nav><label>Ordina<select data-market-sort><option value="value" ${this.sort==='value'?'selected':''}>Valore posseduto</option><option value="price" ${this.sort==='price'?'selected':''}>Prezzo più alto</option><option value="change" ${this.sort==='change'?'selected':''}>Variazione 24h</option><option value="name" ${this.sort==='name'?'selected':''}>Nome</option></select></label></div>
        ${this.tab==='deck'?this.deckRows(marketDecks):!this.data.items.length?emptyNoCards():!hasSnapshots?`${emptyPreparing()}${this.rows(items,[])}`:this.rows(items,[])}
      </section>${this.selected?this.detailView():''}${this.selectedDeck?this.deckDetailView(marketDecks):''}</section>`;}
  rows(items,unresolved){return `<div class="market-list">${unresolved.map(unresolvedDeckRow).join('')}${items.map(item=>marketRow(item,this.history.get(item.printingId),this.tab)).join('')}${!items.length&&!unresolved.length?'<div class="market-tab-empty">Nessuna printing in questa sezione.</div>':''}</div>`;}
  marketDecks(){return buildMarketDecks(this.getDecks?.()||this.data.decks||[],this.data.items,this.data.deckUnresolved);}
  deckRows(decks){return decks.length?`<div class="market-deck-grid">${decks.map(deck=>renderDeckBoxCard(deck,{mode:'market',marketValue:deck.marketValue,marketIndicative:deck.marketIndicative,marketCoverage:`${deck.valuedCopies}/${deck.totalCopies} copie`,delta24:deck.delta24,delta7:deck.delta7,topMover:deck.topMover})).join('')}</div>`:'<div class="market-tab-empty">Nessun mazzo disponibile nel Market Watch.</div>';}
  deckDetailView(decks){const deck=decks.find(row=>String(row.id)===String(this.selectedDeck));if(!deck)return'';return `<div class="detail-backdrop" data-market-deck-close><aside class="card-detail market-deck-detail" role="dialog" aria-modal="true"><button class="detail-close" data-market-deck-close aria-label="Chiudi">×</button><span class="eyebrow">${deck.marketIndicative?'Valore indicativo':'Valore mazzo'}</span><div class="market-deck-detail-head">${renderDeckBoxVisual(deck)}<div><h2>${esc(deck.name)}</h2><p>${deck.marketValue==null?'Valore non disponibile':money(deck.marketValue)}</p><small>${deck.valuedCopies}/${deck.totalCopies} copie valorizzate${deck.indicativeValuedCopies?` · ${deck.indicativeValuedCopies} con stima indicativa`:''}${deck.unresolvedCount?` · ${deck.unresolvedCount} printing da definire`:''}</small></div></div><div class="market-deck-kpis"><span><small>24 ore</small><strong class="${tone(deck.delta24)}">${deck.marketIndicative?'Non disponibile':changePercent(deck.delta24)}</strong></span><span><small>7 giorni</small><strong class="${tone(deck.delta7)}">${deck.marketIndicative?'Non disponibile':changePercent(deck.delta7)}</strong></span><span><small>Top mover</small><strong>${deck.marketIndicative?'Escluso':deck.topMover?`${esc(deck.topMover.cardName)} ${changePercent(deck.topMover.percent)}`:'Non disponibile'}</strong></span></div><p class="data-note">${deck.marketIndicative?'Stima basata anche su prezzi Cardmarket aggregati o su una printing posseduta scelta tramite identità catalogo. Trend e mover restano esclusi.':'Il valore deriva da printing con prezzo specifico. Le fonti restano visibili nei dettagli delle singole printing.'}</p></aside></div>`;}
  detailView(){
    const item=this.data.items.find(row=>row.printingId===this.selected);if(!item)return'';
    const providers=Object.entries(item.providers||{}),history=this.history.get(item.printingId)||[],aggregate=isAggregatePrice(item);
    const stats=aggregate?null:historyStats(history);
    const delta=!aggregate&&item.referencePrice!=null&&item.price24h!=null?item.referencePrice-item.price24h:null,percent=delta!=null&&item.price24h?delta/item.price24h*100:null;
    const primaryProvider=providers.find(([name])=>name==='cardmarket')||providers[0]||null;
    const owned=item.sources.includes('owned')&&item.ownedQuantity>0;
    return `<div class="detail-backdrop" data-market-detail-close><aside class="card-detail market-detail" role="dialog" aria-modal="true">
      <header class="market-detail-topbar"><button type="button" class="detail-close" data-market-detail-close aria-label="Chiudi">${icon('arrow')}</button><strong>Dettaglio printing</strong></header>
      <div class="market-detail-head">${item.imageUrl?`<img src="${esc(item.imageUrl)}" alt="">`:icon('card')}<div><h2>${esc(item.cardName)}</h2><p>${esc(item.setCode||'Set non indicato')} · ${esc(item.rarity||'Rarità non indicata')}</p><div class="market-detail-badges">${item.sources.map(source=>`<i class="market-row-badge ${source}">${esc(LABELS[source])}${source==='owned'?` · ${item.ownedQuantity} ${item.ownedQuantity===1?'copia':'copie'}`:''}</i>`).join('')}${aggregate?'<i class="market-row-badge aggregate">Aggregato</i>':''}</div></div></div>
      ${aggregate?aggregateNotice(item):''}
      <section class="market-price-card ${tone(delta)}">
        <span class="market-price-card-icon">${icon('chart')}</span>
        <div class="market-price-card-copy"><small>Prezzo attuale${primaryProvider?` · ${providerName(primaryProvider[0])}`:''}</small><strong>${item.referencePrice==null?'—':money(item.referencePrice)}</strong><span>${priceTypeLabel(primaryProvider?.[1]?.type)} · ${formatTimestamp(item.latestAt)}${delta!=null?` · ${changeMoney(delta)}`:''}</span></div>
        ${percent!=null?`<b class="market-price-card-badge ${tone(delta)}">${changePercent(percent)}</b>`:''}
      </section>
      <section class="market-chart">
        <div class="market-chart-head"><h3>Storico prezzo</h3>${aggregate?'':`<div class="market-range-tabs" role="group" aria-label="Intervallo storico">${RANGES.map(range=>`<button type="button" class="${this.historyRange===range.days?'active':''}" data-market-range="${range.days}">${range.label}</button>`).join('')}</div>`}</div>
        ${aggregate?'<p class="market-detail-empty">Trend escluso: il prezzo non è specifico della printing.</p>':this.historyLoading?'<div class="loading-spinner"></div>':richPriceChart(stats)}
        ${stats?chartStatRow(stats):''}
      </section>
      ${owned?positionCard(item,stats):''}
      ${quickActions(item)}
      <p class="mapping-state">Mapping Cardmarket: ${esc(mappingStatusLabel(item))}${item.resolverVersion!=null?` · resolver v${esc(item.resolverVersion)}`:''}</p>
    </aside></div>`;
  }
  bind(root=document){root.querySelector('[data-market-retry]')?.addEventListener('click',()=>void this.load().then(()=>this.onRender()));root.querySelectorAll('[data-market-tab]').forEach(button=>button.addEventListener('click',()=>{this.tab=button.dataset.marketTab;this.selected='';this.selectedDeck='';this.onRender();}));root.querySelector('[data-market-sort]')?.addEventListener('change',event=>{this.sort=event.target.value;this.onRender();});root.querySelectorAll('[data-market-card]').forEach(button=>button.addEventListener('click',()=>void this.openDetail(button.dataset.marketCard)));root.querySelectorAll('[data-market-deck]').forEach(button=>button.addEventListener('click',()=>{this.selectedDeck=button.dataset.marketDeck;this.onRender();}));root.querySelectorAll('[data-market-deck-close]').forEach(node=>node.addEventListener('click',event=>{if(event.target!==node&&!event.target.closest('.detail-close'))return;this.selectedDeck='';this.onRender();}));root.querySelectorAll('[data-market-detail-close]').forEach(node=>node.addEventListener('click',event=>{if(event.target!==node&&!event.target.closest('.detail-close'))return;this.selected='';this.onRender();}));root.querySelectorAll('[data-market-unwatch]').forEach(button=>button.addEventListener('click',()=>void this.unwatch(button.dataset.marketUnwatch)));root.querySelectorAll('[data-market-watch-toggle]').forEach(button=>button.addEventListener('click',()=>void (button.dataset.marketWatchState==='remove'?this.unwatch(button.dataset.marketWatchToggle):this.watch(button.dataset.marketWatchToggle))));root.querySelectorAll('[data-market-share]').forEach(button=>button.addEventListener('click',()=>void this.share(button.dataset.marketShare)));root.querySelectorAll('[data-market-confirm-mapping]').forEach(button=>button.addEventListener('click',()=>void this.confirmMapping(button.dataset.marketConfirmMapping,button.dataset.marketConfirmProduct,{productName:button.dataset.marketConfirmName||'',expansion:button.dataset.marketConfirmExpansion||'',rarity:button.dataset.marketConfirmRarity||''})));root.querySelectorAll('[data-market-range]').forEach(button=>button.addEventListener('click',()=>this.setHistoryRange(Number(button.dataset.marketRange))));root.querySelectorAll('[data-market-resolve-deck]').forEach(button=>button.addEventListener('click',()=>this.onNavigate('decks')));this.observeRows(root);}
  observeRows(root=document){
    if(typeof IntersectionObserver==='undefined'||!this.api?.marketPriceHistory)return;
    this.rowObserver?.disconnect();
    this.rowObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;const printingId=entry.target.dataset.marketCard;this.rowObserver.unobserve(entry.target);if(printingId)void this.loadRowHistory(printingId);}},{rootMargin:'200px',threshold:.01});
    root.querySelectorAll('[data-market-card]').forEach(node=>{if(!this.history.has(node.dataset.marketCard))this.rowObserver.observe(node);});
  }
  async loadRowHistory(printingId){
    if(this.history.has(printingId)||this.rowHistoryLoading.has(printingId))return;
    this.rowHistoryLoading.add(printingId);
    try{const rows=await this.api.marketPriceHistory(printingId,30);this.history.set(printingId,(rows||[]).map(row=>({provider:row.provider,type:row.price_type||row.priceType,price:Number(row.price),capturedAt:row.captured_at||row.capturedAt})));}
    catch{this.history.set(printingId,[]);}
    finally{this.rowHistoryLoading.delete(printingId);this.onRender();}
  }
  async openDetail(printingId){this.selected=printingId;this.historyRange=30;this.onRender();if(this.history.has(printingId))return;const item=this.data.items.find(row=>row.printingId===printingId);if(isAggregatePrice(item)){this.history.set(printingId,[]);return;}await this.fetchHistory(printingId);}
  async fetchHistory(printingId){this.historyLoading=true;this.onRender();try{const rows=await this.api.marketPriceHistory(printingId,this.historyRange);this.history.set(printingId,(rows||[]).map(row=>({provider:row.provider,type:row.price_type||row.priceType,price:Number(row.price),capturedAt:row.captured_at||row.capturedAt})));}catch{this.history.set(printingId,[]);}finally{this.historyLoading=false;this.onRender();}}
  setHistoryRange(days){if(!RANGES.some(range=>range.days===days)||this.historyRange===days)return;this.historyRange=days;const item=this.data.items.find(row=>row.printingId===this.selected);if(!item||isAggregatePrice(item))return;this.history.delete(this.selected);void this.fetchHistory(this.selected);}
  async watch(printingId){try{await this.api.setMarketWatchItem(printingId,true);await this.load();this.onToast('Printing aggiunta alla Watchlist');}catch(error){this.onToast(error.message||'Operazione non riuscita');}this.onRender();}
  async unwatch(printingId){try{await this.api.setMarketWatchItem(printingId,false);await this.load();const stillListed=this.data.items.some(row=>row.printingId===printingId);if(!stillListed)this.selected='';this.onToast('Printing rimossa dalla Watchlist');}catch(error){this.onToast(error.message||'Operazione non riuscita');}this.onRender();}
  async confirmMapping(printingId,productId,meta={}){
    if(!productId)return;
    try{await this.api.setMarketMappingManual(printingId,productId,meta);await this.load();this.onToast('Printing confermata — il prossimo aggiornamento userà questo prezzo reale');}
    catch(error){this.onToast(error.message||'Conferma non riuscita');}
    this.onRender();
  }
  async share(printingId){const item=this.data.items.find(row=>row.printingId===printingId);if(!item)return;const url=item.cardmarketUrl||(typeof location!=='undefined'?location.href:''),text=`${item.cardName}${item.referencePrice!=null?` · ${money(item.referencePrice)}`:''}`;try{if(typeof navigator!=='undefined'&&navigator.share){await navigator.share({title:item.cardName,text,url});return;}await navigator.clipboard.writeText(url);this.onToast('Link copiato negli appunti');}catch(error){if(error?.name!=='AbortError')this.onToast('Condivisione non riuscita');}}
}

export function mapPayload(payload={}){return {items:(payload.items||[]).map(row=>{const priceScope=row.price_scope||row.priceScope||{};return {printingId:row.printing_id||row.printingId,catalogCardId:String(row.catalog_card_id||row.catalogCardId||''),cardName:row.card_name||row.cardName||'',setCode:row.set_code||row.setCode||'',setName:row.set_name||row.setName||'',rarity:row.rarity||'',imageUrl:row.image_url||row.imageUrl||'',sources:Array.isArray(row.sources)?row.sources:[],ownedQuantity:Number(row.owned_quantity??row.ownedQuantity??0),providers:normalizeProviders(row.providers),referencePrice:nullableNumber(row.reference_price??row.referencePrice),minPrice:nullableNumber(row.min_price??row.minPrice),price24h:nullableNumber(row.price_24h??row.price24h),price7d:nullableNumber(row.price_7d??row.price7d),price30d:nullableNumber(row.price_30d??row.price30d),latestAt:row.latest_at||row.latestAt||null,mappingStatus:row.mapping_status||row.mappingStatus||'unresolved',resolverStatus:row.resolver_status||row.resolverStatus||row.mapping_status||row.mappingStatus||'unresolved',resolverVersion:nullableNumber(row.resolver_version??row.resolverVersion),priceScope,languageScope:row.language_scope||row.languageScope||priceScope.language||null,editionScope:row.edition_scope||row.editionScope||priceScope.edition||null,rarityScope:row.rarity_scope||row.rarityScope||priceScope.rarity||null,foilScope:row.foil_scope||row.foilScope||priceScope.foil||null,mappingReason:row.mapping_reason||row.mappingReason||'',mappingEvidence:row.mapping_evidence||row.mappingEvidence||{},cardmarketProductId:String(row.cardmarket_product_id||row.cardmarketProductId||''),cardmarketUrl:row.cardmarket_url||row.cardmarketUrl||''};}),deckUnresolved:(payload.deckUnresolved||payload.deck_unresolved||[]).map(row=>({deckId:row.deckId||row.deck_id,deckName:row.deckName||row.deck_name,cardName:row.cardName||row.card_name,catalogCardId:String(row.catalogCardId||row.catalog_card_id||''),section:row.section,quantity:Number(row.quantity||0)})),lastSync:payload.lastSync||payload.last_sync||null};}
export function buildMarketDecks(decks=[],items=[],unresolved=[]){
  const prices=new Map((items||[]).map(item=>[String(item.printingId),item])),catalogPrices=new Map(),unresolvedByDeck=new Map();
  for(const item of items||[]){const key=canonicalCatalogCardId(item.catalogCardId,item.game||'yugioh');if(!key||item.referencePrice==null||!item.sources?.includes('owned'))continue;const current=catalogPrices.get(key);if(!current||Number(item.referencePrice)<Number(current.referencePrice))catalogPrices.set(key,item);}
  for(const row of unresolved||[])unresolvedByDeck.set(String(row.deckId),(unresolvedByDeck.get(String(row.deckId))||0)+Number(row.quantity||0));
  const available=(decks||[]).map(deck=>{
    let totalCopies=0,valuedCopies=0,indicativeValuedCopies=0,current=0,current24=0,baseline24=0,current7=0,baseline7=0,has24=false,has7=false,topMover=null;
    for(const card of deck.cards||[]){const quantity=Number(card.quantity||0);totalCopies+=quantity;const catalogFallback=!card.printingId,item=card.printingId?prices.get(String(card.printingId)):catalogPrices.get(canonicalCatalogCardId(card.catalogCardId,deck.game||'yugioh'));if(!item||item.referencePrice==null)continue;if(catalogFallback||isAggregatePrice(item)){valuedCopies+=quantity;indicativeValuedCopies+=quantity;current+=item.referencePrice*quantity;continue;}if(!derivedPriceEligible(item))continue;valuedCopies+=quantity;current+=item.referencePrice*quantity;
      if(item.price24h!=null&&item.price24h>0){has24=true;current24+=item.referencePrice*quantity;baseline24+=item.price24h*quantity;const percent=(item.referencePrice-item.price24h)/item.price24h*100;if(!topMover||percent>topMover.percent)topMover={cardName:card.cardName,percent};}
      if(item.price7d!=null&&item.price7d>0){has7=true;current7+=item.referencePrice*quantity;baseline7+=item.price7d*quantity;}
    }
    const marketIndicative=indicativeValuedCopies>0;return {...deck,marketValue:valuedCopies?current:null,marketIndicative,delta24:!marketIndicative&&has24&&baseline24?((current24-baseline24)/baseline24)*100:null,delta7:!marketIndicative&&has7&&baseline7?((current7-baseline7)/baseline7)*100:null,topMover:!marketIndicative&&topMover?.percent>0?topMover:null,totalCopies,valuedCopies,indicativeValuedCopies,unresolvedCount:unresolvedByDeck.get(String(deck.id))||0};
  });
  if(available.length)return available;
  const grouped=new Map();for(const row of unresolved||[]){const id=String(row.deckId),deck=grouped.get(id)||{id,name:row.deckName||'Mazzo',game:'yugioh',deckTheme:'arcane-purple',cards:[],marketValue:null,marketIndicative:false,delta24:null,delta7:null,topMover:null,totalCopies:0,valuedCopies:0,indicativeValuedCopies:0,unresolvedCount:0};deck.cards.push({catalogCardId:row.catalogCardId,cardName:row.cardName,section:row.section,quantity:row.quantity,imageUrl:''});deck.totalCopies+=row.quantity;deck.unresolvedCount+=row.quantity;grouped.set(id,deck);}return [...grouped.values()];
}
export function portfolioSummary(items,now=Date.now()){const owned=items.filter(item=>item.sources.includes('owned')&&item.ownedQuantity>0),totalUnits=owned.reduce((sum,item)=>sum+item.ownedQuantity,0),fresh=owned.filter(item=>derivedPriceEligible(item)&&item.referencePrice!=null&&item.latestAt&&now-new Date(item.latestAt).getTime()<=FRESH_MS),coveredUnits=fresh.reduce((sum,item)=>sum+item.ownedQuantity,0),coverage=totalUnits?coveredUnits/totalUnits:0,current=fresh.reduce((sum,item)=>sum+item.referencePrice*item.ownedQuantity,0),with24=fresh.filter(item=>item.price24h!=null),with7=fresh.filter(item=>item.price7d!=null),old24=with24.reduce((sum,item)=>sum+item.price24h*item.ownedQuantity,0),current24=with24.reduce((sum,item)=>sum+item.referencePrice*item.ownedQuantity,0),old7=with7.reduce((sum,item)=>sum+item.price7d*item.ownedQuantity,0),current7=with7.reduce((sum,item)=>sum+item.referencePrice*item.ownedQuantity,0);return {totalUnits,coveredUnits,totalPrintings:owned.length,coveredPrintings:fresh.length,freshPrintings:items.filter(item=>derivedPriceEligible(item)&&item.latestAt&&now-new Date(item.latestAt).getTime()<=FRESH_MS).length,coverage,current,complete:totalUnits>0&&coverage>=.9,delta24:current24-old24,delta24Percent:old24?((current24-old24)/old24)*100:null,delta24Complete:fresh.length>0&&with24.length===fresh.length&&coverage>=.9,delta7:current7-old7,delta7Percent:old7?((current7-old7)/old7)*100:null,delta7Complete:fresh.length>0&&with7.length===fresh.length&&coverage>=.9};}
export function deduplicateMonitored({owned=[],deck=[],manual=[]}={}){const map=new Map();for(const [source,rows] of Object.entries({owned,deck,manual}))for(const row of rows){if(!row.printingId)continue;const entry=map.get(row.printingId)||{printingId:row.printingId,sources:new Set(),quantity:0};entry.sources.add(source);if(source==='owned')entry.quantity+=Number(row.quantity||0);map.set(row.printingId,entry);}return [...map.values()].map(row=>({...row,sources:[...row.sources]}));}
export function positiveMovers(items,limit=3){const ranked=(items||[]).filter(item=>derivedPriceEligible(item)&&item.sources?.includes('owned')&&Number.isFinite(item.referencePrice)&&Number.isFinite(item.price24h)&&item.price24h>0&&item.referencePrice>item.price24h).map(item=>({...item,positiveChange:(item.referencePrice-item.price24h)/item.price24h*100})).sort((a,b)=>b.positiveChange-a.positiveChange||(b.referencePrice-b.price24h)-(a.referencePrice-a.price24h));const seen=new Set(),result=[];for(const item of ranked){const key=String(item.catalogCardId||item.cardName).toLowerCase();if(seen.has(key))continue;seen.add(key);result.push(item);if(result.length>=limit)break;}return result;}
export function mapDashboardMovers(rows=[]){return (Array.isArray(rows)?rows:[]).map(row=>({printingId:row.printingId||row.printing_id,catalogCardId:String(row.catalogCardId||row.catalog_card_id||''),cardName:row.cardName||row.card_name||'',setCode:row.setCode||row.set_code||'',setName:row.setName||row.set_name||'',rarity:row.rarity||'',imageUrl:row.imageUrl||row.image_url||'',ownedQuantity:Number(row.ownedQuantity??row.owned_quantity??0),referencePrice:nullableNumber(row.referencePrice??row.reference_price),baselinePrice:nullableNumber(row.baselinePrice??row.baseline_price),positiveChange:nullableNumber(row.positiveChange??row.positive_change),capturedAt:row.capturedAt||row.captured_at||null,sparkline:(row.sparkline||[]).map(point=>({label:point.label||'',price:nullableNumber(point.price),order:Number(point.order||0)})).filter(point=>point.price!=null).sort((a,b)=>a.order-b.order)}));}

function marketRow(item,history,tab){
  const aggregate=isAggregatePrice(item),delta=!aggregate&&item.referencePrice!=null&&item.price24h!=null?item.referencePrice-item.price24h:null,percent=delta!=null&&item.price24h?delta/item.price24h*100:null;
  const owned=tab==='owned'&&item.ownedQuantity>0,position=owned&&item.referencePrice!=null?item.referencePrice*item.ownedQuantity:null;
  return `<button class="market-row" data-market-card="${esc(item.printingId)}">
    ${item.imageUrl?`<img src="${esc(item.imageUrl)}" alt="">`:`<span class="market-art-empty">${icon('card')}</span>`}
    <span class="market-card-copy">
      <strong>${esc(item.cardName)}</strong>
      <small>${esc(item.setCode||'Set non indicato')} · ${esc(item.rarity||'Rarità non indicata')}</small>
      <span class="market-row-badges"><i class="market-row-badge ${tab}">${esc(LABELS[tab])}</i>${owned?`<i class="market-row-badge qty">${item.ownedQuantity} ${item.ownedQuantity===1?'copia':'copie'}</i>`:''}${aggregate?'<i class="market-row-badge aggregate">Aggregato</i>':''}</span>
    </span>
    <span class="market-price">
      <span class="market-price-top"><strong>${item.referencePrice==null?'—':money(item.referencePrice)}</strong>${percent!=null?`<b class="${tone(delta)}">${changePercent(percent)}</b>`:''}</span>
      ${position!=null?`<span class="market-price-position"><b>${money(position)}</b><small>Totale posizione</small></span>`:`<small class="market-price-note">${aggregate?'Indicativo · non specifico':item.minPrice==null?'Min. non disponibile':`A partire da ${money(item.minPrice)}`}</small>`}
    </span>
    ${rowSparkline(history,delta)}
  </button>`;
}
function rowSparkline(history,delta){
  const points=(history||[]).filter(row=>Number.isFinite(row.price)).sort((a,b)=>new Date(a.capturedAt)-new Date(b.capturedAt));
  if(points.length<2)return '<i class="market-row-chart empty" aria-hidden="true"></i>';
  const values=points.map(row=>row.price),min=Math.min(...values),max=Math.max(...values),span=max-min||1,width=48,height=20;
  const path=points.map((row,index)=>`${index?'L':'M'} ${(index/(points.length-1))*width} ${height-((row.price-min)/span)*height}`).join(' ');
  const trend=tone(delta??(values.at(-1)-values[0]));
  return `<svg class="market-row-chart ${trend}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}
export function isAggregatePrice(item){return item?.resolverStatus==='PROVIDER_AGGREGATE';}
export function derivedPriceEligible(item){return item?.mappingStatus==='manual'||(item?.referencePrice!=null&&item?.resolverStatus!=='PROVIDER_AGGREGATE');}
function aggregateNotice(item){const scope=item.priceScope||{},labels=[];if(scope.language!=='specific')labels.push('lingua');if(scope.edition!=='specific')labels.push('edizione');if(scope.rarity!=='specific')labels.push('rarità');if(scope.foil!=='specific')labels.push('foil');const productNote=scope.product==='minimum_across_candidates'?' Usa il prezzo minimo fra i Product ID compatibili.':'';return `<p class="provider-warning aggregate-price-notice">${icon('info')} <span><strong>Prezzo Cardmarket aggregato</strong><br>Indicativo e non specifico per ${esc(labels.join(', ')||'la variante')}.${productNote} Non alimenta il valore preciso della raccolta, trend o mover.</span></p>${mappingConfirmBlock(item)}`;}
function mappingConfirmBlock(item){
  const evidence=item.mappingEvidence||{};
  const candidates=Array.isArray(evidence.candidates)&&evidence.candidates.length?evidence.candidates:evidence.providerProductId?[{productId:evidence.providerProductId,cardName:evidence.providerCardName||item.cardName,rarity:evidence.providerRarity||'',expansion:evidence.providerExpansion||'',productUrl:evidence.providerProductUrl||''}]:[];
  if(!candidates.length)return '<p class="mapping-confirm-empty">Nessun candidato salvato per la conferma manuale: attendi il prossimo sync o verifica a mano su Cardmarket.</p>';
  return `<div class="mapping-confirm"><p>Conferma quale printing Cardmarket è quella giusta — resterà fissa e userà il prezzo reale dal prossimo aggiornamento:</p><div class="mapping-confirm-list">${candidates.map(candidate=>`<div class="mapping-confirm-row"><span><strong>${esc(candidate.cardName||item.cardName)}</strong><small>${esc(candidate.expansion||'—')}${candidate.rarity?` · ${esc(candidate.rarity)}`:''}</small></span><div class="mapping-confirm-actions">${candidate.productUrl?`<a href="${esc(candidate.productUrl)}" target="_blank" rel="noopener noreferrer" class="mapping-confirm-view">Vedi</a>`:''}<button type="button" class="btn secondary small" data-market-confirm-mapping="${esc(item.printingId)}" data-market-confirm-product="${esc(candidate.productId)}" data-market-confirm-name="${esc(candidate.cardName||item.cardName)}" data-market-confirm-expansion="${esc(candidate.expansion||'')}" data-market-confirm-rarity="${esc(candidate.rarity||'')}">Conferma questa</button></div></div>`).join('')}</div></div>`;
}
export function sortItems(items,mode='value'){return [...items].sort((a,b)=>{if(mode==='name')return a.cardName.localeCompare(b.cardName,'it');if(mode==='price')return (b.referencePrice??-1)-(a.referencePrice??-1);if(mode==='change'){const av=a.referencePrice!=null&&a.price24h!=null?a.referencePrice-a.price24h:-Infinity,bv=b.referencePrice!=null&&b.price24h!=null?b.referencePrice-b.price24h:-Infinity;return bv-av;}return ((b.referencePrice??-1)*b.ownedQuantity)-((a.referencePrice??-1)*a.ownedQuantity);});}
function historyStats(history){
  const points=(history||[]).filter(row=>Number.isFinite(row.price)).sort((a,b)=>new Date(a.capturedAt)-new Date(b.capturedAt));
  if(points.length<2)return null;
  const values=points.map(row=>row.price),min=Math.min(...values),max=Math.max(...values),avg=values.reduce((sum,value)=>sum+value,0)/values.length,first=values[0],last=values.at(-1),change=last-first,changePercentValue=first?change/first*100:null;
  return {points,min,max,avg,first,last,change,changePercent:changePercentValue};
}
function richPriceChart(stats){
  if(!stats)return '<div class="market-detail-empty">Il grafico comparirà dopo almeno due snapshot in questo intervallo.</div>';
  const {points,min,max}=stats,span=(max-min)||1,width=300,height=150,padL=40,padR=10,padT=32,padB=20,plotW=width-padL-padR,plotH=height-padT-padB;
  const x=index=>padL+(points.length>1?(index/(points.length-1))*plotW:plotW/2),y=value=>padT+plotH-((value-min)/span)*plotH;
  const linePath=points.map((point,index)=>`${index?'L':'M'} ${x(index).toFixed(1)} ${y(point.price).toFixed(1)}`).join(' ');
  const areaPath=`${linePath} L ${x(points.length-1).toFixed(1)} ${(padT+plotH).toFixed(1)} L ${x(0).toFixed(1)} ${(padT+plotH).toFixed(1)} Z`;
  const positive=points.at(-1).price>=points[0].price;
  const maxIndex=points.findIndex(point=>point.price===max),minIndex=points.findIndex(point=>point.price===min);
  const callouts=min!==max?`
    <circle cx="${x(maxIndex).toFixed(1)}" cy="${y(max).toFixed(1)}" r="3" class="market-chart-callout-dot max"/>
    <text x="${Math.min(width-padR-4,Math.max(padL+4,x(maxIndex))).toFixed(1)}" y="${Math.max(10,y(max)-8).toFixed(1)}" class="market-chart-callout max" text-anchor="middle">MAX ${money(max)}</text>
    <circle cx="${x(minIndex).toFixed(1)}" cy="${y(min).toFixed(1)}" r="3" class="market-chart-callout-dot min"/>
    <text x="${Math.min(width-padR-4,Math.max(padL+4,x(minIndex))).toFixed(1)}" y="${Math.min(height-6,y(min)+15).toFixed(1)}" class="market-chart-callout min" text-anchor="middle">MIN ${money(min)}</text>
  `:'';
  return `<svg class="market-rich-chart ${positive?'positive':'negative'}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Andamento prezzo">
    <line x1="${padL}" y1="${padT}" x2="${width-padR}" y2="${padT}" class="market-chart-grid"/>
    <line x1="${padL}" y1="${(padT+plotH/2).toFixed(1)}" x2="${width-padR}" y2="${(padT+plotH/2).toFixed(1)}" class="market-chart-grid"/>
    <line x1="${padL}" y1="${padT+plotH}" x2="${width-padR}" y2="${padT+plotH}" class="market-chart-grid"/>
    <text x="0" y="${padT+3}" class="market-chart-axis">${money(max)}</text>
    <text x="0" y="${(padT+plotH/2+3).toFixed(1)}" class="market-chart-axis">${money(min+span/2)}</text>
    <text x="0" y="${padT+plotH+3}" class="market-chart-axis">${money(min)}</text>
    <path d="${areaPath}" class="market-chart-area"/>
    <path d="${linePath}" class="market-chart-line"/>
    <circle cx="${x(points.length-1).toFixed(1)}" cy="${y(points.at(-1).price).toFixed(1)}" r="3.5" class="market-chart-dot"/>
    ${callouts}
    <text x="${padL}" y="${height-3}" class="market-chart-axis start">${formatChartDate(points[0].capturedAt)}</text>
    <text x="${width-padR}" y="${height-3}" class="market-chart-axis end">${formatChartDate(points.at(-1).capturedAt)}</text>
  </svg>`;
}
function chartStatRow(stats){return `<div class="market-chart-stats"><span><small>Min</small><b>${money(stats.min)}</b></span><span><small>Max</small><b>${money(stats.max)}</b></span><span><small>Med</small><b>${money(stats.avg)}</b></span><span><small>Variazione</small><b class="${tone(stats.change)}">${stats.changePercent==null?'—':changePercent(stats.changePercent)}</b></span></div>`;}
function positionCard(item,stats){
  const total=item.referencePrice!=null?item.referencePrice*item.ownedQuantity:null,avgPrice=stats?.avg??null,avgDelta=avgPrice!=null&&item.referencePrice!=null?item.referencePrice-avgPrice:null,avgPercent=avgDelta!=null&&avgPrice?avgDelta/avgPrice*100:null;
  return `<section class="market-position-card"><div class="market-position-head"><h3>La tua posizione</h3>${item.latestAt?`<small>Aggiornato ${formatTimestamp(item.latestAt)}</small>`:''}</div><div class="market-position-grid">
    <span><small>Copie possedute</small><b>${item.ownedQuantity}</b><em>copie</em></span>
    <span><small>Valore unitario</small><b>${item.referencePrice==null?'—':money(item.referencePrice)}</b>${avgPrice!=null?`<em>media ${money(avgPrice)}</em>`:''}</span>
    <span><small>Valore posizione</small><b>${total==null?'—':money(total)}</b><em>${item.ownedQuantity} × ${item.referencePrice==null?'—':money(item.referencePrice)}</em></span>
    <span><small>Variazione media</small><b class="${tone(avgDelta)}">${avgPercent==null?'—':changePercent(avgPercent)}</b>${avgDelta!=null?`<em class="${tone(avgDelta)}">${changeMoney(avgDelta)}</em>`:''}</span>
  </div></section>`;
}
function quickActions(item){
  const inWatchlist=item.sources.includes('manual');
  return `<div class="market-quick-actions">
    <button type="button" class="market-quick-btn ${inWatchlist?'active':''}" data-market-watch-toggle="${esc(item.printingId)}" data-market-watch-state="${inWatchlist?'remove':'add'}">${icon('star')}<span>${inWatchlist?'Rimuovi watchlist':'Watchlist'}</span></button>
    ${item.cardmarketUrl?`<a class="market-quick-btn" href="${esc(item.cardmarketUrl)}" target="_blank" rel="noopener noreferrer">${icon('chart')}<span>Apri su Cardmarket</span></a>`:''}
    <button type="button" class="market-quick-btn" data-market-share="${esc(item.printingId)}">${icon('share')}<span>Condividi</span></button>
  </div>`;
}
function formatChartDate(value){const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('it-IT',{day:'2-digit',month:'2-digit'}).format(date);}
function unresolvedDeckRow(row){return `<article class="market-row unresolved"><span class="market-art-empty">${icon('deck')}</span><span class="market-card-copy"><strong>${esc(row.cardName)}</strong><small>${esc(row.deckName)} · ${esc(row.section)} · ${row.quantity} copie</small><em>Printing da selezionare</em></span><button class="btn secondary small" data-market-resolve-deck>Seleziona</button></article>`;}
function emptyPreparing(){return '<div class="market-preparing"><span class="market-orbit">'+icon('chart')+'</span><div><h2>Il Market Watch sta preparando i primi dati.</h2><p>Le printing sono pronte; i valori compariranno dopo il primo aggiornamento server-side.</p></div></div>';}
function emptyNoCards(){return '<div class="empty-state market-empty">'+icon('collection')+'<h2>Aggiungi carte alla Raccolta o alla Watchlist per iniziare.</h2><p>Le carte possedute entrano automaticamente nel monitoraggio.</p></div>';}
function kpi(label,value,detail,kind){return `<article class="surface market-kpi ${kind}"><small>${label}</small><strong>${value}</strong><span>${detail}</span></article>`;}
function countFor(data,tab,deckCount=0){return tab==='deck'?deckCount:data.items.filter(item=>item.sources.includes(tab)).length;}
function normalizeProviders(value){if(!value||typeof value!=='object')return{};return Object.fromEntries(Object.entries(value).map(([key,row])=>[key,{...row,capturedAt:row.capturedAt||row.captured_at,conditionReference:row.conditionReference||row.condition_reference,price:nullableNumber(row.price)}]));}
function nullableNumber(value){if(value==null||value==='')return null;const number=Number(value);return Number.isFinite(number)?number:null;}
function money(value){return new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'}).format(Number(value)||0);}
function changeMoney(value){const number=Number(value)||0;return `${number>=0?'+':'−'}${money(Math.abs(number))}`;}
function changePercent(value){if(value==null)return'—';const number=Number(value)||0;return `${number>=0?'+':'−'}${Math.abs(number).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2})}%`;}
function tone(value){return value==null?'muted':value>0?'positive':value<0?'negative':'muted';}
function formatTimestamp(value){if(!value)return'—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('it-IT',{dateStyle:'short',timeStyle:'short'}).format(date);}
function providerName(value){return value==='cardtrader'?'CardTrader':value==='cardmarket'?'Cardmarket':value;}
const PRICE_TYPE_LABELS={low:'Minimo',trend:'Trend',average:'Media',avg:'Media',avg1:'Media 1 giorno',avg7:'Media 7 giorni',avg30:'Media 30 giorni',
  foil_low:'Minimo (foil)',foil_trend:'Trend (foil)',foil_average:'Media (foil)',foil_avg1:'Media 1 giorno (foil)',foil_avg7:'Media 7 giorni (foil)',foil_avg30:'Media 30 giorni (foil)',
  lowest:'Più basso',reference:'Riferimento'};
function priceTypeLabel(type){return PRICE_TYPE_LABELS[type]||(type?esc(type):'Prezzo');}
const MAPPING_STATUS_LABELS={PROVIDER_AGGREGATE:'Prezzo aggregato Cardmarket',AMBIGUOUS:'Ambiguo — verifica manuale consigliata',UNRESOLVED:'Non risolto',UNSUPPORTED:'Rarità non gestita',EXACT:'Corrispondenza esatta',
  resolved:'Risolto',ambiguous:'Ambiguo',unresolved:'Non risolto',manual:'Confermato manualmente'};
function mappingStatusLabel(item){const raw=item.resolverStatus||item.mappingStatus||'unresolved';return MAPPING_STATUS_LABELS[raw]||raw;}
