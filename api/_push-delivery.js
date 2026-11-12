import webpush from 'web-push';

// Push service acceptance is not proof of handset display. Never log endpoints/keys.
export async function deliverPush(db, recipient, message, { env = process.env, transport = webpush } = {}) {
  try { transport.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@fptcards.it', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY); }
  catch { return { status:503, code:'vapid_configuration', accepted:0 }; }
  const { data, error } = await db.rpc('push_delivery_subscriptions', { p_member_slug:recipient });
  if (error) return { status:500, code:'subscription_lookup_failed', accepted:0 };
  const rows = data || [];
  const result = { status:200, code:'no_subscriptions', subscriptions:rows.length, accepted:0, expired:0, failed:0, errors:[] };
  await Promise.all(rows.map(async item => {
    try {
      const endpoint = new URL(item.endpoint);
      if (endpoint.protocol !== 'https:' || endpoint.port || !/(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/.test(endpoint.hostname)) {
        result.failed++; result.errors.push('invalid_endpoint'); return;
      }
      await transport.sendNotification({ endpoint:item.endpoint, keys:{ p256dh:item.p256dh, auth:item.auth } }, JSON.stringify(message), { TTL:3600, urgency:'normal', timeout:10000 });
      result.accepted++;
    } catch (error) {
      if ([404,410].includes(error.statusCode)) {
        result.expired++;
        const removed = await db.from('push_subscriptions').delete().eq('endpoint', item.endpoint).eq('p256dh', item.p256dh).eq('auth', item.auth);
        if (removed.error) result.errors.push('cleanup_failed');
      } else {
        result.failed++;
        result.errors.push([401,403].includes(error.statusCode) ? 'vapid_rejected' : error.statusCode === 429 ? 'push_rate_limited' : error.statusCode ? 'push_service_error' : 'network_error');
      }
    }
  }));
  result.errors = [...new Set(result.errors)];
  result.code = result.failed ? (result.accepted ? 'partially_accepted' : result.errors[0]) : result.accepted ? 'push_service_accepted' : result.expired ? 'subscriptions_expired' : 'no_subscriptions';
  result.status = result.failed ? 502 : result.accepted ? 200 : result.expired ? 410 : 409;
  result.ok = result.accepted > 0 && result.failed === 0;
  return result;
}

export function notificationMessage(record) {
  const page = /^[a-z][a-z0-9-]*$/.test(record.route_page || '') ? record.route_page : 'home';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(record.route_params || {})) if (['string','number','boolean'].includes(typeof value)) params.set(key, String(value));
  return { title:record.title || 'F.P.T. Cards', body:record.body || '', tag:`notif-${record.id}`, url:`/#/${page}${params.size ? '?' + params : ''}`, member:record.member_slug };
}

export function loanRecipient(type, record, old = {}) {
  const base = { url:`/#/loans?loanId=${encodeURIComponent(record.id)}&game=${record.game === 'onepiece' ? 'onepiece' : 'yugioh'}`, tag:`loan-${record.id}-${record.status}` };
  const owner = record.owner_name || record.owner_slug, borrower = record.borrower_name || record.borrower_slug;
  if (type === 'INSERT' && record.status === 'requested') return { ...base, member:record.owner_slug, title:'Nuova richiesta di prestito', body:record.pre_agreed ? `${borrower} conferma il prestito già concordato di ${record.requested_quantity || record.quantity}× ${record.card_name}.` : `${borrower} ti richiede ${record.requested_quantity || record.quantity}× ${record.card_name}.` };
  if (type === 'INSERT' && record.status === 'pending') return { ...base, member:record.borrower_slug, title:'Nuovo prestito', body:`${owner} ti ha prestato ${record.quantity}× ${record.card_name}.` };
  if (type !== 'UPDATE' || old.status === record.status) return null;
  if (old.status === 'requested' && ['reserved','active','pending'].includes(record.status)) return { ...base, member:record.borrower_slug, title:'Prestito approvato', body:`${owner} ha accettato la tua richiesta per ${record.card_name}.` };
  if (record.status === 'rejected') return { ...base, member:record.borrower_slug, title:'Richiesta rifiutata', body:`${owner} ha rifiutato la richiesta per ${record.card_name}.` };
  if (record.status === 'return_pending') return { ...base, member:record.owner_slug, title:'Restituzione da confermare', body:`${borrower} ha segnalato la restituzione di ${record.card_name}.` };
  return null;
}
