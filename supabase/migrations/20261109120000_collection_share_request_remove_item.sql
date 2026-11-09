-- F.P.T Cards — Richieste: il proprietario può togliere da una richiesta
-- ricevuta le carte che non vuole scambiare (2026-11-09).
--
-- Vale per le richieste in attesa (pending/seen) e confermate: su una
-- confermata la copia riservata torna subito disponibile, perché
-- collection_share_confirmed_quantity somma le righe ancora presenti.
-- Togliere l'ultima carta annulla la richiesta (stato 'cancelled', come
-- cancel_collection_share_request): una richiesta vuota non ha senso.
-- Stesso lucchetto per proprietario delle altre mutazioni sulle richieste.
-- Additiva: solo una funzione nuova.

begin;

create or replace function public.remove_collection_share_request_item(
  p_token text, p_request_id uuid, p_printing_id uuid
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token); req record; removed integer; remaining integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  perform pg_advisory_xact_lock(hashtext('collection_share_owner_mutation:' || me));

  select r.id, r.status into req
  from public.collection_share_requests r
  join public.collection_shares s on s.id = r.share_id
  where r.id = p_request_id and s.owner_slug = me
  for update of r;
  if not found then raise exception 'Richiesta non trovata'; end if;
  if req.status not in ('pending','seen','confirmed') then raise exception 'Questa richiesta non si può più modificare'; end if;

  delete from public.collection_share_request_items
  where request_id = p_request_id and printing_id = p_printing_id;
  get diagnostics removed = row_count;
  if removed = 0 then raise exception 'Carta non presente nella richiesta'; end if;

  select count(*)::integer into remaining from public.collection_share_request_items where request_id = p_request_id;
  if remaining = 0 then
    update public.collection_share_requests set status = 'cancelled' where id = p_request_id;
    return jsonb_build_object('remainingItems', 0, 'status', 'cancelled');
  end if;
  return jsonb_build_object('remainingItems', remaining, 'status', req.status);
end;
$$;

-- Stessa convenzione delle altre RPC "pubbliche ma protette da token":
-- l'app si connette con la chiave anon e si autentica con session_member.
revoke all on function public.remove_collection_share_request_item(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_collection_share_request_item(text, uuid, uuid) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
