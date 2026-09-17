import assert from 'node:assert/strict';
import {ScanSessionBuffer} from '../js/fast-scan-core.js';
const a={printingId:'a',game:'yugioh',catalogCardId:'1',cardName:'Carta A',setCode:'LOB-IT001',rarity:'Common',imageUrl:'/icon.svg'},b={...a,printingId:'b',cardName:'Carta B',setCode:'LOB-IT002'};
const local=new Map();globalThis.localStorage={getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value),removeItem:key=>local.delete(key)};
globalThis.window={addEventListener(){}};globalThis.document={hidden:false,addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({getContext:()=>({})})};
const {FastScanController}=await import('../js/fast-scan.js');
const {saveScanSession,loadScanSession,clearScanSession}=await import('../js/fast-scan-storage.js');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const controllers=[];
function controller(api={}){const c=new FastScanController({camera:{stream:{},stop(){}},api,paddleOcr:{prepare:async()=>{},dispose:async()=>{}},getCollection:()=>({mine:[],team:[]}),isOnline:()=>true,onRender(){},onRoute(){},onToast(){}});c.phase='scanning';c.schedule=()=>{};controllers.push(c);return c;}
const buffer=new ScanSessionBuffer();buffer.add(a);buffer.add(a);assert.equal(buffer.entries.get('a').quantity,2);
const [first,second]=buffer.scanEvents;buffer.cancelScan(first.id);assert.equal(buffer.entries.get('a').quantity,1);buffer.correctScan(second.id,b);assert.equal(buffer.entries.has('a'),false);assert.equal(buffer.entries.get('b').quantity,1);assert.equal(buffer.scanned,2);
buffer.updateQuantity('b',3);assert.equal(buffer.total,3);assert.equal(buffer.scanned,2,'quantity adjustment is not a camera acquisition');buffer.updateQuantity('b',2);assert.equal(buffer.total,2);
const failed=buffer.createScan();buffer.failScan(failed.id,'NO_TEXT');const pending=buffer.createScan();buffer.queueReview({id:pending.id,code:a.setCode,pending:true,matches:[]});const deferredScan=buffer.createScan();buffer.deferScan(deferredScan.id);
await saveScanSession(buffer.snapshot());const restored=new ScanSessionBuffer(await loadScanSession());assert.equal(restored.total,2);assert.equal(restored.scanned,5);assert.equal(restored.getScan(failed.id).status,'FAILED');assert.equal(restored.getScan(deferredScan.id).status,'DEFERRED');assert.equal(restored.getScan(pending.id).status,'PENDING_REMOTE');
restored.interruptPending();assert.equal(restored.getScan(pending.id).status,'REVIEW_REQUIRED');assert.equal(restored.review.find(row=>row.id===pending.id).pending,false);assert(restored.getScan(pending.id).resolutionVersion>pending.resolutionVersion);
assert(restored.createScan().sequence>Math.max(...buffer.scanEvents.map(scan=>scan.sequence)));assert.equal(JSON.stringify(restored.snapshot()).includes('rawCanvas'),false);
const legacy=new ScanSessionBuffer({entries:[{...a,key:'a',quantity:2,edition:'Prima Edizione'}],review:[{id:'old-pending',code:b.setCode,pending:true}],scanned:4});assert.equal(legacy.total,2);assert.equal(legacy.scanned,4);assert.equal(legacy.getScan('old-pending').status,'PENDING_REMOTE');assert.equal(legacy.entries.get('a').edition,'Prima Edizione');assert(legacy.scanEvents.every(scan=>scan.source==='legacy'));
for(const action of ['cancel','correct','defer']){
 const lookup=deferred(),c=controller({lookupPrintings:async()=>{await lookup.promise;return [a];}});
 await c.resolveCapturedReading({text:a.setCode,confidence:95});const result=c.pendingResolution,scan=c.buffer.scanEvents[0];
 if(action==='cancel')c.buffer.cancelScan(scan.id);if(action==='correct')c.buffer.correctScan(scan.id,b);if(action==='defer')c.buffer.deferScan(scan.id);
 lookup.resolve();await result;
 assert.equal(scan.status,action==='cancel'?'CANCELLED':action==='correct'?'CONFIRMED':'DEFERRED');assert.equal(c.buffer.entries.has('a'),false);assert.equal(c.buffer.total,action==='correct'?1:0);
}
const race=controller();race.buffer.add(a);const editId=race.buffer.scanEvents[0].id,old=deferred();race.resolve=()=>old.promise;const correcting=race.correctReview(editId,b.setCode);race.buffer.correctScan(editId,a);old.resolve({matches:[b]});await correcting;assert.equal(race.buffer.getScan(editId).printingId,'a','older manual correction cannot replace newer one');
const c=controller();c.cacheResolution(a.setCode,[a]);await c.resolveCapturedReading({text:a.setCode,confidence:96});assert.match(c.assistantView(),/Aggiunta alla sessione/);assert.match(c.assistantView(),/Carta A/);assert.match(c.assistantView(),/Common/);assert.match(c.assistantView(),/#1/);
c.requestSnapshot();assert.equal(c.buffer.scanned,2);assert.equal(c.buffer.scanEvents[1].status,'CAPTURED');c.requestSnapshot();assert.equal(c.buffer.scanned,2,'busy press does not duplicate the acquisition');await c.openReview();assert.equal(c.buffer.scanEvents[1].status,'FAILED');assert.equal(c.buffer.scanEvents[1].failureReason,'INTERRUPTED');
const waiting=deferred(),assisted=controller({lookupPrintings:async()=>{await waiting.promise;return[a];}});await assisted.resolveCapturedReading({text:a.setCode,confidence:96});const queued=assisted.pendingResolution;assisted.requestSnapshot();assert.equal(assisted.buffer.scanned,1,'assisted mode blocks advancing past pending');assert.doesNotMatch(assisted.detection.detail,/avanti/i);assert.match(assisted.assistantView(),/Metti da parte/);assisted.buffer.deferScan(assisted.currentScanId);assisted.currentScanId=null;assisted.requestSnapshot();assert.equal(assisted.buffer.scanned,2);waiting.resolve();await queued;assert.equal(assisted.buffer.total,0);
const unknown=controller();await unknown.resolveCapturedReading({text:'bad',confidence:12});assert.equal(unknown.buffer.scanEvents[0].status,'FAILED');assert.equal(unknown.buffer.scanEvents[0].failureReason,'NO_VALID_CODE');assert.match(unknown.historyView(),/Fallito/);
const locked=controller();locked.buffer.add(a);locked.sync={chunks:[{status:'synced'}]};locked.requestSnapshot();assert.equal(locked.buffer.scanned,1,'partial sync prohibits new captures');
await Promise.all([saveScanSession({scanned:1}),saveScanSession({scanned:2}),clearScanSession()]);assert.equal(await loadScanSession(),null,'clear is ordered after earlier saves');
for(const c of controllers){clearTimeout(c.persistTimer);clearTimeout(c.feedbackTimer);clearTimeout(c.timer);}
console.log('PASS scan events: duplicates, single undo/correction, legacy restore, versions, failures, assisted gating, partial-sync lock and ordered persistence.');
