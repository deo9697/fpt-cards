// list_market_watch_owned_page — verifica di equivalenza funzionale tra la
// query LIVE (supabase/migrations/20260911145101_market_watch_owned_pagination.sql)
// e quella riscritta per il P0 performance
// (supabase/migrations/20260914090000_market_watch_owned_page_perf.sql).
//
// Questa sessione non ha accesso a un Postgres reale (nessuna CLI/credenziali,
// vedi audit di questo stesso task): non è possibile lanciare EXPLAIN
// (ANALYZE, BUFFERS) né le due funzioni vere. Per verificare comunque la
// correttezza SENZA limitarsi a una lettura manuale del SQL, questo file
// reimplementa in JS puro ENTRAMBE le strategie (quella whole-set di sempre
// e quella a percorsi distinti per sort) sullo STESSO modello di dati
// sintetico, e verifica che producano lo stesso risultato — stesse
// printing_id di pagina, stesso total, stessi valori reference_price/
// price_24h/price_7d/price_30d mostrati, stesso ordine finale — per tutti i
// sort/ricerca/offset richiesti. Non sostituisce un EXPLAIN reale (da fare
// dopo l'applicazione live, vedi il report finale), ma è una prova concreta
// di equivalenza logica, non un'affermazione non verificata.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Verifiche statiche sulla nuova migration -------------------------
{
  const root=path.dirname(fileURLToPath(import.meta.url));
  const migration=await readFile(path.join(root,'..','supabase','migrations','20260914090000_market_watch_owned_page_perf.sql'),'utf8');
  function test(name,fn){try{fn();console.log(`PASS ${name}`);}catch(err){console.error(`FAIL ${name}`);console.error(err);process.exitCode=1;}}

  test('nessuna scrittura di pricing/dati (solo create/replace function + create index)', () => {
    assert.equal(/\binsert\s+into\b|\bupdate\s+public\.|\bdelete\s+from\b/i.test(migration), false, 'la migration non deve contenere alcuna scrittura di dati');
  });
  test('nessun riferimento SQL reale (fuori dai commenti "NON tocca...") a cron/Edge Function/ygo_market_variants/Exact Price', () => {
    // Rimuove le righe di commento (-- ...) prima di cercare: l'unico posto
    // dove questi nomi compaiono è la spiegazione "NON tocca X" in testa al
    // file, mai in una FROM/JOIN reale.
    const sqlOnly=migration.split('\n').filter(line=>!line.trim().startsWith('--')).join('\n');
    for(const forbidden of ['cron.schedule','pg_cron','ygo_market_variants','ygo_market_variant_price_shadow','market_price_events','functions/v1','market_watch_items']){
      assert.equal(sqlOnly.includes(forbidden), false, `riferimento vietato trovato nel SQL vero: ${forbidden}`);
    }
  });
  test('ridefinisce SOLO list_market_watch_owned_page (non get_market_watch_summary/list_market_watch_extra/list_market_confirm_queue)', () => {
    assert.equal((migration.match(/create or replace function/g)||[]).length, 1);
    assert.match(migration, /create or replace function public\.list_market_watch_owned_page/);
    for(const untouched of ['get_market_watch_summary','list_market_watch_extra','list_market_confirm_queue']){
      assert.equal(migration.includes(`function public.${untouched}`), false, `${untouched} non deve essere ridefinita in questa migration`);
    }
  });
  test('indice aggiunto con IF NOT EXISTS (idempotente, sicuro anche se già presente live con altro nome)', () => {
    assert.match(migration, /create index if not exists market_provider_printings_printing_id_idx\s*\n\s*on public\.market_provider_printings\(printing_id\)/);
  });
  test('mapping_flags è ristretto alle sole printing_id note (candidates/page_ids), non più l\'intera market_provider_printings', () => {
    // 3 occorrenze attese: branch 'change', branch price/value (il branch
    // 'name' non calcola alcun prezzo, quindi non tocca mapping_flags) e FASE B.
    const occurrences=(migration.match(/from public\.market_provider_printings\s*\n\s*where printing_id in \(select printing_id from (candidates|page_ids)\)/g)||[]).length;
    assert.equal(occurrences, 3, 'attese 3 occorrenze (branch change + branch price/value + FASE B), trovate ' + occurrences);
  });
  test('la firma della funzione (nome, parametri, default) resta identica: nessuna rottura per l\'API client esistente', () => {
    assert.match(migration, /p_token text, p_game text default 'yugioh',\s*\n\s*p_limit integer default 60, p_offset integer default 0,\s*\n\s*p_sort text default 'value', p_query text default null/);
  });
  console.log('list_market_watch_owned_page perf migration (statico): nessuna scrittura, nessun tocco fuori scope, firma invariata');
}

