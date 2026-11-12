// Isolated unit/integration tests. No production network or handset notifications.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { deliverPush, loanRecipient, notificationMessage } from '../api/_push-delivery.js';
import { createPushHandler } from '../api/send-push.js';
import { createTestHandler } from '../api/test-push.js';
let passed=0;
async function test(name, fn) { await fn(); console.log('PASS', name); passed++; }
const endpoint='https://fcm.googleapis.com/fcm/send/synthetic';
const subscription={endpoint,expirationTime:null,options:{},toJSON(){return {endpoint,keys:{p256dh:'key',auth:'auth'}}},async unsubscribe(){this.removed=true;return true}};
async function browser({permission='default',supported=true,existing=null,ios=false,standalone=false,save=null,ready=null}={}) {
  let requests=0,subscribes=0,saves=0,removed=0,token='session-a';
  const store=new Map(), cache=new Map();
  const registration={pushManager:{async getSubscription(){return existing?.removed?null:existing},async subscribe(){subscribes++;existing={...subscription};return existing}},async getNotifications(){return []}};
  globalThis.Notification={permission,async requestPermission(){requests++;this.permission=permission==='denied'?'denied':'granted';return this.permission}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:ios?'iPhone':'Chrome',standalone,serviceWorker:{ready:ready||Promise.resolve(registration),async getRegistration(){return registration}}}});
  globalThis.window={isSecureContext:true,Notification:globalThis.Notification,PushManager:{},caches:{},matchMedia:()=>({matches:standalone})};
  if(!supported)delete window.PushManager;
  globalThis.localStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)};
  globalThis.caches={async open(){return {async put(k,v){cache.set(k,await v.text())},async match(k){return cache.has(k)?new Response(cache.get(k)):undefined}}}};
  globalThis.fetch=async()=>({ok:true,json:async()=>({publicKey:'BAECAw'})});
  globalThis.__pushTestApi={pushSession:()=>token,async savePushSubscription(...args){saves++;await save?.(...args)},async removePushSubscription(){removed++},async testPush(){return {accepted:1}}};
  const source=fs.readFileSync('js/push.js','utf8').replace("import { api } from './api.js';",'const api = globalThis.__pushTestApi;');
  const module=await import('data:text/javascript;base64,'+Buffer.from(source+'\n//'+Math.random()).toString('base64'));
  return {module,registration,store,cache,counts:()=>({requests,subscribes,saves,removed}),changeToken:value=>{token=value}};
}
await test('first activation requests permission only on explicit enable; missing subscription is saved',async()=>{
  const b=await browser();await b.module.setPushAccount('a');assert.equal(b.counts().requests,0);assert(b.module.shouldOfferPush());
  await b.module.enablePushNotifications();assert.deepEqual(b.counts(),{requests:1,subscribes:1,saves:1,removed:0});assert(b.module.pushConfigured());assert.equal(b.cache.get('/__push_owner'),'a');
});
await test('granted permission repairs missing database registration; existing subscription reused',async()=>{
  const b=await browser({permission:'granted',existing:{...subscription}});await b.module.setPushAccount('a');assert.equal(b.counts().saves,1);assert.equal(b.counts().subscribes,0);assert.equal(b.counts().requests,0);
});
await test('granted permission with missing subscription self repairs',async()=>{const b=await browser({permission:'granted'});await b.module.setPushAccount('a');assert(b.module.pushConfigured());assert.equal(b.counts().subscribes,1)});
await test('denied permission and unsupported browsers never subscribe',async()=>{
  for(const opts of [{permission:'denied'},{supported:false}]){const b=await browser(opts);await b.module.setPushAccount('a');await assert.rejects(b.module.enablePushNotifications());assert.equal(b.counts().subscribes,0);assert(!b.module.pushConfigured())}
});
await test('iOS Home Screen instructions; installed supported context enabled',async()=>{
  let b=await browser({ios:true});await b.module.setPushAccount('a');assert.equal(b.module.pushStatus(),'install');await assert.rejects(b.module.enablePushNotifications(),/Home/);
  b=await browser({ios:true,standalone:true});await b.module.setPushAccount('a');await b.module.enablePushNotifications();assert(b.module.pushConfigured());
});
await test('Non ora snoozes onboarding per account for seven days',async()=>{const b=await browser();await b.module.setPushAccount('a');b.module.deferPush();assert(!b.module.shouldOfferPush());await b.module.setPushAccount('b');assert(b.module.shouldOfferPush())});
await test('old localStorage configured flag never claims active',async()=>{const b=await browser();b.store.set('fpt-push-configured','true');assert(!b.module.pushConfigured())});
await test('expired subscription is removed then replaced',async()=>{const b=await browser({permission:'granted',existing:{...subscription,expirationTime:1}});await b.module.setPushAccount('a');assert.equal(b.counts().removed,1);assert.equal(b.counts().subscribes,1)});
await test('concurrent repair coalesces saves',async()=>{const b=await browser({permission:'granted'});await b.module.setPushAccount('a');await Promise.all([b.module.reconcilePush(),b.module.reconcilePush()]);assert.equal(b.counts().saves,2)});
await test('logout while worker readiness is pending prevents stale registration',async()=>{
  let release;const ready=new Promise(r=>release=r);const b=await browser({permission:'granted',ready});const started=b.module.setPushAccount('a');await Promise.resolve();const stopped=b.module.stopPush();release(b.registration);await Promise.all([started,stopped]);assert.equal(b.counts().saves,0);assert(!b.module.pushConfigured());assert.equal(b.cache.get('/__push_owner'),'');
});
await test('account switch while save is pending cannot mark old account active',async()=>{
  let release,entered;const enteredPromise=new Promise(r=>entered=r);let first=true;
  const b=await browser({permission:'granted',save:async()=>{if(first){first=false;entered();await new Promise(r=>release=r)}}});
  const started=b.module.setPushAccount('a');await enteredPromise;b.changeToken('session-b');const switched=b.module.setPushAccount('b');release();await Promise.all([started,switched]);assert.equal(b.cache.get('/__push_owner'),'b');assert(b.module.pushConfigured());assert.equal(b.counts().saves,2);
});
await test('registration failure is visible and recoverable',async()=>{const b=await browser({permission:'granted',save:()=>{throw Error('synthetic')}});await assert.rejects(b.module.setPushAccount('a'));assert.equal(b.module.pushStatus(),'error');assert(!b.module.pushConfigured())});
await test('device reset removes only its subscription and stays paused until explicit activation',async()=>{
 const b=await browser({permission:'granted'});await b.module.setPushAccount('a');b.module.deferPush();await b.module.resetPushNotifications();
 assert.equal(b.counts().removed,1);assert.equal(Notification.permission,'granted');assert.equal(b.counts().requests,0);assert(b.module.pushResetPaused());assert(!b.module.pushConfigured());assert(b.module.shouldOfferPush());
 await b.module.reconcilePush();assert.equal(b.counts().saves,1);await b.module.enablePushNotifications();assert(!b.module.pushResetPaused());assert(b.module.pushConfigured());assert.equal(b.counts().saves,2);assert.equal(b.counts().requests,0);
});
await test('reset cannot manufacture a native prompt or undo a browser denial',async()=>{
 const b=await browser({permission:'denied'});await b.module.setPushAccount('a');await b.module.resetPushNotifications();assert.equal(Notification.permission,'denied');assert.equal(b.counts().requests,0);await assert.rejects(b.module.enablePushNotifications(),/impostazioni/);assert.equal(b.counts().subscribes,0);
});
await test('foreground reconciliation cannot interrupt an in-flight device reset',async()=>{
 let release,entered;const started=new Promise(resolve=>entered=resolve);
 const existing={...subscription,async unsubscribe(){entered();await new Promise(resolve=>release=resolve);this.removed=true;return true}};
 const b=await browser({permission:'granted',existing});await b.module.setPushAccount('a');
 const reset=b.module.resetPushNotifications();await started;await b.module.reconcilePush();
 assert.equal(b.module.pushStatus(),'resetting');await assert.rejects(b.module.enablePushNotifications(),/completamento/);
 release();await reset;assert.equal(b.module.pushStatus(),'unconfigured');assert.equal(b.counts().saves,1);
});
await test('loan request, acceptance, rejection and return produce correct recipient and deep link',async()=>{
  const record={id:'loan-1',owner_slug:'owner',borrower_slug:'borrower',card_name:'Carta reale',quantity:2,status:'requested'};
  const request=loanRecipient('INSERT',record);assert.equal(request.member,'owner');assert.match(request.body,/2× Carta reale/);assert.match(request.url,/loanId=loan-1/);
  for(const status of ['reserved','rejected'])assert.equal(loanRecipient('UPDATE',{...record,status},{status:'requested'}).member,'borrower');
  assert.equal(loanRecipient('UPDATE',{...record,status:'return_pending'},{status:'active'}).member,'owner');assert.equal(loanRecipient('UPDATE',record,{status:'requested'}),null);
  assert.equal(loanRecipient('INSERT',record).tag,request.tag);
  const general=notificationMessage({id:1,member_slug:'owner',title:'Richiesta',route_page:'requests',route_params:{requestId:'r-1'}});assert.equal(general.url,'/#/requests?requestId=r-1');
});
const row={endpoint,p256dh:'p',auth:'a'};
function dbFor(rows=[row]){const deletions=[];return {deletions,async rpc(){return {data:rows}},from(){const q={delete(){return q},eq(k,v){deletions.push([k,v]);return q},then(resolve){resolve({error:null})}};return q}}}
await test('delivery distinguishes accepted, no subscriptions, expired, VAPID and network failures',async()=>{
  for(const [failure,code] of [[null,'push_service_accepted'],[410,'subscriptions_expired'],[403,'vapid_rejected'],[0,'network_error']]){
    const db=dbFor();const r=await deliverPush(db,'a',{}, {transport:{setVapidDetails(){},async sendNotification(){if(failure!==null)throw {statusCode:failure}}}});
    assert.equal(r.code,code);assert.equal(r.accepted,failure===null?1:0);if(failure===410)assert.equal(db.deletions.length,3);if(failure===403||failure===0)assert.equal(r.status,502);
  }
  assert.equal((await deliverPush(dbFor([]),'a',{}, {transport:{setVapidDetails(){}}})).code,'no_subscriptions');
  assert.equal((await deliverPush(dbFor(),'a',{}, {transport:{setVapidDetails(){throw Error()}}})).code,'vapid_configuration');
});
const response=()=>({status(n){this.code=n;return this},json(v){this.body=v;return this},setHeader(){}});
const envKeys=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','PUSH_WEBHOOK_SECRET'];
const savedEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));for(const key of envKeys)process.env[key]='synthetic-config-1234567890';
await test('test push endpoint rejects unauthenticated/other endpoints and propagates rate limit',async()=>{
  for(const [code,status] of [['unauthorized',401],['rate_limited',429]]){let sends=0;const handler=createTestHandler({clientFactory:()=>({rpc:async()=>({data:{code}})}),deliver:async()=>{sends++}});const r=response();await handler({method:'POST',body:{token:'synthetic',endpoint}},r);assert.equal(r.code,status);assert.equal(sends,0)}
});
await test('test push sends exactly claimed device; webhook auth rejects before DB lookup',async()=>{
  const h=createTestHandler({clientFactory:()=>({rpc:async()=>({data:{member:'a',subscription:row}})}),deliver:async(db,member)=>{assert.equal(member,'a');assert.equal((await db.rpc()).data.length,1);return {status:200,accepted:1}}});
  const r=response();await h({method:'POST',body:{token:'synthetic',endpoint}},r);assert.equal(r.body.accepted,1);
  const webhook=createPushHandler({clientFactory:()=>{throw Error('must not run')}});const denied=response();await webhook({method:'POST',headers:{}},denied);assert.equal(denied.code,401);
});
for(const [key,value]of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value}
await test('service worker branding, duplicate tags, privacy, click routing and API bypass',async()=>{
  const handlers={},shown=[],messages=[],opened=[];let owner='a',fetchHandled=false;
  const self={location:{origin:'https://example.test'},addEventListener:(k,fn)=>handlers[k]=fn,registration:{async showNotification(title,opts){shown.push({title,...opts})}},clients:{}};
  const clients={async matchAll(){return [{url:'https://example.test/',postMessage:m=>messages.push(m),focus:async()=>{}}]},async openWindow(url){opened.push(url)}};
  const context={self,clients,URL,Promise,caches:{async open(){return {async match(){return new Response(owner)}}}},console};
  vm.runInNewContext(fs.readFileSync('sw.js','utf8'),context);
  async function push(data){let task;handlers.push({data:{json:()=>data},waitUntil:p=>task=p});await task}
  await push({member:'a',title:'Evento',body:'privato',tag:'same',url:'/#/loans?loanId=1'});await push({member:'a',title:'Evento',tag:'same'});
  assert.equal(shown[0].icon,'/icon-192.png');assert.equal(shown[0].badge,'/assets/notification-badge.png');assert.equal(shown[0].renotify,false);assert.equal(shown[0].tag,shown[1].tag);
  owner='b';await push({member:'a',body:'privato'});assert(!shown.at(-1).body.includes('privato'));
  let task;handlers.notificationclick({notification:{data:{url:'/#/loans?loanId=1'},close(){}},waitUntil:p=>task=p});await task;assert.match(messages[0].url,/loanId=1/);
  clients.matchAll=async()=>[];handlers.notificationclick({notification:{data:{url:'https://evil.test/'},close(){}},waitUntil:p=>task=p});await task;assert.equal(opened[0],'https://example.test/');
  handlers.fetch({request:{method:'GET',url:'https://example.test/api/push-public-key'},respondWith(){fetchHandled=true}});assert.equal(fetchHandled,false);
});
console.log(`${passed} Push 2.0 checks passed`);
