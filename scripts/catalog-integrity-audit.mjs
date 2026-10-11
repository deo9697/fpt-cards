import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonicalCatalogCardId, sanitizeYugiohRarity } from '../js/cards.js';

const identity = row => [row.set_code,row.catalog_card_id,row.rarity,row.variant_id||''].join('|');
export function auditCatalog(source, database, { prefix='MAMO-' }={}) {
  const sourceRows=[];
  const findings=[];
  for(const card of source.data||source)for(const printing of card.card_sets||[]) {
    if(!printing.set_code?.startsWith(prefix))continue;
    if(/^(new|reprint)\b/i.test(String(printing.set_rarity||''))){
      findings.push({type:'NON_RARITY_SOURCE_TAG',set_code:printing.set_code,source_id:String(card.id),source_rarity:printing.set_rarity,reason:'Not evidence of a physical Common printing'});
      continue;
    }
    const rarity=sanitizeYugiohRarity(printing.set_rarity);
    const row={set_code:printing.set_code,card_name:card.name,catalog_card_id:canonicalCatalogCardId(card.id,'yugioh'),rarity,set_name:printing.set_name,variant_id:'',source_id:String(card.id),image_ids:(card.card_images||[]).map(image=>String(image.id))};
    if(!rarity)findings.push({type:'UNSUPPORTED_SOURCE_RARITY',...row,source_rarity:printing.set_rarity});
    sourceRows.push(row);
  }
  const db=database.filter(row=>row.game!=='onepiece'&&row.set_code?.startsWith(prefix));
  const sourceByKey=new Map(sourceRows.map(row=>[identity(row),row]));
  const dbByKey=new Map();
  for(const row of db){const key=identity(row);dbByKey.set(key,[...(dbByKey.get(key)||[]),row]);}
  const report=[];
  for(const [key,row] of sourceByKey){
    const present=dbByKey.get(key)||[];
    if(!present.length)findings.push({type:'SOURCE_PRINTING_MISSING',...row});
    report.push({...row,known_variants:sourceRows.filter(other=>other.set_code===row.set_code).map(other=>({catalog_card_id:other.catalog_card_id,rarity:other.rarity,source_id:other.source_id})),db_present:present.length>0,db_row_count:present.length,verification_status:present.map(item=>item.catalog_verification_status||'unknown')});
  }
  for(const row of db){
    if(!row.catalog_card_id)findings.push({type:'MISSING_CATALOG_ID',id:row.id,set_code:row.set_code});
    if(row.catalog_verification_status!=='verified')findings.push({type:'UNVERIFIED',id:row.id,set_code:row.set_code});
    if(!row.source_provider)findings.push({type:'MISSING_SOURCE_METADATA',id:row.id,set_code:row.set_code});
    const sourceRow=sourceByKey.get(identity(row));
    const candidates=sourceRows.filter(item=>item.set_code===row.set_code&&item.catalog_card_id===row.catalog_card_id);
    if(!sourceRow)findings.push({type:'DB_IDENTITY_NOT_IN_SOURCE_REVIEW',id:row.id,set_code:row.set_code,rarity:row.rarity});
    if(candidates.length&&!candidates.some(item=>item.rarity===row.rarity))findings.push({type:'RARITY_NOT_IN_SOURCE_REVIEW',id:row.id,set_code:row.set_code});
    if(sourceRow&&row.set_name!==sourceRow.set_name)findings.push({type:'SET_NAME_MISMATCH',id:row.id,expected:sourceRow.set_name,actual:row.set_name});
    const imageId=row.image_url?.match(/\/(\d+)\.(?:jpg|png)(?:\?|$)/)?.[1];
    if(imageId&&sourceRow&&!sourceRow.image_ids.includes(imageId))findings.push({type:'IMAGE_ID_MISMATCH_REVIEW',id:row.id,imageId,catalogId:row.catalog_card_id});
  }
  for(const [key,rows] of dbByKey)if(rows.length>1)findings.push({type:'DUPLICATE_PHYSICAL_IDENTITY_CANDIDATE',key,ids:rows.map(row=>row.id),incoherent:new Set(rows.map(row=>[row.card_name,row.set_name,row.image_url].join('|'))).size>1});
  // Numeric gaps are hints only, never repair inputs or evidence of absence.
  const groups=new Map();
  for(const row of sourceRows){const m=row.set_code.match(/^(.*?)(\d+)$/);if(m){const values=groups.get(m[1])||new Set();values.add(Number(m[2]));groups.set(m[1],values);}}
  for(const [group,values] of groups){const sorted=[...values].sort((a,b)=>a-b);for(let i=1;i<sorted.length;i++)if(sorted[i]>sorted[i-1]+1)findings.push({type:'SUSPICIOUS_SOURCE_GAP_ONLY',group,after:sorted[i-1],before:sorted[i]});}
  const repairs=findings.filter(row=>row.type==='SOURCE_PRINTING_MISSING'&&row.rarity&&row.catalog_card_id).map(row=>({action:'REVIEW_INSERT_ONLY',identity:identity(row),source:row,preconditions:['Re-fetch source and confirm identity/rarity','Verify artwork/variant independently; image candidates are not printing assignments','Re-check database identity immediately before insert','Use existing validated admin repair flow; never overwrite or delete existing rows'],approved:false}));
  return {scope:prefix,source_rows:sourceRows.length,source_identities:sourceByKey.size,db_rows:db.length,report,findings,repair_plan:{executable:false,entries:repairs}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [sourcePath,dbPath,outputPath,prefix='MAMO-']=process.argv.slice(2);
  if(!sourcePath||!dbPath||!outputPath)throw new Error('Usage: node scripts/catalog-integrity-audit.mjs source.json database.json report.json (local files only)');
  const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const source=read(sourcePath),raw=read(dbPath);
  const db=raw.result?JSON.parse(raw.result.match(/\n(\[[\s\S]*\])\n<\/untrusted-data/)[1])[0].audit.mamo:raw;
  const result=auditCatalog(source,db,{prefix});
  fs.writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n');
  const columns=['set_code','card_name','catalog_card_id','rarity','known_variants','db_present','db_row_count','verification_status'];
  const csv=value=>'"'+String(typeof value==='object'?JSON.stringify(value):value??'').replaceAll('"','""')+'"';
  fs.writeFileSync(outputPath.replace(/\.json$/,'')+'.csv',[columns.join(','),...result.report.map(row=>columns.map(column=>csv(row[column])).join(','))].join('\n')+'\n');
  console.log(JSON.stringify({sourceIdentities:result.source_identities,dbRows:result.db_rows,findings:result.findings.reduce((counts,row)=>(counts[row.type]=(counts[row.type]||0)+1,counts),{}),repairCandidates:result.repair_plan.entries.length}));
}
