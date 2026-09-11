// Verifica offline del normalizer OPTCG (nessuna rete, nessun DB): prova che
// gli esempi reali citati nel piano Fase 3 (OP01-001, P-017, EB01-003,
// don_183) restano printing distinte dopo la normalizzazione, invece di
// collassare regular/parallel/alt-art/DON sotto la stessa identità.
// Esegui: node scripts/onepiece-catalog-normalizer-smoke.mjs
import assert from 'node:assert/strict';
import {
  deriveSetCode, normalizeColorList, normalizeTraits, cleanNumber, extractTrigger,
  normalizeStandardCard, normalizeDonCard, identityKey, resolveVariantCollisions, imageMatchesCode
} from '../supabase/functions/onepiece-catalog-sync/normalizer.mjs';

const NOW = '2026-09-08T00:00:00.000Z';

// -- set_code derivato dal card number, non da set_id (OP-01 con trattino) --
assert.equal(deriveSetCode('OP01-016'), 'OP01');
assert.equal(deriveSetCode('ST04-016'), 'ST04');
assert.equal(deriveSetCode('EB01-003'), 'EB01');
assert.equal(deriveSetCode('P-017'), 'P');
console.log('PASS set_code derivato dal prefisso del card number');

// -- colori/traits sempre array, separatore / o , --
assert.deepEqual(normalizeColorList('Red'), ['Red']);
assert.deepEqual(normalizeColorList('Red/Green'), ['Red', 'Green']);
assert.deepEqual(normalizeColorList('Red, Green'), ['Red', 'Green']);
assert.deepEqual(normalizeColorList(''), []);
assert.deepEqual(normalizeTraits('Straw Hat Crew/Animal'), ['Straw Hat Crew', 'Animal']);
console.log('PASS colori e traits normalizzati come array');

// -- numeri tollerante: mai un reject, solo il campo torna null --
assert.equal(cleanNumber('2000'), 2000);
assert.equal(cleanNumber(2000), 2000);
assert.equal(cleanNumber(''), null);
assert.equal(cleanNumber(null), null);
assert.equal(cleanNumber(undefined), null);
assert.equal(cleanNumber('N/A'), null);
assert.equal(cleanNumber('-'), null);
console.log('PASS cleanNumber non scarta mai la carta per un campo numerico mancante/sporco');

// -- [Trigger] estratto solo se presente nel card_text --
assert.equal(extractTrigger('[Trigger] Draw 1 card.'), 'Draw 1 card.');
assert.equal(extractTrigger('On Play Rest up to 1 of your opponent\'s Characters.'), '');
assert.equal(extractTrigger(''), '');
console.log('PASS estrazione [Trigger] solo quando presente nel testo');

// -- OP01-001 regular vs OP01-001_p1 alt art: stesso catalog_card_id, --
// -- variant_id diverso, quindi identity_key diversa. --
const op01RegularRaw = { card_set_id: 'OP01-001', card_image_id: 'OP01-001', card_name: 'Monkey.D.Luffy', card_color: 'Red', card_type: 'Leader', rarity: 'L', set_name: 'Romance Dawn', card_image: 'https://example.test/op01-001.png' };
const op01AltRaw = { ...op01RegularRaw, card_image_id: 'OP01-001_p1' };
const op01Regular = normalizeStandardCard(op01RegularRaw, NOW);
const op01Alt = normalizeStandardCard(op01AltRaw, NOW);
assert.equal(op01Regular.catalog_card_id, 'OP01-001');
assert.equal(op01Regular.variant_id, 'OP01-001');
assert.equal(op01Regular.set_code, 'OP01');
assert.equal(op01Alt.catalog_card_id, 'OP01-001');
assert.equal(op01Alt.variant_id, 'OP01-001_p1');
assert.notEqual(identityKey(op01Regular), identityKey(op01Alt), 'regular e alt art non devono collassare sulla stessa identità');
console.log('PASS OP01-001 regular e OP01-001_p1 restano printing distinte');

