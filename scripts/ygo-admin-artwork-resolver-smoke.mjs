// Copre il rendering/selezione dell'Admin Artwork Resolver (js/admin.js):
// candidati mostrati, nessuna selezione di default, pulsante conferma
// disabilitato finché l'admin non sceglie un candidato, selezione riflessa
// nel markup. La priorità override/idempotenza/non-admin-bloccato sul lato
// RPC sono già coperte da scripts/ygo-printing-registry-smoke.mjs (stessa
// upsert_ygo_printing_override usata qui) — qui si verifica solo il livello
// UI aggiunto in questo task.
import assert from 'node:assert/strict';

globalThis.window = { addEventListener: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { renderAdminPage } = await import('../js/admin.js');

const queueItem = {
  setCode: 'L26D-ENM32', cardName: 'S:P Little Knight', konamiCardId: '19188', artworkCount: 2,
  currentArtworkUrl: null, collectionUsage: 4, deckUsage: 1, loanUsage: 2, usageCount: 7,
  candidates: [
    { index: '1', url: 'https://artworks-en-n.ygoresources.com/1/91/88_1.png' },
    { index: '2', url: 'https://artworks-en-n.ygoresources.com/1/91/88_2.png' }
  ]
};

// --- 1) Nessuna selezione: entrambi i candidati mostrati, conferma disabilitata ---
{
  const html = renderAdminPage({ loading: false, error: '', queue: [queueItem], hasMore: false, selections: new Map() });
  assert.ok(html.includes('data-artwork-index="1"'), 'candidato 1 non mostrato');
  assert.ok(html.includes('data-artwork-index="2"'), 'candidato 2 non mostrato');
  assert.ok(html.includes('4 in raccolta'), 'utilizzo raccolta non mostrato');
  assert.ok(html.includes('1 in mazzi'), 'utilizzo mazzi non mostrato');
  assert.ok(html.includes('2 in prestiti'), 'utilizzo prestiti non mostrato');
  const confirmButtonMatch = html.match(/<button type="button" class="btn" data-artwork-confirm[^>]*>/);
  assert.ok(confirmButtonMatch && confirmButtonMatch[0].includes('disabled'), 'il pulsante conferma deve essere disabilitato senza una selezione');
  assert.ok(!html.includes('is-selected'), 'nessun candidato deve risultare selezionato di default');
}

// --- 2) Con una selezione: il candidato scelto è marcato, conferma abilitata ---
{
  const selections = new Map([['L26D-ENM32', { index: '2', url: 'https://artworks-en-n.ygoresources.com/1/91/88_2.png' }]]);
  const html = renderAdminPage({ loading: false, error: '', queue: [queueItem], hasMore: false, selections });
  const confirmButtonMatch = html.match(/<button type="button" class="btn" data-artwork-confirm[^>]*>/);
  assert.ok(confirmButtonMatch && !confirmButtonMatch[0].includes('disabled'), 'il pulsante conferma deve abilitarsi dopo una selezione');
  assert.ok(html.includes('is-selected'), 'il candidato selezionato deve essere marcato visivamente');
  // Solo IL candidato scelto (indice 2), non entrambi.
  const selectedCount = (html.match(/is-selected/g) || []).length;
  assert.equal(selectedCount, 1, 'un solo candidato alla volta deve risultare selezionato');
}

// --- 3) Stato vuoto/errore non deve mai mostrare candidati inventati ---
{
  const empty = renderAdminPage({ loading: false, error: '', queue: [], hasMore: false, selections: new Map() });
  assert.ok(empty.includes('Nessuna printing multi-artwork'), 'stato vuoto non gestito');
  const errored = renderAdminPage({ loading: false, error: 'Coda non disponibile', queue: [], hasMore: false, selections: new Map() });
  assert.ok(errored.includes('Coda non disponibile'), 'errore non mostrato');
}

console.log('PASS ygo-admin-artwork-resolver: candidati mostrati senza selezione automatica · conferma abilitata solo dopo scelta esplicita · un solo candidato selezionabile alla volta · stati vuoto/errore gestiti');
