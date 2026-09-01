-- P0.4 production follow-up: qualify the card_printings unique target.
-- The RPC output columns are PL/pgSQL variables, so a bare ON CONFLICT column
-- list is ambiguous inside the function. Fresh installs already use ON CONSTRAINT
-- in supabase-printing-editor-integrity.sql; this migration fixes the first rollout.

begin;

do $$
declare
  definition text;
begin
  select pg_get_functiondef(
    'public.correct_collection_item_printing(text,uuid,text,text,text,text,text,text,text,integer)'::regprocedure
  ) into definition;
  definition := replace(
    definition,
    'ON CONFLICT (game, catalog_card_id, set_code, rarity) DO NOTHING',
    'ON CONFLICT ON CONSTRAINT card_printings_game_catalog_card_id_set_code_rarity_key DO NOTHING'
  );
  definition := replace(
    definition,
    'on conflict (game, catalog_card_id, set_code, rarity) do nothing',
    'on conflict on constraint card_printings_game_catalog_card_id_set_code_rarity_key do nothing'
  );
  if position('on conflict (game, catalog_card_id, set_code, rarity)' in lower(definition)) > 0 then
    raise exception 'ON CONFLICT qualification failed';
  end if;
  execute definition;
end;
$$;

notify pgrst, 'reload schema';

commit;
