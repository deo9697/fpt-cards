const configured = Boolean(window.FPT_CONFIG?.supabaseUrl && window.FPT_CONFIG?.supabaseKey);
const client = configured ? window.supabase.createClient(window.FPT_CONFIG.supabaseUrl, window.FPT_CONFIG.supabaseKey) : null;
const TOKEN_KEY = 'fpt-cards-session-token';
let realtimeChannel;
let collectionChannel;

function token() {
  let value = localStorage.getItem(TOKEN_KEY);
  if (!value) { value = `${crypto.randomUUID()}${crypto.randomUUID()}`; localStorage.setItem(TOKEN_KEY, value); }
  return value;
}
function ensure() { if (!client) throw new Error('Supabase non configurato'); }
function unwrap(result) { if (result.error) throw result.error; return result.data; }

export const api = {
  configured,
  async members() { ensure(); return unwrap(await client.rpc('list_login_members')); },
  async login(slug, pin) { ensure(); return unwrap(await client.rpc('login_member', { p_slug:slug, p_pin:pin, p_token:token() })); },
  async logout() { if (client) await client.rpc('logout_member', { p_token:token() }); localStorage.removeItem(TOKEN_KEY); },
  async loans() { ensure(); return unwrap(await client.rpc('list_team_loans', { p_token:token() })); },
  async myCollection() { ensure(); return unwrap(await client.rpc('list_my_collection', { p_token:token() })); },
  async teamCollection() { ensure(); return unwrap(await client.rpc('list_team_collection', { p_token:token() })); },
  async decks() { ensure(); const args={p_token:token()},result=await client.rpc('list_my_decks_with_boxes',args);if(!result.error)return result.data;if(!['PGRST202','42883'].includes(result.error.code))throw result.error;return unwrap(await client.rpc('list_my_decks',args)); },
  async saveDeck(deck) {
    ensure();
    const id=/^[0-9a-f-]{36}$/i.test(String(deck.id||''))?deck.id:null;
    const args={p_token:token(),p_deck:{id,name:deck.name,game:deck.game,format:deck.format,signatureCardId:deck.signatureCardId||null,deckTheme:deck.deckTheme||'arcane-purple',deckBoxTemplate:deck.deckBoxTemplate||'procedural',cards:deck.cards}},result=await client.rpc('save_deck_with_box',args);
    if(!result.error)return result.data;if(!['PGRST202','42883'].includes(result.error.code))throw result.error;return {id:unwrap(await client.rpc('save_deck',args)),deckBoxPersisted:false};
  },
  async deleteDeck(id) { ensure(); return unwrap(await client.rpc('delete_deck', { p_token:token(),p_id:id })); },
  async deckPrintingOptions(deckId, catalogCardId) {
    ensure(); return unwrap(await client.rpc('list_deck_printing_options', { p_token:token(),p_deck_id:deckId,p_catalog_card_id:String(catalogCardId) }));
  },
  async setDeckCardPrinting(deckId, catalogCardId, section, printingId) {
    ensure(); return unwrap(await client.rpc('set_deck_card_printing', { p_token:token(),p_deck_id:deckId,p_catalog_card_id:String(catalogCardId),p_section:section,p_printing_id:printingId }));
  },
  async marketWatch(game = 'yugioh') {
    ensure(); return unwrap(await client.rpc('list_market_watch', { p_token:token(),p_game:game }));
  },
  async marketDashboardMovers(game = 'yugioh') {
    ensure(); return unwrap(await client.rpc('list_market_dashboard_movers', { p_token:token(),p_game:game }));
  },
  async marketPriceHistory(printingId, days = 30) {
    ensure(); return unwrap(await client.rpc('list_market_price_history', { p_token:token(),p_printing_id:printingId,p_days:days }));
  },
  async setMarketWatchItem(printingId, enabled) {
    ensure(); return unwrap(await client.rpc('set_market_watch_item', { p_token:token(),p_printing_id:printingId,p_enabled:Boolean(enabled) }));
  },
  async lookupPrintings(setCode, game = 'yugioh') {
    ensure(); return unwrap(await client.rpc('lookup_card_printings_by_set_code', { p_token:token(),p_game:game,p_set_code:setCode }));
  },
  async saveCollectionBatch(items) {
    ensure(); return unwrap(await client.rpc('save_collection_batch', { p_token:token(),p_items:items }));
  },
  async saveFastScanChunk(batchId, chunkId, batchPayloadHash, payloadHash, totalChunks, items) {
    ensure(); return unwrap(await client.rpc('save_fast_scan_chunk', {
      p_token:token(),p_scan_batch_id:batchId,p_chunk_id:chunkId,p_batch_payload_hash:batchPayloadHash,p_payload_hash:payloadHash,p_total_chunks:totalChunks,p_items:items
    }));
  },
  async saveCollection(item) {
    ensure();
    return unwrap(await client.rpc('save_collection_item', {
      p_token:token(), p_id:item.id || null, p_game:item.game,
      p_catalog_card_id:String(item.catalogCardId), p_card_name:item.cardName,
      p_set_code:item.setCode || '', p_set_name:item.setName || '', p_rarity:item.rarity || '',
      p_language:item.language, p_condition:item.condition, p_edition:item.edition || '',
      p_image_url:item.imageUrl || '', p_quantity_owned:item.quantityOwned,
      p_quantity_mode:item.id ? 'set' : 'increment'
    }));
  },
  async catalogVerificationQueue(version) {
    ensure(); return unwrap(await client.rpc('list_collection_catalog_verification_queue', {
      p_token:token(), p_verification_version:version
    }));
  },
  async repairCollectionCatalogIdentity(item) {
    ensure(); return unwrap(await client.rpc('repair_collection_item_catalog_identity', {
      p_token:token(), p_collection_item_id:item.collectionItemId,
      p_catalog_card_id:String(item.catalogCardId), p_card_name:item.cardName,
      p_image_url:item.imageUrl || '', p_verification_version:item.verificationVersion
    }));
  },
  async correctCollectionPrinting(item) {
    ensure(); return unwrap(await client.rpc('correct_collection_item_printing', {
      p_token:token(), p_collection_item_id:item.collectionItemId,
      p_catalog_card_id:String(item.catalogCardId), p_card_name:item.cardName,
      p_set_code:item.setCode || '', p_set_name:item.setName || '',
      p_rarity:item.rarity || '', p_image_url:item.imageUrl || '',
      p_edition:item.edition || '', p_verification_version:item.verificationVersion
    }));
  },
  async deleteCollection(id) {
    ensure(); return unwrap(await client.rpc('delete_collection_item', { p_token:token(), p_id:id }));
  },
  async requestCollectionLoan(collectionItemId, quantity, notes = '') {
    ensure();
    return unwrap(await client.rpc('request_collection_loan', {
      p_token:token(), p_collection_item_id:collectionItemId, p_quantity:quantity, p_notes:notes
    }));
  },
  async respondCollectionLoan(id, action, quantity = null) {
    ensure();
    return unwrap(await client.rpc('respond_collection_loan', {
      p_token:token(), p_id:id, p_action:action, p_quantity:quantity
    }));
  },
  async create(cardName, quantity, borrower, notes) {
    ensure(); return unwrap(await client.rpc('create_team_loan', { p_token:token(), p_card_name:cardName, p_quantity:quantity, p_borrower_slug:borrower, p_notes:notes }));
  },
  async createMany(cards, borrower, notes, game) {
    ensure(); return unwrap(await client.rpc('create_team_loans', { p_token:token(), p_cards:cards.map(c => ({ name:c.name, quantity:c.quantity, image:c.image || '', externalId:c.id || '', collectionItemId:c.collectionItemId || '' })), p_borrower_slug:borrower, p_notes:notes, p_game:game }));
  },
  async enrichLoan(id, card) {
    ensure(); return unwrap(await client.rpc('enrich_loan_card', { p_token:token(), p_id:id, p_external_id:card.id, p_image:card.fullImage || card.image }));
  },
  async manageMember(action, slug, name = null) {
    ensure(); return unwrap(await client.rpc('admin_manage_member', { p_token:token(), p_action:action, p_slug:slug, p_name:name }));
  },
  async returnQuantity(id, quantity) {
    ensure(); return unwrap(await client.rpc('return_loan_quantity', { p_token:token(), p_id:id, p_quantity:quantity }));
  },
  async savePushSubscription(subscription) {
    ensure();
    return unwrap(await client.rpc('save_push_subscription', {
      p_token:token(), p_endpoint:subscription.endpoint,
      p_p256dh:subscription.keys?.p256dh, p_auth:subscription.keys?.auth
    }));
  },
  subscribe(callback, collectionCallback = callback) {
    ensure();
    if (realtimeChannel) client.removeChannel(realtimeChannel);
    if (collectionChannel) client.removeChannel(collectionChannel);
    realtimeChannel = client.channel('fpt-loans')
      .on('broadcast', { event:'loans_changed' }, callback)
      .subscribe();
    collectionChannel = client.channel('fpt-collection')
      .on('broadcast', { event:'collection_changed' }, collectionCallback)
      .subscribe();
  },
  unsubscribe() {
    if (realtimeChannel) client.removeChannel(realtimeChannel);
    if (collectionChannel) client.removeChannel(collectionChannel);
    realtimeChannel = null;
    collectionChannel = null;
  },
  async transition(id, action) { ensure(); unwrap(await client.rpc('transition_loan', { p_token:token(), p_id:id, p_action:action })); }
};
