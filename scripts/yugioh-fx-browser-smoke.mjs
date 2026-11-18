// Browser smoke for js/games/yugioh/simulator-fx.js (stile Neon FPT, 2026-11-18):
// phase banners, summon FX per type, action menu and summon-choice panel,
// promise resolution, reduced motion, no overflow, no console errors.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-fx-smoke-')), port = 9383;
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
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 500, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/yugioh-fx-harness.html' });
  for (let i = 0; i < 60 && !(await evaluate('Boolean(window.__fxReady)').catch(() => false)); i++) await delay(100);
  assert(await evaluate('Boolean(window.__fxReady)'), 'harness non pronto');

  // Phase banner: shows the label, resolves, clears the layer.
  const phase = await evaluate(`(async()=>{const p=__fx.phase('battle',{turn:3,player:'Daniele'});await new Promise(r=>setTimeout(r,500));
    const text=document.querySelector('.dfx-banner')?.textContent;const t0=performance.now();await p;
    return {text,ms:performance.now()-t0,empty:document.querySelector('.dfx-layer').children.length===0,busy:__fx.busy};})()`);
  assert(phase.text.includes('Battle Phase') && phase.text.includes('Turno 3 · Daniele'), 'fascia di fase: ' + JSON.stringify(phase));
  assert(phase.empty && !phase.busy && phase.ms < 2000, 'la fascia deve risolversi e svuotare il livello: ' + JSON.stringify(phase));
  console.log('PASS fasce di fase: etichetta + turno, Promise risolta, livello svuotato');

  // Summons: structure per type.
  const counts = await evaluate(`(async()=>{const out={};
    __fx.summon({type:'synchro',level:8,name:'Prova'});out.synchro={rings:document.querySelectorAll('.dfx-ring').length,stars:document.querySelectorAll('.dfx-star').length,cap:document.querySelector('.dfx-caption').textContent};
    __fx.summon({type:'xyz',rank:4,materials:3});out.xyz={orbs:document.querySelectorAll('.dfx-orb').length,units:document.querySelectorAll('.dfx-unit').length,cap:document.querySelector('.dfx-caption').textContent};
    __fx.summon({type:'link',link:2,markers:['bottom-left','bottom-right']});out.link={arrows:document.querySelectorAll('.dfx-arrow').length,lit:document.querySelectorAll('.dfx-arrow.is-lit').length,num:document.querySelector('.dfx-link-num').textContent};
    __fx.summon({type:'fusion'});out.fusion={swirls:document.querySelectorAll('.dfx-swirl').length};
    __fx.summon({type:'normal'});out.normal={shock:document.querySelectorAll('.dfx-shock').length};
    __fx.cancel();return out;})()`);
  assert(counts.synchro.rings === 8 && counts.synchro.stars === 8 && counts.synchro.cap.includes('LV 8'), 'Synchro: ' + JSON.stringify(counts.synchro));
  assert(counts.xyz.orbs === 3 && counts.xyz.units === 3 && counts.xyz.cap.includes('Rango 4'), 'Xyz: ' + JSON.stringify(counts.xyz));
  assert(counts.link.arrows === 8 && counts.link.lit === 2 && counts.link.num === 'LINK-2', 'Link: ' + JSON.stringify(counts.link));
  assert(counts.fusion.swirls === 2 && counts.normal.shock === 1, 'Fusione/Normale: ' + JSON.stringify(counts));
  console.log('PASS evocazioni: Synchro (anelli = livello), Xyz (materiali = unità), Link (frecce accese = marcatori), Fusione, Normale');

  // Interrupting an effect resolves the previous promise (no dangling awaits).
  const interrupted = await evaluate(`(async()=>{let done=false;__fx.summon({type:'synchro',level:4}).then(()=>{done=true;});__fx.phase('end');await new Promise(r=>setTimeout(r,20));const ok=done;__fx.cancel();return ok;})()`);
  assert(interrupted, 'un effetto interrotto deve risolvere la sua Promise');
  console.log('PASS un nuovo effetto interrompe il precedente e ne risolve la Promise');

  // Action menu: disabled entry not clickable; picking returns its id.
  const menu = await evaluate(`(async()=>{const p=__fx.actionMenu({anchor:document.getElementById('card'),actions:[{id:'summon',label:'Evoca / Posiziona',hint:'Mano'},{id:'effect',label:'Attiva effetto',disabled:true,reason:'Già usato in questo turno'},{id:'attack',label:'Attacca',hint:'Battle'}]});
    const buttons=[...document.querySelectorAll('.dfx-menu button')];const disabled=buttons[1].disabled&&buttons[1].title.includes('Già usato');buttons[1].click();
    const stillOpen=Boolean(document.querySelector('.dfx-menu'));const interactive=document.querySelector('.dfx-layer').classList.contains('is-interactive');
    buttons[2].click();const picked=await p;return {disabled,stillOpen,interactive,picked,count:buttons.length,closed:!document.querySelector('.dfx-menu')};})()`);
  assert(menu.disabled && menu.stillOpen && menu.interactive && menu.picked === 'attack' && menu.count === 4 && menu.closed, 'menu azioni: ' + JSON.stringify(menu));
  console.log('PASS menu azioni: voce disabilitata col motivo, scelta restituita, "Annulla" sempre presente');

  // Summon choice: disabled option shows its reason; position applies; cancel = null.
  const choice = await evaluate(`(async()=>{const p=__fx.chooseSummon({name:'Prova',level:8,atk:3000,def:2500,note:'Livello 8: servono 2 tributi.',options:[{id:'normal',label:'Evocazione Normale',hint:'2 tributi',disabled:true,reason:'Hai già usato la Normale in questo turno'},{id:'set',label:'Posiziona coperta',needsPosition:false},{id:'special',label:'Evocazione Speciale',hint:'effetto'}]});
    const opts=[...document.querySelectorAll('.dfx-option')];const reason=opts[0].textContent;const firstEnabled=opts.find(b=>b.getAttribute('aria-pressed')==='true')?.dataset.method;
    opts[2].click();document.querySelector('[data-position=defense]').click();document.querySelector('.dfx-go').click();const res=await p;
    const p2=__fx.chooseSummon({options:[{id:'set',label:'Posiziona',needsPosition:false}]});const hidden=document.querySelector('.dfx-pos').hidden;document.querySelector('.dfx-go').click();const res2=await p2;
    const p3=__fx.chooseSummon({options:[{id:'special',label:'Speciale'}]});[...document.querySelectorAll('.dfx-choice-actions button')][0].click();const res3=await p3;
    return {reason,firstEnabled,res,hidden,res2,res3};})()`);
  assert(choice.reason.includes('già usato') && choice.firstEnabled === 'set', 'scelta: motivo e prima opzione valida ' + JSON.stringify(choice));
  assert(choice.res.method === 'special' && choice.res.position === 'defense', 'scelta: metodo/posizione ' + JSON.stringify(choice.res));
  assert(choice.hidden && choice.res2.method === 'set' && choice.res2.position === null && choice.res3 === null, 'scelta: coperta senza posizione, Annulla = null ' + JSON.stringify(choice));
  console.log('PASS scelta evocazione: motivo delle opzioni non disponibili, posizione ATK/DEF, coperta senza posizione, Annulla');

  // Layout: no overflow at a phone landscape size; reduced motion is quick.
  await send('Emulation.setDeviceMetricsOverride', { width: 740, height: 360, deviceScaleFactor: 1, mobile: true });
  const overflow = await evaluate(`(async()=>{__fx.chooseSummon({options:[{id:'special',label:'Speciale'}]});await new Promise(r=>setTimeout(r,250));
    const panel=document.querySelector('.dfx-choice').getBoundingClientRect(),field=document.getElementById('field').getBoundingClientRect();
    const inside=panel.right<=field.right+1&&panel.bottom<=field.bottom+1;__fx.cancel();return {inside,page:document.documentElement.scrollWidth>innerWidth};})()`);
  assert(overflow.inside && !overflow.page, 'pannello fuori dal campo a 740x360: ' + JSON.stringify(overflow));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const quick = await evaluate(`(async()=>{const t=performance.now();await __fx.summon({type:'xyz'});return performance.now()-t;})()`);
  assert(quick < 400, "con animazioni ridotte l'effetto deve durare un istante: " + quick);
  console.log('PASS nessun overflow a 740x360, animazioni ridotte rispettate (' + Math.round(quick) + ' ms)');

  const destroyed = await evaluate(`(()=>{__fx.destroy();return !document.querySelector('.dfx-layer')&&!document.getElementById('field').classList.contains('dfx-host');})()`);
  assert(destroyed, 'destroy deve rimuovere il livello');
  assert(!errors.length, 'errori console: ' + errors.join(' | '));
  console.log('yugioh-fx-browser-smoke: OK');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}
async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
