// Controllo giornaliero dei set Yu-Gi-Oh! appena usciti (2026-10-24, dopo il
// caso Beyond the Brave: set uscito dopo il riempimento del catalogo, Fast
// Scan cieca). Ogni giorno, per i set usciti negli ultimi `days` giorni:
//   1. confronta i codici che YGOResources conosce (EN/IT/FR/DE/SP/PT) con
//      quelli in card_printings;
//   2. se ne mancano, aggiunge solo le stampe confermate da più fonti
//      (regole in plan.ts), con insert idempotente;
//   3. scrive l'esito in catalog_auto_sync_runs.
// Chiamata dal cron catalog-new-sets-daily con x-market-sync-secret.
// Body opzionale: { dryRun?: boolean, sets?: string[], days?: number, maxSets?: number }.
import { planNewSet, missingCodes, unlistedEnglishNumbers, konamiIdsByName, identityKey, LANGUAGES, type Row } from './plan.ts';
import { fetchKonamiCardPage } from '../_shared/konami.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const syncSecret = Deno.env.get('MARKET_SYNC_SECRET') || '';
const YGO = 'https://db.ygoprodeck.com/api/v7';
const YGORES = 'https://db.ygoresources.com';
const UA = { 'user-agent': 'Mozilla/5.0 (F.P.T Cards catalog sync)' };
const SET_CODE = /^[A-Z0-9]{2,5}$/;

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!supabaseUrl || !serviceKey || !syncSecret) return json({ error: 'backend_not_configured' }, 503);
  if (request.headers.get('x-market-sync-secret') !== syncSecret) return json({ error: 'unauthorized' }, 401);
  const body = await request.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const days = Math.min(Math.max(Number(body?.days) || 120, 1), 730);
  const maxSets = Math.min(Math.max(Number(body?.maxSets) || 4, 1), 10);
  const started = Date.now();
  const report: Record<string, unknown>[] = [];
  let inserted = 0, status = 'ok', errorMessage = '';
  try {
    const sets = await candidateSets(Array.isArray(body?.sets) ? body.sets : null, days);
    let filled = 0, nameIndex: Map<string, Set<string>> | null = null;
    for (const { code: set, name: setName } of sets) {
      const printcodes = await fetchPrintcodes(set);
      if (!Object.keys(printcodes).length) { report.push({ set, status: 'not_in_ygoresources' }); continue; }
      const existingRows = await existingPrintings(set);
      const missing = missingCodes(set, printcodes, new Set(existingRows.map(row => row.set_code)));
      if (!missing.length) { report.push({ set, status: 'complete' }); continue; }
      if (filled >= maxSets) { report.push({ set, status: 'deferred', missing: missing.length }); continue; }
      filled++;
      nameIndex ??= konamiIdsByName(await getJson(`${YGORES}/data/idx/card/name/en`, 20000));
      const ygoCards = (await getJson(`${YGO}/cardinfo.php?cardset=${encodeURIComponent(setName)}`).catch(() => ({ data: [] })))?.data || [];
      const extras = await resolveExtras(set, ygoCards, printcodes);
      const labels = [...new Set([...ygoCards.flatMap((card: any) => (card.card_sets || []).filter((row: any) => String(row.set_code || '').toUpperCase().startsWith(`${set}-EN`)).map((row: any) => String(row.set_rarity || '').trim())), ...Object.values(extras).flatMap(extra => extra.rarities)])];
      const allowedRarities = await canonicalRarities(labels);
      const existing = new Set(existingRows.map(identityKey));
      let plan = planNewSet({ set, setName, ygoCards, printcodes, namesToKonami: nameIndex, existing, allowedRarities, extras });
      // YGOPRODeck con sole etichette non valide ("2", "3", "New"…) su un
      // codice: rarità dalla scheda Konami, poi stesso piano (stesse verifiche).
      if (await addKonamiRarities(set, ygoCards, printcodes, plan, extras, allowedRarities)) plan = planNewSet({ set, setName, ygoCards, printcodes, namesToKonami: nameIndex, existing, allowedRarities, extras });
      if (!dryRun && plan.rows.length) await insertRows(plan.rows);
      if (!dryRun) inserted += plan.rows.length;
      const byLanguage = Object.fromEntries(LANGUAGES.map(language => [language, plan.rows.filter(row => row.set_code.startsWith(`${set}-${language}`)).length]).filter(([, count]) => count));
      report.push({ set, setName, status: dryRun ? 'planned' : 'filled', missingBefore: missing.length, newRows: plan.rows.length, byLanguage, sample: plan.rows.filter((_, index) => index % Math.max(1, Math.floor(plan.rows.length / 4)) === 0).slice(0, 4).map(row => `${row.set_code} ${row.rarity} · ${row.card_name}`), issues: plan.issues.slice(0, 40), issueCount: plan.issues.length });
    }
  } catch (error) {
    status = 'error'; errorMessage = String((error as Error)?.message || error).slice(0, 500);
  }
  const summary = { ok: status === 'ok', dryRun, days, insertedRows: inserted, durationMs: Date.now() - started, sets: report, error: errorMessage || undefined };
  console.log(JSON.stringify({ event: 'catalog_new_sets', ...summary, sets: report.filter(item => item.status !== 'complete') }));
  if (!dryRun) await logRun(status, inserted, summary).catch(() => {});
  return json(summary, status === 'ok' ? 200 : 500);
});

