// Migration di sicurezza 2026-11-15 su un Postgres reale in memoria (pglite):
// PIN temporaneo invece del "primo PIN vince", cambio PIN con contatore dei
// tentativi, vincoli anti-HTML, limite richieste da link condiviso.
// Lo schema minimo qui sotto ricalca le colonne di produzione che la
// migration tocca (lette da pg_catalog il 2026-11-15).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create extension if not exists pgcrypto;
  create schema if not exists extensions;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  create table public.teams (id uuid primary key default gen_random_uuid(), slug text, name text not null, kind text);
  create table public.team_members (slug text primary key, full_name text not null, role text not null default 'guest', active boolean not null default true,
    pin_hash text, team_id uuid, can_verify_ygo_artwork boolean default false, user_id uuid);
  create table public.app_sessions (token_hash bytea primary key, member_slug text not null, expires_at timestamptz not null);
  create table public.login_throttle (scope text, key text, failures int not null default 0, last_failure_at timestamptz, locked_until timestamptz, primary key (scope, key));
  create table public.loans (id uuid primary key default gen_random_uuid(), card_name text, card_image text);
  create table public.collection_share_requests (id uuid primary key default gen_random_uuid(), share_id uuid not null, requester_name text not null, message text, client_request_id uuid, created_at timestamptz not null default now());
  create function public.session_member(p_token text) returns text language sql stable as $$
    select member_slug from public.app_sessions where token_hash = digest(p_token, 'sha256') and expires_at > now() $$;
  create or replace function public.login_throttle_record_failure(p_scope text, p_key text, p_threshold integer) returns void language plpgsql security definer set search_path to 'public' as $function$
  declare f integer;
  begin
    insert into public.login_throttle(scope, key, failures, last_failure_at) values (p_scope, p_key, 1, now())
    on conflict (scope, key) do update set
      failures = case when public.login_throttle.last_failure_at < now() - interval '60 minutes' then 1 else public.login_throttle.failures + 1 end,
      last_failure_at = now()
    returning failures into f;
    if f >= p_threshold then
      update public.login_throttle set locked_until = now() + least(interval '15 minutes', make_interval(mins => power(2, least(f - p_threshold, 4))::int)) where scope = p_scope and key = p_key;
    end if;
  end; $function$;
  -- Prima della migration: il comportamento vulnerabile ("primo PIN vince").
  create function public.admin_manage_member(p_token text, p_action text, p_slug text, p_name text default null) returns void language plpgsql as $$ begin end $$;
  insert into public.team_members(slug, full_name, role, pin_hash) values ('admin', 'Admin', 'admin', crypt('2468', gen_salt('bf', 4)));
  insert into public.team_members(slug, full_name, role, pin_hash) values ('legacy', 'Senza PIN', 'guest', null);
