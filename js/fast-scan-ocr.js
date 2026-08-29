const SCRIPT='https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js';
export const OCR_WHITELIST='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';
export const SYNTHETIC_CODES=['JUSH-IT047','L5DD-ENY39','L26D-ENX40','TDGS-IT001'];
let scriptPromise;

export class FastScanOcr {
  constructor({loader=loadTesseract,onProgress=()=>{}}={}){this.loader=loader;this.onProgress=onProgress;this.Tesseract=null;this.worker=null;this.busy=false;this.preparing=null;this.lifecycle=[];this.parameters=null;this.lastRaw=null;}
  mark(step,details={}){this.lifecycle.push({step,at:new Date().toISOString(),...details});if(this.lifecycle.length>80)this.lifecycle.shift();}
  minimalParameters(psm='7'){return {tessedit_char_whitelist:OCR_WHITELIST,tessedit_pageseg_mode:String(psm)};}
  async prepare(){
    if(this.worker)return;
    if(this.preparing)return this.preparing;
    this.preparing=(async()=>{
      this.mark('load-library');this.Tesseract=await this.loader();
      this.mark('create-worker',{language:'eng'});this.worker=await this.Tesseract.createWorker('eng',1,{logger:event=>this.onProgress(event)});
      this.mark('language-ready',{language:'eng'});
      await this.applyParameters(this.worker,'7','reused');
    })();
    try{await this.preparing;}finally{this.preparing=null;}
  }
  async applyParameters(worker,psm='7',workerKind='reused'){
    const parameters=this.minimalParameters(psm);await worker.setParameters(parameters);this.parameters={...parameters};this.mark('set-parameters',{workerKind,...parameters});return parameters;
  }
  async recognize(canvas,{psm='7',debug=false}={}){
    if(this.busy)return null;this.busy=true;
    try{
      await this.prepare();const parameters=await this.applyParameters(this.worker,psm,'reused');this.mark('recognize',{workerKind:'reused',psm:String(psm)});
      const result=await this.worker.recognize(canvas,undefined,debug?{text:true,blocks:true,tsv:true}:undefined);
      return this.readRawResult(result,{parameters,psm,workerKind:'reused'});
    }finally{this.busy=false;}
  }
  readRawResult(result,{parameters,psm,workerKind}){
    const data=result?.data||{},layout=readLayout(data.blocks),raw={text:typeof data.text==='string'?data.text:'',confidence:Number.isFinite(Number(data.confidence))?Number(data.confidence):0,keys:Object.keys(data),words:layout.words,symbols:layout.symbols,tsv:typeof data.tsv==='string'?data.tsv.slice(0,4000):''};
    this.lastRaw=raw;return {text:raw.text,confidence:raw.confidence,raw,parameters:{...parameters},psm:String(psm),workerKind};
  }
  async recognizeWith(worker,canvas,{psm,workerKind}){const parameters=await this.applyParameters(worker,psm,workerKind);this.mark('recognize',{workerKind,psm:String(psm)});const started=performance.now();const result=await worker.recognize(canvas,undefined,{text:true,blocks:true,tsv:true});return {...this.readRawResult(result,{parameters,psm,workerKind}),ocrMs:performance.now()-started};}
  async runSyntheticDiagnostics(){
    if(this.busy)throw new Error('OCR occupato: attendi la fine della lettura corrente');this.busy=true;let fresh=null;
    try{
      await this.prepare();const reused=[];
      for(const code of SYNTHETIC_CODES)reused.push({input:code,...await this.recognizeWith(this.worker,syntheticCanvas(code),{psm:'7',workerKind:'reused'})});
      for(const psm of ['8','13'])reused.push({input:'JUSH-IT047',...await this.recognizeWith(this.worker,syntheticCanvas('JUSH-IT047'),{psm,workerKind:'reused'})});
      this.mark('create-worker',{language:'eng',workerKind:'fresh'});fresh=await this.Tesseract.createWorker('eng',1,{logger:event=>this.onProgress({...event,workerKind:'fresh'})});this.mark('language-ready',{language:'eng',workerKind:'fresh'});const freshResults=[];
      for(const code of SYNTHETIC_CODES)freshResults.push({input:code,...await this.recognizeWith(fresh,syntheticCanvas(code),{psm:'7',workerKind:'fresh'})});
      for(const psm of ['8','13'])freshResults.push({input:'JUSH-IT047',...await this.recognizeWith(fresh,syntheticCanvas('JUSH-IT047'),{psm,workerKind:'fresh'})});
      return {whitelist:OCR_WHITELIST,reused,fresh:freshResults,lifecycle:[...this.lifecycle]};
    }finally{if(fresh){await fresh.terminate();this.mark('terminate-worker',{workerKind:'fresh'});}this.busy=false;}
  }
  debugState(){return {parameters:this.parameters?{...this.parameters}:null,lastRaw:this.lastRaw,lifecycle:[...this.lifecycle]};}
  async terminate(){if(this.preparing)await this.preparing.catch(()=>{});const worker=this.worker;this.worker=null;this.busy=false;if(worker){await worker.terminate();this.mark('terminate-worker',{workerKind:'reused'});}}
}

function syntheticCanvas(text){const canvas=document.createElement('canvas');canvas.width=900;canvas.height=180;canvas.dataset.syntheticOcr=text;const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='#000';context.font='700 82px Arial, sans-serif';context.textAlign='center';context.textBaseline='middle';context.fillText(text,canvas.width/2,canvas.height/2);return canvas;}
function readLayout(blocks){const words=[],symbols=[];for(const block of blocks||[])for(const paragraph of block.paragraphs||[])for(const line of paragraph.lines||[])for(const word of line.words||[]){words.push({text:String(word.text||''),confidence:Number(word.confidence||0)});for(const symbol of word.symbols||[])symbols.push({text:String(symbol.text||''),confidence:Number(symbol.confidence||0)});}return {words,symbols};}

function loadTesseract(){if(globalThis.Tesseract)return Promise.resolve(globalThis.Tesseract);if(scriptPromise)return scriptPromise;scriptPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=SCRIPT;script.async=true;script.crossOrigin='anonymous';script.onload=()=>globalThis.Tesseract?resolve(globalThis.Tesseract):reject(new Error('Motore OCR non disponibile'));script.onerror=()=>reject(new Error('Download OCR non riuscito'));document.head.append(script);});return scriptPromise;}
