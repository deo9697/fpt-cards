// SPDX-License-Identifier: AGPL-3.0-or-later
// Compatibility patches for pinned Project Ignis scripts. Keep each
// replacement scoped to its original statement and preserve the source notices.
const fixes = [
  // Spirit Elimination leaves no eligible GY materials for this Ritual.
  ['c60921537.lua', 'Group.NewGroup()', 'Group.CreateGroup()'],
  // A Plant can free a Main Monster Zone only from sequences 0–4.
  ['c11747708.lua', 'c:IsInMainZone()', 'c:GetSequence()<5'],
  // Level Down needs the published archetype constant on each Horus LV.
  ...[75830094, 11224103, 48229808].map(code => [
    `c${code}.lua`,
    's.LVset=SET_HORUS_BLACK_FLAME_DRAGON',
    's.LVset=SET_HORUS_THE_BLACK_FLAME_DRAGON',
  ]),
];

export function applyTcgR3ScriptFixes(scripts) {
  for (const [file, before, after] of fixes) {
    const original = scripts.get(`official/${file}`);
    if (original !== scripts.get(file) || original?.split(before).length !== 2) {
      throw new Error(`Pinned automatic script does not match the compatibility patch: ${file}`);
    }
    const updated = original.replace(before, after);
    scripts.set(`official/${file}`, updated);
    scripts.set(file, updated);
  }
}
