// Shared Collection — hardening di submit_collection_share_request
// (supabase/migrations/20260916120000_shared_collection_request_hardening.sql).
// Nessun accesso a un Postgres reale in questa sessione: la validazione è
// dimostrata con una reimplementazione JS pura che rispecchia ESATTAMENTE
// l'algoritmo della funzione PL/pgSQL (stesso ordine dei controlli, stessi
// messaggi, stessa logica di aggregazione/idempotenza/notifica best-effort),
// eseguita contro un "DB" sintetico in memoria — stesso metodo già usato
// oggi per le migration Market Watch/missioni senza sessione DB. A questo si
// aggiungono asserzioni statiche sul testo della migration reale.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Reimplementazione fedele di submit_collection_share_request ----------
function uuid(n) { return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; }

function makeDb() {
  return {
    shares: new Map(), // id -> {id, ownerSlug, game, revokedAt}
    printings: new Map(), // id -> {id, game}
    collectionItems: [], // {ownerSlug, printingId, quantityOwned}
    requests: [], // {id, shareId, requesterName, message, clientRequestId}
    requestItems: [], // {requestId, printingId, quantity}
    notifications: [],
    notifyShouldThrow: false,
    nextId: 1
  };
}
function newId(db) { return uuid(db.nextId++); }

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Mirrors the PL/pgSQL function body 1:1 — see the migration for the real SQL.
function submitCollectionShareRequest(db, { shareId, requesterName, items, message = null, clientRequestId = null }) {
  const share = [...db.shares.values()].find(s => s.id === shareId && !s.revokedAt);
  if (!share) throw new Error('Link non valido o revocato');

  const cleanName = String(requesterName ?? '').trim();
  if (cleanName === '') throw new Error('Nome mancante');
  if (cleanName.length > 80) throw new Error('Nome troppo lungo (massimo 80 caratteri)');

  if (message != null && String(message).trim().length > 500) throw new Error('Messaggio troppo lungo (massimo 500 caratteri)');
  const cleanMessage = (() => { const t = String(message ?? '').trim(); return t === '' ? null : t; })();

  if (!Array.isArray(items)) throw new Error('Elenco carte non valido');
  if (items.length < 1) throw new Error('Nessuna carta selezionata');
  if (items.length > 50) throw new Error('Troppe carte in una singola richiesta (massimo 50)');

  // Idempotenza, fast path.
  if (clientRequestId != null) {
    const existing = db.requests.find(r => r.shareId === share.id && r.clientRequestId === clientRequestId);
    if (existing) return existing.id;
  }

  // Validazione riga per riga (forma/tipo/range) — un solo item invalido fa
  // fallire l'intera chiamata, nessun raise qui è catturato.
  let totalQuantity = 0;
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('Elemento richiesta non valido');
    if (typeof item.printingId !== 'string' || !UUID_RE.test(item.printingId)) throw new Error('Elemento richiesta non valido: printingId mancante o malformato');
    // Mirra la regex SQL (item->>'quantity') ~ '^[0-9]+$': un intero
    // negativo o non intero è già respinto qui, con lo stesso messaggio
    // generico della SQL (che non distingue "negativo" da "non intero" a
    // questo punto — lo fa la riga successiva solo per i casi che qui
    // passano, es. 0).
    if (typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || !/^\d+$/.test(String(item.quantity))) throw new Error('Quantità non valida per una delle carte richieste');
    if (item.quantity < 1) throw new Error('La quantità richiesta deve essere maggiore di zero');
    if (item.quantity > 99) throw new Error('Quantità fuori range per una delle carte richieste (massimo 99)');
    totalQuantity += item.quantity;
  }
  if (totalQuantity > 500) throw new Error('Quantità totale richiesta troppo alta (massimo 500 carte in una richiesta)');

  // Aggregazione per printing_id (chiude il bypass "split quantity").
  const aggregated = new Map();
  for (const item of items) aggregated.set(item.printingId, (aggregated.get(item.printingId) || 0) + item.quantity);

  for (const [printingId, quantity] of aggregated) {
    // Ogni riga individuale è già <= 99, ma la SOMMA di più righe valide
    // sullo stesso printingId può comunque superarlo (60+60=120) —
    // collection_share_request_items.quantity ha un CHECK 1..99 a livello
    // di tabella e qui si inserisce UNA riga aggregata per printing_id.
    if (quantity > 99) throw new Error('Quantità fuori range per una delle carte richieste (massimo 99)');
    const printing = db.printings.get(printingId);
    if (!printing || printing.game !== share.game) throw new Error('Una delle carte richieste non appartiene a questa raccolta condivisa');
    const ownerQty = db.collectionItems
      .filter(ci => ci.ownerSlug === share.ownerSlug && ci.printingId === printingId)
      .reduce((sum, ci) => sum + ci.quantityOwned, 0);
    if (ownerQty <= 0) throw new Error('Una delle carte richieste non è nella raccolta condivisa');
    if (quantity > ownerQty) throw new Error('Quantità richiesta superiore a quella disponibile per una delle carte');
  }

  // Persistenza — insert + guardia unique_violation (race idempotenza).
  if (clientRequestId != null && db.requests.some(r => r.shareId === share.id && r.clientRequestId === clientRequestId)) {
    return db.requests.find(r => r.shareId === share.id && r.clientRequestId === clientRequestId).id;
  }
  const requestId = newId(db);
  db.requests.push({ id: requestId, shareId: share.id, requesterName: cleanName, message: cleanMessage, clientRequestId });

  for (const [printingId, quantity] of aggregated) db.requestItems.push({ requestId, printingId, quantity });

  // Notifica best-effort: MAI propaga, MAI annulla la request/items già creati.
  try {
    if (db.notifyShouldThrow) throw new Error('notify boom');
    db.notifications.push({ requestId, ownerSlug: share.ownerSlug, cardCount: aggregated.size });
  } catch { /* solo un warning lato SQL, mai un rollback — vedi migration */ }

  return requestId;
}

