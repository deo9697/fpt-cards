-- F.P.T Cards — One Piece Fase 4.1 fix: deck_cards deve poter avere più
-- printing sotto la stessa carta logica.
-- Migrazione additiva preparata: NON applicata automaticamente al Supabase
-- reale. Richiede che sia già stata eseguita
-- supabase/migrations/20260908190500_onepiece_deck_and_printing_foundation.sql.
--
-- Il problema: deck_cards ha PRIMARY KEY (deck_id, catalog_card_id, section).
-- Oggi puoi collegare UNA sola printing_id a "4x OP01-016" nel Main — non
-- puoi rappresentare "2x regular + 2x alt-art" come due righe sotto la
-- stessa carta logica, perché la seconda riga con lo stesso catalog_card_id
-- e la stessa section violerebbe la PK. Questa migration sostituisce la PK
-- naturale con un id surrogato e una unique key che include la printing:
--   (deck_id, catalog_card_id, section, coalesce(printing_id, <sentinella>))
-- così puoi avere N righe per la stessa carta logica, una per printing
-- fisica scelta, più al massimo UNA riga "non risolta" (printing_id null,
-- il comportamento di oggi) per carta logica per sezione.
--
-- Le regole del mazzo (Leader=1, Main=50, DON=10, max 4 copie per
-- catalog_card_id nel Main) restano lato client (js/games/onepiece/rules.js,
-- js/decks.js) e già sommano per catalog_card_id attraverso più righe —
-- qui serve solo che lo schema/le RPC non collidano nel salvarle.
--
-- Scoperta collaterale mentre verificavo la lineage delle funzioni: la
-- Fase 2 (20260908190500) aveva ricostruito save_deck() partendo dalla
-- versione più vecchia in supabase-milestone-4-decks.sql, perdendo il
-- supporto a printing_id che supabase-milestone-5-market-watch.sql le aveva
-- già aggiunto in seguito (save_deck_with_box non è stata toccata da questo
-- problema: era già basata sulla versione più recente). Questa migration
-- corregge anche quella regressione, oltre al fix dello schema.
--
-- Non tocca: set_deck_card_printing / list_deck_printing_options — restano
-- keyed su (deck_id, catalog_card_id, section) senza printing_id, quindi con
-- più righe per la stessa carta logica diventerebbero ambigue (aggiornano
-- tutte le righe che condividono catalog_card_id+section). Non è un
-- problema pratico oggi: nessun trigger UI le richiama mai (cercare
-- '[data-deck-printing]' in js/decks.js — non esiste, sono già codice morto
-- ereditato). Se in futuro quel flusso verrà agganciato all'interfaccia,
-- andrà esteso con un parametro che identifichi la riga esatta (es. il
-- printing_id corrente, o il nuovo id surrogato).
-- list_my_decks / list_my_decks_with_boxes non cambiano: restituiscono già
-- un oggetto jsonb per riga (non aggregato per catalog_card_id), quindi più
-- righe per la stessa carta logica arrivano già al client come voci
-- separate di deck.cards, esattamente come serve.

begin;

-- 1) deck_cards: id surrogato + unique key che include la printing --------

alter table public.deck_cards add column if not exists id uuid not null default gen_random_uuid();

do $$ begin
  if exists (select 1 from pg_constraint where conname='deck_cards_pkey' and conrelid='public.deck_cards'::regclass) then
    alter table public.deck_cards drop constraint deck_cards_pkey;
  end if;
end $$;
alter table public.deck_cards add constraint deck_cards_pkey primary key (id);

-- Indice su espressione (non un semplice constraint UNIQUE su colonne, che
-- in Postgres non ammette espressioni): coalesce sostituisce printing_id
-- nullo con una sentinella solo ai fini dell'unicità, senza toccare la
-- colonna reale o il suo FK verso card_printings. Effetto: righe con la
-- stessa carta logica+sezione ma printing_id DIVERSE convivono; al massimo
-- una riga con printing_id nullo ("non risolta") per carta logica+sezione.
drop index if exists public.deck_cards_identity_idx;
create unique index deck_cards_identity_idx on public.deck_cards (
  deck_id, catalog_card_id, section, (coalesce(printing_id, '00000000-0000-0000-0000-000000000000'::uuid))
);

-- 2) save_deck: ripristina il supporto a printing_id (regressione Fase 2) -
--    + valida la section per gioco + nuovo target ON CONFLICT -------------

create or replace function public.save_deck(p_token text,p_deck jsonb)
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token); target uuid; payload jsonb:=coalesce(p_deck->'cards','[]'::jsonb);
  card jsonb; total integer:=0; selected_printing uuid; deck_game text:=coalesce(nullif(p_deck->>'game',''),'yugioh');
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
    selected_printing:=null;
    if nullif(coalesce(card->>'printingId',card->>'printing_id'),'') is not null then
      begin selected_printing:=coalesce(card->>'printingId',card->>'printing_id')::uuid; exception when invalid_text_representation then raise exception 'Printing mazzo non valida'; end;
      if not exists(select 1 from public.card_printings cp where cp.id=selected_printing and cp.game=deck_game and cp.catalog_card_id=trim(card->>'catalogCardId')) then
        raise exception 'La printing selezionata non appartiene alla carta';
      end if;
    end if;
    insert into public.deck_cards(deck_id,catalog_card_id,card_name,image_url,ban_tcg,section,quantity,printing_id)
      values(target,left(trim(card->>'catalogCardId'),100),left(trim(card->>'cardName'),200),left(coalesce(card->>'imageUrl',''),500),
        case lower(coalesce(card->>'banTcg','')) when 'limited' then 'limited' when 'semi-limited' then 'semi-limited' when 'forbidden' then 'forbidden' else '' end,
        card->>'section',(card->>'quantity')::integer,selected_printing)
      on conflict (deck_id, catalog_card_id, section, (coalesce(printing_id, '00000000-0000-0000-0000-000000000000'::uuid)))
      do update set quantity=excluded.quantity,card_name=excluded.card_name,image_url=excluded.image_url,ban_tcg=excluded.ban_tcg,printing_id=excluded.printing_id;
  end loop;
  return target;
end;
$$;

-- 3) save_deck_with_box: solo il nuovo target ON CONFLICT ------------------

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
      on conflict (deck_id, catalog_card_id, section, (coalesce(printing_id, '00000000-0000-0000-0000-000000000000'::uuid)))
      do update set quantity=excluded.quantity,card_name=excluded.card_name,image_url=excluded.image_url,ban_tcg=excluded.ban_tcg,printing_id=excluded.printing_id;
  end loop;
  if requested_signature is not null and not exists(select 1 from deck_cards where deck_id=target and catalog_card_id=requested_signature) then raise exception 'La carta signature deve appartenere al mazzo'; end if;
  update decks set signature_card_id=requested_signature,deck_theme=selected_theme,deck_box_template=selected_template where id=target;
  return target;
end;
$$;

notify pgrst, 'reload schema';

commit;
