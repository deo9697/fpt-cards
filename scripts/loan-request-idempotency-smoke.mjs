// Smoke test per Loan DB v2 — P0 (idempotenza + guardia anti-duplicato sulle
// richieste prestito). Nessun accesso DB reale (la migration la applica
// l'utente): verifica testualmente che la migration contenga i pezzi chiave
// e che i tre call site client (app.js x2, js/decks.js) generino e passino
// un client_request_id, stesso stile di scripts/collection-loans-2-1-smoke.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync(new URL('../supabase/migrations/20260909140000_loan_request_idempotency.sql', import.meta.url), 'utf8');
for (const required of [
  'add column if not exists client_request_id uuid',
  'loans_client_request_id_uidx',
  'revoke all on function public.fill_loan_request_metadata()',
  'drop function if exists public.request_collection_loan(text, uuid, integer, text)',
  'drop function if exists public.request_collection_loan(text, uuid, integer, text, boolean)',
  'p_client_request_id uuid default null',
  "existing.status = 'requested'",
  'p_pre_agreed', // preserva il parametro dell'altra sessione, non lo rimuove
  'create or replace function public.request_collection_loans(',
  'for update of ci'
]) assert(sql.includes(required), `migration idempotenza incompleta: ${required}`);

const api = fs.readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');
assert(!api.includes("rpc('create_team_loan',"), 'api.create() morto ancora presente (punta a una funzione droppata)');
assert(api.includes('p_client_request_id:clientRequestId'), 'requestCollectionLoan non passa più client_request_id');
assert(api.includes("client.rpc('request_collection_loans'"), 'requestCollectionLoans (batch) non collegata');

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const appCalls = [...app.matchAll(/requestCollectionLoan\(((?:[^()]|\([^()]*\))*)\)/g)];
assert(appCalls.length >= 2, 'call site requestCollectionLoan mancanti in app.js');
for (const call of appCalls) assert(call[1].includes('crypto.randomUUID()'), `call site senza client_request_id: ${call[0]}`);

const decks = fs.readFileSync(new URL('../js/decks.js', import.meta.url), 'utf8');
assert(/requestCollectionLoan\([^)]*crypto\.randomUUID\(\)/.test(decks), 'js/decks.js: richiesta dal pannello mazzo senza client_request_id');

console.log('PASS Loan DB v2 P0 · client_request_id su tutti i call site · guardia anti-duplicato · request_collection_loans batch pronta · api.create() rimosso');
