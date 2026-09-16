-- F.P.T Cards — Shared Collection "Richieste": repo-sync/hardening rispetto
-- allo stato REALE già applicato sul DB Supabase (migration live
-- "collection_share_requests_state_machine_hardened", DB version
-- 20260916194628). Non riscrive né sostituisce
-- 20260917120000_collection_share_requests_state_machine.sql — resta nella
-- history com'è, questa migration si limita a correggere in avanti i tre
-- blocker emersi da quella versione.
--
-- Questa migration è repo-sync: NON viene eseguita da questa sessione,
-- serve solo a portare il repository allo stesso stato del DB già live.
--
-- ===========================================================================
-- BLOCKER 1 — grant: confirm/complete/cancel/list erano concesse solo ad
-- `authenticated`. FPT Cards si connette SEMPRE con la chiave `anon` di
-- Supabase e fa l'autenticazione applicativa dentro ogni RPC via
-- session_member(p_token) — è lo stesso motivo per cui, già prima di questa
-- migration, list_collection_share_requests era stata concessa a
-- `anon, authenticated` (vedi 20260916120000_shared_collection_request_
-- hardening.sql). 20260917120000 ha regredito questo per le 4 RPC toccate.
-- Nessun cambiamento al modello di auth: solo allineamento alla convenzione
-- già in uso per ogni altra RPC "pubblica ma protetta da token" del progetto.
-- collection_share_confirmed_quantity resta un helper interno, NESSUN grant.
-- ===========================================================================
revoke all on function public.list_collection_share_requests(text) from public, anon, authenticated;
grant execute on function public.list_collection_share_requests(text) to anon, authenticated;

revoke all on function
  public.confirm_collection_share_request(text,uuid),
  public.complete_collection_share_request(text,uuid),
  public.cancel_collection_share_request(text,uuid)
  from public, anon, authenticated;
grant execute on function
  public.confirm_collection_share_request(text,uuid),
  public.complete_collection_share_request(text,uuid),
  public.cancel_collection_share_request(text,uuid)
  to anon, authenticated;

