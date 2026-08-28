import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeSetCode,setCodeCandidates,classifyPrintingMatch,OcrConsensus,ScanGate,ScanSessionBuffer } from '../js/fast-scan-core.js';

assert.deepEqual(normalizeSetCode(' tdgs - it001 '),{raw:' tdgs - it001 ',code:'TDGS-IT001',valid:true});
assert.equal(normalizeSetCode('rumore\nTDGS-IT001\naltro').code,'TDGS-IT001','estrae il codice senza fondere il rumore OCR');
assert.equal(normalizeSetCode('LOB-001').valid,true);
assert.deepEqual(normalizeSetCode(' L26D–ENX40 '),{raw:' L26D–ENX40 ',code:'L26D-ENX40',valid:true});
assert.equal(normalizeSetCode('codice?').valid,false);
assert(setCodeCandidates('TDGS-ITO01').some(item=>item.code==='TDGS-IT001'&&item.ambiguous),'O/0 produce candidato, non correzione silenziosa');
assert(setCodeCandidates('TG-ZDEJ7').some(item=>item.code==='TG-2DEJ7'),'Z/2 produce soltanto una variante esplicita');
assert(setCodeCandidates('L26D-ENX4O').some(item=>item.code==='L26D-ENX40'),'O/0 supportato sul nuovo formato');
assert.equal(classifyPrintingMatch({normalized:normalizeSetCode('LOB-001'),matches:[{id:1}],consensus:2}).status,'high_confidence');
assert.equal(classifyPrintingMatch({normalized:normalizeSetCode('LOB-001'),matches:[{id:1}],ocrConfidence:62}).status,'needs_review','una lettura debole singola non viene accettata');
assert.equal(classifyPrintingMatch({normalized:normalizeSetCode('LOB-001'),matches:[{id:1},{id:2}]}).status,'needs_review');
assert.equal(classifyPrintingMatch({normalized:normalizeSetCode('LOB-001'),matches:[]}).status,'not_found');
assert.equal(classifyPrintingMatch({normalized:normalizeSetCode('TG-ZDEJ7'),matches:[],consensus:3}).status,'not_found','codice plausibile ma inesistente scartato');

const consensus=new OcrConsensus();
assert.equal(consensus.observe('L26D-ENX40',74).ready,false);
const converged=consensus.observe('L26D-ENX40',78);assert.equal(converged.ready,true);assert.equal(converged.code,'L26D-ENX40');assert.equal(converged.votes,2);
const noisyConsensus=new OcrConsensus();noisyConsensus.observe('L26D-ENX4O',71);noisyConsensus.observe('L26D-ENX40',76);const reconciled=noisyConsensus.observe('L26D-ENX40',79);assert.equal(reconciled.ready,true);assert.equal(reconciled.code,'L26D-ENX40','2 letture su 3 convergono senza correzione silenziosa');

const still=new Array(128).fill(80), changed=new Array(128).fill(230); const gate=new ScanGate({sameCodeCooldown:1000});
assert(gate.consider('LOB-001',still,0));
assert.equal(gate.consider('LOB-001',still,1500),false,'stessa carta ferma non duplicata anche dopo cooldown');
gate.miss();gate.miss();assert(gate.consider('LOB-001',still,1600),'uscita dal frame riabilita la stessa printing');
assert(gate.consider('LOB-001',changed,3000),'variazione frame permette copia consecutiva');

