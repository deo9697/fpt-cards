// Shared Collection — Richieste: state machine reale (pending -> confirmed ->
// completed, con cancelled) + prezzo snapshot
// (supabase/migrations/20260917120000_collection_share_requests_state_machine.sql).
//
// Nessun accesso a un Postgres reale in questa sessione: stesso metodo già
// usato da scripts/collection-share-request-hardening-smoke.mjs — una
// reimplementazione JS pura della logica di confirm/complete/cancel contro
// un "DB" sintetico in memoria, più asserzioni statiche sul testo reale
// della migration/frontend. La reimplementazione qui sotto SEMPLIFICA
// deliberatamente collection_item_loaned/collection_item_reserved (già
// testate altrove, supabase-milestone-2-collection.sql/collection-milestone-
// smoke.mjs) a un singolo numero "committed" per collection_item, dato che
// l'obiettivo qui è provare la logica NUOVA (snapshot prezzo, disponibilità
// netta delle richieste confermate, atomicità di confirm/complete/cancel),
// non ri-verificare il matching prestiti/prenotazioni già coperto altrove.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function makeDb() {
  return {
    collectionItems: [], // {id, ownerSlug, printingId, quantityOwned, committed}
    requests: [], // {id, ownerSlug, status, completedAt}
    requestItems: [], // {requestId, printingId, quantity, unitPriceSnapshot}
    marketPrices: new Map(), // printingId -> normalizedPrice (EUR) o assente
    nextId: 1
  };
}
function newId(db) { return db.nextId++; }

// --- Reimplementazione fedele delle parti nuove --------------------------

// Mirrors submit_collection_share_request's price-capture lookup: una sola
// lettura per printing aggregata, mai bloccante se assente.
function captureSnapshot(db, printingId) {
  const price = db.marketPrices.get(printingId);
  return price == null ? { unitPriceSnapshot: null } : { unitPriceSnapshot: price };
}
function submitRequest(db, { ownerSlug, items }) {
  const requestId = newId(db);
  db.requests.push({ id: requestId, ownerSlug, status: 'pending', completedAt: null });
  for (const item of items) {
    const snap = captureSnapshot(db, item.printingId);
    db.requestItems.push({ requestId, printingId: item.printingId, quantity: item.quantity, ...snap });
  }
  return requestId;
}

function ownerQty(db, ownerSlug, printingId) {
  return db.collectionItems.filter(ci => ci.ownerSlug === ownerSlug && ci.printingId === printingId)
    .reduce((sum, ci) => sum + ci.quantityOwned, 0);
}
function committedQty(db, ownerSlug, printingId) {
  return db.collectionItems.filter(ci => ci.ownerSlug === ownerSlug && ci.printingId === printingId)
    .reduce((sum, ci) => sum + (ci.committed || 0), 0);
}
// Mirrors collection_share_confirmed_quantity: solo richieste GIÀ confirmed.
function confirmedShareQty(db, ownerSlug, printingId) {
  return db.requests.filter(r => r.ownerSlug === ownerSlug && r.status === 'confirmed')
    .flatMap(r => db.requestItems.filter(i => i.requestId === r.id))
    .filter(i => i.printingId === printingId)
    .reduce((sum, i) => sum + i.quantity, 0);
}
// Mirrors get_collection_share's quantityAvailable.
function availableQty(db, ownerSlug, printingId) {
  return Math.max(ownerQty(db, ownerSlug, printingId) - committedQty(db, ownerSlug, printingId) - confirmedShareQty(db, ownerSlug, printingId), 0);
}

function findOwnedRequest(db, ownerSlug, requestId) {
  const req = db.requests.find(r => r.id === requestId);
  // Stessa semantica della RPC reale: il WHERE s.owner_slug = me esclude
  // silenziosamente le richieste di un altro owner — "non trovata", non un
  // errore di permesso distinto (nessuna differenza osservabile dall'esterno
  // tra "non esiste" e "non è tua", per non rivelare l'esistenza dell'id).
  if (!req || req.ownerSlug !== ownerSlug) throw new Error('Richiesta non trovata');
  return req;
}

// Mirrors confirm_collection_share_request.
function confirmRequest(db, ownerSlug, requestId) {
  const req = findOwnedRequest(db, ownerSlug, requestId);
  if (!['pending', 'seen'].includes(req.status)) throw new Error('Solo le richieste in attesa possono essere confermate');
  const items = db.requestItems.filter(i => i.requestId === requestId);
  for (const it of items) {
    if (it.quantity > availableQty(db, req.ownerSlug, it.printingId)) {
      throw new Error('Una delle carte richieste non è più disponibile in quantità sufficiente');
    }
  }
  req.status = 'confirmed';
}

