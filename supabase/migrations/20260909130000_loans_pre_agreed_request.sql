-- F.P.T Cards — richiesta prestito "già concordata" dal pannello carte mancanti
-- del mazzo: il richiedente segnala di essersi già accordato offline col
-- proprietario, che può così accettare con un tap solo (client-side) invece
-- di dover impostare la quantità. La richiesta resta comunque una richiesta
-- formale (status 'requested'): serve a bloccare la copia nell'inventario del
-- proprietario ed evitare che la prometta a due persone in parallelo.
-- Eseguire dopo 20260909120000_loans_legacy_cleanup_and_indexes.sql.

alter table public.loans add column if not exists pre_agreed boolean not null default false;

-- CREATE OR REPLACE può aggiungere un nuovo parametro con default alla fine
-- della firma esistente: sostituisce la funzione in-place, i grant restano
-- validi (stesso oid) e le chiamate client con 4 argomenti continuano a
-- funzionare invariate finché js/api.js non viene aggiornato.
create or replace function public.request_collection_loan(
  p_token text, p_collection_item_id uuid, p_quantity integer, p_notes text default '',
  p_pre_agreed boolean default false
) returns public.loans language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); inventory public.collection_items;
  printing public.card_printings; created public.loans; available integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_quantity not between 1 and 99 or char_length(coalesce(p_notes,'')) > 500 then
    raise exception 'Dati richiesta non validi'; end if;
  select * into inventory from public.collection_items where id=p_collection_item_id;
  if not found then raise exception 'Elemento raccolta non trovato'; end if;
  if inventory.owner_slug=me then raise exception 'Non puoi richiedere una carta a te stesso'; end if;
  select * into printing from public.card_printings where id=inventory.printing_id;
  if not found then raise exception 'Printing non valida'; end if;
  if exists(select 1 from public.loans l where l.collection_item_id is null
    and l.owner_slug=inventory.owner_slug and l.game=printing.game
    and l.status in ('pending','requested','reserved','active','return_pending')
    and (nullif(trim(l.card_external_id),'')=printing.catalog_card_id
      or (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name))=lower(trim(printing.card_name))))
    and 1 < (select count(*) from public.collection_items ci join public.card_printings p on p.id=ci.printing_id
      where ci.owner_slug=inventory.owner_slug and p.game=printing.game
      and (p.catalog_card_id=printing.catalog_card_id or lower(trim(p.card_name))=lower(trim(printing.card_name))))) then
    raise exception 'Printing ambigua per prestiti legacy'; end if;
  available := greatest(inventory.quantity_owned-public.collection_item_loaned(inventory.id)-public.collection_item_reserved(inventory.id),0);
  if p_quantity > available then raise exception 'Quantità fisicamente non disponibile'; end if;
  insert into public.loans(card_name,quantity,requested_quantity,accepted_quantity,owner_slug,borrower_slug,notes,status,
    card_external_id,card_image,game,collection_item_id,request_origin,card_set_code,card_set_name,card_rarity,pre_agreed)
  values(printing.card_name,p_quantity,p_quantity,0,inventory.owner_slug,me,left(coalesce(p_notes,''),500),'requested',
    printing.catalog_card_id,nullif(printing.image_url,''),printing.game,inventory.id,'collection_request',
    printing.set_code,printing.set_name,printing.rarity,coalesce(p_pre_agreed,false)) returning * into created;
  return created;
end;
$$;

notify pgrst, 'reload schema';
