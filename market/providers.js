const RESOLUTION_STATES=new Set(['resolved','ambiguous','unresolved','manual']);
export const CARDMARKET_RESOLVER_VERSION=11;
export const CARDMARKET_RESOLUTION_STATES=Object.freeze({EXACT:'EXACT',AMBIGUOUS:'AMBIGUOUS',UNRESOLVED:'UNRESOLVED',UNSUPPORTED:'UNSUPPORTED',PROVIDER_AGGREGATE:'PROVIDER_AGGREGATE'});
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

// Chiavi grezze del Price Guide Cardmarket per tipo di prezzo — hoisted fuori
// da getCurrentPrice() (che fa Math.min tra PIÙ product id, il caso
// aggregate) così exactPriceForProduct() sotto (UN SOLO product id, mai
// Math.min) può riusare esattamente la stessa mappa senza duplicarla.
const CARDMARKET_PRICE_TYPE_FIELDS={low:['low','Low Price','LOW'],trend:['trend','Trend Price','TREND'],average:['avg','Avg. Sell Price','AVG'],avg1:['avg1','AVG1'],avg7:['avg7','AVG7'],avg30:['avg30','AVG30'],
  foil_low:['low-foil','Foil Low','LOWFOIL'],foil_trend:['trend-foil','Foil Trend','TRENDFOIL'],foil_average:['avg-foil','Foil Sell','SELLFOIL'],foil_avg1:['avg1-foil','Foil AVG1'],foil_avg7:['avg7-foil','Foil AVG7'],foil_avg30:['avg30-foil','Foil AVG30']};

export class PriceProvider {
  constructor({name,fetchImpl=globalThis.fetch}={}){this.name=name;this.fetch=fetchImpl;}
  async resolvePrinting(){throw new Error('resolvePrinting() non implementato');}
  async getCurrentPrice(){throw new Error('getCurrentPrice() non implementato');}
  async getMarketListings(){throw new Error('getMarketListings() non implementato');}
  getPriceMetadata(){throw new Error('getPriceMetadata() non implementato');}
}

