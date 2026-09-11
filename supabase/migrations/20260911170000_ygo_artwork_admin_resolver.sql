-- F.P.T Cards — Admin Artwork Resolver per il Yu-Gi-Oh! Printing Registry.
--
-- Il catalog cleanup ha ridotto gli unresolved "no provider match" da 100 a
-- 1 (identità certa via indice nomi YGOResources, vedi migration precedente
-- + js/ygo-printing-registry.js). I restanti unresolved sono quasi tutti
-- multi-artwork: identità carta nota, ma più artwork validi per lo stesso
-- Konami ID e nessuna fonte automatica dice quale appartenga a quale
-- stampa. Questi casi restano — per design — irrisolvibili in automatico:
-- serve una scelta umana, mai un guess.
--
-- Additiva: aggiunge solo una colonna a ygo_artwork_index (i candidati
-- completi, non solo l'URL quando ce n'è uno solo) e due RPC admin-only per
-- la coda di revisione. Nessuna tabella esistente viene alterata nella sua
-- semantica; la scrittura resta upsert_ygo_printing_override (già esistente,
-- già admin-gated, già collegata a apply_ygo_printing_mappings) — l'admin
-- artwork resolver non introduce un secondo percorso di scrittura parallelo.

begin;

alter table public.ygo_artwork_index
  add column if not exists candidates jsonb not null default '[]'::jsonb;

create or replace function public.ygo_artwork_index_upsert(
  p_token text, p_entries jsonb
) returns integer language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); entry jsonb; count_upserted integer := 0;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) not between 1 and 5000 then
    raise exception 'Voci indice artwork non valide'; end if;
  for entry in select value from jsonb_array_elements(p_entries) loop
    if char_length(trim(coalesce(entry->>'konamiCardId', ''))) between 1 and 20
      and (entry->>'artworkCount')::integer >= 0 then
      insert into public.ygo_artwork_index(konami_card_id, artwork_count, single_artwork_url, candidates, synced_at)
      values (trim(entry->>'konamiCardId'), (entry->>'artworkCount')::integer,
        nullif(trim(coalesce(entry->>'singleArtworkUrl', '')), ''),
        coalesce(entry->'candidates', '[]'::jsonb), now())
      on conflict (konami_card_id) do update set
        artwork_count = excluded.artwork_count, single_artwork_url = excluded.single_artwork_url,
        candidates = excluded.candidates, synced_at = excluded.synced_at;
      count_upserted := count_upserted + 1;
    end if;
  end loop;
  return count_upserted;
end;
$$;

-- Coda di revisione per l'Admin Artwork Resolver: solo printing unresolved
-- con identità nota (konami_card_id valorizzato, cioè NON "nessuna fonte" —
-- quelle restano semplicemente fuori da questa coda, non c'è nulla su cui
-- scegliere), con utilizzo reale in collection/deck/loan e i candidati
-- artwork noti. Ordinata per utilizzo: prima le stampe che gli utenti
-- vedono davvero.
create or replace function public.list_ygo_artwork_review_queue(
  p_token text, p_limit integer default 50, p_offset integer default 0
) returns table(
  set_code text, card_name text, konami_card_id text, artwork_count integer,
  current_artwork_url text, candidates jsonb,
  collection_usage integer, deck_usage integer, loan_usage integer, usage_count integer,
  total_count bigint
) language plpgsql stable security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); admin boolean;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;
  if p_limit not between 1 and 200 then raise exception 'Limite non valido'; end if;

  return query
    with usage as (
      select p.set_code_normalized,
        count(distinct ci.id)::integer as collection_usage,
        count(distinct dc.id)::integer as deck_usage,
        count(distinct l.id)::integer as loan_usage
      from public.card_printings p
      left join public.collection_items ci on ci.printing_id = p.id
      left join public.deck_cards dc on dc.printing_id = p.id
      left join public.loans l on l.collection_item_id = ci.id
      where p.game = 'yugioh' and p.set_code <> ''
      group by p.set_code_normalized
    ),
    queue as (
      select r.set_code, r.card_name, r.konami_card_id, a.artwork_count,
        r.artwork_url as current_artwork_url, coalesce(a.candidates, '[]'::jsonb) as candidates,
        coalesce(u.collection_usage, 0) as collection_usage, coalesce(u.deck_usage, 0) as deck_usage,
        coalesce(u.loan_usage, 0) as loan_usage,
        coalesce(u.collection_usage, 0) + coalesce(u.deck_usage, 0) + coalesce(u.loan_usage, 0) as usage_count
      from public.ygo_printing_registry r
      left join public.ygo_artwork_index a on a.konami_card_id = r.konami_card_id
      left join usage u on u.set_code_normalized = r.set_code_normalized
      where r.mapping_status = 'unresolved' and r.konami_card_id is not null
    )
    select q.*, count(*) over()::bigint as total_count
    from queue q
    order by q.usage_count desc, q.set_code
    limit p_limit offset p_offset;
end;
$$;

revoke all on function public.ygo_artwork_index_upsert(text, jsonb),
  public.list_ygo_artwork_review_queue(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.ygo_artwork_index_upsert(text, jsonb),
  public.list_ygo_artwork_review_queue(text, integer, integer)
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
