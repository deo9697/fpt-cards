// Yu-Gi-Oh! Printing Registry — risolutore centrale CARD/PRINTING/ARTWORK.
//
// Prima di questo modulo, FPT derivava l'artwork di una stampa specifica dal
// primo elemento di card_images[] restituito da YGOPRODeck (vedi mapCard() in
// js/cards.js), che non è un dato per-printing: l'ordine dell'array non ha
// alcuna relazione garantita con un set_code preciso. Questo modulo inverte
// la fonte: l'identità parte dal set_code, non dal nome carta, e usa
// YGOResources (Konami database) come unica fonte per set_code -> artwork.
// YGOPRODeck resta usato SOLO per metadata di gioco (nome esatto -> catalog id
// YGOPRODeck, tipo, ATK/DEF, ecc.), mai per decidere quale artwork appartiene
// a quale stampa.
//
// Pipeline (batch, mai una richiesta remota per carta):
//   normalizeSetCode
//     -> registry locale (Supabase: ygo_printing_registry + ygo_printing_overrides)
//        -- override verificato o riga già verified/resolved: RETURN, nessuna rete.
//     -> YGOResources /data/idx/printcode/<SET>-<LOCALE> (per prefisso di set,
//        deduplicato: 200 carte di poche decine di set = poche richieste)
//     -> Konami card ID
//     -> ygo_artwork_index locale (mai il manifest artwork da 21MB lato client:
//        sincronizzato offline da scripts/ygo-artwork-index-sync.mjs)
//        -- 1 solo artwork noto: deterministico, mapping_status='resolved'
//        -- 0 o >1 artwork: ambiguo, mapping_status='unresolved', MAI un guess
//     -> nome carta (da YGOResources /data/card/<id>) -> ricerca ESATTA per
//        nome su YGOPRODeck per ottenere catalogCardId + metadata di gioco
//        (non è fuzzy matching: il nome viene da Konami, non da OCR)
//     -> salva il mapping (apply_ygo_printing_mappings), mai un override di
//        una riga già 'verified'.
//
// Se YGOResources non è raggiungibile, il resolver non blocca né inventa: le
// printing già note restano disponibili (registry locale), le nuove restano
// 'unresolved' finché una connessione o un override manuale non le risolve.

// api è iniettabile (default: il singleton reale) per lo stesso motivo per
// cui FastScanController/DeckController/MarketWatchController lo ricevono
// via costruttore invece di importarlo: permette ai test di sostituirlo con
// un fake senza toccare window/Supabase.
import { api as defaultApi } from './api.js';
import { findCard, lookupPrintingBySetCode } from './cards.js';

const YGORESOURCES_BASE = 'https://db.ygoresources.com';
const FETCH_TIMEOUT_MS = 6000;
const PRINT_CODE_PATTERN = /^([A-Z0-9-]{1,6})-([A-Z]{0,2})([0-9A-Z]{0,4})$/;

// Cache di sessione (non persistita): evita di richiedere due volte lo stesso
// nome Konami o lo stesso prefisso di set nella stessa apertura dell'app.
const konamiNameCache = new Map();
const inFlightPrefixes = new Map();