// Mirrors complete_collection_share_request COME CORRETTA da
// 20260917130000_collection_share_requests_state_machine_hardening.sql: per
// ogni riga posseduta, consuma al massimo la sua quota LIBERA (quantityOwned
// - committed, mai oltre), e a livello di printing non può mai eccedere
// (totale libero) - (quota confirmed di ALTRE richieste sulla stessa
// printing) — la propria quota confirmed (già inclusa in confirmedShareQty,
// essendo questa richiesta già 'confirmed' a questo punto) viene esclusa per
// non contarla due volte. ROLLBACK compreso: una singola chiamata RPC = una
// sola transazione implicita Postgres, un'eccezione a qualunque punto del
// loop annulla anche le delete/update degli item PRECEDENTI già eseguite
// nella stessa chiamata.
function completeRequest(db, ownerSlug, requestId) {
  const req = findOwnedRequest(db, ownerSlug, requestId);
  if (req.status !== 'confirmed') throw new Error('Solo le richieste confermate possono essere completate');
  const snapshot = db.collectionItems.map(ci => ({ ...ci }));
  const items = db.requestItems.filter(i => i.requestId === requestId);
  try {
    for (const it of items) {
      const rows = db.collectionItems.filter(ci => ci.ownerSlug === req.ownerSlug && ci.printingId === it.printingId);
      const totalFree = rows.reduce((sum, ci) => sum + Math.max(ci.quantityOwned - (ci.committed || 0), 0), 0);
      const totalConfirmed = confirmedShareQty(db, req.ownerSlug, it.printingId); // include GIÀ la propria reservation
      const otherConfirmed = Math.max(totalConfirmed - it.quantity, 0);
      const availableForThis = Math.max(totalFree - otherConfirmed, 0);
      if (it.quantity > availableForThis) {
        throw new Error('Una delle carte richieste non è più disponibile in quantità sufficiente');
      }
      let remaining = it.quantity;
      const sortedRows = [...rows].sort((a, b) => a.id - b.id);
      for (const row of sortedRows) {
        if (remaining <= 0) break;
        const freeQty = Math.max(row.quantityOwned - (row.committed || 0), 0);
        if (freeQty <= 0) continue;
        const take = Math.min(remaining, freeQty);
        // Una riga viene eliminata SOLO quando la copia consumata coincide
        // con l'INTERO quantity_owned (possibile solo se free_qty era già
        // pari a quantity_owned, cioè la riga non aveva alcun impegno) —
        // mai azzerata se resta un impegno da rappresentare.
        if (take === row.quantityOwned) row._deleted = true;
        else row.quantityOwned -= take;
        remaining -= take;
      }
      if (remaining > 0) throw new Error('Errore interno: rimozione incompleta dalla raccolta');
    }
  } catch (err) {
    db.collectionItems.length = 0;
    db.collectionItems.push(...snapshot);
    throw err;
  }
  db.collectionItems = db.collectionItems.filter(ci => !ci._deleted);
  req.status = 'completed';
  req.completedAt = 'now';
}

// Mirrors cancel_collection_share_request.
function cancelRequest(db, ownerSlug, requestId) {
  const req = findOwnedRequest(db, ownerSlug, requestId);
  if (!['pending', 'seen', 'confirmed'].includes(req.status)) throw new Error('Questa richiesta non può più essere annullata');
  req.status = 'cancelled';
}

function test(name, fn) { try { fn(); console.log(`PASS ${name}`); } catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; } }

function baseDb() {
  const db = makeDb();
  db.collectionItems.push({ id: 1, ownerSlug: 'daniele', printingId: 'p1', quantityOwned: 5, committed: 0 });
  db.collectionItems.push({ id: 2, ownerSlug: 'daniele', printingId: 'p2', quantityOwned: 3, committed: 0 });
  db.marketPrices.set('p1', 12.5);
  // p2: nessun prezzo affidabile in market_latest_prices.
  return db;
}

// 1) submit salva lo snapshot del prezzo per ogni printing.
test('submit salva unitPriceSnapshot per ogni printing con prezzo disponibile', () => {
  const db = baseDb();
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 2 }] });
  const item = db.requestItems.find(i => i.requestId === id);
  assert.equal(item.unitPriceSnapshot, 12.5);
});

// 2) prezzo mancante -> richiesta comunque valida, snapshot null (n/d lato UI).
test('prezzo mancante -> richiesta valida, snapshot null', () => {
  const db = baseDb();
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p2', quantity: 1 }] });
  assert.equal(db.requests.length, 1, 'la richiesta deve esistere comunque');
  const item = db.requestItems.find(i => i.requestId === id);
  assert.equal(item.unitPriceSnapshot, null);
});

// 3) verificato più sotto, staticamente, sul testo reale della migration
// (list_collection_share_requests: unitPrice/lineTotal/totalPrice dallo
// snapshot, MAI più una lookup live).

// 4) pending non riduce availability.
test('pending non modifica quantityAvailable', () => {
  const db = baseDb();
  const before = availableQty(db, 'daniele', 'p1');
  submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 3 }] });
  assert.equal(availableQty(db, 'daniele', 'p1'), before, 'una richiesta pending non deve mai toccare la disponibilità');
});

// 5) confirm riduce availability, MAI quantity_owned.
test('confirm riduce quantityAvailable senza toccare quantity_owned', () => {
  const db = baseDb();
  const ownedBefore = ownerQty(db, 'daniele', 'p1');
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 3 }] });
  confirmRequest(db, 'daniele', id);
  assert.equal(availableQty(db, 'daniele', 'p1'), 2, '5 possedute - 3 confermate = 2 disponibili');
  assert.equal(ownerQty(db, 'daniele', 'p1'), ownedBefore, 'quantity_owned non deve MAI cambiare al confirm');
});

// 6) due richieste in competizione non possono confermare più copie di quelle disponibili.
test('due richieste concorrenti sulla stessa printing: la seconda non può superare la disponibilità residua', () => {
  const db = baseDb(); // p1: 5 possedute
  const first = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 4 }] });
  const second = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 4 }] });
  confirmRequest(db, 'daniele', first);
  assert.throws(() => confirmRequest(db, 'daniele', second), /non è più disponibile/);
  assert.equal(db.requests.find(r => r.id === second).status, 'pending', 'la richiesta rifiutata resta pending, non cambia stato');
  assert.equal(availableQty(db, 'daniele', 'p1'), 1, '5 - 4 (solo la prima confermata) = 1');
});

// 7) cancel di una confirmed libera la disponibilità.
test('cancel di una richiesta confirmed libera immediatamente la disponibilità riservata', () => {
  const db = baseDb();
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 3 }] });
  confirmRequest(db, 'daniele', id);
  assert.equal(availableQty(db, 'daniele', 'p1'), 2);
  cancelRequest(db, 'daniele', id);
  assert.equal(availableQty(db, 'daniele', 'p1'), 5, 'tornata piena disponibilità dopo l\'annullo');
  assert.equal(db.requests.find(r => r.id === id).status, 'cancelled');
});

