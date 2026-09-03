export class FastScanCamera {
  constructor(mediaDevices = navigator.mediaDevices, timeoutMs = 12000, ImageCaptureClass = globalThis.ImageCapture) {
    this.mediaDevices=mediaDevices; this.timeoutMs=timeoutMs; this.stream=null; this.video=null; this.deviceId=''; this.generation=0; this.torchOn=false;
    this.ImageCaptureClass=ImageCaptureClass;this.imageCapture=null;this.imageCaptureUnstable=false;this.snapshotErrors=0;this.lastGrabError='';this.constraintErrors=[];this.refocusing=false;this.trackListeners=null;this.trackStartedAt=0;this.lastFrameAt=0;this.mutedAt=0;this.blackFrameStreak=0;this.lastTrackEvent='';this.onDiagnostic=null;
    this.capabilities={focusModes:[],focusSupported:false,zoom:null,torch:false}; this.settings={}; this.zoomValue=1; this.captureIndex=0; this.preferredMode=''; this.sampleCanvas=document.createElement('canvas');this.snapshotCanvas=document.createElement('canvas');this.signatureCanvas=document.createElement('canvas');
  }
  get supported() { return Boolean(this.mediaDevices?.getUserMedia); }
  get track() { return this.stream?.getVideoTracks?.()[0] || null; }
  get torchSupported() { return Boolean(this.capabilities.torch && this.track?.applyConstraints); }
  get focusSupported() { return Boolean(this.capabilities.focusSupported && this.track?.applyConstraints); }
  get zoomSupported() { return Boolean(this.capabilities.zoom && this.track?.applyConstraints); }
  async start(video, deviceId = '') {
    this.stop('restart-before-start'); const generation=this.generation; if(!this.supported) throw cameraError('unsupported');this.diagnostic('start-request',{generation,deviceId:deviceId||'environment'});
    const videoConstraint=deviceId?{deviceId:{exact:deviceId},width:{ideal:1920},height:{ideal:1080}}:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}};
    const request=this.mediaDevices.getUserMedia({audio:false,video:videoConstraint});
    let timeout; const timeoutPromise=new Promise((_,reject)=>{timeout=setTimeout(()=>reject(cameraError('timeout')),this.timeoutMs);});
    let acquired=null;try { acquired=await Promise.race([request,timeoutPromise]); }
    catch(error){if(error?.code==='timeout'){request.then(stream=>stream.getTracks().forEach(track=>track.stop())).catch(()=>{});throw error;}throw cameraError(error?.name==='NotAllowedError'||error?.name==='SecurityError'?'denied':error?.name==='NotFoundError'||error?.name==='OverconstrainedError'?'unavailable':'failed',error);}
    finally { clearTimeout(timeout); }
    if(generation!==this.generation){acquired?.getTracks?.().forEach(track=>track.stop());this.diagnostic('start-aborted',{generation,currentGeneration:this.generation});throw cameraError('aborted');}
    this.stream=acquired;
    const track=this.track; this.video=video; this.deviceId=track?.getSettings?.().deviceId||deviceId; this.capabilities=readCapabilities(track); this.settings=track?.getSettings?.()||{};this.imageCapture=this.imageCaptureUnstable?null:createImageCapture(this.ImageCaptureClass,track);this.attachTrackHealth(track);
    video.srcObject=this.stream; video.muted=true; video.playsInline=true; await video.play(); await this.configureTrack();this.diagnostic('start-ready',this.stateSnapshot());return this.devices();
  }
  async configureTrack() {
    const track=this.track; if(!track?.applyConstraints)return;
    if(this.capabilities.focusModes.includes('continuous')) await this.applyConstraint({focusMode:'continuous'});
    this.settings=track.getSettings?.()||this.settings;
    this.zoomValue=Number(this.settings.zoom)||this.capabilities.zoom?.min||1;
  }
  async devices() { if(!this.mediaDevices?.enumerateDevices)return[]; return (await this.mediaDevices.enumerateDevices()).filter(item=>item.kind==='videoinput'); }
  async refocus() {
    const track=this.track; if(!this.focusSupported||!track)return false;
    this.refocusing=true;try{const modes=this.capabilities.focusModes;
      if(modes.includes('single-shot')) {
        const applied=await this.applyConstraint({focusMode:'single-shot'}); if(!applied)return false;
        if(modes.includes('continuous')) { await wait(180); await this.applyConstraint({focusMode:'continuous'}); }
        return true;
      }
      return modes.includes('continuous') ? this.applyConstraint({focusMode:'continuous'}) : false;
    }finally{this.refocusing=false;}
  }
  async setZoom(value) {
    const track=this.track, range=this.capabilities.zoom; if(!track||!range)return false;
    const zoom=clamp(Number(value)||range.min,range.min,range.max);const applied=await this.applyConstraint({zoom});if(applied){this.settings=track.getSettings?.()||{...this.settings,zoom};this.zoomValue=Number(this.settings.zoom)||zoom;}return applied;
  }
  async toggleTorch(){const track=this.track;if(!this.torchSupported||!track)return false;this.torchOn=!this.torchOn;const applied=await this.applyConstraint({torch:this.torchOn});if(applied)return this.torchOn;this.torchOn=false;return false;}
  async applyConstraint(constraint){const track=this.track;if(!track?.applyConstraints)return false;try{await track.applyConstraints({advanced:[constraint]});return true;}catch(error){this.constraintErrors.push({constraint:Object.keys(constraint)[0],message:error?.message||'applyConstraints failed',at:new Date().toISOString()});if(this.constraintErrors.length>12)this.constraintErrors.shift();return false;}}
  preferPreprocessing(mode){if(['grayscale','adaptive'].includes(mode))this.preferredMode=mode;}
  clearPreprocessingPreference(){this.preferredMode='';}
  attachTrackHealth(track){
    this.detachTrackHealth();this.trackStartedAt=performance.now();this.lastFrameAt=0;this.mutedAt=track?.muted?performance.now():0;this.blackFrameStreak=0;this.lastTrackEvent='attached';if(!track?.addEventListener)return;
    const ended=()=>{this.lastTrackEvent='ended';this.diagnostic('track-ended',this.stateSnapshot());},mute=()=>{this.lastTrackEvent='mute';this.mutedAt=performance.now();this.diagnostic('track-muted',this.stateSnapshot());},unmute=()=>{this.lastTrackEvent='unmute';this.mutedAt=0;this.blackFrameStreak=0;this.diagnostic('track-unmuted',this.stateSnapshot());};track.addEventListener('ended',ended);track.addEventListener('mute',mute);track.addEventListener('unmute',unmute);this.trackListeners={track,ended,mute,unmute};
  }
  detachTrackHealth(){const item=this.trackListeners;if(item?.track?.removeEventListener){item.track.removeEventListener('ended',item.ended);item.track.removeEventListener('mute',item.mute);item.track.removeEventListener('unmute',item.unmute);}this.trackListeners=null;}
  markImageCaptureUnstable(reason='unstable'){this.imageCaptureUnstable=true;this.imageCapture=null;this.lastGrabError=reason;}
  resetSnapshotStrategy(){this.imageCaptureUnstable=false;this.snapshotErrors=0;this.lastGrabError='';this.constraintErrors=[];}
  healthIssue(now=performance.now()){
    const track=this.track;if(!track)return 'missing-track';if(this.stream?.active===false)return 'inactive-stream';if(this.lastTrackEvent==='ended')return 'track-ended';if(track.readyState&&track.readyState!=='live')return `track-${track.readyState}`;if(track.enabled===false)return 'track-disabled';if((track.muted||this.mutedAt)&&(this.mutedAt?now-this.mutedAt:0)>1200)return 'track-muted';if(this.blackFrameStreak>=8)return 'black-preview';if(this.video&&(!this.video.videoWidth||!this.video.videoHeight)&&now-this.trackStartedAt>1800)return 'no-video-frame';return '';
  }
  stateSnapshot(){const track=this.track,settings=track?.getSettings?.()||this.settings||{};return {streamActive:this.stream?.active!==false,srcObjectConnected:Boolean(this.video&&this.video.srcObject===this.stream),readyState:track?.readyState||'unknown',enabled:track?.enabled!==false,muted:Boolean(track?.muted),resolution:{width:Number(settings.width||this.video?.videoWidth||0),height:Number(settings.height||this.video?.videoHeight||0)},snapshotSource:this.imageCapture&&!this.imageCaptureUnstable?'ImageCapture':'canvas',imageCaptureUnstable:this.imageCaptureUnstable,snapshotErrors:this.snapshotErrors,lastGrabError:this.lastGrabError,lastTrackEvent:this.lastTrackEvent,lastFrameAt:this.lastFrameAt,blackFrameStreak:this.blackFrameStreak,constraintErrors:[...this.constraintErrors]};}
  sample(roiElement) {
    const started=performance.now();
    const video=this.video; if(!video?.videoWidth||!video?.videoHeight)return null;
    const cropStarted=performance.now(),crop=sourceCrop(video,roiElement),cropMs=performance.now()-cropStarted; if(!crop||crop.sw<24||crop.sh<12)return null;
    const width=320,height=Math.max(38,Math.round(width*crop.sh/crop.sw)),drawStarted=performance.now();this.sampleCanvas.width=width;this.sampleCanvas.height=height;
    const ctx=this.sampleCanvas.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='medium';ctx.drawImage(video,crop.sx,crop.sy,crop.sw,crop.sh,0,0,width,height);
    const signature=this.makeSignature(ctx,width,height),drawMs=performance.now()-drawStarted,qualityStarted=performance.now(),quality=preprocessCodeImage(ctx,width,height,{mode:'grayscale',metricsOnly:true}),qualityMs=performance.now()-qualityStarted;this.lastFrameAt=performance.now();this.blackFrameStreak=quality.meanLuma<2?this.blackFrameStreak+1:0;
    return {signature,roi:crop,quality,timing:{totalMs:performance.now()-started,cropMs,drawMs,qualityMs}};
  }
  async captureSnapshot(roiElement,{preferVideoFrame=false,includeRaw=false}={}) {
    if(this.refocusing)throw new Error('refocus-in-progress');
    const started=performance.now(),video=this.video;if(!video?.videoWidth||!video?.videoHeight)return null;
    let source=video,sourceType='video-canvas',bitmap=null,rawCanvas=null,grabMs=0,completed=false;
    if(!preferVideoFrame&&this.imageCapture?.grabFrame&&!this.imageCaptureUnstable){const grabStarted=performance.now();try{bitmap=await this.imageCapture.grabFrame();if(bitmap?.width&&bitmap?.height){const previewAspect=video.videoWidth/video.videoHeight,bitmapAspect=bitmap.width/bitmap.height;if(Math.abs(previewAspect-bitmapAspect)/previewAspect<=.025){source=bitmap;sourceType='image-capture';}else{this.markImageCaptureUnstable('aspect-ratio-mismatch');bitmap.close?.();bitmap=null;}}}catch(error){this.snapshotErrors+=1;this.markImageCaptureUnstable(error?.message||'grabFrame failed');bitmap=null;}grabMs=performance.now()-grabStarted;}
    try{
      const sourceWidth=Number(source.width||video.videoWidth),sourceHeight=Number(source.height||video.videoHeight),cropStarted=performance.now(),mapping=sourceCropDetails(video,roiElement),previewRoi=mapping.crop,crop=sourceType==='image-capture'?mapCropToSource(previewRoi,video.videoWidth,video.videoHeight,sourceWidth,sourceHeight):previewRoi,cropMs=performance.now()-cropStarted;if(!crop||crop.sw<24||crop.sh<12)return null;
      const mode=this.preferredMode||(this.captureIndex%3===2?'adaptive':'grayscale');this.captureIndex+=1;
      const factor=mode==='adaptive'?2.8:2.35,target=mode==='adaptive'?1080:900,ceiling=mode==='adaptive'?1280:1120,width=Math.min(ceiling,Math.max(target,Math.round(crop.sw*factor))),height=Math.max(88,Math.round(width*crop.sh/crop.sw));
      const drawStarted=performance.now();this.snapshotCanvas.width=width;this.snapshotCanvas.height=height;const ctx=this.snapshotCanvas.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(source,crop.sx,crop.sy,crop.sw,crop.sh,0,0,width,height);const frameCapturedAt=performance.now(),frameCapturedWallAt=new Date().toISOString();if(includeRaw)rawCanvas=cloneCanvas(this.snapshotCanvas);const drawMs=performance.now()-drawStarted;
      const preprocessStarted=performance.now(),preprocessing=preprocessCodeImage(ctx,width,height,{mode,metricsOnly:includeRaw}),preprocessMs=performance.now()-preprocessStarted,snapshot={canvas:this.snapshotCanvas,rawCanvas,previewRoi,roi:crop,preprocessing,alternates:[],mapping:{...mapping,snapshotCrop:crop,sourceWidth,sourceHeight},source:sourceType,resolution:{width:sourceWidth,height:sourceHeight},frameCapturedAt,frameCapturedWallAt,timing:{totalMs:performance.now()-started,grabMs,cropMs,drawMs,preprocessMs}};
      snapshot.release=()=>releaseSnapshot(snapshot);completed=true;return snapshot;
    }finally{if(!completed){clearCanvas(this.snapshotCanvas);clearCanvas(rawCanvas);}bitmap?.close?.();bitmap=null;rawCanvas=null;source=null;}
  }
  makeSignature(ctx,width,height){this.signatureCanvas.width=16;this.signatureCanvas.height=8;const sctx=this.signatureCanvas.getContext('2d',{willReadFrequently:true});sctx.drawImage(ctx.canvas,0,0,width,height,0,0,16,8);const data=sctx.getImageData(0,0,16,8).data;const values=[];for(let i=0;i<data.length;i+=4)values.push(Math.round(data[i]*.299+data[i+1]*.587+data[i+2]*.114));return values;}
  diagnostic(event,payload={}){this.onDiagnostic?.(event,payload);}
  stop(reason='explicit'){const snapshot=this.stream?this.stateSnapshot():null;this.generation+=1;this.torchOn=false;this.refocusing=false;this.captureIndex=0;this.zoomValue=1;this.preferredMode='';this.imageCapture=null;this.detachTrackHealth();this.stream?.getTracks?.().forEach(track=>track.stop());if(this.video)this.video.srcObject=null;this.stream=null;this.video=null;clearCanvas(this.sampleCanvas);clearCanvas(this.snapshotCanvas);this.capabilities={focusModes:[],focusSupported:false,zoom:null,torch:false};this.settings={};if(snapshot)this.diagnostic('stop',{reason,generation:this.generation,before:snapshot});}
}

