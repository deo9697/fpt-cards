export const PADDLE_SDK_URL='https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm';
export const PADDLE_DET_MODEL_URL='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_det_onnx_infer.tar';
export const PADDLE_REC_MODEL_URL='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_rec_onnx_infer.tar';
export const PADDLE_WASM_BASE_URL='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';
// L'inferenza gira in un Web Worker dedicato così ogni scatto non blocca il
// thread principale (HUD, animazioni) per la durata della predict(). Un
// Worker però non può puntare direttamente a uno script di un altro
// dominio anche con CORS — va scaricato una volta e avvolto in un blob:
// URL locale. Il nome del file è l'hash del bundler per QUESTA versione
// del pacchetto: se PADDLE_SDK_URL cambia versione, verificare che esista
// ancora a questo percorso. Un worker guasto viene ricreato al prossimo tentativo.
const PADDLE_WORKER_ENTRY_URL=new URL('./assets/worker-entry-C9UNuyOJ.js',new URL('/npm/@paddleocr/paddleocr-js@0.4.2/dist/index.mjs','https://cdn.jsdelivr.net').href).href;
let workerBlobUrlPromise=null;
function prepareWorkerBlobUrl(){
  if(!workerBlobUrlPromise)workerBlobUrlPromise=(async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    let scriptText;
    try{const response=await fetch(PADDLE_WORKER_ENTRY_URL,{signal:controller.signal});if(!response.ok)throw new Error(`Worker OCR: HTTP ${response.status}`);scriptText=await response.text();}finally{clearTimeout(timer);}
    return URL.createObjectURL(new Blob([scriptText],{type:'text/javascript'}));
  })().catch(error=>{workerBlobUrlPromise=null;throw error;});
  return workerBlobUrlPromise;
}

function weightedConfidence(items=[]){let score=0,weight=0;for(const item of items){const text=String(item?.text||''),itemWeight=Math.max(1,text.length),confidence=Number(item?.score);if(Number.isFinite(confidence)){score+=(confidence<=1?confidence*100:confidence)*itemWeight;weight+=itemWeight;}}return weight?Math.round(score/weight*100)/100:0;}
function readItems(result){const candidates=[result?.items,result?.texts,result?.data,result];const items=candidates.find(value=>Array.isArray(value))||[];return items.filter(item=>item&&typeof item==='object'&&'text' in item);}
function leftEdge(item){const box=item?.poly||item?.box||item?.points||item?.bbox;if(!Array.isArray(box))return 0;const flat=box.flat?.()||box;return Number(flat[0]??0);}
function bounds(item){const box=item?.poly||item?.points||item?.box||item?.bbox;if(!Array.isArray(box))return null;const points=Array.isArray(box[0])?box:[];if(points.length<2)return null;const xs=points.map(point=>Number(point?.[0])).filter(Number.isFinite),ys=points.map(point=>Number(point?.[1])).filter(Number.isFinite);if(xs.length<2||ys.length<2)return null;return {left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys),height:Math.max(1,Math.max(...ys)-Math.min(...ys))};}
function selectCodeItems(items){if(items.length<2)return items;const clusters=[];let current=[];for(const item of items){const box=bounds(item),previous=current.length?bounds(current[current.length-1]):null;if(current.length&&box&&previous){const gap=box.left-previous.right,aligned=Math.min(box.bottom,previous.bottom)-Math.max(box.top,previous.top)>-Math.max(box.height,previous.height)*.35;if(!aligned||gap>Math.max(32,box.height*3,previous.height*3)){clusters.push(current);current=[];}}current.push(item);}if(current.length)clusters.push(current);return clusters.sort((left,right)=>clusterScore(right)-clusterScore(left))[0]||items;}
function clusterScore(items){const text=items.map(item=>String(item.text||'').trim()).join('');return (text.includes('-')?1000:0)+(/[A-Z]/i.test(text)&&/\d/.test(text)?500:0)+Math.min(text.length,30);}