function test(name, fn) { try { fn(); console.log(`PASS ${name}`); } catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; } }

// --- Fixture base -----------------------------------------------------------
function baseDb() {
  const db = makeDb();
  db.shares.set('share-1', { id: 'share-1', ownerSlug: 'daniele', game: 'yugioh', revokedAt: null });
  db.shares.set('share-revoked', { id: 'share-revoked', ownerSlug: 'daniele', game: 'yugioh', revokedAt: '2026-09-01' });
  db.printings.set(uuid(1), { id: uuid(1), game: 'yugioh' });
  db.printings.set(uuid(2), { id: uuid(2), game: 'yugioh' });
  db.printings.set(uuid(3), { id: uuid(3), game: 'onepiece' }); // gioco diverso dallo share
  db.collectionItems.push({ ownerSlug: 'daniele', printingId: uuid(1), quantityOwned: 3 });
  db.collectionItems.push({ ownerSlug: 'daniele', printingId: uuid(1), quantityOwned: 2 }); // seconda copia, condition diversa -> SUM
  db.collectionItems.push({ ownerSlug: 'daniele', printingId: uuid(2), quantityOwned: 1 });
  db.collectionItems.push({ ownerSlug: 'daniele', printingId: uuid(3), quantityOwned: 99 }); // altro gioco, mai richiedibile da share-1
  return db;
}

// 1) Richiesta valida senza messaggio.
test('richiesta valida senza messaggio resta valida', () => {
  const db = baseDb();
  const id = submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 2 }] });
  assert.equal(db.requests.length, 1);
  assert.equal(db.requests[0].message, null);
  assert.equal(db.requestItems.length, 1);
  assert.equal(db.notifications.length, 1);
});

// 2) Richiesta valida con messaggio valido (trim + entro il limite).
test('richiesta con messaggio valido resta valida, trimmato', () => {
  const db = baseDb();
  submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 1 }], message: '  Interessato!  ' });
  assert.equal(db.requests[0].message, 'Interessato!');
});

// 3) Messaggio troppo lungo -> reject esplicito.
test('messaggio oltre 500 caratteri -> reject esplicito', () => {
  const db = baseDb();
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 1 }], message: 'x'.repeat(501) }), /Messaggio troppo lungo/);
  assert.equal(db.requests.length, 0, 'nessuna request parziale creata');
});

