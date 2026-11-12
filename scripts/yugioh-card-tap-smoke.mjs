import assert from 'node:assert/strict';
import {cardTapActions,cardDropActions} from '../js/games/yugioh/simulator-card-actions.js';
import {createSession,applyAction} from '../js/games/yugioh/simulator-engine.js';

const monster={type:'Effect Monster',faceUp:true,position:'attack'};
const spell={type:'Spell Card',faceUp:false,position:'attack'};
const trap={type:'Trap Card',faceUp:false,position:'attack'};
const ids=(card,from)=>cardTapActions(card,from).map(action=>action.id);
const action=(card,from,id)=>cardTapActions(card,from).find(choice=>choice.id===id);
assert.deepEqual(ids(monster,'hand'),['normal','special','set']);
assert.deepEqual(action(monster,'hand','normal').zones,['monsters']);
assert.deepEqual(action(monster,'hand','special').zones,['monsters']);
assert.equal(action(monster,'hand','normal').changes.intent,'normal');
assert.equal(action(monster,'hand','set').changes.faceUp,false);
for(const type of ['Ritual Effect Monster','Fusion Monster','Synchro Monster','XYZ Monster','Link Monster']){
  assert(!ids({type},'hand').includes('normal'),`${type} cannot be Normal Summoned`);
  assert(!ids({type},'hand').includes('set'),`${type} cannot be Normal Set`);
  const dropped=cardDropActions({type},'hand','monsters').map(choice=>choice.id);
  assert(!dropped.includes('normal'),`${type} must not gain a Normal Summon via drag`);
  assert(!dropped.includes('set'),`${type} must not gain a Normal Set via drag`);
}
const ritualDeck={id:'ritual-fixture',game:'yugioh',name:'Synthetic Ritual deck',cards:Array.from({length:14},(_,index)=>({catalogCardId:`ritual-${index}`,cardName:`Ritual ${index}`,section:'main',quantity:index===13?1:3,type:'Ritual Effect Monster'}))};
const ritualTable=applyAction(createSession({decks:[ritualDeck,ritualDeck]}),{type:'start'}),ritualCard=ritualTable.players[0].hand[0];
assert.throws(()=>applyAction(ritualTable,{type:'move',player:0,cardId:ritualCard.id,to:'monsters',intent:'normal',faceUp:true,position:'attack'}),/Mostro Rituale/);
assert.equal(ritualTable.players[0].monsters.length,0,'A rejected Ritual Normal Summon must leave the field unchanged');
assert.equal(applyAction(ritualTable,{type:'move',player:0,cardId:ritualCard.id,to:'monsters',intent:'special',faceUp:true,position:'attack'}).players[0].monsters[0].id,ritualCard.id);
assert.deepEqual(ids({type:'Link Monster'},'extra'),['special','activate']);
assert.deepEqual(action({type:'Link Monster'},'extra','special').zones,['monsters','extraMonsters']);
assert.deepEqual(ids({type:'Fusion Monster'},'extra'),['special','activate']);
console.log('PASS monster taps offer type-appropriate summons and explicit destination zones');

for(const card of [spell,trap]){
  assert.deepEqual(ids(card,'hand'),['activate','set']);
  assert.equal(action(card,'hand','activate').to,'spells');
  assert.equal(action(card,'hand','activate').changes.activateAfter,true);
  assert.equal(action(card,'hand','set').changes.faceUp,false);
  assert.equal(action(card,'spells','activate').changes.activateOnly,true);
  assert(!ids(card,'spells').includes('set'),'An already Set card needs no duplicate Set option');
}
const fieldSpell={...spell,race:'Field'};
assert.equal(action(fieldSpell,'hand','activate').to,'field');
assert.deepEqual(action(fieldSpell,'hand','set').zones,['field']);
assert.equal(action({...spell,faceUp:true},'spells','set').changes.positionOnly,true);
assert.equal(action({cardType:'Trap Card'},'hand','activate').to,'spells');
console.log('PASS spells and traps offer Set/Activate, field spells use the Field Zone');

assert.deepEqual(ids(monster,'monsters'),['activate','position','graveyard']);
assert.equal(action(monster,'monsters','activate').changes.activateOnly,true);
assert.equal(action(monster,'monsters','position').changes.position,'defense');
assert.equal(action({...monster,position:'defense'},'monsters','position').changes.position,'attack');
assert.equal(action(monster,'monsters','graveyard').to,'graveyard');
assert.deepEqual(ids({...monster,faceUp:false},'monsters'),['flip-attack','flip-defense','graveyard']);
assert.deepEqual(ids({type:'Link Monster',faceUp:true},'extraMonsters'),['activate','graveyard']);
assert(!ids({...monster,token:true},'monsters').includes('set'));
assert(!ids(monster,'monsters').includes('move'),'A tap on the current position must not offer a same-slot move');
console.log('PASS cards on the field expose effects, positions and removal without redundant moves');

for(const from of ['graveyard','banished','extra']){
  assert(ids(monster,from).includes('special'));
  assert(!ids(monster,from).includes('normal'));
  assert.equal(action(monster,from,'activate').changes.activateOnly,true);
  assert.deepEqual(ids(spell,from),['activate']);
}
assert(!ids(monster,'deck').includes('activate'),'Deck activations are rejected by the manual engine');
assert.deepEqual(ids(monster,'side'),[]);
assert.deepEqual(cardTapActions(null,'hand'),[]);
assert.deepEqual(cardTapActions(monster,'invalid'),[]);
assert.deepEqual(ids({},'hand'),['normal','special','set']);
console.log('PASS pile effects/summons, unknown-type manual choices and read-only Side Deck');

assert.deepEqual(cardDropActions(monster,'hand','monsters').map(choice=>choice.id),['normal','special','set']);
assert.deepEqual(cardDropActions(monster,'monsters','monsters',{samePosition:true}).map(choice=>choice.id),['activate','position','set']);
assert.deepEqual(cardDropActions({...monster,faceUp:false},'monsters','monsters',{samePosition:true}).map(choice=>choice.id),['flip-attack','flip-defense']);
assert.deepEqual(cardDropActions(monster,'monsters','monsters').map(choice=>choice.id),['move','set']);
for(const card of [monster,spell,trap,fieldSpell,{type:'Link Monster',faceUp:true},{type:'Ritual Monster',faceUp:true},{...monster,token:true},{}]){
  for(const from of ['hand','monsters','extraMonsters','spells','field','deck','graveyard','banished','extra','side']){
    assert(cardTapActions(card,from).length<=3,`Tap options must fit three choices: ${card.type||'unknown'} in ${from}`);
    for(const to of ['monsters','extraMonsters','spells','field','deck','graveyard','banished','extra','hand']){
      for(const samePosition of [false,true]){
        const choices=cardDropActions(card,from,to,{samePosition});
        assert(choices.length<=3,`Drop options must fit three choices: ${card.type||'unknown'} from ${from} to ${to}`);
        assert(!choices.some(choice=>choice.id==='special-defense'),'Special Summon uses one compact choice');
      }
    }
  }
}
console.log('PASS every quick tap/drop menu fits at most three context-appropriate choices');
console.log('yugioh-card-tap-smoke: OK');
