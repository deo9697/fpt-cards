-- F.P.T Cards - P0 Fast Scan: durable idempotency and set-based collection reads.
-- Additive tables; RPC replacements preserve the existing response contracts.

create table if not exists public.fast_scan_batches (
  owner_slug text not null references public.team_members(slug) on delete cascade,
  scan_batch_id uuid not null,
  payload_hash text not null check (char_length(payload_hash) between 8 and 128),
  total_chunks integer not null check (total_chunks between 1 and 100),
  status text not null default 'pending' check (status in ('pending','completed')),
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (owner_slug,scan_batch_id)
);

create table if not exists public.fast_scan_batch_chunks (
  owner_slug text not null,
  scan_batch_id uuid not null,
  chunk_id text not null check (char_length(chunk_id) between 1 and 100),
  payload_hash text not null check (char_length(payload_hash) between 8 and 128),
  status text not null default 'processing' check (status in ('processing','completed')),
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (owner_slug,scan_batch_id,chunk_id),
  foreign key (owner_slug,scan_batch_id) references public.fast_scan_batches(owner_slug,scan_batch_id) on delete cascade
);

create index if not exists fast_scan_batch_chunks_pending_idx
  on public.fast_scan_batch_chunks(owner_slug,scan_batch_id,status);

alter table public.fast_scan_batches enable row level security;
alter table public.fast_scan_batch_chunks enable row level security;

create or replace function public.save_fast_scan_chunk(
  p_token text,
  p_scan_batch_id uuid,
  p_chunk_id text,
  p_batch_payload_hash text,
  p_payload_hash text,
  p_total_chunks integer,
  p_items jsonb
) returns jsonb language plpgsql security definer
set search_path=public,extensions as $$
declare
  me text := public.session_member(p_token);
  batch_row public.fast_scan_batches;
  chunk_row public.fast_scan_batch_chunks;
  save_result jsonb;
  completed_chunks integer;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_scan_batch_id is null or char_length(trim(coalesce(p_chunk_id,''))) not between 1 and 100
    or char_length(trim(coalesce(p_batch_payload_hash,''))) not between 8 and 128
    or char_length(trim(coalesce(p_payload_hash,''))) not between 8 and 128
    or p_total_chunks not between 1 and 100
    or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 25 then
    raise exception 'Chunk Fast Scan non valido';
  end if;

  insert into public.fast_scan_batches(owner_slug,scan_batch_id,payload_hash,total_chunks)
  values(me,p_scan_batch_id,trim(p_batch_payload_hash),p_total_chunks)
  on conflict do nothing;
  select * into batch_row from public.fast_scan_batches
    where owner_slug=me and scan_batch_id=p_scan_batch_id for update;
  if batch_row.payload_hash<>trim(p_batch_payload_hash) or batch_row.total_chunks<>p_total_chunks then
    raise exception 'Batch Fast Scan riutilizzato con payload differente';
  end if;

  insert into public.fast_scan_batch_chunks(owner_slug,scan_batch_id,chunk_id,payload_hash)
  values(me,p_scan_batch_id,trim(p_chunk_id),trim(p_payload_hash))
  on conflict do nothing;
  select * into chunk_row from public.fast_scan_batch_chunks
    where owner_slug=me and scan_batch_id=p_scan_batch_id and chunk_id=trim(p_chunk_id) for update;
  if chunk_row.payload_hash<>trim(p_payload_hash) then
    raise exception 'Chunk Fast Scan riutilizzato con payload differente';
  end if;
  if chunk_row.status='completed' then
    return chunk_row.result || jsonb_build_object('idempotentReplay',true);
  end if;

  -- save_collection_batch is transactional. The client already aggregates by
  -- printing and this boundary caps work at 25 distinct inventory identities.
  save_result := public.save_collection_batch(p_token,p_items);
  save_result := save_result || jsonb_build_object(
    'scanBatchId',p_scan_batch_id,'chunkId',trim(p_chunk_id),'idempotentReplay',false
  );
  update public.fast_scan_batch_chunks set status='completed',result=save_result,
    completed_at=now(),updated_at=now()
    where owner_slug=me and scan_batch_id=p_scan_batch_id and chunk_id=trim(p_chunk_id);

  select count(*)::integer into completed_chunks from public.fast_scan_batch_chunks
    where owner_slug=me and scan_batch_id=p_scan_batch_id and status='completed';
  if completed_chunks>=p_total_chunks then
    update public.fast_scan_batches set status='completed',completed_at=now(),updated_at=now(),
      result=jsonb_build_object('completedChunks',completed_chunks,'totalChunks',p_total_chunks)
      where owner_slug=me and scan_batch_id=p_scan_batch_id;
  end if;
  return save_result;
