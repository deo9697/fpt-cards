export class FastScanCamera {
  constructor(mediaDevices = navigator.mediaDevices, timeoutMs = 12000, ImageCaptureClass = globalThis.ImageCapture) {
    this.mediaDevices=mediaDevices; this.timeoutMs=timeoutMs; this.stream=null; this.video=null; this.deviceId=''; this.generation=0; this.torchOn=false;
    this.ImageCaptureClass=ImageCaptureClass;this.imageCapture=null;this.refocusing=false;
    this.capabilities={focusModes:[],focusSupported:false,zoom:null,torch:false}; this.settings={}; this.zoomValue=1; this.captureIndex=0; this.preferredMode=''; this.sampleCanvas=document.createElement('canvas');this.snapshotCanvas=document.createElement('canvas');this.signatureCanvas=document.createElement('canvas');
  }
  get supported() { return Boolean(this.mediaDevices?.getUserMedia); }
  get track() { return this.stream?.getVideoTracks?.()[0] || null; }
  get torchSupported() { return Boolean(this.capabilities.torch && this.track?.applyConstraints); }
  get focusSupported() { return Boolean(this.capabilities.focusSupported && this.track?.applyConstraints); }
  get zoomSupported() { return Boolean(this.capabilities.zoom && this.track?.applyConstraints); }
  async start(video, deviceId = '') {
    this.stop(); const generation=this.generation; if(!this.supported) throw cameraError('unsupported');
    const videoConstraint=deviceId?{deviceId:{exact:deviceId},width:{ideal:2560},height:{ideal:1440}}:{facingMode:{ideal:'environment'},width:{ideal:2560},height:{ideal:1440}};
    const request=this.mediaDevices.getUserMedia({audio:false,video:videoConstraint});
    let timeout; const timeoutPromise=new Promise((_,reject)=>{timeout=setTimeout(()=>reject(cameraError('timeout')),this.timeoutMs);});
    try { this.stream=await Promise.race([request,timeoutPromise]); }
    catch(error){if(error?.code==='timeout'){request.then(stream=>stream.getTracks().forEach(track=>track.stop())).catch(()=>{});throw error;}throw cameraError(error?.name==='NotAllowedError'||error?.name==='SecurityError'?'denied':error?.name==='NotFoundError'||error?.name==='OverconstrainedError'?'unavailable':'failed',error);}
    finally { clearTimeout(timeout); }
    if(generation!==this.generation){this.stream.getTracks().forEach(track=>track.stop());this.stream=null;throw cameraError('aborted');}
    const track=this.track; this.video=video; this.deviceId=track?.getSettings?.().deviceId||deviceId; this.capabilities=readCapabilities(track); this.settings=track?.getSettings?.()||{};this.imageCapture=createImageCapture(this.ImageCaptureClass,track);
    video.srcObject=this.stream; video.muted=true; video.playsInline=true; await video.play(); await this.configureTrack(); return this.devices();
  }
  async configureTrack() {
    const track=this.track; if(!track?.applyConstraints)return;
    if(this.capabilities.focusModes.includes('continuous')) await applyAdvanced(track,{focusMode:'continuous'});
    this.settings=track.getSettings?.()||this.settings;
    this.zoomValue=Number(this.settings.zoom)||this.capabilities.zoom?.min||1;
  }
  async devices() { if(!this.mediaDevices?.enumerateDevices)return[]; return (await this.mediaDevices.enumerateDevices()).filter(item=>item.kind==='videoinput'); }
  async refocus() {
    const track=this.track; if(!this.focusSupported||!track)return false;
    this.refocusing=true;try{const modes=this.capabilities.focusModes;
      if(modes.includes('single-shot')) {
        const applied=await applyAdvanced(track,{focusMode:'single-shot'}); if(!applied)return false;
        if(modes.includes('continuous')) { await wait(180); await applyAdvanced(track,{focusMode:'continuous'}); }
        return true;
      }
      return modes.includes('continuous') ? applyAdvanced(track,{focusMode:'continuous'}) : false;
    }finally{this.refocusing=false;}
  }
  async setZoom(value) {
    const track=this.track, range=this.capabilities.zoom; if(!track||!range)return false;
    const zoom=clamp(Number(value)||range.min,range.min,range.max);const applied=await applyAdvanced(track,{zoom});if(applied){this.settings=track.getSettings?.()||{...this.settings,zoom};this.zoomValue=Number(this.settings.zoom)||zoom;}return applied;
  }
  async toggleTorch(){const track=this.track;if(!this.torchSupported||!track)return false;this.torchOn=!this.torchOn;const applied=await applyAdvanced(track,{torch:this.torchOn});if(applied)return this.torchOn;this.torchOn=false;return false;}
  preferPreprocessing(mode){if(['grayscale','adaptive'].includes(mode))this.preferredMode=mode;}
  clearPreprocessingPreference(){this.preferredMode='';}
  sample(roiElement) {
    const started=performance.now();
    const video=this.video; if(!video?.videoWidth||!video?.videoHeight)return null;
    const cropStarted=performance.now(),crop=sourceCrop(video,roiElement),cropMs=performance.now()-cropStarted; if(!crop||crop.sw<24||crop.sh<12)return null;
    const width=320,height=Math.max(38,Math.round(width*crop.sh/crop.sw)),drawStarted=performance.now();this.sampleCanvas.width=width;this.sampleCanvas.height=height;
    const ctx=this.sampleCanvas.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='medium';ctx.drawImage(video,crop.sx,crop.sy,crop.sw,crop.sh,0,0,width,height);
    const signature=this.makeSignature(ctx,width,height),drawMs=performance.now()-drawStarted,qualityStarted=performance.now(),quality=preprocessCodeImage(ctx,width,height,{mode:'grayscale'}),qualityMs=performance.now()-qualityStarted;
    return {signature,roi:crop,quality,timing:{totalMs:performance.now()-started,cropMs,drawMs,qualityMs}};
  }
  async captureSnapshot(roiElement) {
    if(this.refocusing)throw new Error('refocus-in-progress');
    const started=performance.now(),video=this.video;if(!video?.videoWidth||!video?.videoHeight)return null;
    let source=video,sourceType='video-canvas',bitmap=null,grabMs=0,completed=false;
    if(this.imageCapture?.grabFrame){const grabStarted=performance.now();try{bitmap=await this.imageCapture.grabFrame();if(bitmap?.width&&bitmap?.height){source=bitmap;sourceType='image-capture';}}catch{}grabMs=performance.now()-grabStarted;}
    try{
      const sourceWidth=Number(source.width||video.videoWidth),sourceHeight=Number(source.height||video.videoHeight),cropStarted=performance.now(),crop=sourceCrop(video,roiElement,sourceWidth,sourceHeight),cropMs=performance.now()-cropStarted;if(!crop||crop.sw<24||crop.sh<12)return null;
      const mode=this.preferredMode||(this.captureIndex%3===2?'adaptive':'grayscale');this.captureIndex+=1;
      const factor=mode==='adaptive'?2.8:2.35,target=mode==='adaptive'?1080:900,ceiling=mode==='adaptive'?1280:1120,width=Math.min(ceiling,Math.max(target,Math.round(crop.sw*factor))),height=Math.max(88,Math.round(width*crop.sh/crop.sw));
      const drawStarted=performance.now();this.snapshotCanvas.width=width;this.snapshotCanvas.height=height;const ctx=this.snapshotCanvas.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(source,crop.sx,crop.sy,crop.sw,crop.sh,0,0,width,height);const drawMs=performance.now()-drawStarted;
      const preprocessStarted=performance.now(),preprocessing=preprocessCodeImage(ctx,width,height,{mode}),preprocessMs=performance.now()-preprocessStarted,snapshot={canvas:this.snapshotCanvas,roi:crop,preprocessing,source:sourceType,resolution:{width:sourceWidth,height:sourceHeight},timing:{totalMs:performance.now()-started,grabMs,cropMs,drawMs,preprocessMs}};
      snapshot.release=()=>releaseSnapshot(snapshot);completed=true;return snapshot;
    }finally{if(!completed)clearCanvas(this.snapshotCanvas);bitmap?.close?.();bitmap=null;source=null;}
  }
  makeSignature(ctx,width,height){this.signatureCanvas.width=16;this.signatureCanvas.height=8;const sctx=this.signatureCanvas.getContext('2d',{willReadFrequently:true});sctx.drawImage(ctx.canvas,0,0,width,height,0,0,16,8);const data=sctx.getImageData(0,0,16,8).data;const values=[];for(let i=0;i<data.length;i+=4)values.push(Math.round(data[i]*.299+data[i+1]*.587+data[i+2]*.114));return values;}
  stop(){this.generation+=1;this.torchOn=false;this.refocusing=false;this.captureIndex=0;this.zoomValue=1;this.preferredMode='';this.imageCapture=null;this.stream?.getTracks?.().forEach(track=>track.stop());if(this.video)this.video.srcObject=null;this.stream=null;this.video=null;clearCanvas(this.sampleCanvas);clearCanvas(this.snapshotCanvas);this.capabilities={focusModes:[],focusSupported:false,zoom:null,torch:false};this.settings={};}
}

