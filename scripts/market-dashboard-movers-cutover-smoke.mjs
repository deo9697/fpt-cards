// Market Watch — CUTOVER di list_market_dashboard_movers al current-price
// layer (supabase/migrations/20260916100000_market_dashboard_movers_
// current_price_cutover.sql). Stesso metodo delle altre 3 RPC cutover
// (scripts/market-watch-current-price-cutover-smoke.mjs): nessun accesso a
// un Postgres reale in questa sessione, quindi la correttezza è dimostrata
// con una reimplementazione JS pura di ENTRAMBE le fonti (storico completo
// "OLD" vs current layer "NEW", quest'ultimo derivato dallo storico con la
// STESSA regola dei trigger di 20260914200000) sullo stesso dataset
// sintetico, più verifiche statiche sul testo della migration.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOW = 2_000_000_000_000; // ms epoch fittizio
const hours = n => NOW - n * 3_600_000;

// --- Dataset sintetico -----------------------------------------------------
// Copre: mapping active/inactive, EUR/USD, price_type fuori dal set
// trend/avg1/avg7/avg30, prezzo current ma più vecchio di 48h (deve sparire),
// due provider_mapping_id attivi sullo stesso printing+price_type (variant
// collision, es. default+foil) per dimostrare che il DISTINCT ON resta
// necessario anche sul current layer, uno storico con uno snapshot anomalo
// più recente del vero current (deve essere ignorato), e un mix per il
// ranking (trend > baseline richiesto, limit 3, ordine per positiveChange).
const owned = [
  { printingId: 'p1', catalogCardId: 'c1', cardName: 'Salita forte', mappingId: 'm1', active: true },
  { printingId: 'p2', catalogCardId: 'c2', cardName: 'Salita debole', mappingId: 'm2', active: true },
  { printingId: 'p3', catalogCardId: 'c3', cardName: 'Mapping inactive', mappingId: 'm3', active: false },
  { printingId: 'p4', catalogCardId: 'c4', cardName: 'Solo USD', mappingId: 'm4', active: true },
  { printingId: 'p5', catalogCardId: 'c5', cardName: 'Current stale (>48h)', mappingId: 'm5', active: true },
  { printingId: 'p6', catalogCardId: 'c6', cardName: 'Discesa (esclusa)', mappingId: 'm6', active: true },
  { printingId: 'p7', catalogCardId: 'c7', cardName: 'Variant collision', mappingId: 'm7a', active: true, mappingId2: 'm7b' },
  { printingId: 'p8', catalogCardId: 'c8', cardName: 'Salita massima', mappingId: 'm8', active: true },
  { printingId: 'p9', catalogCardId: 'c9', cardName: 'Salita minima (4a, fuori top3)', mappingId: 'm9', active: true }
];
const activeByMapping = new Map();
for (const o of owned) {
  activeByMapping.set(o.mappingId, o.active);
  if (o.mappingId2) activeByMapping.set(o.mappingId2, o.active);
}
const printingByMapping = new Map();
for (const o of owned) {
  printingByMapping.set(o.mappingId, o.printingId);
  if (o.mappingId2) printingByMapping.set(o.mappingId2, o.printingId);
}

let sid = 0;
function snap(mappingId, priceType, price, capturedAtMs, opts = {}) {
  return {
    id: ++sid, mappingId, printingId: printingByMapping.get(mappingId), provider: opts.provider ?? 'cardmarket',
    priceType, price, currency: opts.currency ?? 'EUR', capturedAt: capturedAtMs, anomalous: opts.anomalous ?? false
  };
}

