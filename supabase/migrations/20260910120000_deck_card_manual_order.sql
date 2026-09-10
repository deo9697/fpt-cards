-- F.P.T Cards — ordine manuale delle carte nel mazzo (drag & drop).
-- Migrazione additiva preparata: NON applicata automaticamente al Supabase
-- reale.
--
-- Richiesta utente 2026-09-10 (sezione One Piece, ma la modifica è generica
-- e vale per qualunque gioco): poter trascinare le carte nel Main per
-- riordinarle a piacere (costo, personaggi, eventi, stage...), invece di
-- subire l'ordine fisso per tipo/nome che usa la Raccolta.
--
-- Come funziona: `deck_cards` guadagna una colonna `position` (l'indice
-- della carta nell'array `cards` inviato da save_deck/save_deck_with_box).
-- Le liste (list_my_decks, list_my_decks_with_boxes, list_team_decks)
-- ordinano per quella invece che per section/card_name, quindi l'ordine in
-- cui il client ha salvato l'array torna intatto al prossimo caricamento.
-- Lato client (js/decks.js) la modalità di ordinamento "Manuale" lascia
-- l'array `deck.cards` così com'è (il drag & drop lo riordina in place) —
-- nessuna nuova colonna richiesta sull'oggetto carta, la posizione è
-- puramente l'ordine dell'array stesso.
--
-- Non tocca: set_deck_card_printing/list_deck_printing_options (non toccano
-- l'ordine), deck_cards_identity_idx (l'unique key resta la stessa, position
-- non ne fa parte — più righe della stessa carta logica/sezione con
-- printing diverse restano possibili, ognuna con la sua position).

begin;

alter table public.deck_cards add column if not exists position integer not null default 0;

-- 1) save_deck: assegna position dall'indice nell'array payload -----------

create or replace function public.save_deck(p_token text,p_deck jsonb)
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token); target uuid; payload jsonb:=coalesce(p_deck->'cards','[]'::jsonb);
  card jsonb; card_index integer; total integer:=0; selected_printing uuid; deck_game text:=coalesce(nullif(p_deck->>'game',''),'yugioh');
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
  card_index:=0;
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
    insert into public.deck_cards(deck_id,catalog_card_id,card_name,image_url,ban_tcg,section,quantity,printing_id,position)
      values(target,left(trim(card->>'catalogCardId'),100),left(trim(card->>'cardName'),200),left(coalesce(card->>'imageUrl',''),500),
        case lower(coalesce(card->>'banTcg','')) when 'limited' then 'limited' when 'semi-limited' then 'semi-limited' when 'forbidden' then 'forbidden' else '' end,
        card->>'section',(card->>'quantity')::integer,selected_printing,card_index)
      on conflict (deck_id, catalog_card_id, section, (coalesce(printing_id, '00000000-0000-0000-0000-000000000000'::uuid)))
      do update set quantity=excluded.quantity,card_name=excluded.card_name,image_url=excluded.image_url,ban_tcg=excluded.ban_tcg,printing_id=excluded.printing_id,position=excluded.position;
    card_index:=card_index+1;
  end loop;
  return target;
end;
$$;

-- 2) save_deck_with_box: idem -----------------------------------------------

create or replace function public.save_deck_with_box(p_token text,p_deck jsonb)
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token); target uuid; payload jsonb:=coalesce(p_deck->'cards','[]'::jsonb);
  card jsonb; card_index integer; total integer:=0; selected_printing uuid; deck_game text; requested_signature text;
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
  card_index:=0;
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
    insert into deck_cards(deck_id,catalog_card_id,card_name,image_url,ban_tcg,section,quantity,printing_id,position)
      values(target,left(trim(card->>'catalogCardId'),100),left(trim(card->>'cardName'),200),left(coalesce(card->>'imageUrl',''),500),
        case lower(coalesce(card->>'banTcg','')) when 'limited' then 'limited' when 'semi-limited' then 'semi-limited' when 'forbidden' then 'forbidden' else '' end,
        card->>'section',(card->>'quantity')::integer,selected_printing,card_index)
      on conflict (deck_id, catalog_card_id, section, (coalesce(printing_id, '00000000-0000-0000-0000-000000000000'::uuid)))
      do update set quantity=excluded.quantity,card_name=excluded.card_name,image_url=excluded.image_url,ban_tcg=excluded.ban_tcg,printing_id=excluded.printing_id,position=excluded.position;
    card_index:=card_index+1;
  end loop;
  if requested_signature is not null and not exists(select 1 from deck_cards where deck_id=target and catalog_card_id=requested_signature) then raise exception 'La carta signature deve appartenere al mazzo'; end if;
  update decks set signature_card_id=requested_signature,deck_theme=selected_theme,deck_box_template=selected_template where id=target;
  return target;
