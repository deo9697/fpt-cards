// Two independent Chrome contexts exercise the real duel service and UI.
// All players, decks, storage and notifications are synthetic and local.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createDuelService } from '../api/_yugioh-duel-service.js';

const root = process.cwd(), clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const teamId='11111111-1111-4111-8111-111111111111';
const people=[{slug:'duel-host',name:'Marco · Prova'},{slug:'duel-guest',name:'Luca · Prova'},{slug:'duel-observer',name:'Terzo membro'}];
const hostDeckId='a0000000-0000-4000-8000-000000000001',guestDeckId='b0000000-0000-4000-8000-000000000002';
const cards=[
  ['89631139','Drago Bianco Occhi Blu','Normal Monster',3000,2500],
  ['46986414','Mago Nero','Normal Monster',2500,2100],
  ['74677422','Drago Nero Occhi Rossi','Normal Monster',2400,2000],
  ['70781052','Teschio Evocato','Normal Monster',2500,1200],
  ['38033121','Ragazza Maga Nera','Effect Monster',2000,1700],
  ['91152256','Guardiano Celtico','Normal Monster',1400,1200],
  ['15025844','Elfa Mistica','Normal Monster',800,2000],
  ['13039848','Soldato Gigante di Pietra','Normal Monster',1300,2000],
  ['88819587','Drago Cucciolo','Normal Monster',1200,700],
  ['76184692','Bue da Battaglia','Normal Monster',1700,1000],
  ['97590747','La Jinn il Genio Mistico della Lampada','Normal Monster',1800,1000],
  ['14898066','Predatore Vorse','Normal Monster',1900,1200],
  ['5318639','Tifone Spaziale Mistico','Spell Card',null,null],
  ['83764718','Mostro Resuscitato','Spell Card',null,null]
];
const extraCards=[['23995346','Drago Occhi Blu Finale','Fusion Monster',4500,3800],['84013237','Numero 39: Utopia','XYZ Monster',2500,2000],['98978921','Ragno Link','Link Monster',1000,null]];
const makeCard=(row,section,quantity)=>({catalogCardId:row[0],cardName:row[1],type:row[2],atk:row[3],def:row[4],section,quantity,imageUrl:`/previewcard/${row[0]}.jpg`,text:'Carta di prova: applica manualmente il testo mostrato nell’immagine.'});
const makeDeck=(ownerSlug,id)=>({id,ownerSlug,game:'yugioh',persisted:true,name:ownerSlug==='duel-host'?'Draghi e Maghi · Test':'Duello classico · Test',cards:[...cards.map((row,i)=>makeCard(row,'main',i===13?1:3)),...extraCards.map(row=>makeCard(row,'extra',1)),makeCard(['44095762','Forza Riflessa','Trap Card',null,null],'side',1)]});
const decks=[makeDeck('duel-host',hostDeckId),makeDeck('duel-guest',guestDeckId)];
const rows=new Map(),notifications=[],requests=[];
const store={
  members:async id=>id===teamId?clone(people):[],pushMembers:async()=>['duel-guest'],
  list:async(id,slug)=>clone([...rows.values()].filter(row=>row.team_id===id&&[row.host_slug,row.guest_slug].includes(slug))),
  get:async id=>clone(rows.get(id)||null),meta:async id=>{const row=rows.get(id);if(!row)return null;const{state,host_deck,previous_state,...metadata}=row;return clone(metadata);},
  deck:async(id,slug)=>clone(decks.find(deck=>deck.id===id&&deck.ownerSlug===slug)||null),
  recentCount:async(slug,since)=>[...rows.values()].filter(row=>row.host_slug===slug&&row.created_at>=since).length,
  insert:async row=>{if(rows.has(row.id))return null;rows.set(row.id,clone(row));return clone(row);},
  update:async(id,version,patch)=>{const row=rows.get(id);if(!row||row.version!==version)return null;const next={...row,...clone(patch)};rows.set(id,next);return clone(next);}
};
const service=createDuelService({store,notify:async payload=>{notifications.push(clone(payload));return{push:'sent',delivered:1};}});
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server=http.createServer(async(request,response)=>{
  const url=new URL(request.url,'http://localhost'),json=(status,body)=>response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(body));
  if(url.pathname==='/favicon.ico'){response.writeHead(204).end();return;}
  if(url.pathname==='/__duel-fixtures'){
    const person=people.find(member=>member.slug===url.searchParams.get('member'));if(!person){json(404,{message:'Fixture non disponibile'});return;}
    const own=decks.filter(deck=>deck.ownerSlug===person.slug),catalog=Object.fromEntries(own.flatMap(deck=>deck.cards).map(card=>[card.catalogCardId,card]));
    json(200,{...person,teamId,members:people,decks:own,catalog});return;
  }
  if(url.pathname==='/api/yugioh-duel'&&request.method==='POST'){
    try{let body='';for await(const chunk of request)body+=chunk;const payload=JSON.parse(body),person=people.find(member=>member.slug===payload.token);if(!person){json(401,{message:'Sessione non valida'});return;}requests.push({actor:person.slug,op:payload.op,action:payload.action?.type});json(200,await service.run({...person,teamId},payload));}
    catch(error){json(error.status||500,{message:error.message,code:error.code,duel:error.duel});}return;
  }
  if(url.pathname.startsWith('/previewcard/')){
    const code=path.basename(url.pathname,'.jpg');
    if(!/^\d+$/.test(code)){response.writeHead(404).end();return;}
    const image=path.join(root,'artifacts','yugioh-duel','cards',`${code}.jpg`);
    response.setHeader('Content-Type',fs.existsSync(image)?'image/jpeg':'image/png');
    response.end(fs.readFileSync(fs.existsSync(image)?image:path.join(root,'assets','game-logos','yugioh.png')));return;
  }
  const file=path.resolve(root,`.${decodeURIComponent(url.pathname)}`);if(!file.startsWith(`${root}${path.sep}`)){response.writeHead(403).end();return;}
  try{response.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');response.setHeader('Cache-Control','no-store');response.end(fs.readFileSync(file));}catch{response.writeHead(404).end('Not found');}
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
  browserProfile=path.resolve(os.tmpdir(),`fpt-ygo-duel-${Date.now()}-${process.pid}`);
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
    cdp.on('Network.responseReceived',event=>{if(event.response.status>=400&&!event.response.url.endsWith('/api/yugioh-duel'))networkErrors.push(`${event.response.status} ${event.response.url}`);});
    await cdp.call('Runtime.enable');await cdp.call('Network.enable');await cdp.call('Page.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    const evaluate=async expression=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
    const wait=async(expression,label)=>{for(let attempt=0;attempt<200;attempt++){if(await evaluate(expression))return;await delay(80);}if(process.argv.includes('--screenshots')){try{const shot=await cdp.call('Page.captureScreenshot',{format:'png'});const directory=path.join(root,'artifacts','yugioh-duel');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`failure-${member}.png`),Buffer.from(shot.data,'base64'));}catch{}}throw new Error(`${member}: ${label}\n${await evaluate('document.body.innerText.slice(0,2200)')}\n${JSON.stringify(exceptions)}`);};
    const click=async selector=>{assert(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),`${member}: controllo assente ${selector}`);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);};
    const tap=async selector=>{
      const point=await evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});if(!target||target.disabled)throw Error('Controllo touch assente o disabilitato');target.scrollIntoView({block:'nearest',inline:'nearest'});const box=target.getBoundingClientRect();return {x:(Math.max(0,box.left)+Math.min(innerWidth,box.right))/2,y:(Math.max(0,box.top)+Math.min(innerHeight,box.bottom))/2};})()`);
      await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,radiusX:3,radiusY:3,force:1}]});
      await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    };
    const fill=async(selector,value)=>evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});if(!field)throw Error('Controllo assente: '+${JSON.stringify(selector)});field.value=${JSON.stringify(String(value))};field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const submit=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
    const screenshot=async(name,full=true)=>{if(!process.argv.includes('--screenshots'))return;await evaluate('document.fonts.ready');await evaluate('Promise.all(Array.from(document.images,image=>image.complete?Promise.resolve():new Promise(resolve=>{image.onload=resolve;image.onerror=resolve})))');const params={format:'png',captureBeyondViewport:full};if(full){const layout=await cdp.call('Page.getLayoutMetrics'),size=layout.cssContentSize||layout.contentSize;params.clip={x:0,y:0,width:size.width,height:Math.min(size.height,8000),scale:1};}const shot=await cdp.call('Page.captureScreenshot',params);const directory=path.join(root,'artifacts','yugioh-duel');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`${name}.png`),Buffer.from(shot.data,'base64'));};
    await cdp.call('Page.navigate',{url:`${origin}/scripts/fixtures/yugioh-duel-harness.html?member=${member}`});
    return {member,cdp,evaluate,wait,click,tap,fill,submit,screenshot};
  }
  const host=await page('duel-host'),guest=await page('duel-guest');
  await host.wait('window.__fixtureReady && document.querySelector("[data-ygo-invite]")','Invito non disponibile');
  await guest.wait('window.__fixtureReady && document.querySelector("[data-ygo-invite]")','Lobby ospite non disponibile');
  await host.fill('[data-ygo-invite] [name=opponentSlug]','duel-guest');
  await host.fill('[data-ygo-invite] [name=deckId]',hostDeckId);
  await host.fill('[data-ygo-invite] [name=lp]',8000);
  await host.fill('[data-ygo-invite] [name=firstPlayer]',0);
  await host.screenshot('lobby',false);
  await host.submit('[data-ygo-invite]');
  await host.wait('window.__sim.duel?.status==="waiting"','Invito non inviato');
  const duelId=await host.evaluate('window.__sim.duel.id');
  assert.equal(notifications.length,1,'La notifica sintetica deve essere richiesta una sola volta');
  await guest.wait(`Boolean(document.querySelector('[data-ygo-open="${duelId}"]'))`,'Invito non ricevuto');
  await guest.click(`[data-ygo-open="${duelId}"]`);
  await guest.wait('Boolean(document.querySelector("[data-ygo-accept]"))','Accettazione non disponibile');
  await guest.fill('[data-ygo-accept] [name=deckId]',guestDeckId);
  await guest.fill('[data-ygo-accept] [name=lp]',8000);
  await guest.submit('[data-ygo-accept]');
  await host.wait('window.__sim.session && window.__sim.duel.status==="setup"','Preparazione host non arrivata');
  await guest.wait('window.__sim.session && window.__sim.duel.status==="setup"','Preparazione ospite non arrivata');
  await host.click('[data-ygo-action="ready"]');
  await guest.wait('window.__sim.duel.ready[0]','Pronto host non sincronizzato');
  await guest.click('[data-ygo-action="ready"]');
  await host.wait('window.__sim.duel.status==="playing"','Duello host non avviato');
  await guest.wait('window.__sim.duel.status==="playing"','Duello ospite non avviato');
  console.log('PASS private team invitation, own Main/Extra/Side decks, notification fixture and two-player readiness');

  const idle=page=>page.wait('!window.__sim.pending','Sincronizzazione bloccata');
  const both=async(expression,label)=>{await host.wait(expression,label+' (host)');await guest.wait(expression,label+' (ospite)');};
  async function closeCard(page){if(await page.evaluate('Boolean(document.querySelector(".ygo-card-dialog"))'))await page.click('.ygo-card-dialog [data-ygo-command="deselect"]');}
  async function closeMenu(page){if(await page.evaluate('Boolean(document.querySelector("[data-ygo-command=close-menu]"))'))await page.click('[data-ygo-command="close-menu"]');}
  async function closePile(page){if(await page.evaluate('Boolean(document.querySelector("[data-ygo-command=close-pile]"))'))await page.click('[data-ygo-command="close-pile"]');}
  async function openMenu(page){await closeCard(page);await closePile(page);if(!await page.evaluate('window.__sim.menu'))await page.click('[data-ygo-command="menu"]');}
  async function select(page,viewer,id){await idle(page);await page.click(`[data-ygo-card="${id}"][data-player="${viewer}"]`);await page.wait('Boolean(document.querySelector(".ygo-card-dialog"))','Scheda carta assente');}
  async function putInHand(page,viewer,code){
    const player=rows.get(duelId).state.players[viewer],zone=['hand','deck'].find(zone=>player[zone].some(card=>card.catalogCardId===code));
    assert(zone,'Carta di prova assente dalla mano/mazzo: '+code);
    const card=player[zone].find(card=>card.catalogCardId===code);
    if(zone==='deck'){
      await openMenu(page);await page.click('[data-ygo-command="inspect-deck"]');
      await page.wait(`window.__sim.pile?.cards?.some(card=>card.id===${JSON.stringify(card.id)})`,'Ricerca nel mazzo non mostra la carta');
      await page.click(`.ygo-zone-cards [data-ygo-card="${card.id}"]`);
      await page.fill('[data-ygo-move] [name=to]','hand');await page.submit('[data-ygo-move]');
      await page.wait(`window.__sim.session.players[${viewer}].hand.some(card=>card.id===${JSON.stringify(card.id)})`,'Ricerca → mano non applicata');await idle(page);
    }
    await closeMenu(page);await closePile(page);return card.id;
  }
  async function playHand(page,viewer,code,command,slot){
    const id=await putInHand(page,viewer,code);await select(page,viewer,id);await page.click(`[data-ygo-command="${command}"]`);
    const zone=command==='set-spell'||command==='play-spell'?'spells':'monsters';
    await page.click(`[data-ygo-slot="${slot}"][data-zone="${zone}"][data-player="${viewer}"]`);
    await page.wait(`window.__sim.session.players[${viewer}].${zone}.some(card=>card.id===${JSON.stringify(id)}&&card.slot===${slot})`,'Giocata nella zona corretta non applicata');await idle(page);return id;
  }
  async function playExtra(page,viewer,code,zone,slot){
    await closeCard(page);await closeMenu(page);await closePile(page);
    await page.click(`[data-ygo-pile="extra"][data-player="${viewer}"]`);
    const id=rows.get(duelId).state.players[viewer].extra.find(card=>card.catalogCardId===code)?.id;
    assert(id,'Carta Extra non disponibile');
    await page.click(`.ygo-zone-cards [data-ygo-card="${id}"]`);await page.click('[data-ygo-command="summon"]');
    await page.click(`[data-ygo-slot="${slot}"][data-zone="${zone}"][data-player="${viewer}"]`);
    await both(`window.__sim.session.players[${viewer}].${zone}.some(card=>card.id===${JSON.stringify(id)}&&card.slot===${slot})`,'Evocazione Extra');await idle(page);return id;
  }
  assert(await host.evaluate('window.__sim.session.players[1].hand.every(card=>card.hidden&&!card.catalogCardId&&!card.imageUrl)'),'Mano avversaria esposta');
  assert(await host.evaluate('window.__sim.session.players.every(player=>player.deck.every(card=>card.hidden&&!card.catalogCardId&&!card.imageUrl))'),'Ordine del mazzo esposto');
  assert(await host.evaluate('window.__sim.session.players[1].extra.every(card=>card.hidden&&!card.catalogCardId)'),'Extra Deck avversario esposto');
  assert(await host.evaluate('window.__sim.session.players[0].extra.every(card=>!card.hidden&&card.catalogCardId)'),'Extra Deck personale non consultabile');
  const hostMonster=await playHand(host,0,'89631139','summon',4);
  await both(`window.__sim.session.players[0].monsters.some(card=>card.id===${JSON.stringify(hostMonster)}&&card.faceUp)`,'Mostro host pubblico');
  const setMonster=await playHand(host,0,'46986414','set-monster',3);
  await guest.wait('window.__sim.session.players[0].monsters.some(card=>card.slot===3&&card.hidden)','Mostro posizionato non coperto');
  const masked=await guest.evaluate('window.__sim.session.players[0].monsters.find(card=>card.slot===3)');
  assert.equal(masked.catalogCardId,'');assert.equal(masked.imageUrl,'');assert.equal(masked.position,'defense');
  assert(!rows.get(duelId).state.log.at(-1).text.includes('Mago Nero'),'Il registro rivela la carta posizionata');
  await select(host,0,setMonster);await host.click('[data-ygo-action="flip"]');
  await both(`window.__sim.session.players[0].monsters.some(card=>card.id===${JSON.stringify(setMonster)}&&card.faceUp)`,'Scopri Mostro');
  await select(host,0,setMonster);await host.click('[data-ygo-action="setPosition"]');
  await both(`window.__sim.session.players[0].monsters.find(card=>card.id===${JSON.stringify(setMonster)}).position==="attack"`,'Cambia posizione in Attacco');
  await select(host,0,hostMonster);await host.fill('[data-ygo-stats] [name=stat]','atk');await host.fill('[data-ygo-stats] [name=delta]',500);await host.submit('[data-ygo-stats]');
  await both(`window.__sim.session.players[0].monsters.find(card=>card.id===${JSON.stringify(hostMonster)}).atkModifier===500`,'Modifica ATK');
  await select(host,0,hostMonster);await host.click('[data-ygo-action="counter"][data-delta="1"]');
  await both(`window.__sim.session.players[0].monsters.find(card=>card.id===${JSON.stringify(hostMonster)}).counters===1`,'Aggiungi segnalino');
  const guestMonster=await playHand(guest,1,'74677422','summon',0);
  await both(`window.__sim.session.players[1].monsters.some(card=>card.id===${JSON.stringify(guestMonster)})`,'Mostro ospite pubblico');
  await playHand(guest,1,'70781052','defend',4);
  console.log('PASS fixed Monster slots, attack/defense/set/flip, ATK modifiers, counters and private face-down identity/logs');
  await host.screenshot('board-progress',false);

  const spell=await playHand(host,0,'5318639','set-spell',2);
  await guest.wait('window.__sim.session.players[0].spells.some(card=>card.slot===2&&card.hidden)','Magia coperta esposta');
  await select(host,0,spell);await host.click('[data-ygo-action="activate"]');
  await both('window.__sim.session.chain.length===1','Catena attivata');
  await both(`window.__sim.session.players[0].spells.find(card=>card.id===${JSON.stringify(spell)}).faceUp`,'Attivazione svela la carta');
  await host.click('.ygo-chain-bar [data-ygo-action="resolveChain"]');await both('window.__sim.session.chain.length===0','Risoluzione manuale catena');
  await select(host,0,spell);await host.click('[data-ygo-command="to-graveyard"]');
  await both(`window.__sim.session.players[0].graveyard.some(card=>card.id===${JSON.stringify(spell)})`,'Magia → Cimitero');
  await openMenu(host);await host.fill('[data-ygo-lp] [name=delta]',-1200);await host.submit('[data-ygo-lp]');
  await both('window.__sim.session.players[0].lp===6800','Variazione LP');await closeMenu(host);
  const xyz=await playExtra(host,0,'84013237','monsters',1);
  await select(host,0,setMonster);await host.fill('[data-ygo-material] [name=targetId]',xyz);await host.submit('[data-ygo-material]');
  await both(`window.__sim.session.players[0].monsters.find(card=>card.id===${JSON.stringify(xyz)}).materials.length===1`,'Materiale Xyz assegnato');
  await select(host,0,xyz);await host.click('[data-ygo-action="detachMaterial"]');
  await both(`window.__sim.session.players[0].monsters.find(card=>card.id===${JSON.stringify(xyz)}).materials.length===0&&window.__sim.session.players[0].graveyard.some(card=>card.id===${JSON.stringify(setMonster)})`,'Stacca materiale → Cimitero');
  await openMenu(host);await host.click('[data-ygo-action="token"]');await host.wait('window.__sim.session.players[0].monsters.some(card=>card.token)','Segna-Mostro non creato');await closeMenu(host);
  const token=await host.evaluate('window.__sim.session.players[0].monsters.find(card=>card.token).id');
  await select(host,0,token);await host.click('[data-ygo-command="to-graveyard"]');
  await both('!window.__sim.session.players[0].monsters.some(card=>card.token)','Segna-Mostro non rimosso');
  const fusion=await playExtra(host,0,'23995346','extraMonsters',0);
  await playExtra(guest,1,'98978921','extraMonsters',1);
  assert.equal(await host.evaluate('window.__sim.session.players.flatMap(player=>player.extraMonsters).length'),2,'Zone Extra non condivise');
  console.log('PASS Spell set/activation/manual chain/GY, LP, Xyz materials, tokens and shared Extra Monster zones');

  const outsider=await fetch(`${origin}/api/yugioh-duel`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'duel-observer',op:'state',duelId})});
  assert.equal(outsider.status,404,'Un terzo membro legge la partita');
  const forbidden=await fetch(`${origin}/api/yugioh-duel`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'duel-host',op:'inspect',duelId,zone:'deck',player:1})});
  assert.equal(forbidden.status,403,'Mazzo avversario ispezionabile');
  const stateBeforeConflict=rows.get(duelId),handBefore=stateBeforeConflict.state.players[0].hand.length;
  const stale=await fetch(`${origin}/api/yugioh-duel`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'duel-host',op:'action',duelId,expectedVersion:stateBeforeConflict.version-1,requestId:crypto.randomUUID(),action:{type:'draw',player:0}})});
  assert.equal(stale.status,409);assert.equal(rows.get(duelId).state.players[0].hand.length,handBefore);
  await host.click('[data-ygo-action="nextPhase"]');await both('window.__sim.session.phase==="standby"','Cambio fase');
  await host.click('[data-ygo-action="nextTurn"]');await both('window.__sim.session.activePlayer===1&&window.__sim.session.turn===2','Passaggio turno');
  assert(await host.evaluate('document.querySelector("[data-ygo-action=nextTurn]").disabled'),'Giocatore fuori turno può passare il turno');
  await guest.click('[data-ygo-action="nextTurn"]');await both('window.__sim.session.activePlayer===0&&window.__sim.session.turn===3','Ritorno turno host');
  // Reload from the deep link; all state comes back from the service, not storage.
  await host.cdp.call('Page.navigate',{url:`${origin}/scripts/fixtures/yugioh-duel-harness.html?member=duel-host&duel=${duelId}`});
  await host.wait(`window.__sim?.session?.players[0].extraMonsters.some(card=>card.id===${JSON.stringify(fusion)})`,'Ripresa remota non riuscita');
  async function assertArena(page,label){
    await page.wait('Boolean(document.querySelector(".ygo-arena"))',label+': arena assente');
    await page.wait('Array.from(document.querySelectorAll(".ygo-arena img"),image=>image.complete&&image.naturalWidth>0).every(Boolean)',label+': immagini non caricate');
    assert(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),label+': overflow orizzontale');
    for(const player of[0,1])for(const zone of['monsters','spells'])assert.equal(await page.evaluate(`document.querySelectorAll('.ygo-zone[data-zone="${zone}"][data-player="${player}"]').length`),5,label+': cinque zone per lato');
    assert.equal(await page.evaluate('document.querySelectorAll(".ygo-shared-extra .ygo-zone").length'),2,label+': EMZ condivise');
    assert(await page.evaluate('Array.from(document.querySelectorAll(".ygo-half"),half=>half.getBoundingClientRect().height>0&&getComputedStyle(half).display!=="none").every(Boolean)'),label+': metà campo nascosta');
  }
  await assertArena(host,'Desktop 1440×1000');await host.screenshot('desktop',false);
  await host.cdp.call('Emulation.setDeviceMetricsOverride',{width:1440,height:810,deviceScaleFactor:1,mobile:false});await delay(100);
  await assertArena(host,'Desktop 1440×810');await host.screenshot('desktop-reference',false);
  await host.cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await delay(100);
  await assertArena(host,'Smartphone 390×844');await host.screenshot('mobile',false);
  // Real touch events, not programmatic clicks, play a hand card into an empty slot.
  const touchCard=await putInHand(host,0,'91152256');
  await host.tap(`[data-ygo-card="${touchCard}"][data-player="0"]`);await host.wait('Boolean(document.querySelector(".ygo-card-dialog"))','Scheda touch non aperta');
  await host.screenshot('card',false);
  await host.tap('[data-ygo-command="summon"]');
  await host.tap('[data-ygo-slot="3"][data-zone="monsters"][data-player="0"]');
  await both(`window.__sim.session.players[0].monsters.some(card=>card.id===${JSON.stringify(touchCard)}&&card.slot===3)`,'Evocazione touch');
  await host.tap(`[data-ygo-card="${touchCard}"][data-player="0"]`);await host.wait('Boolean(document.querySelector(".ygo-card-dialog"))','Seconda scheda touch non aperta');
  await host.tap('[data-ygo-command="to-graveyard"]');
  await both(`window.__sim.session.players[0].graveyard.some(card=>card.id===${JSON.stringify(touchCard)})`,'KO touch');
  await host.cdp.call('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true});await delay(100);
  await assertArena(host,'Smartphone orizzontale 844×390');await host.screenshot('landscape',false);
  console.log('PASS two-seat privacy/conflicts, phases, remote reload, desktop/mobile layouts and real touch summon/KO');

  await openMenu(host);await host.fill('[data-ygo-finish] [name=winner]',0);await host.fill('[data-ygo-finish] [name=notes]','Duello di prova manuale completato.');await host.submit('[data-ygo-finish]');
  await both('window.__sim.session.result?.winner===0','Risultato finale condiviso');
  assert.deepEqual(exceptions,[],'Eccezioni JavaScript');assert.deepEqual(consoleErrors,[],'Errori console');assert.deepEqual(networkErrors,[],'Risorse mancanti');assert.deepEqual(externalRequests,[],'Richieste esterne inattese');
  assert(requests.some(request=>request.actor==='duel-host'&&request.op==='action')&&requests.some(request=>request.actor==='duel-guest'&&request.op==='action'));
  console.log('PASS shared result, zero exceptions/console/network errors, no production data or real notifications');
  console.log('yugioh-duel-browser-smoke: OK');
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  for(const socket of sockets){try{socket.close();}catch{}}
  try{browser?.kill();}catch{}
  if(browser&&browser.exitCode===null)await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),delay(2000)]);
  await new Promise(resolve=>server.close(resolve));
  const temporaryRoot=path.resolve(os.tmpdir()),profile=browserProfile&&path.resolve(browserProfile);
  if(profile&&path.dirname(profile)===temporaryRoot&&path.basename(profile).startsWith('fpt-ygo-duel-')){
    try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){console.error(`Impossibile rimuovere il profilo del test: ${error.message}`);}
  }
});