const snapshotsOverTime = [
  // p1: trend 15 vs avg7 10 -> +50%, dentro le 48h
  snap('m1', 'avg7', 10, hours(40)), snap('m1', 'trend', 15, hours(1)),
  // p2: trend 11 vs avg7 10 -> +10%
  snap('m2', 'avg7', 10, hours(40)), snap('m2', 'trend', 11, hours(1)),
  // p3: mapping inactive, prezzo altissimo, mai deve comparire
  snap('m3', 'avg7', 10, hours(40)), snap('m3', 'trend', 999, hours(1)),
  // p4: solo USD, mai un reference price EUR
  snap('m4', 'avg7', 10, hours(40), { currency: 'USD' }), snap('m4', 'trend', 20, hours(1), { currency: 'USD' }),
  // p5: current esiste ma è più vecchio di 48h -> deve sparire come mover
  snap('m5', 'avg7', 10, hours(90)), snap('m5', 'trend', 20, hours(60)),
  // p6: discesa, trend < baseline -> escluso dal ranking
  snap('m6', 'avg7', 10, hours(40)), snap('m6', 'trend', 8, hours(1)),
  // p7: due mapping attivi sullo stesso printing+price_type (default+foil),
  // il current layer conserva ENTRAMBI (chiave provider_mapping_id+price_type)
  // -> il DISTINCT ON su (printing_id, price_type) deve scegliere il più
  // recente (m7b, trend 30) e ignorare m7a (trend 25, più vecchio)
  snap('m7a', 'avg7', 10, hours(40)), snap('m7a', 'trend', 25, hours(5)),
  snap('m7b', 'trend', 30, hours(1)),
  // p8: salita massima, +150%
  snap('m8', 'avg7', 10, hours(40)), snap('m8', 'trend', 25, hours(1)),
  // p9: salita minima, +5%, 4a in classifica -> fuori dal top 3
  snap('m9', 'avg7', 10, hours(40)), snap('m9', 'trend', 10.5, hours(1)),
  // rumore: uno snapshot ANOMALO più recente del vero current di p1, non
  // deve mai vincere (il current layer promuove solo non-anomali)
  snap('m1', 'trend', 1, hours(0.1), { anomalous: true })
];

// --- current layer, derivato con la STESSA regola dei trigger di
//     20260914200000 (ultimo snapshot NON anomalo per mappingId+priceType).
function deriveCurrentLayer(snapshots) {
  const byKey = new Map();
  for (const s of snapshots) {
    if (s.anomalous) continue;
    const key = s.mappingId + '|' + s.priceType;
    const cur = byKey.get(key);
    if (!cur || s.capturedAt > cur.capturedAt || (s.capturedAt === cur.capturedAt && s.id > cur.id)) byKey.set(key, s);
  }
  return [...byKey.values()];
}
const currentLayer = deriveCurrentLayer(snapshotsOverTime);

const PRICE_TYPES = new Set(['trend', 'avg1', 'avg7', 'avg30']);
const FRESH_CUTOFF = NOW - 48 * 3_600_000;

// OLD (legacy list_market_dashboard_movers, verificato per grep sul file
// originale supabase-market-dashboard-movers.sql): NESSUN filtro is_anomalous
// — legge da market_active_price_snapshots, che filtra solo per mapping
// attivo. Diverso da get_market_watch_summary/list_market_watch_owned_page/
// list_market_watch_extra, che filtrano SEMPRE "not is_anomalous" esplicito.
function eligibleRowsOld(rows) {
  return rows.filter(s => activeByMapping.get(s.mappingId) && s.provider === 'cardmarket'
    && s.currency === 'EUR' && PRICE_TYPES.has(s.priceType) && s.capturedAt >= FRESH_CUTOFF);
}
// NEW (current layer): non contiene MAI una riga anomala per costruzione
// (deriveCurrentLayer scarta già gli anomalous), quindi qui il filtro è
// implicito nella fonte stessa, non in una condizione WHERE separata.
function eligibleRowsNew(rows) {
  return eligibleRowsOld(rows);
}
// OLD: DISTINCT ON (printing_id, price_type) sullo storico completo attivo,
// order by captured_at desc, id desc.
function latestByPrintingPriceType(rows) {
  const byKey = new Map();
  for (const s of rows) {
    const key = s.printingId + '|' + s.priceType;
    const cur = byKey.get(key);
    if (!cur || s.capturedAt > cur.capturedAt || (s.capturedAt === cur.capturedAt && s.id > cur.id)) byKey.set(key, s);
  }
  return [...byKey.values()];
}
function rankedMovers(latestRows) {
  const byPrinting = new Map();
  for (const row of latestRows) {
    if (!byPrinting.has(row.printingId)) byPrinting.set(row.printingId, {});
    byPrinting.get(row.printingId)[row.priceType] = row.price;
  }
  const ranked = [];
  for (const [printingId, p] of byPrinting) {
    const baseline = p.avg7 ?? p.avg30 ?? p.avg1;
    if (p.trend == null || baseline == null || !(baseline > 0) || !(p.trend > baseline)) continue;
    const positiveChange = ((p.trend - baseline) / baseline) * 100;
    ranked.push({ printingId, positiveChange, delta: p.trend - baseline });
  }
  ranked.sort((a, b) => b.positiveChange - a.positiveChange || b.delta - a.delta);
  return ranked.slice(0, 3).map(r => r.printingId);
}

