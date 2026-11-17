// Which Cardmarket product is which rarity — the evidence engine (2026-11-17).
//
// Cardmarket's public feeds list one product per printed version of a card but
// never say which rarity each one is, and its API is not open to us. So we
// collect independent clues from data we already have and only decide on our
// own when the clues agree:
//
//   template  — verified set template (ygo_market_variant_set_templates).
//               Trusted on its own.
//   learned   — the position (in idProduct order) that the SAME rarity took in
//               the SAME set when a team member confirmed a card one by one.
//               Bulk confirmations ("Conferma tutte") are not used: they always
//               picked the first product and taught nothing.
//   setRule   — the existing price-order rule of the set
//               (variant-price-order.js), when backed by OTHER cards. Backed
//               by 2+ other cards it is trusted on its own, as it was before
//               this engine (validated 2026-10-25 on 124 known printings).
//   tier      — this card's own prices: every version clearly apart and the
//               full rarity ladder known → k-th cheapest = k-th rarity.
//   base      — the owned rarity is the lowest of the ladder and one version is
//               clearly the cheapest (an extra unknown version is tolerated only
//               when the cheapest is far below everything else).
//
// Decision: any two clues disagreeing → conflict (nothing is written). A
// template, a learned position confirmed twice, or two different clues agreeing
// → "auto" (exact price from now on). A single clue → "suggest": the card stays
// in the confirmation queue with that version preselected.
import { RARITY_VALUE_TIER, setPrefixOf, familyKey } from './variant-price-order.js';

const STRONG = new Set(['template']);
export const EVIDENCE_LABELS = Object.freeze({
  template: 'template del set verificato',
  learned: 'stessa rarità confermata nel set',
  setRule: 'regola prezzi del set',
  tier: 'ordine dei prezzi della carta',
  base: 'rarità base, versione più economica',
});

