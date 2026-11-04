// Bug reale segnalato dall'utente 2026-11-04: ha condiviso il link della sua
// raccolta una sola volta, e chi/cosa l'ha aperto ha visto "Link non valido
// o revocato". create_collection_share (supabase-collection-sharing.sql)
// revoca SEMPRE il link attivo corrente prima di inserirne uno nuovo —
// voluto per "Rigenera", ma openCollectionShareModal() in app.js non aveva
// nessuna guardia contro un doppio avvio concorrente (doppio tap, o un
// secondo click sintetico del browser prima che il re-render sostituisca il
// bottone): due chiamate quasi simultanee significano due link creati, e la
// seconda revoca silenziosamente il link appena creato dalla prima — prima
// che chiunque lo apra. Questo smoke dimostra il doppio click sincrono sullo
// stesso bottone e verifica che ora parta una sola create_collection_share.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const root = process.cwd();
const port = 8097;
const debugPort = 9382;
let browser;
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find(fs.existsSync);
if (!chrome) throw new Error('Google Chrome non trovato');

const members = [{ slug:'existing-member', full_name:'Existing Member', role:'guest' }];
const fakeSupabaseSource = `(()=>{
  const members=${JSON.stringify(members)};
  let currentSlug='';
  window.__shareTest={listCalls:0,createCalls:0,createDelay:150,activeShares:[]};
  const client={
    async rpc(name,args={}){
      if(name==='list_login_members'||name==='list_team_members') return {data:members,error:null};
      if(name==='get_my_team') return {data:null,error:null};
      if(name==='login_member'){currentSlug=args.p_slug;return {data:{slug:args.p_slug,name:'Existing Member',role:'guest'},error:null};}
      if(name==='list_team_loans') return {data:[],error:null};
      if(name==='list_my_collection') return {data:[],error:null};
      if(name==='list_team_collection') return {data:[],error:null};
      if(name==='list_my_decks'||name==='list_my_decks_with_boxes') return {data:[],error:null};
      if(name==='list_market_watch') return {data:{items:[],deckUnresolved:[],lastSync:null},error:null};
      if(name==='list_market_dashboard_movers') return {data:[],error:null};
      if(name==='get_my_progression') return {data:{totalXp:0,level:1,xpToday:0,dailyCap:100},error:null};
      if(name==='get_stats') return {data:[],error:null};
      if(name==='get_team_stats') return {data:[],error:null};
      if(name==='list_collection_share_requests') return {data:[],error:null};
      // --- Il comportamento sotto test: mirror di create_collection_share
      // (supabase-collection-sharing.sql) — revoca sempre l'unico link
      // attivo per owner+game prima di inserirne uno nuovo, con un ritardo
      // artificiale per dare al secondo click la finestra per partire prima
      // che il primo abbia finito, esattamente come una vera chiamata di
      // rete farebbe.
      if(name==='list_collection_shares'){
        window.__shareTest.listCalls+=1;
        return {data:window.__shareTest.activeShares.map(share=>({id:share.id,game:share.game,createdAt:share.createdAt,active:true})),error:null};
      }
      if(name==='create_collection_share'){
        window.__shareTest.createCalls+=1;
        await new Promise(resolve=>setTimeout(resolve,window.__shareTest.createDelay));
        for(const share of window.__shareTest.activeShares)if(share.game===args.p_game)share.active=false;
        window.__shareTest.activeShares=window.__shareTest.activeShares.filter(share=>share.active);
        const id='share-'+window.__shareTest.createCalls;
        window.__shareTest.activeShares.push({id,game:args.p_game,createdAt:new Date().toISOString(),active:true});
        return {data:id,error:null};
      }
      return {data:null,error:null};
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
  const relative = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); return res.end('not found'); }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    if (relative === 'index.html') {
      return res.end(data.toString('utf8').replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', '/test-supabase.js'));
    }
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
  const profile = path.join(os.tmpdir(), `fpt-share-double-create-smoke-${Date.now()}`);
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio:'ignore', windowsHide:true });
  await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`);
  const tab = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, { method:'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = new CdpClient(ws);
  cdp.on('Runtime.exceptionThrown', event => {
    console.error(`BROWSER ${event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Eccezione JavaScript'}`);
  });

  await cdp.call('Runtime.enable');
  await cdp.call('Page.navigate', { url:`http://127.0.0.1:${port}/#/home` });

  const evaluate = async expression => (await cdp.call('Runtime.evaluate', { expression, returnByValue:true, awaitPromise:true })).result.value;
  const waitFor = async (expression, message, attempts = 80) => {
    for (let index = 0; index < attempts; index += 1) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw new Error(`${message} · ${JSON.stringify(await evaluate(`({url:location.href,body:document.body.innerText.slice(0,160)})`))}`);
  };
  const selectMember = slug => evaluate(`(()=>{const s=document.querySelector('#member');s.value=${JSON.stringify(slug)};s.dispatchEvent(new Event('change',{bubbles:true}));return s.value})()`);
  const submitPin = pin => evaluate(`(()=>{const p=document.querySelector('#pin');p.value=${JSON.stringify(pin)};p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit(document.querySelector('#login-form button[type="submit"]'));return true})()`);

  await waitFor(`document.querySelectorAll('#member option').length === 2`, 'I membri non sono comparsi nel select');
  await selectMember('existing-member'); await submitPin('1234');
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Login non completato');

  await evaluate(`document.querySelector('[data-page="collection"]').click()`);
  await waitFor(`Boolean(document.querySelector('[data-collection-share]'))`, 'Bottone Condividi raccolta non renderizzato');

  // I due click partono nello STESSO script evaluate, quindi nella stessa
  // esecuzione sincrona: openCollectionShareModal() gira run-to-completion
  // fino al primo await, quindi il secondo click vede già collectionShareOpening
  // impostato dal primo PRIMA che quest'ultimo ceda il controllo — esattamente
  // la finestra di race reale (doppio tap fisico, o un secondo click
  // sintetico del browser prima del re-render).
  await evaluate(`(()=>{const b=document.querySelector('[data-collection-share]');b.click();b.click();})()`);
  await waitFor(`Boolean(document.querySelector('[data-share-url]'))`, 'Il link di condivisione non è apparso nel popup dopo il doppio click');
  await delay(400);

  const result = await evaluate(`({createCalls:window.__shareTest.createCalls,listCalls:window.__shareTest.listCalls,activeShares:window.__shareTest.activeShares.length,shownUrl:document.querySelector('[data-share-url]')?.value||''})`);
  assert(result.createCalls === 1, `REGRESSIONE: un doppio click sul bottone Condividi ha generato ${result.createCalls} chiamate a create_collection_share invece di 1 — il secondo link creato revoca silenziosamente il primo appena condiviso: ${JSON.stringify(result)}`);
  assert(result.activeShares === 1, `Più di un link risulta attivo dopo il doppio click: ${JSON.stringify(result)}`);
  assert(result.shownUrl.includes('share-1'), `Il popup non mostra il link effettivamente creato: ${JSON.stringify(result)}`);
  console.log('PASS doppio click su "Condividi raccolta": una sola create_collection_share, un solo link attivo, nessuna revoca silenziosa del link appena condiviso');

  console.log('Collection share double-create regression: 1/1 PASS');
}

run()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { browser?.kill(); server.close(); });
