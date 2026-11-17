// SPDX-License-Identifier: AGPL-3.0-or-later
import {OcgType as T} from 'ocgcore-wasm';

// Pinned Advanced TCG list. The official page was checked on 2026-11-17;
// its Perfectron Hydradrive Dragon change is effective since 2026-11-11.
// Updating this list is an explicit resource/version change, never deck metadata.
export const AUTO_TCG_BANLIST = Object.freeze({
  id: 'tcg-2026-10-19', format: 'tcg-advanced', effectiveDate: '2026-10-19',
  verifiedAt: '2026-11-17',
  officialUrl: 'https://www.yugioh-card.com/en/limited/list_2026-10-19/',
  sourceUrl: 'https://raw.githubusercontent.com/ProjectIgnis/LFLists/38d6ca4752a224f4157ee982f3d765d7ec0c9425/0TCG.lflist.conf',
  sourceRevision: '38d6ca4752a224f4157ee982f3d765d7ec0c9425',
  sourceSha256: '24a78cae14a067b41b1aa669011ae725e4a7c0bacfbcdf6aba5bf9dfcced128c',
});

const LIMIT_GROUPS = {
  0: [21044178, 28143384, 62320425, 87746184, 13332685, 69072185, 32687071, 58921041, 4280258, 4280259, 43262273, 59509952, 6728559, 80237445, 20292186, 46396218, 440556, 84815190, 19740112, 47961808, 73356503, 10963799, 27552504, 34408491, 9929398, 94689206, 27548199, 1041278, 69243953, 24224830, 57953380, 3040496, 27519978, 60682203, 17375316, 50277355, 65681983, 50954680, 50588353, 31603289, 98095162, 3685372, 69015963, 79559912, 15341821, 44763025, 23557835, 91800273, 83326048, 8903700, 51858306, 59581480, 38273745, 33158448, 78706415, 93369354, 42009836, 42703248, 55204071, 53334471, 79571449, 75732622, 59537380, 86148577, 87639778, 19613556, 24094258, 79606837, 62242678, 61740673, 59934749, 41855169, 35059553, 48626373, 25926710, 17209452, 11398059, 39064822, 65330383, 3679218, 47960073, 28566710, 85602018, 34086406, 57421866, 30342076, 85243784, 34206604, 97631303, 95454996, 34906152, 23434538, 44097050, 71818935, 76375976, 33198837, 61049315, 54719828, 90590303, 10389142, 66011101, 35772782, 63504681, 95474755, 58820923, 52653092, 89023486, 34945480, 74191942, 90884403, 23099524, 23558733, 55144522, 25725326, 70369116, 58036229, 74586817, 23002292, 37818794, 34989413, 27174286, 90846359, 1357146, 93016201, 91258852, 74997493, 68462976, 57585212, 72330894, 3280747, 63789924, 54447022, 84636823, 59859086, 27381364, 23516703, 33918636, 43387895, 92731385, 63101919, 24207889, 42829885, 88071625, 22593417, 64697231, 25311006, 52687916, 88581108, 80604091, 80604092, 83152482, 5851097, 70636044, 44910027, 16923472, 52352005, 7594154, 85115440],
  1: [80181649, 76794549, 85106525, 44362883, 36637374, 29948294, 7394770, 6637331, 33854624, 72892473, 59750328, 91623717, 99266988, 67616300, 31425736, 581014, 15854426, 7375867, 94145021, 33396948, 34022970, 55623480, 46640168, 95308449, 81439173, 27970830, 39512984, 75500286, 97462632, 18144506, 66957584, 1845204, 93946239, 28642461, 63542003, 6153210, 7902349, 44519536, 41999284, 32061192, 69272449, 32723153, 71650854, 36521307, 38572779, 43040603, 83764718, 83764719, 99937011, 3734202, 75433814, 69170557, 72537897, 33782437, 2295440, 13203964, 80453041, 84211599, 25661743, 38814750, 67115133, 32548318, 58577036, 32807846, 70903634, 8124921, 34909328, 66730191, 30336082, 24940422, 73468603, 82732705, 52340444, 71344451, 41420027, 73539069, 20663556, 61665245, 93896655, 65563871, 56910167, 99243014, 90953320, 37961969, 74078255, 572850, 91810826, 73628505, 11110587, 91500017, 89997728, 93156774, 30581601, 78872731],
  2: [33760966, 75003700, 8633261, 68337209, 21347668, 63166095, 35844557],
};
export const AUTO_TCG_LIMITS = Object.freeze(Object.fromEntries(
  Object.entries(LIMIT_GROUPS).flatMap(([limit, codes]) => codes.map(code => [code, Number(limit)])),
));
const EXTRA_TYPES = T.FUSION | T.SYNCHRO | T.XYZ | T.LINK;
const SCRIPT_TYPES = T.EFFECT | T.SPELL | T.TRAP | T.PENDULUM | EXTRA_TYPES;
const KNOWN_TYPES = Object.values(T).reduce((mask, flag) => mask | flag, 0);

