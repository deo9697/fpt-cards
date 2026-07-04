exports.handler = async () => ({
  statusCode: process.env.VAPID_PUBLIC_KEY ? 200 : 503,
  headers: { 'content-type':'application/json', 'cache-control':'public, max-age=3600' },
  body: JSON.stringify({ publicKey:process.env.VAPID_PUBLIC_KEY || null })
});
