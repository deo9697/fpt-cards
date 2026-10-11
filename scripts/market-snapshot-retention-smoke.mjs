// STRICT/OFFLINE: real worker and repository SQL on disposable PostgreSQL/WASM.
// Deletions below affect synthetic in-memory fixtures ONLY. No network/live DB.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { execFileSync } from 'node:child_process';
execFileSync(process.execPath,['scripts/build-market-retention-sql.mjs','--check'],{stdio:'inherit'});
const read=f=>fs.readFileSync(new URL(`../${f}`,import.meta.url),'utf8');
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const base=read('supabase-milestone-5-market-watch.sql');
const fn=(sql,name)=>{const m=sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`,'i'));assert.ok(m,name);return m[0];};
const db=new PGlite();
const scalar=async(sql,params=[])=>(await db.query(sql,params)).rows[0].value;
const count=()=>scalar('select count(*)::int value from market_price_snapshots');
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls; create schema extensions;
    create table team_members(slug text primary key,role text); insert into team_members values('tester','admin');
    create table card_printings(id uuid primary key,card_name text,set_code text,rarity text,
      game text default 'yugioh',catalog_card_id text,set_name text,image_url text);
    create table market_provider_printings(id uuid primary key,printing_id uuid,provider text,
      resolution_status text,provider_metadata jsonb,variant_key text default 'default',provider_product_id text);
    create table collection_items(owner_slug text,printing_id uuid,quantity_owned integer default 1);
    create table decks(id uuid primary key,owner_slug text,game text,name text);
    create table deck_cards(deck_id uuid,printing_id uuid,quantity integer,catalog_card_id text,card_name text,section text);
    create table market_watch_items(member_slug text,printing_id uuid);
    create table market_provider_sync_runs(finished_at timestamptz,status text);
    create function session_member(text) returns text language sql as $$ select 'tester'::text $$;
  `);
  await db.exec(base.slice(base.indexOf('create table if not exists public.market_price_snapshots'),base.indexOf('create table if not exists public.market_watch_items')));
  await db.exec(base.slice(base.indexOf('create table if not exists public.market_price_events'),base.indexOf('create table if not exists public.market_provider_sync_runs')));
  await db.exec(fn(base,'market_reference_type'));
  await db.exec(read('supabase-mw1-market-mapping-integrity.sql'));
  await db.exec(fn(read('supabase-market-watch-decommission-cardtrader-pricing.sql'),'market_mapping_is_active'));
  await db.exec(read('supabase-market-watch-price-anomaly-detection.sql'));
  await db.exec(read('supabase/migrations/20260914200000_market_current_price_layer.sql'));
  await db.exec(read('docs/archive/20261003203253_market_snapshot_storage_hardening.sql'));
  await db.exec(read('supabase/manual/market-append-only-restore.sql'));
  await db.exec(read('supabase/manual/market-append-only-restore.sql'));
  assert.equal(await scalar("select count(*)::int value from pg_trigger where tgname='market_current_price_snapshot_after_value_update'"),0);
  await db.exec(fn(read('supabase-milestone-5-1-market-watch-operational.sql'),'list_market_price_history'));
  for(const f of ['20260914210000_market_watch_current_price_cutover.sql','20260908204855_market_watch_snapshot_reuse.sql','20260916100000_market_dashboard_movers_current_price_cutover.sql'])await db.exec(read(`supabase/migrations/${f}`));
  await db.exec(read('supabase/manual/market-snapshot-retention-design.sql'));
  let targets=[],writes=[],failWrite=false,finished=[];
  const ctx=vm.createContext({URLSearchParams,URL,Response,console,setTimeout,clearTimeout,AbortSignal,
    Deno:{env:{get:k=>k==='SUPABASE_URL'?'https://offline.invalid':'fixture'},serve:()=>{}},
    fetch:()=>{throw new Error('Unexpected network');},listTargets:()=>({rows:targets,requests:1}),finishRun:(...a)=>finished.push(a),
    captureWrite:async(table,method,rows,headers)=>{if(failWrite)throw new Error('fixture write failure');writes.push({table,method,rows:JSON.parse(JSON.stringify(rows)),headers});}});
  vm.runInContext(stripTypeScriptTypes(read('supabase/functions/market-sync/index.ts')),ctx);
  vm.runInContext("rpc=async()=> 'run'; rpcPages=async()=>listTargets(); finish=finishRun; rest=captureWrite; recordMappingError=async()=>{};",ctx);
  const target=(n,provider='cardmarket')=>({printing_id:uid(n),mapping_id:uid(n+1000),variant_key:'default',resolution_status:'manual',foil:false,provider,provider_metadata:{active:true,resolverStatus:'EXACT'}});
  const seed=async t=>{
    await db.query('insert into card_printings(id,card_name,catalog_card_id) values($1,$2,$2) on conflict do nothing',[t.printing_id,t.printing_id]);
    await db.query(`insert into market_provider_printings(id,printing_id,provider,resolution_status,provider_metadata) values($1,$2,$3,'manual','{"active":true,"resolverStatus":"EXACT"}') on conflict do nothing`,[t.mapping_id,t.printing_id,t.provider]);
    await db.query("insert into collection_items(owner_slug,printing_id) values('tester',$1)",[t.printing_id]);
    await db.query("insert into market_watch_items values('tester',$1)",[t.printing_id]);
  };
  const run=async(provider,capturedAt,prices,persist=true)=>{
    writes=[];
    const r=await ctx.syncProvider({name:provider,getPriceMetadata:()=>({status:'available'}),loadPrices:async()=>({}),
      getCurrentPrice:async()=>({status:'available',currency:'EUR',capturedAt,prices,conditionReference:'NM'})},{pricesOnly:true});
    if(persist)for(const w of writes){
      assert.equal(w.table,'market_price_snapshots?on_conflict=provider,observation_key,price_type');assert.equal(w.method,'POST');assert.ok(w.rows.length<=250);
      assert.equal(w.headers.Prefer,'resolution=ignore-duplicates,return=minimal');
      for(const row of w.rows){
        assert.match(row.observation_key,/^[\da-f-]+:\d{4}-\d{2}-\d{2}$/);
        const keys=Object.keys(row),values=keys.map(k=>k==='metadata'?JSON.stringify(row[k]):row[k]);
        await db.query(`insert into market_price_snapshots(${keys.join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')}) on conflict(provider,observation_key,price_type) do nothing`,values);
      }
    }
    return r;
  };
  const types=['trend','avg1','avg7','avg30','low','average'];
  targets=[target(1)];await seed(targets[0]);
  for(const [day,value] of [['2026-09-01',10],['2026-09-02',12]]){const r=await run('cardmarket',`${day}T12:00:00Z`,types.map(type=>({type,value})));assert.equal(r.status,'succeeded');assert.equal(r.snapshots,6);}
  for(const type of types){
    assert.equal(await scalar('select count(*)::int value from market_price_snapshots where price_type=$1',[type]),2);
    assert.equal(Number(await scalar('select normalized_price value from market_current_price_snapshots where price_type=$1',[type])),12);
  }
  const frozen=(await db.query('select * from market_price_snapshots order by id')).rows;
  const events=(await db.query('select * from market_price_events order by id')).rows;
  assert.equal(events.length,6);assert.ok(events.every(e=>e.previous_snapshot_id!==e.current_snapshot_id));
  await run('cardmarket','2026-09-02T12:00:00Z',types.map(type=>({type,value:999})));
  await run('cardmarket','2026-09-02T18:00:00Z',types.map(type=>({type,value:15})));
  assert.deepEqual((await db.query('select * from market_price_snapshots order by id')).rows,frozen);
  assert.deepEqual((await db.query('select * from market_price_events order by id')).rows,events);
  console.log('PASS: daily append/current/events; distinct IDs; duplicates and same-timestamp corrections never mutate snapshots');
  targets=[target(2,'cardtrader')];await seed(targets[0]);
  for(const day of ['2026-09-01','2026-09-02'])await run('cardtrader',`${day}T12:00:00Z`,[{type:'reference',value:10}]);
  targets=[{...target(3),foil:true}];await seed(targets[0]);
  // Equal-valued tie for RPC parity: legacy SQL does not break ties between foil
  // types at the same timestamp/rank. Preserve every tie, without inventing a winner.
  for(const day of ['2026-09-01','2026-09-02'])await run('cardmarket',`${day}T12:00:00Z`,[{type:'foil_trend',value:10},{type:'foil_low',value:10}]);
  assert.equal(await scalar(`select count(*)::int value from market_price_snapshots where printing_id='${uid(3)}'`),4);
  console.log('PASS: reference and foil append daily');
  targets=[target(4)];await seed(targets[0]);
  await run('cardmarket','2026-09-01T12:00:00Z',[{type:'low',value:10}]);await run('cardmarket','2026-09-02T12:00:00Z',[{type:'low',value:100}]);
  const bad=(await db.query(`select * from market_price_snapshots where printing_id='${uid(4)}' order by captured_at desc limit 1`)).rows[0];
  assert.equal(bad.is_anomalous,true);assert.equal(Number(bad.anomaly_ratio),10);
  assert.equal(Number(await scalar(`select normalized_price value from market_current_price_snapshots where printing_id='${uid(4)}'`)),10);
  assert.equal(await scalar(`select count(*)::int value from market_price_events where printing_id='${uid(4)}' and previous_snapshot_id<>current_snapshot_id`),1);
  await db.query("select confirm_market_price_anomaly('fixture',$1)",[bad.id]);
  assert.equal(Number(await scalar(`select normalized_price value from market_current_price_snapshots where printing_id='${uid(4)}'`)),100);
  await db.query('update market_price_snapshots set is_anomalous=true where id=$1',[bad.id]);
  assert.equal(Number(await scalar(`select normalized_price value from market_current_price_snapshots where printing_id='${uid(4)}'`)),10);
  console.log('PASS: non-primary anomaly detected/excluded; event generated; confirm/rebuild intact');
  const insert=async(n,type,age,price=10,x={})=>{
    const t=target(n,x.provider||'cardmarket');
    return (await db.query(`insert into market_price_snapshots(printing_id,provider_mapping_id,provider,price_type,original_currency,original_price,normalized_price,normalized_currency,captured_at,observation_key)
      values($1,$2,$3,$4,'EUR',$5,$6,$7,now()-($8::double precision*interval '1 day'),$9) returning id`,
      [t.printing_id,t.mapping_id,t.provider,type,price,x.nullPrice?null:price,x.currency||'EUR',age,x.key||`${t.mapping_id}:fixture:${type}:${age}`])).rows[0].id;
  };
  for(const [n,provider,type] of [[5,'cardmarket','trend'],[6,'cardtrader','reference']]){
    await seed(target(n,provider));for(let age=0;age<=366;age++)await insert(n,type,age,10,{provider});
    for(const days of [7,30,90,365]){const rows=(await db.query("select * from list_market_price_history('fixture',$1,$2)",[uid(n),days])).rows;assert.equal(rows.length,days);assert.ok(rows.every(row=>row.price_type===type));}
  }
  console.log('PASS: real trend/reference history RPC at 7/30/90/365 days');
  await seed(target(7));const old=[];
  for(const age of [100,90,80,70,60,50,40,36,35.1,34.9,30.1,29.9,7.1,6.9,1.1,.9])old.push(await insert(7,'avg1',age));
  await seed(target(8));for(const age of [120,100,80])await insert(8,'average',age);
  await seed(target(9));await insert(9,'low',100,10,{currency:'EUR'});await insert(9,'low',90,10,{currency:'USD'});await insert(9,'low',80,10,{nullPrice:true});
  const quarantined=await insert(9,'avg7',200,10,{key:`${uid(1009)}:current`});
  await insert(9,'avg7',100);await insert(9,'avg7',90);
  await seed(target(10));const previous=await insert(10,'average',500,10),current=await insert(10,'average',499,12);
  const refs=(await db.query('select snapshot_id id from market_current_price_snapshots union select previous_snapshot_id from market_price_events union select current_snapshot_id from market_price_events')).rows.map(r=>r.id);
  const protectedEvents=(await db.query('select * from market_price_events order by id')).rows;
  const projection=(await db.query('select * from market_current_price_snapshots order by snapshot_id')).rows;
  assert.equal(await scalar('select bucket value from fpt_retention.classify_market_snapshots() where id=$1',[quarantined]),'retention_keep');
  for(const id of [previous,current])assert.equal(await scalar('select bucket value from fpt_retention.classify_market_snapshots() where id=$1',[id]),'referenced');
  const rpcState=async()=>{
    const r={};for(const name of ['list_market_watch','list_market_watch_extra','get_market_watch_summary','list_market_dashboard_movers'])r[name]=await scalar(`select public.${name}('fixture','yugioh') value`);
    for(const sort of ['name','price','value','change'])r[sort]=await scalar("select list_market_watch_owned_page('fixture','yugioh',60,0,$1,null) value",[sort]);
    for(const n of [5,6])for(const days of [7,30,90,365])r[`${n}:${days}`]=(await db.query("select * from list_market_price_history('fixture',$1,$2)",[uid(n),days])).rows;
    return r;
  };
  const beforeRpc=await rpcState(),beforeCount=await count();
  const classified=(await db.query('select * from fpt_retention.classify_market_snapshots()')).rows;
  assert.equal(classified.length,beforeCount);assert.equal(new Set(classified.map(r=>r.id)).size,beforeCount);
  assert.deepEqual([...new Set(classified.map(r=>r.bucket))].sort(),['cleanup_candidate','history_series','referenced','retention_keep']);
  await db.exec(read('scripts/market-snapshot-retention-dry-run.sql'));assert.equal(await count(),beforeCount);
  const plan=(await db.query('select * from fpt_retention.cleanup_market_snapshots()')).rows;
  assert.ok(plan.length>0);assert.ok(plan.every(r=>r.action==='would_delete'));assert.equal(await count(),beforeCount);
  for(const args of ['false,0','false,1001','false,null','null,100'])await assert.rejects(()=>db.query(`select * from fpt_retention.cleanup_market_snapshots(${args})`));
  await db.exec('begin isolation level repeatable read');await assert.rejects(()=>db.query('select * from fpt_retention.cleanup_market_snapshots(false,1)'),/READ COMMITTED/);await db.exec('rollback');
  console.log('PASS: read-only dry run; invalid batch bounds/nulls/isolation rejected');
  const newlyReferenced=plan[0].snapshot_id;
  await db.query(`insert into market_price_events(printing_id,provider,previous_snapshot_id,current_snapshot_id,previous_price,current_price,absolute_change) values($1,'cardmarket',$2,$3,10,10,0)`,[uid(7),newlyReferenced,current]);
  const eventCount=await scalar('select count(*)::int value from market_price_events'),deleted=[];
  for(let i=0;i<100;i++){const batch=(await db.query('select * from fpt_retention.cleanup_market_snapshots(false,3)')).rows;assert.ok(batch.length<=3);assert.ok(batch.every(r=>r.action==='deleted'));deleted.push(...batch.map(r=>r.snapshot_id));if(!batch.length)break;}
  assert.ok(deleted.length>0);assert.ok(old.some(id=>deleted.includes(id)));assert.ok(!deleted.includes(newlyReferenced));assert.ok(!deleted.includes(quarantined));assert.ok(refs.every(id=>!deleted.includes(id)));
  assert.equal(await count(),beforeCount-deleted.length);assert.equal((await db.query('select * from fpt_retention.cleanup_market_snapshots(false,1000)')).rows.length,0);
  assert.equal(await scalar('select count(*)::int value from market_price_events'),eventCount);
  for(const e of protectedEvents)assert.deepEqual((await db.query('select * from market_price_events where id=$1',[e.id])).rows[0],e);
  assert.deepEqual((await db.query('select * from market_current_price_snapshots order by snapshot_id')).rows,projection);
  const afterRpc=await rpcState();for(const key of Object.keys(beforeRpc))assert.deepEqual(afterRpc[key],beforeRpc[key],`RPC parity: ${key}`);
  console.log(`PASS: ${deleted.length} redundant synthetic rows removed; refs/current/events protected; idempotent; real RPC outputs unchanged`);
  await db.exec('create table extra_snapshot_dependency(snapshot_id uuid references market_price_snapshots(id) on delete cascade)');await db.query('insert into extra_snapshot_dependency values($1)',[newlyReferenced]);
  assert.equal(await scalar("select count(*)::int value from fpt_retention.classify_market_snapshots() where bucket='cleanup_candidate'"),0);
  await assert.rejects(()=>db.query('select * from fpt_retention.cleanup_market_snapshots(false,1000)'),/Unknown snapshot FK/);
  assert.equal(await scalar('select count(*)::int value from extra_snapshot_dependency'),1);
  const dryReport=await db.exec(read('scripts/market-snapshot-retention-dry-run.sql'));assert.ok(dryReport.some(r=>r.rows?.some(row=>Number(row.unknown_fk_blockers)===1)));
  await db.exec('drop table extra_snapshot_dependency');
  for(const role of ['anon','authenticated']){
    assert.equal(await scalar("select has_function_privilege($1,'fpt_retention.cleanup_market_snapshots(boolean,integer)','EXECUTE') value",[role]),false);
    await db.exec(`set role ${role}`);await assert.rejects(()=>db.query('select * from fpt_retention.cleanup_market_snapshots(false,1)'),/permission denied/);await db.exec('reset role');
  }
  await db.exec('grant usage on schema fpt_retention to authenticated; grant execute on function fpt_retention.cleanup_market_snapshots(boolean,integer) to authenticated; set role authenticated');
  await assert.rejects(()=>db.query('select * from fpt_retention.cleanup_market_snapshots(false,1)'),/requires service_role/);await db.exec('reset role');
  await db.exec(read('supabase/manual/market-snapshot-retention-design.sql'));
  await db.exec('grant all on public.market_price_snapshots,public.market_current_price_snapshots,public.market_price_events to service_role; set role service_role');
  assert.equal((await db.query('select * from fpt_retention.cleanup_market_snapshots()')).rows.length,0);
  assert.equal((await db.query('select * from fpt_retention.cleanup_market_snapshots(false,1)')).rows.length,0);await db.exec('reset role');
  await db.exec(`create function public.fixture_delete_trigger() returns trigger language plpgsql as $$ begin return old; end; $$;
    create trigger fixture_delete_trigger before delete on market_price_snapshots for each row execute function fixture_delete_trigger();`);
  await assert.rejects(()=>db.query('select * from fpt_retention.cleanup_market_snapshots(false,1)'),/Unreviewed DELETE trigger/);
  await db.exec('drop trigger fixture_delete_trigger on market_price_snapshots');
  console.log('PASS: unknown FK/delete-trigger fail-closed, frontend revokes, runtime authorization, service-role execution');
  targets=Array.from({length:251},(_,i)=>target(i+100));await run('cardmarket','2026-09-03T12:00:00Z',types.map(type=>({type,value:10})),false);
  assert.deepEqual(writes.map(w=>w.rows.length),[250,250,250,250,250,250,6]);failWrite=true;
  const failure=await run('cardmarket','2026-09-03T12:00:00Z',[{type:'trend',value:10}],false);assert.equal(failure.status,'failed');assert.match(failure.error,/fixture write failure/);assert.equal(finished.at(-1)[1],'failed');
  console.log('PASS: batch size and error contract retained. STRICT RETENTION SUITE GREEN.');
} finally { await db.close(); }
