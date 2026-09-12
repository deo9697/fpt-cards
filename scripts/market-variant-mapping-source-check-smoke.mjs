// Regression per il fix 23514 (ygo_market_variants_mapping_source_check
// rifiutava 'verified_set_template' con un rollback completo dell'update).
// Non c'è accesso DB da questa sessione: verifica staticamente che (a) la
// migration di follow-up droppi/ricrei il constraint con tutti e 5 i valori
// attesi, invariati rispetto a prima più 'verified_set_template', e (b) che
// il valore che il resolver JS scrive davvero (MARKET_VARIANT_SOURCE.
// SET_TEMPLATE) sia esattamente uno di quelli accettati dal constraint —
// così un futuro rename in uno dei due lati fa fallire il test invece di
// fallire di nuovo in produzione con un 23514.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MARKET_VARIANT_SOURCE } from '../market/providers.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(root, '..', 'supabase', 'migrations', '20260912210000_ygo_market_variant_mapping_source_check.sql');
const sql = readFileSync(migrationPath, 'utf8');

function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exitCode = 1; }
}

test('la migration droppa e ricrea SOLO ygo_market_variants_mapping_source_check', () => {
  assert.match(sql, /drop constraint if exists ygo_market_variants_mapping_source_check/);
  assert.match(sql, /add constraint ygo_market_variants_mapping_source_check/);
  // Nessun'altra alter table/constraint/update in questo file: fix minimale.
  assert.equal((sql.match(/alter table/g) || []).length, 2);
  assert.equal(/\bupdate\s+public\.ygo_market_variants\b/i.test(sql), false, 'non deve toccare dati esistenti');
});

test('il constraint accetta i 4 valori originali più verified_set_template, nessuno perso', () => {
  const expected = ['manual', 'registry', 'resolver', 'legacy', 'verified_set_template'];
  for (const value of expected) {
    assert.match(sql, new RegExp(`'${value}'`), `manca '${value}' nel nuovo constraint`);
  }
  // Anche il ramo "is null" originale resta permesso.
  assert.match(sql, /mapping_source is null/);
});

test('MARKET_VARIANT_SOURCE.SET_TEMPLATE scrive esattamente il valore ora accettato dal constraint', () => {
  assert.equal(MARKET_VARIANT_SOURCE.SET_TEMPLATE, 'verified_set_template');
  assert.match(sql, new RegExp(`'${MARKET_VARIANT_SOURCE.SET_TEMPLATE}'`));
});

test('la migration è transazionale (begin...commit) come le altre di questo set', () => {
  const withoutLeadingComments = sql.trim().replace(/^(--[^\n]*\n)*\s*/, '');
  assert.match(withoutLeadingComments, /^begin;/);
  assert.match(sql.trim(), /commit;\s*$/);
});

console.log('market variant mapping_source check: constraint di follow-up coerente con MARKET_VARIANT_SOURCE, nessun dato toccato, transazionale');
