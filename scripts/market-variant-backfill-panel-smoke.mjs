// Backfill mirato RA01/RA02 in uso — pannello Market Variant Resolver. Due
// parti, stesso stile di market-variant-exact-price-shadow-panel-smoke.mjs:
//  A) Verifiche statiche sulla nuova discovery RPC (whitelist dai template
//     verified, usage count-distinct per canale, nessuna scrittura/pricing)
//     e sull'orchestrazione in app.js (batch di 20, riuso del canary
//     esistente, nessun auto-run al caricamento pagina, refresh delle
//     sezioni diagnostiche dopo il backfill).
//  B) Browser reale (CDP) per DISCOVER -> preview -> BACKFILL separati: mai
//     un discovery+write nello stesso click, conteggi/tabella/report
//     renderizzati coi soli campi reali.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const readSrc = file => readFile(path.join(root, '..', file), 'utf8');

// --- A) Verifiche statiche -------------------------------------------------
{
  const migration = await readSrc('supabase/migrations/20260912230000_ygo_market_variant_backfill_candidates.sql');
  const appJs = await readSrc('app.js');

  function test(name, fn) {
    try { fn(); console.log(`PASS ${name}`); }
    catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; }
  }

  test('la whitelist dei set_prefix viene SOLO da template verified=true, mai da un pattern (niente RA%/startsWith/left)', () => {
    assert.match(migration, /from public\.ygo_market_variant_set_templates t\s*\n\s*where t\.verified/);
    // Solo pattern SQL funzionali vietati (non il testo dei commenti che
    // spiegano perché NON si deve fare così).
    for (const forbidden of [/'RA%'/, /left\(cp\.set_code/i, /like\s+'ra/i]) {
      assert.equal(forbidden.test(migration), false, `pattern vietato trovato: ${forbidden}`);
    }
  });

  test('default p_set_prefixes copre RA01 e RA02', () => {
    assert.match(migration, /p_set_prefixes text\[\] default array\['RA01', 'RA02'\]/);
  });

  test('usage_count è count(distinct ...) per ciascun canale, CTE separate (mai una moltiplicazione cartesiana da JOIN diretto)', () => {
    for (const table of ['collection_items ci', 'deck_cards dc', 'loans l', 'market_watch_items mw']) {
      assert.match(migration, new RegExp(`left join public\\.${table.split(' ')[0]} ${table.split(' ')[1]}`));
    }
    assert.match(migration, /count\(distinct ci\.id\)/);
    assert.match(migration, /count\(distinct dc\.id\)/);
    assert.match(migration, /count\(distinct l\.id\)/);
    assert.match(migration, /count\(distinct mw\.id\)/);
  });

  test('esclude SOLO printing già resolved/verified: risultato limitato a nessuna riga o ambiguous/unresolved/conflict', () => {
    assert.match(migration, /where v\.printing_id is null or v\.mapping_status in \('ambiguous', 'unresolved', 'conflict'\)/);
  });

  test('la RPC è dichiarata stable (sola lettura) e non scrive mai fuori da un SELECT', () => {
    assert.match(migration, /language plpgsql stable security definer/);
    assert.equal(/\b(insert|update|delete)\s+into?\b/i.test(migration), false, 'la migration non deve contenere alcuna scrittura');
  });

  test('nessun riferimento a pricing live/Market Watch prezzi/snapshot/event nella nuova migration', () => {
    for (const forbidden of ['market_price_snapshots', 'market_price_events', 'market_provider_printings']) {
      assert.equal(migration.includes(forbidden), false, `la migration non deve toccare ${forbidden}`);
    }
    // market_watch_items compare SOLO per il conteggio d'uso (sola lettura),
    // mai per leggere/scrivere un prezzo: nessuna colonna prezzo referenziata.
    assert.equal(/market_watch_items[^;]*price/is.test(migration), false);
  });

  test('nessun pg_cron/schedule nella migration: solo una RPC on-demand', () => {
    assert.equal(/cron\.schedule|pg_cron/i.test(migration), false);
  });

  function extractFunction(source, name) {
    const start = source.indexOf(`async function ${name}`);
    assert.ok(start >= 0, `${name} non trovata in app.js`);
    const nextFn = source.indexOf('\nfunction ', start + 1);
    const nextAsyncFn = source.indexOf('\nasync function ', start + 1);
    const candidates = [nextFn, nextAsyncFn].filter(index => index >= 0);
    const end = candidates.length ? Math.min(...candidates) : source.length;
    return source.slice(start, end);
  }

  test('il backfill riusa api.marketVariantCanary esistente (nessun secondo resolver/nessuna nuova Edge Function)', () => {
    const fn = extractFunction(appJs, 'runMarketVariantBackfill');
    assert.match(fn, /api\.marketVariantCanary\(batch\)/);
    assert.equal(/marketVariantExactPriceComparison|runYgoMarketVariantPriceShadow|resolveYgoMarketVariant\(/.test(fn), false, 'il backfill non deve chiamare direttamente il resolver, solo il canary già esistente');
  });

  test('batch massimo 20 printing per run (nessun mega batch)', () => {
    assert.match(appJs, /const MARKET_VARIANT_BACKFILL_BATCH_SIZE = 20;/);
    const fn = extractFunction(appJs, 'runMarketVariantBackfill');
    assert.match(fn, /index \+= MARKET_VARIANT_BACKFILL_BATCH_SIZE/);
  });

  test('un batch fallito/timeout non blocca gli altri e viene contato come errors, mai silenziosamente ignorato', () => {
    const fn = extractFunction(appJs, 'runMarketVariantBackfill');
    assert.match(fn, /errorCount \+= batch\.length/);
    assert.match(fn, /report\.errors = errorCount/);
  });

  test('a fine backfill: refresh di Exact Pricing Coverage e dell\'elenco Exact Price Shadow, MAI un lancio automatico del confronto prezzi', () => {
    const fn = extractFunction(appJs, 'runMarketVariantBackfill');
    assert.match(fn, /void loadMarketVariantCoverage\(\)/);
    assert.match(fn, /void loadMarketVariantExactPriceEligible\(true\)/);
    assert.equal(/marketVariantExactPriceComparison/.test(fn), false, 'il bottone Exact Price Shadow resta separato, mai chiamato automaticamente qui');
  });

  test('discovery e backfill sono due funzioni distinte: nessuna chiamata automatica al cambio pagina/route', () => {
    assert.match(appJs, /async function discoverMarketVariantBackfillCandidates/);
    assert.match(appJs, /async function runMarketVariantBackfill/);
    // Il solo punto che innesca il caricamento della pagina Market Variant è
    // la route (già esistente, invariata da questo task): non deve chiamare
    // discoverMarketVariantBackfillCandidates/runMarketVariantBackfill.
    const routeLine = appJs.match(/if \(next === 'market-variants'[^\n]*\n/)?.[0] || '';
    assert.equal(/discoverMarketVariantBackfillCandidates|runMarketVariantBackfill/.test(routeLine), false, 'la route non deve innescare discovery/backfill automaticamente');
  });

  console.log('market variant backfill panel (statico): whitelist da dati non da pattern, usage count-distinct corretto, esclusione resolved/verified, sola lettura, batch<=20, errori isolati per batch, refresh diagnostico senza auto-run prezzi, nessun auto-trigger a caricamento pagina');
}

// --- B) Browser reale (rendering/binding) -----------------------------------
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-variant-backfill-smoke-')), port = 9375;
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
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/collection-share-harness.html' });
  await delay(500);
  await evaluate(`window.__consoleErrors = []; window.addEventListener('error', e => window.__consoleErrors.push(String(e.message)));`);

  await evaluate(`(async()=>{
    const {renderMarketVariantPage, bindMarketVariantPage} = await import('/js/market-variant-admin.js');
    document.head.insertAdjacentHTML('afterbegin','<base href="/">');
    window.__calls = [];
    window.__model = {
      loading:false, error:'',
      selections: new Map(), filters: { query:'', usedOnly:true }, hasMore:false,
      refreshingMetadata: new Set(), candidateMetadata: new Map(), setTemplates: [], queue: [],
      exactPriceLoading:false, exactPriceError:'', exactPriceHasMore:false,
      exactPriceRunning: new Set(), exactPriceSummary:null, exactPriceQueue: [],
      // Backfill: PRIMA del discover, nessuna sezione/preview/report visibile.
      backfillDiscovered:false, backfillLoading:false, backfillError:'', backfillRunning:false,
      backfillReport:null, backfillCandidates: []
    };
    window.__render = () => { document.querySelector('#app').innerHTML = renderMarketVariantPage(window.__model); window.__bind(); };
    window.__bind = () => bindMarketVariantPage(document, window.__model, {
      onSelectCandidate: () => {}, onConfirm: () => {}, onLoadMore: () => {},
      onFilterChange: () => {}, onRefreshMetadata: () => {},
      onRunExactPriceShadow: () => {}, onLoadMoreExactPrice: () => {},
      onDiscoverBackfill: () => window.__calls.push(['discoverBackfill']),
      onRunBackfill: () => window.__calls.push(['runBackfill'])
    });
    window.__render();
  })()`);

  // 1) Prima del discover: solo il bottone "Analizza printing in uso",
  //    nessuna preview/tabella/report/bottone backfill (mai discovery+write
  //    nello stesso click, e qui nemmeno la preview esiste ancora).
  const beforeDiscover = await evaluate(`(()=>{
    return {
      discoverButton: !!document.querySelector('[data-variant-backfill-discover]'),
      runButton: !!document.querySelector('[data-variant-backfill-run]'),
      table: !!document.querySelector('.admin-variant-backfill-table'),
      summary: !!document.querySelector('.admin-variant-backfill-section .admin-variant-shadow-summary')
    };
  })()`);
  if (!beforeDiscover.discoverButton) throw Error('Manca il bottone "Analizza printing in uso"');
  if (beforeDiscover.runButton) throw Error('Il bottone di backfill non deve comparire prima del discover');
  if (beforeDiscover.table || beforeDiscover.summary) throw Error('Nessuna preview/summary prima del discover: ' + JSON.stringify(beforeDiscover));

  // 2) Click su "Analizza printing in uso" chiama SOLO onDiscoverBackfill
  //    (mai onRunBackfill nello stesso click).
  await evaluate(`document.querySelector('[data-variant-backfill-discover]').click()`);
  const afterDiscoverClick = await evaluate('window.__calls');
  if (!afterDiscoverClick.some(c => c[0] === 'discoverBackfill')) throw Error('onDiscoverBackfill non chiamato');
  if (afterDiscoverClick.some(c => c[0] === 'runBackfill')) throw Error('onRunBackfill non deve mai scattare dal click di discover');

  // 3) Simula il risultato della discovery (come farebbe app.js dopo la RPC):
  //    conteggi/preview/bottone backfill compaiono coi campi giusti.
  await evaluate(`(()=>{
    window.__model.backfillDiscovered = true;
    window.__model.backfillCandidates = [
      { printingId:'p-resolvable', cardName:'Fulmine Tempesta', setCode:'RA01-EN061', rarity:'Super Rare', usageCount:3, registryExists:true, mappingStatus:'ambiguous', expectedAction:'resolve_set_template', templateMatch:{ variantNumber:1, productId:'741693', setPrefix:'RA01', rarityCanonical:'SUPER_RARE' } },
      { printingId:'p-analyze', cardName:'Placeholder Card', setCode:'RA02-EN024', rarity:'Ultra Rare', usageCount:1, registryExists:false, mappingStatus:null, expectedAction:'run_resolver', templateMatch:null },
      { printingId:'p-ambiguous', cardName:'Garura, Wings of Resonant Life', setCode:'RA02-EN024', rarity:'Secret Rare', usageCount:2, registryExists:true, mappingStatus:'ambiguous', expectedAction:'remain_ambiguous', templateMatch:null },
      { printingId:'p-skip', cardName:'Should Not Appear', setCode:'RA01-EN061', rarity:'Collector\\'s Rare', usageCount:5, registryExists:true, mappingStatus:'resolved', expectedAction:'skip_already_resolved', templateMatch:null }
    ];
    window.__render();
  })()`);
  const afterDiscover = await evaluate(`(()=>{
    const dd = [...document.querySelectorAll('.admin-variant-backfill-section .admin-variant-shadow-summary dd')].map(d => d.textContent);
    const rows = [...document.querySelectorAll('.admin-variant-backfill-table tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent));
    return { counts: dd, rows, runButtonPresent: !!document.querySelector('[data-variant-backfill-run]') };
  })()`);
  if (JSON.stringify(afterDiscover.counts) !== JSON.stringify(['4', '1', '1', '1', '1'])) throw Error('Conteggi preview errati (trovate/già risolte/da analizzare/ambigue/template-resolvable): ' + JSON.stringify(afterDiscover.counts));
  if (!afterDiscover.runButtonPresent) throw Error('Il bottone "Esegui backfill shadow" deve comparire dopo il discover con candidati');
  const resolvableRow = afterDiscover.rows.find(row => row[0] === 'Fulmine Tempesta');
  if (!resolvableRow || !resolvableRow[5].includes('V.1')) throw Error('Riga template-resolvable deve mostrare "Sì (V.1)": ' + JSON.stringify(resolvableRow));
  const analyzeRow = afterDiscover.rows.find(row => row[0] === 'Placeholder Card');
  if (!analyzeRow || analyzeRow[4] !== 'Nessuna riga' || !analyzeRow[5].includes('analizzare')) throw Error('Riga run_resolver senza registry deve mostrare "Nessuna riga"/"Da analizzare": ' + JSON.stringify(analyzeRow));

  // 4) Click su "Esegui backfill shadow" chiama SOLO onRunBackfill.
  await evaluate(`document.querySelector('[data-variant-backfill-run]').click()`);
  const afterRunClick = await evaluate('window.__calls');
  if (!afterRunClick.some(c => c[0] === 'runBackfill')) throw Error('onRunBackfill non chiamato');

  // 5) Report finale: usa SOLO i campi reali del report (nessun numero inventato).
  await evaluate(`(()=>{
    window.__model.backfillRunning = false;
    window.__model.backfillReport = { processed:4, already_resolved:1, resolved_set_template:1, resolved_other:0, ambiguous:1, conflict:0, unresolved:1, errors:0, changed:[] };
    window.__render();
  })()`);
  const reportText = await evaluate(`(()=>{ const boxes = [...document.querySelectorAll('.admin-variant-backfill-section .admin-variant-shadow-summary')]; return boxes[boxes.length - 1]?.textContent || ''; })()`);
  for (const label of ['Processed', 'Already resolved', 'Set template', 'Resolved other', 'Ambiguous', 'Conflict', 'Unresolved', 'Errors']) {
    if (!reportText.includes(label)) throw Error(`Report finale manca l'etichetta "${label}": ` + reportText);
  }
  if (!reportText.includes('4') || !reportText.includes('1')) throw Error('Report finale non usa i valori reali passati: ' + reportText);

  if ((await evaluate('window.__consoleErrors')).length) throw Error('Browser errors: ' + JSON.stringify(await evaluate('window.__consoleErrors')));
  console.log('PASS market variant backfill panel (browser): nessuna preview prima del discover, discover e backfill sono due click distinti, conteggi/tabella coi campi reali (Nessuna riga, Sì (V.n)), report finale coi soli campi restituiti');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
