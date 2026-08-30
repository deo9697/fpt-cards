export const PADDLE_SDK_URL='https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm';
export const PADDLE_DET_MODEL_URL='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_det_onnx_infer.tar';
export const PADDLE_REC_MODEL_URL='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_rec_onnx_infer.tar';
export const PADDLE_WASM_BASE_URL='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';

function weightedConfidence(items=[]){let score=0,weight=0;for(const item of items){const text=String(item?.text||''),itemWeight=Math.max(1,text.length),confidence=Number(item?.score);if(Number.isFinite(confidence)){score+=(confidence<=1?confidence*100:confidence)*itemWeight;weight+=itemWeight;}}return weight?Math.round(score/weight*100)/100:0;}
function readItems(result){const candidates=[result?.items,result?.texts,result?.data,result];const items=candidates.find(value=>Array.isArray(value))||[];return items.filter(item=>item&&typeof item==='object'&&'text' in item);}
function leftEdge(item){const box=item?.poly||item?.box||item?.points||item?.bbox;if(!Array.isArray(box))return 0;const flat=box.flat?.()||box;return Number(flat[0]??0);}
function bounds(item){const box=item?.poly||item?.points||item?.box||item?.bbox;if(!Array.isArray(box))return null;const points=Array.isArray(box[0])?box:[];if(points.length<2)return null;const xs=points.map(point=>Number(point?.[0])).filter(Number.isFinite),ys=points.map(point=>Number(point?.[1])).filter(Number.isFinite);if(xs.length<2||ys.length<2)return null;return {left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys),height:Math.max(1,Math.max(...ys)-Math.min(...ys))};}
function selectCodeItems(items){if(items.length<2)return items;const clusters=[];let current=[];for(const item of items){const box=bounds(item),previous=current.length?bounds(current[current.length-1]):null;if(current.length&&box&&previous){const gap=box.left-previous.right,aligned=Math.min(box.bottom,previous.bottom)-Math.max(box.top,previous.top)>-Math.max(box.height,previous.height)*.35;if(!aligned||gap>Math.max(32,box.height*3,previous.height*3)){clusters.push(current);current=[];}}current.push(item);}if(current.length)clusters.push(current);return clusters.sort((left,right)=>clusterScore(right)-clusterScore(left))[0]||items;}
function clusterScore(items){const text=items.map(item=>String(item.text||'').trim()).join('');return (text.includes('-')?1000:0)+(/[A-Z]/i.test(text)&&/\d/.test(text)?500:0)+Math.min(text.length,30);}

export class PaddleOcrEngine {
  constructor({loader=()=>import(PADDLE_SDK_URL)}={}){this.loader=loader;this.engine=null;this.preparing=null;}
  async prepare(){
    if(this.engine)return;
    if(this.preparing)return this.preparing;
    this.preparing=(async()=>{const module=await this.loader(),PaddleOCR=module.PaddleOCR||module.default?.PaddleOCR||module.default;if(!PaddleOCR?.create)throw new Error('PaddleOCR.js non espone PaddleOCR.create');this.engine=await PaddleOCR.create({textDetectionModelName:'PP-OCRv6_tiny_det',textRecognitionModelName:'PP-OCRv6_tiny_rec',textDetectionModelAsset:{url:PADDLE_DET_MODEL_URL},textRecognitionModelAsset:{url:PADDLE_REC_MODEL_URL},worker:false,ortOptions:{backend:'wasm',wasmPaths:PADDLE_WASM_BASE_URL,numThreads:1,simd:true}});})();
    try{await this.preparing;}catch(error){this.engine=null;throw error;}finally{this.preparing=null;}
  }
  async recognize(canvas){if(!canvas?.width||!canvas?.height)throw new Error('Crop OCR non disponibile');await this.prepare();const response=await this.engine.predict(canvas,{textRecScoreThresh:0}),result=Array.isArray(response)?response[0]:response,items=readItems(result).sort((left,right)=>leftEdge(left)-leftEdge(right)),selected=selectCodeItems(items),text=selected.map(item=>String(item.text||'').trim()).filter(Boolean).join('');return {text,confidence:weightedConfidence(selected),engine:'paddle'};}
  async dispose(){if(this.preparing)await this.preparing.catch(()=>{});const engine=this.engine;this.engine=null;if(engine?.dispose)await engine.dispose();else if(engine?.release)await engine.release();}
}
