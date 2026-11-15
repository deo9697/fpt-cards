// "Vedi mercato" dal dettaglio Raccolta (2026-11-15): deve aprire il dettaglio
// Market Watch di QUELLA printing, anche quando non è nella prima pagina della
// lista paginata (prima si apriva solo la pagina Market, in un punto a caso).
import assert from 'node:assert/strict';
globalThis.window = { FPT_CONFIG: undefined, addEventListener: () => {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
globalThis.history = { state: null, pushState(state) { this.state = state; }, back() {} };
globalThis.location = { href: 'http://x/#/market' };
const { MarketWatchController } = await import('../js/market-watch.js');

const row = (id, code) => ({ printing_id: id, catalog_card_id: '1', card_name: 'Carta ' + id, set_code: code, set_name: 'Set', rarity: 'Ultra Rare', reference_price: 3.5, preferred_price: 3.5 });
const calls = [];
const make = () => {
  const toasts = [];
  const c = new MarketWatchController({
    api: {
      async marketWatchOwnedPage(game, opts) { calls.push(opts.query); return { items: opts.query === 'LOB-001' ? [row('p-far', 'LOB-001')] : [], total: 1, limit: 60, offset: 0 }; },
      async marketPriceHistory() { return [{ provider: 'cardmarket', price_type: 'trend', price: 3.5, captured_at: '2026-11-15T00:00:00Z' }]; }
    },
    getGame: () => 'yugioh', onRender() {}, onToast: m => toasts.push(m)
  });
  c.ownedPage = { items: [row('p-near', 'SDK-001')].map(r => ({ printingId: r.printing_id, cardName: r.card_name, setCode: r.set_code, sources: ['owned'], providers: {} })), total: 300, limit: 60, offset: 0 };
  return { c, toasts };
};

{ const { c } = make(); calls.length = 0;
  assert.equal(await c.focusPrinting('p-near', { query: 'SDK-001' }), true);
  assert.equal(c.selected, 'p-near'); assert.equal(calls.length, 0, 'già caricata: nessuna ricerca');
  console.log('PASS carta già nella lista: si apre subito il dettaglio'); }
{ const { c } = make(); calls.length = 0;
  assert.equal(await c.focusPrinting('p-far', { query: 'LOB-001' }), true);
  assert.equal(c.selected, 'p-far'); assert.deepEqual(calls, ['LOB-001']);
  assert.ok(c.findItem('p-far'), 'la carta trovata resta disponibile al dettaglio');
  assert.equal(c.ownedPage.items.length, 1, 'la lista visibile non cambia'); assert.equal(c.query, '', 'la ricerca della lista non cambia');
  assert.equal(c.history.get('p-far')?.length, 1, 'storico prezzi caricato');
  assert.match(c.detailView(), /Carta p-far/);
  console.log('PASS carta oltre la prima pagina: cercata per codice e aperta'); }
{ const { c, toasts } = make();
  assert.equal(await c.focusPrinting('p-none', { query: 'XXX-000' }), false);
  assert.equal(c.selected, ''); assert.equal(toasts.length, 1);
  console.log('PASS carta assente dal Market Watch: avviso, nessun dettaglio vuoto'); }
console.log('Market Watch focus: 3/3 PASS');
