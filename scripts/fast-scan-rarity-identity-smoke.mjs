import assert from 'node:assert/strict';
import {classifyPrintingMatch,normalizeSetCode,ScanSessionBuffer} from '../js/fast-scan-core.js';
import {printingEvidence,physicalAmbiguity} from '../js/fast-scan-printing-identity.js';
import {sanitizeYugiohRarity} from '../js/cards.js';
globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
globalThis.window={addEventListener(){}};
globalThis.document={addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[]};
const {FastScanController,canonicalizeFastScanEntries}=await import('../js/fast-scan.js');
let count=0;
function check(name,fn){fn();count++;console.log('PASS '+name);}
const seven=['Super Rare','Ultra Rare','Secret Rare','Platinum Secret Rare','Starlight Rare','Ultimate Rare',"Collector's Rare"];
const row=(code,rarity,index=0)=>({printingId:`db-${code}-${index}`,catalogCardId:'123',game:'yugioh',cardName:'Fixture',setCode:code,rarity,quantity:1});
const classify=rows=>classifyPrintingMatch({normalized:normalizeSetCode(rows[0].setCode),matches:rows});
const blgg=['Secret Rare','Starlight Rare'].map((r,i)=>row('BLGG-EN004',r,i));
check('BLGG Secret + Starlight is rarity ambiguous',()=>assert.equal(classify(blgg).physicalClassification,'RARITY_AMBIGUOUS'));
for(const code of ['RA05-EN027','RA05-EN007']){
 const rows=seven.map((r,i)=>row(code,r,i));
 check(code+' all seven variants require review',()=>{assert.equal(classify(rows).physicalClassification,'RARITY_AMBIGUOUS');assert.equal(classify(rows).matches.length,7);});
 check(code+' collapsed catalog is incomplete',()=>{const result=classify([rows[1]]);assert.equal(result.physicalClassification,'CATALOG_VARIANT_INCOMPLETE');assert.equal(result.matches.length,7);assert.equal(result.matches.filter(r=>r.requiresCatalogRepair).length,6);});
}
const falchion=row('BLGG-EN012','Common');
check('actual Falchion Common row is rejected; Ultra requires repair',()=>{const result=classify([falchion]);assert.equal(result.physicalClassification,'CATALOG_VARIANT_INCOMPLETE');assert(result.matches[0].invalidPhysicalRarity);assert(result.matches.find(r=>r.rarity==='Ultra Rare').requiresCatalogRepair);});
check('verified Falchion Ultra alone stays exact',()=>assert.equal(classify([row('BLGG-EN012','Ultra Rare')]).decision,'EXACT_UNIQUE'));
check('normal single rarity stays exact',()=>assert.equal(classify([row('LOB-EN001','Ultra Rare')]).decision,'EXACT_UNIQUE'));
check('explicit Common remains exact',()=>assert.equal(classify([row('LOB-EN002','Common')]).decision,'EXACT_UNIQUE'));
for(const rarity of ['','New','Reprint','New artwork','Reprint (new artwork)','Unknown','3'])check('unknown metadata: '+JSON.stringify(rarity),()=>{assert.equal(sanitizeYugiohRarity(rarity),'');assert.equal(classify([row('LOB-EN001',rarity)]).physicalClassification,'UNKNOWN_RARITY');});
// Bug reale 2026-11-04: DUAD ("R.B.", supabase-add-duad-rb-printings.sql) è
// un prodotto europeo mai tracciato da YGOPRODeck — la rarità fu lasciata
// vuota di proposito, nessuna fonte esterna potrà mai risolverla. La stessa
// regola "rarità vuota = sospetta" che protegge RA05/BLGG/LOB bloccava anche
// queste printing già corrette a catalogo, impedendo per sempre di
// registrarle — pur non essendoci alcuna reale ambiguità da proteggere (un
// solo candidato, nessuna variante concorrente). Eccezione nominale per
// prodotto confermato, non un indebolimento della regola generale (il test
// "unknown metadata" sopra, su un set tracciato, deve restare rosso se
// qualcuno riallarga la regola per sbaglio).
check('DUAD (prodotto non tracciato) con rarità vuota resta exact, non richiede riparazione',()=>{const result=classify([row('DUAD-IT090','')]);assert.equal(result.decision,'EXACT_UNIQUE');assert.equal(result.physicalClassification,undefined);});
check('un set tracciato con rarità vuota resta invece sospetto',()=>assert.equal(classify([row('DUEA-EN001','')]).physicalClassification,'UNKNOWN_RARITY'));
{
  const duadMatch=printingEvidence([row('DUAD-IT090','')])[0];
  check('printingEvidence: DUAD non è mai invalidPhysicalRarity',()=>assert.ok(!duadMatch.invalidPhysicalRarity));
  const duadController=new (await import('../js/fast-scan.js')).FastScanController({camera:{},api:{},paddleOcr:{},getCollection:()=>({mine:[],team:[]}),isOnline:()=>true,onRender(){},onRoute(){},onToast(){}});
  const duadScan=duadController.buffer.createScan();
  duadController.buffer.queueReview({id:duadScan.id,code:'DUAD-IT090',matches:[duadMatch]});duadController.currentScanId=duadScan.id;
  duadController.chooseReview(duadScan.id,0);
  check('chooseReview: una DUAD scelta nel picker si conferma normalmente',()=>{assert.equal(duadController.buffer.entries.size,1);assert.equal(duadController.buffer.getScan(duadScan.id).status,'CONFIRMED');});
  const duadSave=await canonicalizeFastScanEntries([{...duadMatch,quantity:1}],async()=>[duadMatch]);
  check('canonicalizeFastScanEntries: una DUAD con rarità vuota si salva, non viene isolata',()=>{assert.equal(duadSave.rejected.length,0);assert.equal(duadSave.items.length,1);assert.equal(duadSave.items[0].rarity,'');});
  clearTimeout(duadController.persistTimer);
}
const artwork=[{...row('LOB-EN001','Ultra Rare',1),variantId:'a'},{...row('LOB-EN001','Ultra Rare',2),variantId:'b'}];
check('artwork-only ambiguity',()=>assert.equal(physicalAmbiguity(artwork),'ARTWORK_AMBIGUOUS'));
check('mixed rarity and artwork never exact',()=>assert.equal(classify([...artwork,row('LOB-EN001','Secret Rare',3)]).physicalClassification,'RARITY_AMBIGUOUS'));
check('source evidence beyond known codes detects collapsed variants',()=>assert.equal(physicalAmbiguity([{...row('TEST-EN001','Ultra Rare'),expectedRarities:['Ultra Rare','Starlight Rare']}]),'CATALOG_VARIANT_INCOMPLETE'));
check('repair choices cannot inherit any database ID',()=>{const rows=printingEvidence([{id:'uuid',catalog_card_id:'123',set_code:'RA05-EN027',rarity:'Ultra Rare',variant_id:'original'}]);for(const r of rows.filter(r=>r.requiresCatalogRepair)){assert.equal(r.id,'');assert.equal(r.printing_id,'');assert.equal(r.variant_id,'');}assert.equal(printingEvidence(rows).length,7);});
const controller=new FastScanController({camera:{},api:{},paddleOcr:{},getCollection:()=>({mine:[],team:[]}),isOnline:()=>true,onRender(){},onRoute(){},onToast(){}});
const all=seven.map((r,i)=>row('RA05-EN027',r,i));
controller.mergeCatalogIndexRows(all);
controller.cacheResolution('RA05-EN027',[all[1]]);
check('index retains all variants and narrow session cache cannot hide them',()=>assert.equal(controller.lookupMemory('RA05-EN027').matches.length,7));
const fast=await controller.resolveFast('RA05-EN027',99);
check('fast cached resolver requires rarity review',()=>assert.equal(fast.physicalClassification,'RARITY_AMBIGUOUS'));
const scan=controller.buffer.createScan();
controller.buffer.queueReview({id:scan.id,code:'RA05-EN027',matches:printingEvidence([all[1]])});controller.currentScanId=scan.id;
check('review renders every rarity, including options beyond four',()=>assert.equal((controller.assistantView().match(/data-scan-choice=/g)||[]).length,7));
const missingIndex=controller.buffer.review[0].matches.findIndex(r=>r.rarity==='Starlight Rare');
controller.chooseReview(scan.id,missingIndex);
check('missing selected rarity stays review and cannot enter collection',()=>{assert.equal(controller.buffer.entries.size,0);assert.equal(controller.buffer.getScan(scan.id).classification,'REQUIRES_CATALOG_REPAIR');});
const star=all.find(r=>r.rarity==='Starlight Rare'),ultra=all[1];
const good=await canonicalizeFastScanEntries([star],async()=>all);
check('existing Starlight ID and rarity stay coherent',()=>{assert.equal(good.rejected.length,0);assert.equal(good.items[0].printingId,star.printingId);assert.equal(good.items[0].rarity,'Starlight Rare');});
const wrong=await canonicalizeFastScanEntries([{...star,printingId:ultra.printingId}],async()=>all);
check('Starlight cannot be saved against Ultra UUID',()=>{assert.equal(wrong.items.length,0);assert.equal(wrong.rejected[0].code,'REQUIRES_CATALOG_REPAIR');});
const missing=await canonicalizeFastScanEntries([{...star,printingId:''}],async()=>[ultra]);
check('missing Starlight cannot fall back to Ultra or create row',()=>{assert.equal(missing.items.length,0);assert.equal(missing.rejected[0].code,'REQUIRES_CATALOG_REPAIR');});
const absent=await canonicalizeFastScanEntries([{...star,printingId:''}],async()=>[]);
check('empty DB lookup cannot implicitly create a printing',()=>assert.equal(absent.rejected[0].code,'REQUIRES_CATALOG_REPAIR'));
const otherArtwork=await canonicalizeFastScanEntries([{...star,printingId:'',catalogCardId:'456'}],async()=>[star]);
check('matching name cannot switch catalog identity or artwork',()=>assert.equal(otherArtwork.items.length,0));
let lookupCount=0;
await canonicalizeFastScanEntries(all,async()=>{lookupCount++;return all;});
check('seven variants share one verification lookup',()=>assert.equal(lookupCount,1));
const wrongVariant=await canonicalizeFastScanEntries([{...artwork[0],variantId:'b'}],async()=>artwork);
check('variant ID mismatch rejected',()=>assert.equal(wrongVariant.rejected[0].code,'REQUIRES_CATALOG_REPAIR'));
const buffer=new ScanSessionBuffer();for(const r of artwork)buffer.add({...r,printingId:''});
check('variant identities survive session round trip separately',()=>assert.equal(new ScanSessionBuffer(buffer.snapshot()).entries.size,2));
clearTimeout(controller.persistTimer);
console.log(`Rarity identity regression: ${count}/${count} PASS`);
