-- F.P.T Cards — One Piece Fase 2: DB Foundation.
-- Migrazione additiva preparata: NON applicata automaticamente al Supabase
-- reale. Va eseguita in una sessione con accesso DB, dopo aver letto per
-- intero questo file — cambia una unique key e un CHECK su tabelle già in
-- uso da Yu-Gi-Oh!, quindi non è "solo aggiunta colonne".
--
-- Cosa fa, in ordine:
--   1) card_printings: + variant_id, game_metadata, source_provider,
--      source_updated_at. Le righe esistenti restano variant_id='' —
--      semanticamente identiche a prima (nessuna riga YGO cambia identità).
--   2) unique key: (game, catalog_card_id, set_code, rarity) diventa
--      (game, catalog_card_id, set_code, rarity, variant_id). Necessario
--      perché regular/parallel/alt-art dello stesso card number possono
--      condividere set_code e rarity, e devono restare righe distinte.
--   3) deck_cards.section: main/extra/side -> +leader,+don. Sblocca il
--      salvataggio dei mazzi One Piece (oggi save_deck/save_deck_with_box
--      rifiutano qualunque section fuori da main/extra/side).
--   4) save_deck e save_deck_with_box: validano la section in base al game
--      del mazzo invece di un'unica lista fissa.
--   5) save_collection_item guadagna p_printing_id (opzionale): se il
--      chiamante ha già risolto una printing precisa la usa direttamente,
--      altrimenti si comporta come oggi (solo per Yu-Gi-Oh — One Piece senza
--      printing_id viene rifiutato, per non rischiare di fondere regular e
--      parallel sotto la stessa riga tramite il percorso legacy per nome).
--   6) save_collection_batch: stessa guardia per il branch legacy (senza
--      printingId nel payload) quando game='onepiece' — il branch con
--      printingId già presente in questa RPC non cambia.
--   7) correct_collection_item_printing / repair_collection_item_catalog_identity:
--      solo il target dell'ON CONFLICT su card_printings viene aggiornato
--      alla nuova constraint. Nessun cambio di comportamento.
--
-- Cosa NON tocca (confermato compatibile così com'è):
--   set_deck_card_printing, list_deck_printing_options, collection_items,
--   loans, matches/stats, market_price_snapshots, market_provider_printings.
--
-- Effetto collaterale noto e voluto: da qui in poi "Aggiungi carta" per One
-- Piece nell'editor Raccolta (che oggi chiama save_collection_item senza
-- alcun printing_id) smette di funzionare finché la UI Fase 5 non passa a
-- risolvere prima la printing dal catalogo. Non è un bug di questa
-- migration: è la garanzia di integrità che blocca il percorso legacy.

begin;

-- 1) Nuove colonne su card_printings ------------------------------------

alter table public.card_printings
  add column if not exists variant_id text not null default '',
  add column if not exists game_metadata jsonb not null default '{}'::jsonb,
  add column if not exists source_provider text not null default '',
  add column if not exists source_updated_at timestamptz;

do $$ begin
  if not exists(select 1 from pg_constraint where conname='card_printings_variant_id_check' and conrelid='public.card_printings'::regclass) then
    alter table public.card_printings add constraint card_printings_variant_id_check check (char_length(variant_id) <= 100);
  end if;
  if not exists(select 1 from pg_constraint where conname='card_printings_game_metadata_check' and conrelid='public.card_printings'::regclass) then
    alter table public.card_printings add constraint card_printings_game_metadata_check check (jsonb_typeof(game_metadata) = 'object');
  end if;
  if not exists(select 1 from pg_constraint where conname='card_printings_source_provider_check' and conrelid='public.card_printings'::regclass) then
    alter table public.card_printings add constraint card_printings_source_provider_check check (char_length(source_provider) <= 50);
  end if;
end $$;

-- 2) Unique key con variant_id -------------------------------------------
-- Nome storico auto-generato dal constraint originale (confermato dal testo
-- letterale già presente in supabase-printing-editor-integrity.sql):
-- card_printings_game_catalog_card_id_set_code_rarity_key.

