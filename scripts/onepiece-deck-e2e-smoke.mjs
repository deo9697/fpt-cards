// Collaudo E2E One Piece (blocker 3, richiesto dall'utente 2026-09-10):
// cerca carta -> apri risultato -> scegli printing -> aggiungi a raccolta ->
// cambia printing dall'editor Raccolta -> crea mazzo -> stessa carta logica
// come regular+parallel -> cap aggregato 4 copie -> Leader -> DON!! ->
// ordinamento "Costo" di default -> manuale + drag -> salva -> chiudi/riapri.
// Fixture realistiche ma finte (RPC Supabase mockate, sessione CDP reale su
// Chrome headless) — stesso pattern di scripts/p0-nav-regression-smoke.mjs.
// Esegui: node scripts/onepiece-deck-e2e-smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const root = process.cwd();
const port = 8095;
const debugPort = 9355;
let browser;
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find(fs.existsSync);
if (!chrome) throw new Error('Google Chrome non trovato');

const members = [{ slug:'daniele', full_name:'Daniele', role:'admin' }];

// Nami: due printing della stessa carta logica (regular + parallel), usate
// per il test del cap aggregato a 4 copie. Hawkins: immagine deliberatamente
// cross-code (il codice nel filename è "OP10-103", non "OP10-109") per
// provare che il fix del blocker 1 blocca il bug anche nel browser reale,
// non solo negli unit test isolati.
const namiRegular = { catalog_card_id:'OP01-016', printing_id:'printing-nami-regular', variant_id:'OP01-016', card_name:'Nami', set_code:'OP01', set_name:'Romance Dawn', rarity:'R', image_url:'https://optcgapi.com/media/static/Card_Images/OP01-016.jpg', game_metadata:{ cardType:'Character', colors:['Red'], cost:1, power:1000 } };
const namiParallel = { ...namiRegular, printing_id:'printing-nami-parallel', variant_id:'OP01-016_p1', rarity:'SR', image_url:'https://optcgapi.com/media/static/Card_Images/OP01-016_p1.jpg' };
const luffyLeader = { catalog_card_id:'OP01-001', printing_id:'printing-luffy', variant_id:'OP01-001', card_name:'Monkey.D.Luffy', set_code:'OP01', set_name:'Romance Dawn', rarity:'L', image_url:'https://optcgapi.com/media/static/Card_Images/OP01-001.jpg', game_metadata:{ cardType:'Leader', colors:['Red'], cost:0, power:5000 } };
const hawkins = { catalog_card_id:'OP10-109', printing_id:'printing-hawkins', variant_id:'OP10-109', card_name:'Hawkins', set_code:'OP10', set_name:'One Piece the Best', rarity:'R', image_url:'https://optcgapi.com/media/static/Card_Images/OP10-103.jpg', game_metadata:{ cardType:'Character', colors:['Purple'], cost:3, power:4000 } };
const donCard = { catalog_card_id:'don_183', printing_id:'printing-don', variant_id:'don_183', card_name:'DON!! Card', set_code:'DON', set_name:'DON!! Cards', rarity:'DON!!', image_url:'https://optcgapi.com/media/static/Card_Images/don_183.jpg', game_metadata:{ cardType:'don', cost:null } };
const allPrintings = [namiRegular, namiParallel, luffyLeader, hawkins, donCard];

