// Decklist Image Generator — proxy CORS ristretto SOLO ai domini reali già
// usati da FPT Cards per gli artwork (verificato live con curl, non
// assunto): images.ygoprodeck.com e images.ygoprodeck.com/images/cards_cropped
// (Yu-Gi-Oh!, via preferredDeckArtwork in js/deck-box.js) rispondono senza
// Access-Control-Allow-Origin anche con un header Origin esplicito —
// caricarli in un <img crossorigin> per poi leggerli da un canvas
// (canvas.toBlob) li rende "tainted" e blocca l'export. optcgapi.com (One
// Piece, dal catalogo sincronizzato in Supabase) non espone alcun header
// CORS nemmeno lui. Whitelist chiusa: qualunque altro host viene rifiutato,
// mai un proxy aperto verso URL arbitrari.
const ALLOWED_HOSTS = new Set(['images.ygoprodeck.com', 'optcgapi.com']);

// Hardening (richiesto esplicitamente, isolato a questo file):
// 1) redirect: 'manual' + validazione MANUALE di ogni hop — senza questo,
//    fetch() seguirebbe di default un redirect verso un host FUORI dalla
//    whitelist (es. un host malevolo se ygoprodeck/optcgapi venissero mai
//    compromessi o rispondessero con un redirect inatteso), aggirando
//    interamente la whitelist a valle del primo controllo.
// 2) un tetto alla dimensione della risposta, applicato SIA sul
//    Content-Length dichiarato SIA, soprattutto, sui byte realmente letti
//    dallo stream — un header assente/falsato non deve permettere di
//    bufferizzare una risposta arbitrariamente grande in memoria.
const MAX_REDIRECTS = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB: generoso per un artwork carta, stretto per un abuso

class ProxyError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function assertAllowedUrl(url) {
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new ProxyError(403, 'host non consentito');
  }
}

// Segue i redirect A MANO (mai fetch con redirect:'follow'): ogni hop,
// incluso quello finale, viene validato contro la stessa whitelist
// dell'URL iniziale prima di essere richiesto.
async function fetchFollowingValidatedRedirects(initialUrl, { signal }) {
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedUrl(current);
    const response = await fetch(current, { signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new ProxyError(502, 'redirect senza location');
      let next;
      try { next = new URL(location, current); }
      catch { throw new ProxyError(502, 'redirect non valido'); }
      current = next;
      continue;
    }
    return response;
  }
  throw new ProxyError(502, 'troppi redirect');
}

// Legge il body applicando il tetto SIA su Content-Length (fail veloce se
// dichiarato) SIA sui byte via via ricevuti (un Content-Length assente o
// falsato non deve mai permettere di superare il limite).
async function readBodyWithLimit(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new ProxyError(413, 'immagine troppo grande');

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new ProxyError(413, 'immagine troppo grande');
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ProxyError(413, 'immagine troppo grande');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ message: 'Metodo non consentito' });

  const raw = req.query?.url;
  let target;
  try { target = new URL(String(raw || '')); }
  catch { return res.status(400).json({ message: 'url mancante o non valido' }); }

  try { assertAllowedUrl(target); }
  catch (error) { return res.status(error.status).json({ message: error.message }); }

  let upstream;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try { upstream = await fetchFollowingValidatedRedirects(target, { signal: controller.signal }); }
    finally { clearTimeout(timeout); }
  } catch (error) {
    if (error instanceof ProxyError) return res.status(error.status).json({ message: error.message });
    return res.status(502).json({ message: 'artwork non raggiungibile' });
  }
  if (!upstream.ok) return res.status(upstream.status).json({ message: 'artwork non disponibile' });

  const contentType = upstream.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) return res.status(415).json({ message: 'risposta non è un\'immagine' });

  let buffer;
  try { buffer = await readBodyWithLimit(upstream, MAX_IMAGE_BYTES); }
  catch (error) {
    if (error instanceof ProxyError) return res.status(error.status).json({ message: error.message });
    return res.status(502).json({ message: 'lettura immagine non riuscita' });
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).send(buffer);
};
