import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CARDMARKET_RESOLUTION_STATES,CARDMARKET_RESOLVER_VERSION,buildCardmarketExpansionHints,cardmarketMappingNeedsResolver,isAuthorizedCardmarketMapping,normalizeMarketRarity,resolveCardmarketPrinting} from '../market/providers.js';

const product=(id,name,expansion,rarity='',providerExpansionId='set-1')=>({providerProductId:String(id),providerExpansionId,cardName:name,setName:expansion,rarity,foil:null});
const printing=(overrides={})=>({game:'yugioh',catalogCardId:'1',cardName:'Test Card',setCode:'TEST-EN001',setName:'Test Set',rarity:'Common',language:'English',edition:'1st Edition',...overrides});
const resolve=(target,candidates,internalPrintings=[target])=>resolveCardmarketPrinting(target,candidates,{internalPrintings});

const shizukuCommon=printing({catalogCardId:'90673288',cardName:'Sky Striker Ace - Shizuku',setCode:'L26D-ENS26',setName:'Legendary Modern Decks 2026',rarity:'Common'});
const shizukuStarlight={...shizukuCommon,rarity:'Starlight Rare'};
const shizukuProduct=product(900,'Sky Striker Ace - Shizuku','Legendary Modern Decks 2026');
assert.equal(resolve(shizukuCommon,[shizukuProduct],[shizukuCommon,shizukuStarlight]).status,CARDMARKET_RESOLUTION_STATES.AMBIGUOUS);
assert.equal(resolve(shizukuStarlight,[shizukuProduct],[shizukuCommon,shizukuStarlight]).status,CARDMARKET_RESOLUTION_STATES.AMBIGUOUS);

const brambleSecret=printing({catalogCardId:'6560411',cardName:'Bramble Rose Dragon',setCode:'DOOD-IT039',setName:'Destino delle Dimensioni',rarity:'Secret Rare',language:'Italiano'});
const brambleStarlight={...brambleSecret,rarity:'Starlight Rare'};
const brambleEnglish={...brambleSecret,setCode:'DOOD-EN039',setName:'Doom of Dimensions',language:'English'};
const brambleProduct=product(901,'Bramble Rose Dragon','Doom of Dimensions');
assert.equal(resolve(brambleSecret,[brambleProduct],[brambleSecret,brambleStarlight,brambleEnglish]).status,CARDMARKET_RESOLUTION_STATES.AMBIGUOUS);
assert.equal(resolve(brambleStarlight,[brambleProduct],[brambleSecret,brambleStarlight,brambleEnglish]).status,CARDMARKET_RESOLUTION_STATES.AMBIGUOUS);

// Rarità etichettata su Cardmarket ma diversa da quella interna (es. printing corretta a mano
// dopo il fatto): il resolver deve restare UNRESOLVED ma offrire comunque il prodotto trovato
// come candidato per la conferma manuale, invece di scartarlo senza lasciare via d'uscita.
const mismatchPrinting=printing({catalogCardId:'60',cardName:'Rarity Mismatch Card',setCode:'RMIS-EN060',setName:'Rarity Mismatch Set',rarity:'Secret Rare'});
const mismatchProduct=product(960,'Rarity Mismatch Card','Rarity Mismatch Set','Starlight Rare');
const mismatchResolution=resolve(mismatchPrinting,[mismatchProduct]);
assert.equal(mismatchResolution.status,CARDMARKET_RESOLUTION_STATES.UNRESOLVED);
assert.equal(mismatchResolution.reason,'provider_rarity_mismatch');
assert.equal(mismatchResolution.evidence.candidates?.length,1,'candidato trovato ma non salvato per la conferma manuale su rarità non corrispondente');
assert.equal(mismatchResolution.evidence.candidates[0].productId,'960');
assert.equal(mismatchResolution.evidence.candidates[0].rarity,'Starlight Rare');

