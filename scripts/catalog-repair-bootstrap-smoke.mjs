// Verifica il criterio di accettazione centrale del fix "catalog repair
// storm": aprendo l'app con una raccolta realistica (migliaia di printing
// pending, come nel caso reale segnalato: ~2500 collection_items collegati
// a pending, ~8000 card_printings pending in totale), il bootstrap normale
// NON deve mai richiedere/processare l'intera coda né generare loop di
// repair_collection_item_catalog_identity o enrich_loan_card.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const root = process.cwd();
const port = 8093;
const debugPort = 9353;
let browser;
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find(fs.existsSync);
if (!chrome) throw new Error('Google Chrome non trovato');

const members = [{ slug:'daniele', full_name:'Daniele', role:'admin' }];

// Fotografia realistica del problema segnalato: migliaia di printing pending
// nella coda, tutte legacy/irrisolvibili (l'RPC reale le escluderebbe man
// mano che vanno in backoff/unresolved — qui simuliamo lo stato server "la
// coda ha ancora tantissimo pending" per verificare che il CLIENT non lo
// scarichi mai per intero).
const TOTAL_PENDING = 2500;
const pendingQueue = Array.from({ length: TOTAL_PENDING }, (_, index) => ({
  collection_item_id: `item-${index}`, printing_id: `printing-${index}`, game: 'yugioh',
  catalog_card_id: String(90000000 + index), card_name: `Carta Legacy ${index}`,
  set_code: `OLD-IT${String(index % 1000).padStart(3, '0')}`, set_name: 'Set legacy',
  rarity: 'Common', image_url: '', verification_status: 'pending', verification_version: 0
}));
const collectionItems = pendingQueue.slice(0, 200).map((row, index) => ({
  id: row.collection_item_id, printing_id: row.printing_id, owner_slug: 'daniele', owner_name: 'Daniele', game: 'yugioh',
  catalog_card_id: row.catalog_card_id, card_name: row.card_name, set_code: row.set_code, set_name: row.set_name,
  rarity: row.rarity, language: 'Italiano', condition: 'Near Mint', edition: '', image_url: '',
  quantity_owned: 1, quantity_loaned: 0, quantity_reserved: 0, quantity_physically_available: 1,
  legacy_ambiguous: false, updated_at: new Date(2026, 0, 1, 0, 0, index).toISOString()
}));
// Un prestito con immagine GIA' persistita (card_image non nullo): per il
// bug segnalato, "0 prestiti realmente privi di enrichment" — enrich_loan_card
// non deve mai essere chiamata per questo prestito.
const loans = [{
  id: '11111111-1111-4111-8111-111111111111', card_name: 'Dark Magician', quantity: 1,
  owner_slug: 'daniele', borrower_slug: 'daniele', notes: '', status: 'active',
  created_at: new Date().toISOString(), returned_at: null,
  card_image: 'https://images.ygoprodeck.com/images/cards/46986414.jpg', card_external_id: '46986414',
  game: 'yugioh', returned_quantity: 0, pending_return_quantity: 0
}];

