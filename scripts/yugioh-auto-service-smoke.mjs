// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory service/HTTP verification. No account, database, push or live game.
import assert from 'node:assert/strict';
import { createDuelService, DuelError, redactState } from '../api/_yugioh-duel-service.js';
import { projectAutoStateSafe } from '../api/_yugioh-auto-executor.js';
import { createDatabase, createDuelHandler } from '../api/yugioh-duel.js';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const id = index => `a0700000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const team = id(1), otherTeam = id(2);
const host = { slug:'auto-host', name:'Host', teamId:team };
const guest = { slug:'auto-guest', name:'Guest', teamId:team };
const third = { slug:'auto-third', name:'Third', teamId:team };
const outsider = { slug:'outsider', name:'Outside', teamId:otherTeam };
let members = [host, guest, third, outsider];
const decks = [host, guest].map((owner, player) => ({
  id:id(10 + player), ownerSlug:owner.slug, game:'yugioh', name:`${owner.name} saved deck`,
  cards:Array.from({ length:14 }, (_, index) => ({ section:'main', catalogCardId:String(10000000 + index), cardName:`Fixture ${index}`, quantity:index === 13 ? 1 : 3, type:'Effect Monster', level:4, atk:1800, def:1000 }))
}));
const rows = new Map(), notifications = [], calls = [], deckModes = [];
let clock = new Date('2026-11-17T09:00:00Z'), forceConflict = false;
const store = {
  members:async teamId => members.filter(actor => actor.teamId === teamId).map(({ slug, name }) => ({ slug, name })),
  pushMembers:async () => [guest.slug],
  list:async (teamId, slug) => [...rows.values()].filter(row => row.team_id === teamId && [row.host_slug, row.guest_slug].includes(slug)).map(row => ({
    ...Object.fromEntries(['id','team_id','host_slug','guest_slug','status','version','ready','first_player','created_at','updated_at','expires_at'].map(key => [key, clone(row[key])])),
    state_mode:row.state?.mode, host_simulator_mode:row.host_deck?.simulatorMode,
    host_deck_name:row.host_deck?.name, host_auto_deck_name:row.state?.initialDecks?.[0]?.name,
    guest_auto_deck_name:row.state?.initialDecks?.[1]?.name, result:clone(row.state?.result)
  })),
  get:async key => clone(rows.get(key) || null),
  meta:async key => { const row = rows.get(key); return row ? Object.fromEntries(['id','team_id','host_slug','guest_slug','status','version','ready','expires_at'].map(field => [field, clone(row[field])])) : null; },
  deck:async (key, slug, options) => { deckModes.push(options?.mode); return clone(decks.find(deck => deck.id === key && deck.ownerSlug === slug) || null); },
  recentCount:async () => 0,
  insert:async row => { if (rows.has(row.id)) return null; rows.set(row.id, clone(row)); return clone(row); },
  update:async (key, version, patch) => {
    const current = rows.get(key);
    if (forceConflict) { forceConflict = false; rows.set(key, { ...current, version:current.version + 1 }); return null; }
    if (!current || current.version !== version) return null;
    const next = { ...current, ...clone(patch) }; rows.set(key, next); return clone(next);
  }
};

function publicView(viewer, sequence = 0) {
  return {
    mode:'auto', status:'playing', turn:1, phase:'main1', activePlayer:0, startingPlayer:0, result:null, chain:[], log:[],
    players:[0, 1].map(player => ({ name:player ? 'Guest' : 'Host', deckName:decks[player].name, deckId:player === viewer ? decks[player].id : '', lp:8000,
      deck:[{ id:`hidden-${player}-deck-0`, hidden:true }],
      hand:player === viewer ? [{ id:`own-${player}`, cardName:`Own hand ${player}` }] : [{ id:`hidden-${player}-hand-0`, hidden:true }],
      extra:[], side:[], monsters:[], spells:[], field:[], extraMonsters:[], graveyard:[], banished:[] })),
    auto:{ inputSequence:sequence, prompt:sequence % 2 === viewer ? { id:`prompt-${sequence}`, kind:'idle', choices:[{ id:'advance', label:'Avanti' }] } : null, waitingFor:sequence % 2, waitingPlayer:sequence % 2, actor:sequence % 2 }
  };
}
function engineError(status, code) { return Object.assign(new Error(`Synthetic ${code}`), { status, code }); }
const autoRuntime = {
  project:projectAutoStateSafe,
  async run(operation, payload) {
    calls.push({ operation, viewer:payload.viewer });
    if (operation === 'validate') {
      if (payload.deck.cards.some(card => card.catalogCardId === '999999999')) throw engineError(400, 'unsupported_card');
      return { valid:true, deckName:payload.deck.name };
    }
    if (operation === 'create') return {
      mode:'auto', seed:'PRIVATE_SEED', initialDecks:payload.decks.map(deck => ({ id:deck.id, name:deck.name, main:['PRIVATE_INITIAL_CARD'] })),
      names:payload.names, lp:payload.lp, firstPlayer:payload.firstPlayer,
      inputs:[{ secret:'PRIVATE_RESPONSE_TRANSCRIPT' }], pendingMessage:{ secret:'PRIVATE_ENGINE_PROMPT' }, pendingPromptId:'prompt-0',
      inputSequence:0, publicViews:[publicView(0), publicView(1)], result:null
    };
    const { state, viewer, promptId } = payload;
    if (state.publicViews?.[viewer]?.auto?.prompt?.id !== promptId) throw engineError(409, 'stale_prompt');
    if (operation === 'search') return Array.from({ length:45 }, (_, index) => ({ code:100 + index, name:`Public card ${index}` }));
    if (operation !== 'apply' || !['advance', 'finish', 'timeout'].includes(payload.choice?.id)) throw engineError(400, 'invalid_choice');
    if (payload.choice.id === 'timeout') throw engineError(503, 'auto_timeout');
    const next = clone(state), sequence = state.inputSequence + 1;
    next.inputSequence = sequence; next.pendingPromptId = `prompt-${sequence}`;
    next.inputs.push({ viewer, promptId, choice:clone(payload.choice) });
    next.publicViews = [publicView(0, sequence), publicView(1, sequence)];
    if (payload.choice.id === 'finish') {
      next.result = { winner:1, notes:'Automatic engine result' };
      for (const view of next.publicViews) { view.result = clone(next.result); view.status = 'finished'; view.auto.prompt = null; view.auto.waitingFor = null; }
    }
    return next;
  }
};
const service = createDuelService({ store, autoRuntime, now:() => clock, notify:async invitation => { notifications.push(invitation); return { push:'sent' }; } });
const run = (actor, payload) => service.run(actor, payload);
const rejects = (actor, payload, status, code) => assert.rejects(() => run(actor, payload), error => error instanceof DuelError && error.status === status && (!code || error.code === code));
let request = 100;
const command = (duelId, action, extra = {}) => ({ op:'action', duelId, expectedVersion:rows.get(duelId).version, requestId:id(++request), action, ...extra });
const invite = (duelId, mode = 'auto') => ({ op:'invite', requestId:duelId, opponentSlug:guest.slug, deckId:decks[0].id, firstPlayer:0, mode });
function privateDataAbsent(value) {
  const text = JSON.stringify(value);
  for (const secret of ['PRIVATE_SEED','PRIVATE_INITIAL_CARD','PRIVATE_RESPONSE_TRANSCRIPT','PRIVATE_ENGINE_PROMPT','initialDecks','pendingMessage','publicViews']) assert(!text.includes(secret), `Private automatic data leaked: ${secret}`);
}
async function setup(duelId) {
  await run(host, invite(duelId));
  return run(guest, { op:'accept', duelId, expectedVersion:1, requestId:id(++request), deckId:decks[1].id });
}
async function start(duelId) {
  await run(host, command(duelId, { type:'ready' }));
  return run(guest, command(duelId, { type:'ready' }));
}

const duelId = id(20);
await rejects(host, { ...invite(duelId), mode:'unknown' }, 400, 'invalid_mode');
const validationsBeforeUnauthorized = calls.filter(call => call.operation === 'validate').length;
await rejects(host, { ...invite(duelId), deckId:decks[1].id }, 404, 'deck_not_found');
assert.equal(calls.filter(call => call.operation === 'validate').length, validationsBeforeUnauthorized, 'A deck must be authorized before invoking its canonical validator');
const invalidHostDeck = clone(decks[0]); invalidHostDeck.id = id(12); invalidHostDeck.cards[0].catalogCardId = '999999999'; decks.push(invalidHostDeck);
await rejects(host, { ...invite(duelId), deckId:invalidHostDeck.id }, 400, 'unsupported_card');
assert.equal(rows.size, 0, 'Canonical validation must reject an invalid host deck before persisting an invitation');
assert.equal(notifications.length, 0);
// Deliberately stale saved display/banlist fields contradict the canonical
// fixture. Automatic mode must validate passcodes through its engine runtime.
decks[0].cards[0].type = 'Fusion Monster'; decks[0].cards[0].banTcg = 'Forbidden';
const invited = await run(host, invite(duelId));
assert.equal(invited.duel.mode, 'auto'); assert.equal(rows.get(duelId).host_deck.simulatorMode, 'auto');
assert.equal(notifications[0].mode, 'auto'); assert.equal(deckModes.at(-1), 'auto');
assert.equal((await run(host, invite(duelId))).replayed, true); assert.equal(notifications.length, 1);
assert.equal((await run(guest, { op:'lobby' })).duels[0].mode, 'auto');
await rejects(third, { op:'state', duelId }, 404, 'not_found');
await rejects(outsider, { op:'state', duelId, knownVersion:1 }, 404, 'not_found');
const invalidGuestDeck = clone(decks[1]); invalidGuestDeck.id = id(13); invalidGuestDeck.cards[0].catalogCardId = '999999999'; decks.push(invalidGuestDeck);
await rejects(guest, { op:'accept', duelId, expectedVersion:1, requestId:id(++request), deckId:invalidGuestDeck.id }, 400, 'unsupported_card');
assert.equal(rows.get(duelId).status, 'waiting'); assert.equal(rows.get(duelId).version, 1);
decks[1].cards[0].type = 'Fusion Monster'; decks[1].cards[0].banTcg = 'Forbidden';
const accepted = await run(guest, { op:'accept', duelId, expectedVersion:1, requestId:id(++request), deckId:decks[1].id, mode:'manual' });
assert.equal(accepted.duel.mode, 'auto', 'An accept payload cannot switch the host mode');
assert.equal(accepted.duel.status, 'setup'); assert.equal(accepted.duel.state.players[1].hand[0].cardName, 'Own hand 1');
assert(accepted.duel.state.players[0].hand[0].hidden); assert.equal(rows.get(duelId).host_deck, null);
privateDataAbsent(accepted); privateDataAbsent(redactState(rows.get(duelId).state, 0));
assert.equal(calls.filter(call => call.operation === 'create').length, 1);
assert.equal((await run(host, { op:'lobby' })).duels[0].hostDeckName, decks[0].name);
assert.equal((await run(host, { op:'lobby' })).duels[0].guestDeckName, decks[1].name);
await rejects(host, { op:'inspect', duelId, zone:'deck' }, 403, 'auto_private_zone');
await rejects(host, command(duelId, { type:'autoRespond', promptId:'prompt-0', choice:{ id:'advance' } }), 409, 'not_started');
await rejects(host, command(duelId, { type:'ready', player:1 }), 403, 'opponent_action');
const beforeReadyCalls = calls.length;
await run(host, command(duelId, { type:'ready' }));
assert.equal(rows.get(duelId).status, 'setup');
const started = await run(guest, command(duelId, { type:'ready' }));
assert.equal(started.duel.status, 'playing'); assert.equal(calls.length, beforeReadyCalls, 'Readiness must not send a manual start into the core');
assert.equal(rows.get(duelId).state.inputSequence, 0);
console.log('PASS automatic invitations, summaries, owned decks, private projections and two-player readiness');

const unmodified = clone(rows.get(duelId));
await rejects(host, { op:'cancel', duelId, expectedVersion:unmodified.version, requestId:id(++request) }, 403, 'cannot_close');
for (const type of ['move','draw','lp','inspect','finish','start','undo','setPhase','summon','battleManual','activate']) await rejects(host, command(duelId, { type, winner:0, delta:99999 }), 400, 'auto_action_only');
await rejects(host, command(duelId, { type:'autoRespond', player:1, promptId:'prompt-0', choice:{ id:'advance' } }), 403, 'opponent_action');
await rejects(guest, command(duelId, { type:'autoRespond', promptId:'prompt-0', choice:{ id:'advance' } }), 409, 'stale_prompt');
await rejects(host, command(duelId, { type:'autoRespond', promptId:'old-prompt', choice:{ id:'advance' } }), 409, 'stale_prompt');
await rejects(host, command(duelId, { type:'autoRespond', promptId:'prompt-0', choice:{ id:'forged-response' } }), 400, 'invalid_choice');
await rejects(host, command(duelId, { type:'autoRespond', promptId:'prompt-0', choice:{ id:'timeout' } }), 503, 'auto_timeout');
assert.deepEqual(rows.get(duelId), unmodified, 'Invalid/manual/timed-out actions must preserve state and version');
const stale = command(duelId, { type:'autoRespond', promptId:'prompt-0', choice:{ id:'advance' } }, { expectedVersion:1 });
await assert.rejects(() => run(host, stale), error => { assert.equal(error.code, 'stale_version'); privateDataAbsent(error.duel); return true; });
const valid = command(duelId, { type:'autoRespond', promptId:'prompt-0', choice:{ id:'advance' }, winner:0 }, { state:{ mode:'manual', players:[] } });
const applied = await run(host, valid), callsAfterApply = calls.length;
assert.equal(applied.duel.state.auto.inputSequence, 1); assert.equal(applied.duel.state.auto.prompt, null);
assert.equal(rows.get(duelId).state.result, null); assert.equal(rows.get(duelId).state.seed, 'PRIVATE_SEED');
assert.equal((await run(host, valid)).replayed, true); assert.equal(calls.length, callsAfterApply);
const opponentView = (await run(guest, { op:'state', duelId })).duel;
assert.equal(opponentView.state.auto.prompt.id, 'prompt-1'); privateDataAbsent(opponentView);
assert.equal((await run(host, { op:'state', duelId, knownVersion:rows.get(duelId).version })).unchanged, true);
await rejects(third, { op:'state', duelId, knownVersion:rows.get(duelId).version }, 404, 'not_found');
console.log('PASS engine-only inputs, prompt ownership, state-forgery rejection, no-write errors and request replay');

const searchVersion = rows.get(duelId).version;
await rejects(third, { op:'search', duelId, promptId:'prompt-1', query:'Public' }, 404, 'not_found');
await rejects(host, { op:'search', duelId, promptId:'prompt-1', query:'Public' }, 409, 'stale_prompt');
await rejects(guest, { op:'search', duelId, promptId:'old-prompt', query:'Public' }, 409, 'stale_prompt');
await rejects(guest, { op:'search', duelId, promptId:'prompt-1', query:'x'.repeat(101) }, 400, 'invalid_search');
const found = await run(guest, { op:'search', duelId, promptId:'prompt-1', query:'Public' });
assert.equal(found.cards.length, 30); assert.equal(found.version, searchVersion); assert.equal(rows.get(duelId).version, searchVersion); privateDataAbsent(found);
forceConflict = true;
await assert.rejects(() => run(guest, command(duelId, { type:'autoRespond', promptId:'prompt-1', choice:{ id:'advance' } })), error => { assert.equal(error.code, 'stale_version'); privateDataAbsent(error.duel); return true; });
assert.equal(rows.get(duelId).state.inputSequence, 1, 'CAS rejection must not persist the computed next state');
const surrendered = await run(guest, command(duelId, { type:'surrender', winner:1 }));
assert.equal(surrendered.duel.status, 'finished'); assert.equal(surrendered.duel.result.winner, 0, 'A player can concede only their own seat');
assert.equal(surrendered.duel.state.result.winner, 0); assert.equal(surrendered.duel.state.auto.prompt, null);
assert.equal(rows.get(duelId).state.seed, 'PRIVATE_SEED', 'Surrender preserves the replay snapshot');
for (const view of rows.get(duelId).state.publicViews) { assert.equal(view.result.winner, 0); assert.equal(view.status, 'finished'); assert.equal(view.auto.waitingFor, null); assert.equal(view.auto.waitingPlayer, null); assert.equal(view.auto.actor, null); }
await rejects(host, command(duelId, { type:'autoRespond', promptId:'prompt-1', choice:{ id:'advance' } }), 409, 'not_playing');
assert.equal((await run(host, { op:'lobby' })).duels[0].result.winner, 0);
console.log('PASS participant-scoped bounded search, CAS conflicts and authoritative concession');

const lethalId = id(21);
await setup(lethalId); await start(lethalId);
const lethal = await run(host, command(lethalId, { type:'autoRespond', promptId:'prompt-0', choice:{ id:'finish' }, winner:0 }));
assert.equal(lethal.duel.status, 'finished'); assert.equal(lethal.duel.result.winner, 1); privateDataAbsent(lethal);
members = members.filter(member => member.slug !== guest.slug);
await rejects(host, { op:'state', duelId:lethalId, knownVersion:rows.get(lethalId).version }, 403, 'membership_changed');
members.push(guest);
const expiredId = id(22); await setup(expiredId); clock = new Date(clock.getTime() + 86400001);
await rejects(host, { op:'state', duelId:expiredId, knownVersion:rows.get(expiredId).version }, 410, 'expired');
console.log('PASS engine terminal result, current membership checks and expiry on unchanged-state polling');

// A lightweight HTTP fixture confirms the injected runtime and JSON summary
// adapter without touching a Supabase project or loading a native game engine.
const env = { SUPABASE_URL:'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY:'synthetic-not-a-key' };
const handler = createDuelHandler({ env, autoRuntime, databaseFactory:() => ({ authenticate:async token => { if (token !== 'test-token') throw Error('Private auth error'); return host; }, store }), notify:async () => ({ push:'disabled' }) });
async function http(body) {
  const res = { headers:{}, statusCode:200, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method:'POST', headers:{ host:'localhost', 'content-type':'application/json' }, body:{ token:'test-token', ...body } }, res); return res;
}
const response = await http({ op:'state', duelId:lethalId });
assert.equal(response.statusCode, 200); assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0'); privateDataAbsent(response.body);
assert.equal((await http({ op:'inspect', duelId:lethalId, zone:'deck' })).statusCode, 403);
const originalFetch = globalThis.fetch, selects = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input));
  assert.equal(url.hostname, 'synthetic.invalid', 'Automatic deck hydration must not depend on a public metadata request');
  assert.equal(init.method || 'GET', 'GET');
  const json = value => new Response(JSON.stringify(value), { headers:{ 'Content-Type':'application/json' } });
  if (url.pathname === '/rest/v1/yugioh_duels') { selects.push(url.searchParams.get('select')); return json([]); }
  if (url.pathname === '/rest/v1/decks') return json({ id:decks[0].id, owner_slug:host.slug, game:'yugioh', name:'Offline auto deck' });
  if (url.pathname === '/rest/v1/deck_cards') return json([{ catalog_card_id:'89631139', card_name:'Blue-Eyes White Dragon', image_url:'', section:'main', quantity:1, position:0 }]);
  if (url.pathname === '/rest/v1/card_printings') return json([]);
  throw Error(`Unexpected synthetic request ${url.pathname}`);
};
try {
  const database = createDatabase(env);
  const hydrated = await database.store.deck(decks[0].id, host.slug, { mode:'auto' });
  assert.equal(hydrated.cards[0].catalogCardId, '89631139');
  await database.store.list(team, host.slug);
  assert(selects[0].includes('state_mode:state->>mode')); assert(selects[0].includes('host_simulator_mode:host_deck->>simulatorMode'));
  assert(selects[0].includes('host_auto_deck_name:state->initialDecks->0->>name'));
  assert(!selects[0].includes('state,'), 'Lobby must not fetch complete automatic replay data');
} finally { globalThis.fetch = originalFetch; }
console.log('PASS authenticated no-store HTTP, auto-mode summary columns and metadata-independent auto deck hydration');
console.log('yugioh-auto-service-smoke: OK (synthetic runtime, no external account or database)');