const utopiaRare=printing({catalogCardId:'84124261',cardName:'Number 39: Utopia Roots',setCode:'LVAL-IT048',setName:'Legacy of the Valiant',rarity:'Rare'});
const utopiaUltimate={...utopiaRare,rarity:'Ultimate Rare'};
assert.equal(resolve(utopiaUltimate,[product(902,utopiaUltimate.cardName,utopiaUltimate.setName)],[utopiaRare,utopiaUltimate]).status,CARDMARKET_RESOLUTION_STATES.AMBIGUOUS);

const sea=printing({catalogCardId:'96334243',cardName:'Sea Monster of Theseus',setCode:'MP17-DE231',setName:'2017 Mega-Tin Mega Pack',rarity:'Secret Rare',language:'German'});
const seaResolution=resolve(sea,[product(903,sea.cardName,sea.setName)],[sea]);
assert.equal(seaResolution.status,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE);
assert.deepEqual(seaResolution.priceScope,{language:'aggregate',edition:'aggregate',rarity:'aggregate',foil:'parallel_columns_unassigned'});
assert.equal(seaResolution.evidence.internalCatalogFamilySize,1);
assert.equal(seaResolution.evidence.providerHasSetCode,false);
assert.deepEqual(seaResolution.evidence.identityBasis,['card_name','provider_expansion_id','unique_provider_product_id','internal_set_family']);

const one=printing(),oneProduct=product(904,one.cardName,one.setName);
const deterministic=resolve(one,[oneProduct],[one]);
assert.deepEqual(resolve(one,[oneProduct],[one]),deterministic,'stesso input produce un risultato differente');
const extra=product(905,one.cardName,one.setName);
assert.deepEqual(resolve(one,[extra,oneProduct],[one]),resolve(one,[oneProduct,extra],[one]),'ordine candidati influenza il resolver');
const multiProduct=resolve(one,[extra,oneProduct],[one]);
assert.equal(multiProduct.status,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE);
assert.equal(multiProduct.reason,'multiple_provider_products_aggregate_minimum');
assert.deepEqual(multiProduct.evidence.candidateProductIds,['904','905']);
assert.equal(multiProduct.priceScope.product,'minimum_across_candidates');

