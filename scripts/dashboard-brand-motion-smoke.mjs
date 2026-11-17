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

  // Home "Vetrina compatta" (2026-11-17): la bandiera neon a tutta larghezza
  // è sostituita dal logo ufficiale dentro l'unico riquadro d'apertura, con
  // saluto, livello e la carta di maggior valore (intera, una volta sola).
  await evaluate(`(async()=>{
    const {dashboardView,bindDashboardCarousel}=await import('/js/dashboard.js');
    document.head.insertAdjacentHTML('afterbegin','<base href="/">'); document.body.dataset.game='yugioh';
    const top=n=>({printingId:'p'+n,catalogCardId:'card-'+n,cardName:'Carta '+n,imageUrl:'/icon-192.png?'+n,price:90-n*10,price7:80-n*10,quantity:1});
    const market={portfolioValue:2186.25,overview:{value:2186.25,change7:{eur:17.2,base:2169,cards:30},top:[top(1),top(2),top(3),top(4)]}};
    const profile={level:5,progress:80,currentXp:220,nextXp:275,title:'Tonno',avatarHtml:'<i class="mini-avatar">DD</i>',cardCount:32,winRate:58,matches:12,missions:[]};
    const markup=dashboardView({currentUser:'daniele',loans:[]},'yugioh',market,profile);
    document.querySelector('#app').innerHTML='<div style="padding:16px;max-width:1100px;margin:auto"><div class="xp-bar large"><i style="--progress:64"></i></div>'+markup+'</div>';
    bindDashboardCarousel(document);
  })()`);
  await delay(600);
  for (const width of [390,1280]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<600});
    await delay(150);
    const check=await evaluate(`(()=>{const hero=document.querySelector('.hv-hero'),logo=hero.querySelector('.hv-logo'),card=hero.querySelector('.hv-card .hv-card-img'),fill=document.querySelector('.xp-bar>i'),stats=[...document.querySelectorAll('.hv-stats button')];
      return{overflow:document.documentElement.scrollWidth>innerWidth,logo:logo.getAttribute('src'),logoLoaded:logo.complete&&logo.naturalWidth>0,cardLoaded:card.complete&&card.naturalWidth>0,
        heroes:document.querySelectorAll('.hv-hero').length,flags:document.querySelectorAll('.duel-game-logo,.game-neon').length,
        topCardTimes:[...document.querySelectorAll('img.hv-card-img')].filter(img=>img.getAttribute('src').endsWith('?1')).length,strip:document.querySelectorAll('.hv-tile').length,
        stats:stats.length,statsInside:stats.every(b=>b.getBoundingClientRect().right<=innerWidth+0.5),greeting:hero.querySelector('h2').textContent,liquid:getComputedStyle(fill,'::before').animationName}})()`);
    if(check.overflow||!check.logoLoaded||!check.logo.endsWith('yugioh-tcg.png')||!check.cardLoaded||check.heroes!==1||check.flags!==0||check.topCardTimes!==1||check.strip!==3||check.stats!==3||!check.statsInside||!check.greeting.includes('Daniele')||check.liquid!=='fpt-fluid-wave')throw Error(width+' '+JSON.stringify(check));
  }
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  const capture=await send('Page.captureScreenshot',{format:'png'});
  const screenshot=path.join(tmpdir(),'fpt-dashboard-banner-xp.png');
  await (await import('node:fs/promises')).writeFile(screenshot,Buffer.from(capture.data,'base64'));
  console.log('Screenshot: '+screenshot);
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const reduced=await evaluate(`getComputedStyle(document.querySelector('.xp-bar>i'),'::before').animationName`);
  if(reduced!=='none')throw Error('Reduced motion not respected '+reduced);
  console.log('PASS Home Vetrina: logo ufficiale nel riquadro d\'apertura (nessuna bandiera), carta più preziosa una volta sola, 3 pezzi forti, 3 numeri dentro lo schermo, XP fluido, nessun overflow mobile/desktop, reduced motion');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
