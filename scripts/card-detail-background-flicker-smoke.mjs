// Verifica il fix del flicker di sfondo nel dettaglio carta della Raccolta:
// finché il tipo YGOPRODeck non è risolto (typeReady=false) lo stage non deve
// mai mostrare lo sfondo di default/errato, solo lo stato neutro "is-type-pending".
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-detail-bg-smoke-')), port = 9372;
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

  await evaluate(`(async()=>{
    const {collectionDetailView}=await import('/js/collection.js');
    document.head.insertAdjacentHTML('afterbegin','<base href="/">');
    window.__card={id:'mine-1',printingId:'printing-1',game:'yugioh',cardName:'Raigeki',setCode:'DUDE-EN005',rarity:'Ultra Rare',language:'Italiano',condition:'Near Mint',edition:'1ª Edizione',quantityOwned:2,quantityLoaned:0,quantityReserved:0,quantityAvailable:2,imageUrl:'assets/fpt-card-hero.png'};
    window.__render=(cardType='',typeReady=true)=>{document.querySelector('#app').innerHTML=collectionDetailView('mine-1','mine',{mine:[__card],team:[]},true,'me',[],cardType,typeReady);};
  })()`);

  // 1. Tipo ancora sconosciuto (fetch in corso): niente sfondo di default/errato, solo stato neutro.
  await evaluate(`__render('',false)`);
  const pendingState = await evaluate(`(()=>{const s=document.querySelector('.inventory-art-stage');return {hasPendingClass:s.classList.contains('is-type-pending'),hasInlineStyle:!!s.getAttribute('style')}})()`);
  if (!pendingState.hasPendingClass) throw Error('Stato loading atteso (is-type-pending) mancante durante il fetch del tipo');
  if (pendingState.hasInlineStyle) throw Error('Sfondo (di default o di una carta precedente) mostrato mentre il tipo è ancora sconosciuto: flicker non risolto');

  // 2. Tipo risolto come Spell: sfondo corretto subito, nessuno stato pending.
  await evaluate(`__render('Spell Card',true)`);
  const spell = await evaluate(`(()=>{const s=document.querySelector('.inventory-art-stage');return {hasPendingClass:s.classList.contains('is-type-pending'),style:s.getAttribute('style')||''}})()`);
  if (spell.hasPendingClass) throw Error('Classe is-type-pending ancora presente con tipo risolto');
  if (!spell.style.includes('spell_background.png')) throw Error('Sfondo Spell non applicato immediatamente: ' + spell.style);

  // 3. Cambio rapido Spell -> Trap (entrambi già noti): mai un frame con lo sfondo precedente.
  await evaluate(`__render('Trap Card',true)`);
  const trap = await evaluate(`(()=>{const s=document.querySelector('.inventory-art-stage');return {style:s.getAttribute('style')||''}})()`);
  if (trap.style.includes('spell_background.png')) throw Error('Sfondo Spell residuo dopo passaggio a Trap');
  if (!trap.style.includes('trap_backgroud.png')) throw Error('Sfondo Trap non applicato: ' + trap.style);

  // 4. Fusion con tipo noto ma non ancora "pronto" per un'altra carta: nessun sfondo Trap/Spell residuo.
  await evaluate(`__render('',false)`);
  const afterClose = await evaluate(`(()=>{const s=document.querySelector('.inventory-art-stage');return {hasInlineStyle:!!s.getAttribute('style'),hasPendingClass:s.classList.contains('is-type-pending')}})()`);
  if (afterClose.hasInlineStyle) throw Error('Sfondo Trap residuo mostrato per la carta successiva mentre il suo tipo è ancora sconosciuto');
  if (!afterClose.hasPendingClass) throw Error('Stato pending mancante per la carta successiva');

  if ((await evaluate('__consoleErrors')).length) throw Error('Browser errors: ' + JSON.stringify(await evaluate('__consoleErrors')));
  console.log('PASS card detail background: nessun flash di sfondo precedente/default durante il fetch del tipo, sfondo corretto immediato quando noto, nessun residuo tra cambi rapidi');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