export function readCapabilities(track) {
  let raw={}; try { raw=track?.getCapabilities?.()||{}; } catch {}
  const focusModes=Array.isArray(raw.focusMode)?raw.focusMode.filter(mode=>['continuous','single-shot','manual'].includes(mode)):[];
  const zoom=raw.zoom&&Number.isFinite(raw.zoom.min)&&Number.isFinite(raw.zoom.max)?{min:raw.zoom.min,max:raw.zoom.max,step:raw.zoom.step||.1}:null;
  return {focusModes,focusSupported:focusModes.includes('continuous')||focusModes.includes('single-shot'),zoom,torch:Boolean(raw.torch)};
}

export function sourceCrop(video,roiElement,sourceWidth=video.videoWidth,sourceHeight=video.videoHeight) {return sourceCropDetails(video,roiElement,sourceWidth,sourceHeight)?.crop||null;}
export function sourceCropDetails(video,roiElement,sourceWidth=video.videoWidth,sourceHeight=video.videoHeight) {
  const vw=sourceWidth,vh=sourceHeight; if(!vw||!vh)return null;
  const videoRect=video.getBoundingClientRect?.(); const roiRect=roiElement?.getBoundingClientRect?.();
  if(!videoRect?.width||!videoRect?.height||!roiRect?.width||!roiRect?.height){const crop={sx:Math.round(vw*.15),sy:Math.round(vh*.464),sw:Math.round(vw*.7),sh:Math.round(vh*.072)};return {crop,videoRect:null,roiRect:null,videoWidth:vw,videoHeight:vh,scale:null,offsetX:null,offsetY:null};}
  const scale=Math.max(videoRect.width/vw,videoRect.height/vh),renderedWidth=vw*scale,renderedHeight=vh*scale;
  const offsetX=(videoRect.width-renderedWidth)/2,offsetY=(videoRect.height-renderedHeight)/2;
  const left=Math.max(videoRect.left,roiRect.left),top=Math.max(videoRect.top,roiRect.top),right=Math.min(videoRect.right,roiRect.right),bottom=Math.min(videoRect.bottom,roiRect.bottom);
  const sx=clamp((left-videoRect.left-offsetX)/scale,0,vw-1),sy=clamp((top-videoRect.top-offsetY)/scale,0,vh-1);
  const sw=clamp((right-left)/scale,1,vw-sx),sh=clamp((bottom-top)/scale,1,vh-sy);
  const crop={sx:Math.round(sx),sy:Math.round(sy),sw:Math.round(sw),sh:Math.round(sh)};return {crop,videoRect:rectData(videoRect),roiRect:rectData(roiRect),videoWidth:vw,videoHeight:vh,scale,renderedWidth,renderedHeight,offsetX,offsetY,devicePixelRatio:Number(globalThis.devicePixelRatio||1),videoTransform:readVideoTransform(video),viewport:{width:Number(globalThis.innerWidth||0),height:Number(globalThis.innerHeight||0),visualWidth:Number(globalThis.visualViewport?.width||0),visualHeight:Number(globalThis.visualViewport?.height||0),orientation:globalThis.innerWidth>globalThis.innerHeight?'landscape':'portrait'}};
}