-- Entrambi i drop sono "if exists" così questo blocco resta ripetibile: alla
-- prima esecuzione sparisce solo il nome storico, alle successive (rerun)
-- sparisce quello nuovo per poterlo ricreare senza "constraint already exists".
alter table public.card_printings
  drop constraint if exists card_printings_game_catalog_card_id_set_code_rarity_key;
alter table public.card_printings
  drop constraint if exists card_printings_identity_key;
alter table public.card_printings
  add constraint card_printings_identity_key
  unique (game, catalog_card_id, set_code, rarity, variant_id);

-- 3) deck_cards.section: sblocca Leader/DON!! -----------------------------

alter table public.deck_cards drop constraint if exists deck_cards_section_check;
alter table public.deck_cards add constraint deck_cards_section_check
  check (section in ('main','extra','side','leader','don'));

-- 4) save_deck: validazione section per gioco -----------------------------

create or replace function public.save_deck(p_token text,p_deck jsonb)
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token); target uuid; payload jsonb:=coalesce(p_deck->'cards','[]'::jsonb); card jsonb; total integer:=0;
  deck_game text:=coalesce(nullif(p_deck->>'game',''),'yugioh');
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if jsonb_typeof(payload)<>'array' or jsonb_array_length(payload)>200 then raise exception 'Lista mazzo non valida'; end if;
  if char_length(trim(coalesce(p_deck->>'name','')))=0 then raise exception 'Nome mazzo richiesto'; end if;
  if nullif(p_deck->>'id','') is not null then
    begin target:=(p_deck->>'id')::uuid; exception when invalid_text_representation then target:=null; end;
  end if;
  if target is not null and not exists(select 1 from public.decks where id=target and owner_slug=me) then raise exception 'Mazzo non trovato o non modificabile'; end if;
  if target is null then
    insert into public.decks(owner_slug,game,name,format) values(me,deck_game,left(trim(p_deck->>'name'),80),left(coalesce(nullif(trim(p_deck->>'format'),''),'TCG Avanzato'),80)) returning id into target;
  else
    update public.decks set game=deck_game,name=left(trim(p_deck->>'name'),80),format=left(coalesce(nullif(trim(p_deck->>'format'),''),'TCG Avanzato'),80) where id=target;
    delete from public.deck_cards where deck_id=target;
  end if;
  for card in select value from jsonb_array_elements(payload) loop
    total:=total+coalesce((card->>'quantity')::integer,0);
    if total>200 or coalesce((card->>'quantity')::integer,0) not between 1 and 99 then raise exception 'Carta o quantità mazzo non valida'; end if;
    if deck_game='onepiece' then
      if coalesce(card->>'section','') not in ('leader','main','don') then raise exception 'Sezione mazzo non valida per One Piece'; end if;
    else
      if coalesce(card->>'section','') not in ('main','extra','side') then raise exception 'Sezione mazzo non valida per Yu-Gi-Oh!'; end if;
    end if;
    insert into public.deck_cards(deck_id,catalog_card_id,card_name,image_url,ban_tcg,section,quantity)
      values(target,left(trim(card->>'catalogCardId'),100),left(trim(card->>'cardName'),200),left(coalesce(card->>'imageUrl',''),500),case lower(coalesce(card->>'banTcg','')) when 'limited' then 'limited' when 'semi-limited' then 'semi-limited' when 'forbidden' then 'forbidden' else '' end,card->>'section',(card->>'quantity')::integer)
      on conflict(deck_id,catalog_card_id,section) do update set quantity=excluded.quantity,card_name=excluded.card_name,image_url=excluded.image_url,ban_tcg=excluded.ban_tcg;
  end loop;
  return target;
end;
$$;

-- 5) save_deck_with_box: stessa validazione section per gioco -------------

