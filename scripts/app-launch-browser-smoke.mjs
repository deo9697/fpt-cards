// Browser checks for the Android/PWA launch screen (roadmap 2026-09-15):
// first-frame continuity with the native splash, progressive branded reveal,
// responsive sizing, reduced-motion, dismissal semantics and theme-color.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-share-smoke-')), port = 9371;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  const fs = await import('node:fs/promises');
  const html = await fs.readFile('index.html', 'utf8');
  const launch = html.slice(html.indexOf('  <div id="app-launch"'), html.indexOf('  <script src="js/app-launch.js"'));
  const criticalCss = html.slice(html.indexOf('<style>'), html.indexOf('</style>') + '</style>'.length);
  const script = await fs.readFile('js/app-launch.js', 'utf8');
  const bg050711 = 'rgb(5, 7, 17)';

  // --- Step 3: il first frame deve reggersi SOLO sul CSS critico inline in
  // index.html <head>, senza styles.css — harness dedicato senza <link
  // stylesheet>, solo il blocco <style> estratto + il markup dello splash
  // (un about:blank navigato via CDP non completa il fetch di <img>, quindi
  // serve una pagina http reale per verificare il caricamento del logo).
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/app-launch-critical-only-harness.html' });
  await delay(200);
  await evaluate(`document.head.insertAdjacentHTML('beforeend',${JSON.stringify(criticalCss)});document.body.innerHTML=${JSON.stringify(launch)};`);
  await evaluate(`document.querySelector('.app-launch-mark').decode()`);
  const bridgeOnly = await evaluate(`(() => {
    const launchStyle = getComputedStyle(document.querySelector('.app-launch'));
    const mark = document.querySelector('.app-launch-mark'), markStyle = getComputedStyle(mark), markRect = mark.getBoundingClientRect();
    return {
      bodyBg: getComputedStyle(document.body).backgroundColor,
      launchBg: launchStyle.backgroundColor,
      markOpacity: markStyle.opacity,
      markWidth: markRect.width,
      haloOpacity: getComputedStyle(document.querySelector('.app-launch-halo')).opacity,
      brandOpacity: getComputedStyle(document.querySelector('.app-launch-brand')).opacity
    };
  })()`);
  if (bridgeOnly.bodyBg !== bg050711) throw new Error('CSS critico: html/body non è #050711 senza styles.css: ' + bridgeOnly.bodyBg);
  if (bridgeOnly.launchBg !== bg050711) throw new Error('CSS critico: #app-launch non è #050711 senza styles.css: ' + bridgeOnly.launchBg);
  if (bridgeOnly.markOpacity !== '1') throw new Error('CSS critico: il logo non è visibile al primo paint (parte da opacity ' + bridgeOnly.markOpacity + ')');
  if (bridgeOnly.markWidth < 60 || bridgeOnly.markWidth > 150) throw new Error('CSS critico: dimensione logo non moderata (' + bridgeOnly.markWidth + 'px)');
  if (bridgeOnly.haloOpacity !== '0' || bridgeOnly.brandOpacity !== '0') throw new Error('CSS critico: halo/branding visibili nel primissimo frame');
  const bridgeScreenshotPath = path.join(tmpdir(), 'fpt-app-launch-bridge.png');
  const bridgeShot = await send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(bridgeScreenshotPath, Buffer.from(bridgeShot.data, 'base64'));

  // --- Step 1/2/5/9: harness realistico con styles.css, #app popolato con
  // .login-loading (non deve dismissare) e meta theme-color reale.
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/collection-share-harness.html' });
  await delay(500);
  await evaluate(`window.__consoleErrors = []; window.addEventListener('error', e => window.__consoleErrors.push(String(e.message)));`);
  await evaluate(`document.head.insertAdjacentHTML('afterbegin','<base href="/"><meta name="theme-color" content="#050711">');document.body.insertAdjacentHTML('afterbegin',${JSON.stringify(launch)});document.querySelector('#app').innerHTML='<div class="login-loading">Loading</div>';`);
  await evaluate(script);
  await evaluate('document.querySelector(".app-launch-mark").decode()');

  // Il primissimo frame (prima ancora del rAF/120ms di app-launch.js) deve
  // restare "bridge" anche con styles.css completo caricato — stessa
  // proprietà del CSS critico, verificate ora sulla cascata reale.
  const bridgeWithStyles = await evaluate(`(() => ({
    markOpacity: getComputedStyle(document.querySelector('.app-launch-mark')).opacity,
    haloOpacity: getComputedStyle(document.querySelector('.app-launch-halo')).opacity,
    brandOpacity: getComputedStyle(document.querySelector('.app-launch-brand')).opacity,
    isBranded: document.querySelector('.app-launch').classList.contains('is-branded')
  }))()`);
  if (bridgeWithStyles.markOpacity !== '1') throw new Error('Con styles.css il logo non è comunque visibile subito: ' + bridgeWithStyles.markOpacity);
  if (bridgeWithStyles.isBranded) throw new Error('.is-branded presente troppo presto: il primo frame non è più identico allo splash Android');
  if (bridgeWithStyles.haloOpacity !== '0' || bridgeWithStyles.brandOpacity !== '0') throw new Error('Halo/branding visibili prima della fase branded');

  for (const [width, height] of [[360, 800], [390, 844], [412, 915], [844, 390]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    const check = await evaluate(`(() => {
      // splash.scrollWidth non è la metrica giusta qui: #app-launch stesso ha
      // overflow:hidden e l'halo decorativo è volutamente più largo del
      // viewport (bleed clippato per una dissolvenza morbida ai bordi) — la
      // sua estensione non clippata resta comunque nel proprio scrollWidth
      // anche se non è mai visibile. Quello che conta davvero è se la PAGINA
      // scrolla in orizzontale, cioè se il clipping funziona per davvero.
      const splash = document.querySelector('#app-launch'), mark = document.querySelector('.app-launch-mark').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight, mark: mark.left >= 0 && mark.right <= innerWidth && mark.top >= 0 && mark.bottom <= innerHeight, visible: !splash.classList.contains('is-ready') };
    })()`);
    if (check.overflow || !check.mark || !check.visible) throw new Error(`${width}x${height}: ${JSON.stringify(check)}`);
  }

  // --- Step 2: reveal branded dopo il piccolo bridge (~120ms + transizioni).
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await delay(900);
  const branded = await evaluate(`(() => ({
    isBranded: document.querySelector('.app-launch').classList.contains('is-branded'),
    haloOpacity: Number(getComputedStyle(document.querySelector('.app-launch-halo')).opacity),
    brandOpacity: Number(getComputedStyle(document.querySelector('.app-launch-brand')).opacity),
    eyebrow: document.querySelector('.app-launch-eyebrow')?.textContent || ''
  }))()`);
  if (!branded.isBranded) throw new Error('.is-branded non applicata dopo il bridge iniziale');
  if (branded.haloOpacity < 0.9 || branded.brandOpacity < 0.9) throw new Error('Reveal branded incompleto: ' + JSON.stringify(branded));
  if (!branded.eyebrow.includes('F.P.T')) throw new Error('Branding testuale mancante nella fase rivelata');
  const brandedScreenshotPath = path.join(tmpdir(), 'fpt-app-launch-branded.png');
  const brandedShot = await send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(brandedScreenshotPath, Buffer.from(brandedShot.data, 'base64'));

  // --- Step 6: prefers-reduced-motion disattiva animazioni/transizioni.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reducedMotion = await evaluate(`(() => ({
    halo: getComputedStyle(document.querySelector('.app-launch-halo')).animationName,
    mark: getComputedStyle(document.querySelector('.app-launch-mark')).transitionDuration,
    track: getComputedStyle(document.querySelector('.app-launch-track i')).animationName
  }))()`);
  if (reducedMotion.halo !== 'none' || reducedMotion.track !== 'none') throw new Error('Reduced motion ignorato sulle animazioni: ' + JSON.stringify(reducedMotion));
  if (!/^0s(,\s*0s)?$/.test(reducedMotion.mark)) throw new Error('Reduced motion ignorato sulle transizioni del logo: ' + reducedMotion.mark);
  await send('Emulation.setEmulatedMedia', { features: [] });

  // --- Step 5/4: dismiss quando compare UI reale, non su .login-loading; il
  // meta theme-color torna al colore reale dell'app dopo la chiusura.
  await evaluate(`document.querySelector('#app').innerHTML='<main class="app-shell">Ready</main>'`);
  await delay(500);
  const afterReady = await evaluate(`(() => ({ splash: !!document.querySelector('#app-launch'), themeColor: document.querySelector('meta[name="theme-color"]').getAttribute('content') }))()`);
  if (afterReady.splash) throw new Error('Splash blocked ready app');
  if (afterReady.themeColor !== '#07080d') throw new Error('theme-color non ripristinato al colore reale dell’app: ' + afterReady.themeColor);

  // --- Step 5: fallback quando il bootstrap resta rotto.
  await evaluate(`document.querySelector('#app').innerHTML='';document.body.insertAdjacentHTML('afterbegin',${JSON.stringify(launch)});`);
  await evaluate(script);
  await delay(6500);
  if (await evaluate('!!document.querySelector("#app-launch")')) throw new Error('Fallback failed');

  const consoleErrors = await evaluate('window.__consoleErrors || []');
  if (consoleErrors.length) throw new Error('Errori console durante il boot: ' + JSON.stringify(consoleErrors));

  console.log('PASS launch screen: continuità first-frame (CSS critico standalone), reveal branded, 360x800/390x844/412x915/landscape senza overflow, reduced motion, dismiss reale vs .login-loading, theme-color, fallback, nessun errore console.');
  console.log('Screenshot bridge: ' + bridgeScreenshotPath);
  console.log('Screenshot branded: ' + brandedScreenshotPath);
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
