// PoC scansione assistita (js/fast-scan-crop-assist.js) in Chrome reale:
// immagine → Cropper.js → canvas → createOcrInputPlan() e normalizeSetCode()
// di produzione. Solo l'OCR (PaddleOCR) è sostituito da uno stub, così il test
// non scarica il modello dal CDN; Cropper è servito da node_modules.
// Verifica anche: nessuna richiesta di rete esterna, Fast Scan importabile e
// invariato (il PoC non lo tocca). Richiede il preview server (lo avvia se serve).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { CROPPER_VERSION } from '../js/fast-scan-crop-assist.js';

assert.equal(pkg.dependencies.cropperjs, CROPPER_VERSION, 'versione cropperjs in package.json e nel modulo (URL CDN) devono coincidere');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-crop-smoke-')), port = 9395;
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
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/collection-share-harness.html' }); await delay(500);
  requests.length = 0;
  const result = await evaluate(`(async()=>{
    const assist = await import('/js/fast-scan-crop-assist.js');
    const { createOcrInputPlan, FastScanController } = await import('/js/fast-scan.js');
    const { normalizeSetCode } = await import('/js/fast-scan-core.js');
    // "Foto" sintetica: carta chiara con il codice set in basso a destra.
    const photo = document.createElement('canvas'); photo.width = 1200; photo.height = 1700;
    const g = photo.getContext('2d'); g.fillStyle = '#d9c9a3'; g.fillRect(0,0,1200,1700); g.fillStyle = '#5a3a22'; g.fillRect(60,60,1080,1580);
    g.fillStyle = '#e9e1cc'; g.fillRect(120,1180,960,380); g.fillStyle = '#111'; g.font = 'bold 54px Arial'; g.fillText('LOB-EN001', 760, 1150);
    const img = new Image(); img.src = photo.toDataURL('image/jpeg', .92); await img.decode();
    img.style.maxWidth = '100%'; document.querySelector('#app').replaceChildren(img);
    const Cropper = await assist.loadCropper({ loader: () => import('/node_modules/cropperjs/dist/cropper.esm.js'), cssUrl: '/node_modules/cropperjs/dist/cropper.min.css' });
    const cropper = await new Promise(resolve => { const c = assist.createCropSession(img, Cropper, { ready() { resolve(c); } }); });
    cropper.setData({ x: 740, y: 1092, width: 330, height: 76 });
    const canvas = assist.croppedCodeCanvas(cropper);
    let ocrInput = null;
    const out = await assist.recognizeCroppedCode(canvas, {
      createPlan: createOcrInputPlan,
      recognize: async input => { ocrInput = { width: input.width, height: input.height, mode: input.dataset?.ocrInput }; return { text: 'LOB-EN001', confidence: 0.97 }; },
      normalize: normalizeSetCode
    });
    cropper.destroy();
    return { cropped: { w: canvas.width, h: canvas.height }, ocrInput, code: out.code, cssLinked: !!document.querySelector('link[data-cropper-css]'), controller: typeof FastScanController };
  })()`);
  const external = requests.filter(url => !url.startsWith('http://localhost:8080/') && !url.startsWith('data:') && !url.startsWith('blob:'));
  assert.equal(result.controller, 'function', 'Fast Scan deve restare importabile e invariato');
  assert(result.cropped.w >= 300 && result.cropped.h > 76, 'ritaglio + padding verticale attesi: ' + JSON.stringify(result.cropped));
  assert.equal(result.ocrInput?.width, 900, 'il canvas passato all\'OCR deve essere quello del piano di produzione (900px): ' + JSON.stringify(result.ocrInput));
  assert.equal(result.ocrInput?.mode, 'grayscale');
  assert.equal(result.code?.valid, true); assert.equal(result.code?.code, 'LOB-EN001');
  assert(result.cssLinked, 'CSS di Cropper non collegato');
  assert.equal(external.length, 0, 'nessuna richiesta esterna attesa: ' + JSON.stringify(external));
  console.log('PASS PoC scansione assistita: Cropper → canvas ' + result.cropped.w + 'x' + result.cropped.h + ' (con margine) → createOcrInputPlan (900px grayscale) → normalizeSetCode = ' + result.code.code + '; 0 richieste esterne; Fast Scan invariato');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}
