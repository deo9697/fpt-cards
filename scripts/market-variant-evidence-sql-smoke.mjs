// SQL smoke for 20261117130000_market_variant_evidence.sql on PGlite.
// Minimal stubs of the real tables/functions; set_market_mapping_manual is the
// production definition (fixture), so the single confirmation reuses it as-is.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migration = readFileSync(new URL('../supabase/migrations/20261117130000_market_variant_evidence.sql', import.meta.url), 'utf8');
const manualFn = readFileSync(new URL('./fixtures/set-market-mapping-manual.prod-2026-11-17.sql', import.meta.url), 'utf8');

await db.exec(`
  create schema if not exists extensions;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role; exception when duplicate_object then null; end $$;
  create table team_members (slug text primary key, team text);
  create table sessions (token text primary key, slug text);
  create function session_member(p_token text) returns text language sql as $$ select slug from sessions where token = p_token $$;
  create function member_team(p_slug text) returns text language sql as $$ select team from team_members where slug = p_slug $$;
  create function core_team_id() returns text language sql as $$ select 'fpt' $$;
  create table card_printings (id uuid primary key, game text, card_name text, set_code text, set_name text, rarity text, image_url text);
  create table collection_items (id serial primary key, printing_id uuid, owner_slug text);
  create table market_provider_printings (id uuid primary key default gen_random_uuid(), printing_id uuid, provider text, variant_key text default 'default',
    provider_product_id text, condition_reference text, resolution_status text, confidence numeric, resolved_at timestamptz, last_checked_at timestamptz,
    refresh_requested_at timestamptz, last_error text, provider_metadata jsonb, updated_at timestamptz);
  create table ygo_market_variants (id uuid primary key default gen_random_uuid(), printing_id uuid unique, rarity_raw text not null default '', rarity_canonical text,
    cardmarket_product_id text, cardmarket_expansion_id text, candidate_product_ids jsonb not null default '[]', mapping_source text, mapping_confidence numeric,
    mapping_status text not null default 'unresolved', mapping_notes text, verified boolean not null default false, verified_at timestamptz, verified_by text,
    resolution_reason text, created_at timestamptz default now(), updated_at timestamptz default now());
  insert into team_members values ('daniele','fpt'), ('ospite','beta');
  insert into sessions values ('tok-dan','daniele'), ('tok-guest','ospite');
  insert into card_printings values
    ('00000000-0000-0000-0000-000000000001','yugioh','Cyberse Contract Witch','MAMO-EN018','Magnificent Monsters','Ultra Rare',''),
    ('00000000-0000-0000-0000-000000000002','yugioh','Favorite HERO','MAMO-EN005','Magnificent Monsters','Ultra Rare',''),
    ('00000000-0000-0000-0000-000000000003','yugioh','Raigeki','BP01-IT032','Battle Pack','Starfoil Rare','');
  insert into collection_items (printing_id, owner_slug) values
    ('00000000-0000-0000-0000-000000000001','daniele'), ('00000000-0000-0000-0000-000000000002','daniele'), ('00000000-0000-0000-0000-000000000003','daniele');
  insert into market_provider_printings (printing_id, provider, provider_product_id, resolution_status, provider_metadata) values
    ('00000000-0000-0000-0000-000000000001','cardmarket','904602','resolved','{"resolverStatus":"AMBIGUOUS","candidateProductIds":["904602","904603","904604","904605"],"evidence":{"candidates":[{"productId":"904602"},{"productId":"904603"}]}}'),
    ('00000000-0000-0000-0000-000000000002','cardmarket','904550','resolved','{"resolverStatus":"AMBIGUOUS","candidateProductIds":["904550","904551","904552","904553"],"evidence":{"candidates":[{"productId":"904550"},{"productId":"904551"}]}}'),
    ('00000000-0000-0000-0000-000000000003','cardmarket','255000','resolved','{"resolverStatus":"PROVIDER_AGGREGATE","candidateProductIds":["255000","255341"],"evidence":{"candidates":[{"productId":"255000"},{"productId":"255341"}]}}');
`);
await db.exec(manualFn);
await db.exec(migration);
await db.exec(migration); // rieseguibile
console.log('PASS migrazione applicata due volte senza errori');

const queue = async () => (await db.query(`select public.list_market_confirm_queue('tok-dan','yugioh') q`)).rows[0].q.items;
assert.equal((await queue()).length, 3, 'all\'inizio le 3 carte sono in coda');

// Suggerimento del motore (scritto da market-sync) → compare in coda.
await db.exec(`insert into ygo_market_variants (printing_id, cardmarket_product_id, candidate_product_ids, mapping_source, mapping_confidence, mapping_status, resolution_reason, mapping_notes)
  values ('00000000-0000-0000-0000-000000000002','904550','["904550","904551","904552","904553"]','resolver',0.5,'ambiguous','evidence_suggestion','rarità base, versione più economica')`);
const suggested = (await queue()).find(item => item.printing_id === '00000000-0000-0000-0000-000000000002');
assert.equal(suggested.suggested_product_id, '904550');
assert.equal(suggested.suggestion_note, 'rarità base, versione più economica');
console.log('PASS coda: suggerimento del motore restituito con la sua motivazione');

