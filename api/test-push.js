import { createClient } from '@supabase/supabase-js';
import { deliverPush } from './_push-delivery.js';

export function createTestHandler({ clientFactory = createClient, deliver = deliverPush } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ code:'method_not_allowed' });
    if (['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY'].some(key => !process.env[key])) return res.status(503).json({ code:'configuration_missing' });
    try {
      const { token, endpoint } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      if (typeof token !== 'string' || token.length > 512 || typeof endpoint !== 'string' || endpoint.length > 2000) return res.status(400).json({ code:'invalid_request' });
      const db = clientFactory(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{ persistSession:false } });
      // Atomic, persisted rate limit and ownership check, across serverless instances.
      const { data, error } = await db.rpc('claim_push_test', { p_token:token, p_endpoint:endpoint });
      if (error) return res.status(500).json({ code:'internal_error' });
      if (!data?.member) return res.status(data?.code === 'rate_limited' ? 429 : 401).json({ code:data?.code || 'unauthorized' });
      const scoped = { from:(...args) => db.from(...args), rpc:async () => ({ data:[data.subscription], error:null }) };
      const result = await deliver(scoped, data.member, { title:'F.P.T. Cards · Notifica di prova', body:'Il servizio push ha ricevuto la prova per questo dispositivo.', tag:'fpt-push-test', url:'/#/settings', member:data.member });
      return res.status(result.status).json(result);
    } catch { return res.status(500).json({ code:'internal_error' }); }
  };
}
export default createTestHandler();
