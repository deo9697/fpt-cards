-- Sezioni separate Yu-Gi-Oh! / One Piece.
-- Eseguire una sola volta nel SQL Editor di Supabase prima del nuovo deploy.

alter table public.loans
  add column if not exists game text not null default 'yugioh';

alter table public.loans
  drop constraint if exists loans_game_check;
alter table public.loans
  add constraint loans_game_check check (game in ('yugioh', 'onepiece'));

-- Gli ID One Piece sono codici testuali (es. OP01-001).
alter table public.loans
  alter column card_external_id type text using card_external_id::text;

drop function if exists public.create_team_loans(text,jsonb,text,text);
create function public.create_team_loans(
  p_token text, p_cards jsonb, p_borrower_slug text,
  p_notes text default '', p_game text default 'yugioh'
) returns setof public.loans language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_game not in ('yugioh', 'onepiece') then raise exception 'Gioco non valido'; end if;
  if p_borrower_slug = me or not exists(select 1 from public.team_members where slug = p_borrower_slug) then raise exception 'Destinatario non valido'; end if;
  if jsonb_typeof(p_cards) <> 'array' or jsonb_array_length(p_cards) not between 1 and 50 then raise exception 'Elenco carte non valido'; end if;
  if exists (select 1 from jsonb_array_elements(p_cards) c where char_length(trim(c->>'name')) not between 1 and 200 or (c->>'quantity')::integer not between 1 and 99) then raise exception 'Dati carta non validi'; end if;
  return query insert into public.loans(card_name, quantity, owner_slug, borrower_slug, notes, card_external_id, card_image, game)
    select trim(c->>'name'), (c->>'quantity')::integer, me, p_borrower_slug,
      left(coalesce(p_notes,''),500), nullif(left(c->>'externalId',100),''),
      nullif(left(c->>'image',500),''), p_game
    from jsonb_array_elements(p_cards) c returning *;
end;
$$;
revoke all on function public.create_team_loans(text,jsonb,text,text,text) from public;
grant execute on function public.create_team_loans(text,jsonb,text,text,text) to anon, authenticated;

drop function if exists public.enrich_loan_card(text,uuid,bigint,text);
create or replace function public.enrich_loan_card(
  p_token text, p_id uuid, p_external_id text, p_image text
) returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  item public.loans;
  admin boolean;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  select * into item from public.loans where id = p_id;
  if not found or not (admin or item.owner_slug = me or item.borrower_slug = me) then raise exception 'Operazione non consentita'; end if;
  if nullif(trim(p_external_id),'') is null or not (
    p_image like 'https://images.ygoprodeck.com/%' or
    p_image like 'https://optcgapi.com/%'
  ) then raise exception 'Immagine non valida'; end if;
  update public.loans set card_external_id = left(p_external_id,100), card_image = left(p_image,500)
    where id = p_id and card_image is null;
end;
$$;
revoke all on function public.enrich_loan_card(text,uuid,text,text) from public;
grant execute on function public.enrich_loan_card(text,uuid,text,text) to anon, authenticated;

notify pgrst, 'reload schema';