export function normalizeSetCode(raw) {
  return trimDashes(String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-'));
}

function trimDashes(value) { return value.replace(/^-+/, '').replace(/-+$/, ''); }

// Replica SplitPrintCode di YGOResources (db.ygoresources.com/js/shared.js):
// un set code diventa "<SET>-<LOCALE>" (chiave del loro indice) + numero di
// stampa. I codici storici senza marker lingua (es. "MIP-1010") producono un
// prefisso con locale vuoto: la richiesta risulterà quasi certamente
// not_found, che è il comportamento corretto (nessuna fonte automatica li
// conosce) — vedi l'override MIP-1010 nella migration.
export function splitPrintCode(normalizedCode) {
  const match = PRINT_CODE_PATTERN.exec(normalizedCode);
  if (!match) return null;
  let [, set, locale, printNumber] = match;
  if (locale === 'JA') locale = 'JP';
  if (!printNumber) return null;
  return { prefix: `${set}-${locale}`, printNumber };
}

function unresolved(setCode, notes = '') {
  return {
    printingId: '', game: 'yugioh', catalogCardId: '', cardName: '', setCode, setName: '', rarity: '',
    imageUrl: '', warning: '',
    konamiCardId: '', artworkIndex: '', mappingSource: '', mappingConfidence: '',
    mappingStatus: 'unresolved', mappingNotes: notes
  };
}

function logResolution(entry) {
  // Nessun dato utente: solo identificatori di catalogo pubblici.
  const { status, ...rest } = entry;
  if (status === 'conflict') console.warn('[ygo-printing-registry] conflict', rest);
  else console.info('[ygo-printing-registry] resolved', { status, ...rest });
}

async function fetchJson(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 404) return { ok: true, status: 404, data: null };
    if (!response.ok) return { ok: false, status: response.status, data: null };
    return { ok: true, status: response.status, data: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || 'network error', data: null };
  } finally { clearTimeout(timer); }
}

async function fetchPrintcodePrefix(prefix) {
  if (inFlightPrefixes.has(prefix)) return inFlightPrefixes.get(prefix);
  const request = (async () => {
    const result = await fetchJson(`${YGORESOURCES_BASE}/data/idx/printcode/${encodeURIComponent(prefix)}`);
    if (!result.ok) return { status: 'error', entries: null, error: result.error || `HTTP ${result.status}` };
    if (result.status === 404 || !result.data) return { status: 'not_found', entries: new Map() };
    const entries = new Map(Object.entries(result.data).map(([printNumber, konamiCardId]) => [printNumber, String(konamiCardId)]));
    return { status: 'ok', entries };
  })();
  inFlightPrefixes.set(prefix, request);
  try { return await request; } finally { inFlightPrefixes.delete(prefix); }
}

async function fetchKonamiCardName(konamiCardId) {
  if (konamiNameCache.has(konamiCardId)) return konamiNameCache.get(konamiCardId);
  const request = (async () => {
    const result = await fetchJson(`${YGORESOURCES_BASE}/data/card/${encodeURIComponent(konamiCardId)}`);
    if (!result.ok || !result.data) return '';
    // "ae" (English, sempre presente per carte TCG) prima, poi la prima
    // localizzazione disponibile — solo per ottenere il nome esatto da usare
    // nella ricerca YGOPRODeck, mai per decidere l'artwork.
    const locales = result.data.cardData || {};
    return locales.ae?.name || locales.en?.name || Object.values(locales)[0]?.name || '';
  })();
  konamiNameCache.set(konamiCardId, request);
  return request;
}

function precedenceResult(setCode, row) {
  if (!row) return null;
  if (row.override_konami_card_id) {
    return {
      konamiCardId: row.override_konami_card_id, artworkIndex: row.override_artwork_index || '',
      artworkUrl: row.override_artwork_url || '', cardName: row.registry_card_name || '',
      mappingSource: 'override', mappingConfidence: 'high', mappingStatus: 'verified'
    };
  }
  if (row.registry_mapping_status === 'verified' || row.registry_mapping_status === 'resolved') {
    return {
      konamiCardId: row.registry_konami_card_id || '', artworkIndex: row.registry_artwork_index || '',
      artworkUrl: row.registry_artwork_url || '', cardName: row.registry_card_name || '',
      mappingSource: row.registry_mapping_source || '', mappingConfidence: row.registry_mapping_confidence || '',
      mappingStatus: row.registry_mapping_status
    };
  }
  return null;
}

