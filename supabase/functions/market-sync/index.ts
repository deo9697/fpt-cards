// Deploy manualmente solo dopo aver applicato la migration Market Watch.
// Il cron delle 03:00 Europe/Rome è intenzionalmente escluso dalla migration.
//
// NOTA: il contenuto di market/providers.js è INLINE qui sotto (non importato) perché
// il bundler del Dashboard Supabase risolve gli import relativi rispetto a una root
// virtuale che non contiene il resto del repo: qualunque "../" tenta di risalire
// finisce fuori dalla function e il deploy fallisce con "Module not found".
// Se modifichi market/providers.js, riporta manualmente le stesse modifiche qui sotto.

const RESOLUTION_STATES=new Set(['resolved','ambiguous','unresolved','manual']);
const CARDMARKET_RESOLVER_VERSION=8;
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
  ['holographic rare','Holographic Rare'],["ultra rare (pharaoh's rare)","Ultra Rare (Pharaoh's Rare)"]
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
    if(!this.catalogUrl)throw unavailable('Cardmarket Product Catalogue','CARDMARKET_PRODUCT_CATALOG_URL');
    validateOfficialCardmarketUrl(this.catalogUrl);
    const nonSinglesUrl=cardmarketNonSinglesUrl(this.catalogUrl);
    const nonSinglesResponse=nonSinglesUrl?await this.request(nonSinglesUrl):null;
    if(!nonSinglesResponse?.ok)throw new ProviderHttpError(this.name,nonSinglesResponse?.status||503,'Catalogo espansioni non disponibile');
    const expansions=new Map();
    const expansionPayload=await streamCardmarketRows(nonSinglesResponse,'products',(row:any)=>addExpansionName(expansions,row));
    if(expansions.size<100)throw new Error('Catalogo espansioni Cardmarket non disponibile dal link Product Catalogue');
    const internalPrintings=options.internalPrintings||[],targetCatalogIds=new Set((targets||[]).map((row:any)=>norm(row.catalogCardId||row.catalog_card_id)).filter(Boolean));
    const wantedNames=new Set([...(targets||[]),...internalPrintings.filter((row:any)=>targetCatalogIds.has(norm(row.catalogCardId||row.catalog_card_id)))].map((row:any)=>norm(row.cardName||row.card_name)).filter(Boolean));
    const hintNames=new Set(internalPrintings.map((row:any)=>norm(row.cardName||row.card_name)).filter(Boolean)),hintProducts:any[]=[],hintSeen=new Set();
    const catalogResponse=await this.request(this.catalogUrl);
    if(!catalogResponse.ok)throw new ProviderHttpError(this.name,catalogResponse.status,'Product Catalogue non disponibile');
    const catalog:any[]=[];
    const catalogPayload=await streamCardmarketRows(catalogResponse,'products',(row:any)=>{const parsed=parseProductName(row.name||''),name=norm(parsed.cardName);if(!wantedNames.size||wantedNames.has(name))catalog.push(normalizeCardmarketProduct(row,expansions));if(hintNames.has(name)){const candidate=normalizeCardmarketProduct(row,expansions),key=`${name}:${candidate.providerExpansionId}`;if(candidate.providerExpansionId&&!hintSeen.has(key)){hintSeen.add(key);hintProducts.push({cardName:candidate.cardName,setName:candidate.setName,providerExpansionId:candidate.providerExpansionId});}}});
    if(catalogPayload.rows<1000)throw new Error('Product Catalogue Cardmarket non valido: usa il link JSON diretto products_singles_3.json');
    this.catalog=catalog;this.expansionHints=buildCardmarketExpansionHints(internalPrintings,hintProducts);
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
  const allPrintings=options.internalPrintings||[],family=internalFamily(printing,allPrintings),acceptedNames=new Set([name,...(catalogId?allPrintings.filter((row:any)=>norm(row.catalogCardId||row.catalog_card_id)===catalogId).map((row:any)=>norm(row.cardName||row.card_name)):[])].filter(Boolean)),expansions=new Set(family.map((row:any)=>norm(row.setName||row.set_name)).filter(Boolean));
  if(local.expansion)expansions.add(local.expansion);
  if(!name||!expansions.size)return fail(CARDMARKET_RESOLUTION_STATES.UNRESOLVED,'name_or_expansion_missing');
  const hint=options.expansionHints?.get?.(setSeriesKey(printing.setCode||printing.set_code))||null;
  const products=dedupeProducts((candidates||[]).filter((row:any)=>acceptedNames.has(norm(row.cardName||row.name))&&(
    [...expansions].some(expansion=>sameCardmarketExpansion(expansion as string,row.setName||row.expansion))||(hint&&String(row.providerExpansionId||row.provider_expansion_id||'')===hint.providerExpansionId)
  )));
  if(!products.length)return fail(CARDMARKET_RESOLUTION_STATES.UNRESOLVED,'provider_product_not_found',{acceptedNames:[...acceptedNames].sort(),acceptedExpansions:[...expansions].sort(),expansionHint:hint});
  const internalRarities=[...new Set(family.map((row:any)=>normalizeMarketRarity(row.rarity)).filter(Boolean))].sort();
  const exactRarity=products.filter((row:any)=>normalizeMarketRarity(row.rarity)===internalRarity);
  const providerRarityKnown=products.filter((row:any)=>normalizeMarketRarity(row.rarity));
  let matches:any[]=[];
  if(exactRarity.length)matches=exactRarity;
  else if(providerRarityKnown.length)return fail(CARDMARKET_RESOLUTION_STATES.UNRESOLVED,'provider_rarity_mismatch',{internalRarities,providerRarities:[...new Set(providerRarityKnown.map((row:any)=>normalizeMarketRarity(row.rarity)))].sort(),candidateCount:products.length});
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
function cardmarketMappingNeedsResolver(mapping:any):boolean{if(mapping?.resolution_status==='manual'||isAuthorizedCardmarketMapping(mapping))return false;return String(mapping?.provider_metadata?.resolverVersion||'')!==String(CARDMARKET_RESOLVER_VERSION);}

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
function productId(row:any):string{return String(read(row,['providerProductId','provider_product_id','idProduct','Product ID','product_id','id'])||'');}
function mappingProductIds(mapping:any):string[]{const many=mapping?.provider_metadata?.candidateProductIds||mapping?.candidateProductIds||[];return [...new Set([mapping?.providerProductId||mapping?.provider_product_id||'',...(Array.isArray(many)?many:[])].map(String).filter(Boolean))];}
function evidenceBase(printing:any,rarity:any){return {internalPrintingId:printing.printingId||printing.printing_id||printing.id||null,catalogCardId:String(printing.catalogCardId||printing.catalog_card_id||''),internalSetCode:printing.setCode||printing.set_code||'',internalSetName:printing.setName||printing.set_name||'',internalRarity:rarity,internalLanguage:printing.language||'',internalEdition:printing.edition||''};}
function setFamilyKey(value:any):string{const code=String(value||'').trim().toUpperCase(),match=code.match(/^([A-Z0-9]+)-[A-Z]{1,3}([0-9]+)$/);return match?`${match[1]}:${match[2]}`:normCode(code);}
function setSeriesKey(value:any):string{return String(value||'').trim().toUpperCase().split('-',1)[0].replace(/[^A-Z0-9]/g,'');}
function sameCardmarketExpansion(left:any,right:any):boolean{const a=norm(left),b=norm(right);return a===b||Boolean(a&&b&&cardmarketExpansionKey(a)===cardmarketExpansionKey(b));}
function cardmarketExpansionKey(value:any):string{return norm(value).replace(/\b([a-z0-9]+)['’]s\b/g,'$1').replace(/\b(?:structure|starter) deck\b/g,' ').replace(/\bmega[- ]tins?\b/g,'mega tin').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function internalFamily(printing:any,rows:any[]):any[]{const catalog=norm(printing.catalogCardId||printing.catalog_card_id),family=setFamilyKey(printing.setCode||printing.set_code),result=(rows||[]).filter((row:any)=>norm(row.catalogCardId||row.catalog_card_id)===catalog&&setFamilyKey(row.setCode||row.set_code)===family);return result.length?result:[printing];}
function dedupeProducts(rows:any[]):any[]{const byId=new Map<string,any>();for(const row of rows||[]){const id=productId(row);if(id&&!byId.has(id))byId.set(id,row);}return [...byId.values()].sort((a,b)=>productId(a).localeCompare(productId(b),'en',{numeric:true}));}
function cardmarketNonSinglesUrl(value:string):string{try{const url=new URL(value);if(!/products_singles_\d+\.json$/i.test(url.pathname))return'';url.pathname=url.pathname.replace(/products_singles_(\d+)\.json$/i,'products_nonsingles_$1.json');return url.toString();}catch{return'';}}
function addExpansionName(values:Map<string,string>,row:any){const id=String(row.idExpansion||row.expansion_id||'');if(!id)return;const name=cleanExpansionName(row.name||'');if(!name)return;const current=values.get(id);if(!current||name.length<current.length)values.set(id,name);}
function cleanExpansionName(value:any):string{return String(value).replace(/\s+(?:Booster(?: Box| Case)?|Display|Case|Pack|Deck|Tin|Box)(?:\s*\([^)]*\))?$/i,'').trim();}
function normalizeCardmarketProduct(row:any,expansions:Map<string,string>){const rawName=String(row.name||''),parsed=parseProductName(rawName),id=productId(row),expansionId=String(row.idExpansion||'');return {...row,id,providerProductId:id,provider_product_id:id,game:'yugioh',rawName,cardName:parsed.cardName,name:parsed.cardName,rarity:parsed.rarity,setName:expansions.get(expansionId)||'',expansion:expansions.get(expansionId)||'',providerExpansionId:expansionId,provider_expansion_id:expansionId,foil:parsed.foil,productUrl:`https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(id)}`};}
function parseProductName(value:any){const raw=String(value).trim(),match=raw.match(/^(.*?)\s*\(V\.\d+\s*-\s*([^()]+)\)\s*$/i),cardName=(match?.[1]||raw).trim(),rarity=(match?.[2]||'').trim();return {cardName,rarity,foil:/\bfoil\b/i.test(rarity)?true:null};}
function numberFrom(row:any,keys:string[]):number|null{const raw=read(row,keys);if(raw==null||raw==='')return null;const value=Number(String(raw).replace(',','.'));return Number.isFinite(value)&&value>=0?value:null;}
function read(row:any,keys:string[]):any{for(const key of keys)if(row?.[key]!=null&&row[key]!=='')return row[key];return null;}
function norm(value:any):string{return decodeEntities(value).normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[‐‑‒–—]/g,'-').trim().toLowerCase().replace(/\s+/g,' ');}
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
  const reader=response.body.getReader(),decoder=new TextDecoder();let header='',started=false,finished=false,inString=false,escaped=false,depth=0,object='',rows=0,createdAt='';
  const consume=(text:string)=>{let index=0;if(!started){header+=text;const match=header.match(new RegExp(`"${key}"\\s*:\\s*\\[`));if(!match){if(header.length>131072)throw new Error(`Array ${key} non trovato nel feed Cardmarket`);return;}createdAt=header.match(/"createdAt"\s*:\s*"([^"]+)"/)?.[1]||'';index=match.index!+match[0].length;header=header.slice(index);text=header;index=0;header='';started=true;}
    for(;index<text.length&&!finished;index++){const char=text[index];if(depth===0){if(char==='{'){depth=1;object='{';inString=false;escaped=false;}else if(char===']')finished=true;continue;}object+=char;if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue;}if(char==='"'){inString=true;continue;}if(char==='{')depth++;else if(char==='}'&&--depth===0){onRow(JSON.parse(object));rows++;object='';}}
  };
  while(true){const {value,done}=await reader.read();if(done)break;consume(decoder.decode(value,{stream:true}));}
  consume(decoder.decode());if(!started||!finished)throw new Error(`Feed Cardmarket ${key} incompleto`);return {rows,createdAt};
}

