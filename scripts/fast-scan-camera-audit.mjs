import assert from 'node:assert/strict';
import {FastScanCamera} from '../js/fast-scan-camera.js';
globalThis.document={hidden:false,addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({getContext:()=>({clearRect(){}})})};
globalThis.window={addEventListener(){}};
globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(play=async()=>{},enumerateDevices=async()=>[],timeout=30){
  const track={readyState:'live',stop(){this.readyState='ended';},getSettings:()=>({}),getCapabilities:()=>({})};
  const stream={active:true,getTracks:()=>[track],getVideoTracks:()=>[track]};
  const camera=new FastScanCamera({getUserMedia:async()=>stream,enumerateDevices},timeout,null);
  return {camera,track,stream,video:{play,videoWidth:1280,videoHeight:720,currentTime:1}};
}
const hanging=fixture(()=>new Promise(()=>{}));
await assert.rejects(hanging.camera.start(hanging.video),e=>e.code==='timeout');assert.equal(hanging.track.readyState,'ended');
const slow=deferred(),cancelled=fixture(()=>slow.promise);
const starting=cancelled.camera.start(cancelled.video);const rejection=assert.rejects(starting,e=>e.code==='aborted');
await new Promise(resolve=>setTimeout(resolve,1));cancelled.camera.stop();slow.resolve();await rejection;assert.equal(cancelled.camera.stream,null);assert.equal(cancelled.track.readyState,'ended');
for(const enumerate of [async()=>{throw Error('inventory');},()=>new Promise(()=>{}),undefined]){
 const item=fixture();item.camera.mediaDevices.enumerateDevices=enumerate;
 assert.deepEqual(await item.camera.start(item.video),[]);assert.equal(item.track.readyState,'live');item.camera.stop();
}
for(const name of ['NotFoundError','OverconstrainedError']){
 const item=fixture();const requests=[];item.camera.mediaDevices.getUserMedia=async request=>{requests.push(request);if(requests.length===1)throw Object.assign(Error(),{name});return item.stream;};
 await item.camera.start(item.video,'missing');assert.equal(requests.length,2);assert.equal(requests[0].video.deviceId.exact,'missing');assert.equal(requests[1].video.facingMode.ideal,'environment');item.camera.stop();
}
const failed=fixture(async()=>{throw Error('play');});await assert.rejects(failed.camera.start(failed.video));assert.equal(failed.track.readyState,'ended');
const badSettings=fixture();badSettings.track.getSettings=()=>{throw Error('device disconnected');};await assert.rejects(badSettings.camera.start(badSettings.video));assert.equal(badSettings.track.readyState,'ended');
const configuring=deferred(),older=fixture(),newer=fixture();older.camera.configureTrack=()=>configuring.promise;
const old=older.camera.start(older.video);const oldRejected=assert.rejects(old,e=>e.code==='aborted');await new Promise(resolve=>setTimeout(resolve,1));
older.camera.configureTrack=async()=>{};older.camera.mediaDevices.getUserMedia=async()=>newer.stream;
await older.camera.start(newer.video);configuring.resolve();await oldRejected;assert.equal(older.camera.stream,newer.stream);assert.equal(newer.track.readyState,'live');assert.equal(older.track.readyState,'ended');older.camera.stop();
const noFrame=fixture();noFrame.video.videoWidth=0;await assert.rejects(noFrame.camera.start(noFrame.video),e=>e.code==='timeout');assert.equal(noFrame.track.readyState,'ended');
const neverAvailable=fixture();let attempts=0;neverAvailable.camera.mediaDevices.getUserMedia=async()=>{attempts++;throw Object.assign(Error(),{name:'NotFoundError'});};await assert.rejects(neverAvailable.camera.start(neverAvailable.video,'missing'));assert.equal(attempts,2,'exact fallback happens only once');
const metadata=fixture(),listeners=new Map();metadata.video.videoWidth=0;metadata.video.addEventListener=(name,fn)=>listeners.set(name,fn);metadata.video.removeEventListener=name=>listeners.delete(name);const metadataStart=metadata.camera.start(metadata.video);await new Promise(resolve=>setTimeout(resolve,1));metadata.video.videoWidth=1280;listeners.get('loadeddata')();await metadataStart;assert.equal(listeners.size,0);metadata.camera.stop();
const frozen=fixture();await frozen.camera.start(frozen.video);assert.equal(frozen.camera.healthIssue(frozen.camera.frameProgressAt+4100),'frozen-preview');frozen.video.currentTime=2;assert.equal(frozen.camera.healthIssue(),'');frozen.camera.stop();
const {FastScanController}=await import('../js/fast-scan.js');
for(const transition of ['review','leave','hidden','new-start']){
 const delayed=deferred();const camera={start:()=>delayed.promise,stop(){},markImageCaptureUnstable(){}};
 const c=new FastScanController({camera,paddleOcr:{prepare:async()=>{}},onRender(){},onRoute(){}});c.phase='scanning';c.persist=async()=>{};c.schedule=()=>{throw Error('late schedule');};
 const recovery=c.recoverCamera();
 if(transition==='review')await c.openReview();
 if(transition==='leave'){await c.leave();c.phase='setup';}
 if(transition==='hidden'){document.hidden=true;await c.handleVisibilityChange();}
 if(transition==='new-start'){c.startRequestId++;c.devices=['new'];}
 const phase=c.phase;delayed.resolve(['old']);await recovery;assert.equal(c.phase,phase);assert.notDeepEqual(c.devices,['old']);clearTimeout(c.backgroundStopTimer);document.hidden=false;
}
console.log('PASS camera lifecycle: bounded play/metadata/inventory, cancellation, ownership, exact fallback, frozen preview and stale recovery.');
