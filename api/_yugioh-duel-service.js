import { createSession, applyAction, validateSimulatorDeck } from '../js/games/yugioh/simulator-engine.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminal = new Set(['finished', 'declined', 'cancelled']);
const copy = value => JSON.parse(JSON.stringify(value));
const validLp = value => Number.isInteger(value) && value >= 1 && value <= 999999;
export class DuelError extends Error {
  constructor(status, code, message, duel = undefined) { super(message); this.status = status; this.code = code; this.duel = duel; }
}
const fail = (status, code, message, duel) => { throw new DuelError(status, code, message, duel); };
const needUuid = (value, label = 'Identificativo') => { if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'invalid_id', `${label} non valido.`); return value; };

function hiddenCard(player, zone, index, card = {}) {
  return { id: 'hidden-' + player + '-' + zone + '-' + index, hidden:true, cardName:'Carta coperta', catalogCardId:'', imageUrl:'', faceUp:false, position:card.position || 'attack', slot:card.slot ?? null, counters:card.counters || 0, materials:copy(card.materials || []) };
}
export function redactState(state, viewer) {
  if (!state) return null;
  const result = copy(state);
  for (const [index, player] of result.players.entries()) {
    player.deck = player.deck.map((card, cardIndex) => hiddenCard(index, 'deck', cardIndex));
    if (index !== viewer) {
      player.hand = player.hand.map((card, cardIndex) => hiddenCard(index, 'hand', cardIndex));
      player.side = (player.side || []).map((card, cardIndex) => hiddenCard(index, 'side', cardIndex));
      player.extra = player.extra.map((card, cardIndex) => card.faceUp ? card : hiddenCard(index, 'extra', cardIndex));
      for (const zone of ['monsters','spells','field','extraMonsters','banished']) {
        player[zone] = player[zone].map((card, cardIndex) => card.faceUp ? card : hiddenCard(index, zone, cardIndex, card));
      }
      player.deckId = '';
    }
  }
  return result;
}

