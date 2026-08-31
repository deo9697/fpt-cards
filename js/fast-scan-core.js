const STRICT_SET_CODE = /^[A-Z0-9]{2,12}-[A-Z0-9]{2,10}$/;
const OCR_SWAPS = {O:['0'],0:['O'],I:['1','L','T'],1:['I','L','T'],L:['I','1'],T:['I','1'],S:['5'],5:['S','3'],3:['5'],B:['8'],8:['B'],Z:['2'],2:['Z'],G:['6'],6:['G']};
const REGION_CODES = ['IT','EN','DE','FR','SP','PT','ENC',...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter=>`EN${letter}`)];
export const SCAN_DECISION = Object.freeze({EXACT_UNIQUE:'EXACT_UNIQUE',NEAR_UNIQUE:'NEAR_UNIQUE',AMBIGUOUS:'AMBIGUOUS',NOT_FOUND:'NOT_FOUND'});

function plausibleSetCode(code) {
  if(!STRICT_SET_CODE.test(code))return false;
  const [prefix,suffix]=code.split('-');
  return /[A-Z]/.test(prefix)&&/\d/.test(suffix);
}

export function normalizeSetCode(raw) {
  const source=String(raw||'').normalize('NFKC').toUpperCase().replace(/[\u2010-\u2015\u2212_]/g,'-');
  const tokens=extractSetCodeCandidates(source);
  const cleaned=source.replace(/\s+/g,'').replace(/[^A-Z0-9-]/g,'').replace(/-+/g,'-').replace(/^-|-$/g,'');
  const code=tokens[0]||reconstructMissingSeparator(cleaned)||cleaned;
  return {raw:String(raw||''),code,valid:plausibleSetCode(code)};
}

export function extractSetCodeCandidates(rawText) {
  const source=String(rawText||'').normalize('NFKC').toUpperCase().replace(/[\u2010-\u2015\u2212_]/g,'-');
  const matches=[];
  for(const match of source.matchAll(/(?:^|[^A-Z0-9])([A-Z0-9]{2,12}\s*-\s*[A-Z0-9]{2,10})(?=$|[^A-Z0-9])/g)){
    const code=match[1].replace(/\s+/g,'');
    if(plausibleSetCode(code))matches.push(code);
  }
  return [...new Set(matches)];
}

export function setCodeCandidates(raw,limit=24) {
  const base=normalizeSetCode(raw);if(!base.valid)return[];
  const variants=[];
  for(const code of extractSetCodeCandidates(raw).slice(1))variants.push({code,corrected:false,ambiguous:true,confusion:'altro candidato OCR',edits:0,priority:110});
  const numericTail=correctNumericTailZeros(base.code);
  if(numericTail&&numericTail!==base.code)variants.push({code:numericTail,corrected:true,ambiguous:true,confusion:'O/0 numeric-tail',edits:characterDistance(base.code,numericTail),priority:100});
  const structural=structuralRegionVariants(base.code);variants.push(...structural);
  variants.push(...edgeDeletionVariants(base.code,60));
  if(numericTail)variants.push(...edgeDeletionVariants(numericTail,80).map(item=>({...item,edits:item.edits+characterDistance(base.code,numericTail)})));
  const separator=base.code.indexOf('-'),observedRegion=base.code.slice(separator+1,separator+3),protectRegion=REGION_CODES.includes(observedRegion)||structural.length>0,indexes=[...base.code].map((char,index)=>OCR_SWAPS[char]?index:-1).filter(index=>index>=0&&!(protectRegion&&index>separator&&index-separator-1<2)).slice(0,6);
  for(const index of indexes)for(const replacement of OCR_SWAPS[base.code[index]]){const chars=[...base.code];chars[index]=replacement;const code=chars.join('');if(plausibleSetCode(code))variants.push({code,corrected:true,ambiguous:true,confusion:`${base.code[index]}/${replacement}`,edits:1,priority:confusionPriority(base.code,index,replacement)});}
  variants.sort((left,right)=>right.priority-left.priority);
  const output=[{code:base.code,corrected:false,ambiguous:false},...variants.map(({priority,...item})=>item)];
  return [...new Map(output.map(item=>[item.code,item])).values()].slice(0,limit);
}

