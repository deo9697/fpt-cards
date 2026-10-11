import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db=new PGlite(),result={environment:'Disposable PGlite, NOT a Supabase production schema',applied:[],failure:null};
try{
  await db.exec('create role anon; create role authenticated; create role service_role; create schema extensions; create schema auth; create table auth.users(id uuid primary key);');
  for(const file of fs.readdirSync('supabase/migrations').filter(file=>file.endsWith('.sql')).sort()){
    try{await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));result.applied.push(file);}
    catch(error){result.failure={file,message:error.message,code:error.code};break;}
  }
  if(result.failure?.message.includes('vault.secrets')){
    result.platform_failure=result.failure;result.failure=null;
    await db.exec("create schema vault;create table vault.secrets(name text);insert into vault.secrets values('market_sync_secret');create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;");
    for(const file of fs.readdirSync('supabase/migrations').filter(file=>file.endsWith('.sql')&&!result.applied.includes(file)).sort()){
      try{await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));result.applied.push(file);}
      catch(error){result.failure={file,message:error.message,code:error.code};break;}
    }
    result.note='Vault/cron replaced with inert local stubs solely to expose application prerequisites. No HTTP calls or scheduled jobs execute.';
  }
}finally{await db.close();}
fs.writeFileSync('docs/audit-snapshots/stabilization-blockers-2026-10-08/fresh-migration-probe.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
