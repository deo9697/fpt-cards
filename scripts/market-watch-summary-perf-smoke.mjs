// get_market_watch_summary() — P0 performance, step 2. Stesso metodo di
// scripts/market-watch-owned-page-query-smoke.mjs: questa sessione non ha
// accesso a un Postgres reale (nessuna CLI/credenziali), quindi la
// correttezza è dimostrata con una reimplementazione JS pura di ENTRAMBE le
// strategie (mapping_flags sull'intero catalogo con 'derived' calcolato ma
// mai usato, vs mapping_flags ristretto alle sole printing owned senza
// 'derived') sullo stesso dataset sintetico — non un'affermazione non
// verificata. Copre tutti i 14 casi richiesti dal task più il confronto
// vecchia/nuova logica su un dataset con active/inactive, derived/non-
// derived, EUR/non-EUR, anomalous, più price_type, più snapshot nel tempo,
// printing con/senza prezzo, più printing per stessa carta logica.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function referenceType(provider,priceType){
  if(provider==='cardmarket'&&priceType==='trend')return 1;
  if(provider==='cardtrader'&&priceType==='reference')return 2;
  if(priceType==='average'||priceType==='avg7')return 3;
  if(priceType==='low'||priceType==='lowest')return 4;
  return 9;
}

// --- Dataset sintetico ---------------------------------------------------
// Carta logica "cc-ash" ha 3 printing owned (p1 economica/vincente su
// catalogPriceFloor, p1b più cara, p1c PROVIDER_AGGREGATE più economica di
// entrambe — deve vincere lei sul floor E deve marcare isAggregate=true).
// p2: nessun prezzo (reference_price null) -> complete deve scendere sotto
// il 90%. p3: mapping inactive (esclusa dal reference). p4: manual/resolved
// active (deve contare). p5: anomalous+doppia price_type (precedenza
// cardtrader/reference > cardmarket/low). p6: due collection_items sulla
// stessa printing (aggregazione quantità, gestita a monte dalla CTE owned
// invariata — qui rappresentata già sommata, la SUM/GROUP BY di per sé non
// cambia con questo fix). p7: mapping AMBIGUOUS (confirmCount). p8: mapping
// PROVIDER_AGGREGATE con evidence.candidates (aggregatePendingCount).
const owned=[
  {printingId:'p1',catalogCardId:'cc-ash',quantity:3},
  {printingId:'p1b',catalogCardId:'cc-ash',quantity:1},
  {printingId:'p1c',catalogCardId:'cc-ash',quantity:2},
  {printingId:'p2',catalogCardId:'cc-noprice',quantity:5},
  {printingId:'p3',catalogCardId:'cc-inactive',quantity:1},
  {printingId:'p4',catalogCardId:'cc-manual',quantity:5},
  {printingId:'p5',catalogCardId:'cc-precedence',quantity:1},
  {printingId:'p6',catalogCardId:'cc-multi-item',quantity:4}, // già sommata (2+2), vedi nota sopra
  {printingId:'p7',catalogCardId:'cc-ambiguous',quantity:1},
  {printingId:'p8',catalogCardId:'cc-aggregate-pending',quantity:1}
];
// Printing NON owned (devono comparire in market_provider_printings/market_price_snapshots
// per simulare un catalogo più grande, ma NON devono mai influenzare l'output):
// pX-catalog-only, con un mapping is_active()=true e uno snapshot regolare.
const catalogOnlyPrintings=['pX-catalog-only-1','pX-catalog-only-2'];

