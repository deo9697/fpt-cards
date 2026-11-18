// SPDX-License-Identifier: AGPL-3.0-or-later
// Disposable Postgres. No production identities, rows or notifications.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),team='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',id='20000000-0000-4000-8000-000000000001',request='30000000-0000-4000-8000-000000000001';
const rows=async(sql,params=[])=>(await db.query(sql,params)).rows;
try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public to anon,authenticated,service_role;create table public.teams(id uuid primary key);create table public.team_members(slug text primary key,team_id uuid references public.teams(id),active boolean not null default true,kind text not null default 'legacy');grant select on public.team_members to service_role;`);
  await rows('insert into public.teams values ($1),($2)',[team,other]);
  await rows("insert into public.team_members(slug,team_id,active) values ('owner',$1,true),('guest',$1,true),('external',$2,true),('inactive',$1,false)",[team,other]);
  await db.exec(fs.readFileSync('supabase/migrations/20261118063256_yugioh_personal_auto_practice.sql','utf8'));
  for(const role of ['anon','authenticated']){
    await db.exec(`set role ${role}`);
    for(const sql of ['select * from public.yugioh_practice_sessions','insert into public.yugioh_practice_sessions default values','update public.yugioh_practice_sessions set version=2','delete from public.yugioh_practice_sessions','select public.yugioh_practice_guard()'])await assert.rejects(()=>db.exec(sql),/permission denied/);
    await db.exec('reset role');
  }
  assert.equal((await rows("select relrowsecurity from pg_class where oid='public.yugioh_practice_sessions'::regclass"))[0].relrowsecurity,true);
  await db.exec('set role service_role');
  const insert=(sid,owner='owner',tid=team)=>rows("insert into public.yugioh_practice_sessions(id,team_id,owner_slug,status,state,start_request_id,start_request_ids,last_action_id) values ($1,$2,$3,'playing','{\"mode\":\"auto\"}',$4,array[$4::uuid],$4) returning id,version",[sid,tid,owner,request]);
  await insert(id);
  await assert.rejects(()=>insert(crypto.randomUUID()),/duplicate key/);
  for(const state of ['{}','[]','{"mode":"manual"}','{"mode":null}'])await assert.rejects(()=>rows('update public.yugioh_practice_sessions set state=$2::jsonb,version=version+1 where id=$1',[id,state]),/check constraint/);
  for(const history of [[null],[request,null],[]])await assert.rejects(()=>rows('update public.yugioh_practice_sessions set start_request_ids=$2::uuid[],version=version+1 where id=$1',[id,history]),/check constraint/);
  for(const[owner,tid]of[['external',team],['inactive',team],['owner',other]])await assert.rejects(()=>insert(crypto.randomUUID(),owner,tid),/membro attivo/);
  await assert.rejects(()=>rows("update public.yugioh_practice_sessions set owner_slug='guest',version=version+1 where id=$1",[id]),/proprietario/);
  await assert.rejects(()=>rows('update public.yugioh_practice_sessions set version=3 where id=$1',[id]),/avanzare/);
  assert.equal((await rows('update public.yugioh_practice_sessions set version=version+1 where id=$1 and version=1 returning version',[id]))[0].version,2);
  assert.equal((await rows('update public.yugioh_practice_sessions set version=version+1 where id=$1 and version=1 returning version',[id])).length,0);
  const restarted=crypto.randomUUID();await rows('update public.yugioh_practice_sessions set id=$2,version=version+1 where id=$1 and version=2',[id,restarted]);
  assert.equal((await rows('select count(*)::int as n from public.yugioh_practice_sessions'))[0].n,1);
  assert.equal((await rows('select id from public.yugioh_practice_sessions'))[0].id,restarted);
  await db.exec('reset role');await rows("update public.team_members set active=false where slug='owner'");await db.exec('set role service_role');
  await assert.rejects(()=>rows('update public.yugioh_practice_sessions set version=version+1 where id=$1',[restarted]),/membro attivo/);
  console.log('PASS personal-practice schema: private RLS/grants, one owner row, current membership, immutable scope, version CAS and replacement ID.');
}finally{await db.close();}
