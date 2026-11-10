// Two independent Chrome contexts, real duel service, synthetic team and decks.
// No production account, database, push subscription or notification is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createDuelService } from '../api/_onepiece-duel-service.js';

const root = process.cwd();
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const teamId = '11111111-1111-4111-8111-111111111111';
const people = [{slug:'duel-host',name:'Marco · Anteprima'},{slug:'duel-guest',name:'Luca · Anteprima'},{slug:'duel-observer',name:'Membro esterno al tavolo'}];
const hostDeckId = 'a0000000-0000-4000-8000-000000000001';
const guestDeckId = 'b0000000-0000-4000-8000-000000000002';
const redNames = ['Usopp','Uta','Otama','Carrot','Komachiyo','Sai','Sanji','Jinbe','Tony Tony.Chopper','Nami','Nico Robin','Bartolomeo','Roronoa Zoro'];
const redCodes = [4,5,6,9,10,12,13,14,15,16,17,19,25];
const makeDeck = (ownerSlug, id, leaderCode, name, color, index) => ({
  id, ownerSlug, name, game:'onepiece', persisted:true,
  cards:[{catalogCardId:leaderCode,cardName:index ? 'Eustass.Kid' : 'Roronoa Zoro',imageUrl:`/preview/card/${leaderCode}.png`,section:'leader',quantity:1,type:'Leader',colors:[color],power:5000,life:5},
    ...Array.from({length:13},(_,cardIndex)=>{
      const code = `OP01-${String(index ? cardIndex + 33 : redCodes[cardIndex]).padStart(3,'0')}`;
      return {catalogCardId:code,cardName:index ? `Personaggio verde ${cardIndex+1}` : redNames[cardIndex],imageUrl:`/preview/card/${code}.png`,section:'main',quantity:cardIndex===12?2:4,type:'Character',colors:[color],power:3000,cost:2};
    })]
});
const decks = [makeDeck('duel-host',hostDeckId,'OP01-001','Zoro · Rosso','Red',0),makeDeck('duel-guest',guestDeckId,'ST02-001','Kid · Verde','Green',1)];
const rows = new Map(), notifications = [], requests = [];
const store = {
  members:async id=>id===teamId ? clone(people) : [],
  pushMembers:async()=>['duel-guest'],
  list:async(id,slug)=>clone([...rows.values()].filter(row=>row.team_id===id && [row.host_slug,row.guest_slug].includes(slug))),
  get:async id=>clone(rows.get(id)||null),
  meta:async id=>{const row=rows.get(id);if(!row)return null;const {state,host_deck,previous_state,...metadata}=row;return clone(metadata);},
  deck:async(id,slug)=>clone(decks.find(deck=>deck.id===id && deck.ownerSlug===slug)||null),
  recentCount:async(slug,since)=>[...rows.values()].filter(row=>row.host_slug===slug && row.created_at>=since).length,
  insert:async row=>{if(rows.has(row.id))return null;rows.set(row.id,clone(row));return clone(row);},
  update:async(id,version,patch)=>{const row=rows.get(id);if(!row||row.version!==version)return null;const next={...row,...clone(patch)};rows.set(id,next);return clone(next);}
};
const service = createDuelService({store,notify:async payload=>{notifications.push(clone(payload));return {push:'sent',delivered:1};}});
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server=http.createServer(async(request,response)=>{
  const url=new URL(request.url,'http://localhost');
  const json=(status,body)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(body));};
  if(url.pathname==='/favicon.ico'){response.writeHead(204).end();return;}
  if(url.pathname==='/__duel-fixtures'){
    const person=people.find(member=>member.slug===url.searchParams.get('member'));
    if(!person){json(404,{message:'Fixture sconosciuta'});return;}
    const own=decks.filter(deck=>deck.ownerSlug===person.slug);
    const catalog=Object.fromEntries(own.flatMap(deck=>deck.cards).map(card=>[card.catalogCardId,{cardType:card.type,cost:card.cost,power:card.power,effect:'Test manuale: risolvi l’effetto della carta al tavolo.',counter:1000}]));
    json(200,{...person,teamId,members:people,decks:own,catalog});return;
  }
  if(url.pathname==='/api/onepiece-duel' && request.method==='POST'){
    try{
      let body='';for await(const chunk of request)body+=chunk;
      const payload=JSON.parse(body),person=people.find(member=>member.slug===payload.token);
      if(!person){json(401,{message:'Sessione non valida'});return;}
      requests.push({actor:person.slug,op:payload.op,action:payload.action?.type});
      json(200,await service.run({...person,teamId},payload));
    }catch(error){json(error.status||500,{message:error.message,code:error.code,duel:error.duel});}
    return;
  }
  if(url.pathname.startsWith('/preview/card/')){
    const code=path.basename(url.pathname,'.png');
    const art=path.join(root,'artifacts','onepiece-duel','cards',`${code}.png`);
    if(fs.existsSync(art)){response.setHeader('Content-Type','image/png');response.end(fs.readFileSync(art));return;}
    // Offline fallback is explicitly a preview card, never a fabricated card image.
    response.setHeader('Content-Type','image/svg+xml');
    response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="252" height="352" viewBox="0 0 252 352"><rect width="252" height="352" fill="#151025"/><path d="M12 12H224L240 28V340H12Z" fill="none" stroke="#9b5cff" stroke-width="3"/><path d="M32 248H220" stroke="#e8b84f"/><text x="126" y="125" text-anchor="middle" fill="#e8b84f" font-family="Georgia" font-size="22">ONE PIECE</text><text x="126" y="157" text-anchor="middle" fill="#c8a8ff" font-family="monospace" font-size="15">ANTEPRIMA</text><text x="126" y="282" text-anchor="middle" fill="#f3f4f7" font-family="monospace" font-size="18">${code}</text></svg>`);return;
  }
  const file=path.resolve(root,`.${decodeURIComponent(url.pathname)}`);
  if(!file.startsWith(`${root}${path.sep}`)){response.writeHead(403).end();return;}
  try{response.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');response.setHeader('Cache-Control','no-store');response.end(fs.readFileSync(file));}
  catch{response.writeHead(404).end('Not found');}
});
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);
assert(chrome,'Chrome non trovato');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser,browserSocket;const sockets=[];
class Cdp {
  constructor(socket){this.socket=socket;this.id=0;this.pending=new Map();this.handlers=new Map();socket.onmessage=event=>{const message=JSON.parse(event.data),task=this.pending.get(message.id);if(task){this.pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(new Error(message.error.message)):task.resolve(message.result);return;}for(const handler of this.handlers.get(message.method)||[])handler(message.params);};}
  call(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout ${method}`));},15000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  on(name,fn){this.handlers.set(name,[...(this.handlers.get(name)||[]),fn]);}
}
async function connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});sockets.push(socket);return new Cdp(socket);}
async function freePort(){const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));return port;}
async function readJson(url){for(let attempt=0;attempt<100;attempt++){try{const response=await fetch(url);if(response.ok)return await response.json();}catch{}await delay(80);}throw new Error(`Chrome non disponibile: ${url}`);}

