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
const secondHostDeckId='a0000000-0000-4000-8000-000000000003',invalidHostDeckId='a0000000-0000-4000-8000-000000000004';
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
  ['97077563','Richiamo del Posseduto','Trap Card',null,null],
  ['5318639','Tifone Spaziale Mistico','Spell Card',null,null],
  ['83764718','Mostro Resuscitato','Spell Card',null,null]
];
const extraCards=[['23995346','Drago Occhi Blu Finale','Fusion Monster',4500,3800],['84013237','Numero 39: Utopia','XYZ Monster',2500,2000],['98978921','Ragno Link','Link Monster',1000,null]];
const makeCard=(row,section,quantity)=>({catalogCardId:row[0],cardName:row[1],type:row[2],atk:row[3],def:row[4],section,quantity,imageUrl:`/previewcard/${row[0]}.jpg`,text:'Carta di prova: applica manualmente il testo mostrato nell’immagine.'});
const makeDeck=(ownerSlug,id)=>({id,ownerSlug,game:'yugioh',persisted:true,name:ownerSlug==='duel-host'?'Draghi e Maghi · Test':'Duello classico · Test',cards:[...cards.map((row,i)=>makeCard(row,'main',i===13?1:3)),...extraCards.map(row=>makeCard(row,'extra',1)),makeCard(['44095762','Forza Riflessa','Trap Card',null,null],'side',1)]});
const decks=[makeDeck('duel-host',hostDeckId),makeDeck('duel-guest',guestDeckId)];
decks.push({...makeDeck('duel-host',secondHostDeckId),name:'Secondo mazzo salvato · Test'});
const incompleteDeck=makeDeck('duel-host',invalidHostDeckId);incompleteDeck.name='Mazzo incompleto · Test';incompleteDeck.cards=incompleteDeck.cards.filter(card=>card.section!=='main').concat(incompleteDeck.cards.filter(card=>card.section==='main').slice(0,3));decks.push(incompleteDeck);
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
    await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true,screenOrientation:{type:'landscapePrimary',angle:90}});
    const evaluate=async expression=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
    const wait=async(expression,label)=>{for(let attempt=0;attempt<200;attempt++){if(await evaluate(expression))return;await delay(80);}if(process.argv.includes('--screenshots')){try{const shot=await cdp.call('Page.captureScreenshot',{format:'png'});const directory=path.join(root,'artifacts','yugioh-duel');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`failure-${member}.png`),Buffer.from(shot.data,'base64'));}catch{}}throw new Error(`${member}: ${label}\n${await evaluate('document.body.innerText.slice(0,2200)')}\n${JSON.stringify(exceptions)}`);};
    const click=async selector=>{assert(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),`${member}: controllo assente ${selector}`);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);};
    const tap=async(selector,allowDisabled=false)=>{
      const point=await evaluate(`(()=>{const selector=${JSON.stringify(selector)},target=document.querySelector(selector);if(!target||(!${allowDisabled}&&target.disabled))throw Error('Controllo touch assente o disabilitato: '+selector+' '+JSON.stringify({pending:window.__sim.pending,viewer:window.__sim.viewer,active:window.__sim.session?.activePlayer,status:window.__sim.duel?.status,phase:window.__sim.session?.phase}));target.scrollIntoView({block:'center',inline:'center'});const box=target.getBoundingClientRect();return {x:(Math.max(0,box.left)+Math.min(innerWidth,box.right))/2,y:(Math.max(0,box.top)+Math.min(innerHeight,box.bottom))/2};})()`);
      await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,radiusX:3,radiusY:3,force:1}]});
      await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    };
    const hold=async(selector,{duration=400,screenshotName}={})=>{
      const point=await evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});if(!target||target.disabled)throw Error('Carta per lettura assente o disabilitata');target.scrollIntoView({block:'center',inline:'center'});const box=target.getBoundingClientRect();return{x:(Math.max(0,box.left)+Math.min(innerWidth,box.right))/2,y:(Math.max(0,box.top)+Math.min(innerHeight,box.bottom))/2};})()`);
      await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,radiusX:3,radiusY:3,force:1}]});await delay(duration);
      if(screenshotName)await screenshot(screenshotName,false);
      await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    };
    const pressDrag=async(sourceSelector,targetSelector,screenshotName)=>{
      const points=await evaluate(`(()=>{const source=document.querySelector(${JSON.stringify(sourceSelector)}),target=document.querySelector(${JSON.stringify(targetSelector)});if(!source||!target)throw Error('Sorgente o destinazione trascinamento assente');source.scrollIntoView({block:'center',inline:'center'});const from=source.getBoundingClientRect(),to=target.getBoundingClientRect();return{from:{x:(Math.max(0,from.left)+Math.min(innerWidth,from.right))/2,y:(Math.max(0,from.top)+Math.min(innerHeight,from.bottom))/2},to:{x:(to.left+to.right)/2,y:(to.top+to.bottom)/2}};})()`);
      await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...points.from,radiusX:3,radiusY:3,force:1}]});await delay(400);
      for(let step=1;step<=4;step++){await cdp.call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:points.from.x+(points.to.x-points.from.x)*step/4,y:points.from.y+(points.to.y-points.from.y)*step/4,radiusX:3,radiusY:3,force:1}]});await delay(16);}
      if(screenshotName)await screenshot(screenshotName,false);
      await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    };
    const fill=async(selector,value)=>evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});if(!field)throw Error('Controllo assente: '+${JSON.stringify(selector)});field.value=${JSON.stringify(String(value))};field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const submit=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
    const screenshot=async(name,full=true)=>{if(!process.argv.includes('--screenshots'))return;await evaluate('document.fonts.ready');await evaluate('Promise.all(Array.from(document.images,image=>image.complete?Promise.resolve():new Promise(resolve=>{image.onload=resolve;image.onerror=resolve})))');const params={format:'png',captureBeyondViewport:full};if(full){const layout=await cdp.call('Page.getLayoutMetrics'),size=layout.cssContentSize||layout.contentSize;params.clip={x:0,y:0,width:size.width,height:Math.min(size.height,8000),scale:1};}const shot=await cdp.call('Page.captureScreenshot',params);const directory=path.join(root,'artifacts','yugioh-duel');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`${name}.png`),Buffer.from(shot.data,'base64'));};
    await cdp.call('Page.navigate',{url:`${origin}/scripts/fixtures/yugioh-duel-harness.html?member=${member}`});
    return {member,cdp,evaluate,wait,click,tap,hold,pressDrag,fill,submit,screenshot};
  }
  async function assertPhoneFrame(seat,label){
    const geometry=await seat.evaluate(`(()=>{const mat=document.querySelector('.ygo-playmat').getBoundingClientRect();const controls=['[data-ygo-command="menu"]','.ygo-phase-controls [data-ygo-action="draw"]','[data-ygo-action="nextPhase"]','[data-ygo-action="nextTurn"]',...['draw','standby','main1','battle','main2','end'].map(phase=>'[data-ygo-action="setPhase"][data-phase="'+phase+'"]')].map(selector=>{const button=document.querySelector(selector);if(!button)return{selector,inside:false,hit:false};const box=button.getBoundingClientRect(),hit=document.elementFromPoint((box.left+box.right)/2,(box.top+box.bottom)/2);return{selector,inside:box.left>=0&&box.top>=0&&box.right<=innerWidth+1&&box.bottom<=innerHeight+1,hit:Boolean(hit&&(hit===button||button.contains(hit)))};});return{top:mat.top,bottom:mat.bottom,left:mat.left,right:mat.right,width:innerWidth,height:innerHeight,controls};})()`);
    assert(geometry.top>=0&&geometry.bottom<=geometry.height+1&&geometry.left>=0&&geometry.right<=geometry.width+1,`${label}: campo tagliato dal viewport (${JSON.stringify(geometry)})`);
    assert(geometry.controls.every(control=>control.inside&&control.hit),`${label}: comandi fuori schermo o coperti (${JSON.stringify(geometry.controls)})`);
  }
  async function practiceChecks(seat){
    await seat.wait('window.__fixtureReady && document.querySelector("[data-ygo-invite]")','Lobby non pronta per Testa mazzo');
    const before=requests.length,rowsBefore=rows.size,notificationsBefore=notifications.length;
    await seat.evaluate(`window.__fixtures.decks.push({...window.__fixtures.decks[0],id:${JSON.stringify(guestDeckId)},ownerSlug:'duel-guest',name:'Mazzo altrui non selezionabile'})`);
    await seat.cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true,screenOrientation:{type:'portraitPrimary',angle:0}});await delay(100);
    await seat.click('[data-ygo-tab="practice"]');
    await seat.wait('Boolean(document.querySelector("[data-ygo-practice]"))','Selettore Testa mazzo assente');
    const saved=await seat.evaluate('Array.from(document.querySelector("[data-ygo-practice] [name=deckId]").options,option=>option.value)');
    assert(saved.includes(hostDeckId)&&saved.includes(secondHostDeckId),'Testa mazzo non propone entrambi i propri mazzi salvati');
    assert(!saved.includes(guestDeckId),'Testa mazzo propone un mazzo di un altro membro');
    if(saved.includes(invalidHostDeckId)){
      await seat.fill('[data-ygo-practice] [name=deckId]',invalidHostDeckId);
      if(!await seat.evaluate('document.querySelector("[data-ygo-practice] button[type=submit]").disabled')){
        await seat.submit('[data-ygo-practice]');
        await seat.wait('!window.__sim.pending && Boolean(window.__sim.error)','Il mazzo incompleto non viene rifiutato con una spiegazione');
      }
      assert(!await seat.evaluate('window.__sim.practice'),'Il mazzo incompleto ha avviato una prova');
    }
    await seat.fill('[data-ygo-practice] [name=deckId]',secondHostDeckId);await seat.screenshot('practice-picker',false);
    await seat.tap('[data-ygo-practice] button[type="submit"]');
    await seat.wait('window.__sim.practice && window.__sim.session?.phase==="main1" && document.querySelector(".ygo-arena")','Testa mazzo non avvia il proprio mazzo');
    assert.equal(await seat.evaluate('window.__sim.session.players[0].deckName'),'Secondo mazzo salvato · Test');
    assert.equal(await seat.evaluate('window.__sim.session.players[0].hand.length'),5,'La prova non parte da cinque carte');
    await seat.wait('(()=>{const gate=document.querySelector(".ygo-orientation-gate");return gate&&getComputedStyle(gate).display!=="none";})()','La prova verticale non chiede di ruotare il telefono');
    await seat.screenshot('practice-rotate-phone',false);
    await seat.cdp.call('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true,screenOrientation:{type:'landscapePrimary',angle:90}});await delay(100);
    await seat.wait('(()=>{const gate=document.querySelector(".ygo-orientation-gate");return !gate||getComputedStyle(gate).display==="none";})()','La prova orizzontale resta bloccata');
    await seat.tap('[data-ygo-action="draw"]');await seat.wait('window.__sim.session.players[0].hand.length===6','Pesca nella prova non funzionante');
    async function closeDialog(){if(await seat.evaluate('Boolean(document.querySelector(".ygo-card-dialog"))'))await seat.click('.ygo-card-dialog [data-ygo-command="deselect"]');}
    async function practiceMenu(){await closeDialog();if(!await seat.evaluate('window.__sim.menu'))await seat.tap('[data-ygo-command="menu"]');}
    async function findOwnCard(code){
      let id=await seat.evaluate(`window.__sim.session.players[0].hand.find(card=>card.catalogCardId===${JSON.stringify(code)})?.id`);
      if(!id){
        await practiceMenu();await seat.click('[data-ygo-command="inspect-deck"]');
        await seat.wait('Boolean(window.__sim.pile?.cards?.length)','La ricerca locale non apre il mazzo');
        id=await seat.evaluate(`window.__sim.pile.cards.find(card=>card.catalogCardId===${JSON.stringify(code)})?.id`);assert(id,'Carta di prova assente dal mazzo locale');
        await openDetails(seat,`.ygo-zone-cards [data-ygo-card="${id}"]`,'Ricerca locale');await seat.fill('[data-ygo-move] [name=to]','hand');await seat.submit('[data-ygo-move]');
        await seat.wait(`window.__sim.session.players[0].hand.some(card=>card.id===${JSON.stringify(id)})`,'Ricerca → mano locale non applicata');
      }
      return id;
    }
    const monster=await findOwnCard('89631139');
    const beforeDescription=await seat.evaluate('JSON.stringify(window.__sim.session)');
    await seat.hold(`[data-ygo-card="${monster}"][data-player="0"]`,{duration:800,screenshotName:'card-description'});
    await seat.wait('Boolean(document.querySelector(".ygo-card-dialog"))','La pressione ferma non mostra la descrizione della carta');
    assert(!await seat.evaluate('Boolean(document.querySelector(".ygo-drop-menu,.ygo-drag-ghost"))'),'La lettura della carta apre una giocata o un trascinamento');
    assert(await seat.evaluate('Boolean(document.querySelector(".ygo-card-dialog details[data-ygo-advanced]:not([open])"))'),'La descrizione espone subito i comandi avanzati');
    assert.equal(await seat.evaluate('JSON.stringify(window.__sim.session)'),beforeDescription,'Leggere la descrizione modifica il test');
    await closeDialog();
    const beforePracticeDrag=await seat.evaluate('JSON.stringify(window.__sim.session)');
    await seat.pressDrag(`[data-ygo-card="${monster}"][data-player="0"]`,'[data-ygo-slot="0"][data-zone="monsters"][data-player="0"]','drag-active');
    await waitDropMenu(seat,'Drag in Testa mazzo');await seat.screenshot('practice-context-actions',false);await cancelDrop(seat);
    assert.equal(await seat.evaluate('JSON.stringify(window.__sim.session)'),beforePracticeDrag,'Annullare il menu locale modifica il test');
    await delay(250);
    await seat.tap(`[data-ygo-card="${monster}"][data-player="0"]`);await waitDropMenu(seat,'Tocco Mostro locale');
    assert.deepEqual(await seat.evaluate('Array.from(document.querySelectorAll(".ygo-drop-menu [data-ygo-drop-action]"),button=>button.dataset.ygoDropAction).sort()'),['normal','set','special'],'Il tocco sulla mano non propone soltanto le tre giocate del Mostro');
    await seat.screenshot('tap-actions',false);await cancelDrop(seat);
    await seat.cdp.call('Emulation.setDeviceMetricsOverride',{width:740,height:360,deviceScaleFactor:1,mobile:true,screenOrientation:{type:'landscapePrimary',angle:90}});await delay(100);
    await seat.tap(`[data-ygo-card="${monster}"][data-player="0"]`);await waitDropMenu(seat,'Menu Mostro 740×360');await seat.screenshot('tap-actions-740',false);await cancelDrop(seat);
    await seat.cdp.call('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true,screenOrientation:{type:'landscapePrimary',angle:90}});await delay(100);
    await seat.tap(`[data-ygo-card="${monster}"][data-player="0"]`);await waitDropMenu(seat,'Scelta Normal Summon locale');await seat.tap('.ygo-drop-menu [data-ygo-drop-action="normal"]');
    assert(await seat.evaluate(`window.__sim.placing&&window.__sim.session.players[0].hand.some(card=>card.id===${JSON.stringify(monster)})`),'La scelta Normal Summon non attende la destinazione');
    await seat.tap('[data-ygo-slot="0"][data-zone="monsters"][data-player="0"]');
    await seat.wait(`window.__sim.session.players[0].monsters.some(card=>card.id===${JSON.stringify(monster)})`,'Evocazione locale non applicata');
    const facedown=await findOwnCard('46986414');
    await seat.tap(`[data-ygo-card="${facedown}"][data-player="0"]`);await waitDropMenu(seat,'Tocco Set locale');await seat.tap('.ygo-drop-menu [data-ygo-drop-action="set"]');await seat.tap('[data-ygo-slot="1"][data-zone="monsters"][data-player="0"]');
    await seat.wait(`window.__sim.session.players[0].monsters.some(card=>card.id===${JSON.stringify(facedown)}&&!card.faceUp&&card.position==='defense')`,'Carta coperta nella prova non applicata');
    await practiceMenu();await seat.fill('[data-ygo-lp] [name=delta]',-500);await seat.submit('[data-ygo-lp]');await seat.wait('window.__sim.session.players[0].lp===7500','LP locali non modificati');
    assert(!await seat.evaluate('Boolean(document.querySelector("[data-ygo-finish]"))'),'La prova personale offre un risultato multiplayer');
    await seat.click('[data-ygo-command="close-menu"]');
    await assertPhoneFrame(seat,'Testa mazzo 844×390');
    for(const phase of ['draw','standby','main1','battle','main2','end']){await seat.tap(`[data-ygo-action="setPhase"][data-phase="${phase}"]`);await seat.wait(`window.__sim.session.phase===${JSON.stringify(phase)}`,'Chip fase locale non applicato: '+phase);}
    await seat.tap('[data-ygo-action="setPhase"][data-phase="main1"]');await seat.wait('window.__sim.session.phase==="main1"','Ritorno a M1 locale non applicato');
    await seat.tap('[data-ygo-action="nextPhase"]');await seat.wait('window.__sim.session.phase==="battle"','Fase tramite tocco non applicata');
    const turn=await seat.evaluate('window.__sim.session.turn');await seat.tap('[data-ygo-action="nextTurn"]');
    await seat.wait(`window.__sim.session.activePlayer===0&&window.__sim.session.turn===${turn+2}`,'Il test in solitaria non torna al proprio turno');
    await seat.screenshot('practice-landscape',false);
    for(const [width,height]of [[932,430],[740,360]]){await seat.cdp.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true,screenOrientation:{type:'landscapePrimary',angle:90}});await delay(100);await assertPhoneFrame(seat,`Testa mazzo ${width}×${height}`);}
    await seat.cdp.call('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true,screenOrientation:{type:'landscapePrimary',angle:90}});await delay(100);
    await practiceMenu();await seat.click('[data-ygo-command="practice-restart"]');
    await seat.wait('window.__sim.practice&&window.__sim.session.players[0].hand.length===5&&window.__sim.session.players[0].monsters.length===0&&window.__sim.session.turn===1','Ricomincia prova non ripristina mano e campo');
    assert.equal(await seat.evaluate('window.__sim.session.players[0].deckName'),'Secondo mazzo salvato · Test','Ricomincia prova cambia il mazzo selezionato');
    await practiceMenu();await seat.click('[data-ygo-command="practice-exit"]');
    await seat.wait('!window.__sim.practice && Boolean(document.querySelector("[data-ygo-practice]"))','Esci dal test non torna al selettore');
    await seat.evaluate('window.__practiceSavedDecks=window.__fixtures.decks;window.__fixtures.decks=[]');
    await seat.click('[data-ygo-tab="practice"]');
    assert(await seat.evaluate('document.querySelector("[data-ygo-practice] button[type=submit]").disabled && Boolean(document.querySelector(".ygo-simulator [data-page=decks]"))'),'Un profilo senza mazzi non riceve una spiegazione e un avvio disabilitato');
    await seat.evaluate('window.__fixtures.decks=window.__practiceSavedDecks;delete window.__practiceSavedDecks');
    await seat.click('[data-ygo-tab="practice"]');
    assert.equal(rows.size,rowsBefore,'Il test personale crea partite nel servizio');assert.equal(notifications.length,notificationsBefore,'Il test personale invia notifiche');
    assert.deepEqual(requests.slice(before).filter(request=>['invite','accept','action','state','inspect'].includes(request.op)),[],'Le mosse di prova sono state inviate al servizio multiplayer');
    assert(requests.slice(before).some(request=>request.op==='practice'),'Il mazzo salvato non viene recuperato attraverso la lettura autorizzata');
    await seat.click('[data-ygo-tab="table"]');await seat.wait('Boolean(document.querySelector("[data-ygo-invite]"))','Il multiplayer non torna disponibile dopo la prova');
    console.log('PASS Testa mazzo: own saved deck choice, invalid deck guard, local draw/summon/set/LP/turn/restart/exit and no multiplayer writes or notifications');
  }
  const host=await page('duel-host'),guest=await page('duel-guest');
  await practiceChecks(host);
  if(process.argv.includes('--practice-only')){
    assert.deepEqual(exceptions,[],'Eccezioni JavaScript');assert.deepEqual(consoleErrors,[],'Errori console');assert.deepEqual(networkErrors,[],'Risorse mancanti');assert.deepEqual(externalRequests,[],'Richieste esterne inattese');
    console.log('yugioh-practice-browser-smoke: OK');return;
  }
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
  async function openDetails(page,selector,label='Carta'){
    await page.hold(selector);
    await page.wait('Boolean(document.querySelector(".ygo-card-dialog"))',label+': dettagli opzionali assenti');
    assert(!await page.evaluate('Boolean(document.querySelector(".ygo-drop-menu,.ygo-drag-ghost"))'),label+': la pressione ferma apre una giocata');
    if(await page.evaluate('Boolean(document.querySelector(".ygo-card-dialog details[data-ygo-advanced]:not([open])"))'))await page.tap('.ygo-card-dialog details[data-ygo-advanced] > summary');
    await page.wait('Boolean(document.querySelector(".ygo-card-dialog details[data-ygo-advanced][open]"))',label+': comandi avanzati opzionali non aperti');
  }
  async function select(page,viewer,id){await idle(page);await openDetails(page,`[data-ygo-card="${id}"][data-player="${viewer}"]`);}
  async function putInHand(page,viewer,code){
    const player=rows.get(duelId).state.players[viewer],zone=['hand','deck'].find(zone=>player[zone].some(card=>card.catalogCardId===code));
    assert(zone,'Carta di prova assente dalla mano/mazzo: '+code);
    const card=player[zone].find(card=>card.catalogCardId===code);
    if(zone==='deck'){
      await openMenu(page);await page.click('[data-ygo-command="inspect-deck"]');
      await page.wait(`window.__sim.pile?.cards?.some(card=>card.id===${JSON.stringify(card.id)})`,'Ricerca nel mazzo non mostra la carta');
      await openDetails(page,`.ygo-zone-cards [data-ygo-card="${card.id}"]`,'Ricerca nel mazzo');
      await page.fill('[data-ygo-move] [name=to]','hand');await page.submit('[data-ygo-move]');
      await page.wait(`window.__sim.session.players[${viewer}].hand.some(card=>card.id===${JSON.stringify(card.id)})`,'Ricerca → mano non applicata');await idle(page);
    }
    await closeMenu(page);await closePile(page);return card.id;
  }
  async function playHand(page,viewer,code,command,slot){
    const id=await putInHand(page,viewer,code),before=await page.evaluate('JSON.stringify(window.__sim.session)');await page.tap(`[data-ygo-card="${id}"][data-player="${viewer}"]`);await waitDropMenu(page,'Tocco mano '+command);
    assert.equal(await page.evaluate('JSON.stringify(window.__sim.session)'),before,'Il tocco gioca la carta senza scegliere un comando');
    const spell=['set-spell','play-spell'].includes(command);
    assert.deepEqual(await page.evaluate('Array.from(document.querySelectorAll(".ygo-drop-menu [data-ygo-drop-action]"),button=>button.dataset.ygoDropAction).sort()'),spell?['activate','set']:['normal','set','special'],'Il menu della mano contiene giocate secondarie o manca una scelta primaria');
    if(spell)await page.screenshot(code==='97077563'?'trap-actions':'spell-actions',false);
    const quickAction={summon:'normal',defend:'special','set-monster':'set','set-spell':'set','play-spell':'activate'}[command];assert(quickAction,'Comando di prova non supportato: '+command);
    await page.tap(`.ygo-drop-menu [data-ygo-drop-action="${quickAction}"]`);
    await page.wait('Boolean(window.__sim.placing)','La scelta della giocata non chiede una casella');
    assert.equal(await page.evaluate('JSON.stringify(window.__sim.session)'),before,'La scelta della giocata muove la carta senza destinazione');
    const zone=command==='set-spell'||command==='play-spell'?'spells':'monsters';
    await page.tap(`[data-ygo-slot="${slot}"][data-zone="${zone}"][data-player="${viewer}"]`);
    await page.wait(`window.__sim.session.players[${viewer}].${zone}.some(card=>card.id===${JSON.stringify(id)}&&card.slot===${slot})`,'Giocata nella zona corretta non applicata');await idle(page);
    if(command==='defend'){await select(page,viewer,id);await page.click('.ygo-card-dialog [data-ygo-action="setPosition"]');await both(`window.__sim.session.players[${viewer}].monsters.some(card=>card.id===${JSON.stringify(id)}&&card.position==='defense')`,'Difesa tramite comandi avanzati opzionali');}
    return id;
  }
  async function playExtra(page,viewer,code,zone,slot){
    await closeCard(page);await closeMenu(page);await closePile(page);
    await page.click(`[data-ygo-pile="extra"][data-player="${viewer}"]`);
    const id=rows.get(duelId).state.players[viewer].extra.find(card=>card.catalogCardId===code)?.id;
    assert(id,'Carta Extra non disponibile');
    await page.tap(`.ygo-zone-cards [data-ygo-card="${id}"]`);await waitDropMenu(page,'Tocco Extra');await page.tap('.ygo-drop-menu [data-ygo-drop-action="special"]');
    await page.tap(`[data-ygo-slot="${slot}"][data-zone="${zone}"][data-player="${viewer}"]`);
    await both(`window.__sim.session.players[${viewer}].${zone}.some(card=>card.id===${JSON.stringify(id)}&&card.slot===${slot})`,'Evocazione Extra');await idle(page);return id;
  }
  async function waitDropMenu(page,label){
    try{await page.wait('Boolean(document.querySelector(".ygo-drop-menu"))',label+': menu contestuale assente');}
    catch(error){throw new Error(error.message+'\nGesture/render trace: '+JSON.stringify(await page.evaluate('window.__duelQaTrace')));}
    assert(!await page.evaluate('Boolean(document.querySelector(".ygo-card-dialog"))'),label+': il trascinamento apre il pannello grande della carta');
    const menu=await page.evaluate('(()=>{const box=document.querySelector(".ygo-drop-menu").getBoundingClientRect();return{width:box.width,height:box.height,left:box.left,right:box.right,top:box.top,bottom:box.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight};})()');
    assert(menu.width<=160&&menu.height<=130&&menu.left>=0&&menu.right<=menu.viewportWidth+1&&menu.top>=0&&menu.bottom<=menu.viewportHeight+1,label+': menu fuori schermo o troppo grande '+JSON.stringify(menu));
    const content=await page.evaluate('(()=>{const menu=document.querySelector(".ygo-drop-menu");return{actions:menu.querySelectorAll("[data-ygo-drop-action]").length,buttons:menu.querySelectorAll("button").length,extras:Boolean(menu.querySelector("header,h1,h2,h3,footer,.ygo-drop-footer,[data-ygo-command]"))};})()');
    assert(content.actions>=1&&content.actions<=3&&content.buttons===content.actions&&!content.extras,label+': il menu contiene titolo, comandi secondari o più di tre scelte '+JSON.stringify(content));
  }
  async function dragExtra(page,viewer,code,slot){
    await closeCard(page);await closeMenu(page);await closePile(page);await page.click(`[data-ygo-pile="extra"][data-player="${viewer}"]`);
    const id=rows.get(duelId).state.players[viewer].extra.find(card=>card.catalogCardId===code)?.id;assert(id,'Carta Extra per trascinamento assente');
    const before=await page.evaluate('JSON.stringify(window.__sim.session)');
    await page.pressDrag(`.ygo-zone-cards [data-ygo-card="${id}"]`,`[data-ygo-slot="${slot}"][data-zone="extraMonsters"][data-player="${viewer}"]`);await waitDropMenu(page,'Drag dall’Extra Deck');
    assert.equal(await page.evaluate('JSON.stringify(window.__sim.session)'),before,'Il trascinamento dall’Extra evoca prima della scelta');
    assert(!await page.evaluate('Boolean(document.querySelector(".ygo-drop-menu [data-ygo-drop-action=normal]"))'),'Il menu dell’Extra offre una Normal Summon');
    await page.screenshot('context-extra',false);await page.tap('.ygo-drop-menu [data-ygo-drop-action="special"]');
    await both(`window.__sim.session.players[${viewer}].extraMonsters.some(card=>card.id===${JSON.stringify(id)}&&card.slot===${slot}&&card.faceUp)`,'Evocazione Speciale trascinata dall’Extra');return id;
  }
  async function cancelDrop(page){
    await page.cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:2,y:2,radiusX:3,radiusY:3,force:1}]});await page.cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.wait('!document.querySelector(".ygo-drop-menu")','Il menu contestuale non si chiude');
  }
  // Long press + physical touch drag selects a destination; only a menu choice
  // applies a move. A remote update invalidates choices from an older board.
  const draggedMonster=await putInHand(host,0,'91152256'),draggedSelector=`[data-ygo-card="${draggedMonster}"][data-player="0"]`,monsterTarget='[data-ygo-slot="2"][data-zone="monsters"][data-player="0"]';
  const beforeCancelledDrop=await host.evaluate('JSON.stringify(window.__sim.session)');
  await host.pressDrag(draggedSelector,monsterTarget);await waitDropMenu(host,'Drag Mostro');
  assert.equal(await host.evaluate('JSON.stringify(window.__sim.session)'),beforeCancelledDrop,'Il trascinamento muove la carta prima di scegliere un comando');
  await cancelDrop(host);assert.equal(await host.evaluate('JSON.stringify(window.__sim.session)'),beforeCancelledDrop,'Annulla trascinamento modifica la partita');
  await guest.wait(`window.__sim.duel.version===${rows.get(duelId).version}`,'L’ospite non ha ancora ricevuto lo stato prima della prova di aggiornamento remoto');
  await host.pressDrag(draggedSelector,monsterTarget);await waitDropMenu(host,'Drag prima di aggiornamento remoto');
  const versionBeforeDrop=await host.evaluate('window.__sim.duel.version');await guest.click('[data-ygo-action="draw"]');
  await host.wait(`window.__sim.duel.version>${versionBeforeDrop}&&!document.querySelector('.ygo-drop-menu')`,'Il menu con versione superata resta utilizzabile');
  assert(await host.evaluate(`window.__sim.session.players[0].hand.some(card=>card.id===${JSON.stringify(draggedMonster)})`),'L’aggiornamento remoto ha giocato la carta trascinata');
  await host.pressDrag(draggedSelector,monsterTarget);await waitDropMenu(host,'Drag Evoca normalmente');await host.screenshot('context-actions',false);
  await host.tap('.ygo-drop-menu [data-ygo-drop-action="normal"]');
  await both(`window.__sim.session.players[0].monsters.some(card=>card.id===${JSON.stringify(draggedMonster)}&&card.slot===2&&card.faceUp)`,'Evocazione normale scelta dal menu');
  await select(host,0,draggedMonster);await host.click('[data-ygo-command="to-graveyard"]');await both(`window.__sim.session.players[0].graveyard.some(card=>card.id===${JSON.stringify(draggedMonster)})`,'Rimozione Mostro trascinato');
  const specialMonster=await putInHand(host,0,'88819587');
  await host.pressDrag(`[data-ygo-card="${specialMonster}"][data-player="0"]`,monsterTarget);await waitDropMenu(host,'Drag Evoca Specialmente');
  await host.tap('.ygo-drop-menu [data-ygo-drop-action="special"]');
  await both(`window.__sim.session.players[0].monsters.some(card=>card.id===${JSON.stringify(specialMonster)}&&card.slot===2&&card.faceUp)`,'Evocazione Speciale manuale scelta dal menu');
  await select(host,0,specialMonster);await host.click('[data-ygo-command="to-graveyard"]');await both(`window.__sim.session.players[0].graveyard.some(card=>card.id===${JSON.stringify(specialMonster)})`,'Rimozione Mostro evocato Specialmente');
  const draggedSpell=await putInHand(host,0,'5318639'),spellTarget='[data-ygo-slot="1"][data-zone="spells"][data-player="0"]';
  await host.pressDrag(`[data-ygo-card="${draggedSpell}"][data-player="0"]`,spellTarget);await waitDropMenu(host,'Drag Magia coperta');
  await host.tap('.ygo-drop-menu [data-ygo-drop-action="set"]');await guest.wait('window.__sim.session.players[0].spells.some(card=>card.slot===1&&card.hidden)','Posizionamento coperto dal menu rivela la Magia');
  await select(host,0,draggedSpell);await host.click('[data-ygo-command="to-graveyard"]');await both(`window.__sim.session.players[0].graveyard.some(card=>card.id===${JSON.stringify(draggedSpell)})`,'Rimozione Magia posizionata');
  const activatedSpell=await putInHand(host,0,'5318639');
  await host.pressDrag(`[data-ygo-card="${activatedSpell}"][data-player="0"]`,spellTarget);await waitDropMenu(host,'Drag Magia attivata');
  await host.tap('.ygo-drop-menu [data-ygo-drop-action="activate"]');
  await both(`window.__sim.session.players[0].spells.some(card=>card.id===${JSON.stringify(activatedSpell)}&&card.slot===1&&card.faceUp)&&window.__sim.session.chain.some(link=>link.cardId===${JSON.stringify(activatedSpell)})`,'Attivazione dal menu con anello di catena');
  await host.click('.ygo-chain-bar [data-ygo-action="resolveChain"]');await both('window.__sim.session.chain.length===0','Risoluzione Magia trascinata');
  await select(host,0,activatedSpell);await host.click('[data-ygo-command="to-graveyard"]');await both(`window.__sim.session.players[0].graveyard.some(card=>card.id===${JSON.stringify(activatedSpell)})`,'Rimozione Magia attivata');
  console.log('PASS native long-press drag, compact contextual menu, cancellation, stale-menu invalidation, Normal Summon, Spell set/activation and remote synchronization');
  if(process.argv.includes('--drag-only')){assert.deepEqual(exceptions,[]);assert.deepEqual(consoleErrors,[]);console.log('yugioh-duel-browser-smoke --drag-only: OK');return;}
  const setTrap=await playHand(host,0,'97077563','set-spell',0);
  await guest.wait('window.__sim.session.players[0].spells.some(card=>card.slot===0&&card.hidden)','Il Set di una Trappola rivela la carta');
  await host.tap(`[data-ygo-card="${setTrap}"][data-player="0"]`);await waitDropMenu(host,'Tocco Trappola sul campo');
  await host.tap('.ygo-drop-menu [data-ygo-drop-action="activate"]');
  await both(`window.__sim.session.players[0].spells.some(card=>card.id===${JSON.stringify(setTrap)}&&card.slot===0&&card.faceUp)&&window.__sim.session.chain.some(link=>link.cardId===${JSON.stringify(setTrap)})`,'Attivazione Trappola dal campo');
  await host.tap('.ygo-chain-bar [data-ygo-action="resolveChain"]');await both('window.__sim.session.chain.length===0','Risoluzione Trappola dal campo');
  await host.tap(`[data-ygo-card="${setTrap}"][data-player="0"]`);await waitDropMenu(host,'Tocco Trappola attiva');await host.tap('.ygo-drop-menu [data-ygo-drop-action="graveyard"]');await both(`window.__sim.session.players[0].graveyard.some(card=>card.id===${JSON.stringify(setTrap)})`,'Trappola al Cimitero dal menu compatto');
  const handTrap=await playHand(host,0,'97077563','play-spell',0);
  await both(`window.__sim.session.chain.some(link=>link.cardId===${JSON.stringify(handTrap)})`,'Attivazione Trappola manuale dalla mano');
  await host.tap('.ygo-chain-bar [data-ygo-action="resolveChain"]');await both('window.__sim.session.chain.length===0','Risoluzione Trappola dalla mano');
  await host.tap(`[data-ygo-card="${handTrap}"][data-player="0"]`);await waitDropMenu(host,'Tocco seconda Trappola');await host.tap('.ygo-drop-menu [data-ygo-drop-action="graveyard"]');await both(`window.__sim.session.players[0].graveyard.some(card=>card.id===${JSON.stringify(handTrap)})`,'Seconda Trappola al Cimitero');
  assert(await host.evaluate('window.__sim.session.players[1].hand.every(card=>card.hidden&&!card.catalogCardId&&!card.imageUrl)'),'Mano avversaria esposta');
  assert(await host.evaluate('window.__sim.session.players.every(player=>player.deck.every(card=>card.hidden&&!card.catalogCardId&&!card.imageUrl))'),'Ordine del mazzo esposto');
  assert(await host.evaluate('window.__sim.session.players[1].extra.every(card=>card.hidden&&!card.catalogCardId)'),'Extra Deck avversario esposto');
  assert(await host.evaluate('window.__sim.session.players[0].extra.every(card=>!card.hidden&&card.catalogCardId)'),'Extra Deck personale non consultabile');
  const hostMonster=await playHand(host,0,'89631139','summon',4);
  await both(`window.__sim.session.players[0].monsters.some(card=>card.id===${JSON.stringify(hostMonster)}&&card.faceUp)`,'Mostro host pubblico');
  await host.tap(`[data-ygo-card="${hostMonster}"][data-player="0"]`);await waitDropMenu(host,'Tocco effetto Mostro');await host.tap('.ygo-drop-menu [data-ygo-drop-action="activate"]');
  await both(`window.__sim.session.chain.some(link=>link.cardId===${JSON.stringify(hostMonster)})&&window.__sim.session.players[0].monsters.some(card=>card.id===${JSON.stringify(hostMonster)}&&card.slot===4)`,'Effetto dal campo sincronizzato senza spostare il Mostro');
  await host.tap('.ygo-chain-bar [data-ygo-action="resolveChain"]');await both('window.__sim.session.chain.length===0','Risoluzione effetto Mostro');
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
  await host.tap(`[data-ygo-card="${spell}"][data-player="0"]`);await waitDropMenu(host,'Tocco Magia posizionata');await host.tap('.ygo-drop-menu [data-ygo-drop-action="activate"]');
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
  const fusion=await dragExtra(host,0,'23995346',0);
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
  for(const phase of ['draw','standby','main1','battle','main2','end']){
    const selector=`[data-ygo-action="setPhase"][data-phase="${phase}"]`;
    await idle(host);
    if(!await host.evaluate(`window.__sim.session.phase===${JSON.stringify(phase)}`))await host.tap(selector);
    await both(`window.__sim.session.phase===${JSON.stringify(phase)}`,'Chip fase diretto '+phase);
    await idle(host);await idle(guest);
    assert(await host.evaluate(`document.querySelector('[data-ygo-action="setPhase"][data-phase="${phase}"]').closest('li').classList.contains('is-current')`),'Il chip della fase corrente non viene evidenziato: '+phase);
  }
  await host.tap('[data-ygo-action="setPhase"][data-phase="draw"]');await both('window.__sim.session.phase==="draw"','Ritorno Draw tramite chip');
  await host.tap('[data-ygo-action="nextPhase"]');await both('window.__sim.session.phase==="standby"','Cambio fase');
  await host.click('[data-ygo-action="nextTurn"]');await both('window.__sim.session.activePlayer===1&&window.__sim.session.turn===2','Passaggio turno');
  assert(await host.evaluate('document.querySelector("[data-ygo-action=nextTurn]").disabled'),'Giocatore fuori turno può passare il turno');
  assert(await host.evaluate('Array.from(document.querySelectorAll("[data-ygo-action=setPhase]")).every(button=>button.disabled)'),'I chip fase sono utilizzabili fuori turno');
  const otherTurnState=JSON.stringify(rows.get(duelId).state);await host.tap('[data-ygo-action="setPhase"][data-phase="battle"]',true);await delay(100);assert.equal(JSON.stringify(rows.get(duelId).state),otherTurnState,'Un tocco fuori turno modifica la fase');
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
  async function assertPhoneCardFit(page,label){
    await assertPhoneFrame(page,label);
    const geometry=await page.evaluate(`(()=>{
      const describe=zone=>{const card=zone.querySelector('.ygo-card:not(.is-defense)'),image=card?.querySelector('img');if(!card||!image)return null;const box=zone.getBoundingClientRect(),art=image.getBoundingClientRect();return{zone:zone.dataset.zone,width:box.width,height:box.height,artWidth:art.width,artHeight:art.height,ratio:art.height/box.height,objectFit:getComputedStyle(image).objectFit};};
      const normals=Array.from(document.querySelectorAll('.ygo-zone[data-zone="monsters"].is-occupied'),describe).filter(Boolean);
      const extras=Array.from(document.querySelectorAll('.ygo-shared-extra .ygo-zone.is-occupied'),describe).filter(Boolean);
      const defense=Array.from(document.querySelectorAll('.ygo-zone .ygo-card.is-defense')).map(card=>{const zone=card.closest('.ygo-zone').getBoundingClientRect(),box=card.getBoundingClientRect();return{within:box.left>=zone.left-1&&box.right<=zone.right+1&&box.top>=zone.top-1&&box.bottom<=zone.bottom+1};});
      return{normals,extras,defense};
    })()`);
    assert(geometry.normals.length>0&&geometry.extras.length===2,label+': servono Mostri normali ed entrambe le EMZ popolate');
    for(const card of [...geometry.normals,...geometry.extras]){
      assert(card.ratio>=.85&&card.ratio<=1.01,`${label}: carta ${card.zone} non occupa correttamente la casella (${JSON.stringify(card)})`);
      assert.equal(card.objectFit,'contain',label+': artwork deformato o tagliato');
    }
    const normalHeight=geometry.normals[0].artHeight;
    for(const card of geometry.extras)assert(Math.abs(card.artHeight/normalHeight-1)<=.05,`${label}: artwork EMZ più piccolo dei Mostri normali (${JSON.stringify(geometry)})`);
    assert(geometry.defense.every(card=>card.within),label+': Mostro in Difesa supera la propria casella');
    const hiddenPreview=await page.evaluate('(()=>{const preview=document.querySelector(".ygo-idle-preview");return !preview||getComputedStyle(preview).display==="none";})()');
    assert(hiddenPreview,label+': il pannello desktop sottrae spazio al campo sul telefono');
  }
  await host.cdp.call('Emulation.setTouchEmulationEnabled',{enabled:false});
  await host.cdp.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await delay(100);
  await assertArena(host,'Desktop 1440×1000');await host.screenshot('desktop',false);
  await host.cdp.call('Emulation.setDeviceMetricsOverride',{width:1440,height:810,deviceScaleFactor:1,mobile:false});await delay(100);
  await assertArena(host,'Desktop 1440×810');await host.screenshot('desktop-reference',false);
  await host.cdp.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await host.cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true,screenOrientation:{type:'portraitPrimary',angle:0}});await delay(100);
  await host.wait('(()=>{const gate=document.querySelector(".ygo-orientation-gate");return gate&&getComputedStyle(gate).display!=="none"&&gate.getBoundingClientRect().height>0;})()','Il telefono verticale non mostra il blocco Ruota il telefono');
  const beforePortraitTap=await host.evaluate('window.__sim.session.players[0].hand.length');
  await host.tap('[data-ygo-action="draw"]',true);await delay(200);
  assert.equal(await host.evaluate('window.__sim.session.players[0].hand.length'),beforePortraitTap,'Il blocco verticale lascia usare Pesca');
  const portraitState=await host.evaluate('JSON.stringify(window.__sim.session)');
  await host.pressDrag(`[data-ygo-card="${hostMonster}"][data-player="0"]`,'[data-ygo-slot="3"][data-zone="monsters"][data-player="0"]');
  assert(!await host.evaluate('Boolean(document.querySelector(".ygo-drop-menu"))'),'Il trascinamento verticale supera il blocco orientamento');
  assert.equal(await host.evaluate('JSON.stringify(window.__sim.session)'),portraitState,'Il trascinamento verticale modifica il tavolo');
  await host.screenshot('rotate-phone',false);
  await host.cdp.call('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true,screenOrientation:{type:'landscapePrimary',angle:90}});await delay(100);
  await host.wait('(()=>{const gate=document.querySelector(".ygo-orientation-gate");return !gate||getComputedStyle(gate).display==="none"||gate.getBoundingClientRect().height===0;})()','Il blocco orientamento resta sopra il campo orizzontale');
  await assertArena(host,'Smartphone orizzontale 844×390');await assertPhoneCardFit(host,'Smartphone orizzontale 844×390');await host.screenshot('mobile',false);
  // Real touch events, not programmatic clicks, play a hand card into an empty slot.
  const touchCard=await putInHand(host,0,'91152256');
  await host.tap(`[data-ygo-card="${touchCard}"][data-player="0"]`);await waitDropMenu(host,'Giocata touch dopo rotazione');
  await host.screenshot('card',false);
  await host.tap('.ygo-drop-menu [data-ygo-drop-action="normal"]');
  await host.tap('[data-ygo-slot="3"][data-zone="monsters"][data-player="0"]');
  await both(`window.__sim.session.players[0].monsters.some(card=>card.id===${JSON.stringify(touchCard)}&&card.slot===3)`,'Evocazione touch');
  await host.tap(`[data-ygo-card="${touchCard}"][data-player="0"]`);await waitDropMenu(host,'KO touch');
  await host.tap('.ygo-drop-menu [data-ygo-drop-action="graveyard"]');
  await both(`window.__sim.session.players[0].graveyard.some(card=>card.id===${JSON.stringify(touchCard)})`,'KO touch');
  await assertArena(host,'Smartphone orizzontale 844×390');await assertPhoneCardFit(host,'Smartphone orizzontale 844×390');await host.screenshot('landscape',false);
  for(const [width,height]of [[932,430],[740,360]]){
    await host.cdp.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true,screenOrientation:{type:'landscapePrimary',angle:90}});await delay(100);
    await assertArena(host,`Smartphone ${width}×${height}`);await assertPhoneCardFit(host,`Smartphone ${width}×${height}`);await host.screenshot(`landscape-${width}`,false);
  }
  console.log('PASS two-seat privacy/conflicts, phases, remote reload, portrait gate, consistent Main/Extra card sizing and native touch on three landscape phones');

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
