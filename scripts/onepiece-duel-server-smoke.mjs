// Entirely synthetic multiplayer tests: no database, account or push provider.
import assert from 'node:assert/strict';
import { createDuelService, DuelError, redactState } from '../api/_onepiece-duel-service.js';
import { createDuelHandler, sendInvitePush } from '../api/onepiece-duel.js';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const team = '10000000-0000-4000-8000-000000000001';
const otherTeam = '10000000-0000-4000-8000-000000000002';
const host = { slug:'duel-host', name:'Test host', teamId:team };
const guest = { slug:'duel-guest', name:'Test guest', teamId:team };
const stranger = { slug:'duel-third', name:'Test third', teamId:team };
const outsider = { slug:'duel-other-team', name:'Other team', teamId:otherTeam };
const id = index => `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const fixtureDeck = (owner, index) => ({ id:id(index), ownerSlug:owner.slug, game:'onepiece', name:`${owner.name} deck`, cards:[
  { section:'leader', catalogCardId:'OP01-001', cardName:'Test Leader', quantity:1, type:'Leader', colors:['Red'], power:5000 },
  ...Array.from({ length:13 }, (_, i) => ({ section:'main', catalogCardId:`OP01-${String(10 + i).padStart(3, '0')}`, cardName:`Secret ${owner.slug} ${i}`, quantity:i === 12 ? 2 : 4, type:'Character', colors:['Red'], power:3000 }))
] });
const decks = [fixtureDeck(host, 1), fixtureDeck(guest, 2)];
const records = new Map();
const actors = [host, guest, stranger, outsider];
const pushed = [];
let clock = new Date('2026-11-09T20:00:00.000Z');
let overrideCount = null;
let fullReads = 0, metaReads = 0;
const store = {
  members:async teamId => actors.filter(actor => actor.teamId === teamId).map(({ slug, name }) => ({ slug, name })),
  pushMembers:async () => [guest.slug],
  list:async (teamId, slug) => [...records.values()].filter(row => row.team_id === teamId && [row.host_slug, row.guest_slug].includes(slug)).map(clone),
  meta:async key => {
    metaReads++;
    const row = records.get(key);
    return row ? Object.fromEntries(['id', 'team_id', 'host_slug', 'guest_slug', 'status', 'version', 'ready', 'expires_at', 'created_at', 'updated_at', 'first_player'].map(field => [field, clone(row[field])])) : null;
  },
  get:async key => { fullReads++; return clone(records.get(key) || null); },
  deck:async (key, ownerSlug) => clone(decks.find(deck => deck.id === key && deck.ownerSlug === ownerSlug) || null),
  recentCount:async (slug, since) => overrideCount ?? [...records.values()].filter(row => row.host_slug === slug && row.created_at >= since).length,
  insert:async row => { if (records.has(row.id)) return null; records.set(row.id, clone(row)); return clone(row); },
  update:async (key, version, patch) => { const row = records.get(key); if (!row || row.version !== version) return null; const updated = { ...row, ...clone(patch) }; records.set(key, updated); return clone(updated); }
};
const service = createDuelService({ store, now:() => clock, notify:async invitation => { pushed.push(invitation); return { push:'sent' }; } });
const run = (actor, payload) => service.run(actor, payload);
const rejects = async (actor, payload, status, code) => {
  await assert.rejects(() => run(actor, payload), error => error instanceof DuelError && error.status === status && (!code || error.code === code));
};

const lobby = await run(host, { op:'lobby' });
assert.equal(lobby.members.length, 3);
assert.equal(lobby.members.find(member => member.slug === guest.slug).pushEnabled, true);
assert(!JSON.stringify(lobby).includes('endpoint'));
assert(!JSON.stringify(lobby).includes(outsider.slug));
await rejects({}, { op:'lobby' }, 401);
await rejects(host, { op:'invite', requestId:id(10), opponentSlug:outsider.slug, deckId:id(1), lifeCount:5, firstPlayer:0 }, 400, 'invalid_opponent');
await rejects(host, { op:'invite', requestId:id(10), opponentSlug:guest.slug, deckId:id(2), lifeCount:5, firstPlayer:0 }, 404, 'deck_not_found');
const invitation = { op:'invite', requestId:id(10), opponentSlug:guest.slug, deckId:id(1), lifeCount:5, firstPlayer:0 };
let created = await run(host, invitation);
assert.equal(created.duel.status, 'waiting');
assert.equal(created.duel.hostDeckName, decks[0].name);
assert.equal(created.notification.push, 'sent');
assert.equal(pushed.length, 1);
assert.equal((await run(host, invitation)).replayed, true);
assert.equal(pushed.length, 1, 'An invitation retry must never duplicate the push');
await rejects(host, { ...invitation, requestId:id(11) }, 409, 'already_invited');
await rejects(stranger, { op:'state', duelId:id(10) }, 404);
await rejects(outsider, { op:'state', duelId:id(10) }, 404);
assert.equal((await run(guest, { op:'lobby' })).duels.length, 1);
await rejects(host, { op:'accept', duelId:id(10), requestId:id(20), expectedVersion:1, deckId:id(1), lifeCount:5 }, 403);
const accepted = await run(guest, { op:'accept', duelId:id(10), requestId:id(20), expectedVersion:1, deckId:id(2), lifeCount:4 });
assert.equal(accepted.duel.status, 'setup');
assert.equal(accepted.duel.viewer, 1);
assert.equal(accepted.duel.version, 2);
assert.equal(accepted.duel.state.players[1].hand.length, 5);
assert(accepted.duel.state.players[1].hand.every(card => card.cardName.startsWith('Secret duel-guest')));
assert(accepted.duel.state.players[0].hand.every(card => card.hidden));
assert(!accepted.duel.state.players[0].deckId);
assert(accepted.duel.state.players.every(player => player.deck.every(card => card.hidden)));
assert.equal(records.get(id(10)).host_deck, null);
assert(!JSON.stringify(accepted).includes('host_deck'));
const hostSetup = (await run(host, { op:'state', duelId:id(10) })).duel;
assert(hostSetup.state.players[0].hand.every(card => !card.hidden));
assert(hostSetup.state.players[1].hand.every(card => card.hidden));
await rejects(guest, { op:'inspect', duelId:id(10), zone:'deck' }, 409, 'not_started');
await rejects(host, { op:'action', duelId:id(10), expectedVersion:2, requestId:id(21), action:{ type:'start' } }, 400);
let ready = await run(host, { op:'action', duelId:id(10), expectedVersion:2, requestId:id(22), action:{ type:'ready' } });
assert.deepEqual(ready.duel.ready, [true, false]);
assert.equal(ready.duel.state.phase, 'setup');
await rejects(host, { op:'action', duelId:id(10), expectedVersion:3, requestId:id(23), action:{ type:'mulligan', player:0 } }, 409, 'already_ready');
const mulligan = await run(guest, { op:'action', duelId:id(10), expectedVersion:3, requestId:id(24), action:{ type:'mulligan', player:1 } });
assert(mulligan.duel.state.players[1].mulliganUsed);
ready = await run(guest, { op:'action', duelId:id(10), expectedVersion:4, requestId:id(25), action:{ type:'ready' } });
assert.equal(ready.duel.status, 'playing');
assert.equal(ready.duel.state.phase, 'refresh');
assert.deepEqual(ready.duel.state.players.map(player => player.life.length), [5, 4]);
assert(ready.duel.state.players.every(player => player.life.every(card => card.hidden)));
let previousFullReads = fullReads, previousMetaReads = metaReads;
assert.deepEqual(await run(host, { op:'state', duelId:id(10), knownVersion:5 }), { unchanged:true, duelId:id(10), version:5 });
assert.equal(metaReads, previousMetaReads + 1);
assert.equal(fullReads, previousFullReads, 'Same-version polling must not read the full private state');
await rejects(stranger, { op:'state', duelId:id(10), knownVersion:5 }, 404);
await rejects(outsider, { op:'state', duelId:id(10), knownVersion:5 }, 404);
assert.equal(fullReads, previousFullReads, 'A correct version never authorizes a non-participant');
const missingGuest = actors.splice(actors.indexOf(guest), 1)[0];
await rejects(host, { op:'state', duelId:id(10), knownVersion:5 }, 403, 'membership_changed');
actors.push(missingGuest);
assert.equal(fullReads, previousFullReads, 'Unchanged polling must recheck current membership before reading private state');
const changedPoll = await run(guest, { op:'state', duelId:id(10), knownVersion:4 });
assert.equal(changedPoll.duel.version, 5);
assert(changedPoll.duel.state.players[0].hand.every(card => card.hidden));
assert(changedPoll.duel.state.players.every(player => player.deck.every(card => card.hidden)));
assert.equal(fullReads, previousFullReads + 1, 'A stale version must return the current redacted state');
previousMetaReads = metaReads;
for (const knownVersion of [0, -1, 1.5, '5', null, Number.MAX_SAFE_INTEGER + 1]) await rejects(host, { op:'state', duelId:id(10), knownVersion }, 400, 'invalid_version');
assert.equal(metaReads, previousMetaReads, 'Invalid versions must be rejected before database reads');
await rejects(guest, { op:'inspect', duelId:id(10), zone:'deck', player:0 }, 403);
const inspected = await run(guest, { op:'inspect', duelId:id(10), zone:'deck' });
assert.equal(inspected.cards.length, 41);
assert(inspected.cards.every(card => card.cardName.startsWith('Secret duel-guest')));
assert(inspected.duel.state.players[0].hand.every(card => card.hidden));
await rejects(guest, { op:'action', duelId:id(10), expectedVersion:5, requestId:id(26), action:{ type:'nextTurn' } }, 403, 'not_your_turn');
await rejects(guest, { op:'action', duelId:id(10), expectedVersion:5, requestId:id(27), action:{ type:'draw', player:0 } }, 403, 'opponent_action');
const draw = { op:'action', duelId:id(10), expectedVersion:5, requestId:id(28), action:{ type:'draw', player:0, count:1 } };
const drawn = await run(host, draw);
assert.equal(drawn.duel.state.players[0].hand.length, 6);
assert.equal((await run(host, draw)).replayed, true);
assert.equal(records.get(id(10)).state.players[0].hand.length, 6);
try { await run(guest, { op:'action', duelId:id(10), expectedVersion:5, requestId:id(29), action:{ type:'draw', player:1 } }); assert.fail('stale action accepted'); }
catch (error) { assert.equal(error.status, 409); assert(error.duel.state.players[0].hand.every(card => card.hidden)); }
await rejects(guest, { op:'action', duelId:id(10), expectedVersion:6, requestId:id(30), action:{ type:'move', player:1, cardId:'hidden-0-life-0', to:'hand' } }, 403);
const lifeTaken = await run(guest, { op:'action', duelId:id(10), expectedVersion:6, requestId:id(31), action:{ type:'takeLife', player:1 } });
assert.equal(lifeTaken.duel.state.players[1].life.length, 3);
assert.equal(lifeTaken.duel.state.players[1].hand.length, 6);
assert(lifeTaken.duel.state.log.at(-1).text.includes('una carta'));
const lifeRevealed = await run(guest, { op:'action', duelId:id(10), expectedVersion:7, requestId:id(32), action:{ type:'toggleFaceUp', player:1, cardId:'hidden-1-life-0' } });
assert(lifeRevealed.duel.state.players[1].life[0].faceUp);
const hostView = (await run(host, { op:'state', duelId:id(10) })).duel;
assert(hostView.state.players[1].life[0].faceUp);
assert(hostView.state.players[1].life.slice(1).every(card => card.hidden));
const handCard = hostView.state.players[0].hand[0];
const played = await run(host, { op:'action', duelId:id(10), expectedVersion:8, requestId:id(33), action:{ type:'move', player:0, cardId:handCard.id, to:'characters' } });
assert.equal(played.duel.state.players[0].characters[0].cardName, handCard.cardName);
const opponentView = (await run(guest, { op:'state', duelId:id(10) })).duel;
assert.equal(opponentView.state.players[0].characters[0].cardName, handCard.cardName);
assert(opponentView.state.players[0].hand.every(card => card.hidden));
const finished = await run(host, { op:'action', duelId:id(10), expectedVersion:9, requestId:id(34), action:{ type:'finish', winner:0, notes:'Synthetic manual test' } });
assert.equal(finished.duel.status, 'finished');
assert.equal(finished.duel.result.winner, 0);
assert.equal((await run(host, { op:'lobby' })).duels[0].result.notes, 'Synthetic manual test');
await rejects(guest, { op:'action', duelId:id(10), expectedVersion:10, requestId:id(35), action:{ type:'draw', player:1 } }, 409, 'not_playing');
overrideCount = 5;
await rejects(host, { ...invitation, requestId:id(40) }, 429, 'rate_limit');
overrideCount = null;
const expiring = await run(host, { ...invitation, requestId:id(41) });
clock = new Date(clock.getTime() + 86400001);
await rejects(guest, { op:'state', duelId:expiring.duel.id }, 410, 'expired');
previousFullReads = fullReads;
await rejects(guest, { op:'state', duelId:expiring.duel.id, knownVersion:1 }, 410, 'expired');
assert.equal(fullReads, previousFullReads, 'Expired same-version polling must fail before a full-state read');
assert.equal((await run(guest, { op:'lobby' })).duels.length, 1, 'Only the concluded test remains after invitation expiry');
assert.equal(redactState(null, 0), null);
console.log('PASS private invitations, push idempotency, own saved decks and participant/team isolation');
console.log('PASS two players, shared manual actions, ready/mulligan, CAS conflicts and replayed actions');
console.log('PASS server-only hands/decks/Life, own inspections, public face-up Life, manual results and expiry');
console.log('PASS lightweight version polling preserves participant/membership checks, redaction and expiry without full-state reads');

// HTTP boundaries, authentication and safe errors without real Supabase clients.
const env = { SUPABASE_URL:'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY:'synthetic-not-a-key' };
const handler = createDuelHandler({ env, databaseFactory:() => ({ authenticate:async token => { if (token !== 'synthetic-token') throw new Error('private raw database error'); return host; }, store }), notify:async () => ({ push:'disabled' }) });
const call = async (body, options = {}) => {
  const res = { headers:{}, statusCode:200, body:null, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method:options.method || 'POST', headers:{ host:'localhost', 'content-type':'application/json', ...options.headers }, body }, res);
  return res;
};
let response = await call({ op:'lobby', token:'synthetic-token' });
assert.equal(response.statusCode, 200);
assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0');
response = await call({ op:'lobby', token:'invalid' });
assert.equal(response.statusCode, 401);
assert(!JSON.stringify(response.body).includes('private raw database error'));
assert.equal((await call({}, { method:'GET' })).statusCode, 405);
assert.equal((await call('{invalid')).statusCode, 400);
assert.equal((await call({ op:'lobby' }, { headers:{ origin:'https://attacker.invalid' } })).statusCode, 403);
assert.equal((await call({ op:'lobby' }, { headers:{ authorization:'bad-token' } })).statusCode, 401);
assert.equal((await call(' '.repeat(16001))).statusCode, 413);
console.log('PASS HTTP authentication, same origin, payload bounds, no-store and controlled error messages');

const notifications = [], deleted = [];
const pushDatabase = { subscriptions:async () => [{ endpoint:'https://push.synthetic.invalid/good', p256dh:'key', auth:'auth' }, { endpoint:'https://push.synthetic.invalid/expired', p256dh:'key', auth:'auth' }], removeExpired:async values => deleted.push(...values) };
const fakePush = { setVapidDetails() {}, async sendNotification(subscription, message) { if (subscription.endpoint.endsWith('expired')) throw { statusCode:410 }; notifications.push(JSON.parse(message)); } };
const sent = await sendInvitePush(pushDatabase, { id:id(10), recipient:guest.slug, senderName:host.name }, { VAPID_PUBLIC_KEY:'synthetic', VAPID_PRIVATE_KEY:'synthetic' }, fakePush);
assert.deepEqual(sent, { push:'sent', subscriptionsAccepted:1 });
assert.equal(notifications[0].url, `/#/simulator?duel=${id(10)}`);
assert.deepEqual(deleted, ['https://push.synthetic.invalid/expired']);
assert.equal((await sendInvitePush({ subscriptions:async () => [] }, {}, env, fakePush)).push, 'disabled');
assert.equal((await sendInvitePush(pushDatabase, {}, env, fakePush)).push, 'unavailable');
console.log('PASS synthetic push payload, exact invite deep link, disabled notifications and expired subscription cleanup');
console.log('onepiece-duel-server-smoke: OK (no external requests or real notifications)');
