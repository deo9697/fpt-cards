import assert from 'node:assert/strict';
import {ScanSessionBuffer} from '../js/fast-scan-core.js';
import {PaddleOcrEngine} from '../js/fast-scan-ocr-engine-b.js';
import {FastScanCamera} from '../js/fast-scan-camera.js';

const local=new Map();
globalThis.window={addEventListener(){}};
globalThis.localStorage={getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value),removeItem:key=>local.delete(key)};
function canvas(width=30,height=10){const node={width,height,dataset:{}};node.getContext=()=>({canvas:node,drawImage(){},fillRect(){},clearRect(){},getImageData:()=>({data:new Uint8ClampedArray(node.width*node.height*4).fill(180)}),putImageData(){}});return node;}
globalThis.document={hidden:false,addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>canvas()};
const {FastScanController}=await import('../js/fast-scan.js');
const controllers=[];
function controller(options={}){
  const value=new FastScanController({camera:{stream:{},sample:()=>({signature:[1],quality:{sharpness:5}}),waitForFreshFrame:async()=>{},captureSnapshot:async()=>({rawCanvas:canvas(),canvas:canvas(),preprocessing:{sharpness:5},release(){}})},paddleOcr:{dispose:async()=>{}},isOnline:()=>true,onRender(){},onToast(){},...options});
  value.phase='scanning';value.refreshHud=()=>{};value.feedback=()=>{};value.snapshotFeedback=async()=>{};value.schedule=()=>{};controllers.push(value);return value;
}
const printing={printingId:'p1',game:'yugioh',catalogCardId:'1',cardName:'Test',setCode:'LOB-IT001',rarity:'Common'};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function scan(value,readings){let calls=0;value.recognizeProduction=async()=>readings[Math.min(calls++,readings.length-1)];value.forceSnapshot=true;await value.scanOnce();return calls;}

const cameraStart=deferred(),ocrStart=deferred();let cameraStarted=false,ocrStarted=false;
const parallel=controller({camera:{start:()=>{cameraStarted=true;return cameraStart.promise;},stop(){}},paddleOcr:{prepare:()=>{ocrStarted=true;return ocrStart.promise;}}});parallel.refreshControls=()=>{};
const starting=parallel.start();assert(cameraStarted&&ocrStarted,'camera and model initialize concurrently');cameraStart.resolve([]);ocrStart.resolve();await starting;assert.equal(parallel.paddleState,'paddle');

const warm=controller();warm.cacheResolution(printing.setCode,[printing]);
assert.equal(await scan(warm,[{text:printing.setCode,confidence:96}]),1);
assert.equal(await scan(warm,[{text:printing.setCode,confidence:96}]),1,'consecutive copies use one inference each');
assert.equal(warm.buffer.total,2);
// Sezione 4 (feedback minimale 2026-09-17): il pop di conferma ora sparisce
// da solo dopo una breve durata (mai bloccante sul prossimo scatto), non più
// tenuto vivo solo dal prossimo scatto — vedi showDetection().
assert.equal(warm.detection.tone,'ok');assert.match(warm.detection.detail,/Salvata/);assert(warm.feedbackTimer,'la conferma deve sparire da sola dopo una breve durata');
assert.match(warm.scannerView(),/live-detection show ok/,'badge survives a full scanner redraw');
const ambiguous=controller();ambiguous.cacheResolution(printing.setCode,[printing,{...printing,printingId:'p2',rarity:'Ultra Rare'}]);
assert.equal(await scan(ambiguous,[{text:printing.setCode,confidence:95}]),1,'rarity ambiguity must not trigger adaptive');
assert.equal(ambiguous.buffer.review[0].matches.length,2);
assert.equal(ambiguous.buffer.total,0);
// Una vera ambiguità (2+ candidati) non usa più il banner transitorio: la
// scelta inline di assistantView() è l'unico feedback, mostrata subito.
assert.equal(ambiguous.detection,null,'una vera ambiguità non mostra il banner transitorio, solo il chooser inline');
assert.match(ambiguous.assistantView(),/Quale carta è\?/);assert.equal(ambiguous.assistantView().match(/data-scan-choice/g)?.length,2);
const weak=controller();weak.cacheResolution(printing.setCode,[printing]);
assert.equal(await scan(weak,[{text:printing.setCode,confidence:40},{text:printing.setCode,confidence:50}]),2);
assert.equal(weak.buffer.total,0,'catalog match cannot auto-add weak OCR');
assert.match(weak.buffer.review[0].warning,/incerta/);
const conflict=controller();conflict.cacheResolution(printing.setCode,[printing]);
await scan(conflict,[{text:'LOB-IT002',confidence:70},{text:printing.setCode,confidence:97}]);
assert.equal(conflict.buffer.total,0,'conflicting valid reads require review');
const unreadable=controller();await scan(unreadable,[{text:'',confidence:0}]);assert.equal(unreadable.detection.tone,'error');assert.match(unreadable.detection.detail,/Riprova questa carta/);assert.equal(unreadable.buffer.scanEvents[0].status,'FAILED');assert.equal(unreadable.buffer.scanEvents[0].failureReason,'NO_TEXT');assert.equal(unreadable.buffer.scanned,1);
unreadable.requestSnapshot();assert.equal(unreadable.detection,null,'accepted next capture clears previous result immediately');
const brokenCapture=controller();brokenCapture.camera.captureSnapshot=async()=>{throw new Error('camera failed');};await scan(brokenCapture,[]);assert.equal(brokenCapture.detection.tone,'error');assert.equal(brokenCapture.buffer.scanEvents[0].status,'FAILED');

