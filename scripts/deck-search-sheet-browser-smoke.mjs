// Deck Builder: ricerca a pannello (2026-11-10). Browser reale via CDP con TOCCHI
// VERI (Input.dispatchTouchEvent): apertura dal pulsante, risultati senza il vecchio
// tetto di 12, "+" con Main/Extra automatici, limite 3 copie Yu-Gi-Oh!, tieni premuto
// e trascina nel mazzo, uno scorrimento veloce che NON aggiunge, anteprima carta con
// "+ Side", scheda Side, chiusura, nessun pulsante coperto, colonna a destra su PC.
// Usa solo artwork same-origin (/icon-192.png): nessuna rete esterna.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-deck-search-smoke-')), port = 9377;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const shots = process.argv.includes('--screenshots');
let previewServer = null;
const alreadyUp = await fetch('http://localhost:8080/index.html').then(() => true).catch(() => false);
if (!alreadyUp) {
  previewServer = spawn(process.execPath, ['scripts/preview-server.mjs'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 50; i++) { if (await fetch('http://localhost:8080/index.html').then(() => true).catch(() => false)) break; await delay(100); }
}
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket, passed = 0;
const pass = text => { passed++; console.log('PASS ' + text); };
try {
  const target = await waitTarget(port); socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map(); const errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(arg => arg.value || arg.description || '').join(' '));
    const task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  const wait = async (expression, label) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(50); } throw new Error(label + ' · ' + JSON.stringify(await evaluate('({sheet:document.querySelector("[data-deck-search-sheet]")?.className, deck:window.__deck.cards.map(c=>c.section+":"+c.catalogCardId+"x"+c.quantity),toasts:window.__toasts.slice(-4),peek:document.querySelector("[data-deck-result-peek-box]")?.innerHTML.slice(0,600)})'))); };
  const centre = async selector => { const box = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height};})()`); if (!box) throw new Error('Elemento assente: ' + selector); return box; };
  const touch = async (type, x, y) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }] });
  const tap = async selector => { const { x, y } = await centre(selector); await touch('touchStart', x, y); await delay(60); await touch('touchEnd', x, y); await delay(250); };
  const shot = async name => { if (!shots) return; const data = (await send('Page.captureScreenshot', { format: 'png' })).data; const dir = path.join('artifacts', 'deck-search'); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, name + '.png'), Buffer.from(data, 'base64')); };
  const covered = () => evaluate(`Array.from(document.querySelectorAll('.deck-search-sheet.open button:not([disabled]), [data-deck-search-open]:not(.hidden)')).filter(button=>{const r=button.getBoundingClientRect();if(r.width<8||r.height<8||r.bottom<=0||r.top>=innerHeight)return false;let top=Math.max(r.top,0),bottom=Math.min(r.bottom,innerHeight);for(let n=button.parentElement;n;n=n.parentElement){const s=getComputedStyle(n);if(s.overflowY!=='visible'){const c=n.getBoundingClientRect();top=Math.max(top,c.top);bottom=Math.min(bottom,c.bottom);}}if(bottom-top<10)return false;const hit=document.elementFromPoint(r.left+r.width/2,(top+bottom)/2);return !(hit&&(hit===button||button.contains(hit)));}).map(b=>b.outerHTML.slice(0,100))`);

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/collection-share-harness.html' });
  await delay(700);

  const setup = await evaluate(`(async()=>{
    const {DeckController} = await import('/js/decks.js');
    const types = ['Effect Monster','Spell Card','Trap Card','Fusion Monster','Synchro Monster','XYZ Monster','Link Monster','Tuner Monster'];
    const results = Array.from({length:20}, (_, i) => ({ id:String(10000001 + i), name:'Carta di prova ' + String(i + 1).padStart(2, '0') + ' ' + types[i % types.length], type:types[i % types.length], level:i % 8 + 1, image:'/icon-192.png', fullImage:'/icon-192.png' }));
    const deck = { id:'d1', persisted:true, ownerSlug:'daniele', name:'Mazzo ricerca', format:'TCG Avanzato', game:'yugioh', deckTheme:'arcane-purple', deckBoxTemplate:'procedural', signatureCardId:null,
      cards:[{ catalogCardId:'10000001', cardName:results[0].name, section:'main', quantity:1, imageUrl:'/icon-192.png' }] };
    window.__deck = deck; window.__toasts = [];
    const controller = new DeckController({
      api:{}, getState:() => ({ decks:[deck], game:'yugioh', currentUser:'daniele', collection:[], loans:[] }),
      searchCards: async () => results,
      onRender:() => { document.querySelector('#app').innerHTML = controller.view(); controller.bind(document); },
      onToast:message => window.__toasts.push(String(message))
    });
    controller.markDirty = () => {};
    controller.activeId = 'd1'; controller.screen = 'detail';
    document.body.dataset.page = 'decks';
    window.__controller = controller; window.__results = results;
    controller.onRender();
    return Boolean(document.querySelector('[data-deck-search-open]'));
  })()`);
  if (!setup) throw new Error('Pulsante "Cerca carte" assente nell\'editor');
  if (!await evaluate(`!document.querySelector('[data-deck-search-sheet]').classList.contains('open')`)) throw new Error('Il pannello parte già aperto');

  // 1) apertura col dito + ricerca
  await tap('[data-deck-search-open]');
  await wait(`document.querySelector('[data-deck-search-sheet]').classList.contains('open') && document.querySelector('[data-deck-search-open]').classList.contains('hidden')`, 'Il tocco su "Cerca carte" non apre il pannello');
  await evaluate(`(()=>{const i=document.querySelector('[data-deck-search]');i.value='carta di prova';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(`document.querySelectorAll('[data-deck-result-card]').length===20`, 'I 20 risultati non sono tutti mostrati');
  await shot('mobile-search-open');
  // Il pannello vive in un livello figlio di <body> (sopra barra in alto e navigazione dell'app vera).
  if (!await evaluate(`document.querySelector('[data-deck-search-sheet]').parentElement?.id==='deck-search-layer' && document.getElementById('deck-search-layer').parentElement===document.body`)) throw new Error('Il pannello non è nel livello sopra le barre dell\'app');
  pass('apertura col tocco e 20 risultati su 20 (niente più tetto di 12), pannello nel livello sopra le barre');

  // 2) "+" con Main/Extra automatici; il pannello resta aperto
  await evaluate(`window.__sheetRef = document.querySelector('[data-deck-search-sheet]'); window.__imgRef = document.querySelector('[data-deck-result-card="0"] img'); document.querySelector('[data-deck-search-results]').scrollTop = 120;`);
  const fusion = await evaluate(`window.__results.findIndex(c=>c.type==='Fusion Monster')`);
  await tap(`[data-deck-result="${fusion}"]`);
  await wait(`window.__deck.cards.some(c=>c.catalogCardId===window.__results[${fusion}].id&&c.section==='extra')`, 'Il mostro Fusione non va nell\'Extra');
  if (!await evaluate(`document.querySelector('[data-deck-search-sheet]').classList.contains('open') && document.querySelectorAll('[data-deck-result-card]').length===20`)) throw new Error('Dopo + il pannello si chiude o perde i risultati');
  const persisted = await evaluate(`JSON.stringify({ sameSheet: window.__sheetRef === document.querySelector('[data-deck-search-sheet]'), sameImg: window.__imgRef === document.querySelector('[data-deck-result-card="0"] img'), scroll: document.querySelector('[data-deck-search-results]').scrollTop })`);
  if (!/"sameSheet":true/.test(persisted) || !/"sameImg":true/.test(persisted) || /"scroll":0[,}]/.test(persisted)) throw new Error('Aggiungere una carta ricrea il pannello o la lista: ' + persisted);
  await evaluate(`document.querySelector('[data-deck-section="extra"]')?.click()`); await delay(200);
  const spell = await evaluate(`window.__results.findIndex(c=>c.type==='Spell Card')`);
  await tap(`[data-deck-result="${spell}"]`);
  await wait(`window.__deck.cards.some(c=>c.catalogCardId===window.__results[${spell}].id&&c.section==='main')`, 'Con la scheda Extra aperta la Magia non va nel Main');
  if (!await evaluate(`window.__toasts.some(t=>t.includes('→ Extra')) && window.__toasts.some(t=>t.includes('→ Main'))`)) throw new Error('Manca l\'avviso con la sezione di destinazione');
  // X nel campo: cancella il testo e lascia scrivere subito
  if (!await evaluate(`!document.querySelector('[data-deck-search-clear]').hidden`)) throw new Error('La X per cancellare il testo non compare con del testo scritto');
  await tap('[data-deck-search-clear]');
  await wait(`document.querySelector('[data-deck-search]').value==='' && document.querySelector('[data-deck-search-clear]').hidden && document.activeElement===document.querySelector('[data-deck-search]') && !document.querySelector('[data-deck-result-card]')`, 'La X non cancella il testo o non rimette il cursore nel campo');
  await evaluate(`(()=>{const i=document.querySelector('[data-deck-search]');i.value='carta di prova';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(`document.querySelectorAll('[data-deck-result-card]').length===20`, 'Dopo la X una nuova ricerca non funziona');
  pass('+ manda Fusione nell\'Extra e la Magia nel Main anche con la scheda Extra aperta; il pannello NON si ricrea (stesse immagini, scroll intatto); la X svuota il campo e si riscrive subito');

  // 3) limite 3 copie Yu-Gi-Oh! tra tutte le sezioni
  await tap('[data-deck-result="0"]'); await tap('[data-deck-result="0"]'); await tap('[data-deck-result="0"]');
  await wait(`window.__deck.cards.filter(c=>c.catalogCardId==='10000001').reduce((n,c)=>n+c.quantity,0)===3 && document.querySelector('[data-deck-result-card="0"]').classList.contains('is-full')`, 'Il limite di 3 copie non è applicato');
  if (!await evaluate(`window.__toasts.some(t=>t.includes('massimo di copie'))`)) throw new Error('Nessun avviso alla quarta copia');
  pass('limite di 3 copie: la quarta è rifiutata con avviso e la carta diventa grigia');

  // 4) scorrimento veloce: NON aggiunge
  const before = await evaluate(`window.__deck.cards.reduce((n,c)=>n+c.quantity,0)`);
  const tile = await centre('[data-deck-result-card="9"] .deck-result-art');
  await touch('touchStart', tile.x, tile.y); for (let i = 1; i <= 6; i++) { await touch('touchMove', tile.x, tile.y - i * 14); await delay(16); } await touch('touchEnd', tile.x, tile.y - 84); await delay(300);
  if (await evaluate(`window.__deck.cards.reduce((n,c)=>n+c.quantity,0)`) !== before) throw new Error('Uno scorrimento veloce ha aggiunto una carta');
  pass('uno scorrimento veloce sui risultati non aggiunge nulla');

  // 5) tieni premuto e trascina nel mazzo
  const trap = await evaluate(`window.__results.findIndex(c=>c.type==='Trap Card')`);
  const from = await centre(`[data-deck-result-card="${trap}"] .deck-result-art`);
  await touch('touchStart', from.x, from.y); await delay(650);
  if (!await evaluate(`Boolean(document.querySelector('.deck-drag-ghost'))`)) throw new Error('Tenere premuto non prende la carta');
  // Il pannello laterale scivola quasi tutto a destra: il mazzo torna visibile e la carta si porta a sinistra.
  await wait(`document.querySelector('[data-deck-search-sheet]').classList.contains('is-dragging') && document.querySelector('[data-deck-search-sheet]').getBoundingClientRect().left > 250`, 'Durante il trascinamento il pannello non si sposta per mostrare il mazzo');
  const dropX = 40, dropY = 300;
  for (let i = 1; i <= 12; i++) { await touch('touchMove', from.x + (dropX - from.x) * i / 12, from.y + (dropY - from.y) * i / 12); await delay(20); }
  if (!await evaluate(`document.querySelector('.deck-mobile').classList.contains('deck-drop-over')`)) throw new Error('Il mazzo non si illumina sotto la carta trascinata');
  await shot('mobile-drag');
  await touch('touchEnd', dropX, dropY); await delay(400);
  if (await evaluate(`document.querySelector('[data-deck-search-sheet]').classList.contains('is-dragging')`)) throw new Error('Dopo il rilascio il pannello non torna al suo posto');
  await wait(`window.__deck.cards.some(c=>c.catalogCardId===window.__results[${trap}].id&&c.section==='main') && !document.querySelector('.deck-drag-ghost')`, 'La carta trascinata non entra nel mazzo');
  pass('tieni premuto e trascina: la carta segue il dito, il mazzo si illumina, al rilascio entra nel Main');

  // 6) anteprima carta + "+ Side"
  const link = await evaluate(`window.__results.findIndex(c=>c.type==='Link Monster')`);
  await tap(`[data-deck-result-peek="${link}"]`);
  await wait(`!document.querySelector('[data-deck-result-peek-box]').hidden && /\\+ Extra/.test(document.querySelector('[data-deck-result-peek-box]').textContent)`, 'L\'anteprima della carta non si apre');
  await shot('mobile-peek');
  // I pulsanti dell'anteprima devono stare sopra i risultati (un vecchio z-index li copriva).
  const peekBlocked = await evaluate(`[...document.querySelectorAll('[data-deck-result-peek-box] button')].filter(b=>{const r=b.getBoundingClientRect();const h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !(h&&(h===b||b.contains(h)));}).map(b=>b.textContent)`);
  if (peekBlocked.length) throw new Error('Pulsanti dell\'anteprima coperti dai risultati: ' + JSON.stringify(peekBlocked));
  await tap('[data-deck-peek-add="side"]');
  await wait(`window.__deck.cards.some(c=>c.catalogCardId===window.__results[${link}].id&&c.section==='side') && document.querySelector('[data-deck-result-peek-box]').hidden`, '"+ Side" dall\'anteprima non mette la carta nel Side');
  pass('tocco sull\'immagine: anteprima con + Extra / + Side, "+ Side" la mette nel Side e chiude l\'anteprima');

  // 7) scheda Side: le carte vanno nel Side
  await evaluate(`document.querySelector('[data-deck-section="side"]').click()`); await delay(250);
  await wait(`/Side Deck/.test(document.querySelector('[data-deck-search-target]').textContent) && document.querySelector('[data-deck-result-card="4"]').dataset.dest==='side'`, 'Con la scheda Side la destinazione non diventa Side');
  await tap('[data-deck-result="4"]');
  await wait(`window.__deck.cards.some(c=>c.catalogCardId===window.__results[4].id&&c.section==='side')`, 'Con la scheda Side aperta la carta non va nel Side');
  pass('scheda Side aperta: destinazione Side indicata su ogni carta e rispettata');

  // 8) nessun pulsante coperto, chiusura con la X e con la parte scura, linguetta e barra "% pronto"
  const blocked = await covered(); if (blocked.length) throw new Error('Pulsanti coperti nel pannello: ' + JSON.stringify(blocked));
  await tap('[data-deck-search-close]');
  await wait(`!document.querySelector('[data-deck-search-sheet]').classList.contains('open') && !document.querySelector('[data-deck-search-open]').classList.contains('hidden')`, 'La X non chiude il pannello');
  await tap('[data-deck-search-open]');
  await wait(`document.querySelector('[data-deck-search-sheet]').classList.contains('open') && document.querySelector('[data-deck-search-scrim]').classList.contains('on')`, 'La linguetta non riapre il pannello');
  { const { x, y } = await evaluate(`(()=>{const s=document.querySelector('[data-deck-search-sheet]').getBoundingClientRect();return {x:Math.max(8,s.left/2),y:innerHeight/2};})()`); await touch('touchStart', x, y); await delay(60); await touch('touchEnd', x, y); await delay(300); }
  await wait(`!document.querySelector('[data-deck-search-sheet]').classList.contains('open')`, 'Toccare la parte scura non chiude il pannello');
  await delay(350); await shot('mobile-tab-closed');
  const tab = await evaluate(`(()=>{const t=document.querySelector('[data-deck-search-open]').getBoundingClientRect(),p=document.querySelector('.deck-peek')?.getBoundingClientRect();return {right:Math.round(innerWidth-t.right),width:Math.round(t.width),overlapsPeek:Boolean(p&&!(t.bottom<=p.top||t.top>=p.bottom||t.right<=p.left||t.left>=p.right)),peekDisplay:document.querySelector('.deck-peek')?getComputedStyle(document.querySelector('.deck-peek')).display:'assente'};})()`);
  if (tab.right !== 0 || tab.width > 40 || tab.overlapsPeek) throw new Error('La linguetta non è sul bordo destro o tocca la barra "% pronto": ' + JSON.stringify(tab));
  if (tab.peekDisplay === 'none') throw new Error('La barra "% pronto" è stata nascosta');
  pass('nessun pulsante coperto, chiusura con la X e con la parte scura, linguetta stretta sul bordo destro che non tocca la barra "% pronto"');

  // 9) PC: colonna a destra
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await delay(200);
  await evaluate(`document.querySelector('[data-deck-search-open]').click()`);
  await wait(`document.querySelector('[data-deck-search-sheet]').classList.contains('open')`, 'Su PC il pannello non si apre');
  await evaluate(`(()=>{const i=document.querySelector('[data-deck-search]');i.value='carta di prova';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(`document.querySelectorAll('[data-deck-result-card]').length===20`, 'Su PC i risultati non arrivano');
  await delay(350);
  const layout = await evaluate(`(()=>{const s=document.querySelector('[data-deck-search-sheet]').getBoundingClientRect();return {left:s.left,width:s.width,height:s.height,scroll:document.documentElement.scrollWidth<=innerWidth+1};})()`);
  if (!(layout.left > 900 && layout.width <= 410 && layout.height > 800 && layout.scroll)) throw new Error('Su PC il pannello non è una colonna a destra: ' + JSON.stringify(layout));
  const blockedDesk = await covered(); if (blockedDesk.length) throw new Error('Pulsanti coperti su PC: ' + JSON.stringify(blockedDesk));
  await shot('desktop-search');
  pass('PC: la ricerca è una colonna a destra alta tutta la pagina, senza scroll orizzontale né pulsanti coperti');

  // 8b) One Piece: i filtri colore nel pannello si selezionano col dito e filtrano i risultati
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await evaluate(`(async()=>{
    const {DeckController} = await import('/js/decks.js');
    const results = [['Red'],['Green'],['Red','Green'],['Blue'],['Red'],['Green']].map((colors, i) => ({ id:'OP01-0' + (10 + i), name:'Carta OP ' + i, type:'Character', colors, cost:i + 1, setCode:'OP01', image:'/icon-192.png', fullImage:'/icon-192.png' }));
    const deck = { id:'op1', persisted:true, ownerSlug:'daniele', name:'Zoro', format:'', game:'onepiece', cards:[{ catalogCardId:'OP01-001', cardName:'Zoro', section:'leader', quantity:1, colors:['Red'], imageUrl:'/icon-192.png' }] };
    window.__opDeck = deck;
    const controller = new DeckController({ api:{}, getState:() => ({ decks:[deck], game:'onepiece', currentUser:'daniele', collection:[], loans:[] }), searchCards: async () => results,
      onRender:() => { document.querySelector('#app').innerHTML = controller.view(); controller.bind(document); }, onToast:message => window.__toasts.push(String(message)) });
    controller.markDirty = () => {}; controller.activeId = 'op1'; controller.screen = 'detail';
    window.__controller = controller; controller.onRender(); return true;
  })()`);
  await tap('[data-deck-search-open]');
  await evaluate(`(()=>{const i=document.querySelector('[data-deck-search]');i.value='carta op';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(`document.querySelectorAll('[data-deck-result-card]').length===3 && document.querySelector('[data-deck-catalog-color="Red"]')?.classList.contains('active')`, 'One Piece: il prefiltro sul colore del Leader (Rosso) non è applicato');
  await tap('[data-deck-catalog-color="Green"]');
  await wait(`document.querySelector('[data-deck-catalog-color="Green"]').classList.contains('active') && document.querySelectorAll('[data-deck-result-card]').length===5`, 'One Piece: il tocco su "Verde" non aggiunge il colore ai filtri');
  await tap('[data-deck-catalog-color="Red"]');
  await wait(`!document.querySelector('[data-deck-catalog-color="Red"]').classList.contains('active') && document.querySelectorAll('[data-deck-result-card]').length===3`, 'One Piece: il tocco su "Rosso" non toglie il colore dai filtri');
  const chips = await evaluate(`(()=>{const s=document.querySelector('[data-deck-search-sheet]').getBoundingClientRect();const all=[...document.querySelectorAll('[data-deck-catalog-color]')];return {n:all.length,inside:all.every(b=>{const r=b.getBoundingClientRect();return r.left>=s.left-1&&r.right<=s.right+1&&r.top>=0&&r.bottom<=innerHeight;}),green:getComputedStyle(document.querySelector('[data-deck-catalog-color="Green"]')).backgroundColor};})()`);
  if (chips.n !== 6 || !chips.inside) throw new Error('One Piece: non tutti i 6 colori sono visibili nel pannello: ' + JSON.stringify(chips));
  if (chips.green !== 'rgb(232, 184, 79)') throw new Error('One Piece: il colore scelto non è evidenziato in oro: ' + JSON.stringify(chips));
  await shot('mobile-op-colors');
  pass('One Piece: tutti e 6 i colori visibili, si selezionano/deselezionano col dito, il colore scelto diventa oro e filtra i risultati');


  if (errors.length) throw new Error('Errori JavaScript: ' + JSON.stringify(errors));
  console.log(`deck-search-sheet-browser-smoke: ${passed}/${passed} PASS`);
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}
async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const page = list.find(item => item.type === 'page'); if (page) return page; } catch {} await delay(100); } throw new Error('Chrome non raggiungibile'); }