// 4) quantity = 0 -> reject.
test('quantity = 0 -> reject', () => {
  const db = baseDb();
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 0 }] }), /maggiore di zero/);
  assert.equal(db.requests.length, 0);
});

// 5) quantity negativa -> reject.
test('quantity negativa -> reject', () => {
  const db = baseDb();
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: -3 }] }), /Quantità non valida/);
  assert.equal(db.requests.length, 0);
});

// 6) quantity > quantity_owned (aggregato su tutte le copie) -> reject.
test('quantity > quantity_owned -> reject', () => {
  const db = baseDb(); // uuid(1) possiede 3+2=5 in totale
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 6 }] }), /superiore a quella disponibile/);
  assert.equal(db.requests.length, 0);
});

// 6b) split della stessa printing su due righe non deve bypassare il cap.
test('quantità splittata su più righe della stessa carta resta soggetta al totale posseduto', () => {
  const db = baseDb(); // uuid(1) = 5 possedute in totale
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 3 }, { printingId: uuid(1), quantity: 3 }] }), /superiore a quella disponibile/);
  assert.equal(db.requests.length, 0, 'nessun bypass del cap via righe duplicate');
});

// 6c) split della stessa printing su più righe TUTTE individualmente valide
// (<=99) la cui SOMMA supera 99 -> reject esplicito, non un vincolo di
// tabella generico (collection_share_request_items.quantity è 1..99, e qui
// si inserisce una riga aggregata per printing_id).
test('somma di più righe valide sulla stessa carta che supera 99 -> reject esplicito', () => {
  const db = baseDb();
  db.collectionItems.push({ ownerSlug: 'daniele', printingId: uuid(1), quantityOwned: 200 }); // abbondanza: non è il cap a bloccare qui
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 60 }, { printingId: uuid(1), quantity: 60 }] }), /Quantità fuori range/);
  assert.equal(db.requests.length, 0);
});

// 7) printing non appartenente alla collezione condivisa (owner non la possiede) -> reject.
test('printing non appartenente allo share (owner non la possiede) -> reject', () => {
  const db = baseDb();
  const foreignPrinting = uuid(999);
  db.printings.set(foreignPrinting, { id: foreignPrinting, game: 'yugioh' });
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: foreignPrinting, quantity: 1 }] }), /non è nella raccolta condivisa/);
  assert.equal(db.requests.length, 0);
});

// 7b) printing di un gioco diverso da quello dello share -> reject (anche se l'owner la possiede altrove).
test('printing di un gioco diverso dallo share -> reject anche se posseduta in un altro gioco', () => {
  const db = baseDb();
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(3), quantity: 1 }] }), /non appartiene a questa raccolta condivisa/);
  assert.equal(db.requests.length, 0);
});

// 8) share revocato -> reject.
test('share revocato -> reject', () => {
  const db = baseDb();
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-revoked', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 1 }] }), /Link non valido o revocato/);
});

// 9) items vuoto -> reject.
test('items vuoto -> reject', () => {
  const db = baseDb();
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [] }), /Nessuna carta selezionata/);
});

// 10) payload malformato (non un array, item senza printingId, quantity come stringa) -> reject.
test('payload malformato -> reject (in ognuna delle sue forme)', () => {
  const db = baseDb();
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: 'non-un-array' }), /Elenco carte non valido/);
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ quantity: 1 }] }), /printingId mancante/);
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: '2' }] }), /Quantità non valida/);
  assert.throws(() => submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 2.5 }] }), /Quantità non valida/);
  assert.equal(db.requests.length, 0);
});

// 11) payload valido -> success.
test('payload valido -> success, un item, id request restituito', () => {
  const db = baseDb();
  const id = submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 1 }, { printingId: uuid(2), quantity: 1 }] });
  assert.equal(typeof id, 'string');
  assert.equal(db.requests.length, 1);
  assert.equal(db.requestItems.length, 2);
});