let networkCalls=0;const network=deferred();const pending=controller({api:{lookupPrintings:async()=>{networkCalls++;await network.promise;return [printing];}}});
assert.equal(await scan(pending,[{text:printing.setCode,confidence:95}]),1,'cold catalog should not cause another inference');
const first=pending.pendingResolution;
assert.equal(pending.buffer.review[0].pending,true);
assert.equal(pending.detection.tone,'pending');assert.match(pending.detection.detail,/Attendi la verifica/);
assert.equal(JSON.parse(local.get('fpt-fast-scan-active')).review[0].pending,true,'pending persisted before lookup completes');
await scan(pending,[{text:printing.setCode,confidence:95}]);const second=pending.pendingResolution;
assert.equal(pending.buffer.scanned,2,'each manual copy retained');assert.equal(networkCalls,1);
let saveStarted=false;pending.api.saveCollectionBatch=async()=>{saveStarted=true;};await pending.save();assert.equal(saveStarted,false,'save blocked while pending');
network.resolve();await Promise.all([first,second]);assert.equal(pending.buffer.total,2);assert.equal(pending.buffer.scanned,2);assert.equal(networkCalls,1,'second copy reuses resolved identity');
assert.equal(pending.detection.tone,'ok','current pending badge becomes a confirmed badge');

const oldLookup=deferred();const mixed=controller({api:{lookupPrintings:async()=>{await oldLookup.promise;return [printing];}}});
await scan(mixed,[{text:printing.setCode,confidence:95}]);const oldResult=mixed.pendingResolution;
const otherPrinting={...printing,printingId:'other',setCode:'LOB-IT002'};mixed.cacheResolution(otherPrinting.setCode,[otherPrinting]);await scan(mixed,[{text:otherPrinting.setCode,confidence:96}]);
oldLookup.resolve();await oldResult;assert.equal(mixed.detection.code,otherPrinting.setCode,'late result cannot replace the current badge');assert.equal(mixed.backgroundNotice.code,printing.setCode);assert.match(mixed.backgroundNotice.detail,/Scatto precedente/);assert.match(mixed.scannerView(),/data-scan-background-result/);
// Sezione 7 (2026-09-17): zero candidati è un fallimento pulito, non più
// "trattenuto per review senza richiedere una nuova scansione" — l'utente
// deve poter riprovare subito, mai lavorare su una coda per una lettura senza
// alcun candidato reale.
const absent=controller({api:{lookupPrintings:async()=>[]}});await scan(absent,[{text:printing.setCode,confidence:95}]);await absent.pendingResolution;assert.equal(absent.detection.tone,'error');assert.match(absent.detection.detail,/Codice non letto — riprova/,'zero candidati: fallimento pulito, retry immediato');

const late=deferred(),cancelled=controller({api:{lookupPrintings:async()=>{await late.promise;return [printing];}}});
await cancelled.resolveCapturedReading({text:printing.setCode,confidence:96});const lateResult=cancelled.pendingResolution;
cancelled.buffer=new ScanSessionBuffer();late.resolve();await lateResult;assert.equal(cancelled.buffer.total,0,'old session cannot mutate new session');
const ignoredWait=deferred(),ignored=controller({api:{lookupPrintings:async()=>{await ignoredWait.promise;return [printing];}}});
await ignored.resolveCapturedReading({text:printing.setCode,confidence:95});const ignoredResult=ignored.pendingResolution;
ignored.buffer.removeReview(ignored.buffer.review[0].id);ignoredWait.resolve();await ignoredResult;assert.equal(ignored.buffer.total,0,'ignored pending must not reappear');

const {saveScanSession}=await import('../js/fast-scan-storage.js');
await saveScanSession({scanned:1,review:[{id:'interrupted',code:printing.setCode,pending:true}],entries:[]});
const restored=controller();await restored.restore();assert.equal(restored.buffer.review[0].pending,false);assert.match(restored.buffer.review[0].warning,/interrotta/);
const storageFailure=controller();storageFailure.persist=async()=>{throw new Error('quota');};await assert.rejects(()=>storageFailure.resolveCapturedReading({text:printing.setCode,confidence:95}),/quota/);assert.equal(storageFailure.buffer.review[0].pending,false);assert.equal(storageFailure.backgroundQueue.length,0);

