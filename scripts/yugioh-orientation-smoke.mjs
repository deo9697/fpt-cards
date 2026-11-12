import assert from 'node:assert/strict';
import { createDuelOrientation } from '../js/games/yugioh/simulator-orientation.js';

const deferred = () => { let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };
const flush = () => new Promise(resolve=>queueMicrotask(resolve));
function target() {
  const listeners=new Map();
  return {
    addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
    removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
    emit(name){for(const fn of listeners.get(name)||[])fn();},
    listenerCount(){return [...listeners.values()].reduce((sum,set)=>sum+set.size,0);}
  };
}
function fixture({mobile=true,coarse=mobile,lock=true,fullscreen=true,existingFullscreen=false}={}) {
  const calls=[],env=target(),doc=target(),orientation=target();
  Object.assign(env,{innerWidth:390,innerHeight:844,navigator:{userAgent:mobile?'Mozilla/5.0 Android Mobile':'Mozilla/5.0 Windows NT',platform:'',maxTouchPoints:mobile?5:0},document:doc,screen:{orientation},setTimeout,clearTimeout,queueMicrotask});
  env.matchMedia=query=>({matches:query==='(pointer: coarse)'?coarse:query==='(orientation: portrait)'?env.innerHeight>=env.innerWidth:false});
  doc.documentElement={};doc.fullscreenElement=existingFullscreen?doc.documentElement:null;
  if(lock)orientation.lock=async name=>{calls.push('lock:'+name);};
  orientation.unlock=()=>calls.push('unlock');
  if(fullscreen){doc.documentElement.requestFullscreen=async()=>{calls.push('fullscreen');doc.fullscreenElement=doc.documentElement;};doc.exitFullscreen=async()=>{calls.push('exitFullscreen');doc.fullscreenElement=null;};}
  return {env,doc,orientation,calls};
}