create or replace function public.save_deck_with_box(p_token text,p_deck jsonb)
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token); target uuid; payload jsonb:=coalesce(p_deck->'cards','[]'::jsonb);
  card jsonb; total integer:=0; selected_printing uuid; deck_game text; requested_signature text;
  selected_theme text:=coalesce(nullif(p_deck->>'deckTheme',''),'arcane-purple');
  selected_template text:=coalesce(nullif(p_deck->>'deckBoxTemplate',''),'procedural');
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if jsonb_typeof(payload)<>'array' or jsonb_array_length(payload)>200 then raise exception 'Lista mazzo non valida'; end if;
  if char_length(trim(coalesce(p_deck->>'name','')))=0 then raise exception 'Nome mazzo richiesto'; end if;
  if selected_theme not in ('arcane-purple','celestial-gold','abyss-blue','infernal-red','forest-green','cyber-cyan','royal-white','shadow-black') then selected_theme:='arcane-purple'; end if;
  if selected_template not in ('procedural','arcane-vault','infernal-dragon','cyber-core') then selected_template:='procedural'; end if;
  requested_signature:=nullif(trim(coalesce(p_deck->>'signatureCardId','')),'');
  deck_game:=coalesce(nullif(p_deck->>'game',''),'yugioh');
  if nullif(p_deck->>'id','') is not null then begin target:=(p_deck->>'id')::uuid; exception when invalid_text_representation then target:=null; end; end if;
  if target is not null and not exists(select 1 from decks where id=target and owner_slug=me) then raise exception 'Mazzo non trovato o non modificabile'; end if;
  if target is null then
    insert into decks(owner_slug,game,name,format,deck_theme,deck_box_template) values(me,deck_game,left(trim(p_deck->>'name'),80),left(coalesce(nullif(trim(p_deck->>'format'),''),'TCG Avanzato'),80),selected_theme,selected_template) returning id into target;
  else
    update decks set game=deck_game,name=left(trim(p_deck->>'name'),80),format=left(coalesce(nullif(trim(p_deck->>'format'),''),'TCG Avanzato'),80),deck_theme=selected_theme,deck_box_template=selected_template where id=target;
    delete from deck_cards where deck_id=target;
  end if;
  for card in select value from jsonb_array_elements(payload) loop
    total:=total+coalesce((card->>'quantity')::integer,0);
    if total>200 or coalesce((card->>'quantity')::integer,0) not between 1 and 99 then raise exception 'Carta o quantità mazzo non valida'; end if;
    if deck_game='onepiece' then
      if coalesce(card->>'section','') not in ('leader','main','don') then raise exception 'Sezione mazzo non valida per One Piece'; end if;
    else
      if coalesce(card->>'section','') not in ('main','extra','side') then raise exception 'Sezione mazzo non valida per Yu-Gi-Oh!'; end if;
    end if;
    selected_printing:=null;
    if nullif(coalesce(card->>'printingId',card->>'printing_id'),'') is not null then
      begin selected_printing:=coalesce(card->>'printingId',card->>'printing_id')::uuid; exception when invalid_text_representation then raise exception 'Printing mazzo non valida'; end;
      if not exists(select 1 from card_printings cp where cp.id=selected_printing and cp.game=deck_game and cp.catalog_card_id=trim(card->>'catalogCardId')) then raise exception 'La printing selezionata non appartiene alla carta'; end if;
    end if;
    insert into deck_cards(deck_id,catalog_card_id,card_name,image_url,ban_tcg,section,quantity,printing_id)
      values(target,left(trim(card->>'catalogCardId'),100),left(trim(card->>'cardName'),200),left(coalesce(card->>'imageUrl',''),500),
        case lower(coalesce(card->>'banTcg','')) when 'limited' then 'limited' when 'semi-limited' then 'semi-limited' when 'forbidden' then 'forbidden' else '' end,
        card->>'section',(card->>'quantity')::integer,selected_printing)
      on conflict(deck_id,catalog_card_id,section) do update set quantity=excluded.quantity,card_name=excluded.card_name,image_url=excluded.image_url,ban_tcg=excluded.ban_tcg,printing_id=excluded.printing_id;
  end loop;
  if requested_signature is not null and not exists(select 1 from deck_cards where deck_id=target and catalog_card_id=requested_signature) then raise exception 'La carta signature deve appartenere al mazzo'; end if;
  update decks set signature_card_id=requested_signature,deck_theme=selected_theme,deck_box_template=selected_template where id=target;
  return target;
