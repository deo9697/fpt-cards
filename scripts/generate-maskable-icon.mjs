// Genera una variante "maskable" di icon-512.png in modo non distruttivo:
// stesso artwork, nessun taglio/redesign — solo ridimensionato e centrato su
// un canvas pieno del colore di sfondo dell'app, così Android (che applica
// la propria maschera circolare/squircle alle icone maskable) ha un margine
// di sicurezza invece di tagliare via testo/elementi fino al bordo.
// Interim ("cerotto", per esplicita richiesta) in attesa di un vero redesign
// pensato per la safe zone — vedi il report del 2026-09-15.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = await mkdtemp(path.join(tmpdir(), 'fpt-icon-'));
const port = 9372;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const BG = '#050711';
const SCALE = 0.8; // ~10% di margine per lato: compromesso pragmatico, non garanzia assoluta su ogni launcher.

const sourceBase64 = (await readFile('icon-512.png')).toString('base64');

const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  const target = await waitTarget(port); socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', event => { const message = JSON.parse(event.data), task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };

  await send('Runtime.enable'); await send('Page.enable');
  await evaluate(`window.__sourceBase64=${JSON.stringify(sourceBase64)};void 0`);
  const maskableBase64 = await evaluate(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + window.__sourceBase64;
    await img.decode();
    const size = 512, scale = ${SCALE};
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '${BG}';
    ctx.fillRect(0, 0, size, size);
    const drawSize = size * scale, offset = (size - drawSize) / 2;
    ctx.drawImage(img, offset, offset, drawSize, drawSize);
    return canvas.toDataURL('image/png').split(',')[1];
  })()`);

  await writeFile('icon-512-maskable.png', Buffer.from(maskableBase64, 'base64'));
  console.log('Generato icon-512-maskable.png (scale ' + SCALE + ', bg ' + BG + ')');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
