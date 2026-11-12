import { createClient } from '@supabase/supabase-js';
import { webhookAuthorized } from './_webhook-auth.js';
import { deliverPush, loanRecipient, notificationMessage } from './_push-delivery.js';

export function createPushHandler({ notificationsOnly = false, clientFactory = createClient, deliver = deliverPush } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ code:'method_not_allowed' });
    if (!webhookAuthorized(req)) return res.status(401).json({ code:'webhook_unauthorized' });
    if (['VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'].some(key => !process.env[key])) return res.status(503).json({ code:'configuration_missing' });
    try {
      let payload;
      try { payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; }
      catch { return res.status(400).json({ code:'invalid_payload' }); }
      const record = payload.record || {};
      if (notificationsOnly && payload.type !== 'INSERT') return res.status(200).json({ message:'Solo INSERT gestito', code:'ignored' });
      let message = record.category || notificationsOnly ? (payload.type === 'INSERT' && record.member_slug && record.title && record.id ? notificationMessage(record) : null) : loanRecipient(payload.type, record, payload.old_record);
      if (!message?.member) return res.status(200).json({ code:'ignored', message:'Nessuna notifica necessaria' });
      if (!record.id) return res.status(400).json({ code:'invalid_payload' });
      const db = clientFactory(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{ persistSession:false } });
      if (!record.category && !notificationsOnly) {
        const { data } = await db.from('team_members').select('slug,full_name').in('slug', [record.owner_slug, record.borrower_slug]);
        const names = new Map((data || []).map(item => [item.slug,item.full_name]));
        message = loanRecipient(payload.type, { ...record, owner_name:names.get(record.owner_slug), borrower_name:names.get(record.borrower_slug) }, payload.old_record);
      }
      const result = await deliver(db, message.member, message);
      return res.status(result.status).json(result);
    } catch { return res.status(500).json({ code:'internal_error', accepted:0 }); }
  };
}
export default createPushHandler();
