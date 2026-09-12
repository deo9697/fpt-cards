// Micro-feature admin: lancio manuale di run_ygo_market_variant_price_shadow()
// dal pannello Market Variant Resolver (js/market-variant-admin.js) su
// printing già resolved/verified. Due parti:
//  A) Browser reale (CDP) per il rendering/binding della nuova sezione
//     "Exact Price Shadow" — stesso harness minimo delle altre CDP smoke di
//     questo pannello.
//  B) Verifiche statiche (nessun browser) sui file sorgente per le garanzie
//     che non si possono osservare a runtime da un model finto: eligibility
//     lato SQL identica a isExactPriceEligible(), nessuna scrittura fuori
//     dalla shadow table, nessuna nuova Edge Function, l'RPC riceve solo
//     printing_id già filtrati server-side.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const readSrc = file => readFile(path.join(root, '..', file), 'utf8');

// --- B) Verifiche statiche -------------------------------------------------
{
  const migration = await readSrc('supabase/migrations/20260912220000_ygo_market_variant_exact_price_eligible_queue.sql');
  const appJs = await readSrc('app.js');
  const apiJs = await readSrc('js/api.js');
  const providers = await readSrc('market/providers.js');

  function test(name, fn) {
    try { fn(); console.log(`PASS ${name}`); }
    catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; }
  }

  test('la nuova RPC replica testualmente isExactPriceEligible() (cardmarket_product_id is not null AND (verified OR resolved))', () => {
    assert.match(providers, /export function isExactPriceEligible/);
    assert.match(migration, /v\.cardmarket_product_id is not null/);
    assert.match(migration, /\(v\.verified or v\.mapping_status = 'resolved'\)/);
  });

  test('la RPC è dichiarata stable (sola lettura) e non scrive mai fuori da un SELECT', () => {
    assert.match(migration, /language plpgsql stable security definer/);
    assert.equal(/\b(insert|update|delete)\s+into?\b/i.test(migration), false, 'la migration non deve contenere alcuna scrittura');
  });

  test('nessun riferimento a pricing live/Market Watch/snapshot/event nella nuova migration (isolamento totale)', () => {
    // collection_items/deck_cards/loans restano fuori da questa lista: sono
    // già letti in sola lettura per il conteggio "usedOnly", stesso pattern
    // di list_ygo_market_variant_review_queue — legittimo, non pricing.
    for (const forbidden of ['market_provider_printings', 'market_price_snapshots', 'market_price_events', 'market_watch_items']) {
      assert.equal(migration.includes(forbidden), false, `la migration non deve toccare ${forbidden}`);
    }
  });

  function extractFunction(source, name) {
    const start = source.indexOf(`async function ${name}`);
    assert.ok(start >= 0, `${name} non trovata in app.js`);
    const next = source.indexOf('\nfunction ', start + 1);
    const nextAsync = source.indexOf('\nasync function ', start + 1);
    const candidates = [next, nextAsync].filter(index => index >= 0);
    const end = candidates.length ? Math.min(...candidates) : source.length;
    return source.slice(start, end);
  }

  test('runMarketVariantExactPriceShadow prende il printingId SOLO da exactPriceQueue (mai dalla coda ambiguous/conflict)', () => {
    const fn = extractFunction(appJs, 'runMarketVariantExactPriceShadow');
    assert.match(fn, /marketVariantState\.exactPriceQueue\.find/);
    assert.equal(/marketVariantState\.queue\.find/.test(fn), false, 'non deve mai leggere dalla coda ambiguous/conflict');
  });

  test('run success ricarica Exact Pricing Coverage (nessun reload completo)', () => {
    const fn = extractFunction(appJs, 'runMarketVariantExactPriceShadow');
    assert.match(fn, /void loadMarketVariantCoverage\(\)/);
  });

  test('nessuna nuova Edge Function: riusa run_ygo_market_variant_price_shadow/get_ygo_market_variant_canary_run già esistenti', () => {
    assert.match(apiJs, /listYgoMarketVariantExactPriceEligible/);
    assert.match(apiJs, /list_ygo_market_variant_exact_price_eligible/);
    // marketVariantExactPriceComparison (riusata, non duplicata) è l'unica a chiamare la RPC di run.
    const listingFn = apiJs.match(/async listYgoMarketVariantExactPriceEligible[\s\S]*?\n  \},/)?.[0];
    assert.ok(listingFn, 'listYgoMarketVariantExactPriceEligible non trovata');
    assert.equal(/functions\/v1\//.test(listingFn), false, 'la lista non deve invocare direttamente nessuna Edge Function');
    assert.equal(/SERVICE_ROLE|service_role/i.test(listingFn), false, 'mai service role dal browser');
  });

  console.log('market variant exact price shadow panel (statico): eligibility identica, sola lettura, isolamento pricing live, nessuna nuova Edge Function');
}

