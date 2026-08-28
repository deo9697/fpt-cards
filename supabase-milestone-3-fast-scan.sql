-- F.P.T Cards — Milestone 3: Fast Scan / bulk collection ingestion.
-- Eseguire dopo supabase-milestone-2-1-collection-loans.sql.

create index if not exists card_printings_normalized_set_code_idx
  on public.card_printings(game, upper(trim(set_code))) where set_code <> '';

create or replace function public.lookup_card_printings_by_set_code(
  p_token text, p_game text, p_set_code text
) returns table(
  printing_id uuid, game text, catalog_card_id text, card_name text,
  set_code text, set_name text, rarity text, image_url text
) language plpgsql stable security definer set search_path=public, extensions as $$
declare me text := public.session_member(p_token); normalized text := upper(trim(coalesce(p_set_code,'')));
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh','onepiece') or char_length(normalized) not between 4 and 30 then
    raise exception 'Codice printing non valido'; end if;
  return query select p.id,p.game,p.catalog_card_id,p.card_name,p.set_code,p.set_name,p.rarity,p.image_url
    from public.card_printings p where p.game=p_game and upper(trim(p.set_code))=normalized
    order by p.card_name,p.rarity;
end;
$$;

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
      on conflict (game,catalog_card_id,set_code,rarity) do update set
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

revoke all on function public.lookup_card_printings_by_set_code(text,text,text),
  public.save_collection_batch(text,jsonb) from public,anon,authenticated;
grant execute on function public.lookup_card_printings_by_set_code(text,text,text),
  public.save_collection_batch(text,jsonb) to anon,authenticated;

notify pgrst,'reload schema';