end;
$$;

-- One pass over the small loans relation replaces two helper RPC executions and
-- two correlated legacy checks for every collection row.
create or replace function public.list_my_collection(p_token text)
returns table(
  id uuid, printing_id uuid, owner_slug text, owner_name text, game text,
  catalog_card_id text, card_name text, set_code text, set_name text, rarity text,
  language text, condition text, edition text, image_url text,
  quantity_owned integer, quantity_loaned integer, quantity_reserved integer,
  quantity_physically_available integer, legacy_ambiguous boolean,
  created_at timestamptz, updated_at timestamptz
) language plpgsql security definer set search_path=public,extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query
  with inventory as materialized (
    select ci.*,p.game,p.catalog_card_id,p.card_name,p.set_code,p.set_name,p.rarity,p.image_url,m.full_name
    from public.collection_items ci join public.card_printings p on p.id=ci.printing_id
    join public.team_members m on m.slug=ci.owner_slug where ci.owner_slug=me
  ), identity_counts as materialized (
    select source.id,source.owner_slug,source.game,source.catalog_card_id,lower(trim(source.card_name)) normalized_name,
      count(*) over(partition by source.owner_slug,source.game,source.catalog_card_id) catalog_count,
      count(*) over(partition by source.owner_slug,source.game,lower(trim(source.card_name))) name_count
    from inventory source
  ), commitments as materialized (
    select i.id,
      coalesce(sum(greatest(coalesce(l.accepted_quantity,l.quantity)-l.returned_quantity,0))
        filter(where l.status in ('active','return_pending') and (l.collection_item_id=i.id or
          (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count=1) or
          (nullif(trim(l.card_external_id),'') is null and c.name_count=1))),0)::integer loaned,
      coalesce(sum(greatest(coalesce(l.accepted_quantity,l.quantity)-l.returned_quantity,0))
        filter(where l.status='reserved' and (l.collection_item_id=i.id or
          (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count=1) or
          (nullif(trim(l.card_external_id),'') is null and c.name_count=1))),0)::integer reserved,
      coalesce(bool_or(l.collection_item_id is null and (
        (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count>1) or
        (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name))=lower(trim(i.card_name)) and c.name_count>1)
      )),false) legacy_ambiguous
    from inventory i join identity_counts c on c.id=i.id
    left join public.loans l on l.owner_slug=i.owner_slug and l.game=i.game
      and l.status in ('reserved','active','return_pending') and (
        l.collection_item_id=i.id or (l.collection_item_id is null and (
          nullif(trim(l.card_external_id),'')=i.catalog_card_id or
          (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name))=lower(trim(i.card_name)))
        ))
      )
    group by i.id
  )
  select i.id,i.printing_id,i.owner_slug,i.full_name,i.game,i.catalog_card_id,i.card_name,
    i.set_code,i.set_name,i.rarity,i.language,i.condition,i.edition,i.image_url,i.quantity_owned,
    coalesce(c.loaned,0),coalesce(c.reserved,0),
    greatest(i.quantity_owned-coalesce(c.loaned,0)-coalesce(c.reserved,0),0),
    coalesce(c.legacy_ambiguous,false),i.created_at,i.updated_at
  from inventory i left join commitments c on c.id=i.id
  order by i.card_name,i.set_code,i.condition;
