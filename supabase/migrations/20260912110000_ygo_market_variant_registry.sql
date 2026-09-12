-- F.P.T Cards — Market Variant Registry (fondamenta), Yu-Gi-Oh! only.
--
-- Problema confermato dall'audit di Market Watch/Cardmarket (pre-esistente,
-- non introdotto qui): market_provider_printings.unique(printing_id, provider,
-- variant_key) ha variant_key sempre fisso a 'default' per Cardmarket, quindi
-- una printing può mappare AL MASSIMO un solo prodotto Cardmarket. Il feed
-- bulk Cardmarket non porta la rarity (solo la pagina prodotto singola ce
-- l'ha), quindi resolveCardmarketPrinting() (supabase/functions/market-sync/
-- index.ts), quando più prodotti condividono nome+espansione — esattamente
-- il caso Rarity Collection (Super/Ultra/Secret/Platinum Secret/Collector's/
-- Ultimate/Quarter Century Secret Rare sullo stesso set_code) — li tratta
-- come un aggregato unico e mostra il prezzo MINIMO tra rarità diverse.
--
-- Questa migration introduce solo le fondamenta strutturali:
--   1) una canonicalizzazione UNICA e centralizzata delle rarity Yu-Gi-Oh!
--      (tabella dati, non `.includes()`/euristiche in codice — estendibile
--      con una INSERT, mai un redeploy);
--   2) ygo_market_variants: il livello PRINTING -> RARITY VARIANT -> PRODOTTO
--      CARDMARKET, distinto sia da ygo_printing_registry (CARD/PRINTING/
--      ARTWORK, volutamente rarity-agnostic) sia da market_provider_printings
--      (che resta 1:1 per printing finché non verrà esteso a leggere da qui).
--
-- Additiva e inerte: nessuna tabella esistente viene alterata, nessun dato
-- pricing esistente viene toccato, nessuna RPC/Edge Function viene modificata
-- in questa migration. card_printings, market_provider_printings,
-- market_price_snapshots e ygo_printing_registry restano invariati e
-- continuano a funzionare esattamente come oggi. Il resolver
-- (resolveYgoMarketVariant), il collegamento da Market Watch e il backfill
-- sono fasi successive separate, deliberatamente non incluse qui.

begin;

