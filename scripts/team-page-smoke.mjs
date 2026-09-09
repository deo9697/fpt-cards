// Browser checks for the official game logo, responsive banner and reduced-motion XP effects.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-share-smoke-')), port = 9371;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let previewServer = null;
const alreadyUp = await fetch('http://localhost:8080/index.html').then(() => true).catch(() => false);
if (!alreadyUp) {
  previewServer = spawn(process.execPath, ['scripts/preview-server.mjs'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 50; i++) { if (await fetch('http://localhost:8080/index.html').then(() => true).catch(() => false)) break; await delay(100); }
}

const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=390,844', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  const target = await waitTarget(port); socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', event => { const message = JSON.parse(event.data), task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  // Naviga a un harness minimo (solo #app + styles.css), non a index.html:
  // index.html carica app.js, che al load bootstrappa tutta l'app (sessione,
  // service worker, ecc.) e a un certo punto chiama il proprio render() nello
  // stesso #app — una corsa intermittente con l'innerHTML scritto qui sotto
  // che a volte cancella la griglia appena renderizzata (flakiness osservata
  // e diagnosticata prima di introdurre questo harness).
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/collection-share-harness.html' });
  await delay(500);
  await evaluate(`window.__consoleErrors = []; window.addEventListener('error', e => window.__consoleErrors.push(String(e.message)));`);

  await evaluate(`(async()=>{
    const {renderTeamPage,bindTeamPage,teamFilters}=await import('/js/team.js');
    document.head.insertAdjacentHTML('afterbegin','<base href="/">');
    window.__actions=[];
    window.__model={members:[{id:'daniele',name:'Daniele de Oliveira',role:'admin'},{id:'antonello',name:'Antonello Napolitano',role:'guest'},{id:'antonio',name:'Antonio Donato',role:'guest'},{id:'cristian',name:'Cristian Arlia',role:'guest'}],currentUser:'daniele',admin:true,supported:true,configured:false,openLoans:3,avatar:m=>'<span class="avatar">'+m.name.slice(0,2).toUpperCase()+'</span>',title:m=>m.role==='admin'?'Skill Issue':'Membro F.P.T · Tonno'};
    window.__renderTeam=()=>{document.querySelector('#app').innerHTML='<main style="padding:16px;max-width:1100px;margin:auto">'+renderTeamPage(__model)+'</main>';bindTeamPage(document,__model,(...args)=>__actions.push(args));};
    __renderTeam();
  })()`);
  for(const width of [390,1280]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});
    if(await evaluate('document.documentElement.scrollWidth>innerWidth'))throw Error('Horizontal overflow at '+width);
  }
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:true});
  await delay(200);
  const shot=await send('Page.captureScreenshot',{format:'png'});
  const screenshot=path.join(tmpdir(),'fpt-team-mobile.png');
  await (await import('node:fs/promises')).writeFile(screenshot,Buffer.from(shot.data,'base64'));
  console.log('Screenshot: '+screenshot);
  await evaluate(`document.querySelector('[data-team-filter="admin"]').click()`);
  if(await evaluate('document.querySelectorAll(".team-person").length')!==1)throw Error('Admin filter failed');
  await evaluate(`document.querySelector('[data-team-filter="all"]').click();const search=document.querySelector('[data-team-search]');search.focus();search.value='Antonio';search.dispatchEvent(new Event('input'));`);
  if(await evaluate('document.querySelectorAll(".team-person").length')!==1)throw Error('Search failed');
  if(!await evaluate('document.activeElement.matches("[data-team-search]")'))throw Error('Search lost focus');
  await evaluate(`document.querySelector('[data-member-action="reset-pin"]').click()`);
  if(JSON.stringify(await evaluate('__actions'))!==JSON.stringify([['reset-pin','antonio']]))throw Error('Member action misrouted');
  await evaluate(`document.querySelector('[data-team-add-toggle]').click()`);
  if(!await evaluate('!document.querySelector("#team-add-panel").hidden && document.activeElement.id==="new-member-name"'))throw Error('Add member form did not open/focus');
  await evaluate(`document.querySelector('[data-team-add-toggle]').click();__model.admin=false;__renderTeam();`);
  if(await evaluate('!!document.querySelector("[data-member-action],#member-form,[data-team-add-toggle]")'))throw Error('Admin controls exposed to non-admin');
  if((await evaluate('__consoleErrors')).length)throw Error('Browser errors');
  await evaluate(`(async()=>{
    const {api}=await import('/js/api.js'),{state,setMembers}=await import('/js/core.js');
    setMembers(__model.members);state.currentUser='daniele';state.role='admin';
    api.getCollectionShare=async()=>({items:[],ownerName:'Test',game:'yugioh'});
    api.members=async()=>__model.members;api.memberProfiles=async()=>[];
    api.manageMember=async(...args)=>{__actions.push(args);};window.confirm=()=>true;
    document.body.insertAdjacentHTML('beforeend','<div id="toast"></div>');
    history.replaceState(null,'','#/share/11111111-1111-1111-1111-111111111111');
    await import('/app.js');location.hash='#/team';
  })()`);await delay(250);
  if(!await evaluate('!!document.querySelector(".team-page")'))throw Error('Real Team route failed');
  await evaluate(`document.querySelector('[data-team-add-toggle]').click();document.querySelector('#new-member-name').value='Nuovo Test';document.querySelector('#member-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);await delay(150);
  if(!await evaluate(`__actions.some(args=>args[0]==='add'&&args[1]==='nuovo-test')`))throw Error('Existing add-member API not connected');
  console.log('PASS team mobile/desktop, search focus, filters, admin permissions, member action wiring, add form');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
