-- F.P.T Cards — Market Watch P0 performance, step 3: TRUE current-price
-- layer. Additiva, sola creazione di un nuovo layer + diagnostica SHADOW.
-- NON tocca get_market_watch_summary/list_market_watch_owned_page/
-- list_market_watch_extra/list_market_confirm_queue/market_price_snapshots
-- (schema o dati)/ygo_market_variants/Exact Price Shadow/cron/alert/
-- frontend. NESSUN CUTOVER in questa migration.
--
-- =====================================================================
-- FASE 1 — AUDIT DEL WRITE PATH REALE (codice presente, verificato riga
-- per riga, non assunto)
-- =====================================================================
-- 1) Chi scrive in market_price_snapshots: UN SOLO scrittore in tutto il
--    repo — supabase/functions/market-sync/index.ts, riga ~672:
--      POST market_price_snapshots?on_conflict=provider,observation_key,price_type
--      Prefer: resolution=ignore-duplicates (= INSERT ... ON CONFLICT DO NOTHING)
--    Nessuna RPC, nessun'altra Edge Function, nessun import/bulk scrive qui.
-- 2) Frequenza: query nightly (00:00 UTC ogni ora, la Edge Function esegue
--    il refresh completo solo alle 03:00 locali Roma — vedi
--    supabase-market-watch-scheduler.example.sql) per l'intero catalogo
--    mappato, più una coda "priority/newPrintings" ogni 15 minuti
--    (20260908154257_market_refresh_queue_schedule.sql) per sole mappature
--    nuove/appena confermate — quasi sempre "skipped" a costo zero.
-- 3) Batch size: POST a blocchi di 250 righe.
-- 4) UPDATE/DELETE su market_price_snapshots: NESSUNA riga viene mai
--    aggiornata o cancellata dal write path stesso (solo INSERT ... ON
--    CONFLICT DO NOTHING). L'UNICA mutazione post-insert in tutto il repo è
--    confirm_market_price_anomaly(p_token, p_snapshot_id) in
--    supabase-market-watch-price-anomaly-detection.sql:
--      UPDATE market_price_snapshots SET is_anomalous = false
--      WHERE id = p_snapshot_id AND is_anomalous
--    (azione manuale, un utente conferma un prezzo segnalato come insolito
--    dalla tab "Prezzi insoliti"). Nessun'altra query in tutto il repo
--    assegna is_anomalous.
-- 5) Come vengono gestiti gli anomalous: is_anomalous/anomaly_ratio sono
--    calcolati da un trigger BEFORE INSERT (trg_flag_price_anomaly) che
--    confronta il nuovo prezzo con l'ultimo prezzo noto (captured_at desc,
--    id desc) per la STESSA (printing_id, provider, price_type): rapporto
--    >5x o <0.1x -> is_anomalous=true. La riga viene comunque salvata
--    (audit/storico), solo esclusa dalle viste attive.
-- 6) Uno snapshot può diventare anomalous DOPO l'inserimento? NO — verificato
--    per grep su tutto il repo: is_anomalous è scritto SOLO dal trigger
--    BEFORE INSERT (sempre a true) e da confirm_market_price_anomaly
--    (sempre a false). Nessun percorso lo imposta a true dopo l'insert
--    oggi. Il layer qui sotto gestisce comunque ANCHE questa direzione
--    (vedi FASE 3/rebuild_market_current_price_snapshot) per non lasciare
--    un buco se un futuro percorso lo introducesse — richiesto esplicitamente
--    dal task, anche se oggi è un ramo morto.
-- 7) Il mapping (market_provider_printings.resolution_status/
--    provider_metadata, da cui market_mapping_is_active()) PUÒ cambiare
--    indipendentemente dagli snapshot già scritti: market-sync fa upsert
--    (resolution=merge-duplicates) sulla stessa riga ad ogni resolve, e
--    admin/RPC di conferma manuale (Market Variant Registry, printing
--    registry, ecc.) aggiornano resolution_status/provider_metadata in
--    qualunque momento, senza alcun collegamento temporale con quando fu
--    scritto un prezzo. Confermato: il current layer NON deve incorporare
--    "active" al proprio interno (vedi FASE 4).
--
-- =====================================================================
-- FASE 2 — DESIGN: market_current_price_snapshots
-- =====================================================================
-- Chiave: (provider_mapping_id, price_type). NON (printing_id, provider):
-- provider_mapping_id identifica univocamente una riga di
-- market_provider_printings (unique su printing_id,provider,variant_key —
-- vedi l'upsert in market-sync), quindi è ALMENO altrettanto preciso di
-- (printing_id, provider) e coerente con come OGNI altra query di questo
-- repo already joina gli snapshot ai mapping (via provider_mapping_id, mai
-- via printing_id+provider diretto). printing_id/provider sono comunque
-- duplicati qui (immutabili per la vita di un mapping: sono parte della
-- chiave di conflitto dell'upsert su market_provider_printings, quindi non
-- possono mai cambiare per una data provider_mapping_id) — servono al read
-- path per evitare un JOIN in più solo per sapere quale printing/provider è.
--
-- Campi ESCLUSI deliberatamente (mai letti da nessun consumer Market Watch
-- oggi: get_market_watch_summary/list_market_watch_owned_page/
-- list_market_watch_extra non leggono original_price/original_currency/
-- fx_*/available_quantity/sample_size/source_updated_at/metadata dagli
-- snapshot) — "NON duplicare colonne inutili": snapshot_id resta il
-- puntatore per un'eventuale ispezione futura di questi campi senza
-- doverli copiare qui.
--
-- =====================================================================
-- FASE 3 — CONSISTENCY MODEL (incrementale, mai un rebuild periodico)
-- =====================================================================
-- A) Trigger AFTER INSERT su market_price_snapshots: per ogni nuova riga
--    (l'anomaly trigger BEFORE INSERT ha già impostato is_anomalous a
--    questo punto — l'ordine di esecuzione dei trigger BEFORE poi AFTER è
--    garantito da Postgres), sync_market_current_price_snapshot() tenta di
--    promuoverla a current per la sua (provider_mapping_id, price_type):
--    mai se is_anomalous, mai se più vecchia (o pari data con id minore)
--    di quella già current.
-- B) Trigger AFTER UPDATE OF is_anomalous: gestisce ENTRAMBE le direzioni
--    del lifecycle (FASE 3 del task, "non ignorare questo caso"):
--      - false -> true (oggi un ramo morto, vedi punto 6 sopra, ma gestito):
--        se la riga appena marcata anomala ERA il current per la sua
--        chiave, rebuild_market_current_price_snapshot() ricalcola da zero
--        il vero vincitore tra gli snapshot rimasti non anomali (mai un
--        confronto "solo se più recente" qui: deve poter tornare indietro
--        nel tempo se il fallback è più vecchio del current appena
--        invalidato) — se non ne resta nessuno, la riga current viene
--        rimossa (mai una riga anomala esposta come current).
--      - true -> false (il caso reale, confirm_market_price_anomaly):
--        trattata come un candidato fresco, vince solo se più recente del
--        current già presente (stessa sync_market_current_price_snapshot
--        di un insert normale) — se non lo è, non cambia nulla, corretto.
--    Nessun cron di rebuild periodico: lo stato resta corretto in modo
--    puramente incrementale.
--
-- =====================================================================
-- FASE 4 — MAPPING STATUS: MAI incorporato nel current layer
-- =====================================================================
-- Il current layer memorizza SOLO "l'ultimo snapshot non anomalo per
-- (provider_mapping_id, price_type)" — mai un flag "active" o qualunque
-- derivato da market_provider_printings. Il motivo (FASE 1.7): il mapping
-- può cambiare in qualunque momento, indipendentemente dagli snapshot già
-- scritti — se il layer incorporasse "active" al momento dell'insert,
-- diventerebbe stale al primo cambio di mapping senza toccare alcun
-- prezzo, richiedendo un rebuild che il task chiede esplicitamente di
-- evitare. Ogni consumer (inclusa la funzione shadow qui sotto) fa quindi
-- SEMPRE un JOIN leggero e fresco a market_provider_printings/
-- market_mapping_is_active() al momento della lettura, applicato alle
-- sole righe già ridotte del current layer (poche per printing, mai
-- l'intero storico) — mai un rebuild del layer stesso.
--
-- =====================================================================
-- FASE 5 — BACKFILL: RPC admin esplicita, non uno statement automatico
-- nella migration (il task stesso chiede "prima crea, poi shadow, MAI
-- subito il cutover" — un INSERT automatico su ~150k righe dentro una
-- migration application bloccherebbe la transazione senza che l'admin lo
-- decida consapevolmente; stesso pattern già usato per i backfill Market
-- Variant Registry in questo repo).
-- =====================================================================

begin;

-- 1) Tabella — sola lettura per tutti tranne le funzioni SECURITY DEFINER
--    di questa migration (stesso pattern di lockdown di ogni altra tabella
--    di questo progetto: RLS abilitata, zero grant diretti).
create table if not exists public.market_current_price_snapshots (
  provider_mapping_id uuid not null references public.market_provider_printings(id) on delete cascade,
  price_type text not null,
  printing_id uuid not null references public.card_printings(id) on delete cascade,
  provider text not null,
  snapshot_id uuid not null references public.market_price_snapshots(id) on delete cascade,
  normalized_currency text,
  normalized_price numeric(14,4),
  language text,
  condition_reference text,
  foil boolean,
  captured_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (provider_mapping_id, price_type)
);
-- Nuovo pattern di accesso introdotto da questa migration (join da 'owned'
-- via printing_id, la PK è su provider_mapping_id+price_type): indice
-- diretto a supporto, non speculativo.
create index if not exists market_current_price_snapshots_printing_idx
  on public.market_current_price_snapshots(printing_id);

