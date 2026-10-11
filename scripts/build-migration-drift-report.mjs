import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { decodeSnapshot } from './review-missing-catalog-identities.mjs';
const folder='docs/audit-snapshots/stabilization-blockers-2026-10-08';
const live=decodeSnapshot(JSON.parse(fs.readFileSync(folder+'/live-readonly.json','utf8')));
const rawHashes=JSON.parse(fs.readFileSync(folder+'/migration-text-hashes.json','utf8'));
const hashRows=JSON.parse(rawHashes.result.match(/\n(\[[\s\S]*\])\n<\/untrusted-data/)[1]);
for(const record of live.migrations)record.normalized_hash=hashRows.find(row=>row.version===record.version)?.text_hash;
// Never lowercase or strip internal whitespace: SQL string literals matter.
const normalize=text=>text.replaceAll('\r\n','\n').trim();
const hash=text=>createHash('md5').update(normalize(text)).digest('hex');
function files(directory){return fs.existsSync(directory)?fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(directory,entry.name)):entry.name.endsWith('.sql')?[path.join(directory,entry.name).replaceAll('\\','/')]:[]):[];}
const paths=[...fs.readdirSync('.').filter(file=>file.endsWith('.sql')),...files('supabase/migrations'),...files('supabase/manual'),...files('docs/archive')];
const local=paths.map(file=>{const text=fs.readFileSync(file,'utf8');return {file,version:file.match(/\/(\d{14})_/)?.[1],name:path.basename(file).replace(/^\d+_/,'').replace(/\.sql$/,''),hash:hash(text),objects:[...text.matchAll(/create\s+(?:or\s+replace\s+)?(?:function|table|view)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)].map(match=>match[1])};});
const names=new Set([...live.relations.map(row=>row.name),...live.functions.map(row=>row.name)]);
const rows=[];
for(const record of live.migrations){
  if(local.some(row=>row.file.startsWith('supabase/migrations/')&&row.version===record.version))continue;
  const exact=local.filter(row=>row.hash===record.normalized_hash),similar=local.filter(row=>row.name===record.name||row.name.replaceAll('-','_').replace(/^supabase_/,'')===record.name);
  const candidates=exact.length?exact:similar;
  const classification=exact.length?'SAME_CHANGE_DIFFERENT_HISTORY':similar.length?'MISSING_LOCAL_HISTORY':'LIVE_ONLY';
  rows.push({side:'LIVE',version:record.version,name:record.name,classification,local_candidates:candidates.map(row=>row.file),present_objects:[...new Set(candidates.flatMap(row=>row.objects).filter(name=>names.has(name)))],evidence:exact.length?'Entire SQL whitespace-normalized hash matches recorded statements':similar.length?'Local SQL name matches; history version absent. Content equivalence NOT proven':'Recorded live migration has no exact hash/name counterpart in inspected repository SQL',action:'Preserve live record. Review SQL/schema in disposable environment; do not rerun live.'});
}
for(const row of local.filter(row=>row.file.startsWith('supabase/migrations/'))){
  if(live.migrations.some(record=>record.version===row.version))continue;
  const exact=live.migrations.filter(record=>record.normalized_hash===row.hash);
  const present=row.objects.filter(name=>names.has(name));
  const obsolete=row.name==='list_catalog_printings_index';
  const classification=exact.length?'SAME_CHANGE_DIFFERENT_HISTORY':obsolete?'OBSOLETE_LOCAL':row.objects.length&&!present.length?'LOCAL_ONLY':'UNKNOWN';
  rows.push({side:'LOCAL',version:row.version,name:row.name,file:row.file,classification,live_candidates:exact.map(record=>record.version),present_objects:present,absent_objects:row.objects.filter(name=>!names.has(name)),evidence:exact.length?'Entire SQL whitespace-normalized hash matches live history':obsolete?'UUID-only cursor superseded by created_at/id cursor verified in live function':present.length?'Named features exist live, but presence does not establish DDL/body/policy equivalence':'No conclusive matching history or created-object evidence',action:obsolete?'Retain historical ordering; final bootstrap must install the later cursor. Do not replay obsolete definition alone.':'Review dependencies and current definitions before adding a bootstrap reconciliation step.'});
}
const summary=Object.fromEntries(['LOCAL_ONLY','LIVE_ONLY','SAME_CHANGE_DIFFERENT_HISTORY','OBSOLETE_LOCAL','MISSING_LOCAL_HISTORY','UNKNOWN'].map(name=>[name,rows.filter(row=>row.classification===name).length]));
fs.writeFileSync(folder+'/migration-drift.json',JSON.stringify({summary,rows,scope:'History version mismatches; schema evidence is named relation/function presence, not complete structural equivalence'},null,2)+'\n');
fs.writeFileSync('docs/migration-drift-report.md','# Migration drift — 2026-10-08\n\nRead-only comparison of repository SQL, current live history, and actual public relation/function signatures. No record deletion, renaming, history repair, live DDL or replay.\n\n'+Object.entries(summary).map(([name,count])=>`- ${name}: ${count}`).join('\n')+'\n\n`UNKNOWN` is intentional: matching names/objects cannot prove equivalent policies, columns, grants or function bodies. Exact normalized hashes establish matching submitted SQL, not that later migrations have not superseded it. Full evidence: [JSON](audit-snapshots/stabilization-blockers-2026-10-08/migration-drift.json).\n\n| Side | Version / name | Classification | Local evidence | Present live objects |\n|---|---|---|---|---|\n'+rows.map(row=>`| ${row.side} | ${row.version} ${row.name} | ${row.classification} | ${row.file||(row.local_candidates||[]).join(', ')||'No matched file'} | ${row.present_objects.join(', ')||'Not established'} |`).join('\n')+'\n\n## Safest convergence strategy\n\n1. Freeze the historical ledger; never make the live database accept a fictitious migration history.\n2. Establish a disposable Supabase-compatible bootstrap including root SQL prerequisites; the migrations directory alone is not a demonstrated fresh-environment recipe.\n3. Compare resulting columns, constraints, indexes, triggers, grants, RLS policies and function bodies against a reviewed current-schema manifest. Names alone are insufficient.\n4. Preserve ordered historical migrations. Add a reviewed forward-only local reconciliation migration only after discrepancies are reproduced; no automatic application to production.\n5. Replay from an empty environment and a representative older baseline, then run RPC and security regressions. Current recommendation: do not run `supabase db push`.\n6. Market manual SQL must be incorporated into that bootstrap deliberately; the rolling UPDATE trigger must remain absent while its historical live record is preserved.\n\nConvergence is NOT proven by this report. Unknown content mismatches remain a deployment blocker; this report makes each one explicit rather than repairing history blindly.\n');
console.log(JSON.stringify(summary));
