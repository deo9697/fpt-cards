-- F.P.T Cards — Fast Scan catalog identity aliases.
-- Migration additiva preparata, NON applicata automaticamente al progetto Supabase.
-- Gestisce gli ID artwork alternativi senza usare il nome carta come identità.

create table if not exists public.card_catalog_aliases (
  game text not null check (game in ('yugioh', 'onepiece')),
  alias_catalog_card_id text not null
    check (char_length(trim(alias_catalog_card_id)) between 1 and 100),
  canonical_catalog_card_id text not null
    check (char_length(trim(canonical_catalog_card_id)) between 1 and 100),
  source text not null default '' check (char_length(source) <= 100),
  created_at timestamptz not null default now(),
  primary key (game, alias_catalog_card_id),
  check (trim(alias_catalog_card_id) <> trim(canonical_catalog_card_id))
);

create index if not exists card_catalog_aliases_canonical_idx
  on public.card_catalog_aliases(game, canonical_catalog_card_id);

alter table public.card_catalog_aliases enable row level security;
revoke all on public.card_catalog_aliases from public, anon, authenticated;

-- YGOPRODeck espone 94145021 come identità canonica di Droll & Lock Bird
-- e 94145022 come artwork alternativo della stessa carta.
insert into public.card_catalog_aliases(
  game, alias_catalog_card_id, canonical_catalog_card_id, source
) values (
  'yugioh', '94145022', '94145021', 'YGOPRODeck alternate artwork'
)
on conflict (game, alias_catalog_card_id) do nothing;

do $$
begin
  if exists (
    select 1
    from public.card_catalog_aliases
    where game = 'yugioh'
      and alias_catalog_card_id = '94145022'
      and canonical_catalog_card_id <> '94145021'
  ) then
    raise exception 'Alias catalogo 94145022 già associato a una carta differente';
  end if;
end $$;

create or replace function public.resolve_catalog_card_id(
  p_game text, p_catalog_card_id text
) returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (
      select a.canonical_catalog_card_id
      from public.card_catalog_aliases a
      where a.game = p_game
        and a.alias_catalog_card_id = trim(p_catalog_card_id)
    ),
    trim(p_catalog_card_id)
  )
$$;

revoke all on function public.resolve_catalog_card_id(text,text)
  from public, anon, authenticated;

-- Evita di creare due printing identiche quando un alias viene canonizzato.
do $$
begin
  if exists (
    select 1
    from public.card_printings source_printing
    join public.card_catalog_aliases alias
      on alias.game = source_printing.game
     and alias.alias_catalog_card_id = source_printing.catalog_card_id
    join public.card_printings canonical_printing
      on canonical_printing.game = source_printing.game
     and canonical_printing.catalog_card_id = alias.canonical_catalog_card_id
     and canonical_printing.set_code = source_printing.set_code
     and canonical_printing.rarity = source_printing.rarity
     and canonical_printing.id <> source_printing.id
  ) then
    raise exception 'Canonicalizzazione catalogo bloccata: printing duplicate da riconciliare';
  end if;
end $$;

-- Conserva gli UUID delle printing e quindi tutti i riferimenti raccolta/prestiti.
update public.card_printings printing
set catalog_card_id = alias.canonical_catalog_card_id
from public.card_catalog_aliases alias
where alias.game = printing.game
  and alias.alias_catalog_card_id = printing.catalog_card_id;

create or replace function public.canonicalize_card_printing_catalog_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.catalog_card_id := public.resolve_catalog_card_id(new.game, new.catalog_card_id);
  return new;
end;
$$;

revoke all on function public.canonicalize_card_printing_catalog_id()
  from public, anon, authenticated;

drop trigger if exists canonicalize_card_printing_catalog_id_before_insert
  on public.card_printings;
create trigger canonicalize_card_printing_catalog_id_before_insert
before insert on public.card_printings
for each row execute function public.canonicalize_card_printing_catalog_id();

create or replace function public.reconcile_catalog_identity(
  p_game text, p_catalog_card_id text, p_set_code text, p_card_name text,
  p_image_url text default ''
) returns text language plpgsql stable security definer set search_path = public as $$
declare
  canonical_id text;
  known boolean;
  conflicting boolean;
  image_id text;
begin
  if p_game not in ('yugioh','onepiece')
    or char_length(trim(coalesce(p_catalog_card_id,''))) < 1
    or char_length(trim(coalesce(p_card_name,''))) < 1 then
    return 'mismatch';
  end if;

  canonical_id := public.resolve_catalog_card_id(p_game, p_catalog_card_id);

  select exists(
    select 1 from public.card_printings printing
    where printing.game = p_game
      and printing.catalog_card_id = canonical_id
  ) into known;

  select exists(
    select 1 from public.card_printings printing
    where printing.game = p_game and (
      (printing.catalog_card_id = canonical_id
        and lower(trim(printing.card_name)) <> lower(trim(p_card_name)))
      or
      (lower(trim(printing.card_name)) = lower(trim(p_card_name))
        and printing.catalog_card_id <> canonical_id)
    )
  ) into conflicting;

  if conflicting then return 'mismatch'; end if;

  if p_game = 'yugioh' and coalesce(p_image_url,'') <> '' then
    image_id := substring(
      p_image_url from '/([0-9]{5,10})\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$'
    );
    if image_id is not null
      and public.resolve_catalog_card_id(p_game, image_id) <> canonical_id then
      return 'mismatch';
    end if;
  end if;

  return case when known then 'valid' else 'warning' end;
end;
$$;

revoke all on function public.reconcile_catalog_identity(text,text,text,text,text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