export function sortedProductIds(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

// confirmations: [{setCode, rarity, candidateProductIds, productId}] — only
// single-card confirmations. Key = set prefix + number of versions + rarity.
export function learnPositions(confirmations = []) {
  const positions = new Map();
  for (const row of confirmations) {
    const ids = sortedProductIds(row.candidateProductIds);
    const index = ids.indexOf(String(row.productId || ''));
    if (ids.length < 2 || index < 0) continue;
    const key = learnedKey(row.setCode, ids.length, row.rarity);
    if (!key) continue;
    if (!positions.has(key)) positions.set(key, []);
    positions.get(key).push(index);
  }
  return positions;
}
export function learnedKey(setCode, versions, rarity) {
  const prefix = setPrefixOf(setCode), label = String(rarity || '').trim();
  return prefix && label ? `${prefix}#${versions}#${label}` : '';
}

function clearlyApart(values, ratio, gapEur) {
  return values.every((value, index) => index === 0 || (value >= values[index - 1] * ratio && value - values[index - 1] >= gapEur));
}

// targets: [{printingId, setCode, rarity, catalogCardId, candidateProductIds}]
// families: Map(familyKey → rarities[]) from buildRarityFamilies()
// priceOf(productId) → number|null
// templateAssignments / priceOrderAssignments: outputs of resolveBySetTemplates /
//   inferVariantsByPriceOrder (assignments) for the same targets
export function decideVariantsByEvidence({
  targets = [], families = new Map(), priceOf = () => null,
  templateAssignments = [], priceOrderAssignments = [], confirmations = [],
  tierRatio = 1.5, tierGapEur = 0.2, baseRatio = 1.5, baseGapEur = 0.2, extraVersionRatio = 3,
} = {}) {
  const byTemplate = new Map(templateAssignments.map(row => [String(row.printingId), row]));
  const bySetRule = new Map(priceOrderAssignments.map(row => [String(row.printingId), row]));
  const learned = learnPositions(confirmations);
  const decisions = [];
  for (const target of targets) {
    const printingId = String(target.printingId);
    const ids = sortedProductIds(target.candidateProductIds);
    if (ids.length < 2) continue;
    const rarity = String(target.rarity || '').trim();
    const signals = {};

    const template = byTemplate.get(printingId);
    if (template && ids.includes(String(template.productId))) signals.template = String(template.productId);

    const seen = learned.get(learnedKey(target.setCode, ids.length, rarity)) || [];
    let learnedCount = 0;
    if (seen.length && new Set(seen).size === 1) { signals.learned = ids[seen[0]]; learnedCount = seen.length; }
    else if (seen.length) signals.learnedConflict = true;

    const setRule = bySetRule.get(printingId);
    // Backed by other cards: a group decided only by this very card is the
    // "tier" clue again, not a second opinion.
    const setRuleBacking = setRule ? setRule.decisiveCards - (setRule.ownEvidence ? 1 : 0) : 0;
    if (setRule && ids.includes(String(setRule.productId)) && setRuleBacking >= 1) signals.setRule = String(setRule.productId);

    const ladder = (families.get(familyKey(target.catalogCardId, target.setCode)) || []).map(r => String(r).trim()).filter(Boolean);
    const prices = ids.map(id => priceOf(id));
    const priced = prices.every(p => Number.isFinite(p) && p > 0);
    const byPrice = priced ? ids.map((id, i) => ({ id, price: prices[i] })).sort((a, b) => a.price - b.price) : null;

    // tier: the whole ladder vs this card's own prices.
    if (byPrice && ladder.length === ids.length && ladder.includes(rarity) && ladder.every(r => RARITY_VALUE_TIER[r] != null)) {
      const ordered = [...ladder].sort((a, b) => RARITY_VALUE_TIER[a] - RARITY_VALUE_TIER[b]);
      const distinctTiers = new Set(ordered.map(r => RARITY_VALUE_TIER[r])).size === ordered.length;
      if (distinctTiers && clearlyApart(byPrice.map(row => row.price), tierRatio, tierGapEur)) signals.tier = byPrice[ordered.indexOf(rarity)].id;
    }

    // base: owned rarity is the unique lowest of the ladder.
    const mine = RARITY_VALUE_TIER[rarity];
    if (byPrice && mine != null && ladder.includes(rarity) && ladder.every(r => r === rarity || (RARITY_VALUE_TIER[r] != null && RARITY_VALUE_TIER[r] > mine))) {
      const [cheapest, next] = byPrice;
      const exactCount = ladder.length === ids.length;
      const oneUnknownExtra = ladder.length + 1 === ids.length;
      const ratio = exactCount ? baseRatio : extraVersionRatio;
      if ((exactCount || oneUnknownExtra) && next.price >= cheapest.price * ratio && next.price - cheapest.price >= baseGapEur) signals.base = cheapest.id;
    }

    const picks = Object.entries(signals).filter(([key]) => key !== 'learnedConflict');
    const distinct = new Set(picks.map(([, id]) => id));
    const kinds = picks.map(([key]) => key);
    let decision = 'none', productId = null;
    if (distinct.size > 1 || signals.learnedConflict) decision = 'conflict';
    else if (picks.length) {
      productId = picks[0][1];
      const strong = kinds.some(kind => STRONG.has(kind)) || learnedCount >= 2 || (kinds.includes('setRule') && setRuleBacking >= 2);
      decision = strong || kinds.length >= 2 ? 'auto' : 'suggest';
    }
    decisions.push({ printingId, productId, decision, signals: Object.fromEntries(picks), candidateProductIds: ids, learnedCount });
  }
  return decisions;
}

// Short Italian note for mapping_notes / the confirmation queue.
export function evidenceNote(decision) {
  const kinds = Object.keys(decision?.signals || {});
  if (!kinds.length) return '';
  return kinds.map(kind => EVIDENCE_LABELS[kind] || kind).join(' + ').slice(0, 1000);
}

export function summarizeEvidence(decisions = []) {
  const counts = { auto: 0, suggest: 0, conflict: 0, none: 0 };
  for (const row of decisions) counts[row.decision] = (counts[row.decision] || 0) + 1;
  return counts;
}

// Cosa mostrare all'admin per OGNI versione Cardmarket di una carta in coda:
// prezzo e rarità stimata. Cardmarket non dice la rarità, quindi la stima
// viene dalla scala di rarità del set (catalogo, tutte le lingue) e
// dall'ordine dei prezzi:
//   - scala completa + prezzi ben distinti → ogni versione ha la sua rarità;
//   - una versione nettamente più economica → è la rarità più bassa del set,
//     le altre "una tra" le rarità restanti;
//   - altrimenti solo il prezzo.
// decision (opzionale): la versione scelta dal motore riceve la rarità posseduta.
// → [{productId, version, price, rarity, among}] in ordine di idProduct (V.1…).
export function describeVersions({ target, families = new Map(), priceOf = () => null, decision = null, tierRatio = 1.5, tierGapEur = 0.2, baseRatio = 1.5, baseGapEur = 0.2 } = {}) {
  const ids = sortedProductIds(target?.candidateProductIds);
  const rarity = String(target?.rarity || '').trim();
  const ladder = [...new Set((families.get(familyKey(target?.catalogCardId, target?.setCode)) || []).map(r => String(r).trim()).filter(Boolean))];
  const rows = ids.map((productId, index) => {
    const price = priceOf(productId);
    return { productId, version: index + 1, price: Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null, rarity: null, among: null };
  });
  const priced = rows.every(row => row.price != null);
  const byPrice = priced ? [...rows].sort((a, b) => a.price - b.price) : null;
  const known = ladder.length && ladder.every(r => RARITY_VALUE_TIER[r] != null);
  if (byPrice && known && ladder.length === rows.length) {
    const ordered = [...ladder].sort((a, b) => RARITY_VALUE_TIER[a] - RARITY_VALUE_TIER[b]);
    if (new Set(ordered.map(r => RARITY_VALUE_TIER[r])).size === ordered.length && clearlyApart(byPrice.map(row => row.price), tierRatio, tierGapEur)) {
      byPrice.forEach((row, rank) => { row.rarity = ordered[rank]; });
    }
  }
  // La versione nettamente più economica è la rarità più bassa del set (unica),
  // qualunque sia quella posseduta: le altre sono "una tra" le rarità restanti.
  const lowest = known ? [...ladder].sort((x, y) => RARITY_VALUE_TIER[x] - RARITY_VALUE_TIER[y])[0] : null;
  if (byPrice && !rows.some(row => row.rarity) && lowest && ladder.every(r => r === lowest || RARITY_VALUE_TIER[r] > RARITY_VALUE_TIER[lowest])) {
    const [cheapest, next] = byPrice;
    if (next && next.price >= cheapest.price * baseRatio && next.price - cheapest.price >= baseGapEur) {
      cheapest.rarity = lowest;
      const others = ladder.filter(r => r !== lowest);
      for (const row of rows) if (row !== cheapest && others.length) row.among = others;
    }
  }
  if (decision?.productId && rarity) {
    const chosen = rows.find(row => row.productId === String(decision.productId));
    if (chosen && !chosen.rarity) chosen.rarity = rarity;
  }
  return rows;
}