alter table public.market_current_price_snapshots enable row level security;
revoke all on public.market_current_price_snapshots from public, anon, authenticated;

-- 2) sync_market_current_price_snapshot — "promuovi questo snapshot a
--    current per la sua chiave, solo se non anomalo e non più vecchio di
--    quello già presente". Usata sia dal trigger AFTER INSERT sia dal ramo
--    true->false del trigger di anomalia (FASE 3.B).
create or replace function public.sync_market_current_price_snapshot(p_snapshot public.market_price_snapshots)
returns void language plpgsql set search_path = public as $$
begin
  if p_snapshot.provider_mapping_id is null then return; end if;
  if p_snapshot.is_anomalous then return; end if;

  insert into public.market_current_price_snapshots (
    provider_mapping_id, price_type, printing_id, provider, snapshot_id,
    normalized_currency, normalized_price, language, condition_reference, foil,
    captured_at, updated_at
  ) values (
    p_snapshot.provider_mapping_id, p_snapshot.price_type, p_snapshot.printing_id, p_snapshot.provider, p_snapshot.id,
    p_snapshot.normalized_currency, p_snapshot.normalized_price, p_snapshot.language, p_snapshot.condition_reference, p_snapshot.foil,
    p_snapshot.captured_at, now()
  )
  on conflict (provider_mapping_id, price_type) do update set
    printing_id = excluded.printing_id, provider = excluded.provider, snapshot_id = excluded.snapshot_id,
    normalized_currency = excluded.normalized_currency, normalized_price = excluded.normalized_price,
    language = excluded.language, condition_reference = excluded.condition_reference, foil = excluded.foil,
    captured_at = excluded.captured_at, updated_at = now()
  where excluded.captured_at > public.market_current_price_snapshots.captured_at
     or (excluded.captured_at = public.market_current_price_snapshots.captured_at
         and excluded.snapshot_id > public.market_current_price_snapshots.snapshot_id);