const italian=printing({catalogCardId:'2',cardName:'Localized Card',setCode:'LOC-IT001',setName:'Set Italiano',language:'Italiano'});
const english={...italian,setCode:'LOC-EN001',setName:'English Set',language:'English'};
assert.equal(resolve(italian,[product(906,'Localized Card','English Set')],[italian,english]).status,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE);
assert.equal(resolve(printing({rarity:'Ultimate Rare'}),[product(907,'Test Card','Test Set')]).status,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE);
assert.equal(resolve(printing({rarity:'Platinum Secret Rare'}),[product(908,'Test Card','Test Set')]).status,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE);
const encodedExpansion=printing({cardName:'Encoded Card',setName:'Legendary 5D&apos;s Decks',rarity:'Short Print'});
assert.equal(resolve(encodedExpansion,[product(909,'Encoded Card',"Legendary 5D's Decks")]).status,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE,'entità HTML non normalizzata nel nome espansione');
assert.equal(resolve(printing({rarity:'3'}),[oneProduct]).status,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE);
for(const rarity of ['Common','Rare','Super Rare','Ultra Rare','Secret Rare','Ultimate Rare','Starlight Rare','Platinum Secret Rare',"Collector's Rare",'Quarter Century Secret Rare','Starfoil Rare','Short Print','Prismatic Secret Rare','Gold Secret Rare','Gold Rare','Mosaic Rare','Premium Gold Rare','Shatterfoil Rare'])assert(normalizeMarketRarity(rarity),`Rarità supportata non normalizzata: ${rarity}`);
for(const rarity of ['2','3'])assert.equal(normalizeMarketRarity(rarity),'Common');
assert.equal(normalizeMarketRarity('Ghost Rare'),'Ghost Rare');
assert.equal(normalizeMarketRarity('New'),null);
// Rarità reali del catalogo YGOPRODeck che il resolver scartava come UNSUPPORTED prima di
// tentare qualunque match su Cardmarket, escludendo dal Market Watch carte altrimenti valide.
for(const rarity of ['Ghost/Gold Rare','Platinum Rare','Prismatic Ultimate Rare',"Prismatic Collector's Rare",'Extra Secret Rare','20th Secret Rare','Super Short Print','Ultra Short Print','Parallel Rare','Normal Parallel Rare','Super Parallel Rare','Ultra Parallel Rare','Duel Terminal Normal Parallel Rare','Duel Terminal Rare Parallel Rare','Duel Terminal Super Parallel Rare','Duel Terminal Ultra Parallel Rare','Millennium Rare','Millennium Super Rare','Millennium Ultra Rare','Millennium Secret Rare','Millennium Gold Rare','Holographic Rare',"Ultra Rare (Pharaoh's Rare)"])assert(normalizeMarketRarity(rarity),`Rarità reale del catalogo esclusa dal resolver: ${rarity}`);
const parallelRareCard=printing({catalogCardId:'50',cardName:'Parallel Test Card',setCode:'PARA-EN050',setName:'Parallel Test Set',rarity:'Parallel Rare'});
assert.notEqual(resolve(parallelRareCard,[product(950,'Parallel Test Card','Parallel Test Set')]).status,CARDMARKET_RESOLUTION_STATES.UNSUPPORTED,'Parallel Rare ancora scartata come UNSUPPORTED');
const millenniumCard=printing({catalogCardId:'51',cardName:'Millennium Test Card',setCode:'MILL-EN051',setName:'Millennium Test Set',rarity:'Millennium Ultra Rare'});
assert.notEqual(resolve(millenniumCard,[product(951,'Millennium Test Card','Millennium Test Set')]).status,CARDMARKET_RESOLUTION_STATES.UNSUPPORTED,'Millennium Ultra Rare ancora scartata come UNSUPPORTED');

const heroInternal=[
  printing({catalogCardId:'10',cardName:'Elemental HERO Shadow Mist',setCode:'SDHS-EN001',setName:'HERO Strike Structure Deck'}),
  printing({catalogCardId:'11',cardName:'Elemental HERO Ocean',setCode:'SDHS-EN002',setName:'HERO Strike Structure Deck'}),
  printing({catalogCardId:'12',cardName:'Mask Change',setCode:'SDHS-EN021',setName:'HERO Strike Structure Deck'})
];
const heroProducts=[product(920,heroInternal[0].cardName,"Structure Deck: HERO's Strike",'', 'hero-set'),product(921,heroInternal[1].cardName,"Structure Deck: HERO's Strike",'', 'hero-set'),product(922,heroInternal[2].cardName,"Structure Deck: HERO's Strike",'', 'hero-set')];
const heroHints=buildCardmarketExpansionHints(heroInternal,heroProducts);
assert.equal(heroHints.get('SDHS')?.providerExpansionId,'hero-set');
assert.equal(resolveCardmarketPrinting(heroInternal[0],heroProducts,{internalPrintings:heroInternal,expansionHints:heroHints}).status,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE,'alias espansione Structure Deck non risolto dal crosswalk');
assert.equal(resolveCardmarketPrinting(heroInternal[0],[heroProducts[0]],{internalPrintings:heroInternal}).status,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE,'ordine/prefisso Structure Deck non normalizzato deterministicamente');
assert.equal(resolveCardmarketPrinting(printing({cardName:'Blue-Eyes White Dragon',setCode:'SDBE-IT001',setName:'Saga of Blue-Eyes White Dragon Structure Deck',rarity:'Ultra Rare'}),[product(925,'Blue-Eyes White Dragon','Structure Deck: Saga of Blue-Eyes White Dragon')]).status,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE,'alias Saga of Blue-Eyes Structure Deck non normalizzato');
const tiedHints=buildCardmarketExpansionHints(heroInternal,[...heroProducts.slice(0,2),product(923,heroInternal[0].cardName,'Wrong Set','', 'wrong-set'),product(924,heroInternal[1].cardName,'Wrong Set','', 'wrong-set')]);
assert.equal(tiedHints.has('SDHS'),false,'un crosswalk in parità non deve autorizzare un mapping');

