// SPDX-License-Identifier: AGPL-3.0-or-later
// Real phone UI -> personal service -> bounded native WASM worker.
// Only identities/storage are fixtures; card effects are never mocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createDuelHandler} from '../api/yugioh-duel.js';
import {runAutoOperation,projectAutoStateSafe} from '../api/_yugioh-auto-executor.js';
import {createAutoState} from '../api/_yugioh-auto-core.js';
import {loadAutoResources} from '../api/_yugioh-auto-resources.js';

const root=process.cwd(),directory=path.join(root,'artifacts','yugioh-auto-practice');fs.mkdirSync(directory,{recursive:true});
const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
const seed='d1435612789abcde'.repeat(4),teamId='11111111-1111-4111-8111-111111111111',deckId='a0000000-0000-4000-8000-000000000001';
const member={slug:'practice-host',name:'Alice · Test personale',teamId},other={slug:'practice-other',name:'Bob · Team',teamId};
const people=[member,other],resources=await loadAutoResources(),C={FOOLISH:81439173,ALEX:43096270,ZEPHYROS:14785765};
const normal=[...resources.cards.values()].filter(card=>card.ot>0&&card.ot<=3&&(card.ot&2)&&card.type===17&&card.level<=4&&card.attack>0&&!Object.values(C).includes(card.code)).slice(0,40).map(card=>card.code);
const initial=await createAutoState({decks:[{main:normal},{main:normal}],seed});
const positions=initial.publicViews[0].players[0].hand.map(card=>normal.indexOf(card.code)),codes=[...normal];
[C.FOOLISH,C.ALEX].forEach((code,index)=>{codes[positions[index]]=code;});codes[codes.findIndex((_,index)=>!positions.includes(index))]=C.ZEPHYROS;
const cardRow=code=>{const card=resources.cards.get(code);return{catalogCardId:String(code),cardName:card.name,section:'main',quantity:1,type:card.type&1?card.type&32?'Effect Monster':'Normal Monster':card.type&2?'Spell Card':'Trap Card',atk:card.attack,def:card.defense,level:card.level,imageUrl:'/previewcard/'+code+'.jpg',text:card.desc};};
const deck={id:deckId,ownerSlug:member.slug,game:'yugioh',persisted:true,name:'Combo personale · Zephyros',cards:codes.map(cardRow)},originalDeck=JSON.stringify(deck);
const practiceRows=new Map(),requests=[],notifications=[],pvpWrites=[],unknownApis=[];
const key=(team,slug)=>team+':'+slug;
const store={
  members:async team=>team===teamId?clone(people):[],pushMembers:async()=>[],list:async()=>[],get:async()=>null,meta:async()=>null,recentCount:async()=>0,
  deck:async(id,slug)=>id===deckId&&slug===member.slug?clone(deck):null,
  insert:async row=>{pvpWrites.push({op:'insert',id:row.id});throw Error('Personal practice must not create a PvP row');},
  update:async id=>{pvpWrites.push({op:'update',id});throw Error('Personal practice must not update a PvP row');}
};
const practices={
  get:async(team,slug)=>clone(practiceRows.get(key(team,slug))||null),
  insert:async row=>{const owner=key(row.team_id,row.owner_slug);if(practiceRows.has(owner))return null;practiceRows.set(owner,clone(row));return clone(row);},
  update:async(id,version,team,slug,patch)=>{const owner=key(team,slug),row=practiceRows.get(owner);if(!row||row.id!==id||row.version!==version)return null;const next={...row,...clone(patch)};practiceRows.set(owner,next);return clone(next);}
};
const runtime={project:projectAutoStateSafe,run:(operation,payload)=>runAutoOperation(operation,operation==='createPractice'?{...payload,seed}:payload)};
const handler=createDuelHandler({env:{SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-not-a-key'},databaseFactory:()=>({authenticate:async token=>{assert.equal(token,member.slug);return clone(member);},store,practices}),notify:async(_database,payload)=>{notifications.push(payload);return{push:'sent'};},autoRuntime:runtime});
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2'};
const art=code=>{const file=path.join(root,'artifacts','yugioh-auto','cards',code+'.jpg');return fs.existsSync(file)?file:path.join(root,'assets','game-logos','yugioh.png');};
const server=http.createServer(async(request,response)=>{
  const url=new URL(request.url,'http://localhost'),json=(status,body)=>response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(body));
  if(url.pathname==='/favicon.ico'){response.writeHead(204).end();return;}
  if(url.pathname==='/__duel-fixtures'){json(200,{...member,teamId,members:people,decks:[deck],catalog:Object.fromEntries(deck.cards.map(card=>[card.catalogCardId,card]))});return;}
  if(url.pathname==='/api/yugioh-duel'&&request.method==='POST'){
    try{let body='';for await(const chunk of request)body+=chunk;const payload=JSON.parse(body);requests.push({op:payload.op,type:payload.action?.type,duelId:payload.duelId});request.body=payload;response.status=code=>{response.statusCode=code;return response;};response.json=value=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(value));return response;};await handler(request,response);}catch(error){json(error.status||500,{code:error.code,message:error.message,...(error.duel?{duel:error.duel}:{})});}return;
  }
  if(url.pathname.startsWith('/api/')){unknownApis.push(url.pathname);json(404,{message:'Unexpected API in practice fixture'});return;}
  if(url.pathname.startsWith('/previewcard/')){const file=art(path.basename(url.pathname,'.jpg'));response.setHeader('Content-Type',path.extname(file)==='.jpg'?'image/jpeg':'image/png');response.end(fs.readFileSync(file));return;}
  const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(root+path.sep)){response.writeHead(403).end();return;}
  try{response.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');response.setHeader('Cache-Control','no-store');response.end(fs.readFileSync(file));}catch{response.writeHead(404).end('Not found');}
});
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);assert(chrome);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser,profile;const sockets=[],exceptions=[],consoleErrors=[],networkErrors=[];
class Cdp{
  constructor(socket){this.socket=socket;this.id=0;this.pending=new Map();this.handlers=new Map();socket.onmessage=event=>{const message=JSON.parse(event.data),task=this.pending.get(message.id);if(task){this.pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Error(message.error.message)):task.resolve(message.result);return;}for(const handler of this.handlers.get(message.method)||[])handler(message.params);};}
  call(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timeout '+method));},15000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  on(name,fn){this.handlers.set(name,[...(this.handlers.get(name)||[]),fn]);}
}
async function connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});sockets.push(socket);return new Cdp(socket);}
async function readJson(url){for(let attempt=0;attempt<100;attempt++){try{const result=await fetch(url);if(result.ok)return result.json();}catch{}await delay(50);}throw Error('Chrome unavailable: '+url);}
async function freePort(){const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));return port;}

