import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyScanDiagnostic, normalizeSetCode, setCodeCandidates } from '../js/fast-scan-core.js';
globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
globalThis.window={addEventListener(){}};
globalThis.document={addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];}};
const { FastScanController } = await import('../js/fast-scan.js');

const rows=[];
const controller=new FastScanController({api:{lookupPrintings:async code=>rows.filter(row=>row.set_code===code)},camera:{},ocr:{},getCollection:()=>({mine:[],team:[]}),isOnline:()=>true});
// Confidence values are explicit test inputs, not measured camera accuracy.
const before=await controller.resolve('MAMO-EN013',92,{consensus:2,exactOnly:true});
assert.equal(before.classification,'CATALOG_MISSING');
rows.push({id:'fixture-13',game:'yugioh',catalog_card_id:'75787708',card_name:'Fixture',set_code:'MAMO-EN013',rarity:'Ultra Rare'});
const after=await controller.resolve('MAMO-EN013',92,{consensus:2,exactOnly:true});
assert.equal(after.classification,'EXACT');
assert.equal(classifyScanDiagnostic({raw:'MAMO-EN013',result:before,ocrConfidence:30}),'UNRESOLVED');
assert.equal(classifyScanDiagnostic({raw:'MAMO-EN013',result:{lookupComplete:false},ocrConfidence:99}),'UNRESOLVED');
assert.equal(classifyScanDiagnostic({raw:'MAMO-EN013',error:{code:'LOOKUP_TIMEOUT'}}),'LOOKUP_TIMEOUT');
controller.api.lookupPrintings=async()=>{throw new Error('offline');};
assert.equal((await controller.resolve('MAMO-EN099',95,{exactOnly:true})).classification,'UNRESOLVED');
const timeoutTrace=[];
controller.lookupTimeoutMs=5;
controller.api.lookupPrintings=()=>new Promise(()=>{});
controller.debugTrace=(_event,payload)=>timeoutTrace.push(payload);
await assert.rejects(controller.resolve('MAMO-EN098',92,{exactOnly:true}),{code:'LOOKUP_TIMEOUT'});
assert.equal(timeoutTrace.at(-1).classification,'LOOKUP_TIMEOUT');
const corpus=['MAMO-EN012','MAMO-EN013','MAMO-EN014','RA01-EN001','RA02-IT001','RA01EN001','MAMO-ENO13','MAMO-EN0I3','MAMO-EN0L3','MIP-I010','???','MAMO-EN099'];
for(const raw of corpus){const normalized=normalizeSetCode(raw);const candidates=setCodeCandidates(raw);assert.equal(Boolean(candidates.length),normalized.valid,raw);}
assert(setCodeCandidates('MAMO-ENO13').some(row=>row.code==='MAMO-EN013'));
assert.equal(classifyScanDiagnostic({raw:'???'}),'OCR_INVALID');
assert.equal(classifyScanDiagnostic({raw:'RA01-EN001',result:{matches:[{},{}]}}),'AMBIGUOUS');
assert.equal(classifyScanDiagnostic({raw:'MAMO-ENO13',result:{matches:[{}],corrected:true}}),'NEAR');
console.log('PASS diagnostic: missing/exact, low confidence, offline, timeout, ambiguity, OCR corpus');
const measured={exact:0,near:0,review:0,not_found:0,catalog_missing:0};
for(const entry of JSON.parse(fs.readFileSync(new URL('./fixtures/fast-scan-stabilization-corpus.json',import.meta.url),'utf8'))){
  const c=new FastScanController({api:{lookupPrintings:async code=>entry.catalog.flatMap((set_code,index)=>set_code===code?[{printing_id:'fixture-'+index,game:'yugioh',catalog_card_id:String(index+1),card_name:'Synthetic corpus card',set_code,rarity:index?'Secret Rare':'Ultra Rare'}]:[])},camera:{},getCollection:()=>({mine:[],team:[]}),isOnline:()=>true});
  const result=await c.resolve(entry.raw,entry.confidence,{consensus:entry.consensus});
  assert.equal(result.classification,entry.expected,entry.raw);
  if(result.classification==='EXACT')measured.exact++;
  if(result.classification==='NEAR')measured.near++;
  if(result.status==='needs_review')measured.review++;
  if(result.status==='not_found')measured.not_found++;
  if(result.classification==='CATALOG_MISSING')measured.catalog_missing++;
}
console.log('Synthetic corpus (not camera accuracy): '+JSON.stringify(measured));
