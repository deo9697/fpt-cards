-- F.P.T Cards — Market Variant Registry: colonna mancante per lo shadow mode.
--
-- Il wiring dello shadow resolver (resolveYgoMarketVariant, vedi
-- market/providers.js) deve persistere anche il "perché" di ogni decisione
-- (es. 'multiple_candidates_no_rarity_signal', 'exact_rarity_single_candidate')
-- — un codice macchina distinto da mapping_notes, che è testo libero per
-- annotazioni di un curatore umano. La migration 20260912110000 non aveva
-- ancora questa colonna (non serviva finché il resolver girava solo offline
-- nei test). Additiva, non tocca nessun'altra colonna/riga esistente.

begin;

alter table public.ygo_market_variants
  add column if not exists resolution_reason text
    check (resolution_reason is null or char_length(resolution_reason) <= 200);

commit;
