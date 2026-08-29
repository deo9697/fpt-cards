const CONFUSION_GROUPS=['O0','I1','S5','B8','Z2','G6'];
const CONFUSIONS=new Set(CONFUSION_GROUPS.flatMap(group=>[`${group[0]}${group[1]}`,`${group[1]}${group[0]}`]));

export function normalizeRankCode(value=''){
  return String(value).toUpperCase().replace(/[‐‑‒–—−]/g,'-').replace(/\s+/g,'').replace(/[^A-Z0-9-]/g,'');
}

export function setCodeDistance(left,right){
  const a=normalizeRankCode(left),b=normalizeRankCode(right);if(a===b)return 0;if(!a.length)return b.length;if(!b.length)return a.length;
  let previous=Array.from({length:b.length+1},(_,index)=>index),beforePrevious=null;
  for(let i=1;i<=a.length;i+=1){const current=[i];for(let j=1;j<=b.length;j+=1){const substitution=a[i-1]===b[j-1]?0:CONFUSIONS.has(`${a[i-1]}${b[j-1]}`)?.25:1;let cost=Math.min(previous[j]+1,current[j-1]+1,previous[j-1]+substitution);if(beforePrevious&&i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])cost=Math.min(cost,beforePrevious[j-2]+.75);current[j]=cost;}beforePrevious=previous;previous=current;}
  return Math.round(previous[b.length]*100)/100;
}

function prefixOf(code){const dash=code.indexOf('-');return dash>=3?code.slice(0,dash+1):'';}
function structuralPenalty(ocr,candidate){const ocrDash=ocr.indexOf('-'),candidateDash=candidate.indexOf('-');let penalty=0;if((ocrDash<0)!==(candidateDash<0))penalty+=.75;else if(ocrDash>=0&&ocrDash!==candidateDash)penalty+=Math.min(1,Math.abs(ocrDash-candidateDash)*.35);if(Math.abs(ocr.length-candidate.length)>2)penalty+=.5;return penalty;}

export function rankSetCodeCandidates(ocrText,knownSetCodes=[]){
  const ocr=normalizeRankCode(ocrText),known=[...new Set((knownSetCodes||[]).map(normalizeRankCode).filter(Boolean))],ocrPrefix=prefixOf(ocr),matchingPrefix=ocrPrefix&&known.some(code=>prefixOf(code)===ocrPrefix);
  const ranked=known.map(candidate=>{const prefix=prefixOf(candidate),baseDistance=setCodeDistance(ocr,candidate),penalty=structuralPenalty(ocr,candidate),prefixPenalty=ocrPrefix&&prefix&&ocrPrefix!==prefix?(matchingPrefix?2:.5):0,distance=Math.round((baseDistance+penalty+prefixPenalty)*100)/100;return {candidate,distance,editDistance:baseDistance,normalizedDistance:Math.round(distance/Math.max(1,ocr.length,candidate.length)*1000)/1000,prefixMatch:Boolean(ocrPrefix&&prefix===ocrPrefix)};}).sort((left,right)=>left.distance-right.distance||Number(right.prefixMatch)-Number(left.prefixMatch)||left.candidate.localeCompare(right.candidate));
  const best=ranked[0]||null,second=ranked[1]||null;if(!best)return {classification:'reject',bestCandidate:'',distance:null,normalizedDistance:null,unique:false,prefix:ocrPrefix,knownCount:known.length,ranked:[]};
  const exact=best.editDistance===0&&best.distance===0,near=best.distance<=1.5&&best.normalizedDistance<=.16,plausible=best.distance<=2&&best.normalizedDistance<=.22,margin=second?second.distance-best.distance:Infinity,unique=exact||(near&&margin>=.5);let classification='reject';if(exact)classification='exact';else if(near&&unique)classification='near';else if(near||(plausible&&margin<.5))classification='ambiguous';
  return {classification,bestCandidate:best.candidate,distance:best.distance,normalizedDistance:best.normalizedDistance,unique,prefix:ocrPrefix,knownCount:known.length,ranked:ranked.slice(0,5)};
}