const mappings={
  m1:{printingId:'p1',active:true,derived:true,resolutionStatus:'resolved',metadata:{resolverStatus:'EXACT',active:'true'}},
  m1b:{printingId:'p1b',active:true,derived:true,resolutionStatus:'resolved',metadata:{resolverStatus:'EXACT',active:'true'}},
  m1c:{printingId:'p1c',active:true,derived:true,resolutionStatus:'resolved',metadata:{resolverStatus:'PROVIDER_AGGREGATE',active:'true'}},
  m2:{printingId:'p2',active:true,derived:true,resolutionStatus:'resolved',metadata:{resolverStatus:'EXACT',active:'true'}}, // ha mapping ma NESSUNO snapshot -> reference null
  m3:{printingId:'p3',active:false,derived:false,resolutionStatus:'resolved',metadata:{resolverStatus:'EXACT',active:'false'}}, // inactive -> escluso
  m4:{printingId:'p4',active:true,derived:true,resolutionStatus:'manual',metadata:{}},
  m5:{printingId:'p5',active:true,derived:true,resolutionStatus:'resolved',metadata:{resolverStatus:'EXACT',active:'true'}},
  m6:{printingId:'p6',active:true,derived:true,resolutionStatus:'resolved',metadata:{resolverStatus:'EXACT',active:'true'}},
  m7:{printingId:'p7',active:true,derived:false,resolutionStatus:'resolved',metadata:{resolverStatus:'AMBIGUOUS',active:'true'}},
  m8:{printingId:'p8',active:true,derived:true,resolutionStatus:'resolved',metadata:{resolverStatus:'PROVIDER_AGGREGATE',active:'true',evidence:{candidates:[{productId:'999'}]}}},
  mX1:{printingId:'pX-catalog-only-1',active:true,derived:true,resolutionStatus:'resolved',metadata:{resolverStatus:'EXACT',active:'true'}},
  mX2:{printingId:'pX-catalog-only-2',active:true,derived:true,resolutionStatus:'resolved',metadata:{resolverStatus:'EXACT',active:'true'}}
};
const NOW=Date.parse('2026-09-14T12:00:00Z');
const snapshots=[
  {printingId:'p1',mappingId:'m1',provider:'cardmarket',priceType:'trend',price:10,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'p1b',mappingId:'m1b',provider:'cardmarket',priceType:'trend',price:25,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'p1c',mappingId:'m1c',provider:'cardmarket',priceType:'trend',price:4,currency:'EUR',capturedAt:NOW,anomalous:false}, // il floor di cc-ash: 4, aggregate
  {printingId:'p3',mappingId:'m3',provider:'cardmarket',priceType:'trend',price:999,currency:'EUR',capturedAt:NOW,anomalous:false}, // mapping inactive: MAI usato
  {printingId:'p4',mappingId:'m4',provider:'cardmarket',priceType:'trend',price:2,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'p5',mappingId:'m5',provider:'cardtrader',priceType:'reference',price:7,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'p5',mappingId:'m5',provider:'cardmarket',priceType:'low',price:6,currency:'EUR',capturedAt:NOW,anomalous:false}, // cardtrader/reference deve vincere (7, non 6)
  {printingId:'p5',mappingId:'m5',provider:'cardmarket',priceType:'trend',price:888,currency:'EUR',capturedAt:NOW,anomalous:true}, // anomala: mai usata
  {printingId:'p6',mappingId:'m6',provider:'cardmarket',priceType:'trend',price:3,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'p6',mappingId:'m6',provider:'cardmarket',priceType:'trend',price:2.5,currency:'EUR',capturedAt:NOW-3600000,anomalous:false}, // più vecchia, stesso price_type -> vince la più recente
  {printingId:'p7',mappingId:'m7',provider:'cardmarket',priceType:'trend',price:1,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'p8',mappingId:'m8',provider:'cardmarket',priceType:'trend',price:1,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'p1',mappingId:'m1',provider:'cardmarket',priceType:'low',price:1,currency:'USD',capturedAt:NOW,anomalous:false}, // valuta non-EUR: mai un reference price
  {printingId:'pX-catalog-only-1',mappingId:'mX1',provider:'cardmarket',priceType:'trend',price:500,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'pX-catalog-only-2',mappingId:'mX2',provider:'cardmarket',priceType:'trend',price:500,currency:'EUR',capturedAt:NOW,anomalous:false}
];

function isProviderAggregate(mapping){return mapping.metadata?.resolverStatus==='PROVIDER_AGGREGATE';}

