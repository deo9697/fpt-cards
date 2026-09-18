// F.P.T Cards — CH01-EN015 "Dogmatika Fleurdelis, the Knighted": fixture
// obbligatoria per il caso reale del benchmark 2026-09-17. Copre:
// 1) identità carta/set risolta correttamente;
// 2) rarity mai "New artwork" (già coperto altrove, riverificato qui);
// 3-4) il picker riceve ENTRAMBE le artwork reali, con imageUrl/catalogCardId
//      distinti (mai due "rarità" inventate per la stessa carta);
// 5-6) la scelta dell'artwork B sopravvive alla entry di sessione e al
//      payload inviato in salvataggio (proxy diretto di cosa la Raccolta
//      mostrerà riaprendo il dettaglio — stesso catalogCardId/imageUrl);
// 8-9) nessuna cronologia tecnica nella UI normale, presente solo sotto
//      ?debugScan=1;
// + una carta con una sola artwork nota non mostra alcun picker aggiuntivo.
//
// Stesso pattern di mock (fetch YGOResources/YGOPRODeck) di
// scripts/ygo-printing-registry-smoke.mjs, esteso con card_images multipli
// per esercitare externalLookupViaRegistry — nessuna logica artwork parallela,
// solo l'infrastruttura già esistente (ygo_artwork_index + card_images reali).
import assert from 'node:assert/strict';

globalThis.window = { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { hidden: false, addEventListener(){}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ getContext: () => ({}) }) };

