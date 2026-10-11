import assert from 'node:assert/strict';
import { lookupPrintingBySetCode } from '../js/cards.js';

// Fully mocked provider responses; no network, database or repair execution.
const fixtures=new Map();
let requests=0;
globalThis.fetch=async input=>{
  requests++;
  const url=new URL(input);
  if(url.pathname.endsWith('cardsetsinfo.php')){
    const fixture=fixtures.get(url.searchParams.get('setcode'));
    return {ok:true,json:async()=>({data:fixture?[{id:fixture.id,name:'Fixture card',set_code:fixture.code,set_name:'Fixture set',set_rarity:fixture.tag}]:[]})};
  }
  const fixture=[...fixtures.values()].find(row=>String(row.id)===url.searchParams.get('id'));
  return {ok:true,json:async()=>({data:fixture?.rarities?[{id:fixture.id,name:'Fixture card',card_images:[],card_sets:fixture.rarities.map(rarity=>({set_code:fixture.code,set_name:'Fixture set',set_rarity:rarity}))}]:[]})};
};
let sequence=0,failed=0,passed=0;
async function check(label,tag,rarities,expected,code){
  const index=++sequence;
  code ||= `SAFE-EN${String(index).padStart(3,'0')}`;
  fixtures.set(code,{id:90001000+index,code,tag,rarities});
  try{
    const rows=await lookupPrintingBySetCode(code);
    assert.deepEqual(rows.map(row=>row.rarity).sort(),[...expected].sort(),label);
    passed++;console.log('PASS '+label);
  }catch(error){failed++;console.error('FAIL '+label+': '+error.message);}
}
for(const tag of ['New','Reprint','New artwork','Reprint (new artwork)','  nEw artwork  ']){
  await check(`${tag}: missing cardinfo cannot invent Common`,tag,undefined,[]);
  await check(`${tag}: empty card_sets cannot invent Common`,tag,[],[]);
  await check(`${tag}: independent cardinfo rarity survives`,tag,['Ultra Rare'],['Ultra Rare']);
}
for(const rarity of ['Common','Rare','Super Rare','Ultra Rare','Secret Rare','Starlight Rare','Grand Master Rare']){
  await check(`${rarity}: valid source-only printing survives`,rarity,undefined,[rarity]);
}
await check('MAMO-EN013 survives incomplete cardinfo','Ultra Rare',[],['Ultra Rare'],'MAMO-EN013');
await check('multiple independent rarities survive metadata source','New',['Common','Ultra Rare','Starlight Rare'],['Common','Ultra Rare','Starlight Rare']);
await check('real additional rarity is retained','Secret Rare',['Common','Ultra Rare'],['Common','Ultra Rare','Secret Rare']);
await check('empty source rarity preserves independent evidence','',['Rare'],['Rare']);
await check('missing source rarity preserves independent evidence',undefined,['Super Rare'],['Super Rare']);
const before=requests;
assert.deepEqual(await lookupPrintingBySetCode('OP01-001','onepiece'),[]);
assert.equal(requests,before,'One Piece must not enter this provider path');
console.log(JSON.stringify({passed,failed,onePieceNoRequests:true}));
process.exitCode=failed?1:0;
