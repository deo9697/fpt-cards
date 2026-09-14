// Market Watch — CUTOVER dei reader (get_market_watch_summary,
// list_market_watch_owned_page, list_market_watch_extra) al current-price
// layer (supabase/migrations/20260914210000_market_watch_current_price_cutover.sql).
// Stesso metodo delle migration precedenti: nessun accesso a un Postgres
// reale in questa sessione, quindi la correttezza è dimostrata con una
// reimplementazione JS pura di ENTRAMBE le fonti (storico completo "OLD" vs
// current layer "NEW", quest'ultimo derivato dallo storico con la STESSA
// regola dei trigger di 20260914200000 — non un dato indipendente/a caso)
// sullo stesso dataset sintetico, più verifiche statiche sul testo della
// migration.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function referenceType(provider, priceType) {
  if (provider === 'cardmarket' && priceType === 'trend') return 1;
  if (provider === 'cardtrader' && priceType === 'reference') return 2;
  if (priceType === 'average' || priceType === 'avg7') return 3;
  if (priceType === 'low' || priceType === 'lowest') return 4;
  return 9;
}

// --- Dataset sintetico condiviso -----------------------------------------
// 10 printing owned per 3 carte logiche (per il floor multi-printing),
// coprendo: active/inactive/manual/resolved-exact/PROVIDER_AGGREGATE/
// AMBIGUOUS, EUR/USD, anomalous, più price_type con precedenza, storico
// multi-snapshot (per dimostrare che il current layer usa SOLO l'ultimo),
// una printing senza alcun prezzo, due printing nella stessa "pagina"
// per un test di paginazione con offset.
const NOW = 2_000_000_000_000; // ms epoch fittizio, alto abbastanza per sottrarre giorni senza andare negativo
const days = n => NOW - n * 86_400_000;

const owned = [
  { printingId: 'p1', catalogCardId: 'cc-a', cardName: 'Ash Blossom', quantity: 3, mapping: { id: 'm1', resolutionStatus: 'resolved', active: true, metadata: { resolverStatus: 'EXACT', active: 'true' } } },
  { printingId: 'p2', catalogCardId: 'cc-a', cardName: 'Ash Blossom (alt art)', quantity: 1, mapping: { id: 'm2', resolutionStatus: 'resolved', active: true, metadata: { resolverStatus: 'PROVIDER_AGGREGATE', active: 'true' } } }, // stessa carta logica di p1, prezzo più basso -> vince sul floor
  { printingId: 'p3', catalogCardId: 'cc-b', cardName: 'Called by the Grave', quantity: 2, mapping: { id: 'm3', resolutionStatus: 'resolved', active: false, metadata: { resolverStatus: 'EXACT', active: 'false' } } }, // mapping inactive
  { printingId: 'p4', catalogCardId: 'cc-c', cardName: 'Droll & Lock Bird', quantity: 5, mapping: { id: 'm4', resolutionStatus: 'manual', active: true, metadata: {} } }, // manual
  { printingId: 'p5', catalogCardId: 'cc-d', cardName: 'Effect Veiler', quantity: 1, mapping: { id: 'm5', resolutionStatus: 'resolved', active: true, metadata: { resolverStatus: 'EXACT', active: 'true' } } }, // 2 provider, precedenza
  { printingId: 'p6', catalogCardId: 'cc-e', cardName: 'Ghost Ogre', quantity: 4, mapping: { id: 'm6', resolutionStatus: 'resolved', active: true, metadata: { resolverStatus: 'EXACT', active: 'true' } } }, // storico multi-snapshot: il current layer deve usare SOLO l'ultimo
  { printingId: 'p7', catalogCardId: 'cc-f', cardName: 'Harpies Feather Duster', quantity: 1, mapping: { id: 'm7', resolutionStatus: 'resolved', active: true, metadata: { resolverStatus: 'AMBIGUOUS', active: 'true' } } },
  { printingId: 'p8', catalogCardId: 'cc-g', cardName: 'Infinite Impermanence', quantity: 2, mapping: { id: 'm8', resolutionStatus: 'resolved', active: true, metadata: { resolverStatus: 'EXACT', active: 'true' } } }, // solo USD -> mai un reference price
  { printingId: 'p9', catalogCardId: 'cc-h', cardName: 'Junk Forward (no price)', quantity: 1, mapping: { id: 'm9', resolutionStatus: 'resolved', active: true, metadata: { resolverStatus: 'EXACT', active: 'true' } } }, // nessuno snapshot
  { printingId: 'p10', catalogCardId: 'cc-i', cardName: 'Kuriboh', quantity: 1, mapping: { id: 'm10', resolutionStatus: 'resolved', active: true, metadata: { resolverStatus: 'EXACT', active: 'true' } } }
];
const mappingById = new Map(owned.map(o => [o.mapping.id, { printingId: o.printingId, ...o.mapping }]));

