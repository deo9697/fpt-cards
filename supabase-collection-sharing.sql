-- F.P.T Cards — Condivisione raccolta con link pubblico + richieste "Sono interessato".
-- Migration additiva: non modifica dati esistenti. Eseguire dopo
-- supabase-milestone-2-collection.sql e supabase-notifications-center.sql
-- (quest'ultima serve solo per le notifiche push in arrivo, è già additiva
-- e opzionale — se non è stata applicata questa migration funziona lo
-- stesso, semplicemente non genera la notifica push).
--
-- Unica parte del sistema pensata per essere raggiunta SENZA login: chi ha
-- il link (collection_shares.id, un uuid non indovinabile) vede una vista
-- di sola lettura della raccolta di UNA persona per UN gioco — mai altri
-- membri del team, prestiti o dati sensibili — e può mandare una richiesta
-- con le carte che gli interessano. Le funzioni pubbliche validano sempre
-- il token e limitano dimensione/contenuto di quello che accettano in
-- scrittura, dato che chiunque su internet può chiamarle.

create table if not exists public.collection_shares (
  id uuid primary key default gen_random_uuid(),
  owner_slug text not null references public.team_members(slug) on delete cascade,
  game text not null check (game in ('yugioh','onepiece')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists collection_shares_owner_idx on public.collection_shares(owner_slug);
-- No uniqueness on (owner_slug, game): regenerating a link must mint a
-- genuinely new id, not reactivate the same one — otherwise revoking then
-- "regenerating" would just clear revoked_at on the SAME row and the old,
-- supposedly-dead link would start working again for whoever still has it.
create unique index if not exists collection_shares_one_active_idx
  on public.collection_shares(owner_slug, game) where revoked_at is null;

create table if not exists public.collection_share_requests (
  id uuid primary key default gen_random_uuid(),
  share_id uuid not null references public.collection_shares(id) on delete cascade,
  requester_name text not null check (char_length(trim(requester_name)) between 1 and 80),
  status text not null default 'pending' check (status in ('pending','seen')),
  created_at timestamptz not null default now()
);
create index if not exists collection_share_requests_share_idx on public.collection_share_requests(share_id);

create table if not exists public.collection_share_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.collection_share_requests(id) on delete cascade,
  printing_id uuid not null references public.card_printings(id),
  quantity integer not null check (quantity between 1 and 99)
);
create index if not exists collection_share_request_items_request_idx on public.collection_share_request_items(request_id);

alter table public.collection_shares enable row level security;
alter table public.collection_share_requests enable row level security;
alter table public.collection_share_request_items enable row level security;
revoke all on public.collection_shares, public.collection_share_requests, public.collection_share_request_items
  from public, anon, authenticated;

-- Il centro notifiche (se applicato) ammette solo 'market_alert','loan','system'.
do $$ begin
  alter table public.notifications drop constraint if exists notifications_category_check;
  alter table public.notifications add constraint notifications_category_check
    check (category in ('market_alert','loan','system','share_request'));
exception when undefined_table then null;
end $$;

-- Proprietario: crea o riusa il link attivo per game (un solo link per game,
-- rigenerarlo revoca il precedente così i vecchi link smettono di funzionare).
create or replace function public.create_collection_share(p_token text, p_game text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); share_id uuid;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') then raise exception 'Gioco non valido'; end if;
  -- Revoke any existing active link first: a fresh insert always mints a
  -- genuinely new random id, so an old link a viewer might still have
  -- actually stops working instead of quietly reactivating.
  update public.collection_shares set revoked_at = now()
    where owner_slug = me and game = p_game and revoked_at is null;
  insert into public.collection_shares(owner_slug, game) values (me, p_game) returning id into share_id;
  return share_id;
end;
$$;

create or replace function public.revoke_collection_share(p_token text, p_share_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  update public.collection_shares set revoked_at = now()
    where id = p_share_id and owner_slug = me and revoked_at is null;
end;
$$;

create or replace function public.list_collection_shares(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'game', game, 'createdAt', created_at, 'active', revoked_at is null
  ) order by created_at desc), '[]'::jsonb) into result
  from public.collection_shares where owner_slug = me;
  return result;
end;
$$;

