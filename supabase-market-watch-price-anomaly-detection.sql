-- F.P.T Cards — Market Watch: anomaly detection sui nuovi price snapshot.
-- Migrazione additiva: eseguire dopo supabase-mw1-market-mapping-integrity.sql.
--
-- Scelta: rileva e nascondi finché non confermato manualmente. Un nuovo
-- snapshot che si sposta oltre una soglia rispetto all'ultimo snapshot noto
-- per la stessa (printing_id, provider, price_type) viene comunque salvato
-- (audit/storico), ma is_anomalous=true lo esclude da
-- market_active_price_snapshots/market_derived_price_snapshots finché un
-- membro non lo conferma esplicitamente — niente prezzo palesemente sbagliato
-- (es. una mappatura Cardmarket andata storta) mostrato nel frattempo.
-- Soglia: rapporto nuovo/precedente >5x o <0.1x (entrambe le direzioni).

alter table public.market_price_snapshots
  add column if not exists is_anomalous boolean not null default false,
  add column if not exists anomaly_ratio numeric(10,4);

create or replace function public.trg_flag_price_anomaly()
returns trigger language plpgsql set search_path = public, extensions as $$
declare prior_price numeric(14,4); new_value numeric(14,4); ratio numeric(10,4);
begin
  new_value := coalesce(new.normalized_price, new.original_price);
  if new_value is null or new_value <= 0 then return new; end if;

  select coalesce(normalized_price, original_price) into prior_price
    from public.market_price_snapshots
    where printing_id = new.printing_id and provider = new.provider and price_type = new.price_type
      and id <> new.id
    order by captured_at desc, id desc
    limit 1;

  if prior_price is null or prior_price <= 0 then return new; end if;

  ratio := new_value / prior_price;
  if ratio > 5 or ratio < 0.1 then
    new.is_anomalous := true;
    new.anomaly_ratio := ratio;
  end if;
  return new;
end;
$$;

drop trigger if exists flag_price_anomaly on public.market_price_snapshots;
create trigger flag_price_anomaly before insert on public.market_price_snapshots
for each row execute function public.trg_flag_price_anomaly();

-- Le view MW1 escludono ora anche gli snapshot anomali non confermati.
create or replace view public.market_active_price_snapshots
with (security_invoker=true) as
select s.*
from public.market_price_snapshots s
join public.market_provider_printings mp on mp.id=s.provider_mapping_id
where public.market_mapping_is_active(mp.provider,mp.resolution_status,mp.provider_metadata)
  and not s.is_anomalous;

create or replace view public.market_derived_price_snapshots
with (security_invoker=true) as
select s.*
from public.market_price_snapshots s
join public.market_provider_printings mp on mp.id=s.provider_mapping_id
where (
    mp.resolution_status='manual'
    or (
      mp.resolution_status='resolved'
      and coalesce(mp.provider_metadata->>'active','false')='true'
      and mp.provider_metadata->>'resolverStatus'='EXACT'
    )
  )
  and not s.is_anomalous;

-- market_latest_prices eredita già l'esclusione via market_active_price_snapshots
-- (CREATE OR REPLACE non necessario, nessuna colonna cambiata lì).

create or replace function public.list_market_price_anomalies(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select jsonb_agg(jsonb_build_object(
    'id', s.id, 'printingId', s.printing_id, 'cardName', cp.card_name, 'setCode', cp.set_code,
    'rarity', cp.rarity, 'priceType', s.price_type, 'provider', s.provider,
    'newPrice', coalesce(s.normalized_price, s.original_price), 'currency', s.normalized_currency,
    'ratio', s.anomaly_ratio, 'capturedAt', s.captured_at
  ) order by s.captured_at desc)
  into result
  from public.market_price_snapshots s
  join public.card_printings cp on cp.id = s.printing_id
  where s.is_anomalous
  limit 200;
  return coalesce(result, '[]'::jsonb);
end;
$$;

create or replace function public.confirm_market_price_anomaly(p_token text, p_snapshot_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  update public.market_price_snapshots set is_anomalous = false where id = p_snapshot_id and is_anomalous;
end;
$$;

revoke all on function public.list_market_price_anomalies(text), public.confirm_market_price_anomaly(text,uuid) from public,anon,authenticated;
grant execute on function public.list_market_price_anomalies(text), public.confirm_market_price_anomaly(text,uuid) to anon,authenticated;

notify pgrst, 'reload schema';