end;
$$;

-- 3) Liste: ordinano per position invece che per section/card_name --------

create or replace function public.list_my_decks_with_boxes(p_token text)
returns table(id uuid,owner_slug text,game text,name text,format text,signature_card_id text,deck_theme text,deck_box_template text,cover_image_url text,cards jsonb,created_at timestamptz,updated_at timestamptz)
language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select d.id,d.owner_slug,d.game,d.name,d.format,d.signature_card_id,d.deck_theme,d.deck_box_template,
    coalesce((select dc.image_url from deck_cards dc where dc.deck_id=d.id and dc.image_url<>'' and dc.section in ('main','extra')
      order by (dc.catalog_card_id=d.signature_card_id) desc,case dc.section when 'main' then 0 else 1 end,dc.position,dc.card_name limit 1),'') cover_image_url,
    coalesce((select jsonb_agg(jsonb_build_object(
      'catalog_card_id',dc.catalog_card_id,'card_name',dc.card_name,'image_url',dc.image_url,
      'ban_tcg',dc.ban_tcg,'section',dc.section,'quantity',dc.quantity,'printing_id',dc.printing_id,
      'printing_set_code',(select cp.set_code from card_printings cp where cp.id=dc.printing_id),
      'printing_rarity',(select cp.rarity from card_printings cp where cp.id=dc.printing_id)
    ) order by dc.section,dc.position,dc.card_name) from deck_cards dc where dc.deck_id=d.id),'[]'::jsonb) cards,
    d.created_at,d.updated_at from decks d where d.owner_slug=me order by d.updated_at desc;
end;
$$;

create or replace function public.list_my_decks(p_token text)
returns table(id uuid,owner_slug text,game text,name text,format text,cover_image_url text,cards jsonb,created_at timestamptz,updated_at timestamptz)
language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select d.id,d.owner_slug,d.game,d.name,d.format,
    coalesce((select dc.image_url from deck_cards dc where dc.deck_id=d.id and dc.image_url<>'' order by case dc.section when 'main' then 0 when 'extra' then 1 else 2 end,dc.position limit 1),'') cover_image_url,
    coalesce((select jsonb_agg(jsonb_build_object(
      'catalog_card_id',dc.catalog_card_id,'card_name',dc.card_name,'image_url',dc.image_url,
      'ban_tcg',dc.ban_tcg,'section',dc.section,'quantity',dc.quantity,'printing_id',dc.printing_id,
      'printing_set_code',(select cp.set_code from card_printings cp where cp.id=dc.printing_id),
      'printing_rarity',(select cp.rarity from card_printings cp where cp.id=dc.printing_id)
    ) order by dc.section,dc.position,dc.card_name) from deck_cards dc where dc.deck_id=d.id),'[]'::jsonb) cards,
    d.created_at,d.updated_at
  from decks d where d.owner_slug=me order by d.updated_at desc,d.id;
end;
$$;

create or replace function public.list_team_decks(p_token text)
returns table(
  id uuid, owner_slug text, owner_name text, game text, name text, format text,
  signature_card_id text, deck_theme text, deck_box_template text, cover_image_url text,
  cards jsonb, created_at timestamptz, updated_at timestamptz
)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select d.id, d.owner_slug, m.full_name, d.game, d.name, d.format,
    d.signature_card_id, d.deck_theme, d.deck_box_template,
    coalesce((select dc.image_url from public.deck_cards dc where dc.deck_id = d.id and dc.image_url <> '' and dc.section in ('main','extra')
      order by (dc.catalog_card_id = d.signature_card_id) desc, case dc.section when 'main' then 0 else 1 end, dc.position, dc.card_name limit 1), '') cover_image_url,
    coalesce((select jsonb_agg(jsonb_build_object(
      'catalog_card_id', dc.catalog_card_id, 'card_name', dc.card_name, 'image_url', dc.image_url,
      'ban_tcg', dc.ban_tcg, 'section', dc.section, 'quantity', dc.quantity, 'printing_id', dc.printing_id,
      'printing_set_code', (select cp.set_code from public.card_printings cp where cp.id = dc.printing_id),
      'printing_rarity', (select cp.rarity from public.card_printings cp where cp.id = dc.printing_id)
    ) order by dc.section, dc.position, dc.card_name) from public.deck_cards dc where dc.deck_id = d.id), '[]'::jsonb) cards,
    d.created_at, d.updated_at
  from public.decks d
  join public.team_members m on m.slug = d.owner_slug and m.active
  order by m.full_name, d.updated_at desc;
end;
$$;

notify pgrst, 'reload schema';

commit;
