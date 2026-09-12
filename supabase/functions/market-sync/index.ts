// Deploy manualmente solo dopo aver applicato la migration Market Watch.
// Il cron delle 03:00 Europe/Rome è intenzionalmente escluso dalla migration.
//
// NOTA: il contenuto di market/providers.js è INLINE qui sotto (non importato) perché
// il bundler del Dashboard Supabase risolve gli import relativi rispetto a una root
// virtuale che non contiene il resto del repo: qualunque "../" tenta di risalire
// finisce fuori dalla function e il deploy fallisce con "Module not found".
// Se modifichi market/providers.js, riporta manualmente le stesse modifiche qui sotto.

const RESOLUTION_STATES=new Set(['resolved','ambiguous','unresolved','manual']);
const CARDMARKET_RESOLVER_VERSION=11;
const CARDMARKET_RESOLUTION_STATES=Object.freeze({EXACT:'EXACT',AMBIGUOUS:'AMBIGUOUS',UNRESOLVED:'UNRESOLVED',UNSUPPORTED:'UNSUPPORTED',PROVIDER_AGGREGATE:'PROVIDER_AGGREGATE'});
const SUPPORTED_RARITIES=new Map([
  ['common','Common'],['rare','Rare'],['super rare','Super Rare'],['ultra rare','Ultra Rare'],['secret rare','Secret Rare'],
  ['ultimate rare','Ultimate Rare'],['starlight rare','Starlight Rare'],['platinum secret rare','Platinum Secret Rare'],
  ["collector's rare","Collector's Rare"],['collectors rare',"Collector's Rare"],['quarter century secret rare','Quarter Century Secret Rare'],
  ['starfoil rare','Starfoil Rare'],['short print','Short Print'],['prismatic secret rare','Prismatic Secret Rare'],
  ['gold secret rare','Gold Secret Rare'],['gold rare','Gold Rare'],['mosaic rare','Mosaic Rare'],
  ['premium gold rare','Premium Gold Rare'],['shatterfoil rare','Shatterfoil Rare'],['ghost rare','Ghost Rare'],
  // Rarità reali del catalogo YGOPRODeck non coperte sopra: senza queste voci il resolver
  // scartava la printing come UNSUPPORTED prima ancora di cercarla su Cardmarket.
  ['ghost/gold rare','Ghost/Gold Rare'],['platinum rare','Platinum Rare'],
  ['prismatic ultimate rare','Prismatic Ultimate Rare'],["prismatic collector's rare","Prismatic Collector's Rare"],['prismatic collectors rare',"Prismatic Collector's Rare"],
  ['extra secret rare','Extra Secret Rare'],['20th secret rare','20th Secret Rare'],['20th anniversary secret rare','20th Secret Rare'],
  ['super short print','Super Short Print'],['ultra short print','Ultra Short Print'],
  ['parallel rare','Parallel Rare'],['normal parallel rare','Normal Parallel Rare'],['super parallel rare','Super Parallel Rare'],['ultra parallel rare','Ultra Parallel Rare'],
  ['duel terminal normal parallel rare','Duel Terminal Normal Parallel Rare'],['duel terminal rare parallel rare','Duel Terminal Rare Parallel Rare'],
  ['duel terminal super parallel rare','Duel Terminal Super Parallel Rare'],['duel terminal ultra parallel rare','Duel Terminal Ultra Parallel Rare'],
  ['millennium rare','Millennium Rare'],['millennium super rare','Millennium Super Rare'],['millennium ultra rare','Millennium Ultra Rare'],
  ['millennium secret rare','Millennium Secret Rare'],['millennium gold rare','Millennium Gold Rare'],
  ['holographic rare','Holographic Rare'],["ultra rare (pharaoh's rare)","Ultra Rare (Pharaoh's Rare)"],
  // "New"/"Reprint" sono designazioni reali di YGOPRODeck per certe copie di
  // Structure Deck (non un placeholder vuoto) — js/cards.js's normalizeCatalogRarity()
  // le tratta già come alias di Common per lo stesso motivo ("must not vanish
  // entirely, or the printing never matches"). Questa mappa non le conosceva,
  // quindi ogni printing con card_printings.rarity='New'/'Reprint' veniva
  // scartata come UNSUPPORTED prima ancora di cercarla su Cardmarket.
  ['new','Common'],['reprint','Common']
]);

class PriceProvider {
  name:string;fetch:any;
  constructor({name,fetchImpl=globalThis.fetch}:any={}){this.name=name;this.fetch=fetchImpl;}
  async resolvePrinting(...args:any[]):Promise<any>{throw new Error('resolvePrinting() non implementato');}
  async getCurrentPrice(...args:any[]):Promise<any>{throw new Error('getCurrentPrice() non implementato');}
  async getMarketListings(...args:any[]):Promise<any>{throw new Error('getMarketListings() non implementato');}
  getPriceMetadata(...args:any[]):any{throw new Error('getPriceMetadata() non implementato');}
}

