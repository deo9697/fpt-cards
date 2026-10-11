import { sanitizeYugiohRarity } from './cards.js';

// Per-card evidence verified 2026-10-11, not a blanket rarity list for a set.
// Konami card details: cid=19153 (Imsety), 12071 (Delta), 22197 (Falchion),
// 5410 (Vampire Lord). https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid=19153&request_locale=en
const seven=['Super Rare','Ultra Rare','Secret Rare','Platinum Secret Rare','Starlight Rare','Ultimate Rare',"Collector's Rare"];
const verified=new Map([
  ['RA05-EN027',seven],['RA05-EN007',seven],
  ['BLGG-EN012',['Ultra Rare']],['BLGG-EN004',['Secret Rare','Starlight Rare']]
]);
export const physicalKey=row=>[row.game||'yugioh',row.catalogCardId||row.catalog_card_id||'',row.setCode||row.set_code||'',row.rarity||'',row.variantId||row.variant_id||'',row.artworkId||row.artwork_id||''].join('|');
export function printingEvidence(matches=[]){
  const result=[];
  for(const row of matches){
    if((row.game||'yugioh')!=='yugioh'){result.push(row);continue;}
    const code=String(row.setCode||row.set_code||'').toUpperCase();
    const rarity=sanitizeYugiohRarity(row.rarity);
    const expected=verified.get(code)||row.expectedRarities||row.game_metadata?.expected_rarities||[];
    const invalid=!rarity||(/^BLGG-/.test(code)&&rarity==='Common')||(expected.length&&!expected.includes(rarity));
    result.push({...row,setCode:code,catalogCardId:String(row.catalogCardId||row.catalog_card_id||''),rarity,expectedRarities:expected,physicalIdentityChecked:true,invalidPhysicalRarity:invalid,
      catalogVariantIncomplete:row.catalogVariantIncomplete||invalid,
      variantId:row.variantId||row.variant_id||'',artworkId:row.artworkId||row.artwork_id||''});
  }
  // Missing source variants are choices requiring catalog repair, NEVER DB rows.
  for(const row of [...result])for(const rarity of row.expectedRarities||[]){
    if(result.some(other=>other.catalogCardId===row.catalogCardId&&other.setCode===row.setCode&&other.rarity===rarity))continue;
    result.push({...row,id:'',printingId:'',printing_id:'',variantId:'',variant_id:'',artworkId:'',artwork_id:'',game_metadata:{},rarity,imageUrl:'',image_url:'',invalidPhysicalRarity:false,requiresCatalogRepair:true,catalogVariantIncomplete:true});
  }
  return result;
}
export function physicalAmbiguity(matches=[]){
  if(!matches.length)return '';
  const rows=printingEvidence(matches);
  if(rows.some(row=>!sanitizeYugiohRarity(row.rarity)&&(row.game||'yugioh')==='yugioh'))return 'UNKNOWN_RARITY';
  if(rows.some(row=>row.catalogVariantIncomplete||row.requiresCatalogRepair))return 'CATALOG_VARIANT_INCOMPLETE';
  if(new Set(rows.map(row=>row.rarity)).size>1)return 'RARITY_AMBIGUOUS';
  if(rows.length>1&&new Set(rows.map(row=>row.catalogCardId||row.catalog_card_id)).size===1)return 'ARTWORK_AMBIGUOUS';
  // A complete DB download is not proof that a source product is complete.
  if(rows.length===1&&/^RA05-|^BLGG-/.test(rows[0].setCode||rows[0].set_code||'')&&!verified.has(rows[0].setCode||rows[0].set_code)&&!rows[0].rarityEvidenceComplete)return 'CATALOG_VARIANT_INCOMPLETE';
  return '';
}
