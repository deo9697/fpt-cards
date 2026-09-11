-- F.P.T Cards — Yu-Gi-Oh! Printing Registry.
--
-- Problema risolto: FPT usava YGOPRODeck (nome + set_code, o il primo elemento
-- di card_images[]) come fonte per CARD, PRINTING e ARTWORK insieme. Questo ha
-- prodotto associazioni sbagliate (es. LDS3-EN063 legato a "Number 15: Gimmick
-- Puppet Giant Grinder" invece di "Gimmick Puppet Bisque Doll") perché
-- l'ordine di card_images[] non corrisponde alla stampa specifica.
--
-- Questa migration introduce un registro canonico separato, indicizzato per
-- set_code (non per nome), che usa YGOResources (fonte primaria verificata
-- contro le vere API — vedi commenti sotto) per risolvere
-- set_code -> Konami card ID -> artwork, lasciando YGOPRODeck solo per
-- metadata di gioco (già la sua unica responsabilità nel resto del codice).
--
-- Additiva e conservativa: nessuna tabella esistente viene svuotata o
-- riscritta in massa. card_printings resta la tabella "operativa" referenziata
-- da collection_items/deck_cards/market_provider_printings; il nuovo registro
-- vive a fianco, chiave (game, set_code_normalized), e viene "specchiato" su
-- card_printings solo quando la risoluzione è affidabile (mai un guess).
--
-- Note tecniche verificate direttamente contro i servizi reali (non assunte):
--   * L'endpoint documentato da YGOResources (/data/meta/index/printcode) è
--     in realtà 404. Il vero endpoint, trovato leggendo il JS del loro sito
--     (db.ygoresources.com/js/cache.js, funzione GetPrintsForSet), è
--     GET /data/idx/printcode/<SET>-<LOCALE> (es. "LDS3-EN"), che risponde
--     {"063": 14598, ...}. Confermato: LDS3-EN063 -> Konami ID 14598 ->
--     "Gimmick Puppet Bisque Doll" (corretto).
--   * Il manifest artwork (artworks.ygoresources.com/manifest.json, ~21MB) NON
--     collega artwork_index a set_code — confermato leggendo il loro artwork.js
--     (scaricano l'intero manifest una volta e lo tengono in memoria) e
--     ispezionando manifestData.cards['4041'] (Dark Magician): 18 artwork
--     diversi, nessuna informazione su quale stampa usi quale indice. Per
--     questo scaricare l'intero manifest ad ogni scansione sarebbe sia
--     inutile (non risolve l'ambiguità) sia pessimo per le performance su
--     mobile: l'indice locale ygo_artwork_index viene invece popolato da uno
--     script di manutenzione periodico (scripts/ygo-artwork-index-sync.mjs)
--     che scarica il manifest una sola volta e salva solo il FATTO derivato
--     "questo Konami ID ha N artwork, e se N=1 qual è l'URL" — mai il blob.
--   * MIP-1010 non esiste né nell'indice printcode di YGOResources (testato
--     con tutte le combinazioni di locale) né in YGOPRODeck: è uno di quei set
--     code vecchi/regionali che nessuna fonte automatica indicizza (vedi
--     memoria "Fast Scan: speed over coverage"). Richiede l'override
--     documentato inserito più sotto.

begin;

-- 1) Normalizzazione canonica del set code — UNA sola implementazione SQL,
--    usata sia dalla colonna generata sotto sia da tutte le RPC del registro.
--    Il modulo JS del resolver (js/ygo-printing-registry.js) replica lo
--    stesso identico algoritmo affinché set_code_normalized coincida sempre
--    lato client e lato database.
create or replace function public.normalize_ygo_set_code(p_set_code text)
returns text language sql immutable set search_path = '' as $$
  select trim(both '-' from regexp_replace(upper(trim(coalesce($1, ''))), '[^A-Z0-9]+', '-', 'g'))
$$;

-- 2) card_printings: due colonne di sola lettura/mirror, non identity fields.
--    set_code_normalized è indicizzata (non unique qui: più rarità/varianti
--    possono condividere legittimamente lo stesso set_code fisico, il vincolo
--    di unicità reale vive su ygo_printing_registry, vedi punto 4).
alter table public.card_printings
  add column if not exists set_code_normalized text
    generated always as (public.normalize_ygo_set_code(set_code)) stored,
  add column if not exists printing_mapping_status text,
  add column if not exists printing_mapping_checked_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'card_printings_printing_mapping_status_check'
      and conrelid = 'public.card_printings'::regclass
  ) then
    alter table public.card_printings add constraint card_printings_printing_mapping_status_check
      check (printing_mapping_status is null
        or printing_mapping_status in ('verified', 'resolved', 'unresolved', 'conflict'));
  end if;
end $$;

create index if not exists card_printings_set_code_normalized_idx
  on public.card_printings(game, set_code_normalized) where set_code_normalized <> '';

-- 3) Cache locale e condivisa dell'indice print-code di YGOResources — evita
--    che ogni utente/scansione rifaccia la stessa richiesta remota per set
--    già visti (niente N+1 su un import di 200 carte: si deduplicano i
--    prefissi di set, non i singoli codici).
create table if not exists public.ygo_printcode_prefix_cache (
  set_prefix text primary key check (char_length(trim(set_prefix)) between 1 and 30),
  status text not null check (status in ('ok', 'not_found', 'error')),
  entry_count integer not null default 0 check (entry_count >= 0),
  error_message text,
  fetched_at timestamptz not null default now()
);