class ProviderHttpError extends Error {provider:string;status:number;constructor(provider:string,status:number,detail=''){super(`${provider}: HTTP ${status}${detail?` — ${detail}`:''}`);this.provider=provider;this.status=status;}}

const supabaseUrl=Deno.env.get('SUPABASE_URL')||'';
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const syncSecret=Deno.env.get('MARKET_SYNC_SECRET')||'';

Deno.serve(async request=>{
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(!supabaseUrl||!serviceKey)return json({error:'backend_not_configured'},503);
  if(!syncSecret)return json({error:'sync_secret_not_configured'},503);
  if(request.headers.get('x-market-sync-secret')!==syncSecret)return json({error:'unauthorized'},401);
  const payload=await request.json().catch(()=>({}));
  const dryTargetPrintingIds=printingIds(payload?.dryTargetPrintingIds);
  const canaryPrintingIds=printingIds(payload?.canaryPrintingIds);
  if(payload?.dryTargetPrintingIds&&!dryTargetPrintingIds.length)return json({error:'invalid_dry_target_printing_ids'},400);
  if(payload?.canaryPrintingIds&&!canaryPrintingIds.length)return json({error:'invalid_canary_printing_ids'},400);
  if(dryTargetPrintingIds.length&&canaryPrintingIds.length)return json({error:'dry_target_and_canary_are_mutually_exclusive'},400);
  if(payload?.scheduled===true&&!isThreeInRome(new Date()))return json({ok:true,status:'skipped',reason:'outside_03_europe_rome'});
  const providers=[
    new CardmarketPriceGuideProvider({catalogUrl:Deno.env.get('CARDMARKET_PRODUCT_CATALOG_URL')||'',priceGuideUrl:Deno.env.get('CARDMARKET_PRICE_GUIDE_URL')||''})
  ];
  const resolverBatchSize=payload?.resolvePending===true?Math.max(1,Math.min(500,Number(payload?.resolverBatchSize)||100)):0;
  if(resolverBatchSize){const cardmarket=providers.find(provider=>provider.name==='cardmarket');const result=await syncProvider(cardmarket,{recoverStale:payload?.recoverStale===true,pendingResolverLimit:resolverBatchSize,skipPrices:true});return json({ok:['succeeded','partial','skipped'].includes(result.status),mode:'resolver_batch',results:[result]});}
  const scheduled=payload?.scheduled===true,pricesOnly=payload?.pricesOnly===true||scheduled;
  if(canaryPrintingIds.length&&pricesOnly)return json({error:'canary_requires_full_mode'},400);
  if(dryTargetPrintingIds.length){
    const cardmarket=providers.find(provider=>provider.name==='cardmarket');
    return json(await dryTargetCardmarket(cardmarket,dryTargetPrintingIds));
  }
  const results=[];
  if(scheduled){const cardmarket=providers.find(provider=>provider.name==='cardmarket');results.push(await syncProvider(cardmarket,{pendingResolverLimit:500,skipPrices:true}));}
  for(const provider of providers)results.push(await syncProvider(provider,{recoverStale:payload?.recoverStale===true,pricesOnly,targetPrintingIds:canaryPrintingIds}));
  return json({ok:results.some(row=>['succeeded','partial'].includes(row.status)),mode:canaryPrintingIds.length?'canary':scheduled?'scheduled':pricesOnly?'prices_only':'full',results});
});