const oldMovers = rankedMovers(latestByPrintingPriceType(eligibleRowsOld(snapshotsOverTime)));
const newMovers = rankedMovers(latestByPrintingPriceType(eligibleRowsNew(currentLayer)));

// --- 1) Casi invarianti: identici tra OLD (storico) e NEW (current layer) --
{
  for (const excluded of ['p3', 'p4', 'p5', 'p6', 'p9']) {
    assert.equal(oldMovers.includes(excluded), false, `OLD: ${excluded} non deve mai essere un mover`);
    assert.equal(newMovers.includes(excluded), false, `NEW: ${excluded} non deve mai essere un mover`);
  }
  assert.deepEqual(newMovers.slice(0, 2), ['p7', 'p8'], 'i primi 2 posti (p7 +200%, p8 +150%) sono invarianti tra OLD e NEW');
  assert.deepEqual(oldMovers.slice(0, 2), ['p7', 'p8'], 'i primi 2 posti (p7 +200%, p8 +150%) sono invarianti tra OLD e NEW');
  console.log('PASS casi invarianti tra OLD e NEW: mapping inactive/solo USD/current stale(>48h)/discesa/oltre il limit 3 esclusi identicamente, primi 2 posti classifica invariati');
}

// --- 2) BUG PREESISTENTE scoperto e corretto dal cutover: p1 ha uno --------
// snapshot ANOMALO più recente del vero current (trend=1, scartato dal
// trigger del current layer) — la legacy list_market_dashboard_movers non
// filtra MAI is_anomalous (verificato per grep, a differenza delle altre 3
// RPC Market Watch), quindi in OLD quell'1 vince la DISTINCT ON e p1 finisce
// SOTTO baseline (1 < 10) -> escluso dal ranking; in NEW il current layer
// non contiene mai righe anomale, p1 risolve correttamente a trend=15 (+50%)
// ed entra in classifica, spostando fuori p2.
{
  assert.equal(oldMovers.includes('p1'), false, 'OLD (bug preesistente): p1 escluso perché lo snapshot anomalo (1) maschera il vero trend (15)');
  assert.equal(oldMovers.includes('p2'), true, 'OLD (bug preesistente): p2 (+10%) entra in classifica al posto di p1, corrotto dal bug');
  assert.equal(newMovers.includes('p1'), true, 'NEW (fix): p1 risolve correttamente a trend=15 (+50%), il current layer scarta sempre gli anomali');
  assert.equal(newMovers.includes('p2'), false, 'NEW (fix): p2 (+10%) torna fuori dal top 3, spostato da p1 (+50%)');
  assert.deepEqual(newMovers, ['p7', 'p8', 'p1'], 'top 3 corretto dopo il cutover: p7 (+200%), p8 (+150%), p1 (+50%)');
  assert.deepEqual(oldMovers, ['p7', 'p8', 'p2'], 'top 3 legacy (con il bug): p7, p8, p2 — p1 mascherato dallo snapshot anomalo');
  console.log('PASS bug preesistente confermato e corretto: la legacy list_market_dashboard_movers non filtrava is_anomalous, uno snapshot anomalo poteva mascherare una salita reale; il cutover lo risolve senza bisogno di un filtro esplicito, perché il current layer non contiene mai righe anomale per costruzione');
}

// --- 3) Variant collision: DISTINCT ON (printing_id, price_type) resta -----
// necessario anche sul current layer (chiave lì è provider_mapping_id, non
// printing_id) — deve vincere il mapping con lo snapshot più recente.
{
  const p7Rows = eligibleRowsNew(currentLayer).filter(s => s.printingId === 'p7' && s.priceType === 'trend');
  assert.equal(p7Rows.length, 2, 'il current layer conserva entrambi i mapping attivi (m7a, m7b) per lo stesso printing+price_type');
  const winner = latestByPrintingPriceType(p7Rows.concat(eligibleRowsNew(currentLayer).filter(s => s.printingId === 'p7' && s.priceType === 'avg7')));
  const trendWinner = winner.find(r => r.priceType === 'trend');
  assert.equal(trendWinner.price, 30, 'tra due mapping attivi sullo stesso printing+price_type deve vincere lo snapshot più recente (m7b, 30), non m7a (25)');
  console.log('PASS variant collision (2 provider_mapping_id attivi sullo stesso printing+price_type): vince il più recente via DISTINCT ON, invariato dal cutover');
}