export function mapCropToSource(crop,fromWidth,fromHeight,toWidth,toHeight){if(!crop||!fromWidth||!fromHeight||!toWidth||!toHeight)return null;const scaleX=toWidth/fromWidth,scaleY=toHeight/fromHeight,sx=clamp(Math.round(crop.sx*scaleX),0,toWidth-1),sy=clamp(Math.round(crop.sy*scaleY),0,toHeight-1);return {sx,sy,sw:clamp(Math.round(crop.sw*scaleX),1,toWidth-sx),sh:clamp(Math.round(crop.sh*scaleY),1,toHeight-sy)};}

export function preprocessCodeImage(ctx,width,height,{mode='adaptive',metricsOnly=false}={}) {
  const image=ctx.getImageData(0,0,width,height),pixels=width*height,gray=new Uint8Array(pixels),histogram=new Uint32Array(256);let lumaSum=0;
  for(let p=0,i=0;p<pixels;p++,i+=4){const value=Math.round(image.data[i]*.299+image.data[i+1]*.587+image.data[i+2]*.114);gray[p]=value;histogram[value]++;lumaSum+=value;}
  const low=percentile(histogram,pixels,.03),high=Math.max(low+24,percentile(histogram,pixels,.97)),factor=255/(high-low);
  for(let i=0;i<pixels;i++)gray[i]=clamp(Math.round((gray[i]-low)*factor),0,255);
  const sharpness=laplacianVariance(gray,width,height),meanLuma=lumaSum/Math.max(1,pixels);
  // Health checks (preview sample) and the blur read at capture time only need
  // these scalars; skipping the pixel writeback here avoids redoing the same
  // sharpen/threshold pass a second time once createOcrInputPlan runs it for real.
  if(metricsOnly)return {mode,scale:high-low,low,high,sharpness,meanLuma};
  if(mode==='grayscale'){for(let p=0;p<pixels;p++){const i=p*4,value=clamp(Math.round(16+gray[p]*.875),0,255);image.data[i]=image.data[i+1]=image.data[i+2]=value;image.data[i+3]=255;}ctx.putImageData(image,0,0);return {mode,scale:high-low,low,high,sharpness,meanLuma,sharpen:false,threshold:false};}
  const sharpened=new Uint8Array(gray);
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){const i=y*width+x;sharpened[i]=clamp(Math.round(gray[i]*1.8-(gray[i-1]+gray[i+1]+gray[i-width]+gray[i+width])*.2),0,255);}
  const integral=new Uint32Array((width+1)*(height+1));
  for(let y=1;y<=height;y++){let row=0;for(let x=1;x<=width;x++){row+=sharpened[(y-1)*width+x-1];integral[y*(width+1)+x]=integral[(y-1)*(width+1)+x]+row;}}
  const radius=Math.max(8,Math.round(height*.1));
  for(let y=0,p=0;y<height;y++)for(let x=0;x<width;x++,p++){const x0=Math.max(0,x-radius),y0=Math.max(0,y-radius),x1=Math.min(width-1,x+radius),y1=Math.min(height-1,y+radius);const stride=width+1;const sum=integral[(y1+1)*stride+x1+1]-integral[y0*stride+x1+1]-integral[(y1+1)*stride+x0]+integral[y0*stride+x0];const mean=sum/((x1-x0+1)*(y1-y0+1));const value=sharpened[p]>mean-9?255:0;const i=p*4;image.data[i]=image.data[i+1]=image.data[i+2]=value;image.data[i+3]=255;}
  ctx.putImageData(image,0,0); return {mode:'adaptive',scale:high-low,low,high,sharpness,meanLuma};
}

