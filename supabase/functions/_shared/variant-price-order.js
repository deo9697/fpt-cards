// Which Cardmarket product is which rarity, when one card has several products
// in the same expansion (e.g. BETB-013 Secret + Starlight → 914739 + 915990).
//
// Cardmarket publishes no rarity per product (API closed, product pages behind
// Cloudflare), so without this the sync priced the card at the MINIMUM across
// products: a Starlight was shown at its Secret price.
//
// Two signals, both from public data we already download:
//   1. price — the pricier product is the more valuable rarity;
//   2. idProduct order — within a set Cardmarket adds the versions in a fixed
//      order (Starlight/QCSR/Ultimate usually after the base rarity; a few sets,
//      e.g. BLMM and L5DD, the other way round).
// Price alone is noisy (Super vs Ultra in RA01 differ by ~10%), so it is only
// used as evidence on cards where every product is clearly apart (≥ minSeparation×).
// Those "decisive" cards fix, per set + rarity combination, the id-order
// position of each rarity; the rule is then applied to every card of that
// group — including the ones whose prices are too close to tell. Any decisive
// card that disagrees blocks the whole group (it stays a labelled estimate).
// Validated 2026-10-25 on 124 printings with a known exact product.

// Value ladder (cheapest → priciest), only used to order the rarities of ONE
// card. Rarities with equal value can't be told apart by price → skipped.
export const RARITY_VALUE_TIER = Object.freeze({
  'Common': 0, 'Short Print': 0, 'Super Short Print': 0,
  'Rare': 1, 'Normal Parallel Rare': 1, 'Starfoil Rare': 1, 'Mosaic Rare': 1, 'Shatterfoil Rare': 1,
  'Duel Terminal Normal Parallel Rare': 1,
  'Super Rare': 2, 'Duel Terminal Rare Parallel Rare': 2,
  'Ultra Rare': 3, 'Gold Rare': 3, 'Premium Gold Rare': 3, 'Duel Terminal Super Parallel Rare': 3,
  'Secret Rare': 4, 'Ultra Parallel Rare': 4,
  'Ultimate Rare': 5, 'Prismatic Secret Rare': 5, 'Gold Secret Rare': 5, 'Platinum Rare': 5,
  'Duel Terminal Ultra Parallel Rare': 5,
  'Platinum Secret Rare': 6, 'Ghost/Gold Rare': 6,
  'Ghost Rare': 7, "Collector's Rare": 7,
  'Starlight Rare': 8, 'Quarter Century Secret Rare': 8,
});

