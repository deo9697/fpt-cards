-- Prestiti multipli atomici. Eseguire dopo supabase-secure-pin-upgrade.sql.
create or replace function public.create_team_loans(
  p_token text, p_cards jsonb, p_borrower_slug text, p_notes text default ''
) returns setof public.loans language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_borrower_slug = me or not exists(select 1 from public.team_members where slug = p_borrower_slug) then
    raise exception 'Destinatario non valido';
  end if;
  if jsonb_typeof(p_cards) <> 'array' or jsonb_array_length(p_cards) not between 1 and 50 then
    raise exception 'Elenco carte non valido';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_cards) c
    where char_length(trim(c->>'name')) not between 1 and 200
       or (c->>'quantity')::integer not between 1 and 99
  ) then raise exception 'Dati carta non validi'; end if;

  return query
    insert into public.loans(card_name, quantity, owner_slug, borrower_slug, notes)
    select trim(c->>'name'), (c->>'quantity')::integer, me, p_borrower_slug, left(coalesce(p_notes,''),500)
    from jsonb_array_elements(p_cards) c
    returning *;
end;
$$;

revoke all on function public.create_team_loans(text,jsonb,text,text) from public;
grant execute on function public.create_team_loans(text,jsonb,text,text) to anon, authenticated;