export function readCapabilities(track) {
  let raw={}; try { raw=track?.getCapabilities?.()||{}; } catch {}
  const focusModes=Array.isArray(raw.focusMode)?raw.focusMode.filter(mode=>['continuous','single-shot','manual'].includes(mode)):[];
  const zoom=raw.zoom&&Number.isFinite(raw.zoom.min)&&Number.isFinite(raw.zoom.max)?{min:raw.zoom.min,max:raw.zoom.max,step:raw.zoom.step||.1}:null;
  return {focusModes,focusSupported:focusModes.includes('continuous')||focusModes.includes('single-shot'),zoom,torch:Boolean(raw.torch)};
}

export function sourceCrop(video,roiElement,sourceWidth=video.videoWidth,sourceHeight=video.videoHeight) {
  const vw=sourceWidth,vh=sourceHeight; if(!vw||!vh)return null;
  const videoRect=video.getBoundingClientRect?.(); const roiRect=roiElement?.getBoundingClientRect?.();
  if(!videoRect?.width||!videoRect?.height||!roiRect?.width||!roiRect?.height)return {sx:Math.round(vw*.15),sy:Math.round(vh*.464),sw:Math.round(vw*.7),sh:Math.round(vh*.072)};
  const scale=Math.max(videoRect.width/vw,videoRect.height/vh),renderedWidth=vw*scale,renderedHeight=vh*scale;
  const offsetX=(videoRect.width-renderedWidth)/2,offsetY=(videoRect.height-renderedHeight)/2;
  const left=Math.max(videoRect.left,roiRect.left),top=Math.max(videoRect.top,roiRect.top),right=Math.min(videoRect.right,roiRect.right),bottom=Math.min(videoRect.bottom,roiRect.bottom);
  const sx=clamp((left-videoRect.left-offsetX)/scale,0,vw-1),sy=clamp((top-videoRect.top-offsetY)/scale,0,vh-1);
  const sw=clamp((right-left)/scale,1,vw-sx),sh=clamp((bottom-top)/scale,1,vh-sy);
  return {sx:Math.round(sx),sy:Math.round(sy),sw:Math.round(sw),sh:Math.round(sh)};
}

