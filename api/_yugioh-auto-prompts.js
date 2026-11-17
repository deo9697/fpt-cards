// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine messages stay on the server. Only this allowlisted, actor-specific
// projection is sent to the arena; client choices are never engine responses.
import {
  OcgMessageType as M, OcgResponseType as R, OcgLocation as L,
  OcgOpCode as OP, OcgRace, OcgAttribute,
} from 'ocgcore-wasm';

const TYPES = new Set([
  M.SELECT_IDLECMD, M.SELECT_BATTLECMD, M.SELECT_EFFECTYN, M.SELECT_YESNO,
  M.SELECT_OPTION, M.SELECT_CARD, M.SELECT_UNSELECT_CARD, M.SELECT_CHAIN,
  M.SELECT_PLACE, M.SELECT_DISFIELD, M.SELECT_POSITION, M.SELECT_TRIBUTE,
  M.SELECT_SUM, M.SELECT_COUNTER, M.SORT_CARD, M.SORT_CHAIN,
  M.ANNOUNCE_RACE, M.ANNOUNCE_ATTRIB, M.ANNOUNCE_CARD,
  M.ANNOUNCE_NUMBER, M.ROCK_PAPER_SCISSORS,
]);
const MAX_OPTIONS = 4096, MAX_SUM_STATES = 200000;
const fail = (message = 'Scelta non consentita dal motore.') => {
  const error = new Error(message); error.code = 'AUTO_INVALID_CHOICE'; throw error;
};
const capability = (message, code = 'AUTO_UNSUPPORTED_PROMPT') => {
  const error = new Error(message); error.code = code; throw error;
};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const list = value => Array.isArray(value) ? value : [];
const table = (context, key) => context[key] ?? context.resources?.[key];
const lookup = (entries, key) => entries instanceof Map
  ? entries.get(key) ?? entries.get(String(key)) : entries?.[key];
const cardRow = (code, context) => lookup(table(context, 'cards'), code);
const nameOf = (code, context) => String(cardRow(code, context)?.name || `Carta ${code}`);

export function isPromptMessage(message) { return !!message && TYPES.has(message.type); }

function safeCard(card, context) {
  const value = {};
  for (const key of ['code', 'controller', 'location', 'sequence', 'position', 'overlay_sequence']) {
    if (integer(card?.[key])) value[key] = card[key];
  }
  const actor = context.actor;
  if ((value.controller === 0 || value.controller === 1) && value.controller !== actor) {
    const visible = typeof context.isCardVisible === 'function' ? context.isCardVisible(card, actor)
      : value.location === L.GRAVE || ([L.MZONE, L.SZONE, L.REMOVED].includes(value.location) && !!(value.position & 5));
    if (!visible) { value.code = 0; value.hidden = true; return value; }
  }
  if (value.code) {
    const metadata = typeof context.cardInfo === 'function' ? context.cardInfo(value.code, card) : null;
    const name = metadata?.name || cardRow(value.code, context)?.name;
    if (name) value.name = String(name).slice(0, 240);
  }
  return value;
}

function description(value, context, fallback = 'Scegli un effetto') {
  if (value === undefined || value === null) return fallback;
  const number = BigInt(value);
  const text = lookup(table(context, 'strings'), number) ?? lookup(table(context, 'strings'), Number(number));
  if (text) return String(text).slice(0, 4000);
  // Card-effect descriptions use (passcode << 4) | string-index.
  const row = cardRow(Number(number >> 4n), context);
  const cardText = row?.[`str${Number(number & 15n) + 1}`];
  return cardText ? String(cardText).slice(0, 4000) : fallback;
}

function option(id, label, card, context, extra = {}) {
  return {id, label, ...(card ? {card: safeCard(card, context)} : {}), ...extra};
}

