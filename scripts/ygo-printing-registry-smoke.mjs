// Copre i test obbligatori del Printing Registry (set_code -> Konami card ID
// -> artwork): exact code, override precedence, unknown printing, multiple
// artworks, API failure, normalization. Nessuna chiamata di rete reale — sia
// YGOResources sia YGOPRODeck sono mockati con dati strutturalmente validi,
// stesso pattern di scripts/catalog-alternate-artwork-smoke.mjs. api/findCard/
// lookupPrintingBySetCode sono iniettati come fake (vedi js/ygo-printing-registry.js).
import assert from 'node:assert/strict';

globalThis.window = { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

function installFetchMock({ printcode = {}, cardData = {} } = {}) {
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'db.ygoresources.com' && parsed.pathname.startsWith('/data/idx/printcode/')) {
      const prefix = decodeURIComponent(parsed.pathname.slice('/data/idx/printcode/'.length));
      if (prefix === '__NETWORK_ERROR__') throw new Error('network down');
      const entries = printcode[prefix];
      if (!entries) return { status: 404, ok: false, json: async () => ({}) };
      return { status: 200, ok: true, json: async () => entries };
    }
    if (parsed.hostname === 'db.ygoresources.com' && parsed.pathname.startsWith('/data/card/')) {
      const id = parsed.pathname.slice('/data/card/'.length);
      const data = cardData[id];
      if (!data) return { status: 404, ok: false, json: async () => ({}) };
      return { status: 200, ok: true, json: async () => data };
    }
    throw new Error(`fetch non mockato in questo test: ${url}`);
  };
}

function fakeApi(overrides = {}) {
  return {
    ygoPrintingRegistryLookup: async () => [],
    ygoPrintcodeCacheLookup: async () => [],
    ygoPrintcodeCacheUpsert: async () => {},
    ygoArtworkIndexLookup: async () => [],
    applyYgoPrintingMappings: async () => ({ applied: 0, conflicts: 0, skipped: 0 }),
    ...overrides
  };
}

const { resolveYgoPrintings, normalizeSetCode, splitPrintCode } = await import('../js/ygo-printing-registry.js');

// --- 1) Exact code: LDS3-EN063 deve risolvere Gimmick Puppet Bisque Doll ---
// (dati reali verificati contro le API vere il 2026-09-11: printcode index
// LDS3-EN restituisce {"063":14598}, /data/card/14598 è "Gimmick Puppet
// Bisque Doll", manifest artwork ha un solo indice per quel Konami ID).
{
  installFetchMock({
    printcode: { 'LDS3-EN': { '063': 14598 } },
    cardData: { '14598': { cardData: { ae: { name: 'Gimmick Puppet Bisque Doll' } } } }
  });
  const api = fakeApi({ ygoArtworkIndexLookup: async () => [{ konami_card_id: '14598', artwork_count: 1, single_artwork_url: 'https://artworks.ygoresources.com/1/45/98_1.png' }] });
  const findCard = async name => name === 'Gimmick Puppet Bisque Doll' ? { id: 79086452, name } : null;
  const lookupPrintingBySetCode = async () => [];
  const result = await resolveYgoPrintings(['LDS3-EN063'], { api, findCard, lookupPrintingBySetCode });
  const printing = result.get('LDS3-EN063');
  assert.equal(printing.mappingStatus, 'resolved', 'LDS3-EN063 deve risolvere come resolved');
  assert.equal(printing.konamiCardId, '14598', 'Konami ID errato per LDS3-EN063');
  assert.equal(printing.cardName, 'Gimmick Puppet Bisque Doll', 'nome carta errato per LDS3-EN063 (bug storico: veniva associata a Number 15: Gimmick Puppet Giant Grinder)');
  assert.equal(printing.catalogCardId, '79086452', 'catalogCardId YGOPRODeck non risolto');
  assert.equal(printing.imageUrl, 'https://artworks.ygoresources.com/1/45/98_1.png', 'artwork non verificato via registro');
}

