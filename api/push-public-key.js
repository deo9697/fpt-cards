module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ message:'Metodo non consentito' });
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ publicKey:null, message:'VAPID_PUBLIC_KEY non configurata' });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({ publicKey:process.env.VAPID_PUBLIC_KEY });
};