async function run(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,port=await freePort();
  profile=path.resolve(os.tmpdir(),'fpt-ygo-practice-'+Date.now()+'-'+process.pid);browser=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true});
  const controller=await connect((await readJson('http://127.0.0.1:'+port+'/json/version')).webSocketDebuggerUrl);
  const target=await controller.call('Target.createTarget',{url:'about:blank'}),targets=await readJson('http://127.0.0.1:'+port+'/json/list'),cdp=await connect(targets.find(item=>item.id===target.targetId).webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown',event=>exceptions.push(event.exceptionDetails?.exception?.description||event.exceptionDetails?.text));
  cdp.on('Runtime.consoleAPICalled',event=>{if(event.type==='error')consoleErrors.push(event.args.map(item=>item.value||item.description||'').join(' '));});
  cdp.on('Network.responseReceived',event=>{if(event.response.status>=400)networkErrors.push(event.response.status+' '+event.response.url);});
  await cdp.call('Runtime.enable');await cdp.call('Network.enable');await cdp.call('Page.enable');await cdp.call('Fetch.enable',{patterns:[{urlPattern:'https://images.ygoprodeck.com/*'}]});
  cdp.on('Fetch.requestPaused',event=>{const file=art(path.basename(new URL(event.request.url).pathname,'.jpg'));void cdp.call('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:path.extname(file)==='.jpg'?'image/jpeg':'image/png'}],body:fs.readFileSync(file).toString('base64')}).catch(error=>exceptions.push(error.message));});
  await cdp.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  const metrics=(width,height)=>cdp.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true,screenOrientation:{type:width>height?'landscapePrimary':'portraitPrimary',angle:width>height?90:0}});
  await metrics(844,390);
  const evaluate=async expression=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
  const screenshot=async name=>{await evaluate('document.fonts.ready');await delay(80);const result=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(directory,name+'.png'),Buffer.from(result.data,'base64'));};
  const wait=async(expression,label)=>{for(let attempt=0;attempt<180;attempt++){if(await evaluate(expression))return;await delay(60);}await screenshot('failure');throw Error(label+'\n'+await evaluate('document.body.innerText.slice(0,2400)')+'\n'+JSON.stringify(exceptions));};
  const tap=async selector=>{const point=await evaluate('(()=>{const node=document.querySelector('+JSON.stringify(selector)+');if(!node||node.disabled)throw Error("Missing/disabled "+'+JSON.stringify(selector)+');node.scrollIntoView({block:"center",inline:"center"});const r=node.getBoundingClientRect(),x=Math.max(1,Math.min(innerWidth-1,(r.left+r.right)/2)),y=Math.max(1,Math.min(innerHeight-1,(r.top+r.bottom)/2)),hit=document.elementFromPoint(x,y);return{x,y,blocked:hit!==node&&!node.contains(hit),hit:hit?.className||hit?.tagName};})()');if(point.blocked){await screenshot('failure');throw Error('Native touch target covered: '+selector+' by '+point.hit);}await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,radiusX:3,radiusY:3,force:1}]});await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
  const fill=(selector,value)=>evaluate('(()=>{const node=document.querySelector('+JSON.stringify(selector)+');node.value='+JSON.stringify(value)+';node.dispatchEvent(new Event("input",{bubbles:true}));node.dispatchEvent(new Event("change",{bubbles:true}));})()');
  const openPractice=async()=>{await wait('window.__fixtureReady&&window.__sim.ready','fixture initialization');if(!await evaluate('Boolean(document.querySelector("[data-ygo-practice]"))'))await tap('[data-ygo-tab="practice"]');await wait('Boolean(document.querySelector("[data-ygo-practice]"))','personal deck composer');};
  const option=async id=>{const version=await evaluate('window.__sim.duel.version');if(await evaluate('Boolean(document.querySelector('+JSON.stringify('[data-ygo-pick="'+id+'"]')+'))')){await tap('[data-ygo-pick="'+id+'"]');await screenshot('phone-pick-sheet');await tap('[data-ygo-pick-choose="'+id+'"]');}else{if(!await evaluate('Boolean(document.querySelector('+JSON.stringify('[data-ygo-auto-option="'+id+'"]')+'))'))await tap('[data-ygo-command="auto-expand"]');await tap('[data-ygo-auto-option="'+id+'"]');}if(await evaluate('Boolean(document.querySelector("[data-ygo-command=auto-confirm]:not([disabled])"))'))await tap('[data-ygo-command="auto-confirm"]');await wait('window.__sim.duel.version>'+version+'&&!window.__sim.pending','automatic choice '+id);};
  const geometryTests=[];
  const checkCompactTargets=async label=>{
    const result=await evaluate('(()=>{const nodes=[...document.querySelectorAll(".ygo-playmat [data-ygo-pile],.ygo-playmat [data-zone=monsters][data-slot],.ygo-playmat [data-zone=spells][data-slot]")];return{viewport:[innerWidth,innerHeight],compact:!!document.querySelector(".ygo-auto-prompt.is-compact"),targets:nodes.map(node=>{const r=node.getBoundingClientRect(),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return{player:node.dataset.player,zone:node.dataset.ygoPile||node.dataset.zone,slot:node.dataset.slot,coveredByCompact:!!hit?.closest(".ygo-auto-prompt.is-compact"),reachable:hit===node||node.contains(hit),disabled:node.disabled===true,hit:hit?.className||hit?.tagName};})};})()');
    assert(result.compact,'Expected the idle compact controls to be open');assert.equal(result.targets.filter(row=>['monsters','spells'].includes(row.zone)).length,20);
    const blocked=result.targets.filter(row=>row.coveredByCompact||!row.disabled&&!row.reachable);if(blocked.length){await screenshot('failure');assert.fail('Compact controls cover phone targets: '+JSON.stringify({label,viewport:result.viewport,blocked}));}
    geometryTests.push({label,...result});
  };
  const settle=async()=>{for(let step=0;step<80;step++){const prompt=await evaluate('window.__sim.session.auto.prompt');if(prompt?.kind==='idle'&&prompt.player===0)return;assert(prompt,'No personal actor prompt');assert.equal(prompt.player,0,'Passive seat must be processed on server');assert.notEqual(prompt.kind,'idle');if(prompt.kind==='place'&&prompt.min===1){const place=prompt.options.find(row=>row.place?.player===0&&row.place.sequence<5&&[4,8].includes(row.place.location));if(place){const version=await evaluate('window.__sim.duel.version');await tap('.ygo-playmat [data-ygo-auto-option="'+place.id+'"]');if(await evaluate('Boolean(document.querySelector("[data-ygo-command=auto-confirm]:not([disabled])"))'))await tap('[data-ygo-command="auto-confirm"]');await wait('window.__sim.duel.version>'+version+'&&!window.__sim.pending','native touch legal placement');continue;}}await option(prompt.options.find(row=>row.id==='pass')?.id||prompt.options.find(row=>row.id==='no')?.id||prompt.options[0]?.id);}throw Error('Too many automatic practice choices');};
  const command=async(predicate,pile)=>{
    const selected=(await evaluate('window.__sim.session.auto.prompt')).options.find(predicate);assert(selected,'Expected legal command');
    if(!pile){await option(selected.id);return;}
    await tap('[data-ygo-pile="'+pile+'"][data-player="0"]');await wait('Boolean(document.querySelector(".ygo-zone-dialog"))','graveyard gallery');
    const card=await evaluate('window.__sim.session.players[0]['+JSON.stringify(pile)+'].find(card=>card.controller==='+selected.card.controller+'&&card.location==='+selected.card.location+'&&card.sequence==='+selected.card.sequence+')');assert(card);
    await tap('.ygo-zone-dialog [data-ygo-card="'+card.id+'"]');await wait('Boolean(document.querySelector(".ygo-drop-menu"))','compact off-field legal actions');const version=await evaluate('window.__sim.duel.version');await screenshot('phone-844-graveyard-action');await tap('.ygo-drop-menu [data-ygo-drop-action="'+selected.id+'"]');await wait('window.__sim.duel.version>'+version+'&&!window.__sim.pending','GY automatic activation');
  };
  await cdp.call('Page.navigate',{url:origin+'/scripts/fixtures/yugioh-duel-harness.html?member='+member.slug});await openPractice();
  assert.equal(await evaluate('document.querySelector("[data-ygo-practice] [name=mode]").value'),'auto','Automatic is the personal-test default');
  assert(await evaluate('Boolean(document.querySelector("[data-ygo-practice] [name=mode] option[value=manual]"))'),'Manual remains explicit');
  await screenshot('phone-844-composer');await fill('[data-ygo-practice] [name="deckId"]',deckId);await tap('[data-ygo-practice] button[type="submit"]');
  await wait('window.__sim.practice&&window.__sim.session?.mode==="auto"&&window.__sim.duel?.status==="playing"&&!window.__sim.pending','real automatic practice start');await settle();
  let session=await evaluate('window.__sim.session');assert.equal(await evaluate('window.__sim.duel.practice'),true);assert.equal(session.activePlayer,0);assert(session.players[1].hand.every(card=>card.hidden));
  for(const key of ['seed','initialDecks','inputs','pendingMessage','publicViews'])assert(!(key in session),key+' leaked');
  assert.equal(await evaluate('document.querySelectorAll("[data-ygo-action=lp],[data-ygo-action=move],[data-ygo-action=drawEffect]").length'),0);
  await command(row=>row.action==='summon'&&row.card?.code===C.ALEX);await settle();
  await command(row=>row.action==='activate'&&row.card?.code===C.FOOLISH);
  for(let step=0;step<40;step++){const prompt=await evaluate('window.__sim.session.auto.prompt');if(prompt.kind==='idle')break;const target=prompt.options.find(row=>row.card?.code===C.ZEPHYROS);await option(target?.id||prompt.options.find(row=>row.id==='pass')?.id||prompt.options.find(row=>row.id==='no')?.id||prompt.options[0].id);}
  await wait('window.__sim.session.players[0].graveyard.some(card=>card.code==='+C.ZEPHYROS+')','Foolish Burial sends real Zephyros to GY');
  for(const[width,height]of[[844,390],[740,360]]){await metrics(width,height);await delay(70);await checkCompactTargets('live GY effect available');}
  await metrics(844,390);
  await command(row=>row.action==='activate'&&row.card?.code===C.ZEPHYROS,'graveyard');await settle();
  await wait('window.__sim.session.players[0].lp===7600&&window.__sim.session.players[0].monsters.some(card=>card.code==='+C.ZEPHYROS+')&&window.__sim.session.players[0].hand.some(card=>card.code==='+C.ALEX+')','GY cost, actual summon and damage');await screenshot('phone-844-gy-resolved');
  await command(row=>row.id==='to_ep');await settle();session=await evaluate('window.__sim.session');assert.equal(session.activePlayer,0);assert.equal(session.turn,3,'Passive turn is processed by core');assert.equal(await evaluate('window.__sim.session.auto.prompt.player'),0);
  const playedId=await evaluate('window.__sim.duel.id'),playedVersion=await evaluate('window.__sim.duel.version');
  for(const[width,height]of[[844,390],[740,360]]){await metrics(width,height);await delay(70);const box=await evaluate('(()=>{const r=document.querySelector(".ygo-playmat").getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()');assert(box.left>=0&&box.right<=width+1&&box.top>=0&&box.bottom<=height+1,JSON.stringify(box));await checkCompactTargets('after passive turn');await screenshot('phone-'+width+'-played');}
  await tap('[data-ygo-command="practice-exit"]');await wait('Boolean(document.querySelector("[data-ygo-practice]"))','return to personal decks');assert.equal(await evaluate('document.fullscreenElement===null'),true);
  await cdp.call('Page.reload');await openPractice();await wait('Boolean(document.querySelector("[data-ygo-command=practice-resume]"))','resume saved personal session');await tap('[data-ygo-command="practice-resume"]');
  await wait('window.__sim.duel?.id==='+JSON.stringify(playedId)+'&&window.__sim.duel.version==='+playedVersion+'&&window.__sim.session?.players[0].lp===7600','resume exact private state after reload');await screenshot('phone-740-resumed');
  await tap('[data-ygo-command="menu"]');await tap('[data-ygo-command="practice-restart"]');await wait('window.__sim.practice&&window.__sim.session?.mode==="auto"&&window.__sim.duel?.id!=='+JSON.stringify(playedId)+'&&!window.__sim.pending','restart fresh personal test');await settle();
  assert.equal(await evaluate('window.__sim.session.players[0].lp'),8000);assert.equal(await evaluate('window.__sim.session.turn'),1);assert.equal(await evaluate('window.__sim.session.players[0].monsters.length'),0);
  await metrics(390,844);await wait('(()=>{const gate=document.querySelector(".ygo-orientation-gate");return gate&&getComputedStyle(gate).display!=="none";})()','portrait gate');await screenshot('phone-portrait-gate');
  const actionCount=requests.filter(row=>row.op==='practiceAction').length;await evaluate('window.__sim.act({type:"lp",delta:99999})');assert.equal(requests.filter(row=>row.op==='practiceAction').length,actionCount,'Manual command not sent');
  await tap('.ygo-orientation-gate [data-ygo-command="practice-exit"]');await wait('Boolean(document.querySelector("[data-ygo-practice]"))','exit portrait gate');assert.equal(await evaluate('document.fullscreenElement===null'),true);await evaluate('window.__sim.reset()');
  assert.equal(practiceRows.size,1);assert.equal(JSON.stringify(deck),originalDeck);assert.deepEqual(pvpWrites,[]);assert.deepEqual(notifications,[]);assert.deepEqual(unknownApis,[]);
  assert(!requests.some(row=>['invite','accept','action','inspect','search'].includes(row.op)),'Personal practice must not call PvP/manual endpoints');assert(requests.filter(row=>row.op==='practiceAction').every(row=>row.type==='autoRespond'));
  assert.deepEqual(exceptions,[]);assert.deepEqual(consoleErrors,[]);assert.deepEqual(networkErrors,[]);
  fs.writeFileSync(path.join(directory,'browser-verification.json'),JSON.stringify({passed:true,viewports:['844x390','740x360','390x844'],requests,practiceRows:practiceRows.size,pvpRows:0,notifications:0,statsWrites:0,actualEffect:'Foolish Burial -> GY Zephyros -> return own monster -> summon -> 400 LP',restart:true,reloadResume:true,geometryTests,exceptions,consoleErrors,networkErrors},null,2));
  console.log('PASS actual phone personal auto test: default auto/manual choice, real GY activation/cost/summon/damage, passive turn, resume/restart, privacy, landscape and zero PvP/notifications/stats.');
}
const deadline=setTimeout(()=>{console.error('Practice browser smoke exceeded two minutes.');process.exitCode=1;browser?.kill();server.close();},120000);
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{clearTimeout(deadline);for(const socket of sockets){try{socket.close();}catch{}}try{browser?.kill();}catch{}if(browser&&browser.exitCode===null)await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),delay(2000)]);await new Promise(resolve=>server.close(resolve));const temporaryRoot=path.resolve(os.tmpdir()),target=profile&&path.resolve(profile);if(target&&path.dirname(target)===temporaryRoot&&path.basename(target).startsWith('fpt-ygo-practice-')){try{fs.rmSync(target,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch{}}});
