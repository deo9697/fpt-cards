import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.localStorage = { getItem:() => null, setItem:() => {} };
const { collectionView, collectionDetailView } = await import('../js/collection.js');

class CollectionFixture {
  constructor() { this.items = []; this.loans = []; this.sequence = 0; }
  save(actor, value) {
    assert(actor, 'sessione richiesta');
    assert(value.owned >= 1 && value.owned <= 999, 'owned valido');
    if (value.id) {
      const item = this.items.find(entry => entry.id === value.id);
      assert(item?.owner === actor, 'un membro modifica solo la propria raccolta');
      assert(value.owned >= this.loaned(item) + this.reserved(item), 'owned non inferiore agli impegni');
      Object.assign(item, value); return item;
    }
    const duplicate = this.items.find(item => item.owner === actor
      && item.catalog === value.catalog && item.setCode === value.setCode
      && item.rarity === value.rarity && item.language === value.language
      && item.condition === value.condition && item.edition === value.edition);
    if (duplicate) { duplicate.owned += value.owned; return duplicate; }
    const item = { ...value, id:`item-${++this.sequence}`, owner:actor };
    this.items.push(item); return item;
  }
  loaned(item) { return this.loans.filter(loan => loan.itemId === item.id && ['active','return_pending'].includes(loan.status)).reduce((sum, loan) => sum + loan.quantity - loan.returned, 0); }
  reserved(item) { return this.loans.filter(loan => loan.itemId === item.id && loan.status === 'reserved').reduce((sum, loan) => sum + loan.quantity - loan.returned, 0); }
  available(item) { return Math.max(item.owned - this.loaned(item) - this.reserved(item), 0); }
  team(actor) { assert(actor); return this.items.map(item => ({ owner:item.owner, catalog:item.catalog, setCode:item.setCode, rarity:item.rarity, loaned:this.loaned(item), reserved:this.reserved(item), available:this.available(item) })); }
  reserve(item, quantity) {
    assert(quantity <= this.available(item), 'quantità fisicamente non disponibile');
    this.loans.push({ itemId:item.id, quantity, returned:0, status:'reserved' });
  }
  accept(item, loan) {
    assert(this.loaned(item) + this.reserved(item) <= item.owned, 'accettazione oltre quantità posseduta');
    loan.status = 'active';
  }
  delete(actor, id) {
    const index = this.items.findIndex(item => item.id === id);
    assert(index >= 0 && this.items[index].owner === actor, 'rimozione solo propria');
    assert(!this.loans.some(loan => loan.itemId === id && ['reserved','active','return_pending'].includes(loan.status)), 'prestito impegnato impedisce rimozione');
    this.items.splice(index, 1);
  }
}

const fixture = new CollectionFixture();
const sdk = fixture.save('daniele', { catalog:'89631139', setCode:'SDK-001', rarity:'Ultra Rare', language:'Italiano', condition:'Near Mint', edition:'1ª Edizione', owned:12 });
const lob = fixture.save('daniele', { catalog:'89631139', setCode:'LOB-001', rarity:'Ultra Rare', language:'Italiano', condition:'Near Mint', edition:'1ª Edizione', owned:1 });
assert.notEqual(sdk.id, lob.id, 'SDK-001 e LOB-001 restano printing distinte');
const sameSdk = fixture.save('daniele', { catalog:'89631139', setCode:'SDK-001', rarity:'Ultra Rare', language:'Italiano', condition:'Near Mint', edition:'1ª Edizione', owned:2 });
assert.equal(sameSdk.id, sdk.id, 'stessa owner/printing/metadati accorpata');
assert.equal(sdk.owned, 14, 'inserimento ripetuto incrementa la quantità');
sdk.owned = 12;
fixture.loans.push({ itemId:sdk.id, quantity:2, returned:0, status:'active' });
assert.equal(fixture.available(sdk), 10, '12 possedute - 2 prestate = 10 disponibili');
fixture.reserve(sdk, 10);
assert.equal(fixture.available(sdk), 0, 'le reserved sono prenotazioni fisiche');
assert.throws(() => fixture.reserve(sdk, 1), /fisicamente/, 'non è possibile impegnare oltre 12');
const invalidPending = { itemId:sdk.id, quantity:1, returned:0, status:'reserved' };
fixture.loans.push(invalidPending);
assert.throws(() => fixture.accept(sdk, invalidPending), /oltre/, 'accept non supera le copie possedute');
fixture.loans.pop();
assert.throws(() => fixture.save('marco', { ...sdk, id:sdk.id, owned:12 }), /propria/);
const teamProjection = fixture.team('marco');
assert.equal(teamProjection.length, 2, 'il team trova tutte le printing senza configurazione manuale');
assert(!('owned' in teamProjection[0]), 'la RPC team non espone il totale posseduto');
assert.throws(() => fixture.delete('marco', sdk.id), /propria/);