function failure(code, message) { const error = new Error(message); error.code = code; error.status = 400; throw error; }
function cardCode(value) {
  if (typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) failure('invalid_card', 'Codice carta non valido.');
  return value;
}

function normalizeDeck(deck) {
  if (!deck || typeof deck !== 'object' || Array.isArray(deck)) failure('invalid_deck', 'Scegli un mazzo salvato.');
  const result = {id: String(deck.id || '').slice(0, 100), name: String(deck.name || 'Mazzo').slice(0, 160), main: [], extra: [], side: []};
  if (Array.isArray(deck.main)) {
    for (const section of ['main', 'extra', 'side']) {
      if (deck[section] !== undefined && !Array.isArray(deck[section])) failure('invalid_deck', 'Sezione del mazzo non valida.');
      if ((deck[section]?.length || 0) > (section === 'main' ? 60 : 15)) failure('invalid_deck', 'Servono 40–60 carte Main, massimo 15 Extra e 15 Side.');
      result[section] = (deck[section] || []).map(cardCode);
    }
  } else if (Array.isArray(deck.cards)) {
    if (deck.cards.length > 90) failure('invalid_deck', 'Il mazzo contiene troppe voci.');
    for (const card of deck.cards) {
      const section = card?.section || 'main', quantity = Number(card?.quantity ?? 1);
      if (!['main', 'extra', 'side'].includes(section) || !Number.isInteger(quantity) || quantity < 1 || quantity > 3) failure('invalid_deck', 'Quantità o sezione del mazzo non valida.');
      const code = cardCode(card?.catalogCardId ?? card?.code);
      for (let index = 0; index < quantity; index++) result[section].push(code);
    }
  } else failure('invalid_deck', 'Il mazzo non contiene carte.');
  if (result.main.length < 40 || result.main.length > 60 || result.extra.length > 15 || result.side.length > 15) failure('invalid_deck', 'Servono 40–60 carte Main, massimo 15 Extra e 15 Side.');
  return result;
}

function canonicalAlias(card, cards) {
  const seen = new Set([card.code]);
  while (card.alias) {
    if (seen.has(card.alias)) failure('unsupported_card', 'Alias carta non valido nel database del motore.');
    seen.add(card.alias);
    const next = cards.get(card.alias);
    if (!next) return card.alias;
    card = next;
  }
  return card.code;
}

export function validateAutoDeck(deck, resources) {
  if (!(resources?.cards instanceof Map) || !(resources?.scripts instanceof Map)) failure('unsupported_card', 'Risorse del motore non disponibili.');
  const result = normalizeDeck(deck), counts = new Map(), limits = new Map();
  for (const section of ['main', 'extra', 'side']) for (const code of result[section]) {
    const card = resources.cards.get(code);
    if (!card) failure('unsupported_card', `Carta ${code} non presente nel motore automatico.`);
    const label = card.name || code, type = card.type;
    // Ignis scope bit 2 is TCG; values above 3 include prerelease, Rush,
    // anime/custom/skill scopes. Never trust a saved card's legality fields.
    if (!Number.isInteger(card.ot) || card.ot < 1 || card.ot > 3 || !(card.ot & 2)) failure('illegal_tcg_card', `${label} non è una carta TCG pubblicata nel database selezionato.`);
    if (!Number.isInteger(type) || type < 1 || (type & ~KNOWN_TYPES) || (type & (T.TOKEN | T.MAXIMUM)) || ![1, 2, 4].includes(type & 7)) failure('illegal_tcg_card', `${label} non può essere inclusa in un mazzo TCG standard.`);
    const isExtra = !!((type & T.MONSTER) && (type & EXTRA_TYPES));
    if ((section === 'main' && isExtra) || (section === 'extra' && !isExtra)) failure('invalid_deck', `Sezione non valida per ${label}.`);
    const alias = canonicalAlias(card, resources.cards), count = (counts.get(alias) || 0) + 1;
    counts.set(alias, count);
    const allowed = Math.min(limits.get(alias) ?? 3, AUTO_TCG_LIMITS[alias] ?? 3, AUTO_TCG_LIMITS[code] ?? 3);
    limits.set(alias, allowed);
    if (count > allowed) {
      if (!allowed) failure('forbidden_card', `${label} è proibita nella lista TCG del ${AUTO_TCG_BANLIST.effectiveDate}.`);
      failure(allowed === 3 ? 'invalid_deck' : 'limited_card', `Massimo ${allowed} copie di ${label} tra Main, Extra e Side (alias inclusi).`);
    }
    if ((type & SCRIPT_TYPES) && !resources.scripts.has(`c${code}.lua`) && !resources.scripts.has(`c${alias}.lua`)) failure('unsupported_script', `Script automatico non disponibile per ${label}.`);
  }
  return result;
}
