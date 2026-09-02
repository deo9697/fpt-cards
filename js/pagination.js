export const POSTGREST_PAGE_SIZE = 500;
export const POSTGREST_MAX_ROWS = 20000;

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
  for (let from = 0; from <= maxRows; from += pageSize) {
    const to = from + pageSize - 1;
    const page = await fetchPage(from, to, requests);
    if (!Array.isArray(page)) throw new Error(`${resource}: risposta paginata non valida`);
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
  const initial = client.rpc(name, args);
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
    return result.data || [];
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
