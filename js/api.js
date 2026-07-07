const configured = Boolean(window.FPT_CONFIG?.supabaseUrl && window.FPT_CONFIG?.supabaseKey);
const client = configured ? window.supabase.createClient(window.FPT_CONFIG.supabaseUrl, window.FPT_CONFIG.supabaseKey) : null;
const TOKEN_KEY = 'fpt-cards-session-token';
let realtimeChannel;

function token() {
  let value = localStorage.getItem(TOKEN_KEY);
  if (!value) { value = `${crypto.randomUUID()}${crypto.randomUUID()}`; localStorage.setItem(TOKEN_KEY, value); }
  return value;
}
function ensure() { if (!client) throw new Error('Supabase non configurato'); }
function unwrap(result) { if (result.error) throw result.error; return result.data; }

export const api = {
  configured,
  async login(slug, pin) { ensure(); return unwrap(await client.rpc('login_member', { p_slug:slug, p_pin:pin, p_token:token() })); },
  async logout() { if (client) await client.rpc('logout_member', { p_token:token() }); localStorage.removeItem(TOKEN_KEY); },
  async loans() { ensure(); return unwrap(await client.rpc('list_team_loans', { p_token:token() })); },
  async create(cardName, quantity, borrower, notes) {
    ensure(); return unwrap(await client.rpc('create_team_loan', { p_token:token(), p_card_name:cardName, p_quantity:quantity, p_borrower_slug:borrower, p_notes:notes }));
  },
  async createMany(cards, borrower, notes, game) {
    ensure(); return unwrap(await client.rpc('create_team_loans', { p_token:token(), p_cards:cards.map(c => ({ name:c.name, quantity:c.quantity, image:c.image || '', externalId:c.id || '' })), p_borrower_slug:borrower, p_notes:notes, p_game:game }));
  },
  async enrichLoan(id, card) {
    ensure(); return unwrap(await client.rpc('enrich_loan_card', { p_token:token(), p_id:id, p_external_id:card.id, p_image:card.image }));
  },
  async savePushSubscription(subscription) {
    ensure();
    return unwrap(await client.rpc('save_push_subscription', {
      p_token:token(), p_endpoint:subscription.endpoint,
      p_p256dh:subscription.keys?.p256dh, p_auth:subscription.keys?.auth
    }));
  },
  subscribe(callback) {
    ensure();
    if (realtimeChannel) client.removeChannel(realtimeChannel);
    realtimeChannel = client.channel('fpt-loans')
      .on('broadcast', { event:'loans_changed' }, callback)
      .subscribe();
  },
  unsubscribe() {
    if (realtimeChannel) client.removeChannel(realtimeChannel);
    realtimeChannel = null;
  },
  async transition(id, action) { ensure(); unwrap(await client.rpc('transition_loan', { p_token:token(), p_id:id, p_action:action })); }
};
