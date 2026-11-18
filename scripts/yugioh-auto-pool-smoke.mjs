// SPDX-License-Identifier: AGPL-3.0-or-later
// Transport lifecycle tests. Native WASM/replay is checked by the engine suites.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createAutoWorkerPool} from '../api/_yugioh-auto-pool.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pools=[];let assertions=0;
const eq=(actual,expected)=>{assertions++;assert.deepEqual(actual,expected);};
function harness(options={}){
  const workers=[],started=[];
  class FakeWorker extends EventEmitter{
    constructor(){super();this.dead=false;workers.push(this);}
    ref(){}unref(){}
    terminate(){this.dead=true;return Promise.resolve(0);}
    postMessage(message){
      if(this.dead)throw Error('Terminated');started.push(message.id);
      setTimeout(()=>{
        if(this.dead)return;
        if(message.operation==='crash'){this.emit('error',Error('Synthetic transport error'));return;}
        if(message.operation==='exit'){this.emit('exit',1);return;}
        const response=message.operation==='reject'?{ok:false,status:409,code:'stale_prompt',message:'Stale'}:{ok:true,value:message.payload};
        this.emit('message',{id:message.operation==='bad-id'?message.id+1:message.id,...response});
      },message.payload?.delay||0);
    }
  }
  const pool=createAutoWorkerPool({idleMs:1000,workerFactory:()=>new FakeWorker(),...options});pools.push(pool);
  return{pool,workers,started};
}
try{
  const warm=harness({maxJobs:2});
  eq(await warm.pool.run('apply',{n:1}),{n:1});eq(await warm.pool.run('apply',{n:2}),{n:2});eq(warm.workers.length,1);eq(warm.workers[0].dead,true);
  eq(await warm.pool.run('apply',{n:3}),{n:3});eq(warm.workers.length,2);
  const parallel=harness({maxWorkers:2});
  const outputs=await Promise.all(Array.from({length:6},(_,n)=>parallel.pool.run('apply',{n,delay:n%2?5:12})));
  eq(outputs.map(output=>output.n),[0,1,2,3,4,5]);eq(parallel.workers.length,2);eq(new Set(parallel.started).size,6);

  const timeout=harness({maxWorkers:1});const payload={n:4,delay:35};
  await assert.rejects(timeout.pool.run('apply',payload,{timeoutMs:5}),error=>error.code==='auto_timeout'&&error.status===503);assertions++;
  eq(payload,{n:4,delay:35});eq(timeout.workers[0].dead,true);eq(await timeout.pool.run('apply',{n:5}),{n:5});eq(timeout.workers.length,2);
  // A completion from the terminated old worker cannot resolve a newer job.
  timeout.workers[0].emit('message',{id:2,ok:true,value:{n:999}});
  eq(await timeout.pool.run('apply',{n:6}),{n:6});

  const queued=harness({maxWorkers:1});
  const original={n:7,delay:20};const active=queued.pool.run('apply',original);original.n=999;
  const expired=assert.rejects(queued.pool.run('apply',{n:8},{timeoutMs:5}),error=>error.code==='auto_timeout');
  const [snapshot]=await Promise.all([active,expired]);eq(snapshot.n,7);eq(queued.started.length,1);
  for(const operation of ['crash','exit','bad-id','reject']){
    const failed=harness();await assert.rejects(failed.pool.run(operation,{}),error=>error.code===(operation==='reject'?'stale_prompt':'auto_worker'));assertions++;
    eq(failed.workers[0].dead,true);eq(await failed.pool.run('apply',{operation}),{operation});eq(failed.workers.length,2);
  }
  const isolated=harness({maxWorkers:2});
  const mixed=await Promise.allSettled([isolated.pool.run('crash',{delay:1}),isolated.pool.run('apply',{n:9,delay:10})]);
  eq(mixed[0].reason.code,'auto_worker');eq(mixed[1].value.n,9);
  const capacity=harness({maxWorkers:1,maxQueue:1});
  const blocked=capacity.pool.run('apply',{delay:100});const pending=capacity.pool.run('apply',{delay:100});
  await assert.rejects(capacity.pool.run('apply',{}),error=>error.code==='auto_busy');assertions++;
  const closed=Promise.allSettled([blocked,pending]);capacity.pool.close();eq((await closed).map(result=>result.reason.code),['auto_worker','auto_worker']);
  await assert.rejects(capacity.pool.run('apply',{}),error=>error.code==='auto_worker');assertions++;
  const idle=harness({idleMs:8});await idle.pool.run('apply',{});await wait(20);eq(idle.workers[0].dead,true);await idle.pool.run('apply',{});eq(idle.workers.length,2);
  console.log(`PASS reusable worker pool: ${assertions} assertions; warm reuse, bounded concurrency, snapshot isolation, deadlines/queue, error/exit/stale-message recovery and recycling.`);
}finally{for(const pool of pools)pool.close();}
