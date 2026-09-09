-- F.P.T Cards — pulizia legacy prestiti (P0/P1 dal backlog 2026-09-09).
-- Eseguire dopo 20260908205000_onepiece_deck_multi_printing_per_card.sql.

-- P0: ritira il vecchio transition_loan(uuid,text) senza token/sessione.
-- Il client chiama solo transition_loan(text,uuid,text) (js/api.js:164); la
-- variante a 2 argomenti non riceve p_token e non passa mai da session_member,
-- quindi resta chiamabile senza autenticazione se qualcuno la invoca via RPC diretta.
drop function if exists public.transition_loan(uuid, text);

-- P0/P1: ritira create_team_loan singolo, sostituito da create_team_loans (batch).
-- Verificato: nessuna chiamata client a api.loans.create() in app.js/js/*.js,
-- solo a createMany() -> create_team_loans.
drop function if exists public.create_team_loan(text, text, integer, text, text);

-- P1: indici mancanti per list_team_loans (public.loans where owner_slug = me or borrower_slug = me),
-- oggi una scan completa della tabella ad ogni login/lista prestiti.
create index if not exists loans_owner_slug_idx on public.loans(owner_slug);
create index if not exists loans_borrower_slug_idx on public.loans(borrower_slug);

-- P1: loans_collection_item_idx (collection_item_id) è probabilmente ridondante
-- rispetto a loans_collection_commitment_idx (collection_item_id, status) WHERE
-- collection_item_id IS NOT NULL, introdotto in 20260908... milestone-2-1: nessuna
-- query nel codice filtra collection_item_id senza che quest'ultimo sia not null,
-- quindi l'indice composito copre lo stesso prefisso. Prima di eliminarlo in
-- produzione, conferma con la query qui sotto che non ha scan recenti:
--
--   select idx_scan, idx_tup_read, idx_tup_fetch
--   from pg_stat_user_indexes
--   where indexrelname = 'loans_collection_item_idx';
--
-- Se idx_scan resta a 0 dopo un periodo di utilizzo normale, esegui a mano:
--   drop index if exists public.loans_collection_item_idx;

notify pgrst, 'reload schema';
