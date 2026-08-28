-- F.P.T Cards — Milestone 2.1: richieste prestito dalla Raccolta Team.
-- Eseguire dopo supabase-milestone-2-collection.sql.
-- Migrazione additiva: pending/returned restano supportati per i record legacy.

alter table public.loans add column if not exists requested_quantity integer;
alter table public.loans add column if not exists accepted_quantity integer;
alter table public.loans add column if not exists request_origin text not null default 'legacy';
alter table public.loans add column if not exists card_set_code text not null default '';
alter table public.loans add column if not exists card_set_name text not null default '';
alter table public.loans add column if not exists card_rarity text not null default '';
alter table public.loans add column if not exists reserved_at timestamptz;
alter table public.loans add column if not exists rejected_at timestamptz;

update public.loans set requested_quantity = quantity where requested_quantity is null;
update public.loans set accepted_quantity = case
  when request_origin = 'collection_request' and status in ('requested','rejected') then 0
  else quantity end
  where accepted_quantity is null;
alter table public.loans alter column requested_quantity set not null;
alter table public.loans alter column accepted_quantity set not null;
alter table public.loans drop constraint if exists loans_requested_quantity_check;
alter table public.loans add constraint loans_requested_quantity_check
  check (requested_quantity between 1 and 99 and quantity between 1 and requested_quantity);
alter table public.loans drop constraint if exists loans_accepted_quantity_check;
alter table public.loans add constraint loans_accepted_quantity_check
  check (accepted_quantity between 0 and requested_quantity and (
    (accepted_quantity = 0 and status in ('requested','rejected') and quantity = requested_quantity)
    or (accepted_quantity >= 1 and quantity = accepted_quantity)
  ));
alter table public.loans drop constraint if exists loans_request_origin_check;
alter table public.loans add constraint loans_request_origin_check
  check (request_origin in ('legacy','owner_created','collection_request'));
alter table public.loans drop constraint if exists loans_status_check;
alter table public.loans add constraint loans_status_check check (status in (
  'pending','requested','reserved','active','return_pending','returned','completed','rejected'
));

create index if not exists loans_collection_commitment_idx
  on public.loans(collection_item_id, status) where collection_item_id is not null;

-- Compatibilità con le vecchie RPC che inseriscono solo quantity.
create or replace function public.fill_loan_request_metadata()
returns trigger language plpgsql set search_path = public as $$
begin
  new.requested_quantity := coalesce(new.requested_quantity,new.quantity);
  new.accepted_quantity := coalesce(new.accepted_quantity,
    case when new.status='requested' then 0 else new.quantity end);
  if new.request_origin='legacy' and new.collection_item_id is not null then new.request_origin := 'owner_created'; end if;
  return new;
end;
$$;
drop trigger if exists fill_loan_request_metadata on public.loans;
create trigger fill_loan_request_metadata before insert on public.loans
for each row execute function public.fill_loan_request_metadata();

-- requested e pending non impegnano copie. Solo reserved è una prenotazione fisica.
create or replace function public.collection_item_reserved(p_item_id uuid)
returns integer language sql stable security definer set search_path = public as $$
  with target as (select ci.id, ci.owner_slug, p.game, p.catalog_card_id, p.card_name
    from public.collection_items ci join public.card_printings p on p.id = ci.printing_id
    where ci.id = p_item_id)
  select coalesce(sum(greatest(l.accepted_quantity - l.returned_quantity, 0)), 0)::integer
  from public.loans l cross join target t
  where l.owner_slug = t.owner_slug and l.game = t.game and l.status = 'reserved'
    and public.loan_matches_collection_item(l, t.id, t.owner_slug, t.game, t.catalog_card_id, t.card_name)
$$;

create or replace function public.collection_item_loaned(p_item_id uuid)
returns integer language sql stable security definer set search_path = public as $$
  with target as (select ci.id, ci.owner_slug, p.game, p.catalog_card_id, p.card_name
    from public.collection_items ci join public.card_printings p on p.id = ci.printing_id
    where ci.id = p_item_id)
  select coalesce(sum(greatest(l.accepted_quantity - l.returned_quantity, 0)), 0)::integer
  from public.loans l cross join target t
  where l.owner_slug = t.owner_slug and l.game = t.game
    and l.status in ('active', 'return_pending')
    and public.loan_matches_collection_item(l, t.id, t.owner_slug, t.game, t.catalog_card_id, t.card_name)
$$;

-- Controllo conservativo riutilizzabile da salvataggio/import/Fast Scan futuro.
-- Non pretende di sostituire il catalogo remoto: segnala warning quando manca un
-- riferimento locale, mismatch solo quando esiste una contraddizione verificabile.
create or replace function public.reconcile_catalog_identity(
  p_game text, p_catalog_card_id text, p_set_code text, p_card_name text, p_image_url text default ''
) returns text language plpgsql stable security definer set search_path = public as $$
declare known boolean; conflicting boolean; image_id text;
begin
  if p_game not in ('yugioh','onepiece') or char_length(trim(coalesce(p_catalog_card_id,''))) < 1
    or char_length(trim(coalesce(p_card_name,''))) < 1 then return 'mismatch'; end if;
  select exists(select 1 from public.card_printings p where p.game=p_game
    and p.catalog_card_id=trim(p_catalog_card_id)) into known;
  select exists(select 1 from public.card_printings p where p.game=p_game and (
    (p.catalog_card_id=trim(p_catalog_card_id) and lower(trim(p.card_name))<>lower(trim(p_card_name)))
    or (lower(trim(p.card_name))=lower(trim(p_card_name)) and p.catalog_card_id<>trim(p_catalog_card_id))
  )) into conflicting;
  if conflicting then return 'mismatch'; end if;
  if p_game='yugioh' and coalesce(p_image_url,'')<>'' then
    image_id := substring(p_image_url from '/([0-9]{5,10})\.(?:jpg|jpeg|png)(?:[?#].*)?$');
    if image_id is not null and image_id <> trim(p_catalog_card_id) then return 'mismatch'; end if;
  end if;
  return case when known then 'valid' else 'warning' end;
