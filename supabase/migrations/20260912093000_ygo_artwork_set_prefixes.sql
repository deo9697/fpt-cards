-- F.P.T Cards — elenco prefissi di set con unresolved, per la modalità
-- "Set: L26D" dell'Artwork Resolver (sezione 5): molte unresolved
-- appartengono agli stessi prodotti (L26D, L5DD, ...), un admin/curator deve
-- poterle lavorare in blocco senza indovinare i prefissi a memoria.

begin;

create or replace function public.list_ygo_artwork_review_set_prefixes(
  p_token text
) returns table(set_prefix text, unresolved_count integer) language plpgsql stable
security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); is_admin boolean; can_curate boolean;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin', coalesce(can_verify_ygo_artwork, false) into is_admin, can_curate
    from public.team_members where slug = me;
  if not coalesce(is_admin, false) and not coalesce(can_curate, false) then
    raise exception 'Operazione riservata ad admin o artwork curator';
  end if;
  return query
    select split_part(r.set_code, '-', 1) as set_prefix, count(*)::integer as unresolved_count
    from public.ygo_printing_registry r
    where r.mapping_status = 'unresolved' and r.konami_card_id is not null
    group by split_part(r.set_code, '-', 1)
    order by unresolved_count desc, set_prefix
    limit 40;
end;
$$;

revoke all on function public.list_ygo_artwork_review_set_prefixes(text) from public, anon, authenticated;
grant execute on function public.list_ygo_artwork_review_set_prefixes(text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
