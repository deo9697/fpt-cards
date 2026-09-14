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
  const html=await fs.readFile('index.html','utf8');
  const launch=html.slice(html.indexOf('  <div id="app-launch"'),html.indexOf('  <script src="js/app-launch.js"'));
  const script=await fs.readFile('js/app-launch.js','utf8');
  await evaluate(`document.head.insertAdjacentHTML('afterbegin','<base href="/">');document.body.insertAdjacentHTML('afterbegin',${JSON.stringify(launch)});document.querySelector('#app').innerHTML='<div class="login-loading">Loading</div>';`);
  await evaluate(script);
  await evaluate('document.querySelector(".app-launch-art").decode()');
  for (const [width,height] of [[390,844],[1440,900],[844,390]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<900});
    const check=await evaluate(`(()=>{const splash=document.querySelector('#app-launch'),art=document.querySelector('.app-launch-art').getBoundingClientRect();return {overflow:splash.scrollWidth>innerWidth,art:art.left>=0&&art.right<=innerWidth,visible:!splash.classList.contains('is-ready')}})()`);
    if(check.overflow||!check.art||!check.visible)throw Error(JSON.stringify(check));
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await delay(750);
  const screenshot=path.join(tmpdir(),'fpt-app-launch.png');
  const shot=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile(screenshot,Buffer.from(shot.data,'base64'));
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  if(!await evaluate(`getComputedStyle(document.querySelector('.app-launch-art')).animationName==='none'`))throw Error('Reduced motion ignored');
  await evaluate(`document.querySelector('#app').innerHTML='<main class="app-shell">Ready</main>'`);
  await delay(500);
  if(await evaluate('!!document.querySelector("#app-launch")'))throw Error('Splash blocked ready app');
  await evaluate(`document.querySelector('#app').innerHTML='';document.body.insertAdjacentHTML('afterbegin',${JSON.stringify(launch)});`);
  await evaluate(script);
  await delay(6500);
  if(await evaluate('!!document.querySelector("#app-launch")'))throw Error('Fallback failed');
  console.log('PASS startup panorama: portrait/desktop/landscape, ready dismissal, reduced motion, stalled startup fallback. Screenshot: '+screenshot);
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
