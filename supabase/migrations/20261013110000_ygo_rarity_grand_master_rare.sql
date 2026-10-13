-- F.P.T Cards — Nuova rarità ufficiale Konami: "Grand Master Rare" (GMR).
-- Compare nei set 2025+ (es. BLGG) e il guardiano trg_guard_ygo_printing_rarity
-- la rifiutava perché assente dal canone: 18 stampe reali restavano fuori dal
-- catalogo. Il guardiano è guidato dai dati, basta aggiungere canone + alias.
-- Additiva e idempotente.

insert into public.ygo_rarity_canon(code, label, sort_order)
values ('GRAND_MASTER_RARE', 'Grand Master Rare', 113)
on conflict (code) do nothing;

insert into public.ygo_rarity_aliases(alias_key, canonical_code, alias_raw)
values
  ('GRAND MASTER RARE', 'GRAND_MASTER_RARE', 'Grand Master Rare'),
  ('GMR', 'GRAND_MASTER_RARE', 'GMR')
on conflict (alias_key) do nothing;
