// Calcola dal backup le rilevazioni da tenere, con le stesse regole di
// public.prune_market_price_history (migration 20261126150000), e le scrive
// in keep_snapshots.ndjson.gz. Gli eventi non si tengono (nessuno li legge).
const fs=require('fs'),z=require('zlib');const dir=process.argv[2];
const read=f=>z.gunzipSync(fs.readFileSync(dir+'/'+f)).toString('utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
const rows=fs.readdirSync(dir).filter(f=>/^snapshots_.*\.gz$/.test(f)).flatMap(read);
const current=read('current_price_snapshots.ndjson.gz');
const pinned=new Set(current.map(r=>r.snapshot_id));
const now=Date.now(),DAY=864e5;
const ts=r=>Date.parse(r.captured_at.replace(' ','T').replace(/\+00$/,'Z'));
const day=t=>Math.floor(t/DAY);
const week=t=>{const d=new Date(t);const dow=(d.getUTCDay()+6)%7;return day(t)-dow;}; // lunedì, come date_trunc('week')
const month=t=>{const d=new Date(t);return d.getUTCFullYear()*12+d.getUTCMonth();};
const hasTrend=new Set(rows.filter(r=>r.price_type==='trend').map(r=>r.printing_id));
const series=new Map();
for(const r of rows){r._t=ts(r);if(!Number.isFinite(r._t))throw Error('data non valida '+r.id);const k=[r.printing_id,r.provider_mapping_id,r.provider,r.price_type,r.normalized_currency].join('|');(series.get(k)||series.set(k,[]).get(k)).push(r);}
const keep=[];const why={};
for(const list of series.values()){
  list.sort((a,b)=>b._t-a._t||(b.id<a.id?-1:b.id>a.id?1:0));
  const seenD=new Set(),seenW=new Set(),seenM=new Set();
  list.forEach((r,i)=>{
    const d=day(r._t),w=week(r._t),m=month(r._t);
    const firstD=!seenD.has(d),firstW=!seenW.has(w),firstM=!seenM.has(m);seenD.add(d);seenW.add(w);seenM.add(m);
    const hist=r.price_type==='trend'||!hasTrend.has(r.printing_id),age=now-r._t;
    const reason=pinned.has(r.id)?'pinned':(r.is_anomalous===true||r.is_anomalous==='true')?'anomaly':i<2?'latest2':
      hist&&firstD&&age<=30*DAY?'daily30':hist&&firstW&&age<=90*DAY?'weekly90':hist&&firstM?'monthly':null;
    if(reason){why[reason]=(why[reason]||0)+1;const {_t,...clean}=r;keep.push(clean);}
  });
}
const keptIds=new Set(keep.map(r=>r.id));
const missing=current.filter(c=>!keptIds.has(c.snapshot_id)).length;
if(missing)throw Error('prezzi attuali senza rilevazione: '+missing);
fs.writeFileSync(dir+'/keep_snapshots.ndjson.gz',z.gzipSync(keep.map(r=>JSON.stringify(r)).join('\n')+'\n'));
console.log(JSON.stringify({total:rows.length,keep:keep.length,removed:rows.length-keep.length,why,current:current.length,series:series.size}));
