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

export async function loadCachedCatalogIndex(game){
  try{const db=await openDb();return await requestResult(db.transaction(STORE).objectStore(STORE).get(game));}
  catch{return null;}
}

async function saveCachedCatalogIndex(game,record){
  try{const db=await openDb();const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(record,game);await transactionDone(tx);}catch{}
}

// Riparte da lastId (append-only: le printing esistenti cambiano raramente
// rarità/nome dopo la prima verifica) così un refresh ripetuto nella stessa
// sessione o in sessioni successive scarica solo le righe nuove. onRows
// riceve ogni blocco di righe grezze (prima il baseline in cache, poi ogni
// pagina scaricata) così il chiamante può popolare la propria Map subito,
// senza aspettare che tutta la sincronizzazione finisca.
export async function syncCatalogIndex(api,game,{onRows}={}){
  const cached=await loadCachedCatalogIndex(game)||{game,lastId:null,entries:[]};
  let lastId=cached.lastId,entries=cached.entries||[];
  if(entries.length)onRows?.(entries);
  for(;;){
    let rows;
    try{rows=await api.listCatalogPrintingsIndex(game,lastId,PAGE_LIMIT);}
    catch{break;}
    if(!rows?.length)break;
    entries=entries.concat(rows);
    lastId=rows[rows.length-1].printing_id||lastId;
    await saveCachedCatalogIndex(game,{game,lastId,entries});
    onRows?.(rows);
    if(rows.length<PAGE_LIMIT)break;
  }
  return {game,lastId,entries};
}

function openDb(){return new Promise((resolve,reject)=>{if(!globalThis.indexedDB)return reject(new Error('IndexedDB non disponibile'));const request=indexedDB.open(DB_NAME,1);request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function requestResult(request){return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);});}
function transactionDone(tx){return new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