function places(message, context) {
  const result = [], mask = BigInt(message.field_mask >>> 0);
  for (let side = 0; side < 2; side++) for (const location of [L.MZONE, L.SZONE]) {
    for (let sequence = 0; sequence < (location === L.MZONE ? 7 : 8); sequence++) {
      const shift = side * 16 + (location === L.SZONE ? 8 : 0) + sequence;
      if (mask & (1n << BigInt(shift))) continue;
      const player = side === 0 ? message.player : 1 - message.player;
      const zone = location === L.MZONE ? (sequence < 5 ? `Mostri ${sequence + 1}` : `Extra ${sequence - 4}`)
        : sequence < 5 ? `Magie/Trappole ${sequence + 1}` : sequence === 5 ? 'Terreno' : `Pendulum ${sequence - 5}`;
      result.push(option(`place-${player}-${location}-${sequence}`, `${side ? 'Avversario' : 'Tu'} · ${zone}`, null, context,
        {place: {player, location, sequence}}));
    }
  }
  return result;
}

function maskOptions(available, values, prefix, context) {
  const mask = BigInt(available), result = [];
  for (const [name, value] of Object.entries(values)) {
    const bit = BigInt(value);
    if (bit > 0n && !(bit & (bit - 1n)) && (mask & bit)) {
      result.push(option(`${prefix}-${bit}`, name.replaceAll('_', ' '), null, context));
    }
  }
  return result;
}