// --- A) Browser reale (rendering/binding) -----------------------------------
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-variant-shadow-smoke-')), port = 9374;
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
      refreshingMetadata: new Set(), candidateMetadata: new Map(), setTemplates: [],
      // Coda ambiguous "normale": NON deve mai mostrare il bottone Exact Price Shadow.
      queue: [
        { printingId:'p-ambiguous', cardName:'Lightning Storm', setCode:'RA01-EN061', setName:'Rarity Collection', rarity:'Super Rare', rarityCanonical:'SUPER_RARE',
          mappingStatus:'ambiguous', resolutionReason:'multiple_candidates_no_rarity_signal',
          candidateProductIds:['111','222','333'], collectionUsage:2, deckUsage:1, loanUsage:0 }
      ],
      // Elenco eleggibile Exact Price Shadow: 4 stati reali distinti (same/
      // close/different/exact_missing) + un running per il bottone disabilitato.
      exactPriceLoading:false, exactPriceError:'', exactPriceHasMore:false,
      exactPriceRunning: new Set(['p-running']),
      exactPriceSummary: { printingCount:3, exactAvailable:3, same:1, close:1, different:1, exactMissing:0, legacyMissing:0 },
      exactPriceQueue: [
        { printingId:'p-resolved-same', cardName:'Fulmine Tempesta', setCode:'RA01-EN061', setName:'Rarity Collection', rarity:'Super Rare',
          mappingStatus:'resolved', mappingSource:'verified_set_template', verified:false, cardmarketProductId:'741693',
          collectionUsage:1, deckUsage:0, loanUsage:0,
          legacyPrice:12.5, exactPrice:12.5, priceType:'trend', absoluteDelta:0, percentageDelta:0, comparisonStatus:'same' },
        { printingId:'p-verified-close', cardName:'Lightning Storm', setCode:'RA01-EN061', setName:'Rarity Collection', rarity:'Ultra Rare',
          mappingStatus:'verified', mappingSource:'manual', verified:true, cardmarketProductId:'741694',
          collectionUsage:0, deckUsage:1, loanUsage:0,
          legacyPrice:20, exactPrice:20.8, priceType:'trend', absoluteDelta:0.8, percentageDelta:4, comparisonStatus:'close' },
        { printingId:'p-running', cardName:'Garura, Wings of Resonant Life', setCode:'RA02-EN024', setName:'Rarity Collection II', rarity:'Ultra Rare',
          mappingStatus:'resolved', mappingSource:'verified_set_template', verified:false, cardmarketProductId:'769782',
          collectionUsage:0, deckUsage:0, loanUsage:0,
          legacyPrice:8, exactPrice:15, priceType:'trend', absoluteDelta:7, percentageDelta:87.5, comparisonStatus:'different' },
        { printingId:'p-exact-missing', cardName:'Placeholder Card', setCode:'RA02-EN024', setName:'Rarity Collection II', rarity:'Secret Rare',
          mappingStatus:'resolved', mappingSource:'resolver', verified:false, cardmarketProductId:'769999',
          collectionUsage:0, deckUsage:0, loanUsage:0,
          legacyPrice:9.5, exactPrice:null, priceType:null, absoluteDelta:null, percentageDelta:null, comparisonStatus:'exact_missing' }
      ]
    };
    window.__render = () => { document.querySelector('#app').innerHTML = renderMarketVariantPage(window.__model); window.__bind(); };
    window.__bind = () => bindMarketVariantPage(document, window.__model, {
      onSelectCandidate: () => {}, onConfirm: () => {}, onLoadMore: () => {},
      onFilterChange: () => {}, onRefreshMetadata: () => {},
      onRunExactPriceShadow: printingId => window.__calls.push(['runExactPrice', printingId]),
      onLoadMoreExactPrice: () => window.__calls.push(['loadMoreExactPrice'])
    });
    window.__render();
  })()`);

  // 1) Bottone visibile e abilitato su resolved (p-resolved-same) e verified (p-verified-close).
  const buttons = await evaluate(`(()=>{
    const byId = id => document.querySelector('[data-variant-exact-price-card="'+id+'"] [data-variant-run-exact-price]');
    return {
      resolvedPresent: !!byId('p-resolved-same'), resolvedDisabled: byId('p-resolved-same')?.disabled,
      verifiedPresent: !!byId('p-verified-close'), verifiedDisabled: byId('p-verified-close')?.disabled,
      runningDisabled: byId('p-running')?.disabled, runningText: byId('p-running')?.textContent
    };
  })()`);
  if (!buttons.resolvedPresent || buttons.resolvedDisabled) throw Error('Bottone assente/disabilitato su riga resolved: ' + JSON.stringify(buttons));
  if (!buttons.verifiedPresent || buttons.verifiedDisabled) throw Error('Bottone assente/disabilitato su riga verified: ' + JSON.stringify(buttons));
  if (!buttons.runningDisabled || !buttons.runningText.includes('in corso')) throw Error('Riga in corso deve mostrare "Confronto prezzi in corso…" disabilitato: ' + JSON.stringify(buttons));

  // 2) La coda ambiguous/conflict "normale" non deve MAI mostrare questo bottone.
  const ambiguousHasButton = await evaluate(`!!document.querySelector('[data-admin-variant-card="p-ambiguous"] [data-variant-run-exact-price]')`);
  if (ambiguousHasButton) throw Error('La coda ambiguous non deve mai mostrare "Confronta prezzo esatto"');

  // 3) Click sul bottone chiama l'handler col printingId giusto.
  await evaluate(`document.querySelector('[data-variant-exact-price-card="p-resolved-same"] [data-variant-run-exact-price]').click()`);
  const calls = await evaluate('window.__calls');
  if (!calls.some(c => c[0] === 'runExactPrice' && c[1] === 'p-resolved-same')) throw Error('onRunExactPriceShadow non chiamato col printingId giusto: ' + JSON.stringify(calls));

  // 4) Risultati per riga: same/close/different renderizzati coi campi giusti, exact_missing gestito senza crash.
  const results = await evaluate(`(()=>{
    const text = id => document.querySelector('[data-variant-exact-price-card="'+id+'"] .admin-variant-shadow-result').textContent;
    const status = id => document.querySelector('[data-variant-exact-price-card="'+id+'"] .admin-variant-shadow-result .admin-variant-badge').className;
    return {
      same: { text: text('p-resolved-same'), status: status('p-resolved-same') },
      close: { text: text('p-verified-close'), status: status('p-verified-close') },
      different: { text: text('p-running'), status: status('p-running') },
      exactMissing: { text: text('p-exact-missing'), status: status('p-exact-missing') }
    };
  })()`);
  if (!results.same.text.includes('€12.50') || !results.same.status.includes('is-same')) throw Error('Riga SAME renderizzata male: ' + JSON.stringify(results.same));
  if (!results.close.text.includes('€20.80') || !results.close.status.includes('is-close')) throw Error('Riga CLOSE renderizzata male: ' + JSON.stringify(results.close));
  if (!results.different.text.includes('€15.00') || !results.different.status.includes('is-different')) throw Error('Riga DIFFERENT renderizzata male: ' + JSON.stringify(results.different));
  if (!results.exactMissing.text.includes('non disponibile') || !results.exactMissing.status.includes('is-exact_missing')) throw Error('Riga exact_missing deve mostrare "non disponibile", mai un crash/NaN: ' + JSON.stringify(results.exactMissing));
  if (results.exactMissing.text.includes('NaN') || results.exactMissing.text.includes('undefined')) throw Error('exact_missing ha renderizzato un valore inventato: ' + JSON.stringify(results.exactMissing));

  // 5) Riepilogo run: usa ESATTAMENTE i campi passati (nessun numero inventato).
  const summaryText = await evaluate(`document.querySelector('.admin-variant-shadow-summary').textContent`);
  for (const expected of ['3', '1', '0']) if (!summaryText.includes(expected)) throw Error('Riepilogo run incompleto: ' + summaryText);
  if (!summaryText.includes('Printing elaborate') || !summaryText.includes('Exact disponibili') || !summaryText.includes('Same') || !summaryText.includes('Close') || !summaryText.includes('Different')) throw Error('Riepilogo run manca di una etichetta attesa: ' + summaryText);

  // 6) Load more della sezione Exact Price Shadow chiama il proprio handler (non quello della coda ambiguous).
  await evaluate(`window.__model.exactPriceHasMore = true; window.__render();`);
  await evaluate(`document.querySelector('[data-variant-exact-price-load-more]').click()`);
  const callsAfterLoadMore = await evaluate('window.__calls');
  if (!callsAfterLoadMore.some(c => c[0] === 'loadMoreExactPrice')) throw Error('onLoadMoreExactPrice non chiamato');

  if ((await evaluate('window.__consoleErrors')).length) throw Error('Browser errors: ' + JSON.stringify(await evaluate('window.__consoleErrors')));
  console.log('PASS market variant exact price shadow panel (browser): bottone su resolved/verified, mai su ambiguous, stato in-corso, same/close/different/exact_missing renderizzati senza crash, riepilogo run coi campi reali, load-more isolato');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