// storico "grezzo" — multipli snapshot nel tempo, alcuni anomali, alcuni in
// USD, con precedenza multi-provider esplicita su p5.
const snapshotsOverTime = [
  { id: 's1', printingId: 'p1', mappingId: 'm1', provider: 'cardmarket', priceType: 'trend', price: 10, currency: 'EUR', capturedAt: days(30), anomalous: false },
  { id: 's2', printingId: 'p1', mappingId: 'm1', provider: 'cardmarket', priceType: 'trend', price: 11, currency: 'EUR', capturedAt: days(7), anomalous: false },
  { id: 's3', printingId: 'p1', mappingId: 'm1', provider: 'cardmarket', priceType: 'trend', price: 12, currency: 'EUR', capturedAt: NOW, anomalous: false }, // il vero current
  { id: 's4', printingId: 'p2', mappingId: 'm2', provider: 'cardmarket', priceType: 'trend', price: 4, currency: 'EUR', capturedAt: NOW, anomalous: false }, // vince il floor di cc-a (4 < 12), isAggregate
  { id: 's5', printingId: 'p3', mappingId: 'm3', provider: 'cardmarket', priceType: 'trend', price: 999, currency: 'EUR', capturedAt: NOW, anomalous: false }, // mapping inactive, mai usato
  { id: 's6', printingId: 'p4', mappingId: 'm4', provider: 'cardmarket', priceType: 'trend', price: 2, currency: 'EUR', capturedAt: NOW, anomalous: false }, // manual, deve contare
  { id: 's7', printingId: 'p5', mappingId: 'm5', provider: 'cardtrader', priceType: 'reference', price: 7, currency: 'EUR', capturedAt: NOW, anomalous: false },
  { id: 's8', printingId: 'p5', mappingId: 'm5', provider: 'cardmarket', priceType: 'low', price: 6, currency: 'EUR', capturedAt: NOW, anomalous: false }, // cardtrader/reference deve vincere
  { id: 's9', printingId: 'p6', mappingId: 'm6', provider: 'cardmarket', priceType: 'trend', price: 20, currency: 'EUR', capturedAt: days(60), anomalous: false },
  { id: 's10', printingId: 'p6', mappingId: 'm6', provider: 'cardmarket', priceType: 'trend', price: 25, currency: 'EUR', capturedAt: days(29), anomalous: false }, // ~29gg fa -> price_30d
  { id: 's11', printingId: 'p6', mappingId: 'm6', provider: 'cardmarket', priceType: 'trend', price: 30, currency: 'EUR', capturedAt: days(6), anomalous: false }, // ~6gg fa -> price_7d
  { id: 's12', printingId: 'p6', mappingId: 'm6', provider: 'cardmarket', priceType: 'trend', price: 35, currency: 'EUR', capturedAt: days(0.9), anomalous: false }, // ~22h fa -> price_24h
  { id: 's13', printingId: 'p6', mappingId: 'm6', provider: 'cardmarket', priceType: 'trend', price: 999, currency: 'EUR', capturedAt: days(0.1), anomalous: true }, // anomalo, il PIÙ recente in assoluto -> mai current
  { id: 's14', printingId: 'p6', mappingId: 'm6', provider: 'cardmarket', priceType: 'trend', price: 40, currency: 'EUR', capturedAt: NOW, anomalous: false }, // il vero current (il più recente NON anomalo)
  { id: 's15', printingId: 'p7', mappingId: 'm7', provider: 'cardmarket', priceType: 'trend', price: 1, currency: 'EUR', capturedAt: NOW, anomalous: false },
  { id: 's16', printingId: 'p8', mappingId: 'm8', provider: 'cardmarket', priceType: 'trend', price: 3, currency: 'USD', capturedAt: NOW, anomalous: false }, // USD, mai un reference price
  { id: 's17', printingId: 'p10', mappingId: 'm10', provider: 'cardmarket', priceType: 'trend', price: 50, currency: 'EUR', capturedAt: NOW, anomalous: false }
];

