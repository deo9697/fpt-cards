// Browser reale (nessuna riga di Postgres coinvolta) per il pannello
// Market Variant Resolver (js/market-variant-admin.js): rendering,
// selezione candidato, link "Vedi" verso Cardmarket, e i binding di
// conferma/filtri/load-more chiamano gli handler giusti con gli argomenti
// giusti. Stesso harness minimo di collection-detail-design-smoke.mjs.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profile = await mkdtemp(path.join(tmpdir(), 'fpt-variant-admin-smoke-')), port = 9373;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let previewServer = null;
const alreadyUp = await fetch('http://localhost:8080/index.html').then(() => true).catch(() => false);
if (!alreadyUp) {
  previewServer = spawn(process.execPath, ['scripts/preview-server.mjs'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 50; i++) { if (await fetch('http://localhost:8080/index.html').then(() => true).catch(() => false)) break; await delay(100); }
}

const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=390,844', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  const target = await waitTarget(port); socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', event => { const message = JSON.parse(event.data), task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: 'http://localhost:8080/scripts/fixtures/collection-share-harness.html' });
  await delay(500);
  await evaluate(`window.__consoleErrors = []; window.addEventListener('error', e => window.__consoleErrors.push(String(e.message)));`);

  await evaluate(`(async()=>{
    const {renderMarketVariantPage, bindMarketVariantPage} = await import('/js/market-variant-admin.js');
    document.head.insertAdjacentHTML('afterbegin','<base href="/">');
    window.__calls = [];
    window.__model = {
      loading:false, error:'',
      selections: new Map(),
      filters: { query:'', usedOnly:true },
      hasMore:false,
      refreshingMetadata: new Set(),
      candidateMetadata: new Map([
        ['p-conflict', { fptRarityCanonical:'ULTRA_RARE', candidates:[
          { product_id:'444', rarity_raw:'Ultra Rare', rarity_canonical:'ULTRA_RARE', variant_number:'2', expansion_name:'Rarity Collection II', fetch_status:'resolved', rarity_match:'exact_match' },
          { product_id:'555', rarity_raw:'Secret Rare', rarity_canonical:'SECRET_RARE', variant_number:'3', expansion_name:'Rarity Collection II', fetch_status:'resolved', rarity_match:'mismatch' }
        ] }]
      ]),
      queue:[
        { printingId:'p-ambiguous', cardName:'Lightning Storm', setCode:'RA01-EN061', setName:'Rarity Collection', rarity:'Super Rare',
          mappingStatus:'ambiguous', resolutionReason:'multiple_candidates_no_rarity_signal',
          candidateProductIds:['111','222','333'], collectionUsage:2, deckUsage:1, loanUsage:0 },
        { printingId:'p-conflict', cardName:'Garura', setCode:'RA02-EN024', setName:'Rarity Collection II', rarity:'Ultra Rare',
          mappingStatus:'conflict', resolutionReason:'multiple_provider_expansions',
          candidateProductIds:['444','555'], collectionUsage:0, deckUsage:0, loanUsage:0 }
      ]
    };
    window.__render = () => { document.querySelector('#app').innerHTML = renderMarketVariantPage(window.__model); window.__bind(); };
    window.__bind = () => bindMarketVariantPage(document, window.__model, {
      onSelectCandidate: (printingId, productId) => { window.__model.selections.set(printingId, productId); window.__render(); },
      onConfirm: printingId => window.__calls.push(['confirm', printingId]),
      onLoadMore: () => window.__calls.push(['loadMore']),
      onFilterChange: (key, value) => window.__calls.push(['filter', key, value]),
      onRefreshMetadata: printingId => window.__calls.push(['refreshMetadata', printingId])
    });
    window.__render();
  })()`);

  // 1) Struttura base: 2 card, badge corretti, candidate count, link Vedi.
  const structure = await evaluate(`(()=>{
    const cards = [...document.querySelectorAll('.admin-variant-card')];
    const badges = cards.map(c => c.querySelector('.admin-variant-badge').className);
    const ambiguousLinks = [...cards[0].querySelectorAll('.admin-variant-candidate a')].map(a => a.getAttribute('href'));
    const ambiguousTarget = cards[0].querySelector('.admin-variant-candidate a').getAttribute('target');
    const confirmDisabled = cards.map(c => c.querySelector('[data-variant-confirm]').disabled);
    return {cardCount:cards.length, badges, ambiguousLinks, ambiguousTarget, confirmDisabled};
  })()`);
  if (structure.cardCount !== 2) throw Error('Attese 2 card: ' + JSON.stringify(structure));
  if (!structure.badges[0].includes('is-ambiguous') || !structure.badges[1].includes('is-conflict')) throw Error('Badge status errato: ' + JSON.stringify(structure.badges));
  if (JSON.stringify(structure.ambiguousLinks) !== JSON.stringify([
    'https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=111',
    'https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=222',
    'https://www.cardmarket.com/en/YuGiOh/Products/Singles?idProduct=333'
  ])) throw Error('Link Vedi errati: ' + JSON.stringify(structure.ambiguousLinks));
  if (structure.ambiguousTarget !== '_blank') throw Error('Il link Vedi deve aprire in nuova scheda');
  if (!structure.confirmDisabled.every(Boolean)) throw Error('Conferma deve essere disabilitata senza selezione: ' + JSON.stringify(structure.confirmDisabled));

  // 2) Selezionare un candidato abilita SOLO il bottone di quella card.
  await evaluate(`document.querySelector('[data-variant-product-id="222"]').click()`);
  const afterSelect = await evaluate(`(()=>{
    const cards = [...document.querySelectorAll('.admin-variant-card')];
    return {confirmDisabled: cards.map(c => c.querySelector('[data-variant-confirm]').disabled), selectedChecked: document.querySelector('[data-variant-product-id="222"]').checked};
  })()`);
  if (afterSelect.confirmDisabled[0] !== false || afterSelect.confirmDisabled[1] !== true) throw Error('Selezione ha abilitato la card sbagliata: ' + JSON.stringify(afterSelect));
  if (!afterSelect.selectedChecked) throw Error('Radio selezionato non risulta checked dopo il re-render');

  // 3) Conferma passa il printingId giusto all'handler.
  await evaluate(`document.querySelector('[data-admin-variant-card="p-ambiguous"] [data-variant-confirm]').click()`);
  // 4) Filtri: query input e checkbox usedOnly chiamano onFilterChange con chiave/valore corretti.
  await evaluate(`const q=document.querySelector('[data-variant-filter-query]'); q.value='lightning'; q.dispatchEvent(new Event('input',{bubbles:true}));`);
  await evaluate(`const c=document.querySelector('[data-variant-filter-used-only]'); c.checked=false; c.dispatchEvent(new Event('change',{bubbles:true}));`);
  const calls = await evaluate('window.__calls');
  if (!calls.some(c => c[0] === 'confirm' && c[1] === 'p-ambiguous')) throw Error('onConfirm non chiamato col printingId giusto: ' + JSON.stringify(calls));
  if (!calls.some(c => c[0] === 'filter' && c[1] === 'query' && c[2] === 'lightning')) throw Error('onFilterChange(query) non chiamato correttamente: ' + JSON.stringify(calls));
  if (!calls.some(c => c[0] === 'filter' && c[1] === 'usedOnly' && c[2] === false)) throw Error('onFilterChange(usedOnly) non chiamato correttamente: ' + JSON.stringify(calls));

  // 5) hasMore:false -> nessun bottone "Carica altri"; hasMore:true -> presente e cliccabile.
  const noLoadMore = await evaluate(`!!document.querySelector('[data-variant-load-more]')`);
  if (noLoadMore) throw Error('Load-more non deve comparire con hasMore:false');
  await evaluate(`window.__model.hasMore = true; window.__render();`);
  await evaluate(`document.querySelector('[data-variant-load-more]').click()`);
  const callsAfterLoadMore = await evaluate('window.__calls');
  if (!callsAfterLoadMore.some(c => c[0] === 'loadMore')) throw Error('onLoadMore non chiamato');

  // 6) Metadata candidati: senza metadata -> "non ancora acquisita"; con
  //    metadata -> MATCH/MISMATCH corretti, mai una rarity inventata.
  const metadataState = await evaluate(`(()=>{
    const ambiguousCard = document.querySelector('[data-admin-variant-card="p-ambiguous"]');
    const conflictCard = document.querySelector('[data-admin-variant-card="p-conflict"]');
    const noMetadataHint = ambiguousCard.querySelector('.admin-variant-candidate-hint')?.textContent || '';
    const conflictCandidates = [...conflictCard.querySelectorAll('.admin-variant-candidate')];
    const matchBadges = conflictCandidates.map(c => c.querySelector('.admin-variant-match')?.className || null);
    const details = conflictCandidates.map(c => c.querySelector('.admin-variant-candidate-info small')?.textContent || '');
    return {noMetadataHint, matchBadges, details};
  })()`);
  if (!metadataState.noMetadataHint.includes('non ancora acquisita')) throw Error('Candidato senza metadata deve mostrare "non ancora acquisita": ' + JSON.stringify(metadataState));
  if (!metadataState.matchBadges[0] || !metadataState.matchBadges[0].includes('is-match')) throw Error('Candidato 444 (rarity uguale a FPT) deve mostrare MATCH: ' + JSON.stringify(metadataState));
  if (!metadataState.matchBadges[1] || !metadataState.matchBadges[1].includes('is-mismatch')) throw Error('Candidato 555 (rarity diversa da FPT) deve mostrare MISMATCH: ' + JSON.stringify(metadataState));
  if (!metadataState.details[0].includes('Ultra Rare') || !metadataState.details[0].includes('V.2')) throw Error('Dettaglio candidato 444 incompleto: ' + JSON.stringify(metadataState));

  // 7) "Aggiorna metadata candidati" chiama l'handler col printingId giusto;
  //    mentre è in corso, il bottone di QUELLA card mostra "Aggiornamento..."
  //    e si disabilita, senza toccare l'altra card.
  await evaluate(`document.querySelector('[data-admin-variant-card="p-conflict"] [data-variant-refresh-metadata]').click()`);
  const callsAfterRefresh = await evaluate('window.__calls');
  if (!callsAfterRefresh.some(c => c[0] === 'refreshMetadata' && c[1] === 'p-conflict')) throw Error('onRefreshMetadata non chiamato col printingId giusto: ' + JSON.stringify(callsAfterRefresh));
  await evaluate(`window.__model.refreshingMetadata.add('p-conflict'); window.__render();`);
  const refreshingState = await evaluate(`(()=>{
    const ambiguousButton = document.querySelector('[data-admin-variant-card="p-ambiguous"] [data-variant-refresh-metadata]');
    const conflictButton = document.querySelector('[data-admin-variant-card="p-conflict"] [data-variant-refresh-metadata]');
    return {ambiguousDisabled: ambiguousButton.disabled, ambiguousText: ambiguousButton.textContent, conflictDisabled: conflictButton.disabled, conflictText: conflictButton.textContent};
  })()`);
  if (refreshingState.ambiguousDisabled) throw Error('Il refresh in corso su p-conflict non deve disabilitare anche p-ambiguous: ' + JSON.stringify(refreshingState));
  if (!refreshingState.conflictDisabled || !refreshingState.conflictText.includes('Aggiornamento')) throw Error('p-conflict deve mostrare "Aggiornamento..." disabilitato mentre il refresh è in corso: ' + JSON.stringify(refreshingState));

  if ((await evaluate('window.__consoleErrors')).length) throw Error('Browser errors: ' + JSON.stringify(await evaluate('window.__consoleErrors')));
  console.log('PASS market variant admin panel: rendering, badge status, link Vedi verso Cardmarket in nuova scheda, selezione candidato isolata per card, conferma/filtri/load-more, metadata candidati (MATCH/MISMATCH/non acquisita) e refresh metadata chiamano tutti gli handler con gli argomenti corretti');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (previewServer) previewServer.kill();
}

async function waitTarget(port) { for (let index = 0; index < 80; index++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json(); } catch {} await delay(100); } throw new Error('Chrome DevTools non disponibile'); }
