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
const apiRequests = [];
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url,'http://localhost');
  if (url.pathname === '/test-simulator-supabase.js') {res.setHeader('Content-Type',mime['.js']);res.end(authMock);return;}
  if (['/api/onepiece-duel','/api/yugioh-duel'].includes(url.pathname)) {
    let raw='';for await (const chunk of req) raw+=chunk;
    const payload=JSON.parse(raw||'{}');
    apiRequests.push({endpoint:url.pathname,op:payload.op,duelId:payload.duelId});
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
  const opFiles=['js/games/onepiece/simulator-multiplayer.js','js/games/onepiece/simulator.js','js/games/onepiece/simulator-engine.js','js/games/onepiece/simulator-storage.js','js/games/onepiece/simulator-arena.js','css/onepiece-simulator.css','css/onepiece-battlefield.css'];
  const ygoFiles=['js/games/yugioh/simulator-multiplayer.js','js/games/yugioh/simulator-engine.js','js/games/yugioh/simulator-arena.js','css/yugioh-simulator.css'];
  const simulatorFiles=[...opFiles,...ygoFiles];
  const login=async()=>{
    await waitFor('document.querySelectorAll("#member option").length===3','Login non disponibile');
    await evaluate(`(()=>{const member=document.querySelector('#member');member.value='existing-member';member.dispatchEvent(new Event('change',{bubbles:true}));const pin=document.querySelector('#pin');pin.value='1234';pin.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit();})()`);
    await waitFor('Boolean(document.querySelector(".app-shell"))','Login non completato');
  };
  const switchGame=async game=>{
    await click('.game-switcher .menu-trigger');await click('[data-game="'+game+'"]');
    await waitFor('document.body.dataset.game==='+JSON.stringify(game)+' && document.body.dataset.page==="home"','Cambio gioco non torna alla Home: '+game);
  };
  const assertMoreActive=async()=>{
    for(const nav of ['.mobile-nav','.sidebar'])assert(await evaluate('document.querySelector('+JSON.stringify(nav+' [data-page=more]')+')?.classList.contains("active")'),'Altro non attivo sul simulatore: '+nav);
  };
  const notify=async(game,duelId)=>evaluate('navigator.serviceWorker.dispatchEvent(new MessageEvent("message",{data:{type:"fpt-notification-click",url:'+JSON.stringify('/#/simulator?'+(game==='yugioh'?'game=yugioh&':'')+'duel='+duelId)+'}}))');
  const assertPrivateRoute=async()=>assert(!await evaluate('Boolean(document.querySelector(".op-simulator, .ygo-simulator, [data-op-action], [data-ygo-action]"))'),'Il login espone un tavolo privato');
  const assertEndpoint=(game,duelId)=>assert(apiRequests.some(request=>request.endpoint==='/api/'+(game==='yugioh'?'yugioh':'onepiece')+'-duel'&&request.op==='state'&&request.duelId===duelId),'Invito aperto con gioco o endpoint sbagliato: '+game);
  await call('Runtime.enable');await call('Network.enable');await call('Page.enable');
  await call('Fetch.enable',{patterns:[{urlPattern:'https://*',requestStage:'Request'}]});
  await call('Page.addScriptToEvaluateOnNewDocument',{source:"const sw = new EventTarget(); sw.register = async () => ({update:async()=>{}}); Object.defineProperty(navigator,'serviceWorker',{value:sw,configurable:true});"});
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:origin+'/#/home'});
  await waitFor('document.querySelectorAll("#member option").length===3','Login non disponibile');
  assert.deepEqual(simulatorFiles.filter(loaded),[],'Il login scarica già un simulatore');
  await login();
  await waitFor('Boolean(document.querySelector(".mm-dashboard"))','Dashboard non pronta');
  assert(!await evaluate('Boolean(document.querySelector("[data-page=simulator]"))'),'Accesso al simulatore presente fuori da Altro');
  assert.deepEqual(simulatorFiles.filter(loaded),[],'La Home scarica un simulatore');
  await click('.mobile-nav [data-page="more"]');
  await waitFor('Boolean(document.querySelector(".more-grid [data-page=simulator]"))','Altro Yu-Gi-Oh! senza simulatore');
  assert.equal(await evaluate('document.querySelectorAll("[data-page=simulator]").length'),1,'Yu-Gi-Oh!: accessi al simulatore fuori da Altro');
  assert.match(await evaluate('document.querySelector(".more-grid [data-page=simulator]").textContent'),/Yu-Gi-Oh!/,'Altro Yu-Gi-Oh! propone il simulatore sbagliato');
  assert.deepEqual(simulatorFiles.filter(loaded),[],'La pagina Altro scarica un simulatore prima del clic');
  await click('.sidebar [data-page="home"]');await waitFor('Boolean(document.querySelector(".mm-dashboard"))','Home non raggiunta');
  console.log('PASS login, Home and Altro keep both simulators lazy; Yu-Gi-Oh! advertises one private simulator only under Altro');

  // Open One Piece first: its route must never pull in the new YGO arena.
  await switchGame('onepiece');
  assert(!await evaluate('Boolean(document.querySelector(".sidebar [data-page=simulator]"))'),'Voce simulatore dedicata nella sidebar');
  assert.deepEqual(simulatorFiles.filter(loaded),[],'Il cambio gioco scarica un simulatore');
  await click('.sidebar [data-page="more"]');await waitFor('Boolean(document.querySelector(".more-grid [data-page=simulator]"))','Voce Altro One Piece assente');
  assert.match(await evaluate('document.querySelector(".more-grid [data-page=simulator]").textContent'),/One Piece/);
  assert.equal(await evaluate('document.querySelectorAll("[data-page=simulator]").length'),1,'One Piece: accessi al simulatore fuori da Altro');
  await click('.sidebar [data-page="decks"]');await waitFor('Boolean(document.querySelector(".deck-page"))','Mazzi non renderizzati');
  assert(!await evaluate('Boolean(document.querySelector("[data-page=simulator]"))'),'Accesso al simulatore nella pagina Mazzi');
  await click('.mobile-nav [data-page="more"]');await waitFor('Boolean(document.querySelector(".more-grid [data-page=simulator]"))','Voce Altro mobile assente');
  const membersBefore=await evaluate('window.__simRoutingRpc.filter(name=>name==="list_team_members").length');
  await click('.more-grid [data-page="simulator"]');await waitFor('Boolean(document.querySelector(".op-sim-empty"))','Lobby privata One Piece non pronta');
  assert.deepEqual(opFiles.filter(file=>!loaded(file)),[],'Modulo o CSS One Piece non caricato');
  assert.deepEqual(ygoFiles.filter(loaded),[],'One Piece scarica anche il simulatore Yu-Gi-Oh!');
  assert(await evaluate('Boolean(document.querySelector("link[data-onepiece-simulator]")?.sheet)'),'CSS One Piece non applicato');
  await assertMoreActive();
  assert(await evaluate('window.__simRoutingRpc.filter(name=>name==="list_team_members").length')>membersBefore,'One Piece aperto senza verifica team');
  console.log('PASS One Piece retains its Altro route, team checks and lazy arena without loading Yu-Gi-Oh!');

  await switchGame('yugioh');
  assert(!await evaluate('Boolean(document.querySelector(".op-simulator"))'),'Tavolo One Piece rimasto dopo il cambio gioco');
  await click('.mobile-nav [data-page="more"]');await waitFor('Boolean(document.querySelector(".more-grid [data-page=simulator]"))','Altro Yu-Gi-Oh! assente dopo il cambio gioco');
  const ygoMembersBefore=await evaluate('window.__simRoutingRpc.filter(name=>name==="list_team_members").length');
  await click('.more-grid [data-page="simulator"]');
  await waitFor('Boolean(document.querySelector(".ygo-simulator [data-ygo-invite]"))','Lobby privata Yu-Gi-Oh! non pronta');
  assert.deepEqual(ygoFiles.filter(file=>!loaded(file)),[],'Modulo o CSS Yu-Gi-Oh! non caricato su richiesta');
  assert(await evaluate('Boolean(document.querySelector("link[data-yugioh-simulator]")?.sheet)'),'CSS Yu-Gi-Oh! non applicato');
  assert(!await evaluate('Boolean(document.querySelector(".op-simulator"))'),'La route Yu-Gi-Oh! contiene il tavolo One Piece');
  assert(await evaluate('window.__simRoutingRpc.filter(name=>name==="list_team_members").length')>ygoMembersBefore,'Yu-Gi-Oh! aperto senza verifica team');
  await assertMoreActive();
  await evaluate("location.hash='#/home'");await waitFor('Boolean(document.querySelector(".mm-dashboard"))','Home Yu-Gi-Oh! non raggiunta');
  await evaluate("location.hash='#/simulator'");await waitFor('Boolean(document.querySelector(".ygo-simulator [data-ygo-invite]"))','Route diretta Yu-Gi-Oh! non apre il proprio simulatore');
  console.log('PASS Yu-Gi-Oh! opens its own lazy module, style and team-verified lobby through Altro and a direct route');

  const opInvite='c0000000-0000-4000-8000-000000000001';
  const ygoInvite='c0000000-0000-4000-8000-000000000002';
  await notify('onepiece',opInvite);
  await waitFor('document.body.dataset.game==="onepiece" && Boolean(document.querySelector(".op-sim-waiting"))','Push storico One Piece non cambia gioco da Yu-Gi-Oh!');
  assert(await evaluate('location.hash.includes('+JSON.stringify(opInvite)+')'),'Push One Piece perde ID');assertEndpoint('onepiece',opInvite);
  await notify('yugioh',ygoInvite);
  await waitFor('document.body.dataset.game==="yugioh" && Boolean(document.querySelector(".ygo-simulator [data-ygo-response=cancel]"))','Push Yu-Gi-Oh! non apre il proprio invito da One Piece');
  assert(await evaluate('location.hash.includes("game=yugioh") && location.hash.includes('+JSON.stringify(ygoInvite)+')'),'Push Yu-Gi-Oh! perde gioco o ID');assertEndpoint('yugioh',ygoInvite);
  await switchGame('onepiece');
  await call('Page.navigate',{url:origin+'/#/simulator?game=yugioh&duel='+ygoInvite});
  await waitFor('document.body.dataset.game==="yugioh" && Boolean(document.querySelector(".ygo-simulator [data-ygo-response=cancel]"))','Link diretto Yu-Gi-Oh! non riprende gioco e invito');
  assertEndpoint('yugioh',ygoInvite);
  await call('Page.navigate',{url:origin+'/#/simulator?duel='+opInvite});
  await waitFor('document.body.dataset.game==="onepiece" && Boolean(document.querySelector(".op-sim-waiting"))','Link storico One Piece senza game non riprende il duello');
  assertEndpoint('onepiece',opInvite);
  console.log('PASS both invitation push formats and direct links preserve their game, endpoint and private duel ID across game switches');

  // Both old and new invitations must survive arriving before sign-in.
  const pendingYgoInvite='c0000000-0000-4000-8000-000000000003';
  const pendingOpInvite='c0000000-0000-4000-8000-000000000004';
  await click('[data-logout]');await waitFor('Boolean(document.querySelector("#login-form"))','Logout non completato');
  let privateRequestsBefore=apiRequests.length;
  await notify('yugioh',pendingYgoInvite);await assertPrivateRoute();
  assert(await evaluate('location.hash.includes("game=yugioh") && location.hash.includes('+JSON.stringify(pendingYgoInvite)+')'),'Invito Yu-Gi-Oh! perso prima del login');
  assert.equal(apiRequests.length,privateRequestsBefore,'Invito Yu-Gi-Oh! ricevuto prima del login interroga già il tavolo privato');
  await login();
  await waitFor('document.body.dataset.game==="yugioh" && Boolean(document.querySelector(".ygo-simulator [data-ygo-response=cancel]"))','Login non riprende invito Yu-Gi-Oh! in attesa');
  assertEndpoint('yugioh',pendingYgoInvite);
  await click('[data-logout]');await waitFor('Boolean(document.querySelector("#login-form"))','Secondo logout non completato');
  privateRequestsBefore=apiRequests.length;
  await notify('onepiece',pendingOpInvite);await assertPrivateRoute();
  assert(await evaluate('location.hash.includes('+JSON.stringify(pendingOpInvite)+')'),'Invito storico One Piece perso prima del login');
  assert.equal(apiRequests.length,privateRequestsBefore,'Invito One Piece ricevuto prima del login interroga già il tavolo privato');
  await login();await waitFor('document.body.dataset.game==="onepiece" && Boolean(document.querySelector(".op-sim-waiting"))','Login non riprende invito storico One Piece');
  assertEndpoint('onepiece',pendingOpInvite);
  await click('[data-logout]');await waitFor('Boolean(document.querySelector("#login-form"))','Logout finale non completato');
  await evaluate("location.hash='#/simulator?game=yugioh'");await delay(200);await assertPrivateRoute();
  await evaluate("location.hash='#/simulator'");await delay(200);await assertPrivateRoute();
  console.log('PASS game switches return Home, both pending invitation formats resume after login and public routes expose neither simulator');
  assert.deepEqual(errors,[],'Eccezioni JavaScript');assert.deepEqual(consoleErrors,[],'Errori console');assert.deepEqual(networkErrors,[],'Risorse mancanti');
  console.log('onepiece-simulator-routing-smoke: OK (One Piece + Yu-Gi-Oh!)');
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  try{ws?.close();}catch{}try{browser?.kill();}catch{}await new Promise(resolve=>server.close(resolve));
});
