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
// apply_ygo_printing_mappings è idempotente (upsert + guardie anti-declassamento
// lato SQL): ritentare lo STESSO payload dopo un errore transitorio è sicuro,
// non produce doppie scritture né stati intermedi inconsistenti.
const MAX_APPLY_RETRIES = 2;
const APPLY_RETRY_DELAYS_MS = [400, 1200];

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

// persisted:true qui non significa "scritto sul registro" (non c'è nulla da
// scrivere: nessuna fonte ha dato un'identità) — significa "nessuna
// persistenza pendente", cioè il chiamante può considerare questo risultato
// definitivo. Distinto da persisted:false, che significa sempre "una
// risoluzione POSITIVA che non è però riuscita a essere salvata".
function unresolved(setCode, notes = '') {
  return {
    printingId: '', game: 'yugioh', catalogCardId: '', cardName: '', setCode, setName: '', rarity: '',
    imageUrl: '', warning: '',
    konamiCardId: '', artworkIndex: '', mappingSource: '', mappingConfidence: '',
    mappingStatus: 'unresolved', mappingNotes: notes, persisted: true
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

// Indice nomi->Konami ID (EN) di YGOResources, per il fallback deterministico
// quando il print-code non è nel loro indice ma YGOPRODeck conosce comunque
// la carta (vedi resolveExternally più sotto). Un solo fetch per sessione
// (~500KB, cache indefinita: i nomi ufficiali non cambiano), mai per singola
// carta — coerente col resto del modulo (niente N+1).
let nameIndexEnPromise = null;
async function fetchNameIndexEn() {
  if (!nameIndexEnPromise) {
    nameIndexEnPromise = (async () => {
      const result = await fetchJson(`${YGORESOURCES_BASE}/data/idx/card/name/en`, { timeoutMs: 15000 });
      return result.ok && result.data && typeof result.data === 'object' ? result.data : {};
    })();
  }
  return nameIndexEnPromise;
}

const YGOPRODECK_CARDINFO_ENDPOINT = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
// Nome inglese canonico per id YGOPRODeck — serve a confrontare contro
// l'indice nomi EN di YGOResources con lo stesso identico locale su entrambi
// i lati (il nome restituito da lookupPrintingBySetCode può essere
// localizzato in italiano). Nessun parametro di lingua = inglese di default,
// batch da 40 id per richiesta.
async function fetchEnglishNamesByCatalogId(catalogCardIds) {
  const map = new Map();
  const CHUNK = 40;
  for (let index = 0; index < catalogCardIds.length; index += CHUNK) {
    const chunk = catalogCardIds.slice(index, index + CHUNK);
    const result = await fetchJson(`${YGOPRODECK_CARDINFO_ENDPOINT}?id=${chunk.join(',')}`);
    if (result.ok && Array.isArray(result.data?.data)) {
      for (const card of result.data.data) map.set(String(card.id), card.name);
    }
  }
  return map;
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Un errore con .code (SQLSTATE/PostgREST, es. da un `raise exception` lato
// RPC per input non valido) è persistente: ritentare lo stesso payload
// fallirebbe di nuovo, quindi non è transitorio. Un errore senza .code — fetch
// fallita, timeout, connessione interrotta — è la classe di errore per cui
// ha senso un retry limitato.
function isTransientPersistError(error) { return Boolean(error) && !error.code; }

// Applica un batch di mapping aspettando davvero la persistenza (mai
// fire-and-forget): un chiamante non deve poter considerare una risoluzione
// "conclusa" prima che la scrittura sul registro sia terminata o abbia
// esaurito i tentativi. Un solo batch per chiamata: i retry ripetono la
// STESSA chiamata, non ne aggiungono una per codice (nessun N+1).
async function applyMappingsWithRetry(api, payload) {
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_APPLY_RETRIES; attempt++) {
    try {
      await api.applyYgoPrintingMappings(payload);
      return { persisted: true };
    } catch (error) {
      lastError = error;
      if (!isTransientPersistError(error) || attempt === MAX_APPLY_RETRIES) break;
      await delay(APPLY_RETRY_DELAYS_MS[attempt] || APPLY_RETRY_DELAYS_MS.at(-1));
    }
  }
  // Errore persistente (o transitorio con i tentativi esauriti): mai
  // mascherato — chi chiama riceve persisted:false + il motivo, non un
  // falso successo silenzioso.
  return { persisted: false, error: lastError };
}

function precedenceResult(setCode, row) {
  if (!row) return null;
  if (row.override_konami_card_id) {
    // Un override verificato deve diventare fonte canonica nel registro
    // indipendentemente da come/quando è stato creato (seed di migration,
    // RPC admin, ...): needsRegistrySync=true finché la riga del registro non
    // rispecchia già esattamente questo override, così "usare" l'override
    // (qualunque chiamante lo risolva) lo sincronizza al primo utilizzo senza
    // bisogno di un percorso di creazione specifico.
    const alreadySynced = row.registry_mapping_status === 'verified'
      && row.registry_mapping_source === 'override'
      && row.registry_konami_card_id === row.override_konami_card_id
      && (row.registry_artwork_index || '') === (row.override_artwork_index || '')
      && (row.registry_artwork_url || '') === (row.override_artwork_url || '');
    return {
      konamiCardId: row.override_konami_card_id, artworkIndex: row.override_artwork_index || '',
      artworkUrl: row.override_artwork_url || '', cardName: row.registry_card_name || '',
      mappingSource: 'override', mappingConfidence: 'high', mappingStatus: 'verified',
      needsRegistrySync: !alreadySynced
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
    mappingStatus: resolution.mappingStatus, mappingNotes: resolution.mappingNotes || '',
    // Sovrascritto dal chiamante una volta noto l'esito reale della
    // persistenza (vedi resolveExternally/resolveYgoPrintings) — di default
    // true perché una parte dei chiamanti di toPrinting (precedenza da
    // registro già verificato/resolved) non ha nulla da scrivere.
    persisted: resolution.persisted !== false
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

  // Override verificati che il registro non rispecchia ancora esattamente
  // (creati fuori dal percorso upsert_ygo_printing_override, es. seed di
  // migration come MIP-1010, o un override aggiornato dopo l'ultima sync):
  // sincronizzarli è la stessa identica chiamata batch usata per le
  // risoluzioni automatiche — un override attivo vince sempre lato SQL,
  // quindi è sempre sicuro riapplicarlo qui.
  const overridesNeedingSync = pending.filter(item => item.precedence.needsRegistrySync);
  let overrideSyncOutcome = { persisted: true };
  if (overridesNeedingSync.length) {
    const payload = overridesNeedingSync.map(({ code, precedence }) => ({
      setCode: code, konamiCardId: precedence.konamiCardId, artworkIndex: precedence.artworkIndex || null,
      artworkUrl: precedence.artworkUrl || null, mappingSource: 'override', mappingConfidence: 'high',
      mappingStatus: 'verified'
    }));
    overrideSyncOutcome = await applyMappingsWithRetry(api, payload);
    if (!overrideSyncOutcome.persisted) {
      console.error('[ygo-printing-registry] override registry sync failed', {
        codes: overridesNeedingSync.map(item => item.code), error: overrideSyncOutcome.error?.message || String(overrideSyncOutcome.error)
      });
    }
  }

  for (const { code, precedence } of pending) {
    const persisted = precedence.needsRegistrySync ? overrideSyncOutcome.persisted : true;
    const printing = await toPrinting(code, { ...precedence, persisted }, deps);
    result.set(code, printing);
    logResolution({ setCode: code, provider: precedence.mappingSource, konamiCardId: precedence.konamiCardId, artworkIndex: precedence.artworkIndex, confidence: precedence.mappingConfidence, status: precedence.mappingStatus, persisted });
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

  // YGOResources non conosce questo print code. Prima di arrendersi,
  // un secondo tentativo DETERMINISTICO (non fuzzy): se YGOPRODeck conosce
  // comunque la carta per questo set_code esatto, il suo nome inglese
  // canonico può corrispondere a ESATTAMENTE UN Konami ID nell'indice nomi
  // di YGOResources — stesso standard di rigore già usato in senso inverso
  // da toPrinting() (Konami ID -> nome -> ricerca ESATTA su YGOPRODeck). Se
  // il nome è ambiguo (0 o >1 corrispondenze) non si procede: resta il
  // fallback legacy di prima, mai un guess.
  const legacyIdentities = [];
  for (const code of legacyFallbackCodes) {
    const legacyMatches = await deps.lookupPrintingBySetCode(code).catch(() => []);
    if (legacyMatches.length === 1) legacyIdentities.push({ code, match: legacyMatches[0] });
    else {
      const notes = legacyMatches.length > 1 ? 'più corrispondenze ambigue in YGOPRODeck' : 'set code non presente in nessuna fonte';
      result.set(code, unresolved(code, notes));
      logResolution({ setCode: code, provider: 'none', status: 'unresolved', reason: notes });
    }
  }

  const newlyIdentified = [];
  if (legacyIdentities.length) {
    const catalogIds = [...new Set(legacyIdentities.map(item => item.match.catalogCardId))];
    const [enNames, nameIndex] = await Promise.all([
      fetchEnglishNamesByCatalogId(catalogIds).catch(() => new Map()),
      fetchNameIndexEn().catch(() => ({}))
    ]);
    for (const { code, match } of legacyIdentities) {
      const enName = enNames.get(match.catalogCardId);
      const konamiMatches = enName ? nameIndex[enName] : null;
      if (konamiMatches && konamiMatches.length === 1) {
        newlyIdentified.push({ code, match, enName, konamiCardId: String(konamiMatches[0]) });
      } else {
        result.set(code, { ...match, mappingSource: 'legacy', mappingConfidence: 'low', mappingStatus: 'unresolved',
          mappingNotes: 'Identità/immagine da YGOPRODeck (card_sets), non confermata dal registro: verificare artwork.' });
        logResolution({ setCode: code, provider: 'legacy', status: 'unresolved', reason: 'fallback YGOPRODeck card_sets' });
      }
    }
  }

  if (newlyIdentified.length) {
    const uniqueNewKonamiIds = [...new Set(newlyIdentified.map(item => item.konamiCardId))];
    let newArtworkRows = [];
    try { newArtworkRows = await api.ygoArtworkIndexLookup(uniqueNewKonamiIds); } catch { newArtworkRows = []; }
    const newArtworkByKonamiId = new Map(newArtworkRows.map(row => [row.konami_card_id, row]));

    const byNameIndexMappings = [];
    for (const { code, enName, konamiCardId } of newlyIdentified) {
      const artwork = newArtworkByKonamiId.get(konamiCardId);
      const deterministic = artwork && Number(artwork.artwork_count) === 1 && artwork.single_artwork_url;
      const mappingStatus = deterministic ? 'resolved' : 'unresolved';
      const mappingNotes = deterministic
        ? 'Identità risolta tramite indice nomi YGOResources (print code non indicizzato)'
        : `Identità nota tramite indice nomi YGOResources (print code non indicizzato) — ${artwork ? `${artwork.artwork_count} artwork disponibili, nessuna regola per scegliere quello corretto` : 'artwork non ancora sincronizzato localmente'}`;
      byNameIndexMappings.push({ code, resolution: {
        konamiCardId, cardName: enName, artworkIndex: deterministic ? '1' : '', artworkUrl: deterministic ? artwork.single_artwork_url : '',
        mappingSource: 'ygoresources', mappingConfidence: deterministic ? 'high' : 'low', mappingStatus, mappingNotes
      } });
    }

    const byNamePayload = byNameIndexMappings.map(({ code, resolution }) => ({
      setCode: code, konamiCardId: resolution.konamiCardId, artworkIndex: resolution.artworkIndex || null,
      artworkUrl: resolution.artworkUrl || null, cardName: resolution.cardName || null,
      mappingSource: resolution.mappingSource, mappingConfidence: resolution.mappingConfidence,
      mappingStatus: resolution.mappingStatus, mappingNotes: resolution.mappingNotes || null
    }));
    const byNameOutcome = byNamePayload.length ? await applyMappingsWithRetry(api, byNamePayload) : { persisted: true };
    if (!byNameOutcome.persisted) {
      console.error('[ygo-printing-registry] persistence failed after retries (name-index path)', {
        codes: byNameIndexMappings.map(item => item.code), error: byNameOutcome.error?.message || String(byNameOutcome.error)
      });
    }
    for (const { code, resolution } of byNameIndexMappings) {
      const printing = await toPrinting(code, { ...resolution, persisted: byNameOutcome.persisted }, deps);
      result.set(code, printing);
      logResolution({ setCode: code, provider: 'ygoresources-by-name', konamiCardId: resolution.konamiCardId, artworkIndex: resolution.artworkIndex, confidence: resolution.mappingConfidence, status: resolution.mappingStatus, persisted: byNameOutcome.persisted });
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

  // Nome carta risolto ORA (serve nel payload di persistenza, non solo
  // nell'oggetto restituito): va calcolato prima della persistenza, non dopo,
  // altrimenti "resolved" tornerebbe al chiamante prima che il registro sappia
  // anche il nome, non solo l'id.
  const cardNameByCode = new Map();
  for (const { code, resolution } of mappingsToApply) {
    if (!resolution.cardName && resolution.konamiCardId) {
      cardNameByCode.set(code, await fetchKonamiCardName(resolution.konamiCardId));
    } else cardNameByCode.set(code, resolution.cardName || '');
  }

  const payload = mappingsToApply.map(({ code, resolution }) => ({
    setCode: code, konamiCardId: resolution.konamiCardId, artworkIndex: resolution.artworkIndex || null,
    artworkUrl: resolution.artworkUrl || null, cardName: cardNameByCode.get(code) || null,
    mappingSource: resolution.mappingSource, mappingConfidence: resolution.mappingConfidence,
    mappingStatus: resolution.mappingStatus, mappingNotes: resolution.mappingNotes || null
  }));

  // Mai fire-and-forget: un chiamante non deve poter trattare questa
  // risoluzione come conclusa prima che la scrittura sul registro sia
  // davvero terminata (o abbia esaurito i tentativi su un errore transitorio).
  let applyOutcome = { persisted: true };
  if (payload.length) {
    applyOutcome = await applyMappingsWithRetry(api, payload);
    if (!applyOutcome.persisted) {
      console.error('[ygo-printing-registry] persistence failed after retries', {
        codes: mappingsToApply.map(item => item.code), error: applyOutcome.error?.message || String(applyOutcome.error)
      });
    }
  }

  for (const { code, resolution } of mappingsToApply) {
    const printing = await toPrinting(code, { ...resolution, cardName: cardNameByCode.get(code), persisted: applyOutcome.persisted }, deps);
    result.set(code, printing);
    logResolution({ setCode: code, provider: 'ygoresources', konamiCardId: resolution.konamiCardId, artworkIndex: resolution.artworkIndex, confidence: resolution.mappingConfidence, status: resolution.mappingStatus, persisted: applyOutcome.persisted });
  }
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