export class CardmarketPriceGuideProvider extends PriceProvider {
  constructor({catalogUrl='',priceGuideUrl='',fetchImpl=globalThis.fetch,sleep=delay,timeoutMs=180000}={}){
    super({name:'cardmarket',fetchImpl});this.catalogUrl=catalogUrl;this.priceGuideUrl=priceGuideUrl;this.sleep=sleep;this.timeoutMs=timeoutMs;this.catalog=[];this.expansionHints=new Map();this.prices=new Map();this.sourceUpdatedAt='';this.loaded=false;
  }
  get available(){return Boolean(this.catalogUrl&&this.priceGuideUrl);}
  getPriceMetadata(){return {provider:this.name,status:this.available?'available':'unavailable',currency:'EUR',frequency:'daily',
    priceTypes:['low','trend','average','avg1','avg7','avg30','foil_low','foil_trend','foil_average','foil_avg1','foil_avg7','foil_avg30'],
    languageScope:'aggregate',editionScope:'aggregate',rarityScope:'product_variant_unlabeled',foilScope:'parallel_columns_unassigned',resolverVersion:CARDMARKET_RESOLVER_VERSION};}
  async request(url,{maxAttempts=3}={}){
    for(let attempt=0;attempt<maxAttempts;attempt++){
      let response;
      try{response=await this.fetch(url,{signal:typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function'?AbortSignal.timeout(this.timeoutMs):undefined});}
      catch(error){if(attempt===maxAttempts-1)throw error;await this.sleep(backoff(attempt));continue;}
      if(response.ok)return response;
      if(![429,500,502,503,504].includes(response.status)||attempt===maxAttempts-1)throw new ProviderHttpError(this.name,response.status,await safeText(response));
      const retryAfter=Number(response.headers?.get?.('retry-after'));await this.sleep(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:backoff(attempt));
    }
  }
  async load(targets=[]){
    if(!this.available)throw unavailable('Cardmarket Price Guide','CARDMARKET_PRODUCT_CATALOG_URL / CARDMARKET_PRICE_GUIDE_URL');
    validateOfficialCardmarketUrl(this.catalogUrl);validateOfficialCardmarketUrl(this.priceGuideUrl);
    const catalogStats=await this.loadCatalog(targets),priceStats=await this.loadPrices(targets);
    return {...catalogStats,...priceStats};
  }
  async loadCatalog(targets=[],options={}){
    if(!this.catalogUrl)throw unavailable('Cardmarket Product Catalogue','CARDMARKET_PRODUCT_CATALOG_URL');
    validateOfficialCardmarketUrl(this.catalogUrl);
    const nonSinglesUrl=cardmarketNonSinglesUrl(this.catalogUrl);
    const nonSinglesResponse=nonSinglesUrl?await this.request(nonSinglesUrl):null;
    if(!nonSinglesResponse?.ok)throw new ProviderHttpError(this.name,nonSinglesResponse?.status||503,'Catalogo espansioni non disponibile');
    const expansions=new Map();
    const expansionPayload=await streamCardmarketRows(nonSinglesResponse,'products',row=>addExpansionName(expansions,row));
    if(expansions.size<100)throw new Error('Catalogo espansioni Cardmarket non disponibile dal link Product Catalogue');
    const internalPrintings=options.internalPrintings||[],targetCatalogIds=new Set((targets||[]).map(row=>norm(row.catalogCardId||row.catalog_card_id)).filter(Boolean));
    const wantedNames=new Set([...(targets||[]),...internalPrintings.filter(row=>targetCatalogIds.has(norm(row.catalogCardId||row.catalog_card_id)))].map(row=>norm(row.cardName||row.card_name)).filter(Boolean));
    const hintNames=new Set(internalPrintings.map(row=>norm(row.cardName||row.card_name)).filter(Boolean)),hintProducts=[],hintSeen=new Set();
    const catalogResponse=await this.request(this.catalogUrl);
    if(!catalogResponse.ok)throw new ProviderHttpError(this.name,catalogResponse.status,'Product Catalogue non disponibile');
    const catalog=[];
    // Confirmed 2026-09-06 by dumping a raw feed row: Cardmarket's bulk
    // Product Catalogue has NO rarity anywhere (name is bare, e.g. "Enneacraft
    // - Atori.MAR" — no "(V.n - Rarity)" suffix, no dedicated field). The
    // "(V.1 - Ultra Rare)" title format only exists on the individual product
    // PAGE, which this feed doesn't provide. So when multiple products share
    // a name+expansion with no rarity to disambiguate them, there is no data
    // this resolver can use to pick automatically — manual "Vedi" + visual
    // confirm is the only option for those, not a parsing bug to fix here.
    const catalogPayload=await streamCardmarketRows(catalogResponse,'products',row=>{const parsed=parseProductName(row.name||''),name=norm(parsed.cardName);if(!wantedNames.size||wantedNames.has(name))catalog.push(normalizeCardmarketProduct(row,expansions));if(hintNames.has(name)){const candidate=normalizeCardmarketProduct(row,expansions),key=`${name}:${candidate.providerExpansionId}`;if(candidate.providerExpansionId&&!hintSeen.has(key)){hintSeen.add(key);hintProducts.push({cardName:candidate.cardName,setName:candidate.setName,providerExpansionId:candidate.providerExpansionId});}}});
    if(catalogPayload.rows<1000)throw new Error('Product Catalogue Cardmarket non valido: usa il link JSON diretto products_singles_3.json');
    this.catalog=catalog;this.expansionHints=buildCardmarketExpansionHints(internalPrintings,hintProducts);
    return {catalogRows:catalogPayload.rows,retainedCatalogRows:this.catalog.length,expansionRows:expansions.size,expansionHints:this.expansionHints.size};
  }
  async loadPrices(targets=[]){
    if(!this.priceGuideUrl)throw unavailable('Cardmarket Price Guide','CARDMARKET_PRICE_GUIDE_URL');
    validateOfficialCardmarketUrl(this.priceGuideUrl);
    const wantedProductIds=new Set((targets||[]).filter(row=>isAuthorizedCardmarketMapping(row)).flatMap(mappingProductIds));
    this.prices=new Map();
    if(!wantedProductIds.size){this.sourceUpdatedAt=new Date().toISOString();this.loaded=true;return {priceRows:0,retainedPriceRows:0,mode:'prices_only'};}
    const priceResponse=await this.request(this.priceGuideUrl);
    if(!priceResponse.ok)throw new ProviderHttpError(this.name,priceResponse.status,'Price Guide non disponibile');
    const pricePayload=await streamCardmarketRows(priceResponse,'priceGuides',row=>{const id=productId(row);if(id&&wantedProductIds.has(id))this.prices.set(id,row);});
    if(pricePayload.rows<1000)throw new Error('Price Guide Cardmarket non valido: usa il link JSON diretto price_guide_3.json');
    this.sourceUpdatedAt=pricePayload.createdAt||priceResponse.headers?.get?.('last-modified')||new Date().toISOString();this.loaded=true;
    return {priceRows:pricePayload.rows,retainedPriceRows:this.prices.size,mode:'prices_only'};
  }
  async resolvePrinting(printing,options={}){return resolveCardmarketPrinting(printing,this.catalog,options);}
  async getMarketListings(){return [];}
  async getCurrentPrice(mapping){
    if(!this.loaded)await this.load([mapping]);const ids=mappingProductIds(mapping),rows=ids.map(id=>this.prices.get(id)).filter(Boolean);
    if(!rows.length)return {provider:this.name,status:'unavailable',prices:[],availableQuantity:null,sampleSize:0};
    const prices=[];for(const [type,keys] of Object.entries(CARDMARKET_PRICE_TYPE_FIELDS)){const values=rows.map(row=>numberFrom(row,keys)).filter(value=>value!=null);if(values.length)prices.push({type,value:Math.min(...values)});}
    return {provider:this.name,status:prices.length?'available':'unavailable',currency:'EUR',prices,availableQuantity:null,sampleSize:null,
      conditionReference:ids.length>1?`Price Guide Cardmarket · minimo tra ${ids.length} prodotti`:'Price Guide Cardmarket',capturedAt:new Date().toISOString(),sourceUpdatedAt:this.sourceUpdatedAt};
  }
}

export class CardmarketApiProvider extends PriceProvider {
  constructor(options={}){super({name:'cardmarket-api',fetchImpl:options.fetchImpl});}
  getPriceMetadata(){return {provider:this.name,status:'future',reason:'Nuovi accessi API Cardmarket non disponibili'};}
  async resolvePrinting(){return {status:'unresolved',confidence:0,candidates:[]};}
  async getCurrentPrice(){return {provider:this.name,status:'unavailable',prices:[]};}
  async getMarketListings(){return [];}
}

export function resolveCardmarketPrinting(printing,candidates,options={}){
  const local=normalizePrinting(printing),internalRarity=normalizeMarketRarity(printing.rarity),name=norm(printing.cardName||printing.card_name),catalogId=norm(printing.catalogCardId||printing.catalog_card_id);
  const base=evidenceBase(printing,internalRarity),fail=(status,reason,extra={})=>({status,confidence:0,candidates:[],provider:'cardmarket',reason,evidence:{...base,...extra},priceScope:null,resolverVersion:CARDMARKET_RESOLVER_VERSION});
  if(!internalRarity)return fail(CARDMARKET_RESOLUTION_STATES.UNSUPPORTED,'unsupported_internal_rarity');
  const allPrintings=options.internalPrintings||[],family=internalFamily(printing,allPrintings),acceptedNames=new Set([name,...(catalogId?(internalPrintingsByCatalogId(allPrintings).get(catalogId)||[]).map(row=>norm(row.cardName||row.card_name)):[])].filter(Boolean)),expansions=new Set(family.map(row=>norm(row.setName||row.set_name)).filter(Boolean));
  if(local.expansion)expansions.add(local.expansion);
  if(!name||!expansions.size)return fail(CARDMARKET_RESOLUTION_STATES.UNRESOLVED,'name_or_expansion_missing');
  const hint=options.expansionHints?.get?.(setSeriesKey(printing.setCode||printing.set_code))||null;
  const products=dedupeProducts(cardmarketCandidatesByName(candidates||[],acceptedNames).filter(row=>acceptedNames.has(row._normName??norm(row.cardName||row.name))&&(
    [...expansions].some(expansion=>[row.setName||row.expansion,...(row.expansionNames||[])].some(label=>sameCardmarketExpansion(expansion,label)))||(hint&&String(row.providerExpansionId||row.provider_expansion_id||'')===hint.providerExpansionId)
  )));
  if(!products.length)return fail(CARDMARKET_RESOLUTION_STATES.UNRESOLVED,'provider_product_not_found',{acceptedNames:[...acceptedNames].sort(),acceptedExpansions:[...expansions].sort(),expansionHint:hint});
  const internalRarities=[...new Set(family.map(row=>normalizeMarketRarity(row.rarity)).filter(Boolean))].sort();
  const exactRarity=products.filter(row=>normalizeMarketRarity(row.rarity)===internalRarity);
  const providerRarityKnown=products.filter(row=>normalizeMarketRarity(row.rarity));
  let matches=[];
  if(exactRarity.length)matches=exactRarity;
  else if(providerRarityKnown.length){
    const candidateDetails=providerRarityKnown.map(row=>({productId:productId(row),cardName:row.cardName||row.name||'',rarity:row.rarity||'',expansion:row.setName||row.expansion||'',foil:row.foil??null,productUrl:row.productUrl||(productId(row)?`https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(productId(row))}`:'')}));
    return {...fail(CARDMARKET_RESOLUTION_STATES.UNRESOLVED,'provider_rarity_mismatch',{internalRarities,providerRarities:[...new Set(providerRarityKnown.map(row=>normalizeMarketRarity(row.rarity)))].sort(),candidateCount:products.length,candidates:candidateDetails}),candidates:providerRarityKnown};
  }
  else matches=products;
  if(matches.length>1){const expansionIds=[...new Set(matches.map(row=>String(row.providerExpansionId||row.provider_expansion_id||'')).filter(Boolean))];
    if(expansionIds.length===1){const first=matches[0],candidateProductIds=matches.map(productId).filter(Boolean),candidateDetails=matches.map(row=>({productId:productId(row),cardName:row.cardName||row.name||'',rarity:row.rarity||'',expansion:row.setName||row.expansion||'',foil:row.foil??null,productUrl:row.productUrl||(productId(row)?`https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(productId(row))}`:'')}));return {status:CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE,confidence:1,candidate:{providerExpansionId:expansionIds[0],provider_expansion_id:expansionIds[0],setName:first.setName||first.expansion||'',expansion:first.setName||first.expansion||'',foil:null},candidates:matches,provider:'cardmarket',reason:'multiple_provider_products_aggregate_minimum',priceScope:{product:'minimum_across_candidates',language:'aggregate',edition:'aggregate',rarity:'aggregate',foil:'parallel_columns_unassigned'},resolverVersion:CARDMARKET_RESOLVER_VERSION,evidence:{...base,internalRarities,candidateCount:matches.length,candidateProductIds,candidates:candidateDetails,providerExpansionId:expansionIds[0],acceptedExpansions:[...expansions].sort(),identityBasis:['card_name','provider_expansion_id','multiple_provider_product_ids','minimum_price']}};}
    return {...fail(CARDMARKET_RESOLUTION_STATES.AMBIGUOUS,'multiple_provider_expansions',{internalRarities,candidateCount:matches.length,providerExpansionIds:expansionIds}),candidates:matches};}
  const candidate=matches[0],providerRarity=normalizeMarketRarity(candidate.rarity);
  if(!providerRarity&&internalRarities.length>1)return {...fail(CARDMARKET_RESOLUTION_STATES.AMBIGUOUS,'internal_rarity_conflict_provider_rarity_missing',{internalRarities,candidateCount:1}),candidates:[candidate]};
  const priceScope={language:'aggregate',edition:'aggregate',rarity:providerRarity?'specific':'aggregate',foil:candidate.foil==null?'parallel_columns_unassigned':'specific'};
  return {status:CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE,confidence:1,candidate,candidates:[candidate],provider:'cardmarket',reason:'unique_provider_product_aggregate_variant_scope',priceScope,resolverVersion:CARDMARKET_RESOLVER_VERSION,
    evidence:{...base,providerProductId:productId(candidate),providerProductUrl:candidate.productUrl||(productId(candidate)?`https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(productId(candidate))}`:''),providerCardName:candidate.cardName||candidate.name||'',providerExpansion:candidate.setName||candidate.expansion||'',providerExpansionId:candidate.providerExpansionId||candidate.provider_expansion_id||null,
      providerRarity:providerRarity||null,providerFoil:candidate.foil??null,providerHasSetCode:false,internalSetFamily:setFamilyKey(printing.setCode||printing.set_code),internalCatalogFamilySize:family.length,
      internalRarities,candidateCount:1,acceptedExpansions:[...expansions].sort(),identityBasis:['card_name','provider_expansion_id','unique_provider_product_id','internal_set_family']}};
}
// --- Market Variant Registry (PRINTING -> RARITY VARIANT -> PRODOTTO
// CARDMARKET) — vedi supabase/migrations/20260912110000_ygo_market_variant_registry.sql.
// Additivo: NON tocca resolveCardmarketPrinting() sopra, compone sul suo
// output. Non ancora richiamato da syncProvider()/Deno.serve — resta
// disponibile per il prossimo passo (wiring + backfill) senza toccare oggi
// il comportamento live di Market Watch/del cron dei 15 minuti.
export const MARKET_VARIANT_STATUS=Object.freeze({UNRESOLVED:'unresolved',RESOLVED:'resolved',AMBIGUOUS:'ambiguous',CONFLICT:'conflict',VERIFIED:'verified'});
export const MARKET_VARIANT_SOURCE=Object.freeze({MANUAL:'manual',REGISTRY:'registry',RESOLVER:'resolver',LEGACY:'legacy',SET_TEMPLATE:'verified_set_template'});

// Mirror JS di normalize_ygo_rarity_key()/normalize_ygo_rarity() nella
// migration: stessa identica trasformazione, tenuta manualmente in sync per
// lo stesso motivo di normalize_ygo_set_code (vedi js/ygo-printing-registry.js)
// — qui non c'è un client Postgres sincrono disponibile per ogni riga, quindi
// l'alias_map va caricata una sola volta (select * from ygo_rarity_aliases)
// e riusata per l'intero batch di un sync run.
export function normalizeYgoRarityKey(value){
  const key=String(value||'').replace(/['’]/g,'').replace(/[^A-Za-z0-9]+/g,' ').trim().toUpperCase();
  return key||null;
}
export function canonicalYgoRarity(rawRarity,aliasMap){
  const key=normalizeYgoRarityKey(rawRarity);
  if(!key||!aliasMap)return null;
  return aliasMap.get(key)||null;
}

// Resolver deterministico "V.n -> rarity" per set esplicitamente whitelisted
// (righe verified=true in ygo_market_variant_set_templates — MAI un pattern
// tipo startsWith('RA'), il whitelisting emerge solo dai dati). Pura,
// testabile in isolamento. setTemplates: array di
// {setPrefix,variantNumber,rarityCanonical,verified} — tutte le righe note,
// verificate o no: la funzione stessa scarta quelle non verified, non si fida
// del chiamante per pre-filtrare.
function extractYgoSetPrefix(setCode){
  const match=String(setCode||'').trim().toUpperCase().match(/^([A-Z0-9]+)-/);
  return match?match[1]:'';
}
export function resolveYgoMarketVariantBySetTemplate({setCode=null,rarityCanonical=null,candidateProductIds=[],setTemplates=[]}={}){
  const setPrefix=extractYgoSetPrefix(setCode);
  if(!setPrefix||!rarityCanonical)return null;
  const ids=Array.isArray(candidateProductIds)?candidateProductIds:[];
  if(!ids.length)return null; // candidate array vuoto

  const matches=(setTemplates||[]).filter(row=>row?.setPrefix===setPrefix&&row?.rarityCanonical===rarityCanonical);
  if(matches.length!==1)return null; // template mancante (0) O duplicate/ambiguous (>1) -> mai una scelta
  const template=matches[0];
  if(!template.verified)return null; // set non ancora whitelisted per questa rarity

  const variantNumber=Number(template.variantNumber);
  if(!Number.isInteger(variantNumber)||variantNumber<1)return null;
  if(ids.length<variantNumber)return null; // candidate array più corto della posizione richiesta

  // Safety check fondamentale: MAI riordinare/ricostruire — si usa
  // ESATTAMENTE l'ordine già prodotto dal resolver Cardmarket corrente,
  // indicizzando la posizione (1-based) così come arriva.
  const productId=ids[variantNumber-1];
  if(!productId)return null;

  return {productId,variantNumber,setPrefix,rarityCanonical};
}

// Precedenza (sezione 8, estesa con il set template resolver): verified
// manual > verified registry > verified set template resolver > exact
// Cardmarket variant match > legacy fallback. Un fallback legacy non diventa
// mai verified automaticamente, e nemmeno una risoluzione da set template lo
// diventa (resta 'resolved', non 'verified' — la verifica umana è un atto
// distinto, vedi confirm_ygo_market_variant). MAI scegliere il primo
// risultato quando ci sono più candidati equivalenti: 0 candidati ->
// unresolved, >1 candidati equivalenti -> ambiguous/conflict.
//
// existingVariant: riga corrente di ygo_market_variants per questa printing
//   (o null). cardmarketCandidates: prodotti Cardmarket già filtrati per
//   nome+espansione da resolveCardmarketPrinting() (il suo campo
//   `candidates`/`candidate`) — questa funzione NON rifà quel matching, lo
//   raffina con la rarity canonica. rarityCanonical: risultato di
//   canonicalYgoRarity() per la rarity di QUESTA printing. legacyMapping:
//   mapping market_provider_printings esistente (se presente), MAI usato per
//   sovrascrivere un esito ambiguous/conflict fresco — solo come ultima
//   spiaggia quando la risoluzione fresca non produce alcun candidato.
//   setCode/setTemplates: input per resolveYgoMarketVariantBySetTemplate
//   sopra — opzionali, se assenti il passo 3 semplicemente non si applica
//   (comportamento identico a prima di questa estensione).
export function resolveYgoMarketVariant({existingVariant=null,cardmarketCandidates=[],rarityCanonical=null,legacyMapping=null,forceRefresh=false,setCode=null,setTemplates=[]}={}){
  if(existingVariant?.verified&&existingVariant?.cardmarket_product_id){
    return variantResult({
      mappingStatus:MARKET_VARIANT_STATUS.VERIFIED,
      mappingSource:existingVariant.mapping_source===MARKET_VARIANT_SOURCE.MANUAL?MARKET_VARIANT_SOURCE.MANUAL:MARKET_VARIANT_SOURCE.REGISTRY,
      mappingConfidence:1,cardmarketProductId:existingVariant.cardmarket_product_id,cardmarketExpansionId:existingVariant.cardmarket_expansion_id||null,
      candidateProductIds:[],verified:true,reason:'verified_mapping_preserved'
    });
  }
  if(!forceRefresh&&existingVariant?.mapping_status===MARKET_VARIANT_STATUS.RESOLVED&&existingVariant?.cardmarket_product_id){
    return variantResult({
      mappingStatus:MARKET_VARIANT_STATUS.RESOLVED,mappingSource:MARKET_VARIANT_SOURCE.REGISTRY,
      mappingConfidence:existingVariant.mapping_confidence??0.8,cardmarketProductId:existingVariant.cardmarket_product_id,
      cardmarketExpansionId:existingVariant.cardmarket_expansion_id||null,candidateProductIds:[],verified:false,reason:'resolved_registry_preserved'
    });
  }
  const candidates=dedupeVariantCandidates(cardmarketCandidates);
  const templateMatch=resolveYgoMarketVariantBySetTemplate({setCode,rarityCanonical,candidateProductIds:candidates.map(row=>row.productId),setTemplates});
  if(templateMatch){
    const matchedCandidate=candidates.find(row=>row.productId===templateMatch.productId);
    return variantResult({
      mappingStatus:MARKET_VARIANT_STATUS.RESOLVED,mappingSource:MARKET_VARIANT_SOURCE.SET_TEMPLATE,mappingConfidence:1,
      cardmarketProductId:templateMatch.productId,cardmarketExpansionId:matchedCandidate?.expansionId||null,
      candidateProductIds:candidates.map(row=>row.productId),verified:false,reason:'verified_set_variant_template'
    });
  }
  if(!candidates.length)return legacyFallbackResult(legacyMapping)||variantResult({mappingStatus:MARKET_VARIANT_STATUS.UNRESOLVED,reason:'no_cardmarket_candidates'});
  const exactRarity=rarityCanonical?candidates.filter(row=>row.rarityCanonical===rarityCanonical):[];
  const pool=exactRarity.length?exactRarity:candidates;
  if(pool.length===1){
    const only=pool[0];
    return variantResult({
      mappingStatus:MARKET_VARIANT_STATUS.RESOLVED,mappingSource:MARKET_VARIANT_SOURCE.RESOLVER,
      mappingConfidence:exactRarity.length?1:0.6,cardmarketProductId:only.productId,cardmarketExpansionId:only.expansionId,
      candidateProductIds:candidates.map(row=>row.productId),verified:false,
      reason:exactRarity.length?'exact_rarity_single_candidate':'single_candidate_no_rarity_signal'
    });
  }
  // >1 candidati equivalenti: MAI il primo. Espansioni diverse tra loro =
  // conflitto reale (il feed non concorda nemmeno su dove sia il prodotto);
  // stessa espansione = ambiguous "classico" Rarity Collection (serve una
  // rarity/verifica per scegliere, non un guess).
  const distinctExpansions=new Set(pool.map(row=>row.expansionId).filter(Boolean));
  return variantResult({
    mappingStatus:distinctExpansions.size>1?MARKET_VARIANT_STATUS.CONFLICT:MARKET_VARIANT_STATUS.AMBIGUOUS,
    mappingSource:MARKET_VARIANT_SOURCE.RESOLVER,mappingConfidence:0,
    candidateProductIds:pool.map(row=>row.productId),verified:false,
    reason:exactRarity.length?'multiple_exact_rarity_candidates':'multiple_candidates_no_rarity_signal'
  });
}
function legacyFallbackResult(legacyMapping){
  if(!legacyMapping?.cardmarketProductId)return null;
  const candidateCount=Array.isArray(legacyMapping.candidateProductIds)?legacyMapping.candidateProductIds.length:1;
  // Un aggregato legacy multi-prodotto (il caso PROVIDER_AGGREGATE odierno,
  // prezzo minimo tra rarità diverse) resta ambiguous qui — non è mai stato
  // un match certo, solo l'unico prodotto che il vecchio sistema conosceva.
  return variantResult({
    mappingStatus:candidateCount>1?MARKET_VARIANT_STATUS.AMBIGUOUS:MARKET_VARIANT_STATUS.RESOLVED,
    mappingSource:MARKET_VARIANT_SOURCE.LEGACY,mappingConfidence:candidateCount>1?0:0.4,
    cardmarketProductId:legacyMapping.cardmarketProductId,cardmarketExpansionId:legacyMapping.cardmarketExpansionId||null,
    candidateProductIds:legacyMapping.candidateProductIds||[],verified:false,reason:'legacy_fallback_not_verified'
  });
}
function variantResult({mappingStatus,mappingSource=null,mappingConfidence=0,cardmarketProductId=null,cardmarketExpansionId=null,candidateProductIds=[],verified=false,reason}){
  return {mappingStatus,mappingSource,mappingConfidence,cardmarketProductId,cardmarketExpansionId,candidateProductIds,verified,reason};
}
// Usate dal wiring shadow in supabase/functions/market-sync/index.ts (copia
// manuale, stesso motivo di isAuthorizedCardmarketMapping più sotto) per
// decidere se scrivere una riga e per il summary di fine run — logica pura,
// testabile qui senza bisogno di Deno.
export function shouldPersistMarketVariantShadow(existingVariant){
  // Una riga già verified (manuale o registry) è permanente finché qualcuno
  // non la corregge esplicitamente: il resolver automatico non la tocca MAI,
  // nemmeno per riscrivere lo stesso valore (zero write inutili).
  return !(existingVariant?.verified && existingVariant?.cardmarket_product_id);
}
export function summarizeMarketVariantDecisions(decisions){
  const summary={processed:0,verified:0,resolved:0,ambiguous:0,conflict:0,unresolved:0,errors:0};
  for(const decision of decisions||[]){summary.processed++;summary[decision.mappingStatus]=(summary[decision.mappingStatus]||0)+1;}
  return summary;
}
function dedupeVariantCandidates(rows){
  const byId=new Map();
  for(const row of rows||[]){
    const id=String(row.productId||row.providerProductId||row.provider_product_id||'').trim();
    if(!id||byId.has(id))continue;
    byId.set(id,{productId:id,expansionId:String(row.expansionId||row.providerExpansionId||row.provider_expansion_id||'')||null,rarityCanonical:row.rarityCanonical||null});
  }
  return [...byId.values()];
}

// --- Exact Price Shadow (fase finale dello shadow pricing) -----------------
// Confronta legacy_price (già in market_price_snapshots, calcolato con
// Math.min tra CANDIDATI multipli quando il mapping è un aggregato) con
// exact_price (UN SOLO cardmarket_product_id da ygo_market_variants, MAI un
// Math.min). Additivo: non tocca resolveCardmarketPrinting/getCurrentPrice
// sopra, non scrive prezzi live.

// Stessa priorità di market_reference_type() lato DB (cardmarket 'trend' >
// 'average'/'avg7' > 'low'/'lowest') ma applicata a UN SOLO raw row del
// Price Guide — mai un Math.min tra prodotti diversi, a differenza di
// getCurrentPrice() sopra che è pensato apposta per il caso aggregate.
const EXACT_PRICE_TYPE_PRIORITY=['trend','average','avg7','low','lowest'];
export function exactPriceForProduct(pricesByProductId,productId){
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

// Una printing è eleggibile per exact pricing SOLO se ha un cardmarket_product_id
// noto E quel mapping è o verificato a mano o già risolto in automatico dallo
// shadow resolver — mai ambiguous/conflict/unresolved (lì exact_price resta
// sempre null, candidate_product_ids non è mai usato come fallback).
export function isExactPriceEligible(variant){
  if(!variant?.cardmarket_product_id)return false;
  return Boolean(variant.verified)||variant.mapping_status==='resolved';
}

// Soglie conservative concordate: <1 centesimo = same, <5% = close, il resto
// = different. exact_missing/legacy_missing hanno precedenza su qualunque
// calcolo numerico (non ha senso una percentuale senza uno dei due lati).
export function classifyPriceComparison(legacyPrice,exactPrice){
  const legacy=typeof legacyPrice==='number'&&Number.isFinite(legacyPrice)?legacyPrice:null;
  const exact=typeof exactPrice==='number'&&Number.isFinite(exactPrice)?exactPrice:null;
  if(exact==null)return {comparisonStatus:'exact_missing',absoluteDelta:null,percentageDelta:null};
  if(legacy==null)return {comparisonStatus:'legacy_missing',absoluteDelta:null,percentageDelta:null};
  const absoluteDelta=Math.round((exact-legacy)*10000)/10000;
  const percentageDelta=legacy!==0?Math.round((absoluteDelta/legacy)*10000)/100:null;
  let comparisonStatus;
  if(Math.abs(absoluteDelta)<0.01)comparisonStatus='same';
  else if(percentageDelta!=null&&Math.abs(percentageDelta)<5)comparisonStatus='close';
  else comparisonStatus='different';
  return {comparisonStatus,absoluteDelta,percentageDelta};
}

// --- Candidate Metadata Enrichment ------------------------------------------
// Arricchimento SOLO per i candidate_product_ids già in coda di review — mai
// uno scraper generale. Il bulk feed/Price Guide NON hanno rarity (vedi
// audit): l'unico posto dove Cardmarket la mostra è la pagina prodotto
// individuale, secondo la documentazione — MAI verificato con successo in
// questa sessione (fetch di test verso cardmarket.com bloccato con HTTP 403,
// anche sulla home page category, non solo sull'idProduct — vedi report).
// Queste funzioni sono pure/testabili a prescindere dall'esito del fetch.

// Il titolo di una pagina prodotto Cardmarket porta spesso un suffisso sito
// (es. " | Cardmarket") che va tolto prima di applicare il pattern
// "Card Name (V.N - Rarity Text)" — STESSA forma di parseProductName() sopra
// (pensata per il nome nel bulk feed, dove il formato non compare quasi mai),
// qui riusata per il titolo della pagina individuale. Conservativo: se non
// combacia, ogni campo torna null, mai un guess.
const PRODUCT_TITLE_TRAILING_SUFFIX=/\s*[|–-]\s*Cardmarket\s*$/i;
export function parseCardmarketProductTitle(rawTitle){
  const cleaned=String(rawTitle||'').replace(PRODUCT_TITLE_TRAILING_SUFFIX,'').trim();
  if(!cleaned)return {productName:'',variantNumber:null,rarityRaw:null};
  const match=cleaned.match(/^(.*?)\s*\(V\.(\d+)\s*-\s*([^()]+)\)\s*$/i);
  if(!match)return {productName:cleaned,variantNumber:null,rarityRaw:null};
  return {productName:match[1].trim(),variantNumber:match[2],rarityRaw:match[3].trim()};
}

// Un fetch fallito non è mai "rarity sconosciuta per sempre" — stati
// distinti così l'admin sa se vale la pena ritentare (blocked/parse_error)
// o se il prodotto semplicemente non esiste più (not_found).
export function classifyCandidateMetadataFetchOutcome({httpStatus=null,threwError=false,titleFound=false,rarityRaw=null}={}){
  if(threwError)return 'parse_error';
  if(httpStatus===404)return 'not_found';
  if(httpStatus===403||httpStatus===429)return 'blocked';
  if(httpStatus!=null&&httpStatus>=400)return 'blocked';
  if(!titleFound)return 'parse_error';
  return rarityRaw?'resolved':'incomplete';
}

// Confronto VISIVO, mai un'auto-conferma: dice solo se la rarity FPT e
// quella letta dalla pagina prodotto (una volta canonicalizzate con lo
// stesso ygo_rarity_aliases/ygo_rarity_canon) coincidono.
export function classifyCandidateRarityMatch(fptRarityCanonical,candidateRarityCanonical){
  if(!fptRarityCanonical||!candidateRarityCanonical)return 'unknown';
  return fptRarityCanonical===candidateRarityCanonical?'exact_match':'mismatch';
}

// Sezione "futura auto-resolution, NON implementare ora": solo un
// suggerimento visivo per l'intero pool di candidati di una printing — non
// scrive mai verified=true da sola.
export function classifyCandidatePoolMatch(fptRarityCanonical,candidates){
  if(!fptRarityCanonical)return 'unknown';
  const known=(candidates||[]).filter(candidate=>candidate?.rarityCanonical);
  if(!known.length)return 'unknown';
  const matching=known.filter(candidate=>candidate.rarityCanonical===fptRarityCanonical);
  if(matching.length===1)return 'exact_unique';
  if(matching.length>1)return 'multiple_matches';
  return 'no_match';
}

// Guardrail cache: di default non ri-fetchare entro 7 giorni, a meno di
// force esplicito dall'admin — mai un refresh automatico/continuo.
export function shouldRefreshCandidateMetadata(lastCheckedAt,force=false,maxAgeDays=7){
  if(force)return true;
  if(!lastCheckedAt)return true;
  const last=new Date(lastCheckedAt).getTime();
  if(!Number.isFinite(last))return true;
  return (Date.now()-last)>maxAgeDays*24*60*60*1000;
}

// Batch piccolo e limitato per costruzione, non solo per policy: la RPC
// ripete comunque questo controllo lato server (mai fidarsi solo del client).
export function validateCandidateMetadataBatch(printingIds,productIds,{maxPrintings=5,maxProductIds=40}={}){
  const printingCount=new Set((printingIds||[]).filter(Boolean)).size;
  const productCount=new Set((productIds||[]).filter(Boolean)).size;
  if(printingCount===0)return {ok:false,reason:'empty_printing_ids',printingCount,productCount};
  if(printingCount>maxPrintings)return {ok:false,reason:'too_many_printings',printingCount,productCount};
  if(productCount>maxProductIds)return {ok:false,reason:'too_many_product_ids',printingCount,productCount};
  return {ok:true,printingCount,productCount};
}

export function normalizeMappingStatus(value){return RESOLUTION_STATES.has(value)?value:'unresolved';}
export function normalizeMarketRarity(value){const rarity=norm(value);return /^\d+$/.test(rarity)?'Common':SUPPORTED_RARITIES.get(rarity)||null;}
export function isAuthorizedCardmarketMapping(mapping){if(mapping?.resolution_status==='manual')return true;const status=mapping?.resolverStatus||mapping?.resolver_status||mapping?.provider_metadata?.resolverStatus;return mapping?.resolution_status==='resolved'&&[CARDMARKET_RESOLUTION_STATES.EXACT,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE].includes(status);}
export function cardmarketMappingNeedsResolver(mapping){if(mapping?.resolution_status==='manual')return false;return ['unresolved','ambiguous'].includes(mapping?.resolution_status)||String(mapping?.provider_metadata?.resolverVersion||'')!==String(CARDMARKET_RESOLVER_VERSION);}

export function buildCardmarketExpansionHints(printings=[],products=[]){
  const groups=new Map(),productsByName=new Map();
  for(const row of printings||[]){const key=setSeriesKey(row.setCode||row.set_code),name=norm(row.cardName||row.card_name);if(!key||!name)continue;if(!groups.has(key))groups.set(key,new Set());groups.get(key).add(name);}
  for(const row of products||[]){const name=norm(row.cardName||row.name),expansionId=String(row.providerExpansionId||row.provider_expansion_id||'');if(!name||!expansionId)continue;if(!productsByName.has(name))productsByName.set(name,[]);productsByName.get(name).push(row);}
  const hints=new Map();
  for(const [key,names] of groups){
    const candidates=new Map();
    for(const name of names)for(const row of productsByName.get(name)||[]){const expansionId=String(row.providerExpansionId||row.provider_expansion_id||'');if(!candidates.has(expansionId))candidates.set(expansionId,{providerExpansionId:expansionId,expansion:row.setName||row.expansion||'',matchedNames:new Set()});candidates.get(expansionId).matchedNames.add(name);}
    const ranked=[...candidates.values()].map(row=>({...row,overlap:row.matchedNames.size})).sort((left,right)=>right.overlap-left.overlap||left.providerExpansionId.localeCompare(right.providerExpansionId,'en',{numeric:true}));
    const best=ranked[0],runner=ranked[1];
    if(best?.overlap>=2&&(!runner||best.overlap>runner.overlap))hints.set(key,{providerExpansionId:best.providerExpansionId,expansion:best.expansion,overlap:best.overlap,internalCards:names.size});
  }
  return hints;
}

function normalizePrinting(row){return {game:norm(row.game),catalogId:norm(row.catalogCardId||row.catalog_card_id),setCode:normCode(row.setCode||row.set_code),
  expansion:norm(row.setName||row.set_name||row.expansion),rarity:norm(row.rarity),language:norm(row.language),edition:norm(row.edition),foil:bool(row.foil)};}
// Index a catalog once per feed, avoiding a full scan for every printing.
const cardmarketNameIndexes=new WeakMap();
function cardmarketCandidatesByName(rows,names){
  let index=cardmarketNameIndexes.get(rows);
  if(!index){index=new Map();for(const row of rows){const key=row._normName??norm(row.cardName||row.name);if(!index.has(key))index.set(key,[]);index.get(key).push(row);}cardmarketNameIndexes.set(rows,index);}
  return [...names].flatMap(name=>index.get(name)||[]);
}
function productId(row){return String(read(row,['providerProductId','provider_product_id','idProduct','Product ID','product_id','id'])||'');}
function mappingProductIds(mapping){const many=mapping?.provider_metadata?.candidateProductIds||mapping?.candidateProductIds||[];return [...new Set([mapping?.providerProductId||mapping?.provider_product_id||'',...(Array.isArray(many)?many:[])].map(String).filter(Boolean))];}
function evidenceBase(printing,rarity){return {internalPrintingId:printing.printingId||printing.printing_id||printing.id||null,catalogCardId:String(printing.catalogCardId||printing.catalog_card_id||''),internalSetCode:printing.setCode||printing.set_code||'',internalSetName:printing.setName||printing.set_name||'',internalRarity:rarity,internalLanguage:printing.language||'',internalEdition:printing.edition||''};}
function setFamilyKey(value){const code=String(value||'').trim().toUpperCase(),match=code.match(/^([A-Z0-9]+)-[A-Z]{1,3}([0-9]+)$/);return match?`${match[1]}:${match[2]}`:normCode(code);}
function setSeriesKey(value){return String(value||'').trim().toUpperCase().split('-',1)[0].replace(/[^A-Z0-9]/g,'');}
function sameCardmarketExpansion(left,right){const a=norm(left),b=norm(right);return a===b||Boolean(a&&b&&cardmarketExpansionKey(a)===cardmarketExpansionKey(b));}
function cardmarketExpansionKey(value){
  let key=norm(value);
  const aliases={
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
const internalPrintingsIndexCache=new WeakMap();
function internalPrintingsByCatalogId(rows){
  let index=internalPrintingsIndexCache.get(rows);
  if(!index){
    index=new Map();
    for(const row of rows||[]){const key=norm(row.catalogCardId||row.catalog_card_id);if(!key)continue;if(!index.has(key))index.set(key,[]);index.get(key).push(row);}
    internalPrintingsIndexCache.set(rows,index);
  }
  return index;
}
function internalFamily(printing,rows){const catalog=norm(printing.catalogCardId||printing.catalog_card_id),family=setFamilyKey(printing.setCode||printing.set_code),sameCatalog=internalPrintingsByCatalogId(rows).get(catalog)||[],result=sameCatalog.filter(row=>setFamilyKey(row.setCode||row.set_code)===family);return result.length?result:[printing];}
function dedupeProducts(rows){const byId=new Map();for(const row of rows||[]){const id=productId(row);if(id&&!byId.has(id))byId.set(id,row);}return [...byId.values()].sort((a,b)=>productId(a).localeCompare(productId(b),'en',{numeric:true}));}
export function parseCardmarketPayload(text,key){const value=String(text||'').trim();if(!value)return {rows:[],createdAt:''};if(value[0]==='{'||value[0]==='['){const parsed=JSON.parse(value),rows=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.[key])?parsed[key]:[]);return {rows,createdAt:parsed?.createdAt||''};}return {rows:parseDelimited(value),createdAt:''};}
export function cardmarketNonSinglesUrl(value){try{const url=new URL(value);if(!/products_singles_\d+\.json$/i.test(url.pathname))return'';url.pathname=url.pathname.replace(/products_singles_(\d+)\.json$/i,'products_nonsingles_$1.json');return url.toString();}catch{return'';}}
function buildExpansionNames(rows){const values=new Map();for(const row of rows||[])addExpansionName(values,row);return values;}
function addExpansionName(values,row){const id=String(row.idExpansion||row.expansion_id||'');if(!id)return;const name=cleanExpansionName(row.name||'');if(!name)return;const names=values.get(id)||[];if(!names.includes(name))names.push(name);names.sort((a,b)=>a.length-b.length||a.localeCompare(b));values.set(id,names);}
function cleanExpansionName(value){return String(value).replace(/\s+(?:Booster(?: Box| Case)?|Box Set|Display|Case|Pack|Deck|Tin|Box)(?:\s*\([^)]*\))?$/i,'').trim();}
function normalizeCardmarketProduct(row,expansions){const rawName=String(row.name||''),parsed=parseProductName(rawName),id=productId(row),expansionId=String(row.idExpansion||'');return {...row,id,providerProductId:id,provider_product_id:id,game:'yugioh',rawName,cardName:parsed.cardName,name:parsed.cardName,rarity:parsed.rarity,setName:expansions.get(expansionId)?.[0]||'',expansion:expansions.get(expansionId)?.[0]||'',expansionNames:expansions.get(expansionId)||[],providerExpansionId:expansionId,provider_expansion_id:expansionId,foil:parsed.foil,productUrl:`https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(id)}`,
  // norm() does Unicode NFD normalization + several regex passes — cheap once,
  // but resolveCardmarketPrinting() used to call it fresh on every catalog row
  // for EVERY target being resolved (T targets x N catalog rows), which is
  // almost certainly what was burning the Edge Function's CPU-time budget on
  // a real production-sized catalogue (confirmed via "CPU Time exceeded",
  // 2026-09-06). Precomputing it once per row here turns that into O(N).
  _normName:norm(parsed.cardName)};}
function parseProductName(value){const raw=String(value).trim(),match=raw.match(/^(.*?)\s*\(V\.\d+\s*-\s*([^()]+)\)\s*$/i),cardName=(match?.[1]||raw).trim(),rarity=(match?.[2]||'').trim();return {cardName,rarity,foil:/\bfoil\b/i.test(rarity)?true:null};}
function numberFrom(row,keys){const raw=read(row,keys);if(raw==null||raw==='')return null;const value=Number(String(raw).replace(',','.'));return Number.isFinite(value)&&value>=0?value:null;}
function read(row,keys){for(const key of keys)if(row?.[key]!=null&&row[key]!=='')return row[key];return null;}
function norm(value){return decodeEntities(value).replace(/^el shaddoll meshahrail$/i,'El Shaddoll Meshachrer').replace(/^reeshaddoll wendikurhu$/i,'Reeshaddoll Wendikuruhu').replace(/^black jack the shadow-armored knight$/i,'Shadowreaver Knight 21').replace(/^early palm gets the win$/i,'First Striker Advantage').replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g,'').replace(/maliss <([pq])>/gi,'maliss $1').replace(/falchion\s*(?:beta|β)/gi,'falchion beta').replace(/^(H\.E\.R\.O\. Flash!) \(BLZD\)$/i,'$1').replace(/\\+(?=["'])/g,'').replace(/[“”]/g,'"').replace(/"+/g,'"').replace(/[★☆]/g,'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[‐‑‒–—]/g,'-').trim().toLowerCase().replace(/\s+/g,' ');}
function decodeEntities(value){return String(value??'').replace(/&(apos|#39|#x27);/gi,"'").replace(/&(quot|#34|#x22);/gi,'"').replace(/&amp;/gi,'&').replace(/&nbsp;/gi,' ').replace(/&#(x?[0-9a-f]+);/gi,(_,raw)=>{const radix=raw[0].toLowerCase()==='x'?16:10,code=Number.parseInt(raw.replace(/^x/i,''),radix);return Number.isFinite(code)&&code>0&&code<=0x10ffff?String.fromCodePoint(code):_;});}
function normCode(value){return norm(value).replace(/[^a-z0-9]/g,'');}
function bool(value){if(value==null||value==='')return null;if(typeof value==='boolean')return value;return ['1','true','yes','foil'].includes(norm(value));}
function backoff(attempt){return Math.min(16000,2000*(2**attempt))+Math.floor(Math.random()*250);}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function unavailable(provider,secret){const error=new Error(`${provider} non disponibile: configurare ${secret}`);error.code='provider_unavailable';return error;}
async function safeText(response){try{return (await response.text()).slice(0,500);}catch{return '';}}
function validateOfficialCardmarketUrl(value){const url=new URL(value);if(url.protocol!=='https:'||!(url.hostname==='www.cardmarket.com'||url.hostname==='cardmarket.com'||url.hostname.endsWith('.cardmarket.com')||url.hostname==='downloads.s3.cardmarket.com'))throw new Error('URL Cardmarket non ufficiale rifiutato');}
async function responseText(response){const buffer=await response.arrayBuffer(),encoding=String(response.headers?.get?.('content-encoding')||'').toLowerCase(),type=String(response.headers?.get?.('content-type')||'').toLowerCase(),gzip=encoding.includes('gzip')||type.includes('gzip')||new Uint8Array(buffer).slice(0,2).join(',')==='31,139';if(gzip&&typeof DecompressionStream!=='undefined'){const stream=new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));return new Response(stream).text();}return new TextDecoder().decode(buffer);}
export async function streamCardmarketRows(response,key,onRow=()=>{}){
  if(!response?.body)throw new Error(`Feed Cardmarket ${key} senza contenuto`);
  const reader=response.body.getReader(),decoder=new TextDecoder();
  // Building each row's JSON text one character at a time via `object+=char`
  // used to burn Edge Function CPU-time badly on Cardmarket's full catalogue
  // (tens/hundreds of thousands of rows -> that many repeated string copies)
  // and got the whole sync killed with "CPU Time exceeded" before it ever
  // got to run a query. Tracking start/end indexes and slicing once per row
  // (joining only the rare row that straddles two stream chunks) does the
  // exact same boundary detection with none of the per-character copying.
  let header='',started=false,finished=false,inString=false,escaped=false,depth=0,rows=0,createdAt='',parts=[],partStart=0;
  const consume=text=>{let index=0;if(!started){header+=text;const match=header.match(new RegExp(`"${key}"\\s*:\\s*\\[`));if(!match){if(header.length>131072)throw new Error(`Array ${key} non trovato nel feed Cardmarket`);return;}createdAt=header.match(/"createdAt"\s*:\s*"([^"]+)"/)?.[1]||'';index=match.index+match[0].length;header=header.slice(index);text=header;index=0;header='';started=true;}
    if(depth>0)partStart=0;
    for(;index<text.length&&!finished;index++){const char=text[index];if(depth===0){if(char==='{'){depth=1;partStart=index;inString=false;escaped=false;}else if(char===']')finished=true;continue;}if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue;}if(char==='"'){inString=true;continue;}if(char==='{')depth++;else if(char==='}'&&--depth===0){parts.push(text.slice(partStart,index+1));onRow(JSON.parse(parts.length>1?parts.join(''):parts[0]));rows++;parts=[];}}
    if(depth>0)parts.push(text.slice(partStart));
  };
  while(true){const {value,done}=await reader.read();if(done)break;consume(decoder.decode(value,{stream:true}));}
  consume(decoder.decode());if(!started||!finished)throw new Error(`Feed Cardmarket ${key} incompleto`);return {rows,createdAt};
}
export function parseDelimited(text){const first=String(text).split(/\r?\n/,1)[0]||'',delimiter=(first.match(/;/g)||[]).length>(first.match(/,/g)||[]).length?';':',';const rows=parseCsv(String(text),delimiter);if(!rows.length)return[];const headers=rows.shift().map(value=>value.replace(/^\uFEFF/,''));return rows.filter(row=>row.some(Boolean)).map(row=>Object.fromEntries(headers.map((key,index)=>[key,row[index]??''])));}
function parseCsv(text,delimiter){const rows=[];let row=[],field='',quoted=false;for(let index=0;index<text.length;index++){const char=text[index];if(char==='"'){if(quoted&&text[index+1]==='"'){field+='"';index++;}else quoted=!quoted;}else if(char===delimiter&&!quoted){row.push(field);field='';}else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&text[index+1]==='\n')index++;row.push(field);rows.push(row);row=[];field='';}else field+=char;}if(field||row.length){row.push(field);rows.push(row);}return rows;}

export class ProviderHttpError extends Error {constructor(provider,status,detail=''){super(`${provider}: HTTP ${status}${detail?` — ${detail}`:''}`);this.provider=provider;this.status=status;}}
