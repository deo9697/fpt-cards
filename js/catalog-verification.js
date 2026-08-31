export const CATALOG_VERIFICATION_VERSION = 1;

export async function verifyPendingCollectionCatalog({
  api,
  resolveCard,
  onVerified = () => {},
  attempted = new Set(),
  concurrency = 4
} = {}) {
  const stats = { queued:0, providerRequests:0, verified:0, failed:0, unavailable:false };
  let rows;
  try {
    rows = await api.catalogVerificationQueue(CATALOG_VERIFICATION_VERSION);
  } catch {
    stats.unavailable = true;
    return stats;
  }
  const candidates = (rows || []).filter(row => {
    const id = row.collection_item_id || row.collectionItemId || row.id;
    const key = `${id}:${CATALOG_VERIFICATION_VERSION}`;
    if (!id || attempted.has(key)) return false;
    attempted.add(key);
    return true;
  });
  stats.queued = candidates.length;
  await runLimited(candidates, concurrency, async row => {
    stats.providerRequests += 1;
    try {
      const card = await resolveCard({
        id:row.catalog_card_id || row.catalogCardId || '',
        name:row.card_name || row.cardName || '',
        setCode:row.set_code || row.setCode || ''
      }, row.game || 'yugioh');
      if (!card) { stats.failed += 1; return; }
      const repaired = await api.repairCollectionCatalogIdentity({
        collectionItemId:row.collection_item_id || row.collectionItemId || row.id,
        catalogCardId:String(card.id),
        cardName:card.name,
        imageUrl:card.fullImage || card.image || '',
        verificationVersion:CATALOG_VERIFICATION_VERSION
      });
      stats.verified += 1;
      onVerified(row, repaired, card);
    } catch {
      // Il record resta pending: un errore provider/RPC non modifica inventario o verifica.
      stats.failed += 1;
    }
  });
  return stats;
}

async function runLimited(items, limit, task) {
  let cursor = 0;
  const workers = Array.from({ length:Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) await task(items[cursor++]);
  });
  await Promise.all(workers);
}
