// F.P.T Cards — One Piece Fase 3: catalog sync OPTCG -> card_printings.
// Deploy manualmente dopo aver applicato
// supabase/migrations/20260908190500_onepiece_deck_and_printing_foundation.sql
// (serve variant_id + la unique key card_printings_identity_key).
//
// Richiede un secret Vault ONEPIECE_CATALOG_SYNC_SECRET esposto come env var
// (stesso pattern di MARKET_SYNC_SECRET in market-sync/index.ts) e chiamate
// autenticate con l'header x-onepiece-catalog-sync-secret.
//
// La logica di normalizzazione pura vive in ./normalizer.mjs, non qui:
// quel file non usa nessuna API Deno, quindi è anche l'esatto modulo che
// scripts/onepiece-catalog-normalizer-smoke.mjs importa da Node per
// verificare gli esempi reali (OP01-001, P-017, EB01-003, don_183) senza
// toccare rete o DB. È un sibling in questa stessa cartella (non un '../'),
// quindi il bundler del Dashboard Supabase lo impacchetta senza problemi.
//
// OPTCG chiede di non fare un numero eccessivo di chiamate: questo sync ne
// fa 4 (5 se scatta il fallback promo), mai una per carta.
import { normalizeStandardCard, normalizeDonCard, identityKey, SOURCE_PROVIDER } from './normalizer.mjs';

const OPTCG_BASE = 'https://optcgapi.com/api';
const BATCH_SIZE = 400;
const FETCH_TIMEOUT_MS = 30_000;

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const syncSecret = Deno.env.get('ONEPIECE_CATALOG_SYNC_SECRET') || '';

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!supabaseUrl || !serviceKey) return json({ error: 'backend_not_configured' }, 503);
  if (!syncSecret) return json({ error: 'sync_secret_not_configured' }, 503);
  if (request.headers.get('x-onepiece-catalog-sync-secret') !== syncSecret) return json({ error: 'unauthorized' }, 401);

  const errors: string[] = [];

  const [setsRaw, starterRaw, donRaw] = await Promise.all([
    fetchBulk(`${OPTCG_BASE}/allSetCards/`, 'sets', errors),
    fetchBulk(`${OPTCG_BASE}/allSTCards/`, 'starter', errors),
    fetchBulk(`${OPTCG_BASE}/allDonCards/`, 'don', errors)
  ]);

  // La documentazione ufficiale OPTCG indica /allPromoCards/, ma
  // un'integrazione reale segnala /allPromos/ come quello davvero
  // funzionante oggi: proviamo prima quest'ultimo, con fallback sull'altro.
  let promoRaw: any[] = [];
  let promoEndpoint = '';
  try {
    promoRaw = await fetchBulkOrThrow(`${OPTCG_BASE}/allPromos/`);
    promoEndpoint = 'allPromos';
  } catch (primaryError) {
    try {
      promoRaw = await fetchBulkOrThrow(`${OPTCG_BASE}/allPromoCards/`);
      promoEndpoint = 'allPromoCards';
    } catch (fallbackError) {
      errors.push(`promos: allPromos (${errorMessage(primaryError)}) e allPromoCards (${errorMessage(fallbackError)}) entrambi falliti`);
    }
  }

  const fetched = { sets: setsRaw.length, starter: starterRaw.length, promos: promoRaw.length, don: donRaw.length };
  const nowIso = new Date().toISOString();

  let normalized = 0, skipped = 0;
  const unique = new Map<string, Record<string, unknown>>();

  for (const raw of [...setsRaw, ...starterRaw, ...promoRaw]) {
    const row = normalizeStandardCard(raw, nowIso);
    if (!row) { skipped++; continue; }
    normalized++;
    // L'ultimo che arriva vince: se la stessa identità comparisse sia nei
    // set/starter sia tra i promo (non atteso, ma non impossibile), non
    // vogliamo comunque due righe con la stessa chiave nello stesso batch
    // upsert — Postgres rifiuterebbe l'intero INSERT con "ON CONFLICT DO
    // UPDATE command cannot affect row a second time".
    unique.set(identityKey(row as any), row);
  }
  for (const raw of donRaw) {
    const row = normalizeDonCard(raw, nowIso);
    if (!row) { skipped++; continue; }
    normalized++;
    unique.set(identityKey(row as any), row);
  }

  const rows = [...unique.values()];
  let upserted = 0;
  try {
    upserted = await upsertCardPrintings(rows);
  } catch (error) {
    errors.push(`upsert: ${errorMessage(error)}`);
  }

  return json({
    ok: errors.length === 0,
    source: SOURCE_PROVIDER,
    promoEndpoint,
    fetched,
    normalized,
    unique: rows.length,
    upserted,
    skipped,
    errors
  });
});

async function fetchBulk(url: string, label: string, errors: string[]): Promise<any[]> {
  try {
    return await fetchBulkOrThrow(url);
  } catch (error) {
    errors.push(`${label}: ${errorMessage(error)}`);
    return [];
  }
}

async function fetchBulkOrThrow(url: string): Promise<any[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error('risposta non è un array JSON');
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Upsert via PostgREST puro (stesso stile di rest()/headers() in
// market-sync/index.ts): il service role bypassa RLS, quindi non serve
// nessuna nuova grant lato DB per questa function. on_conflict elenca
// esattamente le colonne di card_printings_identity_key — nessuna delete,
// mai: un problema temporaneo di OPTCG non deve poter cancellare il
// catalogo locale già sincronizzato (Fase 3.8).
async function upsertCardPrintings(rows: Record<string, unknown>[]): Promise<number> {
  let upserted = 0;
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    if (!batch.length) continue;
    const response = await fetch(
      `${supabaseUrl}/rest/v1/card_printings?on_conflict=game,catalog_card_id,set_code,rarity,variant_id`,
      { method: 'POST', headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(batch) }
    );
    if (!response.ok) throw new Error(`batch ${Math.floor(index / BATCH_SIZE) + 1}: HTTP ${response.status} ${await response.text()}`);
    upserted += batch.length;
  }
  return upserted;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function headers() {
  return { 'content-type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
