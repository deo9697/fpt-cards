-- F.P.T Cards — Shared Collection guest: restyle porta bisogno di più metadati
-- per ogni printing (rarità/edizione/condizione/lingua, disponibilità reale al
-- netto di prestiti/prenotazioni, conteggi carte/stampe) e di un messaggio
-- opzionale sulla richiesta. Migrazione additiva: eseguire dopo
-- supabase-collection-sharing.sql, supabase-collection-share-alternate-names.sql
-- e supabase-collection-share-request-prices.sql.
--
-- Non cambia ownership, RLS o la logica prestiti: riusa collection_item_loaned/
-- collection_item_reserved già introdotte da supabase-milestone-2-collection.sql
-- per calcolare una quantità "guest-safe" (solo il numero disponibile, mai il
-- dettaglio dei prestiti). Non tocca submit_collection_share_request se non per
-- aggiungere il messaggio opzionale in coda, con default null: le chiamate
-- esistenti a 3 argomenti restano valide dal lato client via PostgREST (invio
-- named params), ma la firma cambia — la vecchia funzione viene sostituita.

-- 1) Messaggio opzionale sulla richiesta, nullable, nessuna regressione sulle
-- richieste esistenti (restano con message = null).
alter table public.collection_share_requests
  add column if not exists message text check (char_length(message) <= 250);

-- 2) get_collection_share: stessa forma/raggruppamento per printing_id di
-- prima (un tile per stampa fisica, non per riga collection_items — lo schema
-- delle richieste registra solo printing_id, quindi la selezione guest deve
-- restare a quel livello), ma ora espone anche edition/condition/language
-- (solo quando univoci tra le copie della stessa stampa: se il proprietario
-- possiede la stessa stampa in condizioni miste non inventiamo un valore),
-- quantityAvailable (netta di prestiti/prenotazioni) e i conteggi per la hero.
create or replace function public.get_collection_share(p_share_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare share public.collection_shares; owner_name text; items jsonb; card_count integer; printing_count integer;
begin
  select * into share from public.collection_shares where id = p_share_id and revoked_at is null;
  if not found then raise exception 'Link non valido o revocato'; end if;
  select full_name into owner_name from public.team_members where slug = share.owner_slug;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'printingId', row.printing_id, 'cardName', row.card_name, 'setCode', row.set_code, 'setName', row.set_name,
      'rarity', row.rarity, 'imageUrl', row.image_url,
      'quantityOwned', row.quantity_owned, 'quantityAvailable', row.quantity_available,
      'edition', row.edition, 'condition', row.condition, 'language', row.language,
      'alternateNames', coalesce(row.alt_names, '[]'::jsonb)
    ) order by row.card_name), '[]'::jsonb),
    count(distinct row.printing_id), count(distinct row.catalog_card_id)
  into items, printing_count, card_count
  from (
    select
      p.id printing_id, p.card_name, p.set_code, p.set_name, p.rarity, p.image_url, p.catalog_card_id,
      sum(ci.quantity_owned)::integer quantity_owned,
      sum(greatest(ci.quantity_owned
        - public.collection_item_loaned(ci.id) - public.collection_item_reserved(ci.id), 0))::integer quantity_available,
      case when count(distinct nullif(trim(ci.edition), '')) = 1 then min(nullif(trim(ci.edition), '')) end edition,
      case when count(distinct ci.condition) = 1 then min(ci.condition) end condition,
      case when count(distinct ci.language) = 1 then min(ci.language) end language,
      alt.names alt_names
    from public.collection_items ci
    join public.card_printings p on p.id = ci.printing_id
    left join lateral (
      select jsonb_agg(distinct other.card_name) as names
      from public.card_printings other
      where other.game = p.game and other.catalog_card_id = p.catalog_card_id
        and lower(trim(other.card_name)) <> lower(trim(p.card_name))
    ) alt on true
    where ci.owner_slug = share.owner_slug and p.game = share.game
    group by p.id, p.card_name, p.set_code, p.set_name, p.rarity, p.image_url, p.catalog_card_id, alt.names
  ) row;

  return jsonb_build_object(
    'ownerName', coalesce(owner_name,'Un membro del team'), 'game', share.game, 'items', items,
    'cardCount', coalesce(card_count, 0), 'printingCount', coalesce(printing_count, 0)
  );
