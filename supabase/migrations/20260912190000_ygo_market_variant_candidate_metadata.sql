-- F.P.T Cards — Market Variant Registry: arricchimento metadata dei
-- candidate_product_ids per il pannello Market Variant Resolver.
--
-- Audit (turno precedente) ha stabilito che rarity/variant NON sono
-- derivabili localmente: il bulk Product Catalogue di Cardmarket non porta
-- rarity per i casi Rarity Collection/multi-rarity (confermato da un dump
-- reale, commento datato in market/providers.js), il Price Guide contiene
-- solo prezzi, e market_provider_printings.provider_metadata eredita lo
-- stesso limite. L'unico posto dove Cardmarket mostra rarity/variant è la
-- pagina prodotto individuale (titolo "Card Name (V.N - Rarity)").
--
-- IMPORTANTE — verificato in questa sessione, non un'assunzione: un fetch di
-- prova (WebFetch) verso sia l'URL di un idProduct reale sia la semplice
-- home category YuGiOh di cardmarket.com è tornato HTTP 403 su ENTRAMBI.
-- Questo NON è uno scraper generale né un crawler: fetch solo per i
-- candidate_product_ids già in coda, un admin alla volta, un prodotto alla
-- volta, cache 7 giorni, nessun retry aggressivo, nessun bypass/headless/
-- proxy (esplicitamente vietati). Se il 403 osservato si ripete anche dal
-- lato server (Edge Function), ogni candidato risulterà fetch_status=
-- 'blocked' e il pannello continuerà a funzionare mostrando solo
-- product_id/expansion — nessun impatto sul resto dell'app in ogni caso.
--
-- Additiva. Non tocca ygo_market_variants/market_provider_printings/pricing.

begin;

-- cardmarket_product_id come chiave, non (printing_id, product_id): un
-- prodotto Cardmarket è un'identità globale, indipendente da quale printing
-- FPT lo elenca come candidato (può comparire nella coda di più printing
-- che condividono lo stesso pool ambiguo) — niente duplicati di metadata
-- per lo stesso prodotto.
create table if not exists public.ygo_market_variant_candidate_metadata (
  cardmarket_product_id text primary key check (char_length(cardmarket_product_id) between 1 and 100),
  cardmarket_expansion_id text check (cardmarket_expansion_id is null or char_length(cardmarket_expansion_id) <= 100),
  product_name text check (product_name is null or char_length(product_name) <= 300),
  expansion_name text check (expansion_name is null or char_length(expansion_name) <= 300),
  rarity_raw text check (rarity_raw is null or char_length(rarity_raw) <= 100),
  rarity_canonical text references public.ygo_rarity_canon(code),
  variant_label text check (variant_label is null or char_length(variant_label) <= 100),
  variant_number text check (variant_number is null or char_length(variant_number) <= 20),
  product_url text check (product_url is null or char_length(product_url) <= 500),
  canonical_url text check (canonical_url is null or char_length(canonical_url) <= 500),
  metadata_source text not null default 'cardmarket_product_page'
    check (metadata_source in ('cardmarket_product_page', 'manual_verified')),
  metadata_confidence numeric check (metadata_confidence is null or metadata_confidence between 0 and 1),
  fetch_status text not null default 'pending'
    check (fetch_status in ('pending', 'resolved', 'incomplete', 'not_found', 'blocked', 'parse_error')),
  fetch_error text check (fetch_error is null or char_length(fetch_error) <= 500),
  -- Solo metadata parsati + un frammento minimo per audit (titolo grezzo,
  -- url) — MAI il blob HTML completo, per policy esplicita.
  raw_metadata jsonb,
  first_seen_at timestamptz not null default now(),
  last_checked_at timestamptz,
  verified_at timestamptz
);

create index if not exists ygo_market_variant_candidate_metadata_status_idx
  on public.ygo_market_variant_candidate_metadata(fetch_status);

alter table public.ygo_market_variant_candidate_metadata enable row level security;
revoke all on public.ygo_market_variant_candidate_metadata from public, anon, authenticated;

