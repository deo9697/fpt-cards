-- F.P.T Cards — Milestone 2: raccolta/inventario.
-- Migrazione additiva NON ancora applicata. Eseguire dopo
-- supabase-admin-partial-offline-upgrade.sql e supabase-multi-game-upgrade.sql.
-- Non modifica né elimina lo storico prestiti.

create table if not exists public.card_printings (
  id uuid primary key default gen_random_uuid(),
  game text not null check (game in ('yugioh', 'onepiece')),
  catalog_card_id text not null check (char_length(trim(catalog_card_id)) between 1 and 100),
  card_name text not null check (char_length(trim(card_name)) between 1 and 200),
  set_code text not null default '' check (char_length(set_code) <= 100),
  set_name text not null default '' check (char_length(set_name) <= 200),
  rarity text not null default '' check (char_length(rarity) <= 100),
  image_url text not null default '' check (char_length(image_url) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game, catalog_card_id, set_code, rarity)
);

create table if not exists public.collection_items (
  id uuid primary key default gen_random_uuid(),
  owner_slug text not null references public.team_members(slug),
  printing_id uuid not null references public.card_printings(id),
  language text not null default 'Italiano' check (char_length(language) between 1 and 50),
  condition text not null default 'Near Mint'
    check (condition in ('Mint', 'Near Mint', 'Excellent', 'Good', 'Played', 'Poor')),
  edition text not null default '' check (char_length(edition) <= 100),
  quantity_owned integer not null check (quantity_owned between 1 and 999),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_slug, printing_id, language, condition, edition)
);

alter table public.loans add column if not exists collection_item_id uuid;
do $$ begin
  alter table public.loans add constraint loans_collection_item_id_fkey
    foreign key (collection_item_id) references public.collection_items(id) on delete set null;
exception when duplicate_object then null;
end $$;

create index if not exists collection_items_owner_idx on public.collection_items(owner_slug);
create index if not exists collection_items_printing_idx on public.collection_items(printing_id);
create index if not exists card_printings_catalog_idx on public.card_printings(game, catalog_card_id);
create index if not exists card_printings_set_code_idx on public.card_printings(game, set_code);
create index if not exists loans_collection_item_idx on public.loans(collection_item_id)
  where collection_item_id is not null;

alter table public.card_printings enable row level security;
alter table public.collection_items enable row level security;
revoke all on public.card_printings, public.collection_items from public, anon, authenticated;

create or replace function public.touch_collection_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists touch_card_printings_updated_at on public.card_printings;
create trigger touch_card_printings_updated_at before update on public.card_printings
for each row execute function public.touch_collection_updated_at();
drop trigger if exists touch_collection_items_updated_at on public.collection_items;
create trigger touch_collection_items_updated_at before update on public.collection_items
for each row execute function public.touch_collection_updated_at();

-- I prestiti legacy vengono attribuiti soltanto quando catalogo/nome identificano
-- un unico item del proprietario. In caso ambiguo non scegliamo una printing.
create or replace function public.loan_matches_collection_item(
  p_loan public.loans, p_item_id uuid, p_owner text, p_game text,
  p_catalog_card_id text, p_card_name text
) returns boolean language sql stable security definer set search_path = public as $$
  select p_loan.collection_item_id = p_item_id
    or (p_loan.collection_item_id is null
      and nullif(trim(p_loan.card_external_id), '') = p_catalog_card_id
      and 1 = (select count(*) from public.collection_items ci
        join public.card_printings p on p.id = ci.printing_id
        where ci.owner_slug = p_owner and p.game = p_game and p.catalog_card_id = p_catalog_card_id))
    or (p_loan.collection_item_id is null
      and nullif(trim(p_loan.card_external_id), '') is null
      and lower(trim(p_loan.card_name)) = lower(trim(p_card_name))
      and 1 = (select count(*) from public.collection_items ci
        join public.card_printings p on p.id = ci.printing_id
        where ci.owner_slug = p_owner and p.game = p_game
          and lower(trim(p.card_name)) = lower(trim(p_card_name))))
$$;

