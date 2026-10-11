// Local files only. Builds a reviewable bundle; never deploys or executes SQL.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const check=process.argv.includes('--check');
const bundle='artifacts/market-egress-rollout-2026-10-04';
const files=[
  'supabase/functions/market-sync/index.ts',
  'supabase/functions/market-refresh-queue-cached/index.ts',
  'supabase/config.toml',
  'supabase/manual/market-feed-queue-probe.sql',
  'supabase/manual/market-egress-cron-rollout.sql',
  'supabase/manual/market-egress-rollout-rollback.sql',
  'supabase/manual/market-egress-queue-canary.sql',
  'supabase/manual/market-egress-live-verification.sql',
  'docs/market-egress-rollout-operator-notes.md',
  'docs/audit-snapshots/market-egress-2026-10-04/market-refresh-queue-cached-v2.ts',
];
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const git=process.platform==='win32'?'C:/Program Files/Git/cmd/git.exe':'git';
const diff=execFileSync(git,['-c',`safe.directory=${root.replaceAll('\\','/')}`,'diff','--no-ext-diff','--','supabase/functions/market-sync/index.ts'],{cwd:root,encoding:'utf8'});
const notes=read('docs/market-egress-rollout-operator-notes.md');
const section=(letter,title,p,lang)=>`## ${letter}. ${title}\n\nFILE: \`${p}\`\n\n\`\`\`${lang}\n${read(p).trimEnd()}\n\`\`\`\n`;
let output='# FPT Cards — exact live rollout package, 2026-10-04\n\n';
output+='PREPARED ONLY. No live calls, deploy, secrets changes, cron changes, commit or push.\n';
output+='The complete deployable market-sync source is included in the accompanying bundle; do not reconstruct it from a partial patch.\n\n';
output+=section('A','QUEUE WRAPPER FULL CONTENT',files[1],'ts');
output+=section('B','CANONICAL PRIVATE RPC FULL CONTENT',files[3],'sql');
output+=section('C','CRON ROLLOUT FULL CONTENT',files[4],'sql');
output+=section('D','CRON ROLLBACK FULL CONTENT',files[5],'sql');
output+='## E. DIFF — market-sync P0 only\n\nRelative to local Git HEAD, not a fetched live v57 source. Deploy the complete source supplied in this bundle.\n\n```diff\n'+diff.trimEnd()+'\n```\n\n';
const f=notes.indexOf('## F.'),g=notes.indexOf('## G.'),rollback=notes.indexOf('## Rollback code'),i=notes.indexOf('## I.');
output+=notes.slice(f,g)+'\n'+notes.slice(g,rollback)+'\n';
output+=section('H','EXACT LIVE VERIFICATION QUERIES',files[7],'sql');
output+=notes.slice(i)+'\n'+notes.slice(rollback,i)+'\n';
output+='## Manual queue canary SQL — execute only at step 7\n\n```sql\n'+read(files[6]).trimEnd()+'\n```\n';
output+='\n## Canonical artifacts and deployment configuration\n\n'+notes.slice(notes.indexOf('## Fonte canonica'),f)+'\n```toml\n'+read(files[2]).trimEnd()+'\n```\n';
const manifest=files.map(p=>{const bytes=fs.readFileSync(path.join(root,p));return {path:p,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});
output+='\n## SHA-256 manifest\n\n```json\n'+JSON.stringify(manifest,null,2)+'\n```\n';
const emit=(p,data)=>{
  const full=path.join(root,p),bytes=Buffer.isBuffer(data)?data:Buffer.from(data);
  if(check){if(!fs.existsSync(full)||!fs.readFileSync(full).equals(bytes))throw new Error(`Generated package drift: ${p}`);}
  else{fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,bytes);}
};
emit('docs/market-egress-live-rollout-2026-10-04.md',output);
for(const p of files)emit(`${bundle}/${p}`,fs.readFileSync(path.join(root,p)));
emit(`${bundle}/ROLLOUT_PACKAGE.md`,output);
emit(`${bundle}/market-sync.patch`,diff);
emit(`${bundle}/manifest.json`,JSON.stringify(manifest,null,2)+'\n');
console.log(`PASS ${check?'verified':'generated'} exact rollout package: ${files.length} canonical files, full source, A-I handoff, SHA-256 manifest`);
