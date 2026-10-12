-- F.P.T Cards — Exact Variant Pricing: cutover del prezzo live.
--
-- market-sync ora restringe un mapping Cardmarket aggregate (più V.n della
-- stessa carta, prezzo = minimo tra le rarità) al SOLO product_id della
-- variante risolta in ygo_market_variants. Il primo snapshot "exact" di una
-- Starlight/Quarter Century può valere >5x l'ultimo snapshot "minimo": il
-- trigger di anomaly detection lo segnerebbe is_anomalous e il prezzo
-- corretto resterebbe nascosto finché qualcuno non lo conferma a mano.
--
-- Qui il confronto avviene solo tra snapshot con lo STESSO priceScope.product
-- (metadata->'priceScope'->>'product'). Quando lo scope cambia (es. da
-- 'minimum_across_candidates' a 'exact_variant') il nuovo prezzo non viene
-- confrontato con quello vecchio: è un cambio di identità del prodotto, non
-- un movimento di mercato. Tra due snapshot dello stesso scope la soglia
-- >5x / <0.1x resta identica a prima.
--
-- Additiva: ridefinisce solo la funzione del trigger, nessuna tabella/vista.

create or replace function public.trg_flag_price_anomaly()
returns trigger language plpgsql set search_path = public, extensions as $$
declare prior_price numeric(14,4); prior_scope text; new_scope text; new_value numeric(14,4); ratio numeric(10,4);
begin
  new_value := coalesce(new.normalized_price, new.original_price);
  if new_value is null or new_value <= 0 then return new; end if;

  select coalesce(normalized_price, original_price), metadata->'priceScope'->>'product'
    into prior_price, prior_scope
    from public.market_price_snapshots
    where printing_id = new.printing_id and provider = new.provider and price_type = new.price_type
      and id <> new.id
    order by captured_at desc, id desc
    limit 1;

  if prior_price is null or prior_price <= 0 then return new; end if;

  new_scope := new.metadata->'priceScope'->>'product';
  if new_scope is distinct from prior_scope and 'exact_variant' in (coalesce(new_scope, ''), coalesce(prior_scope, '')) then
    return new;
  end if;

  ratio := new_value / prior_price;
  if ratio > 5 or ratio < 0.1 then
    new.is_anomalous := true;
    new.anomaly_ratio := ratio;
  end if;
  return new;
end;
$$;
