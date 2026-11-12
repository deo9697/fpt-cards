import assert from 'node:assert/strict';
import { createDuelCardGestures } from '../js/games/yugioh/simulator-touch.js';

function clock() {
  let now=0,id=0;const tasks=new Map();
  return { get now(){return now;},setTimeout(fn,ms){const key=++id;tasks.set(key,{fn,at:now+ms});return key;},clearTimeout(key){tasks.delete(key);},count:()=>tasks.size,
    advance(ms){const end=now+ms;for(;;){const next=[...tasks.entries()].filter(([,task])=>task.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;tasks.delete(next[0]);next[1].fn();}now=end;}
  };
}
function events(object={}) {
  const handlers=new Map();
  Object.assign(object,{
    addEventListener(type,fn){if(!handlers.has(type))handlers.set(type,new Set());handlers.get(type).add(fn);},
    removeEventListener(type,fn){handlers.get(type)?.delete(fn);},
    emit(type,event={}){event.type=type;for(const fn of [...handlers.get(type)||[]])fn(event);},
    listenerCount(){return [...handlers.values()].reduce((sum,set)=>sum+set.size,0);}
  });return object;
}
function element(doc,tag='div',dataset={}) {
  const classes=new Set(),node=events({ownerDocument:doc,tagName:tag.toUpperCase(),dataset:{...dataset},children:[],parentElement:null,style:{},attributes:{},isConnected:true,disabled:false,textContent:''});
  node.classList={add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),contains:name=>classes.has(name)};
  node.setAttribute=(key,value)=>{node.attributes[key]=String(value);};node.getAttribute=key=>node.attributes[key]??null;
  node.appendChild=child=>{child.parentElement=node;node.children.push(child);return child;};
  node.remove=()=>{if(node.parentElement)node.parentElement.children=node.parentElement.children.filter(child=>child!==node);node.parentElement=null;node.isConnected=false;};
  node.contains=child=>{for(let current=child;current;current=current.parentElement)if(current===node)return true;return false;};
  node.closest=selectors=>{for(let current=node;current;current=current.parentElement){if(selectors.includes('[data-ygo-card]')&&current.dataset.ygoCard!==undefined||selectors.includes('[data-ygo-slot]')&&current.dataset.ygoSlot!==undefined||selectors.includes('[data-ygo-drop-zone]')&&current.dataset.ygoDropZone!==undefined)return current;}return null;};
  node.querySelector=selector=>selector==='img'?node.children.find(child=>child.tagName==='IMG')||null:null;
  node.getBoundingClientRect=()=>({left:20,top:250,width:42,height:59});
  node.captured=new Set();node.setPointerCapture=id=>node.captured.add(id);node.releasePointerCapture=id=>node.captured.delete(id);
  return node;
}
function event(target,extra={}) {
  return {target,pointerId:7,pointerType:'touch',isPrimary:true,button:0,clientX:40,clientY:275,prevented:false,stopped:false,
    preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},stopPropagation(){this.stopped=true;},...extra};
}
function fixture() {
  const time=clock(),doc=events({hit:null,points:[]});doc.createElement=tag=>element(doc,tag);doc.body=element(doc,'body');doc.elementFromPoint=(x,y)=>{doc.points.push({x,y});return doc.hit;};
  const root=element(doc),hand=element(doc,'div',{ygoDropZone:'hand',player:'0'}),card=element(doc,'button',{ygoCard:'card-1',player:'0'});
  doc.body.appendChild(root);root.appendChild(hand);hand.appendChild(card);card.setAttribute('aria-label','Private card');
  const image=element(doc,'img',{privateMarker:'do not clone'});image.src='/card.jpg';image.id='private-art-id';card.appendChild(image);doc.hit=card;
  const slot=element(doc,'button',{ygoSlot:'4',zone:'monsters',player:'0'});root.appendChild(slot);
  const starts=[],drops=[],cancels=[];let version='duel:1',controllable=true;
  const helper=createDuelCardGestures({environment:{document:doc,setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,performance:{now:()=>time.now}},
    canStart:node=>controllable&&Number(node.dataset.player)===0,getRevision:()=>version,onStart:value=>starts.push(value),onDrop:value=>drops.push(value),onCancel:value=>cancels.push(value)});
  helper.bind(root);
  const ghost=()=>doc.body.children.find(node=>node.className==='ygo-drag-ghost');
  return {time,doc,root,hand,card,image,slot,starts,drops,cancels,helper,ghost,setRevision:value=>{version=value;},setControllable:value=>{controllable=value;},node:(tag,data)=>element(doc,tag,data)};
}