export function normalizePrompt(message, context = {}) {
  if (!isPromptMessage(message)) capability(`Richiesta del motore non supportata: ${message?.type ?? 'sconosciuta'}.`);
  if (own(context, 'viewer') && context.viewer !== message.player) return null;
  if (message.player !== 0 && message.player !== 1) capability('Giocatore della richiesta non valido.');
  context = {...context, actor: message.player};
  const id = String(context.id ?? `prompt-${context.sequence ?? 0}`);
  const prompt = {id, promptId: id, player: message.player, kind: '', title: '', options: [], min: 1, max: 1, cancelable: false};
  const cards = (rows, prefix, label, extra = () => ({})) => list(rows).map((card, index) => {
    const view = safeCard(card, context);
    const hiddenLabel = `Carta coperta · ${card.location === L.MZONE ? 'Mostri' : card.location === L.SZONE ? 'Magie/Trappole' : 'Zona'} ${card.sequence + 1}`;
    return option(`${prefix}-${index}`, `${label}${label ? ' · ' : ''}${view.hidden ? hiddenLabel : nameOf(card.code, context)}`, card, context, extra(card, index));
  });
  switch (message.type) {
    case M.SELECT_IDLECMD: {
      prompt.kind = 'idle'; prompt.title = 'La tua mossa';
      for (const [key, label, action] of [
        ['summons', 'Normal Summon', 'summon'], ['special_summons', 'Special Summon', 'special-summon'],
        ['pos_changes', 'Cambia posizione', 'position'], ['monster_sets', 'Set', 'monster-set'],
        ['spell_sets', 'Set', 'spell-set'], ['activates', 'Activate', 'activate'],
      ]) prompt.options.push(...cards(message[key], key, label, card => ({action, ...(key === 'activates' ? {effect: description(card.description, context, 'Attiva effetto')} : {})})));
      for (const [key, label] of [['to_bp', 'Battle Phase'], ['to_ep', 'End Phase'], ['shuffle', 'Mescola mano']]) {
        if (message[key]) prompt.options.push(option(key, label, null, context, {action: key}));
      }
      break;
    }
    case M.SELECT_BATTLECMD:
      prompt.kind = 'battle'; prompt.title = 'Battle Phase';
      prompt.options.push(...cards(message.chains, 'chains', 'Activate', card => ({action: 'activate', effect: description(card.description, context, 'Attiva effetto')})),
        ...cards(message.attacks, 'attacks', 'Attacca', card => ({action: 'attack', direct: !!card.can_direct})));
      if (message.to_m2) prompt.options.push(option('to_m2', 'Main Phase 2', null, context));
      if (message.to_ep) prompt.options.push(option('to_ep', 'End Phase', null, context));
      break;
    case M.SELECT_EFFECTYN:
    case M.SELECT_YESNO:
      prompt.kind = 'yes-no'; prompt.title = description(message.description, context, 'Vuoi procedere?');
      prompt.options = [option('yes', 'Sì', message.type === M.SELECT_EFFECTYN ? message : null, context), option('no', 'No', null, context)];
      break;
    case M.SELECT_OPTION:
      prompt.kind = 'option'; prompt.title = 'Scegli un effetto';
      prompt.options = list(message.options).map((value, index) => option(`option-${index}`, description(value, context, `Opzione ${index + 1}`), null, context));
      break;
    case M.SELECT_CARD:
    case M.SELECT_TRIBUTE:
    case M.SELECT_SUM: {
      const tribute = message.type === M.SELECT_TRIBUTE, sum = message.type === M.SELECT_SUM;
      prompt.kind = tribute ? 'tribute' : sum ? 'sum' : 'select';
      prompt.title = tribute ? 'Scegli i tributi' : sum ? `Scegli i materiali · totale ${message.amount}` : 'Scegli le carte';
      prompt.min = tribute ? (message.min ? 1 : 0) : sum && message.select_max ? 0 : message.min;
      prompt.max = sum && message.select_max ? list(message.selects).length : message.max;
      prompt.cancelable = !sum && !!message.can_cancel;
      prompt.options = cards(message.selects, 'card', '', card => tribute ? {contribution: card.release_param} : sum ? {contributions: sumValues(card.amount)} : {});
      if (tribute) prompt.requiredContribution = message.min;
      if (sum) { prompt.amount = message.amount; prompt.sumMode = message.select_max ? 'at-least-minimal' : 'exact'; prompt.mandatory = cards(message.selects_must, 'mandatory', '', card => ({contributions: sumValues(card.amount), mandatory: true})); }
      break;
    }
    case M.SELECT_UNSELECT_CARD:
      prompt.kind = 'toggle'; prompt.title = 'Scegli i materiali'; prompt.canFinish = !!message.can_finish;
      prompt.cancelable = !!message.can_cancel;
      prompt.options = [...cards(message.select_cards, 'select', '', () => ({selected: false})), ...cards(message.unselect_cards, 'unselect', '', () => ({selected: true}))];
      break;
    case M.SELECT_CHAIN:
      prompt.kind = 'chain'; prompt.title = message.forced ? 'Scegli un effetto obbligatorio' : 'Vuoi rispondere alla catena?';
      prompt.options = cards(message.selects, 'chain', 'Activate', card => ({effect: description(card.description, context, 'Attiva effetto')}));
      prompt.cancelable = !message.forced;
      if (!message.forced) prompt.options.push(option('pass', 'Non rispondere', null, context));
      break;
    case M.SELECT_PLACE:
    case M.SELECT_DISFIELD:
      prompt.kind = 'place'; prompt.title = message.type === M.SELECT_DISFIELD ? 'Scegli le zone da disabilitare' : 'Scegli la zona';
      prompt.min = prompt.max = message.count; prompt.options = places(message, context);
      break;
    case M.SELECT_POSITION:
      prompt.kind = 'position'; prompt.title = 'Scegli la posizione';
      for (const [value, label] of [[1, 'Attack'], [4, 'Defense'], [8, 'Set Defense'], [2, 'Set Attack']]) {
        if (message.positions & value) prompt.options.push(option(`position-${value}`, label, {code: message.code, position: value}, context));
      }
      break;
    case M.SELECT_COUNTER:
      prompt.kind = 'counter'; prompt.title = `Rimuovi ${message.count} segnalini`; prompt.count = message.count;
      prompt.options = cards(message.cards, 'counter', '', card => ({available: card.count}));
      break;
    case M.SORT_CARD:
    case M.SORT_CHAIN:
      prompt.kind = 'sort'; prompt.title = message.type === M.SORT_CHAIN ? 'Ordina gli effetti della catena' : 'Ordina le carte';
      prompt.options = cards(message.cards, 'sort', ''); prompt.min = prompt.max = prompt.options.length;
      prompt.cancelable = true; prompt.ordered = true;
      break;
    case M.ANNOUNCE_RACE:
    case M.ANNOUNCE_ATTRIB: {
      const race = message.type === M.ANNOUNCE_RACE;
      prompt.kind = race ? 'race' : 'attribute'; prompt.title = race ? 'Dichiara il Tipo' : 'Dichiara l’Attributo';
      prompt.options = maskOptions(message.available, race ? OcgRace : OcgAttribute, race ? 'race' : 'attribute', context);
      prompt.min = prompt.max = message.count;
      break;
    }
    case M.ANNOUNCE_CARD:
      prompt.kind = 'announce-card'; prompt.title = 'Dichiara una carta'; prompt.searchable = true; prompt.input = 'card';
      break;
    case M.ANNOUNCE_NUMBER:
      prompt.kind = 'announce-number'; prompt.title = 'Dichiara un numero';
      prompt.options = list(message.options).map((value, index) => option(`number-${index}`, String(value), null, context));
      break;
    case M.ROCK_PAPER_SCISSORS:
      prompt.kind = 'rps'; prompt.title = 'Sasso, carta, forbici';
      prompt.options = [option('rps-2', 'Sasso', null, context), option('rps-3', 'Carta', null, context), option('rps-1', 'Forbici', null, context)];
      break;
  }
  if (prompt.options.length > MAX_OPTIONS) capability('Richiesta con troppe opzioni.', 'AUTO_PROMPT_LIMIT');
  if (!integer(prompt.min) || !integer(prompt.max) || prompt.max < prompt.min) capability('Limiti della richiesta non validi.');
  return prompt;
}