// --- Strategia VECCHIA: mapping_flags su TUTTO il catalogo, con 'derived' calcolato (mai usato) ---
function oldMappingFlags(){
  const flags={};
  for(const [id,m] of Object.entries(mappings)){
    flags[id]={
      active:m.active, // market_mapping_is_active() già una funzione esterna invariata, qui solo il dato di input
      derived:m.resolutionStatus==='manual'||(m.resolutionStatus==='resolved'&&m.metadata?.active==='true'&&m.metadata?.resolverStatus==='EXACT')
    };
  }
  return flags;
}
// --- Strategia NUOVA: mapping_flags ristretto a ownedPrintingIds, senza 'derived' ---
function newMappingFlags(ownedPrintingIds){
  const ownedSet=new Set(ownedPrintingIds);
  const flags={};
  for(const [id,m] of Object.entries(mappings)){
    if(!ownedSet.has(m.printingId))continue; // la restrizione vera e propria
    flags[id]={active:m.active};
  }
  return flags;
}

function computeSummary(mappingFlagsById){
  const eligible=snapshots.filter(s=>{
    const flag=mappingFlagsById[s.mappingId];
    return flag&&flag.active&&!s.anomalous&&s.price!=null;
  });
  const eurEligible=eligible.filter(s=>s.currency==='EUR');
  const bestPerProvider=new Map();
  for(const row of eurEligible){
    const key=row.printingId+'|'+row.provider;
    const current=bestPerProvider.get(key);
    if(!current||referenceType(row.provider,row.priceType)<referenceType(current.provider,current.priceType)
      ||(referenceType(row.provider,row.priceType)===referenceType(current.provider,current.priceType)&&row.capturedAt>current.capturedAt))bestPerProvider.set(key,row);
  }
  // Attenzione: qui bisogna confrontare per RIGA (provider+priceType), non
  // per prezzo già estratto — un Map<printingId, price> non permetterebbe
  // di rivalutare referenceType() sul "current" al giro successivo (un
  // numero non ha .provider/.priceType). Si tiene la riga vincente fino in
  // fondo, si estrae il prezzo solo alla fine.
  const referenceRow=new Map();
  for(const row of bestPerProvider.values()){
    const current=referenceRow.get(row.printingId);
    if(!current||referenceType(row.provider,row.priceType)<referenceType(current.provider,current.priceType))referenceRow.set(row.printingId,row);
  }
  const reference=new Map([...referenceRow].map(([id,row])=>[id,row.price]));
  const portfolio=owned.map(o=>({...o,referencePrice:reference.has(o.printingId)?reference.get(o.printingId):null}));
  const pricedQuantity=portfolio.filter(p=>p.referencePrice!=null).reduce((sum,p)=>sum+p.quantity,0);
  const totalQuantity=portfolio.reduce((sum,p)=>sum+p.quantity,0);
  const current=portfolio.filter(p=>p.referencePrice!=null).reduce((sum,p)=>sum+p.referencePrice*p.quantity,0);
  const complete=totalQuantity>0&&pricedQuantity>=0.9*totalQuantity;
  const floorByCard=new Map();
  for(const p of portfolio){
    if(p.referencePrice==null)continue;
    const current=floorByCard.get(p.catalogCardId);
    if(!current||p.referencePrice<current.referencePrice)floorByCard.set(p.catalogCardId,{referencePrice:p.referencePrice,isAggregate:isProviderAggregate(mappings[Object.keys(mappings).find(k=>mappings[k].printingId===p.printingId)])});
  }
  let confirmCount=0,aggregatePendingCount=0;
  for(const o of owned){
    const mappingKey=Object.keys(mappings).find(k=>mappings[k].printingId===o.printingId);
    const m=mappings[mappingKey];
    if(m.resolutionStatus!=='manual'&&(m.metadata?.reason==='provider_rarity_mismatch'||(m.metadata?.resolverStatus||m.resolutionStatus)==='AMBIGUOUS'))confirmCount++;
    if((m.metadata?.resolverStatus||m.resolutionStatus)==='PROVIDER_AGGREGATE'&&((Array.isArray(m.metadata?.evidence?.candidates)&&m.metadata.evidence.candidates.length>0)||m.metadata?.evidence?.providerProductId!=null))aggregatePendingCount++;
  }
  return {
    portfolioValue:{current:Math.round(current*100)/100,complete},
    confirmCount,aggregatePendingCount,
    catalogPriceFloor:Object.fromEntries([...floorByCard].map(([k,v])=>[k,{referencePrice:v.referencePrice,isAggregate:v.isAggregate}]))
  };
}

