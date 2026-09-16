// Fast Scan caso 4 — riconciliazione post-save di printing_mapping_status
// unresolved/conflict (js/ygo-printing-mapping-reconciliation.js,
// supabase/migrations/20260917100000_ygo_printing_mapping_reconciliation_queue.sql).
// Copre: solo 'unresolved' viene passato al resolver (mai 'conflict'),
// conteggio corretto di resolved/stillUnresolved/conflicts, coda vuota ->
// nessuna chiamata al resolver, coda non disponibile -> nessun throw. Più
// asserzioni statiche sulla migration e sul wiring in app.js (nessun accesso
// a un Postgres reale in questa sessione, stesso metodo di oggi).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// js/ygo-printing-mapping-reconciliation.js importa (per il default resolve)
// js/ygo-printing-registry.js, che importa js/api.js — legge window.FPT_CONFIG
// a livello di modulo. Stesso shim minimo già usato da fast-scan-milestone-
// smoke.mjs/collection-share-guest-smoke.mjs per girare sotto plain node.
globalThis.window ??= { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { reconcileYgoPrintingMappings, PRINTING_MAPPING_RECONCILIATION_BATCH_LIMIT } = await import('../js/ygo-printing-mapping-reconciliation.js');

function test(name, fn) { try { fn(); console.log(`PASS ${name}`); } catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; } }
async function asyncTest(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; } }

// --- 1) Coda vuota -> nessuna chiamata al resolver, stats a zero ----------
await asyncTest('coda vuota: nessuna chiamata al resolver, stats a zero', async () => {
  let resolveCalls = 0;
  const api = { collectionPrintingMappingQueue: async () => [] };
  const stats = await reconcileYgoPrintingMappings({ api, resolve: async () => { resolveCalls++; return new Map(); } });
  assert.equal(resolveCalls, 0);
  assert.deepEqual(stats, { queued: 0, conflicts: 0, resolved: 0, stillUnresolved: 0, unavailable: false });
});

// --- 2) 'conflict' non viene MAI passato al resolver, solo contato --------
await asyncTest('conflict: mai passato al resolver, solo contato in stats.conflicts', async () => {
  let receivedCodes = null;
  const api = { collectionPrintingMappingQueue: async () => [
    { set_code: 'LOB-001', mapping_status: 'conflict' },
    { set_code: 'LOB-002', mapping_status: 'conflict' }
  ] };
  const stats = await reconcileYgoPrintingMappings({ api, resolve: async codes => { receivedCodes = codes; return new Map(); } });
  assert.equal(receivedCodes, null, 'il resolver non deve MAI essere chiamato se tutti gli item sono conflict');
  assert.equal(stats.conflicts, 2);
  assert.equal(stats.queued, 2);
  assert.equal(stats.resolved, 0);
  assert.equal(stats.stillUnresolved, 0);
});

// --- 3) 'unresolved' passato al resolver, conflict escluso dal payload ----
await asyncTest('mix unresolved/conflict: solo gli unresolved finiscono nel payload del resolver', async () => {
  let receivedCodes = null;
  const api = { collectionPrintingMappingQueue: async () => [
    { set_code: 'LOB-001', mapping_status: 'unresolved' },
    { set_code: 'LOB-002', mapping_status: 'conflict' },
    { set_code: 'LOB-003', mapping_status: 'unresolved' }
  ] };
  const stats = await reconcileYgoPrintingMappings({
    api,
    resolve: async codes => {
      receivedCodes = codes;
      return new Map(codes.map(code => [code, { mappingStatus: 'resolved' }]));
    }
  });
  assert.deepEqual(receivedCodes, ['LOB-001', 'LOB-003'], 'solo gli unresolved devono finire nel payload');
  assert.equal(stats.conflicts, 1);
  assert.equal(stats.resolved, 2);
  assert.equal(stats.stillUnresolved, 0);
});

