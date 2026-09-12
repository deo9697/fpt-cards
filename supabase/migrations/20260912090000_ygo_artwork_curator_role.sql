-- F.P.T Cards — Artwork Curator: capability limitata (non un ruolo admin)
-- per verificare manualmente gli artwork multi-artwork del Yu-Gi-Oh!
-- Printing Registry.
--
-- Il modello auth attuale (team_members.role) ammette solo 'admin'/'guest'
-- (check constraint verificato prima di scrivere questa migration) — nessun
-- sistema di permessi granulari preesistente. Aggiungere un terzo valore di
-- `role` avrebbe reso ogni controllo "role = 'admin'" sparso nel codice
-- potenzialmente ambiguo su cosa un nuovo valore implica. Si aggiunge invece
-- UNA capability booleana dedicata e stretta (least privilege, coerente con
-- can_verify_ygo_artwork chiesto esplicitamente), che non tocca il
-- significato di `role` in nessun altro punto dello schema o del client.
--
-- Additiva e conservativa: nessuna tabella esistente viene svuotata; gli
-- unici default sono false (nessun utente esistente guadagna il permesso
-- implicitamente).

begin;

alter table public.team_members
  add column if not exists can_verify_ygo_artwork boolean not null default false;

-- Attribuzione della verifica: chi e con quale livello (admin o curator).
-- Colonne denormalizzate sul registro per una lettura O(1) in coda (la
-- storia completa, incluse le correzioni, vive in ygo_printing_artwork_audit
-- sotto — queste due colonne riflettono sempre solo l'ULTIMA verifica).
alter table public.ygo_printing_registry
  add column if not exists verified_by text references public.team_members(slug),
  add column if not exists verification_source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ygo_printing_registry_verification_source_check'
      and conrelid = 'public.ygo_printing_registry'::regclass
  ) then
    alter table public.ygo_printing_registry add constraint ygo_printing_registry_verification_source_check
      check (verification_source is null or verification_source in ('admin_manual', 'curator_manual'));
  end if;
end $$;

-- Audit trail append-only: mai aggiornato né cancellato, una riga per ogni
-- conferma/correzione. previous_artwork_index è null solo alla primissima
-- verifica di quella printing.
create table if not exists public.ygo_printing_artwork_audit (
  id uuid primary key default gen_random_uuid(),
  set_code text not null check (char_length(trim(set_code)) between 1 and 100),
  set_code_normalized text not null generated always as (public.normalize_ygo_set_code(set_code)) stored,
  konami_card_id text not null check (char_length(trim(konami_card_id)) between 1 and 20),
  previous_artwork_index text,
  new_artwork_index text not null check (char_length(trim(new_artwork_index)) between 1 and 10),
  new_artwork_url text not null check (new_artwork_url like 'https://%'),
  verified_by text not null references public.team_members(slug),
  verification_source text not null check (verification_source in ('admin_manual', 'curator_manual')),
  verified_at timestamptz not null default now()
);

create index if not exists ygo_printing_artwork_audit_set_code_idx
  on public.ygo_printing_artwork_audit(set_code_normalized, verified_at desc);
create index if not exists ygo_printing_artwork_audit_verified_by_idx
  on public.ygo_printing_artwork_audit(verified_by, verified_at desc);

alter table public.ygo_printing_artwork_audit enable row level security;
revoke all on public.ygo_printing_artwork_audit from public, anon, authenticated;

