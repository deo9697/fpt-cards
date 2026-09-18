// Fast Scan — strumentazione debug (?debugScan=1): executionMode/cacheState/
// worker counters (js/fast-scan-ocr-engine-b.js), aggregazione di sessione
// (ScanTelemetry dentro js/fast-scan.js, non esportata separatamente ma
// raggiungibile via FastScanController.telemetry), e il passthrough del
// flag `complete` in syncCatalogIndex (js/fast-scan-catalog-cache.js).
// Nessuna modifica al modello OCR/preprocessing: solo osservabilità di
// comportamenti già esistenti (worker vs fallback main-thread, reset() su
// fallimento, sync del catalogo) — vedi docs/ocr-audit-2026-09-16.md e
// docs/fast-scan-benchmark-procedure.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';

function test(name, fn) { try { fn(); console.log(`PASS ${name}`); } catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; } }
async function asyncTest(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; } }

// --- PaddleOcrEngine: executionMode/workerTimeoutCount/workerRestartCount ---
const { PaddleOcrEngine } = await import('../js/fast-scan-ocr-engine-b.js');

function fakeCanvas() { return { width: 900, height: 117 }; }

await asyncTest('engine nuovo: executionMode WORKER, contatori a zero', () => {
  const engine = new PaddleOcrEngine();
  assert.equal(engine.executionMode, 'WORKER');
  assert.equal(engine.workerTimeoutCount, 0);
  assert.equal(engine.workerRestartCount, 0);
});

await asyncTest('recognize con worker creato -> executionMode resta WORKER, worker:true nel risultato', async () => {
  const engine = new PaddleOcrEngine({
    loader: async () => ({ PaddleOCR: { create: async ({ worker }) => { worker.createWorker(); return { predict: async () => ({ items: [{ text: 'LOB-001', score: 0.95 }] }) }; } } }),
    workerUrl: async () => 'blob:fake',
    WorkerClass: class { terminate() {} }
  });
  const result = await engine.recognize(fakeCanvas());
  assert.equal(result.worker, true);
  assert.equal(engine.executionMode, 'WORKER');
});

await asyncTest('recognize SENZA worker creato (libreria non lo invoca) -> executionMode MAIN_THREAD_FALLBACK', async () => {
  const engine = new PaddleOcrEngine({
    loader: async () => ({ PaddleOCR: { create: async () => ({ predict: async () => ({ items: [{ text: 'LOB-001', score: 0.9 }] }) }) } }),
    workerUrl: async () => 'blob:fake',
    WorkerClass: class { terminate() {} }
  });
  const result = await engine.recognize(fakeCanvas());
  assert.equal(result.worker, false, 'nessun this.worker impostato: la libreria non ha chiamato createWorker()');
  assert.equal(engine.executionMode, 'MAIN_THREAD_FALLBACK');
});

await asyncTest('fallimento di prepare() -> workerRestartCount incrementato, executionMode WORKER_FAILED, cooldown immediato, poi WORKER_RESTARTING dopo il cooldown', async () => {
  let attempt = 0;
  const engine = new PaddleOcrEngine({
    loader: async () => { attempt++; if (attempt === 1) throw new Error('modello non disponibile'); return { PaddleOCR: { create: async ({ worker }) => { worker.createWorker(); return { predict: async () => ({ items: [] }) }; } } }; },
    workerUrl: async () => 'blob:fake',
    WorkerClass: class { terminate() {} },
    cooldownBaseMs: 5
  });
  await assert.rejects(() => engine.prepare());
  assert.equal(engine.workerRestartCount, 1);
  assert.equal(engine.executionMode, 'WORKER_FAILED');
  assert.equal(engine.everFailed, true);
  // Circuit breaker (audit OCR 2026-09-17): un tentativo immediato dopo il
  // fallimento non deve ripartire dalla rete (CDN/modello ancora giù) — deve
  // fallire subito con ENGINE_COOLDOWN, non ritentare loader().
  await assert.rejects(() => engine.prepare(), { code: 'ENGINE_COOLDOWN' });
  assert.equal(attempt, 1, 'durante il cooldown il loader non deve essere richiamato');
  await new Promise(resolve => setTimeout(resolve, 15));
  const preparePromise = engine.prepare();
  assert.equal(engine.executionMode, 'WORKER_RESTARTING', 'il tentativo dopo il cooldown deve segnalarsi come riavvio');
  await preparePromise;
  assert.equal(attempt, 2);
});