async function run(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,debugPort=await freePort();
  browser=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${path.join(os.tmpdir(),`fpt-private-duel-${Date.now()}`)}`,'about:blank'],{stdio:'ignore',windowsHide:true});
  const version=await readJson(`http://127.0.0.1:${debugPort}/json/version`);
  const controller=await connect(version.webSocketDebuggerUrl);browserSocket=controller.socket;
  const exceptions=[],consoleErrors=[],networkErrors=[],externalRequests=[];
  async function page(member){
    const context=await controller.call('Target.createBrowserContext');
    const target=await controller.call('Target.createTarget',{url:'about:blank',browserContextId:context.browserContextId});
    const targets=await readJson(`http://127.0.0.1:${debugPort}/json/list`);
    const cdp=await connect(targets.find(item=>item.id===target.targetId).webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown',event=>exceptions.push(event.exceptionDetails?.exception?.description||event.exceptionDetails?.text));
    cdp.on('Runtime.consoleAPICalled',event=>{if(event.type==='error')consoleErrors.push(event.args.map(item=>item.value||item.description||'').join(' '));});
    cdp.on('Network.requestWillBeSent',event=>{if(/^https?:/.test(event.request.url)&&!event.request.url.startsWith(origin))externalRequests.push(event.request.url);});
    cdp.on('Network.responseReceived',event=>{if(event.response.status>=400&&!event.response.url.endsWith('/api/onepiece-duel'))networkErrors.push(`${event.response.status} ${event.response.url}`);});
    await cdp.call('Runtime.enable');await cdp.call('Network.enable');await cdp.call('Page.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    const evaluate=async expression=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
    const wait=async(expression,label)=>{for(let attempt=0;attempt<200;attempt++){if(await evaluate(expression))return;await delay(80);}throw new Error(`${member}: ${label}\n${await evaluate('document.body.innerText.slice(0,2200)')}\n${JSON.stringify(exceptions)}`);};
    const click=async selector=>{assert(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),`${member}: controllo assente ${selector}`);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);};
    const fill=async(selector,value)=>evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});if(!field)throw Error('Controllo assente: '+${JSON.stringify(selector)});field.value=${JSON.stringify(String(value))};field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const submit=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
    const screenshot=async(name,full=true)=>{if(!process.argv.includes('--screenshots'))return;await evaluate('document.fonts.ready');const params={format:'png',captureBeyondViewport:full};if(full){const layout=await cdp.call('Page.getLayoutMetrics'),size=layout.cssContentSize||layout.contentSize;params.clip={x:0,y:0,width:size.width,height:Math.min(size.height,8000),scale:1};}const shot=await cdp.call('Page.captureScreenshot',params);const directory=path.join(root,'artifacts','onepiece-duel');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`${name}.png`),Buffer.from(shot.data,'base64'));};
    await cdp.call('Page.navigate',{url:`${origin}/scripts/fixtures/onepiece-duel-harness.html?member=${member}`});
    return {member,cdp,evaluate,wait,click,fill,submit,screenshot};
  }
  const host=await page('duel-host'),guest=await page('duel-guest');
  await host.wait('window.__fixtureReady && document.querySelector("[data-op-invite]")','Preparazione invito assente');
  await guest.wait('window.__fixtureReady && document.querySelector("[data-op-invite]")','Lobby avversario assente');
  assert(await host.evaluate('window.__sim.lobby.members.find(member=>member.slug==="duel-guest").pushEnabled'),'Stato notifiche del membro assente');
  assert(await host.evaluate('document.querySelector(".sidebar [data-page=more]").classList.contains("active")'),'Shell FPT non mostra Altro attivo');
  await host.fill('[data-op-invite] [name=opponentSlug]','duel-guest');
  await host.fill('[data-op-invite] [name=deckId]',hostDeckId);
  await host.fill('[data-op-invite] [name=lifeCount]',5);
  await host.fill('[data-op-invite] [name=firstPlayer]',0);
  await host.screenshot('setup-desktop');
  await host.submit('[data-op-invite]');
  await host.wait('window.__sim.duel?.status==="waiting"','Invito non creato');
  const duelId=await host.evaluate('window.__sim.duel.id');
  assert.equal(notifications.length,1);assert.equal(notifications[0].recipient,'duel-guest');
  assert(!JSON.stringify(notifications).includes('cards'),'La notifica contiene le liste');
  await guest.wait(`Boolean(document.querySelector('[data-op-open="${duelId}"]'))`,'Invito non arrivato nella lobby avversario');
  await guest.click(`[data-op-open="${duelId}"]`);
  await guest.wait('Boolean(document.querySelector("[data-op-accept]"))','Invito senza accettazione');
  assert(await guest.evaluate(`Array.from(document.querySelectorAll('[data-op-accept] [name=deckId] option')).every(option=>!option.value || option.value===${JSON.stringify(guestDeckId)})`),'Accettazione mostra mazzi altrui');
  await guest.fill('[data-op-accept] [name=deckId]',guestDeckId);
  await guest.fill('[data-op-accept] [name=lifeCount]',5);
  await guest.submit('[data-op-accept]');
  await guest.wait('window.__sim.duel?.status==="setup" && window.__sim.session','Accettazione non completata');
  await host.wait('window.__sim.duel?.status==="setup" && window.__sim.session','L’host non riceve l’accettazione');
  console.log('PASS team invitation, private inbox, opted-in notification and opponent-owned deck choice');
  for(const [page,viewer]of [[host,0],[guest,1]]){
    assert.equal(await page.evaluate('window.__sim.duel.viewer'),viewer);
    assert(await page.evaluate(`window.__sim.session.players[${1-viewer}].hand.every(card=>card.hidden && !card.catalogCardId && !card.imageUrl)`),'Mano avversaria non oscurata');
    assert(await page.evaluate('window.__sim.session.players.every(player=>player.deck.every(card=>card.hidden && !card.catalogCardId))'),'Ordine mazzo presente nella risposta');
    assert(await page.evaluate(`Array.from(document.querySelectorAll('[data-op-action][data-player="${1-viewer}"]')).every(button=>button.disabled)`),'Controlli avversario non bloccati');
  }
  await host.click('[data-op-action="ready"]');
  await guest.wait('window.__sim.duel.ready[0]','Pronto host non sincronizzato');
  await guest.click('[data-op-action="ready"]');
  await host.wait('window.__sim.duel.status==="playing"','Duello non avviato su host');
  await guest.wait('window.__sim.duel.status==="playing"','Duello non avviato su ospite');
  assert.equal(rows.get(duelId).state.players[0].life.length,5);assert.equal(rows.get(duelId).state.players[1].life.length,5);
  console.log('PASS two-device readiness, private hands/Life/decks and blocked opponent controls');
  const beforeDraw=await host.evaluate('window.__sim.session.players[0].hand.length');
  await host.click('[data-op-action="draw"][data-player="0"]');
  await host.wait(`window.__sim.session.players[0].hand.length===${beforeDraw+1}`,'Pesca host non applicata');
  await guest.wait(`window.__sim.session.players[0].hand.length===${beforeDraw+1}`,'Pesca host non sincronizzata');
  async function playFirstCard(page,viewer){
    const card=await page.evaluate(`window.__sim.session.players[${viewer}].hand[0].id`);
    const selector=`[data-op-card="${card}"][data-player="${viewer}"]`;
    if(!await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))await page.click(`[data-op-hand="${viewer}"]`);
    await page.click(selector);await page.wait('Boolean(document.querySelector("[data-op-move]"))','Inspector carta assente');
    await page.fill('[data-op-move] [name=to]','characters');await page.submit('[data-op-move]');
    await page.wait(`window.__sim.session.players[${viewer}].characters.some(card=>card.id===${JSON.stringify(card)})`,'Personaggio non giocato');return card;
  }
  await playFirstCard(host,0);
  await guest.wait('window.__sim.session.players[0].characters.length===1','Personaggio host non pubblico');
  await playFirstCard(guest,1);
  await host.wait('window.__sim.session.players[1].characters.length===1','Personaggio ospite non pubblico');
  await host.click('[data-op-action="addDon2"][data-player="0"]');
  await host.wait('window.__sim.session.players[0].don.active===2','DON host non aggiunti');
  await guest.wait('window.__sim.session.players[0].don.active===2','DON host non sincronizzati');
  assert(await host.evaluate('window.__sim.session.players[1].hand.every(card=>card.hidden && !card.catalogCardId)'),'Il movimento pubblico rivela il resto della mano');
  console.log('PASS manual draw, public character movements and DON synchronize across isolated browser contexts');
  const beforeConflict=await host.evaluate('window.__sim.session.players[0].hand.length');
  await host.evaluate('window.__sim.duel.version-=1;document.querySelector("[data-op-action=draw][data-player=\\"0\\"]").click()');
  await host.wait('Boolean(window.__sim.error) && !window.__sim.pending','Conflitto UI senza errore visibile');
  assert((await host.evaluate('window.__sim.error')).includes('aggiornato'),'Il conflitto non spiega che il tavolo è cambiato');
  assert.equal(await host.evaluate('window.__sim.session.players[0].hand.length'),beforeConflict,'La richiesta in conflitto ha pescato una carta');
  assert.equal(await host.evaluate('window.__sim.duel.version'),rows.get(duelId).version,'Il conflitto UI non adotta lo stato aggiornato');
  await host.click('[data-op-action="draw"][data-player="0"]');
  await host.wait(`window.__sim.session.players[0].hand.length===${beforeConflict+1} && !window.__sim.pending`,'Nuovo tentativo dopo conflitto non riuscito');
  await guest.wait(`window.__sim.session.players[0].hand.length===${beforeConflict+1}`,'Riprova dopo conflitto non sincronizzata');
  console.log('PASS visible concurrent-action conflict, unchanged hand and successful manual retry');
  const state=rows.get(duelId);
  const staleResponse=await fetch(`${origin}/api/onepiece-duel`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'duel-host',op:'action',duelId,expectedVersion:state.version-1,requestId:crypto.randomUUID(),action:{type:'draw',player:0}})});
  assert.equal(staleResponse.status,409);const stale=await staleResponse.json();assert(stale.duel.state.players[1].hand.every(card=>card.hidden));
  const forbidden=await fetch(`${origin}/api/onepiece-duel`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'duel-host',op:'inspect',duelId,player:1,zone:'deck'})});
  assert.equal(forbidden.status,403,'Ispezione mazzo avversario consentita');
  const outsider=await fetch(`${origin}/api/onepiece-duel`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'duel-observer',op:'state',duelId})});
  assert.equal(outsider.status,404,'Un terzo membro può leggere il tavolo');
  console.log('PASS stale-version conflicts and API boundaries preserve hidden information and participant privacy');
  await host.cdp.call('Page.navigate',{url:`${origin}/scripts/fixtures/onepiece-duel-harness.html?member=duel-host&duel=${duelId}`});
  await host.wait(`window.__sim?.duel?.id===${JSON.stringify(duelId)} && window.__sim.session?.players[0].characters.length===1`,'Ripresa sessione remota non riuscita');
  assert(await host.evaluate('window.__sim.session.players[1].hand.every(card=>card.hidden)'),'Refresh rivela mano avversaria');
  await host.screenshot('game-desktop');await host.screenshot('game-viewport',false);
  await host.click('[data-op-side="0"]');
  await host.screenshot('game-own-desktop');
  await host.cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await host.cdp.call('Page.navigate',{url:`${origin}/scripts/fixtures/onepiece-duel-harness.html?member=duel-host&duel=${duelId}`});
  await host.wait('window.__sim?.session && window.__sim.playerFocus==="0"','Il telefono non apre il proprio campo');
  assert.equal(await host.evaluate('document.querySelectorAll(".op-sim-player").length'),1,'Mobile mostra due campi completi insieme');
  assert(await host.evaluate('Boolean(document.querySelector(".op-sim-opponent-strip"))'),'Riepilogo avversario assente');
  await delay(100);
  assert(await host.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Overflow orizzontale mobile');
  await host.screenshot('game-mobile');
  await host.screenshot('game-mobile-viewport',false);
  const mobileCard=await host.evaluate('window.__sim.session.players[0].hand[0].id');
  await host.click(`[data-op-card="${mobileCard}"][data-player="0"]`);
  await host.wait('Boolean(document.querySelector(".op-sim-inspector.has-selection"))','Azioni touch non aperte');
  assert.equal(await host.evaluate('getComputedStyle(document.querySelector(".op-sim-inspector.has-selection")).position'),'fixed','Inspector mobile non è un pannello fisso');
  await host.screenshot('game-mobile-card',false);
  await host.click('.op-sim-inspector-close');
  assert(!await host.evaluate('Boolean(document.querySelector(".op-sim-inspector.has-selection"))'),'Il pannello carta non si chiude');
  console.log('PASS smartphone-first own field, opponent summary, horizontal hand and touch card sheet');
  assert.deepEqual(exceptions,[],'Eccezioni JavaScript');assert.deepEqual(consoleErrors,[],'Errori console');assert.deepEqual(networkErrors,[],'Risorse mancanti');assert.deepEqual(externalRequests,[],'Richieste esterne inattese');
  assert(requests.some(request=>request.actor==='duel-host'&&request.op==='action')&&requests.some(request=>request.actor==='duel-guest'&&request.op==='action'));
  console.log('PASS remote session refresh, FPT shell, desktop/mobile rendering and zero external requests');
  console.log('onepiece-duel-browser-smoke: OK');
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{for(const socket of sockets){try{socket.close();}catch{}}try{browser?.kill();}catch{}await new Promise(resolve=>server.close(resolve));});
