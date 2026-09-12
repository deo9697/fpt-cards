-- F.P.T Cards — Market Variant Registry: report di backfill, SOLO locale.
--
-- Sezione 15 del task: "prima un backfill/report, non correggere subito
-- tutto". Questa RPC risponde alla parte del report che NON richiede dati
-- Cardmarket (nessuna chiamata al feed, nessun costo, gira solo su
-- card_printings/collection_items/market_provider_printings già in DB):
--   * quante printing condividono lo stesso (catalog_card_id, set_code) con
--     più rarità distinte — l'identikit di un prodotto tipo Rarity
--     Collection, non serve un nome hardcoded per trovarli;
--   * quante collection item ricadono in uno di questi gruppi (rarity
--     "ambigua" nel senso: più fratelli-rarità condividono il set_code) contro
--     quante hanno una rarity deterministica (nessun fratello nello stesso
--     set_code);
--   * quante printing hanno già una rarity canonicalizzabile con il
--     vocabolario di 20260912110000_ygo_market_variant_registry.sql;
--   * quante hanno già un mapping Cardmarket "legacy" autorizzato oggi
--     (market_provider_printings) che ricade in un gruppo multi-rarity —
--     candidati a diventare 'ambiguous' sotto la nuova classificazione
--     invece di continuare a mostrare silenziosamente un prezzo aggregato.
--
-- "Quante varianti Cardmarket sono mappabili automaticamente" / "quante
-- necessitano review manuale" NON sono rispondibili da qui: richiedono di
-- far girare resolveYgoMarketVariant() (market/providers.js) contro il
-- catalogo Cardmarket reale, cosa che questa migration NON fa — resta la
-- fase successiva, deliberatamente separata (nessuna chiamata di rete né
-- scrittura su ygo_market_variants qui dentro).
--
-- Additiva, sola lettura: nessuna tabella esistente viene modificata.

begin;

create or replace function public.ygo_market_variant_backfill_report(p_token text, p_game text default 'yugioh')
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;

  with rarity_groups as (
    select catalog_card_id, set_code_normalized,
      count(distinct nullif(trim(rarity), '')) as distinct_rarities,
      count(*) as printing_count,
      array_agg(distinct rarity order by rarity) as rarities
    from public.card_printings
    where game = p_game and set_code_normalized <> ''
    group by catalog_card_id, set_code_normalized
  ),
  multi_rarity_groups as (
    select * from rarity_groups where distinct_rarities > 1
  ),
  printing_canon as (
    select cp.id, cp.rarity, (nullif(trim(cp.rarity), '') is not null) as has_rarity,
      public.normalize_ygo_rarity(cp.rarity) as rarity_canonical,
      (mrg.catalog_card_id is not null) as in_multi_rarity_group
    from public.card_printings cp
    left join multi_rarity_groups mrg
      on mrg.catalog_card_id = cp.catalog_card_id and mrg.set_code_normalized = cp.set_code_normalized
    where cp.game = p_game
  ),
  legacy_mapping as (
    select printing_id from public.market_provider_printings where provider = 'cardmarket'
  ),
  collection_scope as (
    select ci.id as collection_item_id, pc.has_rarity, pc.in_multi_rarity_group
    from public.collection_items ci
    join public.card_printings cp on cp.id = ci.printing_id and cp.game = p_game
    join printing_canon pc on pc.id = ci.printing_id
  ),
  unknown_rarities as (
    select rarity, count(*) as occurrences
    from public.card_printings
    where game = p_game and nullif(trim(rarity), '') is not null and public.normalize_ygo_rarity(rarity) is null
    group by rarity
    order by count(*) desc, rarity
    limit 100
  ),
  top_groups as (
    select mrg.catalog_card_id, mrg.set_code_normalized, mrg.rarities, mrg.printing_count,
      (select cp2.card_name from public.card_printings cp2
        where cp2.catalog_card_id = mrg.catalog_card_id and cp2.game = p_game limit 1) as card_name,
      (select jsonb_agg(jsonb_build_object('printing_id', cp3.id, 'set_code', cp3.set_code, 'rarity', cp3.rarity) order by cp3.rarity)
        from public.card_printings cp3
        where cp3.catalog_card_id = mrg.catalog_card_id and cp3.set_code_normalized = mrg.set_code_normalized and cp3.game = p_game) as printings
    from multi_rarity_groups mrg
    order by mrg.printing_count desc, mrg.catalog_card_id
    limit 50
  )
  select jsonb_build_object(
    'game', p_game,
    'generated_at', now(),
    'printings_total', (select count(*) from printing_canon),
    'printings_rarity_canonical_known', (select count(*) from printing_canon where rarity_canonical is not null),
    'printings_rarity_canonical_unknown', (select count(*) from printing_canon where rarity_canonical is null),
    'unknown_rarities_sample', (
      select coalesce(jsonb_agg(jsonb_build_object('rarity_raw', rarity, 'occurrences', occurrences)), '[]'::jsonb)
      from unknown_rarities
    ),
    'printings_in_multi_rarity_group', (select count(*) from printing_canon where in_multi_rarity_group),
    'multi_rarity_groups_count', (select count(*) from multi_rarity_groups),
    'multi_rarity_groups_sample', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'catalog_card_id', catalog_card_id, 'card_name', card_name, 'set_code_normalized', set_code_normalized,
        'rarities', rarities, 'printing_count', printing_count, 'printings', printings
      )), '[]'::jsonb)
      from top_groups
    ),
    'collection_items_total', (select count(*) from collection_scope),
    'collection_items_with_rarity', (select count(*) from collection_scope where has_rarity),
    'collection_items_without_rarity', (select count(*) from collection_scope where not has_rarity),
    'collection_items_rarity_deterministic', (select count(*) from collection_scope where not in_multi_rarity_group),
    'collection_items_rarity_ambiguous_family', (select count(*) from collection_scope where in_multi_rarity_group),
    'legacy_cardmarket_mappings_total', (select count(*) from legacy_mapping),
    'legacy_cardmarket_mappings_on_multi_rarity_printings', (
      select count(*) from legacy_mapping lm
      join printing_canon pc on pc.id = lm.printing_id
      where pc.in_multi_rarity_group
    ),
    'note', 'Conteggi solo locali, nessuna chiamata Cardmarket: "mappabili automaticamente" e "review manuale" richiedono di far girare resolveYgoMarketVariant() contro il catalogo Cardmarket reale (fase successiva, non ancora eseguita).'
  ) into result;

  return result;
end;
$$;

revoke all on function public.ygo_market_variant_backfill_report(text, text) from public, anon, authenticated;
grant execute on function public.ygo_market_variant_backfill_report(text, text) to authenticated, anon;

commit;
