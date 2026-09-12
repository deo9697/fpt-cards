-- F.P.T Cards — throttle del repair/enrichment automatico del catalogo.
--
-- Problema risolto: all'avvio, list_collection_catalog_verification_queue
-- restituiva TUTTA la coda pending (in una raccolta reale: ~2500-2700 righe,
-- ~8000 card_printings pending in totale) e js/api.js la paginava per
-- intero con pagedRpc — nessun limite sul totale processato, solo la
-- concorrenza client-side (4) a rallentare la scarica. Ogni riga innescava
-- fino a 2 richieste YGOPRODeck (cardinfo.php IT+EN) e una
-- repair_collection_item_catalog_identity: per un id/nome legacy non più
-- risolvibile dal provider, entrambe rispondono 400 — e siccome il
-- fallimento non veniva mai persistito (solo un Set in-memory per sessione),
-- la STESSA riga tornava identica in coda a ogni apertura dell'app,
-- all'infinito.
--
-- Questa migration NON introduce un backfill server-side (non richiesto,
-- e comunque molte di queste righe sono legacy/regionali che YGOPRODeck non
-- conosce — vedi nota di progetto sul Fast Scan: vanno risolte a mano in
-- Supabase, non indovinate da un provider che non le ha). Si limita a:
--   1) far si che la coda restituisca un batch piccolo (default 20, max 50),
--      ordinato per dare priorità alle righe mai tentate;
--   2) dare al client un modo di registrare un fallimento (RPC dedicata)
--      cosi la riga entra in backoff esponenziale invece di essere ritentata
--      identica a ogni bootstrap, e dopo troppi tentativi passa a uno stato
--      terminale ('unresolved') che la coda esclude fino a intervento manuale.
--
-- NOTA: la versione originariamente preparata di questa migration includeva
-- anche una riscrittura di enrich_loan_card. Verificato PRIMA di applicare
-- (pg_get_functiondef sul progetto live) che la funzione live e' GIA' stata
-- aggiornata da un lavoro precedente (supporto One Piece optcgapi.com,
-- p_external_id text, scrittura via "is distinct from" invece del guard
-- "card_image is null") — piu' avanzata di quanto assunto dai file .sql
-- storici in root. Riscriverla qui l'avrebbe REGREDITA. Il blocco e' stato
-- rimosso da questa migration: la mitigazione per enrich_loan_card resta
-- solo lato client (app.js non la chiama piu' per un prestito che ha gia'
-- un'immagine persistita — vedi loan.hasStoredImage).
--
-- Additiva e conservativa: nessuna validazione di sicurezza/ownership viene
-- rimossa o allentata, nessuna RPC diventa permissiva, RLS/SECURITY DEFINER
-- invariati. list_collection_catalog_verification_queue e
-- repair_collection_item_catalog_identity verificate contro il corpo live
-- prima di applicare: nessuna deriva, sicuro sostituire/estendere.

begin;

alter table public.card_printings
  add column if not exists catalog_verification_attempts integer not null default 0,
  add column if not exists catalog_verification_last_attempt_at timestamptz,
  add column if not exists catalog_verification_retry_after timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'card_printings_catalog_verification_attempts_check'
      and conrelid = 'public.card_printings'::regclass
  ) then
    alter table public.card_printings add constraint card_printings_catalog_verification_attempts_check
      check (catalog_verification_attempts >= 0);
  end if;
end $$;

-- 'unresolved' = stato terminale del backoff automatico (troppi tentativi
-- falliti: provider senza match, immagine mancante, immagine/catalog ID
-- incoerenti, 400 ripetuti). Diverso da 'incoherent' (già esistente, mai
-- scritto da nessuna funzione oggi — riservato a un futuro marcamento
-- esplicito/manuale): 'unresolved' è ciò che l'automazione produce da sola
-- quando deve arrendersi, ed è esclusa dalla coda finché qualcuno non la
-- resetta (backfill admin o correzione dei dati sorgente).
alter table public.card_printings drop constraint if exists card_printings_catalog_verification_status_check;
alter table public.card_printings add constraint card_printings_catalog_verification_status_check
  check (catalog_verification_status in ('pending','verified','incoherent','unresolved'));

drop index if exists public.card_printings_catalog_verification_retry_idx;
create index card_printings_catalog_verification_retry_idx
  on public.card_printings(catalog_verification_status, catalog_verification_retry_after);

