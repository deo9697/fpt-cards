// Local commit-readiness audit only. Never stages, commits, deploys or contacts a backend.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root=process.cwd();
const output='docs/audit-snapshots/commit-readiness-2026-10-08';
const artifacts='artifacts/commit-readiness-2026-10-08';
const gitExe=process.env.FPT_GIT || (process.platform==='win32'?'C:/Program Files/Git/cmd/git.exe':'git');
const git=(...args)=>execFileSync(gitExe,['-c',`safe.directory=${root.replaceAll('\\','/')}`,...args],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});
fs.mkdirSync(output,{recursive:true});fs.mkdirSync(artifacts,{recursive:true});
for(const [name,args] of Object.entries({status:['status','--short'],diffstat:['diff','--stat'],names:['diff','--name-status'],diffcheck:['diff','--check'],log:['log','-15','--oneline']}))fs.writeFileSync(`${artifacts}/${name}.txt`,git(...args));
const selected=new Set([
  'js/cards.js','js/collection-share.js','js/fast-scan-core.js','js/fast-scan.js',
  'scripts/collection-routing-browser-smoke.mjs','scripts/collection-share-bootstrap-guard-smoke.mjs','scripts/collection-share-guest-smoke.mjs','scripts/fast-scan-milestone-smoke.mjs',
  'scripts/catalog-integrity-audit.mjs','scripts/catalog-integrity-audit-smoke.mjs','scripts/catalog-printing-completeness-smoke.mjs','scripts/fast-scan-catalog-diagnostic-smoke.mjs','scripts/fixtures/fast-scan-stabilization-corpus.json','scripts/collection-share-performance-benchmark.mjs','scripts/production-stabilization-tests.mjs',
  'scripts/lib/catalog-ingest-plan.mjs','scripts/catalog-ingest-plan-smoke.mjs','scripts/catalog-identities-review-smoke.mjs','scripts/review-missing-catalog-identities.mjs','scripts/build-catalog-repair-plan.mjs','scripts/build-migration-drift-report.mjs','scripts/probe-fresh-migrations.mjs',
  'docs/missing-catalog-identities-review.json','docs/missing-catalog-identities-review.md','docs/catalog-repair-plan.json','docs/catalog-repair-plan.md','docs/migration-drift-report.md','docs/real-device-stabilization-checklist.md','docs/mamo-en013-root-cause.md',
  'docs/audit-snapshots/production-stabilization-2026-10-05/mamo-source.json','docs/audit-snapshots/production-stabilization-2026-10-05/mamo-audit.json',
  ...['live-readonly','related-db-identities','konami-facts','migration-text-hashes','ingest-live-functions','migration-drift','fresh-migration-probe'].map(name=>'docs/audit-snapshots/stabilization-blockers-2026-10-08/'+name+'.json')
]);
const extra=[
  'supabase/functions/market-sync/index.ts','supabase/functions/market-refresh-queue-cached/index.ts','supabase/config.toml',
  'scripts/market-watch-browser-smoke.mjs','scripts/market-watch-loading-smoke.mjs',
  'scripts/market-egress-rollout-smoke.mjs','scripts/market-feed-hardening-smoke.mjs','scripts/market-snapshot-retention-smoke.mjs','scripts/market-sync-egress-smoke.mjs',
  'scripts/build-market-egress-rollout-package.mjs','scripts/build-market-retention-sql.mjs','scripts/market-feed-egress-audit.sql','scripts/market-snapshot-retention-dry-run.sql','scripts/market-snapshot-retention-policy.sql',
  'supabase/manual/market-feed-queue-probe.sql','supabase/manual/market-egress-cron-rollout.sql','supabase/manual/market-egress-live-verification.sql','supabase/manual/market-egress-queue-canary.sql','supabase/manual/market-egress-rollout-rollback.sql','supabase/manual/market-append-only-restore.sql','supabase/manual/market-snapshot-retention-design.sql',
  'docs/market-egress-live-rollout-2026-10-04.md','docs/market-egress-rollout-operator-notes.md','docs/market-feed-egress-2026-10-04.md','docs/market-retention-append-only-2026-10-03.md','docs/market-retention-egress-2026-10-03.md','docs/production-baseline-2026-10-05.md','docs/stabilization-blockers-2026-10-08.md',
  'docs/archive/20261003203253_market_snapshot_storage_hardening.sql',
  'docs/audit-snapshots/market-egress-2026-10-04/market-refresh-queue-cached-v2.ts',
  'scripts/audit-stabilization-tranche.mjs','docs/stabilization-commit-readiness-2026-10-08.md'
];
for(const file of extra)selected.add(file);
// Older isolation tooling intentionally excluded: its scope predates the Market inclusion.
selected.delete('scripts/prepare-stabilization-tranche.mjs');
const records=git('status','--porcelain=v1','-z','--untracked-files=all').split('\0').filter(Boolean).map(line=>({status:line.slice(0,2),file:line.slice(3)}));
const rows=records.map(({file,status})=>{
  let classification='F. UNKNOWN',why='Not yet attributed',keep=false,risk='Needs review';
  if(file==='package.json'||file==='package-lock.json')return {file,status,classification:'A. STABILIZATION_TRANCHE',why:'MIXED_FILE: select four Market scripts and PGlite dependency only; derive matching lock from selected package',keep:'EXTRACT',risk:'Never stage current whole file'};
  if(selected.has(file)){
    classification=file.startsWith('docs/')?'C. GENERATED_REPORT':file.startsWith('scripts/')?'D. TEST_FIXTURE':'A. STABILIZATION_TRANCHE';
    why=file.startsWith('docs/archive/')?'Historical SQL evidence only; excluded from automatic migrations':file.startsWith('supabase/manual/')?'Manual reviewed design/operator SQL; never automatic migration':file.startsWith('docs/')?'Stabilization evidence or operator documentation':file.startsWith('scripts/')?'Stabilization audit or regression validation':'Catalog, scanner, shared collection or Market egress fix';
    keep=true;risk=file.includes('/manual/')?'Manual production action requires separate rollout':file.startsWith('docs/')?'Historical evidence, not refreshed live status':'Validate on isolated HEAD';
  }else if(file.startsWith('artifacts/')||file.startsWith('.claude/')||file.endsWith('.log')||file.endsWith('.html')&&file.startsWith('docs/audit-snapshots/')||file==='scripts/.isolate-fast-scan.mjs'){
    classification='E. BUILD_OR_TEMP_ARTIFACT';why='Local artifact, raw capture, log or developer settings';risk='Exclude';
  }else if(file.startsWith(output+'/')||file==='docs/stabilization-working-tree-inventory.md'){
    classification='C. GENERATED_REPORT';why='Current readiness inventory/evidence';keep=true;risk='Snapshot of this audit';
  }else if(file==='docs/supabase-egress-audit-2026-09-26.md'||file.startsWith('docs/audit-snapshots/production-stabilization-')||file.startsWith('docs/audit-snapshots/stabilization-blockers-')||file.startsWith('docs/audit-snapshots/market-egress-')){
    classification='C. GENERATED_REPORT';why='Supplementary historical evidence; outside minimal reproducible commit set';risk='Exclude raw or redundant snapshot';
  }else if(file==='scripts/production-baseline-audit.mjs'||file==='scripts/prepare-stabilization-tranche.mjs'){
    classification='D. TEST_FIXTURE';why='Historical one-off tooling with fixed date/path or obsolete tranche scope';risk='Exclude until made reusable';
  }else if(file==='scripts/market-watch-core-smoke.mjs'){
    classification='E. BUILD_OR_TEMP_ARTIFACT';why='Git status entry but no textual diff (line-ending/index stat noise)';risk='Exclude';
  }else{
    classification='B. PREVIOUS_UNRELATED_WORK';why='Existing auth, identity, User Edition, pilot/security or supporting app changes outside stabilization scope';risk='Preserve untouched; separate review';
  }
  return {file,status,classification,why,keep,risk};
});
const counts=Object.fromEntries([...new Set(rows.map(r=>r.classification))].map(c=>[c,rows.filter(r=>r.classification===c).length]));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest={base:git('rev-parse','HEAD').trim(),scope:'Market egress + catalog + Fast Scan + shared collection stabilization; no live action',files:[...selected].filter(f=>fs.existsSync(f)).sort().map(file=>({file,sha256:hash(file)})),mixed:{'package.json':'Only test:market-retention, test:market-feed-hardening, test:market-egress-rollout, test:market-retention-sql-sync and devDependencies.@electric-sql/pglite','package-lock.json':'Derive lock matching isolated selected package; do not copy root metadata blindly'},counts,total:rows.length,tracked:rows.filter(r=>r.status!=='??').length,untracked:rows.filter(r=>r.status==='??').length};
manifest.evidenceFiles=['docs/stabilization-working-tree-inventory.md',...['inventory','proposed-manifest','hygiene','catalog-new-repro','validation'].map(name=>`${output}/${name}.json`)];
manifest.readiness='NO: runtime New-to-Common regression is reproduced; this is a candidate set, not an approval to commit';
fs.writeFileSync(`${output}/inventory.json`,JSON.stringify({counts,rows},null,2)+'\n');
fs.writeFileSync(`${output}/proposed-manifest.json`,JSON.stringify(manifest,null,2)+'\n');
const cell=v=>String(v).replaceAll('|','\\|').replaceAll('\n',' ');
fs.writeFileSync('docs/stabilization-working-tree-inventory.md','# Complete working-tree inventory — 2026-10-08\n\nEvery Git-visible changed/untracked file is listed, including individual generated artifact paths. Ignored dependencies are not Git candidates. Counts describe this capture; rerun after new evidence is written. No staging performed.\n\n'+JSON.stringify({total:manifest.total,tracked:manifest.tracked,untracked:manifest.untracked,counts},null,2)+'\n\n| FILE | STATUS | CLASSIFICATION | WHY | KEEP IN TRANCHE? | RISK |\n|---|---|---|---|---|---|\n'+rows.map(r=>'| '+[r.file,r.status,r.classification,r.why,r.keep===true?'YES':r.keep||'NO',r.risk].map(cell).join(' | ')+' |').join('\n')+'\n');
console.log(JSON.stringify({total:manifest.total,tracked:manifest.tracked,untracked:manifest.untracked,proposedFiles:manifest.files.length,counts}));
