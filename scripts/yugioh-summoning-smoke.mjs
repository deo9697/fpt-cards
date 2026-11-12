import assert from 'node:assert/strict';
import {getSummonKind,getSummonRecipe,materialLevel,eligibleSummonMaterials,validateSummonMaterials,summonPlan} from '../js/games/yugioh/simulator-summoning.js';

const normal=(id,level,slot)=>({id,cardName:id,type:'Effect Monster',level,slot,faceUp:true,token:false,materials:[]});
const tune={...normal('tuner',3,0),type:'Tuner Monster'};
const five=normal('five',5,1),four=normal('four',4,2),secondFour=normal('second-four',4,3),thirdFour=normal('third-four',4,4);
const synchro={id:'stardust',type:'Synchro Monster',cardName:'Generic Synchro',level:8,text:'1 Tuner + 1+ non-Tuner monsters\nAn effect follows.'};
const xyz={id:'utopia',type:'XYZ Monster',cardName:'Generic Xyz',level:4,text:'2 Level 4 monsters\nAn effect follows.'};
assert.equal(getSummonKind(synchro),'synchro');assert.equal(getSummonKind(xyz),'xyz');assert.equal(getSummonKind(four),null);
assert.equal(materialLevel({...four,type:'XYZ Monster'}),null);assert.equal(materialLevel({...four,type:'Link Monster'}),null);
assert.equal(validateSummonMaterials(synchro,[tune,five]).kind,'synchro');
assert.equal(validateSummonMaterials({...synchro,text:'1 Tuner + 1+ mostri non-Tuner'},[tune,five]).requiresManualConfirmation,false);
assert.throws(()=>validateSummonMaterials(synchro,[four,secondFour]),/Tuner/);
assert.throws(()=>validateSummonMaterials(synchro,[tune,four]),/somma/);
assert.throws(()=>validateSummonMaterials(synchro,[tune,{...five,type:'Tuner Monster'}]),/Tuner/);
assert.throws(()=>validateSummonMaterials(synchro,[tune,{...five,faceUp:false}]),/scoperti/);
assert.throws(()=>validateSummonMaterials(synchro,[tune,{...five,level:null}]),/Livello/);
assert.equal(validateSummonMaterials(synchro,[tune,{...five,token:true,type:'Token'}]).kind,'synchro');
console.log('PASS Synchro uses a known Level, required Tuner/non-Tuner counts and the exact total; face-down/missing-Level materials fail');

assert.equal(validateSummonMaterials(xyz,[four,secondFour]).kind,'xyz');
assert.equal(validateSummonMaterials({...xyz,text:'2 mostri di Livello 4'},[four,secondFour]).requiresManualConfirmation,false);
assert.equal(getSummonRecipe({...xyz,rank:4,level:null}).targetRank,4);
assert.throws(()=>validateSummonMaterials(xyz,[four,five]),/Livello 4/);
assert.throws(()=>validateSummonMaterials(xyz,[four,{...secondFour,token:true}]),/Segna-Mostro/);
assert.throws(()=>validateSummonMaterials(xyz,[four,{...secondFour,type:'XYZ Monster'}]),/Livello/);
assert.throws(()=>validateSummonMaterials(xyz,[four,four]),/distinti/);
const three={...xyz,text:'3 Level 4 monsters'};
assert.throws(()=>validateSummonMaterials(three,[four,secondFour]),/3 materiali/);
assert.equal(validateSummonMaterials(three,[four,secondFour,thirdFour]).minMaterials,3);
assert.throws(()=>validateSummonMaterials({...three,text:'3 mostri OSCURITÀ di Livello 4'},[four,secondFour],{confirmRequirements:true}),/3 materiali/);
assert.equal(validateSummonMaterials({...xyz,text:'2+ Level 4 monsters'},[four,secondFour,thirdFour]).maxMaterials,null);
assert.throws(()=>validateSummonMaterials({...xyz,level:null},[four,secondFour]),/Rango/);
console.log('PASS Xyz uses equal known Levels matching the printed Rank, exact/minimum material counts and rejects Tokens/Xyz/Link');

const named={...xyz,text:'2 Level 4 DARK monsters\nNamed restrictions remain manual.'};
assert.throws(()=>validateSummonMaterials(named,[four,secondFour]),/Conferma/);
assert.equal(validateSummonMaterials(named,[four,secondFour],{confirmRequirements:true}).requiresManualConfirmation,true);
assert.throws(()=>validateSummonMaterials(named,[four,five],{confirmRequirements:true}),/Livello 4/);
const twoTuners={...synchro,level:10,text:'2 Tuners + 1 non-Tuner DARK Dragon Synchro Monster'};
assert.throws(()=>validateSummonMaterials(twoTuners,[tune,{...four,type:'Tuner Monster'},{...five,level:3}]),/Conferma/);
assert.equal(validateSummonMaterials(twoTuners,[tune,{...four,type:'Tuner Monster'},{...five,level:3}],{confirmRequirements:true}).minTuners,2);
console.log('PASS card-specific requirements require explicit confirmation without bypassing basic material checks');

const state={phase:'main1',activePlayer:0,chain:[],result:null,players:[
  {extra:[synchro,xyz],monsters:[tune,five,four,secondFour,thirdFour],extraMonsters:[]},
  {extra:[],monsters:[normal('foreign',4,0)],extraMonsters:[{...normal('enemy-extra',4,1),type:'Link Monster'}]}
]};
const before=structuredClone(state);
assert.deepEqual(eligibleSummonMaterials(state,0,xyz).map(card=>card.id),['four','second-four','third-four']);
const plan=summonPlan(state,{player:0,cardId:'utopia',materialIds:['four','second-four'],slot:2});
assert.equal(plan.kind,'xyz');assert.equal(plan.slot,2);assert.deepEqual(plan.materials.map(item=>item.zone),['monsters','monsters']);
assert.deepEqual(plan.materials.map(item=>item.index),[2,3]);assert.deepEqual(state,before,'Planning must not mutate cards or materials');
assert.equal(summonPlan(state,{player:0,cardId:'stardust',materialIds:['tuner','five'],to:'extraMonsters',slot:0}).slot,0);
assert.throws(()=>summonPlan(state,{player:0,cardId:'stardust',materialIds:['tuner','five'],to:'extraMonsters',slot:1}),/occupata/);
assert.throws(()=>summonPlan(state,{player:0,cardId:'utopia',materialIds:['four','second-four'],slot:0}),/occupata/);
assert.throws(()=>summonPlan(state,{player:0,cardId:'utopia',materialIds:['four','foreign']}),/tuo terreno/);
assert.throws(()=>summonPlan(state,{player:0,cardId:'missing',materialIds:['four','second-four']}),/Extra Deck/);
assert.throws(()=>summonPlan({...state,phase:'battle'},{player:0,cardId:'utopia',materialIds:['four','second-four']}),/Main Phase/);
assert.throws(()=>summonPlan({...state,chain:[{}]},{player:0,cardId:'utopia',materialIds:['four','second-four']}),/catena/);
assert.throws(()=>summonPlan({...state,activePlayer:1},{player:0,cardId:'utopia',materialIds:['four','second-four']}),/Main Phase/);
assert.deepEqual(state,before);
console.log('PASS plans preserve state, use only the owner’s face-up field, free consumed slots and respect Main Phase/shared zones/chains');
console.log('yugioh-summoning-smoke: OK');
