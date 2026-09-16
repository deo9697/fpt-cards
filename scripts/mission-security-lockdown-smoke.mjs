// P0 security — chiusura dell'accesso esterno diretto a bump_daily_mission()
// (supabase/migrations/20260916090000_lockdown_bump_daily_mission.sql).
// Nessun accesso a un Postgres/PostgREST reale in questa sessione: la
// verifica è statica sul testo delle migration/funzioni coinvolte, più un
// file di verifica manuale (scripts/mission-security-lockdown-verify.sql)
// per chi ha accesso al DB. Stesso metodo delle altre migration di questo
// progetto senza sessione DB (vedi scripts/market-watch-current-price-
// cutover-smoke.mjs).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const readRepo = p => readFile(path.join(root, '..', p), 'utf8');

function test(name, fn) { try { fn(); console.log(`PASS ${name}`); } catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; } }

const lockdown = await readRepo('supabase/migrations/20260916090000_lockdown_bump_daily_mission.sql');
const perfMigration = await readRepo('supabase-fast-scan-mission-trigger-perf.sql');
const milestone10 = await readRepo('supabase-milestone-10-daily-missions.sql');

test('la migration di lockdown contiene ESATTAMENTE il revoke atteso, nessuna ridefinizione della funzione', () => {
  assert.match(lockdown, /revoke all on function public\.bump_daily_mission\(text, text, integer, integer, integer\)\s*\n\s*from public, anon, authenticated;/, 'revoke mancante o con firma diversa');
  assert.equal(lockdown.includes('create or replace function'), false, 'la migration non deve ridefinire alcuna funzione: solo un REVOKE, zero rischio di alterare il comportamento');
});

test('la firma nel REVOKE corrisponde ESATTAMENTE a quella della funzione live (supabase-fast-scan-mission-trigger-perf.sql, l\'ultima create or replace)', () => {
  assert.match(perfMigration, /create or replace function public\.bump_daily_mission\(\s*\n\s*p_member text, p_mission_id text, p_target integer, p_delta integer, p_xp_reward integer\s*\n\s*\)/, 'la firma live non è quella attesa: il REVOKE fallirebbe o colpirebbe la funzione sbagliata');
});

test('bump_daily_mission non ha MAI ricevuto un revoke in nessuna migration precedente (il buco era reale, non già chiuso altrove)', () => {
  for (const file of [milestone10, perfMigration]) {
    assert.equal(/revoke\s+all\s+on\s+function\s+public\.bump_daily_mission/i.test(file), false);
  }
});

test('get_my_daily_missions (l\'unica RPC missioni pensata per il client) mantiene il suo grant esplicito, non toccato da questa migration', () => {
  assert.match(milestone10, /grant execute on function public\.get_my_daily_missions\(text\) to anon, authenticated;/);
  assert.equal(/\b(grant|revoke)\b[^\n]*get_my_daily_missions/i.test(lockdown), false, 'la migration di lockdown non deve grant/revoke su get_my_daily_missions (una menzione nel commento di verifica va bene)');
});

test('i 3 trigger (aggiunta carte/salvataggio deck/registrazione match) chiamano bump_daily_mission internamente via `perform`, invariati', () => {
  const expectations = [
    { fn: 'trg_mission_on_match', call: "perform public.bump_daily_mission(new.member_slug, 'daily_duel_log', 1, 1, 25);" },
    { fn: 'trg_mission_on_deck', call: "perform public.bump_daily_mission(new.owner_slug, 'daily_deck_complete', 1, 1, 25);" },
    { fn: 'trg_mission_on_collection', call: "perform public.bump_daily_mission(new.owner_slug, 'daily_collection_100', 100, delta, 40);" }
  ];
  for (const { fn, call } of expectations) {
    assert.match(milestone10, new RegExp(`create or replace function public\\.${fn}`), `${fn} deve esistere`);
    assert.equal(milestone10.includes(call), true, `${fn} deve ancora chiamare bump_daily_mission con la stessa firma`);
  }
});

test('perché il REVOKE non rompe i 3 trigger: sono anch\'essi SECURITY DEFINER (girano col ruolo owner, non anon/authenticated, quindi il REVOKE da anon/authenticated non li tocca)', () => {
  for (const fn of ['trg_mission_on_match', 'trg_mission_on_deck', 'trg_mission_on_collection']) {
    const start = milestone10.indexOf(`create or replace function public.${fn}`);
    const end = milestone10.indexOf('$$;', start) + 3;
    const header = milestone10.slice(start, milestone10.indexOf('$$', start));
    assert.match(header, /security definer/, `${fn} deve essere security definer perché il perform interno funzioni indipendentemente dal REVOKE`);
  }
});

test('nessun tocco a market watch/fast scan/altre RPC fuori scope in questa migration', () => {
  for (const forbidden of ['market_', 'fast_scan', 'create trigger', 'create table', 'alter table']) {
    assert.equal(lockdown.toLowerCase().includes(forbidden.toLowerCase()), false, `riferimento vietato: ${forbidden}`);
  }
});

console.log('PASS mission security lockdown: revoke corretto e mirato, funzione non ridefinita, get_my_daily_missions e i 3 trigger invariati — verifica live (permission denied via RPC + missioni/XP ancora aggiornate dai flussi reali) in scripts/mission-security-lockdown-verify.sql');
