-- F.P.T Cards — Market Variant Registry: canale canary admin-only.
--
-- Problema risolto: testare lo shadow resolver richiedeva finora
-- MARKET_SYNC_SECRET a mano (header x-market-sync-secret) da fuori
-- dell'app — un segreto server-to-server che non deve mai avvicinarsi a un
-- browser. Questa migration introduce un canale che riusa SOLO
-- l'autenticazione FPT già esistente (session_member + team_members.role):
--
--   admin FPT autenticato
--   -> run_ygo_market_variant_canary(p_token, p_printing_ids)  [RPC, admin-only]
--   -> inserisce una riga 'pending' in ygo_market_variant_canary_runs
--   -> net.http_post verso market-sync, CON l'header x-market-sync-secret
--      aggiunto qui dentro (SECURITY DEFINER, legge vault.decrypted_secrets)
--   -> il client non vede né conosce il secret in nessun momento
--   -> market-sync (Edge Function) processa SOLO quella run, scrive SOLO
--      ygo_market_variants (shadow) + il risultato nella run stessa — MAI
--      market_provider_printings/market_price_snapshots (quindi mai
--      market_price_events, che è solo un trigger su quello)
--
-- Non duplica in SQL la logica di resolveYgoMarketVariant()/
-- resolveCardmarketPrinting() (TypeScript, ha bisogno del catalogo
-- Cardmarket in memoria) — la RPC è solo il gate di autorizzazione + la
-- coda, l'Edge Function resta l'unico posto che risolve davvero.
--
-- Additiva: nessuna tabella esistente toccata. RLS attiva, zero policy,
-- accesso solo tramite le due RPC sotto (stesso pattern zero-policy di
-- ygo_market_variant_backfill_report/ygo_printing_registry).

begin;

create table if not exists public.ygo_market_variant_canary_runs (
  id uuid primary key default gen_random_uuid(),
  requested_by text not null references public.team_members(slug),
  printing_ids uuid[] not null check (coalesce(array_length(printing_ids, 1), 0) between 1 and 20),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  error_message text check (error_message is null or char_length(error_message) <= 1000)
);

create index if not exists ygo_market_variant_canary_runs_status_idx
  on public.ygo_market_variant_canary_runs(status);

alter table public.ygo_market_variant_canary_runs enable row level security;
revoke all on public.ygo_market_variant_canary_runs from public, anon, authenticated;

-- 1) Crea la run + scatena l'Edge Function — l'unico punto dell'intero
--    sistema che tocca vault.decrypted_secrets per questo scopo. net.http_post
--    è fire-and-forget (pg_net): la RPC ritorna subito con status 'pending',
--    il client fa polling su get_ygo_market_variant_canary_run() sotto.
create or replace function public.run_ygo_market_variant_canary(p_token text, p_printing_ids uuid[])
returns jsonb
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
  if id_count > 20 then raise exception 'Massimo 20 printing_ids per canary run (ricevuti %)', id_count; end if;

  select count(*) into invalid_count
  from unnest(ids) as pid
  where not exists (
    select 1 from public.card_printings cp where cp.id = pid and cp.game = 'yugioh'
  );
  if invalid_count > 0 then
    raise exception '% printing_id non validi o non Yu-Gi-Oh!', invalid_count;
  end if;

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
    body := jsonb_build_object('marketVariantCanaryRunId', new_run_id),
    timeout_milliseconds := 60000
  );

  return jsonb_build_object('run_id', new_run_id, 'status', 'pending');
end;
$$;

-- 2) Lettura di stato/risultato — admin-only, mai lettura diretta della
--    tabella dal client (RLS zero-policy sopra lo impedisce comunque).
create or replace function public.get_ygo_market_variant_canary_run(p_token text, p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;

  select jsonb_build_object(
    'run_id', r.id, 'status', r.status, 'requested_by', r.requested_by,
    'printing_ids', r.printing_ids, 'created_at', r.created_at, 'started_at', r.started_at,
    'finished_at', r.finished_at, 'result', r.result, 'error_message', r.error_message
  ) into result
  from public.ygo_market_variant_canary_runs r
  where r.id = p_run_id;

  if result is null then raise exception 'Canary run non trovata'; end if;
  return result;
end;
$$;

revoke all on function public.run_ygo_market_variant_canary(text, uuid[]) from public, anon, authenticated;
grant execute on function public.run_ygo_market_variant_canary(text, uuid[]) to authenticated, anon;
revoke all on function public.get_ygo_market_variant_canary_run(text, uuid) from public, anon, authenticated;
grant execute on function public.get_ygo_market_variant_canary_run(text, uuid) to authenticated, anon;

commit;