// -- P-017 promo regular vs P-017_pr1: set_code condiviso 'P', non un set --
// -- diverso per ogni singolo numero di promo. --
const promoRegularRaw = { card_set_id: 'P-017', card_image_id: 'P-017', set_id: 'P', set_name: 'One Piece Promotion Cards', card_name: 'Nami', rarity: 'PR', card_image: 'https://example.test/p-017.png' };
const promoAltRaw = { ...promoRegularRaw, card_image_id: 'P-017_pr1' };
const promoRegular = normalizeStandardCard(promoRegularRaw, NOW);
const promoAlt = normalizeStandardCard(promoAltRaw, NOW);
assert.equal(promoRegular.set_code, 'P');
assert.equal(promoRegular.set_name, 'One Piece Promotion Cards');
assert.equal(promoAlt.variant_id, 'P-017_pr1');
assert.notEqual(identityKey(promoRegular), identityKey(promoAlt));
// set_name mancante dall'API per un promo: fallback al nome unificato, non stringa vuota.
const promoNoSetName = normalizeStandardCard({ ...promoRegularRaw, set_name: '' }, NOW);
assert.equal(promoNoSetName.set_name, 'One Piece Promotion Cards');
console.log('PASS promo P-017/P-017_pr1 condividono un unico set_code senza collassare la printing');

// -- EB01-003 / EB01-003_pr2 (Extra Booster) --
const eb01RegularRaw = { card_set_id: 'EB01-003', card_image_id: 'EB01-003', card_name: 'Trafalgar Law', rarity: 'SR', set_name: 'Memorial Collection' };
const eb01AltRaw = { ...eb01RegularRaw, card_image_id: 'EB01-003_pr2' };
const eb01Regular = normalizeStandardCard(eb01RegularRaw, NOW);
const eb01Alt = normalizeStandardCard(eb01AltRaw, NOW);
assert.equal(eb01Regular.set_code, 'EB01');
assert.notEqual(identityKey(eb01Regular), identityKey(eb01Alt));
console.log('PASS EB01-003/EB01-003_pr2 restano printing distinte');

// -- DON!! (don_183): niente card_set_id/set_id nel payload reale --
const donRaw = { card_image_id: 'don_183', card_name: 'DON!! Card (Egghead)', card_text: 'Your Turn +1000', rarity: 'DON!!', card_type: 'DON!!', card_image: 'https://example.test/don-183.png' };
const don = normalizeDonCard(donRaw, NOW);
assert.equal(don.catalog_card_id, 'don_183');
assert.equal(don.variant_id, 'don_183');
assert.equal(don.set_code, 'DON');
console.log('PASS DON!! (don_183) normalizzato con set_code fisso e identità propria');

// -- Due don_id diversi non devono mai collassare sulla stessa riga. --
const donOther = normalizeDonCard({ ...donRaw, card_image_id: 'don_1', card_name: 'DON!! Card' }, NOW);
assert.notEqual(identityKey(don), identityKey(donOther));
console.log('PASS due carte DON!! diverse restano identità separate');

// -- Record senza identità utilizzabile viene scartato (skipped), non --
// -- inserito con dati vuoti. --
assert.equal(normalizeStandardCard({ card_set_id: '', card_name: 'Senza ID' }, NOW), null);
assert.equal(normalizeStandardCard({ card_set_id: 'OP01-999', card_name: '' }, NOW), null);
assert.equal(normalizeDonCard({ card_image_id: '', card_name: 'Senza ID' }, NOW), null);
console.log('PASS carte senza catalog_card_id o card_name vengono scartate, non salvate vuote');

// -- Stesso raw record normalizzato due volte (simula la stessa carta --
// -- comparsa sia in allSetCards sia in allPromos, Fase 3.9): stessa --
// -- identity_key, quindi il dedupe locale la collassa correttamente in --
// -- una singola riga upsert invece di farla arrivare due volte nello --
// -- stesso batch (che Postgres rifiuterebbe). --
const duplicateA = normalizeStandardCard(op01RegularRaw, NOW);
const duplicateB = normalizeStandardCard({ ...op01RegularRaw }, NOW);
assert.equal(identityKey(duplicateA), identityKey(duplicateB));
assert.deepEqual(duplicateA, duplicateB);
console.log('PASS stesso raw normalizzato due volte produce la stessa identity_key (dedupe sicuro)');

