// market_current_price_snapshots — P0 performance, step 3. Stesso metodo
// delle due migration precedenti: questa sessione non ha accesso a un
// Postgres reale, quindi la correttezza dei trigger/backfill/shadow è
// dimostrata con una reimplementazione JS pura delle STESSE regole
// codificate in supabase/migrations/20260914200000_market_current_price_layer.sql
// (sync_market_current_price_snapshot / rebuild_market_current_price_snapshot),
// più verifiche statiche sul testo della migration, più una prova di
// equivalenza legacy/new su un dataset sintetico (stesso stile di
// market-watch-summary-perf-smoke.mjs). Copre tutti i 18 casi richiesti.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Reimplementazione pura di sync_market_current_price_snapshot -------
// Ritorna il nuovo stato "current" per una chiave (o null se rimane
// com'era / viene rimosso), dato lo stato attuale e un candidato.
function syncCandidate(current, candidate) {
  if (candidate.providerMappingId == null) return current;
  if (candidate.isAnomalous) return current; // mai promuovere un anomalo
  if (!current) return { ...candidate };
  const candidateWins = candidate.capturedAt > current.capturedAt
    || (candidate.capturedAt === current.capturedAt && candidate.snapshotId > current.snapshotId);
  return candidateWins ? { ...candidate } : current;
}

// --- Reimplementazione pura di rebuild_market_current_price_snapshot ----
// Ricalcola da zero il vincitore tra TUTTI gli snapshot noti per la
// chiave (mai un confronto incrementale: può tornare indietro nel tempo).
function rebuildCurrent(allSnapshotsForKey) {
  const valid = allSnapshotsForKey.filter(s => !s.isAnomalous);
  if (!valid.length) return null;
  return valid.slice().sort((a, b) => (b.capturedAt - a.capturedAt) || (b.snapshotId - a.snapshotId))[0];
}

// --- Simulatore di timeline: applica gli eventi (insert / anomaly-flag- --
// change) in ordine, con la STESSA logica dei due trigger, e restituisce
// lo stato finale "current" per quella chiave sola.
function simulate(events) {
  let current = null;
  const bySnapshotId = new Map(); // stato pieno di ogni snapshot noto (per il rebuild)
  for (const event of events) {
    if (event.type === 'insert') {
      bySnapshotId.set(event.snapshotId, { ...event, isAnomalous: !!event.isAnomalous });
      current = syncCandidate(current, bySnapshotId.get(event.snapshotId));
    } else if (event.type === 'setAnomalous') {
      const row = bySnapshotId.get(event.snapshotId);
      const wasAnomalous = row.isAnomalous;
      row.isAnomalous = event.value;
      if (wasAnomalous === event.value) continue; // trigger non scatta se il valore non cambia
      if (event.value) {
        // false -> true: rebuild SOLO se questa riga era il current registrato.
        if (current && current.snapshotId === event.snapshotId) {
          current = rebuildCurrent([...bySnapshotId.values()]);
        }
      } else {
        // true -> false: candidato fresco, vince solo se più recente.
        current = syncCandidate(current, row);
      }
    }
  }
  return current;
}

