// Nomi localizzati delle carte Yu-Gi-Oh! (2026-11-21).
// YGOPRODeck ha il nome italiano solo per una parte delle carte recenti
// (es. Magnificent Maestros: 40 su 124), quindi "Angelechy Arruolato" non
// trovava nulla. YGOResources ha l'indice completo dei nomi ufficiali Konami
// per lingua: nome localizzato -> id Konami -> nome inglese, che YGOPRODeck
// conosce sempre. Qui si scaricano i due indici (circa 1 MB, senza
// compressione: troppo per il telefono), si tengono in memoria e si
// restituiscono solo i nomi inglesi delle carte che corrispondono.
// GET /api/card-names?q=<testo>&lang=it  ->  { results: [{ name, english }] }
const SOURCE = 'https://db.ygoresources.com/data/idx/card/name';
const LANGUAGES = new Set(['it', 'fr', 'de', 'es', 'pt']);
const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_RESULTS = 40;
const indexes = new Map(); // lang -> { at, entries, pending }

export function normalizeCardName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`´-]/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

async function fetchIndex(lang) {
  const response = await fetch(`${SOURCE}/${lang}`, { headers: { 'user-agent': 'Mozilla/5.0 (F.P.T Cards name search)' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`ygoresources ${lang} ${response.status}`);
  const data = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`ygoresources ${lang} invalid`);
  return data;
}

/** Pure: builds [{ name, english, key }] from the two name -> [konamiId] indexes. */
export function buildEntries(localized, english) {
  const englishById = new Map();
  for (const [name, ids] of Object.entries(english || {})) for (const id of Array.isArray(ids) ? ids : []) if (!englishById.has(String(id))) englishById.set(String(id), name);
  const entries = [];
  for (const [name, ids] of Object.entries(localized || {})) {
    const englishNames = [...new Set((Array.isArray(ids) ? ids : []).map(id => englishById.get(String(id))).filter(Boolean))];
    for (const englishName of englishNames) if (englishName !== name) entries.push({ name, english: englishName, key: normalizeCardName(name) });
  }
  return entries;
}

/** Pure: every typed word must appear; exact > prefix > contains, then shorter names. */
export function searchEntries(entries, query, limit = MAX_RESULTS) {
  const wanted = normalizeCardName(query);
  const words = wanted.split(' ').filter(word => word.length >= 2);
  if (wanted.length < 3 || !words.length) return [];
  const scored = [];
  for (const entry of entries) {
    if (!words.every(word => entry.key.includes(word))) continue;
    const score = entry.key === wanted ? 3 : entry.key.startsWith(wanted) ? 2 : entry.key.includes(wanted) ? 1 : 0;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.key.length - b.entry.key.length || a.entry.name.localeCompare(b.entry.name));
  const seen = new Set(), results = [];
  for (const { entry } of scored) {
    if (seen.has(entry.english)) continue;
    seen.add(entry.english); results.push({ name: entry.name, english: entry.english });
    if (results.length >= limit) break;
  }
  return results;
}

async function entriesFor(lang) {
  const current = indexes.get(lang);
  if (current?.entries && Date.now() - current.at < TTL_MS) return current.entries;
  if (current?.pending) return current.pending;
  const pending = Promise.all([fetchIndex(lang), fetchIndex('en')])
    .then(([localized, english]) => { const entries = buildEntries(localized, english); indexes.set(lang, { at: Date.now(), entries }); return entries; })
    .catch(error => { if (current?.entries) { indexes.set(lang, { ...current, pending: null }); return current.entries; } indexes.delete(lang); throw error; });
  indexes.set(lang, { ...(current || {}), pending });
  return pending;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const lang = String(req.query?.lang || 'it').toLowerCase();
  const query = String(req.query?.q || '').slice(0, 80);
  if (!LANGUAGES.has(lang)) return res.status(400).json({ error: 'unsupported_language' });
  if (normalizeCardName(query).length < 3) return res.status(200).json({ results: [] });
  try {
    const results = searchEntries(await entriesFor(lang), query);
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
    return res.status(200).json({ results });
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'names_unavailable', results: [] });
  }
}
