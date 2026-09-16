// Fast Scan caso 4 — riconciliazione POST-SAVE di printing_mapping_status
// unresolved/conflict (ygo_printing_registry/card_printings), scoped alle
// sole printing REALMENTE possedute dal chiamante (vedi supabase/migrations/
// 20260917100000_ygo_printing_mapping_reconciliation_queue.sql). Stesso
// principio di js/catalog-verification.js per catalog_verification_status
// (case 3): un batch piccolo e limitato, letto DOPO che i dati sono già
// salvati, mai un gate sul salvataggio stesso, mai un arricchimento della
// cache locale di Fast Scan (js/fast-scan-catalog-cache.js resta invariata).
//
// Riusa la pipeline di risoluzione/scrittura già esistente e matura
// (resolveYgoPrintings di js/ygo-printing-registry.js, la STESSA che Fast
// Scan chiama già in scansione): questo modulo si limita a decidere QUALI
// set code proporle, filtrando i 'conflict' (richiedono revisione umana per
// design — vedi apply_ygo_printing_mappings — ririsolverli produrrebbe solo
// lo stesso conflitto salvato di nuovo, uno spreco di richieste YGOResources
// senza mai convergere) e a interpretarne l'esito in statistiche.
import { resolveYgoPrintings as defaultResolve } from './ygo-printing-registry.js';

export const PRINTING_MAPPING_RECONCILIATION_BATCH_LIMIT = 20;

export async function reconcileYgoPrintingMappings({
  api,
  resolve = defaultResolve,
  limit = PRINTING_MAPPING_RECONCILIATION_BATCH_LIMIT,
  log = () => {}
} = {}) {
  const stats = { queued: 0, conflicts: 0, resolved: 0, stillUnresolved: 0, unavailable: false };
  let rows;
  try {
    rows = await api.collectionPrintingMappingQueue(limit);
  } catch (error) {
    stats.unavailable = true;
    log({ stage: 'queue', error });
    return stats;
  }
  const candidates = rows || [];
  stats.queued = candidates.length;
  if (!candidates.length) return stats;

  const actionable = [];
  for (const row of candidates) {
    const status = row.mapping_status || row.mappingStatus || 'unresolved';
    if (status === 'conflict') stats.conflicts += 1;
    else actionable.push(row.set_code || row.setCode);
  }
  if (!actionable.length) return stats;

  try {
    const results = await resolve(actionable, { api });
    for (const printing of results.values()) {
      if (printing?.mappingStatus === 'resolved' || printing?.mappingStatus === 'verified') stats.resolved += 1;
      else stats.stillUnresolved += 1;
    }
  } catch (error) {
    stats.unavailable = true;
    log({ stage: 'resolve', error });
  }
  return stats;
}
