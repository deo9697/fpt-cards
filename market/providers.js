const CARDTRADER_BASE='https://api.cardtrader.com/api/v2';
const RESOLUTION_STATES=new Set(['resolved','ambiguous','unresolved','manual']);

export class PriceProvider {
  constructor({name,fetchImpl=globalThis.fetch}={}){this.name=name;this.fetch=fetchImpl;}
  async resolvePrinting(){throw new Error('resolvePrinting() non implementato');}
  async getCurrentPrice(){throw new Error('getCurrentPrice() non implementato');}
  async getMarketListings(){throw new Error('getMarketListings() non implementato');}
  getPriceMetadata(){throw new Error('getPriceMetadata() non implementato');}
}

export class CardTraderProvider extends PriceProvider {
  constructor({token='',fetchImpl=globalThis.fetch,sleep=delay,baseUrl=CARDTRADER_BASE}={}){
    super({name:'cardtrader',fetchImpl});this.token=token;this.sleep=sleep;this.baseUrl=baseUrl;this.lastMarketplaceAt=0;
  }
  get available(){return Boolean(this.token);}
  getPriceMetadata(){return {provider:this.name,status:this.available?'available':'unavailable',currency:'account',
    priceTypes:['lowest','reference'],conditionReference:'listing property',marketplaceLimitPerSecond:1};}
  async resolvePrinting(printing,candidates=[]){return resolveExactPrinting(printing,candidates,'cardtrader');}
  async request(path,{marketplace=false,maxAttempts=4}={}){
    if(!this.available)throw unavailable('CardTrader','CARDTRADER_API_TOKEN');
    if(marketplace){const wait=Math.max(0,1050-(Date.now()-this.lastMarketplaceAt));if(wait)await this.sleep(wait);this.lastMarketplaceAt=Date.now();}
    for(let attempt=0;attempt<maxAttempts;attempt++){
      let response;
      try{response=await this.fetch(`${this.baseUrl}${path}`,{headers:{Authorization:`Bearer ${this.token}`,Accept:'application/json'}});}catch(error){if(attempt===maxAttempts-1)throw error;await this.sleep(backoff(attempt));continue;}
      if(response.ok)return response.json();
      if(![429,500,502,503,504].includes(response.status)||attempt===maxAttempts-1)throw new ProviderHttpError(this.name,response.status,await safeText(response));
      const retryAfter=Number(response.headers?.get?.('retry-after'));
      await this.sleep(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:backoff(attempt));
    }
  }
  async getMarketListings(mapping){
    if(!mapping?.providerBlueprintId&&!mapping?.provider_blueprint_id)throw new Error('Blueprint CardTrader mancante');
    const blueprint=String(mapping.providerBlueprintId||mapping.provider_blueprint_id);
    const params=new URLSearchParams({blueprint_id:blueprint});
    const language=locale(mapping.language);if(language)params.set('language',language);
    if(typeof mapping.foil==='boolean')params.set('foil',String(mapping.foil));
    const body=await this.request(`/marketplace/products?${params}`,{marketplace:true});
    const rows=Array.isArray(body)?body:(body[String(blueprint)]||Object.values(body||{}).flat());
    return rows.filter(row=>eligibleListing(row,mapping)).map(normalizeCardTraderListing);
  }
  async getCurrentPrice(mapping){
    const listings=await this.getMarketListings(mapping),priced=listings.filter(row=>Number.isFinite(row.price)&&row.price>=0).sort((a,b)=>a.price-b.price);
    if(!priced.length)return {provider:this.name,status:'unavailable',prices:[],availableQuantity:0,sampleSize:0};
    const currency=priced[0].currency,compatible=priced.filter(row=>row.currency===currency),values=compatible.map(row=>row.price);
    return {provider:this.name,status:'available',currency,availableQuantity:compatible.reduce((sum,row)=>sum+row.quantity,0),sampleSize:compatible.length,
      conditionReference:mapping.conditionReference||mapping.condition_reference||'Near Mint',capturedAt:new Date().toISOString(),
      prices:[{type:'lowest',value:values[0]},{type:'reference',value:median(values)}]};
  }
}