const fakeSupabaseSource = `(()=>{
  window.__rpcCounts={};
  window.__rpcArgs={};
  const track=(name,args)=>{window.__rpcCounts[name]=(window.__rpcCounts[name]||0)+1;(window.__rpcArgs[name]=window.__rpcArgs[name]||[]).push(args);};
  const members=${JSON.stringify(members)};
  const loans=${JSON.stringify(loans)};
  const collectionItems=${JSON.stringify(collectionItems)};
  const pendingQueue=${JSON.stringify(pendingQueue)};
  let currentSlug='daniele';
  const listResponses={
    list_login_members:()=>members,
    list_team_loans:()=>loans,
    list_my_collection:()=>collectionItems,
    list_team_collection:()=>[],
    list_my_decks_with_boxes:()=>[],
    list_market_watch:()=>({items:[],deckUnresolved:[],lastSync:new Date().toISOString()}),
    list_collection_shares:()=>[],
    list_collection_share_requests:()=>[],
    get_my_progression:()=>({totalXp:0,level:1,xpToday:0,dailyCap:100}),
    get_stats:()=>[],
    get_team_stats:()=>[],
    get_match_streak:()=>null
  };
  const client={
    async rpc(name,args={}){
      track(name,args);
      if(name==='login_member'){
        const profile=members.find(item=>item.slug===args.p_slug);
        currentSlug=profile.slug;
        return {data:{slug:profile.slug,name:profile.full_name,role:profile.role},error:null};
      }
      if(name==='list_collection_catalog_verification_queue'){
        // Il client corretto DEVE inviare un p_limit piccolo: se non lo
        // invia (regressione al vecchio comportamento non paginato/illimitato)
        // qui restituiamo apposta l'INTERA coda di 2500 righe, cosi' un
        // eventuale regressione viene rilevata dagli assert sotto invece di
        // passare silenziosamente.
        const limit=Math.max(1,Math.min(50,Number(args.p_limit)||pendingQueue.length));
        return {data:pendingQueue.slice(0,limit),error:null};
      }
      if(name==='repair_collection_item_catalog_identity'||name==='record_collection_catalog_verification_attempt'||name==='enrich_loan_card'){
        return {data:null,error:{message:'non usata in questo fixture: il provider non risolve mai queste carte legacy'}};
      }
      if(name in listResponses) return {data:listResponses[name](),error:null};
      if(name==='logout_member') return {data:null,error:null};
      return {data:[],error:null};
    },
    channel(){return {on(){return this},subscribe(){return this}}},
    removeChannel(){}
  };
  window.supabase={createClient(){return client}};
})();`;