// Da un risultato del registro (konamiCardId + artwork noti) a un oggetto
// printing pronto per il salvataggio in card_printings — richiede una ricerca
// ESATTA per nome su YGOPRODeck (non fuzzy: il nome arriva da Konami) per
// ottenere il catalogCardId YGOPRODeck, che resta l'id usato da
// collection_items/deck_cards/market_provider_printings. Rarità e set_name
// sono metadata di gioco legittimi da YGOPRODeck (mai l'artwork): li
// recuperiamo dal suo endpoint per-set-code esatto, ma solo se conferma la
// STESSA identità carta trovata dal registro — altrimenti il registro
// (verificato contro Konami) vince e rarità/set_name restano vuoti piuttosto
// che presi da una carta diversa.
async function toPrinting(setCode, resolution, deps) {
  let cardName = resolution.cardName;
  if (!cardName && resolution.konamiCardId) cardName = await fetchKonamiCardName(resolution.konamiCardId);
  let catalogCardId = '';
  if (cardName) {
    const catalogCard = await deps.findCard(cardName).catch(() => null);
    catalogCardId = catalogCard ? String(catalogCard.id) : '';
  }
  let setName = '', rarity = '';
  if (catalogCardId) {
    const legacyMatches = await deps.lookupPrintingBySetCode(setCode).catch(() => []);
    const agreeing = legacyMatches.find(match => String(match.catalogCardId) === catalogCardId);
    if (agreeing) { setName = agreeing.setName || ''; rarity = agreeing.rarity || ''; }
  }
  return {
    printingId: '', game: 'yugioh', catalogCardId, cardName: cardName || '', setCode, setName, rarity,
    imageUrl: resolution.artworkUrl || '', warning: '',
    konamiCardId: resolution.konamiCardId || '', artworkIndex: resolution.artworkIndex || '',
    mappingSource: resolution.mappingSource || '', mappingConfidence: resolution.mappingConfidence || '',
    mappingStatus: resolution.mappingStatus, mappingNotes: resolution.mappingNotes || ''
  };
}

// Risolve N set code in batch: UNA sola richiesta di lettura registro, un
// prefisso YGOResources per set distinto (mai per carta), una sola lettura
// dell'indice artwork locale. allowRemote:false forza la sola risoluzione
// locale (usato quando l'app sa già di essere offline). api/findCard/
// lookupPrintingBySetCode sono iniettabili per i test (default: le
// implementazioni reali).
export async function resolveYgoPrintings(rawSetCodes, {
  allowRemote = true, api = defaultApi, findCard: findCardImpl = findCard,
  lookupPrintingBySetCode: legacyLookupImpl = lookupPrintingBySetCode
} = {}) {
  const deps = { api, findCard: findCardImpl, lookupPrintingBySetCode: legacyLookupImpl };
  const normalizedList = [...new Set((rawSetCodes || []).map(normalizeSetCode).filter(Boolean))];
  const result = new Map();
  if (!normalizedList.length) return result;

  let registryRows = [];
  try { registryRows = await api.ygoPrintingRegistryLookup(normalizedList); } catch { registryRows = []; }
  const registryByCode = new Map(registryRows.map(row => [row.set_code_normalized, row]));

  const pending = [];
  for (const code of normalizedList) {
    const precedence = precedenceResult(code, registryByCode.get(code));
    if (precedence) { pending.push({ code, precedence }); continue; }
    result.set(code, null); // segnaposto: serve risoluzione esterna
  }

  const toResolveExternally = [...result.keys()];
  if (!allowRemote || !toResolveExternally.length) {
    for (const code of toResolveExternally) result.set(code, unresolved(code, allowRemote ? 'nessuna corrispondenza nel registro' : 'risoluzione remota disabilitata'));
  } else {
    await resolveExternally(toResolveExternally, result, deps);
  }

  for (const { code, precedence } of pending) {
    const printing = await toPrinting(code, precedence, deps);
    result.set(code, printing);
    logResolution({ setCode: code, provider: precedence.mappingSource, konamiCardId: precedence.konamiCardId, artworkIndex: precedence.artworkIndex, confidence: precedence.mappingConfidence, status: precedence.mappingStatus });
  }

  return result;
}

