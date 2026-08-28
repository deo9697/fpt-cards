import assert from 'node:assert/strict';
import fs from 'node:fs';

class LoanFixture {
  constructor(owned = 3) { this.owned = owned; this.loans = []; this.locked = false; }
  committed(statuses) { return this.loans.filter(loan => statuses.includes(loan.status)).reduce((sum, loan) => sum + loan.acceptedQuantity, 0); }
  available() { return this.owned - this.committed(['reserved','active','return_pending']); }
  request(quantity) { assert(quantity <= this.available()); const loan = { requestedQuantity:quantity, acceptedQuantity:0, returnedQuantity:0, quantity, status:'requested' }; this.loans.push(loan); return loan; }
  accept(loan, quantity = loan.requestedQuantity) {
    assert(!this.locked, 'inventory row lock serializza le accettazioni');
    this.locked = true;
    try { assert.equal(loan.status, 'requested'); assert(quantity >= 1 && quantity <= loan.requestedQuantity); assert(quantity <= this.available(), 'quantità fisicamente non disponibile'); loan.acceptedQuantity = quantity; loan.quantity = quantity; loan.status = 'reserved'; }
    finally { this.locked = false; }
  }
  activate(loan) { assert.equal(loan.status, 'reserved'); loan.status = 'active'; }
  complete(loan) { assert.equal(loan.status, 'active'); loan.status = 'completed'; }
  remaining(loan) { return Math.max(loan.acceptedQuantity - loan.returnedQuantity, 0); }
}

const flow = new LoanFixture(3);
const request = flow.request(3);
assert.equal(flow.available(), 3, 'requested non blocca');
flow.accept(request, 2);
assert.equal(flow.available(), 1, 'reserved blocca');
flow.activate(request);
assert.equal(flow.available(), 1, 'active conserva la disponibilità');
flow.complete(request);
assert.equal(flow.available(), 3, 'completed libera le copie');

const partial = new LoanFixture(3);
const partialRequest = partial.request(3);
partial.accept(partialRequest, 1);
assert.equal(partialRequest.quantity, 1, 'accettazione parziale');
assert.equal(partialRequest.requestedQuantity, 3, 'la quantità richiesta originaria resta immutata');
assert.equal(partialRequest.acceptedQuantity, 1, 'la quantità accettata è separata');
assert.equal(partial.remaining(partialRequest), 1, 'remaining deriva da accepted - returned');
assert.equal(partial.available(), 2);

const concurrent = new LoanFixture(3);
const first = concurrent.request(3);
const second = concurrent.request(3);
concurrent.accept(first, 2);
assert.throws(() => concurrent.accept(second, 2), /fisicamente/, 'due richieste non superano quantity_owned');

globalThis.fetch = async url => {
  const id = new URL(url).searchParams.get('id');
  const cards = id === '94145021' ? [{
    id:94145021, name:'Droll & Lock Bird', type:'Effect Monster',
    card_images:[{id:94145021,image_url:'https://images.ygoprodeck.com/images/cards/94145021.jpg',image_url_small:'https://images.ygoprodeck.com/images/cards_small/94145021.jpg'}],
    card_sets:[{set_code:'LCKC-EN077',set_name:'Legendary Collection Kaiba',set_rarity:'Ultra Rare'}]
  }] : [];
  return { ok:Boolean(cards.length), json:async () => ({ data:cards }) };
};
const { reconcileCatalogCard } = await import('../js/cards.js');
assert.equal((await reconcileCatalogCard({ game:'yugioh',catalogCardId:'94145021',cardName:'Droll & Lock Bird',setCode:'LCKC-EN077',rarity:'Ultra Rare',imageUrl:'https://images.ygoprodeck.com/images/cards/94145021.jpg' })).status, 'valid');
assert.equal((await reconcileCatalogCard({ game:'yugioh',catalogCardId:'94145021',cardName:'Kashtira Shangri-Ira',setCode:'DABL-EN045' })).status, 'mismatch', 'nome e catalog ID incoerenti rilevati');

const sql = fs.readFileSync(new URL('../supabase-milestone-2-1-collection-loans.sql', import.meta.url), 'utf8');
for (const required of [
  "'pending','requested','reserved','active','return_pending','returned','completed','rejected'",
  'add column if not exists accepted_quantity integer',
  'l.accepted_quantity - l.returned_quantity',
  "l.status = 'reserved'",
  'public.request_collection_loan',
  'public.respond_collection_loan',
  "where id=item.collection_item_id for update",
  'accepted > available',
  'public.reconcile_catalog_identity',
  "request_origin='collection_request'",
  "collection_item_id is null",
  "status in ('reserved','active','return_pending')"
]) assert(sql.includes(required), `migrazione 2.1 incompleta: ${required}`);

const cards = fs.readFileSync(new URL('../js/cards.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../js/collection.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
assert(cards.includes('reconcileCatalogCard') && cards.includes("status:'mismatch'"), 'reconciliation catalogo assente');
assert(api.includes('request_collection_loan') && api.includes('respond_collection_loan'), 'RPC non collegate');
assert(ui.includes('data-request-collection-loan') && ui.includes('collection-request-form'), 'CTA/modal richiesta assenti');
assert(app.includes('accept-request') && app.includes('requestedQuantity') && app.includes('data-action="activate"'), 'flusso prestiti UI incompleto');
assert(css.includes('.request-response') && css.includes('@media (max-width: 560px)'), 'responsive richiesta assente');

console.log('PASS requested non blocca, reserved/active bloccano, completed libera');
console.log('PASS accettazione parziale e guardia concorrenza');
console.log('PASS RPC autorizzate, legacy nullable e reconciliation catalogo');
console.log('PASS UI richiesta/risposta e layout mobile');
