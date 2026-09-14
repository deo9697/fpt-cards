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

  const fs=await import('node:fs/promises');
  const app=await fs.readFile('app.js','utf8');
  const start=app.indexOf('function installCollectionControls()');
  const controls=app.slice(start,app.indexOf('\nfunction ',start+10));
  await evaluate(`(async()=>{
    const {collectionView,collectionResultsView}=await import('/js/collection.js');
    window.collectionFilters={scope:'mine',query:'',owner:'all',status:'all',sort:'name-asc',layout:'grid',facets:{}};
    window.__collection={mine:[{id:'fixture',game:'yugioh',catalogCardId:'44265115',cardName:'Brain Controller',setCode:'ALIN-IT033',quantityAvailable:1,quantityOwned:1,quantityLoaned:0,quantityReserved:0}],team:[]};
    window.collectionTypeObserver={disconnect(){}};window.collectionTypeTimer=null;window.visibleTypeQueue=new Set();window.collectionSearchTimer=null;window.collectionVisibleCount=60;window.COLLECTION_PAGE_SIZE=60;
    window.refreshCollectionResults=(prefetch)=>{if(prefetch!==false)throw Error('Typing enabled remote type prefetch');document.querySelector('[data-collection-results]').innerHTML=collectionResultsView(__collection,collectionFilters,'yugioh',true)};
    document.querySelector('#app').innerHTML=collectionView(__collection,collectionFilters,'yugioh',true);
    window.__fetches=0;window.fetch=()=>{__fetches++;throw Error('Unexpected fetch while typing')};
  })()`);
  await evaluate(controls+';installCollectionControls();');
  for(const query of ['Brain Controller','Controlla Cervello','alin it033','Drago Bianco','']){
    await evaluate(`(()=>{const input=document.querySelector('[data-collection-query]');input.value=${JSON.stringify(query)};input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await delay(260);
    const count=await evaluate(`document.querySelectorAll('[data-collection-item]').length`);
    if(count!==(query==='Drago Bianco'?0:1))throw Error('Wrong browser results for '+query);
  }
  if(await evaluate('__fetches'))throw Error('Search made network requests');
  console.log('PASS real collection input handler: EN/IT/set code/negative/clear, zero fetch and no decorative prefetch');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