create table if not exists public.ygo_printcode_entries (
  set_prefix text not null references public.ygo_printcode_prefix_cache(set_prefix) on delete cascade,
  print_number text not null check (char_length(trim(print_number)) between 1 and 10),
  konami_card_id text not null check (char_length(trim(konami_card_id)) between 1 and 20),
  primary key (set_prefix, print_number)
);

alter table public.ygo_printcode_prefix_cache enable row level security;
alter table public.ygo_printcode_entries enable row level security;
revoke all on public.ygo_printcode_prefix_cache, public.ygo_printcode_entries from public, anon, authenticated;

-- 4) Registro canonico delle printing — CARD/PRINTING/ARTWORK identity,
--    indicizzato per set_code, indipendente dall'esistenza di una riga
--    card_printings (una scansione Fast Scan può risolvere una printing
--    prima ancora che l'utente decida di salvarla in collezione).
create table if not exists public.ygo_printing_registry (
  id uuid primary key default gen_random_uuid(),
  game text not null default 'yugioh' check (game = 'yugioh'),
  set_code text not null check (char_length(trim(set_code)) between 1 and 100),
  set_code_normalized text not null generated always as (public.normalize_ygo_set_code(set_code)) stored,
  konami_card_id text check (konami_card_id is null or char_length(trim(konami_card_id)) between 1 and 20),
  ygoprodeck_card_id text check (ygoprodeck_card_id is null or char_length(trim(ygoprodeck_card_id)) between 1 and 100),
  card_name text not null default '' check (char_length(card_name) <= 200),
  artwork_index text check (artwork_index is null or char_length(trim(artwork_index)) between 1 and 10),
  artwork_url text check (artwork_url is null or (artwork_url like 'https://%' and char_length(artwork_url) <= 500)),
  mapping_source text check (mapping_source is null or mapping_source in ('ygoresources', 'override', 'manual')),
  mapping_confidence text check (mapping_confidence is null or mapping_confidence in ('high', 'medium', 'low')),
  mapping_status text not null default 'unresolved'
    check (mapping_status in ('verified', 'resolved', 'unresolved', 'conflict')),
  mapping_notes text check (mapping_notes is null or char_length(mapping_notes) <= 1000),
  verified boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game, set_code_normalized)
);

create index if not exists ygo_printing_registry_status_idx
  on public.ygo_printing_registry(mapping_status);
create index if not exists ygo_printing_registry_konami_idx
  on public.ygo_printing_registry(konami_card_id) where konami_card_id is not null;

alter table public.ygo_printing_registry enable row level security;
revoke all on public.ygo_printing_registry from public, anon, authenticated;

create or replace function public.touch_ygo_printing_registry_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists touch_ygo_printing_registry_updated_at on public.ygo_printing_registry;
create trigger touch_ygo_printing_registry_updated_at before update on public.ygo_printing_registry
for each row execute function public.touch_ygo_printing_registry_updated_at();

-- 5) Override manuali — precedenza assoluta, mai riscritti da un resolver
--    automatico. Un override verificato risolve per sempre lo stesso
--    set_code_normalized senza richiedere una nuova patch SQL ad-hoc (sostituisce
--    il pattern supabase-fix-*.sql per i casi di identità carta/artwork).
create table if not exists public.ygo_printing_overrides (
  id uuid primary key default gen_random_uuid(),
  game text not null default 'yugioh' check (game = 'yugioh'),
  set_code text not null check (char_length(trim(set_code)) between 1 and 100),
  set_code_normalized text not null generated always as (public.normalize_ygo_set_code(set_code)) stored,
  konami_card_id text check (konami_card_id is null or char_length(trim(konami_card_id)) between 1 and 20),
  artwork_index text check (artwork_index is null or char_length(trim(artwork_index)) between 1 and 10),
  artwork_url text check (artwork_url is null or (artwork_url like 'https://%' and char_length(artwork_url) <= 500)),
  printing_id uuid references public.card_printings(id) on delete set null,
  reason text not null check (char_length(trim(reason)) between 1 and 500),
  created_by text references public.team_members(slug),
  verified boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game, set_code_normalized)
);

alter table public.ygo_printing_overrides enable row level security;
revoke all on public.ygo_printing_overrides from public, anon, authenticated;

drop trigger if exists touch_ygo_printing_overrides_updated_at on public.ygo_printing_overrides;
create trigger touch_ygo_printing_overrides_updated_at before update on public.ygo_printing_overrides
for each row execute function public.touch_ygo_printing_registry_updated_at();

-- Caso reale documentato: MIP-1010 non è indicizzato da nessuna fonte
-- automatica (verificato: 404 su YGOResources per ogni locale plausibile,
-- "No card matching" su YGOPRODeck). Identità confermata manualmente:
-- Hane-Hane, Konami/YGOResources card ID 4547 (db.ygoresources.com/data/card/4547
-- e indice nome "Hane-Hane":[4547] concordano). Card ad artwork singolo
-- (manifest: solo indice "1"), quindi anche l'artwork è deterministico.
insert into public.ygo_printing_overrides(
  game, set_code, konami_card_id, artwork_index, reason, verified
) values (
  'yugioh', 'MIP-1010', '4547', '1',
  'MIP-1010 non risulta in nessuna fonte automatica (YGOResources printcode index: not found per ogni locale; YGOPRODeck: nessun set MIP). Identità Hane-Hane confermata manualmente su db.ygoresources.com/data/card/4547.',
  true
)
on conflict (game, set_code_normalized) do nothing;