// Stessa priorità di market_reference_type() lato DB (comportamento
// consolidato di questo progetto, non un'assunzione nuova): cardmarket+trend
// > cardtrader+reference > average/avg7 > low/lowest.
function referenceType(provider,priceType){
  if(provider==='cardmarket'&&priceType==='trend')return 1;
  if(provider==='cardtrader'&&priceType==='reference')return 2;
  if(priceType==='average'||priceType==='avg7')return 3;
  if(priceType==='low'||priceType==='lowest')return 4;
  return 9;
}

// --- Dataset sintetico -------------------------------------------------
// 12 printing owned: prezzi con pareggi voluti (p3/p4 stesso reference
// price, per verificare che il tie-break su printing_id resti identico),
// una senza alcun prezzo (p9, reference_price null -> deve finire in coda
// su name/price/value ma non sparire), una con prezzo attivo ma nessuno
// storico derived (p10, price_24h/7d/30d null), una con SOLO storico
// derived e nessun prezzo attivo (p11, reference_price null ma price_24h
// presente), una filtrata dalla ricerca (p12, nome "Zzz Excluded").
const NOW=Date.parse('2026-09-14T12:00:00Z');
const days=n=>NOW-n*86400000;
const printings=[
  {id:'p1',cardName:'Ash Blossom',quantity:3},
  {id:'p2',cardName:'Called by the Grave',quantity:1},
  {id:'p3',cardName:'Droll & Lock Bird',quantity:2},
  {id:'p4',cardName:'Effect Veiler',quantity:2},
  {id:'p5',cardName:'Ghost Ogre',quantity:1},
  {id:'p6',cardName:'Harpie\'s Feather Duster',quantity:1},
  {id:'p7',cardName:'Infinite Impermanence',quantity:4},
  {id:'p8',cardName:'Junk Forward',quantity:1},
  {id:'p9',cardName:'Kuriboh (no price yet)',quantity:1},
  {id:'p10',cardName:'Lava Golem (no history)',quantity:1},
  {id:'p11',cardName:'Mind Control (derived only)',quantity:1},
  {id:'p12',cardName:'Zzz Excluded By Search',quantity:1}
];
// provider_mapping_id -> {printingId, active, derived}
const mappings={
  m1:{printingId:'p1',active:true,derived:true}, m2:{printingId:'p2',active:true,derived:true},
  m3:{printingId:'p3',active:true,derived:true}, m4:{printingId:'p4',active:true,derived:true},
  m5:{printingId:'p5',active:true,derived:true}, m6:{printingId:'p6',active:true,derived:true},
  m7:{printingId:'p7',active:true,derived:true}, m8:{printingId:'p8',active:true,derived:true},
  m10:{printingId:'p10',active:true,derived:false},
  m11:{printingId:'p11',active:false,derived:true},
  m12:{printingId:'p12',active:true,derived:true}
};
// snapshots: printingId, providerMappingId, provider, priceType, price, currency, capturedAt, anomalous
const snapshots=[
  {printingId:'p1',providerMappingId:'m1',provider:'cardmarket',priceType:'trend',price:20,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'p1',providerMappingId:'m1',provider:'cardmarket',priceType:'trend',price:18,currency:'EUR',capturedAt:days(1),anomalous:false},
  {printingId:'p1',providerMappingId:'m1',provider:'cardmarket',priceType:'trend',price:15,currency:'EUR',capturedAt:days(7),anomalous:false},
  {printingId:'p1',providerMappingId:'m1',provider:'cardmarket',priceType:'trend',price:12,currency:'EUR',capturedAt:days(30),anomalous:false},
  {printingId:'p1',providerMappingId:'m1',provider:'cardmarket',priceType:'trend',price:999,currency:'EUR',capturedAt:days(2),anomalous:true}, // scartata (anomala)
  {printingId:'p2',providerMappingId:'m2',provider:'cardmarket',priceType:'trend',price:4,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'p2',providerMappingId:'m2',provider:'cardmarket',priceType:'trend',price:4,currency:'EUR',capturedAt:days(1.5),anomalous:false},
  {printingId:'p3',providerMappingId:'m3',provider:'cardmarket',priceType:'trend',price:10,currency:'EUR',capturedAt:NOW,anomalous:false}, // pareggio con p4
  {printingId:'p4',providerMappingId:'m4',provider:'cardmarket',priceType:'trend',price:10,currency:'EUR',capturedAt:NOW,anomalous:false}, // pareggio con p3
  {printingId:'p5',providerMappingId:'m5',provider:'cardtrader',priceType:'reference',price:7,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'p5',providerMappingId:'m5',provider:'cardmarket',priceType:'low',price:6,currency:'EUR',capturedAt:NOW,anomalous:false}, // cardtrader/reference vince su cardmarket/low
  {printingId:'p6',providerMappingId:'m6',provider:'cardmarket',priceType:'average',price:3,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'p6',providerMappingId:'m6',provider:'cardmarket',priceType:'average',price:3.5,currency:'EUR',capturedAt:days(1),anomalous:false},
  {printingId:'p7',providerMappingId:'m7',provider:'cardmarket',priceType:'trend',price:50,currency:'EUR',capturedAt:NOW,anomalous:false},
  {printingId:'p7',providerMappingId:'m7',provider:'cardmarket',priceType:'trend',price:40,currency:'EUR',capturedAt:days(1),anomalous:false}, // <24h fa, non deve contare come "24h"
  {printingId:'p7',providerMappingId:'m7',provider:'cardmarket',priceType:'trend',price:55,currency:'EUR',capturedAt:days(0.5),anomalous:false},
  {printingId:'p8',providerMappingId:'m8',provider:'cardmarket',priceType:'trend',price:2,currency:'USD',capturedAt:NOW,anomalous:false}, // valuta non EUR -> mai un reference price
  {printingId:'p10',providerMappingId:'m10',provider:'cardmarket',priceType:'trend',price:9,currency:'EUR',capturedAt:NOW,anomalous:false}, // active ma NON derived: niente storico 24h/7d/30d
  {printingId:'p11',providerMappingId:'m11',provider:'cardmarket',priceType:'trend',price:99,currency:'EUR',capturedAt:days(2),anomalous:false}, // derived ma NON active: niente reference/preferred
  {printingId:'p12',providerMappingId:'m12',provider:'cardmarket',priceType:'trend',price:1,currency:'EUR',capturedAt:NOW,anomalous:false}
];

