// Editor Raccolta nell'app REALE: aggiunta manuale di una carta in italiano
// quando il nostro catalogo conosce solo la stampa inglese.
// Caso reale (tester, 2026-10-13): PGLD-EN021 Disaster Leo → serve PGLD-IT021.
// Mock Supabase di scripts/auth-regression-smoke.mjs (letto da quel file) +
// lookup_card_printings_by_catalog_id che restituisce la sola riga EN021;
// catalogo YGOPRODeck finto. Verifica:
// - l'elenco "Set / codice" propone PGLD-IT021 (selezionata) oltre a EN021;
// - il salvataggio invia PGLD-IT021 SENZA il printing_id della riga inglese;
// - cambiando lingua in Inglese la selezione passa a PGLD-EN021 (col suo id).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const root = process.cwd(), port = 8097, debugPort = 9357;
const EN_ID = '33333333-3333-4333-8333-333333333333';
const authSource = fs.readFileSync(path.join(root, 'scripts', 'auth-regression-smoke.mjs'), 'utf8');
const mockBlock = authSource.slice(authSource.indexOf('const members = ['), authSource.indexOf('\nconst mime = {'));
const membersLine = "if(name==='list_login_members') return {data:members,error:null};";
const fakeSupabaseSource = new Function(`${mockBlock}\nreturn fakeSupabaseSource;`)()
  .replace(membersLine, `if(name==='lookup_card_printings_by_catalog_id') return {data:[{printing_id:'${EN_ID}',set_code:'PGLD-EN021',set_name:'Premium Gold',rarity:'Gold Secret Rare',image_url:''}],error:null};\n      ${membersLine}`);
if (!fakeSupabaseSource.includes('lookup_card_printings_by_catalog_id')) throw new Error('Mock list_login_members non trovato in auth-regression-smoke.mjs');

