// Executes the real SQL in isolated PostgreSQL/WASM. No production writes/pushes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {notificationMessage} from '../api/_push-delivery.js';
const db=new PGlite();
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
let checks=0;
const test=async(name,fn)=>{await fn();checks++;console.log('PASS',name);};
try {
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table team_members(slug text primary key,active boolean default true);
 insert into team_members values('owner',true),('other',true),('inactive',false);
 create table card_printings(id uuid primary key,card_name text,set_code text,game text);
 create table collection_items(owner_slug text,printing_id uuid,quantity_owned integer);
 create table market_provider_printings(id uuid primary key,provider text,resolution_status text,provider_metadata jsonb);
 create table market_price_snapshots(id uuid primary key,printing_id uuid,provider_mapping_id uuid,provider text,price_type text,normalized_currency text,normalized_price numeric,captured_at timestamptz,language text,condition_reference text,foil boolean,metadata jsonb,is_anomalous boolean default false);
 create index on market_price_snapshots(printing_id,provider,price_type,captured_at desc);
 create table market_current_price_snapshots(provider_mapping_id uuid,price_type text,printing_id uuid,provider text,snapshot_id uuid,normalized_currency text,normalized_price numeric,language text,condition_reference text,foil boolean,captured_at timestamptz,updated_at timestamptz,primary key(provider_mapping_id,price_type));
 create table market_alert_preferences(member_slug text,printing_id uuid,enabled boolean default true,direction text default 'both',absolute_threshold numeric default 1,up_absolute_threshold numeric,down_absolute_threshold numeric,percentage_threshold numeric default 8,cooldown interval default interval '24 hours');
 create function market_mapping_is_active(text,text,jsonb) returns boolean language sql as $$select $2 in ('resolved','manual')$$;
 create function market_reference_type(text,text) returns integer language sql as $$select case $2 when 'trend' then 1 when 'avg7' then 3 when 'low' then 4 else 9 end$$;`);
 // Use the existing notification schema/constraints unchanged.
 await db.exec(fs.readFileSync('supabase-notifications-center.sql','utf8'));
 const sql=fs.readFileSync('supabase/manual/market-owned-euro-alerts.sql','utf8');
 await db.exec(sql);await db.exec(sql);
 const scope={priceScope:{product:'specific'},productUrl:'https://cardmarket.test/product/1',variantKey:'default'};
 async function advance(card,price,{hours=1,metadata=scope,anomalous=false,type='trend',currency='EUR',mapping=card.mapping}={}){
  const id=randomUUID();
  await db.query(`insert into market_price_snapshots(id,printing_id,provider_mapping_id,provider,price_type,normalized_currency,normalized_price,captured_at,language,condition_reference,foil,metadata,is_anomalous)
   values($1,$2,$3,'cardmarket',$4,$5,$6,now()-$7::interval,'en','NM',false,$8,$9)`,[id,card.id,mapping,type,currency,price,`${hours} hours`,metadata,anomalous]);
  await db.query(`insert into market_current_price_snapshots select provider_mapping_id,price_type,printing_id,provider,id,normalized_currency,normalized_price,language,condition_reference,foil,captured_at,now() from market_price_snapshots where id=$1
   on conflict(provider_mapping_id,price_type) do update set snapshot_id=excluded.snapshot_id,normalized_price=excluded.normalized_price,normalized_currency=excluded.normalized_currency,captured_at=excluded.captured_at`,[id]);
  return id;
 }
 async function card({owner='owner',quantity=1,base=10,metadata=scope,type='trend'}={}){
  const c={id:randomUUID(),mapping:randomUUID()};
  await db.query("insert into card_printings values($1,'Carta test','TEST-001','yugioh')",[c.id]);
  await db.query('insert into collection_items values($1,$2,$3)',[owner,c.id,quantity]);
  await db.query("insert into market_provider_printings values($1,'cardmarket','resolved','{}')",[c.mapping]);
  await advance(c,base,{hours:26,metadata,type});await advance(c,base,{hours:2,metadata,type});return c;
 }
 const scan=()=>scalar('select public.run_market_alert_scan()');
 const count=()=>scalar('select count(*)::int from notifications');
 await test('repeatable SQL, initial cursor and no historical notification backlog',async()=>{
  const c=await card();await advance(c,20);assert.equal(await scan(),0);assert.equal(await count(),0);
 });
 await test('2 EUR inclusive, both directions, no percentage trigger or quantity multiplier',async()=>{
  const up=await card(),down=await card(),small=await card({base:.1,quantity:100});await scan();
  await advance(up,12);await advance(down,8);await advance(small,2.09);
  assert.equal(await scan(),2);assert.equal(await count(),2);
  const rows=(await db.query('select * from notifications')).rows;
  assert(rows.some(r=>r.body.includes('+2,00 € per carta')));assert(rows.some(r=>r.body.includes('−2,00 € per carta')));
  const m=notificationMessage(rows[0]),link=new URL(m.url,'https://example.test');
  assert(link.hash.startsWith('#/collection?'));const params=new URLSearchParams(link.hash.split('?')[1]);
  assert.equal(params.get('game'),'yugioh');assert(params.get('printingId'));assert.equal(m.member,'owner');
 });
 await test('separate cards notify independently; same snapshot/scan never duplicates',async()=>{
  const a=await card(),b=await card();await scan();await advance(a,13);await advance(b,14);
  assert.equal(await scan(),2);assert.equal(await scan(),0);
  await advance(a,15,{hours:.5});assert.equal(await scan(),0);
 });
 await test('per-card cooldown permits a later daily event, never a delayed stale duplicate',async()=>{
  const c=await card();await scan();await advance(c,13);assert.equal(await scan(),1);
  await db.query("update market_owned_alert_state set last_notified_at=now()-interval '25 hours' where printing_id=$1",[c.id]);
  assert.equal(await scan(),0);await advance(c,14,{hours:.25});assert.equal(await scan(),1);
 });
 await test('only current owned cards: watchlist-only, zero quantity and inactive excluded',async()=>{
  const a=await card({quantity:0}),b=await card({owner:'inactive'}),c=await card({owner:'other'});await scan();
  await advance(a,20);await advance(b,20);await advance(c,12);assert.equal(await scan(),1);
  assert.equal(await scalar("select count(*)::int from notifications where member_slug='other'"),1);
 });
 await test('sale/removal clears cursor and reacquiring never sends previous movement',async()=>{
  const c=await card();await scan();await db.query('update collection_items set quantity_owned=0 where printing_id=$1',[c.id]);await scan();
  assert.equal(await scalar('select count(*)::int from market_owned_alert_state where printing_id=$1',[c.id]),0);
  await advance(c,20);await db.query('update collection_items set quantity_owned=1 where printing_id=$1',[c.id]);assert.equal(await scan(),0);
 });
 await test('anomalous, stale and future prices do not notify',async()=>{
  for(const opts of [{anomalous:true},{hours:38},{hours:-1}]){const c=await card();await scan();await advance(c,20,opts);assert.equal(await scan(),0);}
 });
 await test('scope, product identity and mapping changes do not masquerade as gains',async()=>{
  for(const metadata of [{...scope,priceScope:{product:'exact_variant'}},{...scope,productUrl:'https://cardmarket.test/product/2'},{...scope,variantKey:'new'}]){
   const c=await card();await scan();await advance(c,20,{metadata});assert.equal(await scan(),0);
  }
  const c=await card();await scan();const mapping=randomUUID();await db.query("insert into market_provider_printings values($1,'cardmarket','resolved','{}')",[mapping]);
  await advance(c,20,{mapping,hours:.2});assert.equal(await scan(),0);
 });
 await test('aggregate/ambiguous mappings do not notify; price types/currency are never mixed',async()=>{
  const a=await card({metadata:{priceScope:{product:'minimum_across_candidates'}}});await scan();await advance(a,20,{metadata:{priceScope:{product:'minimum_across_candidates'}}});assert.equal(await scan(),0);
  const b=await card();await db.query(`update market_provider_printings set provider_metadata='{"candidateProductIds":["1","2"]}' where id=$1`,[b.mapping]);await scan();await advance(b,20);assert.equal(await scan(),0);
  const c=await card();await scan();await advance(c,100,{type:'low'});assert.equal(await scan(),0);
  const d=await card();await scan();await advance(d,20,{currency:'USD'});assert.equal(await scan(),0);
 });
 await test('member preferences opt out/direction work; legacy percentage never bypasses 2 EUR',async()=>{
  const a=await card(),b=await card(),c=await card();await scan();
  await db.query("insert into market_alert_preferences(member_slug,printing_id,enabled) values('owner',$1,false)",[a.id]);
  await db.query("insert into market_alert_preferences(member_slug,printing_id,direction) values('owner',$1,'up')",[b.id]);
  await db.query("insert into market_alert_preferences(member_slug,printing_id,absolute_threshold,percentage_threshold) values('owner',$1,0,0)",[c.id]);
  await advance(a,20);await advance(b,8);await advance(c,11.99);assert.equal(await scan(),0);
 });
 await test('scanner/cursors inaccessible to client roles, service-only execution, RLS enabled',async()=>{
  assert.equal(await scalar("select relrowsecurity from pg_class where oid='market_owned_alert_state'::regclass"),true);
  await db.exec('set role anon');await assert.rejects(scan(),/permission denied/);await assert.rejects(db.query('select * from market_owned_alert_state'),/permission denied/);
  await db.exec('reset role;set role authenticated');await assert.rejects(scan(),/permission denied/);
  await db.exec('reset role;set role service_role');assert.equal(await scan(),0);await db.exec('reset role');
 });
 console.log(`${checks} market-owned EUR alert checks passed`);
}finally{await db.close();}
