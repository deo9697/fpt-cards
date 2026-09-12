-- F.P.T Cards — Market Variant Registry: follow-up minimale al CHECK di
-- mapping_source. La migration 20260912110000_ygo_market_variant_registry.sql
-- è già applicata live e non va modificata retroattivamente: questa migration
-- si limita a droppare/ricreare SOLO il constraint
-- ygo_market_variants_mapping_source_check per accettare anche
-- 'verified_set_template' (introdotto da 20260912200000_ygo_market_variant_
-- set_templates.sql), che il safe apply del set-template resolver prova a
-- scrivere e che il DB rifiutava con 23514.
--
-- Nessun dato toccato: nessun update/backfill sulle righe esistenti, nessuna
-- mapping già risolta/verificata/manuale viene riscritta qui. Nessuna
-- modifica a pricing, Market Watch, Cardmarket mapping, Printing Registry o
-- all'Edge Function.

begin;

alter table public.ygo_market_variants
  drop constraint if exists ygo_market_variants_mapping_source_check;

alter table public.ygo_market_variants
  add constraint ygo_market_variants_mapping_source_check
  check (
    mapping_source is null
    or mapping_source in (
      'manual',
      'registry',
      'resolver',
      'legacy',
      'verified_set_template'
    )
  );

commit;
