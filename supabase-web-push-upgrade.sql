-- Sottoscrizioni Web Push protette dalle sessioni F.P.T.
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  member_slug text not null references public.team_members(slug) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

create or replace function public.save_push_subscription(
  p_token text, p_endpoint text, p_p256dh text, p_auth text
) returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.session_member(p_token);
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  if p_endpoint !~ '^https://' or char_length(p_endpoint) > 2000
     or char_length(p_p256dh) not between 20 and 500
     or char_length(p_auth) not between 8 and 200 then
    raise exception 'Sottoscrizione push non valida';
  end if;
  insert into public.push_subscriptions(endpoint, member_slug, p256dh, auth)
  values(p_endpoint, me, p_p256dh, p_auth)
  on conflict(endpoint) do update set member_slug=excluded.member_slug,
    p256dh=excluded.p256dh, auth=excluded.auth, updated_at=now();
end;
$$;
revoke all on function public.save_push_subscription(text,text,text,text) from public;
grant execute on function public.save_push_subscription(text,text,text,text) to anon, authenticated;
