// Fast Scan, revisione a selezione multipla — verifica reale in Chrome a
// 360/390/768 px: niente overflow, pallino e stato sotto ogni carta, barra di
// selezione con 2 + 6 pulsanti da almeno 44 px, salvataggio nascosto mentre si
// sceglie. Fixture isolata (solo #app + styles.css, mai index.html).
// Argomento opzionale "real": immagini vere dalla rete per lo screenshot.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-scan-selection-smoke-')), port = 9376;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const realImages = process.argv[2] === 'real';

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
  await evaluate(`document.head.insertAdjacentHTML('afterbegin','<base href="/">');`);
  const art = 'data:image/png;base64,' + (await readFile('icon-192.png')).toString('base64');
  await evaluate('window.__art=' + JSON.stringify(art) + ';window.__real=' + JSON.stringify(realImages));

  const setup = await evaluate(`(async()=>{
    const {FastScanController} = await import('/js/fast-scan.js');
    const c = new FastScanController({camera:{stream:{},stop(){},focusSupported:false,torchSupported:false},paddleOcr:{prepare:async()=>{}},isOnline:()=>true,onRender(){window.__render();},onRoute(){},onToast(){}});
    c.persist = () => {};
    const img = id => window.__real ? 'https://images.ygoprodeck.com/images/cards/'+id+'.jpg' : window.__art;
    const cards = [['p1','1784686','The Eye of Timaeus','DRLG-IT005','Secret Rare'],['p2','6165656','Number C88: Gimmick Puppet Disaster Leo','PGLD-EN021','Gold Secret Rare'],['p3','88305705','Brave-Eyes Pendulum Dragon','RATE-IT039','Secret Rare'],['p4','38033121','Dark Magician Girl','PGLD-EN033','Gold Rare'],['p5','74820316','Enlilgirsu, the Orcust Mekk-Knight','BLMM-EN053','Ultra Rare'],['p6','6351147','Transaction Rollback','MP24-EN134','Prismatic Secret Rare']];
    c.buffer.settings = {...c.buffer.settings, condition:'Near Mint', edition:''};
    for (const [printingId,catalogCardId,cardName,setCode,rarity] of cards) c.buffer.add({printingId,game:'yugioh',catalogCardId,cardName,setCode,rarity,imageUrl:img(catalogCardId)});
    c.buffer.add({printingId:'p1',game:'yugioh',catalogCardId:'1784686',cardName:'The Eye of Timaeus',setCode:'DRLG-IT005',rarity:'Secret Rare',imageUrl:img('1784686')});
    c.buffer.setEdition('p1','Prima Edizione'); c.buffer.setEdition('p6','Prima Edizione');
    c.phase = 'review';
    window.__c = c;
    window.__render = () => { document.querySelector('#app').innerHTML = '<main class="fast-scan-route">'+c.view()+'</main>'; c.bind(document); };
    window.__render();
    return true;
  })()`);
  if (!setup) throw new Error('Setup revisione fallito');

  // Scelta reale con clic sul pallino (gestori veri), poi 1ª Edizione + Played.
  await evaluate(`document.querySelector('[data-scan-select="p2"].fsx-tile-check').click()`);
  await evaluate(`document.querySelector('.fsx-tile-open[data-scan-select="p5"]').click()`);
  await evaluate(`document.querySelector('[data-scan-bulk-condition="Played"]').click()`);
  const applied = await evaluate(`({p2: window.__c.buffer.entries.get('p2').condition, p5: window.__c.buffer.entries.get('p5').condition, p1: window.__c.buffer.entries.get('p1').condition})`);
  if (applied.p2 !== 'Played' || applied.p5 !== 'Played' || applied.p1 !== 'Near Mint') throw Error('Condizione non applicata alle sole carte scelte: ' + JSON.stringify(applied));

  for (const width of [360, 390, 768]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 900 });
    const check = await evaluate(`(()=>{
      const bar = document.querySelector('.fsx-selbar'), save = document.querySelector('.scan-save-bar');
      const small = [...bar.querySelectorAll('button[aria-pressed]')].filter(b => b.getBoundingClientRect().height < 44).length;
      const checks = [...document.querySelectorAll('.fsx-tile-check')].map(b => b.getBoundingClientRect());
      return {overflow: document.body.getBoundingClientRect().width > innerWidth + 1, barButtons: bar.querySelectorAll('button[aria-pressed]').length, small,
        saveHidden: getComputedStyle(save).display === 'none', checks: checks.length, checkSize: Math.round(Math.min(...checks.map(r => r.width))),
        states: document.querySelectorAll('.fsx-tile-state .fsx-state-cond').length, selected: document.querySelectorAll('.fsx-tile.selected').length};
    })()`);
    if (check.overflow || check.barButtons !== 8 || check.small || !check.saveHidden || check.checks !== 6 || check.checkSize < 44 || check.states !== 6 || check.selected !== 2) throw Error(`Revisione non valida a ${width}px: ${JSON.stringify(check)}`);
  }
  console.log('PASS revisione a 360/390/768px: 6 pallini da 44px, stato sotto ogni carta, barra con 8 pulsanti da 44px, salvataggio nascosto, condizione applicata alle 2 carte scelte');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  if (realImages) await evaluate(`Promise.all([...document.querySelectorAll('.fsx-tile-art img')].map(i => i.decode().catch(()=>null))).then(()=>new Promise(r=>setTimeout(r,1500)))`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const screenshotPath = path.join(tmpdir(), realImages ? 'fpt-scan-selection-real.png' : 'fpt-scan-selection.png');
  await writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));
  if ((await evaluate('window.__consoleErrors')).length) throw Error('Errori console imprevisti: ' + JSON.stringify(await evaluate('window.__consoleErrors')));
  console.log('PASS fast-scan-review-selection-browser (browser reale). Screenshot: ' + screenshotPath);
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