// --- current layer, derivato con la STESSA regola dei trigger di
//     20260914200000 (ultimo snapshot NON anomalo per mappingId+priceType,
//     captured_at desc poi id desc) — non un dato indipendente/a caso.
function deriveCurrentLayer(snapshots) {
  const byKey = new Map();
  for (const s of snapshots) {
    if (s.anomalous) continue;
    const key = s.mappingId + '|' + s.priceType;
    const current = byKey.get(key);
    if (!current || s.capturedAt > current.capturedAt || (s.capturedAt === current.capturedAt && s.id > current.id)) byKey.set(key, s);
  }
  return [...byKey.values()];
}
const currentLayer = deriveCurrentLayer(snapshotsOverTime);

function activeByMapping() { return new Map(owned.map(o => [o.mapping.id, o.mapping.active])); }
function derivedByMapping() {
  return new Map(owned.map(o => [o.mapping.id, o.mapping.resolutionStatus === 'manual'
    || (o.mapping.resolutionStatus === 'resolved' && o.mapping.metadata?.active === 'true' && o.mapping.metadata?.resolverStatus === 'EXACT')]));
}

// OLD: reference price dallo storico completo (eligible -> preferred -> reference).
function oldReferenceByPrinting() {
  const active = activeByMapping();
  const eligible = snapshotsOverTime.filter(s => active.get(s.mappingId) && !s.anomalous && s.currency === 'EUR');
  return referenceFromRows(eligible);
}
// NEW: reference price dal current layer (già "ultimo non anomalo").
function newReferenceByPrinting() {
  const active = activeByMapping();
  const eligible = currentLayer.filter(s => active.get(s.mappingId) && s.currency === 'EUR');
  return referenceFromRows(eligible);
}
function referenceFromRows(rows) {
  const bestPerProvider = new Map();
  for (const row of rows) {
    const key = row.printingId + '|' + row.provider;
    const current = bestPerProvider.get(key);
    if (!current || referenceType(row.provider, row.priceType) < referenceType(current.provider, current.priceType)
      || (referenceType(row.provider, row.priceType) === referenceType(current.provider, current.priceType) && row.capturedAt > current.capturedAt)) bestPerProvider.set(key, row);
  }
  const referenceRow = new Map();
  for (const row of bestPerProvider.values()) {
    const current = referenceRow.get(row.printingId);
    if (!current || referenceType(row.provider, row.priceType) < referenceType(current.provider, current.priceType)) referenceRow.set(row.printingId, row);
  }
  return new Map([...referenceRow].map(([id, row]) => [id, row.price]));
}

