const SCRIPT='https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js';
export const OCR_WHITELIST='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';
let scriptPromise;

export class FastScanOcr {
  constructor({loader=loadTesseract,onProgress=()=>{}}={}){this.loader=loader;this.onProgress=onProgress;this.worker=null;this.busy=false;this.preparing=null;}
  async prepare(){
    if(this.worker)return;
    if(this.preparing)return this.preparing;
    this.preparing=(async()=>{
      const Tesseract=await this.loader();
      this.worker=await Tesseract.createWorker('eng',1,{logger:event=>this.onProgress(event)});
      await this.worker.setParameters({
        tessedit_char_whitelist:OCR_WHITELIST,
        tessedit_pageseg_mode:'7',
        preserve_interword_spaces:'0'
      });
    })();
    try{await this.preparing;}catch(error){const worker=this.worker;this.worker=null;try{await worker?.terminate?.();}catch{}throw error;}finally{this.preparing=null;}
  }
  async recognize(canvas){
    if(!canvas?.width||!canvas?.height)throw new Error('Crop OCR non disponibile');
    if(this.busy)throw new Error('OCR occupato');
    this.busy=true;
    try{
      await this.prepare();
      const result=await this.worker.recognize(canvas);
      const data=result?.data||{};
      return {text:typeof data.text==='string'?data.text:'',confidence:Number.isFinite(Number(data.confidence))?Number(data.confidence):0,engine:'tesseract'};
    }finally{this.busy=false;}
  }
  async terminate(){if(this.preparing)await this.preparing.catch(()=>{});const worker=this.worker;this.worker=null;this.busy=false;if(worker)await worker.terminate();}
}

function loadTesseract(){
  if(globalThis.Tesseract)return Promise.resolve(globalThis.Tesseract);
  if(scriptPromise)return scriptPromise;
  scriptPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=SCRIPT;script.async=true;script.crossOrigin='anonymous';
    script.onload=()=>globalThis.Tesseract?resolve(globalThis.Tesseract):reject(new Error('Motore OCR non disponibile'));
    script.onerror=()=>{scriptPromise=null;reject(new Error('Download OCR non riuscito'));};
    document.head.append(script);
  });
  return scriptPromise;
}
