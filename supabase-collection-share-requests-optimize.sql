-- Ottimizzazione: list_collection_share_requests calcolava il prezzo di ogni
-- carta due volte (una per "items", una identica per "totalPrice"), con due
-- lateral join separati su market_latest_prices per ogni riga. Unificato in
-- un solo lateral per richiesta che calcola entrambi insieme — stesso
-- risultato, metà del lavoro di lookup prezzi.
-- Nessuna modifica a firma/permessi: create or replace su una firma
-- invariata preserva i grant già impostati, quindi qui non li si tocca.

create or replace function public.list_collection_share_requests(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'requesterName', r.requester_name, 'status', r.status, 'createdAt', r.created_at, 'game', s.game,
    'items', ri.items, 'totalPrice', ri.total_price
  ) order by r.created_at desc), '[]'::jsonb) into result
  from public.collection_share_requests r
  join public.collection_shares s on s.id = r.share_id
  join lateral (
    select
      jsonb_agg(jsonb_build_object(
        'printingId', p.id, 'cardName', p.card_name, 'setCode', p.set_code, 'rarity', p.rarity,
        'imageUrl', p.image_url, 'quantity', i.quantity, 'unitPrice', ip.unit_price
      )) items,
      round(sum(ip.unit_price * i.quantity), 2) total_price
    from public.collection_share_request_items i
    join public.card_printings p on p.id = i.printing_id
    left join lateral (
      select mp.normalized_price unit_price
      from public.market_latest_prices mp
      where mp.printing_id = p.id and mp.normalized_currency = 'EUR' and mp.normalized_price is not null
      order by public.market_reference_type(mp.provider, mp.price_type), mp.captured_at desc
      limit 1
    ) ip on true
    where i.request_id = r.id
  ) ri on true
  where s.owner_slug = me;
  return result;
end;
$$;

notify pgrst, 'reload schema';
