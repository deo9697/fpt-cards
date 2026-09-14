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

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ message: 'Metodo non consentito' });

  const raw = req.query?.url;
  let target;
  try { target = new URL(String(raw || '')); }
  catch { return res.status(400).json({ message: 'url mancante o non valido' }); }

  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    return res.status(403).json({ message: 'host non consentito' });
  }

  let upstream;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    upstream = await fetch(target, { signal: controller.signal });
    clearTimeout(timeout);
  } catch {
    return res.status(502).json({ message: 'artwork non raggiungibile' });
  }
  if (!upstream.ok) return res.status(upstream.status).json({ message: 'artwork non disponibile' });

  const contentType = upstream.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) return res.status(415).json({ message: 'risposta non è un\'immagine' });

  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).send(buffer);
};
