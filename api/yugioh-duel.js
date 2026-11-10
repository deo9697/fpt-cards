import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import { createDuelService, DuelError } from './_yugioh-duel-service.js';

const unwrap = result => { if (result.error) throw result.error; return result.data; };
const clientOptions = { auth:{ persistSession:false, autoRefreshToken:false } };
const cardMetadataCache = new Map();

// Deck rows store identities and images. Resolve game data through the same
// public catalogue used by FPT, only after the saved deck's owner is verified.
export async function lookupYugiohMetadata(ids, fetchImpl = globalThis.fetch) {
  const codes = [...new Set(ids.map(String).filter(code => /^\d{5,10}$/.test(code)))].slice(0, 90);
  const result = new Map(), missing = [];
  for (const code of codes) {
    const cached = cardMetadataCache.get(code);
    if (fetchImpl === globalThis.fetch && cached && cached.until > Date.now()) result.set(code, cached.card);
    else missing.push(code);
  }
  await Promise.all(Array.from({ length:Math.ceil(missing.length / 40) }, async (_, index) => {
    const chunk = missing.slice(index * 40, index * 40 + 40);
    try {
      const response = await fetchImpl(`https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${chunk.join(',')}`, { signal:AbortSignal.timeout(6000) });
      if (!response.ok) return;
      const payload = await response.json();
      for (const card of Array.isArray(payload.data) ? payload.data : []) {
        const code = String(card.id);
        if (!chunk.includes(code)) continue;
        result.set(code, card);
        if (fetchImpl === globalThis.fetch) cardMetadataCache.set(code, { card, until:Date.now() + 21600000 });
      }
    } catch { /* The manual table still works if optional metadata is offline. */ }
  }));
  while (cardMetadataCache.size > 2000) cardMetadataCache.delete(cardMetadataCache.keys().next().value);
  return result;
}

export function createDatabase(env, authorization) {
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, clientOptions);
  // The caller's JWT is used only to resolve their identity. All private table
  // reads use the server client after participant/team authorization.
  const identity = authorization ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { ...clientOptions, global:{ headers:{ Authorization:authorization } } }) : admin;
  return {
    // This existing resolver authorizes current team membership for both games.
    async authenticate(token) { return unwrap(await identity.rpc('onepiece_duel_identity', { p_token:token || null })); },
    store: {
      async members(teamId) {
        const rows = unwrap(await admin.from('team_members').select('slug,full_name').eq('team_id', teamId).eq('active', true));
        return (rows || []).map(row => ({ slug:row.slug, name:row.full_name }));
      },
      async pushMembers(slugs) {
        if (!slugs.length) return [];
        const result = await admin.from('push_subscriptions').select('member_slug').in('member_slug', slugs).limit(1000);
        if (result.error) return [];
        return [...new Set((result.data || []).map(row => row.member_slug))];
      },
      async list(teamId, slug) {
        // Polling the lobby reads summaries, never every finished hand/deck.
        const columns = 'id,team_id,host_slug,guest_slug,status,version,ready,first_player,created_at,updated_at,expires_at,host_deck_name:host_deck->>name,host_state_deck_name:state->players->0->>deckName,guest_state_deck_name:state->players->1->>deckName,result:state->result';
        return unwrap(await admin.from('yugioh_duels').select(columns).eq('team_id', teamId).or(`host_slug.eq.${slug},guest_slug.eq.${slug}`).order('updated_at', { ascending:false }).limit(100)) || [];
      },
      async meta(id) {
        return unwrap(await admin.from('yugioh_duels').select('id,team_id,host_slug,guest_slug,status,version,ready,expires_at,created_at,updated_at,first_player').eq('id', id).maybeSingle());
      },
      async get(id) { return unwrap(await admin.from('yugioh_duels').select('*').eq('id', id).maybeSingle()); },
      async deck(id, ownerSlug) {
        const row = unwrap(await admin.from('decks').select('id,owner_slug,game,name').eq('id', id).eq('owner_slug', ownerSlug).eq('game', 'yugioh').maybeSingle());
        if (!row) return null;
        const cards = unwrap(await admin.from('deck_cards').select('catalog_card_id,card_name,image_url,section,quantity,printing_id,position,ban_tcg').eq('deck_id', id).order('position')) || [];
        const codes = [...new Set(cards.map(card => card.catalog_card_id))];
        let metadata = [];
        if (codes.length) metadata = unwrap(await admin.from('card_printings').select('id,catalog_card_id,game_metadata').eq('game', 'yugioh').in('catalog_card_id', codes).limit(1000)) || [];
        const publicMetadata = await lookupYugiohMetadata(codes.filter(code => !metadata.some(item => item.catalog_card_id === code && (item.game_metadata?.cardType || item.game_metadata?.type))));
        return { id:row.id, ownerSlug:row.owner_slug, game:row.game, name:row.name, cards:cards.map(card => {
          const found = metadata.find(item => item.id === card.printing_id) || metadata.find(item => item.catalog_card_id === card.catalog_card_id);
          const info = { ...(publicMetadata.get(card.catalog_card_id) || {}), ...(found?.game_metadata || {}) };
          return { catalogCardId:card.catalog_card_id, cardName:card.card_name, imageUrl:card.image_url, printingId:card.printing_id || '', section:card.section, quantity:card.quantity, banTcg:card.ban_tcg || '', type:info.cardType || info.type || '', atk:info.atk ?? null, def:info.def ?? null, text:info.effect || info.desc || '', attribute:info.attribute || '', level:info.level ?? null };
        }) };
      },
      async recentCount(hostSlug, since) {
        const result = await admin.from('yugioh_duels').select('id', { count:'exact', head:true }).eq('host_slug', hostSlug).gte('created_at', since);
        if (result.error) throw result.error;
        return result.count || 0;
      },
      async insert(row) {
        // The service-only RPC locks per host before checking pending pairs and
        // rate limits, so concurrent distinct request IDs cannot duplicate pushes.
        const result = await admin.rpc('yugioh_duel_insert_invite', { p_invite:row });
        if (result.error?.code === 'P1001') throw new DuelError(409, 'already_invited', 'Hai già un invito in attesa per questo membro.');
        if (result.error?.code === 'P1002') throw new DuelError(429, 'rate_limit', 'Hai inviato diversi inviti. Attendi un minuto.');
        if (result.error?.code === '23505') return null;
        return unwrap(result);
      },
      async update(id, version, patch) {
        return unwrap(await admin.from('yugioh_duels').update(patch).eq('id', id).eq('version', version).select('*').maybeSingle());
      }
    },
    async subscriptions(slug) { return unwrap(await admin.from('push_subscriptions').select('endpoint,p256dh,auth').eq('member_slug', slug).limit(20)) || []; },
    async removeExpired(endpoints) { if (endpoints.length) await admin.from('push_subscriptions').delete().in('endpoint', endpoints); }
  };
}