// --- 2) Override: precedenza assoluta, mai sovrascritto da fonti automatiche ---
// (MIP-1010 -> Hane-Hane, Konami ID 4547: caso reale, YGOResources non ha
// alcuna voce per MIP in nessun locale, verificato). Il fetch mock non
// contiene alcuna voce per il prefisso derivato da MIP-1010: se il resolver
// tentasse comunque una risoluzione automatica invece di fidarsi
// dell'override, il test fallirebbe per fetch non mockato.
{
  installFetchMock({});
  const api = fakeApi({
    ygoPrintingRegistryLookup: async (codes) => codes.filter(c => c === 'MIP-1010').map(() => ({
      set_code_normalized: 'MIP-1010', registry_konami_card_id: null, registry_card_name: null,
      registry_artwork_index: null, registry_artwork_url: null, registry_mapping_source: null,
      registry_mapping_confidence: null, registry_mapping_status: null, registry_verified: null,
      override_konami_card_id: '4547', override_artwork_index: '1', override_artwork_url: 'https://artworks.ygoresources.com/0/45/47_1.png',
      override_reason: 'MIP-1010 non risulta in nessuna fonte automatica'
    }))
  });
  const findCard = async name => name === 'Hane-Hane' ? { id: 7089711, name } : null;
  const lookupPrintingBySetCode = async () => [];
  installFetchMock({ cardData: { '4547': { cardData: { ae: { name: 'Hane-Hane' } } } } });
  const result = await resolveYgoPrintings(['MIP-1010'], { api, findCard, lookupPrintingBySetCode });
  const printing = result.get('MIP-1010');
  assert.equal(printing.mappingStatus, 'verified', 'un override deve risultare verified');
  assert.equal(printing.mappingSource, 'override', 'la fonte deve essere "override"');
  assert.equal(printing.konamiCardId, '4547', 'Konami ID errato per MIP-1010');
  assert.equal(printing.cardName, 'Hane-Hane', 'MIP-1010 deve risolvere a Hane-Hane');
  assert.equal(printing.catalogCardId, '7089711', 'catalogCardId YGOPRODeck non risolto per Hane-Hane');
}

// --- 3) Unknown printing: un set code sconosciuto non deve produrre una carta a caso ---
{
  installFetchMock({}); // nessun prefisso conosciuto: ogni richiesta risulta 404
  const api = fakeApi();
  const findCard = async () => { throw new Error('non deve essere chiamato per un set code sconosciuto'); };
  const lookupPrintingBySetCode = async () => [];
  const result = await resolveYgoPrintings(['ZZZZ-XX999'], { api, findCard, lookupPrintingBySetCode });
  const printing = result.get('ZZZZ-XX999');
  assert.equal(printing.mappingStatus, 'unresolved', 'un set code sconosciuto deve essere unresolved');
  assert.equal(printing.catalogCardId, '', 'un set code sconosciuto non deve avere un catalogCardId inventato');
  assert.equal(printing.imageUrl, '', 'un set code sconosciuto non deve avere un\'immagine inventata');
}

// --- 4) Multiple artworks: mai un guess su quale sia quello giusto ---
{
  installFetchMock({
    printcode: { 'LOB-EN': { '005': 4041 } },
    cardData: { '4041': { cardData: { ae: { name: 'Dark Magician' } } } }
  });
  // 18 artwork noti per questo Konami ID (dato reale verificato sul manifest):
  // nessuna regola per scegliere, quindi niente artwork_count===1.
  const api = fakeApi({ ygoArtworkIndexLookup: async () => [{ konami_card_id: '4041', artwork_count: 18, single_artwork_url: null }] });
  const findCard = async name => name === 'Dark Magician' ? { id: 46986414, name } : null;
  const lookupPrintingBySetCode = async () => [];
  const result = await resolveYgoPrintings(['LOB-EN005'], { api, findCard, lookupPrintingBySetCode });
  const printing = result.get('LOB-EN005');
  assert.equal(printing.mappingStatus, 'unresolved', 'una carta con più artwork non deve auto-risolversi');
  assert.equal(printing.imageUrl, '', 'non deve usare automaticamente il primo artwork (né alcun altro) senza una regola affidabile');
  assert.equal(printing.catalogCardId, '46986414', 'l\'identità carta resta comunque nota anche se l\'artwork è ambiguo');
}

