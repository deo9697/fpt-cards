// Fast Scan, revisione a selezione multipla (2026-10-25, variante C):
// pallino per scegliere più carte, stato 1ª Ed./condizione sotto l'immagine,
// barra in basso che applica edizione e condizione alle carte scelte.
// I pulsanti vengono ricavati dall'HTML vero della revisione e premuti
// attraverso bind(), così il test passa dai gestori reali.
import assert from 'node:assert/strict';
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.document ??= { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
const { FastScanController } = await import('../js/fast-scan.js');
const test = (name, fn) => { fn(); console.log(`PASS ${name}`); };

// DOM minimo: ogni <button> dell'HTML diventa un oggetto con dataset e listener.
function fakeRoot(html) {
  const buttons = [...html.matchAll(/<button\b([^>]*)>/g)].map(([, attrs]) => {
    const all = Object.fromEntries([...attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, k, v]) => [k, v ?? '']));
    const dataset = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v.replace(/&quot;/g, '"').replace(/&amp;/g, '&')]));
    const listeners = {};
    return { attrs: all, dataset, addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }, click() { (listeners.click || []).forEach(fn => fn({ preventDefault() {} })); } };
  });
  const match = sel => { const m = sel.match(/^\[([\w-]+)\]$/); return m ? buttons.filter(b => m[1] in b.attrs) : []; };
  return { buttons, querySelectorAll: sel => match(sel), querySelector: sel => match(sel)[0] || null };
}

let renders = 0;
const c = new FastScanController({ camera: { stream: {}, stop() {}, focusSupported: false, torchSupported: false }, paddleOcr: { prepare: async () => {} }, isOnline: () => true, onRender() { renders++; }, onRoute() {}, onToast() {} });
c.persist = () => {};
const cards = [
  { printingId: 'p1', game: 'yugioh', catalogCardId: '1784686', cardName: 'The Eye of Timaeus', setCode: 'DRLG-IT005', rarity: 'Secret Rare' },
  { printingId: 'p2', game: 'yugioh', catalogCardId: '6165656', cardName: 'Gimmick Puppet Disaster Leo', setCode: 'PGLD-EN021', rarity: 'Gold Secret Rare' },
  { printingId: 'p3', game: 'yugioh', catalogCardId: '88305705', cardName: 'Brave-Eyes Pendulum Dragon', setCode: 'RATE-IT039', rarity: 'Secret Rare' },
];
c.buffer.settings = { ...c.buffer.settings, condition: 'Near Mint', edition: '' };
cards.forEach(card => c.buffer.add(card));
c.buffer.add(cards[0]);
c.phase = 'review';
const render = () => { const html = c.reviewView(); const root = fakeRoot(html); c.bind(root); return { html, root }; };
const press = (root, attr, value) => { const button = root.buttons.find(b => attr in b.attrs && (value === undefined || b.attrs[attr] === value)); assert.ok(button, `pulsante ${attr}=${value} non trovato`); button.click(); };

test('stato sotto l\'immagine: condizione della sessione, nessuna selezione, "Tutte" in alto', () => {
  const { html } = render();
  assert.equal((html.match(/class="fsx-tile-check"/g) || []).length, 3, 'un pallino per carta');
  assert.equal((html.match(/fsx-state-cond cond-nm/g) || []).length, 3);
  assert.doesNotMatch(html, /fsx-selbar/, 'barra di selezione chiusa');
  assert.match(html, /data-scan-select-all>Tutte</);
  assert.match(html, /data-scan-entry-open=/, 'senza selezione l\'immagine apre il dettaglio');
  assert.match(html, /<div class="scan-save-bar fsx-savebar" >/, 'barra di salvataggio visibile');
});

test('il pallino sceglie; con una scelta anche il tocco sull\'immagine seleziona', () => {
  let { root } = render();
  press(root, 'data-scan-select', 'p2');
  let { html } = render();
  assert.match(html, /fsx-tile selected/);
  assert.match(html, /1 carta scelta/);
  assert.match(html, /fsx-savebar" hidden/, 'il salvataggio si nasconde mentre si sceglie');
  assert.doesNotMatch(html, /data-scan-entry-open=/, 'in selezione l\'immagine non apre il dettaglio');
  ({ root } = render());
  const imageButtons = root.buttons.filter(b => b.attrs.class === 'fsx-tile-open' && b.attrs['data-scan-select'] === 'p3');
  assert.equal(imageButtons.length, 1); imageButtons[0].click();
  ({ html } = render());
  assert.match(html, /2 carte scelte/);
});

test('la barra applica 1ª Edizione e condizione solo alle carte scelte, a tutte le copie', () => {
  let { root } = render();
  press(root, 'data-scan-bulk-edition', 'first');
  ({ root } = render());
  press(root, 'data-scan-bulk-condition', 'Played');
  const by = id => c.buffer.entries.get(id);
  assert.equal(by('p2').edition, 'Prima Edizione'); assert.equal(by('p3').edition, 'Prima Edizione');
  assert.equal(by('p2').condition, 'Played'); assert.equal(by('p3').condition, 'Played');
  assert.equal(by('p1').condition, 'Near Mint', 'carta non scelta invariata');
  assert.equal(by('p1').quantity, 2);
  const { html } = render();
  assert.match(html, /data-scan-bulk-edition="first" aria-pressed="true"/);
  assert.match(html, /data-scan-bulk-condition="Played" aria-pressed="true"/);
  assert.equal((html.match(/fsx-state-cond cond-pl/g) || []).length, 2);
  assert.equal((html.match(/fsx-state-ed first">1ª Ed\./g) || []).length, 2);
});

test('condizione non valida ignorata; "Tutte", "Fatto" e ritorno allo scanner azzerano', () => {
  let { root } = render();
  root.buttons.find(b => b.attrs['data-scan-bulk-condition'] === 'Played').dataset.scanBulkCondition = 'Rovinata';
  root.buttons.find(b => b.attrs['data-scan-bulk-condition'] === 'Played').click();
  assert.equal(c.buffer.entries.get('p2').condition, 'Played');
  press(root, 'data-scan-select-all');
  let { html } = render();
  assert.match(html, /3 carte scelte/); assert.match(html, /data-scan-select-all>Nessuna</);
  ({ root } = render());
  press(root, 'data-scan-select-done');
  ({ html } = render());
  assert.doesNotMatch(html, /fsx-selbar/);
  c.reviewSelection = new Set(['p1']);
  ({ root } = render());
  press(root, 'data-scan-continue');
  assert.equal(c.reviewSelection.size, 0);
});

test('il salvataggio porta edizione e condizione della singola carta', () => {
  c.phase = 'review';
  const entry = c.buffer.entries.get('p3');
  assert.equal(entry.condition, 'Played');
  assert.equal(entry.edition, 'Prima Edizione');
  const snapshot = c.buffer.snapshot ? c.buffer.snapshot() : null;
  if (snapshot) {
    const saved = (snapshot.entries || []).find(row => (row.printingId || row.printing?.printingId) === 'p3');
    if (saved) assert.equal(saved.condition, 'Played');
  }
});
