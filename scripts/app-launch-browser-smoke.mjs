// Real Chrome, real launch assets/styles. No Supabase calls or notifications.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root=process.cwd(), output=path.join(root,'artifacts/app-launch');
fs.mkdirSync(output,{recursive:true});
const index=fs.readFileSync('index.html','utf8');
const launch=index.slice(index.indexOf('  <div id="app-launch"'),index.indexOf('  <script src="js/app-launch.js"'));
const critical=index.slice(index.indexOf('<style>'),index.indexOf('</style>')+8);
const script=fs.readFileSync('js/app-launch.js','utf8');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.jpg':'image/jpeg','.png':'image/png','.woff2':'font/woff2'};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/launch-fixture') {
    const minimal=url.searchParams.has('critical'), ready=url.searchParams.has('ready');
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.end(`<!doctype html><html lang="it"><head><base href="/"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#050711">${critical}${minimal?'':'<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="css/app-launch.css">'}</head><body>${launch}${minimal?'':`<script>${script}</script>`}<div id="app">${ready?'<main class="app-shell">Ready</main>':'<div class="login-loading">Loading profiles</div>'}</div></body></html>`);
  }
  const file=path.resolve(root,decodeURIComponent(url.pathname).slice(1));
  if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
  fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(data);});
});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fpt-launch-smoke-'));
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-sandbox','--no-first-run',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let socket;
try {
  let target;
  for(let i=0;i<80;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0];if(target)break;}catch{}await delay(100);}
  assert(target,'Chrome unavailable');socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let id=0;const tasks=new Map(),errors=[];
  socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const task=tasks.get(m.id);if(task){clearTimeout(task.timer);tasks.delete(m.id);m.error?task.reject(Error(m.error.message)):task.resolve(m.result);}}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(Error(`CDP timeout ${method}`)),12000);tasks.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(80);}throw Error('Missing launch state: '+expression);};
  const viewport=(width,height)=>call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
  await call('Runtime.enable');await call('Page.enable');await viewport(390,844);
  await call('Page.navigate',{url:origin+'/launch-fixture?critical'});await wait('!!document.querySelector(".app-launch-mark")');
  const first=await evaluate('({background:getComputedStyle(document.querySelector("#app-launch")).backgroundColor,logo:getComputedStyle(document.querySelector(".app-launch-mark")).opacity,scene:getComputedStyle(document.querySelector(".launch-arcane")).opacity})');
  assert.deepEqual(first,{background:'rgb(5, 7, 17)',logo:'1',scene:'0'});
  console.log('PASS critical-only first frame retains native-compatible logo and background');

  for(const [width,height] of [[320,568],[360,800],[390,844],[412,915],[844,390]]) {
    await viewport(width,height);await call('Page.navigate',{url:origin+'/launch-fixture'});
    await wait('document.querySelector("#app-launch")?.classList.contains("is-branded") && document.querySelector("#app-launch")?.classList.contains("has-mascot")');
    await evaluate('document.fonts.ready');await delay(120);
    const layout=await evaluate('(()=>{const scene=document.querySelector(".launch-arcane"),img=document.querySelector("[data-launch-mascot]"),hero=img.getBoundingClientRect(),title=document.querySelector(".launch-title").getBoundingClientRect(),progress=document.querySelector(".launch-progress").getBoundingClientRect();return {scroll:document.documentElement.scrollWidth,width:innerWidth,sceneBottom:scene.getBoundingClientRect().bottom,sceneScroll:scene.scrollHeight,sceneHeight:scene.clientHeight,heroTop:hero.top,heroBottom:hero.bottom,titleBottom:title.bottom,progressTop:progress.top,border:getComputedStyle(img).borderTopWidth,cards:document.querySelectorAll(".launch-card").length}})()');
    assert(layout.scroll<=width&&layout.sceneBottom<=height+1&&layout.sceneScroll<=layout.sceneHeight+1,JSON.stringify(layout));
    if(height>500)assert(layout.heroTop>layout.titleBottom&&layout.heroBottom<layout.progressTop,JSON.stringify(layout));
    assert.equal(layout.cards,11);assert.equal(layout.border,'0px');
    assert(await evaluate('document.querySelector(".launch-title").textContent.includes("YEAH BABY LES GOH!")'));
    if(width===390){await delay(350);fs.writeFileSync(path.join(output,'phone-arcane-launch.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));}
  }
  console.log('PASS real arcane launch at 320/360/390/412 px and landscape; unframed mascot and 11 cards');

  await viewport(390,844);await call('Page.navigate',{url:origin+'/launch-fixture'});await wait('!!window.FPT_LAUNCH');
  await evaluate('window.FPT_LAUNCH.hold("Sincronizzazione in corso");document.querySelector("#app").innerHTML="<main class=app-shell>Ready</main>"');await delay(180);
  assert(await evaluate('!document.querySelector("#app-launch").classList.contains("is-ready")'));
  await evaluate('window.FPT_LAUNCH.status("Caricamento reale");');assert.equal(await evaluate('document.querySelector("[data-launch-status]").textContent'),'Caricamento reale');
  await evaluate('window.FPT_LAUNCH.release()');await wait('!document.querySelector("#app-launch")');
  assert.equal(await evaluate('document.querySelector("meta[name=theme-color]").content'),'#07080d');
  console.log('PASS restored-session hold follows actual bootstrap; release restores theme and dismisses');

  await call('Page.navigate',{url:origin+'/launch-fixture?ready'});await wait('!!document.querySelector(".app-shell")');await wait('!document.querySelector("#app-launch")');
  console.log('PASS fast usable UI closes splash without a minimum display time');

  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await call('Page.navigate',{url:origin+'/launch-fixture'});await wait('!!document.querySelector(".launch-card")');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".launch-card")).animationName'),'none');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".launch-mascot")).animationName'),'none');
  await call('Emulation.setEmulatedMedia',{features:[]});
  console.log('PASS reduced motion preserves static mascot, cards and progress indicator');

  await call('Page.navigate',{url:origin+'/launch-fixture'});await wait('!!window.FPT_LAUNCH');
  await evaluate('window.FPT_LAUNCH.hold("Offline fixture");document.querySelector("#app").innerHTML=""');
  await wait('!document.querySelector("#app-launch")');
  assert.deepEqual(errors,[]);
  assert(fs.statSync('assets/loading/blattaman-arcane.webp').size<180000);
  console.log('PASS failed bootstrap escape hatch; optimized local assets; no uncaught exceptions');
} finally {
  socket?.close();chrome.kill();await new Promise(resolve=>server.close(resolve));
  const target=path.resolve(profile),parent=path.resolve(os.tmpdir());
  if(target.startsWith(parent+path.sep)&&path.basename(target).startsWith('fpt-launch-smoke-'))fs.rmSync(target,{recursive:true,force:true,maxRetries:2,retryDelay:100});
}
