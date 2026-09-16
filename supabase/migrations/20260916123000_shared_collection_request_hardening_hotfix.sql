-- F.P.T Cards — Shared Collection: HOTFIX di submit_collection_share_request
-- (20260916120000_shared_collection_request_hardening.sql).
--
-- BUG: PL/pgSQL propaga NULL attraverso <>/!~ invece di farli fallire — un
-- confronto con NULL restituisce NULL, non TRUE, e "if NULL then" è
-- equivalente a "if false then" (nessuna eccezione, il controllo viene
-- silenziosamente SALTATO, non rifiutato). Due punti della funzione
-- precedente erano esposti a questo:
--
--   1) p_items IS NULL: `jsonb_typeof(p_items) <> 'array'` con p_items NULL
--      vale NULL (non TRUE) -> il controllo di forma viene saltato, così
--      come jsonb_array_length(p_items) < 1/> 50 (anch'essi NULL con
--      argomento NULL) -> nessun raise. jsonb_array_elements(NULL) non
--      solleva un errore, restituisce zero righe -> il loop di validazione
--      e quello di aggregazione non eseguono MAI, e la funzione arriva
--      all'insert con una request valida ma ZERO collection_share_request_
--      items: una richiesta "fantasma", vuota, comunque persistita.
--   2) quantity mancante o esplicitamente null in un item: stesso
--      meccanismo — `jsonb_typeof(item->'quantity') <> 'number'` e
--      `(item->>'quantity') !~ '^[0-9]+$'` valgono entrambi NULL quando la
--      chiave manca o è json null, quindi `NULL or NULL` = NULL, il
--      controllo non scatta e l'esecuzione prosegue fino al cast
--      `(item->>'quantity')::integer`, che con input NULL restituisce NULL
--      (non un errore) — la quantità finiva a null nei controlli successivi
--      invece di essere esplicitamente rifiutata con un messaggio chiaro.
--
-- Il printingId mancante era GIÀ gestito correttamente (guardia esplicita
-- `item->>'printingId' is null or ...`) — solo quantity ne era priva.
--
-- FIX: guardie `is null` esplicite PRIMA di ogni confronto <>/!~ (mai
-- affidarsi al risultato di un confronto con un valore potenzialmente NULL),
-- variabile del loop rinominata item_row (RECORD, non jsonb, coerente con lo
-- schema "una colonna value" sotto) e jsonb_array_elements aliasato
-- esplicitamente come j(value) invece del bare "item" precedente — stesso
-- comportamento per ogni caso già valido, comportamento CORRETTO (rifiuto
-- esplicito, mai un salto silenzioso) per p_items null e quantity
-- mancante/null. Nessun altro cambiamento: stessa firma, stessa idempotenza,
-- stesso cap aggregato a 99, stessa notifica best-effort, stessi REVOKE/GRANT.
--
-- Dopo questo hotfix: Shared Collection (invio richiesta) è chiusa.

begin;

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
  owner_qty integer;
  printing_game text;
  distinct_count integer := 0;
  total_quantity integer := 0;
