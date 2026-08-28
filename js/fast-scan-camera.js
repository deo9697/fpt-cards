export class FastScanCamera {
  constructor(mediaDevices = navigator.mediaDevices, timeoutMs = 12000) { this.mediaDevices=mediaDevices; this.timeoutMs=timeoutMs; this.stream=null; this.video=null; this.deviceId=''; this.generation=0; this.torchOn=false; this.canvas=document.createElement('canvas'); this.signatureCanvas=document.createElement('canvas'); }
  get supported() { return Boolean(this.mediaDevices?.getUserMedia); }
  async start(video, deviceId = '') {
    this.stop(); const generation=this.generation; if(!this.supported) throw cameraError('unsupported');
    const videoConstraint=deviceId?{deviceId:{exact:deviceId}}:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}};
    const request=this.mediaDevices.getUserMedia({audio:false,video:videoConstraint});
    let timeout; const timeoutPromise=new Promise((_,reject)=>{timeout=setTimeout(()=>reject(cameraError('timeout')),this.timeoutMs);});
    try { this.stream=await Promise.race([request,timeoutPromise]); }
    catch(error){if(error?.code==='timeout'){request.then(stream=>stream.getTracks().forEach(track=>track.stop())).catch(()=>{});throw error;}throw cameraError(error?.name==='NotAllowedError'||error?.name==='SecurityError'?'denied':error?.name==='NotFoundError'||error?.name==='OverconstrainedError'?'unavailable':'failed',error);}
    finally { clearTimeout(timeout); }
    if(generation!==this.generation){this.stream.getTracks().forEach(track=>track.stop());this.stream=null;throw cameraError('aborted');}
    this.video=video; this.deviceId=this.stream.getVideoTracks()[0]?.getSettings?.().deviceId||deviceId;
    video.srcObject=this.stream; video.muted=true; video.playsInline=true; await video.play(); return this.devices();
  }
  async devices() { if(!this.mediaDevices?.enumerateDevices)return[]; return (await this.mediaDevices.enumerateDevices()).filter(item=>item.kind==='videoinput'); }
  get torchSupported(){const track=this.stream?.getVideoTracks?.()[0];return Boolean(track?.getCapabilities?.().torch&&track?.applyConstraints);}
  async toggleTorch(){const track=this.stream?.getVideoTracks?.()[0];if(!this.torchSupported||!track)return false;this.torchOn=!this.torchOn;try{await track.applyConstraints({advanced:[{torch:this.torchOn}]});return this.torchOn;}catch{this.torchOn=false;return false;}}
  capture() {
    const video=this.video; if(!video?.videoWidth||!video?.videoHeight)return null;
    const landscape=video.videoWidth>=video.videoHeight;
    const roi=landscape?{x:.43,y:.62,w:.54,h:.22}:{x:.08,y:.62,w:.84,h:.18};
    const sx=Math.round(video.videoWidth*roi.x),sy=Math.round(video.videoHeight*roi.y),sw=Math.round(video.videoWidth*roi.w),sh=Math.round(video.videoHeight*roi.h);
    const width=900,height=Math.max(110,Math.round(width*sh/sw)); this.canvas.width=width;this.canvas.height=height;
    const ctx=this.canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(video,sx,sy,sw,sh,0,0,width,height);
    const signature=this.makeSignature(ctx,width,height); const image=ctx.getImageData(0,0,width,height); let mean=0;
    for(let index=0;index<image.data.length;index+=4) mean+=(image.data[index]*.299+image.data[index+1]*.587+image.data[index+2]*.114);
    mean/=image.data.length/4; const threshold=Math.max(75,Math.min(190,mean*.9));
    for(let index=0;index<image.data.length;index+=4){const gray=image.data[index]*.299+image.data[index+1]*.587+image.data[index+2]*.114;const value=gray>threshold?255:0;image.data[index]=image.data[index+1]=image.data[index+2]=value;}
    ctx.putImageData(image,0,0); return {canvas:this.canvas,signature};
  }
  makeSignature(ctx,width,height){this.signatureCanvas.width=16;this.signatureCanvas.height=8;const sctx=this.signatureCanvas.getContext('2d',{willReadFrequently:true});sctx.drawImage(ctx.canvas,0,0,width,height,0,0,16,8);const data=sctx.getImageData(0,0,16,8).data;const values=[];for(let i=0;i<data.length;i+=4)values.push(Math.round(data[i]*.299+data[i+1]*.587+data[i+2]*.114));return values;}
  stop(){this.generation+=1;this.torchOn=false;this.stream?.getTracks?.().forEach(track=>track.stop());if(this.video)this.video.srcObject=null;this.stream=null;this.video=null;}
}

function cameraError(code,cause){const error=new Error(({unsupported:'Fotocamera non supportata dal browser',denied:'Permesso fotocamera negato',unavailable:'Nessuna fotocamera disponibile',timeout:'La fotocamera non ha risposto: prova da Safari o cambia camera',aborted:'Avvio fotocamera annullato',failed:'Impossibile avviare la fotocamera'})[code]);error.code=code;error.cause=cause;return error;}