const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`);
  const requestPath = decodeURIComponent(requestUrl.pathname);
  if (requestPath === '/test-supabase.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    return res.end(fakeSupabaseSource);
  }
  if (requestPath === '/test-cardinfo') {
    // Ogni lookup provider fallisce a vuoto: nessuna di queste carte legacy
    // esiste davvero su YGOPRODeck (lo stesso scenario del bug reale).
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
    if (relative === 'js/cards.js') return res.end(data.toString('utf8').replace(/https:\/\/db\.ygoprodeck\.com\/api\/v7\/cardinfo\.php/g, '/test-cardinfo'));
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
  const profile = path.join(os.tmpdir(), `fpt-catalog-repair-bootstrap-smoke-${Date.now()}`);
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio:'ignore', windowsHide:true });
  await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`);
  const tab = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, { method:'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = new CdpClient(ws);

  const networkFailures = [];
  let cardinfoRequests = 0;
  cdp.on('Network.responseReceived', event => {
    if (event.response.url.includes('/test-cardinfo')) cardinfoRequests += 1;
    if (event.response.status >= 400) networkFailures.push(`${event.response.status} ${event.response.url}`);
  });
  await cdp.call('Network.enable');
  await cdp.call('Runtime.enable');
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
    throw new Error(message);
  };
  const selectMember = slug => evaluate(`(()=>{const s=document.querySelector('#member');s.value=${JSON.stringify(slug)};s.dispatchEvent(new Event('change',{bubbles:true}));return s.value})()`);
  const submitPin = pin => evaluate(`(()=>{const p=document.querySelector('#pin');p.value=${JSON.stringify(pin)};p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit(document.querySelector('#login-form button[type="submit"]'));return true})()`);

  await waitFor(`document.querySelectorAll('#member option').length >= ${members.length}`, 'I membri non sono comparsi nel select');
  await selectMember('daniele');
  await submitPin('1234');
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Login non completato');
  await waitFor(`Boolean(document.querySelector('.dashboard'))`, 'Home non renderizzata');

  // Il repair di bootstrap è schedulato con setTimeout(0) e gira in un ciclo
  // async (resolveCard/RPC verso il fixture, tutte fallite apposta): un
  // margine ampio (3s) lascia il tempo di completare l'intero batch, non solo
  // di partire.
  await delay(3000);

  // Regressione osservata in produzione il 2026-09-12: loadPrimaryData() non
  // è "solo bootstrap" — login(), start() (sessione ripristinata) e questo
  // watchConnectivity() la richiamano tutte. Un vero browser spesso emette
  // uno o più eventi 'online' reali entro pochi secondi dall'apertura pagina
  // (reali, non simulati da noi): senza una guardia di sessione, ognuno
  // rifaceva scheduleCatalogRepairs() da capo — osservate 4 chiamate reali
  // alla coda invece di 1. Simuliamo qui lo stesso evento per bloccare la
  // regressione.
  await evaluate(`(window.dispatchEvent(new Event('online')), true)`);
  await delay(1500);
  await evaluate(`(window.dispatchEvent(new Event('online')), true)`);
  await delay(1500);

  const rpcCounts = await evaluate('window.__rpcCounts');
  const queueArgs = await evaluate('window.__rpcArgs.list_collection_catalog_verification_queue || []');

  console.log('--- RPC call counts (bootstrap singolo, 2500 pending simulati) ---');
  console.log('  ' + JSON.stringify(rpcCounts));

  assert((rpcCounts.list_collection_catalog_verification_queue || 0) === 1,
    `list_collection_catalog_verification_queue deve essere chiamata esattamente 1 volta per bootstrap (scheduling duplicato loadCollection/loadCloudLoans?), trovate: ${rpcCounts.list_collection_catalog_verification_queue || 0}`);
  assert(queueArgs.every(args => Number(args.p_limit) > 0 && Number(args.p_limit) <= 50),
    `p_limit inviato al server deve essere un batch piccolo (<=50), trovato: ${JSON.stringify(queueArgs.map(a => a.p_limit))}`);
  const repairCalls = rpcCounts.repair_collection_item_catalog_identity || 0;
  assert(repairCalls <= 50,
    `repair_collection_item_catalog_identity chiamata ${repairCalls} volte: il bootstrap non deve mai processare l'intera coda pending (2500 righe simulate)`);
  assert((rpcCounts.enrich_loan_card || 0) === 0,
    `enrich_loan_card chiamata ${rpcCounts.enrich_loan_card || 0} volte per un prestito che ha già un'immagine persistita (0 prestiti realmente privi di enrichment nel fixture)`);
  assert(networkFailures.length === 0 || networkFailures.every(entry => !entry.includes('test-cardinfo')),
    `Risposte di rete >=400 inattese: ${JSON.stringify(networkFailures)}`);
  // resolveStoredCard incatena piu tentativi per candidato (lookup per id
  // IT+EN, poi ricerca per nome IT+EN, poi eventuale fallback sul token piu
  // distintivo IT+EN — vedi js/cards.js): nel peggiore dei casi ~8 richieste
  // per riga. Con un batch da 20 righe il tetto realistico e' ~160; con
  // 2500 pending scaricati per intero (la regressione da evitare) sarebbero
  // decine di migliaia. 300 lascia margine senza nascondere una regressione.
  assert(cardinfoRequests <= 300,
    `${cardinfoRequests} richieste cardinfo.php: il bootstrap ha interrogato il provider per (quasi) l'intera coda di 2500 pending invece di un batch piccolo`);

  console.log(`PASS bootstrap singolo: list_collection_catalog_verification_queue x${rpcCounts.list_collection_catalog_verification_queue || 0} (p_limit<=50), ${cardinfoRequests} richieste cardinfo.php (<=300, non decine di migliaia), repair_collection_item_catalog_identity x${repairCalls} (<=50, non l'intera coda di 2500), enrich_loan_card x${rpcCounts.enrich_loan_card || 0} (0 attese)`);
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { server.close(); } catch {}
  try { browser?.kill(); } catch {}
});