const localizedAlias=printing({catalogCardId:'77',cardName:'Giudizio Solenne',setCode:'RA02-EN075',setName:'25th Anniversary Rarity Collection II',rarity:'Ultra Rare'});
const canonicalAlias=printing({catalogCardId:'77',cardName:'Solemn Judgment',setCode:'RA02-EN075',setName:'25th Anniversary Rarity Collection II',rarity:'Ultra Rare'});
assert.equal(resolveCardmarketPrinting(localizedAlias,[product(926,'Solemn Judgment','25th Anniversary Rarity Collection II')],{internalPrintings:[localizedAlias,canonicalAlias]}).status,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE,'alias nome con catalog_card_id identico non risolto');

assert.equal(CARDMARKET_RESOLVER_VERSION,8);
assert(cardmarketMappingNeedsResolver({resolution_status:'unresolved',provider_metadata:{resolverVersion:2}}));
assert(cardmarketMappingNeedsResolver({resolution_status:'unresolved',provider_metadata:{}}));
assert(!cardmarketMappingNeedsResolver({resolution_status:'resolved',provider_metadata:{resolverVersion:CARDMARKET_RESOLVER_VERSION}}));
assert(!cardmarketMappingNeedsResolver({resolution_status:'resolved',provider_metadata:{resolverVersion:2,resolverStatus:'PROVIDER_AGGREGATE'}}));
assert(!cardmarketMappingNeedsResolver({resolution_status:'manual',provider_metadata:{resolverVersion:1}}));
assert(isAuthorizedCardmarketMapping({resolution_status:'resolved',provider_metadata:{resolverStatus:'PROVIDER_AGGREGATE'}}));
assert(!isAuthorizedCardmarketMapping({resolution_status:'resolved',provider_metadata:{}}),'mapping legacy 0.88 ancora autorizzato');
assert(isAuthorizedCardmarketMapping({resolution_status:'manual'}));

