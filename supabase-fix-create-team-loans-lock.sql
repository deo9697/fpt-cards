-- Hotfix: evita "FOR UPDATE is not allowed with DISTINCT clause" durante
-- la creazione di un prestito dal Loan Builder.
-- Eseguire dopo supabase-milestone-2-collection.sql.

begin;

create or replace function public.create_team_loans(
  p_token text, p_cards jsonb, p_borrower_slug text, p_notes text default '', p_game text default 'yugioh'
) returns setof public.loans language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') then raise exception 'Gioco non valido'; end if;
  if p_borrower_slug = me or not exists(select 1 from public.team_members where slug = p_borrower_slug and active) then raise exception 'Destinatario non valido'; end if;
  if jsonb_typeof(p_cards) <> 'array' or jsonb_array_length(p_cards) not between 1 and 50 then raise exception 'Elenco carte non valido'; end if;
  if exists(select 1 from jsonb_array_elements(p_cards) c where char_length(trim(c->>'name')) not between 1 and 200 or (c->>'quantity')::integer not between 1 and 99) then raise exception 'Dati carta non validi'; end if;
  if exists(select 1 from jsonb_array_elements(p_cards) c where nullif(c->>'collectionItemId','') is not null
    and not exists(select 1 from public.collection_items ci join public.card_printings p on p.id = ci.printing_id
      where ci.id = (c->>'collectionItemId')::uuid and ci.owner_slug = me and p.game = p_game)) then raise exception 'Elemento raccolta non valido'; end if;

  -- La query principale non usa DISTINCT: PostgreSQL puo quindi applicare
  -- FOR UPDATE esclusivamente alle righe fisiche di collection_items.
  perform ci.id from public.collection_items ci
  where exists (
    select 1 from jsonb_array_elements(p_cards) c
    where nullif(c->>'collectionItemId','') is not null
      and ci.id = (c->>'collectionItemId')::uuid)
  order by ci.id for update of ci;

  if exists(select 1 from (
    select (c->>'collectionItemId')::uuid item_id, sum((c->>'quantity')::integer)::integer requested
    from jsonb_array_elements(p_cards) c where nullif(c->>'collectionItemId','') is not null
    group by (c->>'collectionItemId')::uuid) requested
    join public.collection_items ci on ci.id = requested.item_id
    where requested.requested > greatest(ci.quantity_owned - public.collection_item_loaned(ci.id)
      - public.collection_item_reserved(ci.id), 0)) then raise exception 'Quantità fisicamente non disponibile'; end if;

  return query insert into public.loans(card_name, quantity, owner_slug, borrower_slug, notes,
    card_external_id, card_image, game, collection_item_id)
  select coalesce(p.card_name, trim(c->>'name')), (c->>'quantity')::integer, me, p_borrower_slug,
    left(coalesce(p_notes,''),500), coalesce(p.catalog_card_id, nullif(left(c->>'externalId',100),'')),
    coalesce(nullif(p.image_url,''), nullif(left(c->>'image',500),'')), p_game, ci.id
  from jsonb_array_elements(p_cards) c
  left join public.collection_items ci on ci.id = (nullif(c->>'collectionItemId',''))::uuid
  left join public.card_printings p on p.id = ci.printing_id returning *;
end;
$$;

revoke all on function public.create_team_loans(text,jsonb,text,text,text) from public;
grant execute on function public.create_team_loans(text,jsonb,text,text,text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
