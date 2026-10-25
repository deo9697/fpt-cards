// Dashboard Market Watch "Vetrina" (2026-10-25) — verifica reale in Chrome:
// nessun overflow a 360/390/768/1440 px, artwork decodificati davvero (hero,
// scaffale, movers), grafico della carta in evidenza, nessun errore console.
// Stessa fixture isolata di dashboard-trends-browser-smoke (solo #app +
// styles.css, mai index.html che bootstrappa l'app e riscrive #app).
// Argomento opzionale: "real" usa gli artwork veri (rete) per lo screenshot.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-dashboard-vetrina-smoke-')), port = 9374;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const realArtwork = process.argv[2] === 'real';

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
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/collection-share-harness.html' });
  await delay(500);
  await evaluate(`window.__consoleErrors = []; window.addEventListener('error', e => window.__consoleErrors.push(String(e.message)));`);
  await evaluate(`document.head.insertAdjacentHTML('afterbegin','<base href="/">');`);
  const artData = 'data:image/png;base64,' + (await readFile('icon-192.png')).toString('base64');
  await evaluate('window.__testArtwork=' + JSON.stringify(artData) + ';window.__realArtwork=' + JSON.stringify(realArtwork));

  const setup = await evaluate(`(async()=>{
    const {dashboardView, bindDashboardCarousel} = await import('/js/dashboard.js');
    const {mapDashboardOverview} = await import('/js/market-watch.js');
    const art = id => window.__realArtwork ? {catalogCardId:id, imageUrl:''} : {catalogCardId:'', imageUrl:window.__testArtwork};
    const card = (printingId, id, cardName, setCode, rarity, price, extra={}) => ({printingId, ...art(id), cardName, setCode, rarity, quantity:1, price, ...extra});
    const overview = mapDashboardOverview({
      value:'2186.25', change7:{eur:'9.34',base:'2048.22',cards:2855}, change30:{eur:'65.09',base:'1992.47',cards:2855},
      top:[card('p1','98476659','Pot of Sloth','CORI-IT061','Secret Rare','55.15',{price7:'54.39',price30:'58.24'}),
        card('p2','88305705','Brave-Eyes Pendulum Dragon','RATE-IT039','Secret Rare','17.62'),
        card('p3','38033121','Dark Magician Girl','PGLD-EN033','Gold Rare','15.36'),
        card('p4','74820316','Enlilgirsu, the Orcust Mekk-Knight','BLMM-EN053','Ultra Rare','14.96'),
        card('p5','43892409','Dark Magician Girl the Dragon Knight','DRLG-IT004','Secret Rare','14.61')],
      movers:[card('m1','1784686','The Eye of Timaeus','DRLG-IT005','Secret Rare','9.22',{quantity:2,price7:'7.34',deltaEur:'3.76'}),
        card('m2','6165656','Number C88: Gimmick Puppet Disaster Leo','PGLD-EN021','Gold Secret Rare','5.94',{price7:'2.62',deltaEur:'3.32'}),
        card('m3','6351147','Transaction Rollback','MP24-EN134','Prismatic Secret Rare','1.69',{quantity:3,price7:'0.64',deltaEur:'3.15'}),
        card('m4','88305705','Brave-Eyes Pendulum Dragon','RATE-IT039','Secret Rare','17.62',{price7:'20.73',deltaEur:'-3.11'})],
      signals:{aboveMonthAverage:8,duplicatesValue:'63.88',duplicates:[{cardName:'Super Polymerization',quantity:6,spare:'26.55'}],estimated:472}
    });
    const day = 86400000, now = Date.UTC(2026,9,25);
    const hist = [58.24,58.26,57.9,53.72,53.72,52.87,52.87,53.28,53.47,54.39,54.39,54.39,53.9,54.13,54.32,54.32,55.15];
    const featuredHistory = new Map([['p1', hist.map((price,i)=>({price, capturedAt:new Date(now-(hist.length-1-i)*day).toISOString()}))]]);
    document.querySelector('#app').innerHTML = dashboardView({currentUser:'daniele', loans:[]}, 'yugioh', {overview, portfolioValue:2186.25, featuredHistory});
    bindDashboardCarousel();
    return true;
  })()`);
  if (!setup) throw new Error('Setup Dashboard fallito');

  for (const width of [360, 390, 768, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1400, deviceScaleFactor: 1, mobile: width < 900 });
    const check = await evaluate(`(()=>{
      const panel = document.querySelector('.market-vetrina');
      const overflow = document.body.getBoundingClientRect().width > innerWidth + 1;
      const inner = [...panel.querySelectorAll('.mv-hero,.mv-shelf,.mv-value,.mv-movers,.mv-signals')].some(el => el.scrollWidth > el.clientWidth + 1);
      const r = panel.getBoundingClientRect();
      return {shelf: panel.querySelectorAll('.mv-shelf-card').length, movers: panel.querySelectorAll('.mv-mover').length, chips: panel.querySelectorAll('.mv-signal').length,
        chart: !!panel.querySelector('.mv-hero .market-featured-chart svg'), overflow, inner, panelRight: r.right <= innerWidth + 1, carousel: !!panel.querySelector('.market-featured-slide')};
    })()`);
    if (check.shelf !== 4 || check.movers !== 4 || check.chips !== 3 || !check.chart || check.overflow || check.inner || !check.panelRight || check.carousel) throw Error(`Layout Vetrina non valido a ${width}px: ${JSON.stringify(check)}`);
  }
  console.log('PASS Vetrina senza overflow a 360/390/768/1440px: hero con grafico, 4 carte in vetrina, 4 movers, 3 segnali');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1500, deviceScaleFactor: 2, mobile: true });
  const artCheck = await evaluate(`(async()=>{
    const imgs = [...document.querySelectorAll('.market-vetrina img.market-featured-art')];
    await Promise.all(imgs.map(img => { img.loading='eager'; return img.decode().catch(()=>null); }));
    await new Promise(r => setTimeout(r, ${realArtwork ? 2500 : 100}));
    const hero = document.querySelector('.mv-hero-art').getBoundingClientRect();
    return {count: imgs.length, decoded: imgs.filter(img => img.naturalWidth > 0).length, heroHeight: Math.round(hero.height), fit: getComputedStyle(imgs[0]).objectFit};
  })()`);
  if (artCheck.count !== 9 || artCheck.decoded !== 9 || artCheck.fit !== 'cover' || artCheck.heroHeight < 280) throw Error('Artwork Vetrina non validi: ' + JSON.stringify(artCheck));
  console.log('PASS artwork Vetrina: 9 immagini decodificate (hero ' + artCheck.heroHeight + 'px), object-fit:cover');

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const box = await evaluate(`(()=>{const r=document.querySelector('.market-vetrina').getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height};})()`);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, scale: 1 } });
  const screenshotPath = path.join(tmpdir(), realArtwork ? 'fpt-dashboard-vetrina-real.png' : 'fpt-dashboard-vetrina.png');
  await writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));
  if ((await evaluate('window.__consoleErrors')).length) throw Error('Errori console imprevisti: ' + JSON.stringify(await evaluate('window.__consoleErrors')));
  console.log('PASS dashboard-vetrina-browser (browser reale). Screenshot: ' + screenshotPath);
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
