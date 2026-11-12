-- Production function backup before Push 2.0. No subscription data or secrets.

-- Coordinate with reverting the Push 2.0 backend. Added columns remain untouched.

begin;

CREATE OR REPLACE FUNCTION public.logout_member(p_token text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  delete from public.app_sessions where token_hash = digest(p_token, 'sha256')
$function$;

CREATE OR REPLACE FUNCTION public.save_push_subscription(p_token text, p_endpoint text, p_p256dh text, p_auth text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$;

revoke all on function public.logout_member(text) from public, anon, authenticated, service_role;

grant execute on function public.logout_member(text) to anon;

grant execute on function public.logout_member(text) to authenticated;

grant execute on function public.logout_member(text) to service_role;

revoke all on function public.save_push_subscription(text,text,text,text) from public, anon, authenticated, service_role;

grant execute on function public.save_push_subscription(text,text,text,text) to anon;

grant execute on function public.save_push_subscription(text,text,text,text) to authenticated;

grant execute on function public.save_push_subscription(text,text,text,text) to service_role;

drop function if exists public.claim_push_test(text,text);

drop function if exists public.push_delivery_subscriptions(text);

drop function if exists public.remove_push_subscription(text,text);

drop function if exists public.save_push_subscription(text,text,text,text,text);

notify pgrst, 'reload schema';

commit;