async function resolveExternally(codes, result, deps) {
  const { api } = deps;
  const prefixGroups = new Map();
  for (const code of codes) {
    const split = splitPrintCode(code);
    if (!split) { result.set(code, unresolved(code, 'set code non analizzabile')); continue; }
    if (!prefixGroups.has(split.prefix)) prefixGroups.set(split.prefix, []);
    prefixGroups.get(split.prefix).push({ code, printNumber: split.printNumber });
  }
  const prefixes = [...prefixGroups.keys()];
  if (!prefixes.length) return;

  let cacheRows = [];
  try { cacheRows = await api.ygoPrintcodeCacheLookup(prefixes); } catch { cacheRows = []; }
  const cacheByPrefix = new Map();
  for (const row of cacheRows) {
    if (!cacheByPrefix.has(row.set_prefix)) cacheByPrefix.set(row.set_prefix, { status: row.status, entries: new Map() });
    if (row.print_number) cacheByPrefix.get(row.set_prefix).entries.set(row.print_number, row.konami_card_id);
  }

  const missingPrefixes = prefixes.filter(prefix => !cacheByPrefix.has(prefix));
  if (missingPrefixes.length) {
    const fetched = await Promise.all(missingPrefixes.map(async prefix => [prefix, await fetchPrintcodePrefix(prefix)]));
    for (const [prefix, outcome] of fetched) {
      cacheByPrefix.set(prefix, { status: outcome.status, entries: outcome.entries || new Map() });
      const entries = outcome.status === 'ok'
        ? [...outcome.entries].map(([printNumber, konamiCardId]) => ({ printNumber, konamiCardId }))
        : (outcome.error ? [outcome.error] : []);
      api.ygoPrintcodeCacheUpsert(prefix, outcome.status, entries).catch(() => {});
    }
  }

  const konamiByCode = new Map();
  const legacyFallbackCodes = [];
  for (const [prefix, entries] of prefixGroups) {
    const cache = cacheByPrefix.get(prefix);
    for (const { code, printNumber } of entries) {
      const konamiCardId = cache?.entries?.get(printNumber);
      if (!konamiCardId) { legacyFallbackCodes.push(code); continue; }
      konamiByCode.set(code, konamiCardId);
    }
  }

  // YGOResources non conosce questo set code (o non è raggiungibile): ultimo
  // tentativo con il vecchio percorso YGOPRODeck (card_sets per set_code
  // esatto) prima di arrendersi a 'unresolved'. Non è fuzzy matching — resta
  // un filtro esatto per set_code — ma non passa dal registro, quindi non
  // può mai diventare 'verified' da solo.
  for (const code of legacyFallbackCodes) {
    const legacyMatches = await deps.lookupPrintingBySetCode(code).catch(() => []);
    if (legacyMatches.length === 1) {
      const match = legacyMatches[0];
      result.set(code, { ...match, mappingSource: 'legacy', mappingConfidence: 'low', mappingStatus: 'unresolved',
        mappingNotes: 'Identità/immagine da YGOPRODeck (card_sets), non confermata dal registro: verificare artwork.' });
      logResolution({ setCode: code, provider: 'legacy', status: 'unresolved', reason: 'fallback YGOPRODeck card_sets' });
    } else {
      const notes = legacyMatches.length > 1 ? 'più corrispondenze ambigue in YGOPRODeck' : 'set code non presente in nessuna fonte';
      result.set(code, unresolved(code, notes));
      logResolution({ setCode: code, provider: 'none', status: 'unresolved', reason: notes });
    }
  }
  if (!konamiByCode.size) return;

  const uniqueKonamiIds = [...new Set(konamiByCode.values())];
  let artworkRows = [];
  try { artworkRows = await api.ygoArtworkIndexLookup(uniqueKonamiIds); } catch { artworkRows = []; }
  const artworkByKonamiId = new Map(artworkRows.map(row => [row.konami_card_id, row]));

  const mappingsToApply = [];
  for (const [code, konamiCardId] of konamiByCode) {
    const artwork = artworkByKonamiId.get(konamiCardId);
    const deterministic = artwork && Number(artwork.artwork_count) === 1 && artwork.single_artwork_url;
    const mappingStatus = deterministic ? 'resolved' : 'unresolved';
    const mappingNotes = deterministic ? '' : (artwork
      ? `${artwork.artwork_count} artwork disponibili per questo Konami ID: nessuna regola per scegliere quello corretto`
      : 'artwork non ancora sincronizzato localmente (scripts/ygo-artwork-index-sync.mjs)');
    const resolution = {
      konamiCardId, artworkIndex: deterministic ? '1' : '', artworkUrl: deterministic ? artwork.single_artwork_url : '',
      mappingSource: 'ygoresources', mappingConfidence: deterministic ? 'high' : 'low', mappingStatus, mappingNotes
    };
    mappingsToApply.push({ code, resolution });
  }

  for (const { code, resolution } of mappingsToApply) {
    const printing = await toPrinting(code, resolution, deps);
    result.set(code, printing);
    logResolution({ setCode: code, provider: 'ygoresources', konamiCardId: resolution.konamiCardId, artworkIndex: resolution.artworkIndex, confidence: resolution.mappingConfidence, status: resolution.mappingStatus });
  }

  const payload = mappingsToApply.map(({ code, resolution }) => ({
    setCode: code, konamiCardId: resolution.konamiCardId, artworkIndex: resolution.artworkIndex || null,
    artworkUrl: resolution.artworkUrl || null, cardName: result.get(code)?.cardName || null,
    mappingSource: resolution.mappingSource, mappingConfidence: resolution.mappingConfidence,
    mappingStatus: resolution.mappingStatus, mappingNotes: resolution.mappingNotes || null
  }));
  if (payload.length) api.applyYgoPrintingMappings(payload).catch(() => {});
}

