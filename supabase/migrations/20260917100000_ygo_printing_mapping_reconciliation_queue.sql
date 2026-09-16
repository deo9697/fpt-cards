-- F.P.T Cards — Fast Scan caso 4: printing_mapping_status unresolved/conflict
-- (ygo_printing_registry/card_printings) mai riconciliato per le printing
-- REALMENTE possedute. Fino ad oggi risolto solo al momento della scansione
-- (Fast Scan chiama resolveYgoPrintings su un set_code appena letto), mai
-- retroattivamente per printing già in collezione la cui risoluzione era
-- fallita in passato (YGOResources irraggiungibile quel giorno, artwork
-- index non ancora sincronizzato, ecc.) — motivo del residuo "118 mapping
-- unresolved/conflict" nell'audit del 2026-09-16.
--
-- Approccio: POST-SAVE RECONCILIATION, come richiesto esplicitamente,
-- NON un arricchimento della cache locale di Fast Scan (js/fast-scan-
-- catalog-cache.js/list_catalog_printings_index restano invariati — questa
-- migration non li tocca). Stesso pattern già maturo di case 3
-- (catalog_verification_status, vedi 20260912141500_catalog_verification_
-- queue_throttle.sql): una coda piccola e limitata, scoped alle SOLE
-- printing possedute dal chiamante, letta dopo che i dati sono già salvati
-- (mai un gate sul salvataggio stesso).
--
-- Riusa l'infrastruttura di risoluzione/scrittura GIÀ esistente e matura
-- (js/ygo-printing-registry.js: resolveYgoPrintings -> apply_ygo_printing_
-- mappings, la stessa pipeline che Fast Scan usa già in scansione) — questa
-- migration aggiunge SOLO la coda di lettura owner-scoped, nessuna nuova
-- RPC di scrittura.
--
-- Throttle: a differenza di catalog_verification_status (che ha un sistema
-- di backoff esponenziale dedicato con colonne attempts/retry_after, per un
-- volume di partenza di migliaia di righe), qui basta un cooldown FISSO più
-- semplice sulla colonna printing_mapping_checked_at già esistente (scritta
-- da apply_ygo_printing_mappings ad ogni tentativo, verified o no): un
-- volume di partenza di ~100 righe non giustifica la stessa macchina di
-- backoff esponenziale — proporzionato, non sovradimensionato. Una printing
-- genuinamente irrisolvibile (set code legacy/regionale mai indicizzato da
-- YGOResources, stesso caso di MIP-1010 già documentato nella migration del
-- registro) viene ritentata al massimo una volta al giorno per chiamante,
-- non ad ogni singolo salvataggio/bootstrap.
--
-- 'conflict' non viene MAI passato al resolver da questa coda (il client
-- consumer, js/ygo-printing-mapping-reconciliation.js, filtra prima di
-- chiamare resolveYgoPrintings): un conflict richiede revisione umana per
-- design (vedi apply_ygo_printing_mappings, "non sovrascrivere in
-- automatico"), ririsolverlo produrrebbe solo lo stesso conflitto salvato di
-- nuovo — la coda lo restituisce comunque per farlo CONTARE/segnalare, mai
-- per farlo processare in automatico.

begin;

create or replace function public.list_collection_printing_mapping_queue(
  p_token text, p_limit integer default 20
) returns table(
  set_code text, mapping_status text
) language plpgsql stable security definer set search_path = public, extensions as $$
declare
  me text := public.session_member(p_token);
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  -- Nessun DISTINCT ON necessario qui (a differenza di list_collection_
  -- catalog_verification_queue): quella coda joina collection_items,
  -- moltiplicando le righe per printing posseduta più volte; questa usa un
  -- EXISTS (mai un JOIN), quindi cp.id è già unico per costruzione.
  return query
    select cp.set_code, coalesce(cp.printing_mapping_status, 'unresolved') as mapping_status
    from public.card_printings cp
    where cp.game = 'yugioh' and cp.set_code <> ''
      and coalesce(cp.printing_mapping_status, 'unresolved') in ('unresolved', 'conflict')
      and (cp.printing_mapping_checked_at is null or cp.printing_mapping_checked_at < now() - interval '24 hours')
      and exists (
        select 1 from public.collection_items ci
        where ci.printing_id = cp.id and ci.owner_slug = me
      )
    order by cp.printing_mapping_checked_at nulls first
    limit v_limit;
end;
$$;

revoke all on function public.list_collection_printing_mapping_queue(text, integer)
  from public, anon, authenticated;
grant execute on function public.list_collection_printing_mapping_queue(text, integer)
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
