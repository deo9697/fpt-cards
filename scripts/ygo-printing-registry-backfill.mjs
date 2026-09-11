// Backfill del Printing Registry sulle printing Yu-Gi-Oh già presenti in
// card_printings. Classifica ogni set_code distinto (verified/resolved/
// unresolved/conflict) tramite il resolver reale (js/ygo-printing-registry.js)
// — nessuna correzione automatica dei casi ambigui, solo classificazione.
//
// Uso: node scripts/ygo-printing-registry-backfill.mjs [porta CDP, default 9351]
// Richiede l'app aperta e loggata in una scheda Chrome con quella porta di
// debug (stesso pattern di scripts/repair-known-card-images.mjs).

const port = Number(process.argv[2] || 9351);
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const tab = tabs.find(target => target.type === 'page' && target.url.includes('localhost:8080'));
if (!tab) throw new Error('Scheda F.P.T Cards non trovata');

const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

async function evaluate(expression) {
  const id = Math.floor(Math.random() * 1e9);
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  return new Promise((resolve, reject) => {
    const handler = event => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener('message', handler);
      if (message.error || message.result?.exceptionDetails) {
        const details = message.result?.exceptionDetails;
        reject(new Error(details?.exception?.description || details?.text || message.error?.message));
      } else resolve(message.result.result.value);
    };
    socket.addEventListener('message', handler);
  });
}

console.log('Backfill: enumero le printing Yu-Gi-Oh esistenti…');
let afterId = null;
const rows = [];
while (true) {
  const page = await evaluate(`(async()=>{
    const {api}=await import('./js/api.js');
    return api.ygoPrintingsForBackfill(${JSON.stringify(afterId)}, 500);
  })()`);
  if (!page.length) break;
  rows.push(...page);
  afterId = page[page.length - 1].id;
  if (page.length < 500) break;
}
console.log(`Backfill: ${rows.length} righe card_printings (yugioh, set_code non vuoto) trovate.`);

const setCodes = [...new Set(rows.map(r => r.set_code).filter(Boolean))];
console.log(`Backfill: ${setCodes.length} set code distinti da risolvere tramite il registro.`);

const CHUNK = 40;
for (let index = 0; index < setCodes.length; index += CHUNK) {
  const chunk = setCodes.slice(index, index + CHUNK);
  await evaluate(`(async()=>{
    const {resolveYgoPrintings}=await import('./js/ygo-printing-registry.js');
    await resolveYgoPrintings(${JSON.stringify(chunk)});
  })()`);
  console.log(`Backfill: risolti ${Math.min(index + CHUNK, setCodes.length)}/${setCodes.length} set code…`);
}

console.log('Backfill: leggo lo stato finale del registro…');
const registryRows = await evaluate(`(async()=>{
  const {api}=await import('./js/api.js');
  return api.ygoPrintingRegistryIssues(['verified','resolved','unresolved','conflict']);
})()`);

const counts = { verified: 0, resolved: 0, unresolved: 0, conflict: 0 };
for (const row of registryRows) counts[row.mapping_status] = (counts[row.mapping_status] || 0) + 1;

console.log('\n=== Report backfill Printing Registry ===');
console.log(`Totale set code distinti processati: ${setCodes.length}`);
console.log(`Totale righe nel registro: ${registryRows.length}${registryRows.length >= 2000 ? ' (limite di lettura 2000 raggiunto: rilanciare per stati specifici se serve il resto)' : ''}`);
console.log(`  verified:   ${counts.verified}`);
console.log(`  resolved:   ${counts.resolved}`);
console.log(`  unresolved: ${counts.unresolved}`);
console.log(`  conflict:   ${counts.conflict}`);

const problematic = registryRows.filter(row => row.mapping_status === 'unresolved' || row.mapping_status === 'conflict');
if (problematic.length) {
  console.log('\nCasi da rivedere (non corretti automaticamente):');
  for (const row of problematic.slice(0, 200)) {
    console.log(`  ${row.set_code} — ${row.card_name || '(nome sconosciuto)'} — ${row.mapping_status}${row.mapping_notes ? ' — ' + row.mapping_notes : ''}`);
  }
  if (problematic.length > 200) console.log(`  … e altri ${problematic.length - 200} casi (vedi list_ygo_printing_registry_issues per l'elenco completo).`);
}

socket.close();
console.log('\nBackfill completato.');
