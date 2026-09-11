// Sfondo per tipo carta (Yu-Gi-Oh! soltanto): magia/trappola/mostro fusione
// mostrano lo sfondo dietro l'immagine, dietro al clic in Raccolta e su ogni
// tile della Shared Collection guest. Test puro, nessun DOM/rete: verifica
// solo il mapping tipo->asset e che i file esistano davvero sul disco (i
// nomi hanno refusi voluti — "backgroudn"/"backgroud" — un rename "corretto"
// futuro romperebbe la funzione senza toccare la sua firma).
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { backgroundForCardType } = await import('../js/cards.js');

assert.equal(backgroundForCardType('Spell Card'), 'assets/background/spell_background.png');
assert.equal(backgroundForCardType('Trap Card'), 'assets/background/trap_backgroud.png');
assert.equal(backgroundForCardType('Fusion Monster'), 'assets/background/fusion_monster_backgroudn.png');
// Varianti reali YGOPRODeck che contengono comunque "Fusion"/"Spell"/"Trap".
assert.equal(backgroundForCardType('Pendulum Effect Fusion Monster'), 'assets/background/fusion_monster_backgroudn.png');
assert.equal(backgroundForCardType('Quick-Play Spell Card'), 'assets/background/spell_background.png');
assert.equal(backgroundForCardType('Counter Trap Card'), 'assets/background/trap_backgroud.png');
// Nessun asset per gli altri tipi: non si inventa uno sfondo che non esiste.
for (const type of ['Normal Monster', 'Effect Monster', 'Synchro Monster', 'Xyz Monster', 'Link Monster', 'Ritual Monster', '', undefined, null])
  assert.equal(backgroundForCardType(type), '', `${type}: non deve avere uno sfondo per tipo`);

for (const relative of ['assets/background/spell_background.png', 'assets/background/trap_backgroud.png', 'assets/background/fusion_monster_backgroudn.png'])
  assert(fs.existsSync(new URL(`../${relative}`, import.meta.url)), `asset mancante sul disco: ${relative} (il mapping in backgroundForCardType punta a un file che non esiste più)`);

console.log('PASS backgroundForCardType: spell/trap/fusion (incl. varianti pendulum/quick-play/counter) mappati ai 3 asset reali · nessuno sfondo inventato per gli altri tipi');