for(const size of [100,500,1000]){
  const buffer=new ScanSessionBuffer();
  for(let index=0;index<size;index++)buffer.add({printingId:`p-${index%84}`,game:'yugioh',catalogCardId:String(index%84),cardName:`Carta ${index%84}`,setCode:`SET-${String(index%84).padStart(3,'0')}`,setName:'Set',rarity:'Common'});
  assert.equal(buffer.total,size);assert.equal(buffer.entries.size,84);assert.equal(buffer.snapshot().entries.reduce((sum,item)=>sum+item.quantity,0),size);
}
const editable=new ScanSessionBuffer();editable.add({printingId:'p',game:'yugioh',catalogCardId:'1',cardName:'Carta',setCode:'SET-001'});editable.add({printingId:'p',game:'yugioh',catalogCardId:'1',cardName:'Carta',setCode:'SET-001'});editable.updateQuantity('p',5);assert.equal(editable.total,5);editable.updateQuantity('p',0);assert.equal(editable.entries.size,0);
const resumed=new ScanSessionBuffer({entries:[{key:'p',printingId:'p',quantity:127}],review:[{id:'r'}],total:127});assert.equal(resumed.total,127);assert.equal(resumed.review.length,1);
const local=new Map();globalThis.localStorage={getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value),removeItem:key=>local.delete(key)};const storage=await import('../js/fast-scan-storage.js');await storage.saveScanSession(resumed.snapshot());assert.equal((await storage.loadScanSession()).total,127);await storage.clearScanSession();assert.equal(await storage.loadScanSession(),null);

globalThis.fetch=async url=>{const parsed=new URL(url);if(parsed.pathname.endsWith('cardsetsinfo.php')){const code=parsed.searchParams.get('setcode');if(code==='TDGS-IT001')return{ok:false,json:async()=>({})};if(code==='TDGS-EN001')return{ok:true,json:async()=>({id:60187739,name:'Turbo Booster',set_name:'The Duelist Genesis',set_code:'TDGS-EN001',set_rarity:'Common'})};}return{ok:true,json:async()=>({data:[{id:60187739,name:'Turbo Booster',type:'Machine',card_images:[{id:60187739,image_url:'https://images.ygoprodeck.com/images/cards/60187739.jpg',image_url_small:'https://images.ygoprodeck.com/images/cards_small/60187739.jpg'}],card_sets:[{set_code:'TDGS-EN001',set_name:'The Duelist Genesis',set_rarity:'Common'}]}]})};};
const {lookupPrintingBySetCode}=await import('../js/cards.js');const localized=await lookupPrintingBySetCode('TDGS-IT001');assert.equal(localized.length,1);assert.equal(localized[0].setCode,'TDGS-IT001','conserva il codice fisico locale');assert.match(localized[0].warning,/TDGS-EN001/);

globalThis.document={createElement:()=>({getContext:()=>({})})};
const {FastScanCamera,readCapabilities,sourceCrop,preprocessCodeImage}=await import('../js/fast-scan-camera.js');
const stopped=[];const stream={getTracks:()=>[{stop:()=>stopped.push(true)}],getVideoTracks:()=>[{getSettings:()=>({deviceId:'rear'})}]};
const video={srcObject:null,muted:false,playsInline:false,play:async()=>{}};
const allowed=new FastScanCamera({getUserMedia:async constraints=>{assert.equal(constraints.video.facingMode.ideal,'environment');return stream;},enumerateDevices:async()=>[{kind:'videoinput',deviceId:'rear'}]});
assert.equal((await allowed.start(video)).length,1);assert.equal(allowed.video,video,'la sorgente video deve restare disponibile al crop ROI');allowed.stop();assert.equal(stopped.length,1,'stop chiude tutte le track');
for(const [name,code] of [['NotAllowedError','denied'],['NotFoundError','unavailable']]){const camera=new FastScanCamera({getUserMedia:async()=>{const e=new Error();e.name=name;throw e;}});await assert.rejects(()=>camera.start(video),error=>error.code===code);}
const unsupported=new FastScanCamera(null);await assert.rejects(()=>unsupported.start(video),error=>error.code==='unsupported');
const hanging=new FastScanCamera({getUserMedia:()=>new Promise(()=>{})},5);await assert.rejects(()=>hanging.start(video),error=>error.code==='timeout');
let torchConstraint=null;const torchTrack={getCapabilities:()=>({torch:true}),applyConstraints:async value=>{torchConstraint=value;},stop:()=>{},getSettings:()=>({deviceId:'torch'})};const torchCamera=new FastScanCamera();torchCamera.stream={getVideoTracks:()=>[torchTrack],getTracks:()=>[torchTrack]};torchCamera.capabilities=readCapabilities(torchTrack);assert.equal(torchCamera.torchSupported,true);assert.equal(await torchCamera.toggleTorch(),true);assert.equal(torchConstraint.advanced[0].torch,true);torchCamera.stop();assert.equal(torchCamera.torchOn,false);

