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


  await evaluate(`document.head.insertAdjacentHTML('afterbegin','<base href="/">');`);
  const artData='data:image/png;base64,'+(await (await import('node:fs/promises')).readFile(process.argv[2]||'assets/fpt-card-hero.png')).toString('base64');
  await evaluate('window.__testArtwork='+JSON.stringify(artData));
  await evaluate(`(async()=>{const {dashboardView,bindDashboardCarousel}=await import('/js/dashboard.js');const rows=Array.from({length:6},(_,i)=>({cardName:['Ghost Belle & Haunted Mansion','Phantom of Yubel','Mitsurugi Sacred Boundary'][i%3],setCode:'DUDE-EN004',rarity:'Ultra Rare',printingId:String(i),imageUrl:window.__testArtwork,referencePrice:12.5,baselinePrice:10,positiveChange:i<3?30-i*5:-15-i*5}));document.querySelector('#app').innerHTML=dashboardView({currentUser:'daniele',loans:[]},'yugioh',{featuredMovers:rows,featuredHistory:new Map(rows.map((row,i)=>[row.printingId,Array.from({length:10},(_,j)=>({price:i<3?8+j*.5+Math.sin(j):15-j*.4+Math.sin(j),capturedAt:new Date(Date.UTC(2026,8,j+1)).toISOString()}))]))});bindDashboardCarousel();})()`);
  for (const width of [360,390,768,1440]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:width<900});
    const check=await evaluate(`(()=>{const panel=document.querySelector('.market-movers-panel');return {rows:panel.querySelectorAll('.market-art-card').length,overflow:panel.scrollWidth>panel.clientWidth,groups:panel.querySelectorAll('.market-art-carousel').length,height:panel.getBoundingClientRect().height}})()`);
    if(check.rows!==6||check.groups!==1||check.overflow||check.height>650)throw Error(JSON.stringify({width,...check}));
  }
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:1100,deviceScaleFactor:1,mobile:true});
  await evaluate(`document.querySelector('.market-movers-panel').scrollIntoView();`);
  await evaluate(`Promise.all([...document.querySelectorAll('.market-art-background')].map(img=>{img.loading='eager';return img.decode();}))`);
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate(`document.querySelector('[data-mover-step="1"]').click()`);
  await delay(150);
  if(await evaluate(`document.querySelector('[data-mover-position]').textContent`)!=='2 / 6')throw Error('Next control failed');
  const swipe=await evaluate(`(()=>{const el=document.querySelector('.market-art-carousel');el.scrollLeft=el.clientWidth;return el.scrollWidth>el.clientWidth;})()`);
  if(!swipe)throw Error('Carousel not scrollable');
  await evaluate(`document.querySelector('.market-art-carousel').scrollLeft=0`);
  const fs=await import('node:fs/promises');const shot=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(tmpdir(),'fpt-dashboard-trends.png'),Buffer.from(shot.data,'base64'));
  if((await evaluate('window.__consoleErrors')).length)throw Error('Browser errors');
  console.log('PASS dashboard rankings: 360/390/768/1440px, six rows, no panel overflow.');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
