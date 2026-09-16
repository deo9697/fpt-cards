-- F.P.T Cards — Shared Collection: P0/P1/P2 hardening del flusso "Sono
-- interessato" (submit_collection_share_request).
--
-- ROOT CAUSE (confermato per audit del codice, non assunto): js/collection-
-- share.js (dal restyle 2026-09-09) chiama già submitCollectionShareRequest
-- con un 4° argomento p_message (js/api.js:405). La migration che introduceva
-- quel parametro e la colonna message (supabase-collection-share-guest-
-- redesign.sql, commit 2efc286 del 2026-09-09) non risulta MAI eseguita sul
-- DB live: nessuna colonna message su collection_share_requests, RPC live
-- ancora alla firma a 3 argomenti di supabase-collection-sharing.sql. Ogni
-- invio richiesta fallisce oggi lato client (PostgREST non trova un overload
-- a 4 argomenti per submit_collection_share_request).
--
-- Questa migration SOSTITUISCE la parte submit_collection_share_request/
-- colonna message di supabase-collection-share-guest-redesign.sql (quel file
-- NON va più eseguito per queste due parti, sarebbe ridondante/in conflitto —
-- vedi note sotto) aggiungendo anche le protezioni P0/P1/P2 mancanti:
-- validazione server-side reale di ogni item, notifica non bloccante,
-- idempotenza, hardening anti-spam minimo. La parte di quel file relativa a
-- get_collection_share (edition/condition/language/quantityAvailable/
-- cardCount/printingCount) resta FUORI da questa migration — fuori scope per
-- questo task, il frontend già degrada senza (vedi commento in
-- js/collection-share.js:availableQuantity) — e resta applicabile a parte
-- senza conflitti: non tocca submit_collection_share_request né la colonna
-- message.
--
-- Contratto pubblico: p_share_id/p_requester_name/p_items restano identici
-- per nome, ordine e tipo. p_message e p_client_request_id sono SOLO in
-- coda, entrambi default null — compatibili con qualunque client (vecchio o
-- nuovo) e con le richieste già esistenti.
--
-- Identità "collection_item_id" del task -> printing_id di questo schema:
-- le richieste di questo progetto sono registrate per printing_id (un tile
-- per stampa fisica posseduta, aggregato su TUTTE le righe collection_items
-- di quella stampa per quell'owner — condition/edition/language possono
-- variare tra copie della stessa stampa, vedi get_collection_share), mai per
-- singola riga collection_items. printing_id è quindi il vero identificatore
-- usato da tutto il flusso richieste esistente (request/response, notifica,
-- vista proprietario in list_collection_share_requests) — passare a
-- collection_item_id romperebbe quel contratto pubblico e la UI già buona
-- che il task chiede esplicitamente di non toccare. La validazione sotto usa
-- quindi printing_id come source of truth, con lo stesso significato pratico
-- richiesto dal task (mai fidarsi di nome carta/quantità mostrata/owner
-- inviato dal client: qui non arriva nessuno di questi, solo printingId e
-- quantity, tutto il resto è riletto da card_printings/collection_items via
-- share.owner_slug, mai dal payload).
--
-- Quantità: il cap usato è SUM(quantity_owned) sulle righe collection_items
-- dell'owner per quella printing — lo stesso numero già mostrato oggi al
-- guest da get_collection_share (quantityOwned). NON netto di prestiti/
-- prenotazioni: quel calcolo più stretto (quantityAvailable) esiste già,
-- non applicato, in supabase-collection-share-guest-redesign.sql e resta
-- un'estensione indipendente e futura. Come richiesto esplicitamente dal
-- task, questa resta comunque solo la validazione al MOMENTO DELL'INVIO:
-- la richiesta non prenota le carte, quindi una seconda validazione (netta
-- di eventuali prestiti nel frattempo) resta necessaria in fase di
-- accettazione/creazione prestito, quando le carte vengono davvero impegnate
-- — non implementata qui, fuori scope.
--
-- Locking: deliberatamente NESSUN "FOR UPDATE"/"FOR SHARE" su collection_
-- items in questa funzione. Un lock qui protegge solo letture/scritture
-- all'INTERNO della stessa transazione — questa RPC non scrive mai
-- collection_items (non prenota nulla), quindi non c'è nulla, nella stessa
-- transazione, da proteggere da una modifica concorrente: l'unica seconda
-- validazione che conta davvero è quella, separata, in fase di accettazione
-- (vedi sopra). Aggiungere un lock qui sarebbe overhead senza reale
-- beneficio — coerente con "non introdurre locking pesante senza necessità".

begin;

