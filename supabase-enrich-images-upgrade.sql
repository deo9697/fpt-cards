-- Completa automaticamente le immagini dei prestiti esistenti.
-- Eseguire dopo supabase-card-images-upgrade.sql.
create or replace function public.enrich_loan_card(
  p_token text, p_id uuid, p_external_id bigint, p_image text
) returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  item public.loans;
  admin boolean;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  select * into item from public.loans where id = p_id;
  if not found or not (admin or item.owner_slug = me or item.borrower_slug = me) then
    raise exception 'Operazione non consentita';
  end if;
  if p_external_id is null or p_external_id <= 0
     or p_image not like 'https://images.ygoprodeck.com/%' then
    raise exception 'Immagine non valida';
  end if;
  update public.loans
    set card_external_id = p_external_id, card_image = left(p_image, 500)
    where id = p_id and card_image is null;
end;
$$;
revoke all on function public.enrich_loan_card(text,uuid,bigint,text) from public;
grant execute on function public.enrich_loan_card(text,uuid,bigint,text) to anon, authenticated;