class CardmarketPriceGuideProvider extends PriceProvider {
  catalogUrl:string;priceGuideUrl:string;sleep:any;timeoutMs:number;catalog:any[];expansionHints:Map<string,any>;prices:Map<string,any>;sourceUpdatedAt:string;loaded:boolean;
  constructor({catalogUrl='',priceGuideUrl='',fetchImpl=globalThis.fetch,sleep=delay,timeoutMs=180000}:any={}){
    super({name:'cardmarket',fetchImpl});this.catalogUrl=catalogUrl;this.priceGuideUrl=priceGuideUrl;this.sleep=sleep;this.timeoutMs=timeoutMs;this.catalog=[];this.expansionHints=new Map();this.prices=new Map();this.sourceUpdatedAt='';this.loaded=false;
  }
  get available(){return Boolean(this.catalogUrl&&this.priceGuideUrl);}
  getPriceMetadata(){return {provider:this.name,status:this.available?'available':'unavailable',currency:'EUR',frequency:'daily',
    priceTypes:['low','trend','average','avg1','avg7','avg30','foil_low','foil_trend','foil_average','foil_avg1','foil_avg7','foil_avg30'],
    languageScope:'aggregate',editionScope:'aggregate',rarityScope:'product_variant_unlabeled',foilScope:'parallel_columns_unassigned',resolverVersion:CARDMARKET_RESOLVER_VERSION};}
  async request(url:string,{maxAttempts=3}:any={}):Promise<any>{
    for(let attempt=0;attempt<maxAttempts;attempt++){
      let response:any;
      try{response=await this.fetch(url,{signal:typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function'?AbortSignal.timeout(this.timeoutMs):undefined});}
      catch(error){if(attempt===maxAttempts-1)throw error;await this.sleep(backoff(attempt));continue;}
      if(response.ok)return response;
      if(![429,500,502,503,504].includes(response.status)||attempt===maxAttempts-1)throw new ProviderHttpError(this.name,response.status,await safeText(response));
      const retryAfter=Number(response.headers?.get?.('retry-after'));await this.sleep(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:backoff(attempt));
    }
  }
  async load(targets:any[]=[]){
    if(!this.available)throw unavailable('Cardmarket Price Guide','CARDMARKET_PRODUCT_CATALOG_URL / CARDMARKET_PRICE_GUIDE_URL');
    validateOfficialCardmarketUrl(this.catalogUrl);validateOfficialCardmarketUrl(this.priceGuideUrl);
    const catalogStats=await this.loadCatalog(targets),priceStats=await this.loadPrices(targets);
    return {...catalogStats,...priceStats};
  }
  async loadCatalog(targets:any[]=[],options:any={}){
    // Two rounds of fixes (catalog-row norm() caching, internalPrintings
    // indexing) each measured as a big win in isolation but the real batch
    // STILL hit "CPU Time exceeded" afterward — meaning there's cost here
    // neither one touched, most likely the unavoidable per-row
    // parseProductName()+norm() scan below over the FULL feed (every row,
    // not just matches, since we can't know a row matches before parsing its
    // name). Rather than guess a fourth fix blind, these checkpoints log
    // real row counts/timings to Supabase's Logs tab so the actual feed size
    // and slow stage are visible even if this invocation still gets killed.
    const t0=Date.now();
    if(!this.catalogUrl)throw unavailable('Cardmarket Product Catalogue','CARDMARKET_PRODUCT_CATALOG_URL');
    validateOfficialCardmarketUrl(this.catalogUrl);
    const nonSinglesUrl=cardmarketNonSinglesUrl(this.catalogUrl);
    const nonSinglesResponse=nonSinglesUrl?await this.request(nonSinglesUrl):null;
    if(!nonSinglesResponse?.ok)throw new ProviderHttpError(this.name,nonSinglesResponse?.status||503,'Catalogo espansioni non disponibile');
    console.log('[market-sync] loadCatalog: non-singles fetched',{ms:Date.now()-t0});
    const expansions=new Map();
    const expansionPayload=await streamCardmarketRows(nonSinglesResponse,'products',(row:any)=>addExpansionName(expansions,row));
    console.log('[market-sync] loadCatalog: non-singles parsed',{rows:expansionPayload.rows,expansions:expansions.size,ms:Date.now()-t0});
    if(expansions.size<100)throw new Error('Catalogo espansioni Cardmarket non disponibile dal link Product Catalogue');
    const internalPrintings=options.internalPrintings||[],targetCatalogIds=new Set((targets||[]).map((row:any)=>norm(row.catalogCardId||row.catalog_card_id)).filter(Boolean));
    const wantedNames=new Set([...(targets||[]),...internalPrintings.filter((row:any)=>targetCatalogIds.has(norm(row.catalogCardId||row.catalog_card_id)))].map((row:any)=>norm(row.cardName||row.card_name)).filter(Boolean));
    const hintNames=new Set(internalPrintings.map((row:any)=>norm(row.cardName||row.card_name)).filter(Boolean)),hintProducts:any[]=[],hintSeen=new Set();
    console.log('[market-sync] loadCatalog: wantedNames built',{targets:targets.length,internalPrintings:internalPrintings.length,wantedNames:wantedNames.size,hintNames:hintNames.size,ms:Date.now()-t0});
    const catalogResponse=await this.request(this.catalogUrl);
    if(!catalogResponse.ok)throw new ProviderHttpError(this.name,catalogResponse.status,'Product Catalogue non disponibile');
    console.log('[market-sync] loadCatalog: main catalog fetched',{ms:Date.now()-t0});
    const catalog:any[]=[];
    let scanned=0;
    // Confirmed 2026-09-06 by dumping a raw feed row: Cardmarket's bulk
    // Product Catalogue has NO rarity anywhere (name is bare, e.g. "Enneacraft
    // - Atori.MAR" — no "(V.n - Rarity)" suffix, no dedicated field). The
    // "(V.1 - Ultra Rare)" title format only exists on the individual product
    // PAGE, which this feed doesn't provide. So when multiple products share
    // a name+expansion with no rarity to disambiguate them, there is no data
    // this resolver can use to pick automatically — manual "Vedi" + visual
    // confirm is the only option for those, not a parsing bug to fix here.
    const catalogPayload=await streamCardmarketRows(catalogResponse,'products',(row:any)=>{scanned++;if(scanned%50000===0)console.log('[market-sync] loadCatalog: scanning',{scanned,retained:catalog.length,ms:Date.now()-t0});const parsed=parseProductName(row.name||''),name=norm(parsed.cardName);if(!wantedNames.size||wantedNames.has(name))catalog.push(normalizeCardmarketProduct(row,expansions));if(hintNames.has(name)){const candidate=normalizeCardmarketProduct(row,expansions),key=`${name}:${candidate.providerExpansionId}`;if(candidate.providerExpansionId&&!hintSeen.has(key)){hintSeen.add(key);hintProducts.push({cardName:candidate.cardName,setName:candidate.setName,providerExpansionId:candidate.providerExpansionId});}}});
    console.log('[market-sync] loadCatalog: main catalog parsed',{totalRows:catalogPayload.rows,retainedRows:catalog.length,ms:Date.now()-t0});
    if(catalogPayload.rows<1000)throw new Error('Product Catalogue Cardmarket non valido: usa il link JSON diretto products_singles_3.json');
    this.catalog=catalog;this.expansionHints=buildCardmarketExpansionHints(internalPrintings,hintProducts);
    console.log('[market-sync] loadCatalog: done',{ms:Date.now()-t0});
    return {catalogRows:catalogPayload.rows,retainedCatalogRows:this.catalog.length,expansionRows:expansions.size,expansionHints:this.expansionHints.size};
  }
  async loadPrices(targets:any[]=[]){
    if(!this.priceGuideUrl)throw unavailable('Cardmarket Price Guide','CARDMARKET_PRICE_GUIDE_URL');
    validateOfficialCardmarketUrl(this.priceGuideUrl);
    const wantedProductIds=new Set((targets||[]).filter((row:any)=>isAuthorizedCardmarketMapping(row)).flatMap(mappingProductIds));
    this.prices=new Map();
    if(!wantedProductIds.size){this.sourceUpdatedAt=new Date().toISOString();this.loaded=true;return {priceRows:0,retainedPriceRows:0,mode:'prices_only'};}
    const priceResponse=await this.request(this.priceGuideUrl);
    if(!priceResponse.ok)throw new ProviderHttpError(this.name,priceResponse.status,'Price Guide non disponibile');
    const pricePayload=await streamCardmarketRows(priceResponse,'priceGuides',(row:any)=>{const id=productId(row);if(id&&wantedProductIds.has(id))this.prices.set(id,row);});
    if(pricePayload.rows<1000)throw new Error('Price Guide Cardmarket non valido: usa il link JSON diretto price_guide_3.json');
    this.sourceUpdatedAt=pricePayload.createdAt||priceResponse.headers?.get?.('last-modified')||new Date().toISOString();this.loaded=true;
    return {priceRows:pricePayload.rows,retainedPriceRows:this.prices.size,mode:'prices_only'};
  }
  async resolvePrinting(printing:any,options:any={}){return resolveCardmarketPrinting(printing,this.catalog,options);}
  async getMarketListings(){return [];}
  async getCurrentPrice(mapping:any){
    if(!this.loaded)await this.load([mapping]);const ids=mappingProductIds(mapping),rows=ids.map(id=>this.prices.get(id)).filter(Boolean);
    if(!rows.length)return {provider:this.name,status:'unavailable',prices:[],availableQuantity:null,sampleSize:0};
    const definitions:Record<string,string[]>={low:['low','Low Price','LOW'],trend:['trend','Trend Price','TREND'],average:['avg','Avg. Sell Price','AVG'],avg1:['avg1','AVG1'],avg7:['avg7','AVG7'],avg30:['avg30','AVG30'],
      foil_low:['low-foil','Foil Low','LOWFOIL'],foil_trend:['trend-foil','Foil Trend','TRENDFOIL'],foil_average:['avg-foil','Foil Sell','SELLFOIL'],foil_avg1:['avg1-foil','Foil AVG1'],foil_avg7:['avg7-foil','Foil AVG7'],foil_avg30:['avg30-foil','Foil AVG30']};
    const prices:any[]=[];for(const [type,keys] of Object.entries(definitions)){const values=rows.map(row=>numberFrom(row,keys)).filter(value=>value!=null);if(values.length)prices.push({type,value:Math.min(...values)});}
    return {provider:this.name,status:prices.length?'available':'unavailable',currency:'EUR',prices,availableQuantity:null,sampleSize:null,
      conditionReference:ids.length>1?`Price Guide Cardmarket · minimo tra ${ids.length} prodotti`:'Price Guide Cardmarket',capturedAt:new Date().toISOString(),sourceUpdatedAt:this.sourceUpdatedAt};
  }
}

function resolveCardmarketPrinting(printing:any,candidates:any[],options:any={}):any{
  const local=normalizePrinting(printing),internalRarity=normalizeMarketRarity(printing.rarity),name=norm(printing.cardName||printing.card_name),catalogId=norm(printing.catalogCardId||printing.catalog_card_id);
  const base=evidenceBase(printing,internalRarity),fail=(status:string,reason:string,extra:any={})=>({status,confidence:0,candidates:[],provider:'cardmarket',reason,evidence:{...base,...extra},priceScope:null,resolverVersion:CARDMARKET_RESOLVER_VERSION});
  if(!internalRarity)return fail(CARDMARKET_RESOLUTION_STATES.UNSUPPORTED,'unsupported_internal_rarity');
  const allPrintings=options.internalPrintings||[],family=internalFamily(printing,allPrintings),acceptedNames=new Set([name,...(catalogId?(internalPrintingsByCatalogId(allPrintings).get(catalogId)||[]).map((row:any)=>norm(row.cardName||row.card_name)):[])].filter(Boolean)),expansions=new Set(family.map((row:any)=>norm(row.setName||row.set_name)).filter(Boolean));
  if(local.expansion)expansions.add(local.expansion);
  if(!name||!expansions.size)return fail(CARDMARKET_RESOLUTION_STATES.UNRESOLVED,'name_or_expansion_missing');
  const hint=options.expansionHints?.get?.(setSeriesKey(printing.setCode||printing.set_code))||null;
  const products=dedupeProducts(cardmarketCandidatesByName(candidates||[],acceptedNames).filter((row:any)=>acceptedNames.has(row._normName??norm(row.cardName||row.name))&&(
    [...expansions].some(expansion=>[row.setName||row.expansion,...(row.expansionNames||[])].some((label:any)=>sameCardmarketExpansion(expansion as string,label)))||(hint&&String(row.providerExpansionId||row.provider_expansion_id||'')===hint.providerExpansionId)
  )));
  if(!products.length)return fail(CARDMARKET_RESOLUTION_STATES.UNRESOLVED,'provider_product_not_found',{acceptedNames:[...acceptedNames].sort(),acceptedExpansions:[...expansions].sort(),expansionHint:hint});
  const internalRarities=[...new Set(family.map((row:any)=>normalizeMarketRarity(row.rarity)).filter(Boolean))].sort();
  const exactRarity=products.filter((row:any)=>normalizeMarketRarity(row.rarity)===internalRarity);
  const providerRarityKnown=products.filter((row:any)=>normalizeMarketRarity(row.rarity));
  let matches:any[]=[];
  if(exactRarity.length)matches=exactRarity;
  else if(providerRarityKnown.length){
    const candidateDetails=providerRarityKnown.map((row:any)=>({productId:productId(row),cardName:row.cardName||row.name||'',rarity:row.rarity||'',expansion:row.setName||row.expansion||'',foil:row.foil??null,productUrl:row.productUrl||(productId(row)?`https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(productId(row))}`:'')}));
    return {...fail(CARDMARKET_RESOLUTION_STATES.UNRESOLVED,'provider_rarity_mismatch',{internalRarities,providerRarities:[...new Set(providerRarityKnown.map((row:any)=>normalizeMarketRarity(row.rarity)))].sort(),candidateCount:products.length,candidates:candidateDetails}),candidates:providerRarityKnown};
  }
  else matches=products;
  if(matches.length>1){const expansionIds=[...new Set(matches.map((row:any)=>String(row.providerExpansionId||row.provider_expansion_id||'')).filter(Boolean))];
    if(expansionIds.length===1){const first=matches[0],candidateProductIds=matches.map(productId).filter(Boolean),candidateDetails=matches.map((row:any)=>({productId:productId(row),cardName:row.cardName||row.name||'',rarity:row.rarity||'',expansion:row.setName||row.expansion||'',foil:row.foil??null,productUrl:row.productUrl||(productId(row)?`https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(productId(row))}`:'')}));return {status:CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE,confidence:1,candidate:{providerExpansionId:expansionIds[0],provider_expansion_id:expansionIds[0],setName:first.setName||first.expansion||'',expansion:first.setName||first.expansion||'',foil:null},candidates:matches,provider:'cardmarket',reason:'multiple_provider_products_aggregate_minimum',priceScope:{product:'minimum_across_candidates',language:'aggregate',edition:'aggregate',rarity:'aggregate',foil:'parallel_columns_unassigned'},resolverVersion:CARDMARKET_RESOLVER_VERSION,evidence:{...base,internalRarities,candidateCount:matches.length,candidateProductIds,candidates:candidateDetails,providerExpansionId:expansionIds[0],acceptedExpansions:[...expansions].sort(),identityBasis:['card_name','provider_expansion_id','multiple_provider_product_ids','minimum_price']}};}
    return {...fail(CARDMARKET_RESOLUTION_STATES.AMBIGUOUS,'multiple_provider_expansions',{internalRarities,candidateCount:matches.length,providerExpansionIds:expansionIds}),candidates:matches};}
  const candidate=matches[0],providerRarity=normalizeMarketRarity(candidate.rarity);
  if(!providerRarity&&internalRarities.length>1)return {...fail(CARDMARKET_RESOLUTION_STATES.AMBIGUOUS,'internal_rarity_conflict_provider_rarity_missing',{internalRarities,candidateCount:1}),candidates:[candidate]};
  const priceScope={language:'aggregate',edition:'aggregate',rarity:providerRarity?'specific':'aggregate',foil:candidate.foil==null?'parallel_columns_unassigned':'specific'};
  return {status:CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE,confidence:1,candidate,candidates:[candidate],provider:'cardmarket',reason:'unique_provider_product_aggregate_variant_scope',priceScope,resolverVersion:CARDMARKET_RESOLVER_VERSION,
    evidence:{...base,providerProductId:productId(candidate),providerProductUrl:candidate.productUrl||(productId(candidate)?`https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(productId(candidate))}`:''),providerCardName:candidate.cardName||candidate.name||'',providerExpansion:candidate.setName||candidate.expansion||'',providerExpansionId:candidate.providerExpansionId||candidate.provider_expansion_id||null,
      providerRarity:providerRarity||null,providerFoil:candidate.foil??null,providerHasSetCode:false,internalSetFamily:setFamilyKey(printing.setCode||printing.set_code),internalCatalogFamilySize:family.length,
      internalRarities,candidateCount:1,acceptedExpansions:[...expansions].sort(),identityBasis:['card_name','provider_expansion_id','unique_provider_product_id','internal_set_family']}};
}
function normalizeMarketRarity(value:any):string|null{const rarity=norm(value);return /^\d+$/.test(rarity)?'Common':SUPPORTED_RARITIES.get(rarity)||null;}
function isAuthorizedCardmarketMapping(mapping:any):boolean{if(mapping?.resolution_status==='manual')return true;const status=mapping?.resolverStatus||mapping?.resolver_status||mapping?.provider_metadata?.resolverStatus;return mapping?.resolution_status==='resolved'&&[CARDMARKET_RESOLUTION_STATES.EXACT,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE].includes(status);}
function cardmarketMappingNeedsResolver(mapping:any):boolean{if(mapping?.resolution_status==='manual')return false;return ['unresolved','ambiguous'].includes(mapping?.resolution_status)||String(mapping?.provider_metadata?.resolverVersion||'')!==String(CARDMARKET_RESOLVER_VERSION);}

// --- Market Variant Registry: SHADOW MODE ----------------------------------
// Copia manuale di resolveYgoMarketVariant()/shouldPersistMarketVariantShadow()/
// summarizeMarketVariantDecisions() da market/providers.js (stesso motivo
// isAuthorizedCardmarketMapping sopra — il bundler non risolve "../"). Gira
// SOLO in aggiunta al resolver legacy sopra, mai al posto suo: bodies[] (il
// path che scrive market_provider_printings, quindi il prezzo live) non
// viene toccato da nessuna riga qui sotto. Se questo blocco lancia,
// resolveCardmarketTargets() deve continuare come se non esistesse — vedi il
// try/catch attorno alla sua unica chiamata più in basso.
const MARKET_VARIANT_STATUS=Object.freeze({UNRESOLVED:'unresolved',RESOLVED:'resolved',AMBIGUOUS:'ambiguous',CONFLICT:'conflict',VERIFIED:'verified'});
const MARKET_VARIANT_SOURCE=Object.freeze({MANUAL:'manual',REGISTRY:'registry',RESOLVER:'resolver',LEGACY:'legacy'});
function normalizeYgoRarityKey(value:any):string|null{
  const key=String(value||'').replace(/['’]/g,'').replace(/[^A-Za-z0-9]+/g,' ').trim().toUpperCase();
  return key||null;
}
function canonicalYgoRarity(rawRarity:any,aliasMap:Map<string,string>):string|null{
  const key=normalizeYgoRarityKey(rawRarity);
  if(!key||!aliasMap)return null;
  return aliasMap.get(key)||null;
}
function resolveYgoMarketVariant({existingVariant=null as any,cardmarketCandidates=[] as any[],rarityCanonical=null as string|null,legacyMapping=null as any,forceRefresh=false}={}):any{
  if(existingVariant?.verified&&existingVariant?.cardmarket_product_id){
    return ygoMarketVariantResult({mappingStatus:MARKET_VARIANT_STATUS.VERIFIED,mappingSource:existingVariant.mapping_source===MARKET_VARIANT_SOURCE.MANUAL?MARKET_VARIANT_SOURCE.MANUAL:MARKET_VARIANT_SOURCE.REGISTRY,mappingConfidence:1,cardmarketProductId:existingVariant.cardmarket_product_id,cardmarketExpansionId:existingVariant.cardmarket_expansion_id||null,candidateProductIds:[],verified:true,reason:'verified_mapping_preserved'});
  }
  if(!forceRefresh&&existingVariant?.mapping_status===MARKET_VARIANT_STATUS.RESOLVED&&existingVariant?.cardmarket_product_id){
    return ygoMarketVariantResult({mappingStatus:MARKET_VARIANT_STATUS.RESOLVED,mappingSource:MARKET_VARIANT_SOURCE.REGISTRY,mappingConfidence:existingVariant.mapping_confidence??0.8,cardmarketProductId:existingVariant.cardmarket_product_id,cardmarketExpansionId:existingVariant.cardmarket_expansion_id||null,candidateProductIds:[],verified:false,reason:'resolved_registry_preserved'});
  }
  const candidates=dedupeYgoVariantCandidates(cardmarketCandidates);
  if(!candidates.length)return ygoLegacyFallbackResult(legacyMapping)||ygoMarketVariantResult({mappingStatus:MARKET_VARIANT_STATUS.UNRESOLVED,reason:'no_cardmarket_candidates'});
  const exactRarity=rarityCanonical?candidates.filter(row=>row.rarityCanonical===rarityCanonical):[];
  const pool=exactRarity.length?exactRarity:candidates;
  if(pool.length===1){
    const only=pool[0];
    return ygoMarketVariantResult({mappingStatus:MARKET_VARIANT_STATUS.RESOLVED,mappingSource:MARKET_VARIANT_SOURCE.RESOLVER,mappingConfidence:exactRarity.length?1:0.6,cardmarketProductId:only.productId,cardmarketExpansionId:only.expansionId,candidateProductIds:candidates.map(row=>row.productId),verified:false,reason:exactRarity.length?'exact_rarity_single_candidate':'single_candidate_no_rarity_signal'});
  }
  const distinctExpansions=new Set(pool.map(row=>row.expansionId).filter(Boolean));
  return ygoMarketVariantResult({mappingStatus:distinctExpansions.size>1?MARKET_VARIANT_STATUS.CONFLICT:MARKET_VARIANT_STATUS.AMBIGUOUS,mappingSource:MARKET_VARIANT_SOURCE.RESOLVER,mappingConfidence:0,candidateProductIds:pool.map(row=>row.productId),verified:false,reason:exactRarity.length?'multiple_exact_rarity_candidates':'multiple_candidates_no_rarity_signal'});
}
function ygoLegacyFallbackResult(legacyMapping:any):any{
  if(!legacyMapping?.cardmarketProductId)return null;
  const candidateCount=Array.isArray(legacyMapping.candidateProductIds)?legacyMapping.candidateProductIds.length:1;
  return ygoMarketVariantResult({mappingStatus:candidateCount>1?MARKET_VARIANT_STATUS.AMBIGUOUS:MARKET_VARIANT_STATUS.RESOLVED,mappingSource:MARKET_VARIANT_SOURCE.LEGACY,mappingConfidence:candidateCount>1?0:0.4,cardmarketProductId:legacyMapping.cardmarketProductId,cardmarketExpansionId:legacyMapping.cardmarketExpansionId||null,candidateProductIds:legacyMapping.candidateProductIds||[],verified:false,reason:'legacy_fallback_not_verified'});
}
function ygoMarketVariantResult({mappingStatus,mappingSource=null as any,mappingConfidence=0,cardmarketProductId=null as any,cardmarketExpansionId=null as any,candidateProductIds=[] as string[],verified=false,reason}:any):any{
  return {mappingStatus,mappingSource,mappingConfidence,cardmarketProductId,cardmarketExpansionId,candidateProductIds,verified,reason};
}
function dedupeYgoVariantCandidates(rows:any[]):any[]{
  const byId=new Map<string,any>();
  for(const row of rows||[]){
    const id=String(row.productId||row.providerProductId||row.provider_product_id||'').trim();
    if(!id||byId.has(id))continue;
    byId.set(id,{productId:id,expansionId:String(row.expansionId||row.providerExpansionId||row.provider_expansion_id||'')||null,rarityCanonical:row.rarityCanonical||null});
  }
  return [...byId.values()];
}
function shouldPersistMarketVariantShadow(existingVariant:any):boolean{
  return !(existingVariant?.verified&&existingVariant?.cardmarket_product_id);
}
function summarizeMarketVariantDecisions(decisions:any[]):any{
  const summary:any={processed:0,verified:0,resolved:0,ambiguous:0,conflict:0,unresolved:0,errors:0};
  for(const decision of decisions||[]){summary.processed++;summary[decision.mappingStatus]=(summary[decision.mappingStatus]||0)+1;}
  return summary;
}
// --- Exact Price Shadow: copia manuale di exactPriceForProduct()/
// isExactPriceEligible()/classifyPriceComparison() da market/providers.js
// (stesso motivo delle altre copie sopra). MAI un Math.min tra prodotti —
// getCurrentPrice() sopra resta l'unico posto con quella logica, per il
// prezzo legacy/aggregate; qui si legge SEMPRE un solo cardmarket_product_id.
// Stessa mappa di chiavi grezze già inline dentro getCurrentPrice() sopra
// (impossibile condividerla tra i due file per il vincolo del bundler): se
// la cambi lì, cambiala anche qui.
const CARDMARKET_PRICE_TYPE_FIELDS:Record<string,string[]>={low:['low','Low Price','LOW'],trend:['trend','Trend Price','TREND'],average:['avg','Avg. Sell Price','AVG'],avg1:['avg1','AVG1'],avg7:['avg7','AVG7'],avg30:['avg30','AVG30'],
  foil_low:['low-foil','Foil Low','LOWFOIL'],foil_trend:['trend-foil','Foil Trend','TRENDFOIL'],foil_average:['avg-foil','Foil Sell','SELLFOIL'],foil_avg1:['avg1-foil','Foil AVG1'],foil_avg7:['avg7-foil','Foil AVG7'],foil_avg30:['avg30-foil','Foil AVG30']};
const EXACT_PRICE_TYPE_PRIORITY=['trend','average','avg7','low','lowest'];
function exactPriceForProduct(pricesByProductId:Map<string,any>,productId:any):any{
  const key=String(productId||'').trim();
  if(!key)return null;
  const row=pricesByProductId?.get?.(key);
  if(!row)return null;
  for(const type of EXACT_PRICE_TYPE_PRIORITY){
    const fields=CARDMARKET_PRICE_TYPE_FIELDS[type]||(type==='lowest'?CARDMARKET_PRICE_TYPE_FIELDS.low:null);
    if(!fields)continue;
    const value=numberFrom(row,fields);
    if(value!=null)return {type,value,currency:'EUR'};
  }
  return null;
}
function isExactPriceEligible(variant:any):boolean{
  if(!variant?.cardmarket_product_id)return false;
  return Boolean(variant.verified)||variant.mapping_status==='resolved';
}
function classifyPriceComparison(legacyPrice:any,exactPrice:any):any{
  const legacy=typeof legacyPrice==='number'&&Number.isFinite(legacyPrice)?legacyPrice:null;
  const exact=typeof exactPrice==='number'&&Number.isFinite(exactPrice)?exactPrice:null;
  if(exact==null)return {comparisonStatus:'exact_missing',absoluteDelta:null,percentageDelta:null};
  if(legacy==null)return {comparisonStatus:'legacy_missing',absoluteDelta:null,percentageDelta:null};
  const absoluteDelta=Math.round((exact-legacy)*10000)/10000;
  const percentageDelta=legacy!==0?Math.round((absoluteDelta/legacy)*10000)/100:null;
  let comparisonStatus:string;
  if(Math.abs(absoluteDelta)<0.01)comparisonStatus='same';
  else if(percentageDelta!=null&&Math.abs(percentageDelta)<5)comparisonStatus='close';
  else comparisonStatus='different';
  return {comparisonStatus,absoluteDelta,percentageDelta};
}
// Copia manuale di parseCardmarketProductTitle()/classifyCandidateMetadataFetchOutcome()/
// validateCandidateMetadataBatch()/shouldRefreshCandidateMetadata() da
// market/providers.js (stesso motivo delle altre copie sopra).
const PRODUCT_TITLE_TRAILING_SUFFIX=/\s*[|–-]\s*Cardmarket\s*$/i;
function parseCardmarketProductTitle(rawTitle:any):any{
  const cleaned=String(rawTitle||'').replace(PRODUCT_TITLE_TRAILING_SUFFIX,'').trim();
  if(!cleaned)return {productName:'',variantNumber:null,rarityRaw:null};
  const match=cleaned.match(/^(.*?)\s*\(V\.(\d+)\s*-\s*([^()]+)\)\s*$/i);
  if(!match)return {productName:cleaned,variantNumber:null,rarityRaw:null};
  return {productName:match[1].trim(),variantNumber:match[2],rarityRaw:match[3].trim()};
}
function classifyCandidateMetadataFetchOutcome({httpStatus=null as number|null,threwError=false,titleFound=false,rarityRaw=null as string|null}={}):string{
  if(threwError)return 'parse_error';
  if(httpStatus===404)return 'not_found';
  if(httpStatus===403||httpStatus===429)return 'blocked';
  if(httpStatus!=null&&httpStatus>=400)return 'blocked';
  if(!titleFound)return 'parse_error';
  return rarityRaw?'resolved':'incomplete';
}
function validateCandidateMetadataBatch(printingIdsList:string[],productIdsList:string[],{maxPrintings=5,maxProductIds=40}={}):any{
  const printingCount=new Set((printingIdsList||[]).filter(Boolean)).size;
  const productCount=new Set((productIdsList||[]).filter(Boolean)).size;
  if(printingCount===0)return {ok:false,reason:'empty_printing_ids',printingCount,productCount};
  if(printingCount>maxPrintings)return {ok:false,reason:'too_many_printings',printingCount,productCount};
  if(productCount>maxProductIds)return {ok:false,reason:'too_many_product_ids',printingCount,productCount};
  return {ok:true,printingCount,productCount};
}
function shouldRefreshCandidateMetadata(lastCheckedAt:any,force=false,maxAgeDays=7):boolean{
  if(force)return true;
  if(!lastCheckedAt)return true;
  const last=new Date(lastCheckedAt).getTime();
  if(!Number.isFinite(last))return true;
  return (Date.now()-last)>maxAgeDays*24*60*60*1000;
}
// Un solo GET per l'intera tabella alias (~55 righe) per run di sync, mai per
// printing — la stessa identica tabella scritta dalla migration
// 20260912110000_ygo_market_variant_registry.sql.
async function fetchYgoRarityAliasMap():Promise<Map<string,string>>{
  const page=await restPages('ygo_rarity_aliases?select=alias_key,canonical_code',{key:(row:any)=>row.alias_key});
  return new Map(page.rows.map((row:any)=>[row.alias_key,row.canonical_code]));
}
// Un solo GET a blocchi (mai per printing) per sapere quali printing hanno
// già una riga ygo_market_variants — indispensabile per non riscrivere mai
// un mapping verified (sezione 6/11 dello shadow mode).
async function fetchExistingYgoMarketVariants(printingIds:string[]):Promise<Map<string,any>>{
  const byId=new Map<string,any>(),unique=[...new Set(printingIds.filter(Boolean))];
  for(let index=0;index<unique.length;index+=150){
    const chunk=unique.slice(index,index+150);
    const page=await restPages(`ygo_market_variants?select=printing_id,mapping_status,mapping_source,mapping_confidence,cardmarket_product_id,cardmarket_expansion_id,verified&printing_id=in.(${chunk.map(encodeURIComponent).join(',')})`,{key:(row:any)=>row.printing_id});
    for(const row of page.rows)byId.set(String(row.printing_id),row);
  }
  return byId;
}
// Batch upsert, stesso pattern/dimensione blocco già usato per
// market_provider_printings poco più sotto (200 righe) — nessuna riga con
// verified=true finisce mai qui dentro, filtrata a monte da
// shouldPersistMarketVariantShadow().
async function upsertYgoMarketVariantsShadow(rows:any[]):Promise<void>{
  for(let index=0;index<rows.length;index+=200){
    await rest('ygo_market_variants?on_conflict=printing_id','POST',rows.slice(index,index+200),{'Prefer':'resolution=merge-duplicates,return=minimal'});
  }
}

function buildCardmarketExpansionHints(printings:any[]=[],products:any[]=[]):Map<string,any>{
  const groups=new Map<string,Set<string>>(),productsByName=new Map<string,any[]>();
  for(const row of printings||[]){const key=setSeriesKey(row.setCode||row.set_code),name=norm(row.cardName||row.card_name);if(!key||!name)continue;if(!groups.has(key))groups.set(key,new Set());groups.get(key)!.add(name);}
  for(const row of products||[]){const name=norm(row.cardName||row.name),expansionId=String(row.providerExpansionId||row.provider_expansion_id||'');if(!name||!expansionId)continue;if(!productsByName.has(name))productsByName.set(name,[]);productsByName.get(name)!.push(row);}
  const hints=new Map<string,any>();
  for(const [key,names] of groups){
    const candidates=new Map<string,any>();
    for(const name of names)for(const row of productsByName.get(name)||[]){const expansionId=String(row.providerExpansionId||row.provider_expansion_id||'');if(!candidates.has(expansionId))candidates.set(expansionId,{providerExpansionId:expansionId,expansion:row.setName||row.expansion||'',matchedNames:new Set()});candidates.get(expansionId).matchedNames.add(name);}
    const ranked=[...candidates.values()].map(row=>({...row,overlap:row.matchedNames.size})).sort((left,right)=>right.overlap-left.overlap||left.providerExpansionId.localeCompare(right.providerExpansionId,'en',{numeric:true}));
    const best=ranked[0],runner=ranked[1];
    if(best?.overlap>=2&&(!runner||best.overlap>runner.overlap))hints.set(key,{providerExpansionId:best.providerExpansionId,expansion:best.expansion,overlap:best.overlap,internalCards:names.size});
  }
  return hints;
}

function normalizePrinting(row:any){return {game:norm(row.game),catalogId:norm(row.catalogCardId||row.catalog_card_id),setCode:normCode(row.setCode||row.set_code),
  expansion:norm(row.setName||row.set_name||row.expansion),rarity:norm(row.rarity),language:norm(row.language),edition:norm(row.edition),foil:bool(row.foil)};}
// Index a catalog once per feed, avoiding a full scan for every printing.
const cardmarketNameIndexes=new WeakMap<any[],Map<string,any[]>>();
function cardmarketCandidatesByName(rows:any[],names:Set<string>):any[]{
  let index=cardmarketNameIndexes.get(rows);
  if(!index){index=new Map();for(const row of rows){const key=row._normName??norm(row.cardName||row.name);if(!index.has(key))index.set(key,[]);index.get(key).push(row);}cardmarketNameIndexes.set(rows,index);}
  return [...names].flatMap(name=>index.get(name)||[]);
}
function productId(row:any):string{return String(read(row,['providerProductId','provider_product_id','idProduct','Product ID','product_id','id'])||'');}
function mappingProductIds(mapping:any):string[]{const many=mapping?.provider_metadata?.candidateProductIds||mapping?.candidateProductIds||[];return [...new Set([mapping?.providerProductId||mapping?.provider_product_id||'',...(Array.isArray(many)?many:[])].map(String).filter(Boolean))];}
function evidenceBase(printing:any,rarity:any){return {internalPrintingId:printing.printingId||printing.printing_id||printing.id||null,catalogCardId:String(printing.catalogCardId||printing.catalog_card_id||''),internalSetCode:printing.setCode||printing.set_code||'',internalSetName:printing.setName||printing.set_name||'',internalRarity:rarity,internalLanguage:printing.language||'',internalEdition:printing.edition||''};}
function setFamilyKey(value:any):string{const code=String(value||'').trim().toUpperCase(),match=code.match(/^([A-Z0-9]+)-[A-Z]{1,3}([0-9]+)$/);return match?`${match[1]}:${match[2]}`:normCode(code);}
function setSeriesKey(value:any):string{return String(value||'').trim().toUpperCase().split('-',1)[0].replace(/[^A-Z0-9]/g,'');}
function sameCardmarketExpansion(left:any,right:any):boolean{const a=norm(left),b=norm(right);return a===b||Boolean(a&&b&&cardmarketExpansionKey(a)===cardmarketExpansionKey(b));}
function cardmarketExpansionKey(value:any):string{
  let key=norm(value);
  const aliases:Record<string,string>={
    "starter deck: yu-gi-oh! 5d's":"5d's starter deck 2008",
    "starter deck: yu-gi-oh! 5d's 2009":"5d's starter deck 2009",
    'starter deck 2006':'gx starter deck 2006',
    'servitore del faraone':"pharaoh's servant (sdf)",
    'mazzo introduttivo yugi':'starter deck: yugi (miy)',
    'mazzo introduttivo kaiba':'starter deck: kaiba (mik)',
    'mazzo introduttivo yugi evoluzione':'starter deck: yugi evolution',
    'gold series 2009':'gold series 2',
    'zexal collection tin':'2013 zexal collection',
    'super starter power-up pack':'super starter power-up',
    "legendary collection 4: joey's world mega pack":'legendary collection 4: mega pack',
    "warriors' strike structure deck":"structure deck: warrior's strike"
  };
  key=(aliases[key]||key).replace(/\s*\(tcg\)$/,'').replace(/^dark revelation volume /,'dark revelation ');
  // Cardmarket groups both waves under the same annual collector tin set.
  const tin=key.match(/^(?:(20\d{2}) collectible tins(?: wave \d+)?|collectible tins (20\d{2})(?: wave \d+)?|collector['’]s tins (20\d{2})(?::.*)?)$/);
  if(tin)return 'collector tins '+(tin[1]||tin[2]||tin[3]);
  key=key.replace(/^(hidden arsenal \d+):.*$/,'$1')
    .replace(/^(duelist pack: yusei)( \d+)?$/,'$1 fudo$2');
  return key.replace(/\b([a-z0-9]+)['’]s\b/g,'$1').replace(/\b(?:structure|starter) deck\b/g,' ').replace(/\bmega[- ]tins?\b/g,'mega tin').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}
// resolveCardmarketPrinting() used to scan the FULL internalPrintings array
// (the app's own card_printings table, easily thousands of rows) TWICE per
// target being resolved — once here, once more inline for acceptedNames —
// each re-running norm() per row. Same class of bug as the Cardmarket
// catalog hotspot (see normalizeCardmarketProduct's _normName), just on a
// different dataset; together these two were still enough to blow the Edge
// Function's CPU-time budget even after the catalog-side fix alone.
// internalPrintings is the SAME array reference for every target within one
// resolver batch, so indexing it once by catalogCardId and caching that
// index by array identity turns both O(targets x printings) scans into a
// one-time O(printings) build plus O(1) lookups per target.
const internalPrintingsIndexCache=new WeakMap<any[],Map<string,any[]>>();
function internalPrintingsByCatalogId(rows:any[]){
  let index=internalPrintingsIndexCache.get(rows);
  if(!index){
    index=new Map();
    for(const row of rows||[]){const key=norm(row.catalogCardId||row.catalog_card_id);if(!key)continue;if(!index.has(key))index.set(key,[]);index.get(key)!.push(row);}
    internalPrintingsIndexCache.set(rows,index);
  }
  return index;
}
function internalFamily(printing:any,rows:any[]):any[]{const catalog=norm(printing.catalogCardId||printing.catalog_card_id),family=setFamilyKey(printing.setCode||printing.set_code),sameCatalog=internalPrintingsByCatalogId(rows).get(catalog)||[],result=sameCatalog.filter((row:any)=>setFamilyKey(row.setCode||row.set_code)===family);return result.length?result:[printing];}
function dedupeProducts(rows:any[]):any[]{const byId=new Map<string,any>();for(const row of rows||[]){const id=productId(row);if(id&&!byId.has(id))byId.set(id,row);}return [...byId.values()].sort((a,b)=>productId(a).localeCompare(productId(b),'en',{numeric:true}));}
function cardmarketNonSinglesUrl(value:string):string{try{const url=new URL(value);if(!/products_singles_\d+\.json$/i.test(url.pathname))return'';url.pathname=url.pathname.replace(/products_singles_(\d+)\.json$/i,'products_nonsingles_$1.json');return url.toString();}catch{return'';}}
function addExpansionName(values:Map<string,string[]>,row:any){const id=String(row.idExpansion||row.expansion_id||'');if(!id)return;const name=cleanExpansionName(row.name||'');if(!name)return;const names=values.get(id)||[];if(!names.includes(name))names.push(name);names.sort((a,b)=>a.length-b.length||a.localeCompare(b));values.set(id,names);}
function cleanExpansionName(value:any):string{return String(value).replace(/\s+(?:Booster(?: Box| Case)?|Box Set|Display|Case|Pack|Deck|Tin|Box)(?:\s*\([^)]*\))?$/i,'').trim();}
function normalizeCardmarketProduct(row:any,expansions:Map<string,string[]>){const rawName=String(row.name||''),parsed=parseProductName(rawName),id=productId(row),expansionId=String(row.idExpansion||'');return {...row,id,providerProductId:id,provider_product_id:id,game:'yugioh',rawName,cardName:parsed.cardName,name:parsed.cardName,rarity:parsed.rarity,setName:expansions.get(expansionId)?.[0]||'',expansion:expansions.get(expansionId)?.[0]||'',expansionNames:expansions.get(expansionId)||[],providerExpansionId:expansionId,provider_expansion_id:expansionId,foil:parsed.foil,productUrl:`https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(id)}`,
  // norm() does Unicode NFD normalization + several regex passes — cheap once,
  // but resolveCardmarketPrinting() used to call it fresh on every catalog row
  // for EVERY target being resolved (T targets x N catalog rows), which is
  // almost certainly what was burning the Edge Function's CPU-time budget on
  // a real production-sized catalogue (confirmed via "CPU Time exceeded",
  // 2026-09-06). Precomputing it once per row here turns that into O(N).
  _normName:norm(parsed.cardName)};}
function parseProductName(value:any){const raw=String(value).trim(),match=raw.match(/^(.*?)\s*\(V\.\d+\s*-\s*([^()]+)\)\s*$/i),cardName=(match?.[1]||raw).trim(),rarity=(match?.[2]||'').trim();return {cardName,rarity,foil:/\bfoil\b/i.test(rarity)?true:null};}
function numberFrom(row:any,keys:string[]):number|null{const raw=read(row,keys);if(raw==null||raw==='')return null;const value=Number(String(raw).replace(',','.'));return Number.isFinite(value)&&value>=0?value:null;}
function read(row:any,keys:string[]):any{for(const key of keys)if(row?.[key]!=null&&row[key]!=='')return row[key];return null;}
function norm(value:any):string{return decodeEntities(value).replace(/^el shaddoll meshahrail$/i,'El Shaddoll Meshachrer').replace(/^reeshaddoll wendikurhu$/i,'Reeshaddoll Wendikuruhu').replace(/^black jack the shadow-armored knight$/i,'Shadowreaver Knight 21').replace(/^early palm gets the win$/i,'First Striker Advantage').replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g,'').replace(/maliss <([pq])>/gi,'maliss $1').replace(/falchion\s*(?:beta|β)/gi,'falchion beta').replace(/^(H\.E\.R\.O\. Flash!) \(BLZD\)$/i,'$1').replace(/\\+(?=["'])/g,'').replace(/[“”]/g,'"').replace(/"+/g,'"').replace(/[★☆]/g,'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[‐‑‒–—]/g,'-').trim().toLowerCase().replace(/\s+/g,' ');}
function decodeEntities(value:any):string{return String(value??'').replace(/&(apos|#39|#x27);/gi,"'").replace(/&(quot|#34|#x22);/gi,'"').replace(/&amp;/gi,'&').replace(/&nbsp;/gi,' ').replace(/&#(x?[0-9a-f]+);/gi,(_,raw)=>{const radix=raw[0].toLowerCase()==='x'?16:10,code=Number.parseInt(raw.replace(/^x/i,''),radix);return Number.isFinite(code)&&code>0&&code<=0x10ffff?String.fromCodePoint(code):_;});}
function normCode(value:any):string{return norm(value).replace(/[^a-z0-9]/g,'');}
function bool(value:any):boolean|null{if(value==null||value==='')return null;if(typeof value==='boolean')return value;return ['1','true','yes','foil'].includes(norm(value));}
function backoff(attempt:number):number{return Math.min(16000,2000*(2**attempt))+Math.floor(Math.random()*250);}
function delay(ms:number):Promise<void>{return new Promise(resolve=>setTimeout(resolve,ms));}
function unavailable(provider:string,secret:string):Error{const error:any=new Error(`${provider} non disponibile: configurare ${secret}`);error.code='provider_unavailable';return error;}
async function safeText(response:any):Promise<string>{try{return (await response.text()).slice(0,500);}catch{return '';}}
function validateOfficialCardmarketUrl(value:string){const url=new URL(value);if(url.protocol!=='https:'||!(url.hostname==='www.cardmarket.com'||url.hostname==='cardmarket.com'||url.hostname.endsWith('.cardmarket.com')||url.hostname==='downloads.s3.cardmarket.com'))throw new Error('URL Cardmarket non ufficiale rifiutato');}
async function streamCardmarketRows(response:any,key:string,onRow:(row:any)=>void=()=>{}):Promise<{rows:number,createdAt:string}>{
  if(!response?.body)throw new Error(`Feed Cardmarket ${key} senza contenuto`);
  const reader=response.body.getReader(),decoder=new TextDecoder();
  // Building each row's JSON text one character at a time via `object+=char`
  // used to burn Edge Function CPU-time badly on Cardmarket's full catalogue
  // (tens/hundreds of thousands of rows -> that many repeated string copies)
  // and got the whole sync killed with "CPU Time exceeded" before it ever
  // got to run a query. Tracking start/end indexes and slicing once per row
  // (joining only the rare row that straddles two stream chunks) does the
  // exact same boundary detection with none of the per-character copying.
  let header='',started=false,finished=false,inString=false,escaped=false,depth=0,rows=0,createdAt='',parts:string[]=[],partStart=0;
  const consume=(text:string)=>{let index=0;if(!started){header+=text;const match=header.match(new RegExp(`"${key}"\\s*:\\s*\\[`));if(!match){if(header.length>131072)throw new Error(`Array ${key} non trovato nel feed Cardmarket`);return;}createdAt=header.match(/"createdAt"\s*:\s*"([^"]+)"/)?.[1]||'';index=match.index!+match[0].length;header=header.slice(index);text=header;index=0;header='';started=true;}
    if(depth>0)partStart=0;
    for(;index<text.length&&!finished;index++){const char=text[index];if(depth===0){if(char==='{'){depth=1;partStart=index;inString=false;escaped=false;}else if(char===']')finished=true;continue;}if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue;}if(char==='"'){inString=true;continue;}if(char==='{')depth++;else if(char==='}'&&--depth===0){parts.push(text.slice(partStart,index+1));onRow(JSON.parse(parts.length>1?parts.join(''):parts[0]));rows++;parts=[];}}
    if(depth>0)parts.push(text.slice(partStart));
  };
  while(true){const {value,done}=await reader.read();if(done)break;consume(decoder.decode(value,{stream:true}));}
  consume(decoder.decode());if(!started||!finished)throw new Error(`Feed Cardmarket ${key} incompleto`);return {rows,createdAt};
}

class ProviderHttpError extends Error {provider:string;status:number;constructor(provider:string,status:number,detail=''){super(`${provider}: HTTP ${status}${detail?` — ${detail}`:''}`);this.provider=provider;this.status=status;}}

const supabaseUrl=Deno.env.get('SUPABASE_URL')||'';
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const syncSecret=Deno.env.get('MARKET_SYNC_SECRET')||'';
// Non un tetto "giornaliero ragionevole" da ritoccare a mano ogni volta che
// la raccolta cresce — resolveCardmarketPrinting() è O(1) per target dopo il
// caching di norm()/internalPrintingsByCatalogId (2026-09-06, ~28ms/500
// target = ~0.056ms/target), e il costo dominante di un run resta il
// download una tantum del feed Cardmarket, identico a 1500 o 40000 target
// risolti contro di esso. Questo numero esiste solo come paracadute contro
// un backlog davvero patologico (es. un futuro bump di CARDMARKET_RESOLVER_
// VERSION che rimette in coda l'intero catalogo mapping in un colpo solo):
// finché il conteggio reale di pending resta sotto questa soglia, ogni notte
// smaltisce TUTTO l'arretrato, senza bisogno di alzare questo valore man
// mano che raccolta/team crescono.
const RESOLVER_SAFETY_CEILING=50000;

Deno.serve(async request=>{
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(!supabaseUrl||!serviceKey)return json({error:'backend_not_configured'},503);
  if(!syncSecret)return json({error:'sync_secret_not_configured'},503);
  if(request.headers.get('x-market-sync-secret')!==syncSecret)return json({error:'unauthorized'},401);
  const payload=await request.json().catch(()=>({}));
  // Canary admin-only del Market Variant Registry — invocato SOLO da
  // run_ygo_market_variant_canary (RPC FPT via net.http_post, mai dal
  // browser direttamente: l'header x-market-sync-secret sopra resta
  // l'unico gate HTTP, il client non lo vede mai). Ramo indipendente, nessun
  // altro payload rilevante quando presente.
  const marketVariantCanaryRunId=typeof payload?.marketVariantCanaryRunId==='string'?payload.marketVariantCanaryRunId.trim():'';
  if(marketVariantCanaryRunId){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marketVariantCanaryRunId))return json({error:'invalid_market_variant_canary_run_id'},400);
    return json(await runYgoMarketVariantCanary(marketVariantCanaryRunId));
  }
  // Fase finale dello shadow pricing — stesso identico pattern del canary
  // sopra (run_ygo_market_variant_price_shadow via net.http_post, mai dal
  // browser). Legge la stessa coda ygo_market_variant_canary_runs (generica,
  // non serve una seconda tabella), ma processa un genere diverso di run.
  const marketVariantPriceShadowRunId=typeof payload?.marketVariantPriceShadowRunId==='string'?payload.marketVariantPriceShadowRunId.trim():'';
  if(marketVariantPriceShadowRunId){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marketVariantPriceShadowRunId))return json({error:'invalid_market_variant_price_shadow_run_id'},400);
    return json(await runYgoMarketVariantPriceShadow(marketVariantPriceShadowRunId));
  }
  // Arricchimento metadata candidati Cardmarket — stesso pattern, stessa
  // coda. NON uno scraper generale: solo i candidate_product_ids delle
  // printing passate da request_ygo_market_variant_candidate_metadata_refresh.
  const marketVariantCandidateMetadataRunId=typeof payload?.marketVariantCandidateMetadataRunId==='string'?payload.marketVariantCandidateMetadataRunId.trim():'';
  if(marketVariantCandidateMetadataRunId){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marketVariantCandidateMetadataRunId))return json({error:'invalid_market_variant_candidate_metadata_run_id'},400);
    return json(await runYgoMarketVariantCandidateMetadataRefresh(marketVariantCandidateMetadataRunId,payload?.force===true));
  }
  const dryTargetPrintingIds=printingIds(payload?.dryTargetPrintingIds);
  const canaryPrintingIds=printingIds(payload?.canaryPrintingIds);
  if(payload?.dryTargetPrintingIds&&!dryTargetPrintingIds.length)return json({error:'invalid_dry_target_printing_ids'},400);
  if(payload?.canaryPrintingIds&&!canaryPrintingIds.length)return json({error:'invalid_canary_printing_ids'},400);
  if(dryTargetPrintingIds.length&&canaryPrintingIds.length)return json({error:'dry_target_and_canary_are_mutually_exclusive'},400);
  if(payload?.scheduled===true&&!isThreeInRome(new Date()))return json({ok:true,status:'skipped',reason:'outside_03_europe_rome'});
  const providers=[
    new CardmarketPriceGuideProvider({catalogUrl:Deno.env.get('CARDMARKET_PRODUCT_CATALOG_URL')||'',priceGuideUrl:Deno.env.get('CARDMARKET_PRICE_GUIDE_URL')||''})
  ];
  const resolverBatchSize=payload?.resolvePending===true?Math.max(1,Math.min(RESOLVER_SAFETY_CEILING,Number(payload?.resolverBatchSize)||100)):0;
  if(resolverBatchSize){const cardmarket=providers.find(provider=>provider.name==='cardmarket');const result=await syncProvider(cardmarket,{recoverStale:payload?.recoverStale===true,pendingResolverLimit:resolverBatchSize,skipPrices:true});return json({ok:['succeeded','partial','skipped'].includes(result.status),mode:'resolver_batch',results:[result]});}
  // Coda di refresh prioritario (ogni ~15 min, job separato da quello
  // notturno): scarica il price guide feed UNA volta per ciclo e aggiorna
  // solo le mappature manuali confermate di recente (refresh_requested_at
  // valorizzato da set_market_mapping_manual). Sempre pricesOnly: sono già
  // 'manual' con provider_product_id noto, non serve ririsolvere/scaricare
  // il catalogo prodotti. Vedi supabase-market-watch-priority-refresh.sql.
  if(payload?.priorityQueue===true){const cardmarket=providers.find(provider=>provider.name==='cardmarket');const result=await syncProvider(cardmarket,{priorityOnly:true,pricesOnly:true});return json({ok:['succeeded','partial','skipped'].includes(result.status),mode:'priority_queue',results:[result]});}
  if(payload?.refreshQueue===true){
    const cardmarket=providers.find(provider=>provider.name==='cardmarket');
    // One provider cycle per invocation keeps feed parsing within the CPU budget.
    const result=await syncProvider(cardmarket,{newPrintingsOnly:true});
    return json({ok:['succeeded','partial','skipped'].includes(result.status),mode:'refresh_queue',results:[result]});
  }
  const scheduled=payload?.scheduled===true,pricesOnly=payload?.pricesOnly===true||scheduled;
  if(canaryPrintingIds.length&&pricesOnly)return json({error:'canary_requires_full_mode'},400);
  if(dryTargetPrintingIds.length){
    const cardmarket=providers.find(provider=>provider.name==='cardmarket');
    return json(await dryTargetCardmarket(cardmarket,dryTargetPrintingIds));
  }
  const results=[];
  if(scheduled){const cardmarket=providers.find(provider=>provider.name==='cardmarket');results.push(await syncProvider(cardmarket,{pendingResolverLimit:RESOLVER_SAFETY_CEILING,skipPrices:true}));}
  for(const provider of providers)results.push(await syncProvider(provider,{recoverStale:payload?.recoverStale===true,pricesOnly,targetPrintingIds:canaryPrintingIds}));
  return json({ok:results.some(row=>['succeeded','partial'].includes(row.status)),mode:canaryPrintingIds.length?'canary':scheduled?'scheduled':pricesOnly?'prices_only':'full',results});
});

// request()'s per-attempt AbortSignal.timeout(180000) only bounds a single
// HTTP attempt; with maxAttempts=3 retries plus backoff, one loadCatalog()/
// loadPrices() call can legitimately run ~15-20 minutes if Cardmarket's feed
// is slow that day — long past any Edge Function platform time limit. When
// that happens the platform kills the isolate outright, skipping our own
// catch block entirely: the sync_runs row is left at status='running' with
// no error, and (since the scheduled sync only runs once a day) it silently
// blocks all price updates until the next day's attempt notices the >2h-old
// stale lock. Observed twice in a row (2026-09-05 and 2026-09-06). Racing
// each call against a much shorter internal deadline turns that into a
// prompt, diagnosable 'failed' row instead of a day-long silent hang.
// Generous relative to a normal run (a few seconds), but well under any
// plausible platform execution ceiling — pending confirmation of the actual
// limit from Supabase's own dashboard/logs, worth tuning once known.
const CATALOG_DEADLINE_MS=90_000,PRICES_DEADLINE_MS=60_000;
function withDeadline<T>(promise:Promise<T>,ms:number,label:string):Promise<T>{
  let timer:any;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(`${label}: timeout interno dopo ${Math.round(ms/1000)}s`),{code:'internal_timeout'})),ms);});
  return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}

async function syncProvider(provider:any,{recoverStale=false,pricesOnly=false,targetPrintingIds=[] as string[],pendingResolverLimit=0,skipPrices=false,priorityOnly=false,newPrintingsOnly=false}={}){
  const metadata=provider.getPriceMetadata();
  if(metadata.status==='unavailable')return {provider:provider.name,status:'unavailable',reason:'secret_or_feed_missing'};
  if(recoverStale)await releaseProviderSync(provider.name);
  const runId=await rpc('begin_market_provider_sync',{p_provider:provider.name});
  if(!runId)return {provider:provider.name,status:'skipped',reason:'sync_already_running'};
  let requestCount=0,snapshots=0,failures=0,feedStats:any=null,targetPages=0,printingPages=0,printingRows=0;
  try{
    const targetResult=await rpcPages('market_sync_targets',{p_provider:provider.name},{order:'printing_id.asc,variant_key.asc.nullslast,mapping_id.asc.nullslast',key:(row:any)=>row.mapping_id||`${row.printing_id}:${row.variant_key||'default'}`});
    const allTargets=targetResult.rows;targetPages=targetResult.requests;
    const selectedIds=new Set(targetPrintingIds),targets=selectedIds.size?allTargets.filter((target:any)=>selectedIds.has(String(target.printing_id))):newPrintingsOnly?allTargets.filter((target:any)=>!target.mapping_id||target.refresh_requested_at).slice(0,100):priorityOnly?allTargets.filter((target:any)=>target.refresh_requested_at):pendingResolverLimit?allTargets.filter(cardmarketMappingNeedsResolver).slice(0,pendingResolverLimit):allTargets;
    if(newPrintingsOnly&&targets.length&&targets.every((target:any)=>isAuthorizedCardmarketMapping(target)))pricesOnly=true;
    if((pendingResolverLimit||priorityOnly||newPrintingsOnly)&&!targets.length){await finish(runId,'succeeded',{request_count:requestCount,attempt_count:1,metadata:{targets:0,snapshots:0,resolverVersion:CARDMARKET_RESOLVER_VERSION}});return {provider:provider.name,status:'skipped',reason:priorityOnly?'no_pending_refresh_requests':'resolver_current',targets:0,pagination:{targetPages,targetRows:allTargets.length}};}
    const unique=new Map<string,any>();
    for(const target of targets){const key=`${target.printing_id}:${target.variant_key||'default'}`;if(!unique.has(key))unique.set(key,target);}
    let resolvedTargets=[...unique.values()];
    if(provider.name==='cardmarket'){
      if(pricesOnly){feedStats=await withDeadline(provider.loadPrices(resolvedTargets),PRICES_DEADLINE_MS,'loadPrices');requestCount+=1;}
      else{
        const printingResult=await listCardPrintings(),internalPrintings=await withCanonicalCardNames(printingResult.rows,resolvedTargets);
        printingPages=printingResult.requests;printingRows=printingResult.rows.length;
        const catalogStats=await withDeadline(provider.loadCatalog(resolvedTargets,{internalPrintings}),CATALOG_DEADLINE_MS,'loadCatalog');requestCount+=3;
        resolvedTargets=await resolveCardmarketTargets(provider,resolvedTargets,internalPrintings);
        if(skipPrices){const mappingStates=resolvedTargets.reduce((counts:any,target:any)=>{const key=target.provider_metadata?.resolverStatus||target.resolution_status||'unresolved';counts[key]=(counts[key]||0)+1;return counts;},{}),unresolved=resolvedTargets.filter((target:any)=>!isAuthorizedCardmarketMapping(target)).length,status=unresolved?'partial':'succeeded';await finish(runId,status,{request_count:requestCount,attempt_count:1,error_code:unresolved?'target_failures':null,error_message:unresolved?`${unresolved} mapping non risolti`:null,metadata:{targets:unique.size,snapshots:0,resolverOnly:true}});return {provider:provider.name,status,targets:unique.size,snapshots:0,failures:unresolved,feedStats:catalogStats,mappingStates,pagination:{targetPages,targetRows:allTargets.length,printingPages,printingRows}};}
        const priceStats=await withDeadline(provider.loadPrices(resolvedTargets),PRICES_DEADLINE_MS,'loadPrices');requestCount+=1;
        feedStats={...catalogStats,...priceStats};
      }
    }
    const pendingSnapshots=[];
    for(const target of resolvedTargets){
      try{
        const authorized=provider.name==='cardmarket'?isAuthorizedCardmarketMapping(target):['resolved','manual'].includes(target.resolution_status);
        if(!authorized||!target.mapping_id){failures++;continue;}
        const value=await provider.getCurrentPrice(target);
        if(value.status!=='available')continue;
        const capturedAt=value.capturedAt||new Date().toISOString(),day=capturedAt.slice(0,10);
        for(const price of pricesForTarget(value.prices,target)){
          const eur=value.currency==='EUR'?price.value:null;
          pendingSnapshots.push({
            printing_id:target.printing_id,provider_mapping_id:target.mapping_id,provider:provider.name,price_type:price.type,
            original_currency:value.currency,original_price:price.value,normalized_currency:'EUR',normalized_price:eur,
            language:target.language||'',condition_reference:value.conditionReference||target.condition_reference||'',foil:target.foil,
            available_quantity:value.availableQuantity,sample_size:value.sampleSize,source_updated_at:value.sourceUpdatedAt||null,captured_at:capturedAt,
            observation_key:`${target.mapping_id}:${day}`,metadata:{variantKey:target.variant_key||'default',productUrl:target.provider_metadata?.productUrl||null,
              resolverStatus:target.provider_metadata?.resolverStatus||null,resolverVersion:target.provider_metadata?.resolverVersion||null,priceScope:target.provider_metadata?.priceScope||null}
          });snapshots++;
        }
      }catch(error:any){failures++;await recordMappingError(target.mapping_id,error);}
    }
    for(let index=0;index<pendingSnapshots.length;index+=250)await rest('market_price_snapshots?on_conflict=provider,observation_key,price_type','POST',pendingSnapshots.slice(index,index+250),{'Prefer':'resolution=ignore-duplicates,return=minimal'});
    // Un target di priorityOnly è stato "servito" (prezzo trovato o fallito
    // per un motivo reale, non per errori sistemici a monte che avrebbero
    // già lanciato prima di qui) — si toglie dalla coda a prescindere
    // dall'esito per non ritentarlo ogni ~15 min all'infinito.
    if((priorityOnly||newPrintingsOnly)&&resolvedTargets.length){
      const ids=resolvedTargets.filter((target:any)=>priorityOnly||target.refresh_requested_at).map((target:any)=>target.mapping_id).filter(Boolean);
      if(ids.length)await rest(`market_provider_printings?id=in.(${ids.map(encodeURIComponent).join(',')})`,'PATCH',{refresh_requested_at:null},{'Prefer':'return=minimal'});
    }
    const mappingStates=resolvedTargets.reduce((counts:any,target:any)=>{const key=target.provider_metadata?.resolverStatus||target.resolution_status||'unresolved';counts[key]=(counts[key]||0)+1;return counts;},{});
    const status=failures&&snapshots?'partial':failures&&!snapshots?'failed':'succeeded';
    await finish(runId,status,{request_count:requestCount,attempt_count:1,error_code:failures?'target_failures':null,error_message:failures?`${failures} mapping non aggiornati`:null,metadata:{targets:unique.size,snapshots}});
    return {provider:provider.name,status,targets:unique.size,requestedTargets:selectedIds.size||null,snapshots,failures,feedStats,mappingStates,pagination:{targetPages,targetRows:allTargets.length,printingPages,printingRows}};
  }catch(error:any){await finish(runId,'failed',{request_count:requestCount,attempt_count:1,error_code:error?.code||'sync_failed',error_message:String(error?.message||error).slice(0,500)});return {provider:provider.name,status:'failed',error:String(error?.message||error)};}
}

async function dryTargetCardmarket(provider:any,ids:string[]){
  if(provider.getPriceMetadata().status==='unavailable')return {ok:false,mode:'dry_target',provider:'cardmarket',status:'unavailable',reason:'secret_or_feed_missing'};
  const printingResult=await listCardPrintings(),wanted=new Set(ids),targets=printingResult.rows.filter((row:any)=>wanted.has(String(row.id))).map(printingTarget),allPrintings=await withCanonicalCardNames(printingResult.rows,targets);
  const catalogStats=await provider.loadCatalog(targets,{internalPrintings:allPrintings}),resolved:any[]=[],expansionHints=provider.expansionHints;
  for(const target of targets)resolved.push({target,resolution:await provider.resolvePrinting(target,{internalPrintings:allPrintings,expansionHints})});
  const authorized=resolved.filter((row:any)=>[CARDMARKET_RESOLUTION_STATES.EXACT,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE].includes(row.resolution.status)).map((row:any)=>({
    ...row.target,resolution_status:'resolved',provider_product_id:row.resolution.candidate?.providerProductId,provider_metadata:{resolverStatus:row.resolution.status,priceScope:row.resolution.priceScope,candidateProductIds:row.resolution.evidence?.candidateProductIds||[]}
  }));
  const priceStats=await provider.loadPrices(authorized),prices=new Map();
  for(const target of authorized){const value=await provider.getCurrentPrice(target);prices.set(String(target.printing_id),pricesForTarget(value.prices||[],target));}
  return {ok:true,mode:'dry_target',provider:'cardmarket',requested:ids.length,found:targets.length,catalogStats,priceStats,pagination:{printingPages:printingResult.requests,printingRows:allPrintings.length},results:resolved.map((row:any)=>({
    printingId:row.target.printing_id,cardName:row.target.card_name,setCode:row.target.set_code,rarity:row.target.rarity,status:row.resolution.status,reason:row.resolution.reason,
    expansionHint:expansionHints.get(String(row.target.set_code||'').split('-',1)[0].replace(/[^A-Z0-9]/gi,'').toUpperCase())||null,
    providerProductId:row.resolution.candidate?.providerProductId||null,priceScope:row.resolution.priceScope||null,prices:prices.get(String(row.target.printing_id))||[],
    candidates:(row.resolution.candidates||[]).map((candidate:any)=>({providerProductId:candidate.providerProductId||candidate.provider_product_id||null,rawName:candidate.rawName||candidate.name||'',cardName:candidate.cardName||'',rarity:candidate.rarity||'',providerExpansionId:candidate.providerExpansionId||candidate.provider_expansion_id||null,expansion:candidate.setName||candidate.expansion||''})),
    nameCandidates:provider.catalog.filter((candidate:any)=>String(candidate.cardName||candidate.name||'').trim().toLowerCase()===String(row.target.card_name||'').trim().toLowerCase()).slice(0,12).map((candidate:any)=>({providerProductId:candidate.providerProductId||null,providerExpansionId:candidate.providerExpansionId||null,expansion:candidate.setName||''}))
  }))};
}

// Canary admin-only del Market Variant Registry: eseguito SOLO su richiesta
// di run_ygo_market_variant_canary (RPC FPT, admin-gated) via net.http_post
// server-side — il client non conosce mai MARKET_SYNC_SECRET, l'header
// arriva già impostato dalla richiesta Postgres->Edge Function. Legge la
// catalogazione Cardmarket (necessaria per calcolare i candidati, stesso
// costo di dryTargetCardmarket) ma NON chiama mai loadPrices()/getCurrentPrice
// né resolveCardmarketTargets(): niente prezzi, niente scritture su
// market_provider_printings/market_price_snapshots (quindi nessun trigger su
// market_price_events). Scrive SOLO ygo_market_variants (shadow) + il
// risultato dentro la riga ygo_market_variant_canary_runs stessa.
async function runYgoMarketVariantCanary(runId:string){
  const runRows=await restPages(`ygo_market_variant_canary_runs?id=eq.${encodeURIComponent(runId)}&select=id,status,printing_ids`,{key:(row:any)=>row.id});
  const run=runRows.rows[0];
  if(!run)return {ok:false,runId,error:'canary_run_not_found'};
  // Idempotenza: una run già running/succeeded/failed non viene mai
  // rielaborata, anche se questo endpoint viene invocato una seconda volta
  // per lo stesso run_id (retry di rete, doppio click admin, ecc.).
  if(run.status!=='pending')return {ok:true,runId,skipped:true,status:run.status,reason:'already_processed'};
  await rest(`ygo_market_variant_canary_runs?id=eq.${encodeURIComponent(runId)}`,'PATCH',{status:'running',started_at:new Date().toISOString()},{'Prefer':'return=minimal'});
  try{
    const ids=printingIds(run.printing_ids);
    if(!ids.length)throw new Error('printing_ids della run non valido (vuoto, >20, o non tutti UUID)');
    const provider=(new CardmarketPriceGuideProvider({catalogUrl:Deno.env.get('CARDMARKET_PRODUCT_CATALOG_URL')||'',priceGuideUrl:Deno.env.get('CARDMARKET_PRICE_GUIDE_URL')||''}));
    if(provider.getPriceMetadata().status==='unavailable')throw new Error('provider cardmarket non disponibile (secret/feed mancanti)');
    const printingRows=await listCardPrintingsByIds(ids);
    const targets=printingRows.map(printingTarget);
    if(!targets.length)throw new Error('nessuna printing Yu-Gi-Oh! valida trovata per questi id');
    const allPrintings=await withCanonicalCardNames(printingRows,targets);
    await provider.loadCatalog(targets,{internalPrintings:allPrintings});
    const expansionHints=provider.expansionHints;
    const [rarityAliasMap,existingVariants]=await Promise.all([
      fetchYgoRarityAliasMap(),
      fetchExistingYgoMarketVariants(targets.map((target:any)=>String(target.printing_id)))
    ]);
    const resultRows:any[]=[],shadowRowsToPersist:any[]=[];
    for(const target of targets){
      const resolution=await provider.resolvePrinting(target,{internalPrintings:allPrintings,expansionHints});
      const rarityCanonical=canonicalYgoRarity(target.rarity,rarityAliasMap);
      const cardmarketCandidates=(resolution.candidates||[]).map((row:any)=>({
        productId:row.providerProductId||row.provider_product_id,
        expansionId:row.providerExpansionId||row.provider_expansion_id,
        rarityCanonical:canonicalYgoRarity(row.rarity,rarityAliasMap)
      }));
      const existingVariant=existingVariants.get(String(target.printing_id))||null;
      const decision=resolveYgoMarketVariant({existingVariant,cardmarketCandidates,rarityCanonical});
      const verifiedPreserved=!shouldPersistMarketVariantShadow(existingVariant);
      if(!verifiedPreserved){
        shadowRowsToPersist.push({
          printing_id:target.printing_id,rarity_raw:target.rarity||'',rarity_canonical:rarityCanonical,
          cardmarket_product_id:decision.cardmarketProductId,cardmarket_expansion_id:decision.cardmarketExpansionId,
          candidate_product_ids:decision.candidateProductIds,mapping_source:decision.mappingSource,
          mapping_confidence:decision.mappingConfidence,mapping_status:decision.mappingStatus,
          resolution_reason:decision.reason,verified:false
        });
      }
      resultRows.push({
        printing_id:target.printing_id,set_code:target.set_code,rarity:target.rarity,
        legacy_status:resolution.status,shadow_status:decision.mappingStatus,shadow_product_id:decision.cardmarketProductId,
        candidate_product_ids:decision.candidateProductIds,resolution_reason:decision.reason,verified_preserved:verifiedPreserved
      });
    }
    if(shadowRowsToPersist.length)await upsertYgoMarketVariantsShadow(shadowRowsToPersist);
    const summary=summarizeMarketVariantDecisions(resultRows.map((row:any)=>({mappingStatus:row.shadow_status})));
    await rest(`ygo_market_variant_canary_runs?id=eq.${encodeURIComponent(runId)}`,'PATCH',{status:'succeeded',finished_at:new Date().toISOString(),result:{rows:resultRows,summary}},{'Prefer':'return=minimal'});
    return {ok:true,runId,status:'succeeded',rows:resultRows.length};
  }catch(error:any){
    const message=String(error?.message||error).slice(0,1000);
    console.error('[market-sync] market variant canary: run fallita',{runId,error:message});
    await rest(`ygo_market_variant_canary_runs?id=eq.${encodeURIComponent(runId)}`,'PATCH',{status:'failed',finished_at:new Date().toISOString(),error_message:message},{'Prefer':'return=minimal'}).catch(()=>{});
    return {ok:false,runId,status:'failed',error:message};
  }
}
async function listCardPrintingsByIds(ids:string[]){
  const result=await restPages(`card_printings?select=id,game,catalog_card_id,card_name,set_code,set_name,rarity&game=eq.yugioh&id=in.(${ids.map(encodeURIComponent).join(',')})`,{key:(row:any)=>row.id});
  return result.rows;
}

// Fase finale dello shadow pricing: confronta legacy_price (già in
// market_price_snapshots, via ygo_market_variant_legacy_reference_prices —
// stessa selezione di list_market_watch_owned_page, sola lettura) con
// exact_price (il SOLO cardmarket_product_id verificato/risolto per quella
// printing, mai un Math.min tra candidati). Come il canary: invocato SOLO da
// run_ygo_market_variant_price_shadow via net.http_post, mai dal browser.
// Più leggero del canary: non serve loadCatalog() (l'identità del prodotto è
// già nota), solo loadPrices() UNA volta per l'intero batch di product_id
// eleggibili. Scrive SOLO ygo_market_variant_price_shadow (diagnostica) + il
// risultato nella riga della run — mai market_provider_printings/
// market_price_snapshots/market_price_events/market_watch_items/
// collection_items/decks/loans.
async function runYgoMarketVariantPriceShadow(runId:string){
  const runRows=await restPages(`ygo_market_variant_canary_runs?id=eq.${encodeURIComponent(runId)}&select=id,status,printing_ids`,{key:(row:any)=>row.id});
  const run=runRows.rows[0];
  if(!run)return {ok:false,runId,error:'canary_run_not_found'};
  if(run.status!=='pending')return {ok:true,runId,skipped:true,status:run.status,reason:'already_processed'};
  await rest(`ygo_market_variant_canary_runs?id=eq.${encodeURIComponent(runId)}`,'PATCH',{status:'running',started_at:new Date().toISOString()},{'Prefer':'return=minimal'});
  try{
    const ids=printingIds(run.printing_ids);
    if(!ids.length)throw new Error('printing_ids della run non valido (vuoto, >20, o non tutti UUID)');
    const printingRows=await listCardPrintingsByIds(ids);
    if(!printingRows.length)throw new Error('nessuna printing Yu-Gi-Oh! valida trovata per questi id');
    const variantsByPrinting=await fetchExistingYgoMarketVariants(ids);
    const eligiblePrintings=printingRows.filter((row:any)=>isExactPriceEligible(variantsByPrinting.get(String(row.id))||null));

    const provider=(new CardmarketPriceGuideProvider({catalogUrl:Deno.env.get('CARDMARKET_PRODUCT_CATALOG_URL')||'',priceGuideUrl:Deno.env.get('CARDMARKET_PRICE_GUIDE_URL')||''}));
    if(eligiblePrintings.length){
      if(provider.getPriceMetadata().status==='unavailable')throw new Error('provider cardmarket non disponibile (secret/feed mancanti)');
      // Un solo batch: un provider_product_id univoco per printing eleggibile,
      // MAI più id per lo stesso target (niente candidateProductIds qui) —
      // loadPrices() farà un solo fetch dell'intero Price Guide, filtrato a
      // questi soli product_id (stesso meccanismo del canary/dryTarget).
      const syntheticTargets=eligiblePrintings.map((row:any)=>({resolution_status:'manual',provider_product_id:variantsByPrinting.get(String(row.id)).cardmarket_product_id}));
      await provider.loadPrices(syntheticTargets);
    }

    const legacyRows=await rpc('ygo_market_variant_legacy_reference_prices',{p_printing_ids:ids});
    const legacyByPrinting=new Map((legacyRows||[]).map((row:any)=>[String(row.printing_id),row]));

    const resultRows:any[]=[],shadowRowsToPersist:any[]=[];
    for(const printingRow of printingRows){
      const variant=variantsByPrinting.get(String(printingRow.id))||null;
      const eligible=isExactPriceEligible(variant);
      const legacyRow=legacyByPrinting.get(String(printingRow.id))||null;
      const legacyPrice=legacyRow&&legacyRow.normalized_price!=null?Number(legacyRow.normalized_price):null;
      const exactEntry=eligible?exactPriceForProduct(provider.prices,variant.cardmarket_product_id):null;
      const exactPrice=exactEntry?exactEntry.value:null;
      const {comparisonStatus,absoluteDelta,percentageDelta}=classifyPriceComparison(legacyPrice,exactPrice);
      resultRows.push({
        printingId:printingRow.id,cardName:printingRow.card_name,setCode:printingRow.set_code,rarity:printingRow.rarity,
        mappingStatus:variant?.mapping_status||'unresolved',mappingSource:variant?.mapping_source||null,verified:Boolean(variant?.verified),
        cardmarketProductId:variant?.cardmarket_product_id||null,
        legacyPrice,exactPrice,priceType:exactEntry?.type||null,absoluteDelta,percentageDelta,comparisonStatus
      });
      if(eligible&&variant?.cardmarket_product_id){
        shadowRowsToPersist.push({
          printing_id:printingRow.id,cardmarket_product_id:variant.cardmarket_product_id,
          legacy_price:legacyPrice,exact_price:exactPrice,price_type:exactEntry?.type||null,
          absolute_delta:absoluteDelta,percentage_delta:percentageDelta,comparison_status:comparisonStatus,
          mapping_status:variant.mapping_status,mapping_source:variant.mapping_source,verified:Boolean(variant.verified)
        });
      }
    }
    if(shadowRowsToPersist.length)await rest('ygo_market_variant_price_shadow?on_conflict=printing_id','POST',shadowRowsToPersist,{'Prefer':'resolution=merge-duplicates,return=minimal'});

    const summary=resultRows.reduce((counts:any,row:any)=>{counts[row.comparisonStatus]=(counts[row.comparisonStatus]||0)+1;return counts;},{same:0,close:0,different:0,legacy_missing:0,exact_missing:0});
    await rest(`ygo_market_variant_canary_runs?id=eq.${encodeURIComponent(runId)}`,'PATCH',{status:'succeeded',finished_at:new Date().toISOString(),result:{rows:resultRows,summary}},{'Prefer':'return=minimal'});
    return {ok:true,runId,status:'succeeded',rows:resultRows.length};
  }catch(error:any){
    const message=String(error?.message||error).slice(0,1000);
    console.error('[market-sync] market variant price shadow: run fallita',{runId,error:message});
    await rest(`ygo_market_variant_canary_runs?id=eq.${encodeURIComponent(runId)}`,'PATCH',{status:'failed',finished_at:new Date().toISOString(),error_message:message},{'Prefer':'return=minimal'}).catch(()=>{});
    return {ok:false,runId,status:'failed',error:message};
  }
}

// Un solo GET a blocchi per sapere quali printing hanno già candidate_product_ids
// e la loro rarity canonica — mai per printing singola. Colonne diverse da
// fetchExistingYgoMarketVariants() sopra (qui serve candidate_product_ids,
// che quella non seleziona): funzione separata invece di allargare quella
// già usata altrove, per non rischiare di cambiarne il costo/comportamento.
async function fetchYgoMarketVariantCandidates(printingIds:string[]):Promise<Map<string,any>>{
  const byId=new Map<string,any>(),unique=[...new Set(printingIds.filter(Boolean))];
  for(let index=0;index<unique.length;index+=150){
    const chunk=unique.slice(index,index+150);
    const page=await restPages(`ygo_market_variants?select=printing_id,rarity_canonical,candidate_product_ids&printing_id=in.(${chunk.map(encodeURIComponent).join(',')})`,{key:(row:any)=>row.printing_id});
    for(const row of page.rows)byId.set(String(row.printing_id),row);
  }
  return byId;
}

// Arricchimento metadata dei SOLI candidate_product_ids già in coda di
// review — mai uno scraper generale. Invocato SOLO da
// request_ygo_market_variant_candidate_metadata_refresh via net.http_post,
// mai dal browser. IMPORTANTE: un fetch di prova (WebFetch, fuori da questa
// function) verso cardmarket.com — sia un idProduct reale sia la semplice
// home category — è tornato HTTP 403 su entrambi. Questo codice è scritto
// per gestire correttamente quell'esito (fetch_status='blocked', pannello
// che continua a funzionare), non per garantire che il fetch funzioni in
// produzione: non ho modo di verificarlo da questa sessione, e per policy
// esplicita non tento alcun bypass/headless/proxy se accade di nuovo.
// Un prodotto alla volta, nessun retry, piccolo delay tra un fetch e il
// successivo — mai Promise.all, mai un crawler.
const CANDIDATE_METADATA_FETCH_DELAY_MS=400;
async function runYgoMarketVariantCandidateMetadataRefresh(runId:string,force:boolean){
  const runRows=await restPages(`ygo_market_variant_canary_runs?id=eq.${encodeURIComponent(runId)}&select=id,status,printing_ids`,{key:(row:any)=>row.id});
  const run=runRows.rows[0];
  if(!run)return {ok:false,runId,error:'canary_run_not_found'};
  if(run.status!=='pending')return {ok:true,runId,skipped:true,status:run.status,reason:'already_processed'};
  await rest(`ygo_market_variant_canary_runs?id=eq.${encodeURIComponent(runId)}`,'PATCH',{status:'running',started_at:new Date().toISOString()},{'Prefer':'return=minimal'});
  try{
    const printingIdList=printingIds(run.printing_ids);
    if(!printingIdList.length)throw new Error('printing_ids della run non valido (vuoto, >20, o non tutti UUID)');
    const variantsByPrinting=await fetchYgoMarketVariantCandidates(printingIdList);

    const productIdSet=new Set<string>();
    for(const printingId of printingIdList){
      const variant=variantsByPrinting.get(String(printingId));
      const ids:string[]=Array.isArray(variant?.candidate_product_ids)?variant.candidate_product_ids:[];
      for(const id of ids){if(String(id||'').trim())productIdSet.add(String(id).trim());}
    }
    const batchCheck=validateCandidateMetadataBatch(printingIdList,[...productIdSet]);
    const productIdList=[...productIdSet].slice(0,40); // difensivo: la RPC già limita a 5 printing, ma non fidarsi mai solo del client

    const existingMetadata=new Map<string,any>();
    if(productIdList.length){
      const page=await restPages(`ygo_market_variant_candidate_metadata?select=cardmarket_product_id,last_checked_at&cardmarket_product_id=in.(${productIdList.map(encodeURIComponent).join(',')})`,{key:(row:any)=>row.cardmarket_product_id});
      for(const row of page.rows)existingMetadata.set(row.cardmarket_product_id,row);
    }
    const toFetch=productIdList.filter(id=>shouldRefreshCandidateMetadata(existingMetadata.get(id)?.last_checked_at||null,force));

    const rarityAliasMap=await fetchYgoRarityAliasMap();
    const metadataRows:any[]=[];
    const counts:any={fetched:0,skippedCache:productIdList.length-toFetch.length,resolved:0,incomplete:0,notFound:0,blocked:0,parseError:0};

    for(const candidateProductId of toFetch){
      if(metadataRows.length)await new Promise(resolve=>setTimeout(resolve,CANDIDATE_METADATA_FETCH_DELAY_MS));
      const productUrl=`https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(candidateProductId)}`;
      let httpStatus:number|null=null,threwError=false,titleFound=false,rawTitle='',canonicalUrl:string|null=null,fetchErrorMessage:string|null=null;
      try{
        const response=await fetch(productUrl,{headers:{'User-Agent':'FPT-Cards-MarketVariantResolver/1.0 (admin-triggered metadata check; not a crawler)'}});
        httpStatus=response.status;canonicalUrl=response.url||null;
        if(response.ok){
          const html=await response.text();
          const titleMatch=html.match(/<title[^>]*>([^<]*)<\/title>/i);
          if(titleMatch){titleFound=true;rawTitle=titleMatch[1].trim();}
        }else{
          fetchErrorMessage=`HTTP ${httpStatus}`;
        }
      }catch(error:any){threwError=true;fetchErrorMessage=String(error?.message||error).slice(0,500);}

      const parsed=titleFound?parseCardmarketProductTitle(rawTitle):{productName:'',variantNumber:null,rarityRaw:null};
      const rarityCanonical=parsed.rarityRaw?canonicalYgoRarity(parsed.rarityRaw,rarityAliasMap):null;
      const fetchStatus=classifyCandidateMetadataFetchOutcome({httpStatus,threwError,titleFound,rarityRaw:parsed.rarityRaw});
      counts.fetched++;
      if(fetchStatus==='resolved')counts.resolved++;else if(fetchStatus==='incomplete')counts.incomplete++;else if(fetchStatus==='not_found')counts.notFound++;else if(fetchStatus==='blocked')counts.blocked++;else counts.parseError++;

      metadataRows.push({
        cardmarket_product_id:candidateProductId,
        product_name:parsed.productName||null,
        rarity_raw:parsed.rarityRaw,rarity_canonical:rarityCanonical,
        variant_number:parsed.variantNumber,
        product_url:productUrl,canonical_url:canonicalUrl,
        metadata_source:'cardmarket_product_page',
        metadata_confidence:fetchStatus==='resolved'?0.7:null, // mai 1: è una lettura pagina, non una verifica umana
        fetch_status:fetchStatus,fetch_error:fetchErrorMessage,
        raw_metadata:titleFound?{title:rawTitle,url:productUrl}:null,
        last_checked_at:new Date().toISOString()
      });
    }
    if(metadataRows.length)await rest('ygo_market_variant_candidate_metadata?on_conflict=cardmarket_product_id','POST',metadataRows,{'Prefer':'resolution=merge-duplicates,return=minimal'});

    const summary={...counts,totalCandidates:productIdList.length,batchValidation:batchCheck};
    await rest(`ygo_market_variant_canary_runs?id=eq.${encodeURIComponent(runId)}`,'PATCH',{status:'succeeded',finished_at:new Date().toISOString(),result:{productIds:productIdList,summary}},{'Prefer':'return=minimal'});
    return {ok:true,runId,status:'succeeded',summary};
  }catch(error:any){
    const message=String(error?.message||error).slice(0,1000);
    console.error('[market-sync] market variant candidate metadata: run fallita',{runId,error:message});
    await rest(`ygo_market_variant_canary_runs?id=eq.${encodeURIComponent(runId)}`,'PATCH',{status:'failed',finished_at:new Date().toISOString(),error_message:message},{'Prefer':'return=minimal'}).catch(()=>{});
    return {ok:false,runId,status:'failed',error:message};
  }
}

async function resolveCardmarketTargets(provider:any,targets:any[],internalPrintings:any[]){
  const t0=Date.now();
  console.log('[market-sync] resolveCardmarketTargets: start',{targets:targets.length,catalog:provider.catalog?.length||0,internalPrintings:internalPrintings.length});
  const bodies=[],expansionHints=provider.expansionHints?.size?provider.expansionHints:buildCardmarketExpansionHints(internalPrintings,provider.catalog);
  // Market Variant Registry — SHADOW MODE. Un solo fetch (mai per printing)
  // per l'alias map e per le righe ygo_market_variants già esistenti. Se
  // fallisce (es. migration non ancora applicata su questo ambiente), lo
  // shadow resolver si disattiva silenziosamente per l'intero run: il
  // resolver legacy sotto (bodies[], l'unico che conta per il prezzo live)
  // non dipende in alcun modo da questo blocco.
  let shadowRarityAliasMap:Map<string,string>|null=null,shadowExistingVariants:Map<string,any>|null=null;
  if(provider.name==='cardmarket'){
    try{
      [shadowRarityAliasMap,shadowExistingVariants]=await Promise.all([
        fetchYgoRarityAliasMap(),
        fetchExistingYgoMarketVariants(targets.map((target:any)=>String(target.printing_id)))
      ]);
    }catch(error:any){
      console.error('[market-sync] market variant shadow: setup fallito, run senza shadow',{error:String(error?.message||error)});
      shadowRarityAliasMap=null;shadowExistingVariants=null;
    }
  }
  const shadowDecisions:any[]=[],shadowRowsToPersist:any[]=[];
  let index=0;
  for(const target of targets){
    index++;if(index%100===0)console.log('[market-sync] resolveCardmarketTargets: resolving',{index,total:targets.length,ms:Date.now()-t0});
    if(target.resolution_status==='manual'&&target.mapping_id)continue;
    const resolution=await provider.resolvePrinting(target,{internalPrintings,expansionHints});
    bodies.push(cardmarketResolutionBody(target,resolution));
    if(shadowRarityAliasMap&&shadowExistingVariants){
      try{
        const rarityCanonical=canonicalYgoRarity(target.rarity,shadowRarityAliasMap);
        const cardmarketCandidates=(resolution.candidates||[]).map((row:any)=>({
          productId:row.providerProductId||row.provider_product_id,
          expansionId:row.providerExpansionId||row.provider_expansion_id,
          rarityCanonical:canonicalYgoRarity(row.rarity,shadowRarityAliasMap)
        }));
        const existingVariant=shadowExistingVariants.get(String(target.printing_id))||null;
        const decision=resolveYgoMarketVariant({existingVariant,cardmarketCandidates,rarityCanonical});
        shadowDecisions.push(decision);
        if(shouldPersistMarketVariantShadow(existingVariant)){
          shadowRowsToPersist.push({
            printing_id:target.printing_id,rarity_raw:target.rarity||'',rarity_canonical:rarityCanonical,
            cardmarket_product_id:decision.cardmarketProductId,cardmarket_expansion_id:decision.cardmarketExpansionId,
            candidate_product_ids:decision.candidateProductIds,mapping_source:decision.mappingSource,
            mapping_confidence:decision.mappingConfidence,mapping_status:decision.mappingStatus,
            resolution_reason:decision.reason,verified:false
          });
        }
      }catch(error:any){
        shadowDecisions.push({mappingStatus:'errors'});
        console.error('[market-sync] market variant shadow: errore su una printing',{printingId:target.printing_id,error:String(error?.message||error)});
      }
    }
  }
  console.log('[market-sync] resolveCardmarketTargets: resolved',{targets:targets.length,ms:Date.now()-t0});
  if(shadowRowsToPersist.length){
    try{await upsertYgoMarketVariantsShadow(shadowRowsToPersist);}
    catch(error:any){console.error('[market-sync] market variant shadow: upsert fallito',{rows:shadowRowsToPersist.length,error:String(error?.message||error)});}
  }
  if(shadowDecisions.length)console.log('[market-sync] market variant shadow summary',summarizeMarketVariantDecisions(shadowDecisions));
  const saved=[];
  for(let index=0;index<bodies.length;index+=200){const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_printings?on_conflict=printing_id,provider,variant_key`,{method:'POST',headers:{...headers(),Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify(bodies.slice(index,index+200))});if(!response.ok)throw new Error(`mapping cardmarket: ${response.status} ${await response.text()}`);saved.push(...await response.json());}
  const byPrinting=new Map(saved.map((row:any)=>[row.printing_id,row]));return targets.map(target=>{const row:any=byPrinting.get(target.printing_id);return row?{...target,mapping_id:row.id,provider_product_id:row.provider_product_id,provider_expansion_id:row.provider_expansion_id,resolution_status:row.resolution_status,provider_metadata:row.provider_metadata,variant_key:row.variant_key}:target;});
}
function cardmarketResolutionBody(target:any,resolution:any){
  const candidate=resolution.candidate||{},now=new Date().toISOString(),active=[CARDMARKET_RESOLUTION_STATES.EXACT,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE].includes(resolution.status);
  const databaseStatus=active?'resolved':resolution.status===CARDMARKET_RESOLUTION_STATES.AMBIGUOUS?'ambiguous':'unresolved';
  const previousProductId=target.provider_product_id||null,providerProductId=active?(candidate.providerProductId||candidate.provider_product_id||null):previousProductId;
  return {printing_id:target.printing_id,provider:'cardmarket',variant_key:'default',provider_product_id:providerProductId,
    provider_expansion_id:candidate.providerExpansionId||candidate.provider_expansion_id||null,language:target.language||'',condition_reference:'Price Guide Cardmarket',foil:target.foil,
    edition:target.edition||'',resolution_status:databaseStatus,confidence:active?1:0,resolved_at:active?now:null,last_checked_at:now,last_error:null,
    provider_metadata:{...(target.provider_metadata||{}),active,resolverStatus:resolution.status,resolverVersion:resolution.resolverVersion,reason:resolution.reason,priceScope:resolution.priceScope,
      candidateProductIds:active?(resolution.evidence?.candidateProductIds||[]):[],
      productUrl:active?(candidate.productUrl||null):(target.provider_metadata?.productUrl||null),productName:active?(candidate.cardName||candidate.name||null):(target.provider_metadata?.productName||null),
      expansion:active?(candidate.setName||candidate.expansion||null):(target.provider_metadata?.expansion||null),rarity:active?(candidate.rarity||null):(target.provider_metadata?.rarity||null),
      foil:active?(candidate.foil??null):(target.provider_metadata?.foil??null),evidence:resolution.evidence||null,candidateCount:resolution.candidates?.length||0,
      supersededProductId:!active&&previousProductId?previousProductId:null}};
}

async function listCardPrintings(){return restPages('card_printings?select=id,game,catalog_card_id,card_name,set_code,set_name,rarity&game=eq.yugioh&order=id.asc',{key:(row:any)=>row.id});}
async function withCanonicalCardNames(printings:any[],targets:any[]){
  const ids=[...new Set((targets||[]).map(row=>String(row.catalog_card_id||row.catalogCardId||'').trim()).filter(id=>/^\d{5,10}$/.test(id)))];if(!ids.length)return printings;
  // Un solo URL con TUTTI gli id (una richiesta per l'intero batch resolver
  // notturno) rischiava di superare gli ~8KB di lunghezza URL tipici di molti
  // server/proxy una volta alzato il batch oltre poche centinaia di target —
  // a parità di risultato, spezzare in blocchi piccoli elimina il rischio.
  const names=new Map<string,string>();
  for(let index=0;index<ids.length;index+=300){
    const chunk=ids.slice(index,index+300);
    const response=await fetch(`https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${encodeURIComponent(chunk.join(','))}`,{signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`YGOPRODeck canonical names: ${response.status}`);
    const payload=await response.json();
    for(const card of payload?.data||[]){const name=String(card?.name||'').trim();if(!name)continue;names.set(String(card.id||''),name);for(const image of card.card_images||[])names.set(String(image.id||''),name);}
  }
  const aliases=[];for(const row of printings){const name=names.get(String(row.catalog_card_id||''));if(name&&name.trim().toLowerCase()!==String(row.card_name||'').trim().toLowerCase())aliases.push({...row,id:`${row.id}:canonical-name`,card_name:name});}
  return aliases.length?[...printings,...aliases]:printings;
}
function printingTarget(row:any){return {printing_id:row.id,game:row.game,catalog_card_id:row.catalog_card_id,card_name:row.card_name,set_code:row.set_code,set_name:row.set_name,rarity:row.rarity,language:'',edition:'',foil:null};}
function pricesForTarget(prices:any[],target:any){const foil=target.foil===true;return (prices||[]).filter(price=>foil?String(price.type).startsWith('foil_'):!String(price.type).startsWith('foil_'));}
function printingIds(value:any){if(!Array.isArray(value)||value.length>20)return[];const ids=[...new Set(value.map(String))];return ids.length&&ids.every(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))?ids:[];}

async function rpc(name:string,body:Record<string,unknown>){const response=await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`,{method:'POST',headers:headers(),body:JSON.stringify(body)});if(!response.ok)throw new Error(`${name}: ${response.status} ${await response.text()}`);const text=await response.text();return text?JSON.parse(text):null;}
async function rpcPages(name:string,body:Record<string,unknown>,options:any={}){return fetchPages(`${supabaseUrl}/rest/v1/rpc/${name}${options.order?`?order=${encodeURIComponent(options.order)}`:''}`,{method:'POST',body:JSON.stringify(body),key:options.key,resource:name,queryPagination:true});}
async function rest(table:string,method:string,body:unknown,extra:Record<string,string>={}){const response=await fetch(`${supabaseUrl}/rest/v1/${table}`,{method,headers:{...headers(),...extra},body:body==null?undefined:JSON.stringify(body)});if(!response.ok)throw new Error(`${table}: ${response.status} ${await response.text()}`);return response;}
async function restPages(path:string,options:any={}){return fetchPages(`${supabaseUrl}/rest/v1/${path}`,{method:'GET',key:options.key,resource:path});}
async function fetchPages(url:string,{method='GET',body,key=(row:any)=>row.id,resource='resource',pageSize=500,maxRows=20000,queryPagination=false}:any={}){const rows:any[]=[],seen=new Set<string>();let requests=0;for(let from=0;from<=maxRows;from+=pageSize){const to=from+pageSize-1,pageUrl=queryPagination?`${url}${url.includes('?')?'&':'?'}limit=${pageSize}&offset=${from}`:url,response=await fetch(pageUrl,{method,headers:{...headers(),Range:`${from}-${to}`,'Range-Unit':'items'},body});if(response.status===416)return {rows,requests};if(!response.ok)throw new Error(`${resource} pagina ${requests+1}: ${response.status} ${await response.text()}`);const page=await response.json();if(!Array.isArray(page))throw new Error(`${resource}: risposta paginata non valida`);requests++;if(from===maxRows&&page.length)throw new Error(`${resource}: limite massimo di sicurezza superato`);for(const row of page){const identity=key(row);if(identity==null||identity==='')throw new Error(`${resource}: identità riga mancante`);const normalized=String(identity);if(seen.has(normalized))continue;seen.add(normalized);rows.push(row);if(rows.length>maxRows)throw new Error(`${resource}: limite massimo di sicurezza superato`);}if(page.length<pageSize)return {rows,requests};}throw new Error(`${resource}: limite massimo di sicurezza raggiunto`);}
async function releaseProviderSync(provider:string){const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_sync_runs?provider=eq.${encodeURIComponent(provider)}&status=eq.running`,{method:'PATCH',headers:{...headers(),Prefer:'return=minimal'},body:JSON.stringify({status:'failed',finished_at:new Date().toISOString(),error_code:'manual_recovery',error_message:'Lock recuperato dopo interruzione del worker'})});if(!response.ok)throw new Error(`sync recovery: ${response.status} ${await response.text()}`);}
async function finish(id:string,status:string,fields:Record<string,unknown>){const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_sync_runs?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{...headers(),Prefer:'return=minimal'},body:JSON.stringify({status,finished_at:new Date().toISOString(),last_success_at:['succeeded','partial'].includes(status)?new Date().toISOString():null,...fields})});if(!response.ok)throw new Error(`sync finish: ${response.status} ${await response.text()}`);}
async function recordMappingError(id:string,error:any){if(!id)return;const response=await fetch(`${supabaseUrl}/rest/v1/market_provider_printings?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{...headers(),Prefer:'return=minimal'},body:JSON.stringify({last_checked_at:new Date().toISOString(),last_error:String(error?.message||error).slice(0,500)})});if(!response.ok)throw new Error(`mapping error update: ${response.status}`);}
function headers(){return {'content-type':'application/json',apikey:serviceKey,Authorization:`Bearer ${serviceKey}`};}
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});}
function isThreeInRome(date:Date){return new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',hourCycle:'h23'}).format(date)==='03';}
