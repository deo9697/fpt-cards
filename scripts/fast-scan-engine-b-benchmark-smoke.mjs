import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeRankCode, rankSetCodeCandidates, setCodeDistance } from '../js/fast-scan-candidate-ranking.js';
import { ENGINE_B_ASSETS, PADDLE_DET_MODEL_URL, PADDLE_REC_MODEL_URL, PADDLE_RUNTIME_ASSETS, PaddleOcrBenchmarkEngine } from '../js/fast-scan-ocr-engine-b.js';

assert.equal(normalizeRankCode(' l5dd – enc34 '),'L5DD-ENC34');
assert.equal(setCodeDistance('LSDD-ENY39','L5DD-ENY39'),.25,'S/5 deve avere costo OCR ridotto');
assert.equal(setCodeDistance('TDGS-IT0001','TDGS-IT001'),1,'un carattere duplicato deve restare near');

const known=['L5DD-ENC34','L5DD-ENC39','L5DD-ENY39','JUSH-IT047','L26D-ENX40','TDGS-IT001'];
assert.equal(rankSetCodeCandidates('L5DD-ENC34',known).classification,'exact');
const confusion=rankSetCodeCandidates('LSDD-ENY39',known);assert.equal(confusion.classification,'near');assert.equal(confusion.bestCandidate,'L5DD-ENY39');assert.equal(confusion.unique,true);
const insertion=rankSetCodeCandidates('TDGS-IT0001',known);assert.equal(insertion.classification,'near');assert.equal(insertion.bestCandidate,'TDGS-IT001');
const ambiguous=rankSetCodeCandidates('L5DD-ENC3',known);assert.equal(ambiguous.classification,'ambiguous');assert.equal(ambiguous.unique,false);
assert.equal(rankSetCodeCandidates('B070J05VITNN',known).classification,'reject');
assert.equal(rankSetCodeCandidates('L5DD-ENY3S',known).ranked[0].prefixMatch,true,'il prefisso noto deve restringere il ranking');

const canvas={width:900,height:118},calls=[];let disposed=false;
const engine=new PaddleOcrBenchmarkEngine({loader:async()=>({PaddleOCR:{create:async options=>{calls.push(['create',options]);return{predict:async(input,predictOptions)=>{calls.push(['predict',input,predictOptions]);return[{items:[{text:'L5DD-',score:.96,poly:[[1,0]]},{text:'ENC34',score:.92,poly:[[100,0]]}],metrics:{detMs:3,recMs:4,totalMs:7},runtime:{backend:'wasm'}}];},dispose:async()=>{disposed=true;}};}}})});
assert.equal(calls.length,0,'costruttore adapter non deve scaricare PaddleOCR');const result=await engine.recognize(canvas);assert.equal(calls[1][1],canvas,'Engine B deve ricevere lo stesso canvas, non una copia o un blob');assert.equal(calls[0][1].textDetectionModelName,'PP-OCRv6_tiny_det');assert.equal(calls[0][1].textRecognitionModelName,'PP-OCRv6_tiny_rec');assert.equal(calls[0][1].textDetectionModelAsset.url,PADDLE_DET_MODEL_URL);assert.equal(calls[0][1].textRecognitionModelAsset.url,PADDLE_REC_MODEL_URL);assert.equal(calls[0][1].worker,false);assert.equal(calls[0][1].ortOptions.backend,'wasm');assert.equal(calls[0][1].ortOptions.numThreads,1);assert.equal(result.text,'L5DD- ENC34');assert.equal(result.metrics.totalMs,7);assert(result.confidence>90);for(let index=0;index<20;index+=1)await engine.recognize(canvas);assert.equal(calls.filter(call=>call[0]==='create').length,1,'la sessione ONNX deve essere riutilizzata tra le carte');await engine.dispose();assert.equal(disposed,true,'sessione ONNX sperimentale non rilasciata');assert(ENGINE_B_ASSETS.estimatedColdBytes>30_000_000);assert.equal(PADDLE_RUNTIME_ASSETS.length,5);

const scanner=fs.readFileSync(new URL('../js/fast-scan.js',import.meta.url),'utf8'),sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
for(const required of ['data-ocr-real-code','data-run-ocr-engine-benchmark','runOcrEngineBenchmark','sameCanvas:true','rankSetCodeCandidates','__fastScanEngineBenchmarks','prepareProductionOcr','recognizeProduction','paddle cold load','paddle warm startup','total time-to-card'])assert(scanner.includes(required),`benchmark/production candidate incompleto: ${required}`);
assert(sw.includes('fast-scan-candidate-ranking.js')&&sw.includes('fast-scan-ocr-engine-b.js')&&sw.includes('PADDLE_CACHE')&&sw.includes('paddle-model-ecology.bj.bcebos.com'));

console.log('PASS ranking exact/near/ambiguous/reject e prefisso catalogo');
console.log('PASS PaddleOCR lazy, PP-OCRv6 tiny, WASM single-thread e stesso canvas');
console.log('PASS lazy load Fast Scan, runtime cache Paddle e cleanup esplicito');
