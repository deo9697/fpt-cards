// Real index.html/app.js routing, synthetic authenticated team and intercepted external requests.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';

const root = process.cwd();
const authSource = fs.readFileSync(path.join(root,'scripts','auth-regression-smoke.mjs'),'utf8');
const block = authSource.slice(authSource.indexOf('const members = ['),authSource.indexOf('\nconst mime = {'));
const authMock = new Function(`${block}\nreturn fakeSupabaseSource;`)()
  .replace('async rpc(name,args={}){', 'async rpc(name,args={}){window.__simRoutingRpc ||= [];window.__simRoutingRpc.push(name);if(name==="list_collection_share_requests")return {data:[],error:null};')
  .replace("if(name==='get_my_team') return {data:null,error:null};", "if(name==='get_my_team') return {data:{id:'simulator-routing-team',name:'Simulator Routing Team',kind:'core'},error:null};");
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg',
  '.svg':'image/svg+xml','.woff2':'font/woff2','.webmanifest':'application/manifest+json'};
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url,'http://localhost');
  if (url.pathname === '/test-simulator-supabase.js') {res.setHeader('Content-Type',mime['.js']);res.end(authMock);return;}
  if (url.pathname === '/api/onepiece-duel') {
    let raw='';for await (const chunk of req) raw+=chunk;
    const payload=JSON.parse(raw||'{}');
    const value=payload.op==='state'
      ? {duel:{id:payload.duelId,status:'waiting',version:1,viewer:0,hostSlug:'existing-member',guestSlug:'synthetic-guest',hostName:'Existing Member',guestName:'Invited Teammate',ready:[false,false],state:null}}
      : {members:[{slug:'existing-member',name:'Existing Member',pushEnabled:false}],duels:[],serverTime:'2026-11-10T12:00:00Z'};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return;
  }
  if (url.pathname === '/favicon.ico') {res.writeHead(204).end();return;}
  const file = path.resolve(root,url.pathname === '/' ? 'index.html' : `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${root}${path.sep}`)) {res.writeHead(403).end();return;}
  try {
    let data = fs.readFileSync(file);
    if (file.endsWith(`${path.sep}index.html`)) data = data.toString('utf8').replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2','/test-simulator-supabase.js');
    res.setHeader('Content-Type',mime[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control','no-store');res.end(data);
  } catch {res.writeHead(404).end('Not found');}
});
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);
assert(chrome,'Chrome non trovato');
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
let browser,ws;

