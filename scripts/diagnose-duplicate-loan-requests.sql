-- Loan DB v2 — diagnostica sola-lettura per i gruppi di richieste 'requested'
-- duplicate trovati nell'audit. NON è una migration, non scrive nulla.
-- Incolla il risultato prima di decidere come trattare ogni gruppo (unire,
-- cancellare la più vecchia, contattare chi ha ricevuto la richiesta) — la
-- migration 20260909140000_loan_request_idempotency.sql protegge solo le
-- richieste FUTURE, non tocca le righe già esistenti.

-- Gruppo A: percorso attuale (collection_item_id valorizzato) — stessa carta
-- (collection_item_id), stesso destinatario (borrower_slug), più righe
-- ancora in stato 'requested'.
select owner_slug, borrower_slug, collection_item_id, count(*) as duplicates,
  array_agg(id order by created_at) as loan_ids,
  array_agg(created_at order by created_at) as created_at_each
from public.loans
where status = 'requested' and collection_item_id is not null
group by 1, 2, 3
having count(*) > 1
order by count(*) desc;

-- Gruppo B: percorso legacy (collection_item_id null) — stessa identità carta
-- (card_external_id se presente, altrimenti nome normalizzato), stesso
-- proprietario e destinatario, più righe 'requested'.
select owner_slug, borrower_slug,
  coalesce(nullif(trim(card_external_id), ''), lower(trim(card_name))) as card_identity,
  count(*) as duplicates,
  array_agg(id order by created_at) as loan_ids,
  array_agg(created_at order by created_at) as created_at_each
from public.loans
where status = 'requested' and collection_item_id is null
group by 1, 2, 3
having count(*) > 1
order by count(*) desc;