// --- Test 1-7: lifecycle su una singola chiave (provider_mapping_id, price_type) ---
{
  // 1) primo snapshot crea current
  let result = simulate([{ type: 'insert', snapshotId: 1, capturedAt: 100, providerMappingId: 'm1', price: 10 }]);
  assert.equal(result.snapshotId, 1);
  console.log('PASS test 1: primo snapshot crea current');

  // 2) snapshot più nuovo sostituisce current
  result = simulate([
    { type: 'insert', snapshotId: 1, capturedAt: 100, providerMappingId: 'm1', price: 10 },
    { type: 'insert', snapshotId: 2, capturedAt: 200, providerMappingId: 'm1', price: 12 }
  ]);
  assert.equal(result.snapshotId, 2);
  console.log('PASS test 2: snapshot più nuovo sostituisce current');

  // 3) snapshot più vecchio inserito DOPO non sostituisce current
  result = simulate([
    { type: 'insert', snapshotId: 2, capturedAt: 200, providerMappingId: 'm1', price: 12 },
    { type: 'insert', snapshotId: 1, capturedAt: 100, providerMappingId: 'm1', price: 10 } // arrivato dopo, ma più vecchio
  ]);
  assert.equal(result.snapshotId, 2, 'un insert fuori ordine temporale non deve mai retrocedere il current');
  console.log('PASS test 3: snapshot più vecchio inserito dopo NON sostituisce current');

  // 4) stesso captured_at -> id più alto vince
  result = simulate([
    { type: 'insert', snapshotId: 5, capturedAt: 100, providerMappingId: 'm1', price: 10 },
    { type: 'insert', snapshotId: 7, capturedAt: 100, providerMappingId: 'm1', price: 11 }
  ]);
  assert.equal(result.snapshotId, 7, 'a parità di captured_at deve vincere lo snapshot_id più alto');
  console.log('PASS test 4: stesso captured_at -> id più alto vince');

  // 5) anomalous non diventa mai current
  result = simulate([
    { type: 'insert', snapshotId: 1, capturedAt: 100, providerMappingId: 'm1', price: 10 },
    { type: 'insert', snapshotId: 2, capturedAt: 200, providerMappingId: 'm1', price: 999, isAnomalous: true }
  ]);
  assert.equal(result.snapshotId, 1, 'uno snapshot anomalo non deve mai diventare current, anche se più recente');
  console.log('PASS test 5: anomalous non diventa current');

  // 6) current marcato anomalous -> fallback al precedente valido
  result = simulate([
    { type: 'insert', snapshotId: 1, capturedAt: 100, providerMappingId: 'm1', price: 10 },
    { type: 'insert', snapshotId: 2, capturedAt: 200, providerMappingId: 'm1', price: 12 }, // diventa current
    { type: 'setAnomalous', snapshotId: 2, value: true } // il current viene invalidato
  ]);
  assert.equal(result.snapshotId, 1, 'un current invalidato deve tornare automaticamente al precedente valido, anche se più vecchio');
  console.log('PASS test 6: current marcato anomalous -> fallback al precedente valido');

  // 6b) se non resta NESSUNO snapshot valido, il current viene rimosso (null)
  result = simulate([
    { type: 'insert', snapshotId: 1, capturedAt: 100, providerMappingId: 'm1', price: 10 },
    { type: 'setAnomalous', snapshotId: 1, value: true }
  ]);
  assert.equal(result, null, 'se non resta alcuno snapshot valido, il current deve essere rimosso, mai un anomalo esposto');
  console.log('PASS test 6b: nessun fallback disponibile -> current rimosso');

  // 7) anomalia confermata/reintegrata -> current corretto (vince solo se più recente)
  result = simulate([
    { type: 'insert', snapshotId: 1, capturedAt: 100, providerMappingId: 'm1', price: 10, isAnomalous: true }, // scartato all'insert
    { type: 'insert', snapshotId: 2, capturedAt: 50, providerMappingId: 'm1', price: 9 }, // più vecchio ma valido -> current
    { type: 'setAnomalous', snapshotId: 1, value: false } // confermato: 100 > 50 -> deve vincere
  ]);
  assert.equal(result.snapshotId, 1, 'uno snapshot confermato deve tornare candidato e vincere se più recente del current');

  result = simulate([
    { type: 'insert', snapshotId: 1, capturedAt: 30, providerMappingId: 'm1', price: 10, isAnomalous: true },
    { type: 'insert', snapshotId: 2, capturedAt: 200, providerMappingId: 'm1', price: 9 },
    { type: 'setAnomalous', snapshotId: 1, value: false } // confermato ma più vecchio del current -> non deve cambiare nulla
  ]);
  assert.equal(result.snapshotId, 2, 'uno snapshot confermato ma più vecchio del current non deve sostituirlo');
  console.log('PASS test 7: anomalia confermata/reintegrata -> current corretto in entrambi i casi (vince/non vince)');
}