function installFetchMock({ printcode = {}, cardData = {}, ygoprodeckById = {} } = {}) {
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'db.ygoresources.com' && parsed.pathname.startsWith('/data/idx/printcode/')) {
      const prefix = decodeURIComponent(parsed.pathname.slice('/data/idx/printcode/'.length));
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
    if (parsed.hostname === 'db.ygoprodeck.com' && parsed.pathname === '/api/v7/cardinfo.php' && parsed.searchParams.has('id')) {
      const ids = parsed.searchParams.get('id').split(',');
      const data = ids.filter(id => ygoprodeckById[id]).map(id => {
        const entry = ygoprodeckById[id];
        return { id: Number(id), name: entry.name || entry, card_images: entry.card_images || [{ id: Number(id), image_url: `https://images.ygoprodeck.com/images/cards/${id}.jpg` }], card_sets: entry.card_sets || [] };
      });
      return { status: 200, ok: true, json: async () => ({ data }) };
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

const { resolveYgoPrintings, externalLookupViaRegistry } = await import('../js/ygo-printing-registry.js');
const cardsModule = await import('../js/cards.js');

const KONAMI_ID = '99001';
const CATALOG_ID = '89777841';
const CARD_NAME = 'Dogmatika Fleurdelis, the Knighted';
const SET_CODE = 'CH01-EN015';
const RARITY = 'Common';
const ARTWORK_A_URL = 'https://images.ygoprodeck.com/images/cards/89777841.jpg';
const ARTWORK_B_URL = 'https://images.ygoprodeck.com/images/cards/89777842.jpg';
// Identità distinta, mai toccata dal resto del file: garantisce una cache
// findCardById sempre fredda per il guard test di latenza più sotto,
// indipendentemente dall'ordine/dal warm-up della cache di CATALOG_ID.
const GUARD_KONAMI_ID = '99099';
const GUARD_CATALOG_ID = '89779999';
const GUARD_CARD_NAME = 'Guard Latency Dummy';
const GUARD_SET_CODE = 'GRD1-EN099';

installFetchMock({
  printcode: { 'CH01-EN': { '015': Number(KONAMI_ID) }, 'GRD1-EN': { '099': Number(GUARD_KONAMI_ID) } },
  cardData: { [KONAMI_ID]: { cardData: { ae: { name: CARD_NAME } } }, [GUARD_KONAMI_ID]: { cardData: { ae: { name: GUARD_CARD_NAME } } } },
  ygoprodeckById: { [CATALOG_ID]: {
    name: CARD_NAME,
    card_images: [{ id: Number(CATALOG_ID), image_url: ARTWORK_A_URL }, { id: 89777842, image_url: ARTWORK_B_URL }],
    card_sets: [{ set_code: SET_CODE, set_name: 'Championship Pack 2001', set_rarity: RARITY }]
  } }
});
// 2 artwork noti per questo Konami ID: nessuna regola per scegliere, quindi
// niente artwork_count===1 — esattamente il segnale reale del benchmark.
const api = fakeApi({ ygoArtworkIndexLookup: async () => [{ konami_card_id: KONAMI_ID, artwork_count: 2, single_artwork_url: null }] });
const findCard = async name => name === CARD_NAME ? { id: Number(CATALOG_ID), name } : null;
// Mock diretto (stesso pattern di ygo-printing-registry-smoke.mjs): l'identità
// carta arriva da findCard, questo copre solo rarità/set_name per il
// catalogCardId "generico" — /api/v7/cardsetsinfo.php non è mockato qui.
const lookupPrintingBySetCode = async code => code === SET_CODE ? [{ catalogCardId: CATALOG_ID, setCode: SET_CODE, setName: 'Championship Pack 2001', rarity: RARITY }] : [];

// --- 1-2) identità/rarity risolte correttamente, mai "New artwork" ---
const result = await resolveYgoPrintings([SET_CODE], { api, findCard, lookupPrintingBySetCode });
const printing = result.get(SET_CODE);
assert.equal(printing.mappingStatus, 'unresolved', 'più artwork reali: mai un auto-resolve arbitrario');
assert.equal(printing.catalogCardId, CATALOG_ID, 'identità carta deve risolversi correttamente anche con artwork ambiguo');
assert.equal(printing.artworkCount, 2, 'il conteggio artwork reale deve arrivare fino al chiamante');
assert.notEqual(printing.rarity, 'New artwork');
assert.equal(printing.imageUrl, '', 'con artwork ambiguo il resolver di base non deve inventare un\'immagine: la scelta arriva dal picker (externalLookupViaRegistry), non da questo oggetto');
console.log('PASS CH01-EN015: identità carta risolta correttamente, "New artwork" mai presente, artworkCount propagato');

// --- 3) cache fredda (prima volta in sessione): il riconoscimento NON
//     aspetta la rete artwork — un solo match base, immediato (audit OCR
//     2026-09-17: qui stava l'await bloccante che rallentava ogni scan) ---
const coldCandidates = await externalLookupViaRegistry(SET_CODE, 'yugioh', { api, findCard, lookupPrintingBySetCodeImpl: lookupPrintingBySetCode });
assert.equal(coldCandidates.length, 1, 'cache fredda: il riconoscimento base non deve bloccarsi sulla rete artwork');
assert.equal(coldCandidates[0].catalogCardId, CATALOG_ID);
assert(!coldCandidates[0].artworkLabel, 'senza cache calda nessuna label artwork inventata');
console.log('PASS CH01-EN015: cache fredda -> riconoscimento base immediato, nessun await di rete sull\'artwork');

// La chiamata precedente scalda la cache in background (fire-and-forget):
// attenderla qui replica cosa succede appena il fetch in background termina.
await cardsModule.findCardById(CATALOG_ID, CARD_NAME, 'yugioh');

// --- 4) cache calda: ORA il picker riceve ENTRAMBE le artwork reali ---
const candidates = await externalLookupViaRegistry(SET_CODE, 'yugioh', { api, findCard, lookupPrintingBySetCodeImpl: lookupPrintingBySetCode });
assert.equal(candidates.length, 2, 'cache calda: il picker deve ricevere ENTRAMBE le artwork reali');
assert.notEqual(candidates[0].catalogCardId, candidates[1].catalogCardId, 'le due opzioni devono avere catalogCardId reali distinti');
assert.notEqual(candidates[0].imageUrl, candidates[1].imageUrl, 'le due opzioni devono avere imageUrl distinti');
assert.equal(candidates[0].artworkLabel, 'Standard');
assert.equal(candidates[1].artworkLabel, 'Artwork alternativa');
for (const candidate of candidates) {
  assert.notEqual(candidate.rarity, 'New artwork', 'nessuna delle due opzioni deve avere "New artwork" come rarità');
  assert.equal(candidate.setCode, SET_CODE);
}
console.log('PASS CH01-EN015: externalLookupViaRegistry espone le due artwork reali con id/immagine distinti (nessuna logica artwork parallela: stessa infrastruttura ygo_artwork_index + card_images)');

// --- 5-6) selezione artwork B -> entry di sessione + payload di salvataggio ---
const { FastScanController } = await import('../js/fast-scan.js');
const controller = new FastScanController({
  camera: { focusSupported: false }, ocr: {}, api: { lookupPrintings: async () => [] },
  externalLookup: async code => code === SET_CODE ? candidates : [],
  getCollection: () => ({ mine: [], team: [] }), isOnline: () => true, onRender(){}, onRoute(){}
});
const resolved = await controller.resolve(SET_CODE, 95, { consensus: 2 });
assert.equal(resolved.status, 'needs_review', 'due artwork reali sono una vera ambiguità, non un auto-accept arbitrario');
assert.equal(resolved.matches.length, 2);

const scan = controller.buffer.createScan();
controller.buffer.queueReview({ id: scan.id, code: SET_CODE, matches: candidates, warning: 'Quale artwork?' });
controller.currentScanId = scan.id;
assert.match(controller.assistantView(), /Quale carta è\?/);
assert.match(controller.assistantView(), /Artwork alternativa/);
controller.chooseReview(scan.id, 1); // sceglie l'opzione B (index 1)
const savedEntry = [...controller.buffer.entries.values()][0];
assert.equal(savedEntry.catalogCardId, '89777842', 'la session entry deve conservare la artwork B scelta, non un fallback ad artworks[0]');
assert.equal(savedEntry.imageUrl, ARTWORK_B_URL);
assert.equal(savedEntry.rarity, RARITY, 'la rarità reale non deve cambiare per la scelta dell\'artwork');
assert.equal(savedEntry.artworkLabel, 'Artwork alternativa');

let savedPayload = null;
controller.api.saveCollectionBatch = async items => { savedPayload = items; return { savedItems: items.length, totalQuantity: items.length }; };
controller.onToast = () => {};
await controller.save();
assert.equal(savedPayload?.[0]?.catalogCardId, '89777842', 'il payload di salvataggio deve inviare la artwork B — questo è ciò che la Raccolta mostrerà riaprendo il dettaglio');
assert.equal(savedPayload?.[0]?.imageUrl, ARTWORK_B_URL);
assert.equal(savedPayload?.[0]?.rarity, RARITY);
clearTimeout(controller.persistTimer); clearTimeout(controller.feedbackTimer);
console.log('PASS CH01-EN015: la scelta artwork B sopravvive alla entry di sessione e al payload di salvataggio (nessun fallback ad artworks[0])');

// --- guardia anti-regressione (audit OCR 2026-09-17): un findCardById lento
//     (rete reale su mobile) NON deve MAI rallentare externalLookupViaRegistry
//     con cache fredda. Prima del fix, questo era esattamente l'await
//     bloccante che rendeva ogni scan con artwork ambiguo molto più lento. ---
{
  const guardApi = fakeApi({ ygoArtworkIndexLookup: async () => [{ konami_card_id: GUARD_KONAMI_ID, artwork_count: 2, single_artwork_url: null }] });
  const guardFindCard = async name => name === GUARD_CARD_NAME ? { id: Number(GUARD_CATALOG_ID), name } : null;
  const guardLookupPrintingBySetCode = async code => code === GUARD_SET_CODE ? [{ catalogCardId: GUARD_CATALOG_ID, setCode: GUARD_SET_CODE, setName: 'Set', rarity: 'Common' }] : [];
  function slowDelay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  const slowFindCardByIdImpl = async () => { await slowDelay(400); return { artworkVariants: [{ id: '1', imageUrl: 'a.jpg' }, { id: '2', imageUrl: 'b.jpg' }] }; };
  const startedAt = Date.now();
  const guardResult = await externalLookupViaRegistry(GUARD_SET_CODE, 'yugioh', { api: guardApi, findCard: guardFindCard, findCardByIdImpl: slowFindCardByIdImpl, lookupPrintingBySetCodeImpl: guardLookupPrintingBySetCode });
  const elapsedMs = Date.now() - startedAt;
  assert(elapsedMs < 100, `externalLookupViaRegistry non deve attendere la rete artwork (findCardById lento simulato): ${elapsedMs}ms trascorsi, doveva restare cache-only`);
  assert.equal(guardResult.length, 1, 'cache fredda: un solo match base, mai bloccato in attesa delle varianti');
}
console.log('PASS guardia anti-regressione: findCardById lento non blocca mai externalLookupViaRegistry (cache fredda)');

// --- una sola artwork nota: nessun picker aggiuntivo ---
{
  const singleArtworkController = new FastScanController({
    camera: { focusSupported: false }, ocr: {}, api: { lookupPrintings: async () => [] },
    externalLookup: async code => code === 'DRLG-IT024' ? [{ printingId: '', game: 'yugioh', catalogCardId: '999', cardName: "Ra's Disciple", setCode: 'DRLG-IT024', setName: 'Set', rarity: 'Secret Rare', imageUrl: 'https://example.test/single.jpg' }] : [],
    getCollection: () => ({ mine: [], team: [] }), isOnline: () => true, onRender(){}, onRoute(){}
  });
  const singleResult = await singleArtworkController.resolve('DRLG-IT024', 95, { consensus: 2 });
  assert.equal(singleResult.status, 'high_confidence', 'una sola artwork nota deve auto-accettarsi normalmente');
  assert.equal(singleResult.matches.length, 1);
  clearTimeout(singleArtworkController.persistTimer); clearTimeout(singleArtworkController.feedbackTimer);
}
console.log('PASS carta con una sola artwork nota: auto-accept normale, nessun picker aggiuntivo');

// --- 8-9) nessuna cronologia tecnica nella UI normale, solo sotto ?debugScan=1 ---
{
  function artworkCandidate(imageUrl, index) {
    return { printingId: '', game: 'yugioh', catalogCardId: `id-${index}`, cardName: CARD_NAME, setCode: SET_CODE, setName: 'Set', rarity: RARITY, imageUrl, artworkLabel: index === 0 ? 'Standard' : 'Artwork alternativa' };
  }
  const normalController = new FastScanController({ camera: { focusSupported: false }, ocr: {}, api: {}, getCollection: () => ({ mine: [], team: [] }), isOnline: () => true, onRender(){}, onRoute(){} });
  normalController.buffer.add(artworkCandidate(ARTWORK_A_URL, 0));
  const normalReview = normalController.reviewView();
  assert.equal(normalController.debugMode, false, 'debugMode deve essere spento senza ?debugScan=1');
  assert.doesNotMatch(normalReview, /scan-history-review/, 'la cronologia tecnica non deve apparire nella UI normale');
  assert.doesNotMatch(normalController.scannerView(), /live-crop-debug/, 'il pannello debug non deve apparire senza ?debugScan=1');
  assert.doesNotMatch(normalReview, /EXACT_UNIQUE|NEAR_UNIQUE|high_confidence|resolutionVersion|executionMode|cacheState/, 'nessuna informazione tecnica nella schermata di sessione normale');

  globalThis.location = { search: '?debugScan=1' };
  const debugController = new FastScanController({ camera: { focusSupported: false }, ocr: {}, api: {}, getCollection: () => ({ mine: [], team: [] }), isOnline: () => true, onRender(){}, onRoute(){} });
  debugController.buffer.add(artworkCandidate(ARTWORK_A_URL, 0));
  assert.equal(debugController.debugMode, true, 'debugMode deve accendersi con ?debugScan=1');
  assert.match(debugController.reviewView(), /scan-history-review/, 'la cronologia tecnica compare SOLO sotto ?debugScan=1');
  clearTimeout(normalController.persistTimer); clearTimeout(debugController.persistTimer);
  delete globalThis.location;
}
console.log('PASS UI normale senza cronologia/pannelli tecnici; cronologia tecnica presente solo sotto ?debugScan=1');