`);
await db.exec(fs.readFileSync('supabase/migrations/20261115120000_security_hardening.sql', 'utf8'));
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const fails = async (sql, params, pattern, label) => { await assert.rejects(() => db.query(sql, params), pattern, label); };
const T = n => 'token-' + String(n).padEnd(40, 'x');
const login = (slug, pin, t) => one(`select public.login_member_core($1,$2,$3) r`, [slug, pin, t]).then(x => x.r);

await login('admin', '2468', T(1));
let count = 0; const pass = m => { count++; console.log('PASS ' + m); };

// 1. Profilo senza PIN: nessuno può più "prenderselo".
await fails(`select public.login_member_core('legacy','1111',$1)`, [T(2)], /PIN non impostato/);
pass('profilo senza PIN: login rifiutato, niente "primo PIN vince"');

// 2. Aggiunta membro: PIN temporaneo casuale, cambio obbligatorio.
const added = (await one(`select public.admin_manage_member($1,'add','marco','Marco') r`, [T(1)])).r;
assert.match(added.tempPin, /^\d{4}$/);
const first = await login('marco', added.tempPin, T(3));
assert.equal(first.mustChangePin, true);
pass('admin aggiunge un membro: PIN temporaneo di 4 cifre, al primo accesso mustChangePin');

// 3. Cambio PIN: PIN attuale sbagliato conta come tentativo fallito (e il contatore resta).
const bad = (await one(`select public.change_my_pin($1,'0000','5813') r`, [T(3)])).r;
assert.equal(bad.ok, false); assert.equal(bad.code, 'BAD_PIN');
assert.equal((await one(`select failures from public.login_throttle where scope='slug' and key='marco'`)).failures, 1);
for (let i = 0; i < 4; i++) await one(`select public.change_my_pin($1,'0000','5813') r`, [T(3)]);
const locked = (await one(`select public.change_my_pin($1,$2,'5813') r`, [T(3), added.tempPin])).r;
assert.equal(locked.code, 'LOCKED', 'dopo 5 errori anche il PIN giusto aspetta lo sblocco');
await db.query(`delete from public.login_throttle`);
pass('cambio PIN: errori contati e bloccati come per il login');

// 4. Cambio PIN riuscito.
await fails(`select public.change_my_pin($1,$2,'1111')`, [T(3), added.tempPin], /troppo facile/);
const ok = (await one(`select public.change_my_pin($1,$2,'5813') r`, [T(3), added.tempPin])).r;
assert.equal(ok.ok, true);
assert.equal((await login('marco', '5813', T(4))).mustChangePin, false);
await fails(`select public.login_member_core('marco',$1,$2)`, [added.tempPin, T(5)], /PIN non corretto/);
pass('cambio PIN riuscito: il PIN temporaneo non vale più, mustChangePin spento');

// 5. Reset PIN: nuovo temporaneo, sessioni chiuse.
const reset = (await one(`select public.admin_manage_member($1,'reset-pin','marco') r`, [T(1)])).r;
assert.match(reset.tempPin, /^\d{4}$/);
assert.equal((await one(`select count(*)::int n from public.app_sessions where member_slug='marco'`)).n, 0);
assert.equal((await login('marco', reset.tempPin, T(6))).mustChangePin, true);
await fails(`select public.admin_manage_member($1,'reset-pin','marco')`, [T(6)], /Solo l’amministratore/);
pass('reset PIN: nuovo temporaneo, sessioni del membro chiuse, solo l\'admin può farlo');

// 6. Vincoli anti-HTML.
await fails(`select public.admin_manage_member($1,'add','x','<img src=x onerror=alert(1)>')`, [T(1)], /caratteri/);
await fails(`insert into public.team_members(slug, full_name) values ('y','<b>y</b>')`, [], /team_members_full_name_no_html/);
await fails(`insert into public.teams(name) values ('<script>')`, [], /teams_name_no_html/);
await fails(`insert into public.loans(card_image) values ('x" onerror="alert(1)')`, [], /loans_card_image_safe_url/);
await fails(`insert into public.loans(card_image) values ('https://evil.example/a.jpg')`, [], /loans_card_image_safe_url/);
await fails(`insert into public.loans(card_image) values ('https://images.ygoprodeck.com/a.jpg" onerror="x')`, [], /loans_card_image_safe_url/);
for (const url of ['https://images.ygoprodeck.com/images/cards/89631139.jpg', 'https://optcgapi.com/media/static/Card_Images/OP01-001.jpg', 'https://artworks-en-n.ygoresources.com/1234_1.png', '', null])
  await db.query(`insert into public.loans(card_name, card_image) values ('Carta "con" virgolette <EX>', $1)`, [url]);
pass('vincoli: nomi con < > rifiutati, immagini prestito solo https dai siti di carte (nomi carta invariati)');

// 7. Limite richieste da link condiviso.
const share = '11111111-1111-1111-1111-111111111111';
for (let i = 0; i < 10; i++) await db.query(`insert into public.collection_share_requests(share_id, requester_name) values ($1, 'Ospite')`, [share]);
await fails(`insert into public.collection_share_requests(share_id, requester_name) values ($1, 'Ospite')`, [share], /Troppe richieste/);
await db.query(`insert into public.collection_share_requests(share_id, requester_name) values ('22222222-2222-2222-2222-222222222222', 'Altro link')`);
await fails(`insert into public.collection_share_requests(share_id, requester_name) values ($1, '<i>x</i>')`, ['33333333-3333-3333-3333-333333333333'], /requester_no_html/);
pass('link condiviso: massimo 10 richieste all\'ora per link, gli altri link non sono toccati');

// 8. Rieseguibile.
await db.exec(fs.readFileSync('supabase/migrations/20261115120000_security_hardening.sql', 'utf8'));
pass('migration rieseguibile senza errori');
console.log(`Security hardening: ${count}/${count} PASS`);
