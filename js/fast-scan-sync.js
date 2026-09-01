export const FAST_SCAN_CHUNK_SIZE=25;

export function prepareFastScanSync(items=[],previous=null,{chunkSize=FAST_SCAN_CHUNK_SIZE,randomUUID=defaultUuid}={}){
  const normalized=aggregateFastScanItems(items),payloadHash=hashPayload(normalized);
  if(previous?.payloadHash===payloadHash&&Array.isArray(previous.chunks))return resumePlan(previous);
  const batchId=randomUUID();
  return {
    version:1,batchId,payloadHash,status:'pending',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    totalItems:normalized.length,totalQuantity:normalized.reduce((sum,item)=>sum+item.quantityDelta,0),
    chunks:Array.from({length:Math.ceil(normalized.length/chunkSize)},(_,index)=>{
      const payload=normalized.slice(index*chunkSize,(index+1)*chunkSize);
      return {chunkId:`${batchId}:${index+1}`,index,status:'pending',payloadHash:hashPayload(payload),items:payload,attempts:0};
    })
  };
}

export function aggregateFastScanItems(items=[]){
  const grouped=new Map();
  for(const source of items){
    const item={...source,quantityDelta:Number(source.quantityDelta??source.quantity??0)};
    if(!Number.isInteger(item.quantityDelta)||item.quantityDelta<1)continue;
    const identity=[item.printingId||'',item.game||'yugioh',item.catalogCardId||'',item.setCode||'',item.rarity||'',item.language||'',item.condition||'',item.edition||''].join('\u001f');
    const current=grouped.get(identity);
    if(current)current.quantityDelta+=item.quantityDelta;else grouped.set(identity,item);
  }
  return [...grouped.values()];
}

export function markChunk(plan,index,status,result=null,error=''){
  const chunks=plan.chunks.map((chunk,chunkIndex)=>chunkIndex===index?{...chunk,status,result,error,attempts:(chunk.attempts||0)+(status==='syncing'?1:0),updatedAt:new Date().toISOString()}:chunk);
  const allSynced=chunks.every(chunk=>chunk.status==='synced');
  return {...plan,chunks,status:allSynced?'synced':status==='error'?'error':'syncing',updatedAt:new Date().toISOString()};
}

export function pendingChunkIndexes(plan){return plan.chunks.map((chunk,index)=>chunk.status==='synced'?-1:index).filter(index=>index>=0);}
export function syncProgress(plan){const synced=plan?.chunks?.filter(chunk=>chunk.status==='synced').length||0,total=plan?.chunks?.length||0;return {synced,total,percent:total?Math.round(synced/total*100):0};}

function resumePlan(previous){return {...previous,status:previous.status==='synced'?'synced':'pending',chunks:previous.chunks.map(chunk=>chunk.status==='synced'?chunk:{...chunk,status:'pending',error:''}),updatedAt:new Date().toISOString()};}
function hashPayload(value){let hash=2166136261;const text=stableStringify(value);for(let index=0;index<text.length;index++){hash^=text.charCodeAt(index);hash=Math.imul(hash,16777619);}return `fnv1a-${(hash>>>0).toString(16).padStart(8,'0')}`;}
function stableStringify(value){if(Array.isArray(value))return `[${value.map(stableStringify).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function defaultUuid(){return globalThis.crypto?.randomUUID?.()||`scan-${Date.now()}-${Math.random().toString(16).slice(2)}`;}
