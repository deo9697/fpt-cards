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
// Nessun asset per gli altri tipi: non si inventa uno sfondo che non esiste.
for (const type of ['Normal Monster', 'Effect Monster', 'Synchro Monster', 'Xyz Monster', 'Link Monster', 'Ritual Monster', '', undefined, null])
  assert.equal(backgroundForCardType(type), '', `${type}: non deve avere uno sfondo per tipo`);

for (const relative of ['assets/background/spell_background.webp', 'assets/background/trap_backgroud.webp', 'assets/background/fusion_monster_backgroudn.webp'])
  assert(fs.existsSync(new URL(`../${relative}`, import.meta.url)), `asset mancante sul disco: ${relative} (il mapping in backgroundForCardType punta a un file che non esiste più)`);

console.log('PASS backgroundForCardType: spell/trap/fusion (incl. varianti pendulum/quick-play/counter) mappati ai 3 asset reali · nessuno sfondo inventato per gli altri tipi');
