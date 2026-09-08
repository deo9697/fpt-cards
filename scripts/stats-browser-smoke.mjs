// Verifica end-to-end via CDP reale (headless Chrome, Supabase mockato in
// processo — nessuna scrittura verso il Supabase reale) del flusso completo
// Statistiche/XP: apertura pagina, registrazione match con feedback XP/level
// up, aggiornamento della barra XP in header, drawer Progression, pannello
// avatar. Stesso pattern di scripts/auth-regression-smoke.mjs.
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
const deck = {
  id:'44444444-4444-4444-8444-444444444444', owner_slug:'daniele', game:'yugioh', name:'Ryzeal',
  format:'TCG Avanzato', signature_card_id:null, deck_theme:'arcane-purple', deck_box_template:'procedural',
  cover_image_url:'', cards:[{ catalog_card_id:'46986414', card_name:'Dark Magician', image_url:'', ban_tcg:'', section:'main', quantity:1, printing_id:null }]
};

const fakeSupabaseSource = `(()=>{
  const members=${JSON.stringify(members)};
  const decks=${JSON.stringify([deck])};
  let currentSlug='daniele';
  let totalXp=0, level=1, xpToday=0;
  const matches=[];
  const LEVEL_THRESHOLDS=[0,75,200,375,600,875,1200,1575,2000,2475,3000];
  const levelFromXp=xp=>{let lvl=1;for(let i=1;i<LEVEL_THRESHOLDS.length;i+=1){if(xp<LEVEL_THRESHOLDS[i])break;lvl=i+1;}return lvl;};
  window.__statsTest={registerCalls:0};
  const client={
    async rpc(name,args={}){
      if(name==='list_login_members') return {data:members,error:null};
      if(name==='login_member'){const profile=members.find(m=>m.slug===args.p_slug);currentSlug=profile.slug;return {data:{slug:profile.slug,name:profile.full_name,role:profile.role},error:null};}
      if(name==='list_team_loans') return {data:[],error:null};
      if(name==='list_my_collection') return {data:[],error:null};
      if(name==='list_team_collection') return {data:[],error:null};
      if(name==='list_my_decks_with_boxes'||name==='list_my_decks') return {data:decks,error:null};
      if(name==='list_market_watch') return {data:{items:[],deckUnresolved:[],lastSync:new Date().toISOString()},error:null};
      if(name==='list_market_dashboard_movers') return {data:[],error:null};
      if(name==='list_market_price_history') return {data:[],error:null};
      if(name==='list_collection_share_requests') return {data:[],error:null};
      if(name==='list_collection_catalog_verification_queue') return {data:[],error:null};
      if(name==='get_my_progression') return {data:{totalXp,level,xpToday,dailyCap:100},error:null};
      if(name==='get_stats') return {data:matches.filter(m=>!args.p_deck_id||m.deck_id===args.p_deck_id).length?[{deck_id:decks[0].id,deck_name:decks[0].name,matches:matches.length,wins:matches.filter(m=>m.result==='win').length,losses:matches.filter(m=>m.result==='loss').length,draws:matches.filter(m=>m.result==='draw').length,win_rate:matches.length?Math.round(matches.filter(m=>m.result==='win').length/matches.length*1000)/10:0}]:[],error:null};
      if(name==='get_team_stats') return {data:[],error:null};
      if(name==='get_match_streak'){
        if(!matches.length) return {data:{result:null,count:0},error:null};
        const top=matches[matches.length-1].result; let count=0;
        for(let i=matches.length-1;i>=0&&matches[i].result===top;i-=1)count+=1;
        return {data:{result:top,count},error:null};
      }
      if(name==='register_match'){
        window.__statsTest.registerCalls+=1;
        const base=10+(args.p_result==='win'?5:args.p_result==='draw'?2:0);
        const awarded=Math.min(base,Math.max(0,100-xpToday));
        xpToday+=awarded;
        matches.push({deck_id:args.p_deck_id,result:args.p_result});
        const levelBefore=level;
        totalXp+=awarded;
        level=levelFromXp(totalXp);
        return {data:{match:{id:'match-'+matches.length},xpAwarded:awarded,totalXp,level,levelUp:level>levelBefore},error:null};
      }
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
  if (requestPath === '/test-supabase.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return res.end(fakeSupabaseSource); }
  const relative = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); return res.end('not found'); }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    if (relative === 'index.html') return res.end(data.toString('utf8').replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', '/test-supabase.js'));
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
  on(method, handler) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(handler); }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function waitForUrl(url, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) { try { return await (await fetch(url)).json(); } catch { await delay(100); } }
  throw new Error(`Endpoint CDP non disponibile: ${url}`);
}

let exceptionsGlobal = []; let consoleErrorsGlobal = [];
async function run() {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const profile = path.join(os.tmpdir(), `fpt-stats-smoke-${Date.now()}`);
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio:'ignore', windowsHide:true });
  await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`);
  const tab = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, { method:'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = new CdpClient(ws);
  const consoleErrors = []; const exceptions = [];
  exceptionsGlobal = exceptions; consoleErrorsGlobal = consoleErrors;
  cdp.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Eccezione JavaScript'));
  cdp.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') consoleErrors.push((event.args || []).map(a => a.value ?? a.description ?? '').join(' ')); });
  await cdp.call('Runtime.enable');
  await cdp.call('Page.navigate', { url:`http://127.0.0.1:${port}/#/home` });

  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue:true, awaitPromise:true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, message, attempts = 80) => {
    for (let index = 0; index < attempts; index += 1) { if (await evaluate(expression)) return; await delay(100); }
    const diagnostic = await evaluate(`({url:location.href,body:document.body.innerText.slice(0,200)})`);
    throw new Error(`${message} · ${JSON.stringify(diagnostic)}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);

  await waitFor(`document.querySelectorAll('#member option').length >= 1`, 'I membri non sono comparsi nel select');
  await evaluate(`(()=>{const s=document.querySelector('#member');s.value='daniele';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await evaluate(`(()=>{const p=document.querySelector('#pin');p.value='1234';p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit(document.querySelector('#login-form button[type="submit"]'));})()`);
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Login non completato');
  console.log('PASS login');

  await click('.sidebar button[data-page="stats"]');
  await waitFor(`Boolean(document.querySelector('.stats-page'))`, 'Pagina Statistiche non renderizzata');
  assert(await evaluate(`!document.querySelector('.fab')`), 'Il FAB "Nuovo prestito" resta visibile in Statistiche e si sovrappone al modal di registrazione match');
  console.log('PASS navigazione a Statistiche (nessun FAB residuo di altre sezioni)');

  await click('[data-stats-new-match]');
  await waitFor(`Boolean(document.querySelector('[data-match-deck]'))`, 'Modal registrazione match non apparso');
  assert(await evaluate(`document.querySelectorAll('[data-match-deck] option').length === 1 && document.querySelector('[data-match-deck] option').textContent.includes('Ryzeal')`), 'Il selettore mazzo del match non mostra solo i mazzi del gioco/utente corrente');
  await click('[data-match-result="win"]');
  assert(await evaluate(`document.querySelector('[data-match-result="win"]').classList.contains('active')`), 'Il bottone Vittoria non risulta selezionato dopo il click');
  await click('[data-match-submit]');
  await waitFor(`document.querySelector('.match-feedback-xp')?.textContent.includes('+15')`, 'Feedback XP dopo la registrazione match non mostrato');
  assert(await evaluate(`document.querySelector('.match-feedback-result')?.textContent.trim() === 'Vittoria'`), 'Il feedback non mostra il risultato corretto');
  console.log('PASS registrazione match: modal filtrato per gioco/utente, feedback +15 XP mostrato');

  await click('[data-match-close]');
  await waitFor(`!document.querySelector('.match-feedback')`, 'Il feedback match non si chiude');
  await waitFor(`document.querySelector('.stats-deck-bar-row')?.textContent.includes('1 match')`, 'La lista statistiche non riflette il match appena registrato');
  console.log('PASS lista statistiche aggiornata dopo il match (nessuna richiesta manuale di refresh)');

  assert(await evaluate(`document.querySelector('.stats-tile.accent b')?.textContent.trim() === '100%'`), "La tile win-rate della panoramica Io non riflette il 100% dopo l'unica vittoria registrata");
  assert(await evaluate(`Boolean(document.querySelector('.stats-player-card'))`), 'La player card della panoramica Io non è presente');
  console.log('PASS panoramica Io: tile win-rate aggiornata dopo il match');

  await waitFor(`document.querySelector('.xp-strip-level')?.textContent.includes('LV 1')`, 'La barra XP in header non riflette il livello corrente dopo il match');
  assert(await evaluate(`document.querySelector('.xp-strip-identity')?.textContent.includes('Daniele')`), 'Header: nome del membro non mostrato accanto alla barra XP');
  await click('[data-open-progression]');
  await waitFor(`Boolean(document.querySelector('.progression-drawer'))`, "Il drawer Progression non si apre dall'header");
  assert(await evaluate(`document.querySelector('.progression-drawer').textContent.includes('15')`), 'Il drawer Progression non mostra gli XP totali aggiornati');
  await click('[data-close-progression]');
  await waitFor(`!document.querySelector('.progression-drawer')`, 'Il drawer Progression non si chiude');
  console.log('PASS header: barra XP aggiornata, drawer Progression apre/chiude e mostra XP correnti');

  await click('[data-open-avatar]');
  await waitFor(`Boolean(document.querySelector('.avatar-panel'))`, 'Il pannello avatar non si apre');
  assert(await evaluate(`document.querySelector('.avatar-panel').textContent.includes('Statistiche') && document.querySelector('.avatar-panel').textContent.includes('Impostazioni') && document.querySelector('.avatar-panel').textContent.includes('Personalizza')`), 'Il pannello avatar non mostra le 3 voci attese');
  await click('[data-avatar-goto="settings"]');
  await waitFor(`!document.querySelector('.avatar-panel')`, 'Il pannello avatar non si chiude dopo la navigazione');
  assert(await evaluate(`location.hash === '#/settings'`), 'Il pannello avatar non naviga a Impostazioni');
  console.log('PASS pannello avatar: voci corrette, chiusura e navigazione su click');

  assert(exceptions.length === 0, `Eccezioni JS non gestite: ${JSON.stringify(exceptions)}`);
  assert(consoleErrors.length === 0, `console.error registrati: ${JSON.stringify(consoleErrors)}`);
  console.log('stats-browser-smoke: OK — flusso match/header/drawer/avatar verificato via CDP reale, zero errori console');
}

run().catch(error => { console.error(error); console.error('exceptions:', exceptionsGlobal, 'consoleErrors:', consoleErrorsGlobal); process.exitCode = 1; }).finally(async () => {
  try { server.close(); } catch {}
  try { browser?.kill(); } catch {}
});
