-- F.P.T Cards — Milestone 5: Market Watch Core.
-- MIGRAZIONE ADDITIVA NON APPLICATA AUTOMATICAMENTE.
-- Eseguire soltanto dopo supabase-milestone-4-decks.sql.

alter table public.deck_cards add column if not exists printing_id uuid;
do $$ begin
  alter table public.deck_cards add constraint deck_cards_printing_id_fkey
    foreign key (printing_id) references public.card_printings(id) on delete set null;
exception when duplicate_object then null;
end $$;
create index if not exists deck_cards_printing_idx on public.deck_cards(printing_id) where printing_id is not null;

create table if not exists public.market_provider_printings (
  id uuid primary key default gen_random_uuid(),
  printing_id uuid not null references public.card_printings(id) on delete cascade,
  provider text not null check (provider in ('cardtrader','cardmarket')),
  provider_product_id text,
  provider_blueprint_id text,
  provider_expansion_id text,
  variant_key text not null default 'default',
  language text not null default '',
  condition_reference text not null default 'Near Mint',
  foil boolean,
  edition text not null default '',
  provider_metadata jsonb not null default '{}'::jsonb,
  resolution_status text not null default 'unresolved'
    check (resolution_status in ('resolved','ambiguous','unresolved','manual')),
  confidence numeric(5,4) not null default 0 check (confidence between 0 and 1),
  resolved_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (printing_id, provider, variant_key),
  check (provider <> 'cardtrader' or provider_product_id is null),
  check (provider <> 'cardtrader' or resolution_status not in ('resolved','manual') or provider_blueprint_id is not null)
);
create index if not exists market_provider_printings_provider_idx
  on public.market_provider_printings(provider,resolution_status,printing_id);
create unique index if not exists market_provider_blueprint_variant_uidx
  on public.market_provider_printings(provider,provider_blueprint_id,variant_key)
  where provider_blueprint_id is not null and resolution_status in ('resolved','manual');

create table if not exists public.market_price_snapshots (
  id uuid primary key default gen_random_uuid(),
  printing_id uuid not null references public.card_printings(id) on delete cascade,
  provider_mapping_id uuid references public.market_provider_printings(id) on delete set null,
  provider text not null check (provider in ('cardtrader','cardmarket')),
  price_type text not null check (price_type in (
    'lowest','reference','low','trend','average','avg1','avg7','avg30',
    'foil_low','foil_trend','foil_average','foil_avg1','foil_avg7','foil_avg30'
  )),
  original_currency text not null check (char_length(original_currency)=3),
  original_price numeric(14,4) not null check (original_price >= 0),
  normalized_currency text not null default 'EUR' check (char_length(normalized_currency)=3),
  normalized_price numeric(14,4),
  fx_rate numeric(18,8),
  fx_source text,
  fx_date date,
  language text not null default '',
  condition_reference text not null default '',
  foil boolean,
  available_quantity integer check (available_quantity is null or available_quantity >= 0),
  sample_size integer check (sample_size is null or sample_size >= 0),
  source_updated_at timestamptz,
  captured_at timestamptz not null default now(),
  observation_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  unique (provider,observation_key,price_type)
);
create index if not exists market_snapshots_latest_idx
  on public.market_price_snapshots(printing_id,provider,price_type,captured_at desc);
create index if not exists market_snapshots_history_idx
  on public.market_price_snapshots(printing_id,captured_at desc);

create table if not exists public.market_watch_items (
  id uuid primary key default gen_random_uuid(),
  member_slug text not null references public.team_members(slug) on delete cascade,
  printing_id uuid not null references public.card_printings(id) on delete cascade,
  source_type text not null default 'manual' check (source_type='manual'),
  created_at timestamptz not null default now(),
  unique (member_slug,printing_id)
);
create index if not exists market_watch_member_idx on public.market_watch_items(member_slug,created_at desc);

