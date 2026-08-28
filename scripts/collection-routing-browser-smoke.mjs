import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = await mkdtemp(path.join(tmpdir(), 'fpt-collection-smoke-'));
const port = 9347;
const chrome = spawn(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1280,900',
  'about:blank'
], { stdio:'ignore' });

let socket;
try {
  const target = await waitForTarget(port);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once:true });
    socket.addEventListener('error', reject, { once:true });
  });
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls:['*://*.supabase.co/*'] });
  await send('Page.navigate', { url:'http://localhost:8080/?smoke=collection' });
  await delay(1000);
  await evaluate(`localStorage.setItem('fpt-cards-state-v2', JSON.stringify({
    currentUser:'daniele', role:'admin', game:'yugioh', loans:[],
    collection:{mine:[
      {id:'one',printingId:'p-one',ownerSlug:'daniele',ownerName:'Daniele',game:'yugioh',catalogCardId:'46986414',cardName:'Dark Magician',setCode:'LOB-005',setName:'Legend of Blue Eyes',rarity:'Ultra Rare',language:'Italiano',condition:'Near Mint',edition:'',imageUrl:'',quantityOwned:2,quantityLoaned:0,quantityReserved:0,quantityAvailable:2},
      {id:'two',printingId:'p-two',ownerSlug:'daniele',ownerName:'Daniele',game:'yugioh',catalogCardId:'89631139',cardName:'Blue-Eyes White Dragon',setCode:'LOB-001',setName:'Legend of Blue Eyes',rarity:'Ultra Rare',language:'Italiano',condition:'Near Mint',edition:'',imageUrl:'',quantityOwned:1,quantityLoaned:1,quantityReserved:0,quantityAvailable:0}
    ],team:[],syncedAt:null}
  })); location.hash='#/collection'; location.reload();`);
  await waitForSelector(evaluate, '[data-collection-query]', 6000);
  await evaluate(`window.__appReplacements=0; window.__uiErrors=[];
    new MutationObserver(records => window.__appReplacements += records.filter(record => record.target.id === 'app').length)
      .observe(document.querySelector('#app'), {childList:true});
    window.addEventListener('error', event => window.__uiErrors.push(event.message));`);

  const before = await snapshot(evaluate);
  const queryPoint = await center(evaluate, '[data-collection-query]');
  await click(send, queryPoint);
  await send('Input.insertText', { text:'dark' });
  await delay(350);
  const afterTyping = await snapshot(evaluate);

  await evaluate(`(()=>{const field=document.querySelector('#collection-status'); field.value='unavailable'; field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await delay(100);
  const afterStatus = await snapshot(evaluate);

  const listPoint = await center(evaluate, '[data-collection-layout="list"]');
  await click(send, listPoint);
  await delay(100);
  const afterLayout = await snapshot(evaluate);

  const homePoint = await center(evaluate, '.sidebar button[data-page="home"]');
  await click(send, homePoint);
  await delay(100);
  const homeHash = await evaluate('location.hash');
  const collectionPoint = await center(evaluate, '.sidebar button[data-page="collection"]');
  await click(send, collectionPoint);
  await delay(100);
  const collectionHash = await evaluate('location.hash');

  console.log(JSON.stringify({ before, afterTyping, afterStatus, afterLayout, homeHash, collectionHash }, null, 2));
  if (afterTyping.query !== 'dark') throw new Error('La ricerca perde il testo digitato');
  if (afterTyping.appReplacements !== 0) throw new Error('La ricerca ricostruisce l’intera app');
  if (afterLayout.layout !== 'list') throw new Error('Il selettore lista non risponde');
  if (afterLayout.errors.length) throw new Error(`Errori browser: ${afterLayout.errors.join('; ')}`);
  if (homeHash !== '#/home' || collectionHash !== '#/collection') throw new Error('Il routing hash non segue la pagina selezionata');
  console.log('collection-routing-browser-smoke: ok');
} finally {
  socket?.close();
  chrome.kill();
  await rm(profile, { recursive:true, force:true }).catch(() => {});
}

async function waitForTarget(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(target => target.type === 'page');
      if (page) return page;
    } catch {}
    await delay(100);
  }
  throw new Error('Chrome DevTools non disponibile');
}

async function snapshot(evaluate) {
  return evaluate(`(()=>{
    const query=document.querySelector('[data-collection-query]');
    const status=document.querySelector('#collection-status');
    const grid=document.querySelector('.inventory-grid');
    const probe=element=>{const r=element.getBoundingClientRect(); const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2); return {tag:hit?.tagName || '', matches:hit===element || element.contains(hit)};};
    const listActive=document.querySelector('[data-collection-layout="list"]')?.classList.contains('active');
    return {hash:location.hash,query:query?.value,status:status?.value,layout:listActive?'list':'grid',visible:document.querySelectorAll('.inventory-card').length,queryHit:query?probe(query):null,statusHit:status?probe(status):null,appReplacements:window.__appReplacements,errors:window.__uiErrors};
  })()`);
}

async function center(evaluate, selector) {
  return evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}); const r=element.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
}

async function waitForSelector(evaluate, selector, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return;
    await delay(100);
  }
  throw new Error(`Elemento browser non trovato: ${selector}`);
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type:'mousePressed', x:point.x, y:point.y, button:'left', clickCount:1 });
  await send('Input.dispatchMouseEvent', { type:'mouseReleased', x:point.x, y:point.y, button:'left', clickCount:1 });
}

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