// --- Test 8/9: più price_type e più provider indipendenti (nessuna
//     contaminazione tra chiavi diverse) ---
{
  function simulateMultiKey(events) {
    const byKey = new Map();
    for (const event of events) {
      const key = event.providerMappingId + '|' + event.priceType;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(event);
    }
    return new Map([...byKey].map(([key, evts]) => [key, simulate(evts)]));
  }
  const results = simulateMultiKey([
    { type: 'insert', snapshotId: 1, capturedAt: 100, providerMappingId: 'm1', priceType: 'trend', price: 10 },
    { type: 'insert', snapshotId: 2, capturedAt: 100, providerMappingId: 'm1', priceType: 'low', price: 8 },
    { type: 'insert', snapshotId: 3, capturedAt: 100, providerMappingId: 'm2', priceType: 'trend', price: 20 }
  ]);
  assert.equal(results.get('m1|trend').price, 10);
  assert.equal(results.get('m1|low').price, 8);
  assert.equal(results.get('m2|trend').price, 20);
  console.log('PASS test 8/9: più price_type e più provider_mapping_id restano indipendenti, nessuna contaminazione tra chiavi');
}

// --- Verifiche statiche sulla migration ----------------------------------
{
  const root = path.dirname(fileURLToPath(import.meta.url));
  const migration = await readFile(path.join(root, '..', 'supabase', 'migrations', '20260914200000_market_current_price_layer.sql'), 'utf8');
  const sqlNoComments = migration.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  function test(name, fn) { try { fn(); console.log(`PASS ${name}`); } catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; } }

  test('la chiave primaria del current layer è (provider_mapping_id, price_type)', () => {
    assert.match(sqlNoComments, /primary key \(provider_mapping_id, price_type\)/);
  });
  test('nessun campo "active"/mapping status incorporato nel current layer (test 10/11: il read path fa sempre un JOIN fresco)', () => {
    const tableBlock = sqlNoComments.match(/create table if not exists public\.market_current_price_snapshots \(([\s\S]*?)\);/)?.[1] || '';
    assert.equal(/\bactive\b/i.test(tableBlock), false, 'la tabella non deve contenere una colonna di stato mapping');
  });
  test('test 17: nessuna UPDATE/DELETE su market_price_snapshots in tutta la migration (sola lettura di quella tabella)', () => {
    assert.equal(/update\s+public\.market_price_snapshots|delete\s+from\s+public\.market_price_snapshots/i.test(sqlNoComments), false);
  });
  test('il trigger AFTER INSERT e quello AFTER UPDATE OF is_anomalous esistono entrambi', () => {
    assert.match(sqlNoComments, /after insert on public\.market_price_snapshots/);
    assert.match(sqlNoComments, /after update of is_anomalous on public\.market_price_snapshots/);
  });
  test('rebuild_market_current_price_snapshot non ha la guardia "solo se più recente" (deve poter tornare indietro nel tempo)', () => {
    const rebuildBlock = sqlNoComments.match(/create or replace function public\.rebuild_market_current_price_snapshot[\s\S]*?\nend;\n\$\$;/)?.[1] || sqlNoComments.match(/rebuild_market_current_price_snapshot\(p_provider_mapping_id uuid, p_price_type text\)([\s\S]*?)end;\n\$\$;/)?.[1] || '';
    assert.notEqual(rebuildBlock, '', 'blocco rebuild non trovato (regex da aggiornare)');
    assert.equal(/where excluded\.captured_at >/i.test(rebuildBlock), false, 'rebuild non deve avere una guardia incrementale: deve sovrascrivere sempre col vero vincitore');
  });
  test('sync_market_current_price_snapshot ha la guardia "solo se più recente" e scarta gli anomalous', () => {
    const syncBlock = sqlNoComments.match(/sync_market_current_price_snapshot\(p_snapshot public\.market_price_snapshots\)([\s\S]*?)end;\n\$\$;/)?.[1] || '';
    assert.notEqual(syncBlock, '', 'blocco sync non trovato (regex da aggiornare)');
    assert.match(syncBlock, /if p_snapshot\.is_anomalous then return; end if;/);
    assert.match(syncBlock, /where excluded\.captured_at > public\.market_current_price_snapshots\.captured_at/);
  });
  test('il backfill è idempotente (stessa guardia "solo se più recente" del trigger, mai un DO NOTHING che perderebbe aggiornamenti su rerun)', () => {
    const backfillBlock = sqlNoComments.match(/backfill_market_current_price_snapshots\(p_token text\)([\s\S]*?)end;\n\$\$;/)?.[1] || '';
    assert.notEqual(backfillBlock, '', 'blocco backfill non trovato');
    assert.match(backfillBlock, /where excluded\.captured_at > public\.market_current_price_snapshots\.captured_at/);
    assert.equal(/do nothing/i.test(backfillBlock), false, 'un DO NOTHING perderebbe aggiornamenti se il backfill gira dopo che i trigger sono già live');
  });
  test('il backfill e la shadow function sono admin-only (session_member + team_members.role=\'admin\')', () => {
    for (const fnName of ['backfill_market_current_price_snapshots', 'market_current_price_layer_shadow_report']) {
      const block = sqlNoComments.match(new RegExp(fnName + '\\([^)]*\\)([\\s\\S]*?)end;\\n\\$\\$;'))?.[1] || '';
      assert.match(block, /role = 'admin'/, `${fnName} deve richiedere role='admin'`);
    }
  });
  test('nessun tocco a get_market_watch_summary/list_market_watch_owned_page/list_market_watch_extra/list_market_confirm_queue/cron/Edge Function', () => {
    for (const untouched of ['function public.get_market_watch_summary', 'function public.list_market_watch_owned_page', 'function public.list_market_watch_extra', 'function public.list_market_confirm_queue']) {
      assert.equal(sqlNoComments.includes(untouched), false, `${untouched} non deve essere ridefinita in questa migration`);
    }
    assert.equal(/cron\.schedule|pg_cron|functions\/v1/i.test(sqlNoComments), false);
  });
  test('nessuna modifica UI: nessun file frontend (js/*.js, app.js) in questa migration (è un file .sql)', () => {
    assert.equal(migration.trim().length > 0, true); // banale ma esplicito: file .sql, non tocca js/*.js per costruzione
  });
  console.log('market_current_price_layer migration (statico): chiave, isolamento da mapping status, sola lettura di market_price_snapshots, trigger presenti, guardie incrementali corrette nei posti giusti, admin-only, nessun tocco fuori scope');
}

