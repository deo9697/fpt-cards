import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const requested=process.argv.slice(2);
const files=fs.readdirSync('scripts').filter(name=>/^(market-|fast-scan-|catalog-|collection-|decks-milestone|pagination-p0).*smoke\.mjs$/.test(name)&&(!requested.length||requested.includes(name)));
const folder=process.env.FPT_TEST_REPORT_DIR||'docs/audit-snapshots/production-stabilization-2026-10-05';
fs.mkdirSync(folder,{recursive:true});
const results=requested.length&&fs.existsSync(`${folder}/test-results.json`)?JSON.parse(fs.readFileSync(`${folder}/test-results.json`,'utf8')).filter(row=>!files.includes(row.file)):[];
for(const file of files){
  const result=spawnSync(process.execPath,['scripts/'+file,...(file==='market-snapshot-retention-smoke.mjs'?['--strict']:[])],{encoding:'utf8',timeout:120000,windowsHide:true,maxBuffer:8*1024*1024});
  const log=(result.stdout||'')+(result.stderr||'')+(result.error?.message||'');
  fs.writeFileSync(`${folder}/${file}.log`,log);
  results.push({file,status:result.status,error:result.error?.message||null});
  fs.writeFileSync(`${folder}/test-results.json`,JSON.stringify(results,null,2)+'\n');
  console.log(`${result.status===0?'PASS':'FAIL'} ${file}`);
}
console.log(JSON.stringify({total:results.length,passed:results.filter(row=>row.status===0).length,failed:results.filter(row=>row.status!==0)}));
process.exitCode=results.some(row=>row.status!==0)?1:0;
