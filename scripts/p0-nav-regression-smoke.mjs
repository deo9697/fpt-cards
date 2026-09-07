// P0 regression: naviga tutte le sezioni principali (Home, Carte, Raccolta, Mazzi,
// Prestiti, Market Watch, Team, Impostazioni) due volte di seguito con una sessione
// finta (nessuna rete reale verso Supabase), e verifica: nessun errore console/eccezione
// JS, nessuna richiesta di rete reale >=400, nessun caricamento infinito (ogni pagina
// mostra il proprio marker entro pochi secondi), nessun timer (setInterval) che continua
// a crescere senza limite dopo i cambi di route.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const root = process.cwd();
const port = 8092;
const debugPort = 9352;
let browser;
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find(fs.existsSync);
if (!chrome) throw new Error('Google Chrome non trovato');

const members = [
  { slug:'daniele', full_name:'Daniele', role:'admin' },
  { slug:'marco', full_name:'Marco', role:'guest' }
];
const loan = {
  id:'11111111-1111-4111-8111-111111111111', card_name:'Dark Magician', quantity:1,
  owner_slug:'marco', borrower_slug:'daniele', notes:'', status:'active',
  created_at:new Date().toISOString(), returned_at:null,
  card_image:'https://images.ygoprodeck.com/images/cards/46986414.jpg', card_external_id:'46986414',
  game:'yugioh', returned_quantity:0, pending_return_quantity:0
};
const collectionItems = [{
  id:'item-1', printing_id:'printing-1', owner_slug:'daniele', owner_name:'Daniele', game:'yugioh',
  catalog_card_id:'89631139', card_name:'Blue-Eyes White Dragon', set_code:'LOB-001', set_name:'Legend of Blue Eyes',
  rarity:'Ultra Rare', language:'Italiano', condition:'Near Mint', edition:'', image_url:'https://images.ygoprodeck.com/images/cards/89631139.jpg',
  quantity_owned:3, quantity_loaned:1, quantity_reserved:0, quantity_physically_available:2, legacy_ambiguous:false, updated_at:new Date().toISOString()
}];
const deck = {
  id:'44444444-4444-4444-8444-444444444444', owner_slug:'daniele', game:'yugioh', name:'Mazzo di prova',
  format:'TCG Avanzato', signature_card_id:null, deck_theme:'arcane-purple', deck_box_template:'procedural',
  cover_image_url:'https://images.ygoprodeck.com/images/cards/46986414.jpg',
  cards:[{ catalog_card_id:'46986414', card_name:'Dark Magician', image_url:'https://images.ygoprodeck.com/images/cards/46986414.jpg', ban_tcg:'', section:'main', quantity:2, printing_id:null }]
};
const marketItem = {
  printing_id:'printing-1', catalog_card_id:'89631139', card_name:'Blue-Eyes White Dragon',
  set_code:'LOB-001', set_name:'Legend of Blue Eyes', rarity:'Ultra Rare', image_url:'https://images.ygoprodeck.com/images/cards/89631139.jpg',
  sources:['owned'], owned_quantity:3, reference_price:25, price_24h:22, price_7d:20, price_30d:18, latest_at:new Date().toISOString(),
  providers:{ cardmarket:{ price:25, type:'trend', capturedAt:new Date().toISOString() } }
};
const mover = {
  printingId:'printing-1', catalogCardId:'89631139', cardName:'Blue-Eyes White Dragon', imageUrl:'https://images.ygoprodeck.com/images/cards/89631139.jpg',
  referencePrice:25, baselinePrice:18, positiveChange:38.9,
  sparkline:[{ label:'AVG30', price:18, order:1 }, { label:'AVG7', price:20, order:2 }, { label:'TREND', price:25, order:4 }]
};