// -- resolveVariantCollisions: bug reale segnalato dall'utente 2026-09-10 --
// -- ("codice di Hawkins mostra l'immagine di un'altra carta") — OPTCG --
// -- riusa lo stesso card_image_id per ristampe promo/torneo che sono --
// -- carte diverse (nome/immagine diversi). Esempio reale confermato --
// -- dal vivo su optcgapi.com: Otama base vs "Otama (Online Regional --
// -- 2023) [Winner]", entrambe card_set_id=OP01-006, card_image_id= --
// -- OP01-006, stessa rarity — senza il fix collasserebbero sulla --
// -- stessa identity key e l'upsert ne perderebbe una a caso.
const otamaBaseRaw = { card_set_id: 'OP01-006', card_image_id: 'OP01-006', card_name: 'Otama', card_color: 'Red', card_type: 'Character', rarity: 'C', set_name: 'Romance Dawn', card_image: 'https://optcgapi.com/media/static/Card_Images/OP01-006.jpg' };
const otamaWinnerRaw = { ...otamaBaseRaw, card_name: 'Otama (Online Regional 2023) [Winner]', card_image: 'https://optcgapi.com/media/static/Card_Images/Otama_Online_Regional_2023_Winner_img.jpg' };
const otamaBase = normalizeStandardCard(otamaBaseRaw, NOW);
const otamaWinner = normalizeStandardCard(otamaWinnerRaw, NOW);
assert.equal(identityKey(otamaBase), identityKey(otamaWinner), 'prima del fix le due righe devono collidere, altrimenti il test non prova nulla');
const otamaFixed = [normalizeStandardCard(otamaBaseRaw, NOW), normalizeStandardCard(otamaWinnerRaw, NOW)];
resolveVariantCollisions(otamaFixed);
assert.notEqual(identityKey(otamaFixed[0]), identityKey(otamaFixed[1]), 'dopo il fix le due Otama devono restare printing distinte');
assert.equal(otamaFixed[0].card_name, 'Otama');
assert.equal(otamaFixed[1].card_name, 'Otama (Online Regional 2023) [Winner]');
console.log('PASS resolveVariantCollisions separa Otama base e la ristampa "Online Regional 2023 Winner"');

// -- Stessa collisione ma con card_image VUOTO sul lato promo (capita --
// -- davvero su OPTCG per alcune ristampe non ancora fotografate): deve --
// -- comunque disambiguare usando il card_name, non lasciarle collise. --
const momoBaseRaw = { card_set_id: 'OP01-041', card_image_id: 'OP01-041', card_name: 'Kouzuki Momonosuke', rarity: 'R', card_image: 'https://optcgapi.com/media/static/Card_Images/OP01-041.jpg' };
const momoPromoRaw = { ...momoBaseRaw, card_name: 'Kouzuki Momonosuke (CS 2024 Celebration Pack)', card_image: '' };
const momoRows = [normalizeStandardCard(momoBaseRaw, NOW), normalizeStandardCard(momoPromoRaw, NOW)];
resolveVariantCollisions(momoRows);
assert.notEqual(identityKey(momoRows[0]), identityKey(momoRows[1]), 'senza immagine sul lato promo, deve disambiguare comunque dal card_name');
console.log('PASS resolveVariantCollisions disambigua anche quando la ristampa non ha ancora un\'immagine');

// -- Righe che condividono variant_id ma sono davvero la stessa carta --
// -- (stesso card_name, es. presente sia in allSetCards sia in allSTCards) --
// -- non vanno toccate: non è una collisione, è un duplicato legittimo. --
const dupRows = [normalizeStandardCard(op01RegularRaw, NOW), normalizeStandardCard({ ...op01RegularRaw }, NOW)];
resolveVariantCollisions(dupRows);
assert.equal(identityKey(dupRows[0]), identityKey(dupRows[1]));
console.log('PASS resolveVariantCollisions non tocca righe realmente duplicate (stesso nome)');

// -- Righe SENZA nessuna collisione restano byte-per-byte identiche: il --
// -- fix non deve introdurre drift di variant_id per le migliaia di --
// -- righe già pulite, altrimenti ogni sync ne creerebbe duplicati --
// -- fantasma nel DB (mai una delete, vedi index.ts). --
const untouchedRows = [normalizeStandardCard(op01RegularRaw, NOW), normalizeStandardCard(op01AltRaw, NOW)];
const untouchedBefore = JSON.stringify(untouchedRows);
resolveVariantCollisions(untouchedRows);
assert.equal(JSON.stringify(untouchedRows), untouchedBefore, 'righe non in collisione non devono cambiare variant_id');
console.log('PASS resolveVariantCollisions lascia intatte le righe che non collidono con nessun\'altra');