await asyncTest('timeout esplicito (bounded) -> workerTimeoutCount incrementato oltre a workerRestartCount', async () => {
  const engine = new PaddleOcrEngine({
    loader: async () => ({ PaddleOCR: { create: async ({ worker }) => { worker.createWorker(); return { predict: () => new Promise(() => {}) }; } } }), // mai risolve
    workerUrl: async () => 'blob:fake',
    WorkerClass: class { terminate() {} },
    recognizeTimeoutMs: 20
  });
  await assert.rejects(() => engine.recognize(fakeCanvas()), /OCR troppo lento/);
  assert.equal(engine.workerTimeoutCount, 1);
  assert.equal(engine.workerRestartCount, 1, 'un timeout è anche un fallimento (reset del motore), va contato in entrambi');
});

await asyncTest('un recognize() fallito non arma il cooldown: il tentativo successivo riparte subito (audit OCR 2026-09-17)', async () => {
  let creations = 0;
  const engine = new PaddleOcrEngine({
    loader: async () => ({ PaddleOCR: { create: async ({ worker }) => { worker.createWorker(); creations++; return { predict: () => creations === 1 ? new Promise(() => {}) : Promise.resolve({ items: [{ text: 'LOB-IT001', score: 0.95 }] }) }; } } }),
    workerUrl: async () => 'blob:fake',
    WorkerClass: class { terminate() {} },
    recognizeTimeoutMs: 5
  });
  await assert.rejects(() => engine.recognize(fakeCanvas()), /OCR troppo lento/);
  // Il circuit breaker (test precedente) è specifico dei fallimenti di
  // prepare() — un worker impallato su UNA lettura non deve impedire alla
  // carta successiva di ripartire con un engine fresh, altrimenti ogni
  // timeout occasionale si tradurrebbe nello stesso stallo che il breaker
  // vuole evitare per la rete, ma qui senza alcuna ragione (nessuna rete
  // coinvolta in recognize()).
  const result = await engine.recognize(fakeCanvas());
  assert.equal(result.text, 'LOB-IT001');
  assert.equal(creations, 2, 'il secondo tentativo deve ricreare l\'engine, non restare bloccato in cooldown');
});

await asyncTest('bounds() gestisce anche il box flat [x1,y1,x2,y2,...] (non solo [[x,y],...]) — audit OCR 2026-09-17', async () => {
  // Prima del fix, bounds() riconosceva solo il formato annidato: con un box
  // flat il clustering restava disabilitato e titolo+codice si fondevano in
  // un unico testo. I due blocchi qui sono verticalmente lontani (title in
  // alto, codice molto più in basso) apposta per far scattare lo split.
  const engine = new PaddleOcrEngine({
    loader: async () => ({ PaddleOCR: { create: async ({ worker }) => { worker.createWorker(); return { predict: async () => ({ items: [
      { text: 'CARD TITLE', poly: [10, 10, 90, 10, 90, 30, 10, 30] },
      { text: 'LOB-IT001', poly: [10, 200, 90, 200, 90, 220, 10, 220] }
    ] }) }; } } }),
    workerUrl: async () => 'blob:fake',
    WorkerClass: class { terminate() {} }
  });
  const result = await engine.recognize(fakeCanvas());
  assert.equal(result.text, 'LOB-IT001', 'il box flat deve permettere di isolare il blocco codice dal titolo, non concatenarli');
});