function reconstructMissingSeparator(cleaned){
  if(!cleaned||cleaned.includes('-'))return'';const tail=cleaned.match(/([0-9]{1,4}[A-Z]?)$/)?.[1]||'',head=tail?cleaned.slice(0,-tail.length):'';if(!head)return'';
  for(const region of [...REGION_CODES].sort((left,right)=>right.length-left.length)){if(!head.endsWith(region))continue;const prefix=head.slice(0,-region.length),code=`${prefix}-${region}${tail}`;if(prefix.length>=2&&plausibleSetCode(code))return code;}
  for(const regionLength of [2,3]){const prefix=head.slice(0,-regionLength),region=head.slice(-regionLength),code=`${prefix}-${region}${tail}`;if(prefix.length>=2&&plausibleSetCode(code))return code;}
  return'';
}
function structuralRegionVariants(code){
  const [prefix,suffix]=code.split('-'),variants=[];
  for(const regionLength of [2,3]){
    const observed=suffix.slice(0,regionLength),number=suffix.slice(regionLength);if(observed.length!==regionLength||!/^[A-Z0-9]{1,4}[A-Z]?$/.test(number)||!/[0-9]/.test(number))continue;
    for(const region of REGION_CODES.filter(item=>item.length===regionLength)){
      const edits=controlledConfusionDistance(observed,region);if(!edits||edits>2)continue;
      variants.push({code:`${prefix}-${region}${number}`,corrected:true,ambiguous:true,structural:true,confusion:`regione ${observed}/${region}`,edits,priority:106-edits});
    }
  }
  return variants.filter(item=>plausibleSetCode(item.code));
}
function controlledConfusionDistance(observed,expected){if(observed.length!==expected.length)return Infinity;let edits=0;for(let index=0;index<observed.length;index++){if(observed[index]===expected[index])continue;if(!OCR_SWAPS[observed[index]]?.includes(expected[index]))return Infinity;edits+=1;}return edits;}
function correctNumericTailZeros(code){const [prefix,suffix]=code.split('-');if(!/^(?:IT|EN|DE|FR|SP|PT)[A-Z0-9]{2,8}$/.test(suffix))return'';const language=suffix.slice(0,2),tail=suffix.slice(2),corrected=tail.replace(/O/g,'0');return corrected!==tail?`${prefix}-${language}${corrected}`:'';}
function edgeDeletionVariants(code,priority){const [prefix,suffix]=code.split('-'),variants=[];for(const count of [1,2]){if(prefix.length-count>=2){variants.push({code:`${prefix.slice(count)}-${suffix}`,corrected:true,ambiguous:true,confusion:`rimossi ${count} caratteri iniziali`,edits:count,priority:priority-count});variants.push({code:`${prefix.slice(0,-count)}-${suffix}`,corrected:true,ambiguous:true,confusion:`rimossi ${count} caratteri finali dal prefisso`,edits:count,priority:priority-count-10});}if(suffix.length-count>=2){variants.push({code:`${prefix}-${suffix.slice(count)}`,corrected:true,ambiguous:true,confusion:`rimossi ${count} caratteri iniziali dal suffisso`,edits:count,priority:priority-count-20});variants.push({code:`${prefix}-${suffix.slice(0,-count)}`,corrected:true,ambiguous:true,confusion:`rimossi ${count} caratteri finali`,edits:count,priority:priority-count-30});}}return variants.filter(item=>plausibleSetCode(item.code));}
function confusionPriority(code,index,replacement){const hyphen=code.indexOf('-'),suffix=code.slice(hyphen+1),offset=index-hyphen-1;if(index>hyphen&&offset>=2&&replacement==='0'&&/\d/.test(suffix))return 90;if(index>hyphen&&offset>=2&&/\d/.test(replacement))return 40;if(index>hyphen&&offset<3&&/[A-Z]/.test(replacement))return 82;return 72;}
function characterDistance(left,right){if(left.length!==right.length)return Math.max(left.length,right.length);let count=0;for(let index=0;index<left.length;index++)if(left[index]!==right[index])count+=1;return count;}

export function classifyPrintingMatch({normalized,matches=[],corrected=false,catalogMismatch=false,consensus=0,ocrConfidence=0,manual=false}) {
  if(!normalized?.valid)return {status:'not_found',decision:SCAN_DECISION.NOT_FOUND,matches:[]};
  if(catalogMismatch||matches.length>1)return {status:'needs_review',decision:SCAN_DECISION.AMBIGUOUS,matches};
  if(matches.length===1&&!corrected)return {status:'high_confidence',decision:SCAN_DECISION.EXACT_UNIQUE,matches};
  if(matches.length)return {status:'needs_review',decision:SCAN_DECISION.AMBIGUOUS,matches};
  return {status:'not_found',decision:SCAN_DECISION.NOT_FOUND,matches:[]};
}

export function classifyNearPrintingMatch(resolvedCandidates=[],{plausibleCandidateCount=1}={}) {
  const candidates=resolvedCandidates.filter(item=>item?.matches?.length);
  const uniqueCodes=[...new Set(candidates.map(item=>item.candidate.code))];
  const matches=[...new Map(candidates.flatMap(item=>item.matches).map(match=>[[match.printingId||match.printing_id,match.catalogCardId||match.catalog_card_id,match.setCode||match.set_code,match.rarity].join(':'),match])).values()];
  const candidate=candidates[0]?.candidate;
  const safeEdit=candidate?.edits===1||(candidate?.structural&&candidate.edits<=2),safe=plausibleCandidateCount===1&&uniqueCodes.length===1&&matches.length===1&&safeEdit;
  return {status:safe?'high_confidence':'needs_review',decision:safe?SCAN_DECISION.NEAR_UNIQUE:SCAN_DECISION.AMBIGUOUS,matches,code:safe?uniqueCodes[0]:'',corrected:true,alternatives:uniqueCodes};
}

