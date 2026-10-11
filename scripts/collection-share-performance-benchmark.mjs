import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
globalThis.localStorage={getItem:()=>null,setItem(){}};
globalThis.sessionStorage={getItem:()=>null,setItem(){}};
globalThis.window={addEventListener(){},removeEventListener(){}};
const git='C:/Program Files/Git/cmd/git.exe';
const baseline=execFileSync(git,['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`,'show','HEAD:js/collection-share.js'],{encoding:'utf8'});
const baselineModule=baseline.replace(/from '\.\/([^']+)'/g,(_,file)=>`from '${new URL('../js/'+file,import.meta.url).href}'`);
const {CollectionShareController:Before}=await import('data:text/javascript;base64,'+Buffer.from(baselineModule).toString('base64'));
const {CollectionShareController:After}=await import('../js/collection-share.js');
const items=Array.from({length:5000},(_,i)=>({printingId:String(i),cardName:'Card '+String(5000-i).padStart(4,'0'),setName:'Magnificent Monsters',setCode:'MAMO-EN'+i,alternateNames:['Alias '+i],rarity:'Ultra Rare',quantityOwned:2}));
const queries=['m','ma','mam','mamo','mamo-','alias','alias 1','card','card 0','missing'];
function measure(Controller){
  const c=new Controller({shareId:'bench'});c.data={items};
  const originalLower=String.prototype.toLowerCase,originalCompare=String.prototype.localeCompare;
  let normalized=0,comparisons=0;
  String.prototype.toLowerCase=function(...args){normalized++;return originalLower.apply(this,args);};
  String.prototype.localeCompare=function(...args){comparisons++;return originalCompare.apply(this,args);};
  const start=performance.now(),outputs=[];
  try{for(const query of queries){c.query=query;outputs.push(c.visibleItems().map(row=>row.printingId));}}
  finally{String.prototype.toLowerCase=originalLower;String.prototype.localeCompare=originalCompare;c.dispose();}
  return {normalized,comparisons,elapsedMs:performance.now()-start,outputs};
}
const before=measure(Before),after=measure(After);
assert.deepEqual(after.outputs,before.outputs,'cached sort must preserve every filter result and order');
assert(after.normalized<before.normalized);
assert(after.comparisons<before.comparisons);
delete before.outputs;delete after.outputs;
const result={dataset:items.length,queries:queries.length,before,after,note:'Node synthetic operation counts; timings are not mobile device measurements'};
fs.writeFileSync('docs/audit-snapshots/production-stabilization-2026-10-05/shared-performance.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
