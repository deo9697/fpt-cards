-- F.P.T Cards — Market Watch: chiude un varco lasciato da "fix: remove
-- CardTrader as a Market Watch price source" (commit b32a5ac, 2026-09-05).
-- Migration additiva: applicare dopo supabase-mw1-market-mapping-integrity.sql.
-- Non modifica/elimina snapshot, mapping o watchlist esistenti.
--
-- ANOMALIA: quel commit ha rimosso CardTraderProvider e ogni chiamata che lo
-- sincronizza, ma ha lasciato intatto a livello DB market_mapping_is_active():
--   when p_provider <> 'cardmarket' then p_resolution_status in ('resolved','manual')
-- Qualunque mapping CardTrader risolto PRIMA della rimozione (resolution_status
-- 'resolved'/'manual') continua quindi a contare come "attivo" per sempre —
-- nessun sync lo aggiorna più, ma resta eleggibile come prezzo di riferimento.
-- market_reference_type() gli assegna rank 2 (sotto al trend Cardmarket, rank 1),
-- quindi per una printing con mapping Cardmarket EXACT/AGGREGATE non cambia
-- nulla — ma per una printing dove Cardmarket NON ha risolto nulla (in coda
-- "Conferma rarità", o provider_product_not_found) e che aveva UN VECCHIO
-- mapping CardTrader risolto, oggi risulterebbe l'UNICO prezzo disponibile:
-- congelato al giorno della rimozione, mostrato in riga come un prezzo
-- normale, senza alcun badge "vecchio"/"aggregato" (quei badge dipendono da
-- resolverStatus/mappingReason, che per un mapping CardTrader storico erano
-- validi e non vengono ricalcolati da nessun sync). Stesso discorso per
-- list_market_price_history, che filtra ancora esplicitamente
-- "provider='cardtrader' and price_type='reference'" nel suo WHERE.
--
-- FIX: un solo punto di verità. market_active_price_snapshots e
-- market_derived_price_snapshots (e tutto ciò che ci si appoggia sopra:
-- market_latest_prices, list_market_watch, list_market_dashboard_movers,
-- list_market_price_history, list_collection_share_requests) filtrano già
-- tramite questa funzione — basta farla tornare sempre false per qualunque
-- provider diverso da 'cardmarket' per spegnere immediatamente ogni mapping
-- CardTrader storico ovunque, senza toccare le singole query.

create or replace function public.market_mapping_is_active(
  p_provider text,
  p_resolution_status text,
  p_provider_metadata jsonb
)
returns boolean
language sql
immutable
set search_path=public
as $$
  select case
    -- CardTrader è stato rimosso come fonte prezzi (commit b32a5ac,
    -- 2026-09-05): nessun provider diverso da 'cardmarket' è oggi
    -- sincronizzato, quindi nessun mapping storico va più considerato
    -- attivo, per quanto fosse stato risolto correttamente a suo tempo.
    when p_provider <> 'cardmarket'
      then false
    when p_resolution_status = 'manual'
      then coalesce(p_provider_metadata->>'active','true') <> 'false'
    else p_resolution_status = 'resolved'
      and coalesce(p_provider_metadata->>'active','false') = 'true'
      and p_provider_metadata->>'resolverStatus' in ('EXACT','PROVIDER_AGGREGATE')
  end;
$$;

revoke all on function public.market_mapping_is_active(text,text,jsonb) from public,anon,authenticated;

notify pgrst, 'reload schema';