end;
$$;

-- 3) rebuild_market_current_price_snapshot — ricalcola da zero il vero
--    vincitore per una chiave dopo che il current registrato è stato
--    invalidato (diventato anomalo). MAI una guardia "solo se più recente"
--    qui: deve poter tornare a uno snapshot più vecchio del current appena
--    invalidato. Se non resta nessuno snapshot valido, rimuove la riga
--    current (mai un prezzo anomalo esposto come "current").
create or replace function public.rebuild_market_current_price_snapshot(p_provider_mapping_id uuid, p_price_type text)
returns void language plpgsql set search_path = public as $$
declare best public.market_price_snapshots;
begin
  select * into best from public.market_price_snapshots
  where provider_mapping_id = p_provider_mapping_id and price_type = p_price_type and not is_anomalous
  order by captured_at desc, id desc
  limit 1;

  if best.id is null then
    delete from public.market_current_price_snapshots
    where provider_mapping_id = p_provider_mapping_id and price_type = p_price_type;
    return;
  end if;

  insert into public.market_current_price_snapshots (
    provider_mapping_id, price_type, printing_id, provider, snapshot_id,
    normalized_currency, normalized_price, language, condition_reference, foil,
    captured_at, updated_at
  ) values (
    best.provider_mapping_id, best.price_type, best.printing_id, best.provider, best.id,
    best.normalized_currency, best.normalized_price, best.language, best.condition_reference, best.foil,
    best.captured_at, now()
  )
  on conflict (provider_mapping_id, price_type) do update set
    printing_id = excluded.printing_id, provider = excluded.provider, snapshot_id = excluded.snapshot_id,
    normalized_currency = excluded.normalized_currency, normalized_price = excluded.normalized_price,
    language = excluded.language, condition_reference = excluded.condition_reference, foil = excluded.foil,
    captured_at = excluded.captured_at, updated_at = now();