export function setPrefixOf(setCode) {
  const match = String(setCode || '').trim().toUpperCase().match(/^([A-Z0-9]+)-/);
  return match ? match[1] : '';
}
// "BETB-IT013" → "013": the language letters change, the card number doesn't.
export function setNumberOf(setCode) {
  const tail = String(setCode || '').trim().toUpperCase().split('-')[1] || '';
  return tail.replace(/^[A-Z]+/, '');
}
export function familyKey(catalogCardId, setCode) {
  return `${catalogCardId}|${setPrefixOf(setCode)}|${setNumberOf(setCode)}`;
}
// Rarities of every printing of the same card + set number, any language.
export function buildRarityFamilies(printings) {
  const families = new Map();
  for (const row of printings || []) {
    const cid = row.catalog_card_id ?? row.catalogCardId, code = row.set_code ?? row.setCode, rarity = String(row.rarity || '').trim();
    if (!cid || !code || !rarity) continue;
    const key = familyKey(cid, code);
    if (!families.has(key)) families.set(key, new Set());
    families.get(key).add(rarity);
  }
  return new Map([...families].map(([key, set]) => [key, [...set]]));
}
export function guidePrice(row) {
  if (!row) return null;
  for (const field of ['trend', 'avg7', 'avg30', 'avg', 'low']) {
    const value = Number(row[field]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

// targets: [{printingId, setCode, rarity, catalogCardId, candidateProductIds}]
// families: Map(familyKey → rarities[]); priceOf(productId) → number|null.
export function inferVariantsByPriceOrder({ targets = [], families = new Map(), priceOf = () => null, minSeparation = 2, minGapEur = 0.25 } = {}) {
  const skipped = {};
  const skip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
  const cards = [];
  for (const target of targets) {
    const ids = [...new Set((target.candidateProductIds || []).map(String).filter(Boolean))].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    if (ids.length < 2) { skip('single_product'); continue; }
    const rarities = families.get(familyKey(target.catalogCardId, target.setCode)) || [];
    if (rarities.length !== ids.length) { skip('rarity_count_mismatch'); continue; }
    if (!rarities.includes(String(target.rarity || '').trim())) { skip('rarity_not_in_family'); continue; }
    if (rarities.some(rarity => RARITY_VALUE_TIER[rarity] == null)) { skip('unknown_rarity_value'); continue; }
    const ladder = [...rarities].sort((a, b) => RARITY_VALUE_TIER[a] - RARITY_VALUE_TIER[b]);
    if (new Set(ladder.map(r => RARITY_VALUE_TIER[r])).size !== ladder.length) { skip('rarity_value_tie'); continue; }
    // Decisive card: every product clearly apart in price → its own ordering.
    let order = null;
    const prices = ids.map(id => priceOf(id));
    if (prices.every(p => p != null)) {
      const byPrice = ids.map((id, index) => ({ index, price: prices[index] })).sort((a, b) => a.price - b.price);
      // Both a ratio and an absolute gap: between cent-cards ×2 is just noise.
      const apart = byPrice.every((row, i) => i === 0 || (row.price >= byPrice[i - 1].price * minSeparation && row.price - byPrice[i - 1].price >= minGapEur));
      if (apart) order = byPrice.map(row => row.index); // ladder rank → id-order index
    }
    cards.push({ target, ids, ladder, group: `${setPrefixOf(target.setCode)}|${ladder.join('<')}`, order });
  }
  const rules = new Map();
  for (const card of cards) {
    if (!card.order) continue;
    const key = card.order.join(',');
    const rule = rules.get(card.group) || { orders: new Map(), decisive: 0 };
    rule.orders.set(key, (rule.orders.get(key) || 0) + 1); rule.decisive++;
    rules.set(card.group, rule);
  }
  const assignments = [];
  for (const card of cards) {
    const rule = rules.get(card.group);
    if (!rule) { skip('no_decisive_evidence'); continue; }
    if (rule.orders.size !== 1) { skip('conflicting_evidence'); continue; }
    const order = [...rule.orders.keys()][0].split(',').map(Number);
    const rank = card.ladder.indexOf(String(card.target.rarity).trim());
    const productId = card.ids[order[rank]];
    assignments.push({
      printingId: card.target.printingId, productId, candidateProductIds: card.ids,
      group: card.group, decisiveCards: rule.decisive, ownEvidence: Boolean(card.order),
    });
  }
  return { assignments, skipped };
}

// Verified set templates (ygo_market_variant_set_templates: RA01–RA05) win over
// the price rule. variant_number = position in idProduct order (V.1 = lowest
// id), same convention the canary used when the templates were verified.
// templates: [{setPrefix, variantNumber, rarityCanonical, verified, candidateCount}]
// canonicalOf(rarityLabel) → canon code (e.g. 'Starlight Rare' → 'STARLIGHT_RARE').
export function resolveBySetTemplates({ targets = [], templates = [], canonicalOf = () => null } = {}) {
  const assignments = [];
  for (const target of targets) {
    const ids = [...new Set((target.candidateProductIds || []).map(String).filter(Boolean))].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    if (ids.length < 2) continue;
    const prefix = setPrefixOf(target.setCode), canon = canonicalOf(target.rarity);
    if (!prefix || !canon) continue;
    const matches = templates.filter(row => row.setPrefix === prefix && row.rarityCanonical === canon
      && (row.candidateCount == null || Number(row.candidateCount) === ids.length));
    if (matches.length !== 1 || !matches[0].verified) continue;
    const productId = ids[Number(matches[0].variantNumber) - 1];
    if (!productId) continue;
    assignments.push({ printingId: target.printingId, productId, candidateProductIds: ids, group: `${prefix}|template V.${matches[0].variantNumber}`, template: true });
  }
  return assignments;
}
