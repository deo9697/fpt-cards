-- One Piece: i multicolore arrivavano dalla fonte come "Green Yellow" (con lo
-- spazio) e venivano salvati come un unico colore in card_printings.game_metadata.
-- Qui ogni valore viene separato su spazi, "/" e virgole e restano solo i sei
-- colori del gioco, nell'ordine in cui compaiono. Il normalizer della sync
-- (supabase/functions/onepiece-catalog-sync/normalizer.mjs) ora fa lo stesso.
-- Idempotente: tocca solo le righe che hanno ancora un valore non canonico.
with fixed as (
  select p.id,
         coalesce((
           select jsonb_agg(s.color order by s.first_pos)
           from (
             select initcap(lower(t.token)) as color, min(e.ord * 100 + t.tord) as first_pos
             from jsonb_array_elements_text(p.game_metadata -> 'colors') with ordinality as e(val, ord),
                  regexp_split_to_table(btrim(e.val), '[[:space:]/,]+') with ordinality as t(token, tord)
             where lower(t.token) in ('red', 'green', 'blue', 'purple', 'black', 'yellow')
             group by 1
           ) s
         ), '[]'::jsonb) as colors
  from public.card_printings p
  where p.game = 'onepiece'
    and jsonb_typeof(p.game_metadata -> 'colors') = 'array'
    and exists (
      select 1 from jsonb_array_elements_text(p.game_metadata -> 'colors') v(value)
      where v.value not in ('Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow')
    )
)
update public.card_printings p
set game_metadata = jsonb_set(p.game_metadata, '{colors}', f.colors)
from fixed f
where f.id = p.id;