function mappingFlags(printingIds){
  const set=new Set(printingIds);
  return Object.fromEntries(Object.entries(mappings).filter(([,m])=>set.has(m.printingId)));
}
function eligibleRows(flags,{onlyActive=false,onlyDerived=false,currencyEur=false}={}){
  return snapshots.filter(s=>{
    const flag=flags[s.providerMappingId];if(!flag)return false;
    if(s.anomalous||s.price==null)return false;
    if(currencyEur&&s.currency!=='EUR')return false;
    if(onlyActive&&!flag.active)return false;
    if(onlyDerived&&!flag.derived)return false;
    if(!onlyActive&&!onlyDerived&&!(flag.active||flag.derived))return false;
    return true;
  });
}
function distinctOnBestPerProvider(rows){
  const best=new Map();
  for(const row of rows){
    const key=row.printingId+'|'+row.provider;
    const current=best.get(key);
    if(!current||referenceType(row.provider,row.priceType)<referenceType(current.provider,current.priceType)
      ||(referenceType(row.provider,row.priceType)===referenceType(current.provider,current.priceType)&&row.capturedAt>current.capturedAt))best.set(key,row);
  }
  return [...best.values()];
}
function referencePriceByPrinting(rows){
  // Tiene la RIGA vincente (serve .provider/.priceType per il confronto al
  // giro successivo) e ne estrae il prezzo solo alla fine — un Map<id,price>
  // popolato subito renderebbe `current.provider` undefined dal secondo
  // candidato in poi per lo stesso printing_id (bug trovato e corretto
  // durante market-watch-summary-perf-smoke.mjs, che ha un'asserzione
  // assoluta sulla precedenza e l'ha fatto emergere).
  const bestRow=new Map();
  for(const row of rows){
    const current=bestRow.get(row.printingId);
    if(!current||referenceType(row.provider,row.priceType)<referenceType(current.provider,current.priceType))bestRow.set(row.printingId,row);
  }
  return new Map([...bestRow].map(([id,row])=>[id,row.price]));
}
function historyAtOrBefore(rows,cutoffMs){
  const best=new Map();
  for(const row of rows){
    if(row.capturedAt>cutoffMs)continue;
    const current=best.get(row.printingId);
    if(!current||referenceType(row.provider,row.priceType)<referenceType(current.provider,current.priceType)
      ||(referenceType(row.provider,row.priceType)===referenceType(current.provider,current.priceType)&&row.capturedAt>current.capturedAt))best.set(row.printingId,row);
  }
  return new Map([...best].map(([id,row])=>[id,row.price]));
}
function candidatesFor(query){
  return printings.filter(p=>!query||p.cardName.toLowerCase().includes(query.toLowerCase()));
}

