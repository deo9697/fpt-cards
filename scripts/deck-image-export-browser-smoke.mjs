// Decklist Image Generator — rendering/export reali (canvas, blob PNG,
// artwork valido/fallito, Web Share) + UI del DeckController (apertura
// preview, switch Clean/Signature, bottoni download/condividi), in un
// browser reale via CDP. Usa SOLO artwork same-origin (icon-192.png, già
// servito dal preview server) per evitare qualunque dipendenza di rete
// esterna in questo test: la necessità del proxy CORS per ygoprodeck.com/
// optcgapi.com è già stata verificata con curl (vedi commento in
// api/card-image-proxy.js), non richiede una prova a runtime qui — questo
// test dimostra invece che canvas.toBlob() funziona correttamente quando
// l'artwork è CORS-safe (same-origin), e che un artwork fallito (404) non
// blocca comunque l'export.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-deck-image-smoke-')), port = 9376;
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
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/collection-share-harness.html' });
  await delay(500);
  await evaluate(`window.__consoleErrors = []; window.addEventListener('error', e => window.__consoleErrors.push(String(e.message)));`);

  // --- 1) Rendering/export diretto: artwork valido, artwork fallito, dimensioni canvas, blob PNG ---
  const renderResult = await evaluate(`(async()=>{
    const {renderDeckImage, exportDeckImageBlob} = await import('/js/deck-image-export.js');
    document.head.insertAdjacentHTML('afterbegin','<base href="/">');
    const deck = {
      name: 'Blue-Eyes Control', ownerSlug: 'daniele', game: 'yugioh', format: 'TCG Avanzato', deckTheme: 'arcane-purple', signatureCardId: 'valid-1',
      cards: [
        { catalogCardId: 'valid-1', cardName: 'Artwork valido', section: 'main', quantity: 3, imageUrl: '/icon-192.png' },
        { catalogCardId: 'broken-1', cardName: 'Artwork rotto', section: 'main', quantity: 1, imageUrl: '/nonexistent-artwork-404.png' },
        { catalogCardId: 'no-url-1', cardName: 'Nessun artwork', section: 'extra', quantity: 2, imageUrl: '' }
      ]
    };
    const {canvas} = await renderDeckImage(deck, {mode:'clean', ownerName:'Daniele'});
    const blob = await exportDeckImageBlob(canvas);
    return {width:canvas.width, height:canvas.height, blobType:blob.type, blobSize:blob.size};
  })()`);
  if (renderResult.width !== 1080 || renderResult.height !== 1350) throw Error('Canvas non è 1080x1350: ' + JSON.stringify(renderResult));
  if (renderResult.blobType !== 'image/png') throw Error('Blob non è image/png: ' + JSON.stringify(renderResult));
  if (!(renderResult.blobSize > 0)) throw Error('Blob PNG vuoto: ' + JSON.stringify(renderResult));
  console.log('PASS render+export reale: canvas 1080x1350, blob image/png non vuoto, con un artwork valido (same-origin), uno rotto (404) e una carta senza URL — nessuno dei tre blocca l\'export');

  // --- 2) Modalità Signature: sfondo signature card, fallback automatico se assente ---
  const signatureResult = await evaluate(`(async()=>{
    const {renderDeckImage, exportDeckImageBlob} = await import('/js/deck-image-export.js');
    const withSignature = {name:'Con Signature', game:'yugioh', deckTheme:null, signatureCardId:'valid-1', cards:[{catalogCardId:'valid-1', cardName:'X', section:'main', quantity:1, imageUrl:'/icon-192.png'}]};
    const noSignature = {name:'Senza Signature', game:'yugioh', deckTheme:null, signatureCardId:null, cards:[]};
    const a = await renderDeckImage(withSignature, {mode:'signature'});
    const b = await renderDeckImage(noSignature, {mode:'signature'});
    return {withMode: a.mode, withoutMode: b.mode};
  })()`);
  if (signatureResult.withMode !== 'signature') throw Error('Con una signature valida la modalità effettiva deve restare signature: ' + JSON.stringify(signatureResult));
  if (signatureResult.withoutMode !== 'clean') throw Error('Senza signature card deve ricadere automaticamente su clean: ' + JSON.stringify(signatureResult));
  console.log('PASS modalità Signature: usata quando la signature card ha un artwork, fallback automatico a Clean quando manca');

  // --- 3) Web Share: supportato vs non supportato -----------------------
  const shareResult = await evaluate(`(async()=>{
    const {canShareDeckImageBlob, shareDeckImageBlob} = await import('/js/deck-image-export.js');
    const blob = new Blob(['x'], {type:'image/png'});
    const originalShare = navigator.share, originalCanShare = navigator.canShare;
    let shareCalledWith = null;
    navigator.share = async (data) => { shareCalledWith = data; };
    navigator.canShare = () => true;
    const supportedResult = canShareDeckImageBlob(blob, 'Test Deck');
    await shareDeckImageBlob(blob, 'Test Deck', {title:'Test Deck'});
    navigator.share = undefined; navigator.canShare = undefined;
    const unsupportedResult = canShareDeckImageBlob(blob, 'Test Deck');
    if (originalShare !== undefined) navigator.share = originalShare; if (originalCanShare !== undefined) navigator.canShare = originalCanShare;
    return {supportedResult, unsupportedResult, sharedFileName: shareCalledWith?.files?.[0]?.name || null, sharedFileType: shareCalledWith?.files?.[0]?.type || null};
  })()`);
  if (shareResult.supportedResult !== true) throw Error('canShareDeckImageBlob deve tornare true quando navigator.share/canShare esistono: ' + JSON.stringify(shareResult));
  if (shareResult.sharedFileName !== 'fpt-deck-test-deck.png' || shareResult.sharedFileType !== 'image/png') throw Error('Il file condiviso ha nome/tipo sbagliato: ' + JSON.stringify(shareResult));
  if (shareResult.unsupportedResult !== false) throw Error('canShareDeckImageBlob deve tornare false quando Web Share non è disponibile: ' + JSON.stringify(shareResult));
  console.log('PASS Web Share: rilevato correttamente quando supportato (file .png corretto passato a navigator.share) e quando non lo è (false, fallback al download)');

  // --- 4) UI DeckController: apertura preview, switch Clean/Signature, download, share ---
  const uiSetup = await evaluate(`(async()=>{
    window.__consoleErrors = window.__consoleErrors || [];
    const {DeckController} = await import('/js/decks.js');
    const deck = {
      id:'d1', persisted:true, ownerSlug:'daniele', name:'UI Test Deck', format:'TCG Avanzato', game:'yugioh', deckTheme:'arcane-purple', deckBoxTemplate:'procedural', signatureCardId:null,
      cards:[{catalogCardId:'valid-1', cardName:'Artwork valido', section:'main', quantity:2, imageUrl:'/icon-192.png'}]
    };
    const controller = new DeckController({
      api:{}, getState:() => ({decks:[deck], game:'yugioh', currentUser:'daniele'}),
      onRender:() => { document.querySelector('#app').innerHTML = controller.view(); controller.bind(document); },
      onToast:() => {}
    });
    controller.activeId = 'd1'; controller.screen = 'detail';
    window.__controller = controller;
    document.querySelector('#app').innerHTML = controller.view(); controller.bind(document);
    return true;
  })()`);
  if (!uiSetup) throw Error('Setup DeckController fallito');

  // Il menu "..." deve contenere "Genera immagine".
  const menuHtml = await evaluate(`(()=>{ window.__controller.toggleMoreMenu(); return document.querySelector('[data-deck-image-open]')?.outerHTML || null; })()`);
  if (!menuHtml) throw Error('Bottone "Genera immagine" non trovato nel menu azioni del mazzo');

  // Apertura preview: la modale monta con un canvas 1080x1350 e, dopo il
  // ridisegno asincrono innescato da bind(), il loading overlay si nasconde.
  await evaluate(`document.querySelector('[data-deck-image-open]').click()`);
  await delay(600); // renderDeckImage() è asincrono (preload immagini)
  const afterOpen = await evaluate(`(()=>{
    const canvas = document.querySelector('[data-deck-image-canvas]');
    const overlay = document.querySelector('[data-deck-image-loading]');
    return {hasCanvas: !!canvas, width: canvas?.width, height: canvas?.height, overlayHidden: overlay?.hidden, busy: window.__controller.imageExportBusy};
  })()`);
  if (!afterOpen.hasCanvas || afterOpen.width !== 1080 || afterOpen.height !== 1350) throw Error('Preview non ha montato un canvas 1080x1350: ' + JSON.stringify(afterOpen));
  if (!afterOpen.overlayHidden || afterOpen.busy) throw Error('Il loading overlay doveva nascondersi da solo a fine generazione, senza un secondo onRender() che ricrea il canvas: ' + JSON.stringify(afterOpen));
  console.log('PASS apertura preview: bottone nel menu azioni, modale con canvas 1080x1350, loading nascosto a fine generazione senza ricreare il canvas');

  // Switch Arena FPT -> Lista torneo: il bottone diventa attivo, il canvas
  // viene ricreato e ridisegnato di nuovo.
  await evaluate(`document.querySelector('[data-deck-image-style="list"]').click()`);
  await delay(600);
  const afterSwitch = await evaluate(`(()=>{
    const active = document.querySelector('[data-deck-image-style].active')?.dataset.deckImageStyle;
    return {active, style: window.__controller.imageExportStyle, busy: window.__controller.imageExportBusy};
  })()`);
  if (afterSwitch.active !== 'list' || afterSwitch.style !== 'list') throw Error('Lo switch a Lista torneo non ha aggiornato lo stato/la UI: ' + JSON.stringify(afterSwitch));
  if (afterSwitch.busy) throw Error('Il ridisegno dopo lo switch di stile non si è mai concluso: ' + JSON.stringify(afterSwitch));
  console.log('PASS switch Arena FPT/Lista torneo: bottone attivo aggiornato, ridisegno completato');

  // Sfondo personalizzato: un file immagine scelto dall'utente diventa lo sfondo
  // in entrambi gli stili, sopravvive al cambio stile, si rimuove, e il canvas
  // resta esportabile (non "tainted").
  const backgroundResult = await evaluate(`(async()=>{
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const sample = () => { const c = document.querySelector('[data-deck-image-canvas]'); const d = c.getContext('2d').getImageData(540, 60, 1, 1).data; return [d[0], d[1], d[2]]; };
    const pick = async () => {
      const src = document.createElement('canvas'); src.width = 1600; src.height = 1200;
      const g = src.getContext('2d'); g.fillStyle = 'rgb(0,255,0)'; g.fillRect(0, 0, 1600, 1200);
      const blob = await new Promise(r => src.toBlob(r, 'image/png'));
      const input = document.querySelector('[data-deck-image-background]');
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'sfondo-verde.png', { type: 'image/png' }));
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 40 && !window.__controller.imageExportDetails.background; i++) await wait(50);
      await wait(100);
    };
    const greenish = ([r, g, b]) => g > r + 25 && g > b + 25;
    const before = sample();
    if (!document.querySelector('[data-deck-image-background]')) return { error: 'campo Sfondo personalizzato assente' };
    await pick();
    const listAfter = sample();
    const row = document.querySelector('.deck-image-background');
    const label = row?.textContent || '';
    document.querySelector('[data-deck-image-style="arena"]').click();
    for (let i = 0; i < 40 && window.__controller.imageExportBusy; i++) await wait(50);
    await wait(300);
    const arenaAfter = sample();
    const kept = !!window.__controller.imageExportDetails.background;
    let exportable = true; try { document.querySelector('[data-deck-image-canvas]').toDataURL('image/png'); } catch { exportable = false; }
    const blob = await (async () => { let saved = null; const original = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function(){ saved = this.href; }; await window.__controller.downloadImageExport(); HTMLAnchorElement.prototype.click = original; return saved; })();
    document.querySelector('[data-deck-image-background-clear]').click();
    await wait(200);
    const cleared = sample();
    return { before, listAfter, arenaAfter, cleared, kept, exportable, downloaded: !!blob, label, listGreen: greenish(listAfter), arenaGreen: greenish(arenaAfter), clearedGreen: greenish(cleared), removed: !window.__controller.imageExportDetails.background && !document.querySelector('[data-deck-image-background-clear]') };
  })()`);
  if (backgroundResult.error) throw Error(backgroundResult.error);
  if (!backgroundResult.listGreen || !backgroundResult.arenaGreen) throw Error('Lo sfondo caricato non compare nell\'immagine: ' + JSON.stringify(backgroundResult));
  if (!backgroundResult.kept || !backgroundResult.label.includes('sfondo-verde.png')) throw Error('Lo sfondo non resta dopo il cambio stile o il nome file non è mostrato: ' + JSON.stringify(backgroundResult));
  if (!backgroundResult.exportable || !backgroundResult.downloaded) throw Error('Con lo sfondo personalizzato l\'immagine non si esporta: ' + JSON.stringify(backgroundResult));
  if (!backgroundResult.removed || backgroundResult.clearedGreen) throw Error('Rimuovi sfondo non ripristina lo sfondo standard: ' + JSON.stringify(backgroundResult));
  const rejected = await evaluate(`(async()=>{
    const toasts = []; const original = window.__controller.onToast; window.__controller.onToast = (m) => toasts.push(m);
    const input = document.querySelector('[data-deck-image-background]');
    const transfer = new DataTransfer(); transfer.items.add(new File(['non è un\\'immagine'], 'note.txt', { type: 'text/plain' }));
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200)); window.__controller.onToast = original;
    return { toasts, background: !!window.__controller.imageExportDetails.background };
  })()`);
  if (rejected.background || !rejected.toasts.some(message => /immagine/i.test(message))) throw Error('Un file non immagine non viene rifiutato con un avviso: ' + JSON.stringify(rejected));
  console.log('PASS sfondo personalizzato: foto dell\'utente come sfondo in Lista torneo e Arena FPT, resta al cambio stile, export PNG ok, Rimuovi ripristina, file non immagine rifiutato');
  // Il resto del test riparte da Lista torneo, come prima di questo blocco.
  await evaluate(`document.querySelector('[data-deck-image-style="list"]').click()`);
  await delay(600);

  // Download: click deve tentare un <a download> (spy su HTMLAnchorElement.prototype.click).
  const downloadResult = await evaluate(`(async()=>{
    let clicked = false, downloadName = '';
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function(){ clicked = true; downloadName = this.download; };
    await window.__controller.downloadImageExport();
    HTMLAnchorElement.prototype.click = originalClick;
    return {clicked, downloadName};
  })()`);
  if (!downloadResult.clicked || downloadResult.downloadName !== 'fpt-deck-ui-test-deck.png') throw Error('Il download non ha prodotto il link/nome file atteso: ' + JSON.stringify(downloadResult));
  console.log('PASS bottone download: genera un link di download con nome file sanitizzato corretto');

  // Share: con Web Share stubbato come supportato, deve chiamare navigator.share (non il download).
  const shareUiResult = await evaluate(`(async()=>{
    let shareCalled = false, downloadClicked = false;
    navigator.share = async () => { shareCalled = true; };
    navigator.canShare = () => true;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function(){ downloadClicked = true; };
    await window.__controller.shareImageExport();
    HTMLAnchorElement.prototype.click = originalClick;
    navigator.share = undefined; navigator.canShare = undefined;
    return {shareCalled, downloadClicked};
  })()`);
  if (!shareUiResult.shareCalled || shareUiResult.downloadClicked) throw Error('Con Web Share supportato deve condividere, mai scaricare: ' + JSON.stringify(shareUiResult));
  console.log('PASS bottone condividi: con Web Share supportato chiama navigator.share, non il download');

  // --- 5) Preview progressiva reale: appare SUBITO con placeholder (senza
  // aspettare il preload), poi si aggiorna incrementale man mano che ogni
  // artwork arriva. Il caricamento reale ora passa da fetch() (pipeline
  // osservabile: status/content-type/blob/decode, non più un <img src>
  // "cieco"), quindi qui si intercetta window.fetch — non più window.Image —
  // per un artwork "lento" (risposta reale ritardata di proposito) e uno
  // "rotto" (una vera Response 404, un mock deterministico del proxy senza
  // toccare alcun file server/rete reale). L'artwork "lento" risolve con i
  // byte VERI di /icon-192.png: dimostra che l'immagine finita sul canvas
  // non è un placeholder ma è davvero passata dalla pipeline fetch. ---
  const progressiveResult = await evaluate(`(async()=>{
    const {renderDeckImagePreview, waitForPendingDeckImages} = await import('/js/deck-image-export.js');
    const originalFetch = window.fetch;
    const fetchCalls = [];
    window.fetch = async (input, init) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes('slow-marker')) { await new Promise(r => setTimeout(r, 500)); return originalFetch('/icon-192.png', init); }
      if (url.includes('broken-marker')) return new Response(new Blob([JSON.stringify({message:'non trovato'})], {type:'application/json'}), {status: 404});
      return originalFetch(input, init);
    };
    let drawImageCalls = 0;
    const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function(...args) { drawImageCalls++; return originalDrawImage.apply(this, args); };
    const deck = {
      name: 'Progressive Test', game: 'yugioh', deckTheme: 'arcane-purple', signatureCardId: null,
      cards: [
        { catalogCardId: 'fast-1', cardName: 'Veloce', section: 'main', quantity: 1, imageUrl: '/icon-192.png' },
        { catalogCardId: 'slow-1', cardName: 'Lenta', section: 'main', quantity: 1, imageUrl: '/icon-192.png?slow-marker=1' },
        { catalogCardId: 'broken-1', cardName: 'Rotta', section: 'main', quantity: 1, imageUrl: '/artwork-404.png?broken-marker=1' }
      ]
    };
    const canvas = document.createElement('canvas');
    let progressCount = 0;
    const { cache, ready } = renderDeckImagePreview(deck, { mode: 'clean', canvas, previewTimeoutMs: 150, concurrency: 6, onProgress: () => { progressCount++; } });
    // Osservazione SINCRONA, immediatamente dopo la chiamata: l'artwork lento
    // (ritardo artificiale 500ms) e quello rotto (richiede comunque un
    // round-trip di rete/fetch) non possono essere già risolti — la preview
    // è dunque comparsa PRIMA del completamento di qualunque immagine.
    const immediatelyAfterCall = {
      slowResolved: cache.images.has('/icon-192.png?slow-marker=1'),
      brokenResolved: cache.images.has('/artwork-404.png?broken-marker=1'),
      inFlightCount: cache.inFlight.size,
      drawImageCallsSoFar: drawImageCalls
    };
    await ready; // preview conclusa entro il timeout breve: il lento resta pendente
    const rightAfterReady = { slowStillPending: cache.inFlight.has('/icon-192.png?slow-marker=1') };
    await waitForPendingDeckImages(cache, { timeoutMs: 2000 }); // atteso SOLO a scopo di verifica dell'upgrade tardivo
    const slowImage = cache.images.get('/icon-192.png?slow-marker=1');
    const afterWaitPending = {
      fastResolved: cache.images.get('/icon-192.png') != null,
      slowResolved: slowImage != null,
      slowImageHasRealPixels: !!(slowImage && slowImage.naturalWidth > 0),
      brokenResolved: cache.images.has('/artwork-404.png?broken-marker=1'),
      brokenReason: cache.failures.get('/artwork-404.png?broken-marker=1')?.reason || null,
      progressCount,
      drawImageCallsAfterUpgrade: drawImageCalls,
      slowWentThroughFetch: fetchCalls.some(u => u.includes('slow-marker'))
    };
    window.fetch = originalFetch;
    CanvasRenderingContext2D.prototype.drawImage = originalDrawImage;
    return { immediatelyAfterCall, rightAfterReady, afterWaitPending };
  })()`);
  if (progressiveResult.immediatelyAfterCall.slowResolved || progressiveResult.immediatelyAfterCall.brokenResolved) throw Error('Un artwork lento/rotto risulta già risolto in modo sincrono, impossibile: ' + JSON.stringify(progressiveResult));
  if (progressiveResult.immediatelyAfterCall.inFlightCount !== 3) throw Error('Tutti e 3 gli artwork devono essere ancora in volo subito dopo la chiamata sincrona: ' + JSON.stringify(progressiveResult));
  if (!progressiveResult.rightAfterReady.slowStillPending) throw Error('Il timeout breve di preview deve lasciare l\'artwork lento pendente, non attenderlo: ' + JSON.stringify(progressiveResult));
  if (!progressiveResult.afterWaitPending.fastResolved || !progressiveResult.afterWaitPending.slowResolved) throw Error('Dopo aver atteso i soli pendenti, sia l\'artwork veloce che quello lento (upgrade tardivo) devono essere risolti: ' + JSON.stringify(progressiveResult));
  if (!progressiveResult.afterWaitPending.slowImageHasRealPixels) throw Error('L\'artwork lento risolto deve essere un\'immagine reale decodificata (naturalWidth>0), non un placeholder: ' + JSON.stringify(progressiveResult));
  if (!progressiveResult.afterWaitPending.slowWentThroughFetch) throw Error('L\'artwork lento deve essere passato realmente dalla pipeline fetch, non da un <img src> cieco: ' + JSON.stringify(progressiveResult));
  if (progressiveResult.afterWaitPending.brokenResolved) throw Error('Un artwork rotto (404) non deve mai diventare un falso successo in cache.images: ' + JSON.stringify(progressiveResult));
  if (progressiveResult.afterWaitPending.brokenReason !== 'http-404') throw Error('Un 404 deve produrre una diagnostica precisa (http-404), non un fallimento opaco: ' + JSON.stringify(progressiveResult));
  if (progressiveResult.afterWaitPending.progressCount < 2) throw Error('onProgress deve scattare per ogni artwork risolto, incluso l\'upgrade tardivo di quello lento: ' + JSON.stringify(progressiveResult));
  if (progressiveResult.afterWaitPending.drawImageCallsAfterUpgrade <= progressiveResult.immediatelyAfterCall.drawImageCallsSoFar) throw Error('Il redraw incrementale deve effettivamente disegnare l\'artwork arrivato in ritardo sul canvas (drawImage): ' + JSON.stringify(progressiveResult));
  console.log('PASS preview progressiva (browser reale): il canvas parte subito con placeholder (nessun artwork ancora risolto alla chiamata sincrona), il lento (byte reali via fetch, mai un <img src> cieco) resta un placeholder entro il timeout breve poi si aggiorna da solo con pixel reali disegnati sul canvas, il 404 produce una diagnostica precisa e non blocca nulla');

  // --- 6) One Piece end-to-end tramite la UI reale del DeckController:
  // stesso bottone "Genera immagine", stesse sezioni leader/main/don
  // dell'adapter One Piece, nessuna esclusione hardcoded per deck.game. ---
  const opUiResult = await evaluate(`(async()=>{
    const {DeckController} = await import('/js/decks.js');
    const deck = {
      id:'op1', persisted:true, ownerSlug:'daniele', name:'One Piece UI Test', format:'', game:'onepiece', deckTheme:'arcane-purple', deckBoxTemplate:'procedural', signatureCardId:null,
      cards:[
        {catalogCardId:'OP01-001', cardName:'Monkey.D.Luffy', section:'leader', quantity:1, imageUrl:'/icon-192.png'},
        {catalogCardId:'OP01-016', cardName:'Roronoa Zoro', section:'main', quantity:4, imageUrl:'/icon-192.png'},
        {catalogCardId:'don-1', cardName:'DON!!', section:'don', quantity:10, imageUrl:''}
      ]
    };
    const controller = new DeckController({
      api:{}, getState:() => ({decks:[deck], game:'onepiece', currentUser:'daniele'}),
      onRender:() => { document.querySelector('#app').innerHTML = controller.view(); controller.bind(document); },
      onToast:() => {}
    });
    controller.activeId = 'op1'; controller.screen = 'detail';
    document.querySelector('#app').innerHTML = controller.view(); controller.bind(document);
    controller.toggleMoreMenu();
    const hasButton = !!document.querySelector('[data-deck-image-open]');
    document.querySelector('[data-deck-image-open]')?.click();
    await new Promise(r => setTimeout(r, 400));
    const canvas = document.querySelector('[data-deck-image-canvas]');
    let clicked = false, downloadName = '';
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function(){ clicked = true; downloadName = this.download; };
    await controller.downloadImageExport();
    HTMLAnchorElement.prototype.click = originalClick;
    return { hasButton, hasCanvas: !!canvas, width: canvas?.width, height: canvas?.height, clicked, downloadName, busy: controller.imageExportBusy };
  })()`);
  if (!opUiResult.hasButton) throw Error('Bottone "Genera immagine" assente per un mazzo One Piece: non deve esistere alcuna esclusione su deck.game: ' + JSON.stringify(opUiResult));
  if (!opUiResult.hasCanvas || opUiResult.width !== 1080 || opUiResult.height !== 1350) throw Error('Canvas 1080x1350 non montato per un mazzo One Piece: ' + JSON.stringify(opUiResult));
  if (!opUiResult.clicked || opUiResult.downloadName !== 'fpt-deck-one-piece-ui-test.png') throw Error('Download non riuscito per un mazzo One Piece: ' + JSON.stringify(opUiResult));
  if (opUiResult.busy) throw Error('Lo stato busy deve tornare a false dopo il primo frame sincrono: ' + JSON.stringify(opUiResult));
  console.log('PASS One Piece end-to-end (browser reale, UI completa): bottone "Genera immagine" disponibile, canvas 1080x1350 con sezioni leader/main/don, download funzionante — nessun branching hardcoded YGO-only');

  // --- V1.1: controlli Readable/Poster, Deck Theme, Logo funzionano dalla UI reale ---
  const v11UiResult = await evaluate(`(async()=>{
    const {DeckController} = await import('/js/decks.js');
    const deck = {
      id:'v11', persisted:true, ownerSlug:'daniele', name:'V1.1 UI Test', format:'', game:'yugioh', deckTheme:'abyss-blue', deckBoxTemplate:'procedural', signatureCardId:'valid-1',
      cards:[
        {catalogCardId:'valid-1', cardName:'Artwork valido', section:'main', quantity:2, imageUrl:'/icon-192.png'},
        {catalogCardId:'valid-2', cardName:'Seconda carta', section:'extra', quantity:1, imageUrl:'/icon-192.png'}
      ]
    };
    const controller = new DeckController({
      api:{}, getState:() => ({decks:[deck], game:'yugioh', currentUser:'daniele'}),
      onRender:() => { document.querySelector('#app').innerHTML = controller.view(); controller.bind(document); },
      onToast:() => {}
    });
    controller.activeId = 'v11'; controller.screen = 'detail';
    document.querySelector('#app').innerHTML = controller.view(); controller.bind(document);
    controller.toggleMoreMenu();
    document.querySelector('[data-deck-image-open]').click();
    await new Promise(r => setTimeout(r, 500));
    const initialStyle = controller.imageExportStyle;
    const canvasBefore = document.querySelector('[data-deck-image-canvas]');
    const pixel = () => canvasBefore.toDataURL('image/png');
    const pixelBefore = pixel();

    // Evento/piazzamento: solo il canvas si ridisegna, il campo resta lo
    // stesso elemento (nessun onRender che farebbe perdere il focus).
    const eventField = document.querySelector('[data-deck-image-detail="event"]');
    eventField.focus(); eventField.value = 'Locals del venerdì'; eventField.dispatchEvent(new Event('input', { bubbles: true }));
    const place = document.querySelector('[data-deck-image-detail="place"]');
    place.value = '1° posto'; place.dispatchEvent(new Event('change', { bubbles: true }));
    const sameField = document.querySelector('[data-deck-image-detail="event"]') === eventField && document.activeElement === eventField;
    const sameCanvas = document.querySelector('[data-deck-image-canvas]') === canvasBefore;

    const canvas = document.querySelector('[data-deck-image-canvas]');
    return { initialStyle, details: controller.imageExportDetails, sameField, sameCanvas, redrawn: pixel() !== pixelBefore, canvasSize: { w: canvas.width, h: canvas.height } };
  })()`);
  if (v11UiResult.initialStyle !== 'arena') throw Error('Lo stile predefinito deve essere Arena FPT: ' + JSON.stringify(v11UiResult));
  if (v11UiResult.details.event !== 'Locals del venerdì' || v11UiResult.details.place !== '1° posto') throw Error('Evento/piazzamento non salvati nello stato del popup: ' + JSON.stringify(v11UiResult));
  if (!v11UiResult.sameField || !v11UiResult.sameCanvas) throw Error('Scrivere evento/piazzamento non deve ricreare il popup (focus perso): ' + JSON.stringify(v11UiResult));
  if (!v11UiResult.redrawn) throw Error('Evento/piazzamento non hanno ridisegnato il canvas: ' + JSON.stringify(v11UiResult));
  if (v11UiResult.canvasSize.w !== 1080 || v11UiResult.canvasSize.h !== 1350) throw Error('Il canvas deve restare sempre 1080x1350: ' + JSON.stringify(v11UiResult));
  console.log('PASS controlli UI reali: Arena FPT di default, evento/piazzamento ridisegnano il canvas senza ricreare il popup, canvas sempre 1080x1350');

  if ((await evaluate('window.__consoleErrors')).length) throw Error('Browser errors: ' + JSON.stringify(await evaluate('window.__consoleErrors')));
  console.log('PASS deck-image-export (browser reale): rendering/export/artwork/Web Share/UI/preview progressiva/One Piece completa senza errori console');
  // Exercise local assets WITH production proxy configured and export immediately
  // while a serial worker still has cards queued.
  const regression=await evaluate(`(async()=>{
    const {renderDeckImagePreview,exportDeckImageBlob,createDeckImageCache}=await import('/js/deck-image-export.js');
    const cache=createDeckImageCache();
    const cards=Array.from({length:30},(_,i)=>({catalogCardId:String(90000000+i),cardName:'Carta '+(i+1),section:i<18?'main':i<24?'extra':'side',quantity:i<18?2:1,imageUrl:'/assets/fpt-card-hero.png?export='+i}));
    const result=renderDeckImagePreview({name:'FPT ? Tournament Deck',game:'yugioh',format:'TCG Avanzato',cards},{ownerName:'FPT Cards',proxyUrl:'/api/card-image-proxy',cache,concurrency:1});
    const blob=await exportDeckImageBlob(result.canvas,{...result,cache});
    window.__exportCanvas=result.canvas;
    return {loaded:cache.images.size,failed:cache.failures.size,size:blob.size};
  })()`);
  if(regression.loaded!==30||regression.failed||!regression.size)throw Error('Queued/local artwork export regression: '+JSON.stringify(regression));
  const png=await evaluate('__exportCanvas.toDataURL("image/png").split(",")[1]');
  const screenshot=path.join(tmpdir(),'fpt-deck-export-preview.png');
  await (await import('node:fs/promises')).writeFile(screenshot,Buffer.from(png,'base64'));
  console.log('PASS local artwork bypasses proxy; immediate export waits for all 30 queued images. Preview: '+screenshot);

} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
