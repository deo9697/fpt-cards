// Tutorial Blattaman nell'app REALE (index.html + app.js), con lo stesso mock
// Supabase di scripts/auth-regression-smoke.mjs (letto da quel file). Verifica:
// - login di un membro di un team beta: il tutorial parte da solo, js/tutorial.js
//   non è mai scaricato prima del login; ogni tocco porta al passo successivo sulla
//   pagina giusta col pulsante illuminato, Blattaman in basso e fumetto sopra;
//   l'ultimo passo chiude e torna alla Home (TUTORIAL_VIEWPORT=desktop, TUTORIAL_SHOTS=dir);
// - nuovo login sullo stesso dispositivo: non riparte;
// - membro del team F.P.T. (core): non parte da solo;
// - Impostazioni → "Rivedi" lo riapre, Esc lo chiude; nessun errore JavaScript.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const root = process.cwd(), port = 8094, debugPort = 9354;
const authSource = fs.readFileSync(path.join(root, 'scripts', 'auth-regression-smoke.mjs'), 'utf8');
const mockBlock = authSource.slice(authSource.indexOf('const members = ['), authSource.indexOf('\nconst mime = {'));
// Il team arriva da window.__tutorialTeam (null = core), impostato prima del login.
const fakeSupabaseSource = new Function(`${mockBlock}\nreturn fakeSupabaseSource;`)()
  .replace("if(name==='get_my_team') return {data:null,error:null};", "if(name==='get_my_team') return {data:window.__tutorialTeam||null,error:null};");
