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
let browser,browserSocket,browserProfile;const sockets=[];
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
  browserProfile=path.resolve(os.tmpdir(),`fpt-private-duel-${Date.now()}-${process.pid}`);
  browser=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${browserProfile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
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
    const screenshot=async(name,full=true)=>{if(!process.argv.includes('--screenshots'))return;await evaluate('document.fonts.ready');await evaluate('Promise.all(Array.from(document.images,image=>image.complete?Promise.resolve():new Promise(resolve=>{image.onload=resolve;image.onerror=resolve})))');const params={format:'png',captureBeyondViewport:full};if(full){const layout=await cdp.call('Page.getLayoutMetrics'),size=layout.cssContentSize||layout.contentSize;params.clip={x:0,y:0,width:size.width,height:Math.min(size.height,8000),scale:1};}const shot=await cdp.call('Page.captureScreenshot',params);const directory=path.join(root,'artifacts','onepiece-duel');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`${name}.png`),Buffer.from(shot.data,'base64'));};
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
  // Lobby controls: quick Life buttons and "who starts" toggle update the draft and the form.
  await host.click('[data-op-invite] [data-op-life-pick="6"]');
  await host.wait('window.__sim.inviteDraft.lifeCount===6 && document.querySelector("[data-op-invite] [name=lifeCount]").value==="6" && document.querySelector("[data-op-life-pick=\\"6\\"]").classList.contains("is-on")','Scelta rapida Life 6 non applicata');
  await host.click('[data-op-invite] [data-op-life-pick="4"]');
  await host.wait('window.__sim.inviteDraft.lifeCount===4','Scelta rapida Life 4 non applicata');
  await host.click('[data-op-invite] [data-op-life-pick="5"]');
  await host.wait('window.__sim.inviteDraft.lifeCount===5 && document.querySelector("[data-op-invite] [name=lifeCount]").value==="5"','Scelta rapida Life 5 non applicata');
  await host.click('[data-op-invite] input[name=firstPlayer][value="1"]');
  await host.wait('window.__sim.inviteDraft.firstPlayer==="1" && new FormData(document.querySelector("[data-op-invite]")).get("firstPlayer")==="1"','Chi inizia: compagno non selezionato');
  await host.click('[data-op-invite] input[name=firstPlayer][value="0"]');
  await host.wait('window.__sim.inviteDraft.firstPlayer==="0" && new FormData(document.querySelector("[data-op-invite]")).get("firstPlayer")==="0"','Chi inizia: tu non selezionato');
  assert(await host.evaluate('Boolean(document.querySelector(".op-versus .op-vs-card.is-self .op-vs-deck img")) && /Mazzo valido/.test(document.querySelector(".op-vs-card.is-self").textContent)'),'Riepilogo mazzo assente nella sfida');
  assert(await host.evaluate('/Mazzo a sorpresa/.test(document.querySelector(".op-vs-card.is-opponent").textContent)'),'Riepilogo avversario assente');
  console.log('PASS lobby controls: quick Life picks, first-player toggle and versus summaries');
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
  assert(await guest.evaluate('/ti sfida/.test(document.querySelector(".op-sim-waiting h2").textContent)'),'Schermata sfida ricevuta assente');
  await guest.click('[data-op-accept] [data-op-life-pick="6"]');
  await guest.wait('window.__sim.acceptDraft.lifeCount===6 && document.querySelector("[data-op-accept] [name=lifeCount]").value==="6"','Scelta rapida Life in accettazione non applicata');
  await guest.click('[data-op-accept] [data-op-life-pick="5"]');
  await guest.wait('window.__sim.acceptDraft.lifeCount===5','Life 5 in accettazione non ripristinata');
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
  const handBeforeMulligan=await host.evaluate('window.__sim.session.players[0].hand.length');
  await host.click('[data-op-action="mulligan"][data-player="0"]');
  await host.wait('window.__sim.session.players[0].mulliganUsed','Mulligan non applicato');
  assert.equal(await host.evaluate('window.__sim.session.players[0].hand.length'),handBeforeMulligan,'Il mulligan cambia il numero di carte in mano');
  assert(await host.evaluate('document.querySelector("[data-op-action=mulligan][data-player=\\"0\\"]").disabled'),'Mulligan ancora disponibile dopo l’uso');
  await host.click('[data-op-action="ready"]');
  await guest.wait('window.__sim.duel.ready[0]','Pronto host non sincronizzato');
  await guest.click('[data-op-action="ready"]');
  await host.wait('window.__sim.duel.status==="playing"','Duello non avviato su host');
  await guest.wait('window.__sim.duel.status==="playing"','Duello non avviato su ospite');
  assert.equal(rows.get(duelId).state.players[0].life.length,5);assert.equal(rows.get(duelId).state.players[1].life.length,5);
  console.log('PASS two-device readiness, private hands/Life/decks and blocked opponent controls');
  async function closeCard(page){
    if(await page.evaluate('Boolean(document.querySelector(".op-sim-inspector.has-selection"))'))await page.click('.op-sim-inspector.has-selection [data-op-command="deselect"]');
  }
  async function clickAction(page,type,player){
    const selector=`[data-op-action="${type}"]${player==null?'':`[data-player="${player}"]`}`;
    if(!await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))await page.click('[data-op-command="battle-tools"]');
    await page.click(selector);
  }
  async function closeTools(page){
    if(await page.evaluate('Boolean(document.querySelector("[data-op-command=battle-tools-close]"))'))await page.click('[data-op-command="battle-tools-close"]');
  }
  async function assertArena(page,viewer,label){
    await page.wait('Boolean(document.querySelector(".op-battlefield"))',`${label}: campo da battaglia assente`);
    assert.equal(await page.evaluate('document.querySelectorAll(".op-battle-side.is-opponent").length'),1,`${label}: campo avversario assente`);
    assert.equal(await page.evaluate('document.querySelectorAll(".op-battle-side.is-self").length'),1,`${label}: campo personale assente`);
    for(const player of [0,1]){
      const slots=await page.evaluate(`Array.from(document.querySelectorAll('.op-battle-slot[data-zone="characters"][data-player="${player}"]'),slot=>Number(slot.dataset.slot)).sort()`);
      assert.deepEqual(slots,[0,1,2,3,4],`${label}: servono cinque posizioni fisse per lato`);
    }
    assert(await page.evaluate(`Boolean(document.querySelector('.op-battle-hand[data-player="${viewer}"] [data-op-card]'))`),`${label}: mano personale non disponibile`);
    assert(await page.evaluate(`!document.querySelector('.op-battle-hand[data-player="${1-viewer}"] [data-op-card]')`),`${label}: mano avversaria interattiva`);
    assert(await page.evaluate('Array.from(document.querySelectorAll(".op-battle-side"),side=>getComputedStyle(side).display!=="none"&&side.getBoundingClientRect().height>0).every(Boolean)'),`${label}: un lato è nascosto`);
    assert(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),`${label}: overflow orizzontale della pagina`);
    // Every enabled button that is on screen must receive a real tap at the centre of its visible part
    // (cards scrolled half out of the hand strip are measured on the part still inside the strip).
    const covered=await page.evaluate(`Array.from(document.querySelectorAll('.op-battlefield button:not([disabled])')).filter(button=>{let box=button.getBoundingClientRect(),left=Math.max(box.left,0),right=Math.min(box.right,innerWidth),top=Math.max(box.top,0),bottom=Math.min(box.bottom,innerHeight);for(let node=button.parentElement;node;node=node.parentElement){const style=getComputedStyle(node);if(style.overflowX!=='visible'||style.overflowY!=='visible'){const clip=node.getBoundingClientRect();left=Math.max(left,clip.left);right=Math.min(right,clip.right);top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);}}if(right-left<12||bottom-top<12)return false;const hit=document.elementFromPoint((left+right)/2,(top+bottom)/2);button.__hit=hit;return !(hit&&(hit===button||button.contains(hit)));}).map(button=>button.outerHTML.slice(0,90)+' coperto da '+(button.__hit?.outerHTML.slice(0,120)||'nulla'))`);
    assert.deepEqual(covered,[],`${label}: pulsanti coperti da altri elementi`);
    assert(await page.evaluate('Array.from(document.querySelectorAll(".op-battlefield img"),image=>image.complete&&image.naturalWidth>0).every(Boolean)'),`${label}: immagine del campo non caricata`);
  }
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
  const firstHostCard=await playFirstCard(host,0);
  await guest.wait('window.__sim.session.players[0].characters.length===1','Personaggio host non pubblico');
  assert.equal(await host.evaluate(`window.__sim.session.players[0].characters.find(card=>card.id===${JSON.stringify(firstHostCard)}).slot`),0,'Il primo personaggio non occupa il primo slot disponibile');
  const placedHostCard=await host.evaluate('window.__sim.session.players[0].hand[0].id');
  await host.click(`[data-op-card="${placedHostCard}"][data-player="0"]`);
  await host.wait('Boolean(document.querySelector("[data-op-command=battle-place]"))','Comando di piazzamento sul campo assente');
  await host.click('[data-op-command="battle-place"]');
  assert(!await host.evaluate('Boolean(document.querySelector(".op-sim-inspector.has-selection"))'),'Il pannello carta nasconde il campo durante il piazzamento');
  assert(await host.evaluate(`Boolean(document.querySelector('[data-op-slot="4"][data-player="0"].is-legal-target'))`),'Lo slot libero non viene indicato come destinazione');
  await host.click('[data-op-slot="4"][data-player="0"]');
  await host.wait(`window.__sim.session.players[0].characters.some(card=>card.id===${JSON.stringify(placedHostCard)}&&card.slot===4)`,'Piazzamento diretto nello slot 4 non applicato');
  await guest.wait(`window.__sim.session.players[0].characters.some(card=>card.id===${JSON.stringify(placedHostCard)}&&card.slot===4)`,'Piazzamento nello slot 4 non sincronizzato');
  await host.click(`[data-op-card="${firstHostCard}"][data-player="0"]`);
  await host.fill('[data-op-move] [name=to]','trash');await host.submit('[data-op-move]');
  await host.wait(`window.__sim.session.players[0].trash.some(card=>card.id===${JSON.stringify(firstHostCard)})`,'KO manuale non sposta il personaggio nel Trash');
  await guest.wait('window.__sim.session.players[0].characters.length===1','KO non sincronizzato');
  for(const page of [host,guest]){
    assert.equal(await page.evaluate(`window.__sim.session.players[0].characters.find(card=>card.id===${JSON.stringify(placedHostCard)}).slot`),4,'Il KO ha compattato le posizioni del campo');
    assert(await page.evaluate(`Boolean(document.querySelector('.op-battle-slot[data-zone="characters"][data-slot="4"][data-player="0"] [data-op-card="${placedHostCard}"]'))`),'Il personaggio non è renderizzato nello slot stabile');
    assert(!await page.evaluate('Boolean(document.querySelector(\'.op-battle-slot[data-zone="characters"][data-slot="0"][data-player="0"] [data-op-card]\'))'),'La posizione del personaggio in Trash non è vuota');
  }
  await closeCard(host);
  await playFirstCard(guest,1);
  await host.wait('window.__sim.session.players[1].characters.length===1','Personaggio ospite non pubblico');
  await closeCard(guest);
  await clickAction(host,'addDon2',0);
  await host.wait('window.__sim.session.players[0].don.active===2','DON host non aggiunti');
  await guest.wait('window.__sim.session.players[0].don.active===2','DON host non sincronizzati');
  await closeTools(host);
  await host.click(`[data-op-card="${placedHostCard}"][data-player="0"]`);
  await host.click('[data-op-action="toggleRest"][data-player="0"]');
  await host.wait(`window.__sim.session.players[0].characters.find(card=>card.id===${JSON.stringify(placedHostCard)}).rested`,'Rest manuale non applicato');
  await guest.wait(`window.__sim.session.players[0].characters.find(card=>card.id===${JSON.stringify(placedHostCard)}).rested`,'Rest manuale non sincronizzato');
  assert(await host.evaluate(`Boolean(document.querySelector('.op-battle-card.is-rested[data-op-card="${placedHostCard}"]'))`),'La carta Rest non ha orientamento fisico sul campo');
  await closeCard(host);
  assert(await host.evaluate('window.__sim.session.players[1].hand.every(card=>card.hidden && !card.catalogCardId)'),'Il movimento pubblico rivela il resto della mano');
  console.log('PASS direct placement, stable Character slots after KO, Rest and DON synchronize across isolated browser contexts');
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
  // ---- Every control on the desktop table, one by one, synchronised on both seats ----
  {
    const both=async(expr,label)=>{await host.wait(expr,label+' (host)');await guest.wait(expr,label+' (ospite)');};
    const P0='window.__sim.session.players[0]', P1='window.__sim.session.players[1]';
    const read=async expr=>JSON.parse(await host.evaluate('JSON.stringify('+expr+')'));
    const tools=async page=>{if(!await page.evaluate('Boolean(document.querySelector(".op-battle-tools [data-op-command=battle-tools-close]"))'))await page.click('[data-op-command="battle-tools"]');await page.wait('Boolean(document.querySelector(".op-battle-tools"))','Strumenti non aperti');};
    const toolAction=async(page,type,player)=>{await tools(page);await page.click('.op-battle-tools [data-op-action="'+type+'"][data-player="'+player+'"]');};
    const idle=page=>page.wait('!window.__sim.pending','Sincronizzazione bloccata');
    const closePile=async page=>{if(await page.evaluate('Boolean(document.querySelector("[data-op-command=close-pile]"))'))await page.click('[data-op-command="close-pile"]');await page.wait('!window.__sim.pile','Zona non chiusa');};
    await closeCard(host);await closeTools(host);
    assert(await host.evaluate('["is-left","is-right"].every(side=>getComputedStyle(document.querySelector(".op-battle-rail."+side)).display!=="none")'),'Colonne laterali non visibili su desktop');
    assert(await host.evaluate('Boolean(document.querySelector(".op-battle-rail.is-left .op-rail-profile.is-self")) && Boolean(document.querySelector(".op-battle-rail.is-right .op-rail-profile.is-opponent"))'),'Profili nelle colonne laterali assenti');
    assert(await host.evaluate('document.querySelectorAll(".op-battle-side[style*=\\"--side-art\\"]").length===2'),'Sfondo con la Leader assente');
    // Strumenti
    await host.click('[data-op-command="battle-tools"]');await host.wait('Boolean(document.querySelector(".op-battle-tools"))','Strumenti non aperti');
    await host.click('[data-op-command="battle-tools-close"]');await host.wait('!document.querySelector(".op-battle-tools")','Strumenti non chiusi');
    // DON!! deck pile, cost-area chips and every DON!! tool
    let don=await read(P0+'.don');
    await host.click('.op-battle-don-deck[data-player="0"]');await both(P0+'.don.active==='+(don.active+1)+' && '+P0+'.don.deck==='+(don.deck-1),'DON!! deck sul campo');await idle(host);
    await host.click('.op-battle-don-chip[data-op-action="restDon"][data-player="0"]');await both(P0+'.don.rested==='+(don.rested+1),'Chip DON!! riposa');await idle(host);
    await host.click('.op-battle-don-chip[data-op-action="activateDon"][data-player="0"]');await both(P0+'.don.rested==='+don.rested,'Chip DON!! attiva');await idle(host);
    don=await read(P0+'.don');
    await toolAction(host,'addDon',0);await both(P0+'.don.active==='+(don.active+1),'+1 DON!!');await idle(host);
    await toolAction(host,'restDon',0);await both(P0+'.don.rested==='+(don.rested+1),'Riposa DON!!');await idle(host);
    await toolAction(host,'activateDon',0);await both(P0+'.don.rested==='+don.rested,'Attiva DON!!');await idle(host);
    await toolAction(host,'returnDon',0);await both(P0+'.don.active==='+don.active+' && '+P0+'.don.deck==='+don.deck,'DON!! − attivo');await idle(host);
    await toolAction(host,'restDon',0);await both(P0+'.don.rested==='+(don.rested+1),'Riposa DON!! prima del ritorno');await idle(host);
    await toolAction(host,'returnRestedDon',0);await both(P0+'.don.rested==='+don.rested+' && '+P0+'.don.deck==='+(don.deck+1),'DON!! − rested');await idle(host);
    await toolAction(host,'addDon2',0);await both(P0+'.don.deck==='+(don.deck-1),'+2 DON!! negli strumenti');await idle(host);
    // Refresh: rested cards and DON!! return active
    await toolAction(host,'restDon',0);await both(P0+'.don.rested>=1','DON!! riposato per il Refresh');await idle(host);
    assert(await host.evaluate(P0+'.characters.some(card=>card.rested)'),'Serve un personaggio Rest per provare il Refresh');
    await toolAction(host,'refresh',0);await both(P0+'.don.rested===0 && '+P0+'.characters.every(card=>!card.rested)','Refresh');await idle(host);
    // Shuffles write to the shared log
    let log=await host.evaluate('window.__sim.session.log.length');
    await toolAction(host,'shuffle',0);await both('window.__sim.session.log.length==='+(log+1),'Mescola mazzo');await idle(host);
    await toolAction(host,'shuffleLife',0);await both('window.__sim.session.log.length==='+(log+2),'Mescola Life');await idle(host);
    // Search deck and look at Life from the tools
    await tools(host);await host.click('.op-battle-tools [data-op-command="battle-inspect-deck"]');
    await host.wait('window.__sim.pile?.zone==="deck" && window.__sim.pile.cards?.length===window.__sim.session.players[0].deck.length && document.querySelectorAll(".op-battle-pile-cards [data-op-card]").length>0','Cerca nel mazzo non mostra le carte');
    await closePile(host);
    await tools(host);await host.click('.op-battle-tools [data-op-command="battle-inspect-life"]');
    await host.wait('window.__sim.pile?.zone==="life" && window.__sim.privateLife?.cards?.length===window.__sim.session.players[0].life.length','Guarda le Life non mostra le carte');
    await closePile(host);
    // Field piles: Mazzo, Life, Trash (own and opponent)
    let hand=await host.evaluate(P0+'.hand.length');
    await host.click('[data-op-command="battle-deck"][data-player="0"]');await host.wait('window.__sim.pile?.zone==="deck"','Mazzo sul campo non apre la zona');
    await host.click('.op-battle-tools [data-op-action="draw"][data-player="0"]');await both(P0+'.hand.length==='+(hand+1),'Pesca dalla zona Mazzo');await idle(host);
    await closePile(host);
    const life=await host.evaluate(P0+'.life.length');hand=await host.evaluate(P0+'.hand.length');
    await host.click('[data-op-command="battle-life"][data-player="0"]');await host.wait('window.__sim.pile?.zone==="life"','Life sul campo non apre la zona');
    await host.click('.op-battle-tools [data-op-action="takeLife"][data-player="0"]');await both(P0+'.life.length==='+(life-1)+' && '+P0+'.hand.length==='+(hand+1),'Life → mano');await idle(host);
    await closePile(host);
    await host.click('[data-op-command="battle-trash"][data-player="0"]');await host.wait('window.__sim.pile?.zone==="trash" && document.querySelectorAll(".op-battle-pile-cards [data-op-card]").length===window.__sim.session.players[0].trash.length','Trash personale non mostra le carte');
    await closePile(host);
    await host.click('[data-op-command="battle-trash"][data-player="1"]');await host.wait('window.__sim.pile?.zone==="trash" && window.__sim.pile.player===1','Trash avversario non si apre');
    await closePile(host);
    assert(await host.evaluate('document.querySelector("[data-op-command=battle-deck][data-player=\\"1\\"]").disabled'),'Il mazzo avversario è apribile');
    // Hand: Copri / Mostra
    await host.click('[data-op-hand="0"]');await host.wait('!window.__sim.revealHands[0] && !document.querySelector(\'.op-battle-hand[data-player="0"] [data-op-card]\')','Copri mano non funziona');
    await host.click('[data-op-hand="0"]');await host.wait('window.__sim.revealHands[0] && Boolean(document.querySelector(\'.op-battle-hand[data-player="0"] [data-op-card]\'))','Mostra mano non funziona');
    // Card sheet open/close
    const handCard=await host.evaluate(P0+'.hand[0].id');
    await host.click('[data-op-card="'+handCard+'"][data-player="0"]');await host.wait('Boolean(document.querySelector(".op-sim-inspector.has-selection"))','Scheda carta non aperta');
    await host.click('.op-sim-inspector.has-selection [data-op-command="deselect"]');await host.wait('!document.querySelector(".op-sim-inspector.has-selection")','Scheda carta non chiusa');
    // Rules and history from the tools, then back to the table
    await tools(host);await host.click('.op-battle-tools [data-op-tab="rules"]');await host.wait('window.__sim.tab==="rules" && !document.querySelector(".op-battlefield")','Regole non aperte');
    await host.click('[data-op-tab="history"]');await host.wait('window.__sim.tab==="history"','Statistiche non aperte');
    await host.click('[data-op-tab="table"]');await host.wait('window.__sim.tab==="table" && Boolean(document.querySelector(".op-battlefield"))','Ritorno al tavolo non riuscito');
    // Team → lobby tile → back to the table
    await host.click('[data-op-command="lobby"]');await host.wait('Boolean(document.querySelector(".op-invite-tile.is-play [data-op-open=\\"'+duelId+'\\"]"))','La partita in corso non compare nella lobby');
    await host.click('[data-op-open="'+duelId+'"]');await host.wait('Boolean(document.querySelector(".op-battlefield"))','Rientra al tavolo non riuscito');
    // Fase: every phase lights up in the rail on both seats, then the turn passes
    assert(await guest.evaluate('document.querySelector("[data-op-action=nextPhase]").disabled && document.querySelector("[data-op-action=nextTurn]").disabled'),'L’ospite può cambiare fase nel turno altrui');
    let phase=await host.evaluate('window.__sim.session.phase');
    const order=['refresh','draw','don','main','end'];
    for(let i=order.indexOf(phase)+1;i<order.length;i++){
      await host.click('[data-op-action="nextPhase"]');
      await both('window.__sim.session.phase==="'+order[i]+'" && document.querySelector(".op-rail-phases li.is-current")?.textContent.toLowerCase()==="'+({don:'don!!'}[order[i]]||order[i])+'"','Fase '+order[i]);await idle(host);
    }
    const turn=await host.evaluate('window.__sim.session.turn');
    await host.click('[data-op-action="nextPhase"]');await both('window.__sim.session.activePlayer===1 && window.__sim.session.phase==="refresh"','Fase dopo End passa il turno');await idle(host);
    assert(await host.evaluate('document.querySelector("[data-op-action=nextPhase]").disabled'),'L’host può cambiare fase nel turno dell’ospite');
    await guest.wait('!document.querySelector("[data-op-action=nextPhase]").disabled','Fase non disponibile all’ospite di turno');
    await guest.click('[data-op-action="draw"][data-player="1"]');await both(P1+'.hand.length>=1','Pesca dell’ospite');await idle(guest);
    await guest.click('[data-op-action="addDon2"][data-player="1"]');await both(P1+'.don.active>=2','+2 DON!! dell’ospite');await idle(guest);
    await guest.click('[data-op-action="nextTurn"]');await both('window.__sim.session.activePlayer===0 && window.__sim.session.turn>'+turn,'Fine turno dell’ospite');await idle(guest);
    assert(await host.evaluate('document.querySelector(".op-rail-profile.is-self").classList.contains("is-active")'),'Il profilo di turno non è evidenziato');
    console.log('PASS every table control: tools, DON!! deck/chips, Refresh, shuffles, searches, piles, hand, card sheet, tabs, lobby round trip, phases and turns');
  }
  await host.cdp.call('Page.navigate',{url:`${origin}/scripts/fixtures/onepiece-duel-harness.html?member=duel-host&duel=${duelId}`});
  await host.wait(`window.__sim?.duel?.id===${JSON.stringify(duelId)} && window.__sim.session?.players[0].characters.length===1`,'Ripresa sessione remota non riuscita');
  assert(await host.evaluate('window.__sim.session.players[1].hand.every(card=>card.hidden)'),'Refresh rivela mano avversaria');
  await host.wait('Array.from(document.querySelectorAll(".op-battlefield img"),image=>image.complete&&image.naturalWidth>0).every(Boolean)','Immagini del campo non caricate');
  await assertArena(host,0,'desktop 1440×1000');
  await host.screenshot('battlefield-desktop');await host.screenshot('battlefield-desktop-viewport',false);
  await host.cdp.call('Emulation.setDeviceMetricsOverride',{width:1440,height:876,deviceScaleFactor:1,mobile:false});
  await assertArena(host,0,'desktop 1440×876');
  await host.screenshot('battlefield-desktop-reference',false);
  await host.cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await host.cdp.call('Page.navigate',{url:`${origin}/scripts/fixtures/onepiece-duel-harness.html?member=duel-host&duel=${duelId}`});
  await host.wait('window.__sim?.session && document.querySelector(".op-battlefield")','Il telefono non apre il campo da battaglia');
  await host.wait('Array.from(document.querySelectorAll(".op-battlefield img"),image=>image.complete&&image.naturalWidth>0).every(Boolean)','Immagini mobile non caricate');
  await delay(100);
  await assertArena(host,0,'smartphone 390×844');
  const inViewport='element=>{const box=element.getBoundingClientRect();return box.width>0&&box.height>0&&box.top>=0&&box.bottom<=innerHeight+1&&box.left>=0&&box.right<=innerWidth+1}';
  assert(await host.evaluate(`(${inViewport})(document.querySelector('[data-op-action="draw"][data-player="0"]'))`),'Pesca non raggiungibile nel viewport portrait');
  assert(await host.evaluate('getComputedStyle(document.querySelector(".mobile-nav")).display==="none"'),'La navigazione generale occupa spazio durante la partita');
  await host.screenshot('battlefield-mobile');
  await host.screenshot('battlefield-mobile-viewport',false);
  const mobileCard=await host.evaluate('window.__sim.session.players[0].hand[0].id');
  await host.click(`[data-op-card="${mobileCard}"][data-player="0"]`);
  await host.wait('Boolean(document.querySelector(".op-sim-inspector.has-selection"))','Azioni touch non aperte');
  assert.equal(await host.evaluate('getComputedStyle(document.querySelector(".op-sim-inspector.has-selection")).position'),'fixed','Inspector mobile non è un pannello fisso');
  await host.screenshot('battlefield-mobile-card',false);
  await host.click('.op-sim-inspector.has-selection [data-op-command="deselect"]');
  assert(!await host.evaluate('Boolean(document.querySelector(".op-sim-inspector.has-selection"))'),'Il pannello carta non si chiude');
  await host.cdp.call('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true});
  await delay(150);
  await assertArena(host,0,'smartphone landscape 844×390');
  assert(await host.evaluate(`(${inViewport})(document.querySelector('[data-op-action="draw"][data-player="0"]'))`),'Pesca non raggiungibile nel viewport landscape');
  await host.screenshot('battlefield-landscape',false);
  console.log('PASS mirrored mobile battlefield, five fixed Character slots per side, reachable actions, portrait/landscape fit and touch card sheet');
  // ---- Finish the test, then decline and cancel flows from the lobby ----
  {
    await host.cdp.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await host.cdp.call('Page.navigate',{url:`${origin}/scripts/fixtures/onepiece-duel-harness.html?member=duel-host&duel=${duelId}`});
    await host.wait('window.__sim?.session && document.querySelector(".op-battlefield")','Tavolo non riaperto per la conclusione');
    await host.click('[data-op-command="battle-tools"]');await host.wait('Boolean(document.querySelector("[data-op-finish]"))','Concludi il test assente');
    await host.fill('[data-op-finish] [name=winner]',0);await host.fill('[data-op-finish] [name=notes]','Prova di tutti i pulsanti');
    await host.submit('[data-op-finish]');
    await host.wait('window.__sim.session.result?.winner===0','Concludi test non registrato');await guest.wait('window.__sim.session.result?.winner===0','Risultato non sincronizzato');
    await host.wait('Boolean(document.querySelector(".op-battle-result"))','Esito non mostrato sul campo');
    // decline
    await host.click('[data-op-command="lobby"]');await host.wait('Boolean(document.querySelector("[data-op-invite]"))','Lobby non disponibile dopo il test');
    await host.fill('[data-op-invite] [name=opponentSlug]','duel-guest');await host.fill('[data-op-invite] [name=deckId]',hostDeckId);
    await host.submit('[data-op-invite]');await host.wait('window.__sim.duel?.status==="waiting" && window.__sim.duel.id!=='+JSON.stringify(duelId),'Secondo invito non creato');
    const declined=await host.evaluate('window.__sim.duel.id');
    await guest.click('[data-op-command="lobby"]');
    await guest.wait('Boolean(document.querySelector(\'.op-invite-tile.is-new [data-op-open="'+declined+'"]\'))','Nuovo invito non evidenziato');
    await guest.click('[data-op-open="'+declined+'"]');await guest.wait('Boolean(document.querySelector("[data-op-response=decline]"))','Rifiuta invito assente');
    await guest.click('[data-op-response="decline"]');await guest.wait('window.__sim.duel?.status==="declined" || !window.__sim.duel','Rifiuto non applicato');
    assert.equal(rows.get(declined).status,'declined','Il rifiuto non è registrato');
    // cancel
    await host.click('[data-op-command="lobby"]');await host.wait('Boolean(document.querySelector("[data-op-invite]"))','Lobby non disponibile dopo il rifiuto');
    await host.fill('[data-op-invite] [name=opponentSlug]','duel-guest');await host.fill('[data-op-invite] [name=deckId]',hostDeckId);
    await host.submit('[data-op-invite]');await host.wait('window.__sim.duel?.status==="waiting" && window.__sim.duel.id!=='+JSON.stringify(declined),'Terzo invito non creato');
    const cancelled=await host.evaluate('window.__sim.duel.id');
    assert(await host.evaluate('Boolean(document.querySelector(".op-sim-waiting .op-versus .op-vs-deck.is-pending"))'),'Attesa dell’avversario senza riepilogo versus');
    await host.click('[data-op-response="cancel"]');await host.wait('window.__sim.duel?.status==="cancelled" || !window.__sim.duel','Annulla invito non applicato');
    assert.equal(rows.get(cancelled).status,'cancelled','L’annullamento non è registrato');
    console.log('PASS finish test, decline and cancel from the versus lobby');
  }
  assert.deepEqual(exceptions,[],'Eccezioni JavaScript');assert.deepEqual(consoleErrors,[],'Errori console');assert.deepEqual(networkErrors,[],'Risorse mancanti');assert.deepEqual(externalRequests,[],'Richieste esterne inattese');
  assert(requests.some(request=>request.actor==='duel-host'&&request.op==='action')&&requests.some(request=>request.actor==='duel-guest'&&request.op==='action'));
  console.log('PASS remote session refresh, FPT shell, desktop/mobile rendering and zero external requests');
  console.log('onepiece-duel-browser-smoke: OK');
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  for(const socket of sockets){try{socket.close();}catch{}}
  try{browser?.kill();}catch{}
  if(browser&&browser.exitCode===null)await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),delay(2000)]);
  await new Promise(resolve=>server.close(resolve));
  // Remove only the profile created by this run, never a user's Chrome profile.
  const temporaryRoot=path.resolve(os.tmpdir()),profile=browserProfile&&path.resolve(browserProfile);
  if(profile&&path.dirname(profile)===temporaryRoot&&path.basename(profile).startsWith('fpt-private-duel-')){
    try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){console.error(`Impossibile rimuovere il profilo del test: ${error.message}`);}
  }
});