-- 6) Indice locale artwork — popolato da scripts/ygo-artwork-index-sync.mjs
--    (esecuzione periodica manuale, non dal client durante una scansione).
--    Contiene solo il FATTO derivato dal manifest YGOResources, mai il blob.
create table if not exists public.ygo_artwork_index (
  konami_card_id text primary key check (char_length(trim(konami_card_id)) between 1 and 20),
  artwork_count integer not null check (artwork_count >= 0),
  single_artwork_url text check (single_artwork_url is null or single_artwork_url like 'https://%'),
  synced_at timestamptz not null default now()
);

alter table public.ygo_artwork_index enable row level security;
revoke all on public.ygo_artwork_index from public, anon, authenticated;

-- 6bis) Lettura/scrittura batch dell'indice artwork sincronizzato — il
-- resolver la usa per decidere se un konami_card_id ha un artwork
-- deterministico (count=1) senza mai scaricare il manifest da 21MB lato
-- client; la scrittura è usata solo da scripts/ygo-artwork-index-sync.mjs.
create or replace function public.ygo_artwork_index_lookup(
  p_token text, p_konami_card_ids text[]
) returns table(
  konami_card_id text, artwork_count integer, single_artwork_url text, synced_at timestamptz
) language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); ids text[];
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_konami_card_ids is null or array_length(p_konami_card_ids, 1) is null
    or array_length(p_konami_card_ids, 1) > 500 then raise exception 'Elenco Konami ID non valido'; end if;
  select array_agg(distinct trim(item)) into ids
    from unnest(p_konami_card_ids) item where trim(coalesce(item, '')) <> '';
  if ids is null then return; end if;
  return query
    select a.konami_card_id, a.artwork_count, a.single_artwork_url, a.synced_at
    from public.ygo_artwork_index a where a.konami_card_id = any(ids);
end;
$$;

create or replace function public.ygo_artwork_index_upsert(
  p_token text, p_entries jsonb
) returns integer language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); entry jsonb; count_upserted integer := 0;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) not between 1 and 5000 then
    raise exception 'Voci indice artwork non valide'; end if;
  for entry in select value from jsonb_array_elements(p_entries) loop
    if char_length(trim(coalesce(entry->>'konamiCardId', ''))) between 1 and 20
      and (entry->>'artworkCount')::integer >= 0 then
      insert into public.ygo_artwork_index(konami_card_id, artwork_count, single_artwork_url, synced_at)
      values (trim(entry->>'konamiCardId'), (entry->>'artworkCount')::integer,
        nullif(trim(coalesce(entry->>'singleArtworkUrl', '')), ''), now())
      on conflict (konami_card_id) do update set
        artwork_count = excluded.artwork_count, single_artwork_url = excluded.single_artwork_url,
        synced_at = excluded.synced_at;
      count_upserted := count_upserted + 1;
    end if;
  end loop;
  return count_upserted;
end;
$$;

-- 7) RPC di lettura batch — il resolver chiede in UNA chiamata lo stato di N
--    set_code (registry + override), mai una chiamata per carta.
create or replace function public.ygo_printing_registry_lookup(
  p_token text, p_set_codes text[]
) returns table(
  set_code_normalized text, registry_konami_card_id text, registry_card_name text,
  registry_artwork_index text, registry_artwork_url text, registry_mapping_source text,
  registry_mapping_confidence text, registry_mapping_status text, registry_verified boolean,
  override_konami_card_id text, override_artwork_index text, override_artwork_url text,
  override_reason text
) language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); codes text[];
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_set_codes is null or array_length(p_set_codes, 1) is null
    or array_length(p_set_codes, 1) > 500 then raise exception 'Elenco set code non valido'; end if;
  select array_agg(distinct public.normalize_ygo_set_code(code)) into codes
    from unnest(p_set_codes) code where trim(coalesce(code, '')) <> '';
  if codes is null then return; end if;
  return query
    select c.code, r.konami_card_id, r.card_name, r.artwork_index, r.artwork_url,
      r.mapping_source, r.mapping_confidence, r.mapping_status, r.verified,
      o.konami_card_id, o.artwork_index, o.artwork_url, o.reason
    from unnest(codes) c(code)
    left join public.ygo_printing_registry r
      on r.game = 'yugioh' and r.set_code_normalized = c.code
    left join public.ygo_printing_overrides o
      on o.game = 'yugioh' and o.set_code_normalized = c.code;
end;
$$;