end;
$$;

create or replace function public.request_collection_loan(
  p_token text, p_collection_item_id uuid, p_quantity integer, p_notes text default ''
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
    card_external_id,card_image,game,collection_item_id,request_origin,card_set_code,card_set_name,card_rarity)
  values(printing.card_name,p_quantity,p_quantity,0,inventory.owner_slug,me,left(coalesce(p_notes,''),500),'requested',
    printing.catalog_card_id,nullif(printing.image_url,''),printing.game,inventory.id,'collection_request',
    printing.set_code,printing.set_name,printing.rarity) returning * into created;
  return created;
end;
$$;

create or replace function public.respond_collection_loan(
  p_token text, p_id uuid, p_action text, p_quantity integer default null
) returns public.loans language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); item public.loans; inventory public.collection_items;
  accepted integer; available integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select * into item from public.loans where id=p_id for update;
  if not found or item.status<>'requested' or item.owner_slug<>me or item.request_origin<>'collection_request' then
    raise exception 'Richiesta non trovata o non autorizzata'; end if;
  if p_action='reject' then
    update public.loans set status='rejected', rejected_at=now() where id=p_id returning * into item;
    return item;
  end if;
  if p_action<>'accept' then raise exception 'Azione non valida'; end if;
  accepted := coalesce(p_quantity,item.requested_quantity);
  if accepted < 1 or accepted > item.requested_quantity then raise exception 'Quantità accettata non valida'; end if;
  if item.collection_item_id is null then raise exception 'Richiesta senza printing certa'; end if;
  -- Il lock esclusivo sull'unica riga di inventario serializza tutte le
  -- accettazioni della stessa copia/printing fino al commit della transazione RPC.
  select * into inventory from public.collection_items where id=item.collection_item_id for update;
  if not found or inventory.owner_slug<>me then raise exception 'Inventario non valido'; end if;
  available := greatest(inventory.quantity_owned-public.collection_item_loaned(inventory.id)-public.collection_item_reserved(inventory.id),0);
  if accepted > available then raise exception 'Quantità fisicamente non disponibile'; end if;
  update public.loans set quantity=accepted,accepted_quantity=accepted,status='reserved',reserved_at=now()
    where id=p_id returning * into item;
  return item;
end;
$$;

create or replace function public.transition_loan(p_token text, p_id uuid, p_action text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare item public.loans; me text := public.session_member(p_token); admin boolean;
  new_returned integer; inventory public.collection_items; available integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role='admin' into admin from public.team_members where slug=me;
  select * into item from public.loans where id=p_id for update;
  if not found then raise exception 'Prestito non trovato'; end if;
  if p_action='admin-delete' and admin then delete from public.loans where id=p_id;
  elsif p_action='activate' and item.status='reserved' and item.borrower_slug=me then
    update public.loans set status='active' where id=p_id;
  elsif p_action='accept' and item.status='pending' and item.borrower_slug=me then
    if item.collection_item_id is not null then
      select * into inventory from public.collection_items where id=item.collection_item_id for update;
      available := greatest(inventory.quantity_owned-public.collection_item_loaned(inventory.id)-public.collection_item_reserved(inventory.id),0);
      if item.quantity > available then raise exception 'Quantità fisicamente non disponibile'; end if;
    end if;
    update public.loans set status='active' where id=p_id;
  elsif p_action='reject' and item.status='pending' and item.borrower_slug=me then
    update public.loans set status='rejected',rejected_at=now() where id=p_id;
  elsif p_action='return' and item.status='active' and item.borrower_slug=me then
    update public.loans set status='return_pending',pending_return_quantity=quantity-returned_quantity where id=p_id;
  elsif p_action='confirm-return' and item.status='return_pending' and item.owner_slug=me then
    new_returned := item.returned_quantity+item.pending_return_quantity;
    update public.loans set returned_quantity=new_returned,pending_return_quantity=0,
      status=case when new_returned>=quantity then case when request_origin='collection_request' then 'completed' else 'returned' end else 'active' end,
      returned_at=case when new_returned>=quantity then now() else null end where id=p_id;
  else raise exception 'Operazione non consentita'; end if;
end;
$$;

create or replace function public.delete_collection_item(p_token text, p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); item public.collection_items;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select * into item from public.collection_items where id=p_id for update;
  if not found or item.owner_slug<>me then raise exception 'Elemento non trovato o non modificabile'; end if;
  if exists(select 1 from public.loans where collection_item_id=p_id and status in ('reserved','active','return_pending')) then
    raise exception 'Non puoi rimuovere una carta con copie impegnate'; end if;
  update public.loans set status='rejected',rejected_at=now(),collection_item_id=null
    where collection_item_id=p_id and status in ('requested','pending');
  delete from public.collection_items where id=p_id;
end;
$$;

revoke all on function public.reconcile_catalog_identity(text,text,text,text,text),
  public.request_collection_loan(text,uuid,integer,text),
  public.respond_collection_loan(text,uuid,text,integer) from public, anon, authenticated;
grant execute on function public.request_collection_loan(text,uuid,integer,text),
  public.respond_collection_loan(text,uuid,text,integer) to anon, authenticated;

notify pgrst, 'reload schema';
