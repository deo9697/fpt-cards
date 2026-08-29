export const PADDLE_SDK_URL='https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm';
export const PADDLE_DET_MODEL_URL='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_det_onnx_infer.tar';
export const PADDLE_REC_MODEL_URL='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_rec_onnx_infer.tar';
export const PADDLE_WASM_BASE_URL='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';

function weightedConfidence(items=[]){let score=0,weight=0;for(const item of items){const text=String(item?.text||''),itemWeight=Math.max(1,text.length),confidence=Number(item?.score);if(Number.isFinite(confidence)){score+=(confidence<=1?confidence*100:confidence)*itemWeight;weight+=itemWeight;}}return weight?Math.round(score/weight*100)/100:0;}
function readItems(result){const candidates=[result?.items,result?.texts,result?.data,result];const items=candidates.find(value=>Array.isArray(value))||[];return items.filter(item=>item&&typeof item==='object'&&'text' in item);}
function leftEdge(item){const box=item?.poly||item?.box||item?.points||item?.bbox;if(!Array.isArray(box))return 0;const flat=box.flat?.()||box;return Number(flat[0]??0);}

export class PaddleOcrEngine {
  constructor({loader=()=>import(PADDLE_SDK_URL)}={}){this.loader=loader;this.engine=null;this.preparing=null;}
  async prepare(){
    if(this.engine)return;
    if(this.preparing)return this.preparing;
    this.preparing=(async()=>{const module=await this.loader(),PaddleOCR=module.PaddleOCR||module.default?.PaddleOCR||module.default;if(!PaddleOCR?.create)throw new Error('PaddleOCR.js non espone PaddleOCR.create');this.engine=await PaddleOCR.create({textDetectionModelName:'PP-OCRv6_tiny_det',textRecognitionModelName:'PP-OCRv6_tiny_rec',textDetectionModelAsset:{url:PADDLE_DET_MODEL_URL},textRecognitionModelAsset:{url:PADDLE_REC_MODEL_URL},worker:false,ortOptions:{backend:'wasm',wasmPaths:PADDLE_WASM_BASE_URL,numThreads:1,simd:true}});})();
    try{await this.preparing;}catch(error){this.engine=null;throw error;}finally{this.preparing=null;}
  }
  async recognize(canvas){if(!canvas?.width||!canvas?.height)throw new Error('Crop OCR non disponibile');await this.prepare();const response=await this.engine.predict(canvas,{textRecScoreThresh:0}),result=Array.isArray(response)?response[0]:response,items=readItems(result).sort((left,right)=>leftEdge(left)-leftEdge(right)),text=items.map(item=>String(item.text||'').trim()).filter(Boolean).join('');return {text,confidence:weightedConfidence(items),engine:'paddle'};}
  async dispose(){if(this.preparing)await this.preparing.catch(()=>{});const engine=this.engine;this.engine=null;if(engine?.dispose)await engine.dispose();else if(engine?.release)await engine.release();}
}
