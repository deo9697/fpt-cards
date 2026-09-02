\set ON_ERROR_STOP on

drop schema if exists public cascade;
create schema public;
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres, service_role;

create table public.team_members (
  slug text primary key,
  full_name text not null
);

create or replace function public.session_member(p_token text)
returns text language sql stable security definer set search_path=public as $$
  select case when p_token='mw1-local-session-token-000000000000' then 'daniele' end
$$;
revoke all on function public.session_member(text) from public,anon,authenticated;

create table public.card_printings (
  id uuid primary key default gen_random_uuid(),
  game text not null,
  catalog_card_id text not null,
  card_name text not null,
  set_code text not null default '',
  set_name text not null default '',
  rarity text not null default '',
  image_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(game,catalog_card_id,set_code,rarity)
);

create table public.collection_items (
  id uuid primary key default gen_random_uuid(),
  owner_slug text not null references public.team_members(slug),
  printing_id uuid not null references public.card_printings(id),
  language text not null default 'Italiano',
  condition text not null default 'Near Mint',
  edition text not null default '',
  quantity_owned integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_slug,printing_id,language,condition,edition)
);

create table public.decks (
  id uuid primary key default gen_random_uuid(),
  owner_slug text not null references public.team_members(slug),
  game text not null,
  name text not null,
  format text not null default 'TCG Avanzato',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.deck_cards (
  deck_id uuid not null references public.decks(id) on delete cascade,
  catalog_card_id text not null,
  card_name text not null,
  image_url text not null default '',
  ban_tcg text not null default '',
  section text not null,
  quantity integer not null,
  primary key(deck_id,catalog_card_id,section)
);

insert into public.team_members(slug,full_name) values ('daniele','Daniele locale');
