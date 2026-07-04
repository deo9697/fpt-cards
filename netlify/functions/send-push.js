const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return response(405, 'Metodo non consentito');
  if (!process.env.PUSH_WEBHOOK_SECRET || event.headers['x-webhook-secret'] !== process.env.PUSH_WEBHOOK_SECRET) return response(401, 'Non autorizzato');
  const required = ['VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'];
  if (required.some(name => !process.env[name])) return response(503, 'Configurazione incompleta');

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return response(400, 'JSON non valido'); }
  const record = payload.record || {};
  const old = payload.old_record || {};
  const recipient = recipientFor(payload.type, record, old);
  if (!recipient) return response(200, 'Nessuna notifica necessaria');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{ persistSession:false } });
  const { data, error } = await supabase.from('push_subscriptions').select('endpoint,p256dh,auth').eq('member_slug', recipient.slug);
  if (error) return response(500, error.message);

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@fptcards.it', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const message = JSON.stringify({ title:'F.P.T Cards', body:recipient.body, tag:`loan-${record.id || 'update'}`, url:'/' });
  const expired = [];
  await Promise.all((data || []).map(async item => {
    try { await webpush.sendNotification({ endpoint:item.endpoint, keys:{ p256dh:item.p256dh, auth:item.auth } }, message); }
    catch (error) { if ([404,410].includes(error.statusCode)) expired.push(item.endpoint); }
  }));
  if (expired.length) await supabase.from('push_subscriptions').delete().in('endpoint', expired);
  return response(200, `Notifiche inviate: ${(data || []).length}`);
};

function recipientFor(type, record, old) {
  if (type === 'INSERT' && record.status === 'pending') return { slug:record.borrower_slug, body:`${record.owner_slug} ti ha prestato ${record.quantity}× ${record.card_name}` };
  if (type === 'UPDATE' && record.status === 'return_pending' && old.status !== 'return_pending') return { slug:record.owner_slug, body:`${record.borrower_slug} ha segnalato la restituzione di ${record.card_name}` };
  return null;
}
function response(statusCode, body) { return { statusCode, headers:{ 'content-type':'application/json' }, body:JSON.stringify({ message:body }) }; }