-- 8) RPC di lettura/scrittura cache print-code — batch per prefisso di set.
create or replace function public.ygo_printcode_cache_lookup(
  p_token text, p_prefixes text[]
) returns table(
  set_prefix text, status text, fetched_at timestamptz,
  print_number text, konami_card_id text
) language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); prefixes text[];
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_prefixes is null or array_length(p_prefixes, 1) is null
    or array_length(p_prefixes, 1) > 200 then raise exception 'Elenco prefissi non valido'; end if;
  select array_agg(distinct upper(trim(prefix))) into prefixes
    from unnest(p_prefixes) prefix where trim(coalesce(prefix, '')) <> '';
  if prefixes is null then return; end if;
  return query
    select pc.set_prefix, pc.status, pc.fetched_at, e.print_number, e.konami_card_id
    from public.ygo_printcode_prefix_cache pc
    left join public.ygo_printcode_entries e on e.set_prefix = pc.set_prefix
    where pc.set_prefix = any(prefixes);
end;
$$;

create or replace function public.ygo_printcode_cache_upsert(
  p_token text, p_prefix text, p_status text, p_entries jsonb default '[]'::jsonb
) returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); prefix text := upper(trim(coalesce(p_prefix, '')));
  entry jsonb; count_inserted integer := 0;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if char_length(prefix) not between 1 and 30 then raise exception 'Prefisso set non valido'; end if;
  if p_status not in ('ok', 'not_found', 'error') then raise exception 'Stato cache non valido'; end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 500 then
    raise exception 'Voci cache non valide'; end if;

  insert into public.ygo_printcode_prefix_cache(set_prefix, status, entry_count, error_message, fetched_at)
  values (prefix, p_status, jsonb_array_length(p_entries),
    case when p_status = 'error' then left(coalesce(p_entries->>0, ''), 300) else null end, now())
  on conflict (set_prefix) do update set
    status = excluded.status, entry_count = excluded.entry_count,
    error_message = excluded.error_message, fetched_at = excluded.fetched_at;

  delete from public.ygo_printcode_entries where set_prefix = prefix;
  for entry in select value from jsonb_array_elements(p_entries) loop
    if char_length(trim(coalesce(entry->>'printNumber', ''))) between 1 and 10
      and char_length(trim(coalesce(entry->>'konamiCardId', ''))) between 1 and 20 then
      insert into public.ygo_printcode_entries(set_prefix, print_number, konami_card_id)
      values (prefix, trim(entry->>'printNumber'), trim(entry->>'konamiCardId'))
      on conflict (set_prefix, print_number) do update set konami_card_id = excluded.konami_card_id;
      count_inserted := count_inserted + 1;
    end if;
  end loop;
end;
$$;

