export const CATALOG_VERIFICATION_VERSION = 1;
// Un batch piccolo e limitato server-side (list_collection_catalog_verification_queue
// clampa comunque p_limit a 50): il bootstrap di una sessione normale non deve mai
// processare l'intera coda pending (che può contare migliaia di righe legacy).
export const CATALOG_VERIFICATION_BATCH_LIMIT = 20;

// Verifica/ripara un batch piccolo e limitato della coda pending — MAI l'intera
// coda. I fallimenti (provider assente, immagine mancante, ID/immagine
// incoerenti) vengono persistiti via api.recordCatalogVerificationFailure così
// il record entra in backoff invece di essere ritentato identico a ogni
// bootstrap futuro (vedi la nuova RPC record_collection_catalog_verification_attempt).
export async function verifyPendingCollectionCatalog({
  api,
  resolveCard,
  onVerified = () => { },
  concurrency = 4,
  limit = CATALOG_VERIFICATION_BATCH_LIMIT,
  log = () => { }
} = {}) {
  const stats = { queued: 0, providerRequests: 0, verified: 0, failed: 0, unavailable: false };
  let rows;
  try {
    rows = await api.catalogVerificationQueue(CATALOG_VERIFICATION_VERSION, { limit });
  } catch (error) {
    stats.unavailable = true;
    log({ stage: 'queue', error });
    return stats;
  }
  const candidates = rows || [];
  stats.queued = candidates.length;
  await runLimited(candidates, concurrency, async row => {
    const collectionItemId = row.collection_item_id || row.collectionItemId || row.id;
    stats.providerRequests += 1;
    try {
      const card = await resolveCard({
        id: row.catalog_card_id || row.catalogCardId || '',
        name: row.card_name || row.cardName || '',
        setCode: row.set_code || row.setCode || ''
      }, row.game || 'yugioh');
      if (!card) {
        stats.failed += 1;
        await recordFailure(api, collectionItemId, 'ambiguous', 'Nessuna corrispondenza trovata nel catalogo provider', log);
        return;
      }
      const imageUrl = card.fullImage || card.image || '';
      if (!imageUrl) {
        // Meglio lasciare il record pending/in backoff che chiamare la repair
        // con un'immagine vuota: fallirebbe comunque la validazione lato RPC.
        stats.failed += 1;
        await recordFailure(api, collectionItemId, 'missing_image', 'Il provider non ha restituito un URL immagine valido', log);
        return;
      }
      const repaired = await api.repairCollectionCatalogIdentity({
        collectionItemId,
        catalogCardId: String(card.id),
        cardName: card.name,
        imageUrl,
        verificationVersion: CATALOG_VERIFICATION_VERSION
      });
      stats.verified += 1;
      onVerified(row, repaired, card);
    } catch (error) {
      // Il record resta pending (in backoff dopo recordFailure): un errore
      // provider/RPC non modifica inventario o verifica.
      stats.failed += 1;
      log({ stage: 'repair', collectionItemId, game: row.game, error });
      await recordFailure(api, collectionItemId, 'failed', error?.message || String(error), log);
    }
  });
  return stats;
}

async function recordFailure(api, collectionItemId, outcome, message, log) {
  if (!collectionItemId || typeof api.recordCatalogVerificationFailure !== 'function') return;
  try {
    await api.recordCatalogVerificationFailure(collectionItemId, CATALOG_VERIFICATION_VERSION, outcome, message);
  } catch (error) {
    log({ stage: 'record-failure', collectionItemId, error });
  }
}

async function runLimited(items, limit, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) await task(items[cursor++]);
  });
  await Promise.all(workers);
}
