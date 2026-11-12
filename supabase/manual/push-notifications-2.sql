-- Manual rollout, after review. No secrets or trigger replacement required.
-- Run transaction on a staging database first. Legacy clients keep the 4-argument RPC.
begin;
alter table public.push_subscriptions add column if not exists session_token_hash bytea;
alter table public.push_subscriptions add column if not exists last_test_at timestamptz;

create or replace function public.save_push_subscription(p_token text, p_endpoint text, p_p256dh text, p_auth text, p_member_slug text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare me text;
begin
  -- Serialize with logout/delete and login/update of this application session.
  select member_slug into me from public.app_sessions
    where token_hash = digest(p_token, 'sha256') and expires_at > now() for update;
  if me is null or me is distinct from p_member_slug then raise exception 'Sessione scaduta'; end if;
  if p_endpoint is null or p_p256dh is null or p_auth is null
    or p_endpoint !~ '^https://([a-zA-Z0-9-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)/'
    or char_length(p_endpoint) > 2000 or char_length(p_p256dh) not between 20 and 500 or char_length(p_auth) not between 8 and 200 then
    raise exception 'Sottoscrizione push non valida';
  end if;
  insert into public.push_subscriptions(endpoint,member_slug,p256dh,auth,session_token_hash)
    values(p_endpoint,me,p_p256dh,p_auth,digest(p_token,'sha256'))
    on conflict(endpoint) do update set member_slug=excluded.member_slug,p256dh=excluded.p256dh,auth=excluded.auth,
      session_token_hash=excluded.session_token_hash,updated_at=now();
end $$;
revoke all on function public.save_push_subscription(text,text,text,text,text) from public;
grant execute on function public.save_push_subscription(text,text,text,text,text) to anon,authenticated;

create or replace function public.save_push_subscription(p_token text,p_endpoint text,p_p256dh text,p_auth text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.save_push_subscription(p_token,p_endpoint,p_p256dh,p_auth,public.session_member(p_token));
end $$;

create or replace function public.remove_push_subscription(p_token text,p_endpoint text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.push_subscriptions where endpoint=p_endpoint and member_slug=public.session_member(p_token)
    and session_token_hash=digest(p_token,'sha256');
end $$;
revoke all on function public.remove_push_subscription(text,text) from public;
grant execute on function public.remove_push_subscription(text,text) to anon,authenticated;

create or replace function public.logout_member(p_token text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  -- Lock in the same order as registration; delete bindings after invalidation.
  delete from public.app_sessions where token_hash=digest(p_token,'sha256');
  delete from public.push_subscriptions where session_token_hash=digest(p_token,'sha256');
end $$;

revoke all on function public.logout_member(text) from public;
grant execute on function public.logout_member(text) to anon,authenticated;

create or replace function public.push_delivery_subscriptions(p_member_slug text)
returns table(endpoint text,p256dh text,auth text) language sql security definer set search_path = public, extensions as $$
  select p.endpoint,p.p256dh,p.auth from public.push_subscriptions p
  join public.app_sessions s on s.token_hash=p.session_token_hash and s.member_slug=p.member_slug and s.expires_at>now()
  join public.team_members m on m.slug=p.member_slug and m.active
  where p.member_slug=p_member_slug
$$;
revoke all on function public.push_delivery_subscriptions(text) from public,anon,authenticated;
grant execute on function public.push_delivery_subscriptions(text) to service_role;

create or replace function public.claim_push_test(p_token text,p_endpoint text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me text; item public.push_subscriptions;
begin
  select member_slug into me from public.app_sessions where token_hash=digest(p_token,'sha256') and expires_at>now() for update;
  if me is null then return jsonb_build_object('code','unauthorized'); end if;
  select * into item from public.push_subscriptions where endpoint=p_endpoint and member_slug=me and session_token_hash=digest(p_token,'sha256') for update;
  if not found then return jsonb_build_object('code','unauthorized'); end if;
  if item.last_test_at>now()-interval '1 minute' then return jsonb_build_object('code','rate_limited'); end if;
  update public.push_subscriptions set last_test_at=now() where endpoint=p_endpoint;
  return jsonb_build_object('member',me,'subscription',jsonb_build_object('endpoint',item.endpoint,'p256dh',item.p256dh,'auth',item.auth));
end $$;
revoke all on function public.claim_push_test(text,text) from public,anon,authenticated;
grant execute on function public.claim_push_test(text,text) to service_role;
commit;
-- Existing bindings with NULL session_token_hash are deliberately excluded until
-- the member reopens the app: automatic reconciliation binds the current session.