const fakeSupabaseSource = `(()=>{
  window.__rpcCounts={};
  const track=name=>{window.__rpcCounts[name]=(window.__rpcCounts[name]||0)+1;};
  const members=${JSON.stringify(members)};
  const loans=${JSON.stringify([loan])};
  const collectionItems=${JSON.stringify(collectionItems)};
  const decks=${JSON.stringify([deck])};
  const marketItem=${JSON.stringify(marketItem)};
  const mover=${JSON.stringify(mover)};
  let currentSlug='daniele';
  window.__authTest={wrongPinMode:false,lastLoginSlug:''};
  const listResponses={
    list_login_members:()=>members,
    list_team_loans:()=>loans,
    list_my_collection:()=>collectionItems.filter(item=>item.owner_slug===currentSlug),
    list_team_collection:()=>collectionItems.map(({quantity_owned,...item})=>item),
    list_my_decks:()=>decks,
    list_my_decks_with_boxes:()=>decks,
    list_market_watch:()=>({items:[marketItem],deckUnresolved:[],lastSync:new Date().toISOString()}),
    list_market_dashboard_movers:()=>[mover],
    list_market_price_history:()=>[{provider:'cardmarket',price_type:'trend',price:18,captured_at:new Date(Date.now()-86400000*7).toISOString()},{provider:'cardmarket',price_type:'trend',price:25,captured_at:new Date().toISOString()}],
    list_collection_catalog_verification_queue:()=>[],
    list_collection_shares:()=>[],
    list_collection_share_requests:()=>[],
    get_my_progression:()=>({totalXp:2640,level:12,xpToday:30,dailyCap:100}),
    get_stats:()=>[{deck_id:'44444444-4444-4444-8444-444444444444',deck_name:'Mazzo di prova',matches:5,wins:3,losses:2,draws:0,win_rate:60}],
    get_team_stats:()=>[],
    get_match_streak:()=>({result:'win',count:3})
  };
  const client={
    async rpc(name,args={}){
      track(name);
      if(name==='login_member'){
        if(window.__authTest.wrongPinMode) return {data:null,error:{message:'PIN non corretto'}};
        window.__authTest.lastLoginSlug=args.p_slug||'';
        const profile=members.find(item=>item.slug===args.p_slug);
        currentSlug=profile.slug;
        return {data:{slug:profile.slug,name:profile.full_name,role:profile.role},error:null};
      }
      if(name in listResponses) return {data:listResponses[name](),error:null};
      if(name==='logout_member') return {data:null,error:null};
      return {data:[],error:null};
    },
    channel(){return {on(){return this},subscribe(){return this}}},
    removeChannel(){}
  };
  window.supabase={createClient(){return client}};
  window.__timerProbe={active:0,max:0};
  const nativeSetInterval=window.setInterval, nativeClearInterval=window.clearInterval;
  window.setInterval=function(...args){window.__timerProbe.active+=1;window.__timerProbe.max=Math.max(window.__timerProbe.max,window.__timerProbe.active);return nativeSetInterval.apply(window,args);};
  window.clearInterval=function(...args){if(args[0])window.__timerProbe.active=Math.max(0,window.__timerProbe.active-1);return nativeClearInterval.apply(window,args);};
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

const PAGES = [
  { id:'home', marker:`Boolean(document.querySelector('.dashboard'))` },
  { id:'cards', marker:`document.querySelector('.page-stage')?.textContent.includes('Cerca nel catalogo')` },
  { id:'collection', marker:`Boolean(document.querySelector('[data-collection-query]'))` },
  { id:'decks', marker:`Boolean(document.querySelector('.deck-page'))` },
  { id:'stats', marker:`Boolean(document.querySelector('.stats-page'))` },
  { id:'loans', marker:`Boolean(document.querySelector('.loan-hero-compact'))` },
  { id:'market', marker:`Boolean(document.querySelector('.market-page'))` },
  { id:'team', marker:`Boolean(document.querySelector('.team-list'))` },
  { id:'settings', marker:`Boolean(document.querySelector('.settings-list'))` }
];

async function run() {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const profile = path.join(os.tmpdir(), `fpt-p0-nav-smoke-${Date.now()}`);
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio:'ignore', windowsHide:true });
  await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`);
  const tab = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, { method:'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = new CdpClient(ws);

  const consoleErrors = [];
  const exceptions = [];
  const networkFailures = [];
  const requestCounts = new Map();

  cdp.on('Runtime.exceptionThrown', event => {
    exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Eccezione JavaScript');
  });
  cdp.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error') consoleErrors.push((event.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  });
  cdp.on('Network.responseReceived', event => {
    const url = event.response.url;
    requestCounts.set(url, (requestCounts.get(url) || 0) + 1);
    if (event.response.status >= 400) networkFailures.push(`${event.response.status} ${url}`);
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
    const diagnostic = await evaluate(`({url:location.href,body:document.body.innerText.slice(0,200)})`);
    throw new Error(`${message} · ${JSON.stringify(diagnostic)}`);
  };
  const selectMember = slug => evaluate(`(()=>{const s=document.querySelector('#member');s.value=${JSON.stringify(slug)};s.dispatchEvent(new Event('change',{bubbles:true}));return s.value})()`);
  const submitPin = pin => evaluate(`(()=>{const p=document.querySelector('#pin');p.value=${JSON.stringify(pin)};p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit(document.querySelector('#login-form button[type="submit"]'));return true})()`);

  await waitFor(`document.querySelectorAll('#member option').length >= ${members.length}`, 'I membri non sono comparsi nel select');
  await selectMember('daniele');
  await submitPin('1234');
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Login non completato');
  console.log('PASS login');

  const timings = [];
  for (let cycle = 1; cycle <= 2; cycle += 1) {
    for (const page of PAGES) {
      const started = Date.now();
      await evaluate(`document.querySelector('.sidebar button[data-page="${page.id}"]')?.click()`);
      await waitFor(page.marker, `Ciclo ${cycle}: la pagina "${page.id}" non ha renderizzato il suo marker (possibile caricamento infinito o schermata vuota)`, 50);
      const elapsed = Date.now() - started;
      timings.push({ cycle, page:page.id, ms:elapsed });
      await delay(60);
    }
  }
  console.log(`PASS navigazione: ${PAGES.length} pagine x 2 cicli completate`);

  const timerProbe = await evaluate('window.__timerProbe');
  const rpcCounts = await evaluate('window.__rpcCounts');

  console.log('--- Timing per pagina (ms) ---');
  for (const t of timings) console.log(`  ciclo ${t.cycle} · ${t.page}: ${t.ms}ms`);
  const slow = timings.filter(t => t.ms > 2000);
  console.log('--- Timer attivi (setInterval) ---');
  console.log(`  picco: ${timerProbe.max}, attivi a fine sessione: ${timerProbe.active}`);
  console.log('--- RPC call counts (2 cicli di navigazione) ---');
  console.log('  ' + JSON.stringify(rpcCounts));
  console.log(`--- Richieste di rete reali distinte: ${requestCounts.size} ---`);
  const dupes = [...requestCounts.entries()].filter(([, count]) => count > 4);
  if (dupes.length) { console.log('  Richieste ripetute più di 4 volte:'); for (const [url, count] of dupes) console.log(`    ${count}x ${url}`); }

  assert(exceptions.length === 0, `Eccezioni JS non gestite: ${JSON.stringify(exceptions)}`);
  assert(consoleErrors.length === 0, `console.error registrati: ${JSON.stringify(consoleErrors)}`);
  assert(networkFailures.length === 0, `Risposte di rete >=400: ${JSON.stringify(networkFailures)}`);
  assert(slow.length === 0, `Pagine con render >2000ms nel fixture: ${JSON.stringify(slow)}`);
  assert(timerProbe.active <= timerProbe.max, 'contatore timer incoerente');
  assert(timerProbe.active < 6, `Troppi setInterval ancora attivi a fine sessione (${timerProbe.active}): possibile timer non ripulito dopo cambio route`);

  console.log('p0-nav-regression-smoke: OK — nessun errore console/eccezione, nessuna risposta di rete >=400, nessuna pagina con caricamento anomalo, timer sotto controllo');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { server.close(); } catch {}
  try { browser?.kill(); } catch {}
});