await asyncTest('timeout separati per primary e fallback recognize (audit OCR 2026-09-17)', async () => {
  const slowPredict = () => new Promise(resolve => setTimeout(() => resolve({ items: [{ text: 'LOB-IT001', score: 0.9 }] }), 15));
  let creations = 0;
  const engine = new PaddleOcrEngine({
    loader: async () => ({ PaddleOCR: { create: async ({ worker }) => { worker.createWorker(); creations++; return { predict: slowPredict }; } } }),
    workerUrl: async () => 'blob:fake',
    WorkerClass: class { terminate() {} },
    recognizeTimeoutMs: 5,
    fallbackRecognizeTimeoutMs: 40
  });
  // Stesso identico predict() (15ms): il primary (5ms) scade, il fallback
  // (40ms) no — le due soglie sono davvero indipendenti, non la stessa
  // riusata sotto un altro nome.
  await assert.rejects(() => engine.recognize(fakeCanvas()), /OCR troppo lento/, 'primary: 5ms non basta per un predict da 15ms');
  const result = await engine.recognize(fakeCanvas(), { isFallback: true });
  assert.equal(result.text, 'LOB-IT001', 'fallback: 40ms basta per lo stesso predict da 15ms');
  assert.equal(creations, 2, 'il fallback riparte da un engine fresh dopo il timeout del primary');
});

// --- ScanTelemetry (via FastScanController.telemetry, non esportata a parte) ---
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
globalThis.window = globalThis.window || { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.document ??= { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; } };
const { FastScanController } = await import('../js/fast-scan.js');

function makeController() {
  return new FastScanController({ camera: { focusSupported: false, refocus: async () => false }, ocr: {}, getCollection: () => ({ mine: [], team: [] }), isOnline: () => true, onRender: () => {}, onRoute: () => {} });
}

test('ScanTelemetry.summary(): p50/p95, tassi accepted/review/not_found/duplicate/fallback coerenti con i campioni', () => {
  const controller = makeController();
  const base = { cycleStart: 0, sampleMs: 1, snapshotMs: 1, primaryPreprocessMs: 1, primaryOcrMs: 10, primaryResolveMs: 1, fallbackPreprocessMs: 0, fallbackOcrMs: 0, fallbackResolveMs: 0, externalLookupMs: 0, parseMs: 1, commitMs: 1, fallbackUsed: false, secondPassUsed: false, duplicate: false, executionMode: 'WORKER', cacheState: 'READY', workerTimeoutCount: 0, workerRestartCount: 0 };
  const samples = [
    { ...base, cycleTotalMs: 100, readyNextMs: 100, scannerLockedMs: 100, localMatchMs: 1, result: 'accepted', totalFinalizeMs: 100 },
    { ...base, cycleTotalMs: 200, readyNextMs: 200, scannerLockedMs: 200, localMatchMs: 1, result: 'accepted', totalFinalizeMs: 200 },
    { ...base, cycleTotalMs: 300, readyNextMs: 300, scannerLockedMs: 300, localMatchMs: 1, result: 'review', fallbackUsed: true, secondPassUsed: true, totalFinalizeMs: 300 },
    { ...base, cycleTotalMs: 400, readyNextMs: 400, scannerLockedMs: 400, localMatchMs: 1, result: 'not_found', duplicate: true, totalFinalizeMs: 400 }
  ];
  for (const sample of samples) controller.telemetry.record(sample);
  const summary = controller.telemetry.summary();
  assert.equal(summary.count, 4);
  assert.equal(summary.acceptedRate, 0.5);
  assert.equal(summary.reviewRate, 0.25);
  assert.equal(summary.notFoundRate, 0.25);
  assert.equal(summary.duplicateRate, 0.25);
  assert.equal(summary.fallbackRate, 0.25);
  assert.equal(summary.executionMode, 'WORKER', 'legge dall\'ULTIMO campione, lo stato più recente della sessione');
  assert.equal(summary.cacheState, 'READY');
  assert(summary.p50Ms >= 200 && summary.p50Ms <= 300);
  assert.equal(summary.p95Ms, 400);
});

