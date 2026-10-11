// Route lazy loading nell'app REALE (index.html + app.js), con lo stesso mock
// Supabase di scripts/auth-regression-smoke.mjs (letto da quel file, non
// duplicato). Verifica:
// - schermata di login: fast-scan.js, team.js, admin.js,
//   market-variant-admin.js, collection-share.js e collection-name-aliases.js
//   NON vengono scaricati;
// - dopo il login, a browser inattivo, fast-scan.js viene solo prefetchato;
// - Team e Fast Scan si aprono dal router reale: caricamento su richiesta,
//   segnaposto, poi la pagina vera; nessun errore JavaScript.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const root = process.cwd(), port = 8093, debugPort = 9353;
const authSource = fs.readFileSync(path.join(root, 'scripts', 'auth-regression-smoke.mjs'), 'utf8');
const mockBlock = authSource.slice(authSource.indexOf('const members = ['), authSource.indexOf('\nconst mime = {'));
const fakeSupabaseSource = new Function(`${mockBlock}\nreturn fakeSupabaseSource;`)();
const LAZY = ['js/fast-scan.js', 'js/team.js', 'js/admin.js', 'js/market-variant-admin.js', 'js/collection-share.js', 'js/collection-name-aliases.js', 'market/providers.js'];
// Controller post-login: sulla schermata di accesso possono arrivare SOLO come
// prefetch a browser inattivo, cioè dopo che il form di login è già disegnato.
const POST_LOGIN = ['js/decks.js', 'js/market-watch.js', 'js/stats.js', 'js/deck-image-export.js'];

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
  browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(os.tmpdir(), `fpt-lazy-route-${Date.now()}`)}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let tab; for (let i = 0; i < 80 && !tab; i++) { try { tab = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await delay(150); } }
  ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map(), requested = [], errors = [];
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Network.requestWillBeSent') requested.push(m.params.request.url.replace(`http://127.0.0.1:${port}/`, '').split('?')[0]);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    const task = pending.get(m.id); if (task) { pending.delete(m.id); m.error ? task.reject(new Error(m.error.message)) : task.resolve(m.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const waitFor = async (expression, message, attempts = 100) => { for (let i = 0; i < attempts; i++) { if (await evaluate(expression)) return; await delay(100); } throw new Error(message + ' · ' + JSON.stringify(await evaluate(`({url:location.href,body:document.body.innerText.slice(0,200)})`))); };
  const loaded = file => requested.includes(file);
  await call('Runtime.enable'); await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  await call('Page.navigate', { url: `http://127.0.0.1:${port}/#/home` });
  await waitFor(`document.querySelectorAll('#member option').length === 3`, 'Schermata di login non pronta');
  const loginShownAt = await evaluate(`performance.now()`);
  await delay(500);
  const earlyPostLogin = await evaluate(`performance.getEntriesByType('resource').filter(e=>${JSON.stringify(POST_LOGIN)}.some(f=>e.name.endsWith('/'+f))&&e.startTime<${loginShownAt}-250).map(e=>e.name.split('/').slice(-2).join('/'))`);
  assert(earlyPostLogin.length === 0, 'Controller post-login scaricati prima che il login fosse disegnato: ' + JSON.stringify(earlyPostLogin));
  const atLogin = LAZY.filter(loaded);
  assert(atLogin.length === 0, 'Moduli lazy scaricati già al login: ' + JSON.stringify(atLogin));
  console.log('PASS login: nessuno di ' + LAZY.length + ' moduli lazy scaricato (' + requested.filter(u => u.endsWith('.js')).length + ' script richiesti)');

  await evaluate(`(()=>{const s=document.querySelector('#member');s.value='existing-member';s.dispatchEvent(new Event('change',{bubbles:true}));const p=document.querySelector('#pin');p.value='1234';p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit();})()`);
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Login non completato');
  await waitFor(`window.__authTest.syncInFlight===0`, 'Sincronizzazione iniziale non completata');
  assert(loaded('js/collection-name-aliases.js'), 'Gli alias della raccolta devono arrivare insieme al caricamento della raccolta');
  assert(!loaded('js/team.js') && !loaded('js/admin.js'), 'Team/Admin non devono caricarsi prima di aprire la pagina');
  await waitFor(`performance.getEntriesByType('resource').some(e=>e.name.includes('/js/fast-scan.js'))`, 'Prefetch inattivo di fast-scan.js non avvenuto', 150);
  console.log('PASS dopo il login: alias caricati con la raccolta, Team/Admin ancora no, fast-scan.js prefetchato a browser inattivo');

  assert(await evaluate(`Boolean(document.querySelector('.mm-dashboard .market-featured-carousel, .mm-dashboard .featured-empty'))`), 'Dashboard senza pannello Market dopo il login');
  for (const [pageId, selector, label] of [['decks', '.deck-page', 'Mazzi'], ['market', '.market-hero', 'Market Watch'], ['stats', '.stats-page', 'Statistiche']]) {
    await evaluate(`document.querySelector('.sidebar [data-page="${pageId}"]').click()`);
    await waitFor(`Boolean(document.querySelector('${selector}'))`, `Pagina ${label} non renderizzata`);
  }
  assert(!loaded('market/providers.js'), 'market/providers.js deve restare fuori per un utente non admin');
  console.log('PASS Mazzi, Market Watch e Statistiche si aprono dal router reale; market/providers.js mai scaricato da un non-admin');

  await evaluate(`document.querySelector('.sidebar [data-page="team"]').click()`);
  await waitFor(`Boolean(document.querySelector('.team-hero'))`, 'Pagina Team non renderizzata dopo il caricamento lazy');
  assert(loaded('js/team.js'), 'team.js non richiesto aprendo Team');
  console.log('PASS Team: team.js caricato su richiesta e pagina renderizzata');

  await evaluate(`location.hash='#/fastscan'`);
  await waitFor(`Boolean(document.querySelector('.fast-scan-route .fast-scan-setup, .fast-scan-route .fast-scan-live'))`, 'Fast Scan non renderizzato dopo il caricamento lazy');
  await evaluate(`location.hash='#/home'`);
  await waitFor(`Boolean(document.querySelector('.mm-dashboard'))`, 'Ritorno alla Dashboard da Fast Scan non riuscito');
  console.log('PASS Fast Scan: controller creato alla prima apertura, uscita verso la Dashboard regolare');

  assert(errors.length === 0, 'Errori JavaScript: ' + JSON.stringify(errors));
  console.log('PASS nessun errore JavaScript durante login e navigazione lazy');
} finally {
  try { ws?.close(); } catch {}
  browser?.kill();
  server.close();
}