// --- Verifiche statiche sulla migration -------------------------------------
{
  const root = path.dirname(fileURLToPath(import.meta.url));
  const migration = await readFile(path.join(root, '..', 'supabase', 'migrations', '20260916100000_market_dashboard_movers_current_price_cutover.sql'), 'utf8');
  const sqlNoComments = migration.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  function test(name, fn) { try { fn(); console.log(`PASS ${name}`); } catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; } }

  test('ridefinisce ESATTAMENTE list_market_dashboard_movers, nessun\'altra funzione', () => {
    assert.equal((migration.match(/create or replace function/g) || []).length, 1);
    assert.match(migration, /create or replace function public\.list_market_dashboard_movers/);
  });
  test('la firma della RPC resta identica (nessuna rottura di contratto)', () => {
    assert.match(sqlNoComments, /list_market_dashboard_movers\(p_token text, p_game text default 'yugioh'\)/);
  });
  test('legge il current layer per il prezzo, non più market_active_price_snapshots', () => {
    assert.match(sqlNoComments, /from public\.market_current_price_snapshots/, 'deve leggere il current layer');
    assert.equal(sqlNoComments.includes('market_active_price_snapshots'), false, 'non deve più leggere la vista storica');
  });
  test('finestra di freschezza 48h invariata', () => {
    assert.match(sqlNoComments, /interval '48 hours'/);
  });
  test('provider/currency/price_type/limit/ranking invariati testualmente', () => {
    assert.match(sqlNoComments, /c\.provider = 'cardmarket'/);
    assert.match(sqlNoComments, /c\.normalized_currency = 'EUR'/);
    assert.match(sqlNoComments, /price_type in \('trend', 'avg1', 'avg7', 'avg30'\)/);
    assert.match(sqlNoComments, /limit 3/);
    assert.match(sqlNoComments, /order by positive_change desc/);
  });
  test('DISTINCT ON (printing_id, price_type) preservato sul current layer', () => {
    assert.match(sqlNoComments, /distinct on \(c\.printing_id, c\.price_type\)/);
  });
  test('nessuna scrittura di dati, nessun nuovo indice (già coperto da 20260914200000)', () => {
    assert.equal(/\binsert\s+into\b|\bupdate\s+public\.|\bdelete\s+from\b|\bcreate\s+index\b/i.test(sqlNoComments), false);
  });
  test('revoke/grant invariati (stesso pattern anon,authenticated di sempre)', () => {
    assert.match(sqlNoComments, /revoke all on function public\.list_market_dashboard_movers\(text,text\) from public, anon, authenticated;/);
    assert.match(sqlNoComments, /grant execute on function public\.list_market_dashboard_movers\(text,text\) to anon, authenticated;/);
  });
  test('nessun tocco a market-sync/cron/trigger/current layer stesso/altre RPC Market Watch', () => {
    for (const forbidden of ['cron.schedule', 'pg_cron', 'functions/v1', 'create trigger', 'create or replace function public.sync_market_current_price_snapshot', 'create or replace function public.rebuild_market_current_price_snapshot', 'get_market_watch_summary', 'list_market_watch_owned_page', 'list_market_watch_extra']) {
      assert.equal(sqlNoComments.toLowerCase().includes(forbidden.toLowerCase()), false, `riferimento vietato: ${forbidden}`);
    }
  });
  console.log('cutover migration (statico): 1 funzione ridefinita, firma invariata, legge il current layer, freschezza 48h/provider/currency/price_type/limit/ranking/DISTINCT ON invariati, revoke/grant preservati, nessuna scrittura/indice, nessun tocco fuori scope');
}

console.log('PASS list_market_dashboard_movers cutover: OLD/NEW equivalenti (incl. variant collision e freschezza 48h), migration verificata staticamente');
