-- Fixture minima per supabase/tests/beta-teams-assertions.sql: tabelle essenziali + stub di realtime.send.
do $$ begin create role anon; exception when duplicate_object then null; end $$; do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
create schema extensions; create extension pgcrypto with schema extensions;
create schema realtime;
create table realtime.sent(payload jsonb, event text, topic text);
create function realtime.send(p jsonb, e text, t text, priv boolean) returns void language sql as $$ insert into realtime.sent values(p,e,t) $$;
create table public.team_members(slug text primary key, full_name text not null, user_id uuid, role text not null default 'guest', pin_hash text, active boolean not null default true, can_verify_ygo_artwork boolean default false);
-- `teams` come la crea 20260919100000_user_architecture_profiles_teams (stato di produzione: la sola riga fpt).
create table public.teams(id uuid primary key default gen_random_uuid(), slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 40), name text not null check (char_length(btrim(name)) between 1 and 80), owner_user_id uuid, active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create unique index teams_slug_lower_uidx on public.teams(lower(slug));
alter table public.teams enable row level security;
grant select on public.teams to authenticated;
insert into public.teams(slug, name) values ('fpt', 'F.P.T');
create table public.app_sessions(token_hash bytea primary key, member_slug text not null references public.team_members(slug) on delete cascade, expires_at timestamptz not null, created_at timestamptz default now());
create table public.member_progression(member_slug text primary key references public.team_members(slug), total_xp int not null default 0, level int not null default 1, active_title text not null default '', active_avatar text, updated_at timestamptz default now());
create table public.card_printings(id uuid primary key default gen_random_uuid(), game text default 'yugioh', catalog_card_id text, card_name text, set_code text, set_name text, rarity text, image_url text, variant_id text, game_metadata jsonb);
create table public.collection_items(id uuid primary key default gen_random_uuid(), owner_slug text references public.team_members(slug), printing_id uuid references public.card_printings(id), language text, condition text, edition text, quantity_owned int default 1, updated_at timestamptz default now());
create table public.loans(id uuid primary key default gen_random_uuid(), card_name text, quantity int default 1, owner_slug text references public.team_members(slug), borrower_slug text references public.team_members(slug), status text default 'pending', game text default 'yugioh', collection_item_id uuid, card_external_id text, accepted_quantity int, returned_quantity int default 0, created_at timestamptz default now());
create table public.decks(id uuid primary key default gen_random_uuid(), owner_slug text, game text default 'yugioh', name text, format text, signature_card_id text, deck_theme text, deck_box_template text, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.deck_cards(deck_id uuid, catalog_card_id text, card_name text, image_url text, ban_tcg text, section text, quantity int, printing_id uuid, position int);
create table public.matches(id uuid primary key default gen_random_uuid(), member_slug text, game text default 'yugioh', deck_id uuid, result text, opponent_member_slug text, played_at timestamptz default now());
create function public.broadcast_collection_change() returns trigger language plpgsql security definer set search_path = public, realtime as $$
begin perform realtime.send(jsonb_build_object('changed', true), 'collection_changed', 'fpt-collection', false); if tg_op = 'DELETE' then return old; end if; return new; end; $$;
create trigger broadcast_fpt_collection_change after insert or update or delete on public.collection_items for each statement execute function public.broadcast_collection_change();
create function public.broadcast_loan_change() returns trigger language plpgsql as $$ begin perform realtime.send('{}','loans_changed','fpt-loans',false); return new; end $$;
create trigger broadcast_fpt_loan_change after insert or update or delete on public.loans for each row execute function public.broadcast_loan_change();
insert into public.team_members(slug,full_name,role,pin_hash) values ('daniele','Daniele','admin',extensions.crypt('1111',extensions.gen_salt('bf',4))),('cristofer','Cristofer','guest',null);
insert into public.member_progression(member_slug) values ('daniele'),('cristofer');
-- Definizioni repository delle RPC patchate (estratte dalla versione più recente nei file SQL).
create or replace function public.session_member(p_token text)
returns text language sql stable security definer set search_path = public, extensions as $$
  select member_slug from public.app_sessions
  where token_hash = digest(p_token, 'sha256') and expires_at > now()
$$;

create or replace function public.list_login_members()
returns table(slug text, full_name text, role text)
language sql stable security definer set search_path = public as $$
  select m.slug, m.full_name, m.role from public.team_members m
  where m.active order by (m.role = 'admin') desc, m.full_name
$$;

create or replace function public.list_member_profiles(p_token text)
returns table(member_slug text, active_avatar text, active_title text, level integer)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select mp.member_slug, coalesce(mp.active_avatar, ''), coalesce(mp.active_title, ''), mp.level
  from public.member_progression mp
  join public.team_members tm on tm.slug = mp.member_slug and tm.active;
end;
$$;

create or replace function public.list_member_avatars(p_token text)
returns table(member_slug text, active_avatar text)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select mp.member_slug, coalesce(mp.active_avatar, '')
  from public.member_progression mp
  join public.team_members tm on tm.slug = mp.member_slug and tm.active;
end;
$$;

create function public.list_team_collection(p_token text)
returns table(
  id uuid, printing_id uuid, owner_slug text, owner_name text, game text,
  catalog_card_id text, card_name text, set_code text, set_name text, rarity text,
  language text, condition text, edition text, image_url text,
  quantity_loaned integer, quantity_reserved integer,
  quantity_physically_available integer, legacy_ambiguous boolean, updated_at timestamptz,
  variant_id text, game_metadata jsonb
) language plpgsql security definer set search_path=public,extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query
  with inventory as materialized (
    select ci.*,p.game,p.catalog_card_id,p.card_name,p.set_code,p.set_name,p.rarity,p.image_url,
      p.variant_id,p.game_metadata,m.full_name
    from public.collection_items ci join public.card_printings p on p.id=ci.printing_id
    join public.team_members m on m.slug=ci.owner_slug and m.active
  ), identity_counts as materialized (
    select source.id,source.owner_slug,source.game,source.catalog_card_id,lower(trim(source.card_name)) normalized_name,
      count(*) over(partition by source.owner_slug,source.game,source.catalog_card_id) catalog_count,
      count(*) over(partition by source.owner_slug,source.game,lower(trim(source.card_name))) name_count
    from inventory source
  ), commitments as materialized (
    select i.id,
      coalesce(sum(greatest(coalesce(l.accepted_quantity,l.quantity)-l.returned_quantity,0))
        filter(where l.status in ('active','return_pending') and (l.collection_item_id=i.id or
          (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count=1) or
          (nullif(trim(l.card_external_id),'') is null and c.name_count=1))),0)::integer loaned,
      coalesce(sum(greatest(coalesce(l.accepted_quantity,l.quantity)-l.returned_quantity,0))
        filter(where l.status='reserved' and (l.collection_item_id=i.id or
          (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count=1) or
          (nullif(trim(l.card_external_id),'') is null and c.name_count=1))),0)::integer reserved,
      coalesce(bool_or(l.collection_item_id is null and (
        (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count>1) or
        (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name))=lower(trim(i.card_name)) and c.name_count>1)
      )),false) legacy_ambiguous
    from inventory i join identity_counts c on c.id=i.id
    left join public.loans l on l.owner_slug=i.owner_slug and l.game=i.game
      and l.status in ('reserved','active','return_pending') and (
        l.collection_item_id=i.id or (l.collection_item_id is null and (
          nullif(trim(l.card_external_id),'')=i.catalog_card_id or
          (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name))=lower(trim(i.card_name)))
        ))
      )
    group by i.id
  )
  select i.id,i.printing_id,i.owner_slug,i.full_name,i.game,i.catalog_card_id,i.card_name,
    i.set_code,i.set_name,i.rarity,i.language,i.condition,i.edition,i.image_url,
    coalesce(c.loaned,0),coalesce(c.reserved,0),
    greatest(i.quantity_owned-coalesce(c.loaned,0)-coalesce(c.reserved,0),0),
    coalesce(c.legacy_ambiguous,false),i.updated_at,
    i.variant_id,i.game_metadata
  from inventory i left join commitments c on c.id=i.id
  order by i.card_name,i.full_name,i.set_code;