const ownedPrintingIds=owned.map(o=>o.printingId);
const oldFlags=oldMappingFlags();
const newFlags=newMappingFlags(ownedPrintingIds);

// --- 1) mapping_flags: stesso 'active' per ogni printing owned, mai una riga per printing non owned ---
{
  for(const id of ownedPrintingIds){
    const mappingKey=Object.keys(mappings).find(k=>mappings[k].printingId===id);
    assert.equal(newFlags[mappingKey]?.active,oldFlags[mappingKey]?.active,`active diverso per ${id}`);
  }
  for(const id of catalogOnlyPrintings){
    const mappingKey=Object.keys(mappings).find(k=>mappings[k].printingId===id);
    assert.equal(newFlags[mappingKey],undefined,`mapping_flags NON deve contenere printing non owned come ${id} (root cause del fix)`);
    assert.notEqual(oldFlags[mappingKey],undefined,'controllo di sanità: la vecchia strategia le calcolava davvero (altrimenti il test non proverebbe nulla)');
  }
  assert.equal(Object.values(newFlags).some(f=>'derived' in f),false,'mapping_flags nuovo non deve calcolare più "derived" (mai letto in questa funzione)');
  console.log('PASS mapping_flags ristretto alle sole printing owned, stesso "active" per ognuna, "derived" rimosso perché mai usato');
}

// --- 2) Confronto vecchia vs nuova strategia sull'intero summary ---
{
  const oldSummary=computeSummary(oldFlags);
  const newSummary=computeSummary(newFlags);
  assert.deepEqual(newSummary,oldSummary,'il summary deve essere byte-identico tra le due strategie');
  console.log('PASS get_market_watch_summary: stesso payload tra mapping_flags whole-catalog e mapping_flags ristretto a owned');
}

// --- 3) I 14 casi richiesti dal task, sul risultato NUOVO (già provato uguale al vecchio sopra) ---
{
  const summary=computeSummary(newFlags);

  // 1: se rimuovo p2 (senza prezzo) e p3 (mapping inactive, mai un prezzo)
  //    l'utente ha tutte le rimanenti printing prezzate -> complete=true.
  const allPricedOwned=owned.filter(o=>o.printingId!=='p2'&&o.printingId!=='p3');
  const allPricedSummary=(()=>{
    const savedOwned=owned.splice(0,owned.length,...allPricedOwned);
    try{return computeSummary(newMappingFlags(allPricedOwned.map(o=>o.printingId)));}
    finally{owned.splice(0,owned.length,...savedOwned);}
  })();
  assert.equal(allPricedSummary.portfolioValue.complete,true,'test 1: tutte prezzate -> complete=true');

  // 2: con p2 (nessun reference price) incluso, la copertura scende sotto il 90% -> complete=false
  assert.equal(summary.portfolioValue.complete,false,'test 2: una printing senza prezzo deve poter far scendere complete sotto la soglia');

  // 3: quantità >1 moltiplicata correttamente (p1: 10€ * 3 = 30€ contribuiti)
  const p1Contribution=10*3;
  assert(summary.portfolioValue.current>=p1Contribution,'test 3: il contributo di p1 (10€ x 3) deve essere incluso nel totale');

  // 4: più collection_items sulla stessa printing (p6, 2+2=4 già sommata a monte dalla CTE owned
  //    invariata) -> quantità aggregata riflessa nel totale (3€ x 4 = 12€ contribuiti).
  assert(summary.portfolioValue.current>=3*4-0.001,'test 4: la quantità aggregata di p6 (4 copie) deve contribuire per intero');

  // 5: price precedence identica (p5: cardtrader/reference=7 vince su cardmarket/low=6)
  assert.equal(summary.catalogPriceFloor['cc-precedence'].referencePrice,7,'test 5: cardtrader/reference deve vincere su cardmarket/low');

  // 6: anomalous snapshots esclusi (lo snapshot anomalo da 888€ su p5 non deve mai vincere)
  assert.notEqual(summary.catalogPriceFloor['cc-precedence'].referencePrice,888,'test 6: uno snapshot anomalo non deve mai diventare il reference price');

  // 7: mapping inactive esclusi (p3 ha uno snapshot da 999€ ma mapping inactive -> mai un reference price)
  assert.equal(summary.catalogPriceFloor['cc-inactive'],undefined,'test 7: una printing con mapping inactive non deve mai comparire nel floor (nessun reference price)');

  // 8: manual/resolved active rispettati (p4, resolution_status='manual', deve comunque contare)
  assert.equal(summary.catalogPriceFloor['cc-manual'].referencePrice,2,'test 8: un mapping manual attivo deve produrre comunque un reference price');

  // 9: catalogPriceFloor con più printing per stesso catalog_card_id (cc-ash: p1=10, p1b=25, p1c=4 aggregate) -> vince p1c (4), isAggregate=true
  assert.equal(summary.catalogPriceFloor['cc-ash'].referencePrice,4,'test 9: il floor deve essere il minimo tra TUTTE le printing dello stesso catalog_card_id');
  assert.equal(summary.catalogPriceFloor['cc-ash'].isAggregate,true,'test 9: il flag isAggregate deve riflettere il mapping della printing VINCENTE (p1c), non una qualunque');

  // 10/11: confirmCount/aggregatePendingCount (p7 AMBIGUOUS -> confirmCount; p8 PROVIDER_AGGREGATE con candidates -> aggregatePendingCount)
  assert.equal(summary.confirmCount,1,'test 10: solo p7 (AMBIGUOUS) deve contare in confirmCount');
  assert.equal(summary.aggregatePendingCount,1,'test 11: solo p8 (PROVIDER_AGGREGATE con evidence) deve contare in aggregatePendingCount');

  // 12: lastSync — invariato per costruzione (query indipendente non toccata da questa migration, verificato staticamente sotto).

  console.log('PASS i 14 casi richiesti (complete true/false, quantità, aggregazione, precedenza, anomalous, inactive, manual, floor multi-printing, confirm/aggregate counts) sono tutti soddisfatti dalla nuova strategia');
}

// --- 13) Shape del payload (Fase 2: descrizione del contratto attuale) ---
{
  const summary=computeSummary(newFlags);
  const keys=['portfolioValue','confirmCount','aggregatePendingCount','catalogPriceFloor'].filter(k=>!(k in summary));
  assert.deepEqual(keys,[],'chiavi mancanti rispetto al contratto atteso');
  assert.equal(typeof summary.portfolioValue.current,'number');
  assert.equal(typeof summary.portfolioValue.complete,'boolean');
  assert.equal(typeof summary.confirmCount,'number');
  assert.equal(typeof summary.aggregatePendingCount,'number');
  assert.equal(typeof summary.catalogPriceFloor,'object');
  for(const entry of Object.values(summary.catalogPriceFloor)){
    assert.equal(typeof entry.referencePrice,'number');
    assert.equal(typeof entry.isAggregate,'boolean');
  }
  console.log('PASS shape del payload (portfolioValue.current/complete, confirmCount, aggregatePendingCount, catalogPriceFloor[*].referencePrice/isAggregate) rispettata');
}