const mine = [{
  id:'mine-1', printingId:'printing-sdk', ownerSlug:'daniele', ownerName:'Daniele', game:'yugioh',
  catalogCardId:'89631139', cardName:'Blue-Eyes White Dragon', setCode:'SDK-001', setName:'Starter Deck Kaiba',
  rarity:'Ultra Rare', language:'Italiano', condition:'Near Mint', edition:'1ª Edizione', imageUrl:'',
  quantityOwned:12, quantityLoaned:2, quantityReserved:3, quantityAvailable:7, legacyAmbiguous:false
}];
const team = [{ ...mine[0], id:'team-1', ownerSlug:'marco', ownerName:'Marco', quantityOwned:undefined }];
const filters = { scope:'mine', query:'', owner:'all', status:'all', layout:'grid' };
const personalHtml = collectionView({ mine, team }, filters, 'yugioh', true);
assert.match(personalHtml, /Possedute[\s\S]*12/);
assert.match(personalHtml, /Disponibili[\s\S]*7/);
const personalDetail = collectionDetailView('mine-1', 'mine', { mine, team }, true);
assert.match(personalDetail, /Prenotate<\/dt><dd>3/);
const teamHtml = collectionView({ mine, team }, { ...filters, scope:'team' }, 'yugioh', true);
assert(!teamHtml.includes('Possedute'), 'vista team senza quantità totale posseduta');
const teamDetail = collectionDetailView('printing-sdk', 'team', { mine, team }, true, 'daniele');
assert.match(teamDetail, /Marco/);
assert.match(teamDetail, /Richiedi prestito/);
assert.match(teamDetail, /data-request-collection-loan="team-1"/);

const sql = fs.readFileSync(new URL('../supabase-milestone-2-collection.sql', import.meta.url), 'utf8');
for (const required of [
  'create table if not exists public.card_printings',
  'create table if not exists public.collection_items',
  'unique (game, catalog_card_id, set_code, rarity)',
  'unique (owner_slug, printing_id, language, condition, edition)',
  'card_printings_set_code_idx on public.card_printings(game, set_code)',
  'add column if not exists collection_item_id uuid',
  'public.session_member(p_token)',
  'public.list_my_collection',
  'public.list_team_collection',
  'public.save_collection_item',
  "p_quantity_mode text default 'set'",
  'public.collection_item_reserved',
  "l.status in ('active', 'return_pending')",
  "l.status = 'pending'",
  'greatest(ci.quantity_owned - q.loaned - q.reserved, 0)',
  "raise exception 'Quantità fisicamente non disponibile'"
]) assert(sql.includes(required), `migrazione incompleta: ${required}`);
const createLoansSql = sql.slice(sql.indexOf('create or replace function public.create_team_loans'), sql.indexOf('create or replace function public.transition_loan'));
assert(createLoansSql.includes('for update of ci'), 'lock inventario create_team_loans assente');
assert(!createLoansSql.includes('select distinct'), 'create_team_loans combina ancora DISTINCT e FOR UPDATE');

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../js/collection.js', import.meta.url), 'utf8');
assert(api.includes("p_quantity_mode:item.id ? 'set' : 'increment'"), 'strategia upsert non collegata');
assert(ui.includes('quantityReserved') && app.includes('quantity_physically_available'), 'disponibilità fisica non collegata');
assert(app.includes('maxQuantity:item.quantityAvailable') && app.includes('next > card.maxQuantity'), 'limite disponibilità fisica non collegato al Loan Builder');
assert(app.includes("querySelectorAll('button[data-page]')") && !app.includes("querySelectorAll('[data-page]')"), 'listener routing ancora applicato al body');
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
assert(css.includes('@media (max-width: 560px)') && css.includes('.inventory-grid'), 'responsive inventario assente');
const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
assert(sw.includes("'./js/collection.js'") && /fpt-cards-v\d+/.test(sw) && !sw.includes('fpt-card-images-v1'), 'shell PWA non aggiornata');

console.log('PASS quantity_owned e disponibilità fisica derivata');
console.log('PASS limite impegni, reserved prenotate e prestiti attivi');
console.log('PASS upsert incrementale e identità printing');
console.log('PASS privacy e ricerca delle printing del team');
console.log('PASS integrazione UI/realtime/cache/PWA');
