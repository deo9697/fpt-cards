-- F.P.T Cards — Loan DB v2, P0: idempotenza sulle richieste prestito + guardia
-- anti-duplicato. L'audit ha trovato richieste 'requested' duplicate nate da
-- doppio invio (nessun idempotency key, nessun vincolo lato server contro due
-- richieste della stessa carta allo stesso destinatario). Eseguire dopo
-- 20260909120000_loans_legacy_cleanup_and_indexes.sql e
-- 20260909130000_loans_pre_agreed_request.sql (quest'ultima ha già aggiunto
-- p_pre_agreed: questa migration lo preserva e aggiunge p_client_request_id
-- in coda, non lo sostituisce).
--
-- Fuori scope qui, deliberatamente:
--  - un unique index che impedisca *a livello DB* due 'requested' per la
--    stessa (collection_item_id, borrower_slug): fallirebbe alla creazione
--    se esistono già righe duplicate storiche. La guardia applicativa sotto
--    protegge da adesso in poi senza quella dipendenza; l'indice come
--    backstop resta un passo successivo, dopo aver ripulito i duplicati
--    esistenti (query diagnostica consegnata a parte, nessuna cancellazione
--    qui).
--  - migrare il client sul nuovo request_collection_loans() batch: creato
--    qui, non ancora richiamato da app.js/js/decks.js.

-- Idempotenza: nullable, un client vecchio che non la passa si comporta
-- identico a prima (nessun conflitto possibile su NULL).
alter table public.loans add column if not exists client_request_id uuid;
create unique index if not exists loans_client_request_id_uidx
  on public.loans(client_request_id) where client_request_id is not null;

-- Nessun revoke esplicito su questa funzione trigger in nessuna migration
-- precedente — l'unica eccezione tra gli helper prestiti, che sono tutti
-- già revocati da public/anon/authenticated. Corretto qui per coerenza:
-- non è mai raggiungibile via RPC comunque (Postgres rifiuta di chiamare una
-- funzione trigger fuori da un trigger), ma resta default-grantable a PUBLIC
-- finché non lo si dice esplicitamente.
revoke all on function public.fill_loan_request_metadata() from public, anon, authenticated;

-- request_collection_loan: aggiungere un parametro non è un semplice
-- CREATE OR REPLACE sicuro in Postgres — una lista di argomenti diversa è
-- un overload distinto, non una sostituzione in-place, quindi le firme
-- precedenti vanno droppate esplicitamente per non lasciarne due grantate
-- in parallelo (stesso problema già risolto per submit_collection_share_request
-- in supabase-collection-share-guest-redesign.sql). Droppo entrambe le firme
-- note per essere sicuro qualunque sia stato applicato finora.
drop function if exists public.request_collection_loan(text, uuid, integer, text);
drop function if exists public.request_collection_loan(text, uuid, integer, text, boolean);

create or replace function public.request_collection_loan(
  p_token text, p_collection_item_id uuid, p_quantity integer, p_notes text default '',
  p_pre_agreed boolean default false, p_client_request_id uuid default null
) returns public.loans language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); inventory public.collection_items;
  printing public.card_printings; created public.loans; available integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  -- Un retry con la STESSA chiave restituisce la riga già creata invece di
  -- errore o doppio insert — solo se la chiave è già presente.
  if p_client_request_id is not null then
    select * into created from public.loans where client_request_id = p_client_request_id;
    if found then return created; end if;
  end if;
  if p_quantity not between 1 and 99 or char_length(coalesce(p_notes,'')) > 500 then
    raise exception 'Dati richiesta non validi'; end if;
  select * into inventory from public.collection_items where id=p_collection_item_id;
  if not found then raise exception 'Elemento raccolta non trovato'; end if;
  if inventory.owner_slug=me then raise exception 'Non puoi richiedere una carta a te stesso'; end if;
  -- Guardia esplicita anti-duplicato: stessa carta, stesso destinatario, già
  -- in stato 'requested'. Applicativa (non un vincolo DB) apposta — non
  -- dipende dalla pulizia dei duplicati storici, protegge da subito.
  if exists (
    select 1 from public.loans existing
    where existing.collection_item_id = p_collection_item_id
      and existing.borrower_slug = me and existing.status = 'requested'
  ) then raise exception 'Hai già una richiesta in corso per questa carta'; end if;
  select * into printing from public.card_printings where id=inventory.printing_id;
  if not found then raise exception 'Printing non valida'; end if;
  if exists(select 1 from public.loans l where l.collection_item_id is null
    and l.owner_slug=inventory.owner_slug and l.game=printing.game
    and l.status in ('pending','requested','reserved','active','return_pending')
    and (nullif(trim(l.card_external_id),'')=printing.catalog_card_id
      or (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name))=lower(trim(printing.card_name))))
    and 1 < (select count(*) from public.collection_items ci join public.card_printings p on p.id=ci.printing_id
      where ci.owner_slug=inventory.owner_slug and p.game=printing.game
      and (p.catalog_card_id=printing.catalog_card_id or lower(trim(p.card_name))=lower(trim(printing.card_name))))) then
    raise exception 'Printing ambigua per prestiti legacy'; end if;
  available := greatest(inventory.quantity_owned-public.collection_item_loaned(inventory.id)-public.collection_item_reserved(inventory.id),0);
  if p_quantity > available then raise exception 'Quantità fisicamente non disponibile'; end if;
  insert into public.loans(card_name,quantity,requested_quantity,accepted_quantity,owner_slug,borrower_slug,notes,status,
    card_external_id,card_image,game,collection_item_id,request_origin,card_set_code,card_set_name,card_rarity,
    pre_agreed,client_request_id)
  values(printing.card_name,p_quantity,p_quantity,0,inventory.owner_slug,me,left(coalesce(p_notes,''),500),'requested',
    printing.catalog_card_id,nullif(printing.image_url,''),printing.game,inventory.id,'collection_request',
    printing.set_code,printing.set_name,printing.rarity,coalesce(p_pre_agreed,false),p_client_request_id)
  returning * into created;
  return created;