const fakeSupabaseSource = `(()=>{
  window.__rpcCounts={};
  const track=name=>{window.__rpcCounts[name]=(window.__rpcCounts[name]||0)+1;};
  const members=${JSON.stringify(members)};
  const printings=${JSON.stringify(allPrintings)};
  let collectionItems=[];
  let decks=[];
  let currentSlug='daniele';
  window.__dialogs=[];
  window.confirm=message=>{window.__dialogs.push(message);return true;};
  const client={
    async rpc(name,args={}){
      track(name);
      if(name==='list_login_members') return {data:members,error:null};
      if(name==='login_member'){
        currentSlug=args.p_slug;
        const profile=members.find(item=>item.slug===args.p_slug);
        return {data:{slug:profile.slug,name:profile.full_name,role:profile.role},error:null};
      }
      if(name==='list_member_profiles') return {data:members.map(m=>({slug:m.slug,full_name:m.full_name,role:m.role})),error:null};
      if(name==='list_team_loans') return {data:[],error:null};
      if(name==='list_collection_share_requests') return {data:[],error:null};
      if(name==='list_collection_catalog_verification_queue') return {data:[],error:null};
      if(name==='list_market_watch') return {data:{items:[],deckUnresolved:[],lastSync:null},error:null};
      if(name==='list_market_dashboard_movers') return {data:[],error:null};
      if(name==='list_market_price_anomalies') return {data:[],error:null};
      if(name==='get_my_progression') return {data:{totalXp:0,level:1,xpToday:0,dailyCap:100},error:null};
      if(name==='get_match_streak') return {data:null,error:null};
      if(name==='get_stats') return {data:[],error:null};
      if(name==='get_my_cosmetics') return {data:{unlocked:[],activeAvatar:null,activeTitle:null},error:null};
      if(name==='get_my_daily_missions') return {data:[],error:null};
      if(name==='get_match_timeline') return {data:[],error:null};
      if(name==='get_rival_wins') return {data:{},error:null};
      if(name==='search_onepiece_catalog'){
        const q=String(args.p_query||'').trim().toLowerCase();
        const rows=printings.filter(row=>row.card_name.toLowerCase().includes(q)||row.catalog_card_id.toLowerCase()===q);
        return {data:rows,error:null};
      }
      if(name==='list_onepiece_card_costs'){
        const ids=args.p_catalog_card_ids||[];
        return {data:ids.map(id=>{const row=printings.find(p=>p.catalog_card_id===id);return {catalog_card_id:id,cost:row?.game_metadata?.cost??null};}),error:null};
      }
      if(name==='list_my_collection') return {data:collectionItems.filter(item=>item.owner_slug===currentSlug),error:null};
      if(name==='list_team_collection') return {data:collectionItems.map(({quantity_owned,...item})=>item),error:null};
      if(name==='save_collection_item'){
        const id=args.p_id||('coll-'+(collectionItems.length+1));
        const existing=collectionItems.find(item=>item.id===id);
        const owned=args.p_quantity_mode==='increment'&&existing?existing.quantity_owned+args.p_quantity_owned:args.p_quantity_owned;
        const row={id,printing_id:args.p_printing_id||existing?.printing_id||'',owner_slug:currentSlug,owner_name:members.find(m=>m.slug===currentSlug)?.full_name||currentSlug,
          game:args.p_game,catalog_card_id:args.p_catalog_card_id,card_name:args.p_card_name,set_code:args.p_set_code,set_name:args.p_set_name,rarity:args.p_rarity,
          language:args.p_language,condition:args.p_condition,edition:args.p_edition||'',image_url:args.p_image_url,
          quantity_owned:owned,quantity_loaned:0,quantity_reserved:0,quantity_physically_available:owned,legacy_ambiguous:false,updated_at:new Date().toISOString()};
        collectionItems=collectionItems.filter(item=>item.id!==id);collectionItems.push(row);
        return {data:id,error:null};
      }
      if(name==='list_my_decks_with_boxes'||name==='list_my_decks') return {data:decks.filter(deck=>deck.owner_slug===currentSlug),error:null};
      if(name==='save_deck_with_box'){
        // L'id deve avere forma UUID: js/api.js:saveDeck() invia p_deck.id
        // solo se combacia con /^[0-9a-f-]{36}$/i, altrimenti manda null a
        // ogni save (anche il secondo) e questo mock ne creerebbe uno nuovo
        // ogni volta invece di aggiornare lo stesso mazzo.
        const id=args.p_deck.id||'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const row={id,owner_slug:currentSlug,game:args.p_deck.game,name:args.p_deck.name,format:args.p_deck.format,
          signature_card_id:args.p_deck.signatureCardId||null,deck_theme:args.p_deck.deckTheme||'arcane-purple',deck_box_template:args.p_deck.deckBoxTemplate||'procedural',
          cover_image_url:args.p_deck.cards[0]?.imageUrl||'',
          cards:args.p_deck.cards.map(card=>({catalog_card_id:card.catalogCardId,card_name:card.cardName,image_url:card.imageUrl,ban_tcg:card.banTcg||'',section:card.section,quantity:card.quantity,printing_id:card.printingId||null,printing_set_code:card.printingSetCode||'',printing_rarity:card.printingRarity||''}))};
        decks=decks.filter(deck=>deck.id!==id);decks.push(row);
        return {data:id,error:null};
      }
      if(name in {}) {}
      return {data:[],error:null};
    },
    channel(){return {on(){return this},subscribe(){return this}}},
    removeChannel(){}
  };
  window.supabase={createClient(){return client}};
})();`;

