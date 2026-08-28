const STRICT_SET_CODE = /^[A-Z0-9]{2,12}-[A-Z0-9]{2,10}$/;
const OCR_SWAPS = { O:'0', 0:'O', I:'1', 1:'I', S:'5', 5:'S', B:'8', 8:'B' };

export function normalizeSetCode(raw) {
  const source = String(raw || '').normalize('NFKC').toUpperCase().replace(/[‐‑‒–—_]/g, '-');
  const tokens = [...source.matchAll(/(?:^|[^A-Z0-9])([A-Z0-9](?:[A-Z0-9 ]{0,20}[A-Z0-9])?\s*-\s*[A-Z0-9](?:[A-Z0-9 ]{0,16}[A-Z0-9])?)(?=$|[^A-Z0-9])/g)]
    .map(match=>match[1].replace(/\s+/g,'')).filter(code=>STRICT_SET_CODE.test(code));
  const cleaned = source.replace(/\s+/g, '').replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const code = tokens.find(token=>/\d/.test(token.split('-')[1]||'')) || cleaned;
  return { raw:String(raw || ''), code, valid:STRICT_SET_CODE.test(code) && /\d/.test(code.split('-')[1] || '') };
}

export function setCodeCandidates(raw, limit = 24) {
  const base = normalizeSetCode(raw);
  if (!base.code) return [];
  const output = [{ code:base.code, corrected:false, ambiguous:false }];
  const indexes = [...base.code].map((char,index) => OCR_SWAPS[char] ? index : -1).filter(index => index >= 0).slice(0, 5);
  for (const index of indexes) {
    const chars = [...base.code]; chars[index] = OCR_SWAPS[chars[index]];
    const code = chars.join('');
    if (STRICT_SET_CODE.test(code) && /\d/.test(code.split('-')[1] || '')) output.push({ code, corrected:true, ambiguous:true });
    if (output.length >= limit) break;
  }
  return [...new Map(output.map(item => [item.code,item])).values()];
}

export function classifyPrintingMatch({ normalized, matches = [], corrected = false, catalogMismatch = false }) {
  if (!normalized?.valid || catalogMismatch) return { status:catalogMismatch ? 'needs_review' : 'not_found', matches };
  if (matches.length === 1 && !corrected) return { status:'high_confidence', matches };
  if (matches.length) return { status:'needs_review', matches };
  return { status:'not_found', matches:[] };
}

export class ScanGate {
  constructor({ sameCodeCooldown = 1200, globalCooldown = 320, changeThreshold = 0.16, clearFrames = 2 } = {}) {
    this.sameCodeCooldown=sameCodeCooldown; this.globalCooldown=globalCooldown;
    this.changeThreshold=changeThreshold; this.clearFrames=clearFrames;
    this.last=null; this.clearCount=0;
  }
  miss() { this.clearCount += 1; }
  consider(code, signature = [], now = Date.now()) {
    if (!code) { this.miss(); return false; }
    if (!this.last) return this.accept(code,signature,now);
    const elapsed = now-this.last.at;
    if (code !== this.last.code) return elapsed >= this.globalCooldown ? this.accept(code,signature,now) : false;
    const rearmed = this.clearCount >= this.clearFrames;
    const changed = elapsed >= this.sameCodeCooldown && signatureDistance(signature,this.last.signature) >= this.changeThreshold;
    return rearmed || changed ? this.accept(code,signature,now) : false;
  }
  accept(code, signature, now) { this.last={code,signature:[...signature],at:now}; this.clearCount=0; return true; }
}

export function signatureDistance(left = [], right = []) {
  if (!left.length || left.length !== right.length) return 1;
  return left.reduce((sum,value,index) => sum+Math.abs(value-right[index]),0)/(left.length*255);
}

export class ScanSessionBuffer {
  constructor(snapshot = {}) {
    this.entries = new Map((snapshot.entries || []).map(entry => [entry.key,{...entry}]));
    this.review = [...(snapshot.review || [])];
    this.total = Number(snapshot.total || [...this.entries.values()].reduce((sum,item) => sum+item.quantity,0));
    this.scanned = Number(snapshot.scanned ?? (this.total + this.review.length));
    this.settings = snapshot.settings || defaultScanSettings();
    this.updatedAt = snapshot.updatedAt || new Date().toISOString();
  }
  add(printing, confidence = 'high_confidence', warning = '', countScan = true) {
    const key = printing.printingId || [printing.game,printing.catalogCardId,printing.setCode,printing.rarity].join(':');
    const current = this.entries.get(key);
    if (current) current.quantity += 1;
    else this.entries.set(key,{ key,printingId:printing.printingId || '',game:printing.game || 'yugioh',catalogCardId:String(printing.catalogCardId || ''),cardName:printing.cardName,setCode:printing.setCode,setName:printing.setName || '',rarity:printing.rarity || '',imageUrl:printing.imageUrl || '',quantity:1,confidence,warning,language:this.settings.language,condition:this.settings.condition,edition:this.settings.edition });
    this.total += 1; if(countScan)this.scanned += 1; this.touch(); return this.entries.get(key);
  }
  queueReview(item) { this.review.push({...item,id:item.id || crypto.randomUUID()}); this.scanned += 1; this.touch(); }
  updateQuantity(key, quantity) { const item=this.entries.get(key); if(!item)return; const next=Math.max(0,Math.min(999,Number(quantity)||0)); this.total += next-item.quantity; if(next) item.quantity=next; else this.entries.delete(key); this.touch(); }
  removeReview(id) { this.review=this.review.filter(item=>item.id!==id); this.touch(); }
  clear() { this.entries.clear(); this.review=[]; this.total=0; this.scanned=0; this.touch(); }
  snapshot() { return { entries:[...this.entries.values()],review:this.review,total:this.total,scanned:this.scanned,settings:this.settings,updatedAt:this.updatedAt }; }
  touch() { this.updatedAt=new Date().toISOString(); }
}

export function defaultScanSettings() {
  return { game:'yugioh',language:'Italiano',condition:'Near Mint',edition:'',autoAdd:true,vibration:true,sound:false };
}