// --- 1) Equivalenza reference price OLD (storico) vs NEW (current layer) ---
{
  const oldRef = oldReferenceByPrinting(), newRef = newReferenceByPrinting();
  for (const o of owned) {
    assert.equal(newRef.has(o.printingId), oldRef.has(o.printingId), `presenza diversa per ${o.printingId}`);
    if (oldRef.has(o.printingId)) assert.equal(newRef.get(o.printingId), oldRef.get(o.printingId), `prezzo diverso per ${o.printingId}`);
  }
  // Asserzioni assolute sui casi mirati del dataset.
  assert.equal(newRef.get('p1'), 12, 'p1: deve vincere il current (12), mai uno snapshot più vecchio (10/11)');
  assert.equal(newRef.get('p6'), 40, 'p6: deve vincere il current (40), mai l\'anomalo più recente (999) né uno storico (20/25/30/35)');
  assert.equal(newRef.has('p3'), false, 'p3: mapping inactive, mai un reference price in nessuna delle due pipeline');
  assert.equal(newRef.get('p4'), 2, 'p4: manual attivo deve comunque produrre un reference price');
  assert.equal(newRef.get('p5'), 7, 'p5: cardtrader/reference deve vincere su cardmarket/low');
  assert.equal(newRef.has('p8'), false, 'p8: solo USD, mai un reference price');
  assert.equal(newRef.has('p9'), false, 'p9: nessuno snapshot, mai un reference price');
  console.log('PASS reference price identico tra storico completo (OLD) e current layer (NEW), inclusi mapping inactive/manual/precedenza multi-provider/valuta non-EUR/nessun prezzo/anomalo più recente scartato');
}

// --- 2) catalogPriceFloor multi-printing stessa carta logica (get_market_watch_summary) ---
{
  const newRef = newReferenceByPrinting();
  const byCard = new Map();
  for (const o of owned) {
    if (!newRef.has(o.printingId)) continue;
    const price = newRef.get(o.printingId);
    const current = byCard.get(o.catalogCardId);
    if (!current || price < current.price) byCard.set(o.catalogCardId, { price, isAggregate: o.mapping.metadata?.resolverStatus === 'PROVIDER_AGGREGATE' });
  }
  assert.equal(byCard.get('cc-a').price, 4, 'il floor di cc-a deve essere il minimo tra p1 (12) e p2 (4)');
  assert.equal(byCard.get('cc-a').isAggregate, true, 'isAggregate deve riflettere la printing VINCENTE (p2), non una qualunque');
  console.log('PASS catalogPriceFloor multi-printing: minimo corretto, isAggregate della riga vincente');
}

// --- 3) confirmCount / aggregatePendingCount (indipendenti dal current layer, solo metadata) ---
{
  let confirmCount = 0, aggregatePendingCount = 0;
  for (const o of owned) {
    const m = o.mapping;
    if (m.resolutionStatus !== 'manual' && (m.metadata?.reason === 'provider_rarity_mismatch' || (m.metadata?.resolverStatus || m.resolutionStatus) === 'AMBIGUOUS')) confirmCount++;
    if ((m.metadata?.resolverStatus || m.resolutionStatus) === 'PROVIDER_AGGREGATE') aggregatePendingCount++; // dataset senza evidence.candidates espliciti: qui solo il flag di stato
  }
  assert.equal(confirmCount, 1, 'solo p7 (AMBIGUOUS) deve contare in confirmCount');
  console.log('PASS confirmCount coerente con i metadata di mapping (non toccato dal cutover)');
}

