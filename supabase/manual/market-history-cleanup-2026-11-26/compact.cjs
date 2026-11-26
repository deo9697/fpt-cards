// Converte l'output JSON di `supabase db query` in NDJSON compresso e stampa il numero di righe.
const fs=require('fs'),zlib=require('zlib');const [src,dst]=process.argv.slice(2);
const raw=fs.readFileSync(src,'utf8');const j=JSON.parse(raw.slice(raw.indexOf('{')));
if(!Array.isArray(j.rows))throw Error('no rows: '+raw.slice(0,300));
fs.writeFileSync(dst,zlib.gzipSync(j.rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{level:9}));
console.log(j.rows.length);