end;
$$;

-- 6) correct_collection_item_printing: solo il target dell'ON CONFLICT ---

create or replace function public.correct_collection_item_printing(
  p_token text,
  p_collection_item_id uuid,
  p_catalog_card_id text,
  p_card_name text,
  p_set_code text,
  p_set_name text,
  p_rarity text,
  p_image_url text,
  p_edition text,
  p_verification_version integer
) returns table(
  collection_item_id uuid,
  printing_id uuid,
  catalog_card_id text,
  card_name text,
  set_code text,
  set_name text,
  rarity text,
  edition text,
  quantity_owned integer,
  language text,
  condition text
) language plpgsql
security definer
set search_path = ''
as $$
declare
  me text := public.session_member(p_token);
  inventory public.collection_items;
  current_printing public.card_printings;
  target_printing_id uuid;
  canonical_id text;
  current_canonical_id text;
  desired_set_code text := upper(trim(coalesce(p_set_code,'')));
  desired_rarity text := trim(coalesce(p_rarity,''));
  desired_edition text := trim(coalesce(p_edition,''));
  reconciliation text;
  committed integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_verification_version <> 1 then raise exception 'Versione verifica catalogo non supportata'; end if;
  if char_length(trim(coalesce(p_catalog_card_id,''))) not between 1 and 100
    or char_length(trim(coalesce(p_card_name,''))) not between 1 and 200
    or char_length(desired_set_code) not between 1 and 100
    or char_length(desired_rarity) not between 1 and 100
    or char_length(trim(coalesce(p_set_name,''))) > 200
    or coalesce(p_image_url,'') not like 'https://%'
    or char_length(coalesce(p_image_url,'')) > 500 then
    raise exception 'Dati printing verificata non validi';
  end if;

  select * into inventory
  from public.collection_items
  where id = p_collection_item_id
  for update;
  if not found or inventory.owner_slug <> me then
    raise exception 'Elemento raccolta non trovato o non modificabile';
  end if;

  select * into current_printing
  from public.card_printings
  where id = inventory.printing_id
  for update;
  if not found then raise exception 'Printing corrente non trovata'; end if;

  canonical_id := public.resolve_catalog_card_id(current_printing.game, p_catalog_card_id);
  current_canonical_id := public.resolve_catalog_card_id(current_printing.game, current_printing.catalog_card_id);
  if canonical_id <> current_canonical_id then
    raise exception 'La correzione deve restare sulla stessa carta canonica';
  end if;

  reconciliation := public.reconcile_catalog_identity(
    current_printing.game, canonical_id, desired_set_code, p_card_name, p_image_url
  );
  if reconciliation = 'mismatch' then
    raise exception 'Dati catalogo incoerenti';
  end if;

  if desired_edition not in ('', 'Prima Edizione', 'Unlimited')
    and desired_edition <> inventory.edition then
    raise exception 'Edizione non valida';
  end if;

  select cp.id into target_printing_id
  from public.card_printings cp
  where cp.game = current_printing.game
    and cp.catalog_card_id = canonical_id
    and cp.set_code = desired_set_code
    and lower(trim(cp.rarity)) = lower(desired_rarity)
  for update;

  if target_printing_id is null then
    insert into public.card_printings(
      game, catalog_card_id, card_name, set_code, set_name, rarity, image_url,
      catalog_verification_status, catalog_verification_version,
      catalog_verified_at, catalog_verification_error
    ) values (
      current_printing.game, canonical_id, trim(p_card_name), desired_set_code,
      left(trim(coalesce(p_set_name,'')),200), desired_rarity, left(p_image_url,500),
      'verified', p_verification_version, now(), null
    )
    on conflict on constraint card_printings_identity_key do nothing
    returning id into target_printing_id;

    if target_printing_id is null then
      select cp.id into target_printing_id
      from public.card_printings cp
      where cp.game = current_printing.game
        and cp.catalog_card_id = canonical_id
        and cp.set_code = desired_set_code
        and cp.rarity = desired_rarity
      for update;
    end if;
  end if;

  if target_printing_id is null then raise exception 'Creazione printing verificata non riuscita'; end if;

  committed := public.collection_item_loaned(inventory.id) + public.collection_item_reserved(inventory.id);
  if target_printing_id <> inventory.printing_id and committed > 0 then
    raise exception 'Non puoi cambiare printing mentre esiste un prestito collegato';
  end if;

  if exists (
    select 1 from public.collection_items ci
    where ci.owner_slug = inventory.owner_slug
      and ci.id <> inventory.id
      and ci.printing_id = target_printing_id
      and ci.language = inventory.language
      and ci.condition = inventory.condition
      and ci.edition = desired_edition
  ) then
    raise exception 'Esiste già un elemento con questa printing e gli stessi metadati';
  end if;

  -- Field-specific: UUID, owner, quantità, lingua e condizione non possono cambiare.
  update public.collection_items
  set printing_id = target_printing_id,
      edition = desired_edition
  where id = inventory.id;

  return query
  select ci.id, cp.id, cp.catalog_card_id, cp.card_name, cp.set_code, cp.set_name,
    cp.rarity, ci.edition, ci.quantity_owned, ci.language, ci.condition
  from public.collection_items ci
  join public.card_printings cp on cp.id = ci.printing_id
  where ci.id = inventory.id;
