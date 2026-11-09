// Isolated real-browser test: synthetic decks only; no production account or RPC.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';

const workspace = process.cwd();
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find(fs.existsSync);
assert(chrome, 'Chrome non trovato per il test del simulatore');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp',
  '.svg':'image/svg+xml','.woff2':'font/woff2'};
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const target = path.resolve(workspace, `.${decodeURIComponent(url.pathname)}`);
  if (!target.startsWith(`${workspace}${path.sep}`)) { response.writeHead(403).end(); return; }
  try {
    const data = fs.readFileSync(target);
    response.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
    response.setHeader('Cache-Control', 'no-store'); response.end(data);
  } catch { response.writeHead(404).end('Not found'); }
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, ws;

class CdpClient {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map(); this.handlers = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const task = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(task.timer);
        message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
      } else for (const handler of this.handlers.get(message.method) || []) handler(message.params);
    };
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, {resolve, reject, timer}); this.socket.send(JSON.stringify({id, method, params}));
    });
  }
  on(method, fn) { this.handlers.set(method, [...(this.handlers.get(method) || []), fn]); }
}

async function freePort() {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
async function waitForJson(url) {
  for (let index = 0; index < 90; index++) {
    try { const response = await fetch(url); if (response.ok) return await response.json(); } catch {}
    await delay(100);
  }
  throw new Error(`Chrome CDP non disponibile: ${url}`);
}

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const debugPort = await freePort();
  const profile = path.join(os.tmpdir(), `fpt-onepiece-simulator-${Date.now()}`);
  browser = spawn(chrome, ['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions',
    '--no-first-run',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,'about:blank'],
  {stdio:'ignore',windowsHide:true});
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
  const tab = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, {method:'PUT'})).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = new CdpClient(ws);
  const exceptions = [], consoleErrors = [], networkErrors = [], externalRequests = [];
  cdp.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  cdp.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error') consoleErrors.push((event.args || []).map(item => item.value || item.description || '').join(' '));
  });
  cdp.on('Network.responseReceived', event => {
    if (event.response.status >= 400 && !event.response.url.endsWith('/favicon.ico')) networkErrors.push(`${event.response.status} ${event.response.url}`);
  });
  cdp.on('Network.requestWillBeSent', event => {
    if (/^https?:/.test(event.request.url) && !event.request.url.startsWith(origin)) externalRequests.push(event.request.url);
  });
  await cdp.call('Runtime.enable'); await cdp.call('Network.enable'); await cdp.call('Page.enable');
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, message) => {
    for (let index = 0; index < 100; index++) { if (await evaluate(expression)) return; await delay(75); }
    throw new Error(`${message}\n${await evaluate('document.body.innerText.slice(0,1600)')}`);
  };
  const click = async selector => {
    assert(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `Controllo mancante: ${selector}`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const fill = (selector, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing '+${JSON.stringify(selector)});el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const submit = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
  const snapshot = () => evaluate('JSON.parse(JSON.stringify(window.__sim.session))');
  const screenshot = async name => {
    if (!process.argv.includes('--screenshots')) return;
    const metrics = await cdp.call('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    const shot = await cdp.call('Page.captureScreenshot', {format:'png',captureBeyondViewport:true,
      clip:{x:0,y:0,width:size.width,height:Math.min(size.height,12000),scale:1}});
    const folder = path.join(workspace,'artifacts','onepiece-simulator');
    fs.mkdirSync(folder,{recursive:true}); fs.writeFileSync(path.join(folder,`${name}.png`),Buffer.from(shot.data,'base64'));
  };

  await cdp.call('Page.navigate', {url:`${origin}/scripts/fixtures/onepiece-simulator-harness.html`});
  await waitFor('window.__fixtureReady && document.querySelector("[data-op-setup]")', 'Setup non disponibile');
  const originalDecks = await evaluate('JSON.stringify(window.__decks)');
  await evaluate('window.__decks[0].cards.find(card=>card.section==="main").quantity=3;window.__render()');
  await fill('[data-op-setup] [name=deck0]', 'simulator-deck-a');
  await fill('[data-op-setup] [name=deck1]', 'simulator-deck-b');
  await submit('[data-op-setup]');
  assert.equal(await snapshot(), null, 'Il setup ammette un Main Deck di 49 carte');
  assert(await evaluate('Boolean(document.querySelector("[role=alert]"))'), 'Mazzo incompleto senza spiegazione visibile');
  await evaluate(`window.__decks=JSON.parse(${JSON.stringify(originalDecks)});window.__render()`);
  console.log('PASS incomplete deck rejected with a visible explanation');
  await fill('[data-op-setup] [name=deck0]', 'simulator-deck-a');
  await fill('[data-op-setup] [name=deck1]', 'simulator-deck-b');
  await fill('[data-op-setup] [name=name0]', 'Test player A');
  await fill('[data-op-setup] [name=name1]', 'Test player B');
  await fill('[data-op-setup] [name=life0]', 5);
  await fill('[data-op-setup] [name=life1]', 4);
  await fill('[data-op-setup] [name=firstPlayer]', 0);
  await submit('[data-op-setup]');
  await waitFor('window.__sim.session?.players?.length === 2', 'Tavolo non avviato');
  let session = await snapshot();
  assert.equal(session.players[0].hand.length, 5); assert.equal(session.players[1].hand.length, 5);
  assert.equal(session.players[0].life.length, 0, 'Life distribuite prima del mulligan');
  assert.equal(session.players[1].life.length, 0);
  assert.equal(session.players[0].don.deck, 10);
  assert(await evaluate('window.__verifyCalls > 0'), 'Accesso team non verificato all’avvio');
  console.log('PASS private setup, selected decks, opening hands before Life');

  await click('[data-op-action="start"]');
  await waitFor('window.__sim.session?.phase !== "setup"', 'Preparazione non conclusa');
  session = await snapshot();
  assert.equal(session.players[0].life.length, 5); assert.equal(session.players[1].life.length, 4);
  const beforeDraw = session.players[0].hand.length;
  await click('[data-op-action="draw"][data-player="0"]');
  await waitFor(`window.__sim.session.players[0].hand.length === ${beforeDraw + 1}`, 'Pesca manuale non applicata');
  session = await snapshot();
  const chosen = session.players[0].hand[0].id;
  await click('[data-op-hand="0"]');
  await click(`[data-op-card="${chosen}"][data-player="0"]`);
  await waitFor('Boolean(document.querySelector("[data-op-move]"))', 'Inspector carta non aperto');
  await fill('[data-op-move] [name=to]', 'characters');
  await submit('[data-op-move]');
  await waitFor(`window.__sim.session.players[0].characters.some(card=>card.id===${JSON.stringify(chosen)})`, 'Carta non spostata sul campo');
  session = await snapshot();
  assert.equal(session.players[0].hand.length, beforeDraw);
  assert.equal(session.players[0].characters.length, 1);
  await click('[data-op-command="undo"]');
  await waitFor('window.__sim.session.players[0].characters.length === 0', 'Annulla non ripristina il campo');
  session = await snapshot(); assert.equal(session.players[0].hand.length, beforeDraw + 1);
  console.log('PASS manual draw, card inspector, movement and undo');
  await click('[data-op-action="addDon2"][data-player="0"]');
  session = await snapshot();
  await click(`[data-op-card="${session.players[0].leader.id}"][data-player="0"]`);
  await click('[data-op-command="metadata"]');
  await waitFor('document.body.textContent.includes("Manual fixture effect")', 'Testo carta non caricato nell’inspector');
  await click('[data-op-action="attachDon"][data-player="0"]');
  session = await snapshot(); assert.equal(session.players[0].leader.don, 1); assert.equal(session.players[0].don.active, 1);
  await click('[data-op-action="returnAttachedDon"][data-player="0"]');
  session = await snapshot(); assert.equal(session.players[0].leader.don, 0); assert.equal(session.players[0].don.deck, 9);
  await click('[data-op-action="attachDon"][data-player="0"]');
  await click('[data-op-action="toggleRest"][data-player="0"]');
  session = await snapshot(); assert.equal(session.players[0].leader.rested, true);
  await click('[data-op-action="refresh"][data-player="0"]');
  session = await snapshot(); assert.equal(session.players[0].leader.rested, false);
  assert.equal(session.players[0].leader.don, 0); assert.equal(session.players[0].don.active, 1);
  assert.equal(session.players[0].don.rested, 0); assert.equal(session.players[0].don.deck, 9);
  console.log('PASS card text, DON assignment/return, resting and Refresh');
  const hiddenCandidate = session.players[0].hand[0].id;
  for (const destination of ['life','deck']) {
    await click(`[data-op-card="${hiddenCandidate}"][data-player="0"]`);
    await fill('[data-op-move] [name=to]', destination); await submit('[data-op-move]');
    assert.equal(await evaluate('document.querySelector(".op-sim-inspector h2").textContent'),'Il banco di regia',`Carta nascosta in ${destination} ancora mostrata nell’inspector`);
    assert(!await evaluate('Boolean(document.querySelector(".op-sim-inspector .op-sim-preview img"))'),'Immagine di carta nascosta rimasta nell’inspector');
    await click('[data-op-command="undo"]');
  }
  await click('[data-op-pile="deck"][data-player="0"]');
  session = await snapshot();
  await click(`[data-op-card="${session.players[0].deck[0].id}"][data-player="0"]`);
  await click('[data-op-command="close-pile"]');
  assert.equal(await evaluate('document.querySelector(".op-sim-inspector h2").textContent'),'Il banco di regia','Chiusura mazzo lascia il dettaglio di una carta visibile');
  await click('[data-op-peek="0"]');
  await click('[data-op-life="0"][data-player="0"]');
  await click('[data-op-action="toggleFaceUp"][data-player="0"]');
  session = await snapshot(); assert.equal(session.players[0].life[0].faceUp,true);
  await click('[data-op-command="cover"]');
  assert(!await evaluate('document.querySelector("[data-op-life=\\"0\\"][data-player=\\"0\\"]").classList.contains("op-sim-card-back")'),'Copri tutto nasconde una Life resa scoperta da un effetto');
  assert(await evaluate('document.querySelector("[data-op-life=\\"1\\"][data-player=\\"0\\"]").classList.contains("op-sim-card-back")'),'Copri tutto rivela le altre Life');
  assert.deepEqual(await evaluate('window.__sim.revealHands'),[false,false],'Copri tutto non copre entrambe le mani');
  console.log('PASS hidden zone inspector privacy, closed piles and individual face-up Life');
  await cdp.call('Emulation.setDeviceMetricsOverride', {width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await screenshot('desktop');

  const savedId = session.id;
  await cdp.call('Page.reload', {ignoreCache:true});
  await waitFor(`window.__fixtureReady && window.__sim.session?.id === ${JSON.stringify(savedId)}`, 'Tavolo non ripreso dopo refresh');
  session = await snapshot(); assert.equal(session.players[0].hand.length, beforeDraw + 1);
  assert.equal(session.players[0].life[0].faceUp,true,'Orientamento Life perso al refresh');
  assert(!await evaluate('document.querySelector("[data-op-life=\\"0\\"][data-player=\\"0\\"]").classList.contains("op-sim-card-back")'),'Life scoperta nascosta dopo refresh');
  const sessionStorageKey = await evaluate(`Object.keys(sessionStorage).find(key=>sessionStorage.getItem(key).includes(${JSON.stringify(savedId)}))`);
  assert(sessionStorageKey, 'Sessione non salvata nello storage del browser');
  console.log('PASS refresh restores private session');

  await evaluate('window.__context.allowed=false;window.__render()');
  assert(!await evaluate('Boolean(document.querySelector("[data-op-action=draw]"))'), 'Permesso revocato lascia attivi i controlli');
  assert(!(await evaluate('document.body.innerText')).includes('Test player A'), 'Permesso revocato mostra ancora la sessione');
  await evaluate('window.__context.allowed=true;window.__mount()');
  await waitFor(`window.__sim.session?.id === ${JSON.stringify(savedId)}`, 'Permesso ripristinato non rilegge la propria sessione');
  console.log('PASS access revoked during an existing session');

  await cdp.call('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate('window.__render()'); await delay(100);
  const width = await evaluate('({body:document.body.scrollWidth,viewport:window.innerWidth})');
  assert(width.body <= width.viewport + 2, `Overflow mobile: ${JSON.stringify(width)}`);
  await screenshot('mobile');
  await click('[data-op-tab="rules"]');
  const ruleLinks = await evaluate('[...document.querySelectorAll("a[href]")].map(link=>link.href)');
  assert(ruleLinks.some(url => url.startsWith('https://en.onepiece-cardgame.com/rules/')), 'Riferimenti ufficiali non presenti');
  console.log('PASS mobile layout and official ruling links');

  await click('[data-op-tab="table"]');
  await waitFor('Boolean(document.querySelector("[data-op-finish]"))', 'Risultato manuale non disponibile');
  await fill('[data-op-finish] [name=winner]', 0);
  await fill('[data-op-finish] [name=notes]', 'Fixture session; no team match statistics should be changed. <img data-injected src=x onerror="window.__injected=true">');
  await submit('[data-op-finish]');
  await waitFor('Boolean(window.__sim.session?.result)', 'Esito sessione non registrato');
  await click('[data-op-tab="history"]');
  assert((await evaluate('document.body.innerText')).includes('Fixture deck A'), 'Storico non mostra il mazzo utilizzato');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".op-sim-stats > div > b")].map(el=>el.textContent)'), ['1','100%','0%'], 'Conteggio test o win rate errato');
  assert(!await evaluate('Boolean(window.__injected || document.querySelector("[data-injected]"))'), 'Le note del test iniettano HTML');
  assert.equal(await evaluate('JSON.stringify(window.__decks)'), originalDecks, 'Il tavolo modifica i mazzi originali');
  await click('[data-op-tab="table"]'); await click('[data-op-command="save-result"]');
  await click('[data-op-tab="history"]');
  assert.equal(await evaluate('window.__sim.history.length'), 1, 'Il doppio salvataggio duplica il test');
  await cdp.call('Page.reload', {ignoreCache:true});
  await waitFor('window.__fixtureReady && window.__sim.ready', 'Storico non ricaricato dopo refresh');
  await click('[data-op-tab="history"]');
  assert.equal(await evaluate('window.__sim.history.length'), 1, 'Storico perso al refresh');
  await evaluate(`(()=>{const key=Object.keys(localStorage).find(key=>key.endsWith(':results')&&localStorage.getItem(key).includes(${JSON.stringify(savedId)}));const rows=JSON.parse(localStorage.getItem(key));rows.push({id:'corrupt-test',players:[null,null],winner:0});localStorage.setItem(key,JSON.stringify(rows));window.__mount();})()`);
  await waitFor('window.__sim.ready','Storico corrotto impedisce l’inizializzazione');
  await click('[data-op-tab="history"]');
  assert.equal(await evaluate('window.__sim.history.length'),1,'Storico con partecipanti null non filtrato');
  console.log('PASS manual result and local practice history');

  await evaluate('window.__context.member="simulator-member-b";window.__sim.reset();window.__mount()');
  await waitFor('window.__sim.ready', 'Contesto altro membro non inizializzato');
  assert.equal(await snapshot(), null, 'Il tavolo privato trapela a un altro membro');
  await click('[data-op-tab="history"]');
  assert(!(await evaluate('document.body.innerText')).includes('Fixture session; no team match statistics'), 'Lo storico privato trapela a un altro membro');
  await evaluate('window.__context.member="simulator-member-a";window.__context.team="simulator-team-b";window.__sim.reset();window.__mount()');
  await waitFor('window.__sim.ready', 'Contesto altro team non inizializzato');
  assert.equal(await snapshot(), null, 'Il tavolo privato trapela a un altro team');
  await evaluate('window.__context.allowed=false;window.__sim.reset();window.__mount()');
  assert(!await evaluate('Boolean(document.querySelector("[data-op-setup]"))'), 'Accesso vietato mostra il setup');
  assert(!await evaluate('Boolean(document.querySelector("[data-op-action=draw]"))'), 'Accesso vietato mostra controlli del tavolo');
  console.log('PASS member/team isolation and denied access');

  await evaluate(`window.__context={member:'simulator-member-a',team:'simulator-team-a',allowed:true};sessionStorage.setItem(${JSON.stringify(sessionStorageKey)},'{broken JSON');window.__mount()`);
  await waitFor('window.__sim.ready', 'Tavolo corrotto blocca l’inizializzazione');
  assert.equal(await snapshot(), null, 'Sessione corrotta non scartata');
  assert(await evaluate('Boolean(document.querySelector("[data-op-setup]"))'), 'Sessione corrotta impedisce un nuovo setup');
  console.log('PASS corrupted local session fails safely');

  assert.deepEqual(exceptions, [], 'Eccezioni JavaScript');
  assert.deepEqual(consoleErrors, [], 'Errori console');
  assert.deepEqual(networkErrors, [], 'Risorse locali mancanti');
  assert.deepEqual(externalRequests, [], 'La fixture ha contattato servizi esterni');
  console.log('onepiece-simulator-ui-smoke: OK');
}

run().catch(error => {console.error(error);process.exitCode=1;}).finally(async () => {
  try { ws?.close(); } catch {}
  try { browser?.kill(); } catch {}
  await new Promise(resolve => server.close(resolve));
});
