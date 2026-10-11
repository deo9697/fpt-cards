import { canonicalCatalogCardId } from '../../js/cards.js';

// Pure administrative ingestion plan. No network, database connection or writes.
// Every source printing gets an explicit disposition; image lists are evidence,
// never a guessed artwork-to-printing assignment.
export function planCatalogIngest(cards,existing=[]){
  const key=row=>[row.game,row.catalog_card_id,row.set_code,row.rarity,row.variant_id||''].join('|');
  const stored=new Set(existing.map(key)),planned=new Map(),decisions=[];
  for(const [cardIndex,card] of cards.entries()){
    if(!Array.isArray(card?.card_sets)||!card.card_sets.length){decisions.push({cardIndex,classification:'INVALID_SOURCE_RECORD',reason:'NO_SOURCE_PRINTINGS'});continue;}
    for(const [printingIndex,printing] of card.card_sets.entries()){
      const catalog_card_id=canonicalCatalogCardId(card.id,'yugioh');
      const set_code=String(printing?.set_code||'').trim().toUpperCase();
      const rarity=String(printing?.set_rarity||'').trim();
      const decision={cardIndex,printingIndex,source_id:String(card.id||''),set_code,rarity};
      if(!catalog_card_id||!card.name||!set_code||!printing?.set_name||!rarity){decisions.push({...decision,classification:'INVALID_SOURCE_RECORD',reason:'MISSING_REQUIRED_SOURCE_FIELD'});continue;}
      if(/^(new|reprint)\b/i.test(rarity)){decisions.push({...decision,classification:'INVALID_SOURCE_RECORD',reason:'NON_RARITY_SOURCE_TAG'});continue;}
      const row={game:'yugioh',catalog_card_id,card_name:card.name,set_code,set_name:printing.set_name,rarity,variant_id:String(printing.variant_id||''),source_provider:'ygoprodeck',source_ids:[String(card.id)],image_ids:(card.card_images||[]).map(image=>String(image.id))};
      const identity=key(row);
      if(stored.has(identity)){decisions.push({...decision,identity,classification:'ALREADY_PRESENT',reason:'EXACT_PHYSICAL_IDENTITY_EXISTS'});continue;}
      const previous=planned.get(identity);
      if(previous){
        previous.source_ids=[...new Set([...previous.source_ids,...row.source_ids])];
        previous.image_ids=[...new Set([...previous.image_ids,...row.image_ids])];
        decisions.push({...decision,identity,classification:'MERGED_SOURCE_RECORD',reason:previous.source_ids.length>1?'VERIFIED_CATALOG_ALIAS':'DUPLICATE_PHYSICAL_IDENTITY'});
      }else{planned.set(identity,row);decisions.push({...decision,identity,classification:'ACCEPTED',reason:'VALID_SOURCE_PRINTING'});}
    }
  }
  return {dry_run:true,executable:false,rows:[...planned.values()].sort((a,b)=>key(a).localeCompare(key(b))),decisions};
}