end;
$$;

create or replace function public.list_team_decks(p_token text)
returns table(
  id uuid, owner_slug text, owner_name text, game text, name text, format text,
  signature_card_id text, deck_theme text, deck_box_template text, cover_image_url text,
  cards jsonb, created_at timestamptz, updated_at timestamptz
)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select d.id, d.owner_slug, m.full_name, d.game, d.name, d.format,
    d.signature_card_id, d.deck_theme, d.deck_box_template,
    coalesce((select dc.image_url from public.deck_cards dc where dc.deck_id = d.id and dc.image_url <> '' and dc.section in ('main','extra')
      order by (dc.catalog_card_id = d.signature_card_id) desc, case dc.section when 'main' then 0 else 1 end, dc.position, dc.card_name limit 1), '') cover_image_url,
    coalesce((select jsonb_agg(jsonb_build_object(
      'catalog_card_id', dc.catalog_card_id, 'card_name', dc.card_name, 'image_url', dc.image_url,
      'ban_tcg', dc.ban_tcg, 'section', dc.section, 'quantity', dc.quantity, 'printing_id', dc.printing_id,
      'printing_set_code', (select cp.set_code from public.card_printings cp where cp.id = dc.printing_id),
      'printing_rarity', (select cp.rarity from public.card_printings cp where cp.id = dc.printing_id)
    ) order by dc.section, dc.position, dc.card_name) from public.deck_cards dc where dc.deck_id = d.id), '[]'::jsonb) cards,
    d.created_at, d.updated_at
  from public.decks d
  join public.team_members m on m.slug = d.owner_slug and m.active
  order by m.full_name, d.updated_at desc;