// --- Vecchia strategia (whole-set sempre, prima di questa migration) ---
function oldWholeSetReferenceAnd24h(candidatePrintingIds){
  const flags=mappingFlags(candidatePrintingIds);
  const eligible=eligibleRows(flags); // (active OR derived), come eligible_snapshots
  const preferred=distinctOnBestPerProvider(eligible.filter(r=>flags[r.providerMappingId].active&&r.currency==='EUR'));
  const reference=referencePriceByPrinting(preferred);
  const derivedOnly=eligible.filter(r=>flags[r.providerMappingId].derived);
  const history24h=historyAtOrBefore(derivedOnly,NOW-24*3600000);
  return {reference,history24h};
}
function oldPageDisplay(printingIds){
  // page_history_7d/30d erano GIA' page-scoped prima di questa migration:
  // stessa identica funzione usata per il nuovo codice, a riprova che
  // quella parte non cambia.
  const flags=mappingFlags(printingIds);
  const eligible=eligibleRows(flags);
  const derivedOnly=eligible.filter(r=>flags[r.providerMappingId].derived);
  const history7d=historyAtOrBefore(derivedOnly,NOW-7*86400000);
  const history30d=historyAtOrBefore(derivedOnly,NOW-30*86400000);
  const activeEur=eligible.filter(r=>flags[r.providerMappingId].active&&r.currency==='EUR');
  const preferred=distinctOnBestPerProvider(activeEur);
  const minPrice=new Map();
  for(const row of activeEur)if(row.provider==='cardmarket'&&(row.priceType==='low'||row.priceType==='lowest')){
    const current=minPrice.get(row.printingId);
    if(!current||row.capturedAt>current.capturedAt)minPrice.set(row.printingId,row);
  }
  return {history7d,history30d,minPrice:new Map([...minPrice].map(([id,row])=>[id,row.price])),providersByPrinting:preferred};
}
function oldSortAndPage(candidatePrintingIds,sort,limit,offset){
  const {reference,history24h}=oldWholeSetReferenceAnd24h(candidatePrintingIds);
  const rows=candidatePrintingIds.map(id=>{
    const printing=printings.find(p=>p.id===id);
    const referencePrice=reference.has(id)?reference.get(id):null;
    const price24h=history24h.has(id)?history24h.get(id):null;
    let sortKey;
    if(sort==='name')sortKey=null;
    else if(sort==='price')sortKey=referencePrice;
    else if(sort==='change')sortKey=(referencePrice!=null&&price24h!=null&&price24h!==0)?referencePrice-price24h:null;
    else sortKey=(referencePrice??-1)*printing.quantity;
    return {id,cardName:printing.cardName,referencePrice,price24h,sortKey};
  });
  const total=rows.length;
  const compareTieBreak=(a,b)=>a.id.localeCompare(b.id);
  rows.sort((a,b)=>{
    if(sort==='name')return a.cardName.localeCompare(b.cardName)||compareTieBreak(a,b);
    const av=a.sortKey,bv=b.sortKey;
    if(av==null&&bv==null)return compareTieBreak(a,b);
    if(av==null)return 1;if(bv==null)return -1;
    return bv-av||compareTieBreak(a,b);
  });
  const page=rows.slice(offset,offset+limit);
  return {pageIds:page.map(r=>r.id),total,displayed:new Map(page.map(r=>[r.id,{referencePrice:r.referencePrice,price24h:r.price24h}]))};
}