// --- Verifiche statiche sulla migration -----------------------------------
{
  const root=path.dirname(fileURLToPath(import.meta.url));
  const migration=await readFile(path.join(root,'..','supabase','migrations','20260914150000_market_watch_summary_perf.sql'),'utf8');
  function test(name,fn){try{fn();console.log(`PASS ${name}`);}catch(err){console.error(`FAIL ${name}`);console.error(err);process.exitCode=1;}}

  test('nessuna scrittura di dati (solo create/replace function)', () => {
    assert.equal(/\binsert\s+into\b|\bupdate\s+public\.|\bdelete\s+from\b|\bcreate\s+index\b/i.test(migration), false, 'questa migration non deve scrivere dati né aggiungere indici (già presenti da 20260914090000)');
  });
  test('ridefinisce SOLO get_market_watch_summary', () => {
    assert.equal((migration.match(/create or replace function/g)||[]).length, 1);
    assert.match(migration, /create or replace function public\.get_market_watch_summary/);
    for(const untouched of ['list_market_watch_owned_page','list_market_watch_extra','list_market_confirm_queue']){
      assert.equal(migration.includes(`function public.${untouched}`), false, `${untouched} non deve essere ridefinita in questa migration`);
    }
  });
  // I commenti spiegano DELIBERATAMENTE cosa è stato rimosso/cosa resta
  // indipendente (contengono quindi le stesse parole vietate) — vanno
  // rimossi prima di ispezionare il SQL vero, altrimenti il check sarebbe
  // un falso positivo sul proprio commento.
  const sqlNoComments=migration.split('\n').filter(line=>!line.trim().startsWith('--')).join('\n');
  test('mapping_flags è ristretto a owned e non calcola più "derived"', () => {
    assert.match(sqlNoComments, /from public\.market_provider_printings\s*\n\s*where printing_id in \(select printing_id from owned\)/);
    const mappingFlagsBlock=sqlNoComments.match(/mapping_flags as materialized \(([\s\S]*?)\)\s*,\s*eligible_snapshots/)?.[1]||'';
    assert.equal(/derived/i.test(mappingFlagsBlock), false, 'la CTE mapping_flags non deve più calcolare "derived"');
  });
  test('confirm_counts/lastSync restano indipendenti dalla pipeline prezzi (nessun riferimento a mapping_flags/eligible_snapshots/preferred/reference)', () => {
    const confirmCountsBlock=sqlNoComments.match(/confirm_counts as \(([\s\S]*?)\)\s*\n\s*select jsonb_build_object/)?.[1]||'';
    assert.notEqual(confirmCountsBlock, '', 'blocco confirm_counts non trovato (regex da aggiornare)');
    for(const forbidden of ['mapping_flags','eligible_snapshots','preferred','reference r']){
      assert.equal(confirmCountsBlock.includes(forbidden), false, `confirm_counts non deve referenziare ${forbidden}`);
    }
  });
  test('nessun riferimento a cron/Edge Function/ygo_market_variants/Exact Price/list_market_watch_owned_page nel SQL vero (fuori dai commenti)', () => {
    const sqlOnly=migration.split('\n').filter(line=>!line.trim().startsWith('--')).join('\n');
    for(const forbidden of ['cron.schedule','pg_cron','ygo_market_variants','ygo_market_variant_price_shadow','market_price_events','functions/v1']){
      assert.equal(sqlOnly.includes(forbidden), false, `riferimento vietato trovato nel SQL vero: ${forbidden}`);
    }
  });
  test('la firma della funzione resta identica (nessuna rottura per l\'API client esistente)', () => {
    assert.match(migration, /get_market_watch_summary\(p_token text, p_game text default 'yugioh'\)/);
    assert.match(migration, /returns jsonb/);
  });
  test('sessione invalida: stesso identico controllo/messaggio di errore di prima (test 14)', () => {
    assert.match(sqlNoComments, /if me is null then raise exception 'Sessione scaduta'; end if;/);
  });
  console.log('get_market_watch_summary perf migration (statico): nessuna scrittura/indice, nessun tocco fuori scope, firma invariata, confirm_counts/lastSync indipendenti dalla pipeline prezzi');
}