export function preprocessCodeImage(ctx,width,height,{mode='adaptive'}={}) {
  const image=ctx.getImageData(0,0,width,height),pixels=width*height,gray=new Uint8Array(pixels),histogram=new Uint32Array(256);
  for(let p=0,i=0;p<pixels;p++,i+=4){const value=Math.round(image.data[i]*.299+image.data[i+1]*.587+image.data[i+2]*.114);gray[p]=value;histogram[value]++;}
  const low=percentile(histogram,pixels,.03),high=Math.max(low+24,percentile(histogram,pixels,.97)),factor=255/(high-low);
  for(let i=0;i<pixels;i++)gray[i]=clamp(Math.round((gray[i]-low)*factor),0,255);
  const sharpness=laplacianVariance(gray,width,height);
  const sharpened=new Uint8Array(gray);
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){const i=y*width+x;sharpened[i]=clamp(Math.round(gray[i]*1.8-(gray[i-1]+gray[i+1]+gray[i-width]+gray[i+width])*.2),0,255);}
  if(mode==='grayscale'){for(let p=0;p<pixels;p++){const i=p*4;image.data[i]=image.data[i+1]=image.data[i+2]=sharpened[p];image.data[i+3]=255;}ctx.putImageData(image,0,0);return {mode,scale:high-low,low,high,sharpness};}
  const integral=new Uint32Array((width+1)*(height+1));
  for(let y=1;y<=height;y++){let row=0;for(let x=1;x<=width;x++){row+=sharpened[(y-1)*width+x-1];integral[y*(width+1)+x]=integral[(y-1)*(width+1)+x]+row;}}
  const radius=Math.max(8,Math.round(height*.1));
  for(let y=0,p=0;y<height;y++)for(let x=0;x<width;x++,p++){const x0=Math.max(0,x-radius),y0=Math.max(0,y-radius),x1=Math.min(width-1,x+radius),y1=Math.min(height-1,y+radius);const stride=width+1;const sum=integral[(y1+1)*stride+x1+1]-integral[y0*stride+x1+1]-integral[(y1+1)*stride+x0]+integral[y0*stride+x0];const mean=sum/((x1-x0+1)*(y1-y0+1));const value=sharpened[p]>mean-9?255:0;const i=p*4;image.data[i]=image.data[i+1]=image.data[i+2]=value;image.data[i+3]=255;}
  ctx.putImageData(image,0,0); return {mode:'adaptive',scale:high-low,low,high,sharpness};
}