create or replace function public.collection_item_loaned(p_item_id uuid)
returns integer language sql stable security definer set search_path = public as $$
  with target as (select ci.id, ci.owner_slug, p.game, p.catalog_card_id, p.card_name
    from public.collection_items ci join public.card_printings p on p.id = ci.printing_id
    where ci.id = p_item_id)
  select coalesce(sum(greatest(l.quantity - l.returned_quantity, 0)), 0)::integer
  from public.loans l cross join target t
  where l.owner_slug = t.owner_slug and l.game = t.game
    and l.status in ('active', 'return_pending')
    and public.loan_matches_collection_item(l, t.id, t.owner_slug, t.game, t.catalog_card_id, t.card_name)
$$;

create or replace function public.collection_item_reserved(p_item_id uuid)
returns integer language sql stable security definer set search_path = public as $$
  with target as (select ci.id, ci.owner_slug, p.game, p.catalog_card_id, p.card_name
    from public.collection_items ci join public.card_printings p on p.id = ci.printing_id
    where ci.id = p_item_id)
  select coalesce(sum(greatest(l.quantity - l.returned_quantity, 0)), 0)::integer
  from public.loans l cross join target t
  where l.owner_slug = t.owner_slug and l.game = t.game and l.status = 'pending'
    and public.loan_matches_collection_item(l, t.id, t.owner_slug, t.game, t.catalog_card_id, t.card_name)
$$;
revoke all on function public.loan_matches_collection_item(public.loans,uuid,text,text,text,text),
  public.collection_item_loaned(uuid), public.collection_item_reserved(uuid)
  from public, anon, authenticated;

create or replace function public.list_my_collection(p_token text)
returns table(
  id uuid, printing_id uuid, owner_slug text, owner_name text, game text,
  catalog_card_id text, card_name text, set_code text, set_name text, rarity text,
  language text, condition text, edition text, image_url text,
  quantity_owned integer, quantity_loaned integer, quantity_reserved integer,
  quantity_physically_available integer, legacy_ambiguous boolean,
  created_at timestamptz, updated_at timestamptz
) language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select ci.id, p.id, ci.owner_slug, m.full_name, p.game, p.catalog_card_id,
    p.card_name, p.set_code, p.set_name, p.rarity, ci.language, ci.condition,
    ci.edition, p.image_url, ci.quantity_owned, q.loaned, q.reserved,
    greatest(ci.quantity_owned - q.loaned - q.reserved, 0),
    exists (select 1 from public.loans l where l.owner_slug = ci.owner_slug and l.game = p.game
      and l.collection_item_id is null and l.status in ('pending','active','return_pending')
      and (nullif(trim(l.card_external_id),'') = p.catalog_card_id
        or (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name)) = lower(trim(p.card_name)))))
    and 1 < (select count(*) from public.collection_items ci2
      join public.card_printings p2 on p2.id = ci2.printing_id
      where ci2.owner_slug = ci.owner_slug and p2.game = p.game
        and (p2.catalog_card_id = p.catalog_card_id or lower(trim(p2.card_name)) = lower(trim(p.card_name)))),
    ci.created_at, ci.updated_at
  from public.collection_items ci join public.card_printings p on p.id = ci.printing_id
  join public.team_members m on m.slug = ci.owner_slug
  cross join lateral (select public.collection_item_loaned(ci.id) loaned,
    public.collection_item_reserved(ci.id) reserved) q
  where ci.owner_slug = me order by p.card_name, p.set_code, ci.condition;
end;
$$;

