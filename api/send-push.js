const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message:'Metodo non consentito' });
  if (!process.env.PUSH_WEBHOOK_SECRET || req.headers['x-webhook-secret'] !== process.env.PUSH_WEBHOOK_SECRET) return res.status(401).json({ message:'Non autorizzato' });
  const required = ['VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'];
  if (required.some(name => !process.env[name])) return res.status(503).json({ message:'Configurazione incompleta' });

  const payload = req.body || {};
  const record = payload.record || {};
  const old = payload.old_record || {};
  const recipient = recipientFor(payload.type, record, old);
  if (!recipient) return res.status(200).json({ message:'Nessuna notifica necessaria' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{ persistSession:false } });
  const { data, error } = await supabase.from('push_subscriptions').select('endpoint,p256dh,auth').eq('member_slug', recipient.slug);
  if (error) return res.status(500).json({ message:error.message });

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@fptcards.it', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const message = JSON.stringify({ title:recipient.title || 'F.P.T Cards', body:recipient.body, tag:`${recipient.tag || 'update'}-${record.id || ''}`, url:recipient.url || '/' });
  const expired = [];
  await Promise.all((data || []).map(async item => {
    try { await webpush.sendNotification({ endpoint:item.endpoint, keys:{ p256dh:item.p256dh, auth:item.auth } }, message); }
    catch (error) { if ([404,410].includes(error.statusCode)) expired.push(item.endpoint); }
  }));
  if (expired.length) await supabase.from('push_subscriptions').delete().in('endpoint', expired);
  return res.status(200).json({ message:`Notifiche inviate: ${(data || []).length}` });
};

function recipientFor(type, record, old) {
  // Two webhook sources feed this same endpoint: public.loans rows (own
  // shape below) and public.notifications rows (the general notifications
  // center — category/member_slug/title/body — used for share_request,
  // market_alert, system). Tell them apart by the columns present rather
  // than requiring a second endpoint per source table.
  if (record.category) return recipientForNotification(type, record);
  const names = { daniele:'Daniele', 'cristian-arlia':'Cristian Arlia', 'cristian-spadafora':'Cristian Spadafora', cristofer:'Cristofer' };
  if (type === 'INSERT' && record.status === 'requested') return { slug:record.owner_slug, body:`${names[record.borrower_slug] || record.borrower_slug} ti richiede ${record.requested_quantity || record.quantity}× ${record.card_name}`, tag:'loan' };
  if (type === 'INSERT' && record.status === 'pending') return { slug:record.borrower_slug, body:`${names[record.owner_slug] || record.owner_slug} ti ha prestato ${record.quantity}× ${record.card_name}`, tag:'loan' };
  if (type === 'UPDATE' && record.status === 'return_pending' && old.status !== 'return_pending') return { slug:record.owner_slug, body:`${names[record.borrower_slug] || record.borrower_slug} ha segnalato la restituzione di ${record.card_name}`, tag:'loan' };
  return null;
}

function recipientForNotification(type, record) {
  if (type !== 'INSERT') return null;
  return { slug:record.member_slug, title:record.title, body:record.body, tag:`notif-${record.category}`, url:record.route_page ? `/#/${record.route_page}` : '/' };
}
