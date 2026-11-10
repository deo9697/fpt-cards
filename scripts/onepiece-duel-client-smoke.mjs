import assert from 'node:assert/strict';
import { OnePieceMultiplayer } from '../js/games/onepiece/simulator-multiplayer.js';
import { createSession, applyAction } from '../js/games/onepiece/simulator-engine.js';
import { redactState } from '../api/_onepiece-duel-service.js';

const deck = {
  id:'a0000000-0000-4000-8000-000000000001', name:'Synthetic deck', game:'onepiece',
  cards:[{catalogCardId:'OP01-001',cardName:'Synthetic Leader',section:'leader',quantity:1},
    ...Array.from({length:13},(_,i)=>({catalogCardId:`OP01-${String(i+10).padStart(3,'0')}`,cardName:`Synthetic card ${i}`,section:'main',quantity:i===12?2:4}))]
};
const full = applyAction(createSession({decks:[deck,deck]}),{type:'start'});
const id = 'b0000000-0000-4000-8000-000000000001';
const snapshot = version => ({id,status:'playing',version,viewer:0,ready:[true,true],state:redactState(full,0)});
const deferred = () => { let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const button = dataset => ({dataset,hasAttribute:name=>Object.hasOwn(dataset,name.replace(/^data-/, '').replace(/-([a-z])/g,(_,c)=>c.toUpperCase()))});
const controllers=[];
function controller(call) {
  const instance = new OnePieceMultiplayer({
    getContext:()=>({member:'synthetic-host',team:'synthetic-team',allowed:true}),
    getDecks:()=>[],getMembers:()=>[],call,onRender:()=>{},onToast:()=>{},confirm:async()=>true,
    verifyAccess:async()=>true,loadDecks:async()=>{},lookupCard:async()=>null
  });
  instance.ready=true; instance.lastLobby=Date.now(); instance.receive(snapshot(1));
  controllers.push(instance); return instance;
}
try {
  const old=deferred();
  const current=controller(async()=>old.promise);
  const polling=current.poll(); current.receive(snapshot(2)); old.resolve({duel:snapshot(1)}); await polling;
  assert.equal(current.duel.version,2,'A delayed poll must not roll back an accepted action');
  console.log('PASS delayed snapshots never replace a newer table version');

  const abandoned=deferred();
  const navigation=controller(async payload=>payload.op==='lobby'?{members:[],duels:[]}:abandoned.promise);
  const navigationPoll=navigation.poll();
  navigation.battleTools=true;
  await navigation.click(button({opCommand:'lobby'}));
  abandoned.resolve({duel:snapshot(1)}); await navigationPoll;
  assert.equal(navigation.duel,null,'A delayed response must not reopen a departed game');
  assert.equal(navigation.battleTools,false,'Leaving a table must close its tools');
  console.log('PASS leaving a table invalidates its pending responses');

  const inspection=deferred();
  const privacy=controller(async()=>inspection.promise);
  const opening=privacy.click(button({opPile:'deck',player:'0'}));
  await privacy.click(button({opCommand:'cover'}));
  inspection.resolve({duel:snapshot(1),version:1,cards:full.players[0].deck}); await opening;
  assert.equal(privacy.pile,null,'Covering private cards must invalidate an outstanding inspection');
  assert.equal(privacy.privateLife,null);
  console.log('PASS late inspection responses respect the cover command');

  const lifeInspection=controller(async()=>({version:1,cards:full.players[0].life}));
  await lifeInspection.click(button({opCommand:'battle-inspect-life'}));
  assert.deepEqual(lifeInspection.pile.cards,full.players[0].life,'Own Life inspection must show the inspected cards');
  await lifeInspection.click(button({opCommand:'battle-life',player:'1'}));
  assert.equal(lifeInspection.pile.player,1);
  assert.equal(lifeInspection.pile.cards,undefined,'Opening opponent Life must never reuse the private inspection of own Life');
  assert(lifeInspection.session.players[1].life.every(card=>card.hidden),'Opponent Life must stay covered');
  await lifeInspection.click(button({opCommand:'battle-life',player:'0'}));
  assert.deepEqual(lifeInspection.pile.cards,full.players[0].life,'Returning to own Life may use its private inspection');
  await lifeInspection.click(button({opCommand:'battle-inspect-life'}));
  assert.equal(lifeInspection.privateLife,null,'Toggling Life inspection off must clear its private response');
  assert.equal(lifeInspection.pile.cards,undefined,'Toggling Life inspection off must also clear the gallery copy');
  assert.equal(lifeInspection.peekLife[0],false);
  console.log('PASS private Life inspections stay attached to their owner');

  const quiet=controller(async payload=>{
    assert.equal(payload.knownVersion,1);
    return {unchanged:true,duelId:id,version:1};
  });
  const original=quiet.session; await quiet.poll(); assert.equal(quiet.session,original);
  console.log('PASS unchanged polling preserves the current view without private snapshots');

  const revoked=controller(async()=>{throw Object.assign(new Error('Sessione scaduta'),{status:403});});
  await revoked.poll(); assert.equal(revoked.ready,false); assert.equal(revoked.session,null); assert.match(revoked.error,/scaduta/);
  const closed=controller(async()=>({}));
  closed.receive({...snapshot(2),status:'cancelled'}); assert.equal(closed.session,null); assert.equal(closed.canControl(0),false);
  const fresh=controller(async()=>({})); fresh.finishDraft.notes='Do not copy to another opponent';
  fresh.receive({...snapshot(1),id:'b0000000-0000-4000-8000-000000000002'}); assert.equal(fresh.finishDraft.notes,'');
  console.log('PASS expired access, closed tables and opponent changes clear sensitive UI state');

  const typedCards=controller(async()=>({}));
  const typedHand=typedCards.session.players[0].hand[0];
  typedCards.selected={player:0,cardId:typedHand.id};
  typedHand.type='Event';
  assert(!typedCards.inspectorView().includes('<option value="characters"'),'Event command must not offer the Character area');
  assert(!typedCards.inspectorView().includes('<option value="stage"'),'Event command must not offer the Stage area');
  assert(typedCards.inspectorView().includes('<option value="trash" selected>'),'Event command should default to resolving into Trash');
  assert(!typedCards.tableView().includes('data-op-command="battle-place"'),'Event must not offer a battlefield placement shortcut');
  typedHand.type='Stage';
  assert(typedCards.inspectorView().includes('<option value="stage" selected>'),'Stage command should default to its own area');
  assert(!typedCards.inspectorView().includes('<option value="characters"'),'Stage command must not offer the Character area');
  typedHand.type='Personaggio';
  assert(typedCards.inspectorView().includes('<option value="characters" selected>'),'Italian Character type should offer the Character area');
  assert(!typedCards.inspectorView().includes('<option value="stage"'),'Character command must not offer the Stage area');
  console.log('PASS card commands offer only compatible battlefield destinations');
  console.log('onepiece-duel-client-smoke: OK');
} finally { controllers.forEach(instance=>instance.reset()); }