// 8) complete decrementa davvero l'inventario (quantity_owned).
test('complete decrementa quantity_owned della quantità della richiesta', () => {
  const db = baseDb();
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 2 }] });
  confirmRequest(db, 'daniele', id);
  completeRequest(db, 'daniele', id);
  assert.equal(ownerQty(db, 'daniele', 'p1'), 3, '5 - 2 = 3 dopo il complete');
  assert.equal(db.requests.find(r => r.id === id).status, 'completed');
  assert.notEqual(db.requests.find(r => r.id === id).completedAt, null);
});

// 9) quantità che arriva a zero -> la riga collection_items sparisce (mai un
// UPDATE a 0: il CHECK quantity_owned between 1 and 999 lo vieterebbe).
test('quantità che arriva a zero: la riga collection_items viene eliminata, non azzerata', () => {
  const db = baseDb(); // p1: una sola riga, quantityOwned 5
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 5 }] });
  confirmRequest(db, 'daniele', id);
  completeRequest(db, 'daniele', id);
  assert.equal(db.collectionItems.some(ci => ci.printingId === 'p1'), false, 'la riga esaurita deve essere rimossa, non lasciata a 0');
});

// 10) errore durante complete -> rollback completo, nessuna rimozione parziale.
test('errore su un item durante complete: rollback completo, nessuna rimozione parziale del primo item', () => {
  const db = baseDb();
  // Due item nella stessa richiesta: p1 (ok, 2 possedute) e p2 (chiede 3, ne possiede solo 3 -> ok)
  // poi si fa scendere p2 SOTTO la quantità richiesta DOPO il confirm, prima del complete
  // (es. un altro flusso l'ha nel frattempo ridotta) per forzare il fallimento sul secondo item.
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 2 }, { printingId: 'p2', quantity: 3 }] });
  confirmRequest(db, 'daniele', id);
  db.collectionItems.find(ci => ci.printingId === 'p2').quantityOwned = 1; // ora insufficiente
  const ownedP1Before = ownerQty(db, 'daniele', 'p1');
  assert.throws(() => completeRequest(db, 'daniele', id), /non è più disponibile/);
  assert.equal(ownerQty(db, 'daniele', 'p1'), ownedP1Before, 'p1 (item processato per primo) non deve restare parzialmente rimosso');
  assert.equal(db.requests.find(r => r.id === id).status, 'confirmed', 'la richiesta non deve passare a completed su un fallimento parziale');
});

// 11) completed non può essere completata una seconda volta.
test('completed non ri-completabile', () => {
  const db = baseDb();
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 1 }] });
  confirmRequest(db, 'daniele', id);
  completeRequest(db, 'daniele', id);
  assert.throws(() => completeRequest(db, 'daniele', id), /Solo le richieste confermate possono essere completate/);
});

// 12) un utente diverso dal proprietario non può cambiare stato.
test('owner diverso: confirm/complete/cancel falliscono come "richiesta non trovata"', () => {
  const db = baseDb();
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 1 }] });
  assert.throws(() => confirmRequest(db, 'un-altro', id), /Richiesta non trovata/);
  confirmRequest(db, 'daniele', id);
  assert.throws(() => completeRequest(db, 'un-altro', id), /Richiesta non trovata/);
  assert.throws(() => cancelRequest(db, 'un-altro', id), /Richiesta non trovata/);
  assert.equal(db.requests.find(r => r.id === id).status, 'confirmed', 'nessuna modifica di stato da parte di un non-proprietario');
});

// 13) prestiti/reserved esistenti continuano a essere rispettati (netti dalla disponibilità, confirm fallisce se non basta).
test('quantità impegnata da prestiti/prenotazioni riduce la disponibilità e blocca il confirm se non basta', () => {
  const db = baseDb();
  db.collectionItems.find(ci => ci.printingId === 'p1').committed = 4; // 4 delle 5 già prestate/prenotate
  assert.equal(availableQty(db, 'daniele', 'p1'), 1);
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 2 }] });
  assert.throws(() => confirmRequest(db, 'daniele', id), /non è più disponibile/, 'con solo 1 disponibile, confermare 2 deve fallire');
});

// --- Hardening (20260917130000_collection_share_requests_state_machine_
// hardening.sql): complete_collection_share_request NON deve mai consumare
// copie impegnate (loaned/reserved), deve proteggere le quote di ALTRE
// richieste confirmed sulla stessa printing, ed escludere solo la propria. ---

// H1/H2) complete non consuma quantità loaned né reserved (la reimplementazione
// mirror qui usa un unico campo "committed" per rappresentare entrambe, come
// dichiarato in testa al file — collection_item_loaned e collection_item_
// reserved sono sommati insieme anche nella RPC reale per il calcolo di
// free_qty di una riga).
test('complete non consuma la quota LOANED di una riga (free_qty netta il loan)', () => {
  const db = baseDb(); // p1: 1 riga, quantityOwned 5
  db.collectionItems.find(ci => ci.printingId === 'p1').committed = 2; // 2 in prestito
  // Disponibili per una NUOVA richiesta: 5 - 2 = 3. Ne confermiamo 3 (tutto il libero).
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 3 }] });
  confirmRequest(db, 'daniele', id);
  completeRequest(db, 'daniele', id);
  const row = db.collectionItems.find(ci => ci.printingId === 'p1');
  assert(row, 'la riga non deve sparire: restano 2 copie impegnate da rappresentare');
  assert.equal(row.quantityOwned, 2, '5 possedute - 3 consumate (libere) = 2, MAI intaccando le 2 in prestito');
});
test('complete non consuma la quota RESERVED di una riga (stessa protezione di una prenotazione)', () => {
  const db = baseDb();
  db.collectionItems.find(ci => ci.printingId === 'p1').committed = 1; // 1 prenotata
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 4 }] }); // 5-1=4 libere
  confirmRequest(db, 'daniele', id);
  completeRequest(db, 'daniele', id);
  const row = db.collectionItems.find(ci => ci.printingId === 'p1');
  assert(row, 'la riga con la copia prenotata deve restare rappresentata');
  assert.equal(row.quantityOwned, 1, '5 - 4 = 1, la copia prenotata non deve mai essere consumata');
});