begin
  select * into share from public.collection_shares where id = p_share_id and revoked_at is null;
  if not found then raise exception 'Link non valido o revocato'; end if;

  -- --- Nome richiedente ---------------------------------------------
  clean_name := trim(coalesce(p_requester_name, ''));
  if clean_name = '' then raise exception 'Nome mancante'; end if;
  if char_length(clean_name) > 80 then raise exception 'Nome troppo lungo (massimo 80 caratteri)'; end if;

  -- --- Messaggio opzionale: trim, stringa vuota -> null, limite esplicito
  if p_message is not null and char_length(trim(p_message)) > 500 then
    raise exception 'Messaggio troppo lungo (massimo 500 caratteri)';
  end if;
  clean_message := nullif(trim(coalesce(p_message, '')), '');

  -- --- Anti-spam minimo sulla forma del payload -----------------------
  -- HOTFIX: "p_items is null or" esplicito in testa — senza, jsonb_typeof
  -- (null) <> 'array' vale NULL (non TRUE), il controllo veniva saltato e
  -- jsonb_array_elements(null) più sotto non solleva errore (zero righe),
  -- risultando in una request valida ma con ZERO item persistiti.
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'Elenco carte non valido'; end if;
  if jsonb_array_length(p_items) < 1 then raise exception 'Nessuna carta selezionata'; end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'Troppe carte in una singola richiesta (massimo 50)'; end if;

  -- --- Idempotenza, fast path: stesso client_request_id già visto per
  -- questo share -> nessuna nuova validazione/insert, torna la request
  -- esistente. Da sola NON basterebbe contro una race reale (due tentativi
  -- quasi simultanei arrivano entrambi qui PRIMA che l'altro abbia
  -- committato) — la vera protezione è l'indice unique + il catch di
  -- unique_violation sull'insert più sotto.
  if p_client_request_id is not null then
    select id into existing_request_id from public.collection_share_requests
      where share_id = share.id and client_request_id = p_client_request_id;
    if found then return existing_request_id; end if;
  end if;

  -- --- Validazione riga per riga del JSON grezzo: forma/tipo/range -----
  -- Ogni item deve avere ESATTAMENTE printingId (uuid) e quantity (intero
  -- positivo, non un numero con decimali, non una stringa, non mancante/
  -- null). Un solo item invalido fa fallire l'intera richiesta: nessun
  -- raise qui viene catturato, quindi qualunque eccezione abortisce
  -- l'intera funzione (e con essa l'intera transazione della chiamata RPC)
  -- — nessuna request o request_items parziale può mai essere creata.
  for item_row in select j.value from jsonb_array_elements(p_items) as j(value) loop
    if item_row.value is null or jsonb_typeof(item_row.value) <> 'object' then
      raise exception 'Elemento richiesta non valido';
    end if;
    if item_row.value->>'printingId' is null
      or item_row.value->>'printingId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then raise exception 'Elemento richiesta non valido: printingId mancante o malformato'; end if;
    -- HOTFIX: "item_row.value->'quantity' is null or" esplicito in testa —
    -- senza, quantity mancante/json null rendeva NULL entrambi i confronti
    -- successivi (<> 'number' e !~ regex), "NULL or NULL" = NULL, il
    -- controllo veniva saltato invece di rifiutare la riga.
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

  -- --- Validazione per printing: aggrega eventuali righe duplicate dello
  -- stesso printingId (un guest potrebbe splittarlo su più righe nel
  -- payload) PRIMA di confrontare col posseduto — altrimenti due righe da
  -- 30 sulla stessa carta con 40 possedute passerebbero la validazione riga
  -- per riga pur superando il totale reale disponibile. Fonte di verità:
  -- card_printings/collection_items via il VERO owner_slug dello share, mai
  -- un dato ricostruibile lato client (qui non arriva nome carta, quantità
  -- mostrata né owner: solo printingId+quantity). Raggiunto solo dopo il
  -- loop di validazione sopra: ogni item->>'quantity' qui è già garantito
  -- un intero valido 1..99, il cast non può più fallire silenziosamente.
  for agg in
    select (j.value->>'printingId')::uuid as printing_id, sum((j.value->>'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) as j(value)
    group by 1
  loop
    distinct_count := distinct_count + 1;

    -- Ogni riga individuale è già <= 99 (validato sopra), ma la SOMMA di più
    -- righe valide sullo stesso printingId (es. 60 + 60) può comunque
    -- superarlo: collection_share_request_items.quantity ha un CHECK
    -- (quantity between 1 and 99) a livello di tabella, e qui inseriamo UNA
    -- riga per printing_id già aggregata (vedi sotto) — va quindi ricontrollato
    -- sul totale aggregato, non solo riga per riga, altrimenti l'insert
    -- fallirebbe con un vincolo generico invece di questo errore esplicito.
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

  -- --- Persistenza: la parte critica, MAI silenziata da un errore di
  -- notifica (vedi sub-block isolato più sotto).
  begin
    insert into public.collection_share_requests(share_id, requester_name, message, client_request_id)
      values (share.id, clean_name, clean_message, p_client_request_id)
      returning id into request_id;
  exception when unique_violation then
    -- Race reale: un'altra chiamata concorrente con lo stesso
    -- client_request_id ha vinto per pochi millisecondi (entrambe avevano
    -- superato il fast path sopra prima che l'altra committasse). Non è un
    -- errore per il chiamante: stessa idempotenza del fast path, torna la
    -- request del vincitore invece di fallire o duplicare items/notifica.
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
    insert into public.collection_share_request_items(request_id, printing_id, quantity)
      values (request_id, agg.printing_id, agg.quantity);
  end loop;

  -- --- Notifica: SOLO best-effort. Un fallimento qui (tabella notifications
  -- assente perché supabase-notifications-center.sql non è stata applicata,
  -- vincolo imprevisto, qualunque altro errore) non deve MAI annullare una
  -- richiesta già validata e persistita — per questo è isolata nel proprio
  -- sub-block, l'UNICO exception handler "when others" di questa funzione
  -- (ogni raise sopra, validazione compresa, resta non catturato e abortisce
  -- l'intera transazione come previsto).
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

-- Ripetuto esplicitamente (stessa firma di 20260916120000, create or replace
-- preserverebbe comunque i grant già impostati, ma questo progetto ha già
-- visto un grant non restare applicato per motivi mai confermati — vedi
-- supabase-collection-share-request-prices.sql — meglio essere espliciti).
revoke all on function public.submit_collection_share_request(uuid, text, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function public.submit_collection_share_request(uuid, text, jsonb, text, uuid)
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
