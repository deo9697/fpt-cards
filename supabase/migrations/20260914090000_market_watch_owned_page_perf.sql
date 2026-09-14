-- F.P.T Cards — Market Watch: P0 performance su list_market_watch_owned_page.
--
-- CONTESTO REALE (audit prima di questa migration, non assunzioni da note
-- vecchie): la funzione LIVE oggi (supabase/migrations/20260911145101_
-- market_watch_owned_pagination.sql) costruisce, per OGNI chiamata e PRIMA
-- del LIMIT, sull'INTERO insieme owned (post-ricerca):
--   1) mapping_flags — chiama market_mapping_is_active() su TUTTE le righe
--      di market_provider_printings, senza alcun filtro sull'utente che ha
--      chiamato la funzione;
--   2) eligible_snapshots — scansiona TUTTO lo storico di
--      market_price_snapshots per le printing candidate (non solo l'ultimo
--      prezzo), per poter poi derivare sia il reference price (per
--      ordinare "per prezzo"/"per valore") sia il prezzo di 24h fa (per
--      ordinare "per variazione") — SEMPRE ENTRAMBI, indipendentemente da
--      quale p_sort sia stato richiesto davvero.
-- Su una raccolta reale di migliaia di printing questo produce lo spill su
-- temp disk osservato in produzione (~3k temp blocks) e i tempi misurati
-- (list_market_watch_owned_page ≈ 1.97s).
--
-- FIX (additivo, nessuna migration precedente toccata):
--   A) mapping_flags viene ristretto a
--      "where printing_id in (select printing_id from candidates)" — stesso
--      risultato per ogni riga effettivamente usata (mapping_flags non è
--      mai joinata su una printing_id fuori da candidates in nessun punto
--      della funzione, prima o dopo questo fix), ma market_mapping_is_active()
--      non viene più chiamata per l'intero catalogo, solo per le printing
--      dell'utente.
--   B) Il costoso scan whole-set di market_price_snapshots ora dipende dal
--      p_sort richiesto (percorsi SQL distinti, non un'unica query che
--      calcola sempre tutto):
--        - 'name'   -> NESSUN prezzo calcolato prima del LIMIT: si pagina
--          direttamente su candidates (card_name, printing_id).
--        - 'price'/'value' (e qualunque valore non riconosciuto, stesso
--          fallback di oggi) -> serve il reference price sull'intero
--          insieme PRIMA del LIMIT (non è evitabile: bisogna sapere il
--          prezzo di ogni candidato per tagliare la pagina giusta), ma lo
--          storico 24h whole-set NON viene più calcolato affatto (non serve
--          per ordinare per prezzo/valore).
--        - 'change'  -> invariato: servono reference price E 24h
--          sull'intero insieme prima del LIMIT (esplicitamente richiesto,
--          non se ne può fare a meno per ordinare correttamente).
--   C) Una volta note le SOLE printing_id di questa pagina (page_id_array,
--      tipicamente ~60), TUTTI i campi mostrati (reference_price, min_price,
--      price_24h, price_7d, price_30d, providers) vengono ricalcolati SOLO
--      su quelle — stessa identica logica/filtri di prima (mai una fonte
--      diversa, mai un'approssimazione), solo con un input molto più
--      piccolo. Il valore per una data printing_id non dipende mai dalle
--      altre righe dell'insieme candidato: restringere l'input a valle non
--      cambia il risultato per le righe rimaste, lo rende solo più veloce
--      da produrre. price_7d/price_30d erano già calcolati così prima di
--      questa migration (pattern invariato, solo esteso a reference_price/
--      price_24h che prima venivano portati dal calcolo whole-set).
--
-- NON cambiato (garanzia esplicita, verificata riga per riga contro
-- l'originale): l'elenco e l'ordine dei campi in output, la semantica di
-- ricerca/paginazione/ordinamento (compreso il riordino finale
-- "reference_price desc, card_name, printing_id" dei soli item della pagina,
-- IDENTICO indipendentemente da p_sort — comportamento preesistente,
-- confermato dall'audit e mantenuto qui senza modifiche: cambiarlo sarebbe
-- un cambio di comportamento di ordinamento, esplicitamente vietato da
-- questo task), il fallback silenzioso p_sort sconosciuto->value, il
-- clamping di limit/offset, il messaggio/formato di errore di sessione.
-- NON tocca ygo_market_variants/ygo_market_variant_price_shadow/
-- market_price_events/resolver Cardmarket/cron/Edge Functions/alert/
-- market_watch_items, né get_market_watch_summary/list_market_watch_extra/
-- list_market_confirm_queue (stesso identico codice di prima, non
-- ridefinite in questa migration).

begin;

create or replace function public.list_market_watch_owned_page(
  p_token text, p_game text default 'yugioh',
  p_limit integer default 60, p_offset integer default 0,
  p_sort text default 'value', p_query text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  result jsonb;
  safe_limit integer := greatest(1, least(coalesce(p_limit, 60), 200));
  safe_offset integer := greatest(0, coalesce(p_offset, 0));
  safe_query text := nullif(trim(coalesce(p_query, '')), '');
  page_id_array uuid[] := '{}';
  total_count integer := 0;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;

  -- FASE A — determina SOLO le printing_id (e il totale) di questa pagina,
  -- col minimo lavoro necessario per il p_sort richiesto. I valori
  -- effettivamente mostrati (reference_price/price_24h/...) vengono
  -- SEMPRE ricalcolati in FASE B, sulle sole printing_id qui ottenute —
  -- mai riusati direttamente da qui, anche quando già calcolati (branch
  -- 'change'), per avere un'unica fonte di verità per il payload finale.
  if p_sort = 'name' then
    with owned as (
      select ci.printing_id, sum(ci.quantity_owned)::integer as quantity
      from public.collection_items ci
      join public.card_printings cp on cp.id = ci.printing_id
      where ci.owner_slug = me and cp.game = p_game
      group by ci.printing_id
    ), candidates as (
      select o.printing_id, o.quantity, cp.catalog_card_id, cp.card_name, cp.set_code,
        cp.set_name, cp.rarity, cp.image_url
      from owned o
      join public.card_printings cp on cp.id = o.printing_id
      where safe_query is null
        or cp.card_name ilike '%' || safe_query || '%'
        or cp.set_code ilike '%' || safe_query || '%'
        or cp.set_name ilike '%' || safe_query || '%'
        or cp.rarity ilike '%' || safe_query || '%'
    ), paged as (
      select printing_id, count(*) over()::integer as page_total
      from candidates
      order by card_name asc nulls last, printing_id
      limit safe_limit offset safe_offset
    )
    select coalesce(array_agg(printing_id), '{}'), coalesce(max(page_total), 0)
      into page_id_array, total_count
    from paged;

  elsif p_sort = 'change' then
    -- Invariato rispetto a oggi: 'change' ha sempre bisogno sia del
    -- reference price sia del 24h sull'intero insieme candidato prima del
    -- LIMIT, per poterlo ordinare correttamente — nessun risparmio
    -- possibile qui, solo l'isolamento in un proprio percorso e la stessa
    -- restrizione di mapping_flags (B) applicata anche a questo branch.
    with owned as (
      select ci.printing_id, sum(ci.quantity_owned)::integer as quantity
      from public.collection_items ci
      join public.card_printings cp on cp.id = ci.printing_id
      where ci.owner_slug = me and cp.game = p_game
      group by ci.printing_id
    ), candidates as (
      select o.printing_id, o.quantity, cp.catalog_card_id, cp.card_name, cp.set_code,
        cp.set_name, cp.rarity, cp.image_url
      from owned o
      join public.card_printings cp on cp.id = o.printing_id
      where safe_query is null
        or cp.card_name ilike '%' || safe_query || '%'
        or cp.set_code ilike '%' || safe_query || '%'
        or cp.set_name ilike '%' || safe_query || '%'
        or cp.rarity ilike '%' || safe_query || '%'
    ), mapping_flags as materialized (
      select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active,
        (resolution_status = 'manual' or (resolution_status = 'resolved'
          and coalesce(provider_metadata->>'active', 'false') = 'true'
          and provider_metadata->>'resolverStatus' = 'EXACT')) derived
      from public.market_provider_printings
      where printing_id in (select printing_id from candidates)
    ), eligible_snapshots as materialized (
      select s.printing_id, s.provider, s.price_type, s.normalized_price,
        s.normalized_currency, s.captured_at, f.active, f.derived
      from public.market_price_snapshots s
      join candidates c on c.printing_id = s.printing_id
      join mapping_flags f on f.id = s.provider_mapping_id
      where not s.is_anomalous and s.normalized_price is not null and (f.active or f.derived)
    ), preferred as (
      select distinct on (s.printing_id, s.provider) s.*
      from eligible_snapshots s where s.active and s.normalized_currency = 'EUR'
      order by s.printing_id, s.provider, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
    ), reference as (
      select distinct on (printing_id) printing_id, normalized_price
      from preferred order by printing_id, public.market_reference_type(provider, price_type)
    ), history_24h as (
      select distinct on (printing_id) printing_id, normalized_price
      from eligible_snapshots where derived and captured_at <= now() - interval '24 hours'
      order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
    ), scored as (
      select c.printing_id, ref.normalized_price as reference_price, h24.normalized_price as price_24h
      from candidates c
      left join reference ref on ref.printing_id = c.printing_id
      left join history_24h h24 on h24.printing_id = c.printing_id
    ), paged as (
      select printing_id, count(*) over()::integer as page_total
      from scored
      order by
        case when reference_price is not null and price_24h is not null and price_24h <> 0
          then reference_price - price_24h end desc nulls last,
        printing_id
      limit safe_limit offset safe_offset
    )
    select coalesce(array_agg(printing_id), '{}'), coalesce(max(page_total), 0)
      into page_id_array, total_count
    from paged;

  else
    -- 'price' e il fallback 'value' (più qualunque p_sort non riconosciuto,
    -- stesso comportamento di oggi): condividono lo stesso reference price
    -- whole-set (serve comunque prima del LIMIT), ma qui NON serve affatto
    -- lo storico 24h whole-set — risparmio reale rispetto a oggi, che lo
    -- calcolava sempre anche per questi due sort.
    with owned as (
      select ci.printing_id, sum(ci.quantity_owned)::integer as quantity
      from public.collection_items ci
      join public.card_printings cp on cp.id = ci.printing_id
      where ci.owner_slug = me and cp.game = p_game
      group by ci.printing_id
    ), candidates as (
      select o.printing_id, o.quantity, cp.catalog_card_id, cp.card_name, cp.set_code,
        cp.set_name, cp.rarity, cp.image_url
      from owned o
      join public.card_printings cp on cp.id = o.printing_id
      where safe_query is null
        or cp.card_name ilike '%' || safe_query || '%'
        or cp.set_code ilike '%' || safe_query || '%'
        or cp.set_name ilike '%' || safe_query || '%'
        or cp.rarity ilike '%' || safe_query || '%'
    ), mapping_flags as materialized (
      select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active
      from public.market_provider_printings
      where printing_id in (select printing_id from candidates)
    ), eligible_active as materialized (
      -- Solo 'active' (mai 'derived'): il 24h whole-set non serve qui,
      -- quindi non calcoliamo affatto il flag/le righe derived.
      select s.printing_id, s.provider, s.price_type, s.normalized_price, s.captured_at
      from public.market_price_snapshots s
      join candidates c on c.printing_id = s.printing_id
      join mapping_flags f on f.id = s.provider_mapping_id
      where not s.is_anomalous and s.normalized_price is not null
        and s.normalized_currency = 'EUR' and f.active
    ), preferred as (
      select distinct on (s.printing_id, s.provider) s.*
      from eligible_active s
      order by s.printing_id, s.provider, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
    ), reference as (
      select distinct on (printing_id) printing_id, normalized_price
      from preferred order by printing_id, public.market_reference_type(provider, price_type)
    ), scored as (
      select c.printing_id, c.quantity, ref.normalized_price as reference_price
      from candidates c left join reference ref on ref.printing_id = c.printing_id
    ), paged as (
      select printing_id, count(*) over()::integer as page_total
      from scored
      order by
        case when p_sort = 'price' then reference_price end desc nulls last,
        case when p_sort <> 'price' then coalesce(reference_price, -1) * quantity end desc nulls last,
        printing_id
      limit safe_limit offset safe_offset
    )
    select coalesce(array_agg(printing_id), '{}'), coalesce(max(page_total), 0)
      into page_id_array, total_count
    from paged;
  end if;

  -- FASE B — identica per qualunque p_sort: dati "ricchi" (providers,
  -- mapping, storico) SOLO sulle printing_id di questa pagina (~60), MAI
  -- sull'insieme candidato completo. page_history/page_history_7d/
  -- page_history_30d/latest_page_prices/page_flagged/page_preferred/
  -- page_lowest sono ESATTAMENTE le stesse CTE già presenti prima di questa
  -- migration (stesso testo, stessi filtri) — solo page_active_snapshots/
  -- page_reference/page_history_24h sono nuove, per calcolare qui (invece
  -- che riportarle dal whole-set di FASE A) reference_price/price_24h con
  -- la stessa identica logica/priorità di sempre.
  with page_ids as (
    select unnest(page_id_array) as printing_id
  ), candidates as (
    select pi.printing_id, coalesce(cq.quantity, 0) as quantity, cp.catalog_card_id, cp.card_name,
      cp.set_code, cp.set_name, cp.rarity, cp.image_url
    from page_ids pi
    join public.card_printings cp on cp.id = pi.printing_id
    left join (
      select printing_id, sum(quantity_owned)::integer as quantity
      from public.collection_items where owner_slug = me group by printing_id
    ) cq on cq.printing_id = pi.printing_id
  ), mapping_flags as materialized (
    select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active,
      (resolution_status = 'manual' or (resolution_status = 'resolved'
        and coalesce(provider_metadata->>'active', 'false') = 'true'
        and provider_metadata->>'resolverStatus' = 'EXACT')) derived
    from public.market_provider_printings
    where printing_id in (select printing_id from page_ids)
  ), latest_page_prices as (
    select lp.* from public.market_latest_prices lp
    join page_ids pi on pi.printing_id = lp.printing_id
  ), page_flagged as (
    select l.*, f.active from latest_page_prices l join mapping_flags f on f.id = l.provider_mapping_id
  ), page_preferred as (
    select distinct on (printing_id, provider) *
    from page_flagged where active and normalized_currency = 'EUR'
    order by printing_id, provider, public.market_reference_type(provider, price_type), captured_at desc
  ), page_lowest as (
    select distinct on (printing_id) printing_id, normalized_price
    from page_flagged where active and provider = 'cardmarket' and price_type in ('low', 'lowest') and normalized_currency = 'EUR'
    order by printing_id, captured_at desc
  ), page_active_snapshots as (
    -- Equivalente page-scoped di eligible_active in FASE A (branch
    -- price/value) e della parte 'active' di eligible_snapshots in FASE A
    -- (branch change)/nella versione precedente di questa funzione: stesso
    -- filtro, stessa fonte (market_price_snapshots), solo ristretto alle
    -- printing_id della pagina.
    select s.printing_id, s.provider, s.price_type, s.normalized_price, s.captured_at
    from public.market_price_snapshots s
    join page_ids pi on pi.printing_id = s.printing_id
    join mapping_flags f on f.id = s.provider_mapping_id
    where not s.is_anomalous and s.normalized_price is not null
      and s.normalized_currency = 'EUR' and f.active
  ), page_active_preferred as (
    select distinct on (s.printing_id, s.provider) s.*
    from page_active_snapshots s
    order by s.printing_id, s.provider, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
  ), page_reference as (
    select distinct on (printing_id) printing_id, normalized_price
    from page_active_preferred order by printing_id, public.market_reference_type(provider, price_type)
  ), page_history as (
    -- Invariata rispetto a prima di questa migration (stesso filtro
    -- f.derived, stessa fonte, stesso scope su page_ids).
    select s.printing_id, s.price_type, s.provider, s.normalized_price, s.captured_at, f.derived
    from public.market_price_snapshots s
    join page_ids pi on pi.printing_id = s.printing_id
    join mapping_flags f on f.id = s.provider_mapping_id
    where not s.is_anomalous and s.normalized_price is not null and f.derived
  ), page_history_24h as (
    -- Nuova: stessa identica logica della history_24h whole-set di prima,
    -- solo ristretta a page_history (già page-scoped).
    select distinct on (printing_id) printing_id, normalized_price
    from page_history where captured_at <= now() - interval '24 hours'
    order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
  ), page_history_7d as (
    select distinct on (printing_id) printing_id, normalized_price
    from page_history where captured_at <= now() - interval '7 days'
    order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
  ), page_history_30d as (
    select distinct on (printing_id) printing_id, normalized_price
    from page_history where captured_at <= now() - interval '30 days'
    order by printing_id, public.market_reference_type(provider, price_type), captured_at desc
  ), rows as (
    select c.printing_id, c.catalog_card_id, c.card_name, c.set_code, c.set_name, c.rarity, c.image_url,
      c.quantity as owned_quantity,
      coalesce(jsonb_object_agg(pp.provider, jsonb_build_object('price', pp.normalized_price, 'type', pp.price_type, 'currency', pp.normalized_currency, 'capturedAt', pp.captured_at, 'conditionReference', pp.condition_reference)) filter (where pp.provider is not null), '{}'::jsonb) providers,
      pr.normalized_price reference_price, lo.normalized_price min_price, h24.normalized_price price_24h,
      h7.normalized_price price_7d, h30.normalized_price price_30d,
      coalesce(cm.resolution_status, 'unresolved') mapping_status,
      coalesce(cm.provider_metadata->>'resolverStatus', cm.resolution_status, 'unresolved') resolver_status,
      case when cm.provider_metadata->>'resolverVersion' ~ '^[0-9]+$' then (cm.provider_metadata->>'resolverVersion')::integer end resolver_version,
      cm.provider_metadata->'priceScope' price_scope,
      cm.provider_metadata->'priceScope'->>'language' language_scope,
      cm.provider_metadata->'priceScope'->>'edition' edition_scope,
      cm.provider_metadata->'priceScope'->>'rarity' rarity_scope,
      cm.provider_metadata->'priceScope'->>'foil' foil_scope,
      cm.provider_metadata->>'reason' mapping_reason,
      cm.provider_product_id cardmarket_product_id,
      coalesce(cm.provider_metadata->>'productUrl', case when cm.provider_product_id is not null then 'https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct='||cm.provider_product_id end) cardmarket_url
    from candidates c
    left join page_preferred pp on pp.printing_id = c.printing_id
    left join page_lowest lo on lo.printing_id = c.printing_id
    left join page_reference pr on pr.printing_id = c.printing_id
    left join page_history_24h h24 on h24.printing_id = c.printing_id
    left join page_history_7d h7 on h7.printing_id = c.printing_id
    left join page_history_30d h30 on h30.printing_id = c.printing_id
    left join public.market_provider_printings cm on cm.printing_id = c.printing_id and cm.provider = 'cardmarket' and cm.variant_key = 'default'
    group by c.printing_id, c.catalog_card_id, c.card_name, c.set_code, c.set_name, c.rarity, c.image_url, c.quantity,
      pr.normalized_price, lo.normalized_price, h24.normalized_price, h7.normalized_price, h30.normalized_price,
      cm.resolution_status, cm.provider_product_id, cm.provider_metadata
  )
  -- Stesso riordino finale di sempre (comportamento preesistente, non
  -- toccato): reference_price desc, card_name, printing_id — indipendente
  -- da p_sort. total/limit/offset arrivano da FASE A, non ricalcolati qui.
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(to_jsonb(rows) order by reference_price desc nulls last, card_name, printing_id), '[]'::jsonb),
    'total', total_count, 'limit', safe_limit, 'offset', safe_offset
  ) into result from rows;

  return coalesce(result, jsonb_build_object('items', '[]'::jsonb, 'total', total_count, 'limit', safe_limit, 'offset', safe_offset));
end;
$$;

revoke all on function public.list_market_watch_owned_page(text,text,integer,integer,text,text) from public, anon, authenticated;
grant execute on function public.list_market_watch_owned_page(text,text,integer,integer,text,text) to anon, authenticated;

-- Indice diretto a supporto della nuova restrizione "where printing_id in
-- (select printing_id from candidates/page_ids)" su market_provider_printings
-- in mapping_flags (sezione A del fix sopra): senza indice, anche con
-- questa restrizione Postgres continuerebbe a evitare la chiamata
-- market_mapping_is_active() per le righe fuori dal set semi-join grazie al
-- filtro WHERE (il guadagno principale, indipendente dall'indice), ma un
-- indice qui evita anche la scansione sequenziale della tabella per
-- verificare l'appartenenza. Aggiunto SOLO perché introdotto da questa
-- stessa migration (pattern di accesso nuovo, non preesistente) — non
-- essendoci accesso a EXPLAIN da questa sessione, verificare con
-- EXPLAIN (ANALYZE, BUFFERS) dopo l'applicazione che sia effettivamente
-- utilizzato; if not exists lo rende comunque sicuro anche se l'indice
-- esistesse già live con un altro nome.
create index if not exists market_provider_printings_printing_id_idx
  on public.market_provider_printings(printing_id);

commit;
