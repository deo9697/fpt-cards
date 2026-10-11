import assert from 'node:assert/strict';

// Synthetic API responses: reproduce disagreement between the two source
// endpoints, not evidence of the historical MAMO incident.
const fixtures = [
  { id: 48393693, code: 'MAMO-EN012' },
  { id: 75787708, code: 'MAMO-EN013' },
  { id: 1186447, code: 'MAMO-EN014' }
];
let missing = true;
globalThis.fetch = async input => {
  const url = new URL(input);
  if (url.pathname.endsWith('cardsetsinfo.php')) {
    const row = fixtures.find(row => row.code === url.searchParams.get('setcode'));
    return { ok: true, json: async () => ({ data: !row || missing ? [] : [{ id: row.id, name: 'Fixture card', set_code: row.code, set_name: 'Magnificent Monsters', set_rarity: 'Ultra Rare' }] }) };
  }
  const row = fixtures.find(row => String(row.id) === url.searchParams.get('id'));
  return { ok: true, json: async () => ({ data: row ? [{ id: row.id, name: 'Fixture card', type: 'Effect Monster', card_images: [], card_sets: [] }] : [] }) };
};
const { lookupPrintingBySetCode } = await import('../js/cards.js');
assert.deepEqual(await lookupPrintingBySetCode('MAMO-EN013'), []);
missing = false;
for (const row of fixtures) {
  const result = await lookupPrintingBySetCode(row.code);
  assert.equal(result.length, 1, `${row.code}: valid set endpoint row must survive incomplete card_sets and a previous miss`);
  assert.equal(result[0].catalogCardId, String(row.id));
  assert.equal(result[0].rarity, 'Ultra Rare');
}
console.log('PASS catalog completeness: MAMO 012/013/014 and negative-cache recovery');
globalThis.fetch=async input=>{
  const url=new URL(input);
  return {ok:true,json:async()=>url.pathname.endsWith('cardsetsinfo.php')?{data:Array.from({length:9},(_,i)=>({id:90000100+i,name:'Fixture '+i,set_code:'TEST-EN999',set_name:'Fixture',set_rarity:'Ultra Rare'}))}:{data:[]}};
};
assert.equal((await lookupPrintingBySetCode('TEST-EN999')).length,9,'the ninth valid source identity must not be truncated');
globalThis.fetch=async()=>({ok:true,json:async()=>({data:[{id:90000999,name:'Fixture missing rarity',set_code:'TEST-EN998',set_rarity:''}]})});
await assert.rejects(lookupPrintingBySetCode('TEST-EN998'),{code:'CATALOG_SOURCE_INVALID'});
globalThis.fetch=async()=>({ok:false,status:503});
await assert.rejects(lookupPrintingBySetCode('TEST-EN997'),{code:'LOOKUP_FAILED'});
console.log('PASS no row cap, explicit invalid-source rejection, network errors are not catalog misses');
