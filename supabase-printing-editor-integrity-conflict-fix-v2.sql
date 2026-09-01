-- P0.4 production rollout retry: pg_get_functiondef normalizes the clause to
-- lowercase, so qualify that normalized form and assert the replacement.

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
