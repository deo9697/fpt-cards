// Funzioni Vercel push (api/*.js): caricamento ESM, autenticazione del webhook, rotazione a doppio secret.
// Regressione del guasto reale: con "type":"module" le funzioni CommonJS crashavano (FUNCTION_INVOCATION_FAILED).
import assert from 'node:assert/strict';
import fs from 'node:fs';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  ok   ${name}`); }
  catch (error) { results.push(false); console.log(`  FAIL ${name}\n       ${String(error.stack).split('\n').slice(0, 3).join('\n       ')}`); }
}
const OLD = 'old-secret-0123456789abcdef', NEXT = 'next-secret-0123456789abcdef';
const res = () => { const r = { code: 0, body: null, headers: {}, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, setHeader(k, v) { r.headers[k] = v; } }; return r; };
const withEnv = async (env, fn) => { const saved = { ...process.env }; for (const k of Object.keys(process.env)) if (/^(PUSH_WEBHOOK|VAPID|SUPABASE)/.test(k)) delete process.env[k]; Object.assign(process.env, env); try { return await fn(); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); } };

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
await test('package.json è "type":"module" → i file api/ devono essere ESM (causa del guasto reale)', async () => {
  assert.equal(pkg.type, 'module');
  for (const f of fs.readdirSync('api').filter(x => x.endsWith('.js'))) { const src = fs.readFileSync(`api/${f}`, 'utf8'); assert.ok(!/\brequire\(|module\.exports/.test(src), `${f}: CommonJS in un package ESM`); }
});
const handlers = {};
for (const name of ['push-public-key', 'send-push', 'send-notification-push']) {
  await test(`${name}: si carica come ESM ed esporta una funzione di default`, async () => { const m = await import(`../api/${name}.js`); assert.equal(typeof m.default, 'function'); handlers[name] = m.default; });
}
const { webhookAuthorized } = await import('../api/_webhook-auth.js');
const req = secret => ({ headers: secret === undefined ? {} : { 'x-webhook-secret': secret } });
await test('auth: secret corrente accettato; assente/errato/vuoto/array/prefisso rifiutati', async () => {
  const env = { PUSH_WEBHOOK_SECRET: OLD };
  assert.equal(webhookAuthorized(req(OLD), env), true);
  for (const bad of [undefined, '', 'sbagliato', OLD.slice(0, -1), OLD + 'x', [OLD]]) assert.equal(webhookAuthorized(req(bad), env), false, JSON.stringify(bad));
  assert.equal(webhookAuthorized(req(OLD), {}), false, 'nessun secret configurato → sempre rifiutato');
  assert.equal(webhookAuthorized(req(''), { PUSH_WEBHOOK_SECRET: '' }), false);
  assert.equal(webhookAuthorized(req('short'), { PUSH_WEBHOOK_SECRET: 'short' }), false, 'secret troppo corti non sono validi');
});
await test('rotazione: fase 1 entrambi validi → fase 3 solo il nuovo (il vecchio è invalidato)', async () => {
  const phase1 = { PUSH_WEBHOOK_SECRET: OLD, PUSH_WEBHOOK_SECRET_NEXT: NEXT };
  assert.equal(webhookAuthorized(req(OLD), phase1), true); assert.equal(webhookAuthorized(req(NEXT), phase1), true);
  const phase3 = { PUSH_WEBHOOK_SECRET: NEXT };
  assert.equal(webhookAuthorized(req(NEXT), phase3), true); assert.equal(webhookAuthorized(req(OLD), phase3), false);
});
await test('handler: POST senza/con secret errato → 401 (nessun lavoro fatto); GET → 405', async () => {
  for (const name of ['send-push', 'send-notification-push']) await withEnv({ PUSH_WEBHOOK_SECRET: OLD }, async () => {
    let r = res(); await handlers[name]({ method: 'GET', headers: {} }, r); assert.equal(r.code, 405);
    r = res(); await handlers[name]({ method: 'POST', headers: {}, body: {} }, r); assert.equal(r.code, 401);
    r = res(); await handlers[name]({ method: 'POST', headers: { 'x-webhook-secret': 'nope' }, body: {} }, r); assert.equal(r.code, 401);
  });
});
await test('handler: con secret valido (corrente o NEXT) supera l\'auth; senza VAPID/SUPABASE risponde 503, non 401/500', async () => {
  for (const name of ['send-push', 'send-notification-push']) for (const secret of [OLD, NEXT]) await withEnv({ PUSH_WEBHOOK_SECRET: OLD, PUSH_WEBHOOK_SECRET_NEXT: NEXT }, async () => {
    const r = res(); await handlers[name]({ method: 'POST', headers: { 'x-webhook-secret': secret }, body: { type: 'INSERT', record: {} } }, r); assert.equal(r.code, 503, `${name}: ${r.code}`);
  });
});
await test('handler: con env completo e payload irrilevante → 200 senza toccare il DB', async () => {
  const env = { PUSH_WEBHOOK_SECRET: OLD, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  await withEnv(env, async () => {
    let r = res(); await handlers['send-notification-push']({ method: 'POST', headers: { 'x-webhook-secret': OLD }, body: { type: 'UPDATE', record: {} } }, r); assert.deepEqual([r.code, r.body.message], [200, 'Solo INSERT gestito']);
    r = res(); await handlers['send-push']({ method: 'POST', headers: { 'x-webhook-secret': OLD }, body: { type: 'UPDATE', record: { status: 'active' }, old_record: { status: 'active' } } }, r); assert.equal(r.code, 200);
  });
});
await test('push-public-key: 200 con la chiave, 503 senza, 405 non-GET', async () => {
  await withEnv({ VAPID_PUBLIC_KEY: 'BPublicKey' }, async () => { const r = res(); await handlers['push-public-key']({ method: 'GET' }, r); assert.deepEqual([r.code, r.body.publicKey], [200, 'BPublicKey']); });
  await withEnv({}, async () => { const r = res(); await handlers['push-public-key']({ method: 'GET' }, r); assert.equal(r.code, 503); });
  const r = res(); await handlers['push-public-key']({ method: 'POST' }, r); assert.equal(r.code, 405);
});
await test('nessun secret nel repo: nessun valore hex/base64 lungo in api/, trigger template con placeholder', async () => {
  for (const f of fs.readdirSync('api').filter(x => x.endsWith('.js'))) assert.ok(!/['"`][0-9a-f]{40,}['"`]/i.test(fs.readFileSync(`api/${f}`, 'utf8')), `${f}: possibile secret`);
  const sql = fs.readFileSync('supabase/manual/rotate-push-webhook-secret.sql', 'utf8');
  assert.ok(sql.includes(':NEW_SECRET') && !/[0-9a-f]{48,}/i.test(sql), 'lo script deve usare un placeholder');
});

const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed}/${results.length} test passati`);
if (failed) process.exit(1);