// This service owns the state machine. The database adapter uses compare-and-swap;
// a client never uploads a game state, deck list, identity or hidden card data.
export function createDuelService({ store, notify = async () => ({ push:'unavailable' }), now = () => new Date() }) {
  const at = () => now().toISOString();
  async function participant(row, actor) {
    if (!row || row.team_id !== actor.teamId || ![row.host_slug, row.guest_slug].includes(actor.slug)) fail(404, 'not_found', 'Partita non disponibile per il tuo profilo.');
    const members = await store.members(actor.teamId);
    const host = members.find(member => member.slug === row.host_slug);
    const guest = members.find(member => member.slug === row.guest_slug);
    if (!host || !guest) fail(403, 'membership_changed', 'Uno dei giocatori non fa più parte del team.');
    return { members, host, guest, viewer:row.host_slug === actor.slug ? 0 : 1 };
  }
  function projection(row, actor, people, includeState = true) {
    const viewer = people?.viewer ?? (row.host_slug === actor.slug ? 0 : 1);
    return {
      id:row.id, status:row.status, version:row.version, viewer,
      hostSlug:row.host_slug, guestSlug:row.guest_slug,
      hostName:people?.host?.name || row.host_slug, guestName:people?.guest?.name || row.guest_slug,
      ready:Array.isArray(row.ready) ? row.ready.map(Boolean) : [false, false],
      firstPlayer:row.first_player, createdAt:row.created_at, updatedAt:row.updated_at, expiresAt:row.expires_at,
      hostDeckName:row.host_state_deck_name || row.state?.players?.[0]?.deckName || row.host_deck_name || row.host_deck?.name || '',
      guestDeckName:row.guest_state_deck_name || row.state?.players?.[1]?.deckName || '',
      result:row.result || row.state?.result ? copy(row.result || row.state.result) : null,
      ...(includeState ? { state:redactState(row.state, viewer) } : {})
    };
  }
  async function existing(id, actor) {
    const row = await store.get(needUuid(id, 'Partita'));
    const people = await participant(row, actor);
    checkExpiry(row);
    return { row, people };
  }
  function checkExpiry(row) {
    if (new Date(row.expires_at).getTime() <= now().getTime() && !terminal.has(row.status)) fail(410, 'expired', 'La partita è scaduta. Puoi inviare un nuovo invito.');
  }
  async function deck(id, actor) {
    const selected = await store.deck(needUuid(id, 'Mazzo'), actor.slug);
    if (!selected || selected.ownerSlug !== actor.slug || selected.game !== 'yugioh') fail(404, 'deck_not_found', 'Scegli un tuo mazzo Yu-Gi-Oh! salvato.');
    const result = validateSimulatorDeck(selected);
    if (!result.valid) fail(400, 'invalid_deck', result.errors.join(' '));
    return selected;
  }
  async function cas(row, patch, actor, people, requestId) {
    const next = await store.update(row.id, row.version, { ...patch, version:row.version + 1, updated_at:at(), last_action_id:requestId, last_action_by:actor.slug });
    if (!next) {
      const current = await store.get(row.id);
      if (current?.last_action_id === requestId && current?.last_action_by === actor.slug) return { duel:projection(current, actor, people), replayed:true };
      fail(409, 'stale_version', 'Il tavolo è stato aggiornato. Controlla la mossa e riprova.', current ? projection(current, actor, people) : undefined);
    }
    return { duel:projection(next, actor, people) };
  }
  function expected(row, payload, actor, people) {
    needUuid(payload.requestId, 'Richiesta');
    if (row.last_action_id === payload.requestId && row.last_action_by === actor.slug) return true;
    if (!Number.isInteger(payload.expectedVersion) || payload.expectedVersion !== row.version) fail(409, 'stale_version', 'Il tavolo è stato aggiornato. Controlla la mossa e riprova.', projection(row, actor, people));
    return false;
  }
  function actionForViewer(action, state, viewer) {
    if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string') fail(400, 'invalid_action', 'Azione non valida.');
    if (action.player !== undefined && action.player !== viewer) fail(403, 'opponent_action', 'Puoi modificare soltanto il tuo campo.');
    if (['start', 'undo', 'create', 'ready'].includes(action.type)) fail(400, 'invalid_action', 'Azione non disponibile su questo tavolo.');
    if (['setPhase', 'nextPhase', 'nextTurn'].includes(action.type) && state.activePlayer !== viewer) fail(403, 'not_your_turn', 'Il cambio fase e turno spetta al giocatore attivo.');
    const allowed = new Set(['draw','move','setPosition','flip','lp','stats','counter','activate','resolveChain','shuffle','setPhase','nextPhase','nextTurn','finish','token','attachMaterial','detachMaterial']);
    if (!allowed.has(action.type)) fail(400, 'invalid_action', 'Azione non disponibile.');
    const result = { ...action, player:viewer };
    // Concealed IDs are positional and scoped to the viewer, never card identities.
    for (const key of ['cardId', 'targetId']) {
      if (typeof result[key] !== 'string' || !result[key].startsWith('hidden-')) continue;
      const match = result[key].match(/^hidden-([01])-(deck)-(\d+)$/);
      if (!match || Number(match[1]) !== viewer) fail(403, 'hidden_card', 'Carta coperta non disponibile.');
      const card = state.players[viewer][match[2]][Number(match[3])];
      if (!card) fail(400, 'card_not_found', 'Carta non presente nella zona scelta.');
      result[key] = card.id;
    }
    return result;
  }
  return {
    async run(actor, payload) {
      if (!actor?.slug || !actor?.teamId || !UUID.test(actor.teamId)) fail(401, 'unauthorized', 'Accedi con il tuo profilo del team.');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400, 'invalid_request', 'Richiesta non valida.');
      const op = payload.op;
      if (op === 'practice') {
        const members = await store.members(actor.teamId);
        if (!members.some(member => member.slug === actor.slug)) fail(403, 'not_member', 'Il tuo profilo non appartiene al team.');
        return { deck:await deck(payload.deckId, actor) };
      }
      if (op === 'lobby') {
        const members = await store.members(actor.teamId);
        if (!members.some(member => member.slug === actor.slug)) fail(403, 'not_member', 'Il tuo profilo non appartiene al team.');
        const pushMembers = new Set(await store.pushMembers(members.map(member => member.slug)));
        const rows = await store.list(actor.teamId, actor.slug);
        const visible = rows.filter(row => members.some(member => member.slug === row.host_slug) && members.some(member => member.slug === row.guest_slug));
        return { members:members.map(member => ({ slug:member.slug, name:member.name, pushEnabled:pushMembers.has(member.slug) })), duels:visible.filter(row => row.status === 'finished' || (!terminal.has(row.status) && new Date(row.expires_at) > now())).map(row => projection(row, actor, { host:members.find(m => m.slug === row.host_slug), guest:members.find(m => m.slug === row.guest_slug) }, false)), serverTime:at() };
      }
      if (op === 'invite') {
        const requestId = needUuid(payload.requestId, 'Richiesta');
        const duplicate = await store.get(requestId);
        if (duplicate) {
          const people = await participant(duplicate, actor);
          if (duplicate.host_slug !== actor.slug) fail(409, 'request_used', 'Identificativo invito già utilizzato.');
          return { duel:projection(duplicate, actor, people), replayed:true, notification:{ queued:true, push:'already_requested' } };
        }
        if (!validLp(payload.lp ?? 8000) || ![0, 1].includes(payload.firstPlayer)) fail(400, 'invalid_setup', 'Controlla i Life Points e il primo giocatore.');
        const members = await store.members(actor.teamId);
        const host = members.find(member => member.slug === actor.slug), guest = members.find(member => member.slug === payload.opponentSlug);
        if (!host || !guest || host.slug === guest.slug) fail(400, 'invalid_opponent', 'Scegli un altro membro del tuo team.');
        const open = await store.list(actor.teamId, actor.slug);
        if (open.some(row => row.status === 'waiting' && row.host_slug === actor.slug && row.guest_slug === guest.slug && new Date(row.expires_at) > now())) fail(409, 'already_invited', 'Hai già un invito in attesa per questo membro.');
        if (await store.recentCount(actor.slug, new Date(now().getTime() - 60000).toISOString()) >= 5) fail(429, 'rate_limit', 'Hai inviato diversi inviti. Attendi un minuto.');
        const selected = await deck(payload.deckId, actor);
        const row = { id:requestId, team_id:actor.teamId, host_slug:host.slug, guest_slug:guest.slug, status:'waiting', version:1, host_deck:selected, host_lp:payload.lp ?? 8000, first_player:payload.firstPlayer, state:null, previous_state:null, ready:[false, false], last_action_id:requestId, last_action_by:actor.slug, created_at:at(), updated_at:at(), expires_at:new Date(now().getTime() + 86400000).toISOString() };
        const saved = await store.insert(row);
        if (!saved) {
          const current = await store.get(requestId);
          if (current?.host_slug === actor.slug && current?.team_id === actor.teamId) return { duel:projection(current, actor, { host, guest }), replayed:true, notification:{ queued:true, push:'already_requested' } };
          fail(409, 'invite_conflict', 'L’invito è già stato creato. Aggiorna il tavolo.');
        }
        let delivery;
        try { delivery = await notify({ id:row.id, recipient:guest.slug, senderName:host.name }); } catch { delivery = { push:'failed' }; }
        return { duel:projection(saved, actor, { host, guest }), notification:{ queued:true, ...delivery } };
      }
      if (!['state','inspect','accept','decline','cancel','action'].includes(op)) fail(400, 'invalid_operation', 'Operazione non disponibile.');
      if (op === 'state' && payload.knownVersion !== undefined) {
        if (!Number.isSafeInteger(payload.knownVersion) || payload.knownVersion < 1) fail(400, 'invalid_version', 'Versione del tavolo non valida.');
        const meta = await store.meta(needUuid(payload.duelId, 'Partita'));
        // The version is never an access credential. Check both participants'
        // current team membership and expiry before returning even a no-op.
        await participant(meta, actor);
        checkExpiry(meta);
        if (meta.version === payload.knownVersion) return { unchanged:true, duelId:meta.id, version:meta.version };
      }
      const { row, people } = await existing(payload.duelId, actor);
      const view = () => projection(row, actor, people);
      if (op === 'state') return { duel:view() };
      if (op === 'inspect') {
        if (!row.state || payload.zone !== 'deck') fail(400, 'invalid_zone', 'Zona non disponibile.');
        if (!['playing', 'finished'].includes(row.status)) fail(409, 'not_started', 'Attendi che entrambi i giocatori confermino la mano iniziale.');
        if (payload.player !== undefined && payload.player !== people.viewer) fail(403, 'opponent_zone', 'Le zone coperte dell’avversario restano private.');
        return { duel:view(), zone:payload.zone, version:row.version, cards:copy(row.state.players[people.viewer][payload.zone]) };
      }
      if (expected(row, payload, actor, people)) return { duel:view(), replayed:true };
      if (op === 'accept') {
        if (people.viewer !== 1 || row.status !== 'waiting') fail(403, 'cannot_accept', 'Questo invito non è disponibile per l’accettazione.');
        if (!validLp(payload.lp ?? 8000)) fail(400, 'invalid_lp', 'Controlla i Life Points iniziali.');
        const selected = await deck(payload.deckId, actor);
        const state = createSession({ decks:[row.host_deck, selected], firstPlayer:row.first_player, lp:[row.host_lp, payload.lp ?? 8000], names:[people.host.name, people.guest.name] });
        state.id = row.id;
        return cas(row, { status:'setup', state, host_deck:null, ready:[false, false], previous_state:null }, actor, people, payload.requestId);
      }
      if (op === 'decline' || op === 'cancel') {
        if (terminal.has(row.status) || (op === 'decline' && (people.viewer !== 1 || row.status !== 'waiting')) || (op === 'cancel' && row.status === 'waiting' && people.viewer !== 0)) fail(403, 'cannot_close', 'Non puoi chiudere questo invito.');
        return cas(row, { status:op === 'decline' ? 'declined' : 'cancelled', host_deck:null, previous_state:null }, actor, people, payload.requestId);
      }
      if (!row.state || !['setup', 'playing'].includes(row.status)) fail(409, 'not_playing', 'La partita non è in corso.');
      if (payload.action?.type === 'ready') {
        if (payload.action.player !== undefined && payload.action.player !== people.viewer) fail(403, 'opponent_action', 'Puoi confermare soltanto la tua mano.');
        if (row.status !== 'setup') fail(400, 'already_started', 'La partita è già iniziata.');
        const ready = Array.isArray(row.ready) ? [...row.ready] : [false, false]; ready[people.viewer] = true;
        const state = ready.every(Boolean) ? applyAction(row.state, { type:'start' }) : row.state;
        return cas(row, { ready, state, status:ready.every(Boolean) ? 'playing' : 'setup', previous_state:null }, actor, people, payload.requestId);
      }
      if (row.status === 'setup' && row.ready?.[people.viewer]) fail(409, 'already_ready', 'Hai già confermato la mano iniziale. Attendi l’avversario.');
      const action = actionForViewer(payload.action, row.state, people.viewer);
      let state;
      try { state = applyAction(row.state, action); } catch (error) { fail(400, 'invalid_action', error.message || 'Mossa non disponibile.'); }
      return cas(row, { state, status:state.result ? 'finished' : row.status, previous_state:null }, actor, people, payload.requestId);
    }
  };
}
