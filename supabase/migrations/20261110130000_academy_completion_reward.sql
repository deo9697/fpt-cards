-- Accademia del Duellante (tutorial Yu-Gi-Oh!): ricompensa per chi la completa.
--
-- Richiesta 2026-11-09: chi finisce il tutorial guadagna 500 XP e il titolo
-- "Terza Media". Una volta sola per membro: xp_transactions ha già il vincolo
-- unique (member_slug, source_type, source_id), quindi un source_id fisso
-- rende il riscatto idempotente (un secondo tentativo non dà altri XP).
--
-- Additiva: il check su source_type passa da ('match') a ('match','academy');
-- le righe esistenti sono tutte 'match' e restano valide.

begin;

alter table public.xp_transactions drop constraint if exists xp_transactions_source_type_check;
alter table public.xp_transactions add constraint xp_transactions_source_type_check
  check (source_type in ('match', 'academy'));

create or replace function public.claim_academy_reward(p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  me text := public.session_member(p_token);
  reward constant integer := 500;
  academy_source constant uuid := '00000000-0000-4000-a000-00000000ac01';
  inserted integer := 0;
  total_before integer; level_before integer; total_after integer; level_after integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;

  insert into public.xp_transactions(member_slug, source_type, source_id, xp_amount, game)
    values (me, 'academy', academy_source, reward, 'yugioh')
    on conflict (member_slug, source_type, source_id) do nothing;
  get diagnostics inserted = row_count;

  insert into public.member_progression(member_slug, total_xp, level) values (me, 0, 1)
    on conflict (member_slug) do nothing;
  select total_xp, level into total_before, level_before from public.member_progression where member_slug = me;

  if inserted > 0 then
    total_after := total_before + reward;
    level_after := public.level_from_xp(total_after);
    update public.member_progression set total_xp = total_after, level = level_after where member_slug = me;
  else
    total_after := total_before; level_after := level_before;
  end if;

  insert into public.member_cosmetic_unlocks(member_slug, cosmetic_id) values (me, 'title_terza_media')
    on conflict (member_slug, cosmetic_id) do nothing;

  return jsonb_build_object(
    'xpAwarded', case when inserted > 0 then reward else 0 end,
    'alreadyClaimed', inserted = 0,
    'totalXp', total_after, 'level', level_after, 'levelUp', level_after > level_before,
    'title', 'title_terza_media'
  );
end;
$function$;

revoke all on function public.claim_academy_reward(text) from public, anon, authenticated;
grant execute on function public.claim_academy_reward(text) to anon, authenticated;

commit;