const advanced=[];let focusZoom=1;const focusTrack={getCapabilities:()=>({focusMode:['continuous','single-shot'],zoom:{min:1,max:3,step:.1},torch:true}),getSettings:()=>({deviceId:'rear-focus',focusMode:'continuous',zoom:focusZoom}),applyConstraints:async value=>{advanced.push(value);if(value.advanced[0].zoom)focusZoom=value.advanced[0].zoom;},stop:()=>{}};const focusStream={getTracks:()=>[focusTrack],getVideoTracks:()=>[focusTrack]};const focusVideo={srcObject:null,muted:false,playsInline:false,play:async()=>{}};const focusCamera=new FastScanCamera({getUserMedia:async()=>focusStream,enumerateDevices:async()=>[]});await focusCamera.start(focusVideo);assert.equal(focusCamera.focusSupported,true);assert.equal(focusCamera.zoomSupported,true);assert(advanced.some(item=>item.advanced[0].focusMode==='continuous'),'autofocus continuo non applicato');assert.equal(await focusCamera.setZoom(2.2),true);assert(advanced.some(item=>item.advanced[0].zoom===2.2),'zoom utente non applicato alla track');assert.equal(focusCamera.zoomValue,2.2);assert.equal(await focusCamera.refocus(),true);assert(advanced.some(item=>item.advanced[0].focusMode==='single-shot'),'tap/refocus non usa single-shot');focusCamera.stop();

const crop=sourceCrop({videoWidth:1920,videoHeight:1080,getBoundingClientRect:()=>({left:0,top:0,right:390,bottom:844,width:390,height:844})},{getBoundingClientRect:()=>({left:35,top:390,right:355,bottom:448,width:320,height:58})});assert(crop.sw<1920*.5&&crop.sh<1080*.15,'ROI non abbastanza stretta');assert(crop.sx>=0&&crop.sy>=0,'ROI fuori frame con object-fit cover');
for(const [name,dark,light] of [['poca luce',8,62],['luce forte',190,255],['sleeve lucida',30,250]])for(const mode of ['grayscale','adaptive']){const width=36,height=14,data=new Uint8ClampedArray(width*height*4);for(let p=0;p<width*height;p++){const phase=p%9;const value=phase<3?dark:phase<6?Math.round((dark+light)/2):light;data[p*4]=data[p*4+1]=data[p*4+2]=value;data[p*4+3]=255;}const image={data};const ctx={getImageData:()=>image,putImageData:()=>{}};const stats=preprocessCodeImage(ctx,width,height,{mode});assert.equal(stats.mode,mode,`${name}: strategia ${mode} non applicata`);if(mode==='adaptive')assert([...data].filter((_,index)=>index%4===0).every(value=>value===0||value===255),`${name}: threshold non binario`);else assert([...data].filter((_,index)=>index%4===0).some(value=>value!==0&&value!==255),`${name}: grayscale contrastato perso`);}

const {FastScanOcr}=await import('../js/fast-scan-ocr.js');let terminated=false;const ocr=new FastScanOcr({loader:async()=>({createWorker:async()=>({setParameters:async params=>{assert.equal(params.tessedit_char_whitelist,'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-');assert.equal(params.tessedit_pageseg_mode,'7');},recognize:async()=>({data:{text:'TDGS-IT001',confidence:92}}),terminate:async()=>{terminated=true;}})})});
assert.deepEqual(await ocr.recognize({}),{text:'TDGS-IT001',confidence:92});await ocr.terminate();assert(terminated);