-- 9) RPC di scrittura del registro — applica il risultato del resolver
--    rispettando SEMPRE la precedenza: override verificato > registro già
--    verificato > (nuovo mapping). Non declassa mai una riga verificata, e
--    marca 'conflict' invece di sovrascrivere silenziosamente quando un nuovo
--    konami_card_id contraddice un mapping 'resolved' già presente (evita che
--    un resync automatico "sbattezzi" una carta corretta senza revisione
--    umana). Specchia sempre lo stato finale su card_printings.
create or replace function public.apply_ygo_printing_mappings(
  p_token text, p_mappings jsonb
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  m jsonb;
  normalized text;
  override_row public.ygo_printing_overrides;
  existing public.ygo_printing_registry;
  final_konami text; final_card_name text; final_artwork_index text; final_artwork_url text;
  final_source text; final_confidence text; final_status text; final_notes text; final_verified boolean;
  applied_count integer := 0; conflict_count integer := 0; skipped_count integer := 0;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if jsonb_typeof(p_mappings) <> 'array' or jsonb_array_length(p_mappings) not between 1 and 500 then
    raise exception 'Elenco mapping non valido'; end if;

  for m in select value from jsonb_array_elements(p_mappings) loop
    normalized := public.normalize_ygo_set_code(m->>'setCode');
    if normalized = '' then continue; end if;
    if coalesce(m->>'mappingStatus', 'unresolved') not in ('verified', 'resolved', 'unresolved', 'conflict') then
      raise exception 'Stato mapping non valido per %', m->>'setCode'; end if;
    if nullif(m->>'mappingSource', '') is not null and m->>'mappingSource' not in ('ygoresources', 'override', 'manual') then
      raise exception 'Fonte mapping non valida per %', m->>'setCode'; end if;
    if nullif(m->>'mappingConfidence', '') is not null and m->>'mappingConfidence' not in ('high', 'medium', 'low') then
      raise exception 'Confidenza mapping non valida per %', m->>'setCode'; end if;

    select * into override_row from public.ygo_printing_overrides
      where game = 'yugioh' and set_code_normalized = normalized and verified;
    select * into existing from public.ygo_printing_registry
      where game = 'yugioh' and set_code_normalized = normalized for update;

    if override_row.id is not null then
      -- Un override verificato vince sempre, indipendentemente da cosa dice il chiamante.
      final_konami := override_row.konami_card_id;
      final_card_name := coalesce(existing.card_name, '');
      final_artwork_index := override_row.artwork_index;
      final_artwork_url := override_row.artwork_url;
      final_source := 'override'; final_confidence := 'high'; final_status := 'verified'; final_verified := true;
      final_notes := override_row.reason;
    elsif existing.id is not null and existing.mapping_status = 'verified' then
      -- Una riga già verificata (per qualunque via) non viene mai declassata da un resync.
      skipped_count := skipped_count + 1;
      continue;
    else
      final_konami := nullif(trim(coalesce(m->>'konamiCardId', '')), '');
      final_card_name := coalesce(nullif(trim(coalesce(m->>'cardName', '')), ''), coalesce(existing.card_name, ''));
      final_artwork_index := nullif(trim(coalesce(m->>'artworkIndex', '')), '');
      final_artwork_url := nullif(trim(coalesce(m->>'artworkUrl', '')), '');
      final_source := nullif(m->>'mappingSource', '');
      final_confidence := nullif(m->>'mappingConfidence', '');
      final_status := coalesce(nullif(m->>'mappingStatus', ''), 'unresolved');
      final_notes := nullif(m->>'mappingNotes', '');
      final_verified := false;

      if existing.id is not null and existing.mapping_status in ('resolved', 'conflict')
        and existing.konami_card_id is not null and final_konami is not null
        and existing.konami_card_id <> final_konami then
        -- Il nuovo risultato contraddice un mapping già affidabile: non
        -- sovrascrivere in automatico, serve revisione (override manuale).
        final_status := 'conflict';
        final_notes := format('Conflitto: registro aveva konami_card_id=%s, nuova risoluzione propone %s (%s)',
          existing.konami_card_id, final_konami, coalesce(final_source, 'sconosciuta'));
        final_konami := existing.konami_card_id;
        final_artwork_index := existing.artwork_index;
        final_artwork_url := existing.artwork_url;
        conflict_count := conflict_count + 1;
      elsif existing.id is not null and existing.mapping_status = 'resolved'
        and existing.konami_card_id is not distinct from final_konami
        and final_status = 'unresolved' then
        -- Stesso Konami ID di un mapping già 'resolved', ma questa risoluzione
        -- non ha trovato l'artwork (es. ygo_artwork_index non ancora
        -- sincronizzato in questo giro): non declassare un dato già buono per
        -- un gap transitorio della cache locale.
        skipped_count := skipped_count + 1;
        continue;
      end if;
    end if;

    insert into public.ygo_printing_registry(
      game, set_code, konami_card_id, ygoprodeck_card_id, card_name, artwork_index, artwork_url,
      mapping_source, mapping_confidence, mapping_status, mapping_notes, verified,
      verified_at
    ) values (
      'yugioh', trim(m->>'setCode'), final_konami, nullif(trim(coalesce(m->>'ygoprodeckCardId', '')), ''),
      final_card_name, final_artwork_index, final_artwork_url, final_source, final_confidence,
      final_status, final_notes, final_verified, case when final_verified then now() else null end
    )
    on conflict (game, set_code_normalized) do update set
      konami_card_id = excluded.konami_card_id, ygoprodeck_card_id = excluded.ygoprodeck_card_id,
      card_name = case when excluded.card_name <> '' then excluded.card_name else public.ygo_printing_registry.card_name end,
      artwork_index = excluded.artwork_index, artwork_url = excluded.artwork_url,
      mapping_source = excluded.mapping_source, mapping_confidence = excluded.mapping_confidence,
      mapping_status = excluded.mapping_status, mapping_notes = excluded.mapping_notes,
      verified = excluded.verified, verified_at = excluded.verified_at;

    -- Specchia lo stato finale su card_printings, senza mai toccare
    -- catalog_card_id/rarity/edition (identità YGOPRODeck e attributi di
    -- copia restano di competenza della pipeline esistente).
    update public.card_printings set
      printing_mapping_status = final_status,
      printing_mapping_checked_at = now(),
      image_url = case
        when final_status in ('verified', 'resolved') and coalesce(final_artwork_url, '') <> ''
          then final_artwork_url
        else image_url
      end
    where game = 'yugioh' and set_code_normalized = normalized
      and (printing_mapping_status is null or printing_mapping_status <> 'verified' or final_status = 'verified');

    applied_count := applied_count + 1;
  end loop;

  return jsonb_build_object('applied', applied_count, 'conflicts', conflict_count, 'skipped', skipped_count);
end;
$$;

-- 10) Override manuali — solo admin, come le altre azioni di correzione
--     privilegiate del progetto (vedi transition_loan 'admin-delete').
create or replace function public.upsert_ygo_printing_override(
  p_token text, p_set_code text, p_konami_card_id text, p_artwork_index text,
  p_artwork_url text, p_reason text
) returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); admin boolean; override_id uuid;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;
  if char_length(trim(coalesce(p_set_code, ''))) < 1 then raise exception 'Set code non valido'; end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 1 and 500 then raise exception 'Motivazione obbligatoria'; end if;

  insert into public.ygo_printing_overrides(
    game, set_code, konami_card_id, artwork_index, artwork_url, reason, created_by, verified
  ) values (
    'yugioh', trim(p_set_code), nullif(trim(coalesce(p_konami_card_id, '')), ''),
    nullif(trim(coalesce(p_artwork_index, '')), ''), nullif(trim(coalesce(p_artwork_url, '')), ''),
    trim(p_reason), me, true
  )
  on conflict (game, set_code_normalized) do update set
    konami_card_id = excluded.konami_card_id, artwork_index = excluded.artwork_index,
    artwork_url = excluded.artwork_url, reason = excluded.reason, created_by = excluded.created_by
  returning id into override_id;

  perform public.apply_ygo_printing_mappings(p_token, jsonb_build_array(jsonb_build_object(
    'setCode', p_set_code, 'konamiCardId', p_konami_card_id, 'artworkIndex', p_artwork_index,
    'artworkUrl', p_artwork_url, 'mappingSource', 'override', 'mappingConfidence', 'high',
    'mappingStatus', 'verified'
  )));

  return override_id;
