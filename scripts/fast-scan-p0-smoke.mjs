import assert from 'node:assert/strict';
import fs from 'node:fs';
import {aggregateFastScanItems,prepareFastScanSync,markChunk,pendingChunkIndexes} from '../js/fast-scan-sync.js';

const physical=Array.from({length:200},(_,index)=>({
  printingId:`00000000-0000-4000-8000-${String(index%36).padStart(12,'0')}`,
  game:'yugioh',catalogCardId:String(1000+(index%36)),cardName:`Card ${index%36}`,
  setCode:`TEST-IT${String(index%36).padStart(3,'0')}`,rarity:'Common',quantityDelta:1,
  language:'Italiano',condition:'Near Mint',edition:''
}));
const aggregated=aggregateFastScanItems(physical);
assert.equal(aggregated.length,36,'200 scan fisici devono diventare 36 printing distinte');
assert.equal(aggregated.reduce((sum,item)=>sum+item.quantityDelta,0),200);
for(const size of [1,20,50]){
  const fixture=Array.from({length:size},(_,index)=>({...physical[index%physical.length],printingId:`10000000-0000-4000-8000-${String(index).padStart(12,'0')}`,catalogCardId:String(9000+index),setCode:`P0-${String(index).padStart(5,'0')}`}));
  const fixturePlan=prepareFastScanSync(fixture,null,{randomUUID:()=>`00000000-0000-4000-8000-${String(size).padStart(12,'0')}`});
  assert.equal(fixturePlan.totalItems,size);
  assert.equal(fixturePlan.chunks.length,Math.ceil(size/25),`${size} printing non rispettano il chunking 25`);
}

let plan=prepareFastScanSync(physical,null,{randomUUID:()=> '11111111-1111-4111-8111-111111111111'});
assert.equal(plan.chunks.length,2);
assert.ok(plan.chunks.every(chunk=>chunk.items.length<=25));

class IdempotentFixture {
  constructor(){this.results=new Map();this.inventory=new Map();this.locks=new Map();}
  async save(chunk,{loseResponse=false,timeoutBeforeCommit=false}={}){
    const key=chunk.chunkId;
    const previous=this.locks.get(key)||Promise.resolve();
    let release;const current=new Promise(resolve=>{release=resolve;});this.locks.set(key,previous.then(()=>current));
    await previous;
    try{
      if(this.results.has(key))return {...this.results.get(key),idempotentReplay:true};
      if(timeoutBeforeCommit)throw new Error('canceling statement due to statement timeout');
      for(const item of chunk.items)this.inventory.set(item.printingId,(this.inventory.get(item.printingId)||0)+item.quantityDelta);
      const result={savedItems:chunk.items.length,totalQuantity:chunk.items.reduce((sum,item)=>sum+item.quantityDelta,0)};
      this.results.set(key,result);
      if(loseResponse)throw new Error('network response lost after commit');
      return result;
    } finally {release();}
  }
}

const server=new IdempotentFixture();
let first=plan.chunks[0];
plan=markChunk(plan,0,'syncing');
await assert.rejects(server.save(first,{loseResponse:true}),/response lost/);
plan=markChunk(plan,0,'error',null,'response lost');
const restored=prepareFastScanSync(physical,plan);
assert.equal(restored.batchId,plan.batchId,'retry deve conservare scan_batch_id');
const replay=await server.save(restored.chunks[0]);
assert.equal(replay.idempotentReplay,true,'risposta persa deve produrre replay idempotente');
plan=markChunk(restored,0,'synced',replay);
assert.deepEqual(pendingChunkIndexes(plan),[1],'un chunk acknowledged non deve essere reinviato');
const secondResult=await server.save(plan.chunks[1]);
plan=markChunk(plan,1,'synced',secondResult);
assert.equal(plan.status,'synced');
assert.equal([...server.inventory.values()].reduce((sum,value)=>sum+value,0),200,'nessun doppio incremento dopo risposta persa');

const concurrentServer=new IdempotentFixture(),sameChunk=prepareFastScanSync(aggregated.slice(0,20),null,{randomUUID:()=> '22222222-2222-4222-8222-222222222222'}).chunks[0];
const concurrent=await Promise.all([concurrentServer.save(sameChunk),concurrentServer.save(sameChunk)]);
assert.equal(concurrent.filter(result=>result.idempotentReplay).length,1);
assert.equal([...concurrentServer.inventory.values()].reduce((sum,value)=>sum+value,0),sameChunk.items.reduce((sum,item)=>sum+item.quantityDelta,0));

const timeoutServer=new IdempotentFixture();
await assert.rejects(timeoutServer.save(sameChunk,{timeoutBeforeCommit:true}),/statement timeout/);
assert.equal(timeoutServer.inventory.size,0,'timeout prima del commit deve fare rollback completo');
await timeoutServer.save(sameChunk);
assert.ok(timeoutServer.inventory.size>0,'il chunk pending deve essere riprovabile');

const local=new Map();
globalThis.localStorage={getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value),removeItem:key=>local.delete(key)};
const storage=await import('../js/fast-scan-storage.js');
await storage.saveScanSession({entries:aggregated,scanned:200,total:200,sync:plan,updatedAt:new Date().toISOString()});
const recovered=await storage.loadScanSession();
assert.equal(recovered.scanned,200);
assert.equal(recovered.sync.batchId,plan.batchId);
assert.equal(recovered.sync.status,'synced','chiusura/riapertura PWA deve conservare lo stato di sync');

const source=fs.readFileSync(new URL('../js/fast-scan.js',import.meta.url),'utf8');
assert.match(source,/Sincronizzazione interrotta\. I tuoi scan sono salvati sul dispositivo\./);
assert.ok(source.indexOf("stage='acknowledged'")<source.indexOf('await clearScanSession()'),'cleanup locale deve seguire ack definitivo');
assert.match(source,/saveFastScanChunk\(this\.sync\.batchId/);
assert.match(source,/if\(this\.saving\|\|!this\.buffer\.entries\.size\|\|!this\.isOnline\(\)\)return/,'rete assente o doppio tap devono essere bloccati prima della sync');
assert.match(source,/stage='refresh';try\{await this\.onSaved/,'timeout refresh dopo commit non deve retrocedere un batch acknowledged');
assert.match(source,/if\(this\.sync\?\.status==='syncing'\)this\.sync=\{\.\.\.this\.sync,status:'pending'\}/,'refresh durante sync deve rendere il batch riprendibile');
const sql=fs.readFileSync(new URL('../supabase-fast-scan-idempotency-p0.sql',import.meta.url),'utf8');
assert.match(sql,/primary key \(owner_slug,scan_batch_id,chunk_id\)/i);
assert.match(sql,/if chunk_row\.status='completed'/i);
assert.match(sql,/jsonb_array_length\(p_items\) not between 1 and 25/i);
assert.doesNotMatch(sql,/set statement_timeout/i,'il fix non deve alzare il timeout');

console.log('Fast Scan P0 smoke: OK - 200 scan, 36 printing, 2 chunk, retry/lost response/concurrency/rollback verdi.');
