import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const root = process.cwd();
const port = 8091;
const debugPort = 9351;
let browser;
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find(fs.existsSync);
if (!chrome) throw new Error('Google Chrome non trovato');

const members = [
  { slug:'existing-member', full_name:'Existing Member', role:'guest' },
  { slug:'first-access', full_name:'First Access', role:'guest' }
];
const loan = {
  id:'11111111-1111-4111-8111-111111111111', card_name:'Dark Magician', quantity:1,
  owner_slug:'first-access', borrower_slug:'existing-member', notes:'', status:'active',
  created_at:new Date().toISOString(), returned_at:null,
  card_image:'https://images.ygoprodeck.com/images/cards/89631139.jpg', card_external_id:'46986414',
  game:'yugioh', returned_quantity:0, pending_return_quantity:0
};
const fakeSupabaseSource = `(()=>{
  const members=${JSON.stringify(members)};
  const loans=${JSON.stringify([loan])};
  let collectionItems=[{id:'team-item',printing_id:'team-printing',owner_slug:'first-access',owner_name:'First Access',game:'yugioh',catalog_card_id:'46986414',card_name:'Dark Magician',set_code:'SDY-006',set_name:'Starter Deck Yugi',rarity:'Ultra Rare',language:'Italiano',condition:'Near Mint',edition:'',image_url:'https://images.ygoprodeck.com/images/cards/46986414.jpg',quantity_owned:3,quantity_loaned:0,quantity_reserved:0,quantity_physically_available:3,legacy_ambiguous:false,updated_at:new Date().toISOString()}];let decks=[];
  let currentSlug='existing-member';
  window.__authTest={wrongPinMode:false,lastLoginSlug:'',createCalls:0,requestCalls:0,holdCreate:false,syncDelay:0,syncInFlight:0,syncMaxInFlight:0};
  window.__authTest.getCollection=()=>collectionItems;
  const client={
    async rpc(name,args={}){
      if(['list_team_loans','list_my_collection','list_team_collection','list_my_decks','list_my_decks_with_boxes','list_market_watch'].includes(name)&&window.__authTest.syncDelay){window.__authTest.syncInFlight+=1;window.__authTest.syncMaxInFlight=Math.max(window.__authTest.syncMaxInFlight,window.__authTest.syncInFlight);await new Promise(resolve=>setTimeout(resolve,window.__authTest.syncDelay));window.__authTest.syncInFlight-=1;}
      if(name==='list_login_members') return {data:members,error:null};
      if(name==='login_member'){
        window.__authTest.lastLoginSlug=args.p_slug||'';
        if(window.__authTest.wrongPinMode) return {data:null,error:{message:'PIN non corretto'}};
        const profile=members.find(item=>item.slug===args.p_slug);
        currentSlug=profile.slug;
        return {data:{slug:profile.slug,name:profile.full_name,role:profile.role},error:null};
      }
      if(name==='list_team_loans') return {data:loans,error:null};
      if(name==='list_my_collection') return {data:collectionItems.filter(item=>item.owner_slug===currentSlug),error:null};
      if(name==='list_team_collection') return {data:collectionItems.map(({quantity_owned,...item})=>item),error:null};
      if(name==='list_my_decks'||name==='list_my_decks_with_boxes') return {data:decks,error:null};
      if(name==='list_market_watch') return {data:{items:[{printing_id:'team-printing',catalog_card_id:'46986414',card_name:'Dark Magician',set_code:'SDY-006',set_name:'Starter Deck Yugi',rarity:'Ultra Rare',image_url:'https://images.ygoprodeck.com/images/cards/46986414.jpg',sources:['owned'],owned_quantity:3,reference_price:12,price_24h:10,price_7d:8,price_30d:7,latest_at:new Date().toISOString(),providers:{cardmarket:{price:12,type:'trend',capturedAt:new Date().toISOString()}}}],deckUnresolved:[],lastSync:new Date().toISOString()},error:null};
      if(name==='list_market_dashboard_movers') return {data:[{printingId:'team-printing',catalogCardId:'46986414',cardName:'Dark Magician',imageUrl:'https://images.ygoprodeck.com/images/cards/46986414.jpg',referencePrice:12,baselinePrice:10,positiveChange:20,sparkline:[{label:'AVG30',price:8,order:1},{label:'AVG7',price:10,order:2},{label:'TREND',price:12,order:4}]}],error:null};
      if(name==='list_market_price_history') return {data:[{provider:'cardmarket',price_type:'trend',price:8,captured_at:new Date(Date.now()-86400000).toISOString()},{provider:'cardmarket',price_type:'trend',price:12,captured_at:new Date().toISOString()}],error:null};
      if(name==='save_deck'||name==='save_deck_with_box'){const id=args.p_deck.id||'44444444-4444-4444-8444-444444444444',row={id,owner_slug:currentSlug,game:args.p_deck.game,name:args.p_deck.name,format:args.p_deck.format,signature_card_id:args.p_deck.signatureCardId||null,deck_theme:args.p_deck.deckTheme||'arcane-purple',deck_box_template:args.p_deck.deckBoxTemplate||'procedural',cover_image_url:args.p_deck.cards[0]?.imageUrl||'',cards:args.p_deck.cards.map(card=>({catalog_card_id:card.catalogCardId,card_name:card.cardName,image_url:card.imageUrl,ban_tcg:card.banTcg||'',section:card.section,quantity:card.quantity,printing_id:card.printingId||null}))};decks=decks.filter(deck=>deck.id!==id);decks.push(row);return {data:id,error:null};}
      if(name==='delete_deck'){decks=decks.filter(deck=>deck.id!==args.p_id);return {data:null,error:null};}
      if(name==='lookup_card_printings_by_set_code') return {data:collectionItems.filter(item=>item.game===args.p_game&&item.set_code===args.p_set_code).map(item=>({printing_id:item.printing_id,game:item.game,catalog_card_id:item.catalog_card_id,card_name:item.card_name,set_code:item.set_code,set_name:item.set_name,rarity:item.rarity,image_url:item.image_url})),error:null};
      if(name==='save_collection_batch'){
        window.__authTest.lastBatch=args.p_items;
        if(args.p_items.some(item=>'owner' in item)) return {data:null,error:{message:'Owner client non consentito'}};
        for(const item of args.p_items){const source=collectionItems.find(row=>row.printing_id===item.printingId)||item;const existing=collectionItems.find(row=>row.owner_slug===currentSlug&&row.printing_id===(item.printingId||source.printing_id)&&row.language===item.language&&row.condition===item.condition&&row.edition===item.edition);if(existing)existing.quantity_owned+=item.quantityDelta;else collectionItems.push({id:'scan-own-'+collectionItems.length,printing_id:item.printingId||'scan-printing',owner_slug:currentSlug,owner_name:members.find(member=>member.slug===currentSlug)?.full_name||currentSlug,game:item.game,catalog_card_id:item.catalogCardId,card_name:item.cardName,set_code:item.setCode,set_name:item.setName,rarity:item.rarity,language:item.language,condition:item.condition,edition:item.edition,image_url:item.imageUrl,quantity_owned:item.quantityDelta,quantity_loaned:0,quantity_reserved:0,quantity_physically_available:item.quantityDelta,legacy_ambiguous:false,updated_at:new Date().toISOString()});}
        return {data:{savedItems:args.p_items.length,totalQuantity:args.p_items.reduce((sum,item)=>sum+item.quantityDelta,0),owner:currentSlug},error:null};
      }
      if(name==='save_collection_item'){
        const id=args.p_id||'22222222-2222-4222-8222-222222222222';
        const current=collectionItems.find(item=>item.id===id);
        const owned=args.p_quantity_mode==='increment'&&current?current.quantity_owned+args.p_quantity_owned:args.p_quantity_owned;
        const row={id,printing_id:'33333333-3333-4333-8333-333333333333',owner_slug:currentSlug,owner_name:members.find(item=>item.slug===currentSlug)?.full_name||currentSlug,game:args.p_game,catalog_card_id:args.p_catalog_card_id,card_name:args.p_card_name,set_code:args.p_set_code,set_name:args.p_set_name,rarity:args.p_rarity,language:args.p_language,condition:args.p_condition,edition:args.p_edition,image_url:args.p_image_url,quantity_owned:owned,quantity_loaned:0,quantity_reserved:0,quantity_physically_available:owned,legacy_ambiguous:false,updated_at:new Date().toISOString()};
        collectionItems=collectionItems.filter(item=>item.id!==id);collectionItems.push(row);return {data:id,error:null};
      }
      if(name==='delete_collection_item'){collectionItems=collectionItems.filter(item=>item.id!==args.p_id);return {data:null,error:null};}
      if(name==='create_team_loans'){
        window.__authTest.createCalls+=1;window.__authTest.lastCreate=args;
        if(window.__authTest.holdCreate) await new Promise(resolve=>{window.__authTest.releaseCreate=resolve});
        return {data:[],error:null};
      }
      if(name==='request_collection_loan'){
        window.__authTest.requestCalls+=1;window.__authTest.lastRequest=args;
        const item=collectionItems.find(entry=>entry.id===args.p_collection_item_id);
        const base={card_name:item.card_name,quantity:args.p_quantity,requested_quantity:args.p_quantity,accepted_quantity:0,notes:args.p_notes,status:'requested',created_at:new Date().toISOString(),returned_at:null,card_image:item.image_url,card_external_id:item.catalog_card_id,game:item.game,returned_quantity:0,pending_return_quantity:0,collection_item_id:item.id,request_origin:'collection_request',card_set_code:item.set_code,card_set_name:item.set_name,card_rarity:item.rarity};
        loans.push({id:'request-outgoing',owner_slug:item.owner_slug,borrower_slug:currentSlug,...base});
        loans.push({id:'request-incoming',owner_slug:currentSlug,borrower_slug:item.owner_slug,...base});
        return {data:loans.at(-2),error:null};
      }
      if(name==='respond_collection_loan'){
        const target=loans.find(item=>item.id===args.p_id);target.quantity=args.p_quantity||target.quantity;target.accepted_quantity=args.p_action==='accept'?target.quantity:0;target.status=args.p_action==='accept'?'reserved':'rejected';return {data:target,error:null};
      }
      return {data:null,error:null};
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
    const blueEyes={id:89631139,name:'Blue-Eyes White Dragon',type:'Normal Monster',card_images:[{image_url:`http://127.0.0.1:${port}/icon-512.png`,image_url_small:`http://127.0.0.1:${port}/icon-192.png`,image_url_cropped:`http://127.0.0.1:${port}/assets/fpt-card-hero.png`}],card_sets:[{set_code:'SDK-001',set_name:'Starter Deck Kaiba',set_rarity:'Ultra Rare'},{set_code:'LOB-001',set_name:'Legend of Blue Eyes',set_rarity:'Ultra Rare'}]};
    const darkMagician={id:46986414,name:'Dark Magician',type:'Normal Monster',card_images:[{id:46986414,image_url:'https://images.ygoprodeck.com/images/cards/46986414.jpg',image_url_small:'https://images.ygoprodeck.com/images/cards_small/46986414.jpg',image_url_cropped:'https://images.ygoprodeck.com/images/cards_cropped/46986414.jpg'}],card_sets:[{set_code:'SDY-006',set_name:'Starter Deck Yugi',set_rarity:'Ultra Rare'}]};const stardust={id:44508094,name:'Stardust Dragon',type:'Synchro Monster',banlist_info:{ban_tcg:'Limited'},card_images:[{id:44508094,image_url:'https://images.ygoprodeck.com/images/cards/44508094.jpg',image_url_small:'https://images.ygoprodeck.com/images/cards_small/44508094.jpg'}],card_sets:[]};
    const query=(requestUrl.searchParams.get('name')||requestUrl.searchParams.get('fname')||'').toLowerCase();
    const data=query.includes('dark')?[darkMagician]:query.includes('blue')?[blueEyes]:query.includes('stardust')?[stardust]:[blueEyes,darkMagician,stardust];
    return res.end(JSON.stringify({data}));
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
  const profile = path.join(os.tmpdir(), `fpt-auth-smoke-${Date.now()}`);
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
    const diagnostic = await evaluate(`({url:location.href,body:document.body.innerText.slice(0,160),status:document.querySelector('#member-load-status')?.textContent,supabase:typeof window.supabase,mockCollection:window.__authTest?.getCollection?.(),toast:document.querySelector('#toast')?.textContent,editor:Boolean(document.querySelector('#collection-form')),app:document.querySelector('#app')?.innerHTML.slice(0,120)})`);
    throw new Error(`${message} · ${JSON.stringify(diagnostic)}`);
  };
  const selectMember = slug => evaluate(`(()=>{const s=document.querySelector('#member');s.value=${JSON.stringify(slug)};s.dispatchEvent(new Event('change',{bubbles:true}));return s.value})()`);
  const submitPin = pin => evaluate(`(()=>{const p=document.querySelector('#pin');p.value=${JSON.stringify(pin)};p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#login-form').requestSubmit(document.querySelector('#login-form button[type="submit"]'));return true})()`);

  await waitFor(`document.querySelectorAll('#member option').length === 3`, 'I membri non sono comparsi nel select');
  assert(await evaluate(`document.querySelector('#member').tagName === 'SELECT'`), 'Il controllo membro non è un select nativo');

  await evaluate(`document.querySelector('#member').focus()`);
  await cdp.call('Input.dispatchKeyEvent', { type:'keyDown', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40 });
  await cdp.call('Input.dispatchKeyEvent', { type:'keyUp', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40 });
  await waitFor(`document.querySelector('#member').value !== ''`, 'Selezione membro da tastiera non riuscita');
  console.log('PASS selector nativo + tastiera');

  await evaluate(`window.__authTest.wrongPinMode=true`);
  await selectMember('existing-member'); await submitPin('9999');
  await waitFor(`document.querySelector('#toast').textContent.includes('PIN non corretto')`, 'Feedback PIN errato non mostrato');
  assert(await evaluate(`document.querySelector('#member').value === 'existing-member' && !document.querySelector('#login-form button[type="submit"]').disabled`), 'Il form non ha preservato il membro dopo PIN errato');
  console.log('PASS membro esistente + PIN errato');

  await evaluate(`window.__authTest.wrongPinMode=false`);
  await evaluate(`window.__authTest.syncDelay=120;window.__authTest.syncMaxInFlight=0`);
  await submitPin('1234');
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Login con PIN corretto non completato');
  await waitFor(`window.__authTest.syncMaxInFlight>=4`,'Prestiti, raccolta e mazzi non vengono caricati in parallelo');
  await waitFor(`window.__authTest.syncInFlight===0`,'Sincronizzazione iniziale non completata');
  await evaluate(`window.__authTest.syncDelay=0`);
  assert(await evaluate(`window.__authTest.lastLoginSlug === 'existing-member'`), 'Slug login inatteso');
  const identityCheck = await evaluate(`import('./js/cards.js').then(async cards=>({fuzzy:await cards.findCard('Imaginary Dark'),valid:await cards.verifyCardIdentity('46986414','Dark Magician'),invalid:await cards.verifyCardIdentity('89631139','Dark Magician')}))`);
  assert(identityCheck.fuzzy===null && identityCheck.valid===true && identityCheck.invalid===false, `Resolver identità carta non sicuro: ${JSON.stringify(identityCheck)}`);
  assert(await evaluate(`document.querySelector('.market-mover-slide')?.style.getPropertyValue('--mover-image').includes('/cards_cropped/46986414.jpg')&&document.querySelector('.market-mover-chart svg')&&document.querySelector('.market-mover-price b')?.textContent.includes('12')`), 'Artwork cropped, prezzo o grafico della carta in evidenza assente');
  console.log('PASS corrispondenza esatta nome/ID/immagine + quarantena legacy');
  console.log('PASS membro esistente + PIN corretto');

  const routeDuration=await evaluate(`(()=>{window.__stableAppShell=document.querySelector('.app-shell');const started=performance.now();document.querySelector('[data-page="decks"]').click();return performance.now()-started})()`);
  await waitFor(`Boolean(document.querySelector('.deck-page'))`,'Sezione Mazzi non renderizzata');
  assert(await evaluate(`window.__stableAppShell===document.querySelector('.app-shell')`),'Il cambio sezione ricostruisce ancora tutta la shell');
  assert(routeDuration<100,`Cambio sezione troppo lento nel fixture: ${routeDuration.toFixed(1)} ms`);
  console.log(`PASS login parallelo + cambio sezione senza rebuild shell (${routeDuration.toFixed(1)} ms)`);
  await evaluate(`document.querySelector('[data-deck-new]').click()`);
  assert(await evaluate(`document.querySelectorAll('.deck-zone').length===3&&!document.querySelector('[data-deck-section]')`),'Main/Extra/Side sono ancora divisi in schede');
  await evaluate(`(()=>{const input=document.querySelector('[data-deck-search]');input.value='Dark Magician';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await waitFor(`[...document.querySelectorAll('[data-deck-result]')].some(button=>button.textContent.includes('Dark Magician'))`,'Ricerca carta Main nel mazzo fallita');
  await evaluate(`[...document.querySelectorAll('[data-deck-result]')].find(button=>button.textContent.includes('Dark Magician')).click()`);
  await evaluate(`(()=>{const input=document.querySelector('[data-deck-search]');input.value='Stardust Dragon';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await waitFor(`[...document.querySelectorAll('[data-deck-result]')].some(button=>button.textContent.includes('Stardust Dragon'))`,'Ricerca carta Extra nel mazzo fallita');
  await evaluate(`[...document.querySelectorAll('[data-deck-result]')].find(button=>button.textContent.includes('Stardust Dragon')).click()`);
  assert(await evaluate(`document.querySelector('.deck-zone.main').textContent.includes('Dark Magician')&&document.querySelector('.deck-zone.extra').textContent.includes('Stardust Dragon')`),'Classificazione automatica Main/Extra errata');
  assert(await evaluate(`document.querySelector('.deck-zone.extra .deck-ban-badge.limited')?.textContent==='1'`),'Bollino Limitata TCG Advanced assente');
  await evaluate(`document.querySelector('[data-deck-gallery]').click()`);
  assert(await evaluate(`(()=>{const visual=document.querySelector('.deck-box-visual:not(.uses-template)'),image=visual?.querySelector('.deck-box-signature-art'),overlay=visual?.querySelector('i');if(!visual||!image||!overlay)return false;const imageBox=image.getBoundingClientRect(),visualBox=visual.getBoundingClientRect();return Math.abs(imageBox.width-visualBox.width)<5&&Math.abs(imageBox.height-visualBox.height)<5&&getComputedStyle(overlay).inset==='0px'})()`),'Artwork signature non aderisce alla faccia della Deck Box');
  await evaluate(`[...document.querySelectorAll('.deck-box-card')].find(card=>card.textContent.includes('Nuovo mazzo')).click()`);
  await evaluate(`document.querySelector('[data-deck-cover-open]').click()`);
  await waitFor(`document.querySelectorAll('[data-deck-box-template]').length===4`,'Selettore modelli Deck Box non aperto');
  assert(await evaluate(`[...document.querySelectorAll('.deck-template-options img')].filter(image=>image.src.includes('/assets/deck-boxes/')).length===3`),'Le tre immagini Deck Box non sono incorporate nel selettore');
  await evaluate(`document.querySelector('[data-deck-box-template="infernal-dragon"]').click()`);
  assert(await evaluate(`!document.querySelector('.deck-cover-picker')&&document.querySelector('[data-deck-theme]').value==='infernal-red'&&Boolean(document.querySelector('.deck-builder'))`),'La scelta del modello non torna automaticamente al mazzo');
  await evaluate(`document.querySelector('[data-deck-cover-open]').click()`);
  assert(await evaluate(`document.querySelector('[data-deck-box-template="infernal-dragon"]').classList.contains('active')`),'Modello Deck Box selezionato non conservato');
  await evaluate(`document.querySelector('.deck-cover-back').click()`);
  assert(await evaluate(`!document.querySelector('.deck-cover-picker')&&Boolean(document.querySelector('.deck-builder'))`),'Il pulsante Torna al mazzo non chiude la personalizzazione');
  await evaluate(`(()=>{const key='fpt-cards-deck-drafts-v1',drafts=JSON.parse(localStorage.getItem(key)||'[]');for(const deck of drafts)for(const card of deck.cards||[])delete card.banTcg;localStorage.setItem(key,JSON.stringify(drafts))})()`);
  await cdp.call('Page.reload',{ignoreCache:true});
  await waitFor(`[...document.querySelectorAll('.deck-box-card')].some(card=>card.textContent.includes('Nuovo mazzo'))`,'Hard refresh non ha recuperato la bozza nella gallery');
  assert(await evaluate(`document.querySelector('.deck-box-card')&&document.querySelector('.deck-gallery-hero h1')?.textContent==='Scegli il tuo mazzo'&&!document.querySelector('[data-deck-search]')`),'Gallery Mazzi non separata dall’editor');
  assert(await evaluate(`document.querySelector('.deck-box-card[data-deck-template="infernal-dragon"] img.deck-box-template-art')?.src.includes('/assets/deck-boxes/infernal-dragon.png')`),'Hard refresh ha perso il modello Deck Box selezionato');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true, screenWidth:390, screenHeight:844 });
  assert(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth+1&&getComputedStyle(document.querySelector('.deck-box-grid')).gridTemplateColumns.split(' ').length===1`),'Gallery Mazzi non responsive a 390px');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false, screenWidth:1280, screenHeight:900 });
  await evaluate(`[...document.querySelectorAll('.deck-box-card')].find(card=>card.textContent.includes('Nuovo mazzo')).click()`);
  await waitFor(`document.querySelector('.deck-zone.main')?.textContent.includes('Dark Magician')&&document.querySelector('.deck-zone.extra')?.textContent.includes('Stardust Dragon')`,'Hard refresh ha cancellato la bozza del mazzo');
  assert(await evaluate(`document.querySelector('.deck-zone.extra .deck-ban-badge.limited')?.textContent==='1'`),'Hard refresh ha perso il bollino banlist TCG');
  console.log('PASS Mazzi sezioni simultanee + Extra automatico + recupero hard refresh');

  await evaluate(`Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>true})`);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width:1440, height:1000, deviceScaleFactor:1, mobile:false, screenWidth:1440, screenHeight:1000 });
  await evaluate(`document.querySelector('.fab[data-page="new"]').click()`);
  await waitFor(`Boolean(document.querySelector('.loan-builder-grid'))`, 'Loan Builder non renderizzato');
  assert(await evaluate(`document.querySelector('.loan-submit').disabled`), 'Submit senza carte/destinatario non disabilitato');
  await evaluate(`(()=>{const input=document.querySelector('#card-name');input.value='Blue-Eyes';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await waitFor(`[...document.querySelectorAll('.loan-search-result')].some(row=>row.textContent.includes('Blue-Eyes'))`, 'Risultato Blue-Eyes assente');
  assert(await evaluate(`[...document.querySelectorAll('.loan-search-result')].find(row=>row.textContent.includes('Blue-Eyes')).querySelector('img').src.endsWith('/icon-192.png')`), 'La ricerca usa ancora il ritaglio invece della carta completa piccola');
  assert(await evaluate(`(()=>{const image=[...document.querySelectorAll('.loan-search-result')].find(row=>row.textContent.includes('Blue-Eyes')).querySelector('img');const box=image.getBoundingClientRect();return getComputedStyle(image).objectFit==='contain'&&box.height/box.width>1.3})()`), 'La carta completa viene ancora ritagliata dal CSS');
  await evaluate(`[...document.querySelectorAll('.loan-search-result')].find(row=>row.textContent.includes('Blue-Eyes')).querySelector('[data-card-result]').click()`);
  await waitFor(`document.querySelectorAll('.draft-card').length===1`, 'Aggiunta singola carta non riuscita');
  assert(await evaluate(`document.querySelector('#card-name').value==='' && document.querySelector('#card-suggestions').classList.contains('is-collapsed') && Boolean(document.querySelector('.loan-card-flight'))`), 'La selezione non chiude la lista o non avvia il trasferimento animato');
  await evaluate(`document.querySelector('[data-draft-quantity="plus"]').focus()`);
  await cdp.call('Input.dispatchKeyEvent', { type:'keyDown', key:' ', code:'Space', windowsVirtualKeyCode:32 });
  await cdp.call('Input.dispatchKeyEvent', { type:'keyUp', key:' ', code:'Space', windowsVirtualKeyCode:32 });
  await waitFor(`document.querySelector('.draft-stepper output').textContent==='2'`, 'Incremento da tastiera non riuscito');
  await evaluate(`(()=>{const input=document.querySelector('#card-name');input.value='Blue-Eyes';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await waitFor(`[...document.querySelectorAll('.loan-search-result')].some(row=>row.textContent.includes('Blue-Eyes'))`, 'Seconda ricerca Blue-Eyes assente');
  await evaluate(`[...document.querySelectorAll('.loan-search-result')].find(row=>row.textContent.includes('Blue-Eyes')).querySelector('[data-card-result]').click()`);
  await waitFor(`document.querySelector('.draft-stepper output').textContent==='3' && document.querySelectorAll('.draft-card').length===1`, 'Stessa carta non accorpata');
  const decrement = await evaluate(`(()=>{const before=document.querySelector('.draft-stepper output').textContent;document.querySelector('[data-draft-quantity="minus"]').click();return {before,after:document.querySelector('.draft-stepper output').textContent}})()`);
  assert(decrement.before==='3' && decrement.after==='2', `Decremento quantità non riuscito: ${JSON.stringify(decrement)}`);
  await evaluate(`(()=>{const input=document.querySelector('#card-name');input.value='Dark Magician';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await waitFor(`[...document.querySelectorAll('.loan-search-result')].some(row=>row.textContent.includes('Dark Magician'))`, 'Risultato Dark Magician assente');
  await evaluate(`[...document.querySelectorAll('.loan-search-result')].find(row=>row.textContent.includes('Dark Magician')).querySelector('[data-card-result]').click()`);
  await waitFor(`document.querySelectorAll('.draft-card').length===2`, 'Aggiunta multipla non riuscita');
  await evaluate(`[...document.querySelectorAll('.draft-card')].find(row=>row.textContent.includes('Dark Magician')).querySelector('[data-remove-card]').click()`);
  await waitFor(`document.querySelectorAll('.draft-card').length===1`, 'Rimozione carta non riuscita');
  await evaluate(`(()=>{const input=document.querySelector('#card-name');input.value='Dark Magician';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await waitFor(`[...document.querySelectorAll('.loan-search-result')].some(row=>row.textContent.includes('Dark Magician'))`, 'Seconda ricerca Dark Magician assente');
  await evaluate(`[...document.querySelectorAll('.loan-search-result')].find(row=>row.textContent.includes('Dark Magician')).querySelector('[data-card-result]').click()`);
  await waitFor(`document.querySelectorAll('.draft-card').length===2`, 'Nuova aggiunta dopo rimozione non riuscita');
  await evaluate(`document.querySelector('#borrower').focus()`);
  for (let index=0; index<2; index+=1) {
    await cdp.call('Input.dispatchKeyEvent', { type:'keyDown', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40 });
    await cdp.call('Input.dispatchKeyEvent', { type:'keyUp', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40 });
  }
  await waitFor(`document.querySelector('#borrower').value==='first-access'`, 'Cambio destinatario da tastiera non riuscito');
  assert(await evaluate(`document.querySelectorAll('#borrower option[value="existing-member"]').length===0 && document.querySelector('.loan-direction-flag').textContent.includes('Stai prestando') && document.querySelector('.loan-direction-flag').textContent.includes('First Access') && document.querySelector('.loan-submit').textContent.includes('proposta')`), 'Direzione del prestito non chiara o profilo personale ancora selezionabile');
  await evaluate(`(()=>{const notes=document.querySelector('#notes');notes.value='Near Mint · consegna sabato';notes.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  assert(await evaluate(`document.querySelector('#notes-count').textContent.startsWith('27') && !document.querySelector('.loan-submit').disabled`), 'Note o validazione Loan Builder errate');
  const desktopLoanLayout = await evaluate(`({columns:getComputedStyle(document.querySelector('.loan-builder-grid')).gridTemplateColumns,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth})`);
  assert(desktopLoanLayout.columns.split(' ').length>=2 && desktopLoanLayout.overflow===0, `Layout Loan Builder desktop non valido: ${JSON.stringify(desktopLoanLayout)}`);
  for (const width of [390,360]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:true, screenWidth:width, screenHeight:900 });
    await delay(100);
    const layout = await evaluate(`(()=>{const search=document.querySelector('.loan-search-stage').getBoundingClientRect();const recipient=document.querySelector('.loan-recipient').getBoundingClientRect();const selected=document.querySelector('.selected-loan-cards').getBoundingClientRect();const notes=document.querySelector('.loan-notes').getBoundingClientRect();const touch=document.querySelector('[data-draft-quantity="plus"]').getBoundingClientRect();return {client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,order:search.top<recipient.top&&recipient.top<selected.top&&selected.top<notes.top,touch:Math.min(touch.width,touch.height)}})()`);
    assert(layout.client===width && layout.scroll===width && layout.order && layout.touch>=42, `Loan Builder mobile non valido a ${width}px: ${JSON.stringify(layout)}`);
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width:1440, height:1000, deviceScaleFactor:1, mobile:false, screenWidth:1440, screenHeight:1000 });
  await evaluate(`window.__authTest.holdCreate=true;(()=>{const button=document.querySelector('.loan-submit');button.click();button.click()})()`);
  await waitFor(`window.__authTest.createCalls===1 && document.querySelector('.loan-submit')?.textContent.includes('Invio in corso')`, 'Doppio submit non bloccato');
  await evaluate(`window.__authTest.releaseCreate();window.__authTest.holdCreate=false`);
  await waitFor(`Boolean(document.querySelector('#loan-query'))`, 'Submit valido Loan Builder non completato');
  assert(await evaluate(`window.__authTest.lastCreate.p_borrower_slug==='first-access' && window.__authTest.lastCreate.p_cards.length===2 && window.__authTest.lastCreate.p_cards[0].quantity===2 && window.__authTest.lastCreate.p_cards[0].image.endsWith('/icon-512.png') && window.__authTest.lastCreate.p_notes.includes('Near Mint')`), 'Payload prestito o immagine completa non rispettati');
  await evaluate(`document.querySelector('.fab[data-page="new"]').click()`);
  await waitFor(`Boolean(document.querySelector('[data-loan-mode="request"]'))`, 'Interruttore bidirezionale assente');
  await evaluate(`document.querySelector('[data-loan-mode="request"]').click()`);
  await waitFor(`document.querySelector('.loan-mode-switch').classList.contains('request') && document.querySelector('.loan-direction-flag').textContent.includes('Stai richiedendo')`, 'Modalità ricezione non attivata');
  await evaluate(`(()=>{const select=document.querySelector('#borrower');select.value='first-access';select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await evaluate(`(()=>{const input=document.querySelector('#card-name');input.value='Dark Magician';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await waitFor(`[...document.querySelectorAll('.loan-search-result')].some(row=>row.textContent.includes('Dark Magician')&&row.textContent.includes('disponibili'))`, 'Raccolta del proprietario non usata nella richiesta');
  await evaluate(`[...document.querySelectorAll('.loan-search-result')].find(row=>row.textContent.includes('Dark Magician')).querySelector('[data-card-result]').click()`);
  await waitFor(`document.querySelector('.draft-card')?.textContent.includes('SDY-006')`, 'Printing richiesta non collegata alla raccolta team');
  assert(await evaluate(`document.querySelector('.loan-submit').textContent.includes('richiesta') && document.querySelector('.loan-direction-flag').textContent.includes('First Access')`), 'Conferma ricezione non esplicita');
  await evaluate(`document.querySelector('.loan-submit').click()`);
  await waitFor(`window.__authTest.requestCalls===1 && Boolean(document.querySelector('#loan-query'))`, 'Richiesta dal Loan Builder non inviata');
  assert(await evaluate(`window.__authTest.lastRequest.p_collection_item_id==='team-item' && window.__authTest.lastRequest.p_quantity===1`), 'La richiesta non usa la printing esatta del proprietario');
  console.log('PASS Loan Builder bidirezionale, animazione, ricerca/quantità/destinatario/note/submit/desktop/mobile/tastiera/touch');
  await cdp.call('Page.reload', { ignoreCache:true });
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Sessione non ripristinata dopo Loan Builder');

  await evaluate(`location.hash='#/collection'`);
  await waitFor(`Boolean(document.querySelector('.inventory-surface'))`, 'Raccolta non renderizzata');
  await evaluate(`document.querySelector('[data-collection-add]').click()`);
  await waitFor(`Boolean(document.querySelector('#collection-card-search'))`, 'Editor raccolta non aperto');
  await evaluate(`(()=>{const input=document.querySelector('#collection-card-search');input.value='Blue-Eyes';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await waitFor(`Boolean(document.querySelector('[data-collection-card-result]'))`, 'Catalogo raccolta senza risultati');
  await evaluate(`document.querySelector('[data-collection-card-result]').click()`);
  await waitFor(`document.querySelectorAll('#collection-printing option').length === 2`, 'Printing non caricate');
  await evaluate(`(()=>{const printing=document.querySelector('#collection-printing');printing.value='1';printing.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await waitFor(`document.querySelector('.printing-preview')?.textContent.includes('LOB-001')`, 'Cambio printing non applicato');
  await evaluate(`(()=>{const owned=document.querySelector('#collection-owned');owned.value='3';owned.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#collection-form').requestSubmit()})()`);
  await waitFor(`Boolean(document.querySelector('.inventory-card'))`, 'Carta non aggiunta alla raccolta');
  assert(await evaluate(`document.querySelector('.inventory-card').textContent.includes('Disponibili 3')`), 'Disponibilità iniziale errata');
  for (const width of [1440, 820, 390, 360]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height:1000, deviceScaleFactor:1, mobile:false, screenWidth:width, screenHeight:1000 });
    await delay(80);
    const layout = await evaluate(`(()=>{const card=document.querySelector('.inventory-card');const copy=card?.querySelector('.inventory-card-copy');const title=copy?.querySelector('strong');const meta=copy?.querySelector('small');return{client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,card:card?.getBoundingClientRect().width,cardHeight:card?.getBoundingClientRect().height,toolbar:document.querySelector('.inventory-toolbar')?.getBoundingClientRect().width,titleHeight:title?.getBoundingClientRect().height,metaHeight:meta?.getBoundingClientRect().height,copyClient:copy?.clientHeight,copyScroll:copy?.scrollHeight}})()`);
    assert(layout.client === width && layout.scroll === width && layout.card > (width <= 390 ? 280 : 120) && layout.toolbar <= width, `Layout Raccolta non valido a ${width}px: ${JSON.stringify(layout)}`);
    if(width<=390)assert(layout.cardHeight>=156&&layout.titleHeight>=11&&layout.metaHeight>=8&&layout.copyScroll<=layout.copyClient+1,`Testo card Raccolta compresso o tagliato a ${width}px: ${JSON.stringify(layout)}`);
  }
  console.log('PASS Raccolta responsive 1440/tablet/390/360');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false, screenWidth:1280, screenHeight:900 });
  await evaluate(`document.querySelector('[data-collection-scope="team"]').click()`);
  await waitFor(`Boolean(document.querySelector('.inventory-card'))`, 'Raccolta team vuota dopo condivisione');
  assert(await evaluate(`!document.querySelector('.inventory-card').textContent.includes('Possedute')`), 'La Raccolta team espone quantità possedute');
  await evaluate(`[...document.querySelectorAll('.inventory-card')].find(card=>card.textContent.includes('Blue-Eyes')).click()`);
  await waitFor(`document.querySelector('.team-availability')?.textContent.includes('Existing Member')`, 'Disponibilità proprietario assente nel dettaglio team');
  assert(await evaluate(`document.querySelector('[data-collection-loan]') === null && document.querySelector('.inventory-detail .btn')?.disabled`), 'CTA team non correttamente predisposta per 2.1');
  await evaluate(`document.querySelector('[data-close-collection-detail].detail-close').click()`);
  await evaluate(`[...document.querySelectorAll('.inventory-card')].find(card=>card.textContent.includes('Dark Magician')).click()`);
  await waitFor(`Boolean(document.querySelector('[data-request-collection-loan="team-item"]:not(:disabled)'))`, 'CTA richiesta prestito non disponibile');
  await evaluate(`document.querySelector('[data-request-collection-loan="team-item"]').click()`);
  await waitFor(`Boolean(document.querySelector('#collection-request-form'))`, 'Modale richiesta prestito non aperta');
  for (const {width,height} of [{width:360,height:800},{width:390,height:844},{width:412,height:915}]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor:1, mobile:false, screenWidth:width, screenHeight:height });
    const layout = await evaluate(`({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,modal:document.querySelector('.collection-request').getBoundingClientRect().width,button:document.querySelector('#collection-request-form .btn').getBoundingClientRect().height})`);
    assert(layout.client===layout.scroll && layout.modal<=layout.client && layout.button>=42, `Richiesta mobile non valida a ${width}px: ${JSON.stringify(layout)}`);
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false, screenWidth:1280, screenHeight:900 });
  await evaluate(`(()=>{document.querySelector('#collection-request-quantity').value='3';document.querySelector('#collection-request-notes').value='Mi serve per il torneo';document.querySelector('#collection-request-form').requestSubmit()})()`);
  await waitFor(`!document.querySelector('#collection-request-form')`, 'Invio richiesta non completato');
  await evaluate(`location.hash='#/loans'`);
  await waitFor(`Boolean(document.querySelector('[data-action="accept-request"]'))`, 'Richiesta ricevuta non mostrata al proprietario');
  await evaluate(`(()=>{const input=document.querySelector('[data-accept-qty="request-incoming"]');input.value='1';document.querySelector('[data-action="accept-request"][data-id="request-incoming"]').click()})()`);
  await waitFor(`[...document.querySelectorAll('.loan-row')].some(row=>row.textContent.includes('Riservata')&&row.textContent.includes('accettate 1'))`, 'Accettazione parziale non rappresentata');
  console.log('PASS richiesta Raccolta Team + accettazione parziale + mobile 390/360');
  await evaluate(`location.hash='#/collection'`);
  await waitFor(`Boolean(document.querySelector('.inventory-surface'))`, 'Ritorno alla Raccolta dopo richiesta non riuscito');
  await evaluate(`document.querySelector('[data-collection-scope="mine"]').click()`);
  await waitFor(`Boolean(document.querySelector('.inventory-card'))`, 'Ritorno alla raccolta personale non riuscito');
  console.log('PASS privacy Raccolta team + dettaglio disponibilità');
  await evaluate(`document.querySelector('.inventory-card').click()`);
  await waitFor(`Boolean(document.querySelector('[data-collection-edit]'))`, 'Dettaglio personale non aperto');
  await evaluate(`document.querySelector('[data-collection-edit]').click()`);
  await waitFor(`Boolean(document.querySelector('#collection-owned'))`, 'Editor modifica non aperto');
  await evaluate(`(()=>{const owned=document.querySelector('#collection-owned');owned.value='4';owned.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#collection-form').requestSubmit()})()`);
  await waitFor(`document.querySelector('.inventory-card')?.textContent.includes('Disponibili 4')`, 'Modifica quantità non applicata');
  await evaluate(`document.querySelector('.inventory-card').click()`);
  await evaluate(`window.confirm=()=>true;document.querySelector('[data-collection-delete]').click()`);
  await waitFor(`!document.querySelector('.inventory-card')`, 'Eliminazione raccolta non applicata');
  console.log('PASS Raccolta aggiunta/printing/modifica/eliminazione');

  await evaluate(`document.querySelector('[data-fast-scan]').click()`);
  await waitFor(`Boolean(document.querySelector('#fast-scan-settings'))`, 'Impostazioni Fast Scan non aperte');
  for (const width of [390,360]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height:844, deviceScaleFactor:1, mobile:false, screenWidth:width, screenHeight:844 });
    const layout=await evaluate(`({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,form:document.querySelector('#fast-scan-settings').getBoundingClientRect().width,start:document.querySelector('[data-scan-manual-start]').getBoundingClientRect().height})`);
    assert(layout.client===layout.scroll&&layout.form<=layout.client&&layout.start>=42,`Fast Scan setup non valido a ${width}px: ${JSON.stringify(layout)}`);
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false, screenWidth:1280, screenHeight:900 });
  await evaluate(`document.querySelector('[data-scan-manual-start]').click()`);
  await waitFor(`Boolean(document.querySelector('.fast-scan-live'))`, 'Scanner Fast Scan fullscreen non aperto');
  await evaluate(`document.querySelector('[data-scan-back]').click()`);
  await waitFor(`Boolean(document.querySelector('[data-fast-scan]'))`, 'Back Fast Scan vuoto non torna alla Raccolta');
  await evaluate(`document.querySelector('[data-fast-scan]').click()`);
  await waitFor(`Boolean(document.querySelector('#fast-scan-settings'))`, 'Setup Fast Scan non riaperto');
  await evaluate(`document.querySelector('[data-scan-manual-start]').click()`);
  await waitFor(`Boolean(document.querySelector('.fast-scan-live'))`, 'Scanner manuale Fast Scan non aperto');
  await evaluate(`(()=>{const controls=document.querySelector('.live-controls');controls.insertAdjacentHTML('beforebegin','<div class="live-zoom" data-layout-zoom><button>−</button><input type="range"><button>+</button><output>1.5×</output><small>Pinch</small></div>')})()`);
  for (const viewport of [{width:360,height:800,label:'scanner portrait 360×800'},{width:390,height:844,label:'scanner portrait 390×844'},{width:412,height:915,label:'scanner portrait 412×915'},{width:640,height:360,label:'scanner landscape'}]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width:viewport.width, height:viewport.height, deviceScaleFactor:1, mobile:true, screenWidth:viewport.width, screenHeight:viewport.height });
    const scannerLayout=await evaluate(`(()=>{const rect=selector=>{const value=document.querySelector(selector).getBoundingClientRect();return{top:value.top,bottom:value.bottom,left:value.left,right:value.right,width:value.width,height:value.height}};const roiStyle=getComputedStyle(document.querySelector('.live-roi')),buttons=[...document.querySelectorAll('.live-controls button')];return{innerWidth,innerHeight,roi:rect('.live-roi'),footer:rect('.live-scan-bottom'),content:rect('.live-scan-content'),stats:rect('.live-session-stats'),capture:rect('.live-capture'),zoom:rect('[data-layout-zoom]'),controls:rect('.live-controls'),buttons:buttons.map(button=>({top:button.getBoundingClientRect().top,height:button.getBoundingClientRect().height})),roiBackground:roiStyle.backgroundColor,roiBlur:roiStyle.backdropFilter||roiStyle.webkitBackdropFilter,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,pause:Boolean(document.querySelector('[data-scan-pause]'))}})()`);
    assert(scannerLayout.roi.height<=52&&scannerLayout.roi.width<scannerLayout.innerWidth*.82,`ROI troppo dominante (${viewport.label}): ${JSON.stringify(scannerLayout)}`);
    const hierarchyOk=viewport.width>viewport.height
      ? scannerLayout.roi.bottom+10<=scannerLayout.stats.top&&Math.abs(scannerLayout.stats.top-scannerLayout.zoom.top)<2&&scannerLayout.stats.bottom<=scannerLayout.controls.top
      : scannerLayout.roi.bottom+10<=scannerLayout.stats.top&&scannerLayout.stats.bottom<=scannerLayout.zoom.top&&scannerLayout.zoom.bottom<=scannerLayout.controls.top;
    assert(hierarchyOk,`Gerarchia scanner sovrapposta (${viewport.label}): ${JSON.stringify(scannerLayout)}`);
    assert(scannerLayout.controls.bottom<=scannerLayout.innerHeight&&scannerLayout.capture.bottom<=scannerLayout.innerHeight&&scannerLayout.buttons.length===3&&scannerLayout.buttons.every(button=>button.height>=40)&&new Set(scannerLayout.buttons.map(button=>Math.round(button.top))).size===1&&scannerLayout.scrollWidth===scannerLayout.innerWidth,`Controlli scanner tagliati o a capo (${viewport.label}): ${JSON.stringify(scannerLayout)}`);
    assert(Math.abs(scannerLayout.footer.left)<2&&Math.abs(scannerLayout.footer.right-scannerLayout.innerWidth)<2&&Math.abs((scannerLayout.content.left+scannerLayout.content.right)/2-scannerLayout.innerWidth/2)<2&&!scannerLayout.pause,`Toolbar non full-width/centrata o Pausa ancora presente (${viewport.label}): ${JSON.stringify(scannerLayout)}`);
    assert(scannerLayout.roiBackground==='rgba(0, 0, 0, 0)'&&(scannerLayout.roiBlur==='none'||scannerLayout.roiBlur===''),`ROI offuscata (${viewport.label}): ${JSON.stringify(scannerLayout)}`);
    if(viewport.width<viewport.height)assert(scannerLayout.scrollHeight<=scannerLayout.innerHeight,`Scrolling inutile scanner (${viewport.label}): ${JSON.stringify(scannerLayout)}`);
  }
  await evaluate(`document.querySelector('[data-layout-zoom]')?.remove()`);
  assert(await evaluate(`getComputedStyle(document.querySelector('[data-scan-manual-sheet]')).display==='none'`), 'Bottom sheet manuale visibile prima dell’apertura');
  await evaluate(`document.querySelector('[data-scan-manual-open]').click()`);
  await waitFor(`getComputedStyle(document.querySelector('[data-scan-manual-sheet]')).display!=='none'`, 'Bottom sheet manuale Fast Scan non disponibile');
  for (const viewport of [{width:360,height:844,label:'portrait 360'},{width:390,height:844,label:'portrait 390'},{width:360,height:500,label:'tastiera/browser bar'},{width:640,height:360,label:'landscape'}]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width:viewport.width, height:viewport.height, deviceScaleFactor:1, mobile:true, screenWidth:viewport.width, screenHeight:viewport.height });
    const geometry=await evaluate(`(()=>{const overlay=document.querySelector('[data-scan-manual-sheet]').getBoundingClientRect();const sheet=document.querySelector('[data-scan-manual-sheet] .scan-bottom-sheet').getBoundingClientRect();const input=document.querySelector('#scan-manual-code').getBoundingClientRect();const add=document.querySelector('#scan-manual-form .btn').getBoundingClientRect();return{innerHeight,innerWidth,overlay:{top:overlay.top,bottom:overlay.bottom,height:overlay.height},sheet:{top:sheet.top,bottom:sheet.bottom,height:sheet.height,left:sheet.left,right:sheet.right},input:{left:input.left,right:input.right,bottom:input.bottom},add:{left:add.left,right:add.right,bottom:add.bottom},scrollWidth:document.documentElement.scrollWidth}})()`);
    assert(Math.abs(geometry.overlay.bottom-geometry.innerHeight)<2&&Math.abs(geometry.sheet.bottom-geometry.innerHeight)<2,`Sheet non ancorata al fondo (${viewport.label}): ${JSON.stringify(geometry)}`);
    assert(geometry.sheet.top>=0&&geometry.sheet.height<geometry.innerHeight*.9,`Sheet troppo alta (${viewport.label}): ${JSON.stringify(geometry)}`);
    assert(geometry.input.left>=geometry.sheet.left&&geometry.add.right<=geometry.sheet.right&&geometry.input.bottom<=geometry.innerHeight&&geometry.add.bottom<=geometry.innerHeight,`Controlli tagliati (${viewport.label}): ${JSON.stringify(geometry)}`);
    assert(geometry.scrollWidth===geometry.innerWidth,`Overflow orizzontale sheet (${viewport.label}): ${JSON.stringify(geometry)}`);
  }
  await evaluate(`document.querySelector('#scan-manual-code').focus()`);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width:390, height:480, deviceScaleFactor:1, mobile:true, screenWidth:390, screenHeight:844 });
  assert(await evaluate(`(()=>{const sheet=document.querySelector('[data-scan-manual-sheet] .scan-bottom-sheet').getBoundingClientRect();const input=document.querySelector('#scan-manual-code').getBoundingClientRect();return Math.abs(sheet.bottom-innerHeight)<2&&input.bottom<=innerHeight})()`),'Sheet/input coperti con viewport ridotta da tastiera');
  await evaluate(`document.querySelector('[data-scan-manual-close]').click()`);
  await waitFor(`getComputedStyle(document.querySelector('[data-scan-manual-sheet]')).display==='none'`, 'Bottom sheet ancora visibile dopo la chiusura');
  await evaluate(`document.querySelector('[data-scan-manual-open]').click()`);
  await waitFor(`getComputedStyle(document.querySelector('[data-scan-manual-sheet]')).display!=='none'`, 'Bottom sheet non si riapre dopo la chiusura');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false, screenWidth:1280, screenHeight:900 });
  await evaluate(`(()=>{document.querySelector('#scan-manual-code').value='sdy - 006';document.querySelector('#scan-manual-form').requestSubmit()})()`);
  await waitFor(`document.querySelector('[data-scan-total-number]')?.textContent==='1'`, 'Fast Scan non ha accumulato la printing');
  await waitFor(`document.querySelector('[data-scan-last]')?.textContent.includes('SDY-006')&&!document.querySelector('[data-scan-session-cards]')`, 'Fast Scan live non mostra il feedback essenziale');
  await evaluate(`document.querySelector('[data-scan-manual-close]').click();history.back()`);
  await waitFor(`!document.querySelector('[data-scan-exit-sheet]').classList.contains('hidden')`, 'Browser back Fast Scan non mostra il dialog di uscita');
  await evaluate(`document.querySelector('[data-scan-cancel-exit]').click()`);
  await waitFor(`document.querySelector('[data-scan-total-number]')?.textContent==='1'&&document.querySelector('[data-scan-exit-sheet]').classList.contains('hidden')`, 'Continua scansione perde il buffer');
  await evaluate(`document.querySelector('[data-scan-back]').click()`);
  await waitFor(`document.querySelector('[data-scan-exit-sheet]').textContent.includes('Hai finito?')`, 'Back UI Fast Scan non mostra conferma');
  await evaluate(`document.querySelector('[data-scan-confirm-review]').click()`);
  await waitFor(`Boolean(document.querySelector('[data-scan-save]'))`, 'Review Fast Scan non aperta');
  await evaluate(`document.querySelector('[data-scan-continue]').click()`);
  await waitFor(`document.querySelector('[data-scan-total-number]')?.textContent==='1'`, 'Resume scanner non conserva il buffer');
  await evaluate(`document.querySelector('[data-scan-back]').click();document.querySelector('[data-scan-confirm-review]').click()`);
  await waitFor(`Boolean(document.querySelector('[data-scan-save]'))`, 'Review Fast Scan non riaperta dopo resume');
  await evaluate(`(()=>{const input=document.querySelector('[data-scan-quantity]');input.value='2';input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await waitFor(`document.querySelector('[data-scan-quantity]')?.value==='2'`, 'Modifica quantità Fast Scan non conservata');
  await evaluate(`document.querySelector('[data-scan-save]').click()`);
  await waitFor(`document.querySelector('#toast').textContent.includes('Sessione salvata')`, 'Batch Fast Scan non salvato');
  assert(await evaluate(`window.__authTest.lastBatch.length===1&&window.__authTest.lastBatch[0].quantityDelta===2&&!('owner' in window.__authTest.lastBatch[0])`),'Payload batch Fast Scan non valido');
  await evaluate(`location.hash='#/collection'`);
  await waitFor(`[...document.querySelectorAll('.inventory-card')].some(card=>card.textContent.includes('Dark Magician')&&card.textContent.includes('Disponibili 2'))`, 'Batch Fast Scan non riflesso nella Raccolta');
  console.log('PASS Fast Scan buffer/review/batch + responsive 360/390/412 + owner server-side');

  await cdp.call('Page.reload', { ignoreCache:true });
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Sessione non ripristinata dopo refresh');
  assert(await evaluate(`JSON.parse(localStorage.getItem('fpt-cards-state-v2')).currentUser === 'existing-member'`), 'Sessione locale non persistita');
  console.log('PASS refresh dopo login');

  const routeChecks = [
    ['loans', '#loan-query'], ['new', '#card-name'], ['team', '.team-list'], ['collection', '.inventory-surface'], ['home', '.dashboard']
  ];
  for (const [route, selector] of routeChecks) {
    await evaluate(`location.hash='#/${route}'`);
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, `Route ${route} non renderizzata`);
  }
  await evaluate(`location.hash='#/loans'`);
  await waitFor(`Boolean(document.querySelector('.loan-archive-hero'))`, 'Redesign archivio Prestiti non renderizzato');
  assert(await evaluate(`Boolean(document.querySelector('.loan-archive-hero [data-page="new"]'))`), 'CTA Nuovo prestito assente dall’archivio');
  assert(await evaluate(`(()=>{const shell=document.querySelector('.app-shell');const select=document.querySelector('#loan-direction');select.value='received';select.dispatchEvent(new Event('change',{bubbles:true}));return document.querySelector('.app-shell')===shell&&select.isConnected&&select.value==='received'})()`), 'Il filtro Movimento ricostruisce ancora l’app');
  assert(await evaluate(`(()=>{const shell=document.querySelector('.app-shell');const select=document.querySelector('#loan-member');select.value='first-access';select.dispatchEvent(new Event('change',{bubbles:true}));return document.querySelector('.app-shell')===shell&&select.isConnected&&select.value==='first-access'})()`), 'Il filtro Membro ricostruisce ancora l’app');
  await evaluate(`document.querySelector('#clear-filters').click()`);
  assert(await evaluate(`document.querySelector('#loan-direction').value==='all'&&document.querySelector('#loan-member').value==='all'`), 'Reset locale dei filtri Prestiti non riuscito');
  for (const width of [390,360]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false, screenWidth:width, screenHeight:900 });
    await delay(80);
    const layout = await evaluate(`({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,hero:document.querySelector('.loan-archive-hero').getBoundingClientRect().width,kpis:document.querySelectorAll('.loan-kpi-strip article').length})`);
    assert(layout.client===layout.scroll && layout.client<=width && layout.client>=width-20 && layout.hero<=layout.client && layout.kpis===3, `Layout Prestiti non valido a ${width}px: ${JSON.stringify(layout)}`);
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false, screenWidth:1280, screenHeight:900 });
  console.log('PASS redesign Prestiti + filtri senza hard refresh + responsive 390/360');
  await evaluate(`document.querySelector('[data-game="onepiece"]').click()`);
  assert(await evaluate(`document.body.dataset.game === 'onepiece'`), 'Cambio gioco non riuscito');
  await evaluate(`document.querySelector('[data-game="yugioh"]').click()`);
  await evaluate(`location.hash='#/loans'`);
  await cdp.call('Page.reload', { ignoreCache:true });
  await waitFor(`Boolean(document.querySelector('#loan-query'))`, 'Refresh su deep link prestiti non riuscito');
  assert(await evaluate(`Boolean(document.querySelector('[data-action="return"]'))`), 'Azione restituzione non disponibile');
  console.log('PASS smoke Home/cambio gioco/ricerca/Prestiti/restituzioni/Team/deep link');

  await evaluate(`document.querySelector('[data-logout]').click()`);
  await waitFor(`Boolean(document.querySelector('#login-form'))`, 'Logout non completato');
  assert(await evaluate(`document.querySelectorAll('#member option').length === 3`), 'Membri mancanti dopo logout');
  console.log('PASS logout');

  await selectMember('first-access'); await submitPin('2468');
  await waitFor(`Boolean(document.querySelector('.app-shell'))`, 'Primo accesso non completato');
  assert(await evaluate(`window.__authTest.lastLoginSlug === 'first-access'`), 'Profilo primo accesso inatteso');
  console.log('PASS primo accesso (RPC simulata, nessuna scrittura Supabase)');

  await evaluate(`document.querySelector('[data-logout]').click()`);
  await waitFor(`Boolean(document.querySelector('#login-form'))`, 'Ritorno al login non completato');
  for (const width of [390, 360]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height:844, deviceScaleFactor:1, mobile:false, screenWidth:width, screenHeight:844 });
    await delay(100);
    const layout = await evaluate(`({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,select:document.querySelector('#member').getBoundingClientRect().width})`);
    assert(layout.client === width && layout.scroll === width && layout.select > 250, `Layout login non valido a ${width}px`);
    console.log(`PASS viewport ${width}px`);
  }

  assert(await evaluate(`navigator.serviceWorker.ready.then(()=>true).catch(()=>false)`), 'Service worker non pronto');
  await cdp.call('Page.reload', { ignoreCache:false });
  await waitFor(`Boolean(document.querySelector('#login-form'))`, 'Login non disponibile dopo attivazione PWA');
  const pwaShell = await evaluate(`Promise.all(['./index.html','./styles.css','./app.js'].map(item=>caches.match(item))).then(items=>({controller:Boolean(navigator.serviceWorker.controller),assets:items.every(Boolean)}))`);
  assert(pwaShell.controller && pwaShell.assets, `Shell PWA non controllata o asset principali non presenti in cache: ${JSON.stringify(pwaShell)}`);
  console.log('PASS shell PWA/service worker + asset cache');

  ws.send(JSON.stringify({ id:99999, method:'Browser.close' }));
  await delay(250);
  browser.kill(); server.close();
}

run().catch(error => {
  console.error(`FAIL ${error.message}`);
  browser?.kill();
  server.close();
  process.exitCode = 1;
});