// Conferma singola: mapping manuale + variante verificata da cui imparare.
await db.query(`select public.confirm_market_variant_choice('tok-dan','00000000-0000-0000-0000-000000000001','904602','Cyberse Contract Witch','Magnificent Monsters','')`);
const mapping = (await db.query(`select resolution_status, provider_product_id, provider_metadata from market_provider_printings where printing_id='00000000-0000-0000-0000-000000000001'`)).rows[0];
assert.equal(mapping.resolution_status, 'manual');
assert.equal(mapping.provider_product_id, '904602');
assert.equal(mapping.provider_metadata.confirmMode, 'single');
assert.equal(mapping.provider_metadata.manualConfirmedBy, 'daniele');
const variant = (await db.query(`select * from ygo_market_variants where printing_id='00000000-0000-0000-0000-000000000001'`)).rows[0];
assert.equal(variant.verified, true);
assert.equal(variant.mapping_source, 'manual');
assert.equal(variant.cardmarket_product_id, '904602');
assert.deepEqual(variant.candidate_product_ids, ['904602', '904603', '904604', '904605'], 'le versioni servono al motore per imparare la posizione');
assert(!(await queue()).some(item => item.printing_id === '00000000-0000-0000-0000-000000000001'), 'la carta confermata esce dalla coda');
console.log('PASS conferma singola: mapping manuale, variante verificata con le versioni, carta fuori dalla coda');

await assert.rejects(db.query(`select public.confirm_market_variant_choice('tok-dan','00000000-0000-0000-0000-000000000002','999999')`), /non è tra le versioni/);
await assert.rejects(db.query(`select public.confirm_market_variant_choice('tok-guest','00000000-0000-0000-0000-000000000002','904550')`), /riservata al team/);
await assert.rejects(db.query(`select public.confirm_market_variant_choice('scaduto','00000000-0000-0000-0000-000000000002','904550')`), /Sessione scaduta/);
console.log('PASS conferma singola: rifiuta prodotto estraneo, team ospite e sessione scaduta');

// Autorizzazione da parte del motore: solo AMBIGUOUS, solo prodotti candidati.
await db.query(`select public.market_authorize_evidence_variant('00000000-0000-0000-0000-000000000002','123','x')`);
assert.equal((await db.query(`select provider_metadata->>'resolverStatus' s from market_provider_printings where printing_id='00000000-0000-0000-0000-000000000002'`)).rows[0].s, 'AMBIGUOUS', 'un prodotto non candidato non autorizza nulla');
await db.query(`select public.market_authorize_evidence_variant('00000000-0000-0000-0000-000000000002','904550','rarità base + stessa rarità confermata nel set')`);
const authorized = (await db.query(`select resolution_status, provider_metadata from market_provider_printings where printing_id='00000000-0000-0000-0000-000000000002'`)).rows[0];
assert.equal(authorized.provider_metadata.resolverStatus, 'PROVIDER_AGGREGATE');
assert.equal(authorized.provider_metadata.evidenceAuto.productId, '904550');
await db.query(`select public.market_authorize_evidence_variant('00000000-0000-0000-0000-000000000001','904603','x')`);
assert.equal((await db.query(`select resolution_status from market_provider_printings where printing_id='00000000-0000-0000-0000-000000000001'`)).rows[0].resolution_status, 'manual', 'mai sopra una conferma manuale');
console.log('PASS autorizzazione automatica: solo carte AMBIGUOUS, solo prodotti candidati, mai sopra una conferma manuale');

// Variante decisa in automatico (resolved, confidenza 1) → fuori dalla coda.
await db.exec(`update ygo_market_variants set mapping_status='resolved', mapping_confidence=1, resolution_reason='evidence_auto' where printing_id='00000000-0000-0000-0000-000000000002'`);
assert.deepEqual((await queue()).map(item => item.printing_id), ['00000000-0000-0000-0000-000000000003'], 'restano in coda solo le carte senza variante esatta');
// Variante con confidenza nulla: la carta NON deve sparire dalla coda.
await db.exec(`insert into ygo_market_variants (printing_id, cardmarket_product_id, mapping_status, mapping_confidence) values ('00000000-0000-0000-0000-000000000003','255000','resolved',null)`);
assert.equal((await queue()).length, 1, 'confidenza nulla non toglie la carta dalla coda');
console.log('PASS coda: escluse le carte con variante esatta, confidenza nulla gestita');

const grants = (await db.query(`select has_function_privilege('anon','public.market_authorize_evidence_variant(uuid,text,text)','execute') anon_auth, has_function_privilege('service_role','public.market_authorize_evidence_variant(uuid,text,text)','execute') svc, has_function_privilege('anon','public.confirm_market_variant_choice(text,uuid,text,text,text,text)','execute') anon_confirm`)).rows[0];
assert.deepEqual(grants, { anon_auth: false, svc: true, anon_confirm: true });
console.log('PASS grant: autorizzazione automatica solo service_role, conferma singola per i client');
console.log('market-variant-evidence-sql-smoke: OK');
