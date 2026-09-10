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
    const {collectionDetailView}=await import('/js/collection.js');
    document.head.insertAdjacentHTML('afterbegin','<base href="/">');
    window.__card={id:'mine-1',printingId:'printing-1',game:'yugioh',cardName:'Ghost Belle & Haunted Mansion',setCode:'DUDE-EN004',rarity:'Ultra Rare',language:'Italiano',condition:'Near Mint',edition:'1ª Edizione',quantityOwned:5,quantityLoaned:0,quantityReserved:0,quantityAvailable:5,imageUrl:'assets/fpt-card-hero.png'};
    window.__detail=(online=true,prices=[{printingId:'printing-1',referencePrice:12.5}])=>{document.querySelector('#app').innerHTML=collectionDetailView('mine-1','mine',{mine:[__card],team:[]},online,'me',prices);};
    __detail();
  })()`);
  await evaluate('document.querySelector(".detail-art img").decode()');
  for(const width of [360,390,1280]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<700});
    const check=await evaluate(`(()=>{const modal=document.querySelector('.inventory-detail');return {overflow:modal.scrollWidth>modal.clientWidth+1,stats:[...modal.querySelectorAll('dd')].map(x=>x.textContent),buttons:modal.querySelectorAll('[data-collection-loan],[data-collection-edit],[data-collection-delete],[data-market-watch-add]').length}})()`);
    if(check.overflow||check.buttons!==4||JSON.stringify(check.stats)!=='["5","0","0","5"]')throw Error(JSON.stringify(check));
  }
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  const screenshot=path.join(tmpdir(),'fpt-collection-detail.png');
  const shot=await send('Page.captureScreenshot',{format:'png'});
  await (await import('node:fs/promises')).writeFile(screenshot,Buffer.from(shot.data,'base64'));
  console.log('Screenshot: '+screenshot);
  await evaluate('__detail(false,[])');
  if(!await evaluate(`[...document.querySelectorAll('[data-collection-loan],[data-collection-edit],[data-collection-delete],[data-market-watch-add]')].every(b=>b.disabled)&&document.body.textContent.includes('Prezzo non disponibile')`))throw Error('Offline actions or missing price failed');
  await evaluate('__card.quantityAvailable=0;__detail()');
  if(!await evaluate(`document.querySelector('[data-collection-loan]').disabled&&document.querySelector('.inventory-availability').textContent.includes('Non disponibile')`))throw Error('Zero availability failure');
  await evaluate(`__card.printingId='';__detail()`);
  if(!await evaluate(`document.querySelector('[data-market-watch-add]').disabled&&document.body.textContent.includes('Prezzo non disponibile')`))throw Error('Unmapped printing uses wrong price/watch action');
  if((await evaluate('__consoleErrors')).length)throw Error('Browser errors');
  console.log('PASS collection detail responsive layout, quantities, action identifiers, offline, unavailable and unmapped price states');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
