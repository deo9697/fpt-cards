// SPDX-License-Identifier: AGPL-3.0-or-later
import {Worker} from 'node:worker_threads';

const unavailable=()=>Object.assign(new Error('Motore del duello non disponibile. La partita è conservata.'),{status:503,code:'auto_worker'});
const expired=()=>Object.assign(new Error('Il motore non ha risposto in tempo. La mossa non è stata salvata; puoi riprovare.'),{status:503,code:'auto_timeout'});

// Warm workers retain only the checked resource catalogue. Every job still
// reconstructs its duel from the authoritative persisted snapshot. Losing this
// pool, a timeout, another instance or a deploy never loses a game.
export function createAutoWorkerPool({maxWorkers=2,maxJobs=128,idleMs=120000,maxQueue=16,workerFactory=()=>new Worker(new URL('./_yugioh-auto-worker.js',import.meta.url),{resourceLimits:{maxOldGenerationSizeMb:512}})}={}){
  const slots=new Set(),queue=[];let sequence=0,closed=false;
  function settle(job,error,value){
    if(job.done)return;job.done=true;clearTimeout(job.timer);
    error?job.reject(error):job.resolve(value);
  }
  function retire(slot,error){
    if(slot.dead)return;slot.dead=true;clearTimeout(slot.idleTimer);slots.delete(slot);
    const job=slot.job;slot.job=null;
    if(job)settle(job,error||unavailable());
    void Promise.resolve(slot.worker.terminate()).catch(()=>{});
  }
  function makeSlot(){
    const worker=workerFactory(),slot={worker,job:null,jobs:0,dead:false,idleTimer:null};slots.add(slot);
    worker.on('message',message=>{
      if(slot.dead)return;
      const job=slot.job;
      if(!job||message?.id!==job.id){retire(slot,unavailable());drain();return;}
      slot.job=null;slot.jobs++;
      const error=message.ok?null:Object.assign(new Error(message.message||'La scelta non è valida.'),{status:message.status||400,code:message.code||'auto_input'});
      // A failed job never poisons the next request's cached environment.
      if(error||slot.jobs>=maxJobs)retire(slot);
      else{
        worker.unref?.();
        slot.idleTimer=setTimeout(()=>{retire(slot);drain();},idleMs);slot.idleTimer.unref?.();
      }
      settle(job,error,message.value);drain();
    });
    worker.on('error',()=>{retire(slot,unavailable());drain();});
    worker.on('exit',()=>{if(!slot.dead){retire(slot,unavailable());drain();}});
    worker.unref?.();return slot;
  }
  function drain(){
    if(closed)return;
    while(queue.length){
      let slot=[...slots].find(slot=>!slot.job&&!slot.dead);
      if(!slot&&slots.size>=maxWorkers)return;
      const job=queue.shift();if(job.done)continue;
      if(!slot){try{slot=makeSlot();}catch{settle(job,unavailable());continue;}}
      clearTimeout(slot.idleTimer);slot.job=job;job.slot=slot;slot.worker.ref?.();
      try{slot.worker.postMessage({id:job.id,operation:job.operation,payload:job.payload});}
      catch{retire(slot,unavailable());}
    }
  }
  return{
    run(operation,payload,{timeoutMs=20000}={}){
      if(closed)return Promise.reject(unavailable());
      if(queue.length>=maxQueue)return Promise.reject(Object.assign(new Error('Il motore sta elaborando altre mosse. Riprova tra poco.'),{status:503,code:'auto_busy'}));
      const snapshot=structuredClone(payload);
      return new Promise((resolve,reject)=>{
        const job={id:++sequence,operation,payload:snapshot,resolve,reject,done:false,slot:null};
        job.timer=setTimeout(()=>{
          if(job.done)return;
          if(job.slot)retire(job.slot,expired());
          else{const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);settle(job,expired());}
          drain();
        },timeoutMs);
        queue.push(job);drain();
      });
    },
    close(){closed=true;for(const job of queue.splice(0))settle(job,unavailable());for(const slot of [...slots])retire(slot,unavailable());},
  };
}