-- Conferma artwork (admin O artwork curator) — l'UNICO percorso di scrittura
-- per questa capability. Per design non accetta konami_card_id, artwork_url
-- o set_code "liberi": il set_code seleziona solo QUALE printing (già nota),
-- il Konami ID è sempre letto dal registro esistente (mai dal client), e
-- l'artwork_url è sempre ricavato da ygo_artwork_index.candidates per
-- QUELL'esatto Konami ID — un indice che non appartiene al Konami ID di
-- questa printing viene rifiutato. Non tocca mai l'identità carta.
create or replace function public.confirm_ygo_printing_artwork(
  p_token text, p_set_code text, p_artwork_index text
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  is_admin boolean;
  can_curate boolean;
  normalized text := public.normalize_ygo_set_code(p_set_code);
  existing_registry public.ygo_printing_registry;
  chosen_candidate jsonb;
  chosen_url text;
  chosen_index text := trim(coalesce(p_artwork_index, ''));
  source text;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin', coalesce(can_verify_ygo_artwork, false) into is_admin, can_curate
    from public.team_members where slug = me;
  if not coalesce(is_admin, false) and not coalesce(can_curate, false) then
    raise exception 'Operazione riservata ad admin o artwork curator';
  end if;
  if char_length(chosen_index) < 1 then raise exception 'Indice artwork non valido'; end if;
  if normalized = '' then raise exception 'Set code non valido'; end if;

  select * into existing_registry from public.ygo_printing_registry
    where set_code_normalized = normalized for update;
  if not found or existing_registry.konami_card_id is null then
    raise exception 'Identità carta non ancora determinata per questa printing: nessun Konami ID noto';
  end if;

  -- Una printing già verificata (da chiunque, admin o curator) può essere
  -- corretta solo da un admin — mai da un curator, nemmeno per una propria
  -- scelta precedente (scelta esplicita: vedi commit message).
  if existing_registry.verified and not coalesce(is_admin, false) then
    raise exception 'Questa printing è già verificata: solo un admin può correggerla';
  end if;

  select candidate into chosen_candidate
    from public.ygo_artwork_index, jsonb_array_elements(candidates) candidate
    where konami_card_id = existing_registry.konami_card_id
      and candidate->>'index' = chosen_index
    limit 1;
  if chosen_candidate is null then
    raise exception 'Artwork selezionato non valido per questo Konami ID';
  end if;
  chosen_url := chosen_candidate->>'url';
  if coalesce(chosen_url, '') !~ '^https://' then raise exception 'Artwork candidato senza URL valido'; end if;

  source := case when coalesce(is_admin, false) then 'admin_manual' else 'curator_manual' end;

  insert into public.ygo_printing_artwork_audit(
    set_code, konami_card_id, previous_artwork_index, new_artwork_index, new_artwork_url,
    verified_by, verification_source
  ) values (
    existing_registry.set_code, existing_registry.konami_card_id, existing_registry.artwork_index,
    chosen_index, chosen_url, me, source
  );

  update public.ygo_printing_registry set
    artwork_index = chosen_index, artwork_url = chosen_url,
    mapping_source = 'manual', mapping_confidence = 'high', mapping_status = 'verified',
    verified = true, verified_at = now(), verified_by = me, verification_source = source,
    mapping_notes = format('Confermato manualmente (%s)', source)
  where id = existing_registry.id;

  update public.card_printings set
    image_url = chosen_url, printing_mapping_status = 'verified', printing_mapping_checked_at = now()
  where game = 'yugioh' and set_code_normalized = normalized;

  return jsonb_build_object(
    'setCode', existing_registry.set_code, 'artworkIndex', chosen_index, 'artworkUrl', chosen_url,
    'verifiedBy', me, 'verificationSource', source
  );
end;
$$;

-- Coda di revisione — ora aperta ad admin E curator, con filtri/ordinamento
-- e set_name/rarity (da card_printings, un set_code può avere più rarità).
-- Firma diversa dalla precedente (nuovi parametri): drop esplicito, altrimenti
-- create or replace creerebbe un secondo overload invece di sostituirla.
drop function if exists public.list_ygo_artwork_review_queue(text, integer, integer);

create or replace function public.list_ygo_artwork_review_queue(
  p_token text, p_limit integer default 50, p_offset integer default 0,
  p_set_prefix text default null, p_query text default null,
  p_used_only boolean default true, p_order_by text default 'usage_count'
) returns table(
  set_code text, card_name text, set_names text[], rarities text[], konami_card_id text,
  artwork_count integer, current_artwork_url text, candidates jsonb,
  collection_usage integer, deck_usage integer, loan_usage integer, usage_count integer,
  total_count bigint
) language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  is_admin boolean; can_curate boolean;
  prefix text := upper(trim(coalesce(p_set_prefix, '')));
  query_text text := trim(coalesce(p_query, ''));
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin', coalesce(can_verify_ygo_artwork, false) into is_admin, can_curate
    from public.team_members where slug = me;
  if not coalesce(is_admin, false) and not coalesce(can_curate, false) then
    raise exception 'Operazione riservata ad admin o artwork curator';
  end if;
  if p_limit not between 1 and 200 then raise exception 'Limite non valido'; end if;
  if p_order_by not in ('usage_count', 'set_code', 'card_name') then raise exception 'Ordinamento non valido'; end if;

  return query
    with printings as (
      select p.set_code_normalized, p.set_name, p.rarity, p.id as printing_id
      from public.card_printings p where p.game = 'yugioh' and p.set_code <> ''
    ),
    usage as (
      select pr.set_code_normalized,
        count(distinct ci.id)::integer as collection_usage,
        count(distinct dc.id)::integer as deck_usage,
        count(distinct l.id)::integer as loan_usage,
        array_remove(array_agg(distinct nullif(pr.set_name, '')), null) as set_names,
        array_remove(array_agg(distinct nullif(pr.rarity, '')), null) as rarities
      from printings pr
      left join public.collection_items ci on ci.printing_id = pr.printing_id
      left join public.deck_cards dc on dc.printing_id = pr.printing_id
      left join public.loans l on l.collection_item_id = ci.id
      group by pr.set_code_normalized
    ),
    queue as (
      select r.set_code, r.card_name, coalesce(u.set_names, array[]::text[]) as set_names,
        coalesce(u.rarities, array[]::text[]) as rarities, r.konami_card_id, a.artwork_count,
        r.artwork_url as current_artwork_url, coalesce(a.candidates, '[]'::jsonb) as candidates,
        coalesce(u.collection_usage, 0) as collection_usage, coalesce(u.deck_usage, 0) as deck_usage,
        coalesce(u.loan_usage, 0) as loan_usage,
        coalesce(u.collection_usage, 0) + coalesce(u.deck_usage, 0) + coalesce(u.loan_usage, 0) as usage_count
      from public.ygo_printing_registry r
      left join public.ygo_artwork_index a on a.konami_card_id = r.konami_card_id
      left join usage u on u.set_code_normalized = r.set_code_normalized
      where r.mapping_status = 'unresolved' and r.konami_card_id is not null
        and (prefix = '' or r.set_code like prefix || '%')
        and (query_text = '' or r.card_name ilike '%' || query_text || '%' or r.set_code ilike '%' || query_text || '%')
        and (not p_used_only or (coalesce(u.collection_usage, 0) + coalesce(u.deck_usage, 0) + coalesce(u.loan_usage, 0)) > 0)
    )
    select q.*, count(*) over()::bigint as total_count
    from queue q
    order by
      case when p_order_by = 'usage_count' then q.usage_count end desc,
      case when p_order_by = 'set_code' then q.set_code end asc,
      case when p_order_by = 'card_name' then q.card_name end asc,
      q.set_code asc
    limit p_limit offset p_offset;
end;
$$;

-- Storico personale di verifiche (admin o curator, sempre e solo le proprie).
create or replace function public.list_my_ygo_artwork_verifications(
  p_token text, p_limit integer default 100
) returns table(
  set_code text, konami_card_id text, previous_artwork_index text, new_artwork_index text,
  new_artwork_url text, verification_source text, verified_at timestamptz
) language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_limit not between 1 and 500 then raise exception 'Limite non valido'; end if;
  return query
    select a.set_code, a.konami_card_id, a.previous_artwork_index, a.new_artwork_index,
      a.new_artwork_url, a.verification_source, a.verified_at
    from public.ygo_printing_artwork_audit a
    where a.verified_by = me
    order by a.verified_at desc
    limit p_limit;
end;
$$;

-- login_member: espone can_verify_ygo_artwork al client insieme a role,
-- corpo invariato per il resto (stessa versione già in produzione).
create or replace function public.login_member(p_slug text, p_pin text, p_token text)
returns jsonb language plpgsql security definer set search_path = 'public', 'extensions' as $$
declare item public.team_members;
begin
  if p_pin !~ '^[0-9]{4}$' or char_length(p_token) < 32 then raise exception 'Dati di accesso non validi'; end if;
  select * into item from public.team_members where slug = p_slug and active for update;
  if not found then raise exception 'Profilo non trovato o disattivato'; end if;
  if item.pin_hash is null then
    update public.team_members set pin_hash = crypt(p_pin, gen_salt('bf', 10)) where slug = p_slug;
  elsif item.pin_hash <> crypt(p_pin, item.pin_hash) then raise exception 'PIN non corretto';
  end if;
  delete from public.app_sessions where expires_at <= now();
  insert into public.app_sessions(token_hash, member_slug, expires_at)
  values (digest(p_token, 'sha256'), p_slug, now() + interval '30 days')
  on conflict (token_hash) do update set member_slug = excluded.member_slug, expires_at = excluded.expires_at;
  return jsonb_build_object('slug', item.slug, 'name', item.full_name, 'role', item.role,
    'canVerifyYgoArtwork', coalesce(item.can_verify_ygo_artwork, false));
end;
$$;

revoke all on function
  public.confirm_ygo_printing_artwork(text, text, text),
  public.list_ygo_artwork_review_queue(text, integer, integer, text, text, boolean, text),
  public.list_my_ygo_artwork_verifications(text, integer)
  from public, anon, authenticated;
grant execute on function
  public.confirm_ygo_printing_artwork(text, text, text),
  public.list_ygo_artwork_review_queue(text, integer, integer, text, text, boolean, text),
  public.list_my_ygo_artwork_verifications(text, integer)
  to anon, authenticated;

-- Utente volontario iniziale, identità risolta senza ambiguità: esiste
-- esattamente un team_members con full_name 'Cristofer Marincolo'
-- (slug 'cristofer', role 'guest' — resta 'guest', non diventa admin).
update public.team_members set can_verify_ygo_artwork = true where slug = 'cristofer';

notify pgrst, 'reload schema';

commit;