test('ScanTelemetry: finestra scorrevole limitata (non cresce senza limite in una sessione lunga)', () => {
  const controller = makeController();
  const sample = { cycleStart: 0, cycleTotalMs: 50, readyNextMs: 50, scannerLockedMs: 50, sampleMs: 0, snapshotMs: 0, primaryPreprocessMs: 0, primaryOcrMs: 0, primaryResolveMs: 0, fallbackPreprocessMs: 0, fallbackOcrMs: 0, fallbackResolveMs: 0, externalLookupMs: 0, parseMs: 0, commitMs: 0, localMatchMs: 0, fallbackUsed: false, secondPassUsed: false, duplicate: false, result: 'accepted', executionMode: 'WORKER', cacheState: 'READY', workerTimeoutCount: 0, workerRestartCount: 0, totalFinalizeMs: 50 };
  for (let i = 0; i < 250; i += 1) controller.telemetry.record({ ...sample });
  assert(controller.telemetry.samples.length <= 100, 'la finestra di telemetria deve restare limitata');
});

test('ScanTelemetry.recordBackground(): p50/p95 separati dai cicli di scatto', () => {
  const controller = makeController();
  for (const ms of [500, 900, 1400, 2200]) controller.telemetry.recordBackground(ms);
  controller.telemetry.record({ cycleStart: 0, cycleTotalMs: 80, readyNextMs: 80, scannerLockedMs: 80, sampleMs: 0, snapshotMs: 0, primaryPreprocessMs: 0, primaryOcrMs: 0, primaryResolveMs: 0, fallbackPreprocessMs: 0, fallbackOcrMs: 0, fallbackResolveMs: 0, externalLookupMs: 0, parseMs: 0, commitMs: 0, localMatchMs: 0, fallbackUsed: false, secondPassUsed: false, duplicate: false, result: 'accepted', executionMode: 'WORKER', cacheState: 'READY', workerTimeoutCount: 0, workerRestartCount: 0, totalFinalizeMs: 80 });
  const summary = controller.telemetry.summary();
  assert.equal(summary.backgroundVerificationCount, 4);
  assert(summary.backgroundVerificationP50Ms > 0);
  assert(summary.backgroundVerificationP95Ms >= summary.backgroundVerificationP50Ms);
});

test('ScanTelemetry.toJSON()/toCSV(): forma corretta, nessun invio remoto (solo Blob locale)', () => {
  const controller = makeController();
  const sample = { cycleStart: 0, cycleTotalMs: 80, readyNextMs: 80, scannerLockedMs: 80, sampleMs: 0, snapshotMs: 0, primaryPreprocessMs: 0, primaryOcrMs: 0, primaryResolveMs: 0, fallbackPreprocessMs: 0, fallbackOcrMs: 0, fallbackResolveMs: 0, externalLookupMs: 0, parseMs: 0, commitMs: 0, localMatchMs: 0, fallbackUsed: false, secondPassUsed: false, duplicate: false, result: 'accepted', executionMode: 'WORKER', cacheState: 'READY', workerTimeoutCount: 0, workerRestartCount: 0, totalFinalizeMs: 80 };
  controller.telemetry.record(sample);
  const json = controller.telemetry.toJSON();
  assert.equal(typeof json.exportedAt, 'string');
  assert.equal(json.samples.length, 1);
  assert.equal(json.summary.count, 1);
  const csv = controller.telemetry.toCSV();
  const lines = csv.split('\n');
  assert.equal(lines.length, 2, 'header + una riga');
  assert(lines[0].includes('cycleTotalMs') && lines[0].includes('executionMode') && lines[0].includes('cacheState'));
});

