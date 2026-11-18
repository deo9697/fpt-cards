// SPDX-License-Identifier: AGPL-3.0-or-later
// Pending engine responses must preserve the mounted field, prevent duplicate
// choices and keep navigation/orientation usable without optimistic card moves.
import assert from 'node:assert/strict';
import {YugiohMultiplayer} from '../js/games/yugioh/simulator-multiplayer.js';

let renders=0, sent=0, release, rejectResponse;
const identity={team:'private-team',member:'me',allowed:true};
const deferred=()=>new Promise((resolve,reject)=>{release=resolve;rejectResponse=reject;});
const player=name=>({name,lp:8000,deck:[],hand:[],extra:[],side:[],monsters:[],spells:[],field:[],extraMonsters:[],graveyard:[],banished:[]});
const snapshot=(version=1,id='prompt-1')=>({id:'b0000000-0000-4000-8000-000000000001',mode:'auto',practice:true,status:'playing',viewer:0,version,ready:[true,true],state:{mode:'auto',turn:1,activePlayer:0,phase:'main1',players:[player('Me'),player('Practice')],chain:[],auto:{prompt:{id,kind:'position',player:0,min:1,max:1,options:[{id:'position-1',label:'Attack'}]}}}});
const controller=new YugiohMultiplayer({getContext:()=>identity,getDecks:()=>[],getMembers:()=>[],onRender:()=>{renders++;},onToast:()=>{},call:async()=>{sent++;return deferred();}});
controller.ready=true;controller.schedule=()=>{};controller.practice=true;controller.receive(snapshot());
const controls=['auto-confirm','orientation','practice-exit','menu','close-menu',null].map(command=>({dataset:command?{ygoCommand:command}:{ygoAutoOption:'position-1'},disabled:false}));
const connection={textContent:'Prova personale'},feedback={textContent:'Ready'},removed=[];
const arena={
  dataset:{ygoAutoPrompt:'prompt-1',ygoAutoVersion:'1',ygoAutoDuel:controller.duel.id},isConnected:true,attributes:{},
  setAttribute(name,value){this.attributes[name]=value;},
  querySelector(selector){return selector==='.ygo-online'?connection:selector==='.ygo-arena-status'?feedback:null;},
  querySelectorAll(selector){if(selector==='button,input,select,textarea')return controls;return[{remove:()=>removed.push(selector)}];}
};
controller.autoArena=arena;
try{
  const originalState=JSON.stringify(controller.session);
  const pending=controller.respondAuto({optionId:'position-1'});
  assert.equal(controller.pending,true);assert.equal(sent,1);assert.equal(renders,0,'Pending auto choice must not rebuild the page');
  assert.equal(JSON.stringify(controller.session),originalState,'No optimistic engine changes');
  assert.equal(connection.textContent,'Sync...');assert.equal(arena.attributes['aria-busy'],'true');assert.match(feedback.textContent,/Sincronizzazione/);
  assert.equal(controls[0].disabled,true);assert.equal(controls[5].disabled,true);
  for(const control of controls.slice(1,5))assert.equal(control.disabled,false,'Exit/orientation/menu remain accessible');
  assert(removed.includes('.ygo-drop-menu,.ygo-drop-backdrop'));
  await controller.respondAuto({optionId:'position-1'});assert.equal(sent,1,'Rapid duplicate choice blocked');
  release({duel:snapshot(2,'prompt-2')});await pending;
  assert.equal(controller.pending,false);assert.equal(renders,1);assert.equal(controller.duel.version,2);
  await controller.click({dataset:{ygoAutoOption:'position-1'},closest:()=>arena,hasAttribute:()=>false});assert.equal(sent,1,'Old mounted prompt cannot answer the new prompt');

  // A different page/frame must use the normal render fallback.
  const fallback=controller.respondAuto({optionId:'position-1'});assert.equal(sent,2);assert.equal(renders,2);
  rejectResponse(Object.assign(new Error('Request failed'),{status:503}));await fallback;
  assert.equal(controller.pending,false);assert.equal(renders,3);assert.equal(controller.error,'Request failed');

  arena.dataset.ygoAutoPrompt='prompt-2';arena.dataset.ygoAutoVersion='2';
  const conflict=controller.respondAuto({optionId:'position-1'});assert.equal(renders,3);
  rejectResponse(Object.assign(new Error('Stale version'),{status:409,data:{duel:snapshot(3,'prompt-3')}}));await conflict;
  assert.equal(controller.duel.version,3);assert.equal(controller.autoPrompt().id,'prompt-3');assert.equal(renders,4);assert.equal(controller.pending,false);

  // Navigating away before completion cannot resurrect an old table.
  arena.dataset.ygoAutoPrompt='prompt-3';arena.dataset.ygoAutoVersion='3';
  const leaving=controller.respondAuto({optionId:'position-1'});controller.clearTable();
  release({duel:snapshot(4,'prompt-4')});await leaving;assert.equal(controller.session,null);assert.equal(controller.duel,null);
  console.log('PASS automatic pending UI: mounted battlefield, busy controls, no optimistic moves, duplicate/stale/error/conflict and navigation guards.');
}finally{controller.reset();}