end;
$$;

-- 10bis) Lettura paginata di TUTTE le printing Yu-Gi-Oh esistenti, per lo
--        script di backfill (scripts/ygo-printing-registry-backfill.mjs).
--        card_printings è catalogo condiviso (stesso principio già usato da
--        lookup_card_printings_by_catalog_id): nessun filtro ownership.
create or replace function public.list_ygo_printings_for_backfill(
  p_token text, p_after_id uuid default null, p_limit integer default 500
) returns table(
  id uuid, set_code text, catalog_card_id text, card_name text,
  image_url text, printing_mapping_status text
) language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_limit not between 1 and 2000 then raise exception 'Limite non valido'; end if;
  return query
    select p.id, p.set_code, p.catalog_card_id, p.card_name, p.image_url, p.printing_mapping_status
    from public.card_printings p
    where p.game = 'yugioh' and p.set_code <> ''
      and (p_after_id is null or p.id > p_after_id)
    order by p.id
    limit p_limit;
end;
$$;

-- 11) Vista diagnostica leggera per il report di backfill e un eventuale
--     piccolo pannello admin (nessun redesign: solo lettura tabellare).
create or replace function public.list_ygo_printing_registry_issues(
  p_token text, p_statuses text[] default array['unresolved', 'conflict']
) returns table(
  set_code text, card_name text, konami_card_id text, mapping_status text,
  mapping_source text, mapping_notes text, updated_at timestamptz
) language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query
    select r.set_code, r.card_name, r.konami_card_id, r.mapping_status, r.mapping_source,
      r.mapping_notes, r.updated_at
    from public.ygo_printing_registry r
    where r.mapping_status = any(p_statuses)
    order by r.mapping_status, r.set_code
    limit 2000;
end;
$$;

