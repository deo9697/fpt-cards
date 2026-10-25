import { esc } from './core.js';
import { classifyScanDiagnostic } from './fast-scan-core.js';
import { printingEvidence, physicalKey } from './fast-scan-printing-identity.js';
import { icon } from './icons.js';
import { normalizeSetCode, extractSetCodeCandidates, setCodeCandidates, classifyPrintingMatch, classifyNearPrintingMatch, OcrConsensus, ScanGate, ScanSessionBuffer, defaultScanSettings } from './fast-scan-core.js';
import { isFirstEdition, editionState } from './collection.js';
import { FastScanCamera, preprocessCodeImage } from './fast-scan-camera.js';
import { loadScanSession, saveScanSession, clearScanSession } from './fast-scan-storage.js';
import { syncCatalogIndex } from './fast-scan-catalog-cache.js';
import { prepareFastScanSync, markChunk, pendingChunkIndexes, syncProgress } from './fast-scan-sync.js';
import { PaddleOcrEngine } from './fast-scan-ocr-engine-b.js';
import { resolveStoredCard, sanitizeYugiohRarity, canonicalCatalogCardId, findCardById, localizeSetCode, konamiRaritiesForSetCode, canonicalYgoCardImage } from './cards.js';

const MISS_CACHE_TTL=20000;
// resolve() da solo può già sparare fino a ~12 RPC concorrenti per una
// singola carta (candidati di correzione OCR, non è farina del sacco di
// Step B). Prima di Step B questo era comunque sicuro perché una sola carta
// alla volta poteva essere in risoluzione (il loop restava bloccato). Con la
// risoluzione in background senza limiti, scansionare più carte nuove di
// fila (reso possibile proprio da Step A, molto più veloce) accoda decine di
// risoluzioni in parallelo che si contendono rete/CPU con l'OCR stesso —
// il rallentamento riportato dopo Step B. Questo limite riporta "una carta
// alla volta" per il lavoro di rete, senza tornare a bloccare il loop.
const MAX_BACKGROUND_RESOLUTIONS=1;
const TELEMETRY_WINDOW=100;
// Reuse the existing strong-reading threshold; device calibration can refine it.
const STRONG_OCR_CONFIDENCE=88;
const LOOKUP_TIMEOUT_MS=15000;
function boundedLookup(promise,timeoutMs=LOOKUP_TIMEOUT_MS){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Verifica catalogo scaduta'),{code:'LOOKUP_TIMEOUT'})),timeoutMs);})]).finally(()=>clearTimeout(timer));}
function now(){return typeof performance!=='undefined'?performance.now():Date.now();}
function mean(values){return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;}
function percentile(values,ratio){if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*ratio))];}
function esitoFromOutcome(outcome){if(!outcome)return 'NOT_FOUND';if(outcome.status==='pending_async')return 'PENDING';if(outcome.decision==='EXACT_UNIQUE')return 'EXACT';if(outcome.decision==='NEAR_UNIQUE')return 'NEAR';if(outcome.status==='not_found')return 'NOT_FOUND';return 'REVIEW';}
// Finestra scorrevole di telemetria locale (solo ?debugScan=1, mai inviata a
// Supabase): serve a misurare dove va davvero il tempo prima di ottimizzare
// alla cieca — vedi la roadmap Fast Scan performance del 2026-09-15.
class ScanTelemetry{
  constructor(){this.samples=[];this.backgroundSamples=[];}
  record(sample){this.samples.push(sample);if(this.samples.length>TELEMETRY_WINDOW)this.samples.shift();}
  recordBackground(ms){this.backgroundSamples.push(ms);if(this.backgroundSamples.length>TELEMETRY_WINDOW)this.backgroundSamples.shift();}
  // Riepilogo di sessione (?debugScan=1): p50/p95 delle fasi principali +
  // tassi accepted/review/not_found/fallback + worker restarts/timeouts
  // (contatori vivi del motore, non un delta di finestra) — pensato per
  // essere confrontato PRIMA/DOPO un cambiamento reale, mai per dichiarare
  // percentuali di miglioramento senza una misura su dispositivo.
  summary(){
    const n=this.samples.length;if(!n)return null;
    const totals=this.samples.map(sample=>sample.cycleTotalMs);
    const ocrTotals=this.samples.map(sample=>sample.primaryOcrMs+sample.fallbackOcrMs);
    const readyNext=this.samples.map(sample=>sample.readyNextMs);
    const scannerLocked=this.samples.map(sample=>sample.scannerLockedMs);
    const fallbackCount=this.samples.filter(sample=>sample.fallbackUsed).length;
    const externalCount=this.samples.filter(sample=>sample.externalLookupMs>0).length;
    const acceptedCount=this.samples.filter(sample=>sample.result==='accepted').length;
    const reviewCount=this.samples.filter(sample=>sample.result==='review').length;
    const notFoundCount=this.samples.filter(sample=>sample.result==='not_found').length;
    const duplicateCount=this.samples.filter(sample=>sample.duplicate).length;
    const bg=this.backgroundSamples;
    const last=this.samples[n-1];
    return {
      count:n,meanMs:mean(totals),p50Ms:percentile(totals,.5),p95Ms:percentile(totals,.95),
      ocrP50Ms:percentile(ocrTotals,.5),ocrP95Ms:percentile(ocrTotals,.95),
      readyNextP50Ms:percentile(readyNext,.5),readyNextP95Ms:percentile(readyNext,.95),
      scannerLockedP50Ms:percentile(scannerLocked,.5),scannerLockedP95Ms:percentile(scannerLocked,.95),
      backgroundVerificationCount:bg.length,backgroundVerificationP50Ms:percentile(bg,.5),backgroundVerificationP95Ms:percentile(bg,.95),
      fallbackRate:fallbackCount/n,externalRate:externalCount/n,
      acceptedRate:acceptedCount/n,reviewRate:reviewCount/n,notFoundRate:notFoundCount/n,duplicateRate:duplicateCount/n,
      executionMode:last?.executionMode||'',cacheState:last?.cacheState||'',
      workerTimeoutCount:last?.workerTimeoutCount||0,workerRestartCount:last?.workerRestartCount||0
    };
  }
  // Esporta i campioni grezzi (mai inviati a Supabase) come JSON o CSV, per
  // il benchmark manuale su telefono richiesto dalla roadmap Fast Scan.
  toJSON(){return {exportedAt:new Date().toISOString(),summary:this.summary(),samples:this.samples,backgroundSamples:this.backgroundSamples};}
  toCSV(){
    if(!this.samples.length)return '';
    const columns=Object.keys(this.samples[0]);
    const rows=this.samples.map(sample=>columns.map(column=>JSON.stringify(sample[column]??'')).join(','));
    return [columns.join(','),...rows].join('\n');
  }
}

