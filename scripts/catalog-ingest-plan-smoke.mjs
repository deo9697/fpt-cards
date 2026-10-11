import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { planCatalogIngest } from './lib/catalog-ingest-plan.mjs';
const printing=(code,rarity='Ultra Rare',extra={})=>({set_code:code,set_name:'Fixture set',set_rarity:rarity,...extra});
const card=(id,sets,extra={})=>({id,name:'Fixture '+id,card_sets:sets,card_images:[{id}],...extra});
const fixture=[card(48393693,[printing('MAMO-EN012')]),card(75787708,[printing('MAMO-EN013'),printing('MAMO-EN013','Starlight Rare'),printing('OTHER-EN013')]),card(1186447,[printing('MAMO-EN014')]),card(94145022,[printing('TEST-EN001')]),card(94145021,[printing('TEST-EN001')]),card(90000123,[printing('ART-EN001','Ultra Rare',{variant_id:'a'}),printing('ART-EN001','Ultra Rare',{variant_id:'b'})],{card_images:[{id:90000123},{id:90000124}]}),card(90000222,[printing('BAD-EN001','New'),printing('BAD-EN002',''),printing('BAD-EN003','Ultra Rare',{set_name:''})]),card(null,[printing('BAD-EN004')])];
const plan=planCatalogIngest(fixture);
assert.equal(plan.decisions.length,fixture.reduce((sum,row)=>sum+row.card_sets.length,0));
assert.equal(plan.rows.length,8);
assert.equal(plan.decisions.filter(row=>row.classification==='INVALID_SOURCE_RECORD').length,4);
assert.equal(plan.decisions.filter(row=>row.reason==='VERIFIED_CATALOG_ALIAS').length,1);
assert.deepEqual(plan.rows.find(row=>row.set_code==='TEST-EN001').source_ids,['94145022','94145021']);
assert.equal(plan.rows.filter(row=>row.set_code==='ART-EN001').length,2);
assert.equal(plan.rows.find(row=>row.set_code==='MAMO-EN013').catalog_card_id,'75787708');
assert(plan.rows.every(row=>row.rarity!=='Common'),'a source tag cannot manufacture a Common printing');
assert.equal(plan.executable,false);
const db=new PGlite();
try{
  await db.exec('create table card_printings(game text,catalog_card_id text,set_code text,rarity text,variant_id text,unique(game,catalog_card_id,set_code,rarity,variant_id));');
  async function applyLocal(rows){for(const row of rows)await db.query('insert into card_printings values($1,$2,$3,$4,$5) on conflict do nothing',[row.game,row.catalog_card_id,row.set_code,row.rarity,row.variant_id]);}
  const initial=planCatalogIngest([fixture[0],fixture[2]]);await applyLocal(initial.rows);
  const existing=(await db.query('select * from card_printings')).rows;
  const incremental=planCatalogIngest(fixture,existing);assert.equal(incremental.rows.length,6);
  await applyLocal(incremental.rows);await applyLocal(incremental.rows);
  assert.equal(Number((await db.query('select count(*) n from card_printings')).rows[0].n),8);
  for(const code of ['MAMO-EN012','MAMO-EN013','MAMO-EN014'])assert((await db.query('select * from card_printings where set_code=$1',[code])).rows.length,code);
  assert.equal(planCatalogIngest(fixture,(await db.query('select * from card_printings')).rows).rows.length,0);
  // Exercise the repository's actual incremental RPC with a new UUID smaller
  // than the previous cursor; UUID-only pagination would miss this row.
  await db.exec(`alter table card_printings add column id uuid default gen_random_uuid(), add column created_at timestamptz default clock_timestamp(), add column card_name text default 'Fixture', add column set_name text default 'Fixture';
    create schema extensions; create role anon; create role authenticated;
    create function public.session_member(text) returns text language sql as $$ select 'fixture'::text $$;`);
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20260915110000_list_catalog_printings_index_created_at_cursor.sql',import.meta.url),'utf8'));
  const page=(await db.query("select * from list_catalog_printings_index('fixture','yugioh',null,1000)")).rows;
  const cursor=page.at(-1).printing_id;
  await db.query("insert into card_printings(game,catalog_card_id,set_code,rarity,variant_id,id,created_at) values('yugioh','90000888','LATE-EN001','Ultra Rare','','00000000-0000-4000-8000-000000000001',clock_timestamp()+interval '1 second')");
  const next=(await db.query("select * from list_catalog_printings_index('fixture','yugioh',$1,1000)",[cursor])).rows;
  assert.equal(next.length,1);assert.equal(next[0].set_code,'LATE-EN001');
}finally{await db.close();}
console.log('PASS deterministic local ingest: 012/013/014, alias merge with provenance, rarities, explicit artwork variants, invalid fields/tags, multiple sets, incremental insert and replay idempotency');
