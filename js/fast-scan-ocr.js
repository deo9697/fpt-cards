const SCRIPT='https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js';
let scriptPromise;

export class FastScanOcr {
  constructor({loader=loadTesseract,onProgress=()=>{}}={}){this.loader=loader;this.onProgress=onProgress;this.worker=null;this.busy=false;this.preparing=null;}
  async prepare(){if(this.worker)return;if(this.preparing)return this.preparing;this.preparing=(async()=>{const Tesseract=await this.loader();this.worker=await Tesseract.createWorker('eng',1,{logger:event=>this.onProgress(event)});await this.worker.setParameters({tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',tessedit_pageseg_mode:'7',tessedit_enable_doc_dict:'0',preserve_interword_spaces:'0',user_defined_dpi:'300'});})();try{await this.preparing;}finally{this.preparing=null;}}
  async recognize(canvas){if(this.busy) return null;this.busy=true;try{await this.prepare();const result=await this.worker.recognize(canvas);return {text:result.data?.text||'',confidence:Number(result.data?.confidence||0)};}finally{this.busy=false;}}
  async terminate(){if(this.preparing)await this.preparing.catch(()=>{});const worker=this.worker;this.worker=null;this.busy=false;if(worker)await worker.terminate();}
}

function loadTesseract(){if(globalThis.Tesseract)return Promise.resolve(globalThis.Tesseract);if(scriptPromise)return scriptPromise;scriptPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=SCRIPT;script.async=true;script.crossOrigin='anonymous';script.onload=()=>globalThis.Tesseract?resolve(globalThis.Tesseract):reject(new Error('Motore OCR non disponibile'));script.onerror=()=>reject(new Error('Download OCR non riuscito'));document.head.append(script);});return scriptPromise;}
