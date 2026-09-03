-- Team Decks: sola lettura dei mazzi di tutti i membri attivi del team.
-- Nessuna nuova tabella, nessun permesso di scrittura sui mazzi altrui:
-- unica superficie esposta e' questa RPC SELECT-only, sicura via session_member.

create or replace function public.list_team_decks(p_token text)
returns table(
  id uuid, owner_slug text, owner_name text, game text, name text, format text,
  signature_card_id text, deck_theme text, deck_box_template text, cover_image_url text,
  cards jsonb, created_at timestamptz, updated_at timestamptz
)
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query select d.id, d.owner_slug, m.full_name, d.game, d.name, d.format,
    d.signature_card_id, d.deck_theme, d.deck_box_template,
    coalesce((select dc.image_url from public.deck_cards dc where dc.deck_id = d.id and dc.image_url <> '' and dc.section in ('main','extra')
      order by (dc.catalog_card_id = d.signature_card_id) desc, case dc.section when 'main' then 0 else 1 end, dc.card_name limit 1), '') cover_image_url,
    coalesce((select jsonb_agg(jsonb_build_object(
      'catalog_card_id', dc.catalog_card_id, 'card_name', dc.card_name, 'image_url', dc.image_url,
      'ban_tcg', dc.ban_tcg, 'section', dc.section, 'quantity', dc.quantity, 'printing_id', dc.printing_id,
      'printing_set_code', (select cp.set_code from public.card_printings cp where cp.id = dc.printing_id),
      'printing_rarity', (select cp.rarity from public.card_printings cp where cp.id = dc.printing_id)
    ) order by dc.section, dc.card_name) from public.deck_cards dc where dc.deck_id = d.id), '[]'::jsonb) cards,
    d.created_at, d.updated_at
  from public.decks d
  join public.team_members m on m.slug = d.owner_slug and m.active
  order by m.full_name, d.updated_at desc;
end;
$$;

revoke all on function public.list_team_decks(text) from public, anon, authenticated;
grant execute on function public.list_team_decks(text) to anon, authenticated;

notify pgrst, 'reload schema';

-- Rollback:
-- drop function if exists public.list_team_decks(text);
-- notify pgrst, 'reload schema';
