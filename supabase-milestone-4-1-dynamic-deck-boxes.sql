-- F.P.T Cards — Deck Box dinamiche.
-- Migration additiva: preparata ma NON applicata automaticamente.
-- Eseguire dopo le migration Mazzi e Market Watch.

alter table public.decks add column if not exists signature_card_id text null;
alter table public.decks add column if not exists deck_theme text not null default 'arcane-purple';
alter table public.decks add column if not exists deck_box_template text not null default 'procedural';

do $$ begin
  if not exists(select 1 from pg_constraint where conname='decks_deck_theme_check' and conrelid='public.decks'::regclass) then
    alter table public.decks add constraint decks_deck_theme_check check(deck_theme in (
      'arcane-purple','celestial-gold','abyss-blue','infernal-red','forest-green','cyber-cyan','royal-white','shadow-black'
    ));
  end if;
end $$;

do $$ begin
  if not exists(select 1 from pg_constraint where conname='decks_box_template_check' and conrelid='public.decks'::regclass) then
    alter table public.decks add constraint decks_box_template_check check(deck_box_template in ('procedural','arcane-vault','infernal-dragon','cyber-core'));
  end if;
end $$;

create or replace function public.list_my_decks_with_boxes(p_token text)
returns table(id uuid,owner_slug text,game text,name text,format text,signature_card_id text,deck_theme text,deck_box_template text,cover_image_url text,cards jsonb,created_at timestamptz,updated_at timestamptz)
language plpgsql security definer set search_path=public,extensions as $$
declare me text:=public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select d.id,d.owner_slug,d.game,d.name,d.format,d.signature_card_id,d.deck_theme,d.deck_box_template,
    coalesce((select dc.image_url from deck_cards dc where dc.deck_id=d.id and dc.image_url<>'' and dc.section in ('main','extra')
      order by (dc.catalog_card_id=d.signature_card_id) desc,case dc.section when 'main' then 0 else 1 end,dc.card_name limit 1),'') cover_image_url,
    coalesce((select jsonb_agg(jsonb_build_object(
      'catalog_card_id',dc.catalog_card_id,'card_name',dc.card_name,'image_url',dc.image_url,
      'ban_tcg',dc.ban_tcg,'section',dc.section,'quantity',dc.quantity,'printing_id',dc.printing_id,
      'printing_set_code',(select cp.set_code from card_printings cp where cp.id=dc.printing_id),
      'printing_rarity',(select cp.rarity from card_printings cp where cp.id=dc.printing_id)
    ) order by dc.section,dc.card_name) from deck_cards dc where dc.deck_id=d.id),'[]'::jsonb) cards,
    d.created_at,d.updated_at from decks d where d.owner_slug=me order by d.updated_at desc;
end;
$$;

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
    if total>200 or coalesce((card->>'quantity')::integer,0) not between 1 and 99 or coalesce(card->>'section','') not in ('main','extra','side') then raise exception 'Carta o quantità mazzo non valida'; end if;
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

revoke all on function public.list_my_decks_with_boxes(text),public.save_deck_with_box(text,jsonb) from public,anon,authenticated;
grant execute on function public.list_my_decks_with_boxes(text),public.save_deck_with_box(text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
