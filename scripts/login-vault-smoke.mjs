// Login "Vetrina dei Rari" nell'app REALE (index.html + app.js), con lo stesso
// mock Supabase di scripts/auth-regression-smoke.mjs (letto da quel file) più
// la RPC pubblica list_login_showcase. Verifica:
// - vetrina: 5 carte, quelle della RPC compaiono, badge della carta più rara;
//   nessuno scroll orizzontale a 360/390 px e su desktop;
// - campo PIN: non apre la tastiera del telefono (readonly + inputmode none),
//   al tocco apre il tastierino a carte coperte; ogni cifra gira una carta,
//   Cancella ne rigira una, Entra si attiva a 4 cifre, Esc chiude, riapertura da zero;
// - cifre anche da tastiera fisica; PIN sbagliato → messaggio e profilo conservato;
// - accesso completo dal tastierino; js/login-vault.js mai nel percorso critico;
//   nessun errore JavaScript. LOGIN_SHOTS=dir salva gli screenshot.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const root = process.cwd(), port = 8095, debugPort = 9355;
const authSource = fs.readFileSync(path.join(root, 'scripts', 'auth-regression-smoke.mjs'), 'utf8');
const mockBlock = authSource.slice(authSource.indexOf('const members = ['), authSource.indexOf('\nconst mime = {'));
const membersLine = "if(name==='list_login_members') return {data:members,error:null};";
const fakeSupabaseSource = new Function(`${mockBlock}\nreturn fakeSupabaseSource;`)()
  .replace(membersLine, `if(name==='list_login_showcase'){window.__showcaseCalls=(window.__showcaseCalls||0)+1;return {data:window.__showcase||[],error:null};}\n      ${membersLine}`);
if (!fakeSupabaseSource.includes('list_login_showcase')) throw new Error('Mock list_login_members non trovato in auth-regression-smoke.mjs');

const shots = process.env.LOGIN_SHOTS;
const local = name => `http://127.0.0.1:${port}/${name}`;
// Con LOGIN_SHOTS si usano le immagini vere del catalogo (serve rete); altrimenti asset locali.
const images = shots
  ? ['https://artworks-en-n.ygoresources.com/2/10/57_1.png', 'https://artworks-en-n.ygoresources.com/0/53/28_1.png', 'https://artworks-en-n.ygoresources.com/0/86/55_1.png', 'https://artworks-en-n.ygoresources.com/2/13/47_1.png', 'https://artworks-en-n.ygoresources.com/1/4/42_1.png', 'https://artworks-en-n.ygoresources.com/0/75/49_1.png']
  : Array.from({ length: 6 }, () => local('assets/fpt-card-hero.webp'));
const showcase = ['Mitsurugi no Mikoto, Saji', 'Reinforcement of the Army', 'XX-Saber Hyunlei', 'Mitsurugi no Mikoto, Aramasa', 'Coach King Giantrainer', 'Mist Wurm']
  .map((card_name, i) => ({ card_name, rarity: i === 4 ? 'Quarter Century Secret Rare' : 'Starlight Rare', set_code: 'L26D-ENM05', image_url: images[i], copies: [11, 4, 4, 3, 2, 2][i] }));