const leo = { id: 6165656, name: 'Number C88: Gimmick Puppet Disaster Leo', type: 'XYZ Monster',
  card_images: [{ id: 6165656, image_url: `http://127.0.0.1:${port}/icon-512.png`, image_url_small: `http://127.0.0.1:${port}/icon-192.png`, image_url_cropped: `http://127.0.0.1:${port}/icon-192.png` }],
  card_sets: [{ set_code: 'PGLD-EN021', set_name: 'Premium Gold', set_rarity: 'Gold Secret Rare', set_rarity_code: '(GScR)' }] };
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.webp':'image/webp', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req, res) => {
  const requestPath = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
  if (requestPath === '/test-supabase.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return res.end(fakeSupabaseSource); }
  if (requestPath === '/test-cardinfo') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res.end(JSON.stringify({ data: [leo] })); }
  const relative = requestPath === '/' ? 'index.html' : requestPath.slice(1), file = path.resolve(root, relative);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); return res.end('not found'); }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    if (relative === 'index.html') return res.end(data.toString('utf8').replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', '/test-supabase.js'));
    if (relative === 'js/cards.js') return res.end(data.toString('utf8').replace('https://db.ygoprodeck.com/api/v7/cardinfo.php', '/test-cardinfo'));
    res.end(data);
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let browser, ws;
try {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(os.tmpdir(), `fpt-localized-${Date.now()}`)}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let tab; for (let i = 0; i < 80 && !tab; i++) { try { tab = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await delay(150); } }
  ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map(), errors = [], dialogs = [];
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    const task = pending.get(m.id); if (task) { pending.delete(m.id); m.error ? task.reject(new Error(m.error.message)) : task.resolve(m.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const waitFor = async (expression, message, attempts = 100) => { for (let i = 0; i < attempts; i++) { if (await evaluate(expression)) return; await delay(100); } throw new Error(message + ' · ' + JSON.stringify(await evaluate(`({url:location.href,toast:document.querySelector('#toast')?.textContent,sets:[...document.querySelectorAll('#collection-set option')].map(o=>o.value)})`))); };
  const sets = () => evaluate(`({options:[...document.querySelectorAll('#collection-set option')].map(o=>o.value),selected:document.querySelector('#collection-set')?.value||'',rarity:document.querySelector('#collection-rarity')?.value||''})`);
  const openEditorWithLeo = async () => {
    await evaluate(`document.querySelector('[data-collection-add]').click()`);
    await waitFor(`Boolean(document.querySelector('#collection-card-search'))`, 'Editor Raccolta non aperto');
    await evaluate(`(()=>{const i=document.querySelector('#collection-card-search');i.value='Disaster Leo';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`Boolean(document.querySelector('[data-collection-card-result="0"]'))`, 'Nessun risultato di ricerca');
    await evaluate(`document.querySelector('[data-collection-card-result="0"]').click()`);
    // Prima i dati YGOPRODeck, poi il merge col catalogo DB (riga EN021 con id).
    await waitFor(`[...document.querySelectorAll('#collection-set option')].length >= 2`, 'Elenco set non popolato');
    await delay(600);
  };

  await call('Runtime.enable'); await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `http://127.0.0.1:${port}/#/collection` });
  await waitFor(`document.querySelectorAll('#member option').length === 3`, 'Schermata di login non pronta');
  await evaluate(`(()=>{const s=document.querySelector('#member');s.value='existing-member';s.dispatchEvent(new Event('change',{bubbles:true}));const p=document.querySelector('#pin');p.value='1234';p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit(document.querySelector('#login-form button[type="submit"]'));})()`);
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Login non completato');
  await waitFor(`window.__authTest.syncInFlight===0`, 'Sincronizzazione iniziale non completata');
  await evaluate(`location.hash='#/collection'`);
  await waitFor(`Boolean(document.querySelector('[data-collection-add]'))`, 'Pagina Raccolta non pronta');

  await openEditorWithLeo();
  let s = await sets();
  assert(s.options.includes('PGLD-IT021') && s.options.includes('PGLD-EN021'), 'Italiano: attese PGLD-IT021 e PGLD-EN021, trovate ' + JSON.stringify(s));
  assert(s.selected === 'PGLD-IT021', 'Italiano: deve essere selezionata PGLD-IT021: ' + JSON.stringify(s));
  console.log('PASS elenco: con EN021 già nel catalogo propone e seleziona PGLD-IT021 · ' + JSON.stringify(s.options));

  await evaluate(`(()=>{const l=document.querySelector('#collection-language');l.value='Inglese';l.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('#collection-set')?.value === 'PGLD-EN021'`, 'Cambio lingua in Inglese: la selezione non passa a PGLD-EN021');
  await evaluate(`(()=>{const l=document.querySelector('#collection-language');l.value='Italiano';l.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('#collection-set')?.value === 'PGLD-IT021'`, 'Ritorno a Italiano: la selezione non torna a PGLD-IT021');
  console.log('PASS cambio lingua: Italiano → Inglese passa a PGLD-EN021, e ritorno a PGLD-IT021');

  const before = await evaluate(`window.__authTest.saveCollectionItemCalls`);
  await evaluate(`document.querySelector('#collection-form').requestSubmit(document.querySelector('#collection-form button[type="submit"]'))`);
  await waitFor(`window.__authTest.saveCollectionItemCalls > ${before}`, 'save_collection_item non chiamata');
  const saved = await evaluate(`window.__authTest.lastSaveCollectionItem`);
  assert(saved.p_set_code === 'PGLD-IT021' && saved.p_language === 'Italiano', 'Salvataggio: attesi PGLD-IT021 in Italiano, inviati ' + JSON.stringify({ set: saved.p_set_code, lang: saved.p_language }));
  assert(!saved.p_printing_id, 'Salvataggio: non deve inviare il printing_id della riga inglese: ' + saved.p_printing_id);
  console.log('PASS salvataggio: PGLD-IT021 · Italiano · nessun printing_id inglese');

  await waitFor(`!document.querySelector('#collection-form')`, 'Editor non chiuso dopo il salvataggio', 60);
  await openEditorWithLeo();
  await evaluate(`(()=>{const l=document.querySelector('#collection-language');l.value='Inglese';l.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('#collection-set')?.value === 'PGLD-EN021'`, 'Inglese non selezionato');
  const beforeEn = await evaluate(`window.__authTest.saveCollectionItemCalls`);
  await evaluate(`document.querySelector('#collection-form').requestSubmit(document.querySelector('#collection-form button[type="submit"]'))`);
  await waitFor(`window.__authTest.saveCollectionItemCalls > ${beforeEn}`, 'save_collection_item (inglese) non chiamata');
  const savedEn = await evaluate(`window.__authTest.lastSaveCollectionItem`);
  assert(savedEn.p_set_code === 'PGLD-EN021' && savedEn.p_language === 'Inglese' && savedEn.p_printing_id === EN_ID, 'Salvataggio inglese: atteso EN021 col suo id: ' + JSON.stringify({ set: savedEn.p_set_code, lang: savedEn.p_language, id: savedEn.p_printing_id }));
  console.log('PASS salvataggio inglese: PGLD-EN021 collegata alla sua riga del catalogo');

  assert(errors.length === 0, 'Errori JavaScript: ' + JSON.stringify(errors));
  console.log('PASS nessun errore JavaScript');
} finally {
  try { ws?.close(); } catch {}
  browser?.kill();
  server.close();
}
