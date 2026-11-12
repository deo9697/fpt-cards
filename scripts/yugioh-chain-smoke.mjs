import assert from 'node:assert/strict';
import {deriveChainState,appendChain,passChain,resolveChain} from '../js/games/yugioh/simulator-chain.js';

const card=index=>({id:`p${index%2}-main-${index}`,cardName:`Public activated card ${index}`,imageUrl:`/card-${index}.jpg`,privateData:'Never copy the full private card'});
const session=()=>({chain:[]});
function unchanged(table,action,message){const before=structuredClone(table);assert.throws(action,message);assert.deepEqual(table,before,'Rejected chain operations must not mutate the table');}

{
  const table=session();
  assert.deepEqual(deriveChainState(table),{stage:'idle',priority:null,passes:0});
  const one=appendChain(table,0,card(0));
  assert.deepEqual(one,{number:1,player:0,cardId:'p0-main-0',cardName:'Public activated card 0',imageUrl:'/card-0.jpg'});
  assert.deepEqual(table.chainState,{stage:'building',priority:1,passes:0});
  unchanged(table,()=>appendChain(table,0,card(2)),/risposta/);
  unchanged(table,()=>passChain(table,0),/risposta/);
  unchanged(table,()=>resolveChain(table,0),/Entrambi/);
  const two=appendChain(table,1,card(1));
  const three=appendChain(table,0,card(2));
  assert.deepEqual([one.number,two.number,three.number],[1,2,3]);
  assert.equal(table.chainState.priority,1);
  console.log('PASS numbered activations give response priority to the other player without copying private metadata');

  assert.deepEqual(passChain(table,1),{stage:'building',priority:0,passes:1});
  unchanged(table,()=>passChain(table,1),/risposta/);
  appendChain(table,0,card(4));
  assert.deepEqual(table.chainState,{stage:'building',priority:1,passes:0},'A response after one pass reopens response priority');
  passChain(table,1);passChain(table,0);
  assert.deepEqual(table.chainState,{stage:'resolving',priority:null,passes:2});
  unchanged(table,()=>appendChain(table,1,card(5)),/risolvendo/);
  unchanged(table,()=>passChain(table,0),/risoluzione/);
  const order=[resolveChain(table,1),resolveChain(table,0),resolveChain(table,0),resolveChain(table,1)];
  assert.deepEqual(order.map(link=>link.number),[4,3,2,1]);
  assert.equal(table.chainState,null);assert.deepEqual(deriveChainState(table),{stage:'idle',priority:null,passes:0});
  unchanged(table,()=>resolveChain(table,0),/Non ci sono/);
  unchanged(table,()=>passChain(table,0),/Non ci sono/);
  assert.equal(appendChain(table,1,card(1)).number,1,'A new chain starts from one again');
  console.log('PASS two consecutive passes close the chain, responses reset passes and resolution runs highest to lowest');
}
{
  const table={chain:[{player:0,cardId:'legacy-0',cardName:'Legacy activation'},{player:1,cardId:'legacy-1',cardName:'Legacy response'}]};
  assert.deepEqual(deriveChainState(table),{stage:'building',priority:0,passes:0});
  passChain(table,0);passChain(table,1);
  assert.equal(resolveChain(table,1).number,2);assert.equal(resolveChain(table,0).number,1);
  assert.equal(table.chainState,null);
  const another={chain:[{player:0,cardId:'legacy-0',cardName:'Legacy activation'}]};
  assert.equal(appendChain(another,1,card(1)).number,2);
  console.log('PASS existing tables without chain metadata preserve legacy links and acquire response controls');
}
{
  const table=session();
  for(let index=0;index<50;index++)appendChain(table,index%2,card(index));
  unchanged(table,()=>appendChain(table,0,card(50)),/massimo/);
  for(const player of [-1,2,null,'0',undefined]){
    unchanged(table,()=>appendChain(table,player,card(0)),/Giocatore/);
    unchanged(table,()=>passChain(table,player),/Giocatore/);
    unchanged(table,()=>resolveChain(table,player),/Giocatore/);
  }
  for(const value of [null,{}, {id:'',cardName:'x'},{id:'x',cardName:''}]){
    const empty=session();unchanged(empty,()=>appendChain(empty,0,value),/Carta/);
  }
  assert.throws(()=>deriveChainState({chain:[{player:0}],chainState:{stage:'building',priority:3,passes:0}}),/Stato/);
  assert.throws(()=>deriveChainState({chain:[{player:3}]}),/Giocatore/);
  console.log('PASS chain limits, invalid players/cards and malformed response state are rejected');
}
console.log('yugioh-chain-smoke: OK');
