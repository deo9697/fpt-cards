// Dashboard Market Watch "Vetrina" (2026-10-25): pannello costruito da
// get_market_dashboard_overview (precalcolato ogni notte). Verifica il
// mapper (numeric → numeri), il markup (carta più preziosa, scaffale, valore
// a parità di carte, movers in euro, segnali), il ripiego sul vecchio
// carosello senza overview e il cablaggio statico di controller/migration.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window ??= { addEventListener: () => {}, FPT_CONFIG: undefined };
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { mapDashboardOverview } = await import('../js/market-watch.js');
const { dashboardView } = await import('../js/dashboard.js');
const test = (name, fn) => { fn(); console.log(`PASS ${name}`); };
const state = { currentUser: 'daniele', loans: [] };

// Forma reale della RPC: i numeric di Postgres arrivano come stringhe.
const payload = {
  value: '2186.25', pricedCards: 3008,
  change7: { eur: '9.34', base: '2048.22', cards: 2855 }, change30: { eur: '65.09', base: '1992.47', cards: 2855 },
  top: [
    { printingId: 'p1', catalogCardId: '28521039', cardName: 'Pot of Sloth', setCode: 'CORI-IT061', rarity: 'Secret Rare', imageUrl: 'https://artworks-en-n.ygoresources.com/2/30/10_1.png', quantity: 1, price: '55.15', price7: '54.39', price30: '58.24', estimated: false },
    { printingId: 'p2', catalogCardId: '55273560', cardName: 'Brave-Eyes Pendulum Dragon', setCode: 'RATE-IT039', rarity: 'Secret Rare', imageUrl: '', quantity: 1, price: '17.62', price7: '20.73', price30: null, estimated: false },
    { printingId: 'p3', catalogCardId: '38033121', cardName: 'Dark Magician Girl', setCode: 'PGLD-EN033', rarity: 'Gold Rare', imageUrl: '', quantity: 1, price: '15.36', price7: null, price30: null, estimated: true },
  ],
  movers: [
    { printingId: 'm1', catalogCardId: '1784686', cardName: 'The Eye of Timaeus', setCode: 'DRLG-IT005', rarity: 'Secret Rare', imageUrl: '', quantity: 2, price: '9.22', price7: '7.34', deltaEur: '3.76', deltaPct: '25.6' },
    { printingId: 'm2', catalogCardId: '55273560', cardName: 'Brave-Eyes Pendulum Dragon', setCode: 'RATE-IT039', rarity: 'Secret Rare', imageUrl: '', quantity: 1, price: '17.62', price7: '20.73', deltaEur: '-3.11', deltaPct: '-15.0' },
  ],
  signals: { aboveMonthAverage: 8, duplicatesValue: '63.88', duplicates: [{ cardName: 'Super Polymerization', quantity: 6, spare: '26.55' }], estimated: 472 },
  lastSync: '2026-10-25T02:01:01Z', computedAt: '2026-10-25T02:30:00Z',
};

test('mapDashboardOverview: numeri veri, null preservati, payload incompleto → null', () => {
  const o = mapDashboardOverview(payload);
  assert.equal(o.value, 2186.25);
  assert.deepEqual(o.change7, { eur: 9.34, base: 2048.22, cards: 2855 });
  assert.equal(o.top[0].price30, 58.24);
  assert.equal(o.top[1].price30, null);
  assert.equal(o.top[2].estimated, true);
  assert.equal(o.movers[1].deltaEur, -3.11);
  assert.equal(o.signals.duplicates[0].spare, 26.55);
  assert.equal(mapDashboardOverview(null), null);
  assert.equal(mapDashboardOverview({ value: 1 }), null);
});