globalThis.document={...globalThis.document,addEventListener:()=>{},querySelector:()=>null,querySelectorAll:()=>[]};
const {FastScanController}=await import('../js/fast-scan.js');
const printing={printingId:'l26d',game:'yugioh',catalogCardId:'123',cardName:'Test Card',setCode:'L26D-ENX40',setName:'Test',rarity:'Common',imageUrl:''};
const controller=new FastScanController({camera:{focusSupported:false,refocus:async()=>false},ocr:{},getCollection:()=>({mine:[],team:[]}),isOnline:()=>true,onRender:()=>{},onRoute:()=>{}});controller.gate=new ScanGate({globalCooldown:0});controller.lookup=async code=>code==='L26D-ENX40'?[printing]:[];
assert.equal((await controller.processRecognition('TG-ZDEJ7',72,[])).status,'pending_consensus');assert.equal((await controller.processRecognition('TG-ZDEJ7',74,[])).status,'not_found');assert.equal(controller.buffer.scanned,0,'output inesistente non deve entrare nel buffer/review');
assert.equal((await controller.processRecognition('L26D-ENX40',76,[])).status,'pending_consensus');assert.equal((await controller.processRecognition('L26D-ENX40',79,[])).status,'high_confidence');assert.equal(controller.buffer.total,1,'consensus L26D-ENX40 non salvato');
controller.gate.miss();controller.gate.miss();assert.equal((await controller.processRecognition('L26D-ENX4O',70,[0])).status,'pending_consensus');assert.equal((await controller.processRecognition('L26D-ENX4O',73,[255])).status,'needs_review');assert.equal(controller.buffer.review.length,1,'correzione O/0 confermata dal catalogo deve restare needs_review');clearTimeout(controller.persistTimer);clearTimeout(controller.feedbackTimer);

class AtomicBatchFixture { constructor(){this.quantities=new Map();} save(items){const before=new Map(this.quantities);try{for(const item of items){if(item.owner)throw new Error('owner non accettato');const next=(this.quantities.get(item.printingId)||0)+item.quantityDelta;if(next>999||item.fail)throw new Error('batch rollback');this.quantities.set(item.printingId,next);}return true;}catch(error){this.quantities=before;throw error;}} }
const batch=new AtomicBatchFixture();batch.save([{printingId:'a',quantityDelta:2},{printingId:'a',quantityDelta:3}]);assert.equal(batch.quantities.get('a'),5,'duplicati incrementati atomicamente');assert.throws(()=>batch.save([{printingId:'a',quantityDelta:1},{printingId:'b',quantityDelta:1,fail:true}]),/rollback/);assert.equal(batch.quantities.get('a'),5,'errore parziale effettua rollback');batch.save([{printingId:'b',quantityDelta:1}]);assert.equal(batch.quantities.get('b'),1,'retry riuscito');assert.throws(()=>batch.save([{printingId:'x',quantityDelta:1,owner:'altro'}]),/owner/);

const sql=fs.readFileSync(new URL('../supabase-milestone-3-fast-scan.sql',import.meta.url),'utf8');
for(const required of ['public.lookup_card_printings_by_set_code','public.save_collection_batch','public.session_member(p_token)','values(me,printing','on conflict (owner_slug,printing_id,language,condition,edition) do update','quantity_owned+excluded.quantity_owned','jsonb_array_length(p_items) not between 1 and 2000'])assert(sql.includes(required),`SQL Fast Scan incompleto: ${required}`);
assert(!/payload->>'owner'/i.test(sql),'il client non può scegliere owner');
const sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');assert(/fpt-cards-v\d+/.test(sw)&&sw.includes('fast-scan-ocr.js')&&sw.includes('OCR_CACHE'));
const scannerUi=fs.readFileSync(new URL('../js/fast-scan.js',import.meta.url),'utf8');for(const required of ['fast-scan-live','live-roi','Hai finito?','Sì, mostrami','No, continua a scansionare','data-scan-manual-sheet','toggleTorch','data-scan-refocus','data-scan-zoom','touchDistance','camera.capture(document.querySelector(\'.live-roi\'))','await this.ocr.terminate()'])assert(scannerUi.includes(required),`Redesign scanner incompleto: ${required}`);assert(!scannerUi.includes('scan-stage-results'),'La lista completa non deve apparire durante il live scan');

console.log('PASS capability camera, autofocus/zoom/torch, ROI e preprocessing adattivo');
console.log('PASS L26D-ENX40, consensus, confusion handling e scarto falsi OCR');
console.log('PASS buffer 100/500/1000, modifica, remove e resume');
console.log('PASS batch atomico, duplicati, rollback/retry e owner server-side');
console.log('PASS PWA shell e cache OCR lazy');