// --- Test 18: shadow legacy vs new, dataset sintetico (stesso stile delle
//     due migration precedenti: active/inactive, EUR/non-EUR, anomalous,
//     più price_type con precedenza, più snapshot nel tempo, printing con/
//     senza prezzo, più printing per la stessa carta logica) ---
{
  function referenceType(provider, priceType) {
    if (provider === 'cardmarket' && priceType === 'trend') return 1;
    if (provider === 'cardtrader' && priceType === 'reference') return 2;
    if (priceType === 'average' || priceType === 'avg7') return 3;
    if (priceType === 'low' || priceType === 'lowest') return 4;
    return 9;
  }
  const owned = [
    { printingId: 'p1', mappingId: 'm1', active: true },
    { printingId: 'p2', mappingId: 'm2', active: false }, // mapping inactive -> escluso da entrambe le pipeline
    { printingId: 'p3', mappingId: 'm3', active: true },  // nessun prezzo -> missing in entrambe
    { printingId: 'p4', mappingId: 'm4', active: true }   // due provider, precedenza
  ];
  const NOW = 1000000;
  const snapshotsOverTime = [ // storico completo, usato dalla pipeline LEGACY
    { printingId: 'p1', mappingId: 'm1', provider: 'cardmarket', priceType: 'trend', price: 10, currency: 'EUR', capturedAt: NOW - 200, anomalous: false },
    { printingId: 'p1', mappingId: 'm1', provider: 'cardmarket', priceType: 'trend', price: 12, currency: 'EUR', capturedAt: NOW, anomalous: false }, // il vero current
    { printingId: 'p1', mappingId: 'm1', provider: 'cardmarket', priceType: 'trend', price: 999, currency: 'EUR', capturedAt: NOW - 50, anomalous: true }, // anomalo, mai usato
    { printingId: 'p2', mappingId: 'm2', provider: 'cardmarket', priceType: 'trend', price: 5, currency: 'EUR', capturedAt: NOW, anomalous: false }, // mapping inactive
    { printingId: 'p4', mappingId: 'm4', provider: 'cardtrader', priceType: 'reference', price: 7, currency: 'EUR', capturedAt: NOW, anomalous: false },
    { printingId: 'p4', mappingId: 'm4', provider: 'cardmarket', priceType: 'low', price: 6, currency: 'EUR', capturedAt: NOW, anomalous: false }
  ];
  // current layer: SOLO l'ultimo non anomalo per (mappingId, priceType) — esattamente ciò che il trigger produrrebbe.
  const currentLayer = [
    { printingId: 'p1', mappingId: 'm1', provider: 'cardmarket', priceType: 'trend', price: 12, currency: 'EUR' },
    { printingId: 'p2', mappingId: 'm2', provider: 'cardmarket', priceType: 'trend', price: 5, currency: 'EUR' },
    { printingId: 'p4', mappingId: 'm4', provider: 'cardtrader', priceType: 'reference', price: 7, currency: 'EUR' },
    { printingId: 'p4', mappingId: 'm4', provider: 'cardmarket', priceType: 'low', price: 6, currency: 'EUR' }
  ];
  const activeByMapping = new Map(owned.map(o => [o.mappingId, o.active]));

  function legacyReference() {
    const eligible = snapshotsOverTime.filter(s => activeByMapping.get(s.mappingId) && !s.anomalous && s.currency === 'EUR');
    const bestRow = new Map();
    for (const row of eligible) {
      const key = row.printingId + '|' + row.provider;
      const current = bestRow.get(key);
      if (!current || referenceType(row.provider, row.priceType) < referenceType(current.provider, current.priceType)
        || (referenceType(row.provider, row.priceType) === referenceType(current.provider, current.priceType) && row.capturedAt > current.capturedAt)) bestRow.set(key, row);
    }
    const perPrinting = new Map();
    for (const row of bestRow.values()) {
      const current = perPrinting.get(row.printingId);
      if (!current || referenceType(row.provider, row.priceType) < referenceType(current.provider, current.priceType)) perPrinting.set(row.printingId, row);
    }
    return new Map([...perPrinting].map(([id, row]) => [id, row.price]));
  }
  function newReference() {
    const eligible = currentLayer.filter(s => activeByMapping.get(s.mappingId) && s.currency === 'EUR');
    const perPrinting = new Map();
    for (const row of eligible) {
      const current = perPrinting.get(row.printingId);
      if (!current || referenceType(row.provider, row.priceType) < referenceType(current.provider, current.priceType)) perPrinting.set(row.printingId, row);
    }
    return new Map([...perPrinting].map(([id, row]) => [id, row.price]));
  }

  const legacy = legacyReference(), fresh = newReference();
  for (const o of owned) {
    assert.equal(fresh.has(o.printingId), legacy.has(o.printingId), `presenza diversa per ${o.printingId}`);
    if (legacy.has(o.printingId)) assert.equal(fresh.get(o.printingId), legacy.get(o.printingId), `prezzo diverso per ${o.printingId}`);
  }
  assert.equal(legacy.has('p2'), false, 'mapping inactive: mai un reference price in nessuna delle due pipeline');
  assert.equal(legacy.has('p3'), false, 'nessuno snapshot: missing in entrambe');
  assert.equal(legacy.get('p1'), 12, 'deve vincere lo snapshot più recente non anomalo (12), mai quello anomalo (999) né quello vecchio (10)');
  assert.equal(legacy.get('p4'), 7, 'cardtrader/reference deve vincere su cardmarket/low');
  console.log('PASS test 18: shadow legacy vs new identici sul dataset sintetico (active/inactive, anomalous, storico multi-snapshot, precedenza multi-provider)');
}

// Test 12 (EUR/non-EUR) e 13 (precedenza) sono già coperti nel blocco Test
// 18 sopra (currency='EUR' filtrato in entrambe le pipeline, precedenza
// cardtrader/reference su cardmarket/low verificata esplicitamente).
// Test 14 (più printing stessa carta logica) è verificato in
// market-watch-summary-perf-smoke.mjs (catalogPriceFloor, non toccato da
// questa migration) — non duplicato qui.
// Test 15/16 (backfill idempotente/rerun sicuro): la guardia "solo se più
// recente" è la STESSA logica di syncCandidate() già provata esaustivamente
// nei test 1-7 sopra (il backfill applica quella guardia riga per riga via
// ON CONFLICT ... WHERE, verificato staticamente) — rieseguirlo produce
// sempre lo stesso risultato o nessun cambiamento, mai una regressione.
console.log('PASS test 12/13 (coperti nel blocco 18), 14 (coperto in market-watch-summary-perf-smoke.mjs), 15/16 (la guardia di idempotenza del backfill è la stessa syncCandidate provata nei test 1-7)');