-- 12) Guardia anti-regressione: da qui in avanti, save_collection_item e
--     save_collection_batch non sovrascrivono più image_url su una printing
--     che il registro ha già marcato 'verified' o 'resolved' — impedisce che
--     un salvataggio futuro (batch, import, editor non aggiornato) faccia
--     tornare silenziosamente una stampa corretta a un'immagine sbagliata.
--     Corpo identico alla versione live in
--     supabase/migrations/20260908190500_onepiece_deck_and_printing_foundation.sql,
--     unica modifica: la clausola image_url nell'upsert di card_printings.
create or replace function public.save_collection_item(
  p_token text, p_id uuid, p_game text, p_catalog_card_id text, p_card_name text,
  p_set_code text default '', p_set_name text default '', p_rarity text default '',
  p_language text default 'Italiano', p_condition text default 'Near Mint',
  p_edition text default '', p_image_url text default '',
  p_quantity_owned integer default 1, p_quantity_mode text default 'set',
  p_printing_id uuid default null
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

  if p_printing_id is not null then
    select id into printing from public.card_printings where id = p_printing_id and game = p_game and catalog_card_id = trim(p_catalog_card_id);
    if printing is null then raise exception 'Printing selezionata non valida per questa carta'; end if;
  elsif p_game = 'onepiece' then
    raise exception 'One Piece richiede una printing già risolta dal catalogo';
  else
    insert into public.card_printings(game, catalog_card_id, card_name, set_code, set_name, rarity, image_url)
    values (p_game, trim(p_catalog_card_id), trim(p_card_name), upper(left(trim(coalesce(p_set_code,'')),100)),
      left(trim(coalesce(p_set_name,'')),200), left(trim(coalesce(p_rarity,'')),100), left(coalesce(p_image_url,''),500))
    on conflict on constraint card_printings_identity_key do update set card_name = excluded.card_name,
      set_name = case when excluded.set_name <> '' then excluded.set_name else public.card_printings.set_name end,
      image_url = case
        when public.card_printings.printing_mapping_status in ('verified', 'resolved') then public.card_printings.image_url
        when excluded.image_url <> '' then excluded.image_url
        else public.card_printings.image_url
      end
    returning id into printing;
  end if;

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

create or replace function public.save_collection_batch(
  p_token text, p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public, extensions as $$
declare me text := public.session_member(p_token); payload jsonb; printing uuid; saved uuid;
  delta integer; lang text; cond text; ed text; game_value text; catalog_id text;
  card_value text; set_code_value text; set_name_value text; rarity_value text; image_value text;
  saved_count integer := 0; total_count integer := 0; reconcile_status text;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 2000 then
    raise exception 'Batch non valido'; end if;

  for payload in select value from jsonb_array_elements(p_items) loop
    delta := coalesce((payload->>'quantityDelta')::integer,0);
    lang := trim(coalesce(payload->>'language','Italiano'));
    cond := coalesce(payload->>'condition','Near Mint');
    ed := left(trim(coalesce(payload->>'edition','')),100);
    if delta not between 1 and 999 or char_length(lang) not between 1 and 50
      or cond not in ('Mint','Near Mint','Excellent','Good','Played','Poor') then
      raise exception 'Elemento batch non valido'; end if;

    printing := nullif(payload->>'printingId','')::uuid;
    if printing is not null then
      perform 1 from public.card_printings p where p.id=printing;
      if not found then raise exception 'Printing non trovata'; end if;
    else
      game_value := coalesce(payload->>'game','yugioh');
      if game_value = 'onepiece' then raise exception 'One Piece richiede una printing già risolta dal catalogo'; end if;
      catalog_id := trim(coalesce(payload->>'catalogCardId',''));
      card_value := trim(coalesce(payload->>'cardName',''));
      set_code_value := upper(trim(coalesce(payload->>'setCode','')));
      set_name_value := left(trim(coalesce(payload->>'setName','')),200);
      rarity_value := left(trim(coalesce(payload->>'rarity','')),100);
      image_value := left(coalesce(payload->>'imageUrl',''),500);
      if game_value not in ('yugioh','onepiece') or char_length(catalog_id) not between 1 and 100
        or char_length(card_value) not between 1 and 200 or char_length(set_code_value) not between 4 and 100
        or (image_value<>'' and image_value not like 'https://%') then raise exception 'Dati catalogo batch non validi'; end if;
      reconcile_status := public.reconcile_catalog_identity(game_value,catalog_id,set_code_value,card_value,image_value);
      if reconcile_status='mismatch' then raise exception 'Dati catalogo incoerenti per %',set_code_value; end if;
      insert into public.card_printings(game,catalog_card_id,card_name,set_code,set_name,rarity,image_url)
      values(game_value,catalog_id,card_value,set_code_value,set_name_value,rarity_value,image_value)
      on conflict on constraint card_printings_identity_key do update set
        card_name=excluded.card_name,
        set_name=case when excluded.set_name<>'' then excluded.set_name else public.card_printings.set_name end,
        image_url = case
          when public.card_printings.printing_mapping_status in ('verified', 'resolved') then public.card_printings.image_url
          when excluded.image_url <> '' then excluded.image_url
          else public.card_printings.image_url
        end
      returning id into printing;
    end if;

    saved := null;
    insert into public.collection_items(owner_slug,printing_id,language,condition,edition,quantity_owned)
    values(me,printing,lang,cond,ed,delta)
    on conflict (owner_slug,printing_id,language,condition,edition) do update
      set quantity_owned=public.collection_items.quantity_owned+excluded.quantity_owned
      where public.collection_items.quantity_owned+excluded.quantity_owned<=999
    returning id into saved;
    if saved is null then raise exception 'Quantità massima superata nel batch'; end if;
    saved_count := saved_count+1; total_count := total_count+delta;
  end loop;

  return jsonb_build_object('savedItems',saved_count,'totalQuantity',total_count,'owner',me);
end;
$$;

-- 13) Stessa guardia del punto 12, applicata al repair automatico di
--     background (js/catalog-verification.js -> verifyPendingCollectionCatalog
--     -> repair_collection_item_catalog_identity): senza questa modifica,
--     resolveStoredCard() (fallback fuzzy per nome, vedi audit) potrebbe
--     silenziosamente riscrivere l'artwork di una printing già 'verified' o
--     'resolved' dal registro ogni volta che la coda di verifica legacy la
--     rielabora. Corpo identico alla versione live in
--     supabase/migrations/20260910224000_onepiece_image_cross_code_repair.sql,
--     unica modifica: le due clausole image_url nell'update di card_printings
--     (il ramo one-piece resta invariato, il registro è solo yugioh).
create or replace function public.repair_collection_item_catalog_identity(
  p_token text, p_collection_item_id uuid, p_catalog_card_id text,
  p_card_name text, p_image_url text, p_verification_version integer
) returns table(
  collection_item_id uuid, printing_id uuid, catalog_card_id text,
  card_name text, image_url text, verification_status text,
  verification_version integer
) language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  inventory public.collection_items;
  current_printing public.card_printings;
  target_printing_id uuid;
  canonical_id text;
  canonical_base text;
  image_id text;
  image_stem text;
  image_code text;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_verification_version <> 1
    or char_length(trim(coalesce(p_catalog_card_id,''))) not between 1 and 100
    or char_length(trim(coalesce(p_card_name,''))) not between 1 and 200
    or coalesce(p_image_url,'') not like 'https://%'
    or char_length(coalesce(p_image_url,'')) > 500 then
    raise exception 'Dati verifica catalogo non validi';
  end if;

  select * into inventory from public.collection_items
    where id = p_collection_item_id for update;
  if not found or inventory.owner_slug <> me then
    raise exception 'Elemento raccolta non trovato o non modificabile';
  end if;
  select * into current_printing from public.card_printings
    where id = inventory.printing_id for update;
  if not found then raise exception 'Printing non trovata'; end if;

  canonical_id := public.resolve_catalog_card_id(current_printing.game, p_catalog_card_id);
  if current_printing.game = 'yugioh' then
    image_id := substring(p_image_url from '/([0-9]{5,10})\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$');
    if image_id is not null
      and public.resolve_catalog_card_id(current_printing.game, image_id) <> canonical_id then
      raise exception 'Immagine e catalog ID non coerenti';
    end if;
  elsif current_printing.game = 'onepiece' then
    image_stem := regexp_replace(regexp_replace(p_image_url, '^.*/', ''), '\.(jpe?g|png|webp|gif)$', '', 'i');
    image_code := substring(image_stem from '^(([A-Za-z]{1,4}[0-9]{0,3}-[0-9]{1,4})|([Dd][Oo][Nn][_-]?[0-9]+))');
    if image_code is not null then
      image_code := regexp_replace(upper(image_code), '^DON-', 'DON_');
      canonical_base := substring(canonical_id from '^(([A-Za-z]{1,4}[0-9]{0,3}-[0-9]{1,4})|([Dd][Oo][Nn][_-]?[0-9]+))');
      canonical_base := coalesce(regexp_replace(upper(canonical_base), '^DON-', 'DON_'), upper(canonical_id));
      if image_code <> canonical_base then
        raise exception 'Immagine e catalog ID non coerenti';
      end if;
    end if;
  end if;

  if canonical_id = current_printing.catalog_card_id then
    target_printing_id := current_printing.id;
    update public.card_printings set
      image_url = case
        when printing_mapping_status in ('verified', 'resolved') then image_url
        else left(p_image_url,500)
      end,
      catalog_verification_status = 'verified',
      catalog_verification_version = p_verification_version,
      catalog_verified_at = now(),
      catalog_verification_error = null,
      updated_at = now()
    where id = target_printing_id;
  else
    select cp.id into target_printing_id
    from public.card_printings cp
    where cp.game = current_printing.game
      and cp.catalog_card_id = canonical_id
      and cp.set_code = current_printing.set_code
      and cp.rarity = current_printing.rarity
    for update;

    if target_printing_id is null then
      -- L'upsert rende atomiche due repair concorrenti dirette alla stessa
      -- printing canonica, senza creare duplicati o perdere il risultato.
      insert into public.card_printings(
        game, catalog_card_id, card_name, set_code, set_name, rarity, image_url,
        catalog_verification_status, catalog_verification_version,
        catalog_verified_at, catalog_verification_error
      ) values (
        current_printing.game, canonical_id, trim(p_card_name),
        current_printing.set_code, current_printing.set_name, current_printing.rarity,
        left(p_image_url,500), 'verified', p_verification_version, now(), null
      )
      on conflict (game, catalog_card_id, set_code, rarity) do update set
        image_url = case
          when public.card_printings.printing_mapping_status in ('verified', 'resolved') then public.card_printings.image_url
          else excluded.image_url
        end,
        catalog_verification_status = excluded.catalog_verification_status,
        catalog_verification_version = excluded.catalog_verification_version,
        catalog_verified_at = excluded.catalog_verified_at,
        catalog_verification_error = null,
        updated_at = now()
      returning id into target_printing_id;
    else
      update public.card_printings set
        image_url = case
          when printing_mapping_status in ('verified', 'resolved') then image_url
          else left(p_image_url,500)
        end,
        catalog_verification_status = 'verified',
        catalog_verification_version = p_verification_version,
        catalog_verified_at = now(),
        catalog_verification_error = null,
        updated_at = now()
      where id = target_printing_id;
    end if;

    if exists (
      select 1 from public.collection_items ci
      where ci.id <> inventory.id and ci.owner_slug = inventory.owner_slug
        and ci.printing_id = target_printing_id and ci.language = inventory.language
        and ci.condition = inventory.condition and ci.edition = inventory.edition
    ) then
      raise exception 'Repair bloccata: la printing canonica esiste gia nello stesso inventario';
    end if;

    -- Unica modifica ammessa all'inventario: il riferimento alla printing canonica.
    update public.collection_items set printing_id = target_printing_id
      where id = inventory.id;
  end if;

  return query select ci.id, cp.id, cp.catalog_card_id, cp.card_name, cp.image_url,
    cp.catalog_verification_status, cp.catalog_verification_version
  from public.collection_items ci
  join public.card_printings cp on cp.id = ci.printing_id
  where ci.id = inventory.id;
end;
$$;

revoke all on function public.repair_collection_item_catalog_identity(text,uuid,text,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.repair_collection_item_catalog_identity(text,uuid,text,text,text,integer)
  to anon, authenticated;

revoke all on function
  public.ygo_printing_registry_lookup(text, text[]),
  public.ygo_printcode_cache_lookup(text, text[]),
  public.ygo_printcode_cache_upsert(text, text, text, jsonb),
  public.ygo_artwork_index_lookup(text, text[]),
  public.ygo_artwork_index_upsert(text, jsonb),
  public.apply_ygo_printing_mappings(text, jsonb),
  public.upsert_ygo_printing_override(text, text, text, text, text, text),
  public.list_ygo_printing_registry_issues(text, text[]),
  public.list_ygo_printings_for_backfill(text, uuid, integer)
  from public, anon, authenticated;
grant execute on function
  public.ygo_printing_registry_lookup(text, text[]),
  public.ygo_printcode_cache_lookup(text, text[]),
  public.ygo_printcode_cache_upsert(text, text, text, jsonb),
  public.ygo_artwork_index_lookup(text, text[]),
  public.ygo_artwork_index_upsert(text, jsonb),
  public.apply_ygo_printing_mappings(text, jsonb),
  public.upsert_ygo_printing_override(text, text, text, text, text, text),
  public.list_ygo_printing_registry_issues(text, text[]),
  public.list_ygo_printings_for_backfill(text, uuid, integer)
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