// --- syncCatalogIndex: il flag `complete` passa da record a onRows senza essere ricalcolato ---
const { syncCatalogIndex } = await import('../js/fast-scan-catalog-cache.js');
await asyncTest('syncCatalogIndex: onRows riceve complete=true quando la sincronizzazione arriva in fondo', async () => {
  let seenComplete;
  const api = { listCatalogPrintingsIndex: async (game, lastId) => (lastId ? [] : [{ printing_id: 'p1', game: 'yugioh', catalog_card_id: '1', card_name: 'Card', set_code: 'ABC-001' }]) };
  await syncCatalogIndex(api, `game-${Math.random()}`, { onRows: (rows, complete) => { seenComplete = complete; } });
  assert.equal(seenComplete, true);
});
await asyncTest('syncCatalogIndex: un fetch fallito non chiama onRows con dati inventati (nessuna riga, cacheState resta gestito dal chiamante come STALE)', async () => {
  let called = false;
  const api = { listCatalogPrintingsIndex: async () => { throw new Error('rete assente'); } };
  const record = await syncCatalogIndex(api, `game-fail-${Math.random()}`, { onRows: () => { called = true; } });
  assert.equal(called, false, 'senza cache locale pregressa, un fetch fallito non deve pubblicare nulla');
  assert.equal(record.complete, false);
});

// --- Verifiche statiche: campi/strumentazione presenti nel codice reale ---
{
  const fastScanSource = fs.readFileSync(new URL('../js/fast-scan.js', import.meta.url), 'utf8');
  const engineSource = fs.readFileSync(new URL('../js/fast-scan-ocr-engine-b.js', import.meta.url), 'utf8');

  test('fast-scan.js: tutti i campi richiesti dalla roadmap sono presenti nel campione di telemetria', () => {
    for (const field of ['sampleMs', 'snapshotMs', 'primaryPreprocessMs', 'primaryOcrMs', 'parseMs', 'localMatchMs', 'readyNextMs', 'scannerLockedMs', 'externalLookupMs', 'totalFinalizeMs', 'fallbackUsed', 'secondPassUsed', 'executionMode', 'cacheState', 'result', 'duplicate', 'workerTimeoutCount', 'workerRestartCount']) {
      assert(fastScanSource.includes(field), `campo di telemetria mancante nel sorgente: ${field}`);
    }
  });
  test('fast-scan.js: backgroundVerificationMs misurato separatamente (resolvePendingInBackground + recordBackground)', () => {
    assert.match(fastScanSource, /recordBackground\(now\(\)-startedAt\)/);
    assert.match(fastScanSource, /backgroundVerificationP50Ms|backgroundVerificationCount/);
  });
  test('fast-scan.js: cacheState alimentato da LOADING/READY/PARTIAL/STALE, mai da uno stato inventato senza un evento reale', () => {
    assert.match(fastScanSource, /this\.cacheState='LOADING'/);
    assert.match(fastScanSource, /this\.cacheState=complete\?'READY':'PARTIAL'/);
    assert.match(fastScanSource, /this\.cacheState='STALE'/);
  });
  test('fast-scan.js: esportazione telemetria JSON/CSV disponibile solo in debug (mai inviata a Supabase)', () => {
    assert.match(fastScanSource, /exportTelemetry\(format='json'\)/);
    assert.match(fastScanSource, /Mai inviato a Supabase/);
  });
  test('fast-scan-ocr-engine-b.js: executionMode/workerTimeoutCount/workerRestartCount esposti sull\'istanza', () => {
    for (const field of ['executionMode', 'workerTimeoutCount', 'workerRestartCount']) assert(engineSource.includes(field), `campo mancante: ${field}`);
    assert.match(engineSource, /'WORKER_RESTARTING'/);
    assert.match(engineSource, /'WORKER_FAILED'/);
    assert.match(engineSource, /'MAIN_THREAD_FALLBACK'/);
  });
  console.log('statico: tutti i campi richiesti presenti (captureMs~sampleMs/preprocessMs/ocrMs/parseMs/localMatchMs/readyNextMs/scannerLockedMs/backgroundVerificationMs/totalFinalizeMs/fallbackUsed/secondPassUsed/executionMode/cacheState/result/duplicate/worker timeout+restart), export JSON/CSV solo locale');
}

console.log('PASS Fast Scan — strumentazione debug: executionMode/worker counters, ScanTelemetry (summary/finestra/background/export), syncCatalogIndex complete passthrough, campi richiesti presenti nel sorgente');