let fuzzyAfterTimeout=0;const timeout=controller({api:{lookupPrintings:()=>new Promise(()=>{})},externalLookup:async()=>{fuzzyAfterTimeout++;return [printing];}});timeout.lookupTimeoutMs=5;
await timeout.resolveCapturedReading({text:printing.setCode,confidence:95});await timeout.pendingResolution;assert.equal(timeout.buffer.review[0].pending,false);assert.equal(timeout.buffer.total,0);assert.equal(fuzzyAfterTimeout,0,'timed-out exact lookup must not authorize a correction');

// A real frame callback is required; a frozen video must not be counted twice.
const camera=new FastScanCamera(null);let frameCallback,cancelledFrames=0;camera.video={requestVideoFrameCallback:cb=>{frameCallback=cb;return 1;},cancelVideoFrameCallback(){cancelledFrames++;}};
const fresh=camera.waitForFreshFrame(100);frameCallback();await fresh;assert.equal(cancelledFrames,1);
await assert.rejects(()=>camera.waitForFreshFrame(5),/Fotogramma/);

// Worker timeouts terminate execution and permit a clean subsequent initialization.
let creations=0,terminations=0;
const loader=async()=>({PaddleOCR:{create:async options=>{options.worker.createWorker();creations++;return {predict:()=>creations===1?new Promise(()=>{}):Promise.resolve([{items:[{text:'LOB-IT001',score:.96}],metrics:{detMs:1,recMs:2}}])};}}});
const engine=new PaddleOcrEngine({loader,workerUrl:async()=> 'blob:test',WorkerClass:class{terminate(){terminations++;}},recognizeTimeoutMs:5});
await assert.rejects(()=>engine.recognize(canvas()),/troppo lento/);assert.equal(terminations,1);
assert.equal((await engine.recognize(canvas())).metrics.recMs,2);assert.equal(creations,2);await engine.dispose();assert.equal(terminations,2);
const blocked=deferred();let lateCreations=0;const preparing=new PaddleOcrEngine({loader:()=>blocked.promise,workerUrl:async()=> 'blob:test',prepareTimeoutMs:5});
await assert.rejects(()=>preparing.prepare(),/scaduta/);blocked.resolve({PaddleOCR:{create:async()=>{lateCreations++;return {};}}});await Promise.resolve();await Promise.resolve();assert.equal(lateCreations,0,'late loader cannot resurrect expired preparation');

// IndexedDB fixture: count writes and expose complete snapshots, never individual pages.
const records=new Map();let writes=0,closes=0;
globalThis.indexedDB={open:()=>{const request={};queueMicrotask(()=>{request.result={close(){closes++;},transaction(){const tx={objectStore:()=>({get:key=>{const get={};queueMicrotask(()=>{get.result=structuredClone(records.get(key));get.onsuccess();});return get;},put:(record,key)=>{writes++;records.set(key,structuredClone(record));queueMicrotask(()=>tx.oncomplete());}})};return tx;}};request.onsuccess();});return request;}};
const {syncCatalogIndex}=await import('../js/fast-scan-catalog-cache.js');
const firstPage=Array.from({length:1000},(_,i)=>({printing_id:String(i+1),set_code:i===0?'LOB-IT001':`SET-EN${i}`}));
const pageWait=deferred();let pageCalls=0;const api={listCatalogPrintingsIndex:async(_game,lastId)=>{pageCalls++;if(!lastId)return firstPage;await pageWait.promise;return [{printing_id:'1001',set_code:'LOB-IT001',rarity:'Rare'}];}};
const publications=[];const sync1=syncCatalogIndex(api,'yugioh',{onRows:rows=>publications.push(rows.length)});const sync2=syncCatalogIndex(api,'yugioh');
await new Promise(resolve=>setTimeout(resolve,5));assert.equal(publications.length,0,'first page not authoritative');assert.equal(writes,0);assert.equal(pageCalls,2,'simultaneous syncs share requests');
pageWait.resolve();await Promise.all([sync1,sync2]);assert.deepEqual(publications,[1001]);assert.equal(writes,1);assert(closes>=2);
records.set('yugioh',{...records.get('yugioh'),refreshedAt:1});
const refreshed=await syncCatalogIndex({listCatalogPrintingsIndex:async()=>[{printing_id:'new',set_code:'NEW-EN001'}]},'yugioh');
assert.equal(refreshed.entries.length,1,'expired snapshot rebuilt to remove deleted/changed printings');
records.clear();let failedCalls=0;const failed=await syncCatalogIndex({listCatalogPrintingsIndex:async()=>{if(failedCalls++===0)return firstPage;throw new Error('offline');}},'yugioh');assert.equal(failed.complete,false);assert.equal(records.size,0,'failed partial sync not persisted as complete');

for(const value of controllers){clearTimeout(value.persistTimer);clearTimeout(value.feedbackTimer);}
console.log('PASS OCR capture pipeline: one pass, copies, ambiguity, weak/conflicting reads, durable background lookup, cancellation, recovery, worker timeouts and atomic catalog snapshots');
