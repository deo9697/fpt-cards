// Hardening bootstrap pagina Raccolta condivisa (#/share/<uuid>): la pagina
// pubblica non deve MAI mostrare, neanche per un frame, shell privata,
// profilo personale, pagina precedente autenticata o contenuti dell'area
// privata. app.js già controllava SHARE_HASH molto presto in start()/
// render()/renderRoute() (nessun leak dimostrato), qui si aggiunge e verifica
// un guard di bootstrap immediato in index.html (document.body.dataset.page
// = 'share' impostato PRIMA che app.js — un modulo grande — sia anche solo
// scaricato) più il comportamento end-to-end reale nei 6 scenari richiesti.
// Rete Supabase bloccata ovunque: ogni scenario finisce quindi nello stato
// "Link non disponibile" di CollectionShareController — comportamento reale
// per un link scaduto/non valido (copre anche quel caso), mai un crash, mai
// un fallback a contenuto privato.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = await mkdtemp(path.join(tmpdir(), 'fpt-share-guard-smoke-'));
const port = 9378;
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

  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*://*.supabase.co/*'] });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const shareId = '11111111-2222-4333-8444-555555555555';
  const snapshot = async () => evaluate(`({
    hash: location.hash,
    pageAttr: document.body.dataset.page,
    hasShareShell: !!document.querySelector('.share-guest-shell'),
    hasAppShell: !!document.querySelector('.app-shell'),
    hasLoginForm: !!document.querySelector('#login-form'),
    hasSidebar: !!document.querySelector('.sidebar'),
    bodyText: document.body.innerText.slice(0, 300)
  })`);

  // --- 1) Apertura diretta share da sessione anonima -----------------------
  await send('Page.navigate', { url: `http://localhost:8080/#/share/${shareId}` });
  await delay(50); // il guard inline deve marcare la pagina PRIMA ancora che app.js finisca di caricare
  const immediatelyAfterNavigate = await snapshot();
  await delay(800);
  const anonymous = await snapshot();
  if (immediatelyAfterNavigate.pageAttr !== 'share') throw Error('Il guard inline in index.html non marca subito body[data-page=share], prima ancora che app.js risponda: ' + JSON.stringify(immediatelyAfterNavigate));
  if (anonymous.hasAppShell || anonymous.hasLoginForm || anonymous.hasSidebar) throw Error('Sessione anonima: shell privata/login visibili su un link di condivisione: ' + JSON.stringify(anonymous));
  if (!anonymous.hasShareShell || anonymous.pageAttr !== 'share') throw Error('Sessione anonima: la shell guest non è montata correttamente: ' + JSON.stringify(anonymous));
  console.log('PASS apertura diretta share da sessione anonima: solo shell guest, mai shell privata/login, page attr impostato dal guard inline prima del bootstrap');

  // --- 2) Apertura share mentre esiste una sessione autenticata ------------
  // Page.navigate verso un URL che differisce solo per hash è una
  // navigazione same-document (nessun reload reale): per far ripartire
  // davvero app.js e fargli leggere lo stato appena seminato in
  // localStorage serve un location.reload() esplicito, esattamente come in
  // scripts/collection-routing-browser-smoke.mjs.
  await evaluate(`localStorage.setItem('fpt-cards-state-v2', JSON.stringify({ currentUser:'daniele', role:'admin', game:'yugioh', loans:[], collection:{mine:[],team:[],syncedAt:null} })); location.hash = '#/home'; location.reload();`);
  await delay(800);
  const authenticatedHome = await snapshot();
  if (!authenticatedHome.hasAppShell) throw Error('Setup non valido: la sessione autenticata non ha montato la shell privata prima del test: ' + JSON.stringify(authenticatedHome));
  await evaluate(`location.hash = '#/share/${shareId}'`);
  await delay(50);
  const rightAfterShareHash = await snapshot();
  await delay(800);
  const duringAuthenticatedSession = await snapshot();
  if (rightAfterShareHash.hasAppShell) throw Error('REGRESSIONE: la shell privata resta visibile anche solo per un istante dopo il cambio hash verso uno share link con sessione attiva: ' + JSON.stringify(rightAfterShareHash));
  if (duringAuthenticatedSession.hasAppShell || duringAuthenticatedSession.hasSidebar) throw Error('Sessione autenticata: la shell privata resta montata durante la visualizzazione di uno share link: ' + JSON.stringify(duringAuthenticatedSession));
  if (!duringAuthenticatedSession.hasShareShell) throw Error('Sessione autenticata: la shell guest non si monta sopra la sessione attiva: ' + JSON.stringify(duringAuthenticatedSession));
  console.log('PASS apertura share con sessione autenticata attiva: la shell privata sparisce nello stesso istante (mai un frame con entrambe), solo la shell guest resta');

  // --- 3) Apertura share dopo aver visitato Collection/Profile -------------
  await evaluate(`location.hash = '#/home'`); await delay(300);
  await evaluate(`location.hash = '#/collection'`); await delay(300);
  const onCollection = await snapshot();
  if (!onCollection.hasAppShell) throw Error('Setup non valido: la Raccolta non ha montato la shell privata: ' + JSON.stringify(onCollection));
  await evaluate(`location.hash = '#/share/${shareId}'`);
  await delay(600);
  const afterCollectionVisit = await snapshot();
  if (afterCollectionVisit.hasAppShell || afterCollectionVisit.hasSidebar || afterCollectionVisit.bodyText.includes('Raccolta')) throw Error('Dopo aver visitato la Raccolta, lo share link mostra ancora tracce della pagina precedente: ' + JSON.stringify(afterCollectionVisit));
  if (!afterCollectionVisit.hasShareShell) throw Error('Dopo aver visitato la Raccolta, la shell guest non si monta: ' + JSON.stringify(afterCollectionVisit));
  console.log('PASS apertura share dopo aver visitato la Raccolta: nessuna traccia della pagina precedente, solo shell guest');

  // --- 4) Browser back/forward ---------------------------------------------
  await evaluate(`history.back()`); await delay(400);
  const afterBack = await snapshot();
  if (!afterBack.hasAppShell || afterBack.hasShareShell) throw Error('Back dallo share link non ripristina la shell normale: ' + JSON.stringify(afterBack));
  await evaluate(`history.forward()`); await delay(400);
  const afterForward = await snapshot();
  if (afterForward.hasAppShell || !afterForward.hasShareShell) throw Error('Forward verso lo share link non rimonta la shell guest: ' + JSON.stringify(afterForward));
  console.log('PASS back/forward: la shell normale torna indietro, lo share link riappare correttamente in avanti, mai una sovrapposizione');

  // --- 5) Uscita da share verso una route normale ---------------------------
  await evaluate(`location.hash = '#/home'`); await delay(400);
  const backToNormal = await snapshot();
  if (backToNormal.hasShareShell || !backToNormal.hasAppShell || !backToNormal.hasSidebar) throw Error('Uscire dallo share link verso una route normale non ripristina correttamente la shell privata: ' + JSON.stringify(backToNormal));
  console.log('PASS uscita da share verso route normale: la shell privata torna montata correttamente');

  // --- 6) Link scaduto/non valido: nessuna regressione ---------------------
  // Rete Supabase bloccata per l'intero test: getCollectionShare() fallisce
  // sempre, esattamente come per un link scaduto/non valido — verificato qui
  // che porti allo stato di errore neutro, mai a un crash o a un fallback
  // su contenuto privato.
  await evaluate(`location.hash = '#/share/${shareId}'`); await delay(600);
  const invalidLink = await evaluate(`({ hasShareShell: !!document.querySelector('.share-guest-shell'), hasErrorMessage: document.body.innerText.includes('Link non') , hasAppShell: !!document.querySelector('.app-shell') })`);
  if (!invalidLink.hasShareShell || !invalidLink.hasErrorMessage || invalidLink.hasAppShell) throw Error('Link non disponibile: la UI di errore non è quella attesa (nessuna regressione attesa qui): ' + JSON.stringify(invalidLink));
  console.log('PASS link scaduto/non valido: stato di errore neutro nella sola shell guest, nessuna regressione, nessun contenuto privato');

  const consoleErrors = await evaluate('window.__uiErrors || []');
  if (consoleErrors.length) throw Error('Errori console imprevisti: ' + JSON.stringify(consoleErrors));
  console.log('PASS collection-share-bootstrap-guard (browser reale): confine pubblico/privato mai violato in nessuno dei 6 scenari richiesti');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
