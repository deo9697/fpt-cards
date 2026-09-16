-- F.P.T Cards — Shared Collection "Richieste": prezzo snapshot + state
-- machine reale (pending -> confirmed -> completed, con cancelled opzionale)
-- al posto del solo "pending/seen" attuale, dove "seen" significava solo
-- "il proprietario l'ha aperta", non un impegno reale sulle copie.
--
-- ===========================================================================
-- 1) PREZZO SNAPSHOT (bug: list_collection_share_requests oggi calcola il
--    prezzo DAL VIVO al momento in cui il proprietario apre Richieste, non al
--    momento dell'invio — se il prezzo di mercato cambia nel frattempo, il
--    "totale stimato" mostrato al proprietario non è più quello che il guest
--    ha visto quando ha inviato la richiesta).
--
--    Fix: submit_collection_share_request ora cattura il prezzo di
--    riferimento (stessa astrazione di Market Watch: market_latest_prices +
--    market_reference_type per scegliere UN prezzo per printing, stesso
--    ordine di tier già usato altrove) UNA VOLTA per printing, al momento
--    dell'insert, e lo salva su collection_share_request_items. Da qui in
--    avanti list_collection_share_requests legge SOLO questo snapshot, mai
--    più un prezzo live: il totale che il proprietario vede resta coerente
--    con quello mostrato al guest al momento dell'invio, anche se il prezzo
--    di mercato è cambiato dopo.
--
--    Se non esiste un prezzo affidabile per una printing, tutte e tre le
--    colonne restano NULL — la richiesta resta comunque creabile (mai
--    bloccata da un prezzo mancante) e la UI mostra "n/d", mai zero.
-- ===========================================================================
alter table public.collection_share_request_items
  add column if not exists unit_price_snapshot numeric;
alter table public.collection_share_request_items
  add column if not exists price_type_snapshot text;
alter table public.collection_share_request_items
  add column if not exists price_captured_at_snapshot timestamptz;

-- ===========================================================================
-- 2) STATE MACHINE. Stati nuovi: pending -> confirmed -> completed, con
--    cancelled per rifiuto/annullamento. 'seen' resta un valore VALIDO nel
--    CHECK (dati legacy, mai più scritto da nessuna RPC dopo questa
--    migration) — scelta deliberata, non un refuso:
--
--    "seen" nel vecchio modello significava solo "il proprietario ha aperto
--    la richiesta", MAI "le copie sono state verificate/riservate
--    atomicamente" come garantisce oggi "confirmed". Interpretare
--    automaticamente seen -> confirmed avrebbe potuto "riservare" quantità
--    che nel frattempo sono già state prestate/vendute altrove — un bug di
--    sicurezza sui dati, non solo cosmetico. Interpretare seen -> completed
--    sarebbe ancora peggio (tratterebbe come "scambio concluso, carte
--    rimosse dalla raccolta" una richiesta che non ha MAI decrementato
--    nulla). Nessuna delle due migrazioni automatiche viene fatta qui.
--
--    Le richieste 'seen' restano quindi per sempre nel loro stato legacy:
--    list_collection_share_requests le restituisce così come sono (status
--    'seen', a differenza di prima non più intese come "confermate"), e la
--    UI le tratta come pending-equivalent (mai un impegno sulla
--    disponibilità, azioni Rifiuta/Conferma identiche a una vera pending —
--    "confermarle" da qui in avanti passa per confirm_collection_share_
--    request, che le ri-valida atomicamente esattamente come una pending:
--    l'unico modo sicuro di "promuoverle" al nuovo modello).
alter table public.collection_share_requests drop constraint if exists collection_share_requests_status_check;
alter table public.collection_share_requests add constraint collection_share_requests_status_check
  check (status in ('pending','seen','confirmed','completed','cancelled'));

alter table public.collection_share_requests add column if not exists completed_at timestamptz;

-- ===========================================================================
-- 3) Helper interno: quante copie di una printing sono impegnate da
--    richieste CONFERMATE dell'owner (mai anche 'pending'/'seen': quelle non
--    riservano nulla, per requisito esplicito). Stesso pattern di
--    collection_item_loaned/collection_item_reserved (supabase-milestone-2-
--    collection.sql): SECURITY DEFINER, revocato da tutti, mai chiamato
--    direttamente dal client — solo da altre funzioni SECURITY DEFINER di
--    questo file (get_collection_share, confirm_collection_share_request).
--
--    Non serve un parametro "escludi questa richiesta": durante la
--    validazione di confirm_collection_share_request la richiesta che si sta
--    confermando è ancora 'pending' (lo stato passa a 'confirmed' solo alla
--    fine, dopo che tutte le righe hanno superato il controllo), quindi non
--    può mai comparire nella propria stessa somma.
create or replace function public.collection_share_confirmed_quantity(p_owner_slug text, p_printing_id uuid)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(i.quantity), 0)::integer
  from public.collection_share_request_items i
  join public.collection_share_requests r on r.id = i.request_id and r.status = 'confirmed'
  join public.collection_shares s on s.id = r.share_id
  where s.owner_slug = p_owner_slug and i.printing_id = p_printing_id
