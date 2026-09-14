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

  const fs = await import('node:fs/promises');
  const app = await fs.readFile('app.js','utf8');
  const closeFunction = app.slice(app.indexOf('function closeCollectionDetail()'),app.indexOf('// Resolve only'));
  const binding = app.split('\n').find(line=>line.includes("querySelectorAll('[data-close-collection-detail]')"));
  await evaluate(`window.__calls=0;window.__renders=0;window.selectedCollectionItem='card';window.render=()=>{__renders++};history.replaceState(null,'','#/home');history.pushState(null,'','#/collection');history.pushState({collectionDetail:'card'},'','#/collection');window.__back=history.back.bind(history);history.back=()=>{__calls++;__back()};`);
  await evaluate(closeFunction);
  await evaluate(`document.querySelector('#app').innerHTML='<div class="detail-backdrop" data-close-collection-detail><aside><button class="detail-close" data-close-collection-detail><span>X</span></button><p>Content</p></aside></div>';`);
  await evaluate(binding);
  await evaluate(`document.querySelector('aside p').click();if(__calls)throw Error('Content closed modal');document.querySelector('.detail-close span').click();document.querySelector('.detail-close').click();`);
  await delay(200);
  const result=await evaluate(`({calls:__calls,hash:location.hash,selected:selectedCollectionItem,renders:__renders})`);
  if(result.calls!==1||result.hash!=='#/collection'||result.selected||result.renders!==1)throw Error(JSON.stringify(result));
  for (const [file,selector,key,field] of [
    ['js/market-watch.js','data-market-detail-close','marketDetail','selected'],
    ['js/market-watch.js','data-market-deck-close','marketDeckDetail','selectedDeck'],
    ['js/decks.js','data-deck-search-close','deckSearch','searchOpen']
  ]) {
    const source=await fs.readFile(file,'utf8');
    const line=source.split('\n').find(line=>line.includes('querySelector')&&line.includes(selector)&&line.includes('history.back'));
    await evaluate(`__calls=0;history.replaceState(null,'','#/target');history.pushState({[${JSON.stringify(key)}]:${field==='searchOpen'?'true':"'card'"}},'','#/target');document.querySelector('#app').innerHTML='<div ${selector}><aside><button class="detail-close" ${selector}>X</button></aside></div>';window.__controller={${field}:${field==='searchOpen'?'true':"'card'"},onRender(){},closeSearch(){this.searchOpen=false}};`);
    await evaluate('(function(root){'+line+'}).call(__controller,document)');
    await evaluate(`document.querySelector('.detail-close').click();document.querySelector('.detail-close').click();`);
    await delay(150);
    if(!await evaluate(`__calls===1&&location.hash==='#/target'&&!__controller.${field}`))throw Error('Close failed: '+selector);
  }
  console.log('PASS actual collection close handler: nested X, double click, one history traversal, collection preserved');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
