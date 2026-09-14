// api/card-image-proxy.js — hardening: redirect verso host non whitelisted
// bloccati (validazione ad OGNI hop, mai un fetch con redirect:'follow'), e
// un tetto alla dimensione della risposta immagine applicato sia sul
// Content-Length dichiarato sia sui byte realmente letti dallo stream (un
// header assente/falsato non deve permettere di superare il limite).
// Nessuna rete reale: fetch globale stubbato per ogni scenario, cosi' il
// test è deterministico e non dipende da ygoprodeck.com/optcgapi.com.
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// api/card-image-proxy.js è deliberatamente CommonJS (module.exports, stesso
// stile già usato da api/push-public-key.js ecc. per Vercel) mentre questo
// repo ha "type":"module" nel package.json — createRequire() qui fallirebbe
// (Node tenta l'interop require(esm) su un .js con quel package.json e va a
// sbattere contro "module is not defined"). Si compila il sorgente come CJS
// esplicito con l'API Module di basso livello, senza toccare né rinominare
// il file di produzione.
const proxyPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api', 'card-image-proxy.js');
const proxyModule = new Module(proxyPath);
proxyModule.filename = proxyPath;
proxyModule.paths = Module._nodeModulePaths(path.dirname(proxyPath));
proxyModule._compile(readFileSync(proxyPath, 'utf8'), proxyPath);
const handler = proxyModule.exports;

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null, json: null };
  res.status = code => { res.statusCode = code; return res; };
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.json = payload => { res._json = payload; return res; };
  res.send = payload => { res.body = payload; return res; };
  return res;
}

function imageResponse(bytes, { contentLength } = {}) {
  const headers = { 'content-type': 'image/png' };
  if (contentLength !== undefined) headers['content-length'] = String(contentLength);
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); }
  }), { status: 200, headers });
}
// Mock duck-typed (non un vero Response/ReadableStream): Undici pre-legge
// internamente un ReadableStream reale anche solo costruendolo/passandolo a
// Response (osservato empiricamente: pull() scatta prima che il codice del
// proxy chiami mai reader.read()), rendendo inaffidabile verificare "il body
// non è mai stato letto" con un vero stream. Qui il conteggio delle letture
// è sotto controllo diretto del test.
function mockUpstream({ status = 200, headers = {}, chunks = [] } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const state = { readCalls: 0 };
  const upstream = {
    status, ok: status >= 200 && status < 300,
    headers: { get: name => headerMap.get(String(name).toLowerCase()) ?? null },
    body: {
      getReader() {
        let index = 0;
        return {
          async read() { state.readCalls++; return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }; },
          async cancel() {}
        };
      }
    }
  };
  return { upstream, state };
}
function redirectResponse(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

async function run(url, fetchStub) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    const res = fakeRes();
    await handler({ method: 'GET', query: { url } }, res);
    return res;
  } finally { globalThis.fetch = originalFetch; }
}

// --- Redirect verso host non whitelisted: bloccato -----------------------
{
  let calls = 0;
  const res = await run('https://images.ygoprodeck.com/images/cards_cropped/1.jpg', async () => {
    calls++;
    return redirectResponse('https://evil-attacker.example/steal.jpg');
  });
  assert.equal(res.statusCode, 403, 'un redirect verso un host fuori whitelist deve essere rifiutato');
  assert.equal(calls, 1, 'il secondo hop (host non whitelisted) non deve mai essere richiesto');
  assert.equal(res.body, null, 'nessun byte deve essere restituito quando il redirect è rifiutato');
  console.log('PASS redirect verso host non whitelisted: rifiutato (403), il secondo hop non viene mai richiesto');
}

// --- Redirect verso un host ANCORA whitelisted: seguito ------------------
{
  const calledUrls = [];
  const res = await run('https://images.ygoprodeck.com/images/cards/1.jpg', async url => {
    calledUrls.push(String(url));
    if (calledUrls.length === 1) return redirectResponse('https://images.ygoprodeck.com/images/cards_cropped/1.jpg');
    return imageResponse(new Uint8Array([1, 2, 3]));
  });
  assert.equal(res.statusCode, 200, 'un redirect tra due host ENTRAMBI whitelisted deve essere seguito');
  assert.equal(calledUrls.length, 2, 'atteso esattamente un hop di redirect');
  console.log('PASS redirect tra due host entrambi whitelisted: seguito correttamente');
}

