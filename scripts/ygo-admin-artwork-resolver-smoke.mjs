// Copre il rendering dell'Artwork Resolver (js/admin.js): candidati grandi
// mostrati senza selezione automatica, [Conferma]/[Conferma e prossima]
// entrambi disabilitati finché non si sceglie un candidato, filtri/chip di
// set renderizzati, vista storico. Le RPC (confirm_ygo_printing_artwork,
// list_ygo_artwork_review_queue — admin/curator/member/sessione invalida/
// cross-card injection) sono state verificate dal vivo contro produzione con
// una printing sintetica (nessun caso reale toccato); qui si copre solo il
// livello UI aggiunto in questo task.
import assert from 'node:assert/strict';

globalThis.window = { addEventListener: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { renderAdminPage } = await import('../js/admin.js');

const queueItem = {
  setCode: 'L26D-ENM32', cardName: 'S:P Little Knight', setNames: ['Legendary Duelists 2026'], rarities: ['Ultra Rare'],
  konamiCardId: '19188', artworkCount: 2, currentArtworkUrl: null,
  collectionUsage: 4, deckUsage: 1, loanUsage: 2, usageCount: 7,
  candidates: [
    { index: '1', url: 'https://artworks-en-n.ygoresources.com/1/91/88_1.png' },
    { index: '2', url: 'https://artworks-en-n.ygoresources.com/1/91/88_2.png' }
  ]
};
const baseModel = {
  loading: false, error: '', queue: [queueItem], hasMore: false, selections: new Map(),
  filters: { query: '', setPrefix: '', usedOnly: true, orderBy: 'usage_count' },
  setPrefixes: [{ set_prefix: 'L26D', unresolved_count: 23 }, { set_prefix: 'L5DD', unresolved_count: 9 }],
  view: 'queue', history: [], historyLoading: false, isAdmin: false, currentUserName: 'Cristofer Marincolo'
};

// --- 1) Nessuna selezione: entrambi i candidati mostrati, metadata completi, entrambi i pulsanti disabilitati ---
{
  const html = renderAdminPage(baseModel);
  assert.ok(html.includes('data-artwork-index="1"') && html.includes('data-artwork-index="2"'), 'candidati non mostrati');
  assert.ok(html.includes('Legendary Duelists 2026'), 'set name non mostrato');
  assert.ok(html.includes('Ultra Rare'), 'rarity non mostrata');
  assert.ok(html.includes('4 in raccolta') && html.includes('1 in mazzi') && html.includes('2 in prestiti'), 'utilizzo non mostrato per esteso');
  const confirmMatch = html.match(/<button type="button" class="btn secondary" data-artwork-confirm[^>]*>/);
  const confirmNextMatch = html.match(/<button type="button" class="btn" data-artwork-confirm-next[^>]*>/);
  assert.ok(confirmMatch?.[0].includes('disabled'), '[Conferma] deve essere disabilitato senza selezione');
  assert.ok(confirmNextMatch?.[0].includes('disabled'), '[Conferma e prossima] deve essere disabilitato senza selezione');
  assert.ok(!html.includes('is-selected'), 'nessun candidato selezionato di default');
}

// --- 2) Con una selezione: entrambi i pulsanti si abilitano, un solo candidato marcato ---
{
  const selections = new Map([['L26D-ENM32', { index: '2', url: 'https://artworks-en-n.ygoresources.com/1/91/88_2.png' }]]);
  const html = renderAdminPage({ ...baseModel, selections });
  const confirmMatch = html.match(/<button type="button" class="btn secondary" data-artwork-confirm[^>]*>/);
  const confirmNextMatch = html.match(/<button type="button" class="btn" data-artwork-confirm-next[^>]*>/);
  assert.ok(!confirmMatch?.[0].includes('disabled'), '[Conferma] deve abilitarsi dopo una selezione');
  assert.ok(!confirmNextMatch?.[0].includes('disabled'), '[Conferma e prossima] deve abilitarsi dopo una selezione');
  assert.equal((html.match(/is-selected/g) || []).length, 1, 'un solo candidato alla volta selezionato');
}

// --- 3) Filtri e chip di prefisso set (batch navigation per set) ---
{
  const html = renderAdminPage(baseModel);
  assert.ok(html.includes('data-admin-filter-query'), 'filtro ricerca mancante');
  assert.ok(html.includes('data-admin-filter-prefix'), 'filtro prefisso mancante');
  assert.ok(html.includes('data-admin-filter-order'), 'ordinamento mancante');
  assert.ok(html.includes('data-admin-filter-used-only'), 'filtro "solo usate" mancante');
  assert.ok(html.includes('data-admin-prefix-chip="L26D"') && html.includes('data-admin-prefix-chip="L5DD"'), 'chip di prefisso set mancanti');
  const usedOnlyChecked = html.match(/data-admin-filter-used-only ([^>]*)>/)[1];
  assert.ok(usedOnlyChecked.includes('checked'), 'default "solo usate" deve essere attivo');
  const orderSelected = html.match(/<option value="usage_count"[^>]*>/)[0];
  assert.ok(orderSelected.includes('selected'), 'default ordinamento deve essere usage_count desc');
}

// --- 4) Stato vuoto/errore non deve mai mostrare candidati inventati ---
{
  const empty = renderAdminPage({ ...baseModel, queue: [] });
  assert.ok(empty.includes('Nessuna printing'), 'stato vuoto non gestito');
  const errored = renderAdminPage({ ...baseModel, queue: [], error: 'Coda non disponibile' });
  assert.ok(errored.includes('Coda non disponibile'), 'errore non mostrato');
}

// --- 5) Vista storico: attribuzione admin/curator e nome utente corrente ---
{
  const history = [
    { setCode: 'L26D-ENM32', konamiCardId: '19188', previousArtworkIndex: null, newArtworkIndex: '2', verificationSource: 'curator_manual', verifiedAt: '2026-09-12T10:00:00Z' }
  ];
  const html = renderAdminPage({ ...baseModel, view: 'history', history, currentUserName: 'Cristofer Marincolo' });
  assert.ok(html.includes('Cristofer Marincolo'), 'nome utente non mostrato nello storico');
  assert.ok(html.includes('Curator'), 'attribuzione curator mancante');
  assert.ok(html.includes('L26D-ENM32'), 'set_code mancante nella riga storico');
}

console.log('PASS ygo-admin-artwork-resolver: candidati grandi senza selezione automatica · Conferma/Conferma-e-prossima disabilitati finché non si sceglie · filtri e chip di set renderizzati · default usage_count desc + solo usate · storico con attribuzione curator/admin');