-- =====================================================================
-- 1) Colonne additive, nullable, nessuna regressione sui dati esistenti.
-- =====================================================================
alter table public.collection_share_requests add column if not exists message text;
-- drop+add esplicito del CHECK (invece di lasciarlo al solo "add column if
-- not exists"): garantisce il limite finale di 500 anche nell'improbabile
-- caso in cui la colonna esistesse già con un CHECK diverso (es. 250, se
-- supabase-collection-share-guest-redesign.sql fosse stata comunque
-- eseguita nonostante l'audit non lo confermi) — idempotente in entrambi i
-- casi, mai un errore alla riesecuzione.
alter table public.collection_share_requests drop constraint if exists collection_share_requests_message_check;
alter table public.collection_share_requests add constraint collection_share_requests_message_check
  check (char_length(message) <= 500);

alter table public.collection_share_requests add column if not exists client_request_id uuid;

-- Idempotenza: stesso link + stesso client_request_id -> stessa request.
-- Parziale (where client_request_id is not null): le richieste storiche e
-- quelle di client non ancora aggiornati (client_request_id sempre null)
-- non sono mai vincolate da questo indice, possono coesistere in qualunque
-- numero, nessuna regressione sui dati esistenti.
create unique index if not exists collection_share_requests_client_request_idx
  on public.collection_share_requests(share_id, client_request_id)
  where client_request_id is not null;

-- =====================================================================
-- 2) submit_collection_share_request — validazione reale, idempotenza,
--    notifica non bloccante, hardening anti-spam minimo.
-- =====================================================================
-- La vecchia firma a 3 argomenti va droppata esplicitamente: p_message/
-- p_client_request_id hanno un default, quindi PostgREST la vedrebbe come
-- un overload IN PIÙ (stesso nome, arità diversa) invece che una
-- sostituzione, lasciando la vecchia funzione (senza validazione/
-- idempotenza) ancora chiamabile in parallelo — esattamente il rischio di
-- "due submit_collection_share_request ambigue" da evitare.
drop function if exists public.submit_collection_share_request(uuid, text, jsonb);
-- Nel caso in cui supabase-collection-share-guest-redesign.sql sia MAI stata
-- eseguita prima di questa migration (non risulta dall'audit, ma gestito
-- comunque per idempotenza): droppa anche quella firma a 4 argomenti.
drop function if exists public.submit_collection_share_request(uuid, text, jsonb, text);

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
  item jsonb;
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
  if jsonb_typeof(p_items) <> 'array' then raise exception 'Elenco carte non valido'; end if;
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
  -- positivo, non un numero con decimali, non una stringa). Un solo item
  -- invalido fa fallire l'intera richiesta: nessun raise qui viene
  -- catturato, quindi qualunque eccezione abortisce l'intera funzione (e
  -- con essa l'intera transazione della chiamata RPC) — nessuna request o
  -- request_items parziale può mai essere creata.
  for item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) <> 'object' then
      raise exception 'Elemento richiesta non valido';
    end if;
    if item->>'printingId' is null
      or item->>'printingId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then raise exception 'Elemento richiesta non valido: printingId mancante o malformato'; end if;
    if jsonb_typeof(item->'quantity') <> 'number' or (item->>'quantity') !~ '^[0-9]+$' then
      raise exception 'Quantità non valida per una delle carte richieste';
    end if;
    if (item->>'quantity')::integer < 1 then
      raise exception 'La quantità richiesta deve essere maggiore di zero';
    end if;
    if (item->>'quantity')::integer > 99 then
      raise exception 'Quantità fuori range per una delle carte richieste (massimo 99)';
    end if;
    total_quantity := total_quantity + (item->>'quantity')::integer;
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
  -- mostrata né owner: solo printingId+quantity).
  for agg in
    select (item->>'printingId')::uuid as printing_id, sum((item->>'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) item
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
    select (item->>'printingId')::uuid as printing_id, sum((item->>'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) item
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

revoke all on function public.submit_collection_share_request(uuid, text, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function public.submit_collection_share_request(uuid, text, jsonb, text, uuid)
  to anon, authenticated;

-- =====================================================================
-- 3) list_collection_share_requests — espone il messaggio al proprietario.
--    app.js/requestRowHtml lo mostra già se presente (righe ~1476-1479):
--    senza questo, il messaggio scritto dal guest non arriverebbe MAI al
--    proprietario. Corpo IDENTICO a supabase-collection-share-requests-
--    optimize.sql (la versione live più recente, confermata via git log),
--    solo con 'message' in aggiunta all'oggetto restituito.
-- =====================================================================
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

revoke all on function public.list_collection_share_requests(text) from public, anon, authenticated;
grant execute on function public.list_collection_share_requests(text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