end;
$$;

create or replace function public.list_team_collection(p_token text)
returns table(
  id uuid, printing_id uuid, owner_slug text, owner_name text, game text,
  catalog_card_id text, card_name text, set_code text, set_name text, rarity text,
  language text, condition text, edition text, image_url text,
  quantity_loaned integer, quantity_reserved integer,
  quantity_physically_available integer, legacy_ambiguous boolean, updated_at timestamptz
) language plpgsql security definer set search_path=public,extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  return query
  with inventory as materialized (
    select ci.*,p.game,p.catalog_card_id,p.card_name,p.set_code,p.set_name,p.rarity,p.image_url,m.full_name
    from public.collection_items ci join public.card_printings p on p.id=ci.printing_id
    join public.team_members m on m.slug=ci.owner_slug and m.active
  ), identity_counts as materialized (
    select source.id,source.owner_slug,source.game,source.catalog_card_id,lower(trim(source.card_name)) normalized_name,
      count(*) over(partition by source.owner_slug,source.game,source.catalog_card_id) catalog_count,
      count(*) over(partition by source.owner_slug,source.game,lower(trim(source.card_name))) name_count
    from inventory source
  ), commitments as materialized (
    select i.id,
      coalesce(sum(greatest(coalesce(l.accepted_quantity,l.quantity)-l.returned_quantity,0))
        filter(where l.status in ('active','return_pending') and (l.collection_item_id=i.id or
          (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count=1) or
          (nullif(trim(l.card_external_id),'') is null and c.name_count=1))),0)::integer loaned,
      coalesce(sum(greatest(coalesce(l.accepted_quantity,l.quantity)-l.returned_quantity,0))
        filter(where l.status='reserved' and (l.collection_item_id=i.id or
          (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count=1) or
          (nullif(trim(l.card_external_id),'') is null and c.name_count=1))),0)::integer reserved,
      coalesce(bool_or(l.collection_item_id is null and (
        (nullif(trim(l.card_external_id),'')=i.catalog_card_id and c.catalog_count>1) or
        (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name))=lower(trim(i.card_name)) and c.name_count>1)
      )),false) legacy_ambiguous
    from inventory i join identity_counts c on c.id=i.id
    left join public.loans l on l.owner_slug=i.owner_slug and l.game=i.game
      and l.status in ('reserved','active','return_pending') and (
        l.collection_item_id=i.id or (l.collection_item_id is null and (
          nullif(trim(l.card_external_id),'')=i.catalog_card_id or
          (nullif(trim(l.card_external_id),'') is null and lower(trim(l.card_name))=lower(trim(i.card_name)))
        ))
      )
    group by i.id
  )
  select i.id,i.printing_id,i.owner_slug,i.full_name,i.game,i.catalog_card_id,i.card_name,
    i.set_code,i.set_name,i.rarity,i.language,i.condition,i.edition,i.image_url,
    coalesce(c.loaned,0),coalesce(c.reserved,0),
    greatest(i.quantity_owned-coalesce(c.loaned,0)-coalesce(c.reserved,0),0),
    coalesce(c.legacy_ambiguous,false),i.updated_at
  from inventory i left join commitments c on c.id=i.id
  order by i.card_name,i.full_name,i.set_code;
end;
$$;

revoke all on table public.fast_scan_batches,public.fast_scan_batch_chunks from public,anon,authenticated;
revoke all on function public.save_fast_scan_chunk(text,uuid,text,text,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.save_fast_scan_chunk(text,uuid,text,text,text,integer,jsonb) to anon,authenticated;
revoke all on function public.list_my_collection(text),public.list_team_collection(text) from public,anon,authenticated;
grant execute on function public.list_my_collection(text),public.list_team_collection(text) to anon,authenticated;

notify pgrst,'reload schema';