// --- 4) Esito misto resolved/verified/ancora unresolved --------------------
await asyncTest('esito misto: resolved/verified contano come risolti, unresolved/mancante no', async () => {
  const api = { collectionPrintingMappingQueue: async () => [
    { set_code: 'A-001', mapping_status: 'unresolved' },
    { set_code: 'A-002', mapping_status: 'unresolved' },
    { set_code: 'A-003', mapping_status: 'unresolved' },
    { set_code: 'A-004', mapping_status: 'unresolved' }
  ] };
  const outcomes = new Map([
    ['A-001', { mappingStatus: 'resolved' }],
    ['A-002', { mappingStatus: 'verified' }],
    ['A-003', { mappingStatus: 'unresolved' }],
    ['A-004', null]
  ]);
  const stats = await reconcileYgoPrintingMappings({ api, resolve: async () => outcomes });
  assert.equal(stats.resolved, 2, 'resolved + verified');
  assert.equal(stats.stillUnresolved, 2, 'unresolved + risultato mancante/null');
});

// --- 5) camelCase (mappingStatus) supportato oltre a snake_case -----------
await asyncTest('formato camelCase (mappingStatus) supportato oltre a snake_case (mapping_status)', async () => {
  let receivedCodes = null;
  const api = { collectionPrintingMappingQueue: async () => [{ setCode: 'CAML-001', mappingStatus: 'unresolved' }] };
  await reconcileYgoPrintingMappings({ api, resolve: async codes => { receivedCodes = codes; return new Map(); } });
  assert.deepEqual(receivedCodes, ['CAML-001']);
});

// --- 6) Coda non disponibile (RPC assente/errore) -> nessun throw ---------
await asyncTest('coda non disponibile: nessun throw, stats.unavailable=true', async () => {
  const api = { collectionPrintingMappingQueue: async () => { throw new Error('function does not exist'); } };
  const logged = [];
  const stats = await reconcileYgoPrintingMappings({ api, log: entry => logged.push(entry) });
  assert.equal(stats.unavailable, true);
  assert.equal(stats.queued, 0);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].stage, 'queue');
});

// --- 7) Fallimento del resolver (errore rete) -> nessun throw, unavailable=true
await asyncTest('resolver che fallisce: nessun throw, stats.unavailable=true', async () => {
  const api = { collectionPrintingMappingQueue: async () => [{ set_code: 'X-001', mapping_status: 'unresolved' }] };
  const stats = await reconcileYgoPrintingMappings({ api, resolve: async () => { throw new Error('YGOResources non raggiungibile'); } });
  assert.equal(stats.unavailable, true);
});

// --- 8) Limite di default esportato e coerente col batch di catalog_verification (20)
test('limite di default coerente con lo stesso ordine di grandezza del batch catalog_verification (20)', () => {
  assert.equal(PRINTING_MAPPING_RECONCILIATION_BATCH_LIMIT, 20);
});