{
  const f=fixture({mobile:false}),events=[];
  const helper=createDuelOrientation({environment:f.env,onChange:event=>events.push(event)});
  await helper.enter({userGesture:true});await flush();
  assert.deepEqual(f.calls,[],'A narrow desktop window must not request orientation or fullscreen');
  assert.equal(helper.isPortraitBlocked(),false);assert.equal(events.length,0);
  await helper.dispose();assert.equal(f.env.listenerCount(),0);assert.equal(f.orientation.listenerCount(),0);assert.equal(f.doc.listenerCount(),0);
  console.log('PASS narrow desktop stays unrestricted and does not request mobile APIs');
}
{
  const f=fixture(),events=[];
  const helper=createDuelOrientation({environment:f.env,onChange:event=>events.push(event.blocked)});
  await helper.enter();await helper.enter();await flush();
  assert.deepEqual(f.calls,['lock:landscape'],'Repeated render/bind calls must not issue repeated locks');
  assert.equal(helper.isPortraitBlocked(),true,'Successful lock alone must not bypass the portrait gate');
  assert.deepEqual(events,[true]);
  f.env.innerWidth=844;f.env.innerHeight=390;f.env.emit('resize');f.env.emit('orientationchange');f.orientation.emit('change');await flush();
  assert.equal(helper.isPortraitBlocked(),false);assert.deepEqual(events,[true,false],'Resize notifications should be coalesced');
  await helper.exit();assert.deepEqual(f.calls,['lock:landscape','unlock']);
  assert.equal(f.env.listenerCount(),0);assert.equal(f.orientation.listenerCount(),0);assert.equal(f.doc.listenerCount(),0);
  console.log('PASS automatic landscape lock, portrait gate, rotation and listener cleanup');
}
{
  const f=fixture(),helper=createDuelOrientation({environment:f.env});
  await helper.enter({userGesture:true});
  assert.deepEqual(f.calls,['fullscreen','lock:landscape'],'A gesture requests fullscreen before locking');
  await helper.exit();assert.deepEqual(f.calls,['fullscreen','lock:landscape','unlock','exitFullscreen']);
  assert.equal(f.doc.fullscreenElement,null);
  const preexisting=fixture({existingFullscreen:true}),existingHelper=createDuelOrientation({environment:preexisting.env});
  await existingHelper.enter({userGesture:true});await existingHelper.dispose();
  assert.deepEqual(preexisting.calls,['lock:landscape','unlock'],'Leaving the arena must preserve user-owned fullscreen');
  assert.equal(preexisting.doc.fullscreenElement,preexisting.doc.documentElement);
  console.log('PASS fullscreen ordering and ownership-safe exit');
}
{
  const f=fixture({lock:false,fullscreen:false});
  f.env.navigator={userAgent:'Mozilla/5.0 iPhone',platform:'iPhone',maxTouchPoints:5};
  f.env.matchMedia=()=>({matches:false});
  const helper=createDuelOrientation({environment:f.env});
  assert.equal(helper.isMobile(),true);assert.equal(await helper.enter({userGesture:true}),false);assert.equal(helper.isPortraitBlocked(),true);
  await helper.dispose();assert.deepEqual(f.calls,[]);
  const ipad=fixture({mobile:false,coarse:false});ipad.env.navigator={platform:'MacIntel',maxTouchPoints:5,userAgent:'Mozilla/5.0 Macintosh'};
  const tablet=createDuelOrientation({environment:ipad.env});assert.equal(tablet.isMobile(),true);await tablet.dispose();
  console.log('PASS iPhone/iPad detection and unsupported APIs retain the rotate fallback');
}
{
  const f=fixture(),helper=createDuelOrientation({environment:f.env});
  f.doc.documentElement.requestFullscreen=()=>{f.calls.push('fullscreen');throw new Error('Denied');};
  f.orientation.lock=async name=>{f.calls.push('lock:'+name);throw new Error('NotSupportedError');};
  assert.equal(await helper.enter({userGesture:true}),false);assert.equal(helper.isPortraitBlocked(),true);
  assert.deepEqual(f.calls,['fullscreen','lock:landscape']);await helper.dispose();
  console.log('PASS denied fullscreen and orientation requests fail safely without bypassing portrait');
}
{
  const f=fixture(),pending=deferred(),helper=createDuelOrientation({environment:f.env});
  f.doc.documentElement.requestFullscreen=()=>{f.calls.push('fullscreen');return pending.promise;};
  const entry=helper.enter({userGesture:true});await helper.exit();
  assert.equal(await entry,false,'Leaving while fullscreen is pending must cancel the entry');
  f.doc.fullscreenElement=f.doc.documentElement;pending.resolve();await flush();await flush();
  assert.deepEqual(f.calls,['fullscreen','exitFullscreen'],'Late fullscreen completion must be released without locking a departed arena');
  assert.equal(f.doc.fullscreenElement,null);assert.equal(helper.isPortraitBlocked(),false);await helper.dispose();
  console.log('PASS leaving during fullscreen prevents stale landscape locks');
}
{
  const f=fixture(),pending=deferred(),helper=createDuelOrientation({environment:f.env});
  f.orientation.lock=name=>{f.calls.push('lock:'+name);return pending.promise;};
  const entry=helper.enter();await helper.dispose();assert.equal(await entry,false);
  pending.resolve();await flush();await flush();
  assert.deepEqual(f.calls,['lock:landscape','unlock','unlock'],'A late lock must also be unlocked after disposal');
  assert.equal(await helper.enter({userGesture:true}),false);assert.equal(helper.isPortraitBlocked(),false);
  console.log('PASS disposal cancels pending locks and late completion cannot re-lock the page');
}
{
  const f=fixture(),pending=deferred(),helper=createDuelOrientation({environment:f.env});
  f.doc.documentElement.requestFullscreen=()=>{f.calls.push('fullscreen');return pending.promise;};
  const oldEntry=helper.enter({userGesture:true});await helper.exit();
  await helper.enter();
  f.doc.fullscreenElement=f.doc.documentElement;pending.resolve();await oldEntry;await flush();
  assert.equal(f.doc.fullscreenElement,f.doc.documentElement,'A new active arena may adopt a fullscreen request completing from its predecessor');
  assert.deepEqual(f.calls,['fullscreen','lock:landscape'],'Old completion must not lock again or exit the new arena');
  await helper.exit();assert.deepEqual(f.calls,['fullscreen','lock:landscape','unlock','exitFullscreen']);
  console.log('PASS re-entry adopts late owned fullscreen without disturbing the new arena');
}
{
  const f=fixture(),pending=deferred(),helper=createDuelOrientation({environment:f.env,timeoutMs:10});
  f.orientation.lock=()=>pending.promise;
  assert.equal(await helper.enter(),false,'A non-settling native API must not keep the caller pending');
  assert.equal(helper.isPortraitBlocked(),true);await helper.dispose();pending.reject(new Error('Late rejection'));await flush();
  console.log('PASS non-settling platform requests time out and late rejection is handled');
}
console.log('yugioh-orientation-smoke: OK');