-- 1) Canonicalizzazione rarity — tabella dati, non codice. I 42 codici e le
--    alias "raw"/lowercase sono presi 1:1 da SUPPORTED_RARITIES in
--    supabase/functions/market-sync/index.ts (market/providers.js ne è la
--    copia identica) — l'unico vocabolario di rarity Yu-Gi-Oh! già validato
--    contro dati reali in produzione in questo progetto. Le sigle brevi
--    (SR/UR/SE/SCR/CR/UTR/UL/QCSR/QCSE) sono aggiunte come alias ulteriori:
--    se in futuro ne emergono altre, si aggiungono con una INSERT, mai
--    ripescando `.includes()`/regex ad-hoc nel codice applicativo.
create table if not exists public.ygo_rarity_canon (
  code text primary key check (code = upper(code) and char_length(code) between 1 and 60),
  label text not null check (char_length(label) between 1 and 100),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.ygo_rarity_canon enable row level security;
revoke all on public.ygo_rarity_canon from public, anon, authenticated;

-- alias_key è la forma normalizzata (vedi normalize_ygo_rarity_key sotto);
-- alias_raw è la stringa originale, tenuta solo per leggibilità/audit.
create table if not exists public.ygo_rarity_aliases (
  alias_key text primary key check (char_length(alias_key) between 1 and 120),
  canonical_code text not null references public.ygo_rarity_canon(code) on delete cascade,
  alias_raw text not null check (char_length(alias_raw) between 1 and 100),
  created_at timestamptz not null default now()
);

create index if not exists ygo_rarity_aliases_canonical_code_idx
  on public.ygo_rarity_aliases(canonical_code);

alter table public.ygo_rarity_aliases enable row level security;
revoke all on public.ygo_rarity_aliases from public, anon, authenticated;

-- Normalizzazione della chiave alias: rimuove apostrofi/apici (senza
-- inserire spazi, altrimenti "Collector's Rare" e "Collectors Rare"
-- finirebbero su due chiavi diverse), poi collassa ogni altra sequenza di
-- caratteri non alfanumerici (spazi, parentesi, "/", ecc.) in uno spazio
-- singolo. IMMUTABLE: nessuna lettura da tabella, solo trasformazione di
-- stringa — può essere usata anche in un indice/colonna generata in futuro.
create or replace function public.normalize_ygo_rarity_key(p_value text)
returns text language sql immutable set search_path = '' as $$
  select nullif(
    upper(trim(both ' ' from regexp_replace(
      regexp_replace(coalesce($1, ''), '[''’]', '', 'g'),
      '[^A-Za-z0-9]+', ' ', 'g'
    ))),
    ''
  )
$$;

-- Unico punto di canonicalizzazione rarity per tutto il progetto: lookup
-- deterministico sulla tabella alias, MAI un guess. Se la stringa grezza non
-- è in tabella, ritorna NULL (rarity non ancora nota al sistema) invece di
-- indovinare — un mapping_status='unresolved' a valle è sempre preferibile a
-- un canonical sbagliato.
create or replace function public.normalize_ygo_rarity(p_rarity text)
returns text language sql stable set search_path = '' as $$
  select a.canonical_code
  from public.ygo_rarity_aliases a
  where a.alias_key = public.normalize_ygo_rarity_key(p_rarity)
  limit 1
$$;

insert into public.ygo_rarity_canon (code, label, sort_order) values
  ('COMMON', 'Common', 0),
  ('RARE', 'Rare', 10),
  ('SUPER_RARE', 'Super Rare', 20),
  ('ULTRA_RARE', 'Ultra Rare', 30),
  ('ULTRA_RARE_PHARAOHS_RARE', 'Ultra Rare (Pharaoh''s Rare)', 35),
  ('SECRET_RARE', 'Secret Rare', 40),
  ('EXTRA_SECRET_RARE', 'Extra Secret Rare', 42),
  ('20TH_SECRET_RARE', '20th Secret Rare', 44),
  ('PRISMATIC_SECRET_RARE', 'Prismatic Secret Rare', 46),
  ('GOLD_SECRET_RARE', 'Gold Secret Rare', 48),
  ('PLATINUM_SECRET_RARE', 'Platinum Secret Rare', 50),
  ('QUARTER_CENTURY_SECRET_RARE', 'Quarter Century Secret Rare', 52),
  ('COLLECTORS_RARE', 'Collector''s Rare', 54),
  ('PRISMATIC_COLLECTORS_RARE', 'Prismatic Collector''s Rare', 56),
  ('ULTIMATE_RARE', 'Ultimate Rare', 60),
  ('PRISMATIC_ULTIMATE_RARE', 'Prismatic Ultimate Rare', 62),
  ('GHOST_RARE', 'Ghost Rare', 64),
  ('GHOST_GOLD_RARE', 'Ghost/Gold Rare', 66),
  ('STARLIGHT_RARE', 'Starlight Rare', 70),
  ('GOLD_RARE', 'Gold Rare', 72),
  ('PREMIUM_GOLD_RARE', 'Premium Gold Rare', 74),
  ('PLATINUM_RARE', 'Platinum Rare', 76),
  ('MOSAIC_RARE', 'Mosaic Rare', 78),
  ('SHATTERFOIL_RARE', 'Shatterfoil Rare', 80),
  ('STARFOIL_RARE', 'Starfoil Rare', 82),
  ('HOLOGRAPHIC_RARE', 'Holographic Rare', 84),
  ('PARALLEL_RARE', 'Parallel Rare', 90),
  ('NORMAL_PARALLEL_RARE', 'Normal Parallel Rare', 91),
  ('SUPER_PARALLEL_RARE', 'Super Parallel Rare', 92),
  ('ULTRA_PARALLEL_RARE', 'Ultra Parallel Rare', 93),
  ('DUEL_TERMINAL_NORMAL_PARALLEL_RARE', 'Duel Terminal Normal Parallel Rare', 94),
  ('DUEL_TERMINAL_RARE_PARALLEL_RARE', 'Duel Terminal Rare Parallel Rare', 95),
  ('DUEL_TERMINAL_SUPER_PARALLEL_RARE', 'Duel Terminal Super Parallel Rare', 96),
  ('DUEL_TERMINAL_ULTRA_PARALLEL_RARE', 'Duel Terminal Ultra Parallel Rare', 97),
  ('MILLENNIUM_RARE', 'Millennium Rare', 100),
  ('MILLENNIUM_SUPER_RARE', 'Millennium Super Rare', 101),
  ('MILLENNIUM_ULTRA_RARE', 'Millennium Ultra Rare', 102),
  ('MILLENNIUM_SECRET_RARE', 'Millennium Secret Rare', 103),
  ('MILLENNIUM_GOLD_RARE', 'Millennium Gold Rare', 104),
  ('SHORT_PRINT', 'Short Print', 110),
  ('SUPER_SHORT_PRINT', 'Super Short Print', 111),
  ('ULTRA_SHORT_PRINT', 'Ultra Short Print', 112)
on conflict (code) do update set label = excluded.label, sort_order = excluded.sort_order;

-- Alias grezzi: normalize_ygo_rarity_key() fa upper() e rimuove apostrofi
-- senza inserire spazi, quindi "Common"/"common" e "Collector's Rare"/
-- "Collectors Rare" collassano già sulla STESSA chiave — ripeterli come righe
-- separate qui farebbe fallire l'INSERT (ON CONFLICT non può toccare la
-- stessa riga due volte nella stessa istruzione). Una sola forma "raw" per
-- ogni chiave normalizzata distinta; il case/l'apostrofo sono già gestiti
-- dalla funzione, non serve elencare le varianti di sola forma.
insert into public.ygo_rarity_aliases (alias_key, canonical_code, alias_raw)
select public.normalize_ygo_rarity_key(v.alias_raw), v.canonical_code, v.alias_raw
from (values
  ('Common', 'COMMON'), ('New', 'COMMON'), ('Reprint', 'COMMON'),
  ('Rare', 'RARE'),
  ('Super Rare', 'SUPER_RARE'), ('SR', 'SUPER_RARE'),
  ('Ultra Rare', 'ULTRA_RARE'), ('UR', 'ULTRA_RARE'),
  ('Ultra Rare (Pharaoh''s Rare)', 'ULTRA_RARE_PHARAOHS_RARE'),
  ('Secret Rare', 'SECRET_RARE'), ('SE', 'SECRET_RARE'), ('SCR', 'SECRET_RARE'),
  ('Extra Secret Rare', 'EXTRA_SECRET_RARE'),
  ('20th Secret Rare', '20TH_SECRET_RARE'),
  ('20th Anniversary Secret Rare', '20TH_SECRET_RARE'),
  ('Prismatic Secret Rare', 'PRISMATIC_SECRET_RARE'),
  ('Gold Secret Rare', 'GOLD_SECRET_RARE'),
  ('Platinum Secret Rare', 'PLATINUM_SECRET_RARE'),
  ('Quarter Century Secret Rare', 'QUARTER_CENTURY_SECRET_RARE'),
  ('Quarter Century', 'QUARTER_CENTURY_SECRET_RARE'), ('QCSR', 'QUARTER_CENTURY_SECRET_RARE'), ('QCSE', 'QUARTER_CENTURY_SECRET_RARE'),
  ('Collector''s Rare', 'COLLECTORS_RARE'), ('CR', 'COLLECTORS_RARE'),
  ('Prismatic Collector''s Rare', 'PRISMATIC_COLLECTORS_RARE'),
  ('Ultimate Rare', 'ULTIMATE_RARE'), ('UTR', 'ULTIMATE_RARE'), ('UL', 'ULTIMATE_RARE'),
  ('Prismatic Ultimate Rare', 'PRISMATIC_ULTIMATE_RARE'),
  ('Ghost Rare', 'GHOST_RARE'),
  ('Ghost/Gold Rare', 'GHOST_GOLD_RARE'),
  ('Starlight Rare', 'STARLIGHT_RARE'),
  ('Gold Rare', 'GOLD_RARE'),
  ('Premium Gold Rare', 'PREMIUM_GOLD_RARE'),
  ('Platinum Rare', 'PLATINUM_RARE'),
  ('Mosaic Rare', 'MOSAIC_RARE'),
  ('Shatterfoil Rare', 'SHATTERFOIL_RARE'),
  ('Starfoil Rare', 'STARFOIL_RARE'),
  ('Holographic Rare', 'HOLOGRAPHIC_RARE'),
  ('Parallel Rare', 'PARALLEL_RARE'),
  ('Normal Parallel Rare', 'NORMAL_PARALLEL_RARE'),
  ('Super Parallel Rare', 'SUPER_PARALLEL_RARE'),
  ('Ultra Parallel Rare', 'ULTRA_PARALLEL_RARE'),
  ('Duel Terminal Normal Parallel Rare', 'DUEL_TERMINAL_NORMAL_PARALLEL_RARE'),
  ('Duel Terminal Rare Parallel Rare', 'DUEL_TERMINAL_RARE_PARALLEL_RARE'),
  ('Duel Terminal Super Parallel Rare', 'DUEL_TERMINAL_SUPER_PARALLEL_RARE'),
  ('Duel Terminal Ultra Parallel Rare', 'DUEL_TERMINAL_ULTRA_PARALLEL_RARE'),
  ('Millennium Rare', 'MILLENNIUM_RARE'),
  ('Millennium Super Rare', 'MILLENNIUM_SUPER_RARE'),
  ('Millennium Ultra Rare', 'MILLENNIUM_ULTRA_RARE'),
  ('Millennium Secret Rare', 'MILLENNIUM_SECRET_RARE'),
  ('Millennium Gold Rare', 'MILLENNIUM_GOLD_RARE'),
  ('Short Print', 'SHORT_PRINT'),
  ('Super Short Print', 'SUPER_SHORT_PRINT'),
  ('Ultra Short Print', 'ULTRA_SHORT_PRINT')
) as v(alias_raw, canonical_code)
on conflict (alias_key) do update set canonical_code = excluded.canonical_code, alias_raw = excluded.alias_raw;

