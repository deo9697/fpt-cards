// market-sync/index.ts importa da ../_shared/ (deploy via CLI, 2026-10-25):
// i test che lo eseguono in un vm.Script non possono usare `import`. Qui ogni
// riga di import diventa una destrutturazione da un global che
// withSharedModules() mette nel contesto, con le stesse funzioni del modulo vero.
import { stripTypeScriptTypes } from 'node:module';
import * as variantPriceOrder from '../../supabase/functions/_shared/variant-price-order.js';
import * as variantEvidence from '../../supabase/functions/_shared/variant-evidence.js';

const SHARED_MODULES = {
  'variant-price-order.js': '__variantPriceOrder',
  'variant-evidence.js': '__variantEvidence',
};
const SHARED_IMPORT = /^import\s*\{([^}]+)\}\s*from\s*'\.\.\/_shared\/([a-z-]+\.js)';[ \t]*$/gm;

export function marketSyncForVm(source) {
  return stripTypeScriptTypes(source).replace(SHARED_IMPORT, (line, names, file) => {
    const global = SHARED_MODULES[file];
    if (!global) throw new Error(`market-sync-vm: modulo condiviso sconosciuto ${file}`);
    return `const {${names}}=globalThis.${global};`;
  });
}
export function withSharedModules(context) {
  context.__variantPriceOrder = variantPriceOrder;
  context.__variantEvidence = variantEvidence;
  return context;
}
