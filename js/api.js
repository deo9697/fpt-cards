import { pagedRpc, paginationMetrics } from './pagination.js';

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
  async memberProfiles() { ensure(); return unwrap(await client.rpc('list_member_profiles', { p_token:token() })); },
  async login(slug, pin) { ensure(); return unwrap(await client.rpc('login_member', { p_slug:slug, p_pin:pin, p_token:token() })); },
  async logout() { if (client) await client.rpc('logout_member', { p_token:token() }); localStorage.removeItem(TOKEN_KEY); },
  async loans({signal}={}) { ensure(); return pagedRpc(client,'list_team_loans',{p_token:token()},{signal,orders:[{column:'created_at'},{column:'id'}]}); },
  async myCollection({signal}={}) { ensure(); return pagedRpc(client,'list_my_collection',{p_token:token()},{signal,orders:[{column:'card_name'},{column:'set_code'},{column:'condition'},{column:'id'}]}); },
  async teamCollection({signal}={}) { ensure(); return pagedRpc(client,'list_team_collection',{p_token:token()},{signal,orders:[{column:'card_name'},{column:'owner_name'},{column:'set_code'},{column:'id'}]}); },
  async decks({signal}={}) { ensure(); const args={p_token:token()};try{return await pagedRpc(client,'list_my_decks_with_boxes',args,{signal,orders:[{column:'updated_at',ascending:false},{column:'id'}]});}catch(error){if(!['PGRST202','42883'].includes(error.code))throw error;return pagedRpc(client,'list_my_decks',args,{signal,orders:[{column:'updated_at',ascending:false},{column:'id'}]});} },
  async saveDeck(deck) {
    ensure();
    const id=/^[0-9a-f-]{36}$/i.test(String(deck.id||''))?deck.id:null;
    const args={p_token:token(),p_deck:{id,name:deck.name,game:deck.game,format:deck.format,signatureCardId:deck.signatureCardId||null,deckTheme:deck.deckTheme||'arcane-purple',deckBoxTemplate:deck.deckBoxTemplate||'procedural',cards:deck.cards}},result=await client.rpc('save_deck_with_box',args);
    if(!result.error)return result.data;if(!['PGRST202','42883'].includes(result.error.code))throw result.error;return {id:unwrap(await client.rpc('save_deck',args)),deckBoxPersisted:false};
  },
  async teamDecks({signal}={}) { ensure(); return pagedRpc(client,'list_team_decks',{p_token:token()},{signal,orders:[{column:'owner_name'},{column:'updated_at',ascending:false},{column:'id'}]}); },
  async deleteDeck(id) { ensure(); return unwrap(await client.rpc('delete_deck', { p_token:token(),p_id:id })); },
  async deckPrintingOptions(deckId, catalogCardId) {
    ensure(); return unwrap(await client.rpc('list_deck_printing_options', { p_token:token(),p_deck_id:deckId,p_catalog_card_id:String(catalogCardId) }));
  },
  async setDeckCardPrinting(deckId, catalogCardId, section, printingId) {
    ensure(); return unwrap(await client.rpc('set_deck_card_printing', { p_token:token(),p_deck_id:deckId,p_catalog_card_id:String(catalogCardId),p_section:section,p_printing_id:printingId }));
  },
  // Sostituisce il vecchio marketWatch(game) unico (list_market_watch):
  // payload alleggerito (niente mappingEvidence) + vera paginazione
  // server-side sulla sola tab Raccolta, che è quella con migliaia di righe
  // — vedi supabase/migrations/20260911145101_market_watch_owned_pagination.sql.
  async marketWatchOwnedPage(game = 'yugioh', { limit = 60, offset = 0, sort = 'value', query = '' } = {}) {
    ensure(); return unwrap(await client.rpc('list_market_watch_owned_page', { p_token:token(),p_game:game,p_limit:limit,p_offset:offset,p_sort:sort,p_query:query||null }));
  },
  // Tab Mazzi + Watchlist: piccole per costruzione, un solo fetch (non paginato).
  async marketWatchExtra(game = 'yugioh') {
    ensure(); return unwrap(await client.rpc('list_market_watch_extra', { p_token:token(),p_game:game }));
  },
  // Solo aggregati (valore portafoglio, conteggi code di conferma, fallback
  // di prezzo per carta logica) — mai righe intere.
  async marketWatchSummary(game = 'yugioh') {
    ensure(); return unwrap(await client.rpc('get_market_watch_summary', { p_token:token(),p_game:game }));
  },
  // L'unico posto che restituisce mappingEvidence/candidates — chiamata solo
  // quando l'utente apre la tab "Conferma" o preme "Conferma tutti aggregate".
  async marketConfirmQueue(game = 'yugioh') {
    ensure(); return unwrap(await client.rpc('list_market_confirm_queue', { p_token:token(),p_game:game }));
  },
  async marketDashboardMovers(game = 'yugioh') {
    ensure(); return unwrap(await client.rpc('list_market_dashboard_movers', { p_token:token(),p_game:game }));
  },
  async marketPriceHistory(printingId, days = 30) {
    ensure(); return unwrap(await client.rpc('list_market_price_history', { p_token:token(),p_printing_id:printingId,p_days:days }));
  },
  async setMarketMappingManual(printingId, providerProductId, { productName = '', expansion = '', rarity = '' } = {}) {
    ensure(); return unwrap(await client.rpc('set_market_mapping_manual', { p_token:token(),p_printing_id:printingId,p_provider_product_id:String(providerProductId),p_product_name:productName,p_expansion:expansion,p_rarity:rarity }));
  },
  async setMarketWatchItem(printingId, enabled) {
    ensure(); return unwrap(await client.rpc('set_market_watch_item', { p_token:token(),p_printing_id:printingId,p_enabled:Boolean(enabled) }));
  },
  async marketPriceAnomalies() {
    ensure(); return unwrap(await client.rpc('list_market_price_anomalies', { p_token:token() }));
  },
  async confirmMarketPriceAnomaly(snapshotId) {
    ensure(); return unwrap(await client.rpc('confirm_market_price_anomaly', { p_token:token(),p_snapshot_id:snapshotId }));
  },
  async lookupPrintings(setCode, game = 'yugioh') {
    ensure(); return unwrap(await client.rpc('lookup_card_printings_by_set_code', { p_token:token(),p_game:game,p_set_code:setCode }));
  },
  // card_printings è il catalogo autorevole (verificato da Fast Scan/Market
  // Watch nel tempo): l'editor Raccolta lo usa per completare le rarità/set
  // che YGOPRODeck da solo non elenca tutte.
  async lookupPrintingsByCatalogId(catalogCardId, game = 'yugioh') {
    ensure(); return unwrap(await client.rpc('lookup_card_printings_by_catalog_id', { p_token:token(),p_game:game,p_catalog_card_id:catalogCardId }));
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
      p_quantity_mode:item.id ? 'set' : 'increment',
      p_printing_id:item.printingId || null
    }));
  },
  async onePieceCatalogSearch(query, limit = 60) {
    ensure(); return unwrap(await client.rpc('search_onepiece_catalog', { p_token:token(),p_query:query,p_limit:limit }));
  },
  // Il costo non viaggia sulle righe deck_cards (non è dato di inventario,
  // è metadata di catalogo) — si risolve al volo per catalogCardId, come i
  // tipi carta Yu-Gi-Oh via cardTypesByIds.
  async onePieceCardCosts(catalogCardIds) {
    ensure(); return unwrap(await client.rpc('list_onepiece_card_costs', { p_token:token(),p_catalog_card_ids:catalogCardIds }));
  },
  // Printing Registry (set_code -> Konami card ID -> artwork): vedi
  // js/ygo-printing-registry.js, l'unico chiamante di questi metodi.
  async ygoPrintingRegistryLookup(setCodes) {
    ensure(); return unwrap(await client.rpc('ygo_printing_registry_lookup', { p_token:token(), p_set_codes:setCodes }));
  },
  async ygoPrintcodeCacheLookup(prefixes) {
    ensure(); return unwrap(await client.rpc('ygo_printcode_cache_lookup', { p_token:token(), p_prefixes:prefixes }));
  },
  async ygoPrintcodeCacheUpsert(prefix, status, entries = []) {
    ensure(); return unwrap(await client.rpc('ygo_printcode_cache_upsert', { p_token:token(), p_prefix:prefix, p_status:status, p_entries:entries }));
  },
  async ygoArtworkIndexLookup(konamiCardIds) {
    ensure(); return unwrap(await client.rpc('ygo_artwork_index_lookup', { p_token:token(), p_konami_card_ids:konamiCardIds }));
  },
  async ygoArtworkIndexUpsert(entries) {
    ensure(); return unwrap(await client.rpc('ygo_artwork_index_upsert', { p_token:token(), p_entries:entries }));
  },
  async applyYgoPrintingMappings(mappings) {
    ensure(); return unwrap(await client.rpc('apply_ygo_printing_mappings', { p_token:token(), p_mappings:mappings }));
  },
  async upsertYgoPrintingOverride(override) {
    ensure(); return unwrap(await client.rpc('upsert_ygo_printing_override', {
      p_token:token(), p_set_code:override.setCode, p_konami_card_id:override.konamiCardId || null,
      p_artwork_index:override.artworkIndex || null, p_artwork_url:override.artworkUrl || null,
      p_reason:override.reason
    }));
  },
  async ygoPrintingRegistryIssues(statuses = ['unresolved', 'conflict']) {
    ensure(); return unwrap(await client.rpc('list_ygo_printing_registry_issues', { p_token:token(), p_statuses:statuses }));
  },
  async ygoPrintingsForBackfill(afterId = null, limit = 500) {
    ensure(); return unwrap(await client.rpc('list_ygo_printings_for_backfill', { p_token:token(), p_after_id:afterId, p_limit:limit }));
  },
  // Artwork Resolver: coda multi-artwork ordinata per utilizzo reale
  // (collection/deck/loan) — vedi js/admin.js. Aperta ad admin E a chi ha
  // can_verify_ygo_artwork (Artwork Curator); il filtro/ordinamento sono
  // parametri della RPC, non calcolati lato client.
  async ygoArtworkReviewQueue({ limit = 50, offset = 0, setPrefix = '', query = '', usedOnly = true, orderBy = 'usage_count' } = {}) {
    ensure(); return unwrap(await client.rpc('list_ygo_artwork_review_queue', {
      p_token:token(), p_limit:limit, p_offset:offset, p_set_prefix:setPrefix || null,
      p_query:query || null, p_used_only:usedOnly, p_order_by:orderBy
    }));
  },
  // Conferma artwork (admin o Artwork Curator) — l'unico parametro "libero"
  // è l'indice scelto: konami_card_id/artwork_url non sono nemmeno accettati
  // come argomenti, la RPC li ricava sempre da ygo_printing_registry/
  // ygo_artwork_index lato server (mai un valore custom dal client).
  async confirmYgoPrintingArtwork(setCode, artworkIndex) {
    ensure(); return unwrap(await client.rpc('confirm_ygo_printing_artwork', {
      p_token:token(), p_set_code:setCode, p_artwork_index:artworkIndex
    }));
  },
  async myYgoArtworkVerifications(limit = 100) {
    ensure(); return unwrap(await client.rpc('list_my_ygo_artwork_verifications', { p_token:token(), p_limit:limit }));
  },
  async ygoArtworkReviewSetPrefixes() {
    ensure(); return unwrap(await client.rpc('list_ygo_artwork_review_set_prefixes', { p_token:token() }));
  },
  async catalogVerificationQueue(version,{signal}={}) {
    ensure(); return pagedRpc(client,'list_collection_catalog_verification_queue', {
      p_token:token(), p_verification_version:version
    },{signal,key:row=>row.collection_item_id||row.collectionItemId||row.id});
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
  // p_client_request_id: un uuid generato dal chiamante per tentativo di
  // invio — un retry con la STESSA chiave (rete instabile, doppio tap) fa
  // rispondere l'RPC con la riga già creata invece di crearne una seconda.
  async requestCollectionLoan(collectionItemId, quantity, notes = '', preAgreed = false, clientRequestId = null) {
    ensure();
    return unwrap(await client.rpc('request_collection_loan', {
      p_token:token(), p_collection_item_id:collectionItemId, p_quantity:quantity, p_notes:notes,
      p_pre_agreed:preAgreed, p_client_request_id:clientRequestId
    }));
  },
  // Versione batch di requestCollectionLoan — non ancora richiamata
  // dall'app (P1 del backlog Loan DB v2): una sola RPC invece di N chiamate
  // parallele, con la stessa idempotenza per-item. items: [{collectionItemId,
  // quantity, notes, preAgreed, clientRequestId}].
  async requestCollectionLoans(items) {
    ensure();
    return unwrap(await client.rpc('request_collection_loans', {
      p_token:token(), p_items:items.map(item => ({
        collectionItemId:item.collectionItemId, quantity:item.quantity, notes:item.notes || '',
        preAgreed:item.preAgreed || false, clientRequestId:item.clientRequestId || null
      }))
    }));
  },
  async respondCollectionLoan(id, action, quantity = null) {
    ensure();
    return unwrap(await client.rpc('respond_collection_loan', {
      p_token:token(), p_id:id, p_action:action, p_quantity:quantity
    }));
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
  paginationMetrics(resource) { return paginationMetrics(resource); },
  async transition(id, action) { ensure(); unwrap(await client.rpc('transition_loan', { p_token:token(), p_id:id, p_action:action })); },
  async createCollectionShare(game) { ensure(); return unwrap(await client.rpc('create_collection_share', { p_token:token(), p_game:game })); },
  async revokeCollectionShare(shareId) { ensure(); return unwrap(await client.rpc('revoke_collection_share', { p_token:token(), p_share_id:shareId })); },
  async collectionShares() { ensure(); return unwrap(await client.rpc('list_collection_shares', { p_token:token() })); },
  async collectionShareRequests() { ensure(); return unwrap(await client.rpc('list_collection_share_requests', { p_token:token() })); },
  async markCollectionShareRequestSeen(requestId) { ensure(); return unwrap(await client.rpc('mark_collection_share_request_seen', { p_token:token(), p_request_id:requestId })); },
  // Guest-facing: no session token — the share id itself is the only
  // credential, validated server-side against collection_shares.
  async getCollectionShare(shareId) { ensure(); return unwrap(await client.rpc('get_collection_share', { p_share_id:shareId })); },
  async submitCollectionShareRequest(shareId, requesterName, items, message = '') { ensure(); return unwrap(await client.rpc('submit_collection_share_request', { p_share_id:shareId, p_requester_name:requesterName, p_items:items, p_message:message?.trim() || null })); },
  async progression() { ensure(); return unwrap(await client.rpc('get_my_progression', { p_token:token() })); },
  async stats(game, { deckId, period } = {}) { ensure(); return unwrap(await client.rpc('get_stats', { p_token:token(), p_game:game, p_deck_id:deckId || null, p_period:period || 'all' })); },
  async teamStats(game, { period } = {}) { ensure(); return unwrap(await client.rpc('get_team_stats', { p_token:token(), p_game:game, p_period:period || 'all' })); },
  async registerMatch(payload) { ensure(); return unwrap(await client.rpc('register_match', { p_token:token(), p_game:payload.game, p_deck_id:payload.deckId, p_result:payload.result, p_opponent_label:payload.opponentLabel || '', p_opponent_deck:payload.opponentDeck || '', p_notes:payload.notes || '', p_opponent_member_slug:payload.opponentMemberSlug || null, p_opponent_deck_id:payload.opponentDeckId || null, p_opponent_deck_name:payload.opponentDeckName || '', p_went_first:payload.wentFirst ?? null })); },
  async deleteMatch(id) { ensure(); return unwrap(await client.rpc('delete_match', { p_token:token(), p_id:id })); },
  async myCosmetics() { ensure(); return unwrap(await client.rpc('get_my_cosmetics', { p_token:token() })); },
  async claimCosmetic(cosmeticId) { ensure(); return unwrap(await client.rpc('claim_cosmetic', { p_token:token(), p_cosmetic_id:cosmeticId })); },
  async equipCosmetic(type, cosmeticId) { ensure(); return unwrap(await client.rpc('equip_cosmetic', { p_token:token(), p_type:type, p_cosmetic_id:cosmeticId })); },
  async dailyMissions() { ensure(); return unwrap(await client.rpc('get_my_daily_missions', { p_token:token() })); },
  async matchStreak(game) { ensure(); return unwrap(await client.rpc('get_match_streak', { p_token:token(), p_game:game })); },
  // Striscia di vittorie consecutive per UN mazzo specifico (non per gioco
  // come matchStreak) — usata dai Deck Box sbloccabili per archetipo, vedi
  // js/deck-archetype-unlocks.js.
  async deckWinStreak(deckId) { ensure(); return unwrap(await client.rpc('get_deck_win_streak', { p_token:token(), p_deck_id:deckId })); },
  async matchTimeline(game) { ensure(); return unwrap(await client.rpc('get_match_timeline', { p_token:token(), p_game:game })); },
  async headToHead(game, { period } = {}) { ensure(); return unwrap(await client.rpc('get_head_to_head', { p_token:token(), p_game:game, p_period:period || 'all' })); },
  async rivalWins() { ensure(); return unwrap(await client.rpc('get_rival_wins', { p_token:token() })); }
};