export class FastScanController {
  constructor({api,externalLookup,getCollection,isOnline,onRender,onSaved,onToast,onRoute,camera,paddleOcr}={}) {
    Object.assign(this,{api,externalLookup,getCollection,isOnline,onRender,onSaved,onToast,onRoute});
    this.camera=camera||new FastScanCamera();this.paddleOcr=paddleOcr||new PaddleOcrEngine();this.paddleState='idle';this.paddleError='';this.primaryOcrPreparing=null;
    this.buffer=new ScanSessionBuffer();this.sync=null; this.gate=new ScanGate(); this.consensus=new OcrConsensus(); this.failureStreak=0; this.localCatalog=new Map(); this.resolutionCache=new Map(); this.missCache=new Map(); this.phase='setup'; this.status='Pronto';this.debugMode=typeof location!=='undefined'&&new URLSearchParams(location.search).get('debugScan')==='1';this.telemetry=new ScanTelemetry();this.cycleTelemetry=null;this.cacheState='LOADING';this.lastCycleDecision=null;this.catalogIndex=new Map();this.pendingCodes=new Set();this.backgroundQueue=[];this.activeBackgroundResolutions=0;
    this.last=null;this.scanState='IDLE';this.recoveringCamera=false;this.recoveryCount=0;this.recoveryAttempts=[];this.startRequestId=0;this.hiddenSuspended=false;this.roiPreset='narrow';this.forceSnapshot=false;this.snapshotInFlight=false;this.scanCycleInFlight=false; this.devices=[]; this.timer=0; this.persistTimer=0; this.feedbackTimer=0; this.zoomTimer=0; this.backgroundStopTimer=0; this.backgroundCameraStopped=false; this.pinch=null; this.hasRecovery=false; this.saving=false; this.cameraError=''; this.exitOpen=false; this.manualOpen=false;this.settingsOpen=false;
    if(this.debugMode)this.camera.onDiagnostic=(event,payload)=>this.debugTrace(`camera:${event}`,payload);
    this.scanActionHandler=event=>void this.handleScanAction(event);document.addEventListener('click',this.scanActionHandler);
    this.visibilityHandler=()=>void this.handleVisibilityChange(); document.addEventListener('visibilitychange',this.visibilityHandler);
    this.focusHandler=event=>{if(event.target.closest?.('.live-roi,#fast-scan-video'))void this.refocus();}; document.addEventListener('click',this.focusHandler);
    this.restartHandler=event=>{if(event.target.closest?.('[data-scan-restart-camera]'))void this.recoverCamera('manual-restart');};document.addEventListener('click',this.restartHandler);
    this.focusKeyHandler=event=>{if(['Enter',' '].includes(event.key)&&event.target.matches?.('.live-roi')){event.preventDefault();void this.refocus();}}; document.addEventListener('keydown',this.focusKeyHandler);
    this.zoomHandler=event=>{if(event.target.matches?.('[data-scan-zoom]'))this.queueZoom(event.target.value);const step=event.target.closest?.('[data-scan-zoom-step]');if(step)this.stepZoom(Number(step.dataset.scanZoomStep));};document.addEventListener('input',this.zoomHandler);document.addEventListener('click',this.zoomHandler);
    this.pinchStartHandler=event=>this.startPinch(event);this.pinchMoveHandler=event=>this.movePinch(event);this.pinchEndHandler=()=>{this.pinch=null;};document.addEventListener('touchstart',this.pinchStartHandler,{passive:true});document.addEventListener('touchmove',this.pinchMoveHandler,{passive:false});document.addEventListener('touchend',this.pinchEndHandler,{passive:true});
  }
  get hasScans(){return this.buffer.scanned>0||this.buffer.total>0||this.buffer.review.length>0;}
  get currentScan(){return this.buffer.getScan(this.currentScanId);}
  interruptCapture(){for(const id of [this.pendingCaptureId,this.activeCaptureId]){const scan=this.buffer.getScan(id);if(scan&&['CAPTURED','PROCESSING'].includes(scan.status)){this.buffer.invalidateScan(id);this.buffer.failScan(id,'INTERRUPTED');}}this.pendingCaptureId=null;this.forceSnapshot=false;this.persist();}
  // Solo un vero esito da confermare (1-4 candidati reali) interrompe il
  // flusso, e lo risolve subito qui — mai una coda "da verificare dopo".
  // Ogni altro esito (accettato, fallito, in verifica) resta un feedback
  // transitorio su showDetection/showResolvedFeedback: nessun pannello
  // persistente durante lo scatto normale.
  assistantView(){
    const event=this.currentScan;
    const matches=event?.reviewData?.matches;
    if(!event||event.status!=='REVIEW_REQUIRED'||!matches?.length)return '';
    const options=matches;
    const title=options.length>1?'Quale carta è?':'Confermi questa carta?';
    // artworkLabel è presente SOLO quando l'ambiguità riguarda l'illustrazione
    // (stesso catalogCardId/set/rarità reali, il registro conferma più artwork
    // note): mai una seconda rarità inventata, solo l'etichetta Standard/
    // Artwork alternativa accanto ai dati reali già mostrati.
    const name=options.find(match=>match.cardName)?.cardName||'';
    return `<article class="scan-ambiguous" aria-live="polite"><header><strong>${title}</strong><small>${esc(name?`${name} · ${options[0].setCode||''}`:event.normalizedCode||'')}</small></header><div class="scan-ambiguous-options">${options.map((match,index)=>`<button type="button" data-scan-choice="${index}" data-scan-id="${event.id}">${cardImage(match)?`<img src="${esc(cardImage(match,{small:true}))}" alt="">`:`<span class="fsx-thumb-empty">${icon('card')}</span>`}<span><b class="fsx-rarity">${esc(match.rarity||'Rarità non indicata')}</b><small>${esc(match.setCode||'')}</small>${match.requiresCatalogRepair||match.invalidPhysicalRarity?'<small>Richiede correzione catalogo</small>':''}${match.artworkLabel?`<small class="scan-ambiguous-label">${esc(match.artworkLabel)}</small>`:''}</span></button>`).join('')}</div><button type="button" class="scan-ambiguous-retry" data-scan-retry="${event.id}">${glyph('retry')} Riprova foto</button></article>`;
  }
  historyView(all=false){
    const events=this.buffer.scanEvents.filter(event=>event.countsAsScan!==false),visible=all?events:events.slice(-5);
    const labels={CAPTURED:'Acquisito',PROCESSING:'Analisi',PENDING_REMOTE:'In verifica',CONFIRMED:'Aggiunta alla sessione',REVIEW_REQUIRED:'Da verificare',DEFERRED:'Messa da parte',FAILED:'Fallito',CANCELLED:'Annullato'};
    const rows=visible.slice().reverse().map(event=>`<li><span><b>#${event.sequence} · ${esc(event.cardName||event.normalizedCode||'Codice non letto')}</b><small>${labels[event.status]||esc(event.status)}${event.failureReason?` · ${esc(event.failureReason)}`:''}</small></span>${event.status!=='CANCELLED'?`<button type="button" data-scan-edit="${event.id}" aria-label="Correggi scatto ${event.sequence}">Correggi</button><button type="button" data-scan-cancel="${event.id}" aria-label="Annulla scatto ${event.sequence}">Annulla</button>`:''}</li>`).join('');
    return `<details ${all?'open':''}><summary>${all?'Cronologia completa':'Ultime 5 acquisizioni'} · ${events.length} scatti</summary><ol>${rows||'<li>Nessuno scatto</li>'}</ol></details><button type="button" data-scan-undo ${!events.some(event=>event.status!=='CANCELLED')?'disabled':''}>Annulla ultimo scatto</button>${!all?'<button type="button" data-scan-history-review>Apri cronologia e review</button>':''}`;
  }
  async handleScanAction(event){
    // data-scan-choice/data-scan-retry: chooser di ambiguità inline (assistantView,
    // solo scattato). data-scan-edit/data-scan-cancel/data-scan-undo: cronologia
    // completa della schermata di sessione (historyView in reviewView).
    const button=event.target.closest?.('[data-scan-retry],[data-scan-edit],[data-scan-cancel],[data-scan-undo],[data-scan-choice]');if(!button)return;
    if(!this.canEditSession()||this.snapshotInFlight){this.onToast?.('Attendi la fine dello scatto');return;}
    const data=button.dataset;
    if(data.scanEdit){
      const scan=this.buffer.getScan(data.scanEdit);if(!scan||scan.status==='CANCELLED')return;
      this.editScanId=scan.id;
      this.toggleManual(true);const input=document.querySelector('#scan-manual-code');if(input)input.value=scan.normalizedCode||scan.setCode||'';return;
    }
    this.invalidateSync();
    if(data.scanChoice!==undefined){this.chooseReview(data.scanId,Number(data.scanChoice));return;}
    if(data.scanRetry){
      // Riprova foto: scarta questo scatto (resta nella cronologia interna,
      // mai una coda di verifica) e riarma subito la fotocamera per il prossimo.
      this.buffer.cancelScan(data.scanRetry);if(this.currentScanId===data.scanRetry)this.currentScanId=null;
      this.persist();this.refreshHud();this.requestSnapshot();return;
    }
    const cancelId=data.scanCancel||(button.hasAttribute('data-scan-undo')?[...this.buffer.scanEvents].reverse().find(scan=>scan.countsAsScan!==false&&scan.status!=='CANCELLED')?.id:null);
    if(cancelId){this.buffer.cancelScan(cancelId);if(this.currentScanId===cancelId)this.currentScanId=null;}
    this.persist();this.refreshHud();if(this.phase==='review')this.onRender?.();
  }
  refreshScanPanels(){
    for(const [selector,html] of [['[data-scan-assistant]',this.assistantView()],['[data-scan-history]',this.historyView(this.phase==='review')]]){const node=document.querySelector(selector);if(node&&node.innerHTML!==html)node.innerHTML=html;}
    this.updateCaptureUi(this.snapshotInFlight);
  }
  async restore(){const snapshot=await loadScanSession();if(snapshot&&(snapshot.scanEvents?.length||snapshot.scanned||snapshot.total||snapshot.review?.length)){const restored=new ScanSessionBuffer(snapshot);restored.interruptPending();if(!restored.total&&!restored.review.length&&!restored.scanEvents.some(scan=>scan.status==='FAILED')){void clearScanSession().catch(()=>{});return;}this.buffer=restored;this.sync=snapshot.sync||null;this.hasRecovery=true;if(this.sync?.status==='syncing')this.sync={...this.sync,status:'pending'};this.onRender?.();}}
  view(){return this.phase==='review'?this.reviewView()+this.manualSheetView():this.phase==='scanning'?this.scannerView():this.setupView();}
  // Fast Scan v2 (2026-10-24): avvio essenziale, fotocamera al centro, uno
  // stato leggibile alla volta, revisione a schede. La geometria di .live-roi
  // (da cui sourceCropDetails ricava il ritaglio OCR) resta invariata.
  setupView(){const s=this.buffer.settings||defaultScanSettings();return `<section class="page-stack fast-scan-page fsx-launch"><header class="fsx-launch-head"><button class="fsx-round" data-scan-setup-back aria-label="Torna alla Raccolta">${glyph('back')}</button><div><span class="eyebrow">Scanner</span><h1>Fast Scan</h1></div></header><div class="fsx-hero" aria-hidden="true"><div class="fsx-hero-card"><span class="fsx-hero-art"></span><span class="fsx-hero-code"><i>BETB-IT001</i></span><span class="fsx-hero-text"></span><span class="fsx-hero-text short"></span></div><p><strong>Inquadra solo il codice</strong><span>È la riga sotto l’illustrazione, a destra. Carta, rarità e lingua le trova lo scanner.</span></p></div>${this.hasRecovery?`<div class="resume-scan fsx-card fsx-resume"><div><span class="fsx-badge">${glyph('pause')}</span><span><strong>Sessione non salvata</strong><small>${esc(sessionSummary(this.buffer,this.failedScans().length))}</small></span></div><div class="actions"><button class="btn" data-scan-resume-session>Riprendi</button><button class="btn secondary" data-scan-recovery-review>Revisione</button><button class="btn secondary danger" data-scan-discard>Scarta</button></div></div>`:''}<form id="fast-scan-settings" class="scan-settings fsx-card"><div class="fsx-card-title"><strong>Sessione</strong><small>Valori usati per ogni carta scansionata</small></div>${settingsFields(s)}<div class="scan-start-actions"><button class="btn fsx-primary" type="submit">${icon('camera')} Avvia scansione</button><button class="btn secondary" type="button" data-scan-manual-start>${glyph('keyboard')} Inserisci codici a mano</button></div></form><ul class="fsx-tips"><li>${icon('flash')}<span><b>Luce</b> Evita i riflessi: sulle foil inclina un po’ la carta o usa il flash.</span></li><li>${icon('scan')}<span><b>Distanza</b> Il codice deve riempire il riquadro, nitido e dritto.</span></li><li>${icon('check')}<span><b>Ritmo</b> Dopo il ✓ passa alla carta successiva: le dubbie te le chiede subito.</span></li></ul></section>`;}
  scannerView(){const s=this.buffer.settings||defaultScanSettings();return `<section class="fast-scan-live fsx-live ${this.cameraError?'manual-camera':''}" data-state="${this.hudState()}"><video id="fast-scan-video" autoplay muted playsinline></video><div class="fsx-vignette" aria-hidden="true"></div><header class="fsx-top"><button class="fsx-round" data-scan-back aria-label="Chiudi scanner">${glyph('close')}</button><button type="button" class="fsx-session-chip" data-scan-settings-open aria-label="Impostazioni sessione"><span data-scan-settings-summary>${esc(settingsSummary(s))}</span>${icon('settings')}</button><div class="fsx-top-actions"><button class="fsx-round" data-scan-torch ${this.camera.torchSupported?'':'disabled'} aria-label="Flash">${icon('flash')}<span class="fsx-sr">Flash</span></button><button class="fsx-round" data-scan-switch-camera ${this.devices.length>1?'':'disabled'} aria-label="Cambia fotocamera">${glyph('flip')}<span class="fsx-sr">Camera</span></button></div></header>${this.cameraError?`<div class="live-camera-error fsx-camera-error"><span>${icon('camera')}</span><strong>${esc(this.cameraError)}</strong><small>Puoi continuare inserendo i codici a mano.</small></div>`:''}<div class="live-roi-label fsx-hint">Codice della carta<small>es. BETB-IT001</small></div><div class="live-roi" aria-label="Area di lettura codice"><i></i><span></span><b class="fsx-scanline" aria-hidden="true"></b></div><div class="fsx-burst" data-scan-burst aria-hidden="true"></div>${this.debugMode?'<aside class="live-crop-debug" aria-live="polite"><strong>Crop OCR esatto</strong><canvas data-scan-debug-crop></canvas><small data-scan-debug-geometry>In attesa dello scatto</small><small data-scan-debug-stats>In attesa di scan misurati</small><div class="live-crop-debug-export"><button type="button" data-scan-export-telemetry="json">Esporta JSON</button><button type="button" data-scan-export-telemetry="csv">Esporta CSV</button></div></aside>':''}<div class="live-ocr-state fsx-status"><i aria-hidden="true"></i><strong data-scan-status>${esc(this.status)}</strong></div><div class="live-detection ${this.detection?`show ${this.detection.tone}`:''}" data-scan-detection role="status" aria-live="polite" aria-atomic="true">${this.detectionContent(this.detection)}</div><div class="live-background-result ${this.backgroundNotice?`show ${this.backgroundNotice.tone}`:''}" data-scan-background-result role="status" aria-live="polite" aria-atomic="true">${this.detectionContent(this.backgroundNotice)}</div><footer class="live-scan-bottom fsx-dock"><div class="live-scan-content"><div data-scan-assistant>${this.assistantView()}</div><div class="fsx-dock-row"><button type="button" class="live-session-count fsx-tray" data-scan-history-review aria-label="Apri la revisione"><span class="fsx-tray-thumbs" data-scan-tray-thumbs>${this.trayThumbs()}</span><span class="fsx-tray-count"><b data-scan-total-number>${this.buffer.total}</b> <span data-scan-total-label>${this.buffer.total===1?'carta':'carte'}</span></span></button><button type="button" class="live-capture fsx-shutter" data-scan-capture ${this.snapshotInFlight?'disabled':''}><i aria-hidden="true"></i><span>${this.snapshotInFlight?'Elaborazione…':'Scatta e analizza'}</span></button><button type="button" class="fsx-side" data-scan-manual-open>${glyph('keyboard')}<span>Codice</span></button></div><div class="live-controls"><button type="button" class="fsx-undo" data-scan-undo ${this.hasUndoableScan()?'':'disabled'}>${glyph('undo')}<span>Annulla ultima</span></button></div></div></footer>${this.exitSheetView()}${this.manualSheetView()}${this.settingsSheetView()}</section>`;}
  exitSheetView(){return `<div class="scan-sheet-backdrop hidden" data-scan-exit-sheet><section class="scan-bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="scan-exit-title"><span class="sheet-handle"></span><small>Sessione Fast Scan</small><h2 id="scan-exit-title">Hai finito?</h2><p>Vediamo cos’hai raccolto allora?</p><div class="sheet-session-summary"><b>${this.buffer.scanned} carte scansionate</b><span>${esc(sessionSummary(this.buffer,this.failedScans().length))}</span></div><button class="btn" data-scan-confirm-review>Sì, mostrami</button><button class="btn secondary" data-scan-cancel-exit>No, continua a scansionare</button><button class="sheet-danger" data-scan-discard-exit>Scarta sessione</button></section></div>`;}
  manualSheetView(){return `<div class="scan-sheet-backdrop hidden" data-scan-manual-sheet><section class="scan-bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="scan-manual-title"><span class="sheet-handle"></span><small>Inserimento a mano</small><h2 id="scan-manual-title">Scrivi il codice</h2><p>Lo trovi sotto l’illustrazione, a destra: tre o quattro caratteri, il trattino, la lingua e il numero.</p><form id="scan-manual-form"><input id="scan-manual-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Es. BETB-IT001" required><button class="btn">Aggiungi</button></form><button class="btn secondary" data-scan-manual-close>Chiudi</button></section></div>`;}
  settingsSheetView(){const s=this.buffer.settings||defaultScanSettings();return `<div class="scan-sheet-backdrop hidden" data-scan-settings-sheet><section class="scan-bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="scan-settings-title"><span class="sheet-handle"></span><small>Sessione</small><h2 id="scan-settings-title">Impostazioni</h2><div class="scan-settings fsx-sheet-settings" data-scan-settings-form>${settingsFields(s)}</div><button class="btn" data-scan-settings-close>Fatto</button></section></div>`;}
  // Revisione v2.1 (2026-10-24): barra fissa con riepilogo, prima ciò che chiede
  // un'azione (da verificare, non riuscite), poi le carte pronte come griglia di
  // illustrazioni (ultime in alto); tocca una carta per quantità, 1ª Ed. e rimozione.
  reviewView(){const entries=[...this.buffer.entries.values()],progress=syncProgress(this.sync),syncFailed=this.sync?.status==='error',failed=this.failedScans(),pending=this.buffer.review.length,unresolved=this.buffer.scanEvents.filter(scan=>!['CONFIRMED','CANCELLED'].includes(scan.status)).length,total=this.buffer.total,open=this.reviewSheetKey?this.buffer.entries.get(this.reviewSheetKey):null;if(this.reviewSheetKey&&!open)this.reviewSheetKey=null;const selection=this.reviewSelection=new Set([...(this.reviewSelection||[])].filter(key=>this.buffer.entries.has(key))),selecting=selection.size>0;const summary=[`${entries.length} ${entries.length===1?'stampa':'stampe'}`,pending?`${pending} da verificare`:'',failed.length?`${failed.length} non ${failed.length===1?'riuscita':'riuscite'}`:''].filter(Boolean).join(' · ');return `<section class="page-stack fast-scan-page scan-review fsx-review"><header class="fsx-review-bar"><button class="fsx-round" data-scan-continue aria-label="Torna allo scanner">${icon('camera')}</button><div><span class="eyebrow">Revisione</span><strong>${total} ${total===1?'carta':'carte'}</strong><small>${esc(summary)}</small></div>${entries.length>1?`<button type="button" class="fsx-select-all" data-scan-select-all>${selection.size===entries.length?'Nessuna':'Tutte'}</button>`:''}</header>${syncFailed?`<section class="fsx-card scan-sync-warning" role="alert"><strong>Sincronizzazione interrotta. Le scansioni sono salvate sul telefono.</strong><small>${progress.synced}/${progress.total} blocchi completati · al nuovo tentativo partono solo quelli mancanti.</small><div class="actions"><button class="btn" data-scan-save>Riprova</button><button class="btn secondary" data-scan-sync-later>Più tardi</button><button class="btn secondary" data-scan-export>Esporta riepilogo</button></div></section>`:''}${pending?`<section class="fsx-block fsx-attn"><h2>Da verificare <span>${pending}</span></h2><p>Scegli la stampa giusta o correggi il codice: finché restano qui non vengono salvate.</p><div class="scan-review-list">${this.buffer.review.map(item=>reviewRow(item)).join('')}</div></section>`:''}${failed.length?`<section class="fsx-block fsx-failed"><h2>Non riuscite <span>${failed.length}</span></h2><p>Scatti in cui il codice non è stato letto o trovato. Scrivilo a mano oppure toglili: non vengono salvati.</p><div class="scan-review-list">${failed.map(scan=>failedRow(scan)).join('')}</div></section>`:''}${!entries.length&&!pending?`<div class="fsx-empty-session"><p>Non c’è nessuna carta da aggiungere${failed.length?' finché non correggi gli scatti qui sopra':''}.</p><button type="button" class="btn secondary" data-scan-review-discard>Chiudi la sessione senza salvare</button></div>`:''}<section class="fsx-block"><div class="fsx-block-head"><h2>Pronte <span>${entries.length}</span></h2>${entries.length?`<small>${selecting?'Tocca altre carte per aggiungerle alla selezione':'Tocca una carta per i dettagli · il pallino per sceglierne più insieme'}</small>`:''}</div>${entries.length?`<div class="fsx-grid">${entries.slice().reverse().map(entry=>entryTile(entry,selection.has(entry.key),selecting)).join('')}</div>`:`<div class="fsx-empty">${icon('scan')}<strong>Nessuna carta ancora</strong><small>Torna allo scanner e inquadra il primo codice.</small></div>`}</section>${this.debugMode?`<section class="fsx-card scan-history-review" data-scan-history>${this.historyView(true)}</section>`:''}${selecting?selectionBar([...selection].map(key=>this.buffer.entries.get(key)).filter(Boolean)):''}<div class="scan-save-bar fsx-savebar" ${selecting?'hidden':''}><span>${unresolved?`${unresolved} ${unresolved===1?'scatto non riuscito o da verificare escluso':'scatti non riusciti o da verificare esclusi'}`:'Tutto pronto'}${this.saving&&progress.total?` · ${progress.percent}%`:''}</span><button class="btn fsx-primary" data-scan-save ${!entries.length||this.saving||this.buffer.review.some(item=>item.pending)||!this.isOnline()?'disabled':''}>${this.saving?'Sincronizzazione…':syncFailed?'Riprova sincronizzazione':total?`Aggiungi ${total} ${total===1?'carta':'carte'} alla raccolta`:'Nessuna carta da aggiungere'}</button></div>${open?entrySheet(open):''}</section>`;}
  hudState(){if(this.cameraError&&this.cameraError!=='Modalità manuale')return 'error';if(this.detection)return this.detection.tone;if(this.snapshotInFlight)return 'busy';if(this.currentScan?.status==='REVIEW_REQUIRED')return 'warn';return 'idle';}
  applyHudState(){const node=document.querySelector('.fsx-live');if(!node)return;const state=this.hudState();if(node.dataset.state!==state)node.dataset.state=state;}
  trayThumbs(){const items=[...this.buffer.entries.values()].slice(-3).reverse();return items.length?items.map(item=>cardImage(item)?`<img src="${esc(cardImage(item,{small:true}))}" alt="">`:`<span class="fsx-thumb-empty">${icon('card')}</span>`).join(''):`<span class="fsx-thumb-empty">${icon('card')}</span>`;}
  failedScans(){return this.buffer.scanEvents.filter(scan=>scan.countsAsScan!==false&&scan.status==='FAILED');}
  // Animazione di esito sopra il mirino: riparte a ogni esito, sparisce da sola.
  playBurst(kind){const node=document.querySelector('[data-scan-burst]');if(!node)return;clearTimeout(this.burstTimer);node.className='fsx-burst';if(!kind){node.innerHTML='';return;}node.innerHTML=kind==='ok'?BURST_OK:BURST_ERROR;void node.offsetWidth;node.className=`fsx-burst show ${kind}`;this.burstTimer=setTimeout(()=>{node.className='fsx-burst';node.innerHTML='';},kind==='ok'?1250:1050);}
  hasUndoableScan(){return this.buffer.scanEvents.some(scan=>scan.countsAsScan!==false&&scan.status!=='CANCELLED');}
  toggleSettings(open){this.settingsOpen=open;document.querySelector('[data-scan-settings-sheet]')?.classList.toggle('hidden',!open);if(open)this.stopLoop();else if(this.phase==='scanning'&&this.camera.stream&&!this.manualOpen&&!this.exitOpen&&!this.snapshotInFlight)this.schedule(120);}
  bind(root=document){this.reattachVideo();this.updateCaptureUi(this.snapshotInFlight);root.querySelector('#fast-scan-settings')?.addEventListener('submit',e=>{e.preventDefault();this.readSettings();void this.start();});root.querySelector('[data-scan-setup-back]')?.addEventListener('click',()=>void this.exitToCollection());root.querySelector('[data-scan-manual-start]')?.addEventListener('click',()=>{this.readSettings();this.startManual();});root.querySelector('[data-scan-resume-session]')?.addEventListener('click',()=>{this.hasRecovery=false;void this.start();});root.querySelector('[data-scan-recovery-review]')?.addEventListener('click',()=>void this.openReview());root.querySelector('[data-scan-discard]')?.addEventListener('click',()=>void this.discard());root.querySelector('[data-scan-review-discard]')?.addEventListener('click',async()=>{await this.discard(false);this.onRoute?.('scan');this.onRender();});root.querySelector('[data-scan-back]')?.addEventListener('click',()=>void this.requestExit());root.querySelector('[data-scan-confirm-review]')?.addEventListener('click',()=>void this.openReview());root.querySelector('[data-scan-cancel-exit]')?.addEventListener('click',()=>this.cancelExit());root.querySelector('[data-scan-discard-exit]')?.addEventListener('click',()=>void this.discardAndExit());root.querySelectorAll('[data-scan-select]').forEach(button=>button.addEventListener('click',()=>{const key=button.dataset.scanSelect,selection=new Set(this.reviewSelection||[]);selection.has(key)?selection.delete(key):selection.add(key);this.reviewSelection=selection;this.onRender();}));root.querySelector('[data-scan-select-all]')?.addEventListener('click',()=>{const keys=[...this.buffer.entries.keys()];this.reviewSelection=new Set((this.reviewSelection?.size||0)===keys.length?[]:keys);this.onRender();});root.querySelector('[data-scan-select-done]')?.addEventListener('click',()=>{this.reviewSelection=new Set();this.onRender();});root.querySelectorAll('[data-scan-bulk-edition]').forEach(button=>button.addEventListener('click',()=>{if(!this.canEditSession())return;const edition=button.dataset.scanBulkEdition==='first'?'Prima Edizione':'Unlimited';this.invalidateSync();for(const key of this.reviewSelection||[])this.buffer.setEdition(key,edition);this.persist();this.onRender();}));root.querySelectorAll('[data-scan-bulk-condition]').forEach(button=>button.addEventListener('click',()=>{if(!this.canEditSession())return;const condition=button.dataset.scanBulkCondition;if(!VALID_CONDITIONS.includes(condition))return;this.invalidateSync();for(const key of this.reviewSelection||[])this.buffer.setCondition(key,condition);this.persist();this.onRender();}));root.querySelector('[data-scan-continue]')?.addEventListener('click',()=>{if(!this.canEditSession())return;this.reviewSelection=new Set();this.onRoute?.('scan');void this.start();});root.querySelector('[data-scan-manual-open]')?.addEventListener('click',()=>this.toggleManual(true));root.querySelector('[data-scan-history-review]')?.addEventListener('click',()=>void this.openReview());root.querySelector('[data-scan-manual-close]')?.addEventListener('click',()=>this.toggleManual(false));root.querySelector('[data-scan-capture]')?.addEventListener('click',()=>this.requestSnapshot());root.querySelector('[data-scan-settings-open]')?.addEventListener('click',()=>this.toggleSettings(true));root.querySelector('[data-scan-settings-close]')?.addEventListener('click',()=>this.toggleSettings(false));root.querySelector('[data-scan-settings-form]')?.addEventListener('change',()=>{this.readSettings();const summary=root.querySelector('[data-scan-settings-summary]');if(summary)summary.textContent=settingsSummary(this.buffer.settings);});root.querySelector('[data-scan-torch]')?.addEventListener('click',async e=>{const on=await this.camera.toggleTorch();e.currentTarget.classList.toggle('active',on);const label=e.currentTarget.querySelector('span');if(label)label.textContent=on?'Flash on':'Flash';e.currentTarget.setAttribute('aria-pressed',String(on));});root.querySelector('[data-scan-switch-camera]')?.addEventListener('click',()=>void this.switchCamera());root.querySelector('#scan-manual-form')?.addEventListener('submit',e=>{e.preventDefault();const input=root.querySelector('#scan-manual-code');void (this.editScanId?this.correctReview(this.editScanId,input.value):this.processManual(input.value)).then(()=>{input.value='';input.focus();});});root.querySelectorAll('[data-scan-qty-inc]').forEach(button=>button.addEventListener('click',()=>{if(!this.canEditSession())return;const key=button.dataset.scanQtyInc,item=this.buffer.entries.get(key);if(!item)return;this.invalidateSync();this.buffer.updateQuantity(key,item.quantity+1);this.persist();this.onRender();}));root.querySelectorAll('[data-scan-qty-dec]').forEach(button=>button.addEventListener('click',()=>{if(!this.canEditSession())return;const key=button.dataset.scanQtyDec,item=this.buffer.entries.get(key);if(!item)return;this.invalidateSync();this.buffer.updateQuantity(key,item.quantity-1);this.persist();this.onRender();}));root.querySelectorAll('[data-scan-first-edition]').forEach(button=>button.addEventListener('click',()=>{if(!this.canEditSession())return;const key=button.dataset.scanFirstEdition,item=this.buffer.entries.get(key);if(!item)return;this.invalidateSync();this.buffer.setEdition(key,isFirstEdition(item.edition)?'Unlimited':'Prima Edizione');this.persist();this.onRender();}));root.querySelectorAll('[data-scan-remove]').forEach(button=>button.addEventListener('click',()=>{if(!this.canEditSession())return;this.invalidateSync();this.buffer.updateQuantity(button.dataset.scanRemove,0);this.persist();this.onRender();}));root.querySelectorAll('[data-review-choice]').forEach(button=>button.addEventListener('click',()=>this.chooseReview(button.dataset.reviewId,Number(button.dataset.reviewChoice))));root.querySelectorAll('[data-review-ignore]').forEach(button=>button.addEventListener('click',()=>{if(!this.canEditSession())return;this.invalidateSync();this.buffer.removeReview(button.dataset.reviewIgnore);this.persist();this.onRender();}));root.querySelectorAll('[data-review-correct]').forEach(button=>button.addEventListener('click',()=>{const input=root.querySelector(`[data-review-input="${button.dataset.reviewCorrect}"]`);void this.correctReview(button.dataset.reviewCorrect,input.value);}));root.querySelectorAll('[data-scan-entry-open]').forEach(button=>button.addEventListener('click',()=>{this.reviewSheetKey=button.dataset.scanEntryOpen;this.onRender();}));root.querySelector('[data-scan-entry-close]')?.addEventListener('click',()=>{this.reviewSheetKey=null;this.onRender();});root.querySelector('[data-scan-entry-sheet]')?.addEventListener('click',event=>{if(event.target===event.currentTarget){this.reviewSheetKey=null;this.onRender();}});root.querySelectorAll('[data-scan-save]').forEach(button=>button.addEventListener('click',()=>void this.save()));root.querySelector('[data-scan-sync-later]')?.addEventListener('click',()=>{this.hasRecovery=true;this.onRoute?.('collection');});root.querySelector('[data-scan-export]')?.addEventListener('click',()=>this.exportSummary());root.querySelectorAll('[data-scan-export-telemetry]').forEach(button=>button.addEventListener('click',()=>this.exportTelemetry(button.dataset.scanExportTelemetry)));}
  readSettings(){const pick=id=>document.querySelector(id);this.buffer.settings={game:'yugioh',language:pick('#scan-language')?.value||'Italiano',condition:pick('#scan-condition')?.value||'Near Mint',edition:pick('#scan-edition')?.value.trim()||'',autoAdd:Boolean(pick('#scan-auto')?.checked),vibration:Boolean(pick('#scan-vibration')?.checked),sound:Boolean(pick('#scan-sound')?.checked)};this.persist();}
  startManual(){this.startRequestId+=1;this.camera.stop('manual-mode');this.recoveringCamera=false;this.cameraStarting=false;this.stopLoop();this.phase='scanning';this.cameraError='Modalità manuale';this.status='Inserisci un codice';this.onRoute?.('scan');this.onRender();}
  async start(){
    this.beginCaptureFeedback();
    const requestId=++this.startRequestId;this.recoveringCamera=false;this.cameraStarting=true;this.stopLoop();if(this.phase==='setup'&&!this.hasScans)this.camera.resetSnapshotStrategy?.();this.consensus.reset();this.failureStreak=0;this.forceSnapshot=false;this.snapshotInFlight=false;this.scanState='LIVE';this.buildLocalCatalog();this.loadCatalogIndex();this.exitOpen=false;this.manualOpen=false;this.settingsOpen=false;this.hiddenSuspended=false;this.phase='scanning';this.cameraError='';this.status='Avvio fotocamera…';this.onRoute?.('scan');this.onRender();const video=document.querySelector('#fast-scan-video');this.debugTrace('camera:start-controller',{requestId});
    const preparingOcr=this.prepareProductionOcr();
    try{const devices=await this.camera.start(video,this.camera.deviceId);if(requestId!==this.startRequestId||this.phase!=='scanning'||document.hidden)return;this.devices=devices;this.cameraStarting=false;this.refreshControls();this.setStatus('Preparazione OCR…');await preparingOcr;if(requestId!==this.startRequestId||this.phase!=='scanning')return;if(this.paddleState==='unavailable'){this.setStatus('OCR non disponibile · usa Manuale');return;}this.setStatus('Pronto allo scatto');this.schedule(250);}catch(error){if(requestId!==this.startRequestId)return;this.cameraStarting=false;this.camera.stop('start-failed');if(this.phase!=='scanning')return;this.scanState='CAMERA_ERROR';this.cameraError=error.message||'Fotocamera non disponibile';this.status='Riavvia fotocamera';this.debugTrace('camera:start-failed',{requestId,error:this.cameraError});this.onRender();setTimeout(()=>this.showRestartControl(),0);}
  }
  async prepareProductionOcr(){
    if(this.paddleState==='paddle')return;if(this.primaryOcrPreparing)return this.primaryOcrPreparing;this.paddleState='preparing';this.paddleError='';this.primaryOcrPreparing=(async()=>{try{await this.paddleOcr.prepare();this.paddleState='paddle';}catch(error){this.paddleState='unavailable';this.paddleError=error?.message||String(error);}})();try{await this.primaryOcrPreparing;}finally{this.primaryOcrPreparing=null;}}
  async recognizeProduction(canvas,{isFallback=false}={}){
    if(this.paddleState!=='paddle')await this.prepareProductionOcr();
    if(this.paddleState==='paddle'){const started=performance.now();const result=await this.paddleOcr.recognize(canvas,{isFallback});if(this.cycleTelemetry)this.cycleTelemetry.executionMode=this.paddleOcr.executionMode;this.debugTrace('ocr:timing',{durationMs:Math.round(performance.now()-started),width:canvas.width,height:canvas.height,confidence:result.confidence,metrics:result.metrics,runtime:result.runtime,worker:result.worker,executionMode:this.paddleOcr.executionMode});return {...result,engine:'paddle'};}
    throw new Error(this.paddleError||'Motore OCR non disponibile');
  }
  async disposeProductionOcr(){await this.paddleOcr.dispose?.();if(this.primaryOcrPreparing)await this.primaryOcrPreparing.catch(()=>{});this.paddleState='idle';this.paddleError='';}
  async handleVisibilityChange(){
    // Stopping just the scan loop used to leave the actual camera MediaStream
    // running the whole time the app sat backgrounded (screen off, app
    // switched away) — the sensor/ISP never released, which is what was
    // heating phones up during long scan sessions. A brief interruption
    // (permission dialog, quick app switch) should still resume instantly
    // though, so only release the stream once the background has lasted long
    // enough that it's clearly not coming right back.
    if(document.hidden){
      if(this.phase==='scanning'){
        this.interruptCapture();this.hiddenSuspended=true;this.startRequestId+=1;if(this.cameraStarting||this.recoveringCamera){this.camera.stop('suspend-startup');this.backgroundCameraStopped=true;}this.cameraStarting=false;this.recoveringCamera=false;this.stopLoop();this.scanState='BACKGROUND';this.debugTrace('visibility:hidden',this.camera.stateSnapshot?.()||{});
        clearTimeout(this.backgroundStopTimer);
        this.backgroundStopTimer=setTimeout(()=>{if(document.hidden&&this.hiddenSuspended){this.backgroundCameraStopped=true;this.camera.stop('background-timeout');}},4000);
      }
      return;
    }
    clearTimeout(this.backgroundStopTimer);
    if(!this.hiddenSuspended||this.phase!=='scanning')return;this.hiddenSuspended=false;this.debugTrace('visibility:visible',this.camera.stateSnapshot?.()||{});
    if(this.backgroundCameraStopped){this.backgroundCameraStopped=false;await this.recoverCamera('visibility:restore');return;}
    const requestId=this.startRequestId;try{await boundedLookup(this.camera.video?.play?.(),2500);}catch{if(requestId===this.startRequestId&&this.phase==='scanning'&&!document.hidden)await this.recoverCamera('resume-play');return;}if(requestId!==this.startRequestId||this.phase!=='scanning'||document.hidden)return;this.camera.resetFrameProgress?.();
    const issue=this.camera.healthIssue?.();if(issue)await this.recoverCamera(`visibility:${issue}`);else{this.scanState='LIVE';this.setStatus('Pronto allo scatto');this.schedule(120);}
  }
  showRestartControl(){const state=document.querySelector('.live-ocr-state');if(state&&!state.querySelector('[data-scan-restart-camera]'))state.insertAdjacentHTML('beforeend','<button type="button" class="btn secondary small" data-scan-restart-camera>Riavvia fotocamera</button>');}
  async recoverCamera(reason='camera-health'){
    if(this.recoveringCamera||this.phase!=='scanning'||document.hidden)return;
    const now=Date.now();this.recoveryAttempts=this.recoveryAttempts.filter(at=>now-at<30000);
    if(reason!=='manual-restart'&&this.recoveryAttempts.length>=3){this.cameraError='La fotocamera si è interrotta più volte';this.scanState='CAMERA_ERROR';this.setStatus('Riavvia fotocamera');this.showRestartControl();return;}
    const requestId=++this.startRequestId,buffer=this.buffer;
    const current=()=>requestId===this.startRequestId&&buffer===this.buffer&&this.phase==='scanning'&&!document.hidden&&!this.hiddenSuspended;
    this.recoveryAttempts.push(now);this.recoveringCamera=true;this.stopLoop();this.scanState='RECOVERING';this.setStatus('Ripristino fotocamera…');
    this.camera.markImageCaptureUnstable?.('recovery:'+reason);
    const video=document.querySelector('#fast-scan-video')||this.camera.video;
    const preparingOcr=this.prepareProductionOcr();
    try{
      const devices=await this.camera.start(video,this.camera.deviceId);if(!current())return;
      this.devices=devices;this.recoveryCount+=1;this.cameraError='';
      await preparingOcr;if(!current())return;
      this.scanState='LIVE';this.setStatus(this.paddleState==='unavailable'?'OCR non disponibile · usa Manuale':'Pronto allo scatto');
      document.querySelector('[data-scan-restart-camera]')?.remove();this.refreshControls();this.schedule(250);
    }catch(error){if(!current())return;this.scanState='CAMERA_ERROR';this.cameraError=error.message||String(reason);this.setStatus('Riavvia fotocamera');this.showRestartControl();}
    finally{if(requestId===this.startRequestId)this.recoveringCamera=false;}
  }
  async requestExit(){if(this.settingsOpen){this.settingsOpen=false;document.querySelector('[data-scan-settings-sheet]')?.classList.add('hidden');}if(!this.hasScans)return this.exitToCollection();this.stopLoop();this.exitOpen=true;document.querySelector('[data-scan-exit-sheet]')?.classList.remove('hidden');}
  cancelExit(){this.exitOpen=false;document.querySelector('[data-scan-exit-sheet]')?.classList.add('hidden');if(this.phase==='scanning'&&this.camera.stream)this.schedule(120);}
  toggleManual(open){if(!open)this.editScanId=null;this.manualOpen=open;document.querySelector('[data-scan-manual-sheet]')?.classList.toggle('hidden',!open);if(open)this.stopLoop();else if(this.phase==='scanning'&&this.camera.stream)this.schedule(120);if(open)setTimeout(()=>document.querySelector('#scan-manual-code')?.focus(),0);}
  async openReview(){this.interruptCapture();this.reviewSheetKey=null;this.startRequestId+=1;this.recoveringCamera=false;this.cameraStarting=false;this.exitOpen=false;this.manualOpen=false;this.settingsOpen=false;this.stopLoop();clearTimeout(this.backgroundStopTimer);this.backgroundCameraStopped=false;this.camera.stop('open-review');this.phase='review';await this.persist(true);this.onRoute?.('review');this.onRender();}
  async exitToCollection(){await this.leave();this.phase='setup';this.onRoute?.('collection');}
  async discardAndExit(){await this.discard(false);await this.exitToCollection();}
  async leave(){
    this.interruptCapture();this.startRequestId+=1;this.recoveringCamera=false;this.cameraStarting=false;this.stopLoop();clearTimeout(this.feedbackTimer);clearTimeout(this.persistTimer);clearTimeout(this.backgroundStopTimer);this.backgroundCameraStopped=false;this.camera.stop('leave-route');
    // Keep the OCR engine warm across a plain nav back to the Collection —
    // reloading its ONNX models from the CDN on every re-entry into Fast Scan
    // was the main source of perceived slowness. Only save()/discard() free it.
    if(this.hasScans)await saveScanSession({...this.buffer.snapshot(),sync:this.sync});
  }
  schedule(delay=120){this.stopLoop();this.timer=setTimeout(()=>void this.scanOnce(),delay);} stopLoop(){clearTimeout(this.timer);this.timer=0;}
  buildLocalCatalog(){
    this.localCatalog.clear();this.missCache.clear();const collection=this.getCollection?.()||{mine:[],team:[]},buffered=[...(this.buffer.entries?.values?.()||[])];
    for(const raw of [...(collection.mine||[]),...(collection.team||[]),...buffered]){const item=mapPrinting(raw),code=String(item.setCode||'').toUpperCase();if(!code)continue;this.localCatalog.set(code,dedupe([...(this.localCatalog.get(code)||[]),item]));}
  }
  // Fast Scan Step B: indice locale dell'intero catalogo (non solo ciò che
  // possediamo), caricato dalla cache IndexedDB e poi aggiornato in
  // background, pubblicando solo snapshot completi — non blocca l'avvio. A
  // differenza di collection-cache è genuinamente completo (tutto il
  // catalogo del gioco, non solo le stampe possedute), quindi un hit unico
  // può essere trattato come session-cache in resolveFast()/lookupDetailed().
  loadCatalogIndex(){
    if(!this.api?.listCatalogPrintingsIndex)return;
    const game=this.buffer.settings.game||'yugioh',requestId=this.startRequestId;
    this.catalogIndex.clear();this.cacheState='LOADING';
    // Strumentazione (?debugScan=1): `complete` è già calcolato da
    // syncCatalogIndex/syncSnapshot (fast-scan-catalog-cache.js) — ogni
    // publish osservato oggi arriva già completo (mai una pagina parziale,
    // per contratto del modulo), quindi PARTIAL/STALE non sono
    // attualmente raggiungibili da qui: nessuno stato inventato.
    void syncCatalogIndex(this.api,game,{onRows:(rows,complete)=>{if(this.startRequestId===requestId){this.catalogIndex.clear();this.mergeCatalogIndexRows(rows);this.cacheState=complete?'READY':'PARTIAL';}}}).catch(()=>{if(this.startRequestId===requestId)this.cacheState='STALE';});
  }
  mergeCatalogIndexRows(rows){
    for(const row of rows||[]){const item=mapPrinting(row),code=String(item.setCode||'').toUpperCase();if(!code)continue;this.catalogIndex.set(code,dedupe([...(this.catalogIndex.get(code)||[]),item]));}
  }
  recentlyMissed(code){const at=this.missCache.get(code);return Boolean(at)&&Date.now()-at<MISS_CACHE_TTL;}
  lookupMemory(code){const key=String(code||'').toUpperCase(),session=this.resolutionCache.get(key)||[],indexed=this.catalogIndex.get(key)||[];if(session.length||indexed.length)return {matches:dedupe([...indexed,...session]),source:session.length?'session-cache':'catalog-index'};const local=this.localCatalog.get(key)||[];return local.length?{matches:local,source:'collection-cache'}:{matches:[],source:''};}
  cacheResolution(code,matches){const clean=dedupe(matches||[]);if(clean.length)this.resolutionCache.set(String(code).toUpperCase(),clean);return clean;}
  async lookupDetailed(code,{allowRpc=true,allowExternal=true}={}){
    const key=String(code||'').toUpperCase(),memory=this.lookupMemory(key);
    // Solo il session-cache (un RPC/lookup esterno GIÀ fatto in questa
    // sessione) è genuinamente completo e può evitare la query di rete —
    // vedi il commento gemello in resolveFast(). Il collection-cache
    // (cosa possediamo già) resta comunque disponibile come fallback più
    // sotto se si è offline o se RPC/esterno non trovano nulla.
    if(memory.source==='session-cache'||memory.source==='catalog-index')return memory;
    // A full (RPC+external) miss is remembered briefly so re-scanning the same
    // still-uncatalogued code doesn't redo the whole slow lookup cascade.
    const fullAttempt=allowRpc&&allowExternal,missedAt=fullAttempt?this.missCache.get(key):0;
    if(missedAt&&Date.now()-missedAt<MISS_CACHE_TTL)return memory.matches.length?memory:{matches:[],source:'recent-miss'};
    if(this.isOnline?.()===false)return memory.matches.length?memory:{matches:[],source:'offline'};
    const telemetry=this.cycleTelemetry;
    let lookupSucceeded=false,lookupFailed=false;
    if(allowRpc&&this.api?.lookupPrintings){const started=telemetry&&now();try{const rows=await boundedLookup(this.api.lookupPrintings(key,this.buffer.settings.game),this.lookupTimeoutMs);lookupSucceeded=true;if(telemetry)telemetry.externalLookupMs+=now()-started;const matches=this.cacheResolution(key,(rows||[]).map(mapPrinting));if(matches.length)return {matches,source:'rpc'};}catch(error){lookupFailed=true;if(telemetry)telemetry.externalLookupMs+=now()-started;if(error?.code==='LOOKUP_TIMEOUT')throw error;}}
    if(allowExternal&&this.externalLookup){const started=telemetry&&now();try{const matches=this.cacheResolution(key,await boundedLookup(this.externalLookup(key,this.buffer.settings.game),this.lookupTimeoutMs));lookupSucceeded=true;if(telemetry)telemetry.externalLookupMs+=now()-started;if(matches.length)return {matches,source:'external'};}catch(error){lookupFailed=true;if(telemetry)telemetry.externalLookupMs+=now()-started;if(error?.code==='LOOKUP_TIMEOUT')throw error;}}
    if(fullAttempt&&lookupSucceeded&&!lookupFailed)this.missCache.set(key,Date.now());
    return memory.matches.length?memory:{matches:[],source:lookupSucceeded&&!lookupFailed?'not-found':'lookup-unavailable'};
  }
  async lookup(code,options){return (await this.lookupDetailed(code,options)).matches;}
  detectionContent(value){
    if(!value)return '';
    const mark=value.tone==='error'?'✕':value.tone==='pending'?'…':value.tone==='warn'?'!':'✓';
    if(value.card){
      const card=value.card,meta=[card.setCode,card.rarity].filter(Boolean).join(' · ');
      return `${cardImage(card)?`<img src="${esc(cardImage(card,{small:true}))}" alt="">`:''}<i class="fsx-mark" aria-hidden="true">${mark}</i><div><strong>${esc(value.detail)}</strong><span>${esc(card.cardName||value.code)}</span>${meta?`<small>${esc(meta)}</small>`:''}</div>${card.quantity>1?`<b class="scan-detection-qty">×${card.quantity}</b>`:''}`;
    }
    return `<i class="fsx-mark" aria-hidden="true">${mark}</i><div><strong>${esc(value.code)}</strong><span>${esc(value.detail)}</span></div>`;
  }
  renderDetection(){
    for(const [selector,value] of [['[data-scan-detection]',this.detection],['[data-scan-background-result]',this.backgroundNotice]]){
      const node=document.querySelector(selector);if(!node)continue;
      const content=this.detectionContent(value);if(node.innerHTML!==content)node.innerHTML=content;
      node.classList.remove('ok','pending','warn','error','show');if(value)node.classList.add('show',value.tone);
    }
    this.applyHudState();
  }
  showDetection(code,detail,tone='ok',card=null){
    clearTimeout(this.feedbackTimer);this.feedbackTimer=0;
    const entry=this.detection={code,detail,tone,card};this.renderDetection();this.playBurst(tone==='ok'&&card?'ok':tone==='error'?'error':null);
    // Pop transitorio: sparisce da solo, non lascia mai una traccia persistente
    // che l'utente debba chiudere a mano — lo scatto successivo non aspetta.
    this.feedbackTimer=setTimeout(()=>{if(this.detection===entry){this.detection=null;this.renderDetection();}},card?2600:2200);
  }
  beginCaptureFeedback(){this.feedbackCaptureId=(this.feedbackCaptureId||0)+1;this.detection=null;this.backgroundNotice=null;clearTimeout(this.feedbackTimer);this.renderDetection();}
  showResolvedFeedback(code,detail,tone,captureId,sequence,card=null){
    if(this.phase!=='scanning')return;
    if(captureId===(this.feedbackCaptureId||0)){if(tone!=='ok')this.feedback(tone);this.showDetection(code,detail,tone,card);this.setStatus(tone==='ok'?'Aggiunta alla sessione':'Da verificare: tieni questa carta');}
    else{this.backgroundNotice={code,detail:`Scatto precedente #${sequence||'?'} · ${detail}`,tone};this.renderDetection();}
  }
  chooseReview(id,index){
    if(!this.canEditSession())return;const item=this.buffer.review.find(entry=>entry.id===id),match=item?.matches?.[index];if(!match)return;
    if(match.requiresCatalogRepair||match.invalidPhysicalRarity||!sanitizeYugiohRarity(match.rarity)){
      this.buffer.updateScan(id,{classification:'REQUIRES_CATALOG_REPAIR',failureReason:'REQUIRES_CATALOG_REPAIR'});
      item.warning='Questa stampa richiede una correzione del catalogo prima del salvataggio';
      this.onToast?.(item.warning);this.persist();this.refreshHud();if(this.phase==='review')this.onRender();return;
    }
    this.invalidateSync();this.buffer.correctScan(id,match);this.persist();this.refreshHud();if(this.phase==='review')this.onRender();
  }
  async correctReview(id,code){
    if(!this.canEditSession())return;const normalized=normalizeSetCode(code);if(!normalized.valid){this.onToast?.('Formato printing code non valido');return;}
    const buffer=this.buffer,event=buffer.getScan(id),version=buffer.invalidateScan(id);if(!event||version===null)return;
    this.invalidateSync();buffer.updateScan(id,{status:'PROCESSING',rawCode:code,normalizedCode:normalized.code,reviewData:{id,code:normalized.code,matches:[],pending:true,warning:'Correzione in corso'}});this.persist();this.refreshHud();
    try{
      const result=await this.resolve(code,100,{manual:true});if(this.buffer!==buffer||!buffer.isCurrent(id,version))return;
      if(result.matches.length===1){buffer.confirmScan(id,result.matches[0],'manual','Correzione manuale',version);this.editScanId=null;this.toggleManual(false);}
      else buffer.queueReview({id,raw:code,code:normalized.code,matches:result.matches,status:'needs_review',warning:'Printing non trovata o ancora ambigua'});
    }catch(error){if(this.buffer!==buffer||!buffer.isCurrent(id,version))return;buffer.updateReview(id,{pending:false,warning:'Verifica non disponibile: riprova'});this.onToast?.(error.message);}
    this.persist();this.refreshHud();if(this.phase==='review')this.onRender();
  }
  async save(){
    if(this.buffer.review.some(item=>item.pending)||this.buffer.scanEvents.some(scan=>['CAPTURED','PROCESSING','PENDING_REMOTE'].includes(scan.status))){this.onToast?.('Attendi le verifiche in corso prima di salvare');return;}
    if(this.saving||!this.buffer.entries.size||!this.isOnline())return;
    this.saving=true;this.onRender();let stage='canonicalization';
    const entries=[...this.buffer.entries.values()];
    this.debugTrace('save:buffer',{entries:entries.map(saveDiagnosticEntry),reviews:this.buffer.review.length,totalQuantity:this.buffer.total});
    try{
      const prepared=await canonicalizeFastScanEntries(entries,(code,game)=>this.api.lookupPrintings(code,game),async()=>null,base=>confirmPrintingFromCatalogSource(base));
      // Nome + motivo (prima solo il nome: impossibile capire cosa correggere).
      const rejectedNames=prepared.rejected.map(row=>{const name=row.entry.cardName||row.entry.setCode||'carta sconosciuta',message=String(row.message||'').trim();return message?`${name} (${message.startsWith(name)?message.slice(name.length).replace(/^[:\s]+/,''):message})`:name;});
      this.debugTrace('save:canonicalized',{repaired:prepared.repaired,decisions:prepared.decisions,entries:prepared.items.map(saveDiagnosticEntry),rejected:prepared.rejected.map(row=>({...saveDiagnosticEntry(row.entry),code:row.code,message:row.message}))});
      if(!prepared.items.length){
        // Ogni entry è stata isolata: nessuna RPC, sessione locale intatta,
        // l'utente sa esattamente quali carte correggere prima di riprovare.
        this.onToast?.(`Nessuna carta salvabile: da correggere · ${rejectedNames.join(', ')}`);
        return;
      }
      stage='rpc';const rpcPayload=prepared.items;this.sync=prepareFastScanSync(rpcPayload,this.sync);await this.persist(true);this.debugTrace('save:rpc-request',{batchId:this.sync.batchId,chunks:this.sync.chunks.length,rpcPayload});
      let repairAttempts=0;
      for(const index of pendingChunkIndexes(this.sync)){
        let chunk=this.sync.chunks[index];this.sync=markChunk(this.sync,index,'syncing');await this.persist(true);this.onRender();
        try{
          const saveChunk=items=>this.api.saveFastScanChunk
            ?this.api.saveFastScanChunk(this.sync.batchId,chunk.chunkId,this.sync.payloadHash,chunk.payloadHash,this.sync.chunks.length,items)
            :this.api.saveCollectionBatch(items);
          const saved=await saveFastScanBatchWithRepair(chunk.items,saveChunk,async(problemItems,setCode)=>{this.debugTrace('save:repair-request',{setCode,entries:problemItems.map(saveDiagnosticEntry)});return canonicalizeFastScanEntries(problemItems,(code,game)=>this.api.lookupPrintings(code,game),resolveStoredCard);});
          repairAttempts+=saved.repairAttempts;this.sync=markChunk(this.sync,index,'synced',saved.rpcResult);await this.persist(true);this.debugTrace('save:chunk-ack',{batchId:this.sync.batchId,chunkId:chunk.chunkId,rpcResult:saved.rpcResult});
        }catch(error){this.sync=markChunk(this.sync,index,'error',null,error?.message||String(error));await this.persist(true);throw error;}
      }
      const rpcResult={batchId:this.sync.batchId,chunks:this.sync.chunks.map(chunk=>chunk.result)};this.debugTrace('save:rpc-result',{saveAccepted:true,rpcResult,repairAttempts});
      // Rimuove dal buffer SOLO le entry effettivamente salvate — updateQuantity(key,0)
      // annulla i loro scan CONFIRMED senza toccare quelli isolati in `rejected`,
      // che restano visibili e correggibili nella sessione locale.
      stage='acknowledged';clearTimeout(this.persistTimer);
      const rejectedKeys=new Set(prepared.rejected.map(row=>row.entry.key));
      for(const entry of entries)if(!rejectedKeys.has(entry.key))this.buffer.updateQuantity(entry.key,0);
      this.sync=null;await this.persist(true);
      const fullySaved=!prepared.rejected.length&&!this.buffer.entries.size&&!this.buffer.review.length;
      if(fullySaved){
        this.currentScanId=null;this.pendingCaptureId=null;await this.disposeProductionOcr();this.buffer.clear();this.hasRecovery=false;await clearScanSession();
        // La ricarica della Raccolta (tutta, tua e del team) non blocca più la fine
        // del salvataggio: si va subito alla Raccolta e l'elenco si aggiorna da solo.
        stage='refresh';void Promise.resolve().then(()=>this.onSaved?.()).then(()=>this.debugTrace('save:refresh',{saveAccepted:true}),error=>{this.debugTrace('save:refresh-failed',{saveAccepted:true,error:error?.message||String(error)});this.onToast?.('Raccolta salvata. Aggiornamento elenco rimandato.');});
        this.phase='setup';const repaired=prepared.repaired+repairAttempts;this.onToast?.(repaired?`Sessione salvata · ${repaired} identità canoniche aggiornate`:'Sessione salvata nella Raccolta');this.onRoute?.('collection');
      }else{
        stage='refresh';void Promise.resolve().then(()=>this.onSaved?.()).catch(()=>{});
        this.hasRecovery=true;
        this.onToast?.(`${rpcPayload.length} carte salvate · ${rejectedNames.length} da correggere: ${rejectedNames.join(', ')}`);
      }
    }catch(error){const reason=saveRejectionReason(error,stage);this.debugTrace('save:rejected',{saveAccepted:false,saveRejected:true,saveRejectionReason:reason,stage,error:error?.message||String(error),details:error?.details||null});this.onToast?.('Sincronizzazione interrotta. I tuoi scan sono salvati sul dispositivo.');}
    finally{this.saving=false;this.onRender();}
  }
  async discard(render=true){this.currentScanId=null;this.pendingCaptureId=null;clearTimeout(this.persistTimer);this.beginCaptureFeedback();this.startRequestId+=1;this.stopLoop();clearTimeout(this.backgroundStopTimer);this.backgroundCameraStopped=false;this.camera.stop('discard-session');this.buffer=new ScanSessionBuffer();this.sync=null;this.hasRecovery=false;this.exitOpen=false;this.manualOpen=false;this.settingsOpen=false;this.recoveringCamera=false;this.cameraStarting=false;this.phase='setup';await this.disposeProductionOcr();await clearScanSession();if(render)this.onRender();}
  async switchCamera(){if(this.devices.length<2)return;const index=this.devices.findIndex(item=>item.deviceId===this.camera.deviceId);const next=this.devices[(index+1)%this.devices.length];this.camera.deviceId=next.deviceId;await this.start();}
  persist(now=false){clearTimeout(this.persistTimer);const save=()=>saveScanSession({...this.buffer.snapshot(),sync:this.sync});if(now)return save();this.persistTimer=setTimeout(()=>void save().catch(()=>{}),180);}
  // Riscontro distinto per esito (vibrazione + suono), riconoscibile senza guardare lo schermo.
  feedback(tone='ok'){const pattern={ok:35,warn:[30,70,30],error:[110]}[tone]||35;if(this.buffer.settings.vibration)navigator.vibrate?.(pattern);if(this.buffer.settings.sound)beep(tone);}
  invalidateSync(){if(!this.sync?.chunks?.some(chunk=>chunk.status==='synced'))this.sync=null;}
  canEditSession(){if(this.saving){this.onToast?.('Attendi il salvataggio della sessione');return false;}const locked=this.sync?.chunks?.some(chunk=>chunk.status==='synced');if(locked)this.onToast?.('Sincronizzazione parziale: completa prima i blocchi mancanti.');return !locked;}
  exportSummary(){const payload={exportedAt:new Date().toISOString(),session:this.buffer.snapshot(),sync:this.sync};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`fpt-fast-scan-${this.sync?.batchId||Date.now()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),0);}
  setStatus(next){if(!next||next===this.status)return;this.status=next;this.refreshHud();}
  refreshHud(){this.refreshScanPanels();const root=document,write=(node,value)=>{const text=String(value);if(node&&node.textContent!==text)node.textContent=text;};root.querySelectorAll('[data-scan-total-number]').forEach(el=>write(el,this.buffer.total));root.querySelectorAll('[data-scan-total-label]').forEach(el=>write(el,this.buffer.total===1?'carta':'carte'));write(root.querySelector('[data-scan-status]'),this.status);const thumbs=root.querySelector('[data-scan-tray-thumbs]'),html=this.trayThumbs();if(thumbs&&thumbs.innerHTML!==html)thumbs.innerHTML=html;const undo=root.querySelector('[data-scan-undo]');if(undo)undo.disabled=!this.hasUndoableScan();this.applyHudState();}
  async snapshotFeedback(){this.scanState='CAPTURING';this.setStatus('Acquisito');const roi=document.querySelector('.live-roi');roi?.classList.add('captured');await delay(180);roi?.classList.remove('captured');}
  async scanOnce(){
    if(this.scanCycleInFlight)return;this.scanCycleInFlight=true;
    try{return await this.performScanOnce();}
    finally{this.scanCycleInFlight=false;if(this.forceSnapshot&&this.phase==='scanning'&&this.camera.stream&&!document.hidden&&!this.hiddenSuspended&&!this.exitOpen&&!this.manualOpen&&!this.settingsOpen)this.schedule(0);}
  }
  async performScanOnce(){
    const captureSession=this.buffer,captureRequest=this.startRequestId;
    if(this.phase!=='scanning'||document.hidden||this.hiddenSuspended||this.exitOpen||this.manualOpen||this.settingsOpen||!this.camera.stream)return;
    // Keep a manual request pending until a real snapshot starts. Recovery,
    // autofocus and a temporarily unavailable frame must not eat the click.
    const forced=this.forceSnapshot;
    const initialIssue=this.camera.healthIssue?.();if(initialIssue){await this.recoverCamera(initialIssue);return;}
    if(this.camera.refocusing){this.setStatus('Messa a fuoco…');this.schedule(90);return;}
    const sampleStart=now();const roi=document.querySelector('.live-roi'),frame=this.camera.sample(roi);const sampleMs=now()-sampleStart;
    const sampledIssue=this.camera.healthIssue?.();if(sampledIssue){await this.recoverCamera(sampledIssue);return;}if(!frame){this.setStatus('Attendo la fotocamera…');this.schedule(250);return;}
    if(!forced){this.scanState='LIVE';this.schedule(250);return;}
    this.forceSnapshot=false;
    const scan=this.buffer.getScan(this.pendingCaptureId)||this.buffer.createScan();this.pendingCaptureId=null;this.activeCaptureId=scan.id;this.currentScanId=scan.id;
    this.buffer.updateScan(scan.id,{status:'PROCESSING'});
    this.beginCaptureFeedback();
    this.scanState='STABLE';
    this.lastCycleDecision=null;
    // Telemetria locale (mai inviata a Supabase): attiva solo con ?debugScan=1,
    // costo nullo altrimenti perché ogni punto di misura è un `if(telemetry)`
    // su un riferimento null. Vedi ScanTelemetry più sopra per la finestra
    // statistica di sessione mostrata nel pannello debug.
    const telemetry=this.debugMode?{cycleStart:this.captureRequestedAt||now(),sampleMs,snapshotMs:0,primaryPreprocessMs:0,primaryOcrMs:0,primaryResolveMs:0,fallbackPreprocessMs:0,fallbackOcrMs:0,fallbackResolveMs:0,externalLookupMs:0,parseMs:0,commitMs:0,fallbackUsed:false,duplicate:false,executionMode:this.paddleOcr?.executionMode||'',cacheState:this.cacheState,esito:'NOT_FOUND'}:null;
    this.cycleTelemetry=telemetry;
    this.snapshotInFlight=true;this.updateCaptureUi(true);let snapshot=null;try{
      await this.persist(true);
      if(captureSession!==this.buffer||captureRequest!==this.startRequestId)return;
      this.setStatus('Scatto foto…');this.scanState='CAPTURING';const snapshotStart=now();
      await this.camera.waitForFreshFrame?.();
      if(captureSession!==this.buffer||captureRequest!==this.startRequestId)return;
      snapshot=await this.camera.captureSnapshot(roi,{preferVideoFrame:true,includeRaw:true});
      // The guide is drawn over the video preview, so its exact pixels are the
      // authoritative crop. ImageCapture is only a fallback when no preview
      // frame is available because some mobile cameras return shifted frames.
      if(!snapshot)snapshot=await this.camera.captureSnapshot(roi,{preferVideoFrame:false,includeRaw:true});
      if(telemetry)telemetry.snapshotMs=now()-snapshotStart;
      if(captureSession!==this.buffer||captureRequest!==this.startRequestId)return;
      if(!snapshot||this.phase!=='scanning'||this.exitOpen||this.manualOpen||this.settingsOpen){if(!snapshot)await this.recordFailure();return;}
      this.lastPreprocessing=snapshot.preprocessing;void this.snapshotFeedback();if(this.phase!=='scanning'||this.exitOpen||this.manualOpen||this.settingsOpen)return;
      const possiblyBlurred=(snapshot.preprocessing?.sharpness||0)<3;
      this.scanState='ANALYZING';this.setStatus('Analizzo codice…');this.ocrStatusShown=false;
      const planStart=now();const plan=createOcrInputPlan(snapshot);if(telemetry)telemetry.primaryPreprocessMs=now()-planStart;
      const productionReadings=[];try{
        this.renderDebugCrop(plan.primary.canvas,snapshot.mapping,'grayscale');
        const primaryOcrStart=now();const primary={...await this.recognizeProduction(plan.primary.canvas),preprocessing:plan.primary.preprocessing};if(telemetry)telemetry.primaryOcrMs=now()-primaryOcrStart;
        if(captureSession!==this.buffer||captureRequest!==this.startRequestId)return;
        const parseStart=now();const primaryCode=normalizeSetCode(primary.text);if(telemetry)telemetry.parseMs+=now()-parseStart;productionReadings.push(primary);let outcome=null;
        if(primaryCode.valid&&primary.confidence>=STRONG_OCR_CONFIDENCE){
          this.debugStartedAt=typeof performance!=='undefined'?performance.now():Date.now();
          const resolveStart=now();outcome=await this.resolveCapturedReading(primary,{scanId:scan.id});if(telemetry)telemetry.primaryResolveMs=now()-resolveStart;
          if(telemetry&&outcome?.status==='duplicate_blocked')telemetry.duplicate=true;
          this.lastCycleDecision=outcome.decision||null;
        }
        if(!outcome){
          if(telemetry)telemetry.fallbackUsed=true;
          this.setStatus('Verifico lettura OCR…');
          const fallbackPlanStart=now();const fallbackPlan=plan.buildFallback();if(telemetry)telemetry.fallbackPreprocessMs=now()-fallbackPlanStart;
          this.renderDebugCrop(fallbackPlan.canvas,snapshot.mapping,'adaptive');
          const fallbackOcrStart=now();const fallback={...await this.recognizeProduction(fallbackPlan.canvas,{isFallback:true}),preprocessing:fallbackPlan.preprocessing};if(telemetry)telemetry.fallbackOcrMs=now()-fallbackOcrStart;
          if(captureSession!==this.buffer||captureRequest!==this.startRequestId)return;
          productionReadings.push(fallback);
          const result=selectSnapshotOcrResult(productionReadings);
          this.lastPreprocessing=result?.preprocessing||snapshot.preprocessing;
          if(result?.text){const parseStart2=now();const conflicting=productionReadings.some(reading=>normalizeSetCode(reading.text).valid&&normalizeSetCode(reading.text).code!==normalizeSetCode(result.text).code);if(telemetry)telemetry.parseMs+=now()-parseStart2;outcome=await this.resolveCapturedReading(result,{scanId:scan.id,requireReview:conflicting||result.confidence<STRONG_OCR_CONFIDENCE});if(telemetry&&outcome?.status==='duplicate_blocked')telemetry.duplicate=true;this.lastCycleDecision=outcome?.decision||null;}
          else await this.recordFailure();
        }
        if(forced&&(!outcome||outcome.status==='not_found')){const read=ocrReadingSummary(productionReadings);this.setStatus(read?`OCR ha letto: ${read}${possiblyBlurred?' · foto poco nitida':''}`:`OCR non ha rilevato testo${possiblyBlurred?' · foto poco nitida':''}`);}
        if(telemetry)telemetry.esito=esitoFromOutcome(outcome);
      }finally{plan.release();}
    }catch(error){if(captureSession!==this.buffer||captureRequest!==this.startRequestId)return;if(!error.scanInReview)this.buffer.failScan(scan.id,'OCR_FAILED');this.persist();this.refreshHud();if(!error.scanInReview)this.showDetection('Scatto non completato','Riprova questa carta','error');const issue=this.camera.healthIssue?.();if(issue)await this.recoverCamera(issue);else if(error?.message!=='refocus-in-progress')this.setStatus(error.message||'OCR non disponibile');}
    finally{
      snapshot?.release?.();snapshot=null;if(['CAPTURED','PROCESSING'].includes(captureSession.getScan(scan.id)?.status)){captureSession.failScan(scan.id,'INTERRUPTED');if(captureSession===this.buffer)this.persist();}if(this.activeCaptureId===scan.id)this.activeCaptureId=null;this.snapshotInFlight=false;this.updateCaptureUi(false);
      if(captureRequest===this.startRequestId&&captureSession===this.buffer&&this.phase==='scanning'&&!document.hidden&&!this.hiddenSuspended&&!this.exitOpen&&!this.manualOpen&&!this.settingsOpen){
        this.scanState='LIVE';
        // Un EXACT_UNIQUE netto non ha bisogno dei 250ms decorativi: la
        // fotocamera può tornare pronta per la carta successiva quasi subito.
        // Su esito incerto/review teniamo il margine pieno.
        const nextDelay=this.lastCycleDecision==='EXACT_UNIQUE'?90:250;
        if(telemetry){
          telemetry.cycleTotalMs=now()-telemetry.cycleStart;delete telemetry.cycleStart;
          // readyNextMs/scannerLockedMs: nel loop attuale coincidono — il
          // pulsante di scatto si riabilita esattamente a fine ciclo
          // (snapshotInFlight=false, poche righe sopra), non c'è ancora un
          // percorso disaccoppiato "scatto pronto prima che tutto finisca"
          // (vedi audit OCR 2026-09-16, priorità 1: la rete resta nel
          // percorso bloccante). Se/quando quel percorso verrà disaccoppiato,
          // qui divergeranno — per ora sono lo stesso numero per definizione,
          // non un duplicato accidentale.
          telemetry.readyNextMs=telemetry.cycleTotalMs;telemetry.scannerLockedMs=telemetry.cycleTotalMs;
          telemetry.secondPassUsed=telemetry.fallbackUsed;
          // localMatchMs: la parte di resolve() spesa in memoria/catalogo
          // locale, al netto di externalLookupMs (già misurato a parte,
          // dentro resolve(), sulla stessa finestra temporale — sottrarlo
          // evita di contarlo due volte).
          telemetry.localMatchMs=Math.max(0,telemetry.primaryResolveMs+telemetry.fallbackResolveMs-telemetry.externalLookupMs);
          telemetry.result=telemetry.esito==='NOT_FOUND'?'not_found':(telemetry.esito==='EXACT'||telemetry.esito==='NEAR')?'accepted':'review';
          // totalFinalizeMs: null quando l'esito è PENDING (risoluzione
          // ancora in corso in background, vedi resolvePendingInBackground) —
          // in quel caso il tempo di chiusura reale non è ancora noto a
          // questo punto; ScanTelemetry.recordBackground() lo misura a parte
          // quando la verifica in background completa davvero.
          telemetry.totalFinalizeMs=telemetry.esito==='PENDING'?null:telemetry.cycleTotalMs;
          telemetry.workerTimeoutCount=this.paddleOcr?.workerTimeoutCount||0;telemetry.workerRestartCount=this.paddleOcr?.workerRestartCount||0;
          this.telemetry.record(telemetry);this.debugTrace('telemetry:cycle',telemetry);this.renderDebugStats();
        }
        this.schedule(nextDelay);
      }
      this.cycleTelemetry=null;
    }
  }
  requestSnapshot(){
    if(!this.canEditSession())return;
    if(this.exitOpen||this.manualOpen||this.settingsOpen){this.setStatus('Chiudi la finestra aperta prima dello scatto');return;}
    if(this.phase!=='scanning'||document.hidden||this.hiddenSuspended||!this.camera.stream||this.cameraStarting||this.recoveringCamera){this.setStatus('Fotocamera non pronta · riavvia lo scanner');return;}
    if(this.snapshotInFlight||this.forceSnapshot){this.setStatus('Elaborazione snapshot in corso…');return;}
    if(this.currentScan?.status==='REVIEW_REQUIRED'){this.setStatus('Scegli la carta qui sopra prima di continuare');return;}
    if(this.buffer.scanEvents.filter(scan=>scan.status==='PENDING_REMOTE').length>=3){this.setStatus('Attendi le verifiche in corso (3/3)');return;}
    const scan=this.buffer.createScan();this.currentScanId=scan.id;this.pendingCaptureId=scan.id;this.persist();this.beginCaptureFeedback();this.captureRequestedAt=now();this.forceSnapshot=true;this.stopLoop();this.refreshHud();this.setStatus(this.scanCycleInFlight?'Attendo analisi corrente…':'Scatto manuale…');if(!this.scanCycleInFlight)this.schedule(0);
  }
  // PENDING_REMOTE non blocca più lo scatto successivo (Sezione 2/5: la
  // verifica di rete prosegue in background — già race-safe via captureId/
  // isCurrent — e non deve rallentare scan -> prossima carta). Solo una vera
  // ambiguità (REVIEW_REQUIRED, risolta subito dal chooser inline) o uno
  // scatto fisicamente in corso restano bloccanti.
  updateCaptureUi(busy){const button=document.querySelector('[data-scan-capture]');if(!button)return;const status=this.currentScan?.status,blocked=['REVIEW_REQUIRED','CAPTURED','PROCESSING'].includes(status);button.disabled=Boolean(busy||blocked||this.cameraStarting||this.recoveringCamera);const label=button.querySelector('span');if(label)label.textContent=busy?'Elaborazione…':status==='CONFIRMED'?'Prossima carta':status==='FAILED'?'Riprova questa carta':blocked?'Verifica questa carta':'Scatta e analizza';this.applyHudState();}
  renderDebugCrop(source,mapping={},mode='grayscale'){
    if(!this.debugMode||!source?.width||!source?.height)return;const canvas=document.querySelector('[data-scan-debug-crop]'),label=document.querySelector('[data-scan-debug-geometry]');if(!canvas)return;canvas.width=source.width;canvas.height=source.height;const context=canvas.getContext('2d');context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(source,0,0);const crop=mapping.snapshotCrop||mapping.crop||{};if(label)label.textContent=`${mode} · ${source.width}×${source.height} · source ${crop.sx||0},${crop.sy||0} ${crop.sw||0}×${crop.sh||0}`;
  }
  renderDebugStats(){
    if(!this.debugMode)return;const node=document.querySelector('[data-scan-debug-stats]');if(!node)return;
    const summary=this.telemetry.summary();
    node.textContent=summary?`${summary.count} scan · pronto-al-prossimo p50 ${summary.readyNextP50Ms.toFixed(0)}ms p95 ${summary.readyNextP95Ms.toFixed(0)}ms · OCR p50 ${summary.ocrP50Ms.toFixed(0)}ms · accepted ${Math.round(summary.acceptedRate*100)}% · review ${Math.round(summary.reviewRate*100)}% · not-found ${Math.round(summary.notFoundRate*100)}% · fallback ${Math.round(summary.fallbackRate*100)}% · rete ${Math.round(summary.externalRate*100)}% · ${summary.executionMode||'?'} · cache ${summary.cacheState||'?'} · worker restart ${summary.workerRestartCount} (timeout ${summary.workerTimeoutCount})`:'In attesa di scan misurati';
  }
  // Esporta il riepilogo di sessione (?debugScan=1) per il benchmark manuale
  // su telefono — vedi docs/fast-scan-benchmark-procedure.md. JSON per
  // analisi complete (summary + ogni campione), CSV per un'occhiata rapida
  // in un foglio di calcolo. Mai inviato a Supabase.
  exportTelemetry(format='json'){
    const isCsv=format==='csv';
    const content=isCsv?this.telemetry.toCSV():JSON.stringify(this.telemetry.toJSON(),null,2);
    if(!content)return;
    const blob=new Blob([content],{type:isCsv?'text/csv':'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`fpt-fast-scan-telemetry-${Date.now()}.${isCsv?'csv':'json'}`;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),0);
  }
  async recordFailure(catalogMiss=false){
    if(this.activeCaptureId){this.buffer.failScan(this.activeCaptureId,catalogMiss?'NO_CATALOG_MATCH':'NO_TEXT');this.persist();this.refreshHud();}
    const hint=catalogMiss?'':captureHint(this.lastPreprocessing,this.camera.torchSupported);this.lastPreprocessing=null;
    this.showDetection(catalogMiss?'Codice non confermato':'Codice non letto','Riprova questa carta','error');
    this.consensus.miss();this.gate.miss();this.failureStreak+=1;
    if(this.failureStreak>=4){this.failureStreak=0;const focused=await this.camera.refocus();this.setStatus(focused?'Messa a fuoco…':this.camera.focusSupported?'Tocca per mettere a fuoco':'Avvicina la carta');}
    else this.setStatus(catalogMiss?'Codice non trovato · controlla la review':hint||'Codice non letto · riprova lo scatto');
  }
  async refocus(){const requestId=this.startRequestId,focused=await this.camera.refocus();if(requestId!==this.startRequestId||this.phase!=='scanning'||document.hidden)return;this.setStatus(focused?'Messa a fuoco…':'Avvicina la carta');if(focused)setTimeout(()=>{if(requestId===this.startRequestId&&this.phase==='scanning'&&!document.hidden)this.setStatus('Pronto allo scatto');},650);}
  async resolveCapturedReading(reading,{requireReview=false,scanId=null}={}){
    const normalized=normalizeSetCode(reading.text),buffer=this.buffer;
    const scan=buffer.getScan(scanId)||buffer.createScan();this.currentScanId=scan.id;
    const version=scan.resolutionVersion,captureId=this.feedbackCaptureId||0;
    buffer.updateScan(scan.id,{rawCode:reading.text,normalizedCode:normalized.code,ocrConfidence:reading.confidence});
    if(!normalized.valid){await this.recordFailure();buffer.updateScan(scan.id,{classification:'OCR_INVALID'});buffer.failScan(scan.id,'NO_VALID_CODE');this.debugTrace('catalog:classification',{rawOcr:reading.text,classification:'OCR_INVALID'});this.persist();this.refreshHud();return {status:'not_found',classification:'OCR_INVALID'};}
    const code=normalized.code,memory=this.lookupMemory(code),current=()=>this.buffer===buffer&&buffer.isCurrent(scan.id,version);
    const finish=async(result,pendingId=null)=>{
      if(!current())return;
      if(requireReview&&result.matches?.length)result={...result,status:'needs_review',warning:'Lettura OCR incerta: conferma il codice'};
      await this.commitResolution(result,reading.text,false,pendingId,{scanId:scan.id,version});
      if(!current())return;
      if(pendingId){
        if(scan.status==='CONFIRMED'){const entry=this.buffer.entries.get(scan.printing?.key);this.showResolvedFeedback(code,'Salvata','ok',captureId,scan.sequence,entry?{imageUrl:entry.imageUrl,cardName:entry.cardName,setCode:entry.setCode,rarity:entry.rarity,quantity:entry.quantity}:null);}
        else if(scan.status==='FAILED')this.showResolvedFeedback(code,'Codice non letto — riprova','error',captureId,scan.sequence);
        else this.showResolvedFeedback(code,'Conferma la carta qui sopra','warn',captureId,scan.sequence);
      }
    };
    this.consensus.reset();this.failureStreak=0;
    // reconstructedSeparator (audit OCR 2026-09-17, Finding 1): `code` qui è
    // un'ipotesi su dove andava un trattino che l'OCR non ha letto — anche
    // con un hit di memoria "genuinamente completo" (catalog-index) non deve
    // saltare la review come farebbe una lettura col trattino verificata.
    // Il codice cade nel percorso "in verifica" più sotto, che passa da
    // resolve()/classifyNearPrintingMatch (sempre requiresReview per queste).
    if(!normalized.reconstructedSeparator&&['session-cache','catalog-index'].includes(memory.source)){
      const result={...classifyPrintingMatch({normalized,matches:memory.matches}),code,ocrConfidence:reading.confidence,lookupSource:memory.source};
      await finish(result);return requireReview?{...result,status:'needs_review'}:result;
    }
    const pendingId=scan.id;
    if(buffer.scanEvents.filter(event=>event.status==='PENDING_REMOTE').length>=3){buffer.queueReview({id:scan.id,raw:reading.text,code,matches:[],warning:'Coda piena: correggi o riprova dopo le verifiche'});this.persist();this.refreshHud();return {status:'needs_review',code};}
    buffer.queueReview({id:pendingId,raw:reading.text,code,status:'pending',matches:[],ocrConfidence:reading.confidence,warning:'Carta corrente in verifica…',pending:true});
    try{await this.persist(true);}catch(error){buffer.updateReview(pendingId,{pending:false,status:'needs_review',warning:'Salvataggio locale fallito: verifica questa scansione'});if(this.buffer===buffer)this.showDetection(code,'Apri la review prima di riprovare','error');this.refreshHud();throw Object.assign(error,{scanInReview:true});}
    if(!current())return {status:'cancelled'};
    this.setStatus('Carta corrente in verifica');this.showDetection(code,'Attendi la verifica oppure metti da parte','pending');this.refreshHud();
    const task=async()=>{
      if(!current())return;const startedAt=this.debugMode?now():0;
      try{await finish(await this.resolve(code,reading.confidence,{consensus:1}),pendingId);}
      catch{if(current()){buffer.updateReview(pendingId,{pending:false,status:'needs_review',warning:'Verifica fallita: correggi o riprova il codice'});this.showResolvedFeedback(code,'Da verificare: correggi o metti da parte','warn',captureId,scan.sequence);this.persist();if(this.phase==='review')this.onRender?.();else this.refreshHud();}}
      finally{if(this.debugMode)this.telemetry.recordBackground(now()-startedAt);}
    };
    this.pendingResolution=new Promise(resolve=>{this.backgroundQueue.push(async()=>{try{await task();}finally{resolve();}});this.drainBackgroundQueue();});
    return {status:'pending_async',code};
  }
  async processRecognition(raw,ocrConfidence=0,signature=[],preprocessing={},options={}){
    const telemetry=this.cycleTelemetry;
    this.debugStartedAt=typeof performance!=='undefined'?performance.now():Date.now();
    const evidence=this.consensus.observe(raw,ocrConfidence);
    this.debugTrace('ocr',{raw,ocrConfidence,candidate:evidence.code||'',votes:evidence.votes||0});
    if(!evidence.valid){const near=normalizeSetCode(raw).code;this.debugTrace('resolution:rejected',{rawOcr:raw,normalizedOcr:near,parsedCode:'',candidateCodes:[],catalogMatches:[],accepted:false,rejectionReason:'INVALID_FORMAT'});await this.recordFailure();return {status:'not_found'};}
    if(!evidence.ready&&!evidence.strong){
      if(options.catalogConfirm){
        let started=now();const confirmed=await this.resolve(evidence.code,evidence.confidence,{consensus:evidence.votes});if(telemetry)telemetry.fallbackResolveMs+=now()-started;
        if(confirmed.status!=='not_found'){this.gate.accept(confirmed.code,signature,Date.now());this.consensus.reset();this.failureStreak=0;started=now();await this.commitResolution(confirmed,raw);if(telemetry)telemetry.commitMs+=now()-started;return confirmed;}
        this.consensus.reset();started=now();await this.commitResolution(confirmed,raw,true);if(telemetry)telemetry.commitMs+=now()-started;return confirmed;
      }
      let started=now();const fast=await this.resolveFast(evidence.code,evidence.confidence,{consensus:evidence.votes});if(telemetry)telemetry.fallbackResolveMs+=now()-started;
      if(fast.status==='high_confidence'){if(!this.gate.consider(fast.code,signature)){this.debugTrace('resolution:rejected',{rawOcr:raw,parsedCode:fast.code,accepted:false,rejectionReason:'DUPLICATE_DEBOUNCE'});return {status:'duplicate_blocked'};}this.consensus.reset();this.failureStreak=0;started=now();await this.commitResolution(fast,raw);if(telemetry)telemetry.commitMs+=now()-started;return fast;}
      this.setStatus(`Conferma lettura ${evidence.votes}/2`);return {status:'pending_consensus',code:evidence.code};
    }
    // Fast Scan Step B (P1.5): un codice valido ma assente da ogni fonte
    // locale (session-cache/catalog-index/collection-cache) richiederebbe qui
    // un RPC/resolver esterno bloccante — solo se un lookup di rete è
    // davvero configurato (altrimenti resolve() è già locale e istantaneo,
    // vedi i test con un controller senza api/externalLookup). Per il loop
    // live (non per lo scatto manuale, che l'operatore sta guardando)
    // mettiamo la carta "in verifica" e continuiamo a scansionare — la
    // risoluzione prosegue in background e aggiorna la review quando finisce.
    // recentlyMissed() evita di accodare di nuovo la stessa carta se resta
    // inquadrata dopo un miss già noto.
    if(this.pendingCodes.has(evidence.code)){this.consensus.reset();return {status:'pending_async',code:evidence.code};}
    const hasNetworkLookup=Boolean(this.api?.lookupPrintings||this.externalLookup);
    if(hasNetworkLookup&&!options.catalogConfirm&&!this.recentlyMissed(evidence.code)&&!this.lookupMemory(evidence.code).matches.length){
      const pendingId=crypto.randomUUID(),pendingCode=evidence.code;
      this.pendingCodes.add(pendingCode);
      this.buffer.queueReview({id:pendingId,raw,code:pendingCode,status:'pending',matches:[],ocrConfidence:evidence.confidence,warning:'Verifica in corso…',pending:true});
      this.consensus.reset();this.persist();this.refreshHud();
      // Non-void: nessun chiamante deve aspettarla (è tutto il punto del
      // deferral), ma tenerne un riferimento permette ai test di attenderla
      // deterministicamente invece di indovinare quanti tick servono.
      this.pendingResolution=this.enqueueBackgroundResolution(raw,evidence.confidence,evidence.votes,pendingId,pendingCode);
      return {status:'pending_async',code:pendingCode};
    }
    let started=now();const result=await this.resolve(evidence.code,evidence.confidence,{consensus:evidence.votes});if(telemetry)telemetry.fallbackResolveMs+=now()-started;
    if(result.status==='not_found'){this.consensus.reset();await this.recordFailure(true);return result;}
    if(options.catalogConfirm)this.gate.accept(result.code,signature,Date.now());else if(!this.gate.consider(result.code,signature)){this.debugTrace('resolution:rejected',{rawOcr:raw,parsedCode:result.code,accepted:false,rejectionReason:'DUPLICATE_DEBOUNCE'});return {status:'duplicate_blocked'};}
    this.consensus.reset();this.failureStreak=0;started=now();await this.commitResolution(result,raw);if(telemetry)telemetry.commitMs+=now()-started;return result;
  }
  enqueueBackgroundResolution(raw,ocrConfidence,consensusVotes,pendingId,pendingCode){
    return new Promise(resolve=>{
      const buffer=this.buffer,version=buffer.getScan(pendingId)?.resolutionVersion;this.backgroundQueue.push(async()=>{try{await this.resolvePendingInBackground(raw,ocrConfidence,consensusVotes,pendingId,pendingCode,buffer,version);}finally{resolve();}});
      this.drainBackgroundQueue();
    });
  }
  drainBackgroundQueue(){
    while(this.activeBackgroundResolutions<MAX_BACKGROUND_RESOLUTIONS&&this.backgroundQueue.length){
      const task=this.backgroundQueue.shift();
      this.activeBackgroundResolutions+=1;
      task().finally(()=>{this.activeBackgroundResolutions-=1;this.drainBackgroundQueue();});
    }
  }
  async resolvePendingInBackground(raw,ocrConfidence,consensusVotes,pendingId,pendingCode,buffer=this.buffer,version=buffer.getScan(pendingId)?.resolutionVersion){
    const startedAt=this.debugMode?now():0;
    try{
      if(this.buffer!==buffer||!buffer.isCurrent(pendingId,version))return;const result=await this.resolve(raw,ocrConfidence,{consensus:consensusVotes});
      if(this.buffer!==buffer||!buffer.isCurrent(pendingId,version))return;await this.commitResolution(result,raw,false,pendingId,{scanId:pendingId,version});
    }catch{
      if(this.buffer!==buffer||!buffer.isCurrent(pendingId,version))return;this.buffer.updateReview(pendingId,{status:'not_found',warning:'Verifica fallita · correggi manualmente',pending:false});
      this.persist();if(this.phase==='review')this.onRender?.();else this.refreshHud();
    }
    finally{
      this.pendingCodes.delete(pendingCode);
      // backgroundVerificationMs: misurato a parte dal ciclo di scatto (che
      // è già tornato "pronto per il prossimo scatto" molto prima) — vedi
      // ScanTelemetry.recordBackground(). Solo ?debugScan=1.
      if(this.debugMode)this.telemetry.recordBackground(now()-startedAt);
    }
  }
  async processManual(raw){
    if(!this.canEditSession())return;const normalized=normalizeSetCode(raw);if(!normalized.valid){this.onToast?.('Formato printing code non valido');return;}
    const buffer=this.buffer,scan=buffer.createScan({source:'manual',rawCode:raw,normalizedCode:normalized.code,status:'PROCESSING'}),version=scan.resolutionVersion;this.currentScanId=scan.id;this.persist();
    try{const result=await this.resolve(raw,100,{manual:true,consensus:2});if(this.buffer===buffer&&buffer.isCurrent(scan.id,version))await this.commitResolution(result,raw,true,null,{scanId:scan.id,version});}
    catch(error){if(this.buffer!==buffer||!buffer.isCurrent(scan.id,version))return;buffer.failScan(scan.id,'LOOKUP_FAILED');this.persist();this.refreshHud();this.onToast?.(error.message||'Verifica non disponibile: riprova');}
  }
  async resolveFast(raw,ocrConfidence,{consensus=0,manual=false}={}){
    const candidates=setCodeCandidates(raw),plausibleCandidateCount=Math.max(1,extractSetCodeCandidates(raw).length);if(!candidates.length)return {status:'not_found',code:'',matches:[],ocrConfidence};
    // exact.corrected (audit OCR 2026-09-17, Finding 1): candidates[0] non è
    // sempre una lettura pulita — può essere la ricostruzione di un trattino
    // mai visto dall'OCR (normalizeSetCode/setCodeCandidates la marcano
    // corrected+requiresReview). In quel caso non va trattata come "exact":
    // resta nel pool sottostante (slice(0) invece di slice(1)), soggetta allo
    // stesso gate edits===1/requiresReview di ogni altra correzione.
    const exact=candidates[0],hit=exact.corrected?{matches:[],source:''}:this.lookupMemory(exact.code);
    // Un hit "collection-cache" nasce da cosa il team possiede GIÀ, non dal
    // catalogo completo: se un set code ha più rarità (es. una Common e una
    // Ultra Rare con lo stesso codice) e ne possediamo solo una, qui sembra
    // un match unico ma non lo è davvero — trattarlo come high_confidence
    // committerebbe subito la rarità sbagliata quando si scansiona l'altra.
    // session-cache (un RPC già fatto in questa sessione) e catalog-index
    // (l'indice locale Step B, sincronizzato dall'intero card_printings del
    // gioco) sono invece genuinamente completi e possono essere trattati come
    // definitivi qui; il collection-cache passa dal percorso verificato via
    // RPC in resolve()/lookupDetailed(), che lo tiene comunque come fallback
    // se offline o se la sync dell'indice non è ancora arrivata a quel codice.
    if(hit.matches.length&&(hit.source==='session-cache'||hit.source==='catalog-index')){const classified=classifyPrintingMatch({normalized:normalizeSetCode(exact.code),matches:hit.matches,ocrConfidence,consensus,manual});return {...classified,code:exact.code,ocrConfidence,corrected:false,consensus,lookupSource:hit.source};}
    const corrected=candidates.slice(exact.corrected?0:1).map(candidate=>({candidate,...this.lookupMemory(candidate.code)})).filter(item=>item.matches.length);
    if(!corrected.length)return {status:'not_found',code:exact.code,matches:[],ocrConfidence,consensus,fastMiss:true};const matches=dedupe(corrected.flatMap(item=>item.matches)),code=corrected.length===1?corrected[0].candidate.code:exact.code;
    const classified=classifyNearPrintingMatch(corrected,{plausibleCandidateCount});return {...classified,code:classified.code||code,matches,ocrConfidence,corrected:true,consensus,alternatives:classified.alternatives,lookupSource:corrected[0].source};
  }
  async resolve(raw,ocrConfidence,options={}){
    try{
      const result=await this.resolveCatalog(raw,ocrConfidence,options);
      result.classification=classifyScanDiagnostic({raw,result,ocrConfidence,...options});
      return result;
    }catch(error){
      this.debugTrace('catalog',{rawOcr:raw,classification:classifyScanDiagnostic({raw,error}),accepted:false,rejectionReason:error?.code||'LOOKUP_FAILED'});
      throw error;
    }
  }
  async resolveCatalog(raw,ocrConfidence,{consensus=0,manual=false,exactOnly=false}={}){
    const candidates=setCodeCandidates(raw),plausibleCandidateCount=Math.max(1,extractSetCodeCandidates(raw).length);if(!candidates.length)return {status:'not_found',code:'',matches:[],ocrConfidence};
    const fast=await this.resolveFast(raw,ocrConfidence,{consensus,manual});if(!fast.fastMiss&&!fast.corrected)return fast;
    // exact.corrected: stessa guardia di resolveFast() qui sopra — una
    // ricostruzione di trattino non passa dal percorso "exact" fidato via
    // rete/RPC, resta nel pool corrected qualche riga più sotto (slice(0)).
    const exact=candidates[0],exactLookup=exact.corrected?{matches:[],source:''}:await this.lookupDetailed(exact.code,{allowExternal:!exactOnly});
    if(exactLookup.matches.length){const classified=classifyPrintingMatch({normalized:normalizeSetCode(exact.code),matches:exactLookup.matches,ocrConfidence,consensus,manual});return {...classified,code:exact.code,ocrConfidence,corrected:false,consensus,lookupSource:exactLookup.source};}
    const lookupComplete=['not-found','recent-miss'].includes(exactLookup.source);
    if(exactOnly)return {status:'not_found',code:exact.code,matches:[],ocrConfidence,consensus,lookupComplete}; if(!fast.fastMiss&&fast.corrected)return fast;
    let corrected=(await Promise.all(candidates.slice(exact.corrected?0:1,9).map(async candidate=>({candidate,...await this.lookupDetailed(candidate.code,{allowExternal:false})})))).filter(item=>item.matches.length);
    if(!corrected.length&&this.externalLookup){const external=await Promise.all(candidates.slice(exact.corrected?0:1,5).map(async candidate=>({candidate,...await this.lookupDetailed(candidate.code,{allowRpc:false,allowExternal:true})})));corrected=external.filter(item=>item.matches.length);}
    if(!corrected.length)return {status:'not_found',code:exact.code,matches:[],ocrConfidence,consensus,lookupComplete};
    const matches=dedupe(corrected.flatMap(item=>item.matches)),classified=classifyNearPrintingMatch(corrected,{plausibleCandidateCount}),code=classified.code||(corrected.length===1?corrected[0].candidate.code:exact.code);
    return {...classified,code,matches,ocrConfidence,corrected:true,consensus,alternatives:classified.alternatives,lookupSource:corrected[0].source};
  }
  async commitResolution(result,raw,manual=false,pendingId=null,context={}){
    result.classification = classifyScanDiagnostic({raw,result,ocrConfidence:result.ocrConfidence,consensus:result.consensus,manual});
    this.debugTrace('catalog:classification',{rawOcr:raw,classification:result.classification});
    if(context.scanId&&!this.buffer.isCurrent(context.scanId,context.version))return;
    if(pendingId&&!this.buffer.review.some(item=>item.id===pendingId&&item.pending))return;
    const normalized=normalizeSetCode(raw),candidateCodes=setCodeCandidates(raw).map(item=>item.code),selected=result.matches?.[0]||null,accepted=result.status==='high_confidence'&&(result.decision==='EXACT_UNIQUE'||result.decision==='NEAR_UNIQUE'||manual),rejectionReason=result.status==='not_found'?'NO_CATALOG_MATCH':result.matches?.length>1?'MULTIPLE_CATALOG_MATCHES':accepted?'':result.corrected?'LOW_CONFIDENCE':'VALIDATION_FAILED';
    this.debugTrace('catalog',{rawOcr:raw,normalizedOcr:normalized.code,parsedCode:result.code||normalized.code,candidateCodes,catalogMatches:(result.matches||[]).map(saveDiagnosticEntry),selectedCatalogEntry:selected?saveDiagnosticEntry(selected):null,printingId:selected?.printingId||selected?.printing_id||'',printingKey:selected?[selected.game||'yugioh',selected.catalogCardId||selected.catalog_card_id||'',selected.setCode||selected.set_code||'',selected.rarity||''].join(':'):'',validationResult:result.decision||result.status,accepted,rejected:!accepted,rejectionReason,source:result.lookupSource||'',timingMs:Math.round((typeof performance!=='undefined'?performance.now():Date.now())-(this.debugStartedAt||0)),pending:Boolean(pendingId)});
    const scan=this.buffer.getScan(context.scanId||pendingId)||this.buffer.createScan({source:manual?'manual':'camera'});
    this.buffer.updateScan(scan.id,{rawCode:raw,normalizedCode:result.code||normalized.code,ocrConfidence:result.ocrConfidence||scan.ocrConfidence,classification:result.classification,matchType:result.decision||'',source:result.lookupSource||scan.source});
    const mustAutoAdd=result.decision==='EXACT_UNIQUE'||(result.decision==='NEAR_UNIQUE'&&this.buffer.settings.autoAdd)||manual;
    const added=result.status==='high_confidence'&&mustAutoAdd;
    // Nessun codice/match reale: fallimento pulito, mai un elemento da
    // rivedere — l'utente non deve mai vedere una coda per una lettura
    // spazzatura (Sezione 7). Un vero candidato (1-4) resta invece nella
    // review, risolto SUBITO dal chooser inline di assistantView().
    if(added)this.buffer.confirmScan(scan.id,result.matches[0],result.decision||'high_confidence');
    else if(!result.matches?.length)this.buffer.failScan(scan.id,result.status==='not_found'?'NOT_FOUND':'NO_VALID_MATCH');
    else this.buffer.queueReview({id:scan.id,raw,code:result.code,status:result.status,matches:result.matches,ocrConfidence:result.ocrConfidence,warning:result.warning||(result.corrected?'Correzione OCR da confermare':'Match da confermare'),pending:false});
    this.persist();
    if(!pendingId){
      this.currentScanId=scan.id;
      if(added){this.last=this.buffer.entries.get(scan.printing.key);this.feedback();this.scanState='RESULT';this.status='Aggiunta alla sessione';this.showDetection(result.code||normalized.code,'Salvata',this.last?.quantity>1?'ok':'ok',this.last?{imageUrl:this.last.imageUrl,cardName:this.last.cardName,setCode:this.last.setCode,rarity:this.last.rarity,quantity:this.last.quantity}:null);}
      else if(!result.matches?.length){this.scanState='RESULT';this.status='Codice non letto · riprova';this.showDetection(result.code||normalized.code||'','Codice non letto — riprova','error');}
      else{this.scanState='RESULT';this.status='Codice da verificare';}
    }
    if(this.phase==='review')this.onRender?.();else this.refreshHud();
  }
  queueZoom(value){const range=this.camera.capabilities?.zoom;if(!range)return;const zoom=Math.min(range.max,Math.max(range.min,Number(value)||range.min));clearTimeout(this.zoomTimer);this.zoomTimer=setTimeout(()=>void this.camera.setZoom(zoom).then(applied=>{if(applied)this.updateZoomUi(this.camera.zoomValue);}),70);this.updateZoomUi(zoom);}
  stepZoom(direction){const range=this.camera.capabilities?.zoom;if(!range)return;const increment=Math.max(Number(range.step)||.1,.1);this.queueZoom((this.camera.zoomValue||range.min)+(direction*increment));}
  startPinch(event){if(!event.target.closest?.('.live-roi')||event.touches.length!==2||!this.camera.zoomSupported)return;this.pinch={distance:touchDistance(event.touches),zoom:this.camera.zoomValue||this.camera.capabilities.zoom.min};}
  movePinch(event){if(!this.pinch||event.touches.length!==2)return;event.preventDefault();const ratio=touchDistance(event.touches)/Math.max(1,this.pinch.distance);this.queueZoom(this.pinch.zoom*ratio);}
  updateZoomUi(value){const input=document.querySelector('[data-scan-zoom]');const output=document.querySelector('[data-scan-zoom-value]');if(input)input.value=String(value);if(output)output.textContent=`${Number(value).toFixed(1)}×`;}
  debugTrace(stage,payload){if(this.debugMode)console.debug('[Fast Scan debug]',stage,payload);}
  reattachVideo(){
    // app.js redraws the whole page (e.g. on a realtime collection/loan event
    // from another team member) while we're mid-scan, which rebuilds a fresh
    // <video> element from the template. The live MediaStream stays attached
    // to the discarded node — the screen goes black even though the camera
    // is still running — so reconnect it to whichever node is on screen now.
    if(this.phase!=='scanning'||!this.camera.stream)return;
    const video=document.querySelector('#fast-scan-video');
    if(!video||video===this.camera.video&&video.srcObject===this.camera.stream)return;
    this.camera.video=video;video.srcObject=this.camera.stream;video.muted=true;video.playsInline=true;
    video.play?.().catch(()=>{});
    this.debugTrace('camera:video-reattached',{});
  }
  refreshControls(){
    const switchCamera=document.querySelector('[data-scan-switch-camera]'),torch=document.querySelector('[data-scan-torch]');if(switchCamera)switchCamera.disabled=this.devices.length<2;if(torch)torch.disabled=!this.camera.torchSupported;
    const controls=document.querySelector('.live-controls');
    const roi=document.querySelector('.live-roi');if(roi){roi.setAttribute('role','button');roi.setAttribute('tabindex','0');const guide=roi.querySelector('span');guide.className='live-roi-guide';guide.innerHTML='<b>INIZIO</b><small>FINE</small>';}
    const range=this.camera.capabilities?.zoom;let zoom=document.querySelector('.live-zoom');if(range&&!zoom&&controls){controls.insertAdjacentHTML('beforebegin',`<div class="live-zoom" aria-label="Zoom fotocamera"><button type="button" data-scan-zoom-step="-1" aria-label="Riduci zoom">−</button><input data-scan-zoom type="range" min="${range.min}" max="${range.max}" step="${range.step||.1}" value="${this.camera.zoomValue}"><button type="button" data-scan-zoom-step="1" aria-label="Aumenta zoom">+</button><output data-scan-zoom-value>${Number(this.camera.zoomValue).toFixed(1)}×</output><small>Puoi anche pizzicare la guida</small></div>`);zoom=document.querySelector('.live-zoom');}zoom?.classList.toggle('hidden',!range);
  }
}

// Stessi vincoli imposti server-side da save_collection_batch (RPC condivisa
// da Fast Scan e dall'editor Raccolta) — validati QUI prima dell'invio così
// una singola entry fuori norma non arriva mai a un chunk RPC che altrimenti
// la rifiuterebbe in blocco insieme a tutte le altre. Non un secondo elenco
// di regole: le stesse identiche soglie del vincolo server, solo anticipate.
const VALID_CONDITIONS=['Mint','Near Mint','Excellent','Good','Played','Poor'];
function hardValidationReason(base){
  if(!['yugioh','onepiece'].includes(base.game))return 'Gioco non valido';
  if(!VALID_CONDITIONS.includes(base.condition))return `Condizione non valida: ${base.condition}`;
  if(!(base.quantityDelta>=1&&base.quantityDelta<=999))return `Quantità non valida: ${base.quantityDelta}`;
  if(!base.printingId){
    if(!(base.catalogCardId.length>=1&&base.catalogCardId.length<=100))return 'ID catalogo non valido';
    if(!(base.cardName.length>=1&&base.cardName.length<=200))return 'Nome carta non valido';
    if(!(base.setCode.length>=4&&base.setCode.length<=100))return `Set code non valido: ${base.setCode||'(vuoto)'}`;
    if(base.imageUrl&&!base.imageUrl.startsWith('https://'))return 'URL immagine non valido';
  }
  return '';
}

// confirmSourcePrinting (facoltativa, 2026-10-13): quando la stampa non è nel
// catalogo (card_printings), il salvataggio la può far creare al server SOLO se
// questa funzione conferma esplicitamente che la fonte ufficiale (YGOPRODeck)
// ha esattamente quel codice e quella rarità per quella carta. Senza la
// funzione il comportamento resta quello di sempre: nessuna creazione implicita.
export async function canonicalizeFastScanEntries(entries=[],lookupPrintings=async()=>[],resolveCanonicalCard=async()=>null,confirmSourcePrinting=async()=>false) {
  const items=[],decisions=[],rejected=[];let repaired=0;
  const sourceConfirms=async base=>{try{return base.game==='yugioh'&&!base.variantId&&!base.artworkId&&Boolean(await confirmSourcePrinting(base));}catch{return false;}};
  const lookups=new Map();
  const lookupOnce=(code,game)=>{const key=game+':'+code;if(!lookups.has(key))lookups.set(key,Promise.resolve().then(()=>lookupPrintings(code,game)));return lookups.get(key);};
  // Prefetch in parallelo (2026-10-24): prima una richiesta per carta in fila,
  // ~200 ms di rete l'una dal telefono (il server risponde in ~15 ms), cioè
  // 10-15 s per 50 carte. Stessi codici e stessa cache di lookupOnce: il ciclo
  // sotto trova le risposte pronte e decide esattamente come prima.
  const prefetch=[...new Map(entries.map(entry=>{try{const base=batchItem(entry);return base.game==='yugioh'&&base.setCode?[base.game+':'+base.setCode,[base.setCode,base.game]]:null;}catch{return null;}}).filter(Boolean)).values()];
  await mapWithConcurrency(prefetch,LOOKUP_PREFETCH_CONCURRENCY,([code,game])=>lookupOnce(code,game).catch(()=>null));
  for(const entry of entries){
    // Ogni entry è isolata in un proprio try/catch: una singola identità
    // irrisolvibile (rarity contaminata sopravvissuta alla sanitizzazione,
    // mismatch di catalogo, ambiguità reale) non deve più far fallire l'intera
    // sessione — finisce in `rejected`, il resto del batch procede.
    try{
      const base=batchItem(entry);
      // La rarity yugioh è già sanitizzata da ScanSessionBuffer.printing()/
      // rebuild() a monte: questa è solo l'ultima rete di sicurezza, per una
      // entry legacy scritta su disco da una versione dell'app precedente a
      // quel fix, ripristinata senza mai passare da rebuild() di nuovo.
      if(base.game==='yugioh')base.rarity=sanitizeYugiohRarity(base.rarity);
      const invalidReason=hardValidationReason(base);
      if(invalidReason)throw saveError('INVALID_RPC_PAYLOAD',`${base.cardName||base.setCode||'Carta'}: ${invalidReason}`,base);
      if(base.game==='yugioh'&&(!base.rarity||entry.requiresCatalogRepair||printingEvidence([base])[0]?.invalidPhysicalRarity))throw saveError('REQUIRES_CATALOG_REPAIR','Rarità non verificata: correggi il catalogo prima di salvare',base);
      if(base.printingId&&base.game!=='yugioh'){items.push(base);decisions.push(canonicalDecision(base,'EXISTING_PRINTING_ID'));continue;}
      if(base.printingId){
        const rows=(await lookupOnce(base.setCode,base.game)||[]).map(mapPrinting);
        const stored=rows.find(row=>row.printingId===base.printingId);
        if(!stored||physicalKey(stored)!==physicalKey(base))throw saveError('REQUIRES_CATALOG_REPAIR','Printing ID e stampa selezionata non corrispondono',base);
        items.push(base);decisions.push(canonicalDecision(base,'EXISTING_PRINTING_ID'));continue;
      }
      if(!base.setCode||!base.cardName||!base.catalogCardId)throw saveError('INVALID_RPC_PAYLOAD',`Sessione precedente non compatibile: dati printing incompleti per ${base.setCode||base.cardName||'una carta'}`,base);
      let rows=[],lookupFailure='';try{rows=await lookupOnce(base.setCode,base.game);}catch(error){lookupFailure=error?.message||'lookup_failed';}
      const candidates=(rows||[]).map(mapPrinting).filter(item=>item.printingId&&sameText(item.setCode,base.setCode)&&item.game===base.game);
      if(!candidates.length&&base.game==='yugioh'){
        if(await sourceConfirms(base)){items.push(base);decisions.push(canonicalDecision(base,'CREATE_FROM_VERIFIED_SOURCE'));continue;}
        throw saveError('REQUIRES_CATALOG_REPAIR','stampa non ancora nel catalogo e non confermata da YGOPRODeck',base);
      }
      if(!candidates.length){
        items.push(base);decisions.push(canonicalDecision(base,'RPC_VALIDATION_REQUIRED',{lookupFailure}));continue;
      }
      const compatible=base.game==='yugioh'?candidates.filter(item=>sameText(item.rarity,base.rarity)&&String(item.variantId||'')===String(base.variantId||'')&&String(item.artworkId||'')===String(base.artworkId||'')):candidates;
      if(!compatible.length){
        // Codice noto ma senza questa rarità (es. c'è l'Ultra, manca la Starlight).
        if(await sourceConfirms(base)){items.push(base);decisions.push(canonicalDecision(base,'CREATE_FROM_VERIFIED_SOURCE'));continue;}
        throw saveError('REQUIRES_CATALOG_REPAIR','rarità non presente nel catalogo per questo codice',base);
      }
      const ranked=compatible.map(item=>({item,score:canonicalCompatibilityScore(base,item)})).filter(item=>item.score>0).sort((left,right)=>right.score-left.score),best=ranked[0],ties=best?ranked.filter(item=>item.score===best.score):[];
      if(!best||ties.length!==1)throw saveError('AMBIGUOUS_PRINTING',`Identità printing ambigua o incoerente per ${base.setCode}: verifica la carta prima di salvare`,{base,candidates:candidates.map(saveDiagnosticEntry)});
      const canonical=best.item,item={...base,printingId:canonical.printingId,game:canonical.game,catalogCardId:canonical.catalogCardId,cardName:canonical.cardName,setCode:canonical.setCode,setName:canonical.setName,rarity:canonical.rarity,imageUrl:canonical.imageUrl};items.push(item);decisions.push(canonicalDecision(item,'CANONICAL_PRINTING_ID'));repaired+=1;
    }catch(error){
      rejected.push({entry,code:error?.code||'PRINTING_CANONICALIZATION_FAILED',message:error?.message||String(error),details:error?.details||null});
    }
  }
  return {items,repaired,decisions,rejected};
}

// Conferma dalla fonte ufficiale per creare una stampa mancante: la scheda
// YGOPRODeck della carta (stesso id) deve elencare esattamente quel codice (o il
// suo gemello inglese per IT/FR/DE/SP/PT: stessa numerazione) con quella rarità.
export async function confirmPrintingFromCatalogSource(base,findCard=findCardById,konamiLookup=konamiRaritiesForSetCode){
  if(base?.game!=='yugioh'||!base.catalogCardId||!base.setCode||!base.rarity)return false;
  const card=await findCard(base.catalogCardId,base.cardName,'yugioh');
  if(!card)return false;
  const wanted=String(base.setCode).trim().toUpperCase(),english=localizeSetCode(wanted,'EN');
  if((card.printings||[]).some(printing=>[wanted,english].includes(String(printing.setCode||'').trim().toUpperCase())&&sameText(printing.rarity,base.rarity)))return true;
  // YGOPRODeck con "New"/"Reprint" al posto della rarità: conferma dalla scheda
  // ufficiale Konami (stesso codice inglese, stesso nome carta, stessa rarità).
  const official=await Promise.resolve(konamiLookup(english,card.name||base.cardName)).catch(()=>null);
  return Boolean(official?.some(rarity=>sameText(rarity,base.rarity)));
}

export async function saveFastScanBatchWithRepair(items=[],saveBatch,repairEntries,{maxRepairs=8}={}){
  let payload=items.map(item=>({...item})),repairAttempts=0;const repairedSetCodes=[];
  while(true){
    try{return {rpcResult:await saveBatch(payload),payload,repairAttempts,repairedSetCodes};}
    catch(error){const setCode=catalogMismatchSetCode(error);if(!setCode||repairAttempts>=maxRepairs||repairedSetCodes.includes(setCode))throw error;const indexes=[];for(let index=0;index<payload.length;index++)if(!payload[index].printingId&&sameText(payload[index].setCode,setCode))indexes.push(index);if(!indexes.length)throw error;const before=indexes.map(index=>payload[index]),repaired=await repairEntries(before,setCode),next=repaired?.items||[];if(next.length!==before.length||!next.some((item,index)=>canonicalIdentityChanged(before[index],item)))throw error;indexes.forEach((payloadIndex,index)=>{payload[payloadIndex]=next[index];});repairAttempts+=1;repairedSetCodes.push(setCode);}
  }
}

function batchItem(entry){return {variantId:entry.variantId||entry.variant_id||'',artworkId:entry.artworkId||entry.artwork_id||'',printingId:entry.printingId||'',game:entry.game||'yugioh',catalogCardId:String(entry.catalogCardId||''),cardName:String(entry.cardName||''),setCode:String(entry.setCode||'').trim().toUpperCase(),setName:entry.setName||'',rarity:entry.rarity||'',imageUrl:entry.imageUrl||'',quantityDelta:Number(entry.quantity??entry.quantityDelta??0),language:entry.language||'Italiano',condition:entry.condition||'Near Mint',edition:entry.edition||''};}
function canonicalDecision(item,validationResult,extra={}){return {setCode:item.setCode,printingId:item.printingId||'',cardId:item.catalogCardId||'',catalogIdentity:[item.game,item.catalogCardId,item.setCode,item.rarity].join(':'),validationResult,...extra};}
function saveDiagnosticEntry(item){return {printingId:item.printingId||'',cardId:item.catalogCardId||item.catalog_card_id||'',setCode:item.setCode||item.set_code||'',cardName:item.cardName||item.card_name||'',rarity:item.rarity||'',quantity:Number(item.quantity??item.quantityDelta??0),catalogIdentity:[item.game||'yugioh',item.catalogCardId||item.catalog_card_id||'',item.setCode||item.set_code||'',item.rarity||''].join(':')};}
function saveError(code,message,details){const error=new Error(message);error.code=code;error.details=details;return error;}
function saveRejectionReason(error,stage){if(error?.code&&['REQUIRES_CATALOG_REPAIR','INVALID_RPC_PAYLOAD','PRINTING_CANONICALIZATION_FAILED','AMBIGUOUS_PRINTING','CATALOG_IDENTITY_MISMATCH'].includes(error.code))return error.code;if(stage==='rpc'){const message=String(error?.message||'');if(/inventory|collection_items|quantit/i.test(message))return 'INVENTORY_WRITE_FAILED';return 'RPC_REJECTED';}if(stage==='refresh')return 'UI_REFRESH_FAILED';return 'PRINTING_CANONICALIZATION_FAILED';}
function catalogMismatchSetCode(error){return String(error?.message||'').match(/Dati catalogo incoerenti per\s+([A-Z0-9-]+)/i)?.[1]?.toUpperCase()||'';}
function canonicalIdentityChanged(before,after){return ['printingId','catalogCardId','cardName','setCode','setName','rarity','imageUrl'].some(field=>String(before?.[field]||'')!==String(after?.[field]||''));}
function canonicalCompatibilityScore(entry,candidate){const sameId=String(entry.catalogCardId)===String(candidate.catalogCardId),knownAlias=canonicalCatalogCardId(entry.catalogCardId,entry.game),sameName=sameText(entry.cardName,candidate.cardName),sameRarity=!entry.rarity||!candidate.rarity||sameText(entry.rarity,candidate.rarity);if(!sameName||(entry.game==='yugioh'&&!sameId&&(!knownAlias||knownAlias!==canonicalCatalogCardId(candidate.catalogCardId,candidate.game))))return 0;return (sameId?8:0)+4+(sameRarity?2:0);}
function sameText(left,right){return String(left||'').normalize('NFKC').trim().toLocaleLowerCase('en')===String(right||'').normalize('NFKC').trim().toLocaleLowerCase('en');}

export function selectSnapshotOcrResult(readings=[],{avoidCode=''}={}){
  const available=[...readings].filter(Boolean),alternatives=avoidCode?available.filter(reading=>{const normalized=normalizeSetCode(reading?.text||'');return normalized.valid&&normalized.code!==avoidCode;}):[];
  return (alternatives.length?alternatives:available).sort((left,right)=>ocrReadingScore(right)-ocrReadingScore(left))[0]||null;
}
function ocrReadingScore(reading){const normalized=normalizeSetCode(reading?.text||''),near=normalized.code.includes('-')&&normalized.code.length>=5;return (normalized.valid?10000:near?1000:0)+(Number(reading?.confidence)||0);}
function ocrReadingSummary(readings=[]){const values=readings.map(reading=>String(reading?.text||'').replace(/\s+/g,'').replace(/[^A-Z0-9-]/gi,'').toUpperCase()).filter(Boolean);return [...new Set(values)].join(' / ').slice(0,48);}
function toggle(id,label,checked){return `<label class="scan-toggle"><input id="${id}" type="checkbox" ${checked?'checked':''}><span>${label}</span><i aria-hidden="true"></i></label>`;}
const SCAN_LANGUAGES=['Italiano','Inglese','Giapponese','Francese','Tedesco','Spagnolo'],SCAN_CONDITIONS=['Mint','Near Mint','Excellent','Good','Played','Poor'];
const LANGUAGE_SHORT={Italiano:'IT',Inglese:'EN',Giapponese:'JP',Francese:'FR',Tedesco:'DE',Spagnolo:'SP'},CONDITION_SHORT={Mint:'M','Near Mint':'NM',Excellent:'EX',Good:'GD',Played:'PL',Poor:'PO'};
// Campi della sessione, condivisi da avvio e foglio impostazioni dello scanner
// (stessi id: readSettings() li legge da qualunque dei due sia a schermo).
function settingsFields(s){return `<div class="scan-settings-grid"><label>Lingua<select id="scan-language">${SCAN_LANGUAGES.map(value=>`<option ${value===s.language?'selected':''}>${value}</option>`).join('')}</select></label><label>Condizione<select id="scan-condition">${SCAN_CONDITIONS.map(value=>`<option ${value===s.condition?'selected':''}>${value}</option>`).join('')}</select></label><label class="wide">Edizione<input id="scan-edition" maxlength="100" value="${esc(s.edition||'')}" placeholder="Non specificata"></label></div><div class="scan-toggles">${toggle('scan-auto','Aggiungi da sola le letture quasi certe',s.autoAdd)}${toggle('scan-vibration','Vibrazione',s.vibration)}${toggle('scan-sound','Suono',s.sound)}</div>`;}
function settingsSummary(s={}){return [LANGUAGE_SHORT[s.language]||s.language||'IT',CONDITION_SHORT[s.condition]||s.condition||'NM',s.edition].filter(Boolean).join(' · ');}
const GLYPHS={back:'<path d="M15 5l-7 7 7 7"/>',close:'<path d="M6 6l12 12M18 6 6 18"/>',undo:'<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12h-2"/>',retry:'<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',keyboard:'<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',flip:'<path d="M4 8V6a2 2 0 0 1 2-2h3M20 16v2a2 2 0 0 1-2 2h-3"/><path d="M17 4l3 3-3 3M7 20l-3-3 3-3"/>',pause:'<path d="M9 6v12M15 6v12"/>',minus:'<path d="M6 12h12"/>',plus:'<path d="M12 6v12M6 12h12"/>'};
function glyph(name){return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[name]||''}</svg>`;}
// Animazioni di esito (2026-10-24). Grafiche originali in SVG, stile fumetto:
// "OK!" su un'esplosione verde per la carta riconosciuta, X su un'esplosione
// "POW" per la lettura fallita. (L'immagine ufficiale del Puzzle del Millennio
// non si usa: è grafica Konami protetta.) Solo decorazione: niente clic, niente
// attese, e con "riduci movimento" diventano una dissolvenza.
const BURST_OK=`<svg class="fsx-burst-art" viewBox="0 0 160 150" aria-hidden="true"><g class="fsx-burst-pow"><path d="${Array.from({length:24},(_,i)=>{const r=i%2?46:70,a=(i*15-90)*Math.PI/180;return `${i?'L':'M'}${(80+Math.cos(a)*r).toFixed(1)} ${(75+Math.sin(a)*r*.9).toFixed(1)}`;}).join(' ')} Z" fill="#3ee08f" stroke="#0b1a12" stroke-width="5" stroke-linejoin="round"/><path d="${Array.from({length:24},(_,i)=>{const r=i%2?34:54,a=(i*15-82)*Math.PI/180;return `${i?'L':'M'}${(80+Math.cos(a)*r).toFixed(1)} ${(75+Math.sin(a)*r*.9).toFixed(1)}`;}).join(' ')} Z" fill="#c6ff5e"/></g><g class="fsx-burst-sparks" fill="#ffe14d" stroke="#0b1a12" stroke-width="2.5" stroke-linejoin="round"><path d="M18 30 l4 9 9 4 -9 4 -4 9 -4 -9 -9 -4 9 -4z"/><path d="M140 22 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3z"/><path d="M146 118 l3 6 6 3 -6 3 -3 6 -3 -6 -6 -3 6 -3z"/></g><g class="fsx-burst-word" transform="rotate(-9 80 76)"><text x="80" y="92" text-anchor="middle" font-family="'Manrope FPT','Arial Black',system-ui,sans-serif" font-size="50" font-weight="800" font-style="italic" letter-spacing="1" fill="#0b1a12" stroke="#0b1a12" stroke-width="12" stroke-linejoin="round" transform="translate(3 4)">OK!</text><text x="80" y="92" text-anchor="middle" font-family="'Manrope FPT','Arial Black',system-ui,sans-serif" font-size="50" font-weight="800" font-style="italic" letter-spacing="1" fill="#ffffff" stroke="#0b1a12" stroke-width="7" stroke-linejoin="round" paint-order="stroke">OK!</text></g></svg>`;
const BURST_ERROR=`<svg class="fsx-burst-art" viewBox="0 0 160 150" aria-hidden="true"><g class="fsx-burst-pow"><path d="${Array.from({length:24},(_,i)=>{const r=i%2?44:70,a=(i*15-90)*Math.PI/180;return `${i?'L':'M'}${(80+Math.cos(a)*r).toFixed(1)} ${(75+Math.sin(a)*r*.92).toFixed(1)}`;}).join(' ')} Z" fill="#ffd23f" stroke="#120a0a" stroke-width="5" stroke-linejoin="round"/><path d="${Array.from({length:24},(_,i)=>{const r=i%2?32:52,a=(i*15-82)*Math.PI/180;return `${i?'L':'M'}${(80+Math.cos(a)*r).toFixed(1)} ${(75+Math.sin(a)*r*.92).toFixed(1)}`;}).join(' ')} Z" fill="#ff6b3d"/></g><g class="fsx-burst-x" stroke-linecap="round"><path d="M56 51 L104 99 M104 51 L56 99" stroke="#120a0a" stroke-width="26"/><path d="M56 51 L104 99 M104 51 L56 99" stroke="#ff2d55" stroke-width="15"/><path d="M58 52 L74 68 M102 52 L94 60" stroke="#ffd0da" stroke-width="4" opacity=".9"/></g></svg>`;
const FAILURE_LABELS={NO_TEXT:'Codice non letto',OCR_FAILED:'Codice non letto',NO_VALID_CODE:'Lettura non valida',NO_CATALOG_MATCH:'Codice non trovato nel catalogo',NOT_FOUND:'Codice non trovato nel catalogo',NO_VALID_MATCH:'Nessuna stampa corrispondente',LOOKUP_FAILED:'Verifica non riuscita (rete)',INTERRUPTED:'Scatto interrotto'};
function sessionSummary(buffer,failedCount=0){const parts=[`${buffer.total} ${buffer.total===1?'carta':'carte'}`];if(buffer.review.length)parts.push(`${buffer.review.length} da verificare`);if(failedCount)parts.push(`${failedCount} ${failedCount===1?'scatto non riuscito':'scatti non riusciti'}`);return parts.join(' · ');}
function failedRow(scan){const code=scan.normalizedCode||scan.rawCode||'';return `<article class="scan-review-row fsx-row warning failed"><div class="fsx-row-body"><strong>${code?esc(code):'Nessun codice letto'}</strong><small>${esc(FAILURE_LABELS[scan.failureReason]||'Scatto non riuscito')} · scatto n. ${scan.sequence}</small><div class="fsx-row-actions"><button type="button" class="btn small" data-scan-edit="${scan.id}">Scrivi il codice</button><button type="button" class="fsx-link danger" data-scan-cancel="${scan.id}">Togli</button></div></div></article>`;}
// Immagine di una stampa: quella salvata o, se manca (le righe dell'indice del
// catalogo non la portano), quella canonica dall'id carta. small: miniatura
// leggera; se manca, installCardImageRecovery (app.js) ripiega sulla grande.
function cardImage(item,{small=false}={}){const url=item?.imageUrl||((item?.game||'yugioh')==='yugioh'?canonicalYgoCardImage(item?.catalogCardId):'');return small?url.replace(/^(https:\/\/images\.ygoprodeck\.com\/images\/)cards\//i,'$1cards_small/'):url;}
function entryArt(item,className='',small=false){const url=cardImage(item,{small});return url?`<img class="${className}" src="${esc(url)}" alt="" loading="lazy">`:`<span class="fsx-thumb-empty ${className}">${icon('card')}</span>`;}
// Revisione a selezione multipla (2026-10-25, variante C scelta dall'utente):
// pallino per scegliere più carte, stato edizione/condizione sotto l'immagine,
// barra in basso che applica 1ª edizione e condizione alle carte scelte. Con
// almeno una carta scelta anche il tocco sull'immagine seleziona (come nella
// galleria del telefono); senza selezione apre il dettaglio come prima.
const CHECK_GLYPH='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>';
function entryState(item){const ed=editionState(item.edition),cond=CONDITION_SHORT[item.condition]||item.condition||'';return `${ed==='first'?'<i class="fsx-state-ed first">1ª Ed.</i>':ed==='unlimited'?'<i class="fsx-state-ed">Unl.</i>':''}${cond?`<i class="fsx-state-cond cond-${esc(String(cond).toLowerCase())}" title="${esc(item.condition||'')}">${esc(cond)}</i>`:''}`;}
function entryTile(item,selected=false,selecting=false){const label=`${item.cardName}, ${item.rarity||'rarità non indicata'}, quantità ${item.quantity}`;return `<div class="scan-review-row fsx-tile ${selected?'selected':''}"><button type="button" class="fsx-tile-open" ${selecting?`data-scan-select="${esc(item.key)}" aria-pressed="${selected}"`:`data-scan-entry-open="${esc(item.key)}"`} aria-label="${esc((selecting?(selected?'Togli dalla selezione: ':'Scegli: '):'Dettagli: ')+label)}"><span class="fsx-tile-art">${entryArt(item,'',true)}${item.quantity>1?`<b class="fsx-tile-qty">×${item.quantity}</b>`:''}</span></button><button type="button" class="fsx-tile-check" data-scan-select="${esc(item.key)}" aria-pressed="${selected}" aria-label="${esc((selected?'Togli dalla selezione: ':'Scegli: ')+item.cardName)}">${selected?CHECK_GLYPH:''}</button><span class="fsx-tile-state">${entryState(item)}</span><span class="fsx-tile-meta"><strong>${esc(item.cardName)}</strong>${item.rarity?`<em class="fsx-rarity">${esc(item.rarity)}</em>`:''}</span></div>`;}
function selectionBar(items){const count=items.length,eds=items.map(item=>editionState(item.edition)),allFirst=eds.every(ed=>ed==='first'),allUnl=eds.every(ed=>ed==='unlimited'),sameCond=items.every(item=>item.condition===items[0]?.condition)?items[0]?.condition:null;return `<section class="fsx-savebar fsx-selbar" aria-label="Modifica le carte scelte"><div class="fsx-selbar-head"><strong>${count} ${count===1?'carta scelta':'carte scelte'}</strong><button type="button" class="fsx-link" data-scan-select-done>Fatto</button></div><div class="fsx-selbar-ed"><button type="button" data-scan-bulk-edition="first" aria-pressed="${allFirst}">1ª Edizione</button><button type="button" data-scan-bulk-edition="unlimited" aria-pressed="${allUnl}">Non 1ª (Unlimited)</button></div><div class="fsx-selbar-cond" role="group" aria-label="Condizione">${VALID_CONDITIONS.map(condition=>{const short=CONDITION_SHORT[condition]||condition;return `<button type="button" class="cond-${short.toLowerCase()}" data-scan-bulk-condition="${esc(condition)}" aria-pressed="${sameCond===condition}" aria-label="${esc(condition)}">${esc(short)}</button>`;}).join('')}</div></section>`;}
function entrySheet(item){const firstEdition=isFirstEdition(item.edition),details=[item.language,item.condition].filter(Boolean).join(' · ');return `<div class="scan-sheet-backdrop fsx-entry-backdrop" data-scan-entry-sheet><section class="scan-bottom-sheet fsx-entry-sheet" role="dialog" aria-modal="true" aria-labelledby="scan-entry-title"><span class="sheet-handle"></span><div class="fsx-entry-hero">${entryArt(item,'fsx-entry-art')}<div class="fsx-entry-info"><small>${esc(item.setCode||'')}</small><h2 id="scan-entry-title">${esc(item.cardName)}</h2>${item.rarity?`<em class="fsx-rarity">${esc(item.rarity)}</em>`:''}${item.artworkLabel?`<span class="fsx-entry-note">${esc(item.artworkLabel)}</span>`:''}${details?`<span class="fsx-entry-note">${esc(details)}</span>`:''}</div></div><div class="fsx-entry-controls"><div class="scan-qty-stepper"><button type="button" data-scan-qty-dec="${esc(item.key)}" aria-label="Diminuisci quantità">${glyph('minus')}</button><b>${item.quantity}</b><button type="button" data-scan-qty-inc="${esc(item.key)}" aria-label="Aumenta quantità" ${item.quantity>=999?'disabled':''}>${glyph('plus')}</button></div><button type="button" class="scan-first-edition-toggle ${firstEdition?'active':''}" data-scan-first-edition="${esc(item.key)}" aria-pressed="${firstEdition}">1ª Edizione</button></div><button type="button" class="btn fsx-primary" data-scan-entry-close>Fatto</button><button type="button" class="sheet-danger" data-scan-remove="${esc(item.key)}">Rimuovi dalla sessione</button></section></div>`;}
function reviewRow(item){
  const code=esc(item.code||item.raw||'Codice non riconosciuto');
  // An ignored pending row cannot be resurrected by a late background result.
  if(item.pending)return `<article class="scan-review-row fsx-row warning pending"><span class="fsx-spinner" aria-hidden="true"></span><div class="fsx-row-body"><strong>${code}</strong><small>${esc(item.warning||'Verifica in corso…')}</small></div><button type="button" class="btn secondary small" data-review-ignore="${item.id}">Ignora</button></article>`;
  const names=[...new Set((item.matches||[]).map(match=>match.cardName||''))],sameCard=names.length===1&&names[0];
  return `<article class="scan-review-row fsx-row warning"><div class="fsx-row-body"><strong>${code}</strong>${sameCard?`<span class="fsx-row-card">${esc(sameCard)}</span>`:''}${item.warning?`<small>${esc(item.warning)}</small>`:''}${item.matches?.length?`<div class="review-choices">${item.matches.map((match,index)=>`<button type="button" data-review-choice="${index}" data-review-id="${item.id}">${cardImage(match)?`<img src="${esc(cardImage(match,{small:true}))}" alt="">`:`<span class="fsx-thumb-empty">${icon('card')}</span>`}<span>${sameCard?'':`<b>${esc(match.cardName||'')}</b>`}<em class="fsx-rarity">${esc(match.rarity||'Rarità non indicata')}</em>${match.artworkLabel?`<small>${esc(match.artworkLabel)}</small>`:''}</span></button>`).join('')}</div>`:`<div class="review-correction"><input data-review-input="${item.id}" value="${esc(item.code||'')}" autocapitalize="characters" spellcheck="false" placeholder="Correggi il codice"><button type="button" class="btn small" data-review-correct="${item.id}">Cerca</button></div>`}<button type="button" class="fsx-link danger" data-review-ignore="${item.id}">Ignora questa scansione</button></div></article>`;
}
function mapPrinting(row){return {...row,printingId:row.printing_id||row.printingId||row.id||'',game:row.game||'yugioh',catalogCardId:String(row.catalog_card_id||row.catalogCardId||''),cardName:row.card_name||row.cardName,setCode:row.set_code||row.setCode,setName:row.set_name||row.setName||'',rarity:(row.game||'yugioh')==='yugioh'?sanitizeYugiohRarity(row.rarity):row.rarity||'',variantId:row.variantId||row.variant_id||'',artworkId:row.artworkId||row.artwork_id||'',imageUrl:row.image_url||row.imageUrl||((row.game||'yugioh')==='yugioh'?canonicalYgoCardImage(row.catalog_card_id||row.catalogCardId):'')};}
function dedupe(items){return [...new Map(items.map(item=>[[item.printingId,physicalKey(item)].join(':'),item])).values()];}
export const OCR_SUB_ROI={topRatio:.05,heightRatio:.9};
export function createOcrInputPlan(snapshot){
  const raw=snapshot.rawCanvas||snapshot.canvas;if(!raw?.width||!raw?.height)throw new Error('ROI raw OCR non disponibile');
  const {canvas:subCropRaw,geometry:subCrop}=extractOcrSubCrop(raw);
  // L'adaptive costa un secondo preprocessCodeImage + un secondo canvas 900px
  // ad ogni scatto, ma il primary (grayscale) basta da solo quando l'OCR è
  // già ad alta confidence (vedi lo short-circuit in performScanOnce): non ha
  // senso pagarlo se poi non viene mai passato a recognizeProduction.
  function buildItem(mode){
    const sourceCanvas=cloneOcrCanvas(subCropRaw),preprocessing={...preprocessCodeImage(sourceCanvas.getContext('2d',{willReadFrequently:true}),sourceCanvas.width,sourceCanvas.height,{mode}),subCrop};
    const canvas=buildOcrCanvas(sourceCanvas,{targetWidth:900,padding:true});if(canvas.dataset)canvas.dataset.ocrInput=mode;
    return {id:mode,canvas,sourceCanvas,preprocessing:{...preprocessing,input:mode,targetWidth:900,paddingX:.14,paddingY:.2,cropExpansion:0}};
  }
  const primary=buildItem('grayscale'),built=[primary];let fallback=null;
  return {
    primary,
    get fallback(){return fallback;},
    buildFallback(){if(!fallback){fallback=buildItem('adaptive');built.push(fallback);}return fallback;},
    get items(){return built;},
    subCropRaw,subCrop,
    release(){for(const item of built){clearOcrCanvas(item.canvas);clearOcrCanvas(item.sourceCanvas);}clearOcrCanvas(subCropRaw);}
  };
}
function extractOcrSubCrop(source){const topRatio=OCR_SUB_ROI.topRatio,heightRatio=OCR_SUB_ROI.heightRatio,sy=Math.max(0,Math.round(source.height*topRatio)),sh=Math.max(1,Math.min(source.height-sy,Math.round(source.height*heightRatio))),canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=sh;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(source,0,sy,source.width,sh,0,0,canvas.width,canvas.height);return {canvas,geometry:{sx:0,sy,sw:source.width,sh,topRatio,heightRatio}};}
function cloneOcrCanvas(source){const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(source,0,0);return canvas;}
function buildOcrCanvas(source,{targetWidth=900,padding=true,visualOnly=false}={}){const expansion=.1,inset=visualOnly?(1-(1/(1+expansion)))/2:0,sx=Math.round(source.width*inset),sw=Math.max(1,source.width-sx*2),sy=0,sh=source.height,padXRatio=padding?0.14:0,padYRatio=padding?0.2:0,contentWidth=Math.max(1,Math.round(targetWidth/(1+padXRatio*2))),contentHeight=Math.max(1,Math.round(contentWidth*sh/sw)),padX=Math.floor((targetWidth-contentWidth)/2),padY=Math.round(contentHeight*padYRatio),canvas=document.createElement('canvas');canvas.width=targetWidth;canvas.height=contentHeight+padY*2;const context=canvas.getContext('2d',{willReadFrequently:true});context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(source,sx,sy,sw,sh,padX,padY,contentWidth,contentHeight);return canvas;}
function clearOcrCanvas(canvas){if(!canvas)return;try{canvas.getContext?.('2d')?.clearRect?.(0,0,canvas.width||0,canvas.height||0);}catch{}canvas.width=0;canvas.height=0;}
// Motivo probabile di una lettura vuota, dalle misure del ritaglio (preprocessCodeImage):
// luminosità media 0–255 e varianza laplaciana (nitidezza). Solo un suggerimento.
export function captureHint(preprocessing,torchSupported=false){
  if(!preprocessing)return '';
  const luma=Number(preprocessing.meanLuma),sharpness=Number(preprocessing.sharpness);
  if(Number.isFinite(luma)&&luma<55)return torchSupported?'Troppo buio · accendi il flash':'Troppo buio · avvicinati alla luce';
  if(Number.isFinite(luma)&&luma>225)return 'Riflesso · inclina un po’ la carta';
  if(Number.isFinite(sharpness)&&sharpness<3)return 'Immagine mossa · tieni ferma la carta';
  return '';
}
const LOOKUP_PREFETCH_CONCURRENCY=6;
// Esegue task(item) su tutti gli elementi con al massimo `limit` in volo.
async function mapWithConcurrency(items,limit,task){let next=0;const workers=Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const item=items[next++];await task(item);}});await Promise.all(workers);}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function touchDistance(touches){const x=touches[0].clientX-touches[1].clientX,y=touches[0].clientY-touches[1].clientY;return Math.hypot(x,y);}
function beep(tone='ok'){try{const Audio=window.AudioContext||window.webkitAudioContext;const context=new Audio();const notes={ok:[[880,0,.06]],warn:[[620,0,.07],[620,.11,.07]],error:[[260,0,.18]]}[tone]||[[880,0,.06]];let last=null;for(const [frequency,start,length] of notes){const oscillator=context.createOscillator(),gain=context.createGain();oscillator.frequency.value=frequency;gain.gain.value=.03;oscillator.connect(gain).connect(context.destination);oscillator.start(context.currentTime+start);oscillator.stop(context.currentTime+start+length);last=oscillator;}if(last)last.onended=()=>context.close();}catch{}}