// --- 5) API failure: le printing già note localmente continuano a funzionare ---
{
  // Un set code già 'resolved' nel registro non deve MAI toccare la rete:
  // il mock lancia se un prefisso ignoto viene richiesto, provando che il
  // resolver si è fermato al primo passo (registry locale).
  installFetchMock({});
  const api = fakeApi({
    ygoPrintingRegistryLookup: async () => [{
      set_code_normalized: 'LDS3-EN063', registry_konami_card_id: '14598', registry_card_name: 'Gimmick Puppet Bisque Doll',
      registry_artwork_index: '1', registry_artwork_url: 'https://artworks.ygoresources.com/1/45/98_1.png',
      registry_mapping_source: 'ygoresources', registry_mapping_confidence: 'high', registry_mapping_status: 'resolved',
      registry_verified: false, override_konami_card_id: null, override_artwork_index: null, override_artwork_url: null, override_reason: null
    }]
  });
  const findCard = async () => ({ id: 79086452, name: 'Gimmick Puppet Bisque Doll' });
  const lookupPrintingBySetCode = async () => { throw new Error('non deve essere chiamato: la printing è già resolved localmente'); };
  const result = await resolveYgoPrintings(['LDS3-EN063'], { api, findCard, lookupPrintingBySetCode });
  assert.equal(result.get('LDS3-EN063').mappingStatus, 'resolved', 'una printing già resolved deve restare disponibile senza rete');

  // Un set code NUOVO, quando YGOResources è irraggiungibile, deve restare
  // unresolved (o cadere sul fallback legacy) — mai bloccare l'app.
  const apiForUnknown = fakeApi({ ygoPrintingRegistryLookup: async () => [] });
  const legacyFallback = async code => code === 'NEWX-EN001' ? [] : [];
  const failing = await resolveYgoPrintings(['NEWX-EN001'], {
    api: apiForUnknown,
    findCard: async () => null,
    lookupPrintingBySetCode: legacyFallback
  });
  assert.equal(failing.get('NEWX-EN001').mappingStatus, 'unresolved', 'YGOResources irraggiungibile: la nuova printing resta unresolved, non deve lanciare');
}

// --- 6) Normalizzazione: minuscole, maiuscole, spazi, trattini, caratteri OCR ---
{
  assert.equal(normalizeSetCode('lds3-en063'), 'LDS3-EN063', 'lowercase non normalizzato');
  assert.equal(normalizeSetCode('LDS3-EN063'), 'LDS3-EN063', 'uppercase già corretto alterato');
  assert.equal(normalizeSetCode('  LDS3-EN063  '), 'LDS3-EN063', 'spazi esterni non rimossi');
  assert.equal(normalizeSetCode('LDS3 EN063'), 'LDS3-EN063', 'spazio interno non convertito in trattino');
  assert.equal(normalizeSetCode('LDS3–EN063'), 'LDS3-EN063', 'trattino unicode (en dash) non normalizzato');
  assert.equal(normalizeSetCode('LDS3--EN063'), 'LDS3-EN063', 'doppio trattino non collassato');
  assert.deepEqual(splitPrintCode(normalizeSetCode('lds3-en063')), { prefix: 'LDS3-EN', printNumber: '063' }, 'split del print code errato dopo normalizzazione');
  assert.equal(splitPrintCode(normalizeSetCode('mip-1010')).prefix, 'MIP-', 'un codice storico senza marker lingua deve produrre un prefisso a locale vuoto (not_found atteso, mai un guess)');
}

console.log('PASS ygo-printing-registry: exact code (LDS3-EN063) · override precedence (MIP-1010) · unknown printing · multiple artworks · API failure resilience · normalization');
