-- F.P.T Cards — Market Watch: CUTOVER di list_market_dashboard_movers al
-- current-price layer (market_current_price_snapshots), ultima delle 4 RPC
-- Market Watch rimaste sullo storico completo dopo 20260914210000_market_
-- watch_current_price_cutover.sql (che ha coperto get_market_watch_summary/
-- list_market_watch_owned_page/list_market_watch_extra — list_market_
-- dashboard_movers NON era in scope lì, vedi il suo header "NON tocca...").
--
-- SOLO la fonte del prezzo cambia:
--   PRIMA: market_active_price_snapshots (vista su market_price_snapshots,
--          storico completo filtrato per mapping attivo) -> DISTINCT ON
--          (printing_id, price_type ORDER BY captured_at desc, id desc)
--   DOPO:  market_current_price_snapshots (un solo record per
--          provider_mapping_id+price_type, già "l'ultimo non anomalo" per
--          costruzione, vedi 20260914200000) + lo stesso identico filtro
--          f.active via market_mapping_is_active(), applicato con lo stesso
--          pattern "mapping_flags materialized" già usato dalle altre 3 RPC
--          cutover.
-- Il DISTINCT ON su (printing_id, price_type) resta necessario ANCHE sul
-- current layer: una printing può avere più provider_mapping_id attivi per
-- lo stesso provider (es. variant_key 'default' vs 'foil'), esattamente come
-- prima — l'unicità del current layer è per (provider_mapping_id, price_type),
-- non per (printing_id, price_type). Tiebreak captured_at desc poi
-- snapshot_id desc: snapshot_id punta alla riga originale di market_price_
-- snapshots, stesso ruolo dell'"id desc" della query legacy.
--
-- Il filtro "captured_at >= now() - interval '48 hours'" resta IDENTICO e
-- si applica ora al captured_at della riga nel current layer (che è sempre
-- il captured_at del vero snapshot più recente per quella chiave, il layer
-- non lo riscrive mai se non quando arriva un nuovo snapshot): un prezzo
-- "current" ma più vecchio di 48h continua a NON comparire come mover, come
-- prima di questa migration — la freschezza dei "movers" non deve MAI
-- allentarsi rispetto a oggi.
--
-- provider/currency/price_type/soglie di ranking (trend > coalesce(avg7,
-- avg30, avg1), limit 3, ordine per positiveChange) restano testualmente
-- IDENTICI: cambia solo da dove arrivano le righe.
--
-- BUG PREESISTENTE SCOPERTO (e corretto come effetto collaterale, non
-- l'obiettivo di questa migration): a differenza di get_market_watch_
-- summary/list_market_watch_owned_page/list_market_watch_extra (che filtrano
-- SEMPRE esplicitamente "not is_anomalous"), list_market_dashboard_movers
-- leggeva da market_active_price_snapshots (filtra solo per mapping attivo,
-- MAI per anomalia) senza alcun filtro is_anomalous proprio — verificato per
-- grep sul file originale, supabase-market-dashboard-movers.sql, nessuna
-- occorrenza di is_anomalous. Uno snapshot marcato anomalo dal trigger
-- BEFORE INSERT (rapporto >5x o <0.1x rispetto all'ultimo prezzo noto) ma
-- comunque il PIÙ RECENTE per una (printing_id, price_type) vinceva la
-- DISTINCT ON e finiva mostrato in "Carte in evidenza" — nella migliore
-- delle ipotesi un cambio percentuale assurdo, nella peggiore un falso
-- ribasso che nascondeva una salita reale (trend anomalo basso <
-- baseline -> la carta veniva silenziosamente esclusa dal ranking). Il
-- current layer non contiene MAI una riga anomala per costruzione (i
-- trigger di 20260914200000 promuovono solo "l'ultimo snapshot NON
-- anomalo"), quindi il cutover chiude questo buco senza bisogno di un
-- filtro esplicito aggiuntivo qui. Dimostrato dal test dedicato
-- (scripts/market-dashboard-movers-cutover-smoke.mjs, sezione 3).
--
-- NON tocca: supabase/functions/market-sync/index.ts, cron, i trigger del
-- current layer, market_price_snapshots (schema o dati), market_active_
-- price_snapshots/market_derived_price_snapshots (restano usate da altre
-- query, es. il confronto storico nella shadow diagnostica), il frontend
-- (contratto JSON identico — stesse chiavi già mappate da mapDashboardMovers
-- in js/market-watch.js).
--
-- INDICI: nessuno aggiunto. Il JOIN a market_current_price_snapshots avviene
-- per printing_id, già coperto da market_current_price_snapshots_printing_idx
-- (creato in 20260914200000).
--
-- Verifica prima/dopo (nessun accesso a Postgres reale in questa sessione):
-- scripts/market-dashboard-movers-cutover-benchmark.sql (EXPLAIN ANALYZE +
-- riconciliazione contro market_current_price_layer_shadow_report, stesso
-- metodo delle altre 3 RPC) e scripts/market-dashboard-movers-cutover-
-- smoke.mjs (equivalenza OLD/NEW su dataset sintetico + asserzioni statiche
-- sulla migration).

create or replace function public.list_market_dashboard_movers(p_token text, p_game text default 'yugioh')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  with owned as (
    select ci.printing_id, sum(ci.quantity_owned)::integer quantity
    from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
    where ci.owner_slug = me and cp.game = p_game and ci.quantity_owned > 0
    group by ci.printing_id
  ), mapping_flags as materialized (
    select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active
    from public.market_provider_printings
    where printing_id in (select printing_id from owned)
  ), latest as (
    -- CUTOVER: dal current layer, non più da market_active_price_snapshots.
    select distinct on (c.printing_id, c.price_type)
      c.printing_id, c.price_type, c.normalized_price, c.captured_at
    from public.market_current_price_snapshots c
    join owned o on o.printing_id = c.printing_id
    join mapping_flags f on f.id = c.provider_mapping_id
    where f.active and c.provider = 'cardmarket' and c.normalized_currency = 'EUR'
      and c.price_type in ('trend', 'avg1', 'avg7', 'avg30')
      and c.captured_at >= now() - interval '48 hours'
    order by c.printing_id, c.price_type, c.captured_at desc, c.snapshot_id desc
  ), prices as (
    select printing_id,
      max(normalized_price) filter (where price_type = 'trend') trend,
      max(normalized_price) filter (where price_type = 'avg1') avg1,
      max(normalized_price) filter (where price_type = 'avg7') avg7,
      max(normalized_price) filter (where price_type = 'avg30') avg30,
      max(captured_at) captured_at
    from latest group by printing_id
  ), ranked as (
    select cp.id printing_id, cp.catalog_card_id, cp.card_name, cp.set_code, cp.set_name, cp.rarity, cp.image_url, o.quantity,
      p.trend reference_price, coalesce(p.avg7, p.avg30, p.avg1) baseline_price,
      ((p.trend - coalesce(p.avg7, p.avg30, p.avg1)) / nullif(coalesce(p.avg7, p.avg30, p.avg1), 0)) * 100 positive_change,
      p.avg30, p.avg7, p.avg1, p.captured_at
    from prices p join owned o on o.printing_id = p.printing_id join public.card_printings cp on cp.id = p.printing_id
    where p.trend > coalesce(p.avg7, p.avg30, p.avg1) and coalesce(p.avg7, p.avg30, p.avg1) > 0
    order by positive_change desc, (p.trend - coalesce(p.avg7, p.avg30, p.avg1)) desc
    limit 3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'printingId', printing_id, 'catalogCardId', catalog_card_id, 'cardName', card_name, 'setCode', set_code, 'setName', set_name,
    'rarity', rarity, 'imageUrl', image_url, 'ownedQuantity', quantity, 'referencePrice', reference_price,
    'baselinePrice', baseline_price, 'positiveChange', positive_change, 'capturedAt', captured_at,
    'sparkline', jsonb_build_array(
      jsonb_build_object('label', 'AVG30', 'price', avg30, 'order', 1), jsonb_build_object('label', 'AVG7', 'price', avg7, 'order', 2),
      jsonb_build_object('label', 'AVG1', 'price', avg1, 'order', 3), jsonb_build_object('label', 'TREND', 'price', reference_price, 'order', 4)
    )) order by positive_change desc), '[]'::jsonb) into result from ranked;
  return result;
end;
$$;

revoke all on function public.list_market_dashboard_movers(text,text) from public, anon, authenticated;
grant execute on function public.list_market_dashboard_movers(text,text) to anon, authenticated;

notify pgrst, 'reload schema';