end;
$$;

-- 7) repair_collection_item_catalog_identity: solo il target dell'ON CONFLICT

create or replace function public.repair_collection_item_catalog_identity(
  p_token text, p_collection_item_id uuid, p_catalog_card_id text,
  p_card_name text, p_image_url text, p_verification_version integer
) returns table(
  collection_item_id uuid, printing_id uuid, catalog_card_id text,
  card_name text, image_url text, verification_status text,
  verification_version integer
) language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  inventory public.collection_items;
  current_printing public.card_printings;
  target_printing_id uuid;
  canonical_id text;
  image_id text;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_verification_version <> 1
    or char_length(trim(coalesce(p_catalog_card_id,''))) not between 1 and 100
    or char_length(trim(coalesce(p_card_name,''))) not between 1 and 200
    or coalesce(p_image_url,'') not like 'https://%'
    or char_length(coalesce(p_image_url,'')) > 500 then
    raise exception 'Dati verifica catalogo non validi';
  end if;

  select * into inventory from public.collection_items
    where id = p_collection_item_id for update;
  if not found or inventory.owner_slug <> me then
    raise exception 'Elemento raccolta non trovato o non modificabile';
  end if;
  select * into current_printing from public.card_printings
    where id = inventory.printing_id for update;
  if not found then raise exception 'Printing non trovata'; end if;

  canonical_id := public.resolve_catalog_card_id(current_printing.game, p_catalog_card_id);
  if current_printing.game = 'yugioh' then
    image_id := substring(p_image_url from '/([0-9]{5,10})\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$');
    if image_id is not null
      and public.resolve_catalog_card_id(current_printing.game, image_id) <> canonical_id then
      raise exception 'Immagine e catalog ID non coerenti';
    end if;
  end if;

  if canonical_id = current_printing.catalog_card_id then
    target_printing_id := current_printing.id;
    update public.card_printings set
      image_url = left(p_image_url,500),
      catalog_verification_status = 'verified',
      catalog_verification_version = p_verification_version,
      catalog_verified_at = now(),
      catalog_verification_error = null,
      updated_at = now()
    where id = target_printing_id;
  else
    select cp.id into target_printing_id
    from public.card_printings cp
    where cp.game = current_printing.game
      and cp.catalog_card_id = canonical_id
      and cp.set_code = current_printing.set_code
      and cp.rarity = current_printing.rarity
    for update;

    if target_printing_id is null then
      -- L'upsert rende atomiche due repair concorrenti dirette alla stessa
      -- printing canonica, senza creare duplicati o perdere il risultato.
      insert into public.card_printings(
        game, catalog_card_id, card_name, set_code, set_name, rarity, image_url,
        catalog_verification_status, catalog_verification_version,
        catalog_verified_at, catalog_verification_error
      ) values (
        current_printing.game, canonical_id, trim(p_card_name),
        current_printing.set_code, current_printing.set_name, current_printing.rarity,
        left(p_image_url,500), 'verified', p_verification_version, now(), null
      )
      on conflict on constraint card_printings_identity_key do update set
        image_url = excluded.image_url,
        catalog_verification_status = excluded.catalog_verification_status,
        catalog_verification_version = excluded.catalog_verification_version,
        catalog_verified_at = excluded.catalog_verified_at,
        catalog_verification_error = null,
        updated_at = now()
      returning id into target_printing_id;
    else
      update public.card_printings set
        image_url = left(p_image_url,500),
        catalog_verification_status = 'verified',
        catalog_verification_version = p_verification_version,
        catalog_verified_at = now(),
        catalog_verification_error = null,
        updated_at = now()
      where id = target_printing_id;
    end if;

    if exists (
      select 1 from public.collection_items ci
      where ci.id <> inventory.id and ci.owner_slug = inventory.owner_slug
        and ci.printing_id = target_printing_id and ci.language = inventory.language
        and ci.condition = inventory.condition and ci.edition = inventory.edition
    ) then
      raise exception 'Repair bloccata: la printing canonica esiste gia nello stesso inventario';
    end if;

    -- Unica modifica ammessa all'inventario: il riferimento alla printing canonica.
    update public.collection_items set printing_id = target_printing_id
      where id = inventory.id;
  end if;

  return query select ci.id, cp.id, cp.catalog_card_id, cp.card_name, cp.image_url,
    cp.catalog_verification_status, cp.catalog_verification_version
  from public.collection_items ci
  join public.card_printings cp on cp.id = ci.printing_id
  where ci.id = inventory.id;
