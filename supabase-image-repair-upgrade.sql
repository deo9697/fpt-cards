-- Permette all'app di correggere ID/immagini storiche errate senza cancellare prestiti.
-- Eseguire una sola volta nel Supabase SQL Editor.

begin;

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
  select * into item from public.loans where id = p_id for update;
  if not found or not (admin or item.owner_slug = me or item.borrower_slug = me) then
    raise exception 'Operazione non consentita';
  end if;
  if nullif(trim(p_external_id),'') is null or not (
    p_image like 'https://images.ygoprodeck.com/%' or
    p_image like 'https://optcgapi.com/%'
  ) then raise exception 'Immagine non valida'; end if;

  update public.loans
    set card_external_id = left(trim(p_external_id),100),
        card_image = left(p_image,500)
    where id = p_id
      and (card_external_id is distinct from left(trim(p_external_id),100)
        or card_image is distinct from left(p_image,500));
end;
$$;

revoke all on function public.enrich_loan_card(text,uuid,text,text) from public;
grant execute on function public.enrich_loan_card(text,uuid,text,text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;

-- Controllo facoltativo da eseguire dopo aver riaperto l'app:
-- select card_name, card_external_id, card_image
-- from public.loans
-- where lower(card_name) like '%droll%'
--    or lower(card_name) like '%shangri%ira%';