// --- Verifiche statiche sulla migration -------------------------------------
{
  const root = path.dirname(fileURLToPath(import.meta.url));
  const migration = await readFile(path.join(root, '..', 'supabase', 'migrations', '20260917100000_ygo_printing_mapping_reconciliation_queue.sql'), 'utf8');
  const sqlNoComments = migration.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');

  test('migration: scoped alle sole printing possedute (EXISTS su collection_items.owner_slug)', () => {
    assert.match(sqlNoComments, /exists \(\s*\n\s*select 1 from public\.collection_items ci\s*\n\s*where ci\.printing_id = cp\.id and ci\.owner_slug = me\s*\n\s*\)/);
  });
  test('migration: filtra su unresolved/conflict (mai verified/resolved), gestisce NULL come unresolved', () => {
    assert.match(sqlNoComments, /coalesce\(cp\.printing_mapping_status, 'unresolved'\) in \('unresolved', 'conflict'\)/);
  });
  test('migration: cooldown 24h su printing_mapping_checked_at (throttle, non hammering YGOResources)', () => {
    assert.match(sqlNoComments, /cp\.printing_mapping_checked_at is null or cp\.printing_mapping_checked_at < now\(\) - interval '24 hours'/);
  });
  test('migration: limite clampato server-side (1..50), mai illimitato', () => {
    assert.match(sqlNoComments, /least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
  });
  test('migration: SECURITY DEFINER, SET search_path, REVOKE poi GRANT a anon+authenticated', () => {
    assert.match(sqlNoComments, /security definer set search_path = public, extensions/);
    assert.match(sqlNoComments, /revoke all on function public\.list_collection_printing_mapping_queue\(text, integer\)\s*\n\s*from public, anon, authenticated;/);
    assert.match(sqlNoComments, /grant execute on function public\.list_collection_printing_mapping_queue\(text, integer\)\s*\n\s*to anon, authenticated;/);
  });
  test('migration: notify pgrst reload schema presente', () => {
    assert.match(migration, /notify pgrst, 'reload schema';/);
  });
  test('migration: nessuna scrittura (solo lettura) — la scrittura resta a apply_ygo_printing_mappings, già esistente', () => {
    assert.equal(/\binsert\s+into\b|\bupdate\s+public\.|\bdelete\s+from\b/i.test(sqlNoComments), false);
  });
  test('migration: non tocca la cache locale Fast Scan (nessuna DDL su list_catalog_printings_index, solo menzionata nel commento di scope)', () => {
    assert.equal(/\b(create|drop|alter)\b[^\n]*list_catalog_printings_index/i.test(sqlNoComments), false);
  });
  console.log('migration (statico): scoped a owner via EXISTS, filtro unresolved/conflict con NULL-safety, cooldown 24h, limite clampato, SECURITY DEFINER/search_path/REVOKE-GRANT, notify pgrst, sola lettura, nessun tocco alla cache locale');
}

// --- Verifiche statiche sul wiring app.js -----------------------------------
{
  const root = path.dirname(fileURLToPath(import.meta.url));
  const appJs = await readFile(path.join(root, '..', 'app.js'), 'utf8');

  test('app.js: importa reconcileYgoPrintingMappings dal nuovo modulo', () => {
    assert.match(appJs, /import \{ reconcileYgoPrintingMappings \} from '\.\/js\/ygo-printing-mapping-reconciliation\.js';/);
  });
  test('app.js: la riconciliazione mapping è nel ciclo runCatalogRepairs, accanto alle altre due (collection/loans)', () => {
    const start = appJs.indexOf('async function runCatalogRepairs()');
    const end = appJs.indexOf('catch (error)', start);
    const block = appJs.slice(start, end);
    assert.match(block, /quarantineMismatchedCollectionImages\(\)/);
    assert.match(block, /quarantineMismatchedLoanImages\(\)/);
    assert.match(block, /reconcileYgoPrintingMappingsForCollection\(\)/);
    assert.match(block, /if \(!collectionChanged && !loansChanged && !mappingsChanged\) continue;/);
  });
  test('app.js: reconcileYgoPrintingMappingsForCollection ricarica la collezione SOLO se qualcosa è stato risolto (stats.resolved > 0)', () => {
    const start = appJs.indexOf('async function reconcileYgoPrintingMappingsForCollection()');
    const end = appJs.indexOf('async function runLimited', start);
    const block = appJs.slice(start, end);
    assert.match(block, /if \(stats\.resolved <= 0\) return false;/);
    assert.match(block, /await loadCollection\(\);/);
  });
  test('app.js: Fast Scan onSaved pianifica scheduleCatalogRepairs (vera riconciliazione POST-SAVE, non solo al bootstrap)', () => {
    assert.match(appJs, /onSaved:async\(\)=>\{await loadCollection\(\);saveState\(\);scheduleCatalogRepairs\(\);\}/);
  });
  console.log('app.js (statico): import presente, terza riconciliazione nel ciclo esistente, reload condizionato a stats.resolved>0, Fast Scan onSaved pianifica una riconciliazione post-save reale');
}

console.log('PASS Fast Scan caso 4 (printing_mapping_status unresolved/conflict): riconciliazione post-save owner-scoped, conflict mai auto-ritentato, migration e wiring app.js verificati staticamente');
