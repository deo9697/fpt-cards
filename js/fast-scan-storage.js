const DB_NAME='fpt-fast-scan';
const STORE='sessions';
const KEY='active';
const FALLBACK='fpt-fast-scan-active';
let writes=Promise.resolve();
function serialize(action){const next=writes.then(action);writes=next.catch(()=>{});return next;}

export async function loadScanSession() {
  await writes;
  const candidates=[];
  let db;
  try { db=await openDb(); candidates.push(await requestResult(db.transaction(STORE).objectStore(STORE).get(KEY))); }
  catch {}
  finally { db?.close?.(); }
  try { candidates.push(JSON.parse(localStorage.getItem(FALLBACK)||'null')); }
  catch {}
  return candidates.filter(Boolean).sort((left,right)=>snapshotTime(right)-snapshotTime(left))[0]||null;
}

export function saveScanSession(snapshot) {
  const copy=structuredClone(snapshot);
  return serialize(async()=>{
  const durable={...copy,localSavedAt:new Date().toISOString()};
  let indexedDbError=null;
  let db;
  try { db=await openDb(); const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).put(durable,KEY); await transactionDone(tx); }
  catch (error) { indexedDbError=error; }
  finally { db?.close?.(); }
  try { localStorage.setItem(FALLBACK,JSON.stringify(durable)); }
  catch (error) { if(indexedDbError)throw indexedDbError; }
  return durable;
  });
}

export function clearScanSession() {return serialize(async()=>{
  let db;
  try { db=await openDb(); const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).delete(KEY); await transactionDone(tx); }
  catch {}
  finally { db?.close?.(); }
  try { localStorage.removeItem(FALLBACK); } catch {}
});}

function snapshotTime(value){return Date.parse(value?.localSavedAt||value?.updatedAt||0)||0;}
function openDb() { return new Promise((resolve,reject)=>{ if(!globalThis.indexedDB)return reject(new Error('IndexedDB non disponibile')); const request=indexedDB.open(DB_NAME,1); request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);}; request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); }); }
function requestResult(request) { return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);}); }
function transactionDone(tx) { return new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);}); }