end;
$$;

revoke all on function public.request_collection_loan(text,uuid,integer,text,boolean,uuid) from public,anon,authenticated;
grant execute on function public.request_collection_loan(text,uuid,integer,text,boolean,uuid) to anon,authenticated;

-- request_collection_loans: versione batch, stessa validazione riga per riga
-- della singolare (incluse guardia anti-duplicato e idempotenza per-item),
-- con lock esplicito per riga distinta e aggregazione delle quantità
-- richieste per collection_item_id prima del controllo disponibilità —
-- stesso schema già collaudato in create_team_loans
-- (supabase-fix-create-team-loans-lock-v2.sql). Tutto o niente: se un item
-- non è valido l'intera chiamata fallisce, nessuno stato parziale.
-- Non ancora richiamata dal client (P1): creata qui pronta per l'uso.
create or replace function public.request_collection_loans(
  p_token text, p_items jsonb
) returns setof public.loans language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); locked_item_id uuid; item jsonb;
  inventory public.collection_items; printing public.card_printings;
  v_client_request_id uuid; v_notes text; created public.loans; existing_ids uuid[] := '{}';
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'Elenco richieste non valido'; end if;

  for locked_item_id in
    select distinct (c->>'collectionItemId')::uuid from jsonb_array_elements(p_items) c
    order by (c->>'collectionItemId')::uuid
  loop
    perform ci.id from public.collection_items ci where ci.id = locked_item_id for update of ci;
  end loop;

  if exists(select 1 from (
    select (c->>'collectionItemId')::uuid item_id, sum((c->>'quantity')::integer)::integer requested
    from jsonb_array_elements(p_items) c group by (c->>'collectionItemId')::uuid) agg
    join public.collection_items ci on ci.id = agg.item_id
    where agg.requested > greatest(ci.quantity_owned - public.collection_item_loaned(ci.id)
      - public.collection_item_reserved(ci.id), 0)) then
    raise exception 'Quantità fisicamente non disponibile'; end if;

  for item in select * from jsonb_array_elements(p_items) loop
    if (item->>'quantity')::integer not between 1 and 99 then raise exception 'Dati richiesta non validi'; end if;
    select * into inventory from public.collection_items where id = (item->>'collectionItemId')::uuid;
    if not found then raise exception 'Elemento raccolta non trovato'; end if;
    if inventory.owner_slug = me then raise exception 'Non puoi richiedere una carta a te stesso'; end if;
    select * into printing from public.card_printings where id = inventory.printing_id;
    if not found then raise exception 'Printing non valida'; end if;
    if exists (select 1 from public.loans existing where existing.collection_item_id = inventory.id
      and existing.borrower_slug = me and existing.status = 'requested') then
      raise exception 'Hai già una richiesta in corso per questa carta'; end if;

    v_notes := left(coalesce(item->>'notes',''),500);
    v_client_request_id := nullif(item->>'clientRequestId','')::uuid;
    if v_client_request_id is not null then
      select * into created from public.loans l where l.client_request_id = v_client_request_id;
      if found then existing_ids := existing_ids || created.id; continue; end if;
    end if;

    insert into public.loans(card_name,quantity,requested_quantity,accepted_quantity,owner_slug,borrower_slug,notes,status,
      card_external_id,card_image,game,collection_item_id,request_origin,card_set_code,card_set_name,card_rarity,
      pre_agreed,client_request_id)
    values(printing.card_name,(item->>'quantity')::integer,(item->>'quantity')::integer,0,inventory.owner_slug,me,v_notes,'requested',
      printing.catalog_card_id,nullif(printing.image_url,''),printing.game,inventory.id,'collection_request',
      printing.set_code,printing.set_name,printing.rarity,coalesce((item->>'preAgreed')::boolean,false),v_client_request_id)
    returning * into created;
    existing_ids := existing_ids || created.id;
  end loop;

  return query select * from public.loans where id = any(existing_ids);
end;
$$;

revoke all on function public.request_collection_loans(text,jsonb) from public,anon,authenticated;
grant execute on function public.request_collection_loans(text,jsonb) to anon,authenticated;

notify pgrst, 'reload schema';
