// market-sync/index.ts importa da ../_shared/ (deploy via CLI, 2026-10-25):
// i test che lo eseguono in un vm.Script non possono usare `import`. Qui la
// riga diventa una destrutturazione da un global che withSharedModules()
// mette nel contesto, con le stesse funzioni del modulo vero.
import { stripTypeScriptTypes } from 'node:module';
import * as variantPriceOrder from '../../supabase/functions/_shared/variant-price-order.js';

const SHARED_IMPORT = /^import\s*\{([^}]+)\}\s*from\s*'\.\.\/_shared\/variant-price-order\.js';[ \t]*$/m;

export function marketSyncForVm(source) {
  return stripTypeScriptTypes(source).replace(SHARED_IMPORT, (_, names) => `const {${names}}=globalThis.__variantPriceOrder;`);
}
export function withSharedModules(context) {
  context.__variantPriceOrder = variantPriceOrder;
  return context;
}
