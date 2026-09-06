-- F.P.T Cards — prezzo per carta e totale stimato sulle richieste ricevute
-- dalla raccolta condivisa, per la vista "a scontrino" in Richieste.
-- Riusa esattamente la stessa logica di list_market_watch per scegliere UN
-- prezzo di riferimento per carta (market_latest_prices + market_reference_type,
-- lo stesso "tier attivo" — aggregato incluso — che il resto di Market Watch
-- già mostra), così il totale coincide con quello che l'utente vede altrove.

create or replace function public.list_collection_share_requests(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'requesterName', r.requester_name, 'status', r.status, 'createdAt', r.created_at, 'game', s.game,
    'items', (
      select jsonb_agg(jsonb_build_object(
        'printingId', p.id, 'cardName', p.card_name, 'setCode', p.set_code, 'rarity', p.rarity,
        'imageUrl', p.image_url, 'quantity', i.quantity, 'unitPrice', ip.unit_price
      ))
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
    ),
    'totalPrice', (
      select round(sum(ip.unit_price * i.quantity), 2)
      from public.collection_share_request_items i
      join public.card_printings p on p.id = i.printing_id
      join lateral (
        select mp.normalized_price unit_price
        from public.market_latest_prices mp
        where mp.printing_id = p.id and mp.normalized_currency = 'EUR' and mp.normalized_price is not null
        order by public.market_reference_type(mp.provider, mp.price_type), mp.captured_at desc
        limit 1
      ) ip on true
      where i.request_id = r.id
    )
  ) order by r.created_at desc), '[]'::jsonb) into result
  from public.collection_share_requests r join public.collection_shares s on s.id = r.share_id
  where s.owner_slug = me;
  return result;
end;
$$;

-- Ripetuto per sicurezza: create or replace su una funzione con la stessa
-- firma preserva i grant esistenti, ma l'ultima volta un grant non è
-- rimasto applicato per motivi mai confermati — meglio essere espliciti.
revoke all on function public.list_collection_share_requests(text) from public, anon, authenticated;
grant execute on function public.list_collection_share_requests(text) to authenticated;

notify pgrst, 'reload schema';