create or replace function public.list_team_collection(p_token text)
returns table(
  id uuid, printing_id uuid, owner_slug text, owner_name text, game text,
  catalog_card_id text, card_name text, set_code text, set_name text, rarity text,
  language text, condition text, edition text, image_url text,
  quantity_loaned integer, quantity_reserved integer,
  quantity_physically_available integer, legacy_ambiguous boolean, updated_at timestamptz
) language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select ci.id, p.id, ci.owner_slug, m.full_name, p.game, p.catalog_card_id,
    p.card_name, p.set_code, p.set_name, p.rarity, ci.language, ci.condition,
    ci.edition, p.image_url, q.loaned, q.reserved,
    greatest(ci.quantity_owned - q.loaned - q.reserved, 0),
    exists (select 1 from public.loans l where l.owner_slug = ci.owner_slug and l.game = p.game
      and l.collection_item_id is null and l.status in ('pending','active','return_pending')
      and (nullif(trim(l.card_external_id),'') = p.catalog_card_id
        or (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name)) = lower(trim(p.card_name)))))
    and 1 < (select count(*) from public.collection_items ci2
      join public.card_printings p2 on p2.id = ci2.printing_id
      where ci2.owner_slug = ci.owner_slug and p2.game = p.game
        and (p2.catalog_card_id = p.catalog_card_id or lower(trim(p2.card_name)) = lower(trim(p.card_name)))),
    ci.updated_at
  from public.collection_items ci join public.card_printings p on p.id = ci.printing_id
  join public.team_members m on m.slug = ci.owner_slug and m.active
  cross join lateral (select public.collection_item_loaned(ci.id) loaned,
    public.collection_item_reserved(ci.id) reserved) q
  order by p.card_name, m.full_name, p.set_code;
end;
$$;

-- p_id null + increment: scansioni/import ripetuti accorpano la stessa copia.
-- p_id valorizzato + set: l'editor imposta la quantità assoluta.
create or replace function public.save_collection_item(
  p_token text, p_id uuid, p_game text, p_catalog_card_id text, p_card_name text,
  p_set_code text default '', p_set_name text default '', p_rarity text default '',
  p_language text default 'Italiano', p_condition text default 'Near Mint',
  p_edition text default '', p_image_url text default '',
  p_quantity_owned integer default 1, p_quantity_mode text default 'set'
) returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); printing uuid;
  item public.collection_items; committed integer := 0; stored_owned integer := 0;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') then raise exception 'Gioco non valido'; end if;
  if char_length(trim(coalesce(p_catalog_card_id,''))) not between 1 and 100
    or char_length(trim(coalesce(p_card_name,''))) not between 1 and 200 then raise exception 'Carta di catalogo non valida'; end if;
  if p_quantity_owned not between 1 and 999 or p_quantity_mode not in ('set','increment') then raise exception 'Quantità non valida'; end if;
  if p_condition not in ('Mint','Near Mint','Excellent','Good','Played','Poor')
    or char_length(trim(coalesce(p_language,''))) not between 1 and 50 then raise exception 'Metadati della copia non validi'; end if;
  if coalesce(p_image_url,'') <> '' and (p_image_url not like 'https://%' or char_length(p_image_url) > 500) then raise exception 'URL immagine non valido'; end if;

  insert into public.card_printings(game, catalog_card_id, card_name, set_code, set_name, rarity, image_url)
  values (p_game, trim(p_catalog_card_id), trim(p_card_name), upper(left(trim(coalesce(p_set_code,'')),100)),
    left(trim(coalesce(p_set_name,'')),200), left(trim(coalesce(p_rarity,'')),100), left(coalesce(p_image_url,''),500))
  on conflict (game, catalog_card_id, set_code, rarity) do update set card_name = excluded.card_name,
    set_name = case when excluded.set_name <> '' then excluded.set_name else public.card_printings.set_name end,
    image_url = case when excluded.image_url <> '' then excluded.image_url else public.card_printings.image_url end
  returning id into printing;

  if p_id is null then
    if p_quantity_mode = 'increment' then
      insert into public.collection_items(owner_slug, printing_id, language, condition, edition, quantity_owned)
      values(me, printing, trim(p_language), p_condition, left(trim(coalesce(p_edition,'')),100), p_quantity_owned)
      on conflict (owner_slug, printing_id, language, condition, edition) do update
        set quantity_owned = public.collection_items.quantity_owned + excluded.quantity_owned
        where public.collection_items.quantity_owned + excluded.quantity_owned <= 999
      returning id into p_id;
      if p_id is null then raise exception 'Quantità massima superata'; end if;
    else
      insert into public.collection_items(owner_slug, printing_id, language, condition, edition, quantity_owned)
      values(me, printing, trim(p_language), p_condition, left(trim(coalesce(p_edition,'')),100), p_quantity_owned)
      on conflict (owner_slug, printing_id, language, condition, edition) do update
        set quantity_owned = excluded.quantity_owned
      returning id into p_id;
    end if;
    committed := public.collection_item_loaned(p_id) + public.collection_item_reserved(p_id);
    select quantity_owned into stored_owned from public.collection_items where id = p_id for update;
    if stored_owned < committed then raise exception 'Quantità inferiore alle copie già impegnate'; end if;
  else
    select * into item from public.collection_items where id = p_id for update;
    if not found or item.owner_slug <> me then raise exception 'Elemento non trovato o non modificabile'; end if;
    committed := public.collection_item_loaned(p_id) + public.collection_item_reserved(p_id);
    if p_quantity_owned < committed then raise exception 'Quantità inferiore alle copie già impegnate'; end if;
    if item.printing_id <> printing and committed > 0 then raise exception 'Non puoi cambiare printing mentre esiste un prestito collegato'; end if;
    if exists(select 1 from public.collection_items ci where ci.owner_slug = me and ci.id <> p_id
      and ci.printing_id = printing and ci.language = trim(p_language)
      and ci.condition = p_condition and ci.edition = left(trim(coalesce(p_edition,'')),100)) then
      raise exception 'Esiste già un elemento con questa printing e gli stessi metadati'; end if;
    update public.collection_items set printing_id = printing, language = trim(p_language), condition = p_condition,
      edition = left(trim(coalesce(p_edition,'')),100), quantity_owned = p_quantity_owned where id = p_id;
  end if;
  return p_id;