function sumValues(amount) {
  const low = amount & 0xffff, high = amount >>> 16;
  return [...new Set([low, ...(high ? [high] : [])])];
}

function selectedIds(choice, multiple = false) {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) fail();
  const ids = own(choice, 'optionIds') ? choice.optionIds : own(choice, 'optionId') ? [choice.optionId] : null;
  if (!Array.isArray(ids) || ids.length > MAX_OPTIONS || (!multiple && ids.length !== 1)
    || ids.some(id => typeof id !== 'string' || id.length > 100) || new Set(ids).size !== ids.length) fail();
  return ids;
}

function indexes(choice, options, multiple = false) {
  return selectedIds(choice, multiple).map(id => {
    const index = options.findIndex(item => item.id === id);
    if (index < 0) fail();
    return index;
  });
}

function cancelRequested(choice) { return choice?.optionId === 'cancel' || choice?.optionId === 'finish' || choice?.cancel === true; }
function enforceCount(indices, min, max) { if (indices.length < min || indices.length > max) fail('Numero di scelte non valido.'); }

function validSum(message, indices) {
  const cards = [...list(message.selects_must), ...indices.map(index => message.selects[index])];
  if (!cards.length) return false;
  if (message.select_max) {
    let low = 0, high = 0, minimum = Infinity;
    for (const card of cards) {
      const values = sumValues(card.amount), small = Math.min(...values);
      low += small; high += Math.max(...values); minimum = Math.min(minimum, small);
    }
    return high >= message.amount && low - minimum < message.amount;
  }
  enforceCount(indices, message.min, message.max);
  // A bounded dynamic program handles alternate levels without exponential
  // recursion. Mandatory materials contribute, but never enter response indices.
  let sums = new Set([0]), work = 0;
  for (let index = 0; index < cards.length; index++) {
    const next = new Set();
    for (const sum of sums) for (const value of sumValues(cards[index].amount)) {
      if (++work > MAX_SUM_STATES) capability('Selezione materiali troppo complessa.', 'AUTO_PROMPT_LIMIT');
      const total = sum + value;
      if (total <= message.amount && (index === cards.length - 1 || total < message.amount)) next.add(total);
    }
    sums = next;
    if (!sums.size) return false;
  }
  return sums.has(message.amount);
}