async function syncProvider(provider:any,{recoverStale=false,pricesOnly=false,targetPrintingIds=[] as string[],pendingResolverLimit=0,skipPrices=false}={}){
  const metadata=provider.getPriceMetadata();
  if(metadata.status==='unavailable')return {provider:provider.name,status:'unavailable',reason:'secret_or_feed_missing'};
  if(recoverStale)await releaseProviderSync(provider.name);
  const runId=await rpc('begin_market_provider_sync',{p_provider:provider.name});
  if(!runId)return {provider:provider.name,status:'skipped',reason:'sync_already_running'};
  let requestCount=0,snapshots=0,failures=0,feedStats:any=null,targetPages=0,printingPages=0,printingRows=0;
  try{
    const targetResult=await rpcPages('market_sync_targets',{p_provider:provider.name},{order:'printing_id.asc,variant_key.asc.nullslast,mapping_id.asc.nullslast',key:(row:any)=>row.mapping_id||`${row.printing_id}:${row.variant_key||'default'}`});
    const allTargets=targetResult.rows;targetPages=targetResult.requests;
    const selectedIds=new Set(targetPrintingIds),targets=selectedIds.size?allTargets.filter((target:any)=>selectedIds.has(String(target.printing_id))):pendingResolverLimit?allTargets.filter(cardmarketMappingNeedsResolver).slice(0,pendingResolverLimit):allTargets;
    if(pendingResolverLimit&&!targets.length){await finish(runId,'succeeded',{request_count:requestCount,attempt_count:1,metadata:{targets:0,snapshots:0,resolverVersion:CARDMARKET_RESOLVER_VERSION}});return {provider:provider.name,status:'skipped',reason:'resolver_current',targets:0,pagination:{targetPages,targetRows:allTargets.length}};}
    const unique=new Map<string,any>();
    for(const target of targets){const key=`${target.printing_id}:${target.variant_key||'default'}`;if(!unique.has(key))unique.set(key,target);}
    let resolvedTargets=[...unique.values()];
    if(provider.name==='cardmarket'){
      if(pricesOnly){feedStats=await provider.loadPrices(resolvedTargets);requestCount+=1;}
      else{
        const printingResult=await listCardPrintings(),internalPrintings=await withCanonicalCardNames(printingResult.rows,resolvedTargets);
        printingPages=printingResult.requests;printingRows=printingResult.rows.length;
        const catalogStats=await provider.loadCatalog(resolvedTargets,{internalPrintings});requestCount+=3;
        resolvedTargets=await resolveCardmarketTargets(provider,resolvedTargets,internalPrintings);
        if(skipPrices){const mappingStates=resolvedTargets.reduce((counts:any,target:any)=>{const key=target.provider_metadata?.resolverStatus||target.resolution_status||'unresolved';counts[key]=(counts[key]||0)+1;return counts;},{}),unresolved=resolvedTargets.filter((target:any)=>!isAuthorizedCardmarketMapping(target)).length,status=unresolved?'partial':'succeeded';await finish(runId,status,{request_count:requestCount,attempt_count:1,error_code:unresolved?'target_failures':null,error_message:unresolved?`${unresolved} mapping non risolti`:null,metadata:{targets:unique.size,snapshots:0,resolverOnly:true}});return {provider:provider.name,status,targets:unique.size,snapshots:0,failures:unresolved,feedStats:catalogStats,mappingStates,pagination:{targetPages,targetRows:allTargets.length,printingPages,printingRows}};}
        const priceStats=await provider.loadPrices(resolvedTargets);requestCount+=1;
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

async function resolveCardmarketTargets(provider:any,targets:any[],internalPrintings:any[]){
  const bodies=[],expansionHints=provider.expansionHints?.size?provider.expansionHints:buildCardmarketExpansionHints(internalPrintings,provider.catalog);
  for(const target of targets){if(target.resolution_status==='manual'&&target.mapping_id)continue;bodies.push(cardmarketResolutionBody(target,await provider.resolvePrinting(target,{internalPrintings,expansionHints})));}
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
  const response=await fetch(`https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${encodeURIComponent(ids.join(','))}`,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`YGOPRODeck canonical names: ${response.status}`);
  const payload=await response.json(),names=new Map<string,string>();
  for(const card of payload?.data||[]){const name=String(card?.name||'').trim();if(!name)continue;names.set(String(card.id||''),name);for(const image of card.card_images||[])names.set(String(image.id||''),name);}
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
