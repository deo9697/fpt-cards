// Offline SQL execution. pg_cron and pg_net are replaced by recording fixtures;
// SQL parsing, transactions, guards, schedules and timezone logic are real PG.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
const rollout=read('supabase/manual/market-egress-cron-rollout.sql');
const rollback=read('supabase/manual/market-egress-rollout-rollback.sql');
assert.doesNotMatch(rollout+rollback,/cron\.(?:schedule|unschedule)\s*\(/i);
const db=new PGlite();
try{
  await db.exec(`create schema cron;create schema vault;create schema net;
    create table cron.job(jobid bigint primary key,jobname text,schedule text,command text,active boolean);
    insert into cron.job values(5,'fpt-market-refresh-queue','old','old',false),(6,'fpt-market-sync-daily','old','old',false);
    create function cron.alter_job(job_id bigint,schedule text default null,command text default null,database text default null,username text default null,active boolean default null)
    returns void language sql as $$update cron.job j set schedule=coalesce($2,j.schedule),command=coalesce($3,j.command),active=coalesce($6,j.active) where j.jobid=$1$$;
    create table vault.decrypted_secrets(name text,decrypted_secret text);
    insert into vault.decrypted_secrets values('market_sync_secret','offline-fixture');
    create table market_provider_sync_runs(status text);
    create function market_refresh_queue_pending() returns boolean language sql as $$select false$$;
    create table net.calls(id bigserial,url text,headers jsonb,body jsonb,timeout_ms integer);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer)
    returns bigint language sql as $$insert into net.calls(url,headers,body,timeout_ms) values($1,$2,$3,$4) returning id$$;`);
  await db.exec(rollout);await db.exec(rollout);
  let jobs=(await db.query('select * from cron.job order by jobid')).rows;
  assert.equal(jobs.length,2);assert.ok(jobs.every(j=>!j.active));
  assert.equal(jobs[0].schedule,'5,20,35,50 * * * *');assert.equal(jobs[1].schedule,'0 1,2 * * *');
  await db.exec(jobs[0].command);
  let calls=(await db.query('select * from net.calls')).rows;
  assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/market-refresh-queue-cached'));assert.deepEqual(calls[0].body,{refreshQueue:true});
  assert.equal(calls[0].headers['x-market-sync-secret'],'offline-fixture');assert.equal(calls[0].timeout_ms,30000);
  await db.exec(read('supabase/manual/market-egress-queue-canary.sql'));
  assert.equal(Number((await db.query('select count(*) n from net.calls')).rows[0].n),2);
  // Exactly one of the two UTC slots hits 03 Rome, winter/summer/DST transition.
  for(const day of ['2026-01-15','2026-07-15','2026-03-29','2026-10-25']){
    const before=Number((await db.query('select count(*) n from net.calls')).rows[0].n);
    for(const hour of ['01','02'])await db.exec(jobs[1].command.replaceAll('now()',`timestamptz '${day} ${hour}:00:00+00'`));
    assert.equal(Number((await db.query('select count(*) n from net.calls')).rows[0].n)-before,1,day);
  }
  calls=(await db.query('select * from net.calls order by id')).rows;
  for(const c of calls.slice(2)){assert.ok(c.url.endsWith('/market-sync'));assert.deepEqual(c.body,{mode:'daily_full',scheduled:true,pricesOnly:true,recoverStale:true});assert.equal(c.timeout_ms,120000);}
  // Active run refuses alteration after a committed pause.
  await db.exec("insert into market_provider_sync_runs values('running');update cron.job set active=true");
  await assert.rejects(db.exec(rollout),/Active sync runs/);await db.exec('rollback');
  assert.ok((await db.query('select active from cron.job')).rows.every(j=>!j.active));
  await db.exec(rollback);await db.exec(rollback);
  jobs=(await db.query('select * from cron.job order by jobid')).rows;
  assert.equal(jobs.length,2);assert.ok(jobs.every(j=>!j.active));
  await db.exec(jobs[1].command.replaceAll('now()',"timestamptz '2026-07-15 01:00:00+00'"));
  const prior=(await db.query('select * from net.calls order by id desc limit 1')).rows[0];
  assert.ok(prior.url.endsWith('/market-refresh-queue-cached'));
  assert.deepEqual(prior.body,{pricesOnly:true,recoverStale:true,source:'daily_price_refresh'});
  console.log('PASS rollout/rollback SQL idempotency, existing jobs, paused state, Vault header, payloads, DST guard, active-run refusal');
}finally{await db.close();}
