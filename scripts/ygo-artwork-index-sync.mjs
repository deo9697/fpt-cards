// Sincronizza ygo_artwork_index dal manifest artwork di YGOResources.
//
// Il manifest (artworks.ygoresources.com/manifest.json) pesa ~21MB e NON
// collega artwork_index a set_code (verificato: nessun campo del genere nel
// JSON, confermato anche dal loro README "Do not rely on any details of our
// file paths to try and guess them on your own"). Per questo lo scarichiamo
// UNA volta qui (mai dal client durante una scansione) e salviamo solo il
// fatto derivato che serve al resolver: quanti artwork esistono per un dato
// Konami card ID, quale URL se ne esiste esattamente uno, e l'elenco
// completo dei candidati (per l'Admin Artwork Resolver, che li mostra
// all'admin per la scelta manuale quando sono più di uno).
//
// Uso: node scripts/ygo-artwork-index-sync.mjs [porta CDP, default 9351]
// Richiede l'app aperta e loggata in una scheda Chrome con quella porta di
// debug (stesso pattern di scripts/repair-known-card-images.mjs).

const MANIFEST_URL = 'https://artworks.ygoresources.com/manifest.json';
const BATCH_SIZE = 2000;
// Nessuna carta reale nota supera questo numero di artwork (il massimo
// osservato è 18, Dark Magician): un tetto alto evita solo payload
// patologici senza mai troncare un caso reale.
const MAX_CANDIDATES = 50;

console.log('ygo-artwork-index-sync: scarico il manifest (~21MB, una sola volta)…');
const manifest = await (await fetch(MANIFEST_URL)).json();
const cards = manifest.cards || {};
const entries = Object.entries(cards).map(([konamiCardId, artworks]) => {
  const indexes = Object.keys(artworks || {});
  const single = indexes.length === 1 ? artworks[indexes[0]] : null;
  const singleArtworkUrl = single?.bestArt ? new URL(single.bestArt, 'https://artworks.ygoresources.com/').href : null;
  const candidates = indexes.slice(0, MAX_CANDIDATES)
    .map(index => ({ index, url: artworks[index]?.bestArt ? new URL(artworks[index].bestArt, 'https://artworks.ygoresources.com/').href : null }))
    .filter(candidate => candidate.url);
  return { konamiCardId, artworkCount: indexes.length, singleArtworkUrl, candidates };
});
console.log(`ygo-artwork-index-sync: ${entries.length} Konami card ID nel manifest, ${entries.filter(e => e.artworkCount === 1).length} con artwork singolo (deterministico).`);

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

let upserted = 0;
for (let index = 0; index < entries.length; index += BATCH_SIZE) {
  const batch = entries.slice(index, index + BATCH_SIZE);
  const count = await evaluate(`(async()=>{
    const {api}=await import('./js/api.js');
    return api.ygoArtworkIndexUpsert(${JSON.stringify(batch)});
  })()`);
  upserted += count;
  console.log(`ygo-artwork-index-sync: batch ${index / BATCH_SIZE + 1} — ${count} righe aggiornate (${upserted}/${entries.length})`);
}
socket.close();
console.log(`ygo-artwork-index-sync: completato, ${upserted} Konami card ID sincronizzati.`);