end;
$$;

-- 4) Trigger AFTER INSERT — un tentativo di promozione per ogni riga nuova.
create or replace function public.trg_market_current_price_snapshot_after_insert()
returns trigger language plpgsql set search_path = public as $$
begin
  perform public.sync_market_current_price_snapshot(new);
  return null;
end;
$$;
drop trigger if exists market_current_price_snapshot_after_insert on public.market_price_snapshots;
create trigger market_current_price_snapshot_after_insert
after insert on public.market_price_snapshots
for each row execute function public.trg_market_current_price_snapshot_after_insert();

-- 5) Trigger AFTER UPDATE OF is_anomalous — entrambe le direzioni del
--    lifecycle (FASE 3.B).
create or replace function public.trg_market_current_price_snapshot_after_anomaly_change()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.is_anomalous is not distinct from old.is_anomalous then return null; end if;

  if new.is_anomalous then
    -- Rebuild SOLO se questa riga era davvero il current registrato per la
    -- sua chiave (evita lavoro inutile se un futuro percorso marcasse
    -- anomala una riga che non era comunque quella corrente).
    if new.provider_mapping_id is not null and exists (
      select 1 from public.market_current_price_snapshots
      where provider_mapping_id = new.provider_mapping_id
        and price_type = new.price_type
        and snapshot_id = new.id
    ) then
      perform public.rebuild_market_current_price_snapshot(new.provider_mapping_id, new.price_type);
    end if;
  else
    perform public.sync_market_current_price_snapshot(new);
  end if;

  return null;
end;
$$;
drop trigger if exists market_current_price_snapshot_after_anomaly_change on public.market_price_snapshots;
create trigger market_current_price_snapshot_after_anomaly_change
after update of is_anomalous on public.market_price_snapshots
for each row execute function public.trg_market_current_price_snapshot_after_anomaly_change();

