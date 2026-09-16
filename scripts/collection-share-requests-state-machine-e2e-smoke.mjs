// Shared Collection — Richieste: verifica end-to-end nel browser reale (Chrome
// headless + CDP, stesso harness di scripts/p0-nav-regression-smoke.mjs) del
// flusso pending -> confirmed -> completed introdotto da
// supabase/migrations/20260917120000_collection_share_requests_state_machine.sql.
//
// Nessun Postgres reale in questa sessione (le migration le esegue l'utente),
// quindi window.supabase è sostituito da un mock che tiene lo STATO delle
// richieste in memoria e lo muta esattamente come farebbero le RPC reali
// (confirm/complete/cancel), così list_collection_share_requests successive
// riflettono il nuovo stato — a differenza dei test puramente statici, questo
// esercita il VERO app.js/js/api.js in un browser reale: click sui bottoni,
// cambio tab, rendering di prezzo/totale/note di stato.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

// Stato iniziale delle richieste, già nella forma restituita da
// list_collection_share_requests (camelCase) — mutato in place dai mock di
// confirm/complete/cancel, esattamente come farebbe la RPC reale sul DB.
const requests = [
  {
    id:'req-pending', requesterName:'Marco Ospite', status:'pending', createdAt:new Date().toISOString(),
    completedAt:null, game:'yugioh', message:'Mi interessano queste due!',
    items:[
      { printingId:'printing-1', cardName:'Blue-Eyes White Dragon', setCode:'LOB-001', rarity:'Ultra Rare', imageUrl:'', quantity:2, unitPrice:12.5, lineTotal:25 },
      { printingId:'printing-2', cardName:'Dark Magician', setCode:'LOB-005', rarity:'Ultra Rare', imageUrl:'', quantity:1, unitPrice:null, lineTotal:null }
    ],
    totalPrice:25
  },
  {
    id:'req-seen-legacy', requesterName:'Legacy Guest', status:'seen', createdAt:new Date(Date.now() - 86400000).toISOString(),
    completedAt:null, game:'yugioh', message:null,
    items:[{ printingId:'printing-3', cardName:'Red-Eyes Black Dragon', setCode:'LOB-070', rarity:'Ultra Rare', imageUrl:'', quantity:1, unitPrice:8, lineTotal:8 }],
    totalPrice:8
  },
  {
    id:'req-to-reject', requesterName:'Da Rifiutare', status:'pending', createdAt:new Date().toISOString(),
    completedAt:null, game:'yugioh', message:null,
    items:[{ printingId:'printing-4', cardName:'Summoned Skull', setCode:'LOB-052', rarity:'Ultra Rare', imageUrl:'', quantity:1, unitPrice:5, lineTotal:5 }],
    totalPrice:5
  },
  {
    id:'req-confirmed-to-cancel', requesterName:'Confermata Da Annullare', status:'confirmed', createdAt:new Date().toISOString(),
    completedAt:null, game:'yugioh', message:null,
    items:[{ printingId:'printing-5', cardName:'Mirror Force', setCode:'MFC-000', rarity:'Ultra Rare', imageUrl:'', quantity:1, unitPrice:3, lineTotal:3 }],
    totalPrice:3
  }
];