// Convenienza per un singolo set code (editor, repair puntuale). Per import
// batch/Fast Scan usare sempre resolveYgoPrintings con l'elenco completo.
export async function resolveYgoPrinting(setCode, options = {}) {
  const normalized = normalizeSetCode(setCode);
  if (!normalized) return unresolved(setCode || '', 'set code vuoto');
  const map = await resolveYgoPrintings([normalized], options);
  return map.get(normalized) || unresolved(normalized, 'nessun risultato');
}

// Adapter con la stessa firma del vecchio externalLookup(code, game) di Fast
// Scan (js/fast-scan.js) — sostituisce lookupPrintingBySetCode come sorgente
// esterna primaria in app.js, senza toccare la macchina a stati di Fast Scan.
// Ritorna sempre un ARRAY (come il vecchio contratto): se il set_code aveva
// più rarità note per la stessa identità carta, la scelta resta all'utente
// in review, ma l'immagine è SEMPRE quella verificata dal registro, mai
// quella indovinata dal vecchio percorso.
export async function externalLookupViaRegistry(setCode, game = 'yugioh') {
  if (game !== 'yugioh') return [];
  const printing = await resolveYgoPrinting(setCode);
  if (!printing.catalogCardId) return [];
  const legacyMatches = await lookupPrintingBySetCode(setCode).catch(() => []);
  const sameIdentity = legacyMatches.filter(match => String(match.catalogCardId) === printing.catalogCardId);
  if (sameIdentity.length > 1) {
    return sameIdentity.map(match => ({
      ...match, imageUrl: printing.imageUrl || match.imageUrl,
      mappingStatus: printing.mappingStatus, mappingSource: printing.mappingSource,
      mappingConfidence: printing.mappingConfidence, mappingNotes: printing.mappingNotes
    }));
  }
  return [printing];
}