test('Vetrina: carta più preziosa, scaffale, valore a parità di carte, movers in euro, segnali', () => {
  const html = dashboardView(state, 'yugioh', { overview: mapDashboardOverview(payload), portfolioValue: 2190.5, featuredHistory: new Map() });
  assert.match(html, /market-millennium market-vetrina/);
  assert.match(html, /La tua carta più preziosa/);
  assert.match(html, /mv-hero-name">Pot of Sloth</);
  assert.match(html, /cards_cropped\/28521039\.jpg/, 'artwork ritagliato da YGOPRODeck prima della carta intera YGOResources');
  assert.match(html, /58,24\s€ 30 giorni fa/);
  assert.match(html, /mv-shelf-card[\s\S]*Brave-Eyes Pendulum Dragon/);
  assert.match(html, /2\.190,50\s€/, 'valore live del Market Watch quando disponibile');
  assert.match(html, /mv-up">\+9,34\s€ in 7 gg/);
  assert.match(html, /\+65,09\s€ in 30 gg \(\+3,3%\)/);
  assert.match(html, /mv-up">\+3,76\s€</);
  assert.match(html, /mv-down">−3,11\s€</);
  assert.match(html, /2 copie &#183; 9,22\s€ a copia/);
  assert.match(html, /class="mv-signals"/);
  assert.equal((html.match(/class="mv-signal mv-signal-/g) || []).length, 2, 'Da sapere a lista: STONKS + doppioni');
  assert.match(html, /Carte STONKS<\/strong>[\s\S]*?mv-signal-value">8 carte</);
  assert.match(html, /Doppioni di valore<\/strong><small>Super Polymerization ×6<\/small>[\s\S]*?mv-signal-value">63,88\s€</);
  assert.doesNotMatch(html, /Prezzi stimati/, 'riga "prezzi stimati" rimossa: sembrava uno strumento di debug');
  assert.doesNotMatch(readFileSync(new URL('../js/dashboard.js', import.meta.url), 'utf8'), /Raccolta<\/small>/, 'valore della raccolta solo nella Vetrina, non nel pannello duellante');
  assert.doesNotMatch(html, /mv-chip/, 'niente più pulsanti a pillola');
  assert.doesNotMatch(html, /market-featured-slide/, 'niente carosello % quando c\'è la Vetrina');
});

test('Vetrina: carta stimata segnalata, settimana senza movimenti, primo giorno senza confronto', () => {
  const quiet = mapDashboardOverview({ ...payload, top: [payload.top[2]], movers: [], change7: null, change30: null, signals: {} });
  const html = dashboardView(state, 'yugioh', { overview: quiet });
  assert.match(html, /Prezzo stimato/);
  assert.match(html, /Settimana tranquilla/);
  assert.match(html, /Variazione dalla prossima settimana/);
  assert.match(html, /2\.186,25\s€/, 'senza valore live usa quello del riepilogo');
  assert.doesNotMatch(html, /Da sapere/, 'nessun segnale → nessuna sezione vuota');
});

test('senza overview resta il carosello Millennium di prima', () => {
  const html = dashboardView(state, 'yugioh', { overview: null, featuredMovers: [], trendsLoading: false });
  assert.doesNotMatch(html, /market-vetrina/);
  assert.match(html, /market-millennium/);
});

test('cablaggio: overview prima, vecchi movers solo come ripiego; migration precalcolata', () => {
  const controller = readFileSync(new URL('../js/market-watch.js', import.meta.url), 'utf8');
  assert.match(controller, /marketDashboardOverview\?\.\(game\)\?\?null\)\.catch\(\(\)=>null\)\s*\.then\(overview=>overview\?\.top\?\{overview\}:/);
  assert.match(controller, /overview:this\.overview,portfolioValue:this\.summary\.portfolioValue\?\.current/);
  assert.match(controller, /this\.overview\?\.top\?\.length\?this\.overview\.top\.slice\(0,1\)/, 'storico solo per la carta in evidenza');
  const api = readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');
  assert.match(api, /rpc\('get_market_dashboard_overview'/);
  const sql = readFileSync(new URL('../supabase/migrations/20261025100000_market_dashboard_overview.sql', import.meta.url), 'utf8');
  assert.match(sql, /cron\.schedule\('fpt-market-dashboard-overview-daily', '30 2 \* \* \*'/);
  assert.match(sql, /revoke all on function public\.compute_market_dashboard_overview\(text, text\) from public, anon, authenticated/);
  assert.match(sql, /revoke all on table public\.market_dashboard_overviews from anon, authenticated/);
  assert.match(sql, /where not estimated and price7 > 0 and price >= 1 and abs\(price - price7\) >= 0\.5/);
});