end;
$$;

-- 3) submit_collection_share_request: stessa validazione di prima, più
-- p_message opzionale (default null, troncato a 250 caratteri, stringa vuota
-- normalizzata a null). La firma cambia (nuovo parametro) quindi la vecchia
-- va rimossa esplicitamente prima di ricrearla, altrimenti Postgres le
-- tratterebbe come due overload distinti.
drop function if exists public.submit_collection_share_request(uuid, text, jsonb);

create or replace function public.submit_collection_share_request(
  p_share_id uuid, p_requester_name text, p_items jsonb, p_message text default null
)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare share public.collection_shares; request_id uuid; item jsonb; valid_count integer := 0; clean_message text;
begin
  select * into share from public.collection_shares where id = p_share_id and revoked_at is null;
  if not found then raise exception 'Link non valido o revocato'; end if;
  if coalesce(trim(p_requester_name), '') = '' then raise exception 'Nome mancante'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 50 then
    raise exception 'Numero di carte richieste non valido';
  end if;
  clean_message := nullif(left(trim(coalesce(p_message, '')), 250), '');

  insert into public.collection_share_requests(share_id, requester_name, message)
    values (share.id, left(trim(p_requester_name), 80), clean_message) returning id into request_id;

  for item in select * from jsonb_array_elements(p_items) loop
    if not exists (
      select 1 from public.collection_items ci
      where ci.owner_slug = share.owner_slug and ci.printing_id = (item->>'printingId')::uuid
    ) then continue; end if;
    insert into public.collection_share_request_items(request_id, printing_id, quantity)
      values (request_id, (item->>'printingId')::uuid, greatest(1, least(99, coalesce((item->>'quantity')::integer, 1))));
    valid_count := valid_count + 1;
  end loop;

  if valid_count = 0 then raise exception 'Nessuna carta valida nella richiesta'; end if;

  -- notifications only exists if supabase-notifications-center.sql has been
  -- applied — it's optional, so don't let a missing table fail the request.
  -- Testo/logica push invariati: il messaggio si legge dalla richiesta stessa.
  begin
    insert into public.notifications(member_slug, category, title, body, route_page, route_params, dedup_key, source_table, source_id)
    values (
      share.owner_slug, 'share_request', 'Nuova richiesta dalla tua raccolta',
      left(trim(p_requester_name), 80) || ' è interessato a ' || valid_count || ' cart' || (case when valid_count = 1 then 'a' else 'e' end),
      'requests', jsonb_build_object('requestId', request_id), 'share_request:' || request_id,
      'collection_share_requests', request_id
    )
    on conflict (member_slug, dedup_key) do nothing;
  exception when undefined_table then null;
  end;

  return request_id;
end;
$$;

-- 4) list_collection_share_requests: stessa struttura già ottimizzata da
-- supabase-collection-share-requests-optimize.sql, con 'message' in più.
create or replace function public.list_collection_share_requests(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'requesterName', r.requester_name, 'status', r.status, 'createdAt', r.created_at, 'game', s.game,
    'message', r.message, 'items', ri.items, 'totalPrice', ri.total_price
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

revoke all on function
  public.get_collection_share(uuid), public.submit_collection_share_request(uuid,text,jsonb,text),
  public.list_collection_share_requests(text)
  from public, anon, authenticated;

grant execute on function public.list_collection_share_requests(text) to anon, authenticated;
grant execute on function
  public.get_collection_share(uuid), public.submit_collection_share_request(uuid,text,jsonb,text)
  to anon, authenticated;

notify pgrst, 'reload schema';
