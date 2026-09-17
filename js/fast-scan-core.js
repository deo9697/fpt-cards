import { sanitizeYugiohRarity } from './cards.js';

const STRICT_SET_CODE = /^[A-Z0-9]{2,12}-[A-Z0-9]{2,10}$/;
const OCR_SWAPS = {J:['H'],H:['J'],O:['0'],0:['O'],I:['1','L','T'],1:['I','L','T'],L:['I','1'],T:['I','1'],S:['5'],5:['S','3'],3:['5'],B:['8'],8:['B'],Z:['2'],2:['Z'],G:['6'],6:['G']};
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

const SET_CODE_LANGUAGES = {IT:'Italiano',EN:'Inglese',FR:'Francese',DE:'Tedesco',SP:'Spagnolo',PT:'Portoghese'};
// Il marker lingua Konami sono sempre le prime due lettere subito dopo il
// trattino (IT/EN/FR/DE/SP/PT), a volte seguite da 1-2 lettere di categoria
// prima del numero (es. "ENC04", "ITV04" — Speed Duel/Structure Deck). I
// codici storici a una sola lettera (MIP-I010, SDF-I026, ...) non hanno un
// marker lingua a 2 lettere: il regex non li intercetta apposta, restano sul
// fallback invece di essere inferiti alla cieca.
export function languageFromSetCode(setCode, fallback = '') {
  const match = String(setCode || '').trim().toUpperCase().match(/^[A-Z0-9]+-([A-Z]{2})[A-Z]{0,2}\d/);
  return (match && SET_CODE_LANGUAGES[match[1]]) || fallback;
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
  for(const index of indexes)for(const replacement of OCR_SWAPS[base.code[index]]){const chars=[...base.code];chars[index]=replacement;const code=chars.join('');if(plausibleSetCode(code))variants.push({code,corrected:true,ambiguous:true,confusion:`${base.code[index]}/${replacement}`,edits:1,requiresReview:['J','H'].includes(base.code[index])&&['J','H'].includes(replacement),priority:confusionPriority(base.code,index,replacement)});}
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
function confusionPriority(code,index,replacement){if(['J','H'].includes(code[index])&&['J','H'].includes(replacement))return 95;const hyphen=code.indexOf('-'),suffix=code.slice(hyphen+1),offset=index-hyphen-1;if(index>hyphen&&offset>=2&&replacement==='0'&&/\d/.test(suffix))return 90;if(index>hyphen&&offset>=2&&/\d/.test(replacement))return 40;if(index>hyphen&&offset<3&&/[A-Z]/.test(replacement))return 82;return 72;}
function characterDistance(left,right){if(left.length!==right.length)return Math.max(left.length,right.length);let count=0;for(let index=0;index<left.length;index++)if(left[index]!==right[index])count+=1;return count;}

export function classifyPrintingMatch({normalized,matches=[],corrected=false,consensus=0,ocrConfidence=0,manual=false}) {
  if(!normalized?.valid)return {status:'not_found',decision:SCAN_DECISION.NOT_FOUND,matches:[]};
  if(matches.length>1)return {status:'needs_review',decision:SCAN_DECISION.AMBIGUOUS,matches};
  if(matches.length===1&&!corrected)return {status:'high_confidence',decision:SCAN_DECISION.EXACT_UNIQUE,matches};
  if(matches.length)return {status:'needs_review',decision:SCAN_DECISION.AMBIGUOUS,matches};
  return {status:'not_found',decision:SCAN_DECISION.NOT_FOUND,matches:[]};
}

export function classifyNearPrintingMatch(resolvedCandidates=[],{plausibleCandidateCount=1}={}) {
  const candidates=resolvedCandidates.filter(item=>item?.matches?.length);
  const uniqueCodes=[...new Set(candidates.map(item=>item.candidate.code))];
  const matches=[...new Map(candidates.flatMap(item=>item.matches).map(match=>[[match.printingId||match.printing_id,match.catalogCardId||match.catalog_card_id,match.setCode||match.set_code,match.rarity].join(':'),match])).values()];
  const candidate=candidates[0]?.candidate;
  const safeEdit=candidate?.edits===1||(candidate?.structural&&candidate.edits<=2),safe=!candidate?.requiresReview&&plausibleCandidateCount===1&&uniqueCodes.length===1&&matches.length===1&&safeEdit;
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
  constructor(snapshot={}){
    this.settings={...defaultScanSettings(),...snapshot.settings};this.updatedAt=snapshot.updatedAt||new Date().toISOString();this.scanEvents=[];this.entries=new Map();this.review=[];this.nextSequence=1;
    if(Array.isArray(snapshot.scanEvents))this.scanEvents=structuredClone(snapshot.scanEvents);
    else{
      // Legacy aggregates cannot recover physical order: retain every copy,
      // review ID and historic counter, explicitly marking imported events.
      for(const entry of snapshot.entries||[])for(let i=0;i<Number(entry.quantity||entry.quantityDelta||0);i++){
        const event=this.createScan({source:'legacy'});Object.assign(event,{status:'CONFIRMED',printing:this.printing(entry),printingId:entry.printingId||'',cardName:entry.cardName,setCode:entry.setCode,rarity:entry.rarity,imageUrl:entry.imageUrl,matchType:entry.confidence||'',warning:entry.warning||''});
      }
      for(const row of snapshot.review||[])this.queueReview({...row,source:'legacy'});
      const previous=Number(snapshot.scanned??this.scanEvents.length);
      while(this.scanEvents.length<previous)this.createScan({status:'CANCELLED',source:'legacy',failureReason:'LEGACY_HISTORY_UNAVAILABLE'});
      this.scanEvents.forEach((event,index)=>{event.countsAsScan=index<previous;});
    }
    this.nextSequence=Math.max(0,...this.scanEvents.map(event=>Number(event.sequence)||0))+1;this.rebuild();
  }
  printing(value){
    const game=value.game||'yugioh';
    // Single choke point for every confirmed/imported entry: whatever set the
    // raw rarity (fresh catalog lookup, a stale card_printings row, a legacy
    // snapshot), a YGOProDeck artwork/reprint tag can never survive as a
    // literal rarity from here on — see js/cards.js sanitizeYugiohRarity.
    const rarity=game==='yugioh'?sanitizeYugiohRarity(value.rarity):(value.rarity||'');
    return {key:value.key||value.printingId||[game,value.catalogCardId,value.setCode,rarity].join(':'),printingId:value.printingId||'',game,catalogCardId:String(value.catalogCardId||''),cardName:value.cardName||'',setCode:value.setCode||'',setName:value.setName||'',rarity,imageUrl:value.imageUrl||'',language:value.language||(game==='yugioh'?languageFromSetCode(value.setCode,this.settings.language):this.settings.language),condition:value.condition||this.settings.condition,edition:value.edition??this.settings.edition};
  }
  createScan(data={}){
    const event={id:data.id||crypto.randomUUID(),sequence:data.countsAsScan===false?0:this.nextSequence++,createdAt:new Date().toISOString(),status:data.status||'CAPTURED',rawCode:data.rawCode||'',normalizedCode:data.normalizedCode||'',ocrConfidence:Number(data.ocrConfidence)||0,matchType:'',printingId:'',cardName:'',setCode:'',rarity:'',imageUrl:'',source:data.source||'camera',failureReason:data.failureReason||'',resolutionVersion:0,countsAsScan:data.countsAsScan!==false};
    this.scanEvents.push(event);this.rebuild();this.touch();return event;
  }
  getScan(id){return this.scanEvents.find(event=>event.id===id);}
  isCurrent(id,version){const event=this.getScan(id);return Boolean(event&&event.status!=='CANCELLED'&&event.resolutionVersion===version);}
  updateScan(id,patch,version){const event=this.getScan(id);if(!event||event.status==='CANCELLED'||version!==undefined&&!this.isCurrent(id,version))return null;Object.assign(event,patch);this.rebuild();this.touch();return event;}
  invalidateScan(id){const event=this.getScan(id);if(!event||event.status==='CANCELLED')return null;event.resolutionVersion+=1;this.touch();return event.resolutionVersion;}
  confirmScan(id,printing,confidence='high_confidence',warning='',version){
    const previous=this.getScan(id)?.printing,value=this.printing({...printing,condition:printing.condition||previous?.condition,edition:printing.edition??previous?.edition});return this.updateScan(id,{status:'CONFIRMED',printing:value,printingId:value.printingId,cardName:value.cardName,setCode:value.setCode,rarity:value.rarity,imageUrl:value.imageUrl,matchType:confidence,warning,failureReason:'',reviewData:null},version);
  }
  correctScan(id,printing){const version=this.invalidateScan(id);return version===null?null:this.confirmScan(id,printing,'manual','Correzione manuale',version);}
  cancelScan(id){const event=this.getScan(id);if(!event||event.status==='CANCELLED')return;event.resolutionVersion+=1;event.status='CANCELLED';event.reviewData=null;this.rebuild();this.touch();}
  deferScan(id){const version=this.invalidateScan(id);if(version===null)return;const event=this.getScan(id);this.updateScan(id,{status:'DEFERRED',reviewData:{...event.reviewData,id,raw:event.rawCode,code:event.normalizedCode||event.setCode,matches:event.reviewData?.matches||[],pending:false,status:'needs_review',warning:'Messa da parte: conferma o correggi'}});}
  failScan(id,reason){return this.updateScan(id,{status:'FAILED',failureReason:reason,reviewData:null});}
  add(printing,confidence='high_confidence',warning='',countScan=true,scanId=null){
    // Callers converting reviews should pass the ID. The legacy single-review
    // adapter remains for older consumers without creating a second scan.
    const event=this.getScan(scanId)||(!countScan?this.scanEvents.find(event=>['PENDING_REMOTE','REVIEW_REQUIRED','DEFERRED'].includes(event.status)&&event.normalizedCode===printing.setCode):null)||this.createScan({countsAsScan:countScan,source:countScan?'manual':'quantity-adjustment'});
    this.confirmScan(event.id,printing,confidence,warning);return this.entries.get(this.printing(printing).key);
  }
  queueReview(item){
    const event=this.getScan(item.scanId||item.id)||this.createScan({id:item.id,source:item.source});
    this.updateScan(event.id,{status:item.pending?'PENDING_REMOTE':'REVIEW_REQUIRED',rawCode:item.raw||event.rawCode,normalizedCode:item.code||event.normalizedCode,ocrConfidence:item.ocrConfidence??event.ocrConfidence,reviewData:{...item,id:event.id,scanId:event.id}});return event;
  }
  updateReview(id,patch){const event=this.getScan(id);if(!event||!event.reviewData)return;const row={...event.reviewData,...patch};this.updateScan(id,{reviewData:row,status:row.pending?'PENDING_REMOTE':event.status==='DEFERRED'?'DEFERRED':'REVIEW_REQUIRED',normalizedCode:row.code||event.normalizedCode});}
  updateQuantity(key,quantity){
    const item=this.entries.get(key);if(!item)return;const next=Math.max(0,Math.min(999,Math.floor(Number(quantity)||0))),active=this.scanEvents.filter(event=>event.status==='CONFIRMED'&&event.printing?.key===key);
    if(next<active.length)for(const event of active.slice(next))this.cancelScan(event.id);
    else for(let i=active.length;i<next;i++){const event=this.createScan({source:'quantity-adjustment',countsAsScan:false});this.confirmScan(event.id,item,item.confidence,item.warning);}
  }
  setEdition(key,edition){for(const event of this.scanEvents)if(event.status==='CONFIRMED'&&event.printing?.key===key){event.printing.edition=edition;event.resolutionVersion+=1;}this.rebuild();this.touch();}
  removeReview(id){const event=this.getScan(id);if(event?.status==='CONFIRMED')return;this.cancelScan(id);}
  interruptPending(){for(const event of this.scanEvents)if(['CAPTURED','PROCESSING','PENDING_REMOTE'].includes(event.status)){event.resolutionVersion+=1;event.status='REVIEW_REQUIRED';event.reviewData={...event.reviewData,id:event.id,raw:event.rawCode,code:event.normalizedCode,matches:event.reviewData?.matches||[],pending:false,status:'needs_review',warning:'Verifica interrotta: conferma o correggi il codice'};}this.rebuild();this.touch();}
  rebuild(){
    this.entries=new Map();this.review=[];this.total=0;this.scanned=0;
    for(const event of this.scanEvents){
      if(event.countsAsScan!==false)this.scanned+=1;
      if(event.status==='CONFIRMED'&&event.printing){
        // A snapshot restored from persistence (reload mid-session, resumed
        // export) rebuilds scanEvents with structuredClone, never through
        // printing() above — re-sanitize here too so a rarity contaminated
        // before this fix shipped can't survive a resumed session either.
        if(event.printing.game==='yugioh'){
          const clean=sanitizeYugiohRarity(event.printing.rarity);
          if(clean!==event.printing.rarity){event.printing.rarity=clean;event.printing.key=event.printing.printingId||[event.printing.game,event.printing.catalogCardId,event.printing.setCode,clean].join(':');}
        }
        const key=event.printing.key,current=this.entries.get(key);if(current)current.quantity++;else this.entries.set(key,{...event.printing,quantity:1,confidence:event.matchType,warning:event.warning||''});this.total++;}
      else if(event.status!=='CANCELLED'&&event.reviewData)this.review.push(event.reviewData);
    }
  }
  clear(){this.scanEvents=[];this.nextSequence=1;this.rebuild();this.touch();}
  snapshot(){return structuredClone({version:2,scanEvents:this.scanEvents,entries:[...this.entries.values()],review:this.review,total:this.total,scanned:this.scanned,settings:this.settings,updatedAt:this.updatedAt});}
  touch(){this.updatedAt=new Date().toISOString();}
}

export function defaultScanSettings(){return {game:'yugioh',language:'Italiano',condition:'Near Mint',edition:'',autoAdd:true,vibration:true,sound:false};}
