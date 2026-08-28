const DB_NAME='fpt-fast-scan'; const STORE='sessions'; const KEY='active'; const FALLBACK='fpt-fast-scan-active';

export async function loadScanSession() {
  try { const db=await openDb(); return await requestResult(db.transaction(STORE).objectStore(STORE).get(KEY)); }
  catch { try { return JSON.parse(localStorage.getItem(FALLBACK)||'null'); } catch { return null; } }
}

export async function saveScanSession(snapshot) {
  try { const db=await openDb(); const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).put(snapshot,KEY); await transactionDone(tx); }
  catch { localStorage.setItem(FALLBACK,JSON.stringify(snapshot)); }
}

export async function clearScanSession() {
  try { const db=await openDb(); const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).delete(KEY); await transactionDone(tx); }
  catch {} localStorage.removeItem(FALLBACK);
}

function openDb() { return new Promise((resolve,reject)=>{ if(!globalThis.indexedDB)return reject(new Error('IndexedDB non disponibile')); const request=indexedDB.open(DB_NAME,1); request.onupgradeneeded=()=>request.result.createObjectStore(STORE); request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); }); }
function requestResult(request) { return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);}); }
function transactionDone(tx) { return new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);}); }