end;
$$;

create or replace function public.get_team_stats(p_token text, p_game text, p_period text default 'all')
returns table(member_slug text, member_name text, deck_id uuid, deck_name text, matches integer, wins integer, losses integer, draws integer, win_rate numeric)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); since timestamptz;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  since := case p_period when '7d' then now() - interval '7 days' when '30d' then now() - interval '30 days' else '-infinity'::timestamptz end;
  return query select m.member_slug, tm.full_name, d.id, d.name,
    count(*)::integer,
    count(*) filter (where m.result = 'win')::integer,
    count(*) filter (where m.result = 'loss')::integer,
    count(*) filter (where m.result = 'draw')::integer,
    round(count(*) filter (where m.result = 'win')::numeric / greatest(count(*), 1) * 100, 1)
  from public.matches m
  join public.decks d on d.id = m.deck_id
  join public.team_members tm on tm.slug = m.member_slug and tm.active
  where m.game = p_game and m.played_at >= since
  group by m.member_slug, tm.full_name, d.id, d.name
  order by tm.full_name, count(*) desc;
end;
$$;

create or replace function public.get_head_to_head(p_token text, p_game text, p_period text default 'all')
returns table(member_slug text, member_name text, opponent_slug text, opponent_name text, wins integer, losses integer, draws integer, matches integer)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); since timestamptz;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  since := case p_period when '7d' then now() - interval '7 days' when '30d' then now() - interval '30 days' else '-infinity'::timestamptz end;
  return query select m.member_slug, tm.full_name, m.opponent_member_slug, tom.full_name,
    count(*) filter (where m.result = 'win')::integer,
    count(*) filter (where m.result = 'loss')::integer,
    count(*) filter (where m.result = 'draw')::integer,
    count(*)::integer
  from public.matches m
  join public.team_members tm on tm.slug = m.member_slug and tm.active
  join public.team_members tom on tom.slug = m.opponent_member_slug and tom.active
  where m.game = p_game and m.played_at >= since and m.opponent_member_slug is not null
  group by m.member_slug, tm.full_name, m.opponent_member_slug, tom.full_name
  order by tm.full_name, tom.full_name;
end;
$$;

create or replace function public.list_team_loans(p_token text)
returns setof public.loans language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); admin boolean;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  return query select l.* from public.loans l
    where admin or l.owner_slug = me or l.borrower_slug = me order by l.created_at;
end;
$$;