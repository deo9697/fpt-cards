// Mapping of modal card-type backgrounds to optimized local assets.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { backgroundForCardType } = await import('../js/cards.js');

assert.equal(backgroundForCardType('Spell Card'), 'assets/background/spell_background.webp');
assert.equal(backgroundForCardType('Trap Card'), 'assets/background/trap_backgroud.webp');
assert.equal(backgroundForCardType('Fusion Monster'), 'assets/background/fusion_monster_backgroudn.webp');
// Varianti reali YGOPRODeck che contengono comunque "Fusion"/"Spell"/"Trap".
assert.equal(backgroundForCardType('Pendulum Effect Fusion Monster'), 'assets/background/fusion_monster_backgroudn.webp');
assert.equal(backgroundForCardType('Quick-Play Spell Card'), 'assets/background/spell_background.webp');
assert.equal(backgroundForCardType('Counter Trap Card'), 'assets/background/trap_backgroud.webp');
// Nuovi sfondi (2026-11-09): synchro, xyz, link, rituale, pendulum.
const B = name => 'assets/background/' + name + '_background.webp';
assert.equal(backgroundForCardType('Synchro Monster'), B('synchro'));
assert.equal(backgroundForCardType('Synchro Tuner Monster'), B('synchro'));
assert.equal(backgroundForCardType('XYZ Monster'), B('xyz'));
assert.equal(backgroundForCardType('Link Monster'), B('link'));
assert.equal(backgroundForCardType('Ritual Effect Monster'), B('ritual'));
assert.equal(backgroundForCardType('Pendulum Effect Monster'), B('pendulum'));
assert.equal(backgroundForCardType('Pendulum Normal Monster'), B('pendulum'));
// Ibridi: vince il tipo di evocazione, come già per Fusion.
assert.equal(backgroundForCardType('Synchro Pendulum Effect Monster'), B('synchro'));
assert.equal(backgroundForCardType('XYZ Pendulum Effect Monster'), B('xyz'));
// Le Magie Rituali su YGOPRODeck hanno type 'Spell Card' (race Ritual): restano Magia.
assert.equal(backgroundForCardType('Spell Card'), 'assets/background/spell_background.webp');
// Nessun asset per gli altri tipi: non si inventa uno sfondo che non esiste.
for (const type of ['Normal Monster', 'Effect Monster', 'Tuner Monster', 'Token', '', undefined, null])
  assert.equal(backgroundForCardType(type), '', `${type}: non deve avere uno sfondo per tipo`);

for (const relative of ['assets/background/spell_background.webp', 'assets/background/trap_backgroud.webp', 'assets/background/fusion_monster_backgroudn.webp', B('synchro'), B('xyz'), B('link'), B('ritual'), B('pendulum')])
  assert(fs.existsSync(new URL(`../${relative}`, import.meta.url)), `asset mancante sul disco: ${relative}`);

console.log('PASS backgroundForCardType: spell/trap/fusion/synchro/xyz/link/rituale/pendulum mappati agli asset reali (ibridi: vince il tipo di evocazione) · nessuno sfondo inventato per normali/effetto');