function createImageCapture(ImageCaptureClass,track){if(!ImageCaptureClass||!track)return null;try{return new ImageCaptureClass(track);}catch{return null;}}
function releaseSnapshot(snapshot){const canvas=snapshot?.canvas;if(canvas){clearCanvas(canvas);snapshot.canvas=null;}clearCanvas(snapshot?.rawCanvas);snapshot.rawCanvas=null;for(const alternate of snapshot?.alternates||[])clearCanvas(alternate?.canvas);snapshot.alternates=[];snapshot.roi=null;snapshot.release=()=>{};}
function cloneCanvas(source){const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;const context=canvas.getContext('2d',{willReadFrequently:true});context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(source,0,0);return canvas;}
function rectData(rect){return {left:round3(rect.left),top:round3(rect.top),width:round3(rect.width),height:round3(rect.height),right:round3(rect.right),bottom:round3(rect.bottom)};}
function readVideoTransform(video){try{return globalThis.getComputedStyle?.(video)?.transform||'none';}catch{return 'unknown';}}
function round3(value){return Math.round(Number(value)*1000)/1000;}
function clearCanvas(canvas){if(!canvas)return;try{canvas.getContext?.('2d')?.clearRect?.(0,0,canvas.width||0,canvas.height||0);}catch{}canvas.width=0;canvas.height=0;}
function percentile(histogram,total,ratio){let count=0,target=total*ratio;for(let value=0;value<256;value++){count+=histogram[value];if(count>=target)return value;}return 255;}
function laplacianVariance(gray,width,height){let sum=0,sumSquares=0,count=0;for(let y=2;y<height-2;y+=2)for(let x=2;x<width-2;x+=2){const i=y*width+x,value=(gray[i]*4)-gray[i-1]-gray[i+1]-gray[i-width]-gray[i+width];sum+=value;sumSquares+=value*value;count++;}if(!count)return 0;const mean=sum/count;return Math.max(0,(sumSquares/count)-(mean*mean));}
function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function cameraError(code,cause){const error=new Error(({unsupported:'Fotocamera non supportata dal browser',denied:'Permesso fotocamera negato',unavailable:'Nessuna fotocamera disponibile',timeout:'La fotocamera non ha risposto: prova da Safari o cambia camera',aborted:'Avvio fotocamera annullato',failed:'Impossibile avviare la fotocamera'})[code]);error.code=code;error.cause=cause;return error;}