create table if not exists public.market_alert_preferences (
  id uuid primary key default gen_random_uuid(),
  member_slug text not null references public.team_members(slug) on delete cascade,
  printing_id uuid references public.card_printings(id) on delete cascade,
  absolute_threshold numeric(14,4) not null default 1 check (absolute_threshold >= 0),
  percentage_threshold numeric(8,4) not null default 8 check (percentage_threshold >= 0),
  direction text not null default 'both' check (direction in ('up','down','both')),
  enabled boolean not null default true,
  cooldown interval not null default interval '24 hours' check (cooldown >= interval '1 hour'),
  last_notified_price numeric(14,4),
  last_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists market_alert_printing_uidx
  on public.market_alert_preferences(member_slug,printing_id) where printing_id is not null;
create unique index if not exists market_alert_default_uidx
  on public.market_alert_preferences(member_slug) where printing_id is null;

create table if not exists public.market_price_events (
  id uuid primary key default gen_random_uuid(),
  printing_id uuid not null references public.card_printings(id) on delete cascade,
  provider text not null check (provider in ('cardtrader','cardmarket')),
  previous_snapshot_id uuid not null references public.market_price_snapshots(id) on delete cascade,
  current_snapshot_id uuid not null references public.market_price_snapshots(id) on delete cascade,
  previous_price numeric(14,4) not null,
  current_price numeric(14,4) not null,
  absolute_change numeric(14,4) not null,
  percentage_change numeric(12,4),
  detected_at timestamptz not null default now(),
  unique (previous_snapshot_id,current_snapshot_id)
);
create index if not exists market_events_printing_idx on public.market_price_events(printing_id,detected_at desc);

create or replace function public.detect_market_price_event()
returns trigger language plpgsql set search_path=public as $$
declare previous market_price_snapshots;
begin
  if new.normalized_price is null then return new; end if;
  select * into previous from market_price_snapshots
    where printing_id=new.printing_id and provider=new.provider and price_type=new.price_type
      and normalized_price is not null and id<>new.id and captured_at<new.captured_at
    order by captured_at desc,id desc limit 1;
  if previous.id is null or previous.normalized_price=new.normalized_price then return new; end if;
  insert into market_price_events(printing_id,provider,previous_snapshot_id,current_snapshot_id,
    previous_price,current_price,absolute_change,percentage_change,detected_at)
  values(new.printing_id,new.provider,previous.id,new.id,previous.normalized_price,new.normalized_price,
    new.normalized_price-previous.normalized_price,
    case when previous.normalized_price=0 then null else ((new.normalized_price-previous.normalized_price)/previous.normalized_price)*100 end,
    new.captured_at)
  on conflict(previous_snapshot_id,current_snapshot_id) do nothing;
  return new;
end;
$$;
drop trigger if exists detect_market_price_event_after_insert on public.market_price_snapshots;
create trigger detect_market_price_event_after_insert after insert on public.market_price_snapshots
for each row execute function public.detect_market_price_event();

create table if not exists public.market_provider_sync_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('cardtrader','cardmarket','all')),
  status text not null default 'running' check (status in ('running','succeeded','partial','failed','skipped')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  last_success_at timestamptz,
  cursor_state jsonb not null default '{}'::jsonb,
  request_count integer not null default 0 check (request_count >= 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists market_sync_runs_latest_idx on public.market_provider_sync_runs(provider,started_at desc);
create unique index if not exists market_sync_one_running_uidx on public.market_provider_sync_runs(provider)
  where status='running';

alter table public.market_provider_printings enable row level security;
alter table public.market_price_snapshots enable row level security;
alter table public.market_watch_items enable row level security;
alter table public.market_alert_preferences enable row level security;
alter table public.market_price_events enable row level security;
alter table public.market_provider_sync_runs enable row level security;
revoke all on public.market_provider_printings,public.market_price_snapshots,
  public.market_watch_items,public.market_alert_preferences,public.market_price_events,
  public.market_provider_sync_runs from public,anon,authenticated;

create or replace view public.market_latest_prices
with (security_invoker=true) as
select distinct on (s.printing_id,s.provider,s.price_type)
  s.id,s.printing_id,s.provider_mapping_id,s.provider,s.price_type,
  s.original_currency,s.original_price,s.normalized_currency,s.normalized_price,
  s.language,s.condition_reference,s.foil,s.available_quantity,s.sample_size,
  s.source_updated_at,s.captured_at,s.metadata
from public.market_price_snapshots s
order by s.printing_id,s.provider,s.price_type,s.captured_at desc,s.id desc;
revoke all on public.market_latest_prices from public,anon,authenticated;

-- Owned e Deck sono derivati. Solo la watchlist manuale viene materializzata.
create or replace view public.market_monitored_printings
with (security_invoker=true) as
select ci.printing_id,'owned'::text source_type,ci.owner_slug member_slug,sum(ci.quantity_owned)::integer quantity
from public.collection_items ci group by ci.printing_id,ci.owner_slug
union all
select dc.printing_id,'deck'::text,d.owner_slug,sum(dc.quantity)::integer
from public.deck_cards dc join public.decks d on d.id=dc.deck_id
where dc.printing_id is not null group by dc.printing_id,d.owner_slug
union all
select mw.printing_id,'manual'::text,mw.member_slug,0
from public.market_watch_items mw;
revoke all on public.market_monitored_printings from public,anon,authenticated;

create or replace function public.market_reference_type(p_provider text,p_type text)
returns integer language sql immutable as $$
  select case
    when p_provider='cardmarket' and p_type='trend' then 1
    when p_provider='cardtrader' and p_type='reference' then 2
    when p_type in ('average','avg7') then 3
    when p_type in ('low','lowest') then 4 else 9 end;
$$;

create or replace function public.list_market_watch(p_token text,p_game text default 'yugioh')
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  with sources as (
    select ci.printing_id,'owned'::text source_type,sum(ci.quantity_owned)::integer quantity
      from collection_items ci join card_printings cp on cp.id=ci.printing_id
      where ci.owner_slug=me and cp.game=p_game group by ci.printing_id
    union all
    select dc.printing_id,'deck',sum(dc.quantity)::integer
      from deck_cards dc join decks d on d.id=dc.deck_id join card_printings cp on cp.id=dc.printing_id
      where d.owner_slug=me and cp.game=p_game and dc.printing_id is not null group by dc.printing_id
    union all
    select mw.printing_id,'manual',0 from market_watch_items mw join card_printings cp on cp.id=mw.printing_id
      where mw.member_slug=me and cp.game=p_game
  ), monitored as (
    select printing_id,array_agg(distinct source_type order by source_type) sources,
      max(quantity) filter(where source_type='owned') owned_quantity
    from sources group by printing_id
  ), preferred as (
    select distinct on (lp.printing_id,lp.provider) lp.*
    from market_latest_prices lp join monitored m on m.printing_id=lp.printing_id
    where lp.normalized_currency='EUR' and lp.normalized_price is not null
    order by lp.printing_id,lp.provider,market_reference_type(lp.provider,lp.price_type),lp.captured_at desc
  ), history as (
    select m.printing_id,
      (select s.normalized_price from market_price_snapshots s where s.printing_id=m.printing_id and s.normalized_price is not null and s.captured_at<=now()-interval '24 hours' order by market_reference_type(s.provider,s.price_type),s.captured_at desc limit 1) price_24h,
      (select s.normalized_price from market_price_snapshots s where s.printing_id=m.printing_id and s.normalized_price is not null and s.captured_at<=now()-interval '7 days' order by market_reference_type(s.provider,s.price_type),s.captured_at desc limit 1) price_7d
    from monitored m
  ), rows as (
    select cp.id printing_id,cp.catalog_card_id,cp.card_name,cp.set_code,cp.set_name,cp.rarity,cp.image_url,
      m.sources,coalesce(m.owned_quantity,0) owned_quantity,
      coalesce(jsonb_object_agg(p.provider,jsonb_build_object('price',p.normalized_price,'type',p.price_type,'currency',p.normalized_currency,'capturedAt',p.captured_at,'conditionReference',p.condition_reference)) filter(where p.provider is not null),'{}'::jsonb) providers,
      coalesce((select p2.normalized_price from preferred p2 where p2.printing_id=cp.id order by market_reference_type(p2.provider,p2.price_type) limit 1),null) reference_price,
      h.price_24h,h.price_7d,
      (select p3.captured_at from preferred p3 where p3.printing_id=cp.id order by market_reference_type(p3.provider,p3.price_type) limit 1) latest_at
    from monitored m join card_printings cp on cp.id=m.printing_id
    left join preferred p on p.printing_id=cp.id left join history h on h.printing_id=cp.id
    group by cp.id,m.sources,m.owned_quantity,h.price_24h,h.price_7d
  )
  select jsonb_build_object(
    'items',coalesce(jsonb_agg(to_jsonb(rows) order by card_name),'[]'::jsonb),
    'deckUnresolved',coalesce((select jsonb_agg(jsonb_build_object('deckId',d.id,'deckName',d.name,'catalogCardId',dc.catalog_card_id,'cardName',dc.card_name,'section',dc.section,'quantity',dc.quantity)) from deck_cards dc join decks d on d.id=dc.deck_id where d.owner_slug=me and d.game=p_game and dc.printing_id is null),'[]'::jsonb),
    'lastSync',coalesce((select max(finished_at) from market_provider_sync_runs where status in ('succeeded','partial')),null)
  ) into result from rows;
  return coalesce(result,jsonb_build_object('items','[]'::jsonb,'deckUnresolved','[]'::jsonb,'lastSync',null));
end;
$$;

create or replace function public.list_deck_printing_options(p_token text,p_deck_id uuid,p_catalog_card_id text)
returns table(printing_id uuid,set_code text,set_name text,rarity text,image_url text)
language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token); deck_game text;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select game into deck_game from decks where id=p_deck_id and owner_slug=me;
  if deck_game is null then raise exception 'Mazzo non trovato'; end if;
  return query select cp.id,cp.set_code,cp.set_name,cp.rarity,cp.image_url
    from card_printings cp where cp.game=deck_game and cp.catalog_card_id=p_catalog_card_id
    order by cp.set_code,cp.rarity,cp.id;
end;
$$;

create or replace function public.set_deck_card_printing(p_token text,p_deck_id uuid,p_catalog_card_id text,p_section text,p_printing_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if not exists(select 1 from decks d join deck_cards dc on dc.deck_id=d.id
    join card_printings cp on cp.id=p_printing_id
    where d.id=p_deck_id and d.owner_slug=me and dc.catalog_card_id=p_catalog_card_id
      and dc.section=p_section and cp.game=d.game and cp.catalog_card_id=dc.catalog_card_id) then
    raise exception 'Printing non valida per questa carta';
  end if;
  update deck_cards set printing_id=p_printing_id where deck_id=p_deck_id
    and catalog_card_id=p_catalog_card_id and section=p_section;
end;
$$;

create or replace function public.set_market_watch_item(p_token text,p_printing_id uuid,p_enabled boolean)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if not exists(select 1 from card_printings where id=p_printing_id) then raise exception 'Printing non valida'; end if;
  if p_enabled then insert into market_watch_items(member_slug,printing_id) values(me,p_printing_id) on conflict do nothing;
  else delete from market_watch_items where member_slug=me and printing_id=p_printing_id;
  end if;
end;
$$;

-- Estende le RPC Mazzi senza inferire printing per i record storici.
create or replace function public.list_my_decks(p_token text)
returns table(id uuid,owner_slug text,game text,name text,format text,cover_image_url text,cards jsonb,created_at timestamptz,updated_at timestamptz)
language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select d.id,d.owner_slug,d.game,d.name,d.format,
    coalesce((select dc.image_url from deck_cards dc where dc.deck_id=d.id and dc.image_url<>'' order by case dc.section when 'main' then 0 when 'extra' then 1 else 2 end limit 1),'') cover_image_url,
    coalesce((select jsonb_agg(jsonb_build_object(
      'catalog_card_id',dc.catalog_card_id,'card_name',dc.card_name,'image_url',dc.image_url,
      'ban_tcg',dc.ban_tcg,'section',dc.section,'quantity',dc.quantity,'printing_id',dc.printing_id,
      'printing_set_code',(select cp.set_code from card_printings cp where cp.id=dc.printing_id),
      'printing_rarity',(select cp.rarity from card_printings cp where cp.id=dc.printing_id)
    ) order by dc.section,dc.card_name) from deck_cards dc where dc.deck_id=d.id),'[]'::jsonb) cards,
    d.created_at,d.updated_at from decks d where d.owner_slug=me order by d.updated_at desc;
end;
$$;

create or replace function public.save_deck(p_token text,p_deck jsonb)
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token); target uuid; payload jsonb:=coalesce(p_deck->'cards','[]'::jsonb);
  card jsonb; total integer:=0; selected_printing uuid; deck_game text;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if jsonb_typeof(payload)<>'array' or jsonb_array_length(payload)>200 then raise exception 'Lista mazzo non valida'; end if;
  if char_length(trim(coalesce(p_deck->>'name','')))=0 then raise exception 'Nome mazzo richiesto'; end if;
  deck_game:=coalesce(nullif(p_deck->>'game',''),'yugioh');
  if nullif(p_deck->>'id','') is not null then
    begin target:=(p_deck->>'id')::uuid; exception when invalid_text_representation then target:=null; end;
  end if;
  if target is not null and not exists(select 1 from decks where id=target and owner_slug=me) then raise exception 'Mazzo non trovato o non modificabile'; end if;
  if target is null then
    insert into decks(owner_slug,game,name,format) values(me,deck_game,left(trim(p_deck->>'name'),80),left(coalesce(nullif(trim(p_deck->>'format'),''),'TCG Avanzato'),80)) returning id into target;
  else
    update decks set game=deck_game,name=left(trim(p_deck->>'name'),80),format=left(coalesce(nullif(trim(p_deck->>'format'),''),'TCG Avanzato'),80) where id=target;
    delete from deck_cards where deck_id=target;
  end if;
  for card in select value from jsonb_array_elements(payload) loop
    total:=total+coalesce((card->>'quantity')::integer,0);
    if total>200 or coalesce((card->>'quantity')::integer,0) not between 1 and 99 or coalesce(card->>'section','') not in ('main','extra','side') then raise exception 'Carta o quantità mazzo non valida'; end if;
    selected_printing:=null;
    if nullif(coalesce(card->>'printingId',card->>'printing_id'),'') is not null then
      begin selected_printing:=coalesce(card->>'printingId',card->>'printing_id')::uuid; exception when invalid_text_representation then raise exception 'Printing mazzo non valida'; end;
      if not exists(select 1 from card_printings cp where cp.id=selected_printing and cp.game=deck_game and cp.catalog_card_id=trim(card->>'catalogCardId')) then
        raise exception 'La printing selezionata non appartiene alla carta';
      end if;
    end if;
    insert into deck_cards(deck_id,catalog_card_id,card_name,image_url,ban_tcg,section,quantity,printing_id)
      values(target,left(trim(card->>'catalogCardId'),100),left(trim(card->>'cardName'),200),left(coalesce(card->>'imageUrl',''),500),
        case lower(coalesce(card->>'banTcg','')) when 'limited' then 'limited' when 'semi-limited' then 'semi-limited' when 'forbidden' then 'forbidden' else '' end,
        card->>'section',(card->>'quantity')::integer,selected_printing)
      on conflict(deck_id,catalog_card_id,section) do update set quantity=excluded.quantity,card_name=excluded.card_name,
        image_url=excluded.image_url,ban_tcg=excluded.ban_tcg,printing_id=excluded.printing_id;
  end loop;
  return target;
end;
$$;

-- Chiamate riservate alla Edge Function/service role.
create or replace function public.begin_market_provider_sync(p_provider text)
returns uuid language plpgsql security definer set search_path=public as $$
declare run_id uuid;
begin
  update market_provider_sync_runs set status='failed',finished_at=now(),error_code='stale_lock',error_message='Sync interrotta oltre due ore fa'
    where provider=p_provider and status='running' and started_at<now()-interval '2 hours';
  if exists(select 1 from market_provider_sync_runs where provider=p_provider and status='running') then return null; end if;
  begin
    insert into market_provider_sync_runs(provider) values(p_provider) returning id into run_id;
  exception when unique_violation then return null;
  end;
  return run_id;
end;
$$;

create or replace function public.market_sync_targets(p_provider text)
returns table(mapping_id uuid,printing_id uuid,game text,catalog_card_id text,card_name text,set_code text,set_name text,rarity text,
  provider_product_id text,provider_blueprint_id text,provider_expansion_id text,variant_key text,language text,condition_reference text,foil boolean,edition text,resolution_status text,provider_metadata jsonb)
language sql security definer set search_path=public as $$
  with monitored as (select distinct printing_id from market_monitored_printings)
  select mp.id,cp.id,cp.game,cp.catalog_card_id,cp.card_name,cp.set_code,cp.set_name,cp.rarity,
    mp.provider_product_id,mp.provider_blueprint_id,mp.provider_expansion_id,mp.variant_key,mp.language,
    mp.condition_reference,mp.foil,mp.edition,mp.resolution_status,mp.provider_metadata
  from monitored m join card_printings cp on cp.id=m.printing_id
  left join market_provider_printings mp on mp.printing_id=cp.id and mp.provider=p_provider;
$$;

revoke all on function public.begin_market_provider_sync(text),public.market_sync_targets(text) from public,anon,authenticated;
revoke all on function public.list_market_watch(text,text),public.list_deck_printing_options(text,uuid,text),
  public.set_deck_card_printing(text,uuid,text,text,uuid),public.set_market_watch_item(text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.begin_market_provider_sync(text),public.market_sync_targets(text) to service_role;
grant execute on function public.list_market_watch(text,text),public.list_deck_printing_options(text,uuid,text),
  public.set_deck_card_printing(text,uuid,text,text,uuid),public.set_market_watch_item(text,uuid,boolean) to anon,authenticated;
grant execute on function public.list_my_decks(text),public.save_deck(text,jsonb) to anon,authenticated;

-- Lo scheduler delle 03:00 Europe/Rome NON viene creato qui intenzionalmente.
-- Attivarlo solo dopo migration, secrets e collaudo della Edge Function.
