// Real app on mobile Chrome; only synthetic Supabase/Push API boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';import http from 'node:http';import net from 'node:net';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';
const root=process.cwd(), out=path.join(root,'artifacts/push-notifications-2');fs.mkdirSync(out,{recursive:true});
const fixture=`(()=>{
const people=[{slug:'push-a',full_name:'Membro A',role:'admin'},{slug:'push-b',full_name:'Membro B',role:'guest'}];
window.__pushCalls={requests:0,saves:0,removed:0,tests:0};let permission='default',subscription=null;
Object.defineProperty(window,'Notification',{configurable:true,value:{get permission(){return permission},async requestPermission(){window.__pushCalls.requests++;permission='granted';return permission}}});
window.PushManager=class {};
const registration={update:async()=>{},getNotifications:async()=>[],pushManager:{async getSubscription(){return subscription},async subscribe(){subscription={endpoint:'https://fcm.googleapis.com/fcm/send/synthetic',options:{},expirationTime:null,toJSON(){return {endpoint:this.endpoint,keys:{p256dh:'synthetic-key',auth:'synthetic-auth'}}},async unsubscribe(){subscription=null;return true}};return subscription}}};
const sw=new EventTarget();sw.ready=Promise.resolve(registration);sw.register=async()=>registration;sw.getRegistration=async()=>registration;Object.defineProperty(navigator,'serviceWorker',{value:sw,configurable:true});
const client={async rpc(name,args={}){
 if(name==='list_login_members'||name==='list_team_members'||name==='list_member_profiles')return {data:people};
 if(name==='login_member')return {data:{slug:args.p_slug,role:'admin'}};
 if(name==='get_my_team')return {data:null};
 if(name==='save_push_subscription'){window.__pushCalls.saves++;return {data:null}};
 if(name==='remove_push_subscription'){window.__pushCalls.removed++;return {data:null}};
 if(name==='list_team_loans')return {data:[{id:'push-loan',card_name:'Carta di prova',quantity:2,requested_quantity:2,accepted_quantity:0,owner_slug:'push-a',borrower_slug:'push-b',status:'requested',game:'yugioh',created_at:'2026-11-01T10:00:00Z',card_image:'/icon-192.png'}]};
 if(name==='get_my_progression')return {data:{totalXp:0,level:1,xpToday:0,dailyCap:100}};
 if(name==='get_match_streak')return {data:{result:null,count:0}};
 return {data:[]};
},channel(){return {on(){return this},subscribe(){return this}}},removeChannel(){}};
window.supabase={createClient:()=>client};
const nativeFetch=window.fetch.bind(window);window.fetch=async(input,options)=>{const url=String(input);if(url.includes('/api/push-public-key'))return new Response(JSON.stringify({publicKey:'BAECAw'}));if(url.includes('/api/test-push')){window.__pushCalls.tests++;return new Response(JSON.stringify({accepted:1}))}if(/^https?:/.test(url)&&!url.startsWith(location.origin))return new Response(JSON.stringify({data:[]}));return nativeFetch(input,options)};
})();`;
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.woff2':'font/woff2','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/push-fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(fixture);return}const file=path.resolve(root,url.pathname==='/'?'index.html':decodeURIComponent(url.pathname).slice(1));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return}fs.readFile(file,(error,body)=>{if(error){res.writeHead(404).end();return}res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(file.endsWith('index.html')?body.toString().replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2','/push-fixture.js'):body)})});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fpt-push-browser-'));
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let socket;
try {
 let tab;for(let i=0;i<80;i++){try{tab=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0];if(tab)break}catch{}await delay(100)}assert(tab,'Chrome unavailable');
 socket=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});let id=0;const pending=new Map(),errors=[];
 socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(Error('CDP timeout '+method)),15000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}))});
 const evaluate=async(expression)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 const wait=async(expression)=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(100)}throw Error('Not found: '+expression+' '+await evaluate('document.body.innerText.slice(0,700)'))};
 const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const screenshot=async name=>fs.writeFileSync(path.join(out,name+'.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await call('Runtime.enable');await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await call('Page.navigate',{url:origin+'/#/loans?loanId=push-loan'});await wait('!!document.querySelector("#login-form")');
 await evaluate(`document.querySelector('#member').value='push-a';document.querySelector('#pin').value='1234';document.querySelector('#login-form').requestSubmit()`);
 await wait('!!document.querySelector(".loan-detail-sheet")');assert.equal(await evaluate('location.hash'),'#/loans?loanId=push-loan');console.log('PASS cold notification deep link survives login and opens correct loan');
 await click('[data-close-loan-detail].detail-backdrop .detail-close');await wait('!!document.querySelector("#onboard-notifications")');await screenshot('phone-onboarding');
 assert.equal(await evaluate('__pushCalls.requests'),0);assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));await click('#defer-notifications');assert.equal(await evaluate('!!document.querySelector("#onboard-notifications")'),false);console.log('PASS phone onboarding, no unsolicited native prompt, Non ora and no horizontal overflow');
 await evaluate(`location.hash='#/settings'`);await wait('!!document.querySelector("#enable-notifications")');await screenshot('phone-settings-before');await click('#enable-notifications');await wait('__pushCalls.saves===1 && !!document.querySelector("#test-notifications")');assert.equal(await evaluate('__pushCalls.requests'),1);await screenshot('phone-settings-active');
 for(const width of [360,390]){await call('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});assert(await evaluate('document.documentElement.scrollWidth<=innerWidth && document.querySelector(".settings-copy").getBoundingClientRect().width>200'));}
 console.log('PASS notification settings readable without overflow at 360/390 px');
 await click('#test-notifications');await wait('__pushCalls.tests===1');await click('#enable-notifications');await wait('__pushCalls.saves===2 && document.querySelector("#reset-notifications")?.disabled===false');console.log('PASS activation, actual status, own-device test and repair');
 await click('#reset-notifications');await wait('__pushCalls.removed===1 && !document.querySelector("#test-notifications") && document.querySelector("#enable-notifications")?.disabled===false');assert.equal(await evaluate('Notification.permission'),'granted');await evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);assert.equal(await evaluate('__pushCalls.saves'),2);await click('#enable-notifications');await wait('__pushCalls.saves===3');assert.equal(await evaluate('__pushCalls.requests'),1);console.log('PASS device reset, foreground stays paused, explicit reactivation and native permission unchanged');
 await evaluate(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:'fpt-notification-click',url:location.origin+'/#/loans?loanId=push-loan'}}))`);await wait('!!document.querySelector(".loan-detail-sheet")');console.log('PASS warm notification click opens correct loan');
 await click('.loan-detail-sheet .detail-close');await evaluate(`location.hash='#/settings'`);await wait('!!document.querySelector("#test-notifications")');await click('[data-logout]');await wait('!!document.querySelector("#login-form")');assert.equal(await evaluate('__pushCalls.removed'),2);assert.equal(await evaluate(`(async()=>{const cache=await caches.open('fpt-push-state-v1');const hit=await cache.match('/__push_owner');return hit.text()})()`),'');console.log('PASS logout unregisters device and clears private notification identity');
 await evaluate(`document.querySelector('#member').value='push-b';document.querySelector('#pin').value='1234';document.querySelector('#login-form').requestSubmit()`);await wait('__pushCalls.saves===4');assert.equal(await evaluate(`(async()=>{const c=await caches.open('fpt-push-state-v1');return (await c.match('/__push_owner')).text()})()`),'push-b');
 await evaluate(`window.dispatchEvent(new StorageEvent('storage',{key:'fpt-cards-session-token',oldValue:'old-session',newValue:'new-session'}))`);await wait('!!document.querySelector("#login-form")');console.log('PASS account switch auto repairs without another permission prompt; other-tab session change invalidates old UI');
 assert.deepEqual(errors,[]);console.log('PASS no uncaught browser exceptions');
} finally {socket?.close();chrome.kill();await new Promise(r=>server.close(r));}
