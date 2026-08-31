-- F.P.T Cards - rollback catalog verification v1.
-- Usare esclusivamente per annullare supabase-catalog-verification-v1.sql.
-- Il preflight di rollout deve avere confermato che questi oggetti non
-- esistevano prima della migration.

begin;

drop function if exists public.repair_collection_item_catalog_identity(
  text, uuid, text, text, text, integer
);
drop function if exists public.list_collection_catalog_verification_queue(text, integer);

drop trigger if exists invalidate_card_printing_catalog_verification_on_change
  on public.card_printings;
drop function if exists public.invalidate_card_printing_catalog_verification();

drop index if exists public.card_printings_catalog_verification_queue_idx;

alter table public.card_printings
  drop constraint if exists card_printings_catalog_verification_status_check,
  drop constraint if exists card_printings_catalog_verification_version_check,
  drop column if exists catalog_verification_error,
  drop column if exists catalog_verified_at,
  drop column if exists catalog_verification_version,
  drop column if exists catalog_verification_status;

-- Rimuove soltanto l'alias inserito da questa migration, senza toccare un
-- eventuale mapping omonimo creato o modificato da altre procedure.
delete from public.card_catalog_aliases
where game = 'yugioh'
  and alias_catalog_card_id = '73642296'
  and canonical_catalog_card_id = '73642297'
  and source = 'FPT legacy Ghost Belle identity';

notify pgrst, 'reload schema';

commit;
