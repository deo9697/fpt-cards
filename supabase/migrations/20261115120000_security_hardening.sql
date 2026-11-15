-- Sicurezza 2026-11-15 (audit): chiude i punti trovati lato database.
--  1. PIN azzerato = profilo "libero": il primo che entrava sceglieva il PIN.
--     Ora l'admin riceve un PIN temporaneo casuale e il membro deve cambiarlo
--     al primo accesso; un profilo senza PIN non accetta login.
--  2. change_my_pin: ogni membro può cambiare il proprio PIN (serve l'attuale).
--  3. Vincoli contro HTML nei testi scritti dagli utenti che l'app mostra:
--     nomi membri/team, nome di chi chiede da link condiviso; immagini dei
--     prestiti solo https dai siti di carte già usati. NOT VALID: valgono per
--     le righe nuove/modificate (le esistenti sono già state verificate pulite).
--  4. Richieste da link condiviso: massimo 10 all'ora e 30 al giorno per link.
-- Additiva e rieseguibile.

begin;

-- 1+2 ----------------------------------------------------------------------
alter table public.team_members add column if not exists pin_must_change boolean not null default false;

create or replace function public.random_temp_pin() returns text
language sql volatile set search_path to 'public', 'extensions' as $$
  -- pgcrypto: casuale crittografico (random() è prevedibile).
  select lpad(((get_byte(b, 0) * 256 + get_byte(b, 1)) % 10000)::text, 4, '0') from (select gen_random_bytes(2) b) r;
$$;
revoke all on function public.random_temp_pin() from public, anon, authenticated;

drop function if exists public.admin_manage_member(text, text, text, text);
create function public.admin_manage_member(p_token text, p_action text, p_slug text, p_name text default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare me text := public.session_member(p_token); admin boolean; temp_pin text;
begin
  select role = 'admin' into admin from public.team_members where slug = me and active;
  if me is null or not coalesce(admin,false) then raise exception 'Solo l’amministratore può gestire i membri'; end if;
  if p_action = 'add' then
    if p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(trim(coalesce(p_name,''))) not between 2 and 100 then raise exception 'Dati membro non validi'; end if;
    if trim(p_name) ~ '[<>]' then raise exception 'Il nome non può contenere i caratteri < >'; end if;
    temp_pin := public.random_temp_pin();
    insert into public.team_members(slug, full_name, role, active, pin_hash, pin_must_change)
      values(p_slug, trim(p_name), 'guest', true, crypt(temp_pin, gen_salt('bf', 10)), true)
      on conflict (slug) do update set full_name = excluded.full_name, active = true,
        pin_hash = excluded.pin_hash, pin_must_change = true;
    delete from public.app_sessions where member_slug = p_slug;
    return jsonb_build_object('tempPin', temp_pin);
  elsif p_action = 'reset-pin' then
    temp_pin := public.random_temp_pin();
    update public.team_members set pin_hash = crypt(temp_pin, gen_salt('bf', 10)), pin_must_change = true
      where slug = p_slug and role <> 'admin';
    if not found then raise exception 'Membro non trovato'; end if;
    delete from public.app_sessions where member_slug = p_slug;
    return jsonb_build_object('tempPin', temp_pin);
  elsif p_action = 'deactivate' then
    if p_slug = me then raise exception 'Non puoi disattivare il tuo profilo'; end if;
    update public.team_members set active = false where slug = p_slug and role <> 'admin';
    delete from public.app_sessions where member_slug = p_slug;
    return null;
  else raise exception 'Azione non valida';
  end if;
end;
$function$;
revoke all on function public.admin_manage_member(text,text,text,text) from public;
grant execute on function public.admin_manage_member(text,text,text,text) to anon, authenticated;

create or replace function public.login_member_core(p_slug text, p_pin text, p_token text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare item public.team_members;
begin
  if p_pin !~ '^[0-9]{4}$' or char_length(p_token) < 32 then raise exception 'Dati di accesso non validi'; end if;
  select * into item from public.team_members where slug = p_slug and active for update;
  if not found then raise exception 'Profilo non trovato o disattivato'; end if;
  -- Niente più "primo PIN vince": senza PIN si entra solo con quello temporaneo dell'admin.
  if item.pin_hash is null then raise exception 'PIN non impostato: chiedi all’amministratore un PIN temporaneo'; end if;
  if item.pin_hash <> crypt(p_pin, item.pin_hash) then raise exception 'PIN non corretto'; end if;
  delete from public.app_sessions where expires_at <= now();
  insert into public.app_sessions(token_hash, member_slug, expires_at)
  values (digest(p_token, 'sha256'), p_slug, now() + interval '30 days')
  on conflict (token_hash) do update set member_slug = excluded.member_slug, expires_at = excluded.expires_at;
  return jsonb_build_object('slug', item.slug, 'name', item.full_name, 'role', item.role,
    'canVerifyYgoArtwork', coalesce(item.can_verify_ygo_artwork, false),
    'mustChangePin', coalesce(item.pin_must_change, false));
end;
$function$;

drop function if exists public.change_my_pin(text, text, text);
create function public.change_my_pin(p_token text, p_current_pin text, p_new_pin text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare me text := public.session_member(p_token); item public.team_members; throttle public.login_throttle;
begin
  if me is null then raise exception 'Sessione scaduta'; end if;
  select * into throttle from public.login_throttle where scope = 'slug' and key = lower(me);
  if throttle.locked_until > now() then
    return jsonb_build_object('ok', false, 'code', 'LOCKED', 'message', 'Troppi tentativi. Riprova tra qualche minuto.');
  end if;
  if coalesce(p_new_pin,'') !~ '^[0-9]{4}$' then raise exception 'Il nuovo PIN deve avere 4 cifre'; end if;
  if p_new_pin ~ '^(\d)\1{3}$' or p_new_pin in ('1234','4321','0123','9876') then raise exception 'PIN troppo facile: scegline un altro'; end if;
  select * into item from public.team_members where slug = me and active for update;
  if not found then raise exception 'Profilo non trovato o disattivato'; end if;
  if item.pin_hash is null or coalesce(p_current_pin,'') !~ '^[0-9]{4}$' or item.pin_hash <> crypt(p_current_pin, item.pin_hash) then
    -- Stesso contatore dei login: niente tentativi illimitati sul PIN attuale.
    -- Return, non raise: un'eccezione annullerebbe anche il contatore.
    perform public.login_throttle_record_failure('slug', lower(me), 5);
    return jsonb_build_object('ok', false, 'code', 'BAD_PIN', 'message', 'PIN attuale non corretto');
  end if;
  if crypt(p_new_pin, item.pin_hash) = item.pin_hash then raise exception 'Il nuovo PIN è uguale a quello attuale'; end if;
  update public.team_members set pin_hash = crypt(p_new_pin, gen_salt('bf', 10)), pin_must_change = false where slug = me;
  -- Le altre sessioni (altri dispositivi) restano valide: è il membro stesso a cambiarlo.
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.change_my_pin(text,text,text) from public;
grant execute on function public.change_my_pin(text,text,text) to anon, authenticated;

-- 3 ------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'team_members_full_name_no_html') then
    alter table public.team_members add constraint team_members_full_name_no_html check (full_name !~ '[<>]') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'teams_name_no_html') then
    alter table public.teams add constraint teams_name_no_html check (name !~ '[<>]') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'collection_share_requests_requester_no_html') then
    alter table public.collection_share_requests add constraint collection_share_requests_requester_no_html check (requester_name !~ '[<>]') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'loans_card_image_safe_url') then
    alter table public.loans add constraint loans_card_image_safe_url check (
      card_image is null or card_image = ''
      or card_image ~ '^https://(images\.ygoprodeck\.com|optcgapi\.com|artworks-[a-z]{2}-n\.ygoresources\.com)/[^"''<>[:space:]]*$'
    ) not valid;
  end if;
end $$;

-- 4 ------------------------------------------------------------------------
create or replace function public.limit_collection_share_requests() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  if (select count(*) from public.collection_share_requests where share_id = new.share_id and created_at > now() - interval '1 hour') >= 10
     or (select count(*) from public.collection_share_requests where share_id = new.share_id and created_at > now() - interval '1 day') >= 30 then
    raise exception 'Troppe richieste da questo link: riprova più tardi';
  end if;
  return new;
end;
$function$;
revoke all on function public.limit_collection_share_requests() from public, anon, authenticated;
drop trigger if exists collection_share_requests_rate_limit on public.collection_share_requests;
create trigger collection_share_requests_rate_limit before insert on public.collection_share_requests
  for each row execute function public.limit_collection_share_requests();

commit;
