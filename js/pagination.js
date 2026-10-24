export const POSTGREST_PAGE_SIZE = 500;
export const POSTGREST_MAX_ROWS = 20000;
const PARALLEL_PAGES = 3;

const metrics = new Map();

export async function collectPages(fetchPage, {
  resource = 'resource',
  pageSize = POSTGREST_PAGE_SIZE,
  maxRows = POSTGREST_MAX_ROWS,
  key = row => row?.id
} = {}) {
  const startedAt = now();
  const rows = [];
  const seen = new Set();
  let requests = 0;
  let payloadBytes = 0;
  // Pagine in parallelo quando il totale è noto (2026-10-24): la Raccolta del
  // team (3.600+ righe) erano 8 richieste in fila da ~200 ms di server + rete.
  // Se la prima pagina riporta `total` (count di PostgREST, calcolato sulla
  // stessa query), le pagine successive fino al totale partono subito, al
  // massimo PARALLEL_PAGES alla volta, senza richieste oltre l'ultima. Senza
  // `total` il comportamento resta quello di prima: una pagina dopo l'altra.
  // Le pagine si elaborano comunque in ordine, con gli stessi controlli.
  const pending = new Map();
  const request = from => {
    if (!pending.has(from)) pending.set(from, Promise.resolve().then(() => fetchPage(from, from + pageSize - 1, from / pageSize)));
    return pending.get(from);
  };
  let knownTotal = null;
  for (let from = 0; from <= maxRows; from += pageSize) {
    if (knownTotal !== null) for (let ahead = from; ahead < Math.min(knownTotal, from + PARALLEL_PAGES * pageSize, maxRows + 1); ahead += pageSize) request(ahead).catch(() => {});
    const page = await request(from);
    pending.delete(from);
    if (!Array.isArray(page)) throw new Error(`${resource}: risposta paginata non valida`);
    if (from === 0 && Number.isFinite(page.total) && page.total >= 0) knownTotal = page.total;
    requests += 1;
    payloadBytes += byteLength(page);
    if (from === maxRows && page.length) throw new Error(`${resource}: limite massimo di sicurezza superato`);
    for (const row of page) {
      const identity = key(row);
      if (identity == null || identity === '') throw new Error(`${resource}: identità riga mancante`);
      const normalized = String(identity);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      rows.push(row);
      if (rows.length > maxRows) throw new Error(`${resource}: limite massimo di sicurezza superato`);
    }
    if (page.length < pageSize) {
      metrics.set(resource, { resource, rows:rows.length, requests, payloadBytes, durationMs:Math.round((now()-startedAt)*10)/10, pageSize });
      return rows;
    }
  }
  throw new Error(`${resource}: limite massimo di sicurezza raggiunto`);
}

export async function pagedRpc(client, name, args, {
  signal,
  orders = [],
  key = row => row?.id,
  pageSize = POSTGREST_PAGE_SIZE,
  maxRows = POSTGREST_MAX_ROWS
} = {}) {
  // count:'exact' sulla prima pagina: PostgREST conta sulla stessa query
  // (Content-Range), così collectPages può chiedere le altre pagine in parallelo.
  const initial = client.rpc(name, args, { count:'exact' });
  // Compatibilità con i mock legacy: in produzione supabase-js restituisce il builder PostgREST.
  if (typeof initial?.range !== 'function') {
    const result = await initial;
    if (result?.error) throw result.error;
    return result?.data;
  }
  return collectPages(async (from, to, pageIndex) => {
    let query = pageIndex === 0 ? initial : client.rpc(name, args);
    for (const order of orders) query = query.order(order.column, { ascending:order.ascending !== false, nullsFirst:order.nullsFirst });
    query = query.range(from, to);
    if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal);
    const result = await query;
    if (result.error) {
      const error = new Error(`${name}: pagina ${pageIndex+1}: ${result.error.message || result.error.code || 'errore PostgREST'}`);
      error.code = result.error.code;
      throw error;
    }
    const data = result.data || [];
    if (pageIndex === 0 && Number.isFinite(result.count)) data.total = result.count;
    return data;
  }, { resource:name, pageSize, maxRows, key });
}

export function paginationMetrics(resource) {
  const value = metrics.get(resource);
  return value ? { ...value } : null;
}

function byteLength(value) {
  const text = JSON.stringify(value);
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).byteLength : text.length;
}

function now() { return globalThis.performance?.now?.() ?? Date.now(); }