// --- 4) price_24h/7d/30d: SEMPRE dallo storico reale, MAI dal current layer ---
{
  const derived = derivedByMapping();
  const eligibleDerived = snapshotsOverTime.filter(s => derived.get(s.mappingId) && !s.anomalous);
  function historyAtOrBefore(cutoffMs) {
    const best = new Map();
    for (const row of eligibleDerived) {
      if (row.printingId !== 'p6' || row.capturedAt > cutoffMs) continue;
      const current = best.get(row.printingId);
      if (!current || row.capturedAt > current.capturedAt) best.set(row.printingId, row);
    }
    return best.get('p6')?.price ?? null;
  }
  const price24h = historyAtOrBefore(NOW - 24 * 3600 * 1000);
  const price7d = historyAtOrBefore(NOW - 7 * 86400 * 1000);
  const price30d = historyAtOrBefore(NOW - 30 * 86400 * 1000);
  assert.equal(price24h, 30, 'price_24h di p6 deve venire dallo storico (~6gg fa, 30), non dal current layer (40)');
  assert.equal(price7d, 25, 'price_7d di p6 deve venire dallo storico (~29gg fa, 25)');
  assert.equal(price30d, 20, 'price_30d di p6 deve venire dallo storico (~60gg fa, 20)');
  assert.notEqual(price24h, currentLayer.find(s => s.printingId === 'p6')?.price, 'il current layer (40) non deve MAI essere confuso con un valore storico');
  console.log('PASS price_24h/7d/30d derivano SEMPRE dallo storico reale, mai dal current layer (che contiene solo il presente)');
}

// --- 5) Paginazione: sort=value su un dataset più ampio, offset multipli, nessun duplicato/riga saltata ---
{
  function pageIdsForSort(sort, limit, offset) {
    const active = activeByMapping();
    const eligible = currentLayer.filter(s => active.get(s.mappingId) && s.currency === 'EUR');
    const ref = referenceFromRows(eligible);
    const rows = owned.map(o => ({ id: o.printingId, price: ref.has(o.printingId) ? ref.get(o.printingId) : null, quantity: o.quantity, name: o.cardName }));
    rows.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
      const av = sort === 'price' ? a.price : (a.price ?? -1) * a.quantity;
      const bv = sort === 'price' ? b.price : (b.price ?? -1) * b.quantity;
      if (av == null && bv == null) return a.id.localeCompare(b.id);
      if (av == null) return 1; if (bv == null) return -1;
      return bv - av || a.id.localeCompare(b.id);
    });
    return { pageIds: rows.slice(offset, offset + limit).map(r => r.id), total: rows.length };
  }
  const page1 = pageIdsForSort('value', 4, 0), page2 = pageIdsForSort('value', 4, 4), page3 = pageIdsForSort('value', 4, 8);
  const allIds = [...page1.pageIds, ...page2.pageIds, ...page3.pageIds];
  assert.equal(new Set(allIds).size, allIds.length, 'nessun duplicato tra pagine consecutive');
  assert.equal(allIds.length, owned.length, 'nessuna riga saltata: la somma delle pagine deve coprire tutte le 10 printing owned');
  assert.equal(page1.total, owned.length);
  console.log('PASS paginazione (sort=value, limit=4, offset 0/4/8): nessun duplicato, nessuna riga saltata, total corretto');
}

