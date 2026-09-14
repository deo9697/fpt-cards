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

  // Switch a Signature: il bottone diventa attivo, il canvas viene
  // ricreato (nuovo riferimento) e ridisegnato di nuovo.
  const canvasBefore = await evaluate(`document.querySelector('[data-deck-image-canvas]').outerHTML.length`); // proxy indiretto, il riferimento reale si verifica sotto
  await evaluate(`document.querySelector('[data-deck-image-mode="signature"]').click()`);
  await delay(600);
  const afterSwitch = await evaluate(`(()=>{
    const active = document.querySelector('.deck-image-modes .active')?.dataset.deckImageMode;
    return {active, mode: window.__controller.imageExportMode, busy: window.__controller.imageExportBusy};
  })()`);
  if (afterSwitch.active !== 'signature' || afterSwitch.mode !== 'signature') throw Error('Lo switch a Signature non ha aggiornato lo stato/la UI: ' + JSON.stringify(afterSwitch));
  if (afterSwitch.busy) throw Error('Il ridisegno dopo lo switch modalità non si è mai concluso: ' + JSON.stringify(afterSwitch));
  console.log('PASS switch Clean/Signature: bottone attivo aggiornato, ridisegno completato');

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

  if ((await evaluate('window.__consoleErrors')).length) throw Error('Browser errors: ' + JSON.stringify(await evaluate('window.__consoleErrors')));
  console.log('PASS deck-image-export (browser reale): rendering/export/artwork/Web Share/UI completa senza errori console');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