const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.webp':'image/webp', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req, res) => {
  const requestPath = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
  if (requestPath === '/test-supabase.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return res.end(fakeSupabaseSource); }
  const relative = requestPath === '/' ? 'index.html' : requestPath.slice(1), file = path.resolve(root, relative);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); return res.end('not found'); }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    if (relative === 'index.html') return res.end(data.toString('utf8').replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', '/test-supabase.js'));
    res.end(data);
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let browser, ws;
try {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(os.tmpdir(), `fpt-login-vault-${Date.now()}`)}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let tab; for (let i = 0; i < 80 && !tab; i++) { try { tab = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await delay(150); } }
  ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map(), requested = [], errors = [], dialogs = [];
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Network.requestWillBeSent') requested.push(m.params.request.url.replace(`http://127.0.0.1:${port}/`, '').split('?')[0]);
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } })); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    const task = pending.get(m.id); if (task) { pending.delete(m.id); m.error ? task.reject(new Error(m.error.message)) : task.resolve(m.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const waitFor = async (expression, message, attempts = 100) => { for (let i = 0; i < attempts; i++) { if (await evaluate(expression)) return; await delay(100); } throw new Error(message + ' · ' + JSON.stringify(await evaluate(`({url:location.href,body:document.body.innerText.slice(0,200),toast:document.querySelector('#toast')?.textContent})`))); };
  const shot = async name => { if (shots) fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
  const viewport = (width, height, mobile) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height });
  const key = async (key, code, vk) => { await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); };
  const tap = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const padState = () => evaluate(`({open:Boolean(document.querySelector('.pinpad')), up:document.querySelectorAll('.pinpad-slot.is-up').length, go:!document.querySelector('[data-pad="go"]')?.disabled, line:document.querySelector('.pinpad-line')?.textContent||'', pin:document.querySelector('#pin')?.value})`);

  await call('Runtime.enable'); await call('Network.enable'); await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.__showcase = ${JSON.stringify(showcase)};` });
  await viewport(390, 844, true);
  await call('Page.navigate', { url: `http://127.0.0.1:${port}/#/home` });
  await waitFor(`document.querySelectorAll('#member option').length === 3`, 'Schermata di login non pronta');
  assert(await evaluate(`document.querySelectorAll('.login-vault .vault-card').length === 5`), 'La vetrina deve avere 5 carte');
  await waitFor(`document.querySelectorAll('.vault-card.is-loaded').length === 5`, 'Le carte della vetrina non sono comparse');
  await waitFor(`!document.querySelector('[data-vault-badge]').hidden`, 'Badge della carta più rara assente');
  const badge = await evaluate(`document.querySelector('[data-vault-badge]').textContent`);
  assert(badge.includes('Mitsurugi no Mikoto, Saji') && badge.includes('11 copie'), 'Badge inatteso: ' + badge);
  const centre = await evaluate(`document.querySelector('.vault-card:nth-child(3) img').alt`);
  assert(centre === 'Mitsurugi no Mikoto, Saji', 'La carta più rara deve stare al centro: ' + centre);
  const pinAttrs = await evaluate(`(()=>{const p=document.querySelector('#pin');return {readonly:p.readOnly, inputmode:p.getAttribute('inputmode'), type:p.type}})()`);
  assert(pinAttrs.readonly && pinAttrs.inputmode === 'none' && pinAttrs.type === 'password', 'Il campo PIN non deve aprire la tastiera del telefono: ' + JSON.stringify(pinAttrs));
  await delay(1200); await shot('login-390');
  console.log('PASS vetrina: 5 carte dalla RPC, la più rara al centro, badge "' + badge + '"');

  for (const [width, height, mobile] of [[360, 780, true], [390, 844, true], [1280, 800, false]]) {
    await viewport(width, height, mobile); await delay(150);
    const layout = await evaluate(`({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,select:document.querySelector('#member').getBoundingClientRect().width,form:document.querySelector('.vault-form').getBoundingClientRect()})`);
    assert(layout.scroll === layout.client && layout.select > 250, `Layout login non valido a ${width}px: ` + JSON.stringify(layout));
    if (width === 1280) { await delay(600); await shot('login-1280'); }
  }
  await viewport(390, 844, true); await delay(150);
  console.log('PASS layout a 360, 390 e 1280 px senza scroll orizzontale');

  assert(!requested.slice(0, requested.indexOf('app.js') + 1).includes('js/login-vault.js'), 'login-vault.js non deve precedere app.js');
  await tap('#pin');
  await waitFor(`Boolean(document.querySelector('.pinpad .pinpad-keys'))`, 'Il tastierino non si apre al tocco del PIN');
  let s = await padState();
  assert(s.up === 0 && !s.go, 'Il tastierino deve partire vuoto: ' + JSON.stringify(s));
  for (const digit of ['1', '2', '3']) await tap(`.pinpad-key[data-digit="${digit}"]`);
  s = await padState();
  assert(s.up === 3 && !s.go && s.pin === '123', 'Dopo 3 cifre: ' + JSON.stringify(s));
  await tap('[data-pad="del"]');
  s = await padState(); assert(s.up === 2 && s.pin === '12', 'Cancella non rigira la carta: ' + JSON.stringify(s));
  await key('3', 'Digit3', 51); await key('4', 'Digit4', 52);
  s = await padState(); assert(s.up === 4 && s.go && s.pin === '1234' && s.line.includes('Trasisti'), 'Tastiera fisica / 4 cifre: ' + JSON.stringify(s));
  await delay(700); await shot('pinpad-390');
  await key('Escape', 'Escape', 27);
  await waitFor(`!document.querySelector('.pinpad')`, 'Esc non chiude il tastierino');
  await tap('#pin');
  await waitFor(`Boolean(document.querySelector('.pinpad'))`, 'Il tastierino non si riapre');
  s = await padState(); assert(s.up === 0 && s.pin === '', 'La riapertura deve ripartire da zero: ' + JSON.stringify(s));
  await tap('[data-pad="close"]');
  await waitFor(`!document.querySelector('.pinpad')`, 'Chiudi non chiude il tastierino');
  console.log('PASS tastierino: carte girate per cifra, Cancella, tastiera fisica, Entra a 4 cifre, Esc/Chiudi, riapertura da zero');

  await evaluate(`window.__authTest.wrongPinMode=true`);
  await evaluate(`(()=>{const s=document.querySelector('#member');s.value='existing-member';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await tap('#pin'); await waitFor(`Boolean(document.querySelector('.pinpad'))`, 'Tastierino non aperto');
  for (const digit of ['9', '9', '9', '9']) await tap(`.pinpad-key[data-digit="${digit}"]`);
  await tap('[data-pad="go"]');
  await waitFor(`document.querySelector('#toast').textContent.includes('PIN non corretto')`, 'PIN sbagliato senza messaggio');
  await waitFor(`!document.querySelector('.pinpad')`, 'Il tastierino deve chiudersi dopo l\'invio');
  const kept = await evaluate(`document.querySelector('#member').value`);
  assert(kept === 'existing-member', 'Dopo un PIN sbagliato il profilo deve restare selezionato: ' + JSON.stringify(kept));
  console.log('PASS PIN sbagliato: messaggio, profilo conservato');

  await evaluate(`window.__authTest.wrongPinMode=false`);
  await tap('#pin'); await waitFor(`Boolean(document.querySelector('.pinpad'))`, 'Tastierino non aperto');
  for (const digit of ['1', '2', '3', '4']) await tap(`.pinpad-key[data-digit="${digit}"]`);
  await tap('[data-pad="go"]');
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Accesso dal tastierino non completato');
  await waitFor(`!document.querySelector('.pinpad') && !document.body.classList.contains('pinpad-open')`, 'Il tastierino deve chiudersi dopo l\'accesso');
  console.log('PASS accesso completo dal tastierino');

  assert(dialogs.length === 0, 'Dialoghi inattesi: ' + JSON.stringify(dialogs));
  assert(errors.length === 0, 'Errori JavaScript: ' + JSON.stringify(errors));
  console.log('PASS nessun errore JavaScript; login-vault.js caricato dopo il primo disegno');
} finally {
  try { ws?.close(); } catch {}
  browser?.kill();
  server.close();
}