if (!fakeSupabaseSource.includes('window.__tutorialTeam')) throw new Error('Mock get_my_team non trovato in auth-regression-smoke.mjs');

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
  browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(os.tmpdir(), `fpt-tutorial-${Date.now()}`)}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
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
  const waitFor = async (expression, message, attempts = 100) => { for (let i = 0; i < attempts; i++) { if (await evaluate(expression)) return; await delay(100); } throw new Error(message + ' · ' + JSON.stringify(await evaluate(`({url:location.href,body:document.body.innerText.slice(0,200)})`))); };
  const login = async team => {
    await call('Page.navigate', { url: `http://127.0.0.1:${port}/#/home` });
    await waitFor(`document.querySelectorAll('#member option').length === 3`, 'Schermata di login non pronta');
    await evaluate(`window.__tutorialTeam = ${JSON.stringify(team)}`);
    await evaluate(`(()=>{const s=document.querySelector('#member');s.value='existing-member';s.dispatchEvent(new Event('change',{bubbles:true}));const p=document.querySelector('#pin');p.value='1234';p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit();})()`);
    await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Login non completato');
    await waitFor(`window.__authTest.syncInFlight===0`, 'Sincronizzazione iniziale non completata');
  };
  const logout = async () => { await evaluate(`document.querySelector('[data-logout]').click()`); await waitFor(`Boolean(document.querySelector('#login-form'))`, 'Logout non completato'); };
  await call('Runtime.enable'); await call('Network.enable'); await call('Page.enable');
  const desktop = process.env.TUTORIAL_VIEWPORT === 'desktop';
  await call('Emulation.setDeviceMetricsOverride', desktop ? { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false } : { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  const beta = { id:'beta-team', name:'Alpha Squad', kind:'beta', isOwner:true, memberCount:1, canInviteToTeam:true, canInviteNewTeam:false };
  await login(beta);
  await waitFor(`Boolean(document.querySelector('.blatta-tour .blatta-speech'))`, 'Il tutorial non è partito per un membro beta');
  const count = () => evaluate(`document.querySelector('.blatta-count')?.textContent || ''`);
  const steps = Number((await count()).split('/')[1]);
  assert(steps >= 8, 'Troppi pochi passi: ' + steps);
  assert(!(await evaluate(`Boolean(document.querySelector('.blatta-tour button:not(.blatta-skip)'))`)), 'Il tour non deve avere pulsanti avanti/indietro');
  // Ogni passo: pagina giusta, pulsante illuminato quando esiste nel mock, Blattaman visibile.
  const expected = { 3:'collection', 4:'collection', 5:'decks', 6:'loans', 7:'market', 8:'stats', 9:'team', 10:'settings' };
  const spotlit = [];
  for (let s = 1; s <= steps; s++) {
    await waitFor(`document.querySelector('.blatta-count')?.textContent === '${s}/${steps}'`, `Passo ${s} non mostrato`);
    if (process.env.TUTORIAL_DEBUG) console.log('wait', s);
    if (expected[s]) await waitFor(`location.hash === '#/${expected[s]}'`, `Il passo ${s} non porta su ${expected[s]}`);
    await delay(3400);
    const state = await evaluate(`(()=>{const spot=document.querySelector('.blatta-spot'),m=document.querySelector('.blatta-mascot').getBoundingClientRect(),s=document.querySelector('.blatta-speech').getBoundingClientRect();return {spot:!spot.hidden,mascotBottom:m.bottom<=innerHeight+1&&m.top>innerHeight*0.35,speechAboveMascot:s.bottom<=m.top+40,revealed:document.querySelector('.blatta-tour').classList.contains('is-revealed')}})()`);
    assert(state.mascotBottom && state.speechAboveMascot, `Passo ${s}: Blattaman in basso e fumetto sopra non rispettati ` + JSON.stringify(state));
    if (process.env.TUTORIAL_DEBUG) console.log('step', s, await evaluate('location.hash'), JSON.stringify(state));
    if (state.spot) spotlit.push(s);
    if (process.env.TUTORIAL_SHOTS) fs.writeFileSync(path.join(process.env.TUTORIAL_SHOTS, `step-${s}.png`), Buffer.from((await call('Page.captureScreenshot', { format:'png' })).data, 'base64'));
    if (!state.revealed) await evaluate(`document.querySelector('.blatta-tour').click()`);
    await evaluate(`document.querySelector('.blatta-tour').click()`);
  }
  await waitFor(`!document.querySelector('.blatta-tour') && !document.body.classList.contains('blatta-tour-open')`, 'L\'ultimo passo non chiude il tutorial');
  await waitFor(`location.hash === '#/home'`, 'A fine tour non torna alla Home');
  assert([2, 3, 4, 10].every(s => spotlit.includes(s)), 'Pulsanti non illuminati: ' + JSON.stringify(spotlit));
  console.log(`PASS beta: parte da solo, ${steps} passi a tocco su pagine reali, faretto sui passi ${spotlit.join(',')}, fine → Home`);

  await logout(); await login(beta); await delay(800);
  assert(!(await evaluate(`Boolean(document.querySelector('.blatta-tour'))`)), 'Il tutorial è ripartito dopo essere già stato visto');
  console.log('PASS beta: al login successivo non riparte');

  await logout(); await evaluate(`localStorage.clear()`); await login(null); await delay(800);
  assert(!(await evaluate(`Boolean(document.querySelector('.blatta-tour'))`)), 'Il tutorial non deve partire da solo per il team core');
  console.log('PASS core F.P.T.: non parte da solo');

  await evaluate(`location.hash = '#/settings'`);
  await waitFor(`Boolean(document.querySelector('[data-tutorial-open]'))`, 'Voce Tutorial assente nelle Impostazioni');
  await evaluate(`document.querySelector('[data-tutorial-open]').click()`);
  await waitFor(`Boolean(document.querySelector('.blatta-tour .blatta-speech'))`, 'Rivedi non riapre il tutorial');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(`!document.querySelector('.blatta-tour')`, 'Esc non chiude il tutorial');
  console.log('PASS Impostazioni: "Rivedi" lo riapre, Esc lo chiude');

  const firstTutorialRequest = requested.indexOf('js/tutorial.js');
  assert(firstTutorialRequest > requested.indexOf('app.js'), 'js/tutorial.js deve arrivare solo dopo app.js, su richiesta');
  assert(dialogs.length === 0, 'Dialoghi inattesi durante il tour: ' + JSON.stringify(dialogs));
  assert(errors.length === 0, 'Errori JavaScript: ' + JSON.stringify(errors));
  console.log('PASS nessun errore JavaScript; js/tutorial.js caricato solo su richiesta');
} finally {
  try { ws?.close(); } catch {}
  browser?.kill();
  server.close();
}
