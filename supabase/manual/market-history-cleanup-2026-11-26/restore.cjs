// Reinserisce a blocchi le righe da tenere (keep_snapshots) e poi i prezzi attuali.
// Ogni blocco è un solo INSERT (atomico); i blocchi già fatti si saltano rileggendo progress.json.
const fs = require('fs'), z = require('zlib'), { execFileSync } = require('child_process');
const dir = process.argv[2], app = process.argv[3], TMP = process.env.TEMP || '.';
const read = f => z.gunzipSync(fs.readFileSync(dir + '/' + f)).toString('utf8').split('\n').filter(Boolean);
const progressFile = dir + '/progress.json';
const progress = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, 'utf8')) : {};
const DELIM = '$fptjson$';

function run(sql) {
  const f = TMP + '/restore-batch.sql';
  fs.writeFileSync(f, sql);
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--remote', '--yes', '-f', f], { cwd: app, encoding: 'utf8', maxBuffer: 64e6, shell: true, timeout: 600000 });
  const j = JSON.parse(out.slice(out.indexOf('{')));
  if (!j.rows) throw Error(out.slice(0, 500));
  return j.rows;
}

function load(table, file, size) {
  const lines = read(file);
  for (let i = 0; i < lines.length; i += size) {
    const key = table + ':' + i;
    if (progress[key]) continue;
    const batch = '[' + lines.slice(i, i + size).join(',') + ']';
    if (batch.includes(DELIM)) throw Error('delimiter clash');
    const sql = 'set session characteristics as transaction read write;\n'
      + 'insert into public.' + table + ' select * from jsonb_populate_recordset(null::public.' + table + ', ' + DELIM + batch + DELIM + '::jsonb);\n'
      + 'select count(*)::int n from public.' + table + ';';
    const rows = run(sql);
    progress[key] = rows[0].n;
    fs.writeFileSync(progressFile, JSON.stringify(progress));
    console.log(table, Math.min(i + size, lines.length), '/', lines.length, 'db:', rows[0].n);
  }
  return lines.length;
}

const s = load('market_price_snapshots', 'keep_snapshots.ndjson.gz', 800);
const c = load('market_current_price_snapshots', 'current_price_snapshots.ndjson.gz', 1500);
console.log('RESTORE_DONE', s, c);