-- Coda di TRIAGE limitata, non l'elenco completo dei pending: p_limit e'
-- clampato server-side (default 20, mai oltre 50) indipendentemente da cosa
-- invia il client. Deduplica per printing (distinct on cp.id): riparare una
-- printing corregge automaticamente tutti i collection_items che la
-- referenziano, quindi non ha senso restituire più righe per la stessa
-- printing solo perché più persone la possiedono. Ordina per tentativi
-- crescenti così le righe mai provate hanno priorità su quelle già in
-- backoff da un ciclo precedente.
create or replace function public.list_collection_catalog_verification_queue(
  p_token text, p_verification_version integer, p_limit integer default 20
) returns table(
  collection_item_id uuid, printing_id uuid, game text, catalog_card_id text,
  card_name text, set_code text, set_name text, rarity text, image_url text,
  verification_status text, verification_version integer
) language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  v_limit integer := least(greatest(coalesce(p_limit,20),1),50);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_verification_version <> 1 then raise exception 'Versione verifica non supportata'; end if;
  return query
    select q.collection_item_id, q.printing_id, q.game, q.catalog_card_id, q.card_name,
      q.set_code, q.set_name, q.rarity, q.image_url, q.verification_status, q.verification_version
    from (
      select distinct on (cp.id)
        ci.id as collection_item_id, cp.id as printing_id, cp.game, cp.catalog_card_id, cp.card_name,
        cp.set_code, cp.set_name, cp.rarity, cp.image_url,
        cp.catalog_verification_status as verification_status,
        cp.catalog_verification_version as verification_version,
        cp.catalog_verification_attempts as attempts, cp.updated_at
      from public.collection_items ci
      join public.card_printings cp on cp.id = ci.printing_id
      where ci.owner_slug = me
        and cp.catalog_verification_status <> 'unresolved'
        and (cp.catalog_verification_retry_after is null or cp.catalog_verification_retry_after <= now())
        and (
          cp.catalog_verification_status <> 'verified'
          or cp.catalog_verification_version < p_verification_version
          or char_length(trim(cp.catalog_card_id)) < 1
          or char_length(trim(cp.card_name)) < 1
          or cp.image_url not like 'https://%'
        )
      order by cp.id, ci.updated_at asc
    ) q
    order by q.attempts asc, q.updated_at asc
    limit v_limit;
end;
$$;

-- Registra l'esito negativo di un tentativo di verifica/repair fatto dal
-- client (provider senza match, immagine mancante, RPC di repair che ha
-- rifiutato dati incoerenti, errore di rete/provider). Senza questo, un
-- fallimento non scrive nulla e la riga torna identica in coda al prossimo
-- bootstrap — la causa esatta del loop segnalato. Backoff esponenziale
-- (2^tentativi ore, max 7 giorni); dopo troppi tentativi lo stato passa a
-- 'unresolved' e la riga esce dalla coda automatica finché non viene
-- corretta manualmente (i dati sorgente sono spesso legacy/regionali non
-- noti al provider, non un problema che un ritentativo risolverebbe).
create or replace function public.record_collection_catalog_verification_attempt(
  p_token text, p_collection_item_id uuid, p_verification_version integer,
  p_outcome text, p_error text default null
) returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  inventory public.collection_items;
  printing public.card_printings;
  attempts integer;
  max_attempts constant integer := 5;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_outcome not in ('ambiguous','missing_image','failed') then
    raise exception 'Esito non valido';
  end if;

  select * into inventory from public.collection_items where id = p_collection_item_id;
  if not found or inventory.owner_slug <> me then
    raise exception 'Elemento raccolta non trovato o non modificabile';
  end if;
  select * into printing from public.card_printings where id = inventory.printing_id for update;
  if not found then return; end if;

  -- Una repair concorrente (altro tab, Fast Scan, un altro client) può aver
  -- già verificato questa printing mentre il fallimento era in transito: non
  -- farlo regredire a 'pending'/'unresolved' per un esito ormai stantio.
  if printing.catalog_verification_status = 'verified'
    and printing.catalog_verification_version >= p_verification_version then
    return;
  end if;

  attempts := printing.catalog_verification_attempts + 1;
  update public.card_printings set
    catalog_verification_attempts = attempts,
    catalog_verification_last_attempt_at = now(),
    catalog_verification_error = left(coalesce(p_outcome,'') || case when p_error is not null then ': '||p_error else '' end, 500),
    catalog_verification_retry_after = now() + make_interval(hours => least(power(2, attempts)::int, 168)),
    catalog_verification_status = case when attempts >= max_attempts then 'unresolved' else 'pending' end
  where id = printing.id;
end;
$$;

revoke all on function public.list_collection_catalog_verification_queue(text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.list_collection_catalog_verification_queue(text,integer,integer)
  to anon, authenticated;

revoke all on function public.record_collection_catalog_verification_attempt(text,uuid,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.record_collection_catalog_verification_attempt(text,uuid,integer,text,text)
  to anon, authenticated;

-- La vecchia firma (text,integer) del client precedente non serve più: il
-- client aggiornato invia sempre p_limit. Rimossa per non lasciare in giro
-- una via di accesso senza limite di batch.
drop function if exists public.list_collection_catalog_verification_queue(text, integer);

notify pgrst, 'reload schema';

commit;
