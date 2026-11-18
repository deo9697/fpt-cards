// Anonymous, request-local timings. No authentication or duel data is retained.
export function createRequestTimings({clock=()=>performance.now()}={}){
  const started=clock(),buckets=new Map(['auth','db','engine'].map(name=>[name,{active:0,started:0,elapsed:0}]));
  async function measure(name,operation){
    const bucket=buckets.get(name);if(!bucket)throw new Error('Unknown timing category.');
    if(bucket.active++===0)bucket.started=clock();
    try{return await operation();}
    finally{if(--bucket.active===0)bucket.elapsed+=Math.max(0,clock()-bucket.started);}
  }
  function header(){
    const now=clock(),parts=['total;dur='+Math.max(0,now-started).toFixed(2)];
    for(const[name,bucket]of buckets)parts.push(name+';dur='+(bucket.elapsed+(bucket.active?Math.max(0,now-bucket.started):0)).toFixed(2));
    return parts.join(', ');
  }
  return{measure,header};
}

export function timeDatabase(database,timings){
  const methods=value=>value&&Object.fromEntries(Object.entries(value).map(([key,method])=>[key,typeof method==='function'?(...args)=>timings.measure('db',()=>method.apply(value,args)):method]));
  return{...database,store:methods(database.store),practices:methods(database.practices),
    ...(database.subscriptions?{subscriptions:(...args)=>timings.measure('db',()=>database.subscriptions(...args))}:{}),
    ...(database.removeExpired?{removeExpired:(...args)=>timings.measure('db',()=>database.removeExpired(...args))}:{})
  };
}