{
  const f=fixture(),down=event(f.card);f.root.emit('pointerdown',down);f.time.advance(319);
  assert.equal(down.prevented,false);assert.equal(f.starts.length,0);assert.equal(f.ghost(),undefined);
  f.doc.emit('pointerup',event(f.card));f.time.advance(5);
  const click=event(f.card);f.doc.emit('click',click);assert.equal(click.prevented,false);assert.equal(f.starts.length,0);
  assert.equal(f.time.count(),0);f.helper.dispose();
  console.log('PASS short taps remain normal card clicks without long-press state');
}
{
  const f=fixture();f.root.emit('pointerdown',event(f.card));
  const scroll=event(f.card,{clientX:56});f.doc.emit('pointermove',scroll);f.time.advance(400);
  assert.equal(scroll.prevented,false);assert.equal(f.starts.length,0);assert.equal(f.ghost(),undefined);assert.equal(f.time.count(),0);
  const native=event(f.card,{touches:[{}]});f.doc.emit('touchmove',native);assert.equal(native.prevented,false);
  f.helper.dispose();console.log('PASS movement before the hold preserves native hand scrolling');
}
{
  const f=fixture();f.root.emit('pointerdown',event(f.card));f.time.advance(320);
  assert.deepEqual(f.starts,[{cardId:'card-1',player:0}]);assert(f.card.captured.has(7));assert(f.card.classList.contains('is-drag-source'));
  const ghost=f.ghost();assert(ghost);assert.equal(ghost.children[0].src,'/card.jpg');assert.equal(ghost.children[0].id,undefined);assert.deepEqual(ghost.children[0].dataset,{});assert.equal(ghost.style.pointerEvents,'none');
  f.doc.hit=f.slot;const move=event(f.card,{clientX:330,clientY:110});f.doc.emit('pointermove',move);assert(move.prevented);assert(f.slot.classList.contains('is-drag-target'));assert.equal(ghost.style.transform,'translate3d(309px,80.5px,0)');
  const native=event(f.card,{touches:[{}]});f.doc.emit('touchmove',native);assert(native.prevented,'An active hold stops native panning');
  const drag=event(f.card);f.doc.emit('dragstart',drag);assert(drag.prevented,'The touch gesture takes priority over browser-native HTML drag');
  const up=event(f.card,{clientX:330,clientY:110});f.doc.emit('pointerup',up);
  assert.deepEqual(f.drops,[{cardId:'card-1',player:0,zone:'monsters',slot:4,x:330,y:110}]);assert(up.prevented);
  assert.equal(f.ghost(),undefined);assert.equal(f.card.captured.size,0);assert(!f.slot.classList.contains('is-drag-target'));assert(!f.root.classList.contains('is-touch-dragging'));
  const compatibilityClick=event(f.card);f.doc.emit('click',compatibilityClick);assert(compatibilityClick.prevented&&compatibilityClick.stopped);assert.equal(f.time.count(),0);
  const menuButton=f.node('button',{}),menuClick=event(menuButton,{pointerId:9});f.doc.emit('click',menuClick);assert.equal(menuClick.prevented,false,'A new tap on the drop menu must still work');
  f.helper.dispose();console.log('PASS hold, sanitized ghost, pointer capture, native pan prevention, drop and synthetic-click suppression');
}
{
  const f=fixture();f.root.emit('pointerdown',event(f.card));f.time.advance(320);
  f.doc.emit('pointerup',event(f.card));
  assert.deepEqual(f.drops,[{cardId:'card-1',player:0,zone:'hand',slot:undefined,x:40,y:275}],'Holding in place can open the same-zone context menu');
  f.time.advance(401);const click=event(f.card);f.doc.emit('click',click);assert.equal(click.prevented,false);
  f.helper.dispose();
  const occupied=fixture(),zone=occupied.node('div',{ygoDropZone:'monsters',ygoDropSlot:'2',player:'0'});occupied.root.appendChild(zone);zone.appendChild(occupied.card);occupied.doc.hit=occupied.card;
  occupied.root.emit('pointerdown',event(occupied.card));occupied.time.advance(320);occupied.doc.emit('pointerup',event(occupied.card));
  assert.equal(occupied.drops[0].zone,'monsters');assert.equal(occupied.drops[0].slot,2);occupied.helper.dispose();
  console.log('PASS in-place contexts, occupied wrappers and destinations without a slot');
}
{
  const f=fixture();f.root.emit('pointerdown',event(f.card));f.setRevision('duel:2');f.time.advance(320);
  assert.equal(f.starts.length,0);assert.equal(f.drops.length,0);assert.equal(f.ghost(),undefined);f.helper.dispose();
  const after=fixture();after.root.emit('pointerdown',event(after.card));after.time.advance(320);after.setRevision('duel:2');after.doc.hit=after.slot;after.doc.emit('pointerup',event(after.card));
  assert.equal(after.drops.length,0);assert.equal(after.cancels[0].reason,'revision');assert.equal(after.ghost(),undefined);after.helper.dispose();
  console.log('PASS revision changes before hold or drop cancel stale gestures');
}
{
  for(const kind of ['opponent','disabled','outside']){
    const f=fixture();f.root.emit('pointerdown',event(f.card));f.time.advance(320);
    if(kind==='opponent')f.slot.dataset.player='1';if(kind==='disabled')f.slot.disabled=true;
    if(kind==='outside')f.doc.hit=f.node('button',{ygoDropZone:'graveyard',player:'0'});else f.doc.hit=f.slot;
    f.doc.emit('pointerup',event(f.card));assert.equal(f.drops.length,0,kind);assert.equal(f.cancels[0].reason,'destination');f.helper.dispose();
  }
  const f=fixture();f.setControllable(false);f.root.emit('pointerdown',event(f.card));f.time.advance(400);assert.equal(f.starts.length,0);f.helper.dispose();
  console.log('PASS denied sources and opponent, disabled or external destinations never drop');
}
{
  for(const type of ['pointercancel','lostpointercapture']){
    const f=fixture();f.root.emit('pointerdown',event(f.card));f.time.advance(320);f.doc.emit(type,event(f.card));assert.equal(f.ghost(),undefined);assert.equal(f.cancels[0].reason,type);f.helper.dispose();assert.equal(f.time.count(),0);
  }
  const f=fixture();f.root.emit('pointerdown',event(f.card));f.time.advance(320);const replacement=f.node('div',{});f.doc.body.appendChild(replacement);f.helper.bind(replacement);
  assert.equal(f.ghost(),undefined);assert.equal(f.root.listenerCount(),0);assert.equal(f.cancels[0].reason,'rebind');
  f.helper.dispose();assert.equal(f.doc.listenerCount(),0);assert.equal(replacement.listenerCount(),0);assert.equal(f.time.count(),0);f.helper.bind(f.root);assert.equal(f.root.listenerCount(),0);
  console.log('PASS cancel, lost capture, rebind and disposal remove gestures, timers and listeners');
}
{
  const f=fixture();f.root.emit('pointerdown',event(f.card,{pointerType:'mouse'}));f.time.advance(400);assert.equal(f.starts.length,0);
  const mouseMenu=event(f.card);f.doc.emit('contextmenu',mouseMenu);assert.equal(mouseMenu.prevented,false);
  const mouseDrag=event(f.card);f.doc.emit('dragstart',mouseDrag);assert.equal(mouseDrag.prevented,false);
  f.root.emit('pointerdown',event(f.card,{pointerType:'pen'}));f.time.advance(320);const touchMenu=event(f.card);f.doc.emit('contextmenu',touchMenu);assert(touchMenu.prevented);
  f.helper.cancel('orientation');assert.equal(f.cancels[0].reason,'orientation');f.helper.dispose();
  console.log('PASS mouse stays native, pen can drag and only owned long-press context menus are suppressed');
}
console.log('yugioh-touch-smoke: OK');
