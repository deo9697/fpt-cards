import assert from 'node:assert/strict';
import {setCodeCandidates, classifyNearPrintingMatch} from '../js/fast-scan-core.js';

globalThis.window = {addEventListener(){}};
globalThis.document = {addEventListener(){}};
globalThis.localStorage = {getItem(){return null;},setItem(){},removeItem(){}};
const {FastScanController} = await import('../js/fast-scan.js');

for (const [read, expected] of [['PJNI-IT001','PHNI-IT001'],['NUMJ-EN001','NUMH-EN001'],['HOTL-IT001','JOTL-IT001'],['SJSP-EN001','SHSP-EN001']]) {
  const candidate = setCodeCandidates(read).slice(1,9).find(item => item.code === expected);
  assert(candidate, `${read}: expected correction must reach catalog lookup`);
  const matches = [{printingId:expected,catalogCardId:'1',setCode:expected}];
  assert.equal(classifyNearPrintingMatch([{candidate,matches}]).status, 'needs_review');
  assert.equal(setCodeCandidates(expected)[0].code, expected);
}

const calls=[];
const controller = new FastScanController({camera:{},paddleOcr:{},getCollection:()=>({mine:[],team:[]}),isOnline:()=>true,
  api:{lookupPrintings:async code=>{calls.push(['rpc',code]);return code==='PHNI-IT001'?[{printing_id:'phni',catalog_card_id:'1',set_code:code,game:'yugioh'}]:[];}},
  externalLookup:async code=>{calls.push(['external',code]);return [];}});
const first = await controller.resolve('PJNI-IT001',80,{exactOnly:true});
assert.equal(first.status,'not_found');
assert.deepEqual(calls,[['rpc','PJNI-IT001']], 'first pass must not search external sources or corrected candidates');
const corrected = await controller.resolve('PJNI-IT001',80);
assert.equal(corrected.status,'needs_review');
assert(corrected.matches.some(item=>item.setCode==='PHNI-IT001'));
calls.length=0;
assert.equal((await controller.resolve('PHNI-IT001',95,{exactOnly:true})).status,'high_confidence');
assert.equal(calls.length,0,'verified session cache must avoid another request');
console.log('PASS expansion J/H candidates, review safety, first-pass request budget, verified cache');