export class PaddleOcrEngine {
  constructor({loader=()=>import(PADDLE_SDK_URL),workerUrl=prepareWorkerBlobUrl,WorkerClass=globalThis.Worker,prepareTimeoutMs=60000,recognizeTimeoutMs=15000}={}){Object.assign(this,{loader,workerUrl,WorkerClass,prepareTimeoutMs,recognizeTimeoutMs});this.engine=null;this.preparing=null;this.worker=null;this.generation=0;this.cancellations=new Set();
    // Strumentazione (?debugScan=1, vedi js/fast-scan.js): executionMode/
    // workerTimeoutCount/workerRestartCount sono SOLO osservabilità di ciò
    // che il codice già fa (worker vs fallback main-thread già esisteva via
    // il campo `worker` restituito da recognize(); reset() su fallimento già
    // esisteva) — nessun nuovo comportamento OCR, nessuna nuova soglia.
    this.executionMode='WORKER';this.workerTimeoutCount=0;this.workerRestartCount=0;this.everFailed=false;
  }
  bounded(promise,timeoutMs,message,timeoutCode){
    return new Promise((resolve,reject)=>{let timer;const cancel=()=>{clearTimeout(timer);this.cancellations.delete(cancel);reject(Object.assign(new Error(message),timeoutCode?{code:timeoutCode}:null));};this.cancellations.add(cancel);timer=setTimeout(cancel,timeoutMs);Promise.resolve(promise).then(resolve,reject).finally(()=>{clearTimeout(timer);this.cancellations.delete(cancel);});});
  }
  reset(){this.generation+=1;this.worker?.terminate();this.worker=null;this.engine=null;this.preparing=null;for(const cancel of [...this.cancellations])cancel();}
  // Chiamato dai catch di prepare()/recognize() su un fallimento REALE (non
  // su una cancellazione per generazione superata, che non è un guasto).
  noteFailure(error){this.workerRestartCount+=1;this.everFailed=true;this.executionMode='WORKER_FAILED';if(error?.code==='ENGINE_TIMEOUT')this.workerTimeoutCount+=1;}
  async prepare(){
    if(this.engine)return;
    if(this.preparing)return this.preparing;
    if(this.everFailed)this.executionMode='WORKER_RESTARTING';
    const generation=this.generation;
    const preparation=(async()=>{
      const module=await this.loader(),PaddleOCR=module.PaddleOCR||module.default?.PaddleOCR||module.default;
      if(generation!==this.generation)throw new Error('Preparazione OCR annullata');
      if(!PaddleOCR?.create)throw new Error('PaddleOCR.js non espone PaddleOCR.create');
      const baseOptions={textDetectionModelName:'PP-OCRv6_tiny_det',textRecognitionModelName:'PP-OCRv6_tiny_rec',textDetectionModelAsset:{url:PADDLE_DET_MODEL_URL},textRecognitionModelAsset:{url:PADDLE_REC_MODEL_URL},ortOptions:{backend:'wasm',wasmPaths:PADDLE_WASM_BASE_URL,numThreads:1,simd:true}};
      const blobUrl=await this.workerUrl();
      if(generation!==this.generation)throw new Error('Preparazione OCR annullata');
      const engine=await PaddleOCR.create({...baseOptions,worker:{createWorker:()=>{if(generation!==this.generation)throw new Error('Preparazione OCR annullata');return this.worker=new this.WorkerClass(blobUrl,{type:'module'});}}});
      if(generation!==this.generation){void Promise.resolve(engine.dispose?.()).catch(()=>{});throw new Error('Preparazione OCR annullata');}
      this.engine=engine;
    })();
    this.preparing=this.bounded(preparation,this.prepareTimeoutMs,'Preparazione OCR scaduta: riprova','ENGINE_TIMEOUT');
    try{await this.preparing;}catch(error){if(generation===this.generation){this.noteFailure(error);this.reset();}throw error;}finally{if(generation===this.generation)this.preparing=null;}
  }
  async recognize(canvas){
    if(!canvas?.width||!canvas?.height)throw new Error('Crop OCR non disponibile');await this.prepare();const generation=this.generation;
    try{const response=await this.bounded(this.engine.predict(canvas,{textRecScoreThresh:0}),this.recognizeTimeoutMs,'OCR troppo lento: riprova lo scatto','ENGINE_TIMEOUT'),result=Array.isArray(response)?response[0]:response,items=readItems(result).sort((left,right)=>leftEdge(left)-leftEdge(right)),selected=selectCodeItems(items),text=selected.map(item=>String(item.text||'').trim()).filter(Boolean).join('');this.executionMode=this.worker?'WORKER':'MAIN_THREAD_FALLBACK';return {text,confidence:weightedConfidence(selected),engine:'paddle',metrics:result?.metrics||null,runtime:result?.runtime||null,worker:Boolean(this.worker)};}
    catch(error){if(generation===this.generation){this.noteFailure(error);this.reset();}throw error;}
  }
  async dispose(){const engine=this.engine,worker=this.worker;this.reset();if(!worker){if(engine?.dispose)await engine.dispose();else if(engine?.release)await engine.release();}}
}
