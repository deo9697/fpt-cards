const STRICT_SET_CODE = /^[A-Z0-9]{2,12}-[A-Z0-9]{2,10}$/;
const OCR_SWAPS = { O:['0'],0:['O'],I:['1'],1:['I'],S:['5','9'],5:['S'],9:['S'],B:['8'],8:['B'],Z:['2'],2:['Z'],G:['6'],6:['G'] };

function plausibleSetCode(code) {
  if(!STRICT_SET_CODE.test(code))return false;
  const [prefix,suffix]=code.split('-');
  return /[A-Z]/.test(prefix)&&/\d/.test(suffix);
}

export function normalizeSetCode(raw) {
  const source=String(raw||'').normalize('NFKC').toUpperCase().replace(/[\u2010-\u2015\u2212_]/g,'-');
  const tokens=[...source.matchAll(/(?:^|[^A-Z0-9])([A-Z0-9](?:[A-Z0-9 ]{0,20}[A-Z0-9])?\s*-\s*[A-Z0-9](?:[A-Z0-9 ]{0,16}[A-Z0-9])?)(?=$|[^A-Z0-9])/g)]
    .map(match=>match[1].replace(/\s+/g,'')).filter(plausibleSetCode);
  const cleaned=source.replace(/\s+/g,'').replace(/[^A-Z0-9-]/g,'').replace(/-+/g,'-').replace(/^-|-$/g,'');
  const code=tokens[0]||cleaned;
  return {raw:String(raw||''),code,valid:plausibleSetCode(code)};
}

export function setCodeCandidates(raw,limit=24) {
  const base=normalizeSetCode(raw);if(!base.valid)return[];
  const variants=[];
  const numericTail=correctNumericTailZeros(base.code);
  if(numericTail&&numericTail!==base.code)variants.push({code:numericTail,corrected:true,ambiguous:true,confusion:'O/0 numeric-tail',priority:100});
  variants.push(...edgeDeletionVariants(base.code,60));
  if(numericTail)variants.push(...edgeDeletionVariants(numericTail,80));
  const indexes=[...base.code].map((char,index)=>OCR_SWAPS[char]?index:-1).filter(index=>index>=0).slice(0,6);
  for(const index of indexes)for(const replacement of OCR_SWAPS[base.code[index]]){const chars=[...base.code];chars[index]=replacement;const code=chars.join('');if(plausibleSetCode(code))variants.push({code,corrected:true,ambiguous:true,confusion:`${base.code[index]}/${replacement}`,priority:confusionPriority(base.code,index,replacement)});}
  variants.sort((left,right)=>right.priority-left.priority);
  const output=[{code:base.code,corrected:false,ambiguous:false},...variants.map(({priority,...item})=>item)];
  return [...new Map(output.map(item=>[item.code,item])).values()].slice(0,limit);
}

function correctNumericTailZeros(code){const [prefix,suffix]=code.split('-');if(!/^(?:IT|EN|DE|FR|SP|PT)[A-Z0-9]{2,8}$/.test(suffix))return'';const language=suffix.slice(0,2),tail=suffix.slice(2),corrected=tail.replace(/O/g,'0');return corrected!==tail?`${prefix}-${language}${corrected}`:'';}
function edgeDeletionVariants(code,priority){const [prefix,suffix]=code.split('-'),variants=[];for(const count of [1,2]){if(prefix.length-count>=2){variants.push({code:`${prefix.slice(count)}-${suffix}`,corrected:true,ambiguous:true,confusion:`rimossi ${count} caratteri iniziali`,priority:priority-count});variants.push({code:`${prefix.slice(0,-count)}-${suffix}`,corrected:true,ambiguous:true,confusion:`rimossi ${count} caratteri finali dal prefisso`,priority:priority-count-10});}if(suffix.length-count>=2){variants.push({code:`${prefix}-${suffix.slice(count)}`,corrected:true,ambiguous:true,confusion:`rimossi ${count} caratteri iniziali dal suffisso`,priority:priority-count-20});variants.push({code:`${prefix}-${suffix.slice(0,-count)}`,corrected:true,ambiguous:true,confusion:`rimossi ${count} caratteri finali`,priority:priority-count-30});}}return variants.filter(item=>plausibleSetCode(item.code));}
function confusionPriority(code,index,replacement){const hyphen=code.indexOf('-'),suffix=code.slice(hyphen+1),offset=index-hyphen-1;if(index>hyphen&&offset>=2&&replacement==='0'&&/\d/.test(suffix))return 90;if(index>hyphen&&offset>=2&&/\d/.test(replacement))return 40;if(index>hyphen&&offset<2&&/[A-Z]/.test(replacement))return 20;return 10;}

export function classifyPrintingMatch({normalized,matches=[],corrected=false,catalogMismatch=false,consensus=0,ocrConfidence=0,manual=false}) {
  if(!normalized?.valid||catalogMismatch)return {status:catalogMismatch?'needs_review':'not_found',matches};
  if(matches.length===1&&!corrected&&(manual||consensus>=2||ocrConfidence>=88))return {status:'high_confidence',matches};
  if(matches.length)return {status:'needs_review',matches};
  return {status:'not_found',matches:[]};
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