end;
$$;

create or replace function public.delete_collection_item(p_token text, p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); item public.collection_items;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select * into item from public.collection_items where id = p_id for update;
  if not found or item.owner_slug <> me then raise exception 'Elemento non trovato o non modificabile'; end if;
  if exists(select 1 from public.loans where collection_item_id = p_id and status in ('pending','active','return_pending')) then
    raise exception 'Non puoi rimuovere una carta con un prestito collegato non concluso'; end if;
  delete from public.collection_items where id = p_id;
end;
$$;

create or replace function public.create_team_loans(
  p_token text, p_cards jsonb, p_borrower_slug text, p_notes text default '', p_game text default 'yugioh'
) returns setof public.loans language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); locked_item_id uuid;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') then raise exception 'Gioco non valido'; end if;
  if p_borrower_slug = me or not exists(select 1 from public.team_members where slug = p_borrower_slug and active) then raise exception 'Destinatario non valido'; end if;
  if jsonb_typeof(p_cards) <> 'array' or jsonb_array_length(p_cards) not between 1 and 50 then raise exception 'Elenco carte non valido'; end if;
  if exists(select 1 from jsonb_array_elements(p_cards) c where char_length(trim(c->>'name')) not between 1 and 200 or (c->>'quantity')::integer not between 1 and 99) then raise exception 'Dati carta non validi'; end if;
  if exists(select 1 from jsonb_array_elements(p_cards) c where nullif(c->>'collectionItemId','') is not null
    and not exists(select 1 from public.collection_items ci join public.card_printings p on p.id = ci.printing_id
      where ci.id = (c->>'collectionItemId')::uuid and ci.owner_slug = me and p.game = p_game)) then raise exception 'Elemento raccolta non valido'; end if;

  for locked_item_id in
    select (c->>'collectionItemId')::uuid
    from jsonb_array_elements(p_cards) c
    where nullif(c->>'collectionItemId','') is not null
    group by (c->>'collectionItemId')::uuid
    order by (c->>'collectionItemId')::uuid
  loop
    perform ci.id from public.collection_items ci
    where ci.id = locked_item_id
    for update of ci;
  end loop;
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