function maskSelection(message, choice, prompt, race) {
  let bits;
  if (own(choice, 'value')) {
    const text = String(choice.value);
    if (!/^(?:0x[0-9a-f]{1,16}|[0-9]{1,20})$/i.test(text)) fail();
    const mask = BigInt(text), available = BigInt(message.available);
    if (mask < 0n || (mask & ~available)) fail();
    bits = prompt.options.filter(item => mask & BigInt(item.id.slice(item.id.indexOf('-') + 1))).map(item => BigInt(item.id.slice(item.id.indexOf('-') + 1)));
    if (bits.reduce((a, b) => a | b, 0n) !== mask) fail();
  } else bits = indexes(choice, prompt.options, true).map(index => BigInt(prompt.options[index].id.split('-')[1]));
  enforceCount(bits, message.count, message.count);
  return race ? {type: R.ANNOUNCE_RACE, races: bits} : {type: R.ANNOUNCE_ATTRIB, attributes: bits.map(Number)};
}

export function resolveChoice(message, choice, context = {}) {
  const prompt = normalizePrompt(message, context);
  if (!prompt || !choice || typeof choice !== 'object' || Array.isArray(choice)) fail();
  if (Object.keys(choice).some(key => !['optionId', 'optionIds', 'counts', 'value', 'cancel'].includes(key))) fail();
  if (Object.keys(choice).length !== 1 || (own(choice, 'cancel') && choice.cancel !== true)) fail('Invia una sola scelta alla volta.');
  const cancelled = cancelRequested(choice);
  if (cancelled) {
    if (!prompt.cancelable && !(message.type === M.SELECT_UNSELECT_CARD && prompt.canFinish)) fail();
    if (message.type === M.SELECT_CHAIN) return {type: R.SELECT_CHAIN, index: null};
    if (message.type === M.SELECT_CARD) return {type: R.SELECT_CARD, indicies: null};
    if (message.type === M.SELECT_TRIBUTE) return {type: R.SELECT_TRIBUTE, indicies: null};
    if (message.type === M.SELECT_UNSELECT_CARD) return {type: R.SELECT_UNSELECT_CARD, index: null};
    if (message.type === M.SORT_CARD || message.type === M.SORT_CHAIN) return {type: R.SORT_CARD, order: null};
    fail();
  }
  switch (message.type) {
    case M.SELECT_IDLECMD:
    case M.SELECT_BATTLECMD: {
      const id = prompt.options[indexes(choice, prompt.options)[0]].id;
      const idle = message.type === M.SELECT_IDLECMD;
      const actions = idle ? ['summons', 'special_summons', 'pos_changes', 'monster_sets', 'spell_sets', 'activates', 'to_bp', 'to_ep', 'shuffle']
        : ['chains', 'attacks', 'to_m2', 'to_ep'];
      const action = actions.findIndex(prefix => id === prefix || id.startsWith(`${prefix}-`));
      if (action < 0) fail();
      return {type: idle ? R.SELECT_IDLECMD : R.SELECT_BATTLECMD, action, index: id === actions[action] ? null : Number(id.slice(actions[action].length + 1))};
    }
    case M.SELECT_EFFECTYN:
    case M.SELECT_YESNO:
      return {type: message.type === M.SELECT_EFFECTYN ? R.SELECT_EFFECTYN : R.SELECT_YESNO, yes: indexes(choice, prompt.options)[0] === 0};
    case M.SELECT_OPTION:
      return {type: R.SELECT_OPTION, index: indexes(choice, prompt.options)[0]};
    case M.SELECT_CARD:
    case M.SELECT_TRIBUTE:
    case M.SELECT_SUM: {
      const indices = indexes(choice, prompt.options, true);
      if (message.type === M.SELECT_TRIBUTE) {
        enforceCount(indices, 0, message.max);
        if (indices.reduce((total, index) => total + message.selects[index].release_param, 0) < message.min) fail('Tributi insufficienti.');
      } else if (message.type === M.SELECT_SUM) {
        if (!validSum(message, indices)) fail('I materiali non raggiungono il totale richiesto.');
      } else enforceCount(indices, message.min, message.max);
      return {type: message.type === M.SELECT_SUM ? R.SELECT_SUM : message.type === M.SELECT_TRIBUTE ? R.SELECT_TRIBUTE : R.SELECT_CARD, indicies: indices};
    }
    case M.SELECT_UNSELECT_CARD: {
      const id = prompt.options[indexes(choice, prompt.options)[0]].id;
      const index = Number(id.slice(id.indexOf('-') + 1));
      return {type: R.SELECT_UNSELECT_CARD, index: id.startsWith('unselect-') ? list(message.select_cards).length + index : index};
    }
    case M.SELECT_CHAIN: {
      const index = indexes(choice, prompt.options)[0];
      return {type: R.SELECT_CHAIN, index: prompt.options[index].id === 'pass' ? null : index};
    }
    case M.SELECT_PLACE:
    case M.SELECT_DISFIELD: {
      const indices = indexes(choice, prompt.options, true); enforceCount(indices, message.count, message.count);
      return {type: message.type === M.SELECT_PLACE ? R.SELECT_PLACE : R.SELECT_DISFIELD, places: indices.map(index => prompt.options[index].place)};
    }
    case M.SELECT_POSITION:
      return {type: R.SELECT_POSITION, position: Number(prompt.options[indexes(choice, prompt.options)[0]].id.split('-')[1])};
    case M.SELECT_COUNTER: {
      const counts = choice.counts;
      if (!counts || typeof counts !== 'object' || Array.isArray(counts) || Object.keys(counts).some(id => !prompt.options.some(item => item.id === id))) fail();
      const counters = prompt.options.map(item => own(counts, item.id) ? counts[item.id] : 0);
      if (counters.some((count, index) => !integer(count) || count > message.cards[index].count || count > 0x7fff)
        || counters.reduce((total, count) => total + count, 0) !== message.count) fail('Distribuzione dei segnalini non valida.');
      return {type: R.SELECT_COUNTER, counters};
    }
    case M.SORT_CARD:
    case M.SORT_CHAIN: {
      const indices = indexes(choice, prompt.options, true); enforceCount(indices, prompt.options.length, prompt.options.length);
      // Core expects the rank for each original card, not the array of cards in
      // their desired order. The core adapter fixes the wrapper's count prefix.
      const order = new Array(indices.length); indices.forEach((index, rank) => { order[index] = rank; });
      return {type: R.SORT_CARD, order};
    }
    case M.ANNOUNCE_RACE: return maskSelection(message, choice, prompt, true);
    case M.ANNOUNCE_ATTRIB: return maskSelection(message, choice, prompt, false);
    case M.ANNOUNCE_CARD: {
      const value = own(choice, 'value') ? choice.value : /^card-[1-9][0-9]{0,9}$/.test(choice.optionId ?? '') ? choice.optionId.slice(5) : null;
      if (!/^[1-9][0-9]{0,9}$/.test(String(value))) fail();
      const code = Number(value), card = cardRow(code, context);
      if (!card || code > 0x7fffffff || !matchesAnnouncement(card, message.opcodes)) fail('Questa carta non può essere dichiarata.');
      return {type: R.ANNOUNCE_CARD, card: code};
    }
    case M.ANNOUNCE_NUMBER: {
      let index;
      if (own(choice, 'value')) {
        const text = String(choice.value);
        if (!/^[0-9]{1,20}$/.test(text)) fail();
        index = list(message.options).findIndex(value => BigInt(value) === BigInt(text));
        if (index < 0) fail();
      } else index = indexes(choice, prompt.options)[0];
      return {type: R.ANNOUNCE_NUMBER, value: index};
    }
    case M.ROCK_PAPER_SCISSORS:
      return {type: R.ROCK_PAPER_SCISSORS, value: Number(prompt.options[indexes(choice, prompt.options)[0]].id.split('-')[1])};
  }
  capability('Risposta del motore non supportata.');
}

