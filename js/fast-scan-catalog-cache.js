// Fast Scan Step B: cache locale (IndexedDB) dell'indice completo delle
// printing di un gioco — SETCODE -> righe compatte (nessuna immagine), così
// resolveFast() può trattare un hit come genuinamente completo (come il
// session-cache) invece di dover interrogare l'RPC ad ogni set code nuovo
// per la sessione. Stesso pattern raw-IndexedDB di fast-scan-storage.js, in
// un DB/store separato perché qui il payload è l'intero catalogo, non una
// singola sessione di scan.
const DB_NAME='fpt-fast-scan-catalog';
const STORE='index';
const PAGE_LIMIT=1000;
const MAX_SNAPSHOT_AGE=24*60*60*1000;
const activeSyncs=new WeakMap();

export async function loadCachedCatalogIndex(game){
  try{const db=await openDb();try{return await requestResult(db.transaction(STORE).objectStore(STORE).get(game));}finally{db.close();}}
  catch{return null;}
}

async function saveCachedCatalogIndex(game,record){
  try{const db=await openDb();try{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(record,game);await transactionDone(tx);}finally{db.close();}}catch{}
}

// Only completed snapshots are authoritative. Fresh snapshots receive appended
// pages atomically; after 24 hours a full rebuild also picks up edits/deletions.
// Concurrent callers share a single download. onRows receives complete arrays,
// never a partial page that could make a multi-rarity code look unique.
// onRows(entries, complete): `complete` è lo stesso flag già calcolato da
// syncSnapshot (record.complete) — passato attraverso, non ricalcolato.
// Serve a fast-scan.js per esporre cacheState (?debugScan=1): un publish con
// complete=true è un indice interrogabile con certezza di unicità del set
// code, come già documentato sopra ("mai una pagina parziale").
export async function syncCatalogIndex(api,game,{onRows}={}){
  let games=activeSyncs.get(api);if(!games){games=new Map();activeSyncs.set(api,games);}
  let job=games.get(game);
  if(!job){job={listeners:new Set(),snapshot:null};games.set(game,job);job.promise=syncSnapshot(api,game,record=>{job.snapshot=record;for(const listener of job.listeners)listener(record.entries,record.complete);}).finally(()=>games.delete(game));}
  if(onRows){job.listeners.add(onRows);if(job.snapshot)onRows(job.snapshot.entries,job.snapshot.complete);}
  try{return await job.promise;}finally{job.listeners.delete(onRows);}
}

async function syncSnapshot(api,game,publish){
  const stored=await loadCachedCatalogIndex(game);
  // Old records may contain only the first page. Never trust them as complete.
  const fresh=stored?.complete&&Date.now()-stored.refreshedAt<MAX_SNAPSHOT_AGE;
  const cached=fresh?stored:null;
  let lastId=cached?.lastId||null,entries=[...(cached?.entries||[])];
  if(cached)publish(cached);
  let changed=false;
  for(;;){
    let rows;
    try{rows=await api.listCatalogPrintingsIndex(game,lastId,PAGE_LIMIT);}
    catch{return cached||{game,entries:[],lastId:null,complete:false};}
    if(!rows?.length)break;
    const nextId=rows[rows.length-1].printing_id;
    if(!nextId||nextId===lastId)return cached||{game,entries:[],lastId:null,complete:false};
    entries.push(...rows);changed=true;
    lastId=nextId;
    if(rows.length<PAGE_LIMIT)break;
  }
  const record={game,lastId,entries,complete:true,refreshedAt:cached?.refreshedAt||Date.now()};
  // One atomic write and publication per completed sync, not per growing page.
  if(changed||!cached){await saveCachedCatalogIndex(game,record);publish(record);}
  return record;
}

function openDb(){return new Promise((resolve,reject)=>{if(!globalThis.indexedDB)return reject(new Error('IndexedDB non disponibile'));const request=indexedDB.open(DB_NAME,1);request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function requestResult(request){return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);});}
function transactionDone(tx){return new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
