import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const prior='docs/audit-snapshots/production-stabilization-2026-10-05';
const current='docs/audit-snapshots/stabilization-blockers-2026-10-08';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export const decodeSnapshot=raw=>JSON.parse(raw.result.match(/\n(\[[\s\S]*\])\n<\/untrusted-data/)[1])[0].audit;
const normal=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g,'');
const unescape=value=>value.replace(/&#0*39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&nbsp;/g,' ');
export function parseOfficial(html){
  return html.split(/<div class="t_row /).slice(1).flatMap(block=>{
    const name=block.match(/<span class="card_name">([\s\S]*?)<\/span>/)?.[1]?.trim();
    if(!name)return [];
    return [{name:unescape(name),cid:block.match(/class="cid" value="(\d+)"/)?.[1],rarities:[...block.slice(0,block.indexOf('>')).matchAll(/t_rid_(\d+)/g)].map(match=>({'4':'Ultra Rare','47':'Starlight Rare','56':'Grand Master Rare','5':'Secret Rare'}[match[1]]||'UNKNOWN_RARITY_'+match[1]))}];
  });
}
export function reviewMissing(missing,source,db,aliases,official){
  const canonical=id=>{let value=String(id),seen=new Set();while(aliases.some(a=>String(a.alias_catalog_card_id)===value)&&!seen.has(value)){seen.add(value);value=String(aliases.find(a=>String(a.alias_catalog_card_id)===value).canonical_catalog_card_id);}return value;};
  return missing.map(row=>{
    const card=source.data.find(card=>String(card.id)===row.source_id);
    const sourceRows=(card?.card_sets||[]).filter(p=>p.set_code===row.set_code);
    const raw=sourceRows.find(p=>p.set_rarity===row.rarity)||sourceRows.find(p=>row.rarity==='Common'&&/^(new|reprint)\b/i.test(p.set_rarity));
    const related=db.filter(p=>p.set_code===row.set_code||canonical(p.catalog_card_id)===canonical(row.catalog_card_id));
    const represented=related.find(p=>p.set_code===row.set_code&&p.rarity===row.rarity&&canonical(p.catalog_card_id)===canonical(row.catalog_card_id));
    // Explicit source-name correspondence, verified on Konami cid=22702:
    // same MAMO-EN013 code and live manual identity 75787708. Not a fuzzy alias.
    const verified=official.find(p=>normal(p.name)===normal(row.card_name))||(row.set_code==='MAMO-EN013'&&row.catalog_card_id==='75787708'?official.find(p=>p.cid==='22702'):null);
    let classification='UNKNOWN',reason='No independent per-card rarity confirmation',confidence='LOW';
    if(!raw||!row.catalog_card_id||!row.card_name||!raw.set_name){classification='INVALID_SOURCE_RECORD';reason='Required source identity fields absent';confidence='HIGH';}
    else if(/^(new|reprint)\b/i.test(raw.set_rarity)){classification='INVALID_SOURCE_RECORD';reason='Non-rarity source tag was normalized to Common by the previous audit; no Common printing is evidenced';confidence='HIGH';}
    else if(represented){classification=String(represented.catalog_card_id)!==row.catalog_card_id?'CATALOG_ALIAS':'UNKNOWN';reason='Related canonical identity already present; do not insert';confidence='HIGH';}
    else if(!/^MAMO-EN\d+$/.test(row.set_code)){reason='Localized/nonstandard code needs explicit language evidence';}
    else if(/Token/i.test(card?.type||'')){classification='LEGACY_OR_SPECIAL_PRODUCT';reason='Token requires explicit product handling';confidence='HIGH';}
    else if(verified?.rarities.includes(row.rarity)){
      classification=row.rarity==='Grand Master Rare'?'LEGACY_OR_SPECIAL_PRODUCT':'TRUE_MISSING_PRINTING';
      reason=classification==='TRUE_MISSING_PRINTING'?'YGOPRODeck exact set identity plus official Konami name/rarity; no matching DB identity':'Official serialized Grand Master Rare; serial/region and artwork handling require review';confidence='HIGH';
    }
    return {catalog_card_id:row.catalog_card_id,card_name:row.card_name,set_code:row.set_code,set_name:row.set_name,rarity:row.rarity,source:{provider:'YGOPRODeck',snapshot:prior+'/mamo-source.json',source_id:row.source_id,raw_rarity:raw?.set_rarity||null},classification,existing_related_db_identities:related.map(p=>({id:p.id,catalog_card_id:p.catalog_card_id,set_code:p.set_code,rarity:p.rarity,variant_id:p.variant_id})),recommended_action:classification==='TRUE_MISSING_PRINTING'?'Review exact artwork/variant and source identity, then insert-only dry-run plan':classification==='INVALID_SOURCE_RECORD'?'Exclude pseudo-printing; retain explicit rejection reason':'Manual review; no automatic insert',confidence,evidence:{reason,official_card:verified||null,official_url:verified?'https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid='+verified.cid:null,source_snapshot_sha256:createHash('sha256').update(JSON.stringify(raw||null)).digest('hex')}};
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const missing=read(prior+'/mamo-audit.json').findings.filter(row=>row.type==='SOURCE_PRINTING_MISSING');
  const live=decodeSnapshot(read(current+'/live-readonly.json'));
  const official=fs.existsSync(current+'/konami-facts.json')?read(current+'/konami-facts.json').cards:parseOfficial(fs.readFileSync(current+'/konami-mamo.html','utf8'));
  const relatedRaw=read(current+'/related-db-identities.json');
  const related=JSON.parse(relatedRaw.result.match(/\n(\[[\s\S]*\])\n<\/untrusted-data/)[1]);
  const database=[...new Map([...live.mamo,...related].map(row=>[row.id,row])).values()];
  const rows=reviewMissing(missing,read(prior+'/mamo-source.json'),database,live.aliases||[],official);
  const summary=Object.fromEntries(['TRUE_MISSING_PRINTING','CATALOG_ALIAS','ARTWORK_VARIANT','LOCALIZATION_VARIANT','INVALID_SOURCE_RECORD','LEGACY_OR_SPECIAL_PRODUCT','UNKNOWN'].map(key=>[key,rows.filter(row=>row.classification===key).length]));
  fs.writeFileSync(current+'/konami-facts.json',JSON.stringify({url:'https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=1&pid=2000001680000&request_locale=en&rp=99999',cards:official},null,2)+'\n');
  fs.writeFileSync('docs/missing-catalog-identities-review.json',JSON.stringify({review_date:'2026-10-08',scope:'Original 163 findings, not a new full catalog audit',summary,rows},null,2)+'\n');
  const escape=value=>String(value).replaceAll('|','\\|');
  fs.writeFileSync('docs/missing-catalog-identities-review.md','# Missing catalog identities review — 2026-10-08\n\nNo live writes. Review of all original findings against the preserved source and current MAMO DB rows. Alias matching uses the live registry; names alone never establish a catalog alias. Artwork IDs are not printing assignments. Physical variants of an existing card can still be missing printings.\n\n'+Object.entries(summary).map(([key,count])=>`- ${key}: ${count}`).join('\n')+'\n\nFull evidence, related DB rows, source hash and recommended action per item: [JSON](missing-catalog-identities-review.json).\n\n| Code | Catalog ID | Name | Rarity | Classification | Confidence | Evidence / action |\n|---|---|---|---|---|---|---|\n'+rows.map(row=>`| ${[row.set_code,row.catalog_card_id,row.card_name,row.rarity,row.classification,row.confidence,row.evidence.reason+'; '+row.recommended_action].map(escape).join(' | ')} |`).join('\n')+'\n');
  console.log(JSON.stringify({officialCards:official.length,summary,unknown:rows.filter(row=>row.classification==='UNKNOWN').map(row=>({code:row.set_code,name:row.card_name,rarity:row.rarity}))}));
}
