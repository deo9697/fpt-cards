// Web Vitals debug (js/performance-vitals.js): logica pura + browser reale.
// - senza ?debugPerf=1 index.html NON scarica il modulo (UX invariata)
// - con il modulo attivo arrivano LCP/INP/CLS/FCP/TTFB, nessuna richiesta di
//   rete oltre alla libreria stessa (qui servita da node_modules, così il
//   test non dipende dal CDN).
// Richiede il preview server (lo avvia da solo se non è già attivo).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { perfDebugEnabled, formatVital, createVitalsStore, recordVital, WEB_VITALS_VERSION } from '../js/performance-vitals.js';
import pkg from '../package.json' with { type: 'json' };

assert.equal(perfDebugEnabled({ search: '?debugPerf=1' }), true);
assert.equal(perfDebugEnabled({ search: '?debugPerf=0' }), false);
assert.equal(perfDebugEnabled({ search: '' }), false);
assert.equal(formatVital('CLS', 0.12345), '0.123');
assert.equal(formatVital('LCP', 1234.6), '1235 ms');
assert.equal(formatVital('INP', NaN), '—');
const store = createVitalsStore();
recordVital(store, { name: 'LCP', value: 900, delta: 900, rating: 'good', id: 'v1', navigationType: 'navigate' });
recordVital(store, { name: 'LCP', value: 1300, delta: 400, rating: 'good', id: 'v1', navigationType: 'navigate' });
assert.equal(store.metrics.LCP.value, 1300); assert.equal(store.history.length, 2);
assert.equal(pkg.dependencies['web-vitals'], WEB_VITALS_VERSION, 'versione web-vitals in package.json e nel modulo (URL CDN) devono coincidere');
console.log('PASS logica: flag, formattazione, store, versione allineata a package.json');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-vitals-smoke-')), port = 9394;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let previewServer = null;
if (!(await fetch('http://localhost:8080/index.html').then(() => true).catch(() => false))) {
  previewServer = spawn(process.execPath, ['scripts/preview-server.mjs'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 50; i++) { if (await fetch('http://localhost:8080/index.html').then(() => true).catch(() => false)) break; await delay(100); }
}
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=390,844', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  let target; for (let i = 0; i < 80 && !target; i++) { try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await delay(150); } }
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map(), requests = [];
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url); const task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  // 1) Senza flag: index.html reale, il modulo non deve essere richiesto.
  await send('Page.navigate', { url: 'http://localhost:8080/index.html' }); await delay(2500);
  const noFlag = { moduleRequested: requests.some(url => url.includes('performance-vitals.js') || url.includes('web-vitals')), store: await evaluate('typeof window.__fptVitals') };
  assert.equal(noFlag.moduleRequested, false, 'senza ?debugPerf=1 il modulo non deve essere scaricato: ' + JSON.stringify(noFlag));
  assert.equal(noFlag.store, 'undefined');
  console.log('PASS senza ?debugPerf=1: nessun download del modulo né della libreria, UX invariata');

  // 2) Modulo attivo (libreria locale da node_modules): arrivano le 5 metriche.
  requests.length = 0;
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/collection-share-harness.html?debugPerf=1' }); await delay(500);
  await evaluate(`document.querySelector('#app').innerHTML='<h1 style="font-size:48px;margin:40px 16px">FPT Cards</h1><button id="tap" style="margin:16px;width:200px;height:60px">Tap</button><p style="margin:16px">'+'Lorem '.repeat(80)+'</p>'`);
  await evaluate(`import('/js/performance-vitals.js').then(m => m.startPerformanceVitals({loader: () => import('/node_modules/web-vitals/dist/web-vitals.js')})).then(() => true)`);
  await delay(400);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: 116, y: 160, button: 'left', clickCount: 1 });
  await delay(600);
  // CLS e INP vengono finalizzati quando la pagina diventa nascosta.
  await evaluate(`Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true}); document.dispatchEvent(new Event('visibilitychange')); true`);
  await delay(400);
  const result = await evaluate(`({names: Object.keys(window.__fptVitals?.metrics||{}).sort(), overlay: document.querySelector('#fpt-vitals-debug')?.innerText||''})`);
  const external = requests.filter(url => !url.startsWith('http://localhost:8080/') && !url.startsWith('data:'));
  for (const name of ['CLS', 'FCP', 'INP', 'LCP', 'TTFB']) assert(result.names.includes(name), `metrica ${name} mancante: ${JSON.stringify(result)}`);
  assert.equal(external.length, 0, 'nessuna richiesta di rete esterna attesa: ' + JSON.stringify(external));
  assert(result.overlay.includes('LCP'), 'riquadro debug assente');
  console.log('PASS ?debugPerf=1: LCP, INP, CLS, FCP, TTFB raccolti in window.__fptVitals + riquadro debug; 0 richieste di rete esterne');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}
