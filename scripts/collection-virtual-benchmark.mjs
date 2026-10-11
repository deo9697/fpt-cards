// BENCHMARK (non un test di regressione): rendering progressivo attuale della
// Raccolta vs prototipo virtualizzato con @tanstack/virtual-core.
//
// A) ATTUALE — collectionResultsView() reale; la crescita imita app.js:
//    quando il sentinel entra nei 400px, visibleCount += 60 e si ri-renderizza
//    l'intera griglia via innerHTML (come refreshCollectionResults()).
// B) PROTOTIPO — Virtualizer a righe (colonne lette dal CSS reale), solo le
//    righe visibili + overscan nel DOM, stesso markup delle tile (estratto
//    dall'output reale di collectionResultsView).
// Entrambi: Chrome reale 390x844 mobile, CPU 4x più lenta, stesso dataset
// sintetico, stessa immagine locale per ogni tile (niente rete), scroll
// programmatico fino in fondo con misura dei frame (rAF).
// Uso: node scripts/collection-virtual-benchmark.mjs [numeroPrinting=2500]
// Nessuna modifica alla Raccolta di produzione.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const N = Number(process.argv[2]) || 2500;
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-virtual-bench-')), port = 9397;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let previewServer = null;
if (!(await fetch('http://localhost:8080/index.html').then(() => true).catch(() => false))) {
  previewServer = spawn(process.execPath, ['scripts/preview-server.mjs'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 50; i++) { if (await fetch('http://localhost:8080/index.html').then(() => true).catch(() => false)) break; await delay(100); }
}
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', '--enable-precise-memory-info', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=390,844', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  let target; for (let i = 0; i < 80 && !target; i++) { try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await delay(150); } }
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', event => { const message = JSON.parse(event.data), task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const setup = `
    const { collectionResultsView } = await import('/js/collection.js');
    const N = ${N}, filters = { scope:'mine', query:'', owner:'all', status:'all', layout:'grid', sort:'name-asc', facets:{} };
    const rarities = ['Common','Rare','Super Rare','Ultra Rare','Secret Rare'];
    const mine = Array.from({ length: N }, (_, i) => ({ id:'c'+i, collectionItemId:'c'+i, ownerSlug:'bench', ownerName:'Bench', game:'yugioh', catalogCardId:String(10000000+i),
      cardName:'Bench Card '+String(i).padStart(5,'0'), setCode:'BNCH-EN'+String(i%1000).padStart(3,'0'), setName:'Bench Set', rarity:rarities[i%5], language:'Italiano', condition:'Near Mint', edition:'',
      imageUrl:'/icon-192.png', quantityOwned:1+(i%3), quantityLoaned:0, quantityReserved:0, quantityAvailable:1+(i%3) }));
    const collection = { mine, team:[], syncedAt:new Date().toISOString() };
    const nodes = root => root.querySelectorAll('*').length;
    const frameProbe = () => { const frames = []; let last = performance.now(), on = true; const tick = t => { frames.push(t - last); last = t; if (on) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return () => { on = false; const sorted = frames.slice().sort((a,b)=>a-b); return { frames: frames.length, p95: Math.round(sorted[Math.floor(sorted.length*.95)]||0), max: Math.round(sorted.at(-1)||0), long50: frames.filter(f=>f>50).length }; }; };
    const scrollToEnd = async (step = 90) => { let guard = 0; while (scrollY + innerHeight < document.documentElement.scrollHeight - 2 && guard++ < 20000) { scrollBy(0, step); await new Promise(r => requestAnimationFrame(r)); } await new Promise(r => setTimeout(r, 300)); };
  `;

  const runCurrent = `(async()=>{ ${setup}
    const app = document.querySelector('#app'); app.innerHTML = '<div data-collection-results></div>'; scrollTo(0,0);
    const results = app.querySelector('[data-collection-results]'); let visible = 60, renderMs = 0, renders = 0, observer;
    const render = () => { const t = performance.now(); results.innerHTML = collectionResultsView(collection, filters, 'yugioh', true, visible); renderMs += performance.now() - t; renders++; observe(); };
    const observe = () => { observer?.disconnect(); const s = results.querySelector('[data-collection-sentinel]'); if (!s) return; observer = new IntersectionObserver(entries => { if (!entries.some(e => e.isIntersecting)) return; observer.disconnect(); visible += 60; render(); }, { rootMargin:'400px' }); observer.observe(s); };
    const t0 = performance.now(); render(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const initialMs = performance.now() - t0;
    const initialNodes = nodes(results), heap0 = performance.memory?.usedJSHeapSize || 0;
    const stop = frameProbe(), s0 = performance.now(); await scrollToEnd(); const scrollMs = performance.now() - s0, frames = stop();
    return { approach:'attuale (sentinel +60, re-render completo)', initialMs: Math.round(initialMs), initialNodes, finalNodes: nodes(results), tiles: results.querySelectorAll('.inventory-tile').length, renders, renderScriptMs: Math.round(renderMs), scrollMs: Math.round(scrollMs), ...frames, heapMB: +(((performance.memory?.usedJSHeapSize||0))/1048576).toFixed(1) };
  })()`;

  const runVirtual = `(async()=>{ ${setup}
    // La build ESM di virtual-core contiene controlli process.env.NODE_ENV pensati per un bundler:
    // shim minimo solo per il prototipo (la build +esm di jsDelivr li sostituisce).
    globalThis.process ??= { env: { NODE_ENV: 'production' } };
    const { Virtualizer, observeWindowRect, observeWindowOffset, windowScroll } = await import('/node_modules/@tanstack/virtual-core/dist/esm/index.js');
    const app = document.querySelector('#app'); scrollTo(0,0);
    const prepStart = performance.now();
    const tpl = document.createElement('template'); tpl.innerHTML = collectionResultsView(collection, filters, 'yugioh', true, N);
    const tiles = [...tpl.content.querySelectorAll('.inventory-tile')].map(el => el.outerHTML); const prepMs = performance.now() - prepStart;
    const t0 = performance.now();
    app.innerHTML = '<div class="inventory-grid tiles" data-probe style="visibility:hidden;position:absolute"></div><div data-vlist style="position:relative;width:100%"></div>';
    const probe = app.querySelector('[data-probe]'); probe.innerHTML = tiles.slice(0, 12).join('');
    const cols = getComputedStyle(probe).gridTemplateColumns.split(' ').length, rowH = probe.firstElementChild.getBoundingClientRect().height + parseFloat(getComputedStyle(probe).rowGap || 10); probe.remove();
    const list = app.querySelector('[data-vlist]'), rows = Math.ceil(tiles.length / cols); let renderMs = 0, renders = 0;
    const v = new Virtualizer({ count: rows, estimateSize: () => rowH, overscan: 3, getScrollElement: () => window, observeElementRect: observeWindowRect, observeElementOffset: observeWindowOffset, scrollToFn: windowScroll, initialRect: { width: innerWidth, height: innerHeight },
      onChange: inst => { const t = performance.now(); list.style.height = inst.getTotalSize() + 'px'; list.innerHTML = inst.getVirtualItems().map(row => '<div class="inventory-grid tiles" style="position:absolute;left:0;right:0;top:0;transform:translateY(' + row.start + 'px)">' + tiles.slice(row.index*cols, row.index*cols+cols).join('') + '</div>').join(''); renderMs += performance.now() - t; renders++; } });
    const cleanup = v._didMount(); v._willUpdate(); v.options.onChange(v);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const initialMs = performance.now() - t0;
    const initialNodes = nodes(list);
    const stop = frameProbe(), s0 = performance.now(); await scrollToEnd(); const scrollMs = performance.now() - s0, frames = stop();
    const out = { approach:'prototipo TanStack virtual-core (righe da ' + cols + ')', prepMs: Math.round(prepMs), initialMs: Math.round(initialMs), initialNodes, finalNodes: nodes(list), tiles: list.querySelectorAll('.inventory-tile').length, renders, renderScriptMs: Math.round(renderMs), scrollMs: Math.round(scrollMs), ...frames, heapMB: +(((performance.memory?.usedJSHeapSize||0))/1048576).toFixed(1), lastTileReached: list.innerHTML.includes('Bench Card ' + String(N-1).padStart(5,'0')) };
    cleanup(); return out;
  })()`;

  const results = [];
  for (const [label, code] of [['attuale', runCurrent], ['virtual', runVirtual]]) {
    await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/collection-share-harness.html' }); await delay(600);
    await evaluate(`document.head.insertAdjacentHTML('afterbegin','<base href="/">'); true`);
    await send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const result = await evaluate(code);
    await send('Emulation.setCPUThrottlingRate', { rate: 1 });
    results.push(result); console.log(label, JSON.stringify(result));
  }
  const out = path.join(tmpdir(), `fpt-collection-virtual-benchmark-${N}.json`);
  await writeFile(out, JSON.stringify({ N, cpuThrottle: 4, viewport: '390x844', results }, null, 2));
  console.log('Risultati salvati in ' + out);
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}