end;
$$;

-- 8) save_collection_batch: guardia legacy per One Piece ------------------

create or replace function public.save_collection_batch(
  p_token text, p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public, extensions as $$
declare me text := public.session_member(p_token); payload jsonb; printing uuid; saved uuid;
  delta integer; lang text; cond text; ed text; game_value text; catalog_id text;
  card_value text; set_code_value text; set_name_value text; rarity_value text; image_value text;
  saved_count integer := 0; total_count integer := 0; reconcile_status text;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 2000 then
    raise exception 'Batch non valido'; end if;

  for payload in select value from jsonb_array_elements(p_items) loop
    delta := coalesce((payload->>'quantityDelta')::integer,0);
    lang := trim(coalesce(payload->>'language','Italiano'));
    cond := coalesce(payload->>'condition','Near Mint');
    ed := left(trim(coalesce(payload->>'edition','')),100);
    if delta not between 1 and 999 or char_length(lang) not between 1 and 50
      or cond not in ('Mint','Near Mint','Excellent','Good','Played','Poor') then
      raise exception 'Elemento batch non valido'; end if;

    printing := nullif(payload->>'printingId','')::uuid;
    if printing is not null then
      perform 1 from public.card_printings p where p.id=printing;
      if not found then raise exception 'Printing non trovata'; end if;
    else
      game_value := coalesce(payload->>'game','yugioh');
      -- One Piece non può passare da qui: senza printingId risolto dal
      -- catalogo, la ricostruzione per nome/set/rarità rischia di fondere
      -- regular/parallel/alt-art nella stessa riga.
      if game_value = 'onepiece' then raise exception 'One Piece richiede una printing già risolta dal catalogo'; end if;
      catalog_id := trim(coalesce(payload->>'catalogCardId',''));
      card_value := trim(coalesce(payload->>'cardName',''));
      set_code_value := upper(trim(coalesce(payload->>'setCode','')));
      set_name_value := left(trim(coalesce(payload->>'setName','')),200);
      rarity_value := left(trim(coalesce(payload->>'rarity','')),100);
      image_value := left(coalesce(payload->>'imageUrl',''),500);
      if game_value not in ('yugioh','onepiece') or char_length(catalog_id) not between 1 and 100
        or char_length(card_value) not between 1 and 200 or char_length(set_code_value) not between 4 and 100
        or (image_value<>'' and image_value not like 'https://%') then raise exception 'Dati catalogo batch non validi'; end if;
      reconcile_status := public.reconcile_catalog_identity(game_value,catalog_id,set_code_value,card_value,image_value);
      if reconcile_status='mismatch' then raise exception 'Dati catalogo incoerenti per %',set_code_value; end if;
      insert into public.card_printings(game,catalog_card_id,card_name,set_code,set_name,rarity,image_url)
      values(game_value,catalog_id,card_value,set_code_value,set_name_value,rarity_value,image_value)
      on conflict on constraint card_printings_identity_key do update set
        card_name=excluded.card_name,
        set_name=case when excluded.set_name<>'' then excluded.set_name else public.card_printings.set_name end,
        image_url=case when excluded.image_url<>'' then excluded.image_url else public.card_printings.image_url end
      returning id into printing;
    end if;

    saved := null;
    insert into public.collection_items(owner_slug,printing_id,language,condition,edition,quantity_owned)
    values(me,printing,lang,cond,ed,delta)
    on conflict (owner_slug,printing_id,language,condition,edition) do update
      set quantity_owned=public.collection_items.quantity_owned+excluded.quantity_owned
      where public.collection_items.quantity_owned+excluded.quantity_owned<=999
    returning id into saved;
    if saved is null then raise exception 'Quantità massima superata nel batch'; end if;
    saved_count := saved_count+1; total_count := total_count+delta;
  end loop;

  return jsonb_build_object('savedItems',saved_count,'totalQuantity',total_count,'owner',me);
end;
$$;

-- 9) save_collection_item: p_printing_id + guardia legacy One Piece -------
-- Aggiunge un parametro in coda con default: per Postgres questo crea un
-- nuovo overload (14 argomenti -> 15), non sostituisce quello esistente.
-- Il blocco a fondo pagina riusa lo stesso pattern già presente in
-- supabase-milestone-2-collection.sql per risolvere l'overload corretto
-- dall'OID e togliere i permessi al vecchio, evitando l'ambiguità che
-- PostgREST solleverebbe se restassero entrambi eseguibili.

