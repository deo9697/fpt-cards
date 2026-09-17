import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';

const root=process.cwd(),tempRoot=path.resolve(tmpdir()),profile=await fs.mkdtemp(path.join(tempRoot,'fpt-scan-browser-'));
const output=path.join(root,'docs','fast-scan-verification');await fs.mkdir(output,{recursive:true});
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="it"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>Fast Scan local fixture</title><body><main id="app"></main></body></html>');return;}
  const target=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!target.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.svg')?'image/svg+xml':'application/octet-stream');res.end(await fs.readFile(target));
 }catch{res.writeHead(404).end();}
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=`http://127.0.0.1:${server.address().port}`,port=9376;
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let socket;const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 let target;for(let i=0;i<80;i++){try{target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();break;}catch{await delay(100);}}
 if(!target)throw Error('Chrome DevTools unavailable');
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 let id=0;const pending=new Map(),errors=[];
 socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);const task=pending.get(message.id);if(task){pending.delete(message.id);message.error?task.reject(Error(message.error.message)):task.resolve(message.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});socket.send(JSON.stringify({id:requestId,method,params}));});
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
 const screenshot=async name=>{const result=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));};
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Network.setBlockedURLs',{urls:['https://*']});
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await send('Page.navigate',{url:address});await delay(250);
 await evaluate(`(async()=>{
 const {FastScanController}=await import('/js/fast-scan.js');
 window.card={printingId:'a',game:'yugioh',catalogCardId:'1',cardName:'Drago di prova',setCode:'LOB-IT001',rarity:'Ultra Rare',imageUrl:'/icon.svg'};
 window.c=new FastScanController({camera:{stream:{},stop(){},focusSupported:false},paddleOcr:{prepare:async()=>{}},isOnline:()=>true,onRender:()=>render(),onRoute(){},onToast(){}});
 c.phase='scanning';c.schedule=()=>{};c.reattachVideo=()=>{};window.render=()=>{document.querySelector('#app').innerHTML=c.view();c.bind(document);};
 for(let i=0;i<7;i++)c.buffer.add(card);c.currentScanId=c.buffer.scanEvents.at(-1).id;render();
 })()`);
 // Flusso minimale 2026-09-17: nessun pannello persistente/cronologia nel
 // live view. Solo l'indicatore "N carte" tappabile, il chooser inline per
 // una vera ambiguità, e il feedback transitorio (mai un pannello fisso).
 assert.equal(await evaluate(`document.querySelector('[data-scan-capture]').textContent.trim()`),'Prossima carta');
 assert.equal(await evaluate(`document.querySelector('[data-scan-history]')`),null,'nessuna cronologia persistente nel live view');
 assert.equal(await evaluate(`document.querySelector('[data-scan-history-review]').textContent.trim()`),'7 carte');
 assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true);
 await screenshot('01-confirmed-mobile');
 await evaluate(`const scan=c.buffer.createScan();c.buffer.queueReview({id:scan.id,code:card.setCode,matches:[card,{...card,printingId:'rare',rarity:'Rare'}],warning:'Scegli la rarità'});c.currentScanId=scan.id;c.refreshHud();`);
 assert.equal(await evaluate(`document.querySelector('[data-scan-capture]').disabled`),true,'una vera ambiguità blocca lo scatto finché non risolta inline');
 assert.equal(await evaluate(`document.querySelectorAll('[data-scan-choice]').length`),2);
 assert.match(await evaluate(`document.querySelector('.scan-ambiguous strong').textContent`),/Quale carta è\?/);
 assert.ok(await evaluate(`Boolean(document.querySelector('[data-scan-retry]'))`),'Riprova foto disponibile sull\'ambiguità');
 await screenshot('02-review-required-mobile');
 await evaluate(`document.querySelector('[data-scan-choice="1"]').click()`);assert.equal(await evaluate(`c.currentScan.rarity`),'Rare');assert.equal(await evaluate('c.buffer.total'),8);
 assert.equal(await evaluate(`document.querySelector('[data-scan-capture]').disabled`),false,'una scelta confermata sblocca subito lo scatto successivo');
 // Una verifica di rete in corso (PENDING_REMOTE) non blocca più lo scatto:
 // non deve comparire alcun pannello, e il pulsante resta abilitato.
 await evaluate(`const next=c.buffer.createScan();c.buffer.queueReview({id:next.id,code:card.setCode,matches:[],pending:true});c.currentScanId=next.id;c.refreshHud();`);
 assert.equal(await evaluate(`document.querySelector('[data-scan-capture]').disabled`),false,'la verifica in background non deve bloccare lo scatto successivo');
 assert.equal(await evaluate(`document.querySelector('[data-scan-assistant]').innerHTML.trim()`),'','nessun pannello persistente durante una verifica in corso');
 await send('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true});await screenshot('04-landscape');
 assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true);
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await evaluate(`document.querySelector('[data-scan-history-review]').click()`);await delay(100);assert.equal(await evaluate('c.phase'),'review');assert.equal(await evaluate(`document.querySelectorAll('[data-scan-history] li').length`),9);
 await screenshot('03-history-mobile');
 await evaluate(`document.querySelector('[data-scan-history] [data-scan-undo]').click()`);assert.equal(await evaluate(`c.buffer.scanEvents.at(-1).status`),'CANCELLED','Annulla ultimo scatto resta disponibile nella schermata di sessione');
 await evaluate(`document.querySelector('[data-scan-history] [data-scan-edit]').click()`);assert.equal(await evaluate('c.phase'),'review');assert.equal(await evaluate(`document.querySelector('[data-scan-manual-sheet]').classList.contains('hidden')`),false);
 await evaluate(`document.querySelector('[data-scan-manual-close]').click()`);assert.equal(await evaluate('c.phase'),'review');
 assert.deepEqual(errors,[]);console.log('PASS assisted browser: live view minimale (nessuna cronologia/pannello persistente), badge tappabile, chooser inline per ambiguità reale, background non bloccante, cronologia completa nella review; no JS exceptions.');
}finally{
 try{socket?.close();}catch{}chrome.kill();server.close();
 // Only the temporary profile created by this script can be deleted.
 if(path.dirname(path.resolve(profile))!==tempRoot||!path.basename(profile).startsWith('fpt-scan-browser-'))throw Error('Unexpected cleanup target');
 await fs.rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:200}).catch(()=>{});
}