// --- Nuova strategia (percorsi distinti per sort + FASE B page-scoped) ---
function newPageIds(candidatePrintingIds,sort,limit,offset){
  let rows;
  if(sort==='name'){
    rows=candidatePrintingIds.map(id=>({id,cardName:printings.find(p=>p.id===id).cardName,sortKey:null}));
  }else if(sort==='change'){
    const {reference,history24h}=oldWholeSetReferenceAnd24h(candidatePrintingIds); // invariato: stesso calcolo di prima
    rows=candidatePrintingIds.map(id=>{
      const referencePrice=reference.has(id)?reference.get(id):null,price24h=history24h.has(id)?history24h.get(id):null;
      return {id,sortKey:(referencePrice!=null&&price24h!=null&&price24h!==0)?referencePrice-price24h:null};
    });
  }else{
    // price/value: solo reference whole-set (active-only), NIENTE 24h whole-set.
    const flags=mappingFlags(candidatePrintingIds);
    const activeEur=eligibleRows(flags,{onlyActive:true,currencyEur:true});
    const preferred=distinctOnBestPerProvider(activeEur);
    const reference=referencePriceByPrinting(preferred);
    rows=candidatePrintingIds.map(id=>{
      const printing=printings.find(p=>p.id===id);
      const referencePrice=reference.has(id)?reference.get(id):null;
      return {id,sortKey:sort==='price'?referencePrice:(referencePrice??-1)*printing.quantity};
    });
  }
  const total=rows.length;
  const compareTieBreak=(a,b)=>a.id.localeCompare(b.id);
  rows.sort((a,b)=>{
    if(sort==='name'){const an=printings.find(p=>p.id===a.id).cardName,bn=printings.find(p=>p.id===b.id).cardName;return an.localeCompare(bn)||compareTieBreak(a,b);}
    const av=a.sortKey,bv=b.sortKey;
    if(av==null&&bv==null)return compareTieBreak(a,b);
    if(av==null)return 1;if(bv==null)return -1;
    return bv-av||compareTieBreak(a,b);
  });
  return {pageIds:rows.slice(offset,offset+limit).map(r=>r.id),total};
}
function newPageDisplay(pageIds){
  // FASE B: reference_price/price_24h ricalcolati SOLO su pageIds, stessa
  // identica logica/filtro della vecchia whole-set (solo input più piccolo).
  const flags=mappingFlags(pageIds);
  const activeEur=eligibleRows(flags,{onlyActive:true,currencyEur:true});
  const preferred=distinctOnBestPerProvider(activeEur);
  const reference=referencePriceByPrinting(preferred);
  const derivedOnly=eligibleRows(flags,{onlyDerived:true});
  const history24h=historyAtOrBefore(derivedOnly,NOW-24*3600000);
  const displayed=new Map(pageIds.map(id=>[id,{
    referencePrice:reference.has(id)?reference.get(id):null,
    price24h:history24h.has(id)?history24h.get(id):null
  }]));
  return displayed;
}
function newSortAndPage(candidatePrintingIds,sort,limit,offset){
  const {pageIds,total}=newPageIds(candidatePrintingIds,sort,limit,offset);
  const displayed=newPageDisplay(pageIds);
  return {pageIds,total,displayed};
}