-- 2) Market Variant Registry — PRINTING -> RARITY VARIANT -> PRODOTTO
--    CARDMARKET. Una riga per printing (una printing è già rarity-scoped:
--    card_printings.unique(game, catalog_card_id, set_code, rarity,
--    variant_id) garantisce che due rarità diverse abbiano già printing_id
--    diversi oggi — non è quello il gap, vedi header). candidate_product_ids
--    conserva il gruppo di prodotti Cardmarket equivalenti trovato da un
--    resolver automatico quando la rarity non basta a scegliere uno solo
--    (stato 'ambiguous'/'conflict'), cosa che oggi il resolver calcola in
--    memoria (candidates:matches) ma non persiste mai — necessaria per un
--    futuro admin resolver stile Artwork Resolver.
create table if not exists public.ygo_market_variants (
  id uuid primary key default gen_random_uuid(),
  printing_id uuid not null references public.card_printings(id) on delete cascade,
  rarity_raw text not null default '' check (char_length(rarity_raw) <= 100),
  rarity_canonical text references public.ygo_rarity_canon(code),
  cardmarket_product_id text check (cardmarket_product_id is null or char_length(trim(cardmarket_product_id)) between 1 and 100),
  cardmarket_expansion_id text check (cardmarket_expansion_id is null or char_length(trim(cardmarket_expansion_id)) between 1 and 100),
  candidate_product_ids jsonb not null default '[]'::jsonb,
  mapping_source text check (mapping_source is null or mapping_source in ('manual', 'registry', 'resolver', 'legacy')),
  mapping_confidence numeric check (mapping_confidence is null or (mapping_confidence between 0 and 1)),
  mapping_status text not null default 'unresolved'
    check (mapping_status in ('unresolved', 'resolved', 'ambiguous', 'conflict', 'verified')),
  mapping_notes text check (mapping_notes is null or char_length(mapping_notes) <= 1000),
  verified boolean not null default false,
  verified_at timestamptz,
  verified_by text references public.team_members(slug),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (printing_id)
);

create index if not exists ygo_market_variants_status_idx
  on public.ygo_market_variants(mapping_status);
create index if not exists ygo_market_variants_rarity_canonical_idx
  on public.ygo_market_variants(rarity_canonical) where rarity_canonical is not null;
create index if not exists ygo_market_variants_cardmarket_product_idx
  on public.ygo_market_variants(cardmarket_product_id) where cardmarket_product_id is not null;

alter table public.ygo_market_variants enable row level security;
revoke all on public.ygo_market_variants from public, anon, authenticated;

create or replace function public.touch_ygo_market_variants_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists touch_ygo_market_variants_updated_at on public.ygo_market_variants;
create trigger touch_ygo_market_variants_updated_at before update on public.ygo_market_variants
for each row execute function public.touch_ygo_market_variants_updated_at();

commit;
