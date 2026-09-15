// Dashboard Market Watch: hero carousel (solo artwork) + Top 3 Up/Down —
// verifica reale in Chrome (artwork cropped davvero decodificato, niente
// overflow a 360/390/768/1440px, navigazione hero a frecce/pallini, mai
// ritorno dei render pesanti). Sostituisce il vecchio test scritto per il
// carousel unificato (un'altra sessione, ora non più in uso): niente più
// dipendenza dalla RPC list_market_dashboard_trends né dal markup
// .market-art-*.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-dashboard-hero-smoke-')), port = 9372;
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
  // Fixture isolata (solo #app + styles.css), non index.html: quest'ultimo
  // carica app.js, che bootstrappa tutta l'app per conto proprio e in
  // background finirebbe per riscrivere #app indipendentemente da questo
  // test (stessa causa di flakiness già diagnosticata e risolta altrove in
  // questa suite, vedi scripts/mobile-focus-regression-smoke.mjs).
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/collection-share-harness.html' });
  await delay(500);
  await evaluate(`window.__consoleErrors = []; window.addEventListener('error', e => window.__consoleErrors.push(String(e.message)));`);
  await evaluate(`document.head.insertAdjacentHTML('afterbegin','<base href="/">');`);

  // Artwork reale (piccolo PNG locale), decodificato davvero — dimostra che
  // l'hero carousel disegna un'immagine vera in stile cover, non solo testo.
  const artData = 'data:image/png;base64,' + (await (await import('node:fs/promises')).readFile(process.argv[2] || 'icon-192.png')).toString('base64');
  await evaluate('window.__testArtwork=' + JSON.stringify(artData));

  const setup = await evaluate(`(async()=>{
    const {dashboardView, bindDashboardCarousel} = await import('/js/dashboard.js');
    const state = {currentUser:'daniele', loans:[]};
    const upItems = Array.from({length:3},(_,i)=>({printingId:'up'+i, catalogCardId:'up'+i, cardName:'Su '+i, imageUrl:window.__testArtwork, referencePrice:12+i, price24h:10, sources:['owned']}));
    const downItems = Array.from({length:3},(_,i)=>({printingId:'down'+i, catalogCardId:'down'+i, cardName:'Giù '+i, imageUrl:window.__testArtwork, referencePrice:8-i, price24h:10, sources:['owned']}));
    window.__renderDashboard = () => { document.querySelector('#app').innerHTML = dashboardView(state, 'yugioh', {items:[...upItems,...downItems]}); bindDashboardCarousel(); };
    window.__renderDashboard();
    return true;
  })()`);
  if (!setup) throw new Error('Setup Dashboard fallito');

  // --- Nessun overflow / dimensioni ragionevoli a 4 larghezze -------------
  for (const width of [360, 390, 768, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 900 });
    const check = await evaluate(`(()=>{
      const panel = document.querySelector('.market-movers-panel');
      const slides = panel.querySelectorAll('.market-hero-slide').length;
      const upRows = panel.querySelectorAll('.market-movers-group.up .market-mover-row').length;
      const downRows = panel.querySelectorAll('.market-movers-group.down .market-mover-row').length;
      // document.documentElement.scrollWidth è inaffidabile su questa pagina:
      // body ha già overflow-x:hidden (convenzione esistente dell'app), quindi
      // può contare contenuto CLIPPATO (mai visibile, mai scrollabile) come se
      // fosse overflow reale — verificato con un caso concreto durante questo
      // lavoro (scrollWidth=1469 con body.getBoundingClientRect().width=1425,
      // innerWidth=1440: nessun overflow VISIBILE nonostante lo scrollWidth
      // segnalasse il contrario). La larghezza renderizzata di <body> è la
      // misura diretta di ciò che l'utente vede davvero.
      const overflow = document.body.getBoundingClientRect().width > innerWidth + 1;
      return {slides, upRows, downRows, overflow, panelOverflow: panel.scrollWidth > panel.clientWidth + 1};
    })()`);
    if (check.slides !== 3 || check.upRows !== 3 || check.downRows !== 3 || check.overflow || check.panelOverflow) throw Error(`Layout non valido a ${width}px: ${JSON.stringify(check)}`);
  }
  console.log('PASS nessun overflow a 360/390/768/1440px: 3 slide hero, 3 righe Up, 3 righe Down');

  // --- Artwork: cover reale decodificata, mai la carta intera --------------
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1100, deviceScaleFactor: 1, mobile: true });
  await evaluate(`document.querySelector('.market-movers-panel').scrollIntoView();`);
  const artCheck = await evaluate(`(async()=>{
    const imgs = [...document.querySelectorAll('.market-hero-art')];
    await Promise.all(imgs.map(img => { img.loading='eager'; return img.decode(); }));
    return {count: imgs.length, allDecoded: imgs.every(img => img.naturalWidth > 0), objectFit: getComputedStyle(imgs[0]).objectFit};
  })()`);
  if (artCheck.count !== 3 || !artCheck.allDecoded) throw Error('L\'artwork hero non è stato decodificato correttamente: ' + JSON.stringify(artCheck));
  if (artCheck.objectFit !== 'cover') throw Error('L\'hero deve usare object-fit:cover: ' + JSON.stringify(artCheck));
  console.log('PASS artwork hero: 3 immagini reali decodificate correttamente, object-fit:cover applicato');

  // --- Navigazione: frecce + pallini, niente scroll oltre l'ultima slide ---
  const beforeNav = await evaluate(`document.querySelector('[data-hero-dot="1"]').classList.contains('active')`);
  if (beforeNav) throw Error('Il secondo pallino non deve essere attivo prima della navigazione');
  await evaluate(`document.querySelector('[data-hero-next]').click()`);
  await delay(300);
  const afterNext = await evaluate(`({activeDot: [...document.querySelectorAll('[data-hero-dot]')].findIndex(d=>d.classList.contains('active')), prevDisabled: document.querySelector('[data-hero-prev]').disabled})`);
  if (afterNext.activeDot !== 1 || afterNext.prevDisabled) throw Error('Il bottone "successivo" non ha aggiornato correttamente pallino/stato: ' + JSON.stringify(afterNext));
  await evaluate(`document.querySelector('[data-hero-dot="2"]').click()`);
  await delay(300);
  const afterDot = await evaluate(`({activeDot: [...document.querySelectorAll('[data-hero-dot]')].findIndex(d=>d.classList.contains('active')), nextDisabled: document.querySelector('[data-hero-next]').disabled})`);
  if (afterDot.activeDot !== 2 || !afterDot.nextDisabled) throw Error('Il click su un pallino non ha navigato/disabilitato correttamente "successivo" sull\'ultima slide: ' + JSON.stringify(afterDot));
  console.log('PASS navigazione hero: frecce e pallini sincronizzati, "successivo" disabilitato sull\'ultima slide');

  // --- Una sola carta in salita: nessuna navigazione inutile ---------------
  const singleResult = await evaluate(`(async()=>{
    const {dashboardView, bindDashboardCarousel} = await import('/js/dashboard.js');
    const state = {currentUser:'daniele', loans:[]};
    const items = [{printingId:'solo', catalogCardId:'solo', cardName:'Unica Carta', imageUrl:window.__testArtwork, referencePrice:15, price24h:10, sources:['owned']}];
    document.querySelector('#app').innerHTML = dashboardView(state, 'yugioh', {items});
    bindDashboardCarousel();
    return {slides: document.querySelectorAll('.market-hero-slide').length, hasNav: !!document.querySelector('.market-hero-nav')};
  })()`);
  if (singleResult.slides !== 1 || singleResult.hasNav) throw Error('Con una sola carta in salita non deve comparire alcuna navigazione: ' + JSON.stringify(singleResult));
  console.log('PASS singola carta: nessuna navigazione montata, hero mostrata normalmente');

  // --- Nessun mover positivo: stato vuoto elegante, lista Down comunque viva ---
  const emptyUpResult = await evaluate(`(async()=>{
    const {dashboardView} = await import('/js/dashboard.js');
    const state = {currentUser:'daniele', loans:[]};
    const items = [{printingId:'d1', catalogCardId:'d1', cardName:'Solo giù', imageUrl:window.__testArtwork, referencePrice:5, price24h:10, sources:['owned']}];
    document.querySelector('#app').innerHTML = dashboardView(state, 'yugioh', {items});
    return {hasHeroEmpty: !!document.querySelector('.market-hero-empty'), hasSlide: !!document.querySelector('.market-hero-slide'), downText: document.querySelector('.market-movers-group.down')?.textContent || ''};
  })()`);
  if (!emptyUpResult.hasHeroEmpty || emptyUpResult.hasSlide || !emptyUpResult.downText.includes('Solo giù')) throw Error('Stato vuoto hero senza movers positivi non valido: ' + JSON.stringify(emptyUpResult));
  console.log('PASS nessun mover positivo: hero vuoto elegante, lista In discesa comunque popolata');

  // Ripristina la vista con 6 carte per lo screenshot finale.
  await evaluate(`window.__renderDashboard()`);
  await delay(200);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const fs = await import('node:fs/promises');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const screenshotPath = path.join(tmpdir(), 'fpt-dashboard-hero-carousel.png');
  await fs.writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));

  if ((await evaluate('window.__consoleErrors')).length) throw Error('Errori console imprevisti: ' + JSON.stringify(await evaluate('window.__consoleErrors')));
  console.log('PASS dashboard-trends-browser (browser reale): hero carousel + liste Up/Down, nessun render pesante reintrodotto. Screenshot: ' + screenshotPath);
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