export async function sendInvitePush(database, invitation, env, push = webpush) {
  let subscriptions;
  try { subscriptions = await database.subscriptions(invitation.recipient); } catch { return { push:'unavailable' }; }
  if (!subscriptions.length) return { push:'disabled' };
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { push:'unavailable' };
  push.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@fptcards.it', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const message = JSON.stringify({ title:'Sfida Yu-Gi-Oh!', body:`${invitation.senderName} ti invita a un duello manuale privato del team.`, tag:`yugioh-duel-${invitation.id}`, url:`/#/simulator?game=yugioh&duel=${encodeURIComponent(invitation.id)}` });
  const expired = [];
  let sent = 0;
  await Promise.all(subscriptions.map(async subscription => {
    try {
      await push.sendNotification({ endpoint:subscription.endpoint, keys:{ p256dh:subscription.p256dh, auth:subscription.auth } }, message, { TTL:300, timeout:5000 });
      sent++;
    } catch (error) { if ([404, 410].includes(error.statusCode)) expired.push(subscription.endpoint); }
  }));
  try { await database.removeExpired(expired); } catch { /* The invite already exists; cleanup is best effort. */ }
  return { push:sent ? 'sent' : 'failed', subscriptionsAccepted:sent };
}

export function createDuelHandler({ env = process.env, databaseFactory = createDatabase, notify = sendInvitePush } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ code:'method_not_allowed', message:'Metodo non consentito.' }); }
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ code:'not_configured', message:'Il simulatore multiplayer non è ancora configurato.' });
    try {
      const origin = req.headers?.origin;
      const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
      let sameOrigin = false;
      try { sameOrigin = Boolean(host && new URL(origin).host === host); } catch { /* Invalid origins are denied below. */ }
      if (origin && !sameOrigin) throw new DuelError(403, 'invalid_origin', 'Origine della richiesta non consentita.');
      const contentType = req.headers?.['content-type'];
      if (contentType && !contentType.toLowerCase().startsWith('application/json')) throw new DuelError(415, 'invalid_content_type', 'Invia la richiesta in formato JSON.');
      let body = req.body;
      if (typeof body === 'string') { if (Buffer.byteLength(body) > 16000) throw new DuelError(413, 'too_large', 'Richiesta troppo grande.'); try { body = JSON.parse(body); } catch { throw new DuelError(400, 'invalid_json', 'Richiesta non valida.'); } }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 16000) throw new DuelError(400, 'invalid_body', 'Richiesta non valida.');
      if (body.token !== undefined && body.token !== null && (typeof body.token !== 'string' || body.token.length > 256)) throw new DuelError(401, 'unauthorized', 'Accedi con il tuo profilo del team.');
      const authorization = req.headers?.authorization;
      if (authorization && (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization) || authorization.length > 8000)) throw new DuelError(401, 'unauthorized', 'Sessione non valida.');
      const database = databaseFactory(env, authorization);
      let actor;
      try { actor = await database.authenticate(body.token); }
      catch (error) {
        if (['PGRST202', '42883', '42P01'].includes(error?.code)) throw new DuelError(503, 'not_configured', 'Il simulatore multiplayer non è ancora configurato.');
        throw new DuelError(401, 'unauthorized', 'Accedi con il tuo profilo del team.');
      }
      // Restrict slug syntax before composing the participant filter in PostgREST.
      if (!actor?.slug || !/^[a-z0-9_-]{1,100}$/i.test(actor.slug)) throw new DuelError(401, 'unauthorized', 'Profilo del team non valido.');
      const service = createDuelService({ store:database.store, notify:invitation => notify(database, invitation, env) });
      return res.status(200).json(await service.run(actor, body));
    } catch (error) {
      if (error instanceof DuelError) return res.status(error.status).json({ code:error.code, message:error.message, ...(error.duel ? { duel:error.duel } : {}) });
      return res.status(503).json({ code:'service_unavailable', message:'Il tavolo non è disponibile al momento. Riprova tra poco.' });
    }
  };
}

export default createDuelHandler();
