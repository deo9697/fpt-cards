// ESM: package.json ha "type": "module"; la sintassi CommonJS faceva crashare la funzione su Vercel (FUNCTION_INVOCATION_FAILED).
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import { webhookAuthorized } from './_webhook-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message:'Metodo non consentito' });
  if (!webhookAuthorized(req)) return res.status(401).json({ message:'Non autorizzato' });
  const required = ['VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'];
  if (required.some(name => !process.env[name])) return res.status(503).json({ message:'Configurazione incompleta' });

  const payload = req.body || {};
  if (payload.type !== 'INSERT') return res.status(200).json({ message:'Solo INSERT gestito' });
  const record = payload.record || {};
  if (!record.member_slug || !record.title) return res.status(200).json({ message:'Notifica incompleta, ignorata' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{ persistSession:false } });
  const { data, error } = await supabase.from('push_subscriptions').select('endpoint,p256dh,auth').eq('member_slug', record.member_slug);
  if (error) return res.status(500).json({ message:error.message });

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@fptcards.it', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const params = record.route_params && Object.keys(record.route_params).length ? `?${new URLSearchParams(record.route_params)}` : '';
  const message = JSON.stringify({
    title: record.title, body: record.body || '',
    tag: `notif-${record.id}`,
    url: `./#/${record.route_page || ''}${params}`,
    icon: 'icon-192.png', badge: 'icon-192.png'
  });
  const expired = [];
  await Promise.all((data || []).map(async item => {
    try { await webpush.sendNotification({ endpoint:item.endpoint, keys:{ p256dh:item.p256dh, auth:item.auth } }, message); }
    catch (error) { if ([404,410].includes(error.statusCode)) expired.push(item.endpoint); }
  }));
  if (expired.length) await supabase.from('push_subscriptions').delete().in('endpoint', expired);
  return res.status(200).json({ message:`Notifiche inviate: ${(data || []).length}` });
};