-- Ospite (nessuna sessione): solo i campi che servono per sfogliare e scegliere.
create or replace function public.get_collection_share(p_share_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare share public.collection_shares; owner_name text; items jsonb;
begin
  select * into share from public.collection_shares where id = p_share_id and revoked_at is null;
  if not found then raise exception 'Link non valido o revocato'; end if;
  select full_name into owner_name from public.team_members where slug = share.owner_slug;
  select coalesce(jsonb_agg(jsonb_build_object(
    'printingId', p.id, 'cardName', p.card_name, 'setCode', p.set_code, 'setName', p.set_name,
    'rarity', p.rarity, 'imageUrl', p.image_url, 'quantityOwned', totals.quantity
  ) order by p.card_name), '[]'::jsonb) into items
  from (
    select ci.printing_id, sum(ci.quantity_owned)::integer quantity
    from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
    where ci.owner_slug = share.owner_slug and cp.game = share.game
    group by ci.printing_id
  ) totals join public.card_printings p on p.id = totals.printing_id;
  return jsonb_build_object('ownerName', coalesce(owner_name,'Un membro del team'), 'game', share.game, 'items', items);
end;
$$;

-- Ospite (nessuna sessione): invia la richiesta. p_items è un array di
-- {"printingId":"...","quantity":N} — validato riga per riga, non ci si fida
-- di nessun dato in arrivo da qui.
create or replace function public.submit_collection_share_request(p_share_id uuid, p_requester_name text, p_items jsonb)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare share public.collection_shares; request_id uuid; item jsonb; valid_count integer := 0;
begin
  select * into share from public.collection_shares where id = p_share_id and revoked_at is null;
  if not found then raise exception 'Link non valido o revocato'; end if;
  if coalesce(trim(p_requester_name), '') = '' then raise exception 'Nome mancante'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 50 then
    raise exception 'Numero di carte richieste non valido';
  end if;

  insert into public.collection_share_requests(share_id, requester_name)
    values (share.id, left(trim(p_requester_name), 80)) returning id into request_id;

  for item in select * from jsonb_array_elements(p_items) loop
    if not exists (
      select 1 from public.collection_items ci
      where ci.owner_slug = share.owner_slug and ci.printing_id = (item->>'printingId')::uuid
    ) then continue; end if;
    insert into public.collection_share_request_items(request_id, printing_id, quantity)
      values (request_id, (item->>'printingId')::uuid, greatest(1, least(99, coalesce((item->>'quantity')::integer, 1))));
    valid_count := valid_count + 1;
  end loop;

  if valid_count = 0 then raise exception 'Nessuna carta valida nella richiesta'; end if;

  -- notifications only exists if supabase-notifications-center.sql has been
  -- applied — it's optional, so don't let a missing table fail the request.
  begin
    insert into public.notifications(member_slug, category, title, body, route_page, route_params, dedup_key, source_table, source_id)
    values (
      share.owner_slug, 'share_request', 'Nuova richiesta dalla tua raccolta',
      left(trim(p_requester_name), 80) || ' è interessato a ' || valid_count || ' cart' || (case when valid_count = 1 then 'a' else 'e' end),
      'requests', jsonb_build_object('requestId', request_id), 'share_request:' || request_id,
      'collection_share_requests', request_id
    )
    on conflict (member_slug, dedup_key) do nothing;
  exception when undefined_table then null;
  end;

  return request_id;
end;
$$;

-- Proprietario: le richieste ricevute su tutti i suoi link, con le carte.
create or replace function public.list_collection_share_requests(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'requesterName', r.requester_name, 'status', r.status, 'createdAt', r.created_at, 'game', s.game,
    'items', (
      select jsonb_agg(jsonb_build_object(
        'printingId', p.id, 'cardName', p.card_name, 'setCode', p.set_code, 'rarity', p.rarity,
        'imageUrl', p.image_url, 'quantity', i.quantity
      ))
      from public.collection_share_request_items i join public.card_printings p on p.id = i.printing_id
      where i.request_id = r.id
    )
  ) order by r.created_at desc), '[]'::jsonb) into result
  from public.collection_share_requests r join public.collection_shares s on s.id = r.share_id
  where s.owner_slug = me;
  return result;
end;
$$;

create or replace function public.mark_collection_share_request_seen(p_token text, p_request_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  update public.collection_share_requests r set status = 'seen'
    from public.collection_shares s
    where r.id = p_request_id and r.share_id = s.id and s.owner_slug = me;
end;
$$;

revoke all on function
  public.create_collection_share(text,text), public.revoke_collection_share(text,uuid),
  public.list_collection_shares(text), public.get_collection_share(uuid),
  public.submit_collection_share_request(uuid,text,jsonb),
  public.list_collection_share_requests(text), public.mark_collection_share_request_seen(text,uuid)
  from public, anon, authenticated;

grant execute on function
  public.create_collection_share(text,text), public.revoke_collection_share(text,uuid),
  public.list_collection_shares(text), public.list_collection_share_requests(text),
  public.mark_collection_share_request_seen(text,uuid)
  to authenticated;

-- Le uniche due funzioni raggiungibili senza login: la vista del link e
-- l'invio della richiesta. Tutto il resto dell'app resta dietro sessione.
grant execute on function
  public.get_collection_share(uuid), public.submit_collection_share_request(uuid,text,jsonb)
  to anon, authenticated;

notify pgrst, 'reload schema';