async function run() {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const probe = net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const debugPort = probe.address().port;await new Promise(resolve=>probe.close(resolve));
  browser = spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
    `--remote-debugging-port=${debugPort}`,`--user-data-dir=${path.join(os.tmpdir(),`fpt-sim-routing-${Date.now()}`)}`,'about:blank'],{stdio:'ignore',windowsHide:true});
  let tab;
  for (let attempt=0;attempt<100&&!tab;attempt++) {
    try {tab=await(await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`,{method:'PUT'})).json();}catch {await delay(100);}
  }
  assert(tab,'Chrome CDP non disponibile');
  ws = new WebSocket(tab.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  let nextId=0;const pending=new Map(),requested=[],errors=[],consoleErrors=[],networkErrors=[];
  const call=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`));},15000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
  });
  ws.onmessage=event=>{
    const message=JSON.parse(event.data),task=pending.get(message.id);
    if(task){pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(new Error(message.error.message)):task.resolve(message.result);return;}
    if(message.method==='Network.requestWillBeSent') requested.push(message.params.request.url);
    if(message.method==='Network.responseReceived'&&message.params.response.status>=400)networkErrors.push(`${message.params.response.status} ${message.params.response.url}`);
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails?.exception?.description||message.params.exceptionDetails?.text);
    if(message.method==='Runtime.consoleAPICalled'&&message.params.type==='error')consoleErrors.push(message.params.args.map(arg=>arg.value||arg.description||'').join(' '));
    if(message.method==='Fetch.requestPaused') {
      const event=message.params;
      const image=/\.(?:png|jpe?g|webp)(?:\?|$)/i.test(event.request.url);
      const body=image?fs.readFileSync(path.join(root,'icon-192.png')).toString('base64'):Buffer.from(JSON.stringify({data:[]})).toString('base64');
      void call('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:image?'image/png':'application/json'}],body}).catch(error=>errors.push(error.message));
    }
  };
  const evaluate=async expression=>{
    const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor=async(expression,message)=>{
    for(let attempt=0;attempt<120;attempt++){if(await evaluate(expression))return;await delay(75);}
    throw new Error(`${message}\n${JSON.stringify(await evaluate('({hash:location.hash,page:document.body.dataset.page,body:document.body.innerText.slice(0,1800)})'))}\n${JSON.stringify(errors)}`);
  };
  const click=async selector=>{
    assert(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),`Controllo mancante: ${selector}`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const loaded=file=>requested.some(url=>url.split('?')[0]===`${origin}/${file}`);
  const simulatorFiles=['js/games/onepiece/simulator-multiplayer.js','js/games/onepiece/simulator.js','js/games/onepiece/simulator-engine.js','js/games/onepiece/simulator-storage.js','css/onepiece-simulator.css'];
  await call('Runtime.enable');await call('Network.enable');await call('Page.enable');
  await call('Fetch.enable',{patterns:[{urlPattern:'https://*',requestStage:'Request'}]});
  await call('Page.addScriptToEvaluateOnNewDocument',{source:"const sw = new EventTarget(); sw.register = async () => ({update:async()=>{}}); Object.defineProperty(navigator,'serviceWorker',{value:sw,configurable:true});"});
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:`${origin}/#/home`});
  await waitFor('document.querySelectorAll("#member option").length===3','Login non disponibile');
  assert.deepEqual(simulatorFiles.filter(loaded),[],'Il login scarica già il simulatore');
  await evaluate(`(()=>{const member=document.querySelector('#member');member.value='existing-member';member.dispatchEvent(new Event('change',{bubbles:true}));const pin=document.querySelector('#pin');pin.value='1234';pin.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit();})()`);
  await waitFor('Boolean(document.querySelector(".app-shell"))','Login non completato');
  await waitFor('Boolean(document.querySelector(".mm-dashboard"))','Dashboard non pronta');
  assert(!await evaluate('Boolean(document.querySelector("[data-page=simulator]"))'),'Simulatore visibile nella sezione Yu-Gi-Oh!');
  assert.deepEqual(simulatorFiles.filter(loaded),[],'Yu-Gi-Oh! scarica il simulatore');
  await click('.mobile-nav [data-page="more"]');
  await waitFor('Boolean(document.querySelector(".more-grid"))','Pagina Altro Yu-Gi-Oh! assente');
  assert(!await evaluate('Boolean(document.querySelector(".more-grid [data-page=simulator]"))'),'Altro Yu-Gi-Oh! mostra il simulatore');
  await click('.sidebar [data-page="home"]');
  await waitFor('Boolean(document.querySelector(".mm-dashboard"))','Home Yu-Gi-Oh! non raggiunta');
  console.log('PASS login and Yu-Gi-Oh! do not load or advertise the simulator');

  await evaluate("location.hash='#/simulator'");
  await waitFor('document.body.dataset.page==="simulator"','Route diretta non gestita');
  assert(!await evaluate('Boolean(document.querySelector(".op-simulator"))'),'Route Yu-Gi-Oh! espone il tavolo');
  assert((await evaluate('document.body.innerText')).includes('disponibile ai membri del team'),'Blocco di accesso non spiegato');
  assert.deepEqual(simulatorFiles.filter(loaded),[],'Route diretta Yu-Gi-Oh! scarica il simulatore');
  await evaluate("location.hash='#/home'");await waitFor('Boolean(document.querySelector(".mm-dashboard"))','Home non raggiunta');
  console.log('PASS direct simulator route in Yu-Gi-Oh! remains locked');

  await click('.game-switcher .menu-trigger');await click('[data-game="onepiece"]');
  await waitFor('document.body.dataset.game==="onepiece" && document.querySelector(".sidebar [data-page=more]")','Navigazione Altro desktop One Piece assente');
  assert(!await evaluate('Boolean(document.querySelector(".sidebar [data-page=simulator]"))'),'Voce dedicata simulatore rimasta nella sidebar');
  assert.deepEqual(simulatorFiles.filter(loaded),[],'Il solo cambio gioco scarica il simulatore');
  await click('.sidebar [data-page="more"]');
  await waitFor('Boolean(document.querySelector(".more-grid [data-page=simulator]"))','Voce Altro assente');
  assert.equal(await evaluate('document.querySelectorAll("[data-page=simulator]").length'),1,'Accessi al simulatore presenti fuori da Altro');
  await click('.sidebar [data-page="decks"]');
  await waitFor('Boolean(document.querySelector(".deck-page"))','Mazzi non renderizzati');
  assert(!await evaluate('Boolean(document.querySelector("[data-page=simulator]"))'),'Accesso al simulatore rimasto nella pagina Mazzi');
  await click('.mobile-nav [data-page="more"]');
  await waitFor('Boolean(document.querySelector(".more-grid [data-page=simulator]"))','Voce Altro mobile assente');
  const membersBefore=await evaluate('window.__simRoutingRpc.filter(name=>name==="list_team_members").length');
  await click('.more-grid [data-page="simulator"]');
  await waitFor('Boolean(document.querySelector(".op-sim-empty"))','Simulatore privato vuoto non pronto');
  assert.deepEqual(simulatorFiles.filter(file=>!loaded(file)),[],'Modulo o CSS non caricato su richiesta');
  assert(await evaluate('Boolean(document.querySelector("link[data-onepiece-simulator]")?.sheet)'),'Stile del simulatore non applicato');
  assert(await evaluate('document.querySelector(".mobile-nav [data-page=more]")?.classList.contains("active")'),'Altro non attivo sul simulatore');
  assert(await evaluate('document.querySelector(".sidebar [data-page=more]")?.classList.contains("active")'),'Altro desktop non attivo sul simulatore');
  const membersAfter=await evaluate('window.__simRoutingRpc.filter(name=>name==="list_team_members").length');
  assert(membersAfter>membersBefore,'Apertura tavolo senza verifica dei membri del team');
  console.log('PASS simulator only under One Piece Altro; no sidebar/decks shortcut; lazy module/CSS and team verification');

  await click('.game-switcher .menu-trigger');await click('[data-game="yugioh"]');
  await waitFor('document.body.dataset.game==="yugioh" && document.body.dataset.page==="home"','Cambio Yu-Gi-Oh! non esce dal simulatore');
  assert(!await evaluate('Boolean(document.querySelector("[data-page=simulator]"))'),'Link simulatore rimasto in Yu-Gi-Oh!');
  assert(!await evaluate('Boolean(document.querySelector(".op-simulator"))'),'Tavolo rimasto in Yu-Gi-Oh!');
  await click('.mobile-nav [data-page="more"]');
  await waitFor('Boolean(document.querySelector(".more-grid"))','Pagina Altro dopo cambio gioco assente');
  assert(!await evaluate('Boolean(document.querySelector(".more-grid [data-page=simulator]"))'),'Voce simulatore rimasta in Altro Yu-Gi-Oh! dopo il cambio gioco');
  const inviteId='c0000000-0000-4000-8000-000000000001';
  await evaluate(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:'fpt-notification-click',url:'/#/simulator?duel=${inviteId}'}}))`);
  await waitFor('document.body.dataset.game==="onepiece" && Boolean(document.querySelector(".op-sim-waiting"))','Push non apre la partita One Piece da Yu-Gi-Oh!');
  assert(await evaluate(`location.hash.includes(${JSON.stringify(inviteId)})`),'Identificativo partita perso dalla notifica');
  await click('.game-switcher .menu-trigger');await click('[data-game="yugioh"]');
  await call('Page.navigate',{url:`${origin}/#/simulator?duel=${inviteId}`});
  await waitFor('document.body.dataset.game==="onepiece" && Boolean(document.querySelector(".op-sim-waiting"))','Apertura diretta invito non riprende One Piece');
  console.log('PASS invitation push and direct links preserve the selected private duel');
  await click('[data-logout]');await waitFor('Boolean(document.querySelector("#login-form"))','Logout non completato');
  await evaluate(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:'fpt-notification-click',url:'/#/simulator?duel=${inviteId}'}}))`);
  assert(await evaluate(`location.hash.includes(${JSON.stringify(inviteId)})`),'Notifica ricevuta prima del login persa');
  assert(!await evaluate('Boolean(document.querySelector(".op-simulator, [data-op-setup], [data-op-action]"))'),'Invito prima del login espone un tavolo');
  await evaluate("location.hash='#/simulator'");await delay(200);
  assert(!await evaluate('Boolean(document.querySelector(".op-simulator, [data-op-setup], [data-op-action]"))'),'Route pubblica espone il tavolo');
  console.log('PASS game switch returns home and logout blocks the private route');
  assert.deepEqual(errors,[],'Eccezioni JavaScript');assert.deepEqual(consoleErrors,[],'Errori console');assert.deepEqual(networkErrors,[],'Risorse mancanti');
  console.log('onepiece-simulator-routing-smoke: OK');
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  try{ws?.close();}catch{}try{browser?.kill();}catch{}await new Promise(resolve=>server.close(resolve));
});
