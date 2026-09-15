// Fix focus/tastiera mobile — root cause: MarketWatchController.loadOwnedPage()
// chiamava refreshBoardSection() (ricostruisce tutta la toolbar, search bar
// inclusa) ad ogni carattere digitato nella tab Raccolta, distruggendo e
// ricreando l'<input> a fuoco — su mobile la tastiera si chiudeva dopo un
// solo carattere. Un secondo bug correlato: refreshAfterLoad() chiamava
// onRender() (= renderRoute() in app.js, un innerHTML pieno della pagina
// corrente) ogni volta che Market Watch non era la pagina montata, anche se
// l'utente stava scrivendo altrove (es. loadPrimaryData() al login lancia
// marketWatch.load() in parallelo mentre l'utente è già passato alla
// Raccolta) — stesso principio del guard già esistente per il fallback
// periodico Mazzi e la sync realtime in app.js.
// Chrome reale via CDP, viewport mobile 390x844, nessuna rete reale (API
// mockate con un ritardo artificiale per rendere la race deterministica).
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-focus-smoke-')), port = 9377;
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
  // Fixture isolata (solo <div id="app">, nessun bootstrap): il vero
  // index.html carica il vero app.js, che boota per conto proprio (login
  // screen, controllo sessione) e in background finirebbe per sovrascrivere
  // #app anche di questo test, indipendentemente da qualunque fix — mai un
  // segnale reale di regressione, solo interferenza dell'ambiente di test.
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/collection-share-harness.html' });
  await delay(500);

  // --- 1) Market Watch, tab Raccolta: digitare non deve mai perdere il focus ---
  // dell'input, né durante il debounce né dopo la risposta async (root cause
  // reale: refreshBoardSection() ricreava l'<input>).
  const marketResult = await evaluate(`(async()=>{
    const {MarketWatchController} = await import('/js/market-watch.js');
    const now = new Date().toISOString();
    let resolveCount = 0;
    const item = {printing_id:'p1', card_name:'Ash Blossom & Joyous Spring', owned_quantity:1, reference_price:5, mapping_status:'resolved', resolver_status:'EXACT'};
    const api = {
      marketWatchExtra: async () => ({items:[], deckUnresolved:[]}),
      marketWatchSummary: async () => ({portfolioValue:{current:0,complete:false}, confirmCount:0, aggregatePendingCount:0, catalogPriceFloor:{}, lastSync: now}),
      marketWatchOwnedPage: async (game, opts) => {
        resolveCount++;
        await new Promise(r => setTimeout(r, 60)); // rende la race deterministica: la risposta arriva DOPO che il test ha già controllato subito dopo il keystroke
        const q = String(opts.query || '').toLowerCase();
        const items = q && !item.card_name.toLowerCase().includes(q) ? [] : [item];
        return {items, total: items.length, limit: 60, offset: 0};
      },
      setMarketWatchItem: async () => {}, marketPriceHistory: async () => []
    };
    const c = new MarketWatchController({ api, getGame: () => 'yugioh', getDecks: () => [], onRender: () => { document.querySelector('#app').innerHTML = c.view(); c.bind(document); }, onToast: () => {}, onNavigate: () => {} });
    // Spia su refreshBoardSection() (la ricostruzione LARGA, che ricrea anche
    // l'<input>): dopo che l'utente ha messo a fuoco il campo, non deve mai
    // più scattare — solo refreshBoard() (mirato al contenuto) può.
    let sectionCallsDuringTyping = 0;
    await c.load();
    const origSection = c.refreshBoardSection.bind(c);
    c.refreshBoardSection = (...a) => { sectionCallsDuringTyping++; return origSection(...a); };

    const field = document.querySelector('[data-market-query]');
    field.focus();
    window.__marketField = field;
    const typeChar = ch => { field.value += ch; field.selectionStart = field.selectionEnd = field.value.length; field.dispatchEvent(new Event('input', {bubbles:true})); };
    typeChar('a');
    const rightAfterKeystroke = { sameNode: document.activeElement === window.__marketField, value: field.value, selection: field.selectionStart };
    await new Promise(r => setTimeout(r, 400)); // debounce (200ms) + ritardo mock (60ms) + margine
    const stillField = document.querySelector('[data-market-query]');
    const afterResponse = { sameNode: document.activeElement === window.__marketField, sameAsQueried: stillField === window.__marketField, value: stillField?.value, resolveCount, tabCount: document.querySelector('[data-market-tab="owned"] span')?.textContent, sectionCallsDuringTyping };
    return { rightAfterKeystroke, afterResponse };
  })()`);
  if (!marketResult.rightAfterKeystroke.sameNode) throw Error('Il focus si perde già subito dopo il primo carattere: ' + JSON.stringify(marketResult));
  if (marketResult.rightAfterKeystroke.value !== 'a' || marketResult.rightAfterKeystroke.selection !== 1) throw Error('Valore/caret errati subito dopo il keystroke: ' + JSON.stringify(marketResult));
  if (marketResult.afterResponse.resolveCount !== 2) throw Error('Atteso init+1 ricerca: ' + JSON.stringify(marketResult));
  if (marketResult.afterResponse.sectionCallsDuringTyping !== 0) throw Error('REGRESSIONE: refreshBoardSection() (ricostruzione larga, ricrea l\'input) è scattata durante la digitazione: ' + JSON.stringify(marketResult));
  if (!marketResult.afterResponse.sameNode || !marketResult.afterResponse.sameAsQueried) throw Error('REGRESSIONE: il campo di ricerca Market Watch viene ricreato quando arriva la risposta async (la tastiera si chiuderebbe su mobile): ' + JSON.stringify(marketResult));
  if (marketResult.afterResponse.value !== 'a') throw Error('Il valore digitato è andato perso dopo la risposta async: ' + JSON.stringify(marketResult));
  if (marketResult.afterResponse.tabCount !== '1') throw Error('Il conteggio del tab "Raccolta" non si aggiorna durante la ricerca: ' + JSON.stringify(marketResult));
  console.log('PASS Market Watch: focus/valore/caret dell\'input di ricerca restano intatti attraverso debounce + richiesta async, il conteggio del tab resta comunque aggiornato');

  // --- 2) Un controller in background (Market Watch) non deve mai ricostruire
  // la pagina corrente se il proprio pannello non è montato E l'utente sta
  // scrivendo altrove — ma DEVE ancora aggiornarsi se l'utente non sta
  // scrivendo da nessuna parte (altrimenti la Dashboard non vedrebbe mai i
  // movers freschi). Stage fittizio = la pagina "corrente" (es. Raccolta);
  // nessun mock del fix stesso, è il vero MarketWatchController.refreshAfterLoad().
  const backgroundResult = await evaluate(`(async()=>{
    const {MarketWatchController} = await import('/js/market-watch.js');
    document.body.innerHTML = '<div id="stage"><input id="other-field" data-collection-query></div>';
    let renderCalls = 0;
    const api = {
      marketWatchExtra: async () => ({items:[], deckUnresolved:[]}),
      marketWatchSummary: async () => ({portfolioValue:{current:1,complete:true}, confirmCount:0, aggregatePendingCount:0, catalogPriceFloor:{}, lastSync: new Date().toISOString()}),
      marketWatchOwnedPage: async () => ({items:[], total:0, limit:60, offset:0}),
      setMarketWatchItem: async () => {}, marketPriceHistory: async () => []
    };
    // onRender simula renderRoute(): un innerHTML pieno dello stage corrente.
    // '[data-market-board-section]' non esiste mai in questo DOM (Market
    // Watch non è la pagina montata), quindi ogni load() passa dal ramo
    // "controller non montato" di refreshAfterLoad().
    const c = new MarketWatchController({ api, getGame: () => 'yugioh', getDecks: () => [], onRender: () => { renderCalls++; document.querySelector('#stage').innerHTML = '<p>Pagina ricostruita</p>'; }, onToast: () => {}, onNavigate: () => {} });

    const field = document.querySelector('#other-field');
    field.value = 'testo scritto altrove';
    field.focus();
    window.__otherField = field;
    await c.load(); // typing in corso: NON deve chiamare onRender
    const whileTyping = { renderCalls, stageIntact: document.querySelector('#other-field') === window.__otherField, value: document.querySelector('#other-field')?.value, sameFocus: document.activeElement === window.__otherField };

    document.activeElement?.blur?.();
    await c.load(); // nessuno sta scrivendo: onRender DEVE ancora scattare (es. Dashboard vuole i movers freschi) — due punti di completamento di load() lo richiamano entrambi (extra/summary pronti + fine caricamento), quindi 2 chiamate per giro quando il pannello non è montato
    const whileIdle = { renderCalls };

    return { whileTyping, whileIdle };
  })()`);
  if (backgroundResult.whileTyping.renderCalls !== 0) throw Error('REGRESSIONE: un aggiornamento Market Watch in background ricostruisce la pagina corrente mentre l\'utente sta scrivendo altrove: ' + JSON.stringify(backgroundResult));
  if (!backgroundResult.whileTyping.stageIntact || backgroundResult.whileTyping.value !== 'testo scritto altrove' || !backgroundResult.whileTyping.sameFocus) throw Error('Il campo "di un\'altra pagina" viene comunque toccato: ' + JSON.stringify(backgroundResult));
  // Non fissare il conteggio esatto delle chiamate onRender qui: load()
  // ha più punti di completamento interni (extra/summary, owned_page,
  // fine giro) che possono cambiare con lavoro legittimo altrove in
  // market-watch.js — la proprietà che conta per questo test è "almeno un
  // redraw quando nessuno sta scrivendo", non un numero preciso.
  if (backgroundResult.whileIdle.renderCalls < 1) throw Error('Quando nessuno sta scrivendo, l\'aggiornamento in background deve comunque ridisegnare (altrimenti la Dashboard non vedrebbe mai dati freschi): ' + JSON.stringify(backgroundResult));
  console.log('PASS controller in background: un aggiornamento Market Watch non montato non ricostruisce mai la pagina corrente mentre l\'utente scrive altrove, ma lo fa normalmente quando nessun campo è a fuoco');

  if ((await evaluate('[...(window.__consoleErrors||[])]'))?.length) throw Error('Errori console imprevisti');
  console.log('PASS mobile-focus-regression (browser reale, viewport 390x844): tastiera/focus mai persi in Market Watch né per un controller in background che aggiorna una pagina non sua');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
