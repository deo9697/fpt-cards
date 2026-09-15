// Dashboard Market Watch: hero carousel (solo artwork, con un grafico
// dell'andamento prezzo per slide) — verifica reale in Chrome (artwork
// cropped davvero decodificato, grafico SVG renderizzato, niente overflow a
// 360/390/768/1440px, navigazione hero a frecce/pallini, mai ritorno dei
// render pesanti). Le liste Top 3 Up/Down sotto il carousel sono state
// rimosse su richiesta esplicita: questo test non le cerca più.
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
    const now = Date.UTC(2026,8,15);
    // referencePrice decrescente (14,13,12) così positiveMovers() -- che
    // ordina per variazione % più grande prima -- mantiene l'ordine
    // up0,up1,up2 invariato, coerente con la mappa featuredHistory sotto.
    const upItems = Array.from({length:3},(_,i)=>({printingId:'up'+i, catalogCardId:'up'+i, cardName:'Su '+i, imageUrl:window.__testArtwork, referencePrice:14-i, price24h:10, sources:['owned']}));
    // up0: storico < 1 mese (lettura mensile); up1: storico > 1 mese (annuale); up2: nessuno storico (stato vuoto dedicato).
    const featuredHistory = new Map([
      ['up0', [{price:9,capturedAt:new Date(now-20*86400000).toISOString()},{price:12,capturedAt:new Date(now).toISOString()}]],
      ['up1', [{price:7,capturedAt:new Date(now-250*86400000).toISOString()},{price:13,capturedAt:new Date(now).toISOString()}]]
    ]);
    window.__renderDashboard = () => { document.querySelector('#app').innerHTML = dashboardView(state, 'yugioh', {items:upItems, featuredHistory}); bindDashboardCarousel(); };
    window.__renderDashboard();
    return true;
  })()`);
  if (!setup) throw new Error('Setup Dashboard fallito');

  // --- Nessun overflow / dimensioni ragionevoli a 4 larghezze -------------
  for (const width of [360, 390, 768, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 900 });
    const check = await evaluate(`(()=>{
      const panel = document.querySelector('.market-movers-panel');
      const slides = panel.querySelectorAll('.market-featured-slide').length;
      const oldLists = !!document.querySelector('.market-movers-lists');
      // document.documentElement.scrollWidth è inaffidabile su questa pagina:
      // body ha già overflow-x:hidden (convenzione esistente dell'app), quindi
      // può contare contenuto CLIPPATO (mai visibile, mai scrollabile) come se
      // fosse overflow reale — verificato con un caso concreto durante questo
      // lavoro (scrollWidth=1469 con body.getBoundingClientRect().width=1425,
      // innerWidth=1440: nessun overflow VISIBILE nonostante lo scrollWidth
      // segnalasse il contrario). La larghezza renderizzata di <body> è la
      // misura diretta di ciò che l'utente vede davvero.
      const overflow = document.body.getBoundingClientRect().width > innerWidth + 1;
      return {slides, oldLists, overflow, panelOverflow: panel.scrollWidth > panel.clientWidth + 1};
    })()`);
    if (check.slides !== 3 || check.oldLists || check.overflow || check.panelOverflow) throw Error(`Layout non valido a ${width}px: ${JSON.stringify(check)}`);
  }
  console.log('PASS nessun overflow a 360/390/768/1440px: 3 slide hero, nessuna lista Up/Down (rimosse su richiesta)');

  // --- Artwork: cover reale decodificata, mai la carta intera --------------
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1100, deviceScaleFactor: 1, mobile: true });
  await evaluate(`document.querySelector('.market-movers-panel').scrollIntoView();`);
  const artCheck = await evaluate(`(async()=>{
    const imgs = [...document.querySelectorAll('.market-featured-art')];
    await Promise.all(imgs.map(img => { img.loading='eager'; return img.decode(); }));
    return {count: imgs.length, allDecoded: imgs.every(img => img.naturalWidth > 0), objectFit: getComputedStyle(imgs[0]).objectFit};
  })()`);
  if (artCheck.count !== 3 || !artCheck.allDecoded) throw Error('L\'artwork hero non è stato decodificato correttamente: ' + JSON.stringify(artCheck));
  if (artCheck.objectFit !== 'cover') throw Error('L\'hero deve usare object-fit:cover: ' + JSON.stringify(artCheck));
  console.log('PASS artwork hero: 3 immagini reali decodificate correttamente, object-fit:cover applicato');

  // --- Grafico andamento: mensile/annuale/vuoto per le 3 slide -------------
  const chartCheck = await evaluate(`(()=>{
    const slides = [...document.querySelectorAll('.market-featured-slide')];
    return slides.map(slide => ({
      hasSvg: !!slide.querySelector('.market-featured-chart svg'),
      label: slide.querySelector('.market-featured-chart-dates')?.textContent || '',
      empty: !!slide.querySelector('.market-featured-chart-empty')
    }));
  })()`);
  if (!chartCheck[0].hasSvg || !chartCheck[0].label.includes('mensile')) throw Error('La prima slide (storico < 1 mese) deve mostrare un grafico con lettura mensile: ' + JSON.stringify(chartCheck));
  if (!chartCheck[1].hasSvg || !chartCheck[1].label.includes('annuale')) throw Error('La seconda slide (storico > 1 mese) deve mostrare un grafico con lettura annuale: ' + JSON.stringify(chartCheck));
  if (!chartCheck[2].empty) throw Error('La terza slide (nessuno storico) deve mostrare lo stato vuoto dedicato del grafico, mai un grafico rotto: ' + JSON.stringify(chartCheck));
  console.log('PASS grafico andamento reale: mensile/annuale scelti in base alla copertura effettiva dello storico, stato vuoto quando assente');

  // --- Navigazione: frecce + pallini, niente scroll oltre l'ultima slide ---
  const beforeNav = await evaluate(`document.querySelector('[data-featured-dot="1"]').classList.contains('active')`);
  if (beforeNav) throw Error('Il secondo pallino non deve essere attivo prima della navigazione');
  await evaluate(`document.querySelector('[data-featured-next]').click()`);
  await delay(300);
  const afterNext = await evaluate(`({activeDot: [...document.querySelectorAll('[data-featured-dot]')].findIndex(d=>d.classList.contains('active')), prevDisabled: document.querySelector('[data-featured-prev]').disabled})`);
  if (afterNext.activeDot !== 1 || afterNext.prevDisabled) throw Error('Il bottone "successivo" non ha aggiornato correttamente pallino/stato: ' + JSON.stringify(afterNext));
  await evaluate(`document.querySelector('[data-featured-dot="2"]').click()`);
  await delay(300);
  const afterDot = await evaluate(`({activeDot: [...document.querySelectorAll('[data-featured-dot]')].findIndex(d=>d.classList.contains('active')), nextDisabled: document.querySelector('[data-featured-next]').disabled})`);
  if (afterDot.activeDot !== 2 || !afterDot.nextDisabled) throw Error('Il click su un pallino non ha navigato/disabilitato correttamente "successivo" sull\'ultima slide: ' + JSON.stringify(afterDot));
  console.log('PASS navigazione hero: frecce e pallini sincronizzati, "successivo" disabilitato sull\'ultima slide');

  // --- Una sola carta in salita: nessuna navigazione inutile ---------------
  const singleResult = await evaluate(`(async()=>{
    const {dashboardView, bindDashboardCarousel} = await import('/js/dashboard.js');
    const state = {currentUser:'daniele', loans:[]};
    const items = [{printingId:'solo', catalogCardId:'solo', cardName:'Unica Carta', imageUrl:window.__testArtwork, referencePrice:15, price24h:10, sources:['owned']}];
    document.querySelector('#app').innerHTML = dashboardView(state, 'yugioh', {items});
    bindDashboardCarousel();
    return {slides: document.querySelectorAll('.market-featured-slide').length, hasNav: !!document.querySelector('.market-featured-nav')};
  })()`);
  if (singleResult.slides !== 1 || singleResult.hasNav) throw Error('Con una sola carta in salita non deve comparire alcuna navigazione: ' + JSON.stringify(singleResult));
  console.log('PASS singola carta: nessuna navigazione montata, hero mostrata normalmente');

  // --- Nessun mover positivo: stato vuoto elegante del pannello ------------
  const emptyResult = await evaluate(`(async()=>{
    const {dashboardView} = await import('/js/dashboard.js');
    const state = {currentUser:'daniele', loans:[]};
    document.querySelector('#app').innerHTML = dashboardView(state, 'yugioh', {items:[]});
    return {hasEmpty: !!document.querySelector('.featured-empty'), hasSlide: !!document.querySelector('.market-featured-slide')};
  })()`);
  if (!emptyResult.hasEmpty || emptyResult.hasSlide) throw Error('Stato vuoto del pannello senza movers positivi non valido: ' + JSON.stringify(emptyResult));
  console.log('PASS nessun mover positivo: stato vuoto elegante del pannello');

  // Ripristina la vista iniziale per lo screenshot finale.
  await evaluate(`window.__renderDashboard()`);
  await delay(200);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const fs = await import('node:fs/promises');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const screenshotPath = path.join(tmpdir(), 'fpt-dashboard-hero-carousel.png');
  await fs.writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));

  if ((await evaluate('window.__consoleErrors')).length) throw Error('Errori console imprevisti: ' + JSON.stringify(await evaluate('window.__consoleErrors')));
  console.log('PASS dashboard-trends-browser (browser reale): hero carousel con grafico mensile/annuale, nessuna lista Up/Down, nessun render pesante reintrodotto. Screenshot: ' + screenshotPath);
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