// The wrapper's 0.1.6 ISATTRIBUTE helper compares card.code. This local evaluator
// follows core's declarability checks and uses the actual attribute instead.
function matchesAnnouncement(card, opcodes) {
  // Declaring a Forbidden TCG card may be legal; unreleased/OCG-only/Rush or
  // custom cards are outside this arena's pinned TCG card pool.
  if (![2, 3].includes(card.ot)) return false;
  const stack = []; let aliases = false, tokens = false;
  const binary = fn => { if (stack.length < 2) return; const right = stack.pop(), left = stack.pop(); stack.push(BigInt.asIntN(64, fn(left, right))); };
  const unary = fn => { if (stack.length) stack.push(BigInt.asIntN(64, fn(stack.pop()))); };
  try {
    for (const raw of list(opcodes)) {
      const op = BigInt(raw);
      switch (op) {
        case OP.ADD: binary((a, b) => a + b); break;
        case OP.SUB: binary((a, b) => a - b); break;
        case OP.MUL: binary((a, b) => a * b); break;
        case OP.DIV: binary((a, b) => b ? a / b : 0n); break;
        case OP.AND: binary((a, b) => a && b ? 1n : 0n); break;
        case OP.OR: binary((a, b) => a || b ? 1n : 0n); break;
        case OP.NEG: unary(a => -a); break;
        case OP.NOT: unary(a => a ? 0n : 1n); break;
        case OP.BAND: binary((a, b) => a & b); break;
        case OP.BOR: binary((a, b) => a | b); break;
        case OP.BNOT: unary(a => ~a); break;
        case OP.BXOR: binary((a, b) => a ^ b); break;
        case OP.LSHIFT: binary((a, b) => a << (b & 63n)); break;
        case OP.RSHIFT: binary((a, b) => a >> (b & 63n)); break;
        case OP.ALLOW_ALIASES: aliases = true; break;
        case OP.ALLOW_TOKENS: tokens = true; break;
        case OP.ISCODE: unary(a => a === BigInt(card.code) ? 1n : 0n); break;
        case OP.ISSETCARD: unary(a => list(card.setcodes).some(code => (code & 0xfff) === (Number(a) & 0xfff) && (code & 0xf000 & Number(a)) === (Number(a) & 0xf000)) ? 1n : 0n); break;
        case OP.ISTYPE: unary(a => BigInt(card.type) & a ? 1n : 0n); break;
        case OP.ISRACE: unary(a => BigInt(card.race) & a ? 1n : 0n); break;
        case OP.ISATTRIBUTE: unary(a => BigInt(card.attribute) & a ? 1n : 0n); break;
        case OP.GETCODE: stack.push(BigInt(card.code)); break;
        case OP.GETSETCARD: break;
        case OP.GETTYPE: stack.push(BigInt(card.type)); break;
        case OP.GETRACE: stack.push(BigInt(card.race)); break;
        case OP.GETATTRIBUTE: stack.push(BigInt(card.attribute)); break;
        default: stack.push(op);
      }
    }
  } catch { return false; }
  if (stack.length !== 1 || !stack[0]) return false;
  return card.code === 78734254 || card.code === 13857930 || ((aliases || !card.alias) && (tokens || (card.type & 0x4001) !== 0x4001));
}

export function searchPromptCards(message, query, context = {}) {
  if (message?.type !== M.ANNOUNCE_CARD) fail('Nessuna dichiarazione carta in corso.');
  const text = String(query ?? '').trim().toLocaleLowerCase('it').slice(0, 100);
  if (text.length < 2) return [];
  const cards = table(context, 'cards');
  if (!cards) capability('Database carte non disponibile.');
  const limit = Math.min(30, Math.max(1, Number.isInteger(context.limit) ? context.limit : 30));
  const result = [];
  for (const card of cards instanceof Map ? cards.values() : Object.values(cards)) {
    if ((String(card.code).includes(text) || String(card.name ?? '').toLocaleLowerCase('it').includes(text)) && matchesAnnouncement(card, message.opcodes)) {
      result.push({code: card.code, name: String(card.name || `Carta ${card.code}`).slice(0, 240)});
      if (result.length === limit) break;
    }
  }
  return result;
}
