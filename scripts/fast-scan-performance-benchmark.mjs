import { performance } from 'node:perf_hooks';
import { preprocessCodeImage } from '../js/fast-scan-camera.js';
import { normalizeSetCode, setCodeCandidates } from '../js/fast-scan-core.js';

function fixture(width,height,variant=0){
  const data=new Uint8ClampedArray(width*height*4);
  for(let y=0,p=0;y<height;y++)for(let x=0;x<width;x++,p++){
    const stripe=((x+variant*7)%83)<12,glare=Math.abs(x-width*.63)<width*.035;
    const value=glare?238:stripe?34:172+Math.round(28*Math.sin((x+y)/19));
    const offset=p*4;data[offset]=data[offset+1]=data[offset+2]=value;data[offset+3]=255;
  }
  return data;
}

function benchmarkPreprocess(width,mode,runs=12){
  const height=Math.round(width*.13),samples=[];let sharpness=0;
  for(let warmup=0;warmup<2;warmup++){const image={data:fixture(width,height,warmup)};preprocessCodeImage({getImageData:()=>image,putImageData:()=>{}},width,height,{mode});}
  for(let run=0;run<runs;run++){
    const image={data:fixture(width,height,run)};const ctx={getImageData:()=>image,putImageData:()=>{}};
    const start=performance.now();const result=preprocessCodeImage(ctx,width,height,{mode});samples.push(performance.now()-start);sharpness=result.sharpness;
  }
  return {width,height,mode,meanMs:mean(samples),p95Ms:percentile(samples,.95),pixels:width*height,sharpness};
}

const preprocess=[];
for(const width of [900,1080,1280])for(const mode of ['grayscale','adaptive'])preprocess.push(benchmarkPreprocess(width,mode));
const pipelineComparison={
  previousLive:{scheduleMs:720,frames:[benchmarkPreprocess(960,'grayscale'),benchmarkPreprocess(1440,'adaptive')]},
  snapshot:{stabilityFrames:2,estimatedStabilityMs:160,liveQualitySample:benchmarkPreprocess(320,'grayscale'),frames:[benchmarkPreprocess(900,'grayscale'),benchmarkPreprocess(1280,'adaptive')]},
  scope:'CPU sintetica: non include latenza PaddleOCR, autofocus o ImageCapture del dispositivo'
};
const codes=['L26D-ENX40','L26D-ENX4O','TDGS-IT001','TDGS-EN001','LOB-001','TG-ZDEJ7'];
const parsingStart=performance.now();for(let index=0;index<20000;index++){const code=codes[index%codes.length];normalizeSetCode(code);setCodeCandidates(code);}const parsingMs=performance.now()-parsingStart;
console.log(JSON.stringify({preprocess,pipelineComparison,normalizationAndCandidates:{operations:40000,totalMs:parsingMs,meanMs:parsingMs/40000}},null,2));

function mean(values){return values.reduce((sum,value)=>sum+value,0)/values.length;}
function percentile(values,ratio){const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*ratio))];}