-- ===========================================================================
-- BLOCKER 2 — get_collection_share: 20260917120000 l'aveva ridefinita con la
-- versione "semplice" originaria (solo printingId/cardName/setCode/setName/
-- rarity/imageUrl/quantityOwned), perdendo il contratto ricco già live
-- (catalogCardId/edition/condition/language/alternateNames/cardCount/
-- printingCount, dalla redesign guest). Qui si riparte dalla versione ricca
-- e si aggiunge SOLO la sottrazione delle richieste condivise già confirmed,
-- esattamente come richiesto per quantityAvailable — nessun'altra modifica
-- al contratto, stessa logica set-based per i commitment dei prestiti
-- (collection_item_loaned/collection_item_reserved per riga, sommati per
-- printing). collection_share_confirmed_quantity(owner, printing) è
-- chiamata UNA volta per gruppo (è nel SELECT list della subquery
-- raggruppata per p.id, non dentro il sum() per-riga collection_items):
-- eseguita una volta per printing, non una volta per riga posseduta, nessun
-- N+1 aggiuntivo rispetto alla versione ricca originale.
-- ===========================================================================
create or replace function public.get_collection_share(p_share_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare share public.collection_shares; owner_name text; items jsonb; card_count integer; printing_count integer;
begin
  select * into share from public.collection_shares where id = p_share_id and revoked_at is null;
  if not found then raise exception 'Link non valido o revocato'; end if;
  select full_name into owner_name from public.team_members where slug = share.owner_slug;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'printingId', row.printing_id, 'catalogCardId', row.catalog_card_id, 'cardName', row.card_name,
      'setCode', row.set_code, 'setName', row.set_name, 'rarity', row.rarity, 'imageUrl', row.image_url,
      'quantityOwned', row.quantity_owned, 'quantityAvailable', row.quantity_available,
      'edition', row.edition, 'condition', row.condition, 'language', row.language,
      'alternateNames', coalesce(row.alt_names, '[]'::jsonb)
    ) order by row.card_name), '[]'::jsonb),
    count(distinct row.printing_id), count(distinct row.catalog_card_id)
  into items, printing_count, card_count
  from (
    select
      p.id printing_id, p.card_name, p.set_code, p.set_name, p.rarity, p.image_url, p.catalog_card_id,
      sum(ci.quantity_owned)::integer quantity_owned,
      -- Netto di prestiti/prenotazioni (per riga collection_items, sommato
      -- per printing) E delle richieste condivise già confirmed per questa
      -- printing (chiamata una sola volta qui, a livello di gruppo — MAI
      -- dentro il sum() sulle singole righe, altrimenti la stessa richiesta
      -- confermata verrebbe sottratta una volta per ogni riga collection_
      -- items dell'owner su questa printing).
      greatest(
        sum(greatest(ci.quantity_owned - public.collection_item_loaned(ci.id) - public.collection_item_reserved(ci.id), 0))::integer
          - public.collection_share_confirmed_quantity(share.owner_slug, p.id),
        0
      ) quantity_available,
      case when count(distinct nullif(trim(ci.edition), '')) = 1 then min(nullif(trim(ci.edition), '')) end edition,
      case when count(distinct ci.condition) = 1 then min(ci.condition) end condition,
      case when count(distinct ci.language) = 1 then min(ci.language) end language,
      alt.names alt_names
    from public.collection_items ci
    join public.card_printings p on p.id = ci.printing_id
    left join lateral (
      select jsonb_agg(distinct other.card_name) as names
      from public.card_printings other
      where other.game = p.game and other.catalog_card_id = p.catalog_card_id
        and lower(trim(other.card_name)) <> lower(trim(p.card_name))
    ) alt on true
    where ci.owner_slug = share.owner_slug and p.game = share.game
    group by p.id, p.card_name, p.set_code, p.set_name, p.rarity, p.image_url, p.catalog_card_id, alt.names
  ) row;

  return jsonb_build_object(
    'ownerName', coalesce(owner_name,'Un membro del team'), 'game', share.game, 'items', items,
    'cardCount', coalesce(card_count, 0), 'printingCount', coalesce(printing_count, 0)
  );
end;
$$;

revoke all on function public.get_collection_share(uuid) from public, anon, authenticated;
grant execute on function public.get_collection_share(uuid) to anon, authenticated;

-- ===========================================================================
-- BLOCKER 3 — complete_collection_share_request: 20260917120000 validava
-- solo SUM(quantity_owned) >= quantity richiesta e poi consumava righe
-- collection_items fino a coprire la quantità, SENZA MAI guardare quanto di
-- quella riga fosse già impegnato da prestiti/prenotazioni o da ALTRE
-- richieste condivise confirmed sulla stessa printing — poteva quindi
-- decrementare copie che risultavano "possedute" ma non erano affatto
-- libere.
--
-- Fix, per ogni item (printing_id, quantity) della richiesta:
--
--   1) total_free  = SUM per riga di greatest(quantity_owned
--                       - collection_item_loaned(id) - collection_item_reserved(id), 0)
--      (mai un numero negativo per riga, poi sommato sulle righe della printing)
--
--   2) other_confirmed = collection_share_confirmed_quantity(owner, printing)
--                           - quantity DI QUESTA STESSA richiesta.
--      collection_share_confirmed_quantity somma TUTTE le richieste
--      confirmed per quella printing, e la richiesta che si sta completando
--      è già 'confirmed' in questo momento — è quindi già inclusa in quel
--      totale. Va sottratta la propria quota per non contarla due volte (una
--      come "propria", una dentro il totale confirmed) — è esattamente la
--      quota che questa chiamata ha il diritto di consumare.
--
--   3) available_for_this = greatest(total_free - other_confirmed, 0)
--      Se quantity > available_for_this, l'intera funzione fallisce (raise,
--      mai un aggiornamento parziale — la transazione implicita della
--      chiamata RPC fa rollback di ogni delete/update già eseguito in questa
--      stessa chiamata, anche per item precedenti dello stesso loop).
--
--   4) Consumo riga per riga, MAI oltre free_qty della singola riga (per
--      riga: quantity_owned - loaned(id) - reserved(id), mai oltre
--      quantity_owned): quindi una riga con quantity_owned=3 e loaned+
--      reserved=2 (free_qty=1) può cedere AL MASSIMO 1 copia. Una riga viene
--      ELIMINATA solo quando la copia consumata coincide con l'INTERO
--      quantity_owned della riga (possibile solo quando quella riga non ha
--      alcun impegno, cioè free_qty = quantity_owned) — altrimenti viene
--      solo decrementata di "take", mai azzerata, cosicché le copie
--      impegnate restano sempre rappresentate da una riga con quantity_owned
--      pari almeno al loro impegno.
--
-- Resta: SECURITY DEFINER, sessione validata, ownership via join
-- collection_shares, pg_advisory_xact_lock per owner, FOR UPDATE sulle
-- collection_items coinvolte, solo status 'confirmed' accettato, completed_at
-- impostato alla fine. Nessun'altra RPC toccata da questo blocco.
-- ===========================================================================
create or replace function public.complete_collection_share_request(p_token text, p_request_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  req record;
  it record;
  total_free integer;
  total_confirmed integer;
  other_confirmed integer;
  available_for_this integer;
  remaining integer;
  take integer;
  row_rec record;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;

  perform pg_advisory_xact_lock(hashtext('collection_share_owner_mutation:' || me));

  select r.id, r.status into req
    from public.collection_share_requests r
    join public.collection_shares s on s.id = r.share_id
    where r.id = p_request_id and s.owner_slug = me
    for update of r;
  if not found then raise exception 'Richiesta non trovata'; end if;
  if req.status <> 'confirmed' then
    raise exception 'Solo le richieste confermate possono essere completate';
  end if;

  perform ci.id from public.collection_items ci
    join public.collection_share_request_items i on i.printing_id = ci.printing_id
    where i.request_id = p_request_id and ci.owner_slug = me
    for update of ci;

  for it in select printing_id, quantity from public.collection_share_request_items where request_id = p_request_id loop
    select coalesce(sum(greatest(
      ci.quantity_owned - public.collection_item_loaned(ci.id) - public.collection_item_reserved(ci.id), 0
    )), 0) into total_free
      from public.collection_items ci where ci.owner_slug = me and ci.printing_id = it.printing_id;

    select public.collection_share_confirmed_quantity(me, it.printing_id) into total_confirmed;
    other_confirmed := greatest(total_confirmed - it.quantity, 0);

    available_for_this := greatest(total_free - other_confirmed, 0);
    if it.quantity > available_for_this then
      raise exception 'Una delle carte richieste non è più disponibile in quantità sufficiente';
    end if;

    remaining := it.quantity;
    for row_rec in
      select ci.id, ci.quantity_owned,
        greatest(ci.quantity_owned - public.collection_item_loaned(ci.id) - public.collection_item_reserved(ci.id), 0) as free_qty
      from public.collection_items ci
      where ci.owner_slug = me and ci.printing_id = it.printing_id
      order by ci.id
    loop
      exit when remaining <= 0;
      if row_rec.free_qty <= 0 then continue; end if;
      take := least(remaining, row_rec.free_qty);
      if take = row_rec.quantity_owned then
        delete from public.collection_items where id = row_rec.id;
      else
        update public.collection_items set quantity_owned = quantity_owned - take, updated_at = now()
          where id = row_rec.id;
      end if;
      remaining := remaining - take;
    end loop;

    if remaining > 0 then
      raise exception 'Errore interno: rimozione incompleta dalla raccolta';
    end if;
  end loop;

  update public.collection_share_requests set status = 'completed', completed_at = now() where id = p_request_id;
end;
$$;

revoke all on function public.complete_collection_share_request(text,uuid) from public, anon, authenticated;
grant execute on function public.complete_collection_share_request(text,uuid) to anon, authenticated;

-- ===========================================================================
-- Indice mancante su collection_share_request_items(printing_id): usato da
-- ogni lookup per printing introdotta da questa feature (get_collection_share,
-- confirm/complete_collection_share_request, collection_share_confirmed_
-- quantity). L'unico indice preesistente sulla tabella è su request_id
-- (supabase-collection-sharing.sql) — nessun equivalente su printing_id.
-- ===========================================================================
create index if not exists collection_share_request_items_printing_id_idx
  on public.collection_share_request_items(printing_id);

-- ===========================================================================
-- Compatibilità legacy: NESSUNA riga toccata qui sotto, deliberatamente.
-- Nessun UPDATE su collection_share_requests, nessun backfill di snapshot
-- storici, nessuna conversione di 'seen' in 'confirmed'/'completed'. Questa
-- migration è solo grant + ridefinizione di funzioni + un indice.
-- ===========================================================================

notify pgrst, 'reload schema';
