// Stesso identico seed della migration
// supabase/migrations/20260912200000_ygo_market_variant_set_templates.sql
// (tabella ygo_market_variant_set_templates) — per lo script di dry-run
// offline (scripts/market-variant-set-template-dry-run.mjs), che non ha un
// client Postgres riga-per-riga a disposizione. SOLO RA01/RA02, verificati:
// se aggiungi un set alla migration, aggiorna anche questo file.
export const SET_TEMPLATE_SEED = [
  { setPrefix: 'RA01', variantNumber: 1, rarityCanonical: 'SUPER_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 2, rarityCanonical: 'ULTRA_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 3, rarityCanonical: 'SECRET_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 4, rarityCanonical: 'PLATINUM_SECRET_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 5, rarityCanonical: 'QUARTER_CENTURY_SECRET_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 6, rarityCanonical: 'COLLECTORS_RARE', verified: true },
  { setPrefix: 'RA01', variantNumber: 7, rarityCanonical: 'ULTIMATE_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 1, rarityCanonical: 'SUPER_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 2, rarityCanonical: 'ULTRA_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 3, rarityCanonical: 'SECRET_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 4, rarityCanonical: 'PLATINUM_SECRET_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 5, rarityCanonical: 'QUARTER_CENTURY_SECRET_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 6, rarityCanonical: 'COLLECTORS_RARE', verified: true },
  { setPrefix: 'RA02', variantNumber: 7, rarityCanonical: 'ULTIMATE_RARE', verified: true }
];
