-- F.P.T Cards — P0: il dettaglio Raccolta mostrava "Prezzo non disponibile"
-- per printing che HANNO un prezzo reale nel DB, semplicemente perché Market
-- Watch ora pagina lato server (~60 printing caricate inizialmente) e il
-- dettaglio cercava il prezzo SOLO dentro marketWatch.allLoadedItems() — un
-- bug frontend/data-access, non un problema di dati (~2765/2796 printing
-- possedute hanno prezzo corrente nel DB).
--
-- Nessuna RPC esistente permette un lookup mirato per UNA sola printing
-- senza scandire/paginare l'intera Raccolta owned (list_market_watch_owned_
-- page/list_market_watch_extra/get_market_watch_summary sono tutte pensate
-- per un insieme, non per un singolo id). Questa migration aggiunge la
-- soluzione minima: una funzione che calcola il reference price di UNA
-- printing, riusando ESATTAMENTE la stessa catena preferred/reference già
-- in vigore (market_current_price_snapshots + market_mapping_is_active +
-- market_reference_type, EUR-only, captured_at desc come tie-break) —
-- copiata 1:1 dalla Fase B di list_market_watch_owned_page
-- (20260914210000_market_watch_current_price_cutover.sql), MAI una seconda
-- logica di selezione prezzo.
--
-- Costo: un lookup per printing_id singolo, coperto dall'indice esistente
-- market_current_price_snapshots_printing_idx (20260914200000) — non scandisce
-- né pagina l'insieme owned, non tocca market_price_snapshots (storico).

create or replace function public.get_market_watch_item_price(p_token text, p_printing_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_printing_id is null then raise exception 'Printing non valida'; end if;

  with mapping_flags as materialized (
    select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active
    from public.market_provider_printings
    where printing_id = p_printing_id
  ), eligible_current as (
    select c.provider, c.price_type, c.normalized_price, c.captured_at
    from public.market_current_price_snapshots c
    join mapping_flags f on f.id = c.provider_mapping_id
    where c.printing_id = p_printing_id and f.active
      and c.normalized_currency = 'EUR' and c.normalized_price is not null
  ), preferred as (
    select distinct on (provider) provider, price_type, normalized_price, captured_at
    from eligible_current
    order by provider, public.market_reference_type(provider, price_type), captured_at desc
  ), reference as (
    select normalized_price, captured_at
    from preferred
    order by public.market_reference_type(provider, price_type)
    limit 1
  )
  select jsonb_build_object(
    'printingId', p_printing_id,
    'referencePrice', (select normalized_price from reference),
    'capturedAt', (select captured_at from reference)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_market_watch_item_price(text,uuid) from public, anon, authenticated;
grant execute on function public.get_market_watch_item_price(text,uuid) to anon, authenticated;

notify pgrst, 'reload schema';