async function applyAdvanced(track,constraint){try{await track.applyConstraints({advanced:[constraint]});return true;}catch{return false;}}
function createImageCapture(ImageCaptureClass,track){if(!ImageCaptureClass||!track)return null;try{return new ImageCaptureClass(track);}catch{return null;}}
function releaseSnapshot(snapshot){const canvas=snapshot?.canvas;if(canvas){clearCanvas(canvas);snapshot.canvas=null;}snapshot.roi=null;snapshot.release=()=>{};}
function clearCanvas(canvas){if(!canvas)return;try{canvas.getContext?.('2d')?.clearRect?.(0,0,canvas.width||0,canvas.height||0);}catch{}canvas.width=0;canvas.height=0;}
function percentile(histogram,total,ratio){let count=0,target=total*ratio;for(let value=0;value<256;value++){count+=histogram[value];if(count>=target)return value;}return 255;}
function laplacianVariance(gray,width,height){let sum=0,sumSquares=0,count=0;for(let y=2;y<height-2;y+=2)for(let x=2;x<width-2;x+=2){const i=y*width+x,value=(gray[i]*4)-gray[i-1]-gray[i+1]-gray[i-width]-gray[i+width];sum+=value;sumSquares+=value*value;count++;}if(!count)return 0;const mean=sum/count;return Math.max(0,(sumSquares/count)-(mean*mean));}
function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function cameraError(code,cause){const error=new Error(({unsupported:'Fotocamera non supportata dal browser',denied:'Permesso fotocamera negato',unavailable:'Nessuna fotocamera disponibile',timeout:'La fotocamera non ha risposto: prova da Safari o cambia camera',aborted:'Avvio fotocamera annullato',failed:'Impossibile avviare la fotocamera'})[code]);error.code=code;error.cause=cause;return error;}
