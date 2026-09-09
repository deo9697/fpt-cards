// Smoke test per il restyle Shared Collection guest (js/collection-share.js).
// Nessuna sessione Supabase reale: il controller viene istanziato con un
// `api` mock, stesso pattern di scripts/market-watch-browser-smoke.mjs —
// verifica hero/stat, ricerca (nome/alternateName/setCode), i 5 filtri +
// ordinamento, selezione/disponibilità, il modal di richiesta e l'invio,
// tutto su viewport mobile 390x844 senza overflow orizzontale e senza errori
// console. Richiede `npm run preview` attivo su http://localhost:8080 — se
// non è già in ascolto lo script lo avvia e lo ferma da solo.
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

  const now = new Date().toISOString();
  const fixture = {
    ownerName: 'Daniele', game: 'yugioh', cardCount: 3, printingCount: 4,
    items: [
      { printingId: 'p1', cardName: 'Drago Bianco Occhi Blu', setCode: 'SDK-001', setName: 'Starter Deck Kaiba', rarity: 'Ultra Rare', imageUrl: 'icon-192.png', quantityOwned: 3, quantityAvailable: 2, edition: '1a Edizione', condition: 'Near Mint', language: 'Italiano', alternateNames: ['Blue-Eyes White Dragon'] },
      { printingId: 'p2', cardName: 'Mago Nero', setCode: 'LOB-005', setName: 'Legend of Blue Eyes', rarity: 'Secret Rare', imageUrl: 'icon-192.png', quantityOwned: 1, quantityAvailable: 0, edition: 'Unlimited', condition: 'Excellent', language: 'Inglese', alternateNames: [] },
      { printingId: 'p3', cardName: "Cavaliere dell'Ombra", setCode: 'BLTR-IT099', setName: 'Battles of Legend', rarity: 'Ultra Rare', imageUrl: '', quantityOwned: 2, quantityAvailable: 2, edition: '1a Edizione', condition: 'Near Mint', language: 'Italiano', alternateNames: [] },
      { printingId: 'p4', cardName: 'Sintonizzare', setCode: 'DUEL-IT045', setName: 'Duelist Pack', rarity: 'Common', imageUrl: '', quantityOwned: 1, quantityAvailable: 1, edition: '', condition: 'Good', language: 'Italiano', alternateNames: ['Tuning'] }
    ]
  };
  const submitted = [];
  const setup = await evaluate(`import('/js/collection-share.js').then(({CollectionShareController})=>{
    const c = new CollectionShareController({
      api: {
        getCollectionShare: async () => (${JSON.stringify(fixture)}),
        submitCollectionShareRequest: async (shareId, requesterName, items, message) => { window.__submitted = { shareId, requesterName, items, message }; return 'req-1'; }
      },
      shareId: 'share-1',
      onRender: () => { document.querySelector('#app').innerHTML = c.view(); c.bind(document); },
      onToast: text => { window.__toasts = window.__toasts || []; window.__toasts.push(text); }
    });
    window.__share = c;
    return c.load().then(() => true);
  })`);
  if (!setup) throw new Error('Controller Shared Collection non inizializzato');

  // 1) Hero: conteggi reali, nessun dato inventato
  const hero = await evaluate(`({title:document.querySelector('.share-guest-hero h1')?.textContent, pills:[...document.querySelectorAll('.share-guest-pill')].map(p=>p.textContent.trim()), overflow:document.documentElement.scrollWidth>innerWidth})`);
  if (hero.title !== 'Collezione di Daniele') throw new Error(`Titolo hero errato: ${JSON.stringify(hero)}`);
  if (!hero.pills.some(p => p.includes('3') && p.includes('carte'))) throw new Error(`Pill carte mancante/errata: ${JSON.stringify(hero)}`);
  if (!hero.pills.some(p => p.includes('4') && p.includes('stampe'))) throw new Error(`Pill stampe mancante/errata: ${JSON.stringify(hero)}`);
  if (!hero.pills.some(p => p.includes('Yu-Gi-Oh'))) throw new Error(`Pill gioco mancante: ${JSON.stringify(hero)}`);
  if (hero.overflow) throw new Error('Overflow orizzontale sulla hero a 390px');

  // 2) Grid iniziale: 4 tile, p2 esaurita e disabilitata (disponibilità 0)
  const grid = await evaluate(`({tiles:document.querySelectorAll('.share-guest-tile').length, p2:document.querySelector('[data-share-toggle="p2"]').outerHTML.includes('exhausted')&&document.querySelector('[data-share-toggle="p2"]').disabled, p1Badge:document.querySelector('[data-share-toggle="p1"] .share-guest-qty')?.textContent})`);
  if (grid.tiles !== 4) throw new Error(`Attese 4 tile iniziali, trovate ${grid.tiles}`);
  if (!grid.p2) throw new Error('La stampa con disponibilità 0 deve risultare esaurita e non selezionabile');
  if (grid.p1Badge !== 'x2') throw new Error(`Badge quantità disponibile errato per p1: ${grid.p1Badge}`);

  // 3) Ricerca per alternateName (Blue-Eyes -> p1) e per nome italiano (Tuning -> p4, stesso esempio del commento RPC)
  await evaluate(`window.__share.search('Blue-Eyes')`); await delay(250);
  const searchAlt = await evaluate(`[...document.querySelectorAll('.share-guest-tile')].map(t=>t.dataset.shareToggle)`);
  if (JSON.stringify(searchAlt) !== JSON.stringify(['p1'])) throw new Error(`Ricerca alternateName "Blue-Eyes" errata: ${JSON.stringify(searchAlt)}`);
  await evaluate(`window.__share.search('Tuning')`); await delay(250);
  const searchAlt2 = await evaluate(`[...document.querySelectorAll('.share-guest-tile')].map(t=>t.dataset.shareToggle)`);
  if (JSON.stringify(searchAlt2) !== JSON.stringify(['p4'])) throw new Error(`Ricerca alternateName "Tuning" errata: ${JSON.stringify(searchAlt2)}`);

  // 4) Ricerca per setCode
  await evaluate(`window.__share.search('SDK-001')`); await delay(250);
  const searchCode = await evaluate(`[...document.querySelectorAll('.share-guest-tile')].map(t=>t.dataset.shareToggle)`);
  if (JSON.stringify(searchCode) !== JSON.stringify(['p1'])) throw new Error(`Ricerca per setCode errata: ${JSON.stringify(searchCode)}`);
  await evaluate(`window.__share.search('')`); await delay(250);

  // 5) Filtro rarità (client-side, nessuna nuova chiamata a getCollectionShare)
  await evaluate(`window.__share.setFilter('rarity','Ultra Rare')`); await delay(50);
  const rarityFilter = await evaluate(`[...document.querySelectorAll('.share-guest-tile')].map(t=>t.dataset.shareToggle).sort()`);
  if (JSON.stringify(rarityFilter) !== JSON.stringify(['p1', 'p3'])) throw new Error(`Filtro rarità errato: ${JSON.stringify(rarityFilter)}`);
  await evaluate(`window.__share.setFilter('rarity','all')`); await delay(50);

  // 6) Filtro disponibilità nasconde le stampe esaurite
  await evaluate(`window.__share.setFilter('availability','available')`); await delay(50);
  const availFilter = await evaluate(`document.querySelectorAll('.share-guest-tile').length`);
  if (availFilter !== 3) throw new Error(`Filtro disponibilità errato: attese 3 tile, trovate ${availFilter}`);
  await evaluate(`window.__share.setFilter('availability','all')`); await delay(50);

  // 7) Selezione singola/multipla + click su tile esaurita è no-op
  await evaluate(`document.querySelector('[data-share-toggle="p2"]').click()`); await delay(30);
  const afterExhaustedClick = await evaluate(`window.__share.selected.size`);
  if (afterExhaustedClick !== 0) throw new Error('Una stampa esaurita non deve poter essere selezionata');
  await evaluate(`document.querySelector('[data-share-toggle="p1"]').click()`); await delay(30);
  await evaluate(`document.querySelector('[data-share-toggle="p3"]').click()`); await delay(30);
  const selectionBar = await evaluate(`({text:document.querySelector('.share-guest-selection-text')?.textContent, size:window.__share.selected.size, overflow:document.documentElement.scrollWidth>innerWidth})`);
  if (selectionBar.size !== 2 || !selectionBar.text?.includes('2') || !selectionBar.text?.includes('carte selezionate')) throw new Error(`Barra sticky di selezione errata: ${JSON.stringify(selectionBar)}`);
  if (selectionBar.overflow) throw new Error('Overflow orizzontale con barra sticky attiva');

  // 8) Apre il modal di richiesta: nome obbligatorio, submit disabilitato finché vuoto
  await evaluate(`document.querySelector('[data-share-review-open]').click()`); await delay(30);
  const modalOpen = await evaluate(`({title:document.querySelector('#share-review-title')?.textContent, subtitle:document.body.innerText.includes('Daniele'), submitDisabled:document.querySelector('[data-share-submit]')?.disabled, rows:document.querySelectorAll('.share-review-row').length, maxAttr:document.querySelector('[data-share-qty="p1"]')?.getAttribute('max')})`);
  if (modalOpen.title !== 'Richiesta pronta') throw new Error(`Titolo modal errato: ${JSON.stringify(modalOpen)}`);
  if (!modalOpen.submitDisabled) throw new Error('Conferma invio deve essere disabilitato senza nome');
  if (modalOpen.rows !== 2) throw new Error(`Righe carte nel modal errate: ${JSON.stringify(modalOpen)}`);
  if (modalOpen.maxAttr !== '2') throw new Error(`Max quantità richiedibile per p1 deve essere quantityAvailable (2): ${JSON.stringify(modalOpen)}`);

  // 9) Digitare il nome abilita il submit SENZA perdere il focus sul campo (no re-render completo ad ogni tasto)
  await evaluate(`(()=>{const el=document.querySelector('[data-share-name]'); el.focus(); el.value='Cristian'; el.dispatchEvent(new Event('input',{bubbles:true}));})()`); await delay(30);
  const afterName = await evaluate(`({submitDisabled:document.querySelector('[data-share-submit]')?.disabled, focused:document.activeElement===document.querySelector('[data-share-name]')})`);
  if (afterName.submitDisabled) throw new Error('Conferma invio deve abilitarsi non appena il nome è compilato');
  if (!afterName.focused) throw new Error('Il campo nome perde il focus mentre si digita (re-render completo indesiderato)');

  // 10) Quantità: si clampa al massimo disponibile, e a 0 rimuove la carta dalla richiesta
  await evaluate(`(()=>{const el=document.querySelector('[data-share-qty="p1"]'); el.value='9'; el.dispatchEvent(new Event('change',{bubbles:true}));})()`); await delay(30);
  const clamped = await evaluate(`window.__share.selected.get('p1')`);
  if (clamped !== 2) throw new Error(`Quantità non clampata al disponibile: ${clamped}`);
  await evaluate(`(()=>{const el=document.querySelector('[data-share-qty="p1"]'); el.value='0'; el.dispatchEvent(new Event('change',{bubbles:true}));})()`); await delay(30);
  const afterZero = await evaluate(`({size:window.__share.selected.size, rows:document.querySelectorAll('.share-review-row').length})`);
  if (afterZero.size !== 1 || afterZero.rows !== 1) throw new Error(`Rimozione a quantità 0 non riuscita: ${JSON.stringify(afterZero)}`);

  // 11) Messaggio opzionale, contatore caratteri
  await evaluate(`(()=>{const el=document.querySelector('[data-share-message]'); el.focus(); el.value='Mi interessa molto questa carta!'; el.dispatchEvent(new Event('input',{bubbles:true}));})()`); await delay(30);
  const messageCount = await evaluate(`document.querySelector('.share-review-message-count')?.textContent`);
  if (messageCount !== '32/250') throw new Error(`Contatore messaggio errato: ${messageCount}`);

  // Browser Back consumes only the review entry and preserves the whole draft.
  const reviewUrl = await evaluate('location.href');
  await evaluate('history.back()'); await delay(150);
  const afterBack = await evaluate(`({url:location.href, modal:!!document.querySelector('.share-review-modal'), size:__share.selected.size, name:__share.requesterName, message:__share.message})`);
  if (afterBack.url !== reviewUrl || afterBack.modal || afterBack.size !== 1 || afterBack.name !== 'Cristian' || afterBack.message !== 'Mi interessa molto questa carta!') throw new Error('Back loses the share draft or leaves the collection');
  await evaluate('__share.openReview(); __share.closeReview()'); await delay(150);
  if (await evaluate('!!document.querySelector(".share-review-modal")')) throw new Error('Explicit close leaves the review open');
  await evaluate('__share.openReview()');
  const draft = await evaluate(`JSON.parse(sessionStorage.getItem('fpt-share-draft:share-1'))`);
  if (draft.name !== 'Cristian' || draft.selected.length !== 1) throw new Error('Share draft not persisted');
  const invalidRarities = await evaluate(`import('/js/collection-share.js').then(async ({CollectionShareController}) => {
    const c = new CollectionShareController({shareId:'rarities',api:{getCollectionShare:async()=>({items:[{rarity:'2'},{rarity:3},{rarity:'Ultra Rare'}]})}});
    await c.load(); const values=c.facetOptions('rarity'); c.dispose(); return values;
  })`);
  if (JSON.stringify(invalidRarities) !== JSON.stringify(['Ultra Rare'])) throw new Error('Invalid numeric rarity exposed');

  // 12) Invio: usa l'API guest esistente, estesa solo con il messaggio; stato finale FPT senza redirect al login
  const modalOverflow = await evaluate(`document.documentElement.scrollWidth>innerWidth`);
  if (modalOverflow) throw new Error('Overflow orizzontale col modal aperto a 390px');
  await evaluate(`document.querySelector('[data-share-submit]').click()`); await delay(150);
  const afterSubmit = await evaluate(`({submitted:window.__submitted, successTitle:document.querySelector('.share-guest-success h2')?.textContent, hasLoginForm:!!document.querySelector('.login-shell')})`);
  if (afterSubmit.submitted?.requesterName !== 'Cristian' || afterSubmit.submitted?.items?.length !== 1 || afterSubmit.submitted?.message !== 'Mi interessa molto questa carta!') throw new Error(`Payload di invio errato: ${JSON.stringify(afterSubmit.submitted)}`);
  if (afterSubmit.successTitle !== 'Richiesta inviata!') throw new Error(`Stato finale errato: ${JSON.stringify(afterSubmit)}`);
  if (afterSubmit.hasLoginForm) throw new Error('Il guest non deve essere reindirizzato al login dopo l\'invio');

  // 13) Link scaduto/revocato: errore leggibile, nessuna griglia
  const errorSetup = await evaluate(`import('/js/collection-share.js').then(({CollectionShareController})=>{
    const c = new CollectionShareController({ api:{ getCollectionShare: async () => { throw new Error('Link non valido o revocato'); } }, shareId:'dead', onRender:()=>{ document.querySelector('#app').innerHTML=c.view(); }, onToast:()=>{} });
    return c.load().then(()=>({error:document.body.innerText.includes('Link non disponibile')&&document.body.innerText.includes('Link non valido o revocato'), grid:document.querySelectorAll('.share-guest-tile').length}));
  })`);
  if (!errorSetup.error || errorSetup.grid !== 0) throw new Error(`Vista link scaduto/revocato errata: ${JSON.stringify(errorSetup)}`);

  const consoleErrors = await evaluate(`window.__consoleErrors`);
  if (consoleErrors?.length) throw new Error(`Errori console rilevati: ${JSON.stringify(consoleErrors)}`);

  console.log('PASS Shared Collection guest restyle · mobile 390x844 · hero/stat pill reali · ricerca nome/alternateName/setCode · filtri rarità+disponibilità client-side · selezione con disponibilità netta · modal richiesta pronta (nome obbligatorio, quantità clampata, messaggio 250, invio con submitCollectionShareRequest esteso) · stato finale senza redirect login · link revocato gestito · nessun errore console');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