export class CardmarketPriceGuideProvider extends PriceProvider {
  constructor({catalogUrl='',priceGuideUrl='',fetchImpl=globalThis.fetch}={}){
    super({name:'cardmarket',fetchImpl});this.catalogUrl=catalogUrl;this.priceGuideUrl=priceGuideUrl;this.catalog=[];this.prices=new Map();this.sourceUpdatedAt='';
  }
  get available(){return Boolean(this.catalogUrl&&this.priceGuideUrl);}
  getPriceMetadata(){return {provider:this.name,status:this.available?'available':'unavailable',currency:'EUR',frequency:'daily',
    priceTypes:['low','trend','average','avg1','avg7','avg30','foil_low','foil_trend','foil_average','foil_avg1','foil_avg7','foil_avg30']};}
  async load(){
    if(!this.available)throw unavailable('Cardmarket Price Guide','CARDMARKET_PRODUCT_CATALOG_URL / CARDMARKET_PRICE_GUIDE_URL');
    validateOfficialCardmarketUrl(this.catalogUrl);validateOfficialCardmarketUrl(this.priceGuideUrl);
    const nonSinglesUrl=cardmarketNonSinglesUrl(this.catalogUrl);
    const [catalogResponse,priceResponse,nonSinglesResponse]=await Promise.all([this.fetch(this.catalogUrl),this.fetch(this.priceGuideUrl),nonSinglesUrl?this.fetch(nonSinglesUrl):Promise.resolve(null)]);
    if(!catalogResponse.ok)throw new ProviderHttpError(this.name,catalogResponse.status,'Product Catalogue non disponibile');
    if(!priceResponse.ok)throw new ProviderHttpError(this.name,priceResponse.status,'Price Guide non disponibile');
    const [catalogText,priceText,nonSinglesText]=await Promise.all([responseText(catalogResponse),responseText(priceResponse),nonSinglesResponse?.ok?responseText(nonSinglesResponse):Promise.resolve('')]);
    const catalogPayload=parseCardmarketPayload(catalogText,'products'),pricePayload=parseCardmarketPayload(priceText,'priceGuides');
    const nonSingles=parseCardmarketPayload(nonSinglesText,'products').rows,expansions=buildExpansionNames(nonSingles);
    this.catalog=catalogPayload.rows.map(row=>normalizeCardmarketProduct(row,expansions));
    this.prices=new Map(pricePayload.rows.map(row=>[productId(row),row]).filter(([id])=>id));
    this.sourceUpdatedAt=pricePayload.createdAt||priceResponse.headers?.get?.('last-modified')||new Date().toISOString();return {catalogRows:this.catalog.length,priceRows:this.prices.size,expansionRows:expansions.size};
  }
  async resolvePrinting(printing,candidates=this.catalog){return resolveCardmarketPrinting(printing,candidates);}
  async getMarketListings(){return [];}
  async getCurrentPrice(mapping){
    if(!this.prices.size)await this.load();const id=String(mapping.providerProductId||mapping.provider_product_id||'');const row=this.prices.get(id);
    if(!row)return {provider:this.name,status:'unavailable',prices:[],availableQuantity:null,sampleSize:0};
    const definitions={low:['low','Low Price','LOW'],trend:['trend','Trend Price','TREND'],average:['avg','Avg. Sell Price','AVG'],avg1:['avg1','AVG1'],avg7:['avg7','AVG7'],avg30:['avg30','AVG30'],
      foil_low:['low-foil','Foil Low','LOWFOIL'],foil_trend:['trend-foil','Foil Trend','TRENDFOIL'],foil_average:['avg-foil','Foil Sell','SELLFOIL'],foil_avg1:['avg1-foil','Foil AVG1'],foil_avg7:['avg7-foil','Foil AVG7'],foil_avg30:['avg30-foil','Foil AVG30']};
    const prices=[];for(const [type,keys] of Object.entries(definitions)){const value=numberFrom(row,keys);if(value!=null)prices.push({type,value});}
    return {provider:this.name,status:prices.length?'available':'unavailable',currency:'EUR',prices,availableQuantity:null,sampleSize:null,
      conditionReference:'Price Guide Cardmarket',capturedAt:new Date().toISOString(),sourceUpdatedAt:this.sourceUpdatedAt};
  }
}

export class CardmarketApiProvider extends PriceProvider {
  constructor(options={}){super({name:'cardmarket-api',fetchImpl:options.fetchImpl});}
  getPriceMetadata(){return {provider:this.name,status:'future',reason:'Nuovi accessi API Cardmarket non disponibili'};}
  async resolvePrinting(){return {status:'unresolved',confidence:0,candidates:[]};}
  async getCurrentPrice(){return {provider:this.name,status:'unavailable',prices:[]};}
  async getMarketListings(){return [];}
}