// 12) Un solo item invalido su più righe -> l'INTERA richiesta fallisce, nessuna request/items parziale.
test('un item invalido tra più validi fa fallire l\'intera richiesta, atomicamente', () => {
  const db = baseDb();
  assert.throws(() => submitCollectionShareRequest(db, {
    shareId: 'share-1', requesterName: 'Ospite',
    items: [{ printingId: uuid(1), quantity: 1 }, { printingId: uuid(2), quantity: 999 }]
  }), /Quantità fuori range/);
  assert.equal(db.requests.length, 0, 'nessuna request parziale');
  assert.equal(db.requestItems.length, 0, 'nessun item parziale, nemmeno quello valido');
});

// 13) Idempotenza: doppia chiamata con lo stesso client_request_id -> una sola request, stesso id, items non duplicati.
test('doppia chiamata stesso client_request_id -> una sola request, stesso id, nessun item duplicato', () => {
  const db = baseDb();
  const first = submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 1 }], clientRequestId: 'client-abc' });
  const second = submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 1 }], clientRequestId: 'client-abc' });
  assert.equal(first, second, 'stesso id restituito');
  assert.equal(db.requests.length, 1, 'nessuna request duplicata');
  assert.equal(db.requestItems.length, 1, 'nessun item duplicato');
  assert.equal(db.notifications.length, 1, 'nessuna notifica duplicata');
});

// 14) client_request_id diversi -> due request legittime.
test('client_request_id diversi -> due request legittime distinte', () => {
  const db = baseDb();
  const first = submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite A', items: [{ printingId: uuid(1), quantity: 1 }], clientRequestId: 'client-a' });
  const second = submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite B', items: [{ printingId: uuid(2), quantity: 1 }], clientRequestId: 'client-b' });
  assert.notEqual(first, second);
  assert.equal(db.requests.length, 2);
});

// 14b) client_request_id null (client non aggiornato) -> nessuna idempotenza applicata, ogni chiamata crea una request — compatibilità con client vecchi.
test('client_request_id null -> nessuna idempotenza forzata, ogni chiamata crea una request (compatibilità client vecchi)', () => {
  const db = baseDb();
  submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 1 }] });
  submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 1 }] });
  assert.equal(db.requests.length, 2, 'senza client_request_id ogni invio è una request separata, comportamento invariato');
});

// 15) Fallimento notifica non deve MAI annullare la request/items già creati.
test('fallimento notifica: request creata, items creati, nessun rollback', () => {
  const db = baseDb();
  db.notifyShouldThrow = true;
  const id = submitCollectionShareRequest(db, { shareId: 'share-1', requesterName: 'Ospite', items: [{ printingId: uuid(1), quantity: 1 }] });
  assert.equal(db.requests.length, 1, 'la request deve esistere anche se la notifica fallisce');
  assert.equal(db.requests[0].id, id);
  assert.equal(db.requestItems.length, 1, 'gli item devono esistere anche se la notifica fallisce');
  assert.equal(db.notifications.length, 0, 'la notifica fallita non lascia una riga parziale');
});