export class OcrConsensus {
  constructor({windowSize=3,minVotes=2,strongConfidence=88}={}){this.windowSize=windowSize;this.minVotes=minVotes;this.strongConfidence=strongConfidence;this.readings=[];this.misses=0;}
  observe(raw,confidence=0){const normalized=normalizeSetCode(raw);if(!normalized.valid){this.miss();return {valid:false,ready:false,code:''};}this.misses=0;this.readings.push({code:normalized.code,confidence:Number(confidence)||0});if(this.readings.length>this.windowSize)this.readings.shift();const counts=new Map();for(const item of this.readings)counts.set(item.code,(counts.get(item.code)||0)+1);const [code,votes]=[...counts].sort((a,b)=>b[1]-a[1]||this.latestIndex(b[0])-this.latestIndex(a[0]))[0];const matching=this.readings.filter(item=>item.code===code);return {valid:true,ready:votes>=this.minVotes,code,votes,strong:matching.some(item=>item.confidence>=this.strongConfidence),confidence:matching.reduce((sum,item)=>sum+item.confidence,0)/matching.length,readings:[...this.readings]};}
  latestIndex(code){for(let index=this.readings.length-1;index>=0;index--)if(this.readings[index].code===code)return index;return -1;}
  miss(){this.misses+=1;if(this.misses>=2)this.readings=[];}
  reset(){this.readings=[];this.misses=0;}
}

export class ScanGate {
  constructor({sameCodeCooldown=1200,globalCooldown=320,changeThreshold=.16,clearFrames=2}={}){this.sameCodeCooldown=sameCodeCooldown;this.globalCooldown=globalCooldown;this.changeThreshold=changeThreshold;this.clearFrames=clearFrames;this.last=null;this.clearCount=0;}
  miss(){this.clearCount+=1;}
  consider(code,signature=[],now=Date.now()){if(!code){this.miss();return false;}if(!this.last)return this.accept(code,signature,now);const elapsed=now-this.last.at;if(code!==this.last.code)return elapsed>=this.globalCooldown?this.accept(code,signature,now):false;const rearmed=this.clearCount>=this.clearFrames;const changed=elapsed>=this.sameCodeCooldown&&signatureDistance(signature,this.last.signature)>=this.changeThreshold;return rearmed||changed?this.accept(code,signature,now):false;}
  accept(code,signature,now){this.last={code,signature:[...signature],at:now};this.clearCount=0;return true;}
}

export function signatureDistance(left=[],right=[]){if(!left.length||left.length!==right.length)return 1;return left.reduce((sum,value,index)=>sum+Math.abs(value-right[index]),0)/(left.length*255);}

export class ScanSessionBuffer {
  constructor(snapshot={}){this.entries=new Map((snapshot.entries||[]).map(entry=>[entry.key,{...entry}]));this.review=[...(snapshot.review||[])];this.total=Number(snapshot.total||[...this.entries.values()].reduce((sum,item)=>sum+item.quantity,0));this.scanned=Number(snapshot.scanned??(this.total+this.review.length));this.settings=snapshot.settings||defaultScanSettings();this.updatedAt=snapshot.updatedAt||new Date().toISOString();}
  add(printing,confidence='high_confidence',warning='',countScan=true){const key=printing.printingId||[printing.game,printing.catalogCardId,printing.setCode,printing.rarity].join(':');const current=this.entries.get(key);if(current)current.quantity+=1;else this.entries.set(key,{key,printingId:printing.printingId||'',game:printing.game||'yugioh',catalogCardId:String(printing.catalogCardId||''),cardName:printing.cardName,setCode:printing.setCode,setName:printing.setName||'',rarity:printing.rarity||'',imageUrl:printing.imageUrl||'',quantity:1,confidence,warning,language:this.settings.language,condition:this.settings.condition,edition:this.settings.edition});this.total+=1;if(countScan)this.scanned+=1;this.touch();return this.entries.get(key);}
  queueReview(item){this.review.push({...item,id:item.id||crypto.randomUUID()});this.scanned+=1;this.touch();}
  updateQuantity(key,quantity){const item=this.entries.get(key);if(!item)return;const next=Math.max(0,Math.min(999,Number(quantity)||0));this.total+=next-item.quantity;if(next)item.quantity=next;else this.entries.delete(key);this.touch();}
  removeReview(id){this.review=this.review.filter(item=>item.id!==id);this.touch();}
  clear(){this.entries.clear();this.review=[];this.total=0;this.scanned=0;this.touch();}
  snapshot(){return {entries:[...this.entries.values()],review:this.review,total:this.total,scanned:this.scanned,settings:this.settings,updatedAt:this.updatedAt};}
  touch(){this.updatedAt=new Date().toISOString();}
}

export function defaultScanSettings(){return {game:'yugioh',language:'Italiano',condition:'Near Mint',edition:'',autoAdd:true,vibration:true,sound:false};}
