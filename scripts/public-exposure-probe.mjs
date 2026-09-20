// Sonda post-deploy: file interni che NON devono essere raggiungibili dal dominio pubblico.
// Uso: node scripts/public-exposure-probe.mjs https://fpt-cards.vercel.app   (exit 1 se qualcosa è esposto)
import fs from 'node:fs';
const origin = (process.argv[2] || '').replace(/\/$/, '');
if (!origin) { console.error('Uso: node scripts/public-exposure-probe.mjs <origin>'); process.exit(2); }
const migrations = fs.existsSync('supabase/migrations') ? fs.readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).slice(-3) : [];
const docs = fs.existsSync('docs') ? fs.readdirSync('docs').filter(f => f.endsWith('.md')).slice(0, 3) : [];
const forbidden = ['supabase/config.toml', ...migrations.map(f => `supabase/migrations/${f}`), 'supabase-setup.sql', 'supabase-secure-pin-upgrade.sql', ...docs.map(f => `docs/${f}`), 'docs/audit-snapshots/pre-migration-fingerprints-2026-09-19.json', 'scripts/preview-server.mjs', 'scripts/user-edition-gotrue-e2e.mjs', 'design-qa.md', 'package.json', 'package-lock.json', '.git/config', 'backups/'];
const required = ['', 'index.html', 'app.js', 'config.js', 'sw.js', 'styles.css', 'js/user-edition.js', 'js/identity.js', 'manifest.webmanifest'];
let bad = 0;
for (const p of forbidden) { const r = await fetch(`${origin}/${p}`, { redirect: 'manual' }).catch(() => ({ status: 0 })); const exposed = r.status === 200; if (exposed) bad++; console.log(`${exposed ? 'ESPOSTO ' : 'ok      '} /${p}  [${r.status}]`); }
for (const p of required) { const r = await fetch(`${origin}/${p}`).catch(() => ({ status: 0 })); const ok = r.status === 200; if (!ok) bad++; console.log(`${ok ? 'ok      ' : 'MANCANTE'} /${p}  [${r.status}]`); }
console.log(bad ? `\n${bad} problemi` : '\nnessuna esposizione'); process.exit(bad ? 1 : 0);