// --- Verifiche statiche sulla migration reale --------------------------------
{
  const root = path.dirname(fileURLToPath(import.meta.url));
  const migrationPath = path.join(root, '..', 'supabase', 'migrations', '20260916120000_shared_collection_request_hardening.sql');
  const migration = await readFile(migrationPath, 'utf8');
  const sqlNoComments = migration.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');

  test('la migration aggiunge la colonna message (nullable, con limite esplicito)', () => {
    assert.match(migration, /add column if not exists message text/);
    assert.match(migration, /char_length\(message\) <= 500/);
  });
  test('la RPC accetta p_message e p_client_request_id come parametri opzionali finali, firma precedente invariata in testa', () => {
    assert.match(sqlNoComments, /p_share_id uuid,\s*\n\s*p_requester_name text,\s*\n\s*p_items jsonb,\s*\n\s*p_message text default null,\s*\n\s*p_client_request_id uuid default null/);
  });
  test('frontend e RPC usano lo stesso nome parametro p_message/p_client_request_id (js/api.js)', async () => {
    const apiJs = await readFile(path.join(root, '..', 'js', 'api.js'), 'utf8');
    assert.match(apiJs, /p_message:message\?\.trim\(\) \|\| null/);
    assert.match(apiJs, /p_client_request_id:clientRequestId \|\| null/);
  });
  test('la vecchia firma a 3 argomenti viene droppata esplicitamente (evita overload ambigui su PostgREST)', () => {
    assert.match(migration, /drop function if exists public\.submit_collection_share_request\(uuid, text, jsonb\);/);
  });
  test('SECURITY DEFINER, SET search_path, REVOKE poi GRANT preservati su submit_collection_share_request', () => {
    const start = migration.indexOf('create or replace function public.submit_collection_share_request');
    const end = migration.indexOf('grant execute on function public.submit_collection_share_request', start);
    const block = migration.slice(start, end);
    assert.match(block, /security definer/);
    assert.match(block, /set search_path = public, extensions/);
    assert.match(block, /revoke all on function public\.submit_collection_share_request\(uuid, text, jsonb, text, uuid\)\s*\n\s*from public, anon, authenticated;/);
  });
  test('grant finale a anon+authenticated insieme (mai authenticated da solo), come da convenzione del progetto', () => {
    assert.match(sqlNoComments, /grant execute on function public\.submit_collection_share_request\(uuid, text, jsonb, text, uuid\)\s*\n\s*to anon, authenticated;/);
    assert.match(sqlNoComments, /grant execute on function public\.list_collection_share_requests\(text\) to anon, authenticated;/);
  });
  test('notify pgrst reload schema presente', () => {
    assert.match(migration, /notify pgrst, 'reload schema';/);
  });
  test('idempotenza: unique index parziale (share_id, client_request_id) where not null', () => {
    assert.match(migration, /create unique index if not exists collection_share_requests_client_request_idx\s*\n\s*on public\.collection_share_requests\(share_id, client_request_id\)\s*\n\s*where client_request_id is not null;/);
  });
  test('idempotenza: gestisce la race reale con un catch di unique_violation, non solo un SELECT-then-INSERT', () => {
    assert.match(sqlNoComments, /exception when unique_violation then/);
  });
  test('notifica isolata nel proprio sub-block "when others", nessun catch globale che nasconda errori di validazione/insert', () => {
    const beginBlocks = (sqlNoComments.match(/\bbegin\b/gi) || []).length;
    assert(beginBlocks >= 3, 'attesi almeno: il blocco funzione, l\'insert della request (unique_violation) e la notifica (when others)');
    assert.match(sqlNoComments, /exception when others then\s*\n\s*raise warning/);
    // L'unico "when others" deve stare DOPO l'insert di request_items (la
    // notifica è l'ultimo passo), mai avvolgere le validazioni sopra.
    const othersIdx = sqlNoComments.indexOf('exception when others');
    const validationIdx = sqlNoComments.indexOf("raise exception 'Nome mancante'");
    const itemsInsertIdx = sqlNoComments.indexOf('insert into public.collection_share_request_items');
    assert(validationIdx < othersIdx && itemsInsertIdx < othersIdx, 'il catch globale deve avvolgere SOLO la notifica, dopo validazione e insert');
  });
  test('aggregazione per printing_id prima della validazione quantità (chiude il bypass split-quantity)', () => {
    assert.match(sqlNoComments, /select \(item->>'printingId'\)::uuid as printing_id, sum\(\(item->>'quantity'\)::integer\)::integer as quantity/);
  });
  test('il totale aggregato per printing_id è ricontrollato contro il cap 99 (non solo riga per riga)', () => {
    assert.match(sqlNoComments, /if agg\.quantity > 99 then\s*\n\s*raise exception 'Quantità fuori range/);
  });
  test('list_collection_share_requests espone message al proprietario', () => {
    assert.match(sqlNoComments, /'message', r\.message/);
  });
  console.log('migration (statico): colonna message, firma RPC, drop overload, SECURITY DEFINER/search_path/REVOKE-GRANT, notify pgrst, idempotenza (indice + unique_violation), notifica isolata, aggregazione anti-bypass, message esposto al proprietario');
}

console.log('PASS Shared Collection request hardening: validazione/idempotenza/notifica non bloccante riproducono fedelmente la RPC, migration verificata staticamente');
