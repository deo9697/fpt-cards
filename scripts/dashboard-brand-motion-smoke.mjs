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
    const {dashboardView}=await import('/js/dashboard.js');
    document.head.insertAdjacentHTML('afterbegin','<base href="/">'); document.body.dataset.game='yugioh';
    const markup=dashboardView({currentUser:null,loans:[]},'yugioh');
    document.querySelector('#app').innerHTML='<div style="padding:16px;max-width:1100px;margin:auto"><div class="xp-bar large"><i style="--progress:64"></i></div>'+markup+'</div>';
  })()`);
  await delay(400);
  for (const width of [390,1280]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<600});
    const check=await evaluate(`(()=>{const banner=document.querySelector('.duel-game-logo'),img=banner.querySelector('img'),fill=document.querySelector('.xp-bar>i');return{overflow:document.documentElement.scrollWidth>innerWidth,logo:img.getAttribute('src'),loaded:img.complete&&img.naturalWidth>0,banner:banner.getBoundingClientRect().width,parent:banner.parentElement.getBoundingClientRect().width,liquid:getComputedStyle(fill,'::before').animationName,flag:getComputedStyle(banner,'::before').animationName}})()`);
    if(check.overflow||!check.loaded||!check.logo.endsWith('yugioh-tcg.png')||Math.abs(check.banner-check.parent)>2||check.liquid!=='xp-juice-current'||check.flag!=='game-standard-folds')throw Error(JSON.stringify(check));
  }
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  const capture=await send('Page.captureScreenshot',{format:'png'});
  const screenshot=path.join(tmpdir(),'fpt-dashboard-banner-xp.png');
  await (await import('node:fs/promises')).writeFile(screenshot,Buffer.from(capture.data,'base64'));
  console.log('Screenshot: '+screenshot);
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const reduced=await evaluate(`getComputedStyle(document.querySelector('.xp-bar>i'),'::before').animationName`);
  if(reduced!=='none')throw Error('Reduced motion not respected');
  console.log('PASS official TCG logo, full-width banner, fluid XP, mobile/desktop overflow, reduced motion');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
