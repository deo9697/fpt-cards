// Disposable real Postgres (PGlite). No production project or push delivery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = 'supabase/migrations/20261110130001_onepiece_private_multiplayer.sql';
const sql = fs.readFileSync(migration, 'utf8');
const teamA = '10000000-0000-4000-8000-000000000001';
const teamB = '10000000-0000-4000-8000-000000000002';
const duelId = '20000000-0000-4000-8000-000000000001';
const db = new PGlite();
const rows = async (query, params = []) => (await db.query(query, params)).rows;
async function role(name, fn) {
  await db.exec(`set role ${name}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const denied = async (promise, pattern) => assert.rejects(promise, pattern);
const insert = (id, host = 'host', guest = 'guest', team = teamA, extra = {}) => {
  const fields = { id, team_id:team, host_slug:host, guest_slug:guest, host_deck:{ name:'Synthetic deck', cards:[] }, host_life:5, ...extra };
  const names = Object.keys(fields), values = Object.values(fields).map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
  return rows(`insert into public.onepiece_duels (${names.join(',')}) values (${values.map((_, i) => '$' + (i + 1)).join(',')}) returning id`, values);
};

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.teams(id uuid primary key, name text not null);
    create table public.team_members(slug text primary key, full_name text not null, team_id uuid references public.teams(id), active boolean not null default true, kind text not null default 'legacy');
    create table public.duel_test_tokens(token text primary key, member_slug text not null, expires_at timestamptz not null default now() + interval '1 hour');
    create function public.session_member(p_token text) returns text language sql stable security definer set search_path = '' as $$
      select t.member_slug from public.duel_test_tokens t where t.token = p_token and t.expires_at > now()
    $$;
    revoke all on function public.session_member(text) from public, anon, authenticated;
    grant usage on schema public to anon, authenticated, service_role;
    grant select on public.team_members to service_role;
  `);
  await rows('insert into public.teams(id,name) values ($1,\'Team A\'),($2,\'Team B\')', [teamA, teamB]);
  await rows(`insert into public.team_members(slug,full_name,team_id,active,kind) values
    ('host','Host',$1,true,'legacy'),('guest','Guest',$1,true,'legacy'),('other','Other',$1,true,'legacy'),
    ('external','External',$2,true,'legacy'),('inactive','Inactive',$1,false,'legacy'),
    ('shadow','Shadow',$1,true,'standalone'),('unassigned','Unassigned',null,true,'legacy')`, [teamA, teamB]);
  await db.exec(`insert into public.duel_test_tokens(token,member_slug) select slug || '-token',slug from public.team_members;
    insert into public.duel_test_tokens(token,member_slug,expires_at) values ('expired-token','host',now() - interval '1 second');`);
  await db.exec(sql);

  for (const name of ['anon', 'authenticated']) {
    await role(name, async () => {
      const identity = (await rows('select public.onepiece_duel_identity($1) as actor', ['host-token']))[0].actor;
      assert.deepEqual(identity, { slug:'host', name:'Host', teamId:teamA });
      for (const token of [null, 'bad-token', 'expired-token', 'inactive-token', 'shadow-token', 'unassigned-token']) {
        await denied(rows('select public.onepiece_duel_identity($1)', [token]), /Sessione scaduta o membro non autorizzato/);
      }
      await denied(rows('select * from public.onepiece_duels'), /permission denied/i);
      await denied(rows("update public.onepiece_duels set status='cancelled'"), /permission denied/i);
      await denied(rows('delete from public.onepiece_duels'), /permission denied/i);
      await denied(insert(duelId), /permission denied/i);
      await denied(rows('select public.session_member($1)', ['host-token']), /permission denied/i);
      await denied(rows('select public.onepiece_duel_guard()'), /permission denied/i);
      await denied(rows("select public.onepiece_duel_insert_invite('{}'::jsonb)"), /permission denied/i);
    });
  }
  console.log('PASS client roles resolve only their current identity and cannot read or write hidden duel state');

  await role('service_role', async () => {
    await insert(duelId);
    assert.equal((await rows('select * from public.onepiece_duels')).length, 1);
    for (const [host, guest, team] of [['host','external',teamA], ['host','inactive',teamA], ['host','shadow',teamA], ['host','host',teamA], ['host','guest',teamB]]) {
      await denied(insert(crypto.randomUUID(), host, guest, team), /stesso team|distinct_players/);
    }
    await rows("update public.onepiece_duels set version=version+1,status='setup',host_deck=null,state='{}'::jsonb,ready='[false,true]'::jsonb where id=$1", [duelId]);
    assert.equal((await rows('select version from public.onepiece_duels where id=$1', [duelId]))[0].version, 2);
    assert.equal((await rows("update public.onepiece_duels set version=version+1,status='cancelled' where id=$1 and version=1 returning id", [duelId])).length, 0, 'a stale CAS write must not modify the newer game');
    assert.equal((await rows('select status from public.onepiece_duels where id=$1', [duelId]))[0].status, 'setup');
    await denied(rows('update public.onepiece_duels set version=4 where id=$1', [duelId]), /avanzare di una posizione/);
    await denied(rows("update public.onepiece_duels set guest_slug='other',version=version+1 where id=$1", [duelId]), /non possono essere modificati/);
    await denied(rows('update public.onepiece_duels set team_id=$2,version=version+1 where id=$1', [duelId, teamB]), /non possono essere modificati/);
    await denied(rows("update public.onepiece_duels set created_at=created_at-interval '1 day',version=version+1 where id=$1", [duelId]), /non possono essere modificati/);
    await denied(rows("update public.onepiece_duels set version=version+1,ready='[true,null]'::jsonb where id=$1", [duelId]), /check constraint/);
    await denied(rows("update public.onepiece_duels set version=version+1,host_life=11 where id=$1", [duelId]), /check constraint/);
    await denied(rows("update public.onepiece_duels set version=version+1,state=null where id=$1", [duelId]), /started_state/);
    await denied(rows("update public.onepiece_duels set version=version+1,last_action_by='other' where id=$1", [duelId]), /action_participant/);
    await denied(rows("update public.onepiece_duels set version=version+1,expires_at=created_at where id=$1", [duelId]), /expiry/);
    await denied(insert(crypto.randomUUID(), 'host', 'guest', teamA, { host_deck:null }), /waiting_deck/);
  });
  console.log('PASS service writes preserve team boundaries, two active legacy participants, state shape and version integrity');

  await rows(`insert into public.team_members(slug,full_name,team_id) values
    ('atomic-host','Atomic host',$1),('rate-host','Rate host',$1),
    ('invite-guest-1','Invite guest 1',$1),('invite-guest-2','Invite guest 2',$1),('invite-guest-3','Invite guest 3',$1),
    ('invite-guest-4','Invite guest 4',$1),('invite-guest-5','Invite guest 5',$1),('invite-guest-6','Invite guest 6',$1)`, [teamA]);
  const atomicPayload = (host, guest, extra = {}) => ({ id:crypto.randomUUID(), team_id:teamA, host_slug:host, guest_slug:guest, host_deck:{ cards:[] }, host_life:5, first_player:0, ...extra });
  const atomicInsert = async payload => (await rows('select public.onepiece_duel_insert_invite($1::jsonb) as row', [JSON.stringify(payload)]))[0].row;
  await role('service_role', async () => {
    const payload = atomicPayload('atomic-host', 'invite-guest-1');
    const created = await atomicInsert(payload);
    assert.equal(created.id, payload.id);
    assert.equal(created.version, 1);
    assert.deepEqual(created.ready, [false, false]);
    assert.equal(await atomicInsert(payload), null, 'same request ID returns SQL NULL without duplicating the invite');
    await assert.rejects(atomicInsert(atomicPayload('atomic-host', 'invite-guest-1')), error => error.code === 'P1001' && error.message === 'DUEL_INVITE_PENDING');
    // Expired waiting rows must not prevent a fresh invitation for that pair.
    await insert(crypto.randomUUID(), 'atomic-host', 'invite-guest-2', teamA, {
      created_at:new Date(Date.now() - 86400000).toISOString(), expires_at:new Date(Date.now() - 3600000).toISOString()
    });
    assert.ok(await atomicInsert(atomicPayload('atomic-host', 'invite-guest-2')));
    for (let index = 1; index <= 5; index++) assert.ok(await atomicInsert(atomicPayload('rate-host', `invite-guest-${index}`)));
    await assert.rejects(atomicInsert(atomicPayload('rate-host', 'invite-guest-6')), error => error.code === 'P1002' && error.message === 'DUEL_INVITE_RATE_LIMIT');
    await denied(atomicInsert(atomicPayload('atomic-host', 'external')), /stesso team/);
    await denied(atomicInsert(atomicPayload('atomic-host', 'invite-guest-3', { status:'playing' })), /DUEL_INVITE_INVALID/);
  });
  console.log('PASS atomic invitation RPC enforces idempotency, pending-pair and rate limits with expired-invite recovery');

  const table = (await rows("select relrowsecurity from pg_class where oid='public.onepiece_duels'::regclass"))[0];
  assert.equal(table.relrowsecurity, true);
  assert.equal((await rows("select 1 from pg_policies where tablename='onepiece_duels'")).length, 0);
  assert.equal((await rows("select 1 from pg_publication_tables where schemaname='public' and tablename='onepiece_duels'")).length, 0);
  // Independent defense: even a later accidental SELECT grant cannot expose
  // a stored hand or deck while the table has no participant read policy.
  await db.exec('grant select on public.onepiece_duels to anon,authenticated');
  for (const name of ['anon', 'authenticated']) assert.equal((await role(name, () => rows('select * from public.onepiece_duels'))).length, 0);
  await db.exec('revoke select on public.onepiece_duels from anon,authenticated');
  const identityFunction = (await rows("select prosecdef,proconfig from pg_proc where oid='public.onepiece_duel_identity(text)'::regprocedure"))[0];
  assert.equal(identityFunction.prosecdef, true);
  assert.ok(identityFunction.proconfig.some(value => value === 'search_path=""'));
  console.log('PASS RLS is enabled with no browser policies or Realtime publication and identity RPC pins its search path');

  // Production currently has no optional kind column. The same function and
  // trigger remain valid with that older team_members shape.
  await db.exec("delete from public.duel_test_tokens where member_slug='shadow'; delete from public.team_members where slug='shadow'; alter table public.team_members drop column kind;");
  const legacyIdentity = await role('anon', () => rows('select public.onepiece_duel_identity($1) as actor', ['host-token']));
  assert.equal(legacyIdentity[0].actor.slug, 'host');
  await role('service_role', () => insert(crypto.randomUUID()));
  console.log('PASS schema remains compatible with the existing live team_members table without kind');
  console.log('onepiece-duel-schema-smoke: OK');
} finally { await db.close(); }