create or replace function public.transition_loan(p_token text, p_id uuid, p_action text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare item public.loans; me text := public.session_member(p_token); admin boolean;
  new_returned integer; inventory public.collection_items;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  select * into item from public.loans where id = p_id for update;
  if not found then raise exception 'Prestito non trovato'; end if;
  if p_action = 'admin-delete' and admin then delete from public.loans where id = p_id;
  elsif p_action = 'accept' and item.status = 'pending' and item.borrower_slug = me then
    if item.collection_item_id is not null then
      select * into inventory from public.collection_items where id = item.collection_item_id for update;
      if not found or public.collection_item_loaned(inventory.id) + public.collection_item_reserved(inventory.id) > inventory.quantity_owned then
        raise exception 'Quantità fisicamente non disponibile'; end if;
    end if;
    update public.loans set status='active' where id=p_id;
  elsif p_action = 'reject' and item.status = 'pending' and item.borrower_slug = me then delete from public.loans where id=p_id;
  elsif p_action = 'return' and item.status = 'active' and item.borrower_slug = me then
    update public.loans set status='return_pending', pending_return_quantity=quantity-returned_quantity where id=p_id;
  elsif p_action = 'confirm-return' and item.status = 'return_pending' and item.owner_slug = me then
    new_returned := item.returned_quantity + item.pending_return_quantity;
    update public.loans set returned_quantity = new_returned, pending_return_quantity = 0,
      status = case when new_returned >= quantity then 'returned' else 'active' end,
      returned_at = case when new_returned >= quantity then now() else null end where id=p_id;
  else raise exception 'Operazione non consentita'; end if;
end;
$$;

create or replace function public.broadcast_collection_change()
returns trigger language plpgsql security definer set search_path = public, realtime as $$
begin
  perform realtime.send(jsonb_build_object('changed', true), 'collection_changed', 'fpt-collection', false);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists broadcast_fpt_collection_change on public.collection_items;
create trigger broadcast_fpt_collection_change after insert or update or delete on public.collection_items
for each statement execute function public.broadcast_collection_change();

/* Firma esplicita legacy: mantenuta commentata come riferimento.
revoke all on function public.list_my_collection(text), public.list_team_collection(text),
  public.save_collection_item(text,uuid,text,text,text,text,text,text,text,text,text,text,integer,text),
  public.delete_collection_item(text,uuid), public.create_team_loans(text,jsonb,text,text,text),
  public.transition_loan(text,uuid,text) from public;
grant execute on function public.list_my_collection(text), public.list_team_collection(text),
  public.save_collection_item(text,uuid,text,text,text,text,text,text,text,text,text,text,text,integer,text),
  public.delete_collection_item(text,uuid), public.create_team_loans(text,jsonb,text,text,text),
  public.transition_loan(text,uuid,text) to anon, authenticated;

*/

revoke all on function public.list_my_collection(text), public.list_team_collection(text),
  public.delete_collection_item(text,uuid), public.create_team_loans(text,jsonb,text,text,text),
  public.transition_loan(text,uuid,text) from public;
grant execute on function public.list_my_collection(text), public.list_team_collection(text),
  public.delete_collection_item(text,uuid), public.create_team_loans(text,jsonb,text,text,text),
  public.transition_loan(text,uuid,text) to anon, authenticated;

-- Risolve la firma dall'OID appena creato: evita errori di conteggio dei numerosi
-- parametri nei comandi REVOKE/GRANT e resta sicuro in presenza di vecchi overload.
do $permissions$
declare target_function regprocedure; old_function regprocedure;
begin
  select p.oid::regprocedure into target_function
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'save_collection_item'
    and p.pronargs = 14
    and p.proargnames = array[
      'p_token','p_id','p_game','p_catalog_card_id','p_card_name','p_set_code','p_set_name',
      'p_rarity','p_language','p_condition','p_edition','p_image_url',
      'p_quantity_owned','p_quantity_mode'
    ]::text[];

  if target_function is null then
    raise exception 'RPC save_collection_item appena creata non trovata';
  end if;

  for old_function in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'save_collection_item'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', old_function);
  end loop;

  execute format('grant execute on function %s to anon, authenticated', target_function);
end;
$permissions$;

notify pgrst, 'reload schema';