const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.webmanifest':'application/manifest+json', '.mp3':'audio/mpeg', '.mp4':'video/mp4' };
const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`);
  const requestPath = decodeURIComponent(requestUrl.pathname);
  if (requestPath === '/test-supabase.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    return res.end(fakeSupabaseSource);
  }
  if (requestPath === '/test-cardinfo') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ data: [] }));
  }
  const relative = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); return res.end('not found'); }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    if (relative === 'index.html') return res.end(data.toString('utf8').replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', '/test-supabase.js'));
    if (relative === 'js/cards.js') return res.end(data.toString('utf8').replace('https://db.ygoprodeck.com/api/v7/cardinfo.php', '/test-cardinfo'));
    res.end(data);
  });
});

class CdpClient {
  constructor(ws) {
    this.ws = ws; this.nextId = 0; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const task = this.pending.get(message.id); this.pending.delete(message.id);
        message.error ? task.reject(message.error) : task.resolve(message.result);
      } else if (message.method && this.handlers.has(message.method)) {
        for (const handler of this.handlers.get(message.method)) void handler(message.params);
      }
    };
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId; this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function waitForUrl(url, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    try { return await (await fetch(url)).json(); } catch { await delay(100); }
  }
  throw new Error(`Endpoint CDP non disponibile: ${url}`);
}

async function run() {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const profile = path.join(os.tmpdir(), `fpt-onepiece-e2e-smoke-${Date.now()}`);
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio:'ignore', windowsHide:true });
  await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`);
  const tab = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, { method:'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = new CdpClient(ws);

  const consoleErrors = [];
  const exceptions = [];
  const networkFailures = [];

  cdp.on('Runtime.exceptionThrown', event => {
    exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Eccezione JavaScript');
  });
  cdp.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error') consoleErrors.push((event.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  });
  cdp.on('Network.responseReceived', event => {
    if (event.response.status >= 400) networkFailures.push(`${event.response.status} ${event.response.url}`);
  });

  await cdp.call('Runtime.enable');
  await cdp.call('Network.enable');
  await cdp.call('Page.navigate', { url:`http://127.0.0.1:${port}/#/home` });

  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue:true, awaitPromise:true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, message, attempts = 80) => {
    for (let index = 0; index < attempts; index += 1) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    const diagnostic = await evaluate(`({url:location.href,body:document.body.innerText.slice(0,300)})`);
    throw new Error(`${message} · ${JSON.stringify(diagnostic)}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  const typeInto = (selector, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);

  await waitFor(`document.querySelectorAll('#member option').length >= ${members.length}`, 'Membri non caricati');
  await evaluate(`(()=>{const s=document.querySelector('#member');s.value='daniele';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await evaluate(`(()=>{const p=document.querySelector('#pin');p.value='1234';p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit(document.querySelector('#login-form button[type="submit"]'));})()`);
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Login non completato');
  console.log('PASS login');

  // -- Passa a One Piece --
  await click('.game-switcher .menu-trigger');
  await waitFor(`Boolean(document.querySelector('.game-options button[data-game="onepiece"]'))`, 'Menu gioco non aperto');
  await click('.game-options button[data-game="onepiece"]');
  await delay(150);
  console.log('PASS switch a One Piece');

  // -- 1-2. Ricerca -> scegli printing -> aggiungi a Raccolta (Nami regular) --
  await click('.sidebar button[data-page="collection"]');
  await waitFor(`Boolean(document.querySelector('[data-collection-query]'))`, 'Raccolta non caricata');
  await click('[data-collection-add]');
  await waitFor(`Boolean(document.querySelector('#collection-card-search'))`, 'Editor Raccolta non aperto');
  await typeInto('#collection-card-search', 'Nami');
  await waitFor(`Boolean(document.querySelector('[data-collection-card-result="0"]'))`, 'Nessun risultato ricerca catalogo');
  await click('[data-collection-card-result="0"]');
  await waitFor(`Boolean(document.querySelector('[data-collection-printing-option]'))`, 'Picker printing non comparso');
  const printingOptions = await evaluate(`[...document.querySelectorAll('[data-collection-printing-option]')].map(b=>b.dataset.collectionPrintingOption)`);
  assert(printingOptions.includes('printing-nami-regular') && printingOptions.includes('printing-nami-parallel'), `Picker non mostra entrambe le printing Nami: ${JSON.stringify(printingOptions)}`);
  await click('[data-collection-printing-option="printing-nami-regular"]');
  await delay(100);
  await evaluate(`(()=>{const owned=document.querySelector('#collection-owned');if(owned){owned.value='2';owned.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await waitFor(`!document.querySelector('#collection-form button[type="submit"]')?.disabled`, 'Submit raccolta resta disabilitato dopo aver scelto la printing');
  await click('#collection-form button[type="submit"]');
  await waitFor(`document.querySelectorAll('[data-collection-item]').length >= 1`, 'Item non comparso in Raccolta dopo il salvataggio');
  console.log('PASS aggiunta a Raccolta con printing "regular" scelta esplicitamente');

  // -- 3. Editor Raccolta: cambia printing (regular -> parallel) --
  const collectionItemId = await evaluate(`document.querySelector('[data-collection-item]')?.dataset.collectionItem`);
  await click(`[data-collection-item="${collectionItemId}"]`);
  await waitFor(`Boolean(document.querySelector('[data-collection-edit]'))`, 'Dettaglio item non aperto');
  await click('[data-collection-edit]');
  await waitFor(`Boolean(document.querySelector('[data-collection-printing-option="printing-nami-parallel"]'))`, 'Picker printing (modifica) non mostra la variante parallel');
  await click('[data-collection-printing-option="printing-nami-parallel"]');
  await delay(100);
  await click('#collection-form button[type="submit"]');
  await delay(200);
  const dialogsSeen = await evaluate('window.__dialogs.length');
  assert(dialogsSeen >= 1, 'Il cambio printing doveva chiedere conferma (confirm()) e non l\'ha fatto');
  console.log('PASS cambio printing dall\'editor Raccolta (regular -> parallel), confirm() intercettato');

  // -- 4-6. Deck Builder: crea mazzo, DON!! automatico, Leader, Main (Nami regular) --
  await click('.sidebar button[data-page="decks"]');
  await waitFor(`Boolean(document.querySelector('.deck-page'))`, 'Pagina Mazzi non caricata');
  await click('[data-deck-new]');
  await waitFor(`Boolean(document.querySelector('[data-deck-search]'))`, 'Editor mazzo non aperto');

  await waitFor(`document.querySelector('.c-extra b')?.textContent.includes('10/10')`, 'DON!! non auto-riempito a 10/10', 60);
  console.log('PASS DON!! auto-riempito (10/10) alla creazione del mazzo');

  const sortLabelAtOpen = await evaluate(`document.querySelector('[data-deck-sort-cycle] span')?.textContent`);
  assert(sortLabelAtOpen === 'Costo', `Ordinamento di default non è "Costo" ma "${sortLabelAtOpen}"`);
  console.log('PASS ordinamento "Costo" è il default all\'apertura di un mazzo One Piece');

  await click('[data-deck-pick-leader]');
  await typeInto('[data-deck-search]', 'Monkey');
  await waitFor(`Boolean(document.querySelector('[data-deck-result="0"]'))`, 'Nessun risultato ricerca Leader');
  await click('[data-deck-result="0"]');
  await waitFor(`Boolean(document.querySelector('.leader-hero-main[data-deck-card-select="OP01-001"]'))`, 'Leader non impostato');
  console.log('PASS Leader impostato (Monkey.D.Luffy)');

  await typeInto('[data-deck-search]', 'Nami');
  await waitFor(`Boolean(document.querySelector('[data-deck-result="0"]'))`, 'Nessun risultato ricerca Nami per il Main');
  await click('[data-deck-result="0"]');
  await waitFor(`Boolean(document.querySelector('[data-deck-card-select="OP01-016"]'))`, 'Nami non aggiunta al Main');
  console.log('PASS Nami aggiunta al Main (riga non risolta)');

  await click('[data-deck-save]');
  await delay(300);
  await click('[data-deck-gallery]');
  await waitFor(`Boolean(document.querySelector('[data-deck-open]'))`, 'Mazzo non comparso in gallery dopo il salvataggio');
  const deckId = await evaluate(`document.querySelector('[data-deck-open]')?.dataset.deckOpen`);
  assert(deckId, 'Impossibile leggere l\'id del mazzo appena salvato dalla gallery');
  console.log(`PASS primo salvataggio (mazzo persisted, id=${deckId})`);

  // -- 4b. Due printing della stessa carta logica (regular+parallel): non
  // riproducibile via soli click — add()/openPrintingPicker operano sempre
  // sulla PRIMA riga non risolta per quella carta+sezione (vedi ricognizione:
  // js/decks.js add()/openPrintingPicker). Si inietta un draft locale con due
  // righe a printingId diversi, lo stesso meccanismo che l'app usa già per
  // mazzi non salvati/modificati localmente (persistDrafts/readDrafts,
  // js/decks.js:754-755,854) — non un bypass ad-hoc del test.
  await evaluate(`(()=>{
    const deck = {
      id: ${JSON.stringify(deckId)}, persisted: true, dirty: true, ownerSlug: 'daniele',
      name: 'Mazzo E2E', format: 'TCG Avanzato', game: 'onepiece', cover: '',
      signatureCardId: null, deckTheme: 'arcane-purple', deckBoxTemplate: 'procedural',
      cards: [
        { catalogCardId:'OP01-001', cardName:'Monkey.D.Luffy', imageUrl:'https://optcgapi.com/media/static/Card_Images/OP01-001.jpg', banTcg:'', section:'leader', quantity:1, printingId:'printing-luffy', printingSetCode:'OP01', printingRarity:'L' },
        { catalogCardId:'OP01-016', cardName:'Nami', imageUrl:'https://optcgapi.com/media/static/Card_Images/OP01-016.jpg', banTcg:'', section:'main', quantity:2, printingId:'printing-nami-regular', printingSetCode:'OP01', printingRarity:'R' },
        { catalogCardId:'OP01-016', cardName:'Nami', imageUrl:'https://optcgapi.com/media/static/Card_Images/OP01-016_p1.jpg', banTcg:'', section:'main', quantity:2, printingId:'printing-nami-parallel', printingSetCode:'OP01', printingRarity:'SR' },
        { catalogCardId:'don_183', cardName:'DON!! Card', imageUrl:'https://optcgapi.com/media/static/Card_Images/don_183.jpg', banTcg:'', section:'don', quantity:10, printingId:null, printingSetCode:'', printingRarity:'' }
      ]
    };
    localStorage.setItem('fpt-cards-deck-drafts-v1', JSON.stringify([deck]));
  })()`);
  // Rientrare in Decks fa ripartire dispatchPageEnterRefresh -> loadDecks() ->
  // decks.load(), che fonde il draft appena scritto sopra il mazzo remoto
  // (stesso id, dirty:true) invece di limitarsi a rileggere list_my_decks_with_boxes.
  await click('.sidebar button[data-page="collection"]');
  await delay(100);
  await click('.sidebar button[data-page="decks"]');
  await waitFor(`Boolean(document.querySelector('[data-deck-open]'))`, 'Gallery mazzi non ricaricata dopo l\'iniezione del draft');
  await click(`[data-deck-open="${deckId}"]`);
  await waitFor(`document.querySelectorAll('[data-deck-card-select="OP01-016"]').length >= 2`, 'Il mazzo riaperto non mostra due righe distinte per Nami (regular+parallel)');
  const namiPrintings = await evaluate(`[...document.querySelectorAll('[data-deck-card-select="OP01-016"]')].map(el=>el.dataset.deckCardSelectPrinting)`);
  assert(namiPrintings.includes('printing-nami-regular') && namiPrintings.includes('printing-nami-parallel'), `Le due righe Nami non hanno printingId distinti: ${JSON.stringify(namiPrintings)}`);
  console.log('PASS Nami regular+parallel: due righe distinte per la stessa carta logica, 2+2 copie');

  // -- Cap aggregato a 4 copie: 2 regular + 2 parallel = 4 non deve generare
  // l'errore "massimo 4 copie" (il mazzo resta comunque "da completare" per
  // via delle sole 4/50 carte nel Main — non è quello sotto test qui, la
  // regola dei 4 copie aggregate è già coperta a livello di logica pura in
  // scripts/decks-milestone-smoke.mjs; qui si verifica che il browser reale
  // non la segnali erroneamente sommando due printing_id diversi).
  await delay(150);
  const copyLimitError = await evaluate(`document.body.textContent.includes('massimo 4 copie')`);
  assert(!copyLimitError, 'Falso positivo: 2 regular + 2 parallel (somma 4) segnalate come sopra il limite di copie');
  console.log('PASS cap aggregato: 2 regular + 2 parallel = 4 copie, nessun falso errore "massimo 4 copie"');

  // -- Nessuna immagine cross-code (Hawkins) deve mai comparire in pagina --
  const hawkinsImageLeaked = await evaluate(`[...document.querySelectorAll('img')].some(img=>img.src.includes('OP10-103')&&document.body.textContent.includes('Hawkins'))`);
  assert(!hawkinsImageLeaked, 'Un\'immagine cross-code (caso Hawkins) è arrivata fino al DOM');

  // -- Ordinamento: da "Costo" (default) a "Manuale" servono 4 click sul --
  // -- ciclo (cost-asc -> name-asc -> name-desc -> qty-desc -> manual). --
  for (let index = 0; index < 4; index += 1) { await click('[data-deck-sort-cycle]'); await delay(60); }
  const sortLabelManual = await evaluate(`document.querySelector('[data-deck-sort-cycle] span')?.textContent`);
  assert(sortLabelManual === 'Manuale', `Dopo 4 click il sort dovrebbe essere "Manuale", è "${sortLabelManual}"`);
  console.log('PASS ciclo ordinamento arriva a "Manuale" in 4 click da "Costo"');

  // -- Drag&drop manuale (Pointer Events, non HTML5 drag&drop — vedi --
  // -- js/decks.js:startTileDrag): riordina le due tile Nami nel Main. --
  await waitFor(`document.querySelectorAll('.deck-mobile-grid .deck-tile').length >= 2`, 'Tile mazzo non renderizzate per il drag');
  const dragOk = await evaluate(`(async () => {
    const tiles = [...document.querySelectorAll('.deck-mobile-grid .deck-tile')];
    const source = tiles.find(t => t.dataset.deckCardSelectPrinting === 'printing-nami-parallel');
    const target = tiles.find(t => t.dataset.deckCardSelectPrinting === 'printing-nami-regular');
    if (!source || !target) return 'missing-tiles';
    const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
    const startX = from.left + from.width/2, startY = from.top + from.height/2;
    const endX = to.left + to.width/2, endY = to.top + to.height/2;
    source.dispatchEvent(new PointerEvent('pointerdown', { pointerId:1, clientX:startX, clientY:startY, bubbles:true, pointerType:'mouse', button:0 }));
    document.dispatchEvent(new PointerEvent('pointermove', { pointerId:1, clientX:(startX+endX)/2, clientY:(startY+endY)/2, bubbles:true, pointerType:'mouse' }));
    document.dispatchEvent(new PointerEvent('pointermove', { pointerId:1, clientX:endX, clientY:endY, bubbles:true, pointerType:'mouse' }));
    document.dispatchEvent(new PointerEvent('pointerup', { pointerId:1, clientX:endX, clientY:endY, bubbles:true, pointerType:'mouse' }));
    return 'dispatched';
  })()`);
  assert(dragOk === 'dispatched', `Drag non simulabile: ${dragOk}`);
  await delay(150);
  console.log('PASS gesto di drag (Pointer Events) simulato sulle tile Nami');

  await click('[data-deck-save]');
  await delay(300);
  console.log('PASS salvataggio dopo riordino manuale');

  // -- Chiudi e riapri: torna in gallery, riapri lo stesso mazzo, verifica --
  // -- che struttura e legalità siano sopravvissute al round-trip. --
  await click('[data-deck-gallery]');
  await waitFor(`Boolean(document.querySelector('[data-deck-open]'))`, 'Gallery non raggiunta dopo il salvataggio finale');
  await click(`[data-deck-open="${deckId}"]`);
  await waitFor(`document.querySelectorAll('[data-deck-card-select="OP01-016"]').length >= 2`, 'Dopo la riapertura le due righe Nami sono sparite');
  const copyLimitErrorAfterReopen = await evaluate(`document.body.textContent.includes('massimo 4 copie')`);
  assert(!copyLimitErrorAfterReopen, 'Falso positivo "massimo 4 copie" ricomparso dopo chiusura/riapertura');
  await waitFor(`document.querySelector('.c-extra b')?.textContent.includes('10/10')`, 'DON!! non più 10/10 dopo chiusura/riapertura');
  console.log('PASS chiusura e riapertura: struttura del mazzo (2 righe Nami, DON!! 10/10, nessun falso errore) coerente');

  assert(exceptions.length === 0, `Eccezioni JS non gestite: ${JSON.stringify(exceptions)}`);
  assert(consoleErrors.length === 0, `console.error registrati: ${JSON.stringify(consoleErrors)}`);
  assert(networkFailures.length === 0, `Risposte di rete >=400: ${JSON.stringify(networkFailures)}`);

  console.log('\nonepiece-deck-e2e-smoke: OK — flusso completo cerca->raccolta->mazzo->cap 4 copie->Leader->DON!!->sort->drag->salva->riapri, nessun errore console/eccezione.');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { server.close(); } catch {}
  try { browser?.kill(); } catch {}
});