create or replace function public.save_collection_item(
  p_token text, p_id uuid, p_game text, p_catalog_card_id text, p_card_name text,
  p_set_code text default '', p_set_name text default '', p_rarity text default '',
  p_language text default 'Italiano', p_condition text default 'Near Mint',
  p_edition text default '', p_image_url text default '',
  p_quantity_owned integer default 1, p_quantity_mode text default 'set',
  p_printing_id uuid default null
) returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); printing uuid;
  item public.collection_items; committed integer := 0; stored_owned integer := 0;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') then raise exception 'Gioco non valido'; end if;
  if char_length(trim(coalesce(p_catalog_card_id,''))) not between 1 and 100
    or char_length(trim(coalesce(p_card_name,''))) not between 1 and 200 then raise exception 'Carta di catalogo non valida'; end if;
  if p_quantity_owned not between 1 and 999 or p_quantity_mode not in ('set','increment') then raise exception 'Quantità non valida'; end if;
  if p_condition not in ('Mint','Near Mint','Excellent','Good','Played','Poor')
    or char_length(trim(coalesce(p_language,''))) not between 1 and 50 then raise exception 'Metadati della copia non validi'; end if;
  if coalesce(p_image_url,'') <> '' and (p_image_url not like 'https://%' or char_length(p_image_url) > 500) then raise exception 'URL immagine non valido'; end if;

  if p_printing_id is not null then
    select id into printing from public.card_printings where id = p_printing_id and game = p_game and catalog_card_id = trim(p_catalog_card_id);
    if printing is null then raise exception 'Printing selezionata non valida per questa carta'; end if;
  elsif p_game = 'onepiece' then
    raise exception 'One Piece richiede una printing già risolta dal catalogo';
  else
    insert into public.card_printings(game, catalog_card_id, card_name, set_code, set_name, rarity, image_url)
    values (p_game, trim(p_catalog_card_id), trim(p_card_name), upper(left(trim(coalesce(p_set_code,'')),100)),
      left(trim(coalesce(p_set_name,'')),200), left(trim(coalesce(p_rarity,'')),100), left(coalesce(p_image_url,''),500))
    on conflict on constraint card_printings_identity_key do update set card_name = excluded.card_name,
      set_name = case when excluded.set_name <> '' then excluded.set_name else public.card_printings.set_name end,
      image_url = case when excluded.image_url <> '' then excluded.image_url else public.card_printings.image_url end
    returning id into printing;
  end if;

  if p_id is null then
    if p_quantity_mode = 'increment' then
      insert into public.collection_items(owner_slug, printing_id, language, condition, edition, quantity_owned)
      values(me, printing, trim(p_language), p_condition, left(trim(coalesce(p_edition,'')),100), p_quantity_owned)
      on conflict (owner_slug, printing_id, language, condition, edition) do update
        set quantity_owned = public.collection_items.quantity_owned + excluded.quantity_owned
        where public.collection_items.quantity_owned + excluded.quantity_owned <= 999
      returning id into p_id;
      if p_id is null then raise exception 'Quantità massima superata'; end if;
    else
      insert into public.collection_items(owner_slug, printing_id, language, condition, edition, quantity_owned)
      values(me, printing, trim(p_language), p_condition, left(trim(coalesce(p_edition,'')),100), p_quantity_owned)
      on conflict (owner_slug, printing_id, language, condition, edition) do update
        set quantity_owned = excluded.quantity_owned
      returning id into p_id;
    end if;
    committed := public.collection_item_loaned(p_id) + public.collection_item_reserved(p_id);
    select quantity_owned into stored_owned from public.collection_items where id = p_id for update;
    if stored_owned < committed then raise exception 'Quantità inferiore alle copie già impegnate'; end if;
  else
    select * into item from public.collection_items where id = p_id for update;
    if not found or item.owner_slug <> me then raise exception 'Elemento non trovato o non modificabile'; end if;
    committed := public.collection_item_loaned(p_id) + public.collection_item_reserved(p_id);
    if p_quantity_owned < committed then raise exception 'Quantità inferiore alle copie già impegnate'; end if;
    if item.printing_id <> printing and committed > 0 then raise exception 'Non puoi cambiare printing mentre esiste un prestito collegato'; end if;
    if exists(select 1 from public.collection_items ci where ci.owner_slug = me and ci.id <> p_id
      and ci.printing_id = printing and ci.language = trim(p_language)
      and ci.condition = p_condition and ci.edition = left(trim(coalesce(p_edition,'')),100)) then
      raise exception 'Esiste già un elemento con questa printing e gli stessi metadati'; end if;
    update public.collection_items set printing_id = printing, language = trim(p_language), condition = p_condition,
      edition = left(trim(coalesce(p_edition,'')),100), quantity_owned = p_quantity_owned where id = p_id;
  end if;
  return p_id;
end;
$$;

-- Risolve la firma dall'OID appena creato (15 argomenti, il nuovo
-- p_printing_id incluso), revoca tutti gli altri overload di
-- save_collection_item (incluso quello a 14 argomenti pre-migration) e
-- concede l'esecuzione solo a quello corrente. Stesso pattern già usato in
-- supabase-milestone-2-collection.sql per l'evoluzione precedente di questa
-- stessa RPC.
do $permissions$
declare target_function regprocedure; old_function regprocedure;
begin
  select p.oid::regprocedure into target_function
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'save_collection_item'
    and p.pronargs = 15
    and p.proargnames = array[
      'p_token','p_id','p_game','p_catalog_card_id','p_card_name','p_set_code','p_set_name',
      'p_rarity','p_language','p_condition','p_edition','p_image_url',
      'p_quantity_owned','p_quantity_mode','p_printing_id'
    ]::text[];

  if target_function is null then
    raise exception 'RPC save_collection_item appena creata non trovata';
  end if;

  for old_function in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'save_collection_item'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', old_function);
  end loop;

  execute format('grant execute on function %s to anon, authenticated', target_function);
end;
$permissions$;

notify pgrst, 'reload schema';

commit;