-- 1) Lettura per una printing — join dei suoi candidate_product_ids con la
--    cache metadata + il confronto rarity FPT-vs-Cardmarket. Sola lettura,
--    non fa alcun fetch: se un candidato non ha ancora metadata, torna
--    fetch_status='pending' via coalesce (nessuna riga = non ancora richiesto).
create or replace function public.get_ygo_market_variant_candidate_metadata(p_token text, p_printing_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  variant public.ygo_market_variants;
  result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;

  select * into variant from public.ygo_market_variants where printing_id = p_printing_id;
  if not found then
    return jsonb_build_object('printing_id', p_printing_id, 'fpt_rarity_canonical', null, 'candidates', '[]'::jsonb);
  end if;

  select jsonb_build_object(
    'printing_id', p_printing_id,
    'fpt_rarity_canonical', variant.rarity_canonical,
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', pid,
        'product_name', m.product_name, 'expansion_name', m.expansion_name, 'cardmarket_expansion_id', m.cardmarket_expansion_id,
        'rarity_raw', m.rarity_raw, 'rarity_canonical', m.rarity_canonical,
        'variant_label', m.variant_label, 'variant_number', m.variant_number,
        'product_url', m.product_url, 'canonical_url', m.canonical_url,
        'metadata_source', m.metadata_source, 'metadata_confidence', m.metadata_confidence,
        'fetch_status', coalesce(m.fetch_status, 'pending'), 'fetch_error', m.fetch_error,
        'last_checked_at', m.last_checked_at,
        'rarity_match', case
          when variant.rarity_canonical is null or m.rarity_canonical is null then 'unknown'
          when variant.rarity_canonical = m.rarity_canonical then 'exact_match'
          else 'mismatch'
        end
      ) order by pid)
      from jsonb_array_elements_text(coalesce(variant.candidate_product_ids, '[]'::jsonb)) as pid
      left join public.ygo_market_variant_candidate_metadata m on m.cardmarket_product_id = pid
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;
revoke all on function public.get_ygo_market_variant_candidate_metadata(text, uuid) from public, anon, authenticated;
grant execute on function public.get_ygo_market_variant_candidate_metadata(text, uuid) to authenticated, anon;

-- 2) Richiesta di refresh — stesso pattern canary/price-shadow: crea una
--    run nella coda già generica ygo_market_variant_canary_runs e scatena
--    market-sync via net.http_post (secret letto qui, mai dal client). Il
--    force effettivo viaggia nel body dell'http_post, non nella riga: non
--    serve persistere un campo in più su una tabella già generica.
create or replace function public.request_ygo_market_variant_candidate_metadata_refresh(
  p_token text, p_printing_ids uuid[], p_force boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  ids uuid[] := coalesce(p_printing_ids, '{}'::uuid[]);
  id_count integer := coalesce(array_length(ids, 1), 0);
  invalid_count integer;
  new_run_id uuid;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;

  if id_count = 0 then raise exception 'printing_ids non può essere vuoto'; end if;
  if id_count > 5 then raise exception 'Massimo 5 printing_ids per refresh metadata (ricevuti %)', id_count; end if;

  select count(*) into invalid_count
  from unnest(ids) as pid
  where not exists (select 1 from public.card_printings cp where cp.id = pid and cp.game = 'yugioh');
  if invalid_count > 0 then raise exception '% printing_id non validi o non Yu-Gi-Oh!', invalid_count; end if;

  insert into public.ygo_market_variant_canary_runs (requested_by, printing_ids)
  values (me, ids)
  returning id into new_run_id;

  perform net.http_post(
    url := 'https://gonycawupahawocqafcf.supabase.co/functions/v1/market-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-market-sync-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'market_sync_secret')
    ),
    body := jsonb_build_object('marketVariantCandidateMetadataRunId', new_run_id, 'force', coalesce(p_force, false)),
    timeout_milliseconds := 60000
  );

  return jsonb_build_object('run_id', new_run_id, 'status', 'pending');
end;
$$;
revoke all on function public.request_ygo_market_variant_candidate_metadata_refresh(text, uuid[], boolean) from public, anon, authenticated;
grant execute on function public.request_ygo_market_variant_candidate_metadata_refresh(text, uuid[], boolean) to authenticated, anon;

commit;
