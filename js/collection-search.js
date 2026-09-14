import { collectionNameAliases } from './collection-name-aliases.js';

// Collection text only: deliberately independent of identity/printing matching.
export function normalizeCollectionSearch(value) {
  return (typeof value === 'string' ? value : '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/['’‘`´\-‐‑–—]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function collectionSearchAliases(item) {
  const metadata = item.game_metadata || {};
  const names = item.game === 'yugioh'
    ? collectionNameAliases[String(item.catalogCardId ?? item.catalog_card_id ?? '')] || [] : [];
  return [...new Set([
    item.cardName, item.card_name, item.localizedName, metadata.localizedName,
    ...(Array.isArray(item.searchAliases) ? item.searchAliases : []),
    ...(Array.isArray(item.alternateNames) ? item.alternateNames : []),
    ...(Array.isArray(metadata.searchAliases) ? metadata.searchAliases : []),
    ...names
  ].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

export function collectionSearchText(item) {
  // Delimiter prevents a query from accidentally spanning two unrelated fields.
  return [...new Set([
    ...collectionSearchAliases(item), item.setCode, item.setName, item.rarity
  ].map(normalizeCollectionSearch).filter(Boolean))].join('\n');
}

export function matchesCollectionQuery(item, normalizedQuery) {
  return !normalizedQuery || collectionSearchText(item).includes(normalizedQuery);
}

// Enrich once when collection data is loaded. Reuse names from all available
// printings, without extra RPCs or sharing private inventory data externally.
export function enrichCollectionAliases(collection) {
  const namesByCard = new Map();
  const keyFor = item => {
    const id = String(item.catalogCardId ?? item.catalog_card_id ?? '').trim();
    return item.game && id ? `${item.game}:${id}` : '';
  };
  for (const item of [...(collection.mine || []), ...(collection.team || [])]) {
    const key = keyFor(item);
    if (!key) continue;
    const names = namesByCard.get(key) || new Set();
    collectionSearchAliases(item).forEach(name => names.add(name));
    namesByCard.set(key,names);
  }
  const enrich = item => ({...item, searchAliases:[...(namesByCard.get(keyFor(item)) || collectionSearchAliases(item))]});
  return {...collection, mine:(collection.mine || []).map(enrich), team:(collection.team || []).map(enrich)};
}

export function collectionAliasGaps(items) {
  const gaps = new Map();
  for (const item of items) {
    if (item.game !== 'yugioh') continue;
    const id = String(item.catalogCardId ?? item.catalog_card_id ?? '').trim();
    if (collectionNameAliases[id]) continue;
    const key = id || `missing:${item.printingId ?? item.printing_id ?? item.id}`;
    const gap = gaps.get(key) || {catalogCardId:id, cardName:item.cardName || item.card_name || '', printings:0, knownNames:[]};
    gap.printings++;
    gap.knownNames = [...new Set([...gap.knownNames, ...collectionSearchAliases(item)])];
    gaps.set(key,gap);
  }
  return [...gaps.values()].sort((a,b)=>b.printings-a.printings || a.cardName.localeCompare(b.cardName));
}