async function candidateSets(requested: string[] | null, days: number) {
  const all = await getJson(`${YGO}/cardsets.php`);
  const today = new Date().toISOString().slice(0, 10), since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const wanted = requested?.map(code => String(code).toUpperCase()).filter(code => SET_CODE.test(code));
  const seen = new Map<string, { code: string, name: string }>();
  for (const row of all || []) {
    const code = String(row.set_code || '').toUpperCase(), date = String(row.tcg_date || '');
    if (!SET_CODE.test(code) || seen.has(code)) continue;
    if (wanted ? wanted.includes(code) : (date >= since && date <= today)) seen.set(code, { code, name: String(row.set_name || '') });
  }
  return [...seen.values()];
}

async function fetchPrintcodes(set: string) {
  const entries = await Promise.all(LANGUAGES.map(async language => {
    const response = await fetch(`${YGORES}/data/idx/printcode/${encodeURIComponent(`${set}-${language}`)}`, { headers: UA, signal: AbortSignal.timeout(10000) });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`ygoresources_${response.status}`); }
    return [language, await response.json()] as const;
  }));
  return Object.fromEntries(entries.filter(Boolean) as [string, Record<string, number>][]);
}

// Stampe del registro che YGOPRODeck non elenca nel set (es. BETB-ENSP1):
// nome dall'id Konami, carta YGOPRODeck per nome esatto, rarità dalla scheda Konami.
async function resolveExtras(set: string, ygoCards: any[], printcodes: Record<string, Record<string, number | string>>) {
  const extras: Record<string, { card: any, rarities: string[] }> = {};
  for (const number of unlistedEnglishNumbers(set, ygoCards, printcodes).slice(0, 10)) {
    try {
      const konamiId = String(printcodes.EN[number]);
      const data = await getJson(`${YGORES}/data/card/${encodeURIComponent(konamiId)}`);
      const name = data?.cardData?.en?.name || data?.cardData?.ae?.name;
      if (!name) continue;
      const card = (await getJson(`${YGO}/cardinfo.php?name=${encodeURIComponent(name)}`).catch(() => null))?.data?.[0];
      if (!card) continue;
      const page = await fetchKonamiCardPage(konamiId, `${set}-EN${number}`);
      if (page.rarities.length) extras[number] = { card, rarities: page.rarities };
    } catch { /* resta nel report come numero non verificato */ }
  }
  return extras;
}

async function addKonamiRarities(set: string, ygoCards: any[], printcodes: Record<string, Record<string, number | string>>, plan: { rows: Row[], issues: { code: string, reason: string }[] }, extras: Record<string, { card: any, rarities: string[] }>, allowedRarities: Set<string>) {
  const covered = new Set(plan.rows.map(row => row.set_code));
  const codes = [...new Set(plan.issues.filter(issue => issue.reason.startsWith('rarità') && !covered.has(issue.code)).map(issue => issue.code))].slice(0, 25);
  let added = false;
  for (const code of codes) {
    const number = code.slice(set.length + 3), konamiId = printcodes.EN?.[number];
    const card = ygoCards.find(item => (item.card_sets || []).some((row: any) => String(row.set_code || '').toUpperCase() === code));
    if (!konamiId || !card || extras[number]) continue;
    try {
      const page = await fetchKonamiCardPage(String(konamiId), code);
      const labels = page.rarities.filter(label => !allowedRarities.has(label));
      for (const label of (await canonicalRarities(labels))) allowedRarities.add(label);
      if (page.rarities.length) { extras[number] = { card, rarities: page.rarities }; added = true; }
    } catch { /* resta nel report */ }
  }
  return added;
}

async function canonicalRarities(labels: string[]) {
  const allowed = new Set<string>();
  await Promise.all(labels.filter(Boolean).map(async label => {
    const canonical = await rest('rpc/canonicalize_ygo_rarity_label', { method: 'POST', body: JSON.stringify({ p_rarity: label }) });
    if (canonical === label) allowed.add(label);
  }));
  return allowed;
}

async function existingPrintings(set: string) {
  const rows: { catalog_card_id: string, set_code: string, rarity: string, variant_id: string }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rest(`card_printings?select=catalog_card_id,set_code,rarity,variant_id&game=eq.yugioh&set_code=like.${encodeURIComponent(`${set}-*`)}&order=id&limit=1000&offset=${offset}`);
    rows.push(...page.map((row: any) => ({ ...row, variant_id: row.variant_id || '' })));
    if (page.length < 1000) return rows;
  }
}

async function insertRows(rows: Row[]) {
  for (let index = 0; index < rows.length; index += 500) {
    await rest('card_printings?on_conflict=game,catalog_card_id,set_code,rarity,variant_id', {
      method: 'POST', body: JSON.stringify(rows.slice(index, index + 500)),
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }
    });
  }
}

async function logRun(status: string, insertedRows: number, report: unknown) {
  await rest('catalog_auto_sync_runs', { method: 'POST', body: JSON.stringify({ status, inserted_rows: insertedRows, report }), headers: { Prefer: 'return=minimal' } });
}

async function rest(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init, signal: AbortSignal.timeout(20000),
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json', ...(init.headers || {}) }
  });
  if (!response.ok) throw new Error(`db_${response.status}: ${(await response.text()).slice(0, 200)}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function getJson(url: string, timeout = 15000) {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${response.status} ${new URL(url).host}`); }
  return response.json();
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
