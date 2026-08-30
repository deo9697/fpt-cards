-- F.P.T Cards — Milestone 4: mazzi personali e integrazione disponibilità team.
-- Migrazione additiva: eseguire dopo supabase-milestone-2-1-collection-loans.sql.

create table if not exists public.decks (
  id uuid primary key default gen_random_uuid(),
  owner_slug text not null references public.team_members(slug) on delete cascade,
  game text not null check (game in ('yugioh','onepiece')),
  name text not null check (char_length(trim(name)) between 1 and 80),
  format text not null default 'TCG Avanzato' check (char_length(format) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.deck_cards (
  deck_id uuid not null references public.decks(id) on delete cascade,
  catalog_card_id text not null check (char_length(trim(catalog_card_id)) between 1 and 100),
  card_name text not null check (char_length(trim(card_name)) between 1 and 200),
  image_url text not null default '' check (char_length(image_url) <= 500),
  ban_tcg text not null default '',
  section text not null check (section in ('main','extra','side')),
  quantity integer not null check (quantity between 1 and 99),
  primary key (deck_id,catalog_card_id,section)
);

alter table public.deck_cards add column if not exists ban_tcg text not null default '';
do $$ begin
  if not exists(select 1 from pg_constraint where conname='deck_cards_ban_tcg_check' and conrelid='public.deck_cards'::regclass) then
    alter table public.deck_cards add constraint deck_cards_ban_tcg_check check (ban_tcg in ('','limited','semi-limited','forbidden'));
  end if;
end $$;

create index if not exists decks_owner_game_idx on public.decks(owner_slug,game,updated_at desc);
alter table public.decks enable row level security;
alter table public.deck_cards enable row level security;
revoke all on public.decks,public.deck_cards from public,anon,authenticated;

create or replace function public.touch_deck_updated_at()
returns trigger language plpgsql set search_path=public as $$
begin new.updated_at=now(); return new; end;
$$;
drop trigger if exists touch_decks_updated_at on public.decks;
create trigger touch_decks_updated_at before update on public.decks
for each row execute function public.touch_deck_updated_at();

create or replace function public.list_my_decks(p_token text)
returns table(id uuid,owner_slug text,game text,name text,format text,cover_image_url text,cards jsonb,created_at timestamptz,updated_at timestamptz)
language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select d.id,d.owner_slug,d.game,d.name,d.format,
    coalesce((select dc.image_url from public.deck_cards dc where dc.deck_id=d.id and dc.image_url<>'' order by case dc.section when 'main' then 0 when 'extra' then 1 else 2 end limit 1),'') as cover_image_url,
    coalesce((select jsonb_agg(jsonb_build_object('catalog_card_id',dc.catalog_card_id,'card_name',dc.card_name,'image_url',dc.image_url,'ban_tcg',dc.ban_tcg,'section',dc.section,'quantity',dc.quantity) order by dc.section,dc.card_name) from public.deck_cards dc where dc.deck_id=d.id),'[]'::jsonb) as cards,
    d.created_at,d.updated_at from public.decks d where d.owner_slug=me order by d.updated_at desc;
end;
$$;

create or replace function public.save_deck(p_token text,p_deck jsonb)
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token); target uuid; payload jsonb:=coalesce(p_deck->'cards','[]'::jsonb); card jsonb; total integer:=0;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if jsonb_typeof(payload)<>'array' or jsonb_array_length(payload)>200 then raise exception 'Lista mazzo non valida'; end if;
  if char_length(trim(coalesce(p_deck->>'name','')))=0 then raise exception 'Nome mazzo richiesto'; end if;
  if nullif(p_deck->>'id','') is not null then
    begin target:=(p_deck->>'id')::uuid; exception when invalid_text_representation then target:=null; end;
  end if;
  if target is not null and not exists(select 1 from public.decks where id=target and owner_slug=me) then raise exception 'Mazzo non trovato o non modificabile'; end if;
  if target is null then
    insert into public.decks(owner_slug,game,name,format) values(me,coalesce(nullif(p_deck->>'game',''),'yugioh'),left(trim(p_deck->>'name'),80),left(coalesce(nullif(trim(p_deck->>'format'),''),'TCG Avanzato'),80)) returning id into target;
  else
    update public.decks set game=coalesce(nullif(p_deck->>'game',''),'yugioh'),name=left(trim(p_deck->>'name'),80),format=left(coalesce(nullif(trim(p_deck->>'format'),''),'TCG Avanzato'),80) where id=target;
    delete from public.deck_cards where deck_id=target;
  end if;
  for card in select value from jsonb_array_elements(payload) loop
    total:=total+coalesce((card->>'quantity')::integer,0);
    if total>200 or coalesce((card->>'quantity')::integer,0) not between 1 and 99 or coalesce(card->>'section','') not in ('main','extra','side') then raise exception 'Carta o quantità mazzo non valida'; end if;
    insert into public.deck_cards(deck_id,catalog_card_id,card_name,image_url,ban_tcg,section,quantity)
      values(target,left(trim(card->>'catalogCardId'),100),left(trim(card->>'cardName'),200),left(coalesce(card->>'imageUrl',''),500),case lower(coalesce(card->>'banTcg','')) when 'limited' then 'limited' when 'semi-limited' then 'semi-limited' when 'forbidden' then 'forbidden' else '' end,card->>'section',(card->>'quantity')::integer)
      on conflict(deck_id,catalog_card_id,section) do update set quantity=excluded.quantity,card_name=excluded.card_name,image_url=excluded.image_url,ban_tcg=excluded.ban_tcg;
  end loop;
  return target;
end;
$$;

create or replace function public.delete_deck(p_token text,p_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  delete from public.decks where id=p_id and owner_slug=me;
  if not found then raise exception 'Mazzo non trovato o non modificabile'; end if;
end;
$$;

revoke all on function public.list_my_decks(text),public.save_deck(text,jsonb),public.delete_deck(text,uuid) from public,anon,authenticated;
grant execute on function public.list_my_decks(text),public.save_deck(text,jsonb),public.delete_deck(text,uuid) to anon,authenticated;
notify pgrst,'reload schema';