// H6/H7) complete protegge le quote di ALTRE richieste confirmed sulla
// stessa printing, ma consuma correttamente la PROPRIA.
test('complete protegge la quota confirmed di un\'altra richiesta sulla stessa printing (B resta intatta)', () => {
  const db = baseDb(); // p1: 5 possedute, nessun impegno prestiti
  const a = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 3 }] });
  const b = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 2 }] });
  confirmRequest(db, 'daniele', a);
  confirmRequest(db, 'daniele', b); // 3+2=5, esattamente tutto il posseduto: entrambe confermabili
  completeRequest(db, 'daniele', a); // completa SOLO A
  assert.equal(ownerQty(db, 'daniele', 'p1'), 2, 'A ha consumato le sue 3 copie, restano le 2 di B');
  assert.equal(db.requests.find(r => r.id === b).status, 'confirmed', 'B resta confirmed, non toccata');
  // Ora un tentativo di completare B con più di quanto resta libero (0, tutto posseduto è "suo") deve comunque riuscire per la SUA quota.
  completeRequest(db, 'daniele', b);
  assert.equal(ownerQty(db, 'daniele', 'p1'), 0);
});

// H8) row con owned=3, commitment=2, richiesta=1 -> resta quantity_owned=2, mai eliminata.
test('riga con owned=3/commitment=2: completare una richiesta da 1 lascia quantity_owned=2, riga non eliminata', () => {
  const db = makeDb();
  db.collectionItems.push({ id: 1, ownerSlug: 'daniele', printingId: 'p9', quantityOwned: 3, committed: 2 });
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p9', quantity: 1 }] }); // free=1
  confirmRequest(db, 'daniele', id);
  completeRequest(db, 'daniele', id);
  const row = db.collectionItems.find(ci => ci.printingId === 'p9');
  assert(row, 'la riga con un impegno residuo non deve mai essere eliminata');
  assert.equal(row.quantityOwned, 2, 'deve diventare quantity_owned=2 (3 - 1 consumata), le 2 impegnate restano rappresentate');
});

// H9) zero copie libere -> complete fallisce interamente.
test('zero copie libere (tutto in prestito/prenotato) -> complete fallisce', () => {
  const db = makeDb();
  db.collectionItems.push({ id: 1, ownerSlug: 'daniele', printingId: 'p9', quantityOwned: 2, committed: 0 });
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p9', quantity: 2 }] });
  confirmRequest(db, 'daniele', id);
  // Nel frattempo le 2 copie vengono impegnate integralmente da un prestito.
  db.collectionItems.find(ci => ci.printingId === 'p9').committed = 2;
  assert.throws(() => completeRequest(db, 'daniele', id), /non è più disponibile/);
  assert.equal(db.requests.find(r => r.id === id).status, 'confirmed', 'la richiesta resta confirmed, non completed, su fallimento');
  assert.equal(db.collectionItems.find(ci => ci.printingId === 'p9').quantityOwned, 2, 'nessuna rimozione se non c\'è nulla di libero da consumare');
});

// H10) errore su una riga per via di un impegno esterno -> rollback totale (anche di un item precedente già processato con successo nello stesso loop).
test('hardening: errore per impegno esterno su un item -> rollback totale, item precedente non resta parzialmente rimosso', () => {
  const db = baseDb(); // p1 (5 poss.), p2 (3 poss.)
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 2 }, { printingId: 'p2', quantity: 3 }] });
  confirmRequest(db, 'daniele', id);
  db.collectionItems.find(ci => ci.printingId === 'p2').committed = 1; // ora solo 2 libere su p2, ne servono 3
  const ownedP1Before = ownerQty(db, 'daniele', 'p1');
  assert.throws(() => completeRequest(db, 'daniele', id), /non è più disponibile/);
  assert.equal(ownerQty(db, 'daniele', 'p1'), ownedP1Before, 'p1 (processato per primo) non deve restare parzialmente consumato');
  assert.equal(db.requests.find(r => r.id === id).status, 'confirmed');
});

// 15) dati legacy 'seen' non contano come completed: non riducono
// disponibilità né quantity_owned, restano confermabili/rifiutabili come pending.
test('richieste legacy seen: nessun impegno su disponibilità/inventario, restano confermabili come pending', () => {
  const db = baseDb();
  const id = submitRequest(db, { ownerSlug: 'daniele', items: [{ printingId: 'p1', quantity: 2 }] });
  db.requests.find(r => r.id === id).status = 'seen'; // simula un dato legacy
  assert.equal(availableQty(db, 'daniele', 'p1'), 5, 'seen non deve mai comportarsi come confirmed');
  confirmRequest(db, 'daniele', id); // deve funzionare esattamente come da pending
  assert.equal(db.requests.find(r => r.id === id).status, 'confirmed');
  assert.equal(availableQty(db, 'daniele', 'p1'), 3);
});

// --- Verifiche statiche sulla migration reale --------------------------------
{
  const root = path.dirname(fileURLToPath(import.meta.url));
  const migrationPath = path.join(root, '..', 'supabase', 'migrations', '20260917120000_collection_share_requests_state_machine.sql');
  // Normalizzato a LF: git core.autocrlf può restituire CRLF sul checkout
  // Windows di questo repo — le regex qui sotto assumono \n, non \r\n.
  const migration = (await readFile(migrationPath, 'utf8')).replace(/\r\n/g, '\n');
  const sqlNoComments = migration.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');

  test('colonne snapshot prezzo aggiunte a collection_share_request_items (additive, nullable)', () => {
    assert.match(migration, /alter table public\.collection_share_request_items\s*\n\s*add column if not exists unit_price_snapshot numeric;/);
    assert.match(migration, /add column if not exists price_type_snapshot text;/);
    assert.match(migration, /add column if not exists price_captured_at_snapshot timestamptz;/);
  });

  test('status CHECK aggiornato: pending/seen/confirmed/completed/cancelled, seen preservato (mai droppato) per i dati legacy', () => {
    assert.match(sqlNoComments, /check \(status in \('pending','seen','confirmed','completed','cancelled'\)\)/);
  });

  test('nessuna migrazione automatica di seen a confirmed/completed (nessun UPDATE sui dati esistenti)', () => {
    assert.equal(/update\s+public\.collection_share_requests\s+set\s+status\s*=\s*'confirmed'\s+where\s+status\s*=\s*'seen'/i.test(migration), false);
    assert.equal(/update\s+public\.collection_share_requests\s+set\s+status\s*=\s*'completed'\s+where\s+status\s*=\s*'seen'/i.test(migration), false);
  });

  test('completed_at aggiunto a collection_share_requests', () => {
    assert.match(migration, /alter table public\.collection_share_requests add column if not exists completed_at timestamptz;/);
  });

  test('submit_collection_share_request: cattura il prezzo per printing aggregata PRIMA dell\'insert, mai per riga guest grezza (evita N+1)', () => {
    const start = migration.indexOf('create or replace function public.submit_collection_share_request');
    const end = migration.indexOf('grant execute on function public.submit_collection_share_request', start);
    const block = migration.slice(start, end);
    assert.match(block, /select mp\.normalized_price, mp\.price_type, mp\.captured_at\s*\n\s*into price_row/);
    assert.match(block, /insert into public\.collection_share_request_items\(\s*\n\s*request_id, printing_id, quantity, unit_price_snapshot, price_type_snapshot, price_captured_at_snapshot\s*\n\s*\)/);
    // La lookup prezzo deve stare nel loop di AGGREGAZIONE (printing_id, sum(quantity)), non nel loop di validazione riga per riga.
    const priceLookupIdx = block.indexOf('into price_row');
    const aggLoopIdx = block.lastIndexOf('for agg in', priceLookupIdx);
    assert(aggLoopIdx > -1 && aggLoopIdx < priceLookupIdx, 'la lookup prezzo deve avvenire nel loop aggregato per printing_id');
  });

  test('submit_collection_share_request preserva firma/validazione/idempotenza/notifica del hotfix precedente (nessuna regressione)', () => {
    assert.match(sqlNoComments, /p_share_id uuid,\s*\n\s*p_requester_name text,\s*\n\s*p_items jsonb,\s*\n\s*p_message text default null,\s*\n\s*p_client_request_id uuid default null/);
    assert.match(sqlNoComments, /exception when unique_violation then/);
    assert.match(sqlNoComments, /if p_items is null or jsonb_typeof\(p_items\) <> 'array'/);
  });

  test('list_collection_share_requests legge SOLO lo snapshot salvato, mai più una lookup live su market_latest_prices', () => {
    const start = migration.indexOf('create or replace function public.list_collection_share_requests');
    const end = migration.indexOf('revoke all on function public.get_collection_share', 0) < start
      ? migration.indexOf('revoke all on function public.list_collection_share_requests')
      : migration.indexOf('revoke all on function public.list_collection_share_requests');
    const block = migration.slice(start, end);
    assert.match(block, /'unitPrice', i\.unit_price_snapshot/);
    assert.match(block, /'lineTotal', case when i\.unit_price_snapshot is not null then round\(i\.unit_price_snapshot \* i\.quantity, 2\) end/);
    assert.match(block, /round\(sum\(i\.unit_price_snapshot \* i\.quantity\) filter \(where i\.unit_price_snapshot is not null\), 2\) total_price/);
    assert.equal(block.includes('market_latest_prices'), false, 'list_collection_share_requests non deve più contenere una lookup prezzo live');
    assert.match(block, /'completedAt', r\.completed_at/);
  });

  // NOTA (file originale, superseded): questa versione di get_collection_share
  // è quella "semplice" (senza catalogCardId/edition/condition/language/
  // alternateNames/cardCount/printingCount) — 20260917130000_collection_
  // share_requests_state_machine_hardening.sql la ridefinisce ripartendo dal
  // contratto ricco già live, con la STESSA aggiunta di quantityAvailable
  // verificata qui. Vedi la sezione statica dedicata a quella migration.
  test('get_collection_share (file originale, superseded) espone quantityAvailable netto di prestiti/prenotazioni E richieste condivise già confirmed', () => {
    const start = migration.indexOf('create or replace function public.get_collection_share');
    const end = migration.indexOf('create or replace function public.submit_collection_share_request', start);
    const block = migration.slice(start, end);
    assert.match(block, /'quantityAvailable', greatest\(/);
    assert.match(block, /public\.collection_item_loaned\(ci\.id\) \+ public\.collection_item_reserved\(ci\.id\)/);
    assert.match(block, /public\.collection_share_confirmed_quantity\(share\.owner_slug, totals\.printing_id\)/);
  });

  test('collection_share_confirmed_quantity conta solo le richieste status = confirmed', () => {
    const start = migration.indexOf('create or replace function public.collection_share_confirmed_quantity');
    const end = migration.indexOf('revoke all on function public.collection_share_confirmed_quantity', start);
    const block = migration.slice(start, end);
    assert.match(block, /r\.status = 'confirmed'/);
  });

  for (const fn of ['confirm_collection_share_request', 'complete_collection_share_request', 'cancel_collection_share_request']) {
    test(`${fn}: sessione validata, ownership verificata via join collection_shares, security definer`, () => {
      const start = migration.indexOf(`create or replace function public.${fn}`);
      assert(start > -1, `${fn} non trovata nella migration`);
      const end = migration.indexOf('$$;', migration.indexOf('$$', start + 50));
      const block = migration.slice(start, end);
      assert.match(block, /if me is null then raise exception 'Sessione scaduta'; end if;/);
      assert.match(block, /join public\.collection_shares s on s\.id = r\.share_id\s*\n\s*where r\.id = p_request_id and s\.owner_slug = me/);
      assert.match(block, /security definer/);
      assert.match(block, /set search_path = public, extensions/);
    });
  }

  test('confirm_collection_share_request: accetta solo pending/seen, blocca le collection_items coinvolte, ricontrolla ogni riga prima di cambiare stato', () => {
    const start = migration.indexOf('create or replace function public.confirm_collection_share_request');
    const end = migration.indexOf('create or replace function public.complete_collection_share_request', start);
    const block = migration.slice(start, end);
    assert.match(block, /if req\.status not in \('pending', 'seen'\) then/);
    assert.match(block, /for update of ci;/);
    assert.match(block, /pg_advisory_xact_lock\(hashtext\('collection_share_owner_mutation:' \|\| me\)\)/);
    assert.match(block, /update public\.collection_share_requests set status = 'confirmed' where id = p_request_id;/);
    // Nessuna scrittura su collection_items: confirm non deve MAI toccare quantity_owned.
    assert.equal(/update public\.collection_items/.test(block) || /delete from public\.collection_items/.test(block), false, 'confirm non deve mai modificare collection_items');
  });

  // NOTA (file originale, superseded): questa versione di complete_
  // collection_share_request consuma le righe fino a coprire SUM(quantity_
  // owned), senza guardare loaned/reserved né altre richieste confirmed
  // sulla stessa printing — è esattamente il bug corretto da 20260917130000_
  // collection_share_requests_state_machine_hardening.sql. Vedi la sezione
  // statica dedicata a quella migration per il comportamento EFFETTIVAMENTE
  // in vigore.
  test('complete_collection_share_request (file originale, superseded): accetta solo confirmed, decrementa/elimina collection_items, imposta completed_at', () => {
    const start = migration.indexOf('create or replace function public.complete_collection_share_request');
    const end = migration.indexOf('create or replace function public.cancel_collection_share_request', start);
    const block = migration.slice(start, end);
    assert.match(block, /if req\.status <> 'confirmed' then/);
    assert.match(block, /delete from public\.collection_items where id = row_rec\.id;/);
    assert.match(block, /update public\.collection_items set quantity_owned = quantity_owned - remaining, updated_at = now\(\)/);
    assert.match(block, /update public\.collection_share_requests set status = 'completed', completed_at = now\(\) where id = p_request_id;/);
  });

  test('cancel_collection_share_request: pending/seen/confirmed annullabili, completed NO', () => {
    const start = migration.indexOf('create or replace function public.cancel_collection_share_request');
    const end = migration.indexOf('revoke all on function', start);
    const block = migration.slice(start, end);
    assert.match(block, /if req\.status not in \('pending', 'seen', 'confirmed'\) then/);
  });

  // NOTA: questo grant a "solo authenticated" scritto QUI (nel file
  // originale, mai riscritto — vedi la history) si è rivelato un blocker
  // reale: FPT Cards si connette sempre con la chiave `anon` e fa
  // l'autenticazione applicativa via p_token dentro le RPC. La migration
  // 20260917130000_collection_share_requests_state_machine_hardening.sql lo
  // corregge in avanti a "anon, authenticated" — vedi la sezione statica più
  // sotto dedicata a quella migration, che è la fonte di verità sul grant
  // EFFETTIVAMENTE in vigore. Questo test resta com'è solo per documentare
  // fedelmente cosa scrive QUESTO file, non il comportamento finale del DB.
  test('grant (file originale, superseded): confirm/complete/cancel scritte qui come solo authenticated', () => {
    const grantBlock = migration.slice(migration.indexOf('grant execute on function\n  public.confirm_collection_share_request'));
    assert.match(grantBlock, /to authenticated;/);
    assert.equal(grantBlock.slice(0, grantBlock.indexOf('to authenticated;')).includes('anon'), false);
  });

  test('mark_collection_share_request_seen ritirata esplicitamente (revoke poi drop)', () => {
    assert.match(migration, /revoke all on function public\.mark_collection_share_request_seen\(text,uuid\) from public, anon, authenticated;\s*\n\s*drop function if exists public\.mark_collection_share_request_seen\(text, uuid\);/);
  });

  test('notify pgrst reload schema presente', () => {
    assert.match(migration, /notify pgrst, 'reload schema';/);
  });

  console.log('migration (statico): colonne snapshot, status CHECK esteso senza migrazione automatica di seen, completed_at, submit con cattura prezzo N+1-free, list dallo snapshot, get_collection_share con quantityAvailable, confirm/complete/cancel con auth+ownership+lock+transizioni corrette, grants authenticated-only (superseded, vedi hardening), ritiro mark_collection_share_request_seen');
}

// --- Verifiche statiche sulla migration correttiva (repo-sync) --------------
// 20260917130000_collection_share_requests_state_machine_hardening.sql:
// corregge in avanti (senza riscrivere 20260917120000, che resta nella
// history) i tre blocker emersi confrontando il repo con lo stato reale già
// applicato sul DB Supabase (migration live "collection_share_requests_
// state_machine_hardened", DB version 20260916194628) — grant anon mancante,
// contratto ricco di get_collection_share perso, complete che poteva
// consumare copie impegnate.
{
  const root = path.dirname(fileURLToPath(import.meta.url));
  const hardeningPath = path.join(root, '..', 'supabase', 'migrations', '20260917130000_collection_share_requests_state_machine_hardening.sql');
  const hardening = (await readFile(hardeningPath, 'utf8')).replace(/\r\n/g, '\n');
  const hardeningNoComments = hardening.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');

  test('hardening: non riscrive 20260917120000 — nessun DROP/ALTER sulle colonne o sul CHECK status già introdotti da quella migration', () => {
    assert.equal(hardening.includes('drop constraint'), false, 'non deve toccare il CHECK status');
    assert.equal(/add column if not exists (unit_price_snapshot|price_type_snapshot|price_captured_at_snapshot|completed_at)/.test(hardening), false, 'le colonne snapshot/completed_at sono già state introdotte, non vanno ri-aggiunte qui');
  });

  test('hardening: nessuna riga legacy toccata — nessuna conversione bulk di seen, nessun backfill su richieste esistenti', () => {
    // L'unico UPDATE su collection_share_requests atteso in questo file è
    // quello scoped-by-id dentro complete_collection_share_request stessa
    // (set status='completed' where id = p_request_id, l'esito normale di
    // UNA chiamata RPC) — non un backfill di massa sui dati storici.
    assert.equal(/where\s+status\s*=\s*'seen'/i.test(hardeningNoComments), false, 'nessuna conversione bulk di righe seen');
    assert.equal((hardeningNoComments.match(/update\s+public\.collection_share_requests\b/gi) || []).length, 1, 'atteso un solo UPDATE su collection_share_requests: quello scoped-by-id dentro complete_collection_share_request');
    assert.match(hardeningNoComments, /update public\.collection_share_requests set status = 'completed', completed_at = now\(\) where id = p_request_id;/);
  });

  test('hardening BLOCKER 1: list/confirm/complete/cancel concesse a anon E authenticated (mai authenticated da solo)', () => {
    for (const fn of [
      'public.list_collection_share_requests(text)',
      'public.confirm_collection_share_request(text,uuid)',
      'public.complete_collection_share_request(text,uuid)',
      'public.cancel_collection_share_request(text,uuid)'
    ]) {
      assert(hardeningNoComments.includes(fn), `${fn} non compare nel testo della migration`);
    }
    // Ogni blocco grant di queste 4 funzioni deve concedere a "anon, authenticated" insieme.
    const grantMatches = [...hardeningNoComments.matchAll(/grant execute on function\s*\n?\s*((?:public\.[a-z_]+\([^)]*\)[,\s]*)+)\s*to ([a-z, ]+);/g)];
    const relevantFns = ['list_collection_share_requests', 'confirm_collection_share_request', 'complete_collection_share_request', 'cancel_collection_share_request'];
    for (const fnName of relevantFns) {
      const match = grantMatches.find(m => m[1].includes(fnName));
      assert(match, `nessun blocco "grant execute ... to ..." trovato per ${fnName}`);
      assert.match(match[2], /\banon\b/, `${fnName} deve essere concessa anche a anon`);
      assert.match(match[2], /\bauthenticated\b/, `${fnName} deve restare concessa a authenticated`);
    }
  });

  test('hardening: collection_share_confirmed_quantity resta un helper interno (nessun grant execute su di essa in questo file)', () => {
    assert.equal(hardeningNoComments.includes('collection_share_confirmed_quantity(text,uuid) to'), false);
  });

  test('hardening BLOCKER 2: get_collection_share ripristina il contratto ricco (catalogCardId/edition/condition/language/alternateNames/cardCount/printingCount)', () => {
    const start = hardening.indexOf('create or replace function public.get_collection_share');
    const end = hardening.indexOf('revoke all on function public.get_collection_share', start);
    const block = hardening.slice(start, end);
    for (const field of ["'printingId'", "'catalogCardId'", "'cardName'", "'setCode'", "'setName'", "'rarity'", "'imageUrl'", "'quantityOwned'", "'quantityAvailable'", "'edition'", "'condition'", "'language'", "'alternateNames'"]) {
      assert(block.includes(field), `campo per-item mancante nel contratto ricco: ${field}`);
    }
    for (const field of ["'ownerName'", "'game'", "'items'", "'cardCount'", "'printingCount'"]) {
      assert(block.includes(field), `campo root mancante nel contratto ricco: ${field}`);
    }
  });

  test('hardening: quantityAvailable sottrae collection_share_confirmed_quantity UNA volta per gruppo (fuori dal sum() per-riga, mai N+1)', () => {
    const start = hardening.indexOf('create or replace function public.get_collection_share');
    const end = hardening.indexOf('revoke all on function public.get_collection_share', start);
    const block = hardening.slice(start, end);
    // sum(...)::integer deve CHIUDERSI prima della sottrazione di
    // collection_share_confirmed_quantity — cioè la chiamata sta FUORI
    // dall'aggregato per-riga, eseguita una volta per il gruppo (per p.id),
    // non una volta per ogni collection_item sommata dentro il sum().
    assert.match(block, /\)\)::integer\s*\n\s*- public\.collection_share_confirmed_quantity\(share\.owner_slug, p\.id\)/);
  });

  test('hardening BLOCKER 3: complete_collection_share_request calcola free_qty per riga (owned - loaned - reserved), mai oltre', () => {
    const start = hardening.indexOf('create or replace function public.complete_collection_share_request');
    const end = hardening.indexOf('revoke all on function public.complete_collection_share_request', start);
    const block = hardening.slice(start, end);
    assert.match(block, /greatest\(\s*\n?\s*ci\.quantity_owned - public\.collection_item_loaned\(ci\.id\) - public\.collection_item_reserved\(ci\.id\), 0\s*\n?\s*\)/);
    assert.match(block, /free_qty/);
  });

  test('hardening: complete esclude la PROPRIA quota confirmed (già inclusa nel totale) prima di validare le altre', () => {
    const start = hardening.indexOf('create or replace function public.complete_collection_share_request');
    const end = hardening.indexOf('revoke all on function public.complete_collection_share_request', start);
    const block = hardening.slice(start, end);
    assert.match(block, /other_confirmed := greatest\(total_confirmed - it\.quantity, 0\);/);
    assert.match(block, /available_for_this := greatest\(total_free - other_confirmed, 0\);/);
  });

  test('hardening: una riga viene eliminata SOLO quando la quantità consumata coincide con l\'intero quantity_owned (mai quando resta un impegno)', () => {
    const start = hardening.indexOf('create or replace function public.complete_collection_share_request');
    const end = hardening.indexOf('revoke all on function public.complete_collection_share_request', start);
    const block = hardening.slice(start, end);
    assert.match(block, /if take = row_rec\.quantity_owned then\s*\n\s*delete from public\.collection_items where id = row_rec\.id;\s*\n\s*else\s*\n\s*update public\.collection_items set quantity_owned = quantity_owned - take/);
  });

  test('hardening: complete resta atomica (advisory lock per owner + FOR UPDATE sulle collection_items coinvolte, fallimento -> nessun update di stato)', () => {
    const start = hardening.indexOf('create or replace function public.complete_collection_share_request');
    const end = hardening.indexOf('revoke all on function public.complete_collection_share_request', start);
    const block = hardening.slice(start, end);
    assert.match(block, /pg_advisory_xact_lock\(hashtext\('collection_share_owner_mutation:' \|\| me\)\)/);
    assert.match(block, /for update of ci;/);
    assert.match(block, /if req\.status <> 'confirmed' then/);
    assert.match(block, /update public\.collection_share_requests set status = 'completed', completed_at = now\(\) where id = p_request_id;/);
  });

  test('hardening: indice su collection_share_request_items(printing_id) aggiunto in modo idempotente', () => {
    assert.match(hardening, /create index if not exists collection_share_request_items_printing_id_idx\s*\n\s*on public\.collection_share_request_items\(printing_id\);/);
  });

  test('hardening: SECURITY DEFINER e SET search_path preservati sulle funzioni ridefinite', () => {
    for (const fn of ['get_collection_share', 'complete_collection_share_request']) {
      const start = hardening.indexOf(`create or replace function public.${fn}`);
      const dollarStart = hardening.indexOf('$$', start);
      const header = hardening.slice(start, dollarStart);
      assert.match(header, /security definer/, `${fn}: manca security definer`);
      assert.match(header, /set search_path = public, extensions/, `${fn}: manca set search_path`);
    }
  });

  test('hardening: notify pgrst reload schema presente', () => {
    assert.match(hardening, /notify pgrst, 'reload schema';/);
  });

  console.log('hardening (statico): nessuna riscrittura di 20260917120000, nessun dato legacy toccato, grant anon+authenticated su list/confirm/complete/cancel, get_collection_share con contratto ricco + quantityAvailable (confirmed sottratta una volta per gruppo), complete con free_qty per riga + esclusione della propria quota confirmed + eliminazione riga solo se davvero azzerata, atomicità preservata, indice printing_id presente');
}

// --- Verifiche statiche sul frontend -----------------------------------------
{
  const root = path.dirname(fileURLToPath(import.meta.url));
  const apiJs = (await readFile(path.join(root, '..', 'js', 'api.js'), 'utf8')).replace(/\r\n/g, '\n');
  const appJs = (await readFile(path.join(root, '..', 'app.js'), 'utf8')).replace(/\r\n/g, '\n');

  test('js/api.js: nuovi metodi RPC presenti, markCollectionShareRequestSeen rimosso', () => {
    assert.match(apiJs, /confirmCollectionShareRequest\(requestId\)[\s\S]{0,200}confirm_collection_share_request/);
    assert.match(apiJs, /completeCollectionShareRequest\(requestId\)[\s\S]{0,200}complete_collection_share_request/);
    assert.match(apiJs, /cancelCollectionShareRequest\(requestId\)[\s\S]{0,200}cancel_collection_share_request/);
    assert.equal(apiJs.includes('markCollectionShareRequestSeen'), false, 'metodo ritirato: nessun riferimento residuo');
    assert.equal(apiJs.includes('mark_collection_share_request_seen'), false);
  });

  test('app.js: nessun riferimento residuo a data-mark-request-seen', () => {
    assert.equal(appJs.includes('data-mark-request-seen'), false);
    assert.equal(appJs.includes('markRequestSeen'), false);
  });

  test('app.js: tre tab Richieste (pending/confirmed/completed), \'seen\' legacy raggruppata con pending', () => {
    assert.match(appJs, /data-requests-tab="pending"/);
    assert.match(appJs, /data-requests-tab="confirmed"/);
    assert.match(appJs, /data-requests-tab="completed"/);
    assert.match(appJs, /request\.status === 'pending' \|\| request\.status === 'seen'/);
  });

  test('app.js: azioni per stato corrette (Rifiuta/Conferma su pending, Annulla/Segna come effettuata su confirmed)', () => {
    assert.match(appJs, /data-reject-request="\$\{esc\(request\.id\)\}"/);
    assert.match(appJs, /data-confirm-request="\$\{esc\(request\.id\)\}"/);
    assert.match(appJs, /data-cancel-confirmed-request="\$\{esc\(request\.id\)\}"/);
    assert.match(appJs, /data-complete-request="\$\{esc\(request\.id\)\}"/);
  });

  // 14) prezzi/totale mostrati devono venire dal server (snapshot), non
  // ricalcolati lato client — coerenza garantita dalla RPC, non dalla UI.
  test('app.js: il totale di riga (lineTotal) e il totale richiesta vengono dal server, non ricalcolati client-side', () => {
    assert.match(appJs, /const lineTotal = formatEuro\(item\.lineTotal\);/);
    assert.equal(/item\.unitPrice \* item\.quantity/.test(appJs), false, 'nessun ricalcolo lato client del totale riga');
    assert.match(appJs, /formatEuro\(request\.totalPrice\)/);
  });

  console.log('frontend (statico): api.js allineato alle nuove RPC (vecchia rimossa), app.js con 3 tab / azioni per stato / prezzi dal server');
}

console.log('PASS Shared Collection Richieste — state machine: pending/confirmed/completed(+cancelled), prezzo snapshot, disponibilità netta, atomicità confirm/complete/cancel, dati legacy seen mai trattati come completed');