const providerSource=fs.readFileSync(new URL('../market/providers.js',import.meta.url),'utf8');
const edgeSource=fs.readFileSync(new URL('../supabase/functions/market-sync/index.ts',import.meta.url),'utf8');
const integritySql=fs.readFileSync(new URL('../supabase-mw1-market-mapping-integrity.sql',import.meta.url),'utf8');
const rollbackSql=fs.readFileSync(new URL('../supabase-mw1-market-mapping-integrity-rollback.sql',import.meta.url),'utf8');
const operationalSql=fs.readFileSync(new URL('../supabase-milestone-5-1-market-watch-operational.sql',import.meta.url),'utf8');
const moversSql=fs.readFileSync(new URL('../supabase-market-dashboard-movers.sql',import.meta.url),'utf8');
const frontendSource=fs.readFileSync(new URL('../js/market-watch.js',import.meta.url),'utf8');
assert(!providerSource.includes("confidence:rarityMatches.length ? .98 : .88"),'fallback 0.88 ancora presente');
for(const required of ['pricesOnly','payload?.scheduled===true','loadPrices','outside_03_europe_rome','x-market-sync-secret','resolution=ignore-duplicates','source_updated_at:value.sourceUpdatedAt','isAuthorizedCardmarketMapping','dryTargetPrintingIds','canaryPrintingIds','canary_requires_full_mode','pricesForTarget'])assert(edgeSource.includes(required),`Contratto Edge v10/MW1 assente: ${required}`);
assert(edgeSource.includes("candidates:candidateDetails}),candidates:providerRarityKnown};"),'Edge function non allineata al fix candidati su rarità non corrispondente');
for(const required of ['pendingResolverLimit:500','cardmarketMappingNeedsResolver','CARDMARKET_RESOLVER_VERSION','resolver_current'])assert(edgeSource.includes(required),`Resolver incrementale schedulato incompleto: ${required}`);
const manualCapMatch=edgeSource.match(/Math\.min\((\d+),Number\(payload\?\.resolverBatchSize\)\|\|(\d+)\)/);
assert(manualCapMatch&&Number(manualCapMatch[1])>=500,'Il tetto manuale del resolver batch on-demand è ancora troppo basso per smaltire un arretrato reale (un utente attivo può aggiungere più di 10-20 carte nuove al giorno, restando bloccato in coda per giorni)');
assert(edgeSource.includes('queryPagination:true'),'La paginazione RPC Edge deve usare limit/offset espliciti');
assert(edgeSource.includes('limit=${pageSize}&offset=${from}'),'Offset RPC PostgREST non applicato');
for(const required of ["rpcPages('market_sync_targets'","restPages('card_printings?",'Range:`${from}-${to}`',"'Range-Unit':'items'",'from<=maxRows','from===maxRows&&page.length','seen.has(normalized)'])assert(edgeSource.includes(required),`Paginazione Edge incompleta: ${required}`);
assert(!/console\.(log|debug|info).*secret/i.test(edgeSource),'possibile log di secret');
assert(!/market_price_snapshots[^\n]*(DELETE|PATCH)/i.test(edgeSource),'lo storico snapshot viene modificato');
assert(integritySql.includes('market_active_price_snapshots')&&integritySql.includes("'EXACT','PROVIDER_AGGREGATE'"),'filtro mapping attivi assente');
assert(integritySql.includes('market_derived_price_snapshots')&&integritySql.includes("resolverStatus'='EXACT"),'filtro prezzi derivati EXACT assente');
assert((integritySql.match(/security_invoker=true/g)||[]).length>=3,'viste MW1 non security_invoker');
for(const role of ['public','anon','authenticated'])assert(integritySql.includes(`from public,anon,authenticated`),`revoche viste MW1 incomplete: ${role}`);
for(const field of ['resolver_status','resolver_version','price_scope','language_scope','edition_scope','rarity_scope','foil_scope','mapping_reason','mapping_evidence'])assert(operationalSql.includes(field),`RPC non espone ${field}`);
for(const required of ['Prezzo Cardmarket aggregato','derivedPriceEligible','market-row-badge aggregate','resolverStatus','priceScope'])assert(frontendSource.includes(required),`Frontend aggregate incompleto: ${required}`);
for(const required of ['provider_rarity_mismatch','hasRarityMismatchCandidates','rarityMismatchNotice','Rarità non corrispondente su Cardmarket'])assert(frontendSource.includes(required),`Conferma manuale su rarità non corrispondente incompleta: ${required}`);
assert(!/delete\s+from\s+(public\.)?market_price_snapshots/i.test(integritySql),'migration MW1 elimina snapshot');
assert(rollbackSql.includes('create or replace view public.market_latest_prices'),'rollback MW1 non ripristina market_latest_prices');
assert(rollbackSql.includes('create or replace function public.list_market_watch'),'rollback MW1 non ripristina list_market_watch');
assert(rollbackSql.includes('drop view if exists public.market_derived_price_snapshots'),'rollback MW1 non rimuove le viste derivate');
assert(!/delete\s+from\s+(public\.)?(market_provider_printings|market_price_snapshots|market_price_events|market_provider_sync_runs)/i.test(rollbackSql),'rollback MW1 elimina dati storici');
assert(!/from market_price_snapshots s/i.test(operationalSql),'query operativa usa snapshot superseded');
assert(moversSql.includes('from market_derived_price_snapshots s'),'dashboard include prezzi aggregate nei mover');
const dryTargetBody=edgeSource.slice(edgeSource.indexOf('async function dryTargetCardmarket'),edgeSource.indexOf('async function resolveCardmarketTargets'));
assert(dryTargetBody.includes('listCardPrintings')&&dryTargetBody.includes('loadCatalog')&&dryTargetBody.includes('loadPrices'),'dry target incompleto');
assert(!/\brpc\(|\brest\(/.test(dryTargetBody),'dry target contiene una scrittura DB');
assert(edgeSource.includes("targets=selectedIds.size?allTargets.filter"),'canary non limita i target prima del resolver');
assert(edgeSource.includes('pendingResolverLimit:resolverBatchSize,skipPrices:true'),'resolver batch non separa mapping e price feed');
assert(edgeSource.includes('cardinfo.php?id=')&&edgeSource.includes('withCanonicalCardNames'),'resolver non recupera il nome canonico tramite catalog_card_id');
const canary=[seaResolution,resolve(shizukuCommon,[shizukuProduct],[shizukuCommon,shizukuStarlight]),resolve(brambleSecret,[brambleProduct],[brambleSecret,brambleStarlight,brambleEnglish]),resolve(printing({rarity:'3'}),[oneProduct]),resolve(printing({cardName:'Missing'}),[])];
assert.deepEqual(canary.map(row=>row.status),['PROVIDER_AGGREGATE','AMBIGUOUS','AMBIGUOUS','PROVIDER_AGGREGATE','UNRESOLVED']);
assert.equal(canary.filter(row=>['EXACT','PROVIDER_AGGREGATE'].includes(row.status)).length,2,'canary non autorizza i mapping deterministici attesi');

let retryCalls=0,retrySleeps=0;
const {CardmarketPriceGuideProvider}=await import('../market/providers.js');
const retryProvider=new CardmarketPriceGuideProvider({
  catalogUrl:'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_3.json',
  priceGuideUrl:'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_3.json',
  sleep:async()=>{retrySleeps++;},
  fetchImpl:async()=>{retryCalls++;return retryCalls===1?new Response('temporaneo',{status:503}):new Response('{}',{status:200});}
});
assert.equal((await retryProvider.request(retryProvider.priceGuideUrl)).status,200);
assert.equal(retryCalls,2,'retry Cardmarket non limitato/idempotente');
assert.equal(retrySleeps,1,'backoff Cardmarket non applicato una sola volta');
const aggregateProvider=new CardmarketPriceGuideProvider();
aggregateProvider.loaded=true;aggregateProvider.sourceUpdatedAt='2026-09-03T00:00:00Z';
aggregateProvider.prices=new Map([['904',{trend:9,low:4}],['905',{trend:6,low:5}]]);
const aggregatePrice=await aggregateProvider.getCurrentPrice({provider_metadata:{candidateProductIds:['904','905']}});
assert.equal(aggregatePrice.prices.find(row=>row.type==='trend').value,6,'il multi-product aggregate non usa il trend minimo');
assert.equal(aggregatePrice.prices.find(row=>row.type==='low').value,4,'il multi-product aggregate non usa il low minimo');
assert.match(aggregatePrice.conditionReference,/minimo tra 2 prodotti/);

const dryRunSource=fs.readFileSync(new URL('./market-watch-mw1-dry-run.mjs',import.meta.url),'utf8');
assert(dryRunSource.includes('loadCatalog(input.targets)'),'dry-run non usa il solo catalogo');
assert(!/supabase|rpc\(|market_price_snapshots|market_provider_printings/i.test(dryRunSource),'dry-run contiene un percorso di scrittura/database');

console.log('PASS MW1 resolver deterministico e fallback 0.88 rimosso');
console.log('PASS MW1 Common/Starlight, Secret/Starlight e ordine candidati protetti');
console.log('PASS MW1 candidato salvato per conferma manuale su rarità non corrispondente');
console.log('PASS MW1 price scope aggregato, rarità supportate e legacy mapping esclusi');
console.log('PASS MW1 rarità reali del catalogo (Parallel/Millennium/Platinum/Prismatic/...) non più scartate come UNSUPPORTED');
console.log('PASS MW1 Edge pricesOnly, cron guard, secret e snapshot idempotenti preservati');
console.log('PASS MW1 retry Cardmarket limitato e dry-run privo di scritture');
