const DB_NAME='fpt-fast-scan';
const STORE='sessions';
const KEY='active';
const FALLBACK='fpt-fast-scan-active';

export async function loadScanSession() {
  const candidates=[];
  try { const db=await openDb(); candidates.push(await requestResult(db.transaction(STORE).objectStore(STORE).get(KEY))); }
  catch {}
  try { candidates.push(JSON.parse(localStorage.getItem(FALLBACK)||'null')); }
  catch {}
  return candidates.filter(Boolean).sort((left,right)=>snapshotTime(right)-snapshotTime(left))[0]||null;
}

export async function saveScanSession(snapshot) {
  const durable={...snapshot,localSavedAt:new Date().toISOString()};
  let indexedDbError=null;
  try { const db=await openDb(); const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).put(durable,KEY); await transactionDone(tx); }
  catch (error) { indexedDbError=error; }
  try { localStorage.setItem(FALLBACK,JSON.stringify(durable)); }
  catch (error) { if(indexedDbError)throw indexedDbError; throw error; }
  return durable;
}

export async function clearScanSession() {
  try { const db=await openDb(); const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).delete(KEY); await transactionDone(tx); }
  catch {}
  try { localStorage.removeItem(FALLBACK); } catch {}
}

function snapshotTime(value){return Date.parse(value?.localSavedAt||value?.updatedAt||0)||0;}
function openDb() { return new Promise((resolve,reject)=>{ if(!globalThis.indexedDB)return reject(new Error('IndexedDB non disponibile')); const request=indexedDB.open(DB_NAME,1); request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);}; request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); }); }
function requestResult(request) { return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);}); }
function transactionDone(tx) { return new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);}); }