-- 6) Backfill — admin, idempotente (ON CONFLICT ... DO UPDATE con la
--    STESSA guardia "solo se più recente" di sync_market_current_price_
--    snapshot: rieseguirlo dopo che i trigger sono già live non può mai
--    far regredire una chiave a un valore più vecchio), deterministico
--    (stesso ORDER BY di ovunque in questo repo: captured_at desc, id
--    desc), non distruttivo (sola lettura di market_price_snapshots,
--    nessuna scrittura lì).
create or replace function public.backfill_market_current_price_snapshots(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  total_keys integer;
  applied_count integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;

  with best as (
    select distinct on (provider_mapping_id, price_type)
      provider_mapping_id, price_type, printing_id, provider, id as snapshot_id,
      normalized_currency, normalized_price, language, condition_reference, foil, captured_at
    from public.market_price_snapshots
    where not is_anomalous and provider_mapping_id is not null
    order by provider_mapping_id, price_type, captured_at desc, id desc
  ), upserted as (
    insert into public.market_current_price_snapshots (
      provider_mapping_id, price_type, printing_id, provider, snapshot_id,
      normalized_currency, normalized_price, language, condition_reference, foil, captured_at, updated_at
    )
    select provider_mapping_id, price_type, printing_id, provider, snapshot_id,
      normalized_currency, normalized_price, language, condition_reference, foil, captured_at, now()
    from best
    on conflict (provider_mapping_id, price_type) do update set
      printing_id = excluded.printing_id, provider = excluded.provider, snapshot_id = excluded.snapshot_id,
      normalized_currency = excluded.normalized_currency, normalized_price = excluded.normalized_price,
      language = excluded.language, condition_reference = excluded.condition_reference, foil = excluded.foil,
      captured_at = excluded.captured_at, updated_at = now()
    where excluded.captured_at > public.market_current_price_snapshots.captured_at
       or (excluded.captured_at = public.market_current_price_snapshots.captured_at
           and excluded.snapshot_id > public.market_current_price_snapshots.snapshot_id)
    returning 1
  )
  select (select count(*) from best), (select count(*) from upserted)
    into total_keys, applied_count;

  return jsonb_build_object('totalKeys', total_keys, 'appliedOrUpdated', applied_count, 'ranAt', now());
end;
$$;
revoke all on function public.backfill_market_current_price_snapshots(text) from public, anon, authenticated;
grant execute on function public.backfill_market_current_price_snapshots(text) to authenticated, anon;

-- 7) SHADOW report — sola lettura, admin-only, MAI esposta al frontend
--    utente (nessuna modifica UI in questa migration): confronta il
--    reference price calcolato con la pipeline LEGACY di oggi (identica,
--    copiata qui verbatim da get_market_watch_summary post step-2) contro
--    quello calcolato dal nuovo current layer, sulle sole printing owned
--    del member che chiama, tutti i provider/price_type.
create or replace function public.market_current_price_layer_shadow_report(p_token text, p_game text default 'yugioh')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  admin boolean;
  result jsonb;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select role = 'admin' into admin from public.team_members where slug = me;
  if not coalesce(admin, false) then raise exception 'Operazione riservata agli admin'; end if;

  with owned as (
    select ci.printing_id
    from public.collection_items ci join public.card_printings cp on cp.id = ci.printing_id
    where ci.owner_slug = me and cp.game = p_game
    group by ci.printing_id
  ), mapping_flags as materialized (
    select id, public.market_mapping_is_active(provider, resolution_status, provider_metadata) active
    from public.market_provider_printings
    where printing_id in (select printing_id from owned)
  ), legacy_eligible as materialized (
    -- Identica a get_market_watch_summary di oggi (post 20260914150000).
    select s.printing_id, s.provider, s.price_type, s.normalized_price, s.normalized_currency, s.captured_at
    from public.market_price_snapshots s
    join owned o on o.printing_id = s.printing_id
    join mapping_flags f on f.id = s.provider_mapping_id
    where not s.is_anomalous and s.normalized_price is not null and f.active
  ), legacy_preferred as (
    select distinct on (s.printing_id, s.provider) s.*
    from legacy_eligible s where s.normalized_currency = 'EUR'
    order by s.printing_id, s.provider, public.market_reference_type(s.provider, s.price_type), s.captured_at desc
  ), legacy_reference as (
    select distinct on (printing_id) printing_id, normalized_price
    from legacy_preferred order by printing_id, public.market_reference_type(provider, price_type)
  ), new_eligible as (
    -- Dal current layer: già un solo candidato per (provider_mapping_id,
    -- price_type), nessuna DISTINCT ON su storico necessaria qui.
    select c.printing_id, c.provider, c.price_type, c.normalized_price
    from public.market_current_price_snapshots c
    join owned o on o.printing_id = c.printing_id
    join mapping_flags f on f.id = c.provider_mapping_id
    where f.active and c.normalized_currency = 'EUR'
  ), new_reference as (
    select distinct on (printing_id) printing_id, normalized_price
    from new_eligible order by printing_id, public.market_reference_type(provider, price_type)
  ), compared as (
    select o.printing_id, l.normalized_price as legacy_price, n.normalized_price as new_price
    from owned o
    left join legacy_reference l on l.printing_id = o.printing_id
    left join new_reference n on n.printing_id = o.printing_id
  ), classified as (
    select *,
      case
        when legacy_price is null and new_price is null then 'both_missing'
        when legacy_price is null then 'missing_legacy'
        when new_price is null then 'missing_current'
        when legacy_price = new_price then 'equal'
        else 'different'
      end as outcome
    from compared
  )
  select jsonb_build_object(
    'totalCompared', count(*),
    'equal', count(*) filter (where outcome = 'equal'),
    'different', count(*) filter (where outcome = 'different'),
    'missingCurrent', count(*) filter (where outcome = 'missing_current'),
    'missingLegacy', count(*) filter (where outcome = 'missing_legacy'),
    'bothMissing', count(*) filter (where outcome = 'both_missing'),
    'sampleMismatches', coalesce((
      select jsonb_agg(jsonb_build_object('printingId', c2.printing_id, 'legacyPrice', c2.legacy_price, 'newPrice', c2.new_price, 'outcome', c2.outcome))
      from (select * from classified where outcome not in ('equal', 'both_missing') limit 20) c2
    ), '[]'::jsonb)
  ) into result
  from classified;

  return coalesce(result, jsonb_build_object('totalCompared', 0, 'equal', 0, 'different', 0, 'missingCurrent', 0, 'missingLegacy', 0, 'bothMissing', 0, 'sampleMismatches', '[]'::jsonb));
end;
$$;
revoke all on function public.market_current_price_layer_shadow_report(text,text) from public, anon, authenticated;
grant execute on function public.market_current_price_layer_shadow_report(text,text) to authenticated, anon;

commit;
