// Pure build-time validation, separate from runtime search and identity logic.
export function buildCollectionAliases(english, italian, reviewed, previous = {}) {
  const aliases = {};
  const missingItalian = [];
  const changed = [];
  const retained = [];
  for (const [id, en] of [...english].sort(([a],[b]) => a.localeCompare(b))) {
    if (!/^\d{1,10}$/.test(id) || typeof en !== 'string' || !en.trim()) throw Error(`Invalid English entry: ${id}`);
    const it = italian.get(id);
    if (typeof it === 'string' && it.trim()) aliases[id] = [...new Set([en.trim(), it.trim()])];
    else missingItalian.push({ catalogCardId:id, englishName:en });
  }
  const reviewedIds = new Set();
  for (const row of reviewed) {
    const id = row.catalogCardId;
    if (row.game !== 'yugioh' || english.get(id) !== row.expectedEnglishName || !row.source || !row.reviewedAt
        || !Array.isArray(row.aliases) || !row.aliases.length || row.aliases.some(name => typeof name !== 'string' || !name.trim())) {
      throw Error(`Invalid reviewed alias or changed identity: ${id}`);
    }
    reviewedIds.add(id);
    aliases[id] = [...new Set([...(aliases[id] || [english.get(id)]), ...row.aliases.map(name => name.trim())])];
  }
  for (const [id, names] of Object.entries(previous)) {
    if (!english.has(id)) throw Error(`Previously indexed ID missing from English catalog: ${id}`);
    const next = aliases[id] || [english.get(id)];
    const old = names.filter(name => !next.includes(name));
    if (old.length) {
      retained.push({catalogCardId:id, aliases:old});
      aliases[id] = [...new Set([...next, ...old])];
    }
    if (JSON.stringify(names) !== JSON.stringify(aliases[id])) changed.push(id);
  }
  return { aliases, report: {
    englishCards:english.size, italianCards:italian.size,
    indexedCards:Object.keys(aliases).length,
    reviewedCards:reviewedIds.size, changedIds:changed, retainedAliases:retained,
    missingItalian:missingItalian.filter(row => !reviewedIds.has(row.catalogCardId))
  }};
}
