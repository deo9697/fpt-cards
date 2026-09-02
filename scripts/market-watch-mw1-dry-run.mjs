import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {CardmarketPriceGuideProvider,CARDMARKET_RESOLUTION_STATES,resolveCardmarketPrinting} from '../market/providers.js';

const inputPath=process.argv[2];
if(!inputPath)throw new Error('Uso: node scripts/market-watch-mw1-dry-run.mjs <export-read-only.json>');
const input=JSON.parse(fs.readFileSync(inputPath,'utf8'));
const catalogUrl='https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_3.json';
const provider=new CardmarketPriceGuideProvider({catalogUrl,priceGuideUrl:'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_3.json'});
const memoryBefore=process.memoryUsage().rss,start=performance.now();
const catalogStats=await provider.loadCatalog(input.targets);
const loadMs=performance.now()-start,resolverStart=performance.now();
const resolveAll=()=>input.targets.map(target=>({target,resolution:resolveCardmarketPrinting(target,provider.catalog,{internalPrintings:input.allPrintings})}));
const rows=resolveAll(),resolverMs=performance.now()-resolverStart,memoryAfter=process.memoryUsage().rss;

const counts=group(rows,row=>row.resolution.status),previous=group(input.targets,row=>row.oldStatus),reasons=group(rows,row=>row.resolution.reason);
const previousResolved=rows.filter(row=>row.target.oldStatus==='resolved'),transitions=group(previousResolved,row=>row.resolution.status);
const authorized=new Set([CARDMARKET_RESOLUTION_STATES.EXACT,CARDMARKET_RESOLUTION_STATES.PROVIDER_AGGREGATE]);
const newMappings=rows.filter(row=>authorized.has(row.resolution.status)&&row.target.oldStatus!=='resolved');
const byRarity=matrix(rows,row=>row.target.rarity||'∅'),byLanguage=matrix(rows,row=>row.target.language||'Non specificata');
const cases={};
for(const row of rows){const code=String(row.target.setCode||'').toUpperCase(),name=String(row.target.cardName||'');if(['L26D-ENS26','DOOD-IT039','LVAL-IT048','MP17-DE231'].includes(code)){
  const key=`${name} | ${code} | ${row.target.rarity}`;cases[key]={oldStatus:row.target.oldStatus,newStatus:row.resolution.status,reason:row.resolution.reason,productId:row.resolution.candidate?.providerProductId||null,priceScope:row.resolution.priceScope||null,internalRarities:row.resolution.evidence?.internalRarities||[]};
}}
const deterministic=JSON.stringify(rows.map(row=>signature(row.resolution)))===JSON.stringify(resolveAll().map(row=>signature(row.resolution)));
const exactEvidence=rows.filter(row=>row.resolution.status===CARDMARKET_RESOLUTION_STATES.EXACT).map(row=>({printingId:row.target.printingId,setCode:row.target.setCode,rarity:row.target.rarity,evidence:row.resolution.evidence}));
console.log(JSON.stringify({
  input:{targets:input.targets.length,allPrintings:input.allPrintings.length},catalogStats,
  previous,counts,previousResolvedTransitions:transitions,newMappings:newMappings.length,
  resultingCoverage:Number((((counts.EXACT||0)+(counts.PROVIDER_AGGREGATE||0))/input.targets.length*100).toFixed(2)),
  reasons,byRarity,byLanguage,cases,exactEvidence,deterministic,
  performance:{catalogLoadMs:Math.round(loadMs),resolverMs:Math.round(resolverMs),retainedCandidates:provider.catalog.length,rssDeltaMb:Number(((memoryAfter-memoryBefore)/1048576).toFixed(1)),rssPeakObservedMb:Number((memoryAfter/1048576).toFixed(1)),httpRequests:2}
},null,2));

function group(rows,key){const out={};for(const row of rows){const value=key(row)||'∅';out[value]=(out[value]||0)+1;}return sortObject(out);}
function matrix(rows,key){const groups={};for(const row of rows){const value=key(row),status=row.resolution.status;groups[value]||={total:0};groups[value].total++;groups[value][status]=(groups[value][status]||0)+1;}return Object.fromEntries(Object.entries(groups).sort((a,b)=>b[1].total-a[1].total||a[0].localeCompare(b[0])));}
function sortObject(value){return Object.fromEntries(Object.entries(value).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])));}
function signature(resolution){return {status:resolution.status,reason:resolution.reason,productId:resolution.candidate?.providerProductId||null,priceScope:resolution.priceScope||null,evidence:resolution.evidence};}
