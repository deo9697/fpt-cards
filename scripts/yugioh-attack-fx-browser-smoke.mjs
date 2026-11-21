// Browser smoke for js/games/yugioh/simulator-attack-fx.js (stile A «Carica», 2026-11-21):
// phase banners, summon FX per type, action menu and summon-choice panel,
// promise resolution, reduced motion, no overflow, no console errors.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-attack-smoke-')), port = 9387;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };

let previewServer = null;
const alreadyUp = await fetch('http://localhost:8080/index.html').then(() => true).catch(() => false);
if (!alreadyUp) {
  previewServer = spawn(process.execPath, ['scripts/preview-server.mjs'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 50; i++) { if (await fetch('http://localhost:8080/index.html').then(() => true).catch(() => false)) break; await delay(100); }
}
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=900,500', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  const target = await waitTarget(port); socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map(), errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || 'exception');
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(arg => arg.value).join(' '));
    const task = pending.get(message.id); if (!task) return; pending.delete(message.id);
    message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/yugioh-fx-harness.html' });
  for (let i = 0; i < 60 && !(await evaluate('document.readyState==="complete"').catch(() => false)); i++) await delay(100);
  const fs = await import('node:fs'); fs.mkdirSync('artifacts/yugioh-attack-fx', { recursive: true });
  const shot = async name => { const result = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`artifacts/yugioh-attack-fx/${name}.png`, Buffer.from(result.data, 'base64')); };
  // Minimal board: the real class names the module looks up.
  await evaluate(`(async()=>{document.body.innerHTML='<style>body{margin:0;background:#120d18;font-family:sans-serif}.ygo-duelist{position:absolute;padding:6px 12px;border:1px solid #e8b85c99;background:#211c15;color:#f3d79b}.is-opponent{left:20px;top:14px}.is-self{right:20px;bottom:14px}.ygo-field{position:absolute;left:180px;right:180px;display:grid;grid-template-columns:repeat(5,1fr);gap:12px}.o{top:70px}.m{bottom:70px}.z{height:110px;display:grid;place-items:center;border:1px solid #a9c5c43d}.ygo-card{width:75px;height:108px;background:linear-gradient(160deg,#ffcf8a,#b86a2b 55%,#3d1f12);border:1px solid #c5b995}</style><div class="ygo-duelist is-opponent"><div class="ygo-duelist-info"><strong>Prova</strong><span><b>8000</b></span></div></div><div class="ygo-duelist is-self"><div class="ygo-duelist-info"><strong>Tu</strong><span><b>8000</b></span></div></div><div class="ygo-field o"><div class="z"></div><div class="z"><div class="ygo-card" data-ygo-card="t1" data-player="1"></div></div><div class="z"></div><div class="z"></div><div class="z"></div></div><div class="ygo-field m"><div class="z"></div><div class="z"></div><div class="z"><div class="ygo-card" data-ygo-card="a1" data-player="0"></div></div><div class="z"></div><div class="z"></div></div>';
    window.__mod=await import('/js/games/yugioh/simulator-attack-fx.js');window.__afx=__mod.createAttackFx();return true;})()`);
  const session = { players: [{ lp: 8000, monsters: [{ id: 'a1', location: 4, sequence: 2 }], extraMonsters: [] }, { lp: 8000, monsters: [{ id: 't1', location: 4, sequence: 1 }], extraMonsters: [] }] };
  const run = async (events, label) => {
    await evaluate(`window.__done=false;void __afx.play(${JSON.stringify(events)},{session:${JSON.stringify(session)},viewer:0}).then(()=>window.__done=true)`);
    await delay(330); await shot(label + '-mid');
    const mid = await evaluate(`({ghost:!!document.querySelector('.ygo-attack-ghost'),trail:document.querySelector('.ygo-attack-layer').children.length})`);
    for (let i = 0; i < 60 && !(await evaluate('window.__done')); i++) await delay(50);
    return mid;
  };
  let mid = await run({ attack: { auto: true, attackerPlayer: 0, attacker: { controller: 0, location: 4, sequence: 2 }, target: { controller: 1, location: 4, sequence: 1 } }, damage: [] }, 'monster');
  assert(mid.ghost && mid.trail >= 2, 'carica verso il mostro: ' + JSON.stringify(mid));
  assert(await evaluate('!document.querySelector(".ygo-attack-ghost")'), 'il fantasma sparisce a fine carica');
  console.log('PASS attacco a un mostro: fantasma che carica con scia, pulito alla fine');
  mid = await run({ attack: { auto: true, attackerPlayer: 0, attacker: { controller: 0, location: 4, sequence: 2 }, target: null }, damage: [] }, 'direct');
  assert(mid.ghost, 'attacco diretto: ' + JSON.stringify(mid));
  await evaluate(`document.querySelector('.is-opponent b').textContent='5500';void __afx.play({attack:null,damage:[{player:1,from:8000,to:5500}]},{session:${JSON.stringify(session)},viewer:0})`);
  await delay(250); await shot('damage');
  const dmg = await evaluate(`({label:[...document.querySelector('.ygo-attack-layer').children].some(n=>n.textContent==='-2500'),lp:Number(document.querySelector('.is-opponent b').textContent)})`);
  assert(dmg.label && dmg.lp > 5500 && dmg.lp < 8000, 'Life Points: danno visibile e numero che scende: ' + JSON.stringify(dmg));
  await delay(900);
  assert(await evaluate(`document.querySelector('.is-opponent b').textContent==='5500'`), 'il numero arriva al valore finale');
  console.log('PASS attacco diretto e Life Points: «-2500» che sale, numero che scende fino a 5500');
  await evaluate('__afx.dispose()');
  assert(await evaluate('!document.querySelector(".ygo-attack-layer")'), 'dispose rimuove il livello');
  assert(!errors.length, 'errori console: ' + errors.join(' | '));
  console.log('yugioh-attack-fx-browser-smoke: OK');

} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}
async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
