// SPDX-License-Identifier: AGPL-3.0-or-later
// Local CPU/memory measurements only. This never contacts production, writes a
// duel, changes the production executor, or keeps a native game between inputs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const reportDirectory=new URL('../artifacts/yugioh-auto/',import.meta.url);
const rounded=value=>Math.round(value*1000)/1000;
const memory=()=>Object.fromEntries(Object.entries(process.memoryUsage()).map(([key,value])=>[`${key}MiB`,rounded(value/1048576)]));
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
async function timed(run){const at=performance.now(),value=await run();return{ms:rounded(performance.now()-at),value};}
const summary=rows=>{const values=rows.map(row=>typeof row==='number'?row:row.ms).sort((a,b)=>a-b);return{count:values.length,minMs:values[0],medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.min(values.length-1,Math.ceil(values.length*.95)-1)],maxMs:values.at(-1),meanMs:rounded(values.reduce((sum,value)=>sum+value,0)/values.length)};};

if(!isMainThread&&workerData?.performanceOnly){
  const boot=performance.now(),before=memory();
  const imported=await timed(()=>import('../api/_yugioh-auto-core.js'));
  const resourceModule=await import('../api/_yugioh-auto-resources.js');
  const loaded=await timed(()=>resourceModule.loadAutoResources());
  parentPort.postMessage({ready:true,initialization:{moduleImportMs:imported.ms,resourceLoadMs:loaded.ms,totalMs:rounded(performance.now()-boot),memoryBefore:before,memoryAfter:memory(),cards:loaded.value.cards.size,scripts:loaded.value.scripts.size}});
  // A benchmark-only warm worker: each request still reconstructs its duel from
  // the complete input JSON. It caches resources, never a required game handle.
  parentPort.on('message',async request=>{const started=performance.now();try{const value=request.operation==='create'?await imported.value.createAutoState(request.payload):await imported.value.applyAutoInput(request.payload.state,request.payload);parentPort.postMessage({id:request.id,ok:true,value,computeMs:rounded(performance.now()-started),memory:memory()});}catch(error){parentPort.postMessage({id:request.id,ok:false,message:error.message,code:error.code});}});
}else if(isMainThread){
  const launched=performance.now(),report={schema:1,kind:'local-server-cpu-benchmark',createdAt:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,cpuCount:os.cpus().length,hostnameOmitted:true},excludes:['network','Vercel cold container startup','authentication','Supabase reads/writes','browser rendering and polling'],inputCount:40};
  const imported=await timed(()=>import('../api/_yugioh-auto-core.js'));
  const resourceModule=await import('../api/_yugioh-auto-resources.js');
  const beforeResources=memory(),loaded=await timed(()=>resourceModule.loadAutoResources());
  const cached=await timed(()=>resourceModule.loadAutoResources());
  const resources=loaded.value;
  report.resources={moduleImportMs:imported.ms,coldLoadMs:loaded.ms,warmCacheMs:cached.ms,version:resources.version,cards:resources.cards.size,scripts:resources.scripts.size,memoryBefore:beforeResources,memoryAfter:memory()};
  report.resourceComponents=[];
  for(const name of ['cards.json.gz','scripts.json.gz']){
    const read=await timed(()=>fs.readFile(new URL(`../api/yugioh-auto-data/${name}`,import.meta.url)));
    const compressedHash=await timed(()=>createHash('sha256').update(read.value).digest('hex'));
    const inflated=await timed(()=>gunzipSync(read.value));
    const decodedHash=await timed(()=>createHash('sha256').update(inflated.value).digest('hex'));
    const text=await timed(()=>inflated.value.toString('utf8'));
    const parsed=await timed(()=>JSON.parse(text.value));
    report.resourceComponents.push({name,compressedBytes:read.value.byteLength,decodedBytes:inflated.value.byteLength,readMs:read.ms,compressedSha256Ms:compressedHash.ms,gunzipMs:inflated.ms,decodedSha256Ms:decodedHash.ms,utf8Ms:text.ms,jsonParseMs:parsed.ms,note:'Component microbenchmark after actual loading; OS filesystem cache is warm. Map construction/validation is included only in the actual resource-load measurement.'});
  }
  const {createAutoState,applyAutoInput,projectAutoState}=imported.value;
  const {runAutoOperation}=await import('../api/_yugioh-auto-executor.js');
  report.productionSourceFingerprints={};for(const name of ['_yugioh-auto-executor.js','_yugioh-auto-worker.js']){const source=await fs.readFile(new URL(`../api/${name}`,import.meta.url));report.productionSourceFingerprints[name]=createHash('sha256').update(source).digest('hex');}
  const packageModule=await import('ocgcore-wasm');
  const {default:createCore,OcgDuelMode:D,OcgLocation:L,OcgPosition:P,OcgProcessResult:PR,OcgCoreInternal}=packageModule;
  const codes=[...resources.cards.values()].filter(card=>[2,3].includes(card.ot)&&card.type===17&&!card.alias&&card.level<=4&&card.attack>0).slice(0,40).map(card=>card.code);
  assert.equal(codes.length,40);
  const savedDeck=seat=>({id:seat?'b1000000-0000-4000-8000-000000000002':'a1000000-0000-4000-8000-000000000001',ownerSlug:`performance-${seat}`,game:'yugioh',name:`Synthetic performance ${seat+1}`,persisted:true,cards:codes.map(code=>({catalogCardId:String(code),cardName:resources.cards.get(code).name,section:'main',quantity:1}))});
  const setup={decks:[savedDeck(0),savedDeck(1)],names:['Synthetic A','Synthetic B'],seed:'b42da86517c39ef0'.repeat(4)};
  report.deck={mainCardsPerSeat:40,uniquePublishedNormalMonsters:codes.length,savedDeckFormat:true};
  async function bootstrap(core){
    const seed=[1n,2n,3n,4n],team={startingLP:8000,startingDrawCount:5,drawCountPerTurn:1},phases={};
    const made=await timed(()=>core.createDuel({flags:D.MODE_MR5|D.TCG_SEGOC_NONPUBLIC|D.TCG_SEGOC_FIRSTTRIGGER,seed,team1:team,team2:team,cardReader:code=>resources.cards.get(code)||null,scriptReader:name=>resources.scripts.get(name)||null,errorHandler:(type,text)=>{if(type===0)throw Error(text);}}));const duel=made.value;assert.ok(duel);phases.createDuelMs=made.ms;
    try{
      phases.baseLuaMs=(await timed(()=>{for(const name of ['constant.lua','utility.lua'])assert.ok(core.loadScript(duel,name,resources.scripts.get(name)));})).ms;
      phases.add80CardsMs=(await timed(()=>{for(const controller of[0,1])for(const code of codes)core.duelNewCard(duel,{code,team:controller,duelist:0,controller,location:L.DECK,sequence:0,position:P.FACEDOWN_DEFENSE});})).ms;
      let processCalls=0;phases.startAndFirstPromptMs=(await timed(()=>{core.startDuel(duel);for(;;){const result=core.duelProcess(duel);core.duelGetMessage(duel);processCalls++;if(result===PR.WAITING)break;assert.notEqual(result,PR.END);assert.ok(processCalls<1000);}})).ms;phases.processCalls=processCalls;
    }finally{phases.destroyMs=(await timed(()=>core.destroyDuel(duel))).ms;}
    phases.retainedWrapperCallbacks=core[OcgCoreInternal].callbacks.size;phases.wasmHeapMiB=rounded(core[OcgCoreInternal].module.HEAPU8.byteLength/1048576);return phases;
  }
  const raw=[];for(let index=0;index<4;index++){const made=await timed(()=>createCore({sync:true,print:()=>{},printErr:()=>{}}));raw.push({wasmInstantiationMs:made.ms,...await bootstrap(made.value)});}
  const reused=(await timed(()=>createCore({sync:true,print:()=>{},printErr:()=>{}}))).value,reuse=[];for(let index=0;index<8;index++)reuse.push(await bootstrap(reused));
  report.rawBootstrap={freshCore:raw,sameCoreSequentialDuels:reuse,note:'The same-core experiment destroys each native duel. Callback-map growth is reported so reuse is not assumed memory-safe.'};
  const createDirect=[];let initial;for(let index=0;index<4;index++){const made=await timed(()=>createAutoState(setup));createDirect.push(made.ms);initial??=made.value;}
  report.directCreate={samplesMs:createDirect,summary:summary(createDirect)};
  const promptOf=state=>state.publicViews[0].auto.prompt||state.publicViews[1].auto.prompt;
  function legalChoice(prompt){
    if(prompt.kind==='idle'){const summon=prompt.options.find(option=>option.action==='summon');return{optionId:summon?.id||prompt.options.find(option=>option.id==='to_ep')?.id};}
    if(prompt.kind==='chain')return{optionId:prompt.options.find(option=>option.id==='pass')?.id||prompt.options[0].id};
    if(prompt.kind==='yes-no')return{optionId:'no'};
    if(['place','select','tribute'].includes(prompt.kind))return{optionIds:prompt.options.slice(0,prompt.min).map(option=>option.id)};
    if(prompt.kind==='position')return{optionId:prompt.options.find(option=>option.id==='position-1')?.id||prompt.options[0].id};
    throw Error(`Unexpected performance-deck prompt: ${prompt.kind}`);
  }
  let current=initial;const snapshots=[],direct=[];
  for(let index=0;index<report.inputCount;index++){
    const prompt=promptOf(current);assert.ok(prompt);const choice=legalChoice(prompt),input={viewer:prompt.player,promptId:prompt.id,choice},payload={state:current,...input};
    const measured=await timed(()=>applyAutoInput(current,input));snapshots.push({payload,expected:measured.value});direct.push({inputSequence:index,kind:prompt.kind,option:choice.optionId||'multiple',ms:measured.ms,stateBytes:bytes(current),publicBytes:bytes(projectAutoState(current,prompt.player)),transcriptBytes:bytes(current.inputs),turn:current.publicViews[0].turn});current=measured.value;
  }
  report.directApply={summary:summary(direct),samples:direct};
  console.log(`Direct ${report.inputCount} valid inputs: median ${report.directApply.summary.medianMs}ms; measuring existing executor.`);
  const executorCreate=[];for(let index=0;index<3;index++)executorCreate.push((await timed(()=>runAutoOperation('create',setup))).ms);
  const executor=[];for(const snapshot of snapshots){const measured=await timed(()=>runAutoOperation('apply',snapshot.payload));assert.deepEqual(measured.value,snapshot.expected,'fresh worker must reproduce the direct result');executor.push({inputSequence:snapshot.payload.state.inputs.length,ms:measured.ms});}
  report.productionExecutor={createSamplesMs:executorCreate,createSummary:summary(executorCreate),applySummary:summary(executor),applySamples:executor};
  console.log(`Existing production executor: median ${report.productionExecutor.applySummary.medianMs}ms; measuring benchmark-only warm worker.`);
  const warmStarted=performance.now(),worker=new Worker(new URL(import.meta.url),{workerData:{performanceOnly:true},resourceLimits:{maxOldGenerationSizeMb:512}});
  let nextId=0;const tasks=new Map();
  const ready=new Promise((resolve,reject)=>{worker.on('message',message=>{if(message.ready){resolve(message);return;}const task=tasks.get(message.id);if(!task)return;tasks.delete(message.id);clearTimeout(task.timer);message.ok?task.resolve(message):task.reject(Error(message.message));});worker.once('error',reject);});
  const workerReady=await ready;report.warmWorkerInitialization={wallMs:rounded(performance.now()-warmStarted),...workerReady.initialization};
  const request=(operation,payload)=>new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{tasks.delete(id);void worker.terminate();reject(Error('Benchmark worker exceeded hard 20s timeout'));},20000);tasks.set(id,{resolve,reject,timer});worker.postMessage({id,operation,payload});});
  const warmCreate=[],warm=[];
  try{
    for(let index=0;index<3;index++)warmCreate.push((await timed(()=>request('create',setup))).ms);
    for(const snapshot of snapshots){const measured=await timed(()=>request('apply',snapshot.payload));assert.deepEqual(measured.value.value,snapshot.expected,'warm-resource worker must reproduce the same persisted replay');warm.push({inputSequence:snapshot.payload.state.inputs.length,ms:measured.ms,computeMs:measured.value.computeMs,heapUsedMiB:measured.value.memory.heapUsedMiB});}
  }finally{await worker.terminate();}
  report.warmResourceWorker={createSamplesMs:warmCreate,createSummary:summary(warmCreate),applySummary:summary(warm),applySamples:warm,note:'Benchmark-only implementation. Same production adapter replay, fresh WASM core on every input, immutable resource cache retained. No required native session in RAM.'};
  const bands=rows=>[0,10,20,30].map(start=>({inputs:`${start}-${start+9}`,...summary(rows.filter(row=>row.inputSequence>=start&&row.inputSequence<start+10))}));
  report.replayGrowth={direct:bands(direct),productionExecutor:bands(executor),warmResourceWorker:bands(warm)};
  report.sizes={initialStateBytes:bytes(initial),finalStateBytes:bytes(current),finalPublicBytes:bytes(projectAutoState(current,0)),finalTranscriptBytes:bytes(current.inputs),finalInputs:current.inputs.length,finalTurn:current.publicViews[0].turn};
  report.finalMemory=memory();report.totalMs=rounded(performance.now()-launched);
  await fs.mkdir(reportDirectory,{recursive:true});await fs.writeFile(new URL('performance-benchmark.json',reportDirectory),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({resourceLoadMs:report.resources.coldLoadMs,resourceCacheMs:report.resources.warmCacheMs,directApply:report.directApply.summary,productionExecutorApply:report.productionExecutor.applySummary,warmResourceWorkerApply:report.warmResourceWorker.applySummary,rawFreshWasm:raw.map(row=>row.wasmInstantiationMs),retainedCallbacks:reuse.map(row=>row.retainedWrapperCallbacks),sizes:report.sizes,totalMs:report.totalMs},null,2));
}