const fakeSupabaseSource = `(()=>{
  window.__rpcCounts={};
  const track=name=>{window.__rpcCounts[name]=(window.__rpcCounts[name]||0)+1;};
  const members=${JSON.stringify(members)};
  let requests=${JSON.stringify(requests)};
  let currentSlug='daniele';
  const listResponses={
    list_login_members:()=>members,
    list_team_loans:()=>[],
    list_my_collection:()=>[],
    list_my_decks:()=>[],
    list_my_decks_with_boxes:()=>[],
    list_collection_shares:()=>[],
    list_collection_share_requests:()=>requests,
    get_my_progression:()=>({totalXp:0,level:1,xpToday:0,dailyCap:100}),
    get_stats:()=>[],
    get_team_stats:()=>[],
    get_match_streak:()=>({result:null,count:0})
  };
  const findReq=id=>{const r=requests.find(x=>x.id===id); if(!r) throw new Error('Richiesta non trovata'); return r;};
  const client={
    async rpc(name,args={}){
      track(name);
      if(name==='login_member'){
        const profile=members.find(item=>item.slug===args.p_slug);
        currentSlug=profile.slug;
        return {data:{slug:profile.slug,name:profile.full_name,role:profile.role},error:null};
      }
      if(name==='confirm_collection_share_request'){
        try{
          const r=findReq(args.p_request_id);
          if(!['pending','seen'].includes(r.status)) throw new Error('Solo le richieste in attesa possono essere confermate');
          r.status='confirmed';
          return {data:null,error:null};
        }catch(err){return {data:null,error:{message:err.message}};}
      }
      if(name==='complete_collection_share_request'){
        try{
          const r=findReq(args.p_request_id);
          if(r.status!=='confirmed') throw new Error('Solo le richieste confermate possono essere completate');
          r.status='completed'; r.completedAt=new Date().toISOString();
          return {data:null,error:null};
        }catch(err){return {data:null,error:{message:err.message}};}
      }
      if(name==='cancel_collection_share_request'){
        try{
          const r=findReq(args.p_request_id);
          if(!['pending','seen','confirmed'].includes(r.status)) throw new Error('Questa richiesta non può più essere annullata');
          r.status='cancelled';
          return {data:null,error:null};
        }catch(err){return {data:null,error:{message:err.message}};}
      }
      if(name==='mark_collection_share_request_seen'){
        return {data:null,error:{message:'RPC ritirata: la funzione non esiste più'}};
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
  const profile = path.join(os.tmpdir(), `fpt-share-requests-e2e-smoke-${Date.now()}`);
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio:'ignore', windowsHide:true });
  await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`);
  const tab = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, { method:'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = new CdpClient(ws);

  const consoleErrors = [];
  const exceptions = [];
  cdp.on('Runtime.exceptionThrown', event => {
    exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Eccezione JavaScript');
  });
  cdp.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error') consoleErrors.push((event.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  });

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
    const diagnostic = await evaluate(`({url:location.href,body:document.body.innerText.slice(0,400)})`);
    throw new Error(`${message} · ${JSON.stringify(diagnostic)}`);
  };
  const click = selector => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('selettore non trovato: ${selector.replace(/'/g, "\\'")}'); el.click(); return true;})()`);
  const selectMember = slug => evaluate(`(()=>{const s=document.querySelector('#member');s.value=${JSON.stringify(slug)};s.dispatchEvent(new Event('change',{bubbles:true}));return s.value})()`);
  const submitPin = pin => evaluate(`(()=>{const p=document.querySelector('#pin');p.value=${JSON.stringify(pin)};p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit(document.querySelector('#login-form button[type="submit"]'));return true})()`);

  await waitFor(`document.querySelectorAll('#member option').length >= ${members.length}`, 'I membri non sono comparsi nel select');
  await selectMember('daniele');
  await submitPin('1234');
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Login non completato');
  console.log('PASS login');

  // Raggiunge Richieste passando da "Altro" (non è nella sidebar desktop) —
  // stesso percorso reale di un utente.
  await click('.mobile-nav button[data-page="more"]');
  await waitFor(`Boolean(document.querySelector('.more-grid'))`, 'Pagina "Altro" non renderizzata');
  await click('.more-grid button[data-page="requests"]');
  await waitFor(`Boolean(document.querySelector('.share-request-list, .inline-empty'))`, 'Pagina Richieste non renderizzata');
  console.log('PASS navigazione fino a Richieste');

  // --- Tab "In attesa": pending + legacy seen, MAI la parola "Confermata" per seen ---
  await waitFor(`document.querySelector('[data-requests-tab="pending"] span')?.textContent === '3'`, 'Tab In attesa non mostra 3 richieste (2 pending + 1 seen legacy)');
  let rows = await evaluate(`[...document.querySelectorAll('.share-request-row')].map(r=>r.querySelector('strong').textContent)`);
  assert(rows.includes('Marco Ospite') && rows.includes('Legacy Guest') && rows.includes('Da Rifiutare'), `tab pending non contiene le righe attese: ${JSON.stringify(rows)}`);
  const pendingRowsHtml = await evaluate(`document.querySelector('.share-request-list').outerHTML`);
  assert(!pendingRowsHtml.includes('>Confermata<'), 'nessuna richiesta pending/seen deve mostrare la parola "Confermata"');
  console.log('PASS tab In attesa: pending + seen legacy raggruppate, azioni Rifiuta/Conferma');

  // --- Prezzo/totale mostrati correttamente (snapshot dal server) ---
  const marcoRowText = await evaluate(`[...document.querySelectorAll('.share-request-row')].find(r=>r.querySelector('strong').textContent==='Marco Ospite').innerText`);
  assert(marcoRowText.includes('12,50') || marcoRowText.includes('12,5'), `prezzo unitario 12.5 non mostrato: ${marcoRowText}`);
  assert(marcoRowText.includes('prezzo n/d') || marcoRowText.toLowerCase().includes('n/d'), `prezzo mancante deve mostrare n/d: ${marcoRowText}`);
  assert(marcoRowText.includes('25,00') || marcoRowText.includes('25'), `totale stimato 25 non mostrato: ${marcoRowText}`);
  console.log('PASS prezzo unitario/lineTotal/totalPrice mostrati correttamente, n/d per prezzo mancante');

  // --- Rifiuta una pending ---
  await click(`[data-reject-request="req-to-reject"]`);
  await waitFor(`![...document.querySelectorAll('.share-request-row strong')].some(el=>el.textContent==='Da Rifiutare')`, 'la richiesta rifiutata è ancora visibile nel tab pending');
  await waitFor(`document.querySelector('[data-requests-tab="pending"] span')?.textContent === '2'`, 'il conteggio pending non è sceso dopo il rifiuto');
  console.log('PASS Rifiuta: la richiesta sparisce dal tab In attesa');

  // --- Conferma la richiesta legacy "seen" (promozione esplicita, non automatica) ---
  await click(`[data-confirm-request="req-seen-legacy"]`);
  await waitFor(`document.querySelector('[data-requests-tab="confirmed"] span')?.textContent === '2'`, 'req-seen-legacy non risulta confermata (atteso: 1 pre-esistente + 1 promossa = 2)');
  console.log('PASS Conferma su una richiesta legacy "seen": promossa a confirmed via la stessa RPC validata');

  // --- Tab Confermate: nota "riservate", azioni Annulla / Segna come effettuata ---
  await click('[data-requests-tab="confirmed"]');
  await waitFor(`Boolean(document.querySelector('.share-request-row.confirmed'))`, 'nessuna riga confirmed nel tab Confermate');
  const confirmedHtml = await evaluate(`document.querySelector('.share-request-list').outerHTML`);
  assert(confirmedHtml.includes('riservate'), 'manca l\'indicazione "riservate" per le richieste confermate');
  assert(confirmedHtml.includes('data-cancel-confirmed-request'), 'manca il bottone Annulla');
  assert(confirmedHtml.includes('data-complete-request'), 'manca il bottone "Segna come effettuata"');
  console.log('PASS tab Confermate: nota "riservate" + azioni Annulla/Segna come effettuata');

  // --- Annulla una conferma: torna a liberare (sparisce da Confermate, MAI in nessun tab visibile) ---
  await click(`[data-cancel-confirmed-request="req-confirmed-to-cancel"]`);
  await waitFor(`document.querySelector('[data-requests-tab="confirmed"] span')?.textContent === '1'`, 'il conteggio confirmed non è sceso dopo Annulla');
  console.log('PASS Annulla conferma: la richiesta esce dal tab Confermate');

  // --- Completa la richiesta rimasta confirmed ---
  await click(`[data-complete-request="req-seen-legacy"]`);
  await waitFor(`document.querySelector('[data-requests-tab="completed"] span')?.textContent === '1'`, 'la richiesta completata non è comparsa nel tab Effettuate');
  await click('[data-requests-tab="completed"]');
  await waitFor(`Boolean(document.querySelector('.share-request-row.completed'))`, 'nessuna riga completed nel tab Effettuate');
  const completedHtml = await evaluate(`document.querySelector('.share-request-list').outerHTML`);
  assert(completedHtml.includes('Effettuata il'), 'manca la data di completamento');
  assert(completedHtml.includes('rimosse dalla tua raccolta'), 'manca la nota "carte rimosse dalla raccolta"');
  assert(!completedHtml.includes('data-complete-request') && !completedHtml.includes('data-cancel-confirmed-request') && !completedHtml.includes('data-confirm-request'), 'una richiesta completed deve essere sola lettura, senza azioni');
  console.log('PASS tab Effettuate: sola lettura, data completamento, nota rimozione dalla raccolta');

  assert(exceptions.length === 0, `Eccezioni JS non gestite: ${JSON.stringify(exceptions)}`);
  assert(consoleErrors.length === 0, `console.error registrati: ${JSON.stringify(consoleErrors)}`);

  console.log('PASS Shared Collection Richieste — E2E browser reale: navigazione, 3 tab, prezzi/totale dal server, Rifiuta, Conferma (anche su legacy seen), Annulla conferma, Segna come effettuata — nessun errore console/eccezione');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { server.close(); } catch {}
  try { browser?.kill(); } catch {}
});
