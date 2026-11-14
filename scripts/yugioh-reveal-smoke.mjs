import assert from 'node:assert/strict';
import {createActivationReveals,publicChainCard} from '../js/games/yugioh/simulator-reveal.js';
import {chainView,activationRevealView} from '../js/games/yugioh/simulator-rules-ui.js';

function fixture(){
  let now=0,sequence=0;const timers=new Map(),hidden=[];
  const tracker=createActivationReveals({environment:{setTimeout:(fn,delay)=>{const id=++sequence;timers.set(id,{at:now+delay,fn});return id;},clearTimeout:id=>timers.delete(id)},onHide:key=>hidden.push(key)});
  const advance=ms=>{const end=now+ms;for(;;){const next=[...timers.entries()].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();}now=end;};
  return{tracker,advance,hidden,timers};
}
const one={activationId:'activation-a',number:1,player:0,cardId:'a',cardName:'Public effect A',imageUrl:'/a.jpg'},two={activationId:'activation-b',number:2,player:1,cardId:'b',cardName:'Public effect B',imageUrl:'/b.jpg'};
const duel=(version,chain,id='duel-a')=>({id,version,viewer:0,state:{chain,players:[{hand:[],monsters:[]},{hand:[],monsters:[]}]}});
{
  const f=fixture();assert.equal(f.tracker.observe(duel(1,[])),false);
  assert.equal(f.tracker.observe(duel(2,[one])),true);assert.equal(f.tracker.get().cardId,'a');
  f.advance(1200);f.tracker.observe(duel(2,[one]));f.tracker.observe(duel(3,[one]));
  f.advance(799);assert(f.tracker.get());f.advance(1);assert.equal(f.tracker.get(),null);
  assert.deepEqual(f.hidden,['activation-a']);assert.equal(f.timers.size,0);
  f.tracker.observe(duel(4,[one]));assert.equal(f.tracker.get(),null,'Passes must not restart an expired reveal');
  console.log('PASS new activations reveal once; polling and passes do not extend or replay the animation');
}
{
  const f=fixture();f.tracker.observe(duel(1,[]));f.tracker.observe(duel(2,[one]));f.advance(1500);
  f.tracker.observe(duel(3,[one,two]));f.advance(501);assert.equal(f.tracker.get().cardId,'b','The previous timer must not hide a new response');
  f.tracker.observe(duel(2,[one]));assert.equal(f.tracker.get().cardId,'b','Delayed state cannot replay the previous card');
  f.advance(1498);assert(f.tracker.get());f.advance(1);assert.equal(f.tracker.get(),null);
  f.tracker.observe(duel(4,[one]));assert.equal(f.tracker.get(),null,'Resolving the last link must not reveal the previous link again');
  f.tracker.observe(duel(5,[]));f.tracker.observe(duel(6,[{...one,activationId:'new-chain-a'}]));assert.equal(f.tracker.get().key,'new-chain-a');
  f.tracker.observe(duel(7,[]));assert.equal(f.tracker.get(),null);assert.equal(f.timers.size,0);
  const skipped=fixture();skipped.tracker.observe(duel(1,[]));skipped.tracker.observe(duel(2,[one]));
  skipped.tracker.observe(duel(6,[{...one,activationId:'same-card-after-missed-resolution'}]));
  assert.equal(skipped.tracker.get().key,'same-card-after-missed-resolution','A poll that misses resolution must still reveal the same card in a fresh chain');skipped.tracker.dispose();
  console.log('PASS response timers, reverse resolution, stale replies and repeated cards in new chains');
}
{
  const f=fixture();f.tracker.observe(duel(8,[one,two]));assert.equal(f.tracker.get(),null,'Opening an existing chain shows thumbnails without replaying history');
  f.tracker.observe(duel(9,[one,two,{...one,activationId:'c',number:3}]));assert(f.tracker.get());
  f.tracker.clear();assert.equal(f.tracker.get(),null);assert.equal(f.timers.size,0);
  f.tracker.observe(duel(1,[one],'different-duel'));assert.equal(f.tracker.get(),null);
  f.tracker.observe(duel(2,[one,two],'different-duel'));assert(f.tracker.get());
  f.tracker.dispose();f.advance(5000);assert.equal(f.tracker.get(),null);assert.equal(f.timers.size,0);
  assert.equal(f.tracker.observe(duel(3,[one,two],'different-duel')),false);
  console.log('PASS initial loads, navigation, changing tables and disposal clear presentation timers');
}
{
  const session={players:[{hand:[{id:'a',imageUrl:'/own.jpg'}]},{hand:[{id:'secret',imageUrl:'/hidden.jpg'}],monsters:[{id:'public',faceUp:true,imageUrl:'/visible.jpg'},{id:'covered',hidden:true,imageUrl:'/covered.jpg'}]}]};
  assert.equal(publicChainCard(session,{cardId:'a',player:0,cardName:'A'},0).imageUrl,'/own.jpg');
  assert.equal(publicChainCard(session,{cardId:'secret',player:1,cardName:'Secret'},0).imageUrl,'');
  assert.equal(publicChainCard(session,{cardId:'covered',player:1,cardName:'Covered'},0).imageUrl,'');
  assert.equal(publicChainCard(session,{cardId:'public',player:1,cardName:'Public'},0).imageUrl,'/visible.jpg');
  assert.equal(publicChainCard(session,{cardId:'secret',player:1,cardName:'Activated',imageUrl:'/declared.jpg'},0).imageUrl,'/declared.jpg');
  const f=fixture(),snapshot=duel(1,[]);f.tracker.observe(snapshot);const next=duel(2,[one,two]);f.tracker.observe(next);
  const controller={session:next.state,viewer:0,duel:next,activationReveals:f.tracker};
  const small=chainView(controller),large=activationRevealView(controller);
  assert(small.includes('data-chain-card-id="a"')&&small.includes('data-chain-card-id="b"'));assert(small.includes('http://localhost/a.jpg'));
  assert(large.includes('data-card-id="b"')&&large.includes('data-ygo-chain-number="2"'));assert(large.includes('http://localhost/b.jpg'));
  assert(!large.includes('http://localhost/a.jpg'));f.tracker.dispose();
  console.log('PASS public artwork, private legacy fallback and card-attached badges in both renderers');
}
console.log('yugioh-reveal-smoke: OK');
