const RESOLUTION_STATES=new Set(['resolved','ambiguous','unresolved','manual']);
export const CARDMARKET_RESOLVER_VERSION=8;
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
  ['holographic rare','Holographic Rare'],["ultra rare (pharaoh's rare)","Ultra Rare (Pharaoh's Rare)"]
]);

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
    const definitions={low:['low','Low Price','LOW'],trend:['trend','Trend Price','TREND'],average:['avg','Avg. Sell Price','AVG'],avg1:['avg1','AVG1'],avg7:['avg7','AVG7'],avg30:['avg30','AVG30'],
      foil_low:['low-foil','Foil Low','LOWFOIL'],foil_trend:['trend-foil','Foil Trend','TRENDFOIL'],foil_average:['avg-foil','Foil Sell','SELLFOIL'],foil_avg1:['avg1-foil','Foil AVG1'],foil_avg7:['avg7-foil','Foil AVG7'],foil_avg30:['avg30-foil','Foil AVG30']};
    const prices=[];for(const [type,keys] of Object.entries(definitions)){const values=rows.map(row=>numberFrom(row,keys)).filter(value=>value!=null);if(values.length)prices.push({type,value:Math.min(...values)});}
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
  const allPrintings=options.internalPrintings||[],family=internalFamily(printing,allPrintings),acceptedNames=new Set([name,...(catalogId?allPrintings.filter(row=>norm(row.catalogCardId||row.catalog_card_id)===catalogId).map(row=>norm(row.cardName||row.card_name)):[])].filter(Boolean)),expansions=new Set(family.map(row=>norm(row.setName||row.set_name)).filter(Boolean));
  if(local.expansion)expansions.add(local.expansion);
  if(!name||!expansions.size)return fail(CARDMARKET_RESOLUTION_STATES.UNRESOLVED,'name_or_expansion_missing');
  const hint=options.expansionHints?.get?.(setSeriesKey(printing.setCode||printing.set_code))||null;
  const products=dedupeProducts((candidates||[]).filter(row=>acceptedNames.has(norm(row.cardName||row.name))&&(
    [...expansions].some(expansion=>sameCardmarketExpansion(expansion,row.setName||row.expansion))||(hint&&String(row.providerExpansionId||row.provider_expansion_id||'')===hint.providerExpansionId)
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
export function normalizeMappingStatus(value){return RESOLUTION_STATES.has(value)?value:'unresolved';}
export function normalizeMarketRarity(value){const rarity=norm(value);return /^\d+$/.test(rarity)?'Common':SUPPORTED_RARITIES.get(rarity)||null;}
export function isAuthorizedCardmarketMapping(mapping){if(mapping?.resolution_status==='manual')return true;const status=mapping?.resolverStatus||mapping?.resolver_status||mapping?.provider_metadata?.resolverStatus;return mapping?.resolution_status==='resolved'&&[CARDMARKET_RESOLUTION_STATES.EXACT,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE].includes(status);}
export function cardmarketMappingNeedsResolver(mapping){if(mapping?.resolution_status==='manual'||isAuthorizedCardmarketMapping(mapping))return false;return String(mapping?.provider_metadata?.resolverVersion||'')!==String(CARDMARKET_RESOLVER_VERSION);}

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
function productId(row){return String(read(row,['providerProductId','provider_product_id','idProduct','Product ID','product_id','id'])||'');}
function mappingProductIds(mapping){const many=mapping?.provider_metadata?.candidateProductIds||mapping?.candidateProductIds||[];return [...new Set([mapping?.providerProductId||mapping?.provider_product_id||'',...(Array.isArray(many)?many:[])].map(String).filter(Boolean))];}
function evidenceBase(printing,rarity){return {internalPrintingId:printing.printingId||printing.printing_id||printing.id||null,catalogCardId:String(printing.catalogCardId||printing.catalog_card_id||''),internalSetCode:printing.setCode||printing.set_code||'',internalSetName:printing.setName||printing.set_name||'',internalRarity:rarity,internalLanguage:printing.language||'',internalEdition:printing.edition||''};}
function setFamilyKey(value){const code=String(value||'').trim().toUpperCase(),match=code.match(/^([A-Z0-9]+)-[A-Z]{1,3}([0-9]+)$/);return match?`${match[1]}:${match[2]}`:normCode(code);}
function setSeriesKey(value){return String(value||'').trim().toUpperCase().split('-',1)[0].replace(/[^A-Z0-9]/g,'');}
function sameCardmarketExpansion(left,right){const a=norm(left),b=norm(right);return a===b||Boolean(a&&b&&cardmarketExpansionKey(a)===cardmarketExpansionKey(b));}
function cardmarketExpansionKey(value){return norm(value).replace(/\b([a-z0-9]+)['’]s\b/g,'$1').replace(/\b(?:structure|starter) deck\b/g,' ').replace(/\bmega[- ]tins?\b/g,'mega tin').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function internalFamily(printing,rows){const catalog=norm(printing.catalogCardId||printing.catalog_card_id),family=setFamilyKey(printing.setCode||printing.set_code),result=(rows||[]).filter(row=>norm(row.catalogCardId||row.catalog_card_id)===catalog&&setFamilyKey(row.setCode||row.set_code)===family);return result.length?result:[printing];}
function dedupeProducts(rows){const byId=new Map();for(const row of rows||[]){const id=productId(row);if(id&&!byId.has(id))byId.set(id,row);}return [...byId.values()].sort((a,b)=>productId(a).localeCompare(productId(b),'en',{numeric:true}));}
export function parseCardmarketPayload(text,key){const value=String(text||'').trim();if(!value)return {rows:[],createdAt:''};if(value[0]==='{'||value[0]==='['){const parsed=JSON.parse(value),rows=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.[key])?parsed[key]:[]);return {rows,createdAt:parsed?.createdAt||''};}return {rows:parseDelimited(value),createdAt:''};}
export function cardmarketNonSinglesUrl(value){try{const url=new URL(value);if(!/products_singles_\d+\.json$/i.test(url.pathname))return'';url.pathname=url.pathname.replace(/products_singles_(\d+)\.json$/i,'products_nonsingles_$1.json');return url.toString();}catch{return'';}}
function buildExpansionNames(rows){const values=new Map();for(const row of rows||[]){const id=String(row.idExpansion||row.expansion_id||'');if(!id)continue;const name=cleanExpansionName(row.name||'');if(!name)continue;const current=values.get(id);if(!current||name.length<current.length)values.set(id,name);}return values;}
function addExpansionName(values,row){const id=String(row.idExpansion||row.expansion_id||'');if(!id)return;const name=cleanExpansionName(row.name||'');if(!name)return;const current=values.get(id);if(!current||name.length<current.length)values.set(id,name);}
function cleanExpansionName(value){return String(value).replace(/\s+(?:Booster(?: Box| Case)?|Display|Case|Pack|Deck|Tin|Box)(?:\s*\([^)]*\))?$/i,'').trim();}
function normalizeCardmarketProduct(row,expansions){const rawName=String(row.name||''),parsed=parseProductName(rawName),id=productId(row),expansionId=String(row.idExpansion||'');return {...row,id,providerProductId:id,provider_product_id:id,game:'yugioh',rawName,cardName:parsed.cardName,name:parsed.cardName,rarity:parsed.rarity,setName:expansions.get(expansionId)||'',expansion:expansions.get(expansionId)||'',providerExpansionId:expansionId,provider_expansion_id:expansionId,foil:parsed.foil,productUrl:`https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(id)}`};}
function parseProductName(value){const raw=String(value).trim(),match=raw.match(/^(.*?)\s*\(V\.\d+\s*-\s*([^()]+)\)\s*$/i),cardName=(match?.[1]||raw).trim(),rarity=(match?.[2]||'').trim();return {cardName,rarity,foil:/\bfoil\b/i.test(rarity)?true:null};}
function numberFrom(row,keys){const raw=read(row,keys);if(raw==null||raw==='')return null;const value=Number(String(raw).replace(',','.'));return Number.isFinite(value)&&value>=0?value:null;}
function read(row,keys){for(const key of keys)if(row?.[key]!=null&&row[key]!=='')return row[key];return null;}
function norm(value){return decodeEntities(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[‐‑‒–—]/g,'-').trim().toLowerCase().replace(/\s+/g,' ');}
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
  const reader=response.body.getReader(),decoder=new TextDecoder();let header='',started=false,finished=false,inString=false,escaped=false,depth=0,object='',rows=0,createdAt='';
  const consume=text=>{let index=0;if(!started){header+=text;const match=header.match(new RegExp(`"${key}"\\s*:\\s*\\[`));if(!match){if(header.length>131072)throw new Error(`Array ${key} non trovato nel feed Cardmarket`);return;}createdAt=header.match(/"createdAt"\s*:\s*"([^"]+)"/)?.[1]||'';index=match.index+match[0].length;header=header.slice(index);text=header;index=0;header='';started=true;}
    for(;index<text.length&&!finished;index++){const char=text[index];if(depth===0){if(char==='{'){depth=1;object='{';inString=false;escaped=false;}else if(char===']')finished=true;continue;}object+=char;if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue;}if(char==='"'){inString=true;continue;}if(char==='{')depth++;else if(char==='}'&&--depth===0){onRow(JSON.parse(object));rows++;object='';}}
  };
  while(true){const {value,done}=await reader.read();if(done)break;consume(decoder.decode(value,{stream:true}));}
  consume(decoder.decode());if(!started||!finished)throw new Error(`Feed Cardmarket ${key} incompleto`);return {rows,createdAt};
}
export function parseDelimited(text){const first=String(text).split(/\r?\n/,1)[0]||'',delimiter=(first.match(/;/g)||[]).length>(first.match(/,/g)||[]).length?';':',';const rows=parseCsv(String(text),delimiter);if(!rows.length)return[];const headers=rows.shift().map(value=>value.replace(/^\uFEFF/,''));return rows.filter(row=>row.some(Boolean)).map(row=>Object.fromEntries(headers.map((key,index)=>[key,row[index]??''])));}
function parseCsv(text,delimiter){const rows=[];let row=[],field='',quoted=false;for(let index=0;index<text.length;index++){const char=text[index];if(char==='"'){if(quoted&&text[index+1]==='"'){field+='"';index++;}else quoted=!quoted;}else if(char===delimiter&&!quoted){row.push(field);field='';}else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&text[index+1]==='\n')index++;row.push(field);rows.push(row);row=[];field='';}else field+=char;}if(field||row.length){row.push(field);rows.push(row);}return rows;}

export class ProviderHttpError extends Error {constructor(provider,status,detail=''){super(`${provider}: HTTP ${status}${detail?` — ${detail}`:''}`);this.provider=provider;this.status=status;}}