// --- Redirect relativo (senza host): risolto contro l'host corrente, poi validato ---
{
  const calledUrls = [];
  const res = await run('https://images.ygoprodeck.com/images/cards/1.jpg', async url => {
    calledUrls.push(String(url));
    if (calledUrls.length === 1) return redirectResponse('/images/cards_cropped/1.jpg');
    return imageResponse(new Uint8Array([9]));
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calledUrls[1], 'https://images.ygoprodeck.com/images/cards_cropped/1.jpg', 'un redirect relativo va risolto contro l\'host del hop precedente');
  console.log('PASS redirect relativo: risolto correttamente contro l\'host corrente e validato');
}

// --- Troppi redirect: rifiutato, mai un loop infinito ---------------------
{
  let calls = 0;
  const res = await run('https://images.ygoprodeck.com/images/cards/1.jpg', async () => {
    calls++;
    return redirectResponse(`https://images.ygoprodeck.com/images/cards/${calls}.jpg`);
  });
  assert.equal(res.statusCode, 502, 'troppi redirect consecutivi devono essere rifiutati');
  assert(calls <= 5, `atteso un numero di hop limitato, non un loop illimitato (chiamate: ${calls})`);
  console.log('PASS troppi redirect: rifiutato con un limite di hop, mai un loop illimitato');
}

// --- Content-Length dichiarato oltre il limite: rifiutato SENZA leggere il body ---
{
  const { upstream, state } = mockUpstream({ headers: { 'content-type': 'image/jpeg', 'content-length': String(50 * 1024 * 1024) }, chunks: [new Uint8Array(10)] });
  const res = await run('https://optcgapi.com/media/static/Card_Images/OP01-001.jpg', async () => upstream);
  assert.equal(res.statusCode, 413, 'un Content-Length dichiarato oltre il limite deve essere rifiutato');
  assert.equal(state.readCalls, 0, 'reader.read() non deve mai essere chiamato quando Content-Length supera già il limite');
  console.log('PASS Content-Length dichiarato oltre il limite: rifiutato (413) senza leggere il body');
}

// --- Content-Length assente/falsato, ma il body reale supera il limite: rifiutato in streaming ---
{
  const chunkSize = 1024 * 1024; // 1MB a chunk, 8 chunk = 8MB totali, oltre il limite di 5MB, MAI dichiarati in un header
  const chunks = Array.from({ length: 8 }, () => new Uint8Array(chunkSize));
  const { upstream, state } = mockUpstream({ headers: { 'content-type': 'image/jpeg' }, chunks }); // nessun content-length
  const res = await run('https://images.ygoprodeck.com/images/cards/1.jpg', async () => upstream);
  assert.equal(res.statusCode, 413, 'un body più grande del limite deve essere rifiutato anche senza Content-Length dichiarato');
  assert(state.readCalls < chunks.length, `la lettura deve fermarsi PRIMA di consumare l'intero body oversize (letture: ${state.readCalls})`);
  console.log('PASS body oltre il limite senza Content-Length dichiarato: rifiutato in streaming, lettura interrotta appena superata la soglia');
}

// --- Immagine valida sotto il limite: passa, header corretti --------------
{
  const bytes = new Uint8Array(2048).fill(7);
  const res = await run('https://images.ygoprodeck.com/images/cards_cropped/1.jpg', async () => imageResponse(bytes, { contentLength: bytes.length }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(Buffer.isBuffer(res.body), true);
  assert.equal(res.body.length, bytes.length);
  console.log('PASS immagine valida sotto il limite: 200, Content-Type/CORS/cache header corretti, byte integri');
}

// --- Regressioni: host non whitelisted diretto, protocollo non https, url mancante, metodo non GET, content-type non immagine ---
{
  const notWhitelisted = await run('https://evil.example/x.jpg', async () => { throw new Error('non deve mai essere chiamato'); });
  assert.equal(notWhitelisted.statusCode, 403);

  const notHttps = await run('http://images.ygoprodeck.com/images/cards/1.jpg', async () => { throw new Error('non deve mai essere chiamato'); });
  assert.equal(notHttps.statusCode, 403, 'un URL non-https verso un host whitelisted deve comunque essere rifiutato');

  const resMissing = fakeRes(); await handler({ method: 'GET', query: {} }, resMissing);
  assert.equal(resMissing.statusCode, 400);

  const resMethod = fakeRes(); await handler({ method: 'POST', query: { url: 'https://images.ygoprodeck.com/images/cards/1.jpg' } }, resMethod);
  assert.equal(resMethod.statusCode, 405);

  const resBadType = await run('https://images.ygoprodeck.com/images/cards/1.jpg', async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/html' } }));
  assert.equal(resBadType.statusCode, 415);

  console.log('PASS regressioni invariate: host non whitelisted diretto, protocollo non-https, url mancante, metodo non consentito, content-type non immagine');
}

console.log('PASS card-image-proxy hardening: redirect verso host non whitelisted bloccati (diretti e relativi), redirect tra host whitelisted seguiti, limite hop, tetto dimensione (header dichiarato e streaming reale), regressioni preesistenti intatte');