export function resolveExactPrinting(printing,candidates,provider){
  const normalized=normalizePrinting(printing),matches=(candidates||[]).filter(candidate=>candidateMatches(normalized,normalizeCandidate(candidate)));
  if(matches.length===1)return {status:'resolved',confidence:1,candidate:matches[0],provider};
  if(matches.length>1)return {status:'ambiguous',confidence:0.5,candidates:matches,provider};
  return {status:'unresolved',confidence:0,candidates:[],provider};
}
export function resolveCardmarketPrinting(printing,candidates){
  const local=normalizePrinting(printing),name=norm(printing.cardName||printing.card_name),expansion=local.expansion;
  if(!name||!expansion)return {status:'unresolved',confidence:0,candidates:[],provider:'cardmarket',reason:'name_or_expansion_missing'};
  const expanded=(candidates||[]).filter(row=>norm(row.cardName||row.name)===name&&norm(row.setName||row.expansion)===expansion);
  const rarityMatches=local.rarity?expanded.filter(row=>norm(row.rarity)===local.rarity):expanded;
  const matches=rarityMatches.length?rarityMatches:expanded;
  if(matches.length===1)return {status:'resolved',confidence:rarityMatches.length ? .98 : .88,candidate:matches[0],provider:'cardmarket',evidence:{catalogCardId:printing.catalogCardId||printing.catalog_card_id,setCode:printing.setCode||printing.set_code,expansion:printing.setName||printing.set_name,rarity:printing.rarity||'',language:printing.language||'',edition:printing.edition||''}};
  if(matches.length>1)return {status:'ambiguous',confidence:.5,candidates:matches,provider:'cardmarket'};
  return {status:'unresolved',confidence:0,candidates:[],provider:'cardmarket'};
}
export function normalizeMappingStatus(value){return RESOLUTION_STATES.has(value)?value:'unresolved';}

function normalizePrinting(row){return {game:norm(row.game),catalogId:norm(row.catalogCardId||row.catalog_card_id),setCode:normCode(row.setCode||row.set_code),
  expansion:norm(row.setName||row.set_name||row.expansion),rarity:norm(row.rarity),language:norm(row.language),edition:norm(row.edition),foil:bool(row.foil)};}
function normalizeCandidate(row){return {game:norm(read(row,['game','gameName','Game'])),catalogId:norm(read(row,['catalog_card_id','catalogCardId','passcode','collector_number','number','Number'])),
  setCode:normCode(read(row,['set_code','setCode','expansion_code','Expansion Code'])),expansion:norm(read(row,['set_name','setName','expansion','expansionName','Expansion Name'])),
  rarity:norm(read(row,['rarity','Rarity'])),language:norm(read(row,['language','Language'])),edition:norm(read(row,['edition','Edition'])),foil:bool(read(row,['foil','Foil']))};}
function candidateMatches(local,candidate){
  if(!local.game||!candidate.game||local.game!==candidate.game)return false;
  if(!local.catalogId||!candidate.catalogId||local.catalogId!==candidate.catalogId)return false;
  if(!local.setCode||!candidate.setCode||local.setCode!==candidate.setCode)return false;
  if(local.expansion&&(!candidate.expansion||local.expansion!==candidate.expansion))return false;
  if(local.rarity&&(!candidate.rarity||local.rarity!==candidate.rarity))return false;
  if(local.language&&(!candidate.language||local.language!==candidate.language))return false;
  if(local.edition&&(!candidate.edition||local.edition!==candidate.edition))return false;
  if(local.foil!=null&&(candidate.foil==null||local.foil!==candidate.foil))return false;
  return true;
}
function eligibleListing(row,mapping){const props=row.properties_hash||row.properties||{};if(row.graded&&String(row.graded)!=='0')return false;if(row.user?.on_vacation||row.user_on_vacation)return false;
  const expected=norm(mapping.conditionReference||mapping.condition_reference);if(expected&&norm(props.condition)!==expected)return false;
  if(typeof mapping.foil==='boolean'){const actual=bool(props.yugioh_foil??props.mtg_foil??props.foil);if(actual!==mapping.foil)return false;}return true;}
function normalizeCardTraderListing(row){const price=row.price||{};return {id:row.id,blueprintId:row.blueprint_id,price:Number(price.cents??row.price_cents)/100,
  currency:String(price.currency||row.price_currency||'EUR').toUpperCase(),quantity:Number(row.quantity||0),properties:row.properties_hash||row.properties||{}};}