$$;
revoke all on function public.collection_share_confirmed_quantity(text,uuid) from public, anon, authenticated;

-- ===========================================================================
-- 4) get_collection_share: aggiunge quantityAvailable = quantityOwned al
--    netto di prestiti/prenotazioni (stesso pattern già usato altrove,
--    collection_item_loaned/collection_item_reserved per riga collection_
--    items) E delle richieste condivise già CONFERMATE per quella printing
--    (helper sopra, a livello di printing una sola volta per gruppo — non
--    per riga, altrimenti la stessa richiesta confermata verrebbe sottratta
--    più volte quando l'owner possiede la stessa printing su più righe
--    collection_items con condition/edition diverse).
--
--    js/collection-share.js (availableQuantity()) già degrada a
--    quantityOwned quando quantityAvailable manca — questa RPC aggiornata
--    non richiede NESSUNA modifica lato frontend guest, il fallback
--    smette semplicemente di attivarsi.
--
--    NOTA PER CHI TOCCA QUESTA FUNZIONE IN FUTURO: esiste un file separato,
--    NON ANCORA APPLICATO, supabase-collection-share-guest-redesign.sql, che
--    ridefinisce get_collection_share aggiungendo edition/condition/
--    language/alternateNames/cardCount/printingCount (fuori scope per questo
--    task) MA con una quantityAvailable che netta SOLO prestiti/prenotazioni,
--    non le richieste confermate. Se in futuro si applica (o si integra)
--    quella redesign, la sottrazione delle richieste confermate va
--    ri-applicata anche lì, altrimenti quantityAvailable regredirebbe
--    silenziosamente a un valore troppo alto.
create or replace function public.get_collection_share(p_share_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare share public.collection_shares; owner_name text; items jsonb;
begin
  select * into share from public.collection_shares where id = p_share_id and revoked_at is null;
  if not found then raise exception 'Link non valido o revocato'; end if;
  select full_name into owner_name from public.team_members where slug = share.owner_slug;
  select coalesce(jsonb_agg(jsonb_build_object(
    'printingId', p.id, 'cardName', p.card_name, 'setCode', p.set_code, 'setName', p.set_name,
    'rarity', p.rarity, 'imageUrl', p.image_url, 'quantityOwned', totals.quantity,
    'quantityAvailable', greatest(
      totals.quantity - totals.committed
        - public.collection_share_confirmed_quantity(share.owner_slug, totals.printing_id),
      0)
  ) order by p.card_name), '[]'::jsonb) into items
  from (
    select ci.printing_id,
      sum(ci.quantity_owned)::integer quantity,
      sum(public.collection_item_loaned(ci.id) + public.collection_item_reserved(ci.id))::integer committed
    from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
    where ci.owner_slug = share.owner_slug and cp.game = share.game
    group by ci.printing_id
  ) totals join public.card_printings p on p.id = totals.printing_id;
  return jsonb_build_object('ownerName', coalesce(owner_name,'Un membro del team'), 'game', share.game, 'items', items);
end;
$$;

-- ===========================================================================
-- 5) submit_collection_share_request: stessa firma/validazione/idempotenza/
--    notifica-best-effort di 20260916123000 (hotfix NULL-propagation),
--    INVARIATE — l'unica aggiunta è la cattura del prezzo snapshot per ogni
--    printing aggregata, subito prima dell'insert in collection_share_
--    request_items. Nessun drop necessario: stessa arità e stessi tipi.
create or replace function public.submit_collection_share_request(
  p_share_id uuid,
  p_requester_name text,
  p_items jsonb,
  p_message text default null,
  p_client_request_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  share public.collection_shares;
  request_id uuid;
  existing_request_id uuid;
  clean_name text;
  clean_message text;
  item_row record;
  agg record;
  price_row record;
  owner_qty integer;
  printing_game text;
  distinct_count integer := 0;
  total_quantity integer := 0;
begin
  select * into share from public.collection_shares where id = p_share_id and revoked_at is null;
  if not found then raise exception 'Link non valido o revocato'; end if;

  clean_name := trim(coalesce(p_requester_name, ''));
  if clean_name = '' then raise exception 'Nome mancante'; end if;
  if char_length(clean_name) > 80 then raise exception 'Nome troppo lungo (massimo 80 caratteri)'; end if;

  if p_message is not null and char_length(trim(p_message)) > 500 then
    raise exception 'Messaggio troppo lungo (massimo 500 caratteri)';
  end if;
  clean_message := nullif(trim(coalesce(p_message, '')), '');

  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'Elenco carte non valido'; end if;
  if jsonb_array_length(p_items) < 1 then raise exception 'Nessuna carta selezionata'; end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'Troppe carte in una singola richiesta (massimo 50)'; end if;

  if p_client_request_id is not null then
    select id into existing_request_id from public.collection_share_requests
      where share_id = share.id and client_request_id = p_client_request_id;
    if found then return existing_request_id; end if;
  end if;

  for item_row in select j.value from jsonb_array_elements(p_items) as j(value) loop
    if item_row.value is null or jsonb_typeof(item_row.value) <> 'object' then
      raise exception 'Elemento richiesta non valido';
    end if;
    if item_row.value->>'printingId' is null
      or item_row.value->>'printingId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then raise exception 'Elemento richiesta non valido: printingId mancante o malformato'; end if;
    if item_row.value->'quantity' is null
      or jsonb_typeof(item_row.value->'quantity') <> 'number'
      or (item_row.value->>'quantity') !~ '^[0-9]+$'
    then raise exception 'Quantità non valida per una delle carte richieste'; end if;
    if (item_row.value->>'quantity')::integer < 1 then
      raise exception 'La quantità richiesta deve essere maggiore di zero';
    end if;
    if (item_row.value->>'quantity')::integer > 99 then
      raise exception 'Quantità fuori range per una delle carte richieste (massimo 99)';
    end if;
    total_quantity := total_quantity + (item_row.value->>'quantity')::integer;
  end loop;

  if total_quantity > 500 then
    raise exception 'Quantità totale richiesta troppo alta (massimo 500 carte in una richiesta)';
  end if;

  for agg in
    select (j.value->>'printingId')::uuid as printing_id, sum((j.value->>'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) as j(value)
    group by 1
  loop
    distinct_count := distinct_count + 1;

    if agg.quantity > 99 then
      raise exception 'Quantità fuori range per una delle carte richieste (massimo 99)';
    end if;

    select cp.game into printing_game from public.card_printings cp where cp.id = agg.printing_id;
    if printing_game is null or printing_game <> share.game then
      raise exception 'Una delle carte richieste non appartiene a questa raccolta condivisa';
    end if;

    select coalesce(sum(ci.quantity_owned), 0) into owner_qty
      from public.collection_items ci
      where ci.owner_slug = share.owner_slug and ci.printing_id = agg.printing_id;

    if owner_qty <= 0 then
      raise exception 'Una delle carte richieste non è nella raccolta condivisa';
    end if;
    if agg.quantity > owner_qty then
      raise exception 'Quantità richiesta superiore a quella disponibile per una delle carte';
    end if;
  end loop;

  begin
    insert into public.collection_share_requests(share_id, requester_name, message, client_request_id)
      values (share.id, clean_name, clean_message, p_client_request_id)
      returning id into request_id;
  exception when unique_violation then
    select id into existing_request_id from public.collection_share_requests
      where share_id = share.id and client_request_id = p_client_request_id;
    if existing_request_id is not null then return existing_request_id; end if;
    raise;
  end;

  for agg in
    select (j.value->>'printingId')::uuid as printing_id, sum((j.value->>'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) as j(value)
    group by 1
  loop
    -- Prezzo snapshot: stessa astrazione di Market Watch (market_latest_
    -- prices + market_reference_type), UNA lookup per printing aggregata
    -- (mai per riga guest grezza — evita N+1 anche qui). Se non esiste un
    -- prezzo EUR affidabile, price_row resta a NULL su tutti i campi (una
    -- SELECT INTO su un record senza righe trovate assegna NULL a ogni
    -- campo, per definizione PL/pgSQL) e la riga viene comunque inserita
    -- con lo snapshot NULL: mai un motivo per bloccare la richiesta.
    select mp.normalized_price, mp.price_type, mp.captured_at
      into price_row
      from public.market_latest_prices mp
      where mp.printing_id = agg.printing_id and mp.normalized_currency = 'EUR' and mp.normalized_price is not null
      order by public.market_reference_type(mp.provider, mp.price_type), mp.captured_at desc
      limit 1;

    insert into public.collection_share_request_items(
      request_id, printing_id, quantity, unit_price_snapshot, price_type_snapshot, price_captured_at_snapshot
    )
      values (request_id, agg.printing_id, agg.quantity, price_row.normalized_price, price_row.price_type, price_row.captured_at);
  end loop;

  begin
    insert into public.notifications(member_slug, category, title, body, route_page, route_params, dedup_key, source_table, source_id)
    values (
      share.owner_slug, 'share_request', 'Nuova richiesta dalla tua raccolta',
      clean_name || ' è interessato a ' || distinct_count || ' cart' || (case when distinct_count = 1 then 'a' else 'e' end),
      'requests', jsonb_build_object('requestId', request_id), 'share_request:' || request_id,
      'collection_share_requests', request_id
    )
    on conflict (member_slug, dedup_key) do nothing;
  exception when others then
    raise warning 'submit_collection_share_request: notifica non inviata per request %: %', request_id, sqlerrm;
  end;

  return request_id;
end;
$$;

revoke all on function public.submit_collection_share_request(uuid, text, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function public.submit_collection_share_request(uuid, text, jsonb, text, uuid)
  to anon, authenticated;

-- ===========================================================================
-- 6) list_collection_share_requests: legge SOLO lo snapshot salvato (nessuna
--    lookup live su market_latest_prices — evita anche il problema originale
--    di "il totale cambia quando il proprietario riapre la pagina" e resta
--    una singola query con subquery/lateral, nessun N+1). Espone unitPrice/
--    lineTotal per riga e totalPrice per richiesta (somma delle sole righe
--    con prezzo valido — mai un NULL che azzera l'intero totale). Aggiunge
--    completedAt (null finché la richiesta non è completed).
create or replace function public.list_collection_share_requests(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'requesterName', r.requester_name, 'status', r.status, 'createdAt', r.created_at,
    'completedAt', r.completed_at, 'game', s.game,
    'message', r.message, 'items', ri.items, 'totalPrice', ri.total_price
  ) order by r.created_at desc), '[]'::jsonb) into result
  from public.collection_share_requests r
  join public.collection_shares s on s.id = r.share_id
  join lateral (
    select
      jsonb_agg(jsonb_build_object(
        'printingId', p.id, 'cardName', p.card_name, 'setCode', p.set_code, 'rarity', p.rarity,
        'imageUrl', p.image_url, 'quantity', i.quantity,
        'unitPrice', i.unit_price_snapshot,
        'lineTotal', case when i.unit_price_snapshot is not null then round(i.unit_price_snapshot * i.quantity, 2) end
      )) items,
      round(sum(i.unit_price_snapshot * i.quantity) filter (where i.unit_price_snapshot is not null), 2) total_price
    from public.collection_share_request_items i
    join public.card_printings p on p.id = i.printing_id
    where i.request_id = r.id
  ) ri on true
  where s.owner_slug = me;
  return result;
end;
$$;

revoke all on function public.get_collection_share(uuid) from public, anon, authenticated;
grant execute on function public.get_collection_share(uuid) to anon, authenticated;
revoke all on function public.list_collection_share_requests(text) from public, anon, authenticated;
grant execute on function public.list_collection_share_requests(text) to authenticated;

-- ===========================================================================
-- 7) confirm_collection_share_request: pending (o legacy 'seen', vedi nota
--    sezione 2) -> confirmed. Ri-valida atomicamente OGNI riga contro
--    quantityOwned - loan/reservation commitments - altre richieste GIÀ
--    confermate; se anche una sola riga non basta più, l'intera conferma
--    fallisce e lo stato della richiesta non cambia (nessun aggiornamento
--    parziale: la UPDATE finale è l'unica scrittura di stato, raggiunta solo
--    se il loop di validazione termina senza raise).
--
--    Locking: pg_advisory_xact_lock per owner serializza confirm/complete/
--    cancel dello STESSO proprietario (due richieste concorrenti sulla
--    stessa printing non possono più superare insieme la disponibilità: la
--    seconda attende, e quando riparte rilegge collection_share_confirmed_
--    quantity già aggiornata dalla prima). In più, "for update of ci" sulle
--    collection_items coinvolte protegge anche da una modifica concorrente
--    della raccolta stessa (es. l'owner che rimuove/modifica una carta da
--    un'altra scheda mentre la conferma è in corso).
create or replace function public.confirm_collection_share_request(p_token text, p_request_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  req record;
  it record;
  owner_qty integer;
  committed_qty integer;
  confirmed_qty integer;
  available_qty integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;

  perform pg_advisory_xact_lock(hashtext('collection_share_owner_mutation:' || me));

  select r.id, r.status into req
    from public.collection_share_requests r
    join public.collection_shares s on s.id = r.share_id
    where r.id = p_request_id and s.owner_slug = me
    for update of r;
  if not found then raise exception 'Richiesta non trovata'; end if;
  if req.status not in ('pending', 'seen') then
    raise exception 'Solo le richieste in attesa possono essere confermate';
  end if;

  perform ci.id from public.collection_items ci
    join public.collection_share_request_items i on i.printing_id = ci.printing_id
    where i.request_id = p_request_id and ci.owner_slug = me
    for update of ci;

  for it in select printing_id, quantity from public.collection_share_request_items where request_id = p_request_id loop
    select coalesce(sum(ci.quantity_owned), 0) into owner_qty
      from public.collection_items ci where ci.owner_slug = me and ci.printing_id = it.printing_id;
    select coalesce(sum(public.collection_item_loaned(ci.id) + public.collection_item_reserved(ci.id)), 0) into committed_qty
      from public.collection_items ci where ci.owner_slug = me and ci.printing_id = it.printing_id;
    select public.collection_share_confirmed_quantity(me, it.printing_id) into confirmed_qty;

    available_qty := greatest(owner_qty - committed_qty - confirmed_qty, 0);
    if it.quantity > available_qty then
      raise exception 'Una delle carte richieste non è più disponibile in quantità sufficiente';
    end if;
  end loop;

  update public.collection_share_requests set status = 'confirmed' where id = p_request_id;
end;
$$;

-- ===========================================================================
-- 8) complete_collection_share_request: confirmed -> completed. Unica RPC
--    che decrementa DAVVERO collection_items.quantity_owned (confirm non lo
--    fa mai, per requisito esplicito). Ricontrolla le quantità (potrebbero
--    essere cambiate per motivi legittimi tra confirm e complete, es. un
--    prestito accettato nel frattempo) e consuma le copie dalle righe
--    collection_items della printing (condition/edition/language diverse
--    possono coesistere: si consuma riga per riga, in ordine deterministico,
--    finché la quantità richiesta non è coperta). quantity_owned ha un CHECK
--    (between 1 and 999): non può mai essere aggiornato a 0, quindi una riga
--    che si esaurisce viene ELIMINATA (stesso pattern già usato dal progetto
--    per la rimozione di una carta dalla raccolta, supabase-milestone-2-
--    collection.sql), le altre vengono solo decrementate.
--
--    Se una sola operazione fallisce (raise in qualunque punto del loop),
--    l'intera funzione abortisce: essendo un'unica chiamata RPC = un'unica
--    transazione implicita, PostgreSQL fa automaticamente il rollback di
--    ogni delete/update già eseguito in questa stessa chiamata — nessuna
--    quantità può restare parzialmente rimossa, e la richiesta non passa a
--    completed (l'UPDATE finale non viene mai raggiunta).
create or replace function public.complete_collection_share_request(p_token text, p_request_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  req record;
  it record;
  owner_qty integer;
  remaining integer;
  row_rec record;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;

  perform pg_advisory_xact_lock(hashtext('collection_share_owner_mutation:' || me));

  select r.id, r.status into req
    from public.collection_share_requests r
    join public.collection_shares s on s.id = r.share_id
    where r.id = p_request_id and s.owner_slug = me
    for update of r;
  if not found then raise exception 'Richiesta non trovata'; end if;
  if req.status <> 'confirmed' then
    raise exception 'Solo le richieste confermate possono essere completate';
  end if;

  perform ci.id from public.collection_items ci
    join public.collection_share_request_items i on i.printing_id = ci.printing_id
    where i.request_id = p_request_id and ci.owner_slug = me
    for update of ci;

  for it in select printing_id, quantity from public.collection_share_request_items where request_id = p_request_id loop
    select coalesce(sum(ci.quantity_owned), 0) into owner_qty
      from public.collection_items ci where ci.owner_slug = me and ci.printing_id = it.printing_id;
    if it.quantity > owner_qty then
      raise exception 'Una delle carte richieste non è più disponibile in quantità sufficiente';
    end if;

    remaining := it.quantity;
    for row_rec in
      select id, quantity_owned from public.collection_items
      where owner_slug = me and printing_id = it.printing_id and quantity_owned > 0
      order by id
    loop
      exit when remaining <= 0;
      if row_rec.quantity_owned <= remaining then
        remaining := remaining - row_rec.quantity_owned;
        delete from public.collection_items where id = row_rec.id;
      else
        update public.collection_items set quantity_owned = quantity_owned - remaining, updated_at = now()
          where id = row_rec.id;
        remaining := 0;
      end if;
    end loop;

    if remaining > 0 then
      raise exception 'Errore interno: rimozione incompleta dalla raccolta';
    end if;
  end loop;

  update public.collection_share_requests set status = 'completed', completed_at = now() where id = p_request_id;
end;
$$;

-- ===========================================================================
-- 9) cancel_collection_share_request: pending/seen -> cancelled (rifiuto,
--    nessun impegno da liberare) oppure confirmed -> cancelled (annulla la
--    conferma, libera immediatamente le quantità riservate: collection_
--    share_confirmed_quantity le esclude appena lo stato non è più
--    'confirmed', nessuna azione aggiuntiva necessaria). completed non è
--    cancellabile da questa funzione — un ripristino di una richiesta già
--    completata (che ha già decrementato la raccolta) richiederebbe un
--    workflow esplicito e separato, deliberatamente non implementato qui.
create or replace function public.cancel_collection_share_request(p_token text, p_request_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); req record;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;

  perform pg_advisory_xact_lock(hashtext('collection_share_owner_mutation:' || me));

  select r.id, r.status into req
    from public.collection_share_requests r
    join public.collection_shares s on s.id = r.share_id
    where r.id = p_request_id and s.owner_slug = me
    for update of r;
  if not found then raise exception 'Richiesta non trovata'; end if;
  if req.status not in ('pending', 'seen', 'confirmed') then
    raise exception 'Questa richiesta non può più essere annullata';
  end if;

  update public.collection_share_requests set status = 'cancelled' where id = p_request_id;
end;
$$;

revoke all on function
  public.confirm_collection_share_request(text,uuid),
  public.complete_collection_share_request(text,uuid),
  public.cancel_collection_share_request(text,uuid)
  from public, anon, authenticated;
grant execute on function
  public.confirm_collection_share_request(text,uuid),
  public.complete_collection_share_request(text,uuid),
  public.cancel_collection_share_request(text,uuid)
  to authenticated;

-- ===========================================================================
-- 10) Ritiro di mark_collection_share_request_seen: l'unica callsite era
--     app.js (pulsante "Conferma" nel tab pending), sostituita in questo
--     stesso rilascio da confirmCollectionShareRequest. Nessun'altra chiamata
--     nel repository (verificato: js/*.js, app.js, scripts/*.mjs). Drop
--     esplicito, non solo deprecazione — coerente con "mai un dato storico
--     seen trattato come transazione conclusa", questa RPC non aveva MAI
--     validato disponibilità o riservato nulla, mantenerla chiamabile
--     avrebbe lasciato una seconda via, non validata, per marcare una
--     richiesta come "gestita".
revoke all on function public.mark_collection_share_request_seen(text,uuid) from public, anon, authenticated;
drop function if exists public.mark_collection_share_request_seen(text, uuid);

notify pgrst, 'reload schema';