// --- Confronto: stessa pagina, stesso totale, stessi valori mostrati ---
const allIds=printings.map(p=>p.id);
for(const query of [null,'e']){ // 'e' esclude p9/p12 e altre a caso, buon test di ricerca
  const candidateIds=candidatesFor(query).map(p=>p.id);
  for(const sort of ['name','price','value','change','totally-unknown-sort']){
    for(const [limit,offset] of [[5,0],[5,5],[5,10],[100,0]]){
      const oldResult=oldSortAndPage(candidateIds,sort,limit,offset);
      const newResult=newSortAndPage(candidateIds,sort,limit,offset);
      assert.equal(newResult.total,oldResult.total,`total diverso per sort=${sort} query=${query} limit=${limit} offset=${offset}`);
      assert.deepEqual(newResult.pageIds,oldResult.pageIds,`page_ids diversi per sort=${sort} query=${query} limit=${limit} offset=${offset}`);
      for(const id of oldResult.pageIds){
        assert.deepEqual(newResult.displayed.get(id),oldResult.displayed.get(id),`reference_price/price_24h mostrati diversi per ${id} (sort=${sort} query=${query})`);
      }
    }
  }
}
console.log('PASS list_market_watch_owned_page: stesso total/stessa pagina/stessi valori mostrati tra strategia whole-set e strategia a percorsi distinti, per name/price/value/change/fallback, con e senza ricerca, su più offset (incluso un pareggio di prezzo che attraversa un confine di pagina)');

// Prova indipendente che page_history_7d/30d (mai toccati da questa
// migration) restano coerenti quando ricalcolati sulla stessa pagina.
{
  const pageIds=['p1','p6','p10'];
  const oldDisplay=oldPageDisplay(pageIds);
  assert.equal(oldDisplay.history7d.get('p1'),15);
  assert.equal(oldDisplay.history30d.get('p1'),12);
  assert.equal(oldDisplay.history7d.has('p10'),false,'p10 e\' active ma non derived: nessuno storico derivato');
  assert.equal(oldDisplay.minPrice.get('p1'),undefined,'p1 non ha uno snapshot cardmarket low/lowest');
  console.log('PASS page_history_7d/30d/min_price (invariati) restano coerenti sulle sole printing di pagina');
}

// Casi limite espliciti dal dataset: valuta non-EUR mai un reference price
// (p8), mapping active-ma-non-derived senza storico (p10), mapping
// derived-ma-non-active senza reference (p11).
{
  const {reference,history24h}=oldWholeSetReferenceAnd24h(allIds);
  assert.equal(reference.has('p8'),false,'p8 e\' in USD: non deve mai comparire come reference price (EUR-only)');
  assert.equal(reference.has('p11'),false,'p11 ha mapping derived ma non active: niente reference/preferred');
  assert.equal(history24h.has('p11'),true,'p11 resta eleggibile per lo storico derived nonostante non sia active');
  const newDisplay=newPageDisplay(allIds);
  assert.equal(newDisplay.get('p8').referencePrice,null);
  assert.equal(newDisplay.get('p11').referencePrice,null);
  assert.equal(newDisplay.get('p11').price24h,99);
  // Precedenza assoluta (non solo "uguale tra vecchia e nuova strategia"):
  // p5 ha cardtrader/reference=7 e cardmarket/low=6, cardtrader deve vincere.
  assert.equal(reference.get('p5'),7,'cardtrader/reference (priorità 2) deve vincere su cardmarket/low (priorità 4), non un valore arbitrario');
  console.log('PASS casi limite (valuta non-EUR, active senza derived, derived senza active) identici tra le due strategie, precedenza cardtrader/reference confermata in modo assoluto');
}