function productId(row){return String(read(row,['idProduct','Product ID','product_id','id'])||'');}
export function parseCardmarketPayload(text,key){const value=String(text||'').trim();if(!value)return {rows:[],createdAt:''};if(value[0]==='{'||value[0]==='['){const parsed=JSON.parse(value),rows=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.[key])?parsed[key]:[]);return {rows,createdAt:parsed?.createdAt||''};}return {rows:parseDelimited(value),createdAt:''};}
export function cardmarketNonSinglesUrl(value){try{const url=new URL(value);if(!/products_singles_\d+\.json$/i.test(url.pathname))return'';url.pathname=url.pathname.replace(/products_singles_(\d+)\.json$/i,'products_nonsingles_$1.json');return url.toString();}catch{return'';}}
function buildExpansionNames(rows){const values=new Map();for(const row of rows||[]){const id=String(row.idExpansion||row.expansion_id||'');if(!id)continue;const name=cleanExpansionName(row.name||'');if(!name)continue;const current=values.get(id);if(!current||name.length<current.length)values.set(id,name);}return values;}
function cleanExpansionName(value){return String(value).replace(/\s+(?:Booster(?: Box| Case)?|Display|Case|Pack|Deck|Tin|Box)(?:\s*\([^)]*\))?$/i,'').trim();}
function normalizeCardmarketProduct(row,expansions){const parsed=parseProductName(row.name||'');const id=productId(row),expansionId=String(row.idExpansion||'');return {...row,id,providerProductId:id,provider_product_id:id,game:'yugioh',cardName:parsed.cardName,name:parsed.cardName,rarity:parsed.rarity,setName:expansions.get(expansionId)||'',expansion:expansions.get(expansionId)||'',providerExpansionId:expansionId,provider_expansion_id:expansionId,foil:parsed.foil,productUrl:`https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=${encodeURIComponent(id)}`};}
function parseProductName(value){const raw=String(value).trim(),match=raw.match(/^(.*?)\s*\(V\.\d+\s*-\s*([^()]+)\)\s*$/i),cardName=(match?.[1]||raw).trim(),rarity=(match?.[2]||'').trim();return {cardName,rarity,foil:/foil|rare/i.test(rarity)?true:null};}
function numberFrom(row,keys){const raw=read(row,keys);if(raw==null||raw==='')return null;const value=Number(String(raw).replace(',','.'));return Number.isFinite(value)&&value>=0?value:null;}
function read(row,keys){for(const key of keys)if(row?.[key]!=null&&row[key]!=='')return row[key];return null;}
function norm(value){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/\s+/g,' ');}
function normCode(value){return norm(value).replace(/[^a-z0-9]/g,'');}
function bool(value){if(value==null||value==='')return null;if(typeof value==='boolean')return value;return ['1','true','yes','foil'].includes(norm(value));}
function locale(value){const known={italiano:'it',italian:'it',inglese:'en',english:'en',francese:'fr',french:'fr',tedesco:'de',german:'de',spagnolo:'es',spanish:'es'};return known[norm(value)]||(/^[a-z]{2}$/.test(norm(value))?norm(value):'');}
function median(values){const middle=Math.floor(values.length/2);return values.length%2?values[middle]:(values[middle-1]+values[middle])/2;}
function backoff(attempt){return Math.min(16000,2000*(2**attempt))+Math.floor(Math.random()*250);}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function unavailable(provider,secret){const error=new Error(`${provider} non disponibile: configurare ${secret}`);error.code='provider_unavailable';return error;}
async function safeText(response){try{return (await response.text()).slice(0,500);}catch{return '';}}
function validateOfficialCardmarketUrl(value){const url=new URL(value);if(url.protocol!=='https:'||!(url.hostname==='www.cardmarket.com'||url.hostname==='cardmarket.com'||url.hostname.endsWith('.cardmarket.com')||url.hostname==='downloads.s3.cardmarket.com'))throw new Error('URL Cardmarket non ufficiale rifiutato');}
async function responseText(response){const buffer=await response.arrayBuffer(),encoding=String(response.headers?.get?.('content-encoding')||'').toLowerCase(),type=String(response.headers?.get?.('content-type')||'').toLowerCase(),gzip=encoding.includes('gzip')||type.includes('gzip')||new Uint8Array(buffer).slice(0,2).join(',')==='31,139';if(gzip&&typeof DecompressionStream!=='undefined'){const stream=new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));return new Response(stream).text();}return new TextDecoder().decode(buffer);}
export function parseDelimited(text){const first=String(text).split(/\r?\n/,1)[0]||'',delimiter=(first.match(/;/g)||[]).length>(first.match(/,/g)||[]).length?';':',';const rows=parseCsv(String(text),delimiter);if(!rows.length)return[];const headers=rows.shift().map(value=>value.replace(/^\uFEFF/,''));return rows.filter(row=>row.some(Boolean)).map(row=>Object.fromEntries(headers.map((key,index)=>[key,row[index]??''])));}
function parseCsv(text,delimiter){const rows=[];let row=[],field='',quoted=false;for(let index=0;index<text.length;index++){const char=text[index];if(char==='"'){if(quoted&&text[index+1]==='"'){field+='"';index++;}else quoted=!quoted;}else if(char===delimiter&&!quoted){row.push(field);field='';}else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&text[index+1]==='\n')index++;row.push(field);rows.push(row);row=[];field='';}else field+=char;}if(field||row.length){row.push(field);rows.push(row);}return rows;}

export class ProviderHttpError extends Error {constructor(provider,status,detail=''){super(`${provider}: HTTP ${status}${detail?` — ${detail}`:''}`);this.provider=provider;this.status=status;}}