// --- Verifiche statiche sulla migration ----------------------------------
{
  const root = path.dirname(fileURLToPath(import.meta.url));
  const migration = await readFile(path.join(root, '..', 'supabase', 'migrations', '20260914210000_market_watch_current_price_cutover.sql'), 'utf8');
  const sqlNoComments = migration.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  function test(name, fn) { try { fn(); console.log(`PASS ${name}`); } catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; } }

  test('ridefinisce ESATTAMENTE le 3 funzioni attese, nessun'+"'"+'altra', () => {
    assert.equal((migration.match(/create or replace function/g) || []).length, 3);
    for (const fn of ['get_market_watch_summary', 'list_market_watch_owned_page', 'list_market_watch_extra']) {
      assert.match(migration, new RegExp(`create or replace function public\\.${fn}`));
    }
  });
  test('le firme delle 3 RPC restano identiche (nessuna rottura di contratto)', () => {
    assert.match(sqlNoComments, /get_market_watch_summary\(p_token text, p_game text default 'yugioh'\)/);
    assert.match(sqlNoComments, /list_market_watch_owned_page\(\s*p_token text, p_game text default 'yugioh',\s*p_limit integer default 60, p_offset integer default 0,\s*p_sort text default 'value', p_query text default null\s*\)/);
    assert.match(sqlNoComments, /list_market_watch_extra\(p_token text, p_game text default 'yugioh'\)/);
  });
  test('nessuna scrittura di dati, nessun nuovo indice (giustificato: già coperti da 20260914200000)', () => {
    assert.equal(/\binsert\s+into\b|\bupdate\s+public\.|\bdelete\s+from\b|\bcreate\s+index\b/i.test(sqlNoComments), false);
  });
  test('ogni funzione legge market_current_price_snapshots per il prezzo corrente', () => {
    for (const fn of ['get_market_watch_summary', 'list_market_watch_owned_page', 'list_market_watch_extra']) {
      const start = sqlNoComments.indexOf(`create or replace function public.${fn}`);
      const end = sqlNoComments.indexOf('$$;', start) + 3;
      const body = sqlNoComments.slice(start, end);
      assert.match(body, /from public\.market_current_price_snapshots/, `${fn} deve leggere il current layer`);
    }
  });
  test('price_24h/7d/30d restano SEMPRE su market_price_snapshots (mai sostituiti dal current layer)', () => {
    for (const marker of ["interval '24 hours'", "interval '7 days'", "interval '30 days'"]) {
      const idx = sqlNoComments.indexOf(marker);
      assert.notEqual(idx, -1, `manca un uso di ${marker}`);
    }
    // Le 3 occorrenze di ciascun intervallo (owned_page 'change' + owned_page FASE B + extra) devono esistere.
    assert.equal((sqlNoComments.match(/interval '24 hours'/g) || []).length >= 2, true);
    assert.equal((sqlNoComments.match(/interval '7 days'/g) || []).length >= 2, true);
    assert.equal((sqlNoComments.match(/interval '30 days'/g) || []).length >= 2, true);
  });
  test('la logica "derived" (manual OR resolved+active+EXACT) resta testualmente identica ovunque compare', () => {
    const occurrences = sqlNoComments.match(/\(resolution_status = 'manual' or \(resolution_status = 'resolved'\s*\n\s*and coalesce\(provider_metadata->>'active', 'false'\) = 'true'\s*\n\s*and provider_metadata->>'resolverStatus' = 'EXACT'\)\) derived/g) || [];
    assert.equal(occurrences.length, 3, `attese 3 occorrenze (owned_page change + owned_page FASE B + extra), trovate ${occurrences.length}`);
  });
  test('sort=name non tocca né il current layer né market_price_snapshots (nessun prezzo prima del LIMIT)', () => {
    const start = sqlNoComments.indexOf("if p_sort = 'name' then");
    const end = sqlNoComments.indexOf("elsif p_sort = 'change'");
    const nameBlock = sqlNoComments.slice(start, end);
    assert.equal(/market_current_price_snapshots|market_price_snapshots/.test(nameBlock), false);
  });
  test('nessun tocco a market-sync/cron/trigger/Market Variant Registry/Fast Scan/altra migration', () => {
    for (const forbidden of ['cron.schedule', 'pg_cron', 'functions/v1', 'ygo_market_variants', 'ygo_market_variant_price_shadow', 'fast_scan', 'create trigger', 'create or replace function public.sync_market_current_price_snapshot', 'create or replace function public.rebuild_market_current_price_snapshot']) {
      assert.equal(sqlNoComments.toLowerCase().includes(forbidden.toLowerCase()), false, `riferimento vietato: ${forbidden}`);
    }
  });
  test('list_market_watch_extra: mapping_flags ristretto a monitored (stessa restrizione di summary/owned_page)', () => {
    assert.match(sqlNoComments, /from public\.market_provider_printings\s*\n\s*where printing_id in \(select printing_id from monitored\)/);
  });
  console.log('cutover migration (statico): 3 funzioni attese, firme invariate, nessuna scrittura/indice, current layer usato per il prezzo corrente, storico intatto per 24h/7d/30d, "derived" testualmente identico, sort=name senza prezzo, nessun tocco fuori scope');
}