// -- Caso Hawkins (bug reale segnalato dall'utente 2026-09-10): OPTCG manda --
// -- una printing (es. "OP10-109") con card_image che punta all'immagine --
// -- di UN'ALTRA carta già distinta (es. "OP10-103") — non una collisione --
// -- di identity key come Otama sopra, due catalog_card_id già separati. --
// -- Prima del fix quell'immagine sbagliata sarebbe stata scritta così --
// -- com'è; ora normalizeStandardCard deve azzerarla e tenere traccia del --
// -- valore grezzo per un audit futuro, senza scartare la riga. --
const hawkinsRaw = { card_set_id: 'OP10-109', card_image_id: 'OP10-109', card_name: 'Hawkins', card_color: 'Purple', card_type: 'Character', rarity: 'R', set_name: 'One Piece the Best', card_image: 'https://optcgapi.com/media/static/Card_Images/OP10-103.jpg' };
const hawkins = normalizeStandardCard(hawkinsRaw, NOW);
assert.equal(hawkins.catalog_card_id, 'OP10-109', 'la riga non deve essere scartata, solo l\'immagine ripulita');
assert.equal(hawkins.image_url, '', 'immagine cross-code non deve mai essere scritta su card_printings');
assert.equal(hawkins.game_metadata.rawSuspectImageUrl, 'https://optcgapi.com/media/static/Card_Images/OP10-103.jpg', 'il valore grezzo va conservato per l\'audit, non perso');
console.log('PASS caso Hawkins: immagine cross-code (OP10-109 con URL di OP10-103) azzerata, non mostrata');

// -- Un'immagine coerente con la propria carta non deve mai essere toccata, --
// -- alt-art compresa (suffisso dopo il codice). --
const hawkinsOk = normalizeStandardCard({ ...hawkinsRaw, card_image: 'https://optcgapi.com/media/static/Card_Images/OP10-109.jpg' }, NOW);
assert.equal(hawkinsOk.image_url, 'https://optcgapi.com/media/static/Card_Images/OP10-109.jpg');
assert.equal(hawkinsOk.game_metadata.rawSuspectImageUrl, undefined);
const hawkinsAltArt = normalizeStandardCard({ ...hawkinsRaw, card_image: 'https://optcgapi.com/media/static/Card_Images/OP10-109_p1.jpg' }, NOW);
assert.equal(hawkinsAltArt.image_url, 'https://optcgapi.com/media/static/Card_Images/OP10-109_p1.jpg', 'suffisso alt-art dopo il codice corretto non deve essere trattato come cross-code');
console.log('PASS immagini coerenti (base e alt-art) non vengono mai toccate dal controllo cross-code');

// -- Un filename senza forma di codice (slug nome, hash CDN) non è --
// -- classificabile da questa regola: non blocca l'immagine solo perché --
// -- il nome del file è insolito, esattamente come per Otama sopra. --
const hawkinsUnclassifiable = normalizeStandardCard({ ...hawkinsRaw, card_image: 'https://optcgapi.com/media/static/Card_Images/Hawkins_Alt_Art_img.jpg' }, NOW);
assert.equal(hawkinsUnclassifiable.image_url, 'https://optcgapi.com/media/static/Card_Images/Hawkins_Alt_Art_img.jpg', 'filename non a forma di codice non deve essere azzerato');
console.log('PASS filename non a forma di codice (slug/hash) non viene bloccato dal controllo cross-code');

// -- DON!!: stessa regola, separatore "_" o "-" tollerato (non confermato --
// -- dal vivo quale dei due OPTCG usa davvero per le immagini DON). --
assert.equal(imageMatchesCode('don_183', 'https://example.test/don_183.png'), true);
assert.equal(imageMatchesCode('don_183', 'https://example.test/don-183.png'), true);
assert.equal(imageMatchesCode('don_183', 'https://example.test/don_1.png'), false, 'don_1 non deve combaciare con don_183');
console.log('PASS controllo cross-code DON!! tollera sia "_" che "-" come separatore');

console.log('\nTutti i controlli del normalizer One Piece sono passati.');
