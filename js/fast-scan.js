import { esc } from './core.js';
import { icon } from './icons.js';
import { normalizeSetCode, extractSetCodeCandidates, setCodeCandidates, classifyPrintingMatch, classifyNearPrintingMatch, OcrConsensus, ScanGate, ScanSessionBuffer, defaultScanSettings } from './fast-scan-core.js';
import { isFirstEdition } from './collection.js';
import { FastScanCamera, preprocessCodeImage } from './fast-scan-camera.js';
import { loadScanSession, saveScanSession, clearScanSession } from './fast-scan-storage.js';
import { syncCatalogIndex } from './fast-scan-catalog-cache.js';
import { prepareFastScanSync, markChunk, pendingChunkIndexes, syncProgress } from './fast-scan-sync.js';
import { PaddleOcrEngine } from './fast-scan-ocr-engine-b.js';
import { resolveStoredCard } from './cards.js';

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
  constructor(){this.samples=[];}
  record(sample){this.samples.push(sample);if(this.samples.length>TELEMETRY_WINDOW)this.samples.shift();}
  summary(){
    const n=this.samples.length;if(!n)return null;
    const totals=this.samples.map(sample=>sample.cycleTotalMs);
    const fallbackCount=this.samples.filter(sample=>sample.fallbackUsed).length;
    const externalCount=this.samples.filter(sample=>sample.externalLookupMs>0).length;
    return {count:n,meanMs:mean(totals),p50Ms:percentile(totals,.5),p95Ms:percentile(totals,.95),fallbackRate:fallbackCount/n,externalRate:externalCount/n};
  }
}

export class FastScanController {
  constructor({api,externalLookup,getCollection,isOnline,onRender,onSaved,onToast,onRoute,camera,paddleOcr}={}) {
    Object.assign(this,{api,externalLookup,getCollection,isOnline,onRender,onSaved,onToast,onRoute});
    this.camera=camera||new FastScanCamera();this.paddleOcr=paddleOcr||new PaddleOcrEngine();this.paddleState='idle';this.paddleError='';this.primaryOcrPreparing=null;
    this.buffer=new ScanSessionBuffer();this.sync=null; this.gate=new ScanGate(); this.consensus=new OcrConsensus(); this.failureStreak=0; this.localCatalog=new Map(); this.resolutionCache=new Map(); this.missCache=new Map(); this.phase='setup'; this.status='Pronto';this.debugMode=typeof location!=='undefined'&&new URLSearchParams(location.search).get('debugScan')==='1';this.telemetry=new ScanTelemetry();this.cycleTelemetry=null;this.lastCycleDecision=null;this.catalogIndex=new Map();this.pendingCodes=new Set();this.backgroundQueue=[];this.activeBackgroundResolutions=0;
    this.last=null;this.scanState='IDLE';this.recoveringCamera=false;this.recoveryCount=0;this.recoveryAttempts=[];this.startRequestId=0;this.hiddenSuspended=false;this.roiPreset='narrow';this.forceSnapshot=false;this.snapshotInFlight=false;this.scanCycleInFlight=false; this.devices=[]; this.timer=0; this.persistTimer=0; this.feedbackTimer=0; this.zoomTimer=0; this.backgroundStopTimer=0; this.backgroundCameraStopped=false; this.pinch=null; this.hasRecovery=false; this.saving=false; this.cameraError=''; this.exitOpen=false; this.manualOpen=false;
    if(this.debugMode)this.camera.onDiagnostic=(event,payload)=>this.debugTrace(`camera:${event}`,payload);
    this.visibilityHandler=()=>void this.handleVisibilityChange(); document.addEventListener('visibilitychange',this.visibilityHandler);
    this.focusHandler=event=>{if(event.target.closest?.('.live-roi,#fast-scan-video'))void this.refocus();}; document.addEventListener('click',this.focusHandler);
    this.restartHandler=event=>{if(event.target.closest?.('[data-scan-restart-camera]'))void this.recoverCamera('manual-restart');};document.addEventListener('click',this.restartHandler);
    this.focusKeyHandler=event=>{if(['Enter',' '].includes(event.key)&&event.target.matches?.('.live-roi')){event.preventDefault();void this.refocus();}}; document.addEventListener('keydown',this.focusKeyHandler);
    this.zoomHandler=event=>{if(event.target.matches?.('[data-scan-zoom]'))this.queueZoom(event.target.value);const step=event.target.closest?.('[data-scan-zoom-step]');if(step)this.stepZoom(Number(step.dataset.scanZoomStep));};document.addEventListener('input',this.zoomHandler);document.addEventListener('click',this.zoomHandler);
    this.pinchStartHandler=event=>this.startPinch(event);this.pinchMoveHandler=event=>this.movePinch(event);this.pinchEndHandler=()=>{this.pinch=null;};document.addEventListener('touchstart',this.pinchStartHandler,{passive:true});document.addEventListener('touchmove',this.pinchMoveHandler,{passive:false});document.addEventListener('touchend',this.pinchEndHandler,{passive:true});
  }
  get hasScans(){return this.buffer.scanned>0||this.buffer.total>0||this.buffer.review.length>0;}
  async restore(){const snapshot=await loadScanSession();if(snapshot&&(snapshot.scanned||snapshot.total||snapshot.review?.length)){this.buffer=new ScanSessionBuffer(snapshot);for(const item of this.buffer.review)if(item.pending)Object.assign(item,{pending:false,status:'needs_review',warning:'Verifica interrotta: conferma o correggi il codice'});this.sync=snapshot.sync||null;this.hasRecovery=true;if(this.sync?.status==='syncing')this.sync={...this.sync,status:'pending'};this.onRender?.();}}
  view(){return this.phase==='review'?this.reviewView():this.phase==='scanning'?this.scannerView():this.setupView();}
  setupView(){const s=this.buffer.settings||defaultScanSettings();return `<section class="page-stack fast-scan-page fast-scan-setup"><header class="page-header split"><div><span class="eyebrow">Scanner</span><h1>Fast Scan</h1><p>Prepara la sessione, poi la fotocamera diventerà il centro dell’esperienza.</p></div><button class="btn secondary" data-scan-setup-back>Torna alla Raccolta</button></header>${this.hasRecovery?`<div class="resume-scan surface"><div>${icon('collection')}<span><strong>Hai una sessione Fast Scan non salvata</strong><small>${this.buffer.scanned} scansioni · ${this.buffer.entries.size} printing · ${this.buffer.review.length} da verificare</small></span></div><div class="actions"><button class="btn" data-scan-resume-session>Riprendi scansione</button><button class="btn secondary" data-scan-recovery-review>Vai alla review</button><button class="btn secondary danger" data-scan-discard>Scarta</button></div></div>`:''}<form id="fast-scan-settings" class="surface scan-settings"><div><span class="eyebrow">Impostazioni sessione</span><h2>Prepara lo scanner</h2></div><div class="scan-settings-grid"><label>Gioco<select id="scan-game"><option value="yugioh">Yu-Gi-Oh!</option></select></label><label>Lingua predefinita<select id="scan-language">${['Italiano','Inglese','Giapponese','Francese','Tedesco','Spagnolo'].map(value=>`<option ${value===s.language?'selected':''}>${value}</option>`).join('')}</select></label><label>Condizione<select id="scan-condition">${['Mint','Near Mint','Excellent','Good','Played','Poor'].map(value=>`<option ${value===s.condition?'selected':''}>${value}</option>`).join('')}</select></label><label>Edizione<input id="scan-edition" maxlength="100" value="${esc(s.edition||'')}" placeholder="Non specificata"></label></div><div class="scan-toggles">${toggle('scan-auto','Auto-add high confidence',s.autoAdd)}${toggle('scan-vibration','Vibrazione',s.vibration)}${toggle('scan-sound','Suono',s.sound)}</div><div class="scan-start-actions"><button class="btn" type="submit">${icon('search')} Avvia scansione</button><button class="btn secondary" type="button" data-scan-manual-start>Inserimento manuale</button></div></form></section>`;}
  scannerView(){return `<section class="fast-scan-live ${this.cameraError?'manual-camera':''}"><video id="fast-scan-video" autoplay muted playsinline></video><div class="live-scan-shade"></div><header class="live-scan-header"><button class="live-icon-button" data-scan-back aria-label="Indietro">${icon('arrow')}</button><div><small>Scanner</small><strong>Fast Scan</strong></div><span class="live-header-spacer" aria-hidden="true"></span></header>${this.cameraError?`<div class="live-camera-error"><span>${icon('bell')}</span><strong>${esc(this.cameraError)}</strong><small>Puoi continuare tramite inserimento manuale.</small></div>`:''}<div class="live-roi-label">Allinea il codice</div><div class="live-roi" aria-label="Area di lettura codice"><i></i><span></span></div>${this.debugMode?'<aside class="live-crop-debug" aria-live="polite"><strong>Crop OCR esatto</strong><canvas data-scan-debug-crop></canvas><small data-scan-debug-geometry>In attesa dello scatto</small><small data-scan-debug-stats>In attesa di scan misurati</small></aside>':''}<div class="live-ocr-state"><strong data-scan-status>${esc(this.status)}</strong></div><div class="live-detection" data-scan-detection aria-live="assertive"></div><footer class="live-scan-bottom"><div class="live-scan-content"><div class="live-last" data-scan-last>${this.last?`✓ <b>${esc(this.last.setCode)}</b> · +1`:'Nessun codice rilevato'}</div><div class="live-session-stats"><span><b data-scan-total-number>${this.buffer.scanned}</b> scan</span><i>·</i><span><b data-scan-distinct>${this.buffer.entries.size}</b> printing</span><i>·</i><span><b data-scan-review>${this.buffer.review.length}</b> review</span></div><button type="button" class="live-capture" data-scan-capture ${this.snapshotInFlight?'disabled':''}>${icon('camera')}<span>${this.snapshotInFlight?'Elaborazione…':'Scatta e analizza'}</span></button><div class="live-controls"><button data-scan-manual-open>${icon('card')}<span>Manuale</span></button><button data-scan-torch ${this.camera.torchSupported?'':'disabled'}>${icon('flash')}<span>Flash</span></button><button data-scan-switch-camera ${this.devices.length>1?'':'disabled'}>${icon('camera')}<span>Camera</span></button></div></div></footer>${this.exitSheetView()}${this.manualSheetView()}</section>`;}
  exitSheetView(){return `<div class="scan-sheet-backdrop hidden" data-scan-exit-sheet><section class="scan-bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="scan-exit-title"><span class="sheet-handle"></span><small>Sessione Fast Scan</small><h2 id="scan-exit-title">Hai finito?</h2><p>Vediamo cos’hai raccolto allora?</p><div class="sheet-session-summary"><b>${this.buffer.scanned} carte scansionate</b><span>${this.buffer.entries.size} printing · ${this.buffer.review.length} da verificare</span></div><button class="btn" data-scan-confirm-review>Sì, mostrami</button><button class="btn secondary" data-scan-cancel-exit>No, continua a scansionare</button><button class="sheet-danger" data-scan-discard-exit>Scarta sessione</button></section></div>`;}
  manualSheetView(){return `<div class="scan-sheet-backdrop hidden" data-scan-manual-sheet><section class="scan-bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="scan-manual-title"><span class="sheet-handle"></span><small>Fallback</small><h2 id="scan-manual-title">Inserisci codice manualmente</h2><form id="scan-manual-form"><input id="scan-manual-code" autocomplete="off" autocapitalize="characters" placeholder="Es. TDGS-IT001" required><button class="btn">Aggiungi</button></form><button class="btn secondary" data-scan-manual-close>Chiudi</button></section></div>`;}
  reviewView(){const entries=[...this.buffer.entries.values()],progress=syncProgress(this.sync),failed=this.sync?.status==='error';return `<section class="page-stack fast-scan-page scan-review"><header class="page-header split"><div><span class="eyebrow">Review sessione</span><h1>${this.buffer.scanned} carte rilevate</h1><p>${entries.length} printing · ${this.buffer.review.length} da verificare</p></div><button class="btn secondary" data-scan-continue>Continua scansione</button></header>${failed?`<section class="surface scan-sync-warning" role="alert"><strong>Sincronizzazione interrotta. I tuoi scan sono salvati sul dispositivo.</strong><small>${progress.synced}/${progress.total} blocchi completati · al retry saranno inviati soltanto quelli mancanti.</small><div class="actions"><button class="btn" data-scan-save>Riprova sincronizzazione</button><button class="btn secondary" data-scan-sync-later>Continua più tardi</button><button class="btn secondary" data-scan-export>Esporta riepilogo</button></div></section>`:''}${this.buffer.review.length?`<section class="surface"><h2>Da verificare</h2><div class="scan-review-list">${this.buffer.review.map(item=>reviewRow(item)).join('')}</div></section>`:''}<section class="surface"><div class="dashboard-title"><div><span class="eyebrow">Pronte al salvataggio</span><h2>Printing riconosciute</h2></div></div><div class="scan-review-list">${entries.length?entries.map(entry=>entryRow(entry)).join(''):'<div class="empty">Nessuna printing confermata.</div>'}</div></section><div class="scan-save-bar"><span><b>${this.buffer.total}</b> carte saranno aggiunte alla tua raccolta${this.saving&&progress.total?` · ${progress.percent}%`:''}</span><button class="btn" data-scan-save ${!entries.length||this.saving||this.buffer.review.some(item=>item.pending)||!this.isOnline()?'disabled':''}>${this.saving?'Sincronizzazione…':failed?'Riprova sincronizzazione':'Salva raccolta'}</button></div></section>`;}
  bind(root=document){this.reattachVideo();root.querySelector('#fast-scan-settings')?.addEventListener('submit',e=>{e.preventDefault();this.readSettings();void this.start();});root.querySelector('[data-scan-setup-back]')?.addEventListener('click',()=>void this.exitToCollection());root.querySelector('[data-scan-manual-start]')?.addEventListener('click',()=>{this.readSettings();this.startManual();});root.querySelector('[data-scan-resume-session]')?.addEventListener('click',()=>{this.hasRecovery=false;void this.start();});root.querySelector('[data-scan-recovery-review]')?.addEventListener('click',()=>void this.openReview());root.querySelector('[data-scan-discard]')?.addEventListener('click',()=>void this.discard());root.querySelector('[data-scan-back]')?.addEventListener('click',()=>void this.requestExit());root.querySelector('[data-scan-confirm-review]')?.addEventListener('click',()=>void this.openReview());root.querySelector('[data-scan-cancel-exit]')?.addEventListener('click',()=>this.cancelExit());root.querySelector('[data-scan-discard-exit]')?.addEventListener('click',()=>void this.discardAndExit());root.querySelector('[data-scan-continue]')?.addEventListener('click',()=>{if(!this.canEditSession())return;this.onRoute?.('scan');void this.start();});root.querySelector('[data-scan-manual-open]')?.addEventListener('click',()=>this.toggleManual(true));root.querySelector('[data-scan-manual-close]')?.addEventListener('click',()=>this.toggleManual(false));root.querySelector('[data-scan-capture]')?.addEventListener('click',()=>this.requestSnapshot());root.querySelector('[data-scan-torch]')?.addEventListener('click',async e=>{const on=await this.camera.toggleTorch();e.currentTarget.classList.toggle('active',on);e.currentTarget.querySelector('span').textContent=on?'Flash on':'Flash';});root.querySelector('[data-scan-switch-camera]')?.addEventListener('click',()=>void this.switchCamera());root.querySelector('#scan-manual-form')?.addEventListener('submit',e=>{e.preventDefault();const input=root.querySelector('#scan-manual-code');void this.processManual(input.value).then(()=>{input.value='';input.focus();});});root.querySelectorAll('[data-scan-qty-inc]').forEach(button=>button.addEventListener('click',()=>{if(!this.canEditSession())return;const key=button.dataset.scanQtyInc,item=this.buffer.entries.get(key);if(!item)return;this.invalidateSync();this.buffer.updateQuantity(key,item.quantity+1);this.persist();this.onRender();}));root.querySelectorAll('[data-scan-qty-dec]').forEach(button=>button.addEventListener('click',()=>{if(!this.canEditSession())return;const key=button.dataset.scanQtyDec,item=this.buffer.entries.get(key);if(!item)return;this.invalidateSync();this.buffer.updateQuantity(key,item.quantity-1);this.persist();this.onRender();}));root.querySelectorAll('[data-scan-first-edition]').forEach(button=>button.addEventListener('click',()=>{if(!this.canEditSession())return;const key=button.dataset.scanFirstEdition,item=this.buffer.entries.get(key);if(!item)return;this.invalidateSync();this.buffer.setEdition(key,isFirstEdition(item.edition)?'Unlimited':'Prima Edizione');this.persist();this.onRender();}));root.querySelectorAll('[data-scan-remove]').forEach(button=>button.addEventListener('click',()=>{if(!this.canEditSession())return;this.invalidateSync();this.buffer.updateQuantity(button.dataset.scanRemove,0);this.persist();this.onRender();}));root.querySelectorAll('[data-review-choice]').forEach(button=>button.addEventListener('click',()=>this.chooseReview(button.dataset.reviewId,Number(button.dataset.reviewChoice))));root.querySelectorAll('[data-review-ignore]').forEach(button=>button.addEventListener('click',()=>{if(!this.canEditSession())return;this.invalidateSync();this.buffer.removeReview(button.dataset.reviewIgnore);this.persist();this.onRender();}));root.querySelectorAll('[data-review-correct]').forEach(button=>button.addEventListener('click',()=>{const input=root.querySelector(`[data-review-input="${button.dataset.reviewCorrect}"]`);void this.correctReview(button.dataset.reviewCorrect,input.value);}));root.querySelectorAll('[data-scan-save]').forEach(button=>button.addEventListener('click',()=>void this.save()));root.querySelector('[data-scan-sync-later]')?.addEventListener('click',()=>{this.hasRecovery=true;this.onRoute?.('collection');});root.querySelector('[data-scan-export]')?.addEventListener('click',()=>this.exportSummary());}
  readSettings(){const pick=id=>document.querySelector(id);this.buffer.settings={game:'yugioh',language:pick('#scan-language')?.value||'Italiano',condition:pick('#scan-condition')?.value||'Near Mint',edition:pick('#scan-edition')?.value.trim()||'',autoAdd:Boolean(pick('#scan-auto')?.checked),vibration:Boolean(pick('#scan-vibration')?.checked),sound:Boolean(pick('#scan-sound')?.checked)};this.persist();}
  startManual(){this.stopLoop();this.phase='scanning';this.cameraError='Modalità manuale';this.status='Inserisci un codice';this.onRoute?.('scan');this.onRender();}
  async start(){
    const requestId=++this.startRequestId;this.stopLoop();if(this.phase==='setup'&&!this.hasScans)this.camera.resetSnapshotStrategy?.();this.consensus.reset();this.failureStreak=0;this.forceSnapshot=false;this.snapshotInFlight=false;this.scanState='LIVE';this.buildLocalCatalog();this.loadCatalogIndex();this.exitOpen=false;this.manualOpen=false;this.hiddenSuspended=false;this.phase='scanning';this.cameraError='';this.status='Avvio fotocamera…';this.onRoute?.('scan');this.onRender();const video=document.querySelector('#fast-scan-video');this.debugTrace('camera:start-controller',{requestId});
    const preparingOcr=this.prepareProductionOcr();
    try{this.devices=await this.camera.start(video,this.camera.deviceId);if(requestId!==this.startRequestId||this.phase!=='scanning')return;this.refreshControls();this.setStatus('Preparazione OCR…');await preparingOcr;if(requestId!==this.startRequestId||this.phase!=='scanning')return;if(this.paddleState==='unavailable'){this.setStatus('OCR non disponibile · usa Manuale');return;}this.setStatus('Pronto allo scatto');this.schedule(250);}catch(error){if(requestId!==this.startRequestId)return;this.camera.stop('start-failed');if(this.phase!=='scanning')return;this.scanState='CAMERA_ERROR';this.cameraError=error.message||'Fotocamera non disponibile';this.status='Riavvia fotocamera';this.debugTrace('camera:start-failed',{requestId,error:this.cameraError});this.onRender();setTimeout(()=>this.showRestartControl(),0);}
  }
  async prepareProductionOcr(){
    if(this.paddleState==='paddle')return;if(this.primaryOcrPreparing)return this.primaryOcrPreparing;this.paddleState='preparing';this.paddleError='';this.primaryOcrPreparing=(async()=>{try{await this.paddleOcr.prepare();this.paddleState='paddle';}catch(error){this.paddleState='unavailable';this.paddleError=error?.message||String(error);}})();try{await this.primaryOcrPreparing;}finally{this.primaryOcrPreparing=null;}}
  async recognizeProduction(canvas){
    if(this.paddleState!=='paddle')await this.prepareProductionOcr();
    if(this.paddleState==='paddle'){const started=performance.now();const result=await this.paddleOcr.recognize(canvas);this.debugTrace('ocr:timing',{durationMs:Math.round(performance.now()-started),width:canvas.width,height:canvas.height,confidence:result.confidence,metrics:result.metrics,runtime:result.runtime,worker:result.worker});return {...result,engine:'paddle'};}
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
        this.hiddenSuspended=true;this.stopLoop();this.scanState='BACKGROUND';this.debugTrace('visibility:hidden',this.camera.stateSnapshot?.()||{});
        clearTimeout(this.backgroundStopTimer);
        this.backgroundStopTimer=setTimeout(()=>{if(document.hidden&&this.hiddenSuspended){this.backgroundCameraStopped=true;this.camera.stop('background-timeout');}},4000);
      }
      return;
    }
    clearTimeout(this.backgroundStopTimer);
    if(!this.hiddenSuspended||this.phase!=='scanning')return;this.hiddenSuspended=false;this.debugTrace('visibility:visible',this.camera.stateSnapshot?.()||{});
    if(this.backgroundCameraStopped){this.backgroundCameraStopped=false;await this.recoverCamera('visibility:restore');return;}
    try{await this.camera.video?.play?.();}catch{}
    const issue=this.camera.healthIssue?.();if(issue)await this.recoverCamera(`visibility:${issue}`);else{this.scanState='LIVE';this.setStatus('Pronto allo scatto');this.schedule(120);}
  }
  showRestartControl(){const state=document.querySelector('.live-ocr-state');if(state&&!state.querySelector('[data-scan-restart-camera]'))state.insertAdjacentHTML('beforeend','<button type="button" class="btn secondary small" data-scan-restart-camera>Riavvia fotocamera</button>');}
  async recoverCamera(reason='camera-health'){
    if(this.recoveringCamera||this.phase!=='scanning')return;const now=Date.now();this.recoveryAttempts=this.recoveryAttempts.filter(at=>now-at<30000);if(reason!=='manual-restart'&&this.recoveryAttempts.length>=3){this.cameraError='La fotocamera si è interrotta più volte';this.scanState='CAMERA_ERROR';this.setStatus('Riavvia fotocamera');this.debugTrace('camera:recovery-blocked',{reason,attempts:this.recoveryAttempts.length,state:this.camera.stateSnapshot?.()||{}});this.showRestartControl();return;}this.recoveryAttempts.push(now);this.recoveringCamera=true;this.stopLoop();this.scanState='RECOVERING';this.setStatus('Ripristino fotocamera…');this.debugTrace('camera:recovery-start',{reason,attempt:this.recoveryAttempts.length,state:this.camera.stateSnapshot?.()||{}});this.camera.markImageCaptureUnstable?.(`recovery:${reason}`);const video=document.querySelector('#fast-scan-video')||this.camera.video;
    const preparingOcr=this.prepareProductionOcr();
    try{this.devices=await this.camera.start(video,this.camera.deviceId);this.recoveryCount+=1;this.phase='scanning';this.cameraError='';this.scanState='LIVE';this.setStatus('Pronto allo scatto');this.debugTrace('camera:recovery-ready',{reason,state:this.camera.stateSnapshot?.()||{}});document.querySelector('[data-scan-restart-camera]')?.remove();this.refreshControls();this.schedule(250);}
    catch(error){this.scanState='CAMERA_ERROR';this.cameraError=error.message||String(reason);this.setStatus('Riavvia fotocamera');this.debugTrace('camera:recovery-failed',{reason,error:this.cameraError,state:this.camera.stateSnapshot?.()||{}});this.showRestartControl();}
    finally{this.recoveringCamera=false;}
  }
  async requestExit(){if(!this.hasScans)return this.exitToCollection();this.stopLoop();this.exitOpen=true;document.querySelector('[data-scan-exit-sheet]')?.classList.remove('hidden');}
  cancelExit(){this.exitOpen=false;document.querySelector('[data-scan-exit-sheet]')?.classList.add('hidden');if(this.phase==='scanning'&&this.camera.stream)this.schedule(120);}
  toggleManual(open){this.manualOpen=open;document.querySelector('[data-scan-manual-sheet]')?.classList.toggle('hidden',!open);if(open)this.stopLoop();else if(this.phase==='scanning'&&this.camera.stream)this.schedule(120);if(open)setTimeout(()=>document.querySelector('#scan-manual-code')?.focus(),0);}
  async openReview(){this.exitOpen=false;this.manualOpen=false;this.stopLoop();clearTimeout(this.backgroundStopTimer);this.backgroundCameraStopped=false;this.camera.stop('open-review');this.phase='review';await this.persist(true);this.onRoute?.('review');this.onRender();}
  async exitToCollection(){await this.leave();this.phase='setup';this.onRoute?.('collection');}
  async discardAndExit(){await this.discard(false);await this.exitToCollection();}
  async leave(){
    this.startRequestId+=1;this.stopLoop();clearTimeout(this.feedbackTimer);clearTimeout(this.persistTimer);clearTimeout(this.backgroundStopTimer);this.backgroundCameraStopped=false;this.camera.stop('leave-route');
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
    this.catalogIndex.clear();
    void syncCatalogIndex(this.api,game,{onRows:rows=>{if(this.startRequestId===requestId){this.catalogIndex.clear();this.mergeCatalogIndexRows(rows);}}}).catch(()=>{});
  }
  mergeCatalogIndexRows(rows){
    for(const row of rows||[]){const item=mapPrinting(row),code=String(item.setCode||'').toUpperCase();if(!code)continue;this.catalogIndex.set(code,dedupe([...(this.catalogIndex.get(code)||[]),item]));}
  }
  recentlyMissed(code){const at=this.missCache.get(code);return Boolean(at)&&Date.now()-at<MISS_CACHE_TTL;}
  lookupMemory(code){const key=String(code||'').toUpperCase();if(this.resolutionCache.has(key))return {matches:this.resolutionCache.get(key),source:'session-cache'};const indexed=this.catalogIndex.get(key)||[];if(indexed.length)return {matches:indexed,source:'catalog-index'};const local=this.localCatalog.get(key)||[];return local.length?{matches:local,source:'collection-cache'}:{matches:[],source:''};}
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
    if(allowRpc&&this.api?.lookupPrintings){const started=telemetry&&now();try{const rows=await boundedLookup(this.api.lookupPrintings(key,this.buffer.settings.game),this.lookupTimeoutMs);if(telemetry)telemetry.externalLookupMs+=now()-started;const matches=this.cacheResolution(key,(rows||[]).map(mapPrinting));if(matches.length)return {matches,source:'rpc'};}catch(error){if(telemetry)telemetry.externalLookupMs+=now()-started;if(error?.code==='LOOKUP_TIMEOUT')throw error;}}
    if(allowExternal&&this.externalLookup){const started=telemetry&&now();try{const matches=this.cacheResolution(key,await boundedLookup(this.externalLookup(key,this.buffer.settings.game),this.lookupTimeoutMs));if(telemetry)telemetry.externalLookupMs+=now()-started;if(matches.length)return {matches,source:'external'};}catch(error){if(telemetry)telemetry.externalLookupMs+=now()-started;if(error?.code==='LOOKUP_TIMEOUT')throw error;}}
    if(fullAttempt)this.missCache.set(key,Date.now());
    return memory.matches.length?memory:{matches:[],source:'not-found'};
  }
  async lookup(code,options){return (await this.lookupDetailed(code,options)).matches;}
  showDetection(code,detail,tone='ok'){const node=document.querySelector('[data-scan-detection]');if(node){const mark=tone==='error'?'✕':tone==='warn'?'!':'✓';node.innerHTML=`<strong>${mark} ${esc(code)}</strong><span>${esc(detail)}</span>`;node.classList.remove('ok','warn','error');node.classList.add('show',tone);}clearTimeout(this.feedbackTimer);this.feedbackTimer=setTimeout(()=>{node?.classList.remove('show','ok','warn','error');this.status='Pronto allo scatto';this.refreshHud();},1500);}
  chooseReview(id,index){if(!this.canEditSession())return;const item=this.buffer.review.find(entry=>entry.id===id);const match=item?.matches?.[index];if(!match)return;this.invalidateSync();this.buffer.add(match,'needs_review',item.warning,false);this.buffer.removeReview(id);this.persist();this.onRender();}
  async correctReview(id,code){if(!this.canEditSession())return;const buffer=this.buffer,item=buffer.review.find(entry=>entry.id===id);if(!item)return;item.pending=false;this.persist();try{const result=await this.resolve(code,100);if(this.buffer!==buffer||!buffer.review.includes(item))return;if(result.matches.length===1){this.invalidateSync();buffer.add(result.matches[0],'needs_review','Correzione manuale',false);buffer.removeReview(id);this.persist();this.onRender();}else this.onToast?.('Printing non trovata o ancora ambigua');}catch(error){this.onToast?.(error.message||'Verifica non disponibile: riprova');}}
  async save(){
    if(this.buffer.review.some(item=>item.pending)){this.onToast?.('Attendi le verifiche in corso prima di salvare');return;}
    if(this.saving||!this.buffer.entries.size||!this.isOnline())return;
    this.saving=true;this.onRender();let stage='canonicalization';
    const entries=[...this.buffer.entries.values()];
    this.debugTrace('save:buffer',{entries:entries.map(saveDiagnosticEntry),reviews:this.buffer.review.length,totalQuantity:this.buffer.total});
    try{
      const prepared=await canonicalizeFastScanEntries(entries);
      this.debugTrace('save:canonicalized',{repaired:prepared.repaired,decisions:prepared.decisions,entries:prepared.items.map(saveDiagnosticEntry)});
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
      stage='acknowledged';await this.disposeProductionOcr();this.buffer.clear();this.sync=null;this.hasRecovery=false;await clearScanSession();
      stage='refresh';try{await this.onSaved?.();this.debugTrace('save:refresh',{saveAccepted:true});}catch(error){this.debugTrace('save:refresh-failed',{saveAccepted:true,error:error?.message||String(error)});this.onToast?.('Raccolta salvata. Aggiornamento elenco rimandato.');}
      this.phase='setup';const repaired=prepared.repaired+repairAttempts;this.onToast?.(repaired?`Sessione salvata · ${repaired} identità canoniche aggiornate`:'Sessione salvata nella Raccolta');this.onRoute?.('collection');
    }catch(error){const reason=saveRejectionReason(error,stage);this.debugTrace('save:rejected',{saveAccepted:false,saveRejected:true,saveRejectionReason:reason,stage,error:error?.message||String(error),details:error?.details||null});this.onToast?.('Sincronizzazione interrotta. I tuoi scan sono salvati sul dispositivo.');}
    finally{this.saving=false;this.onRender();}
  }
  async discard(render=true){this.startRequestId+=1;this.stopLoop();clearTimeout(this.backgroundStopTimer);this.backgroundCameraStopped=false;this.camera.stop('discard-session');await this.disposeProductionOcr();this.buffer=new ScanSessionBuffer();this.sync=null;this.hasRecovery=false;this.exitOpen=false;this.manualOpen=false;await clearScanSession();this.phase='setup';if(render)this.onRender();}
  async switchCamera(){if(this.devices.length<2)return;const index=this.devices.findIndex(item=>item.deviceId===this.camera.deviceId);const next=this.devices[(index+1)%this.devices.length];this.camera.deviceId=next.deviceId;await this.start();}
  persist(now=false){clearTimeout(this.persistTimer);const save=()=>saveScanSession({...this.buffer.snapshot(),sync:this.sync});if(now)return save();this.persistTimer=setTimeout(()=>void save().catch(()=>{}),180);}
  feedback(){if(this.buffer.settings.vibration)navigator.vibrate?.(35);if(this.buffer.settings.sound)beep();}
  invalidateSync(){if(!this.sync?.chunks?.some(chunk=>chunk.status==='synced'))this.sync=null;}
  canEditSession(){const locked=this.sync?.chunks?.some(chunk=>chunk.status==='synced');if(locked)this.onToast?.('Sincronizzazione parziale: completa prima i blocchi mancanti.');return !locked;}
  exportSummary(){const payload={exportedAt:new Date().toISOString(),session:this.buffer.snapshot(),sync:this.sync};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`fpt-fast-scan-${this.sync?.batchId||Date.now()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),0);}
  setStatus(next){if(!next||next===this.status)return;this.status=next;this.refreshHud();}
  refreshHud(){const root=document,write=(node,value)=>{const text=String(value);if(node&&node.textContent!==text)node.textContent=text;};root.querySelectorAll('[data-scan-total-number]').forEach(el=>write(el,this.buffer.scanned));root.querySelectorAll('[data-scan-distinct]').forEach(el=>write(el,this.buffer.entries.size));root.querySelectorAll('[data-scan-review]').forEach(el=>write(el,this.buffer.review.length));write(root.querySelector('[data-scan-status]'),this.status);const last=root.querySelector('[data-scan-last]');if(last&&this.last){const html=`✓ <b>${esc(this.last.setCode)}</b> · +1`;if(last.innerHTML!==html)last.innerHTML=html;}}
  async snapshotFeedback(){this.scanState='CAPTURING';this.setStatus('Acquisito');const roi=document.querySelector('.live-roi');roi?.classList.add('captured');await delay(180);roi?.classList.remove('captured');}
  async scanOnce(){
    if(this.scanCycleInFlight)return;this.scanCycleInFlight=true;
    try{return await this.performScanOnce();}
    finally{this.scanCycleInFlight=false;if(this.forceSnapshot&&this.phase==='scanning'&&!this.exitOpen&&!this.manualOpen)this.schedule(0);}
  }
  async performScanOnce(){
    const captureSession=this.buffer,captureRequest=this.startRequestId;
    if(this.phase!=='scanning'||this.exitOpen||this.manualOpen||!this.camera.stream)return;
    // Keep a manual request pending until a real snapshot starts. Recovery,
    // autofocus and a temporarily unavailable frame must not eat the click.
    const forced=this.forceSnapshot;
    const initialIssue=this.camera.healthIssue?.();if(initialIssue){await this.recoverCamera(initialIssue);return;}
    if(this.camera.refocusing){this.setStatus('Messa a fuoco…');this.schedule(90);return;}
    const sampleStart=now();const roi=document.querySelector('.live-roi'),frame=this.camera.sample(roi);const sampleMs=now()-sampleStart;
    const sampledIssue=this.camera.healthIssue?.();if(sampledIssue){await this.recoverCamera(sampledIssue);return;}if(!frame){this.setStatus('Attendo la fotocamera…');this.schedule(250);return;}
    if(!forced){this.scanState='LIVE';this.schedule(250);return;}
    this.forceSnapshot=false;
    this.scanState='STABLE';
    this.lastCycleDecision=null;
    // Telemetria locale (mai inviata a Supabase): attiva solo con ?debugScan=1,
    // costo nullo altrimenti perché ogni punto di misura è un `if(telemetry)`
    // su un riferimento null. Vedi ScanTelemetry più sopra per la finestra
    // statistica di sessione mostrata nel pannello debug.
    const telemetry=this.debugMode?{cycleStart:this.captureRequestedAt||now(),sampleMs,snapshotMs:0,primaryPreprocessMs:0,primaryOcrMs:0,primaryResolveMs:0,fallbackPreprocessMs:0,fallbackOcrMs:0,fallbackResolveMs:0,externalLookupMs:0,commitMs:0,fallbackUsed:false,esito:'NOT_FOUND'}:null;
    this.cycleTelemetry=telemetry;
    this.snapshotInFlight=true;this.updateCaptureUi(true);let snapshot=null;try{
      this.setStatus('Scatto foto…');this.scanState='CAPTURING';const snapshotStart=now();
      await this.camera.waitForFreshFrame?.();
      snapshot=await this.camera.captureSnapshot(roi,{preferVideoFrame:true,includeRaw:true});
      // The guide is drawn over the video preview, so its exact pixels are the
      // authoritative crop. ImageCapture is only a fallback when no preview
      // frame is available because some mobile cameras return shifted frames.
      if(!snapshot)snapshot=await this.camera.captureSnapshot(roi,{preferVideoFrame:false,includeRaw:true});
      if(telemetry)telemetry.snapshotMs=now()-snapshotStart;
      if(!snapshot||this.phase!=='scanning'||this.exitOpen||this.manualOpen){if(!snapshot)await this.recordFailure();return;}
      this.lastPreprocessing=snapshot.preprocessing;void this.snapshotFeedback();if(this.phase!=='scanning'||this.exitOpen||this.manualOpen)return;
      const possiblyBlurred=(snapshot.preprocessing?.sharpness||0)<3;
      this.scanState='ANALYZING';this.setStatus('Analizzo codice…');this.ocrStatusShown=false;
      const planStart=now();const plan=createOcrInputPlan(snapshot);if(telemetry)telemetry.primaryPreprocessMs=now()-planStart;
      const productionReadings=[];try{
        this.renderDebugCrop(plan.primary.canvas,snapshot.mapping,'grayscale');
        const primaryOcrStart=now();const primary={...await this.recognizeProduction(plan.primary.canvas),preprocessing:plan.primary.preprocessing};if(telemetry)telemetry.primaryOcrMs=now()-primaryOcrStart;
        if(captureSession!==this.buffer||captureRequest!==this.startRequestId)return;
        const primaryCode=normalizeSetCode(primary.text);productionReadings.push(primary);let outcome=null;
        if(primaryCode.valid&&primary.confidence>=STRONG_OCR_CONFIDENCE){
          this.debugStartedAt=typeof performance!=='undefined'?performance.now():Date.now();
          const resolveStart=now();outcome=await this.resolveCapturedReading(primary);if(telemetry)telemetry.primaryResolveMs=now()-resolveStart;
          this.lastCycleDecision=outcome.decision||null;
        }
        if(!outcome){
          if(telemetry)telemetry.fallbackUsed=true;
          this.setStatus('Verifico lettura OCR…');
          const fallbackPlanStart=now();const fallbackPlan=plan.buildFallback();if(telemetry)telemetry.fallbackPreprocessMs=now()-fallbackPlanStart;
          this.renderDebugCrop(fallbackPlan.canvas,snapshot.mapping,'adaptive');
          const fallbackOcrStart=now();const fallback={...await this.recognizeProduction(fallbackPlan.canvas),preprocessing:fallbackPlan.preprocessing};if(telemetry)telemetry.fallbackOcrMs=now()-fallbackOcrStart;
          if(captureSession!==this.buffer||captureRequest!==this.startRequestId)return;
          productionReadings.push(fallback);
          const result=selectSnapshotOcrResult(productionReadings);
          this.lastPreprocessing=result?.preprocessing||snapshot.preprocessing;
          if(result?.text){const conflicting=productionReadings.some(reading=>normalizeSetCode(reading.text).valid&&normalizeSetCode(reading.text).code!==normalizeSetCode(result.text).code);outcome=await this.resolveCapturedReading(result,{requireReview:conflicting||result.confidence<STRONG_OCR_CONFIDENCE});this.lastCycleDecision=outcome?.decision||null;}
          else await this.recordFailure();
        }
        if(forced&&(!outcome||outcome.status==='not_found')){const read=ocrReadingSummary(productionReadings);this.setStatus(read?`OCR ha letto: ${read}${possiblyBlurred?' · foto poco nitida':''}`:`OCR non ha rilevato testo${possiblyBlurred?' · foto poco nitida':''}`);}
        if(telemetry)telemetry.esito=esitoFromOutcome(outcome);
      }finally{plan.release();}
    }catch(error){const issue=this.camera.healthIssue?.();if(issue)await this.recoverCamera(issue);else if(error?.message!=='refocus-in-progress')this.setStatus(error.message||'OCR non disponibile');}
    finally{
      snapshot?.release?.();snapshot=null;this.snapshotInFlight=false;this.updateCaptureUi(false);
      if(this.phase==='scanning'&&!this.exitOpen&&!this.manualOpen){
        this.scanState='LIVE';
        // Un EXACT_UNIQUE netto non ha bisogno dei 250ms decorativi: la
        // fotocamera può tornare pronta per la carta successiva quasi subito.
        // Su esito incerto/review teniamo il margine pieno.
        const nextDelay=this.lastCycleDecision==='EXACT_UNIQUE'?90:250;
        if(telemetry){telemetry.cycleTotalMs=now()-telemetry.cycleStart;telemetry.readyNextMs=telemetry.cycleTotalMs;delete telemetry.cycleStart;this.telemetry.record(telemetry);this.debugTrace('telemetry:cycle',telemetry);this.renderDebugStats();}
        this.schedule(nextDelay);
      }
      this.cycleTelemetry=null;
    }
  }
  requestSnapshot(){if(this.exitOpen||this.manualOpen){this.setStatus('Chiudi la finestra aperta prima dello scatto');return;}if(this.phase!=='scanning'||!this.camera.stream){this.setStatus('Fotocamera non pronta · riavvia lo scanner');return;}if(this.snapshotInFlight){this.setStatus('Elaborazione snapshot in corso…');return;}this.captureRequestedAt=now();this.forceSnapshot=true;this.stopLoop();this.setStatus(this.scanCycleInFlight?'Attendo analisi corrente…':'Scatto manuale…');if(!this.scanCycleInFlight)this.schedule(0);}
  updateCaptureUi(busy){const button=document.querySelector('[data-scan-capture]');if(!button)return;button.disabled=busy;const label=button.querySelector('span');if(label)label.textContent=busy?'Elaborazione…':'Scatta e analizza';}
  renderDebugCrop(source,mapping={},mode='grayscale'){
    if(!this.debugMode||!source?.width||!source?.height)return;const canvas=document.querySelector('[data-scan-debug-crop]'),label=document.querySelector('[data-scan-debug-geometry]');if(!canvas)return;canvas.width=source.width;canvas.height=source.height;const context=canvas.getContext('2d');context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(source,0,0);const crop=mapping.snapshotCrop||mapping.crop||{};if(label)label.textContent=`${mode} · ${source.width}×${source.height} · source ${crop.sx||0},${crop.sy||0} ${crop.sw||0}×${crop.sh||0}`;
  }
  renderDebugStats(){
    if(!this.debugMode)return;const node=document.querySelector('[data-scan-debug-stats]');if(!node)return;
    const summary=this.telemetry.summary();
    node.textContent=summary?`${summary.count} scan · media ${summary.meanMs.toFixed(0)}ms · p50 ${summary.p50Ms.toFixed(0)}ms · p95 ${summary.p95Ms.toFixed(0)}ms · fallback ${Math.round(summary.fallbackRate*100)}% · rete ${Math.round(summary.externalRate*100)}%`:'In attesa di scan misurati';
  }
  async recordFailure(catalogMiss=false){
    this.consensus.miss();this.gate.miss();this.failureStreak+=1;
    if(this.failureStreak>=4){this.failureStreak=0;this.camera.clearPreprocessingPreference?.();const focused=await this.camera.refocus();this.setStatus(focused?'Messa a fuoco…':this.camera.focusSupported?'Tocca per mettere a fuoco':'Avvicina la carta');}
    else this.setStatus(catalogMiss?'Codice non trovato · controlla la review':'Codice non letto · riprova lo scatto');
  }
  async refocus(){const focused=await this.camera.refocus();this.setStatus(focused?'Messa a fuoco…':'Avvicina la carta');if(focused)setTimeout(()=>{if(this.phase==='scanning')this.setStatus('Pronto allo scatto');},650);}
  async resolveCapturedReading(reading,{requireReview=false}={}){
    const normalized=normalizeSetCode(reading.text);
    if(!normalized.valid){await this.recordFailure();return {status:'not_found'};}
    const code=normalized.code,buffer=this.buffer;
    const memory=this.lookupMemory(code);
    const verified=['session-cache','catalog-index'].includes(memory.source);
    const finish=async(result,pendingId=null)=>{
      if(this.buffer!==buffer||(pendingId&&!buffer.review.some(item=>item.id===pendingId&&item.pending)))return;
      if(requireReview&&result.matches?.length)result={...result,status:'needs_review',warning:'Lettura OCR incerta: conferma il codice'};
      await this.commitResolution(result,reading.text,false,pendingId);
    };
    this.consensus.reset();this.failureStreak=0;
    if(verified){
      const result={...classifyPrintingMatch({normalized,matches:memory.matches}),code,ocrConfidence:reading.confidence,lookupSource:memory.source};
      await finish(result);return requireReview?{...result,status:'needs_review'}:result;
    }
    // Each deliberate capture gets its own persisted row, including identical copies.
    const pendingId=crypto.randomUUID();
    buffer.queueReview({id:pendingId,raw:reading.text,code,status:'pending',matches:[],ocrConfidence:reading.confidence,warning:'Verifica in corso…',pending:true});
    try{await this.persist(true);}catch(error){buffer.updateReview(pendingId,{pending:false,status:'needs_review',warning:'Salvataggio locale fallito: verifica questa scansione'});this.refreshHud();throw error;}
    if(this.buffer!==buffer)return {status:'cancelled'};
    this.setStatus('Codice acquisito · verifica in corso');this.refreshHud();
    const task=async()=>{
      if(this.buffer!==buffer||!buffer.review.some(item=>item.id===pendingId&&item.pending))return;
      try{await finish(await this.resolve(code,reading.confidence,{consensus:1}),pendingId);}
      catch{if(this.buffer===buffer&&buffer.review.some(item=>item.id===pendingId&&item.pending)){buffer.updateReview(pendingId,{pending:false,status:'needs_review',warning:'Verifica fallita: correggi o riprova il codice'});this.persist();if(this.phase==='review')this.onRender?.();else this.refreshHud();}}
    };
    this.pendingResolution=new Promise(resolve=>{this.backgroundQueue.push(async()=>{try{await task();}finally{resolve();}});this.drainBackgroundQueue();});
    return {status:'pending_async',code};
  }
  async processRecognition(raw,ocrConfidence=0,signature=[],preprocessing={},options={}){
    const telemetry=this.cycleTelemetry;
    this.debugStartedAt=typeof performance!=='undefined'?performance.now():Date.now();
    const evidence=this.consensus.observe(raw,ocrConfidence);
    this.debugTrace('ocr',{raw,ocrConfidence,candidate:evidence.code||'',votes:evidence.votes||0});
    if(!evidence.valid){const near=normalizeSetCode(raw).code;this.debugTrace('resolution:rejected',{rawOcr:raw,normalizedOcr:near,parsedCode:'',candidateCodes:[],catalogMatches:[],accepted:false,rejectionReason:'INVALID_FORMAT'});if(near.includes('-')&&near.length>=5&&near.length<=24)this.camera.preferPreprocessing?.(preprocessing.mode);await this.recordFailure();return {status:'not_found'};}
    if(!evidence.ready&&!evidence.strong){
      if(options.catalogConfirm){
        let started=now();const confirmed=await this.resolve(evidence.code,evidence.confidence,{consensus:evidence.votes});if(telemetry)telemetry.fallbackResolveMs+=now()-started;
        if(confirmed.status!=='not_found'){this.gate.accept(confirmed.code,signature,Date.now());this.consensus.reset();this.failureStreak=0;started=now();await this.commitResolution(confirmed,raw);if(telemetry)telemetry.commitMs+=now()-started;this.camera.clearPreprocessingPreference?.();return confirmed;}
        this.consensus.reset();started=now();await this.commitResolution(confirmed,raw,true);if(telemetry)telemetry.commitMs+=now()-started;return confirmed;
      }
      let started=now();const fast=await this.resolveFast(evidence.code,evidence.confidence,{consensus:evidence.votes});if(telemetry)telemetry.fallbackResolveMs+=now()-started;
      if(fast.status==='high_confidence'){if(!this.gate.consider(fast.code,signature)){this.debugTrace('resolution:rejected',{rawOcr:raw,parsedCode:fast.code,accepted:false,rejectionReason:'DUPLICATE_DEBOUNCE'});return {status:'duplicate_blocked'};}this.consensus.reset();this.failureStreak=0;started=now();await this.commitResolution(fast,raw);if(telemetry)telemetry.commitMs+=now()-started;this.camera.clearPreprocessingPreference?.();return fast;}
      this.camera.preferPreprocessing?.(preprocessing.mode);this.setStatus(`Conferma lettura ${evidence.votes}/2`);return {status:'pending_consensus',code:evidence.code};
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
    this.consensus.reset();this.failureStreak=0;started=now();await this.commitResolution(result,raw);if(telemetry)telemetry.commitMs+=now()-started;this.camera.clearPreprocessingPreference?.();return result;
  }
  enqueueBackgroundResolution(raw,ocrConfidence,consensusVotes,pendingId,pendingCode){
    return new Promise(resolve=>{
      this.backgroundQueue.push(async()=>{await this.resolvePendingInBackground(raw,ocrConfidence,consensusVotes,pendingId,pendingCode);resolve();});
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
  async resolvePendingInBackground(raw,ocrConfidence,consensusVotes,pendingId,pendingCode){
    try{
      const result=await this.resolve(raw,ocrConfidence,{consensus:consensusVotes});
      await this.commitResolution(result,raw,false,pendingId);
    }catch{
      this.buffer.updateReview(pendingId,{status:'not_found',warning:'Verifica fallita · correggi manualmente',pending:false});
      this.persist();if(this.phase==='review')this.onRender?.();else this.refreshHud();
    }
    finally{this.pendingCodes.delete(pendingCode);}
  }
  async processManual(raw){const normalized=normalizeSetCode(raw);if(!normalized.valid){this.onToast?.('Formato printing code non valido');return;}const buffer=this.buffer;try{const result=await this.resolve(raw,100,{manual:true,consensus:2});if(this.buffer===buffer)await this.commitResolution(result,raw,true);}catch(error){this.onToast?.(error.message||'Verifica non disponibile: riprova');}}
  async resolveFast(raw,ocrConfidence,{consensus=0,manual=false}={}){
    const candidates=setCodeCandidates(raw),plausibleCandidateCount=Math.max(1,extractSetCodeCandidates(raw).length);if(!candidates.length)return {status:'not_found',code:'',matches:[],ocrConfidence};const exact=candidates[0],hit=this.lookupMemory(exact.code);
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
    const corrected=candidates.slice(1).map(candidate=>({candidate,...this.lookupMemory(candidate.code)})).filter(item=>item.matches.length);
    if(!corrected.length)return {status:'not_found',code:exact.code,matches:[],ocrConfidence,consensus,fastMiss:true};const matches=dedupe(corrected.flatMap(item=>item.matches)),code=corrected.length===1?corrected[0].candidate.code:exact.code;
    const classified=classifyNearPrintingMatch(corrected,{plausibleCandidateCount});return {...classified,code:classified.code||code,matches,ocrConfidence,corrected:true,consensus,alternatives:classified.alternatives,lookupSource:corrected[0].source};
  }
  async resolve(raw,ocrConfidence,{consensus=0,manual=false,exactOnly=false}={}){
    const candidates=setCodeCandidates(raw),plausibleCandidateCount=Math.max(1,extractSetCodeCandidates(raw).length);if(!candidates.length)return {status:'not_found',code:'',matches:[],ocrConfidence};
    const fast=await this.resolveFast(raw,ocrConfidence,{consensus,manual});if(!fast.fastMiss&&!fast.corrected)return fast;
    const exact=candidates[0],exactLookup=await this.lookupDetailed(exact.code,{allowExternal:!exactOnly});
    if(exactLookup.matches.length){const classified=classifyPrintingMatch({normalized:normalizeSetCode(exact.code),matches:exactLookup.matches,ocrConfidence,consensus,manual});return {...classified,code:exact.code,ocrConfidence,corrected:false,consensus,lookupSource:exactLookup.source};}
    if(exactOnly)return {status:'not_found',code:exact.code,matches:[],ocrConfidence,consensus}; if(!fast.fastMiss&&fast.corrected)return fast;
    let corrected=(await Promise.all(candidates.slice(1,9).map(async candidate=>({candidate,...await this.lookupDetailed(candidate.code,{allowExternal:false})})))).filter(item=>item.matches.length);
    if(!corrected.length&&this.externalLookup){const external=await Promise.all(candidates.slice(1,5).map(async candidate=>({candidate,...await this.lookupDetailed(candidate.code,{allowRpc:false,allowExternal:true})})));corrected=external.filter(item=>item.matches.length);}
    if(!corrected.length)return {status:'not_found',code:exact.code,matches:[],ocrConfidence,consensus};
    const matches=dedupe(corrected.flatMap(item=>item.matches)),classified=classifyNearPrintingMatch(corrected,{plausibleCandidateCount}),code=classified.code||(corrected.length===1?corrected[0].candidate.code:exact.code);
    return {...classified,code,matches,ocrConfidence,corrected:true,consensus,alternatives:classified.alternatives,lookupSource:corrected[0].source};
  }
  async commitResolution(result,raw,manual=false,pendingId=null){
    if(pendingId&&!this.buffer.review.some(item=>item.id===pendingId&&item.pending))return;
    const normalized=normalizeSetCode(raw),candidateCodes=setCodeCandidates(raw).map(item=>item.code),selected=result.matches?.[0]||null,accepted=result.status==='high_confidence'&&(result.decision==='EXACT_UNIQUE'||result.decision==='NEAR_UNIQUE'||manual),rejectionReason=result.status==='not_found'?'NO_CATALOG_MATCH':result.matches?.length>1?'MULTIPLE_CATALOG_MATCHES':accepted?'':result.corrected?'LOW_CONFIDENCE':'VALIDATION_FAILED';
    this.debugTrace('catalog',{rawOcr:raw,normalizedOcr:normalized.code,parsedCode:result.code||normalized.code,candidateCodes,catalogMatches:(result.matches||[]).map(saveDiagnosticEntry),selectedCatalogEntry:selected?saveDiagnosticEntry(selected):null,printingId:selected?.printingId||selected?.printing_id||'',printingKey:selected?[selected.game||'yugioh',selected.catalogCardId||selected.catalog_card_id||'',selected.setCode||selected.set_code||'',selected.rarity||''].join(':'):'',validationResult:result.decision||result.status,accepted,rejected:!accepted,rejectionReason,source:result.lookupSource||'',timingMs:Math.round((typeof performance!=='undefined'?performance.now():Date.now())-(this.debugStartedAt||0)),pending:Boolean(pendingId)});
    // pendingId identifica una risoluzione in background: la carta non è
    // più sotto l'obiettivo (l'operatore può aver già scansionato altro), va
    // solo aggiornata nella review — niente flash "Codice rilevato",
    // vibrazione o riscrittura di this.last, che sono feedback per l'istante
    // dello scatto e qui arriverebbero fuori tempo. Il rendering pieno della
    // review scatta solo se l'utente la sta già guardando (fase 'review');
    // durante lo scan dal vivo aggiorniamo solo i contatori HUD per non
    // toccare/ricreare il DOM della fotocamera.
    if(result.status==='not_found'){
      if(pendingId){this.buffer.updateReview(pendingId,{status:'not_found',warning:'Codice non trovato nel catalogo',pending:false});this.persist();if(this.phase==='review')this.onRender?.();else this.refreshHud();return;}
      // Questo ramo (non-pendingId) è raggiungibile SOLO quando un codice è
      // stato letto correttamente (catalogConfirm/processManual validano
      // raw/evidence.code PRIMA di chiamare resolve(): "OCR non ha letto
      // nulla" è già intercettato più a monte, riga ~301 evidence.valid, e
      // non arriva mai qui) — quindi è sempre un catalog miss (codice letto,
      // nessun match), MAI un "codice non letto". Prima di questo fix
      // mostrava comunque il wording del caso "non letto"
      // ('Codice non letto · riprova o usa Manuale'), la stessa confusione
      // fra i due casi elencata nelle priorità P0 Fast Scan di oggi. Il
      // Boolean(result.code) resta comunque la guardia esplicita (mai
      // assunto implicitamente) nel caso quell'invariante cambi in futuro.
      const catalogMiss=Boolean(result.code);
      this.status=catalogMiss?'Codice non trovato · controlla la review':'Codice non letto · riprova o usa Manuale';
      this.showDetection(catalogMiss?'Nessun match':'Codice non letto',catalogMiss?'Verifica manuale':'Riprova','error');this.refreshHud();return;
    }
    if(!pendingId)this.scanState='RESULT';
    const mustAutoAdd=result.decision==='EXACT_UNIQUE'||(result.decision==='NEAR_UNIQUE'&&this.buffer.settings.autoAdd)||manual;
    if(result.status==='high_confidence'&&mustAutoAdd){
      const entry=this.buffer.add(result.matches[0],result.decision||'high_confidence','',!pendingId);
      if(pendingId){this.buffer.removeReview(pendingId);this.persist();if(this.phase==='review')this.onRender?.();else this.refreshHud();return;}
      this.last=entry;this.feedback();this.status='Codice rilevato';this.persist();this.showDetection(entry.setCode,'+1');this.refreshHud();return;
    }
    const warning=result.warning||(result.corrected?'Correzione OCR da confermare':'Match da confermare');
    if(pendingId){this.buffer.updateReview(pendingId,{code:result.code,status:result.status,matches:result.matches,ocrConfidence:result.ocrConfidence,warning,pending:false});this.persist();if(this.phase==='review')this.onRender?.();else this.refreshHud();return;}
    this.buffer.queueReview({raw,code:result.code,status:result.status,matches:result.matches,ocrConfidence:result.ocrConfidence,warning});this.status='Codice da verificare';this.persist();this.showDetection(result.code,'Da verificare','warn');this.refreshHud();
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

export async function canonicalizeFastScanEntries(entries=[],lookupPrintings=async()=>[],resolveCanonicalCard=async()=>null) {
  const items=[],decisions=[];let repaired=0;
  for(const entry of entries){
    const base=batchItem(entry);
    if(base.printingId){items.push(base);decisions.push(canonicalDecision(base,'EXISTING_PRINTING_ID'));continue;}
    if(!base.setCode||!base.cardName||!base.catalogCardId)throw saveError('INVALID_RPC_PAYLOAD',`Sessione precedente non compatibile: dati printing incompleti per ${base.setCode||base.cardName||'una carta'}`,base);
    let rows=[],lookupFailure='';try{rows=await lookupPrintings(base.setCode,base.game);}catch(error){lookupFailure=error?.message||'lookup_failed';}
    const candidates=(rows||[]).map(mapPrinting).filter(item=>item.printingId&&sameText(item.setCode,base.setCode)&&item.game===base.game);
    if(!candidates.length){
      if(base.game==='yugioh'){
        let card=null,resolverFailure='';try{card=await resolveCanonicalCard({id:'',name:base.cardName,setCode:base.setCode},base.game);}catch(error){resolverFailure=error?.message||'resolver_failed';}
        if(card){const setMatch=(card.printings||[]).some(printing=>sameText(printing.setCode,base.setCode)),legacyArtwork=(card.imageIds||[]).includes(String(base.catalogCardId));if(!sameText(card.name,base.cardName)||(!setMatch&&!legacyArtwork))throw saveError('CATALOG_IDENTITY_MISMATCH',`Identità printing incoerente per ${base.setCode}: il catalogo non conferma la carta`,{base,cardId:card.id||'',cardName:card.name||''});const canonicalId=String(card.id||'');if(!canonicalId)throw saveError('PRINTING_CANONICALIZATION_FAILED',`Identità printing incompleta per ${base.setCode}`,base);const canonical={...base,catalogCardId:canonicalId,cardName:card.name,imageUrl:card.fullImage||card.image||base.imageUrl};items.push(canonical);decisions.push(canonicalDecision(canonical,'CANONICAL_CATALOG_ID',{lookupFailure}));if(canonicalId!==base.catalogCardId)repaired+=1;continue;}
        items.push(base);decisions.push(canonicalDecision(base,'RPC_VALIDATION_REQUIRED',{lookupFailure,resolverFailure:resolverFailure||'catalog_unavailable'}));continue;
      }
      items.push(base);decisions.push(canonicalDecision(base,'RPC_VALIDATION_REQUIRED',{lookupFailure}));continue;
    }
    const ranked=candidates.map(item=>({item,score:canonicalCompatibilityScore(base,item)})).filter(item=>item.score>0).sort((left,right)=>right.score-left.score),best=ranked[0],ties=best?ranked.filter(item=>item.score===best.score):[];
    if(!best||ties.length!==1)throw saveError('AMBIGUOUS_PRINTING',`Identità printing ambigua o incoerente per ${base.setCode}: verifica la carta prima di salvare`,{base,candidates:candidates.map(saveDiagnosticEntry)});
    const canonical=best.item,item={...base,printingId:canonical.printingId,game:canonical.game,catalogCardId:canonical.catalogCardId,cardName:canonical.cardName,setCode:canonical.setCode,setName:canonical.setName,rarity:canonical.rarity,imageUrl:canonical.imageUrl};items.push(item);decisions.push(canonicalDecision(item,'CANONICAL_PRINTING_ID'));repaired+=1;
  }
  return {items,repaired,decisions};
}

export async function saveFastScanBatchWithRepair(items=[],saveBatch,repairEntries,{maxRepairs=8}={}){
  let payload=items.map(item=>({...item})),repairAttempts=0;const repairedSetCodes=[];
  while(true){
    try{return {rpcResult:await saveBatch(payload),payload,repairAttempts,repairedSetCodes};}
    catch(error){const setCode=catalogMismatchSetCode(error);if(!setCode||repairAttempts>=maxRepairs||repairedSetCodes.includes(setCode))throw error;const indexes=[];for(let index=0;index<payload.length;index++)if(!payload[index].printingId&&sameText(payload[index].setCode,setCode))indexes.push(index);if(!indexes.length)throw error;const before=indexes.map(index=>payload[index]),repaired=await repairEntries(before,setCode),next=repaired?.items||[];if(next.length!==before.length||!next.some((item,index)=>canonicalIdentityChanged(before[index],item)))throw error;indexes.forEach((payloadIndex,index)=>{payload[payloadIndex]=next[index];});repairAttempts+=1;repairedSetCodes.push(setCode);}
  }
}

function batchItem(entry){return {printingId:entry.printingId||'',game:entry.game||'yugioh',catalogCardId:String(entry.catalogCardId||''),cardName:String(entry.cardName||''),setCode:String(entry.setCode||'').trim().toUpperCase(),setName:entry.setName||'',rarity:entry.rarity||'',imageUrl:entry.imageUrl||'',quantityDelta:Number(entry.quantity??entry.quantityDelta??0),language:entry.language||'Italiano',condition:entry.condition||'Near Mint',edition:entry.edition||''};}
function canonicalDecision(item,validationResult,extra={}){return {setCode:item.setCode,printingId:item.printingId||'',cardId:item.catalogCardId||'',catalogIdentity:[item.game,item.catalogCardId,item.setCode,item.rarity].join(':'),validationResult,...extra};}
function saveDiagnosticEntry(item){return {printingId:item.printingId||'',cardId:item.catalogCardId||item.catalog_card_id||'',setCode:item.setCode||item.set_code||'',cardName:item.cardName||item.card_name||'',rarity:item.rarity||'',quantity:Number(item.quantity??item.quantityDelta??0),catalogIdentity:[item.game||'yugioh',item.catalogCardId||item.catalog_card_id||'',item.setCode||item.set_code||'',item.rarity||''].join(':')};}
function saveError(code,message,details){const error=new Error(message);error.code=code;error.details=details;return error;}
function saveRejectionReason(error,stage){if(error?.code&&['INVALID_RPC_PAYLOAD','PRINTING_CANONICALIZATION_FAILED','AMBIGUOUS_PRINTING','CATALOG_IDENTITY_MISMATCH'].includes(error.code))return error.code;if(stage==='rpc'){const message=String(error?.message||'');if(/inventory|collection_items|quantit/i.test(message))return 'INVENTORY_WRITE_FAILED';return 'RPC_REJECTED';}if(stage==='refresh')return 'UI_REFRESH_FAILED';return 'PRINTING_CANONICALIZATION_FAILED';}
function catalogMismatchSetCode(error){return String(error?.message||'').match(/Dati catalogo incoerenti per\s+([A-Z0-9-]+)/i)?.[1]?.toUpperCase()||'';}
function canonicalIdentityChanged(before,after){return ['printingId','catalogCardId','cardName','setCode','setName','rarity','imageUrl'].some(field=>String(before?.[field]||'')!==String(after?.[field]||''));}
function canonicalCompatibilityScore(entry,candidate){const sameId=String(entry.catalogCardId)===String(candidate.catalogCardId),sameName=sameText(entry.cardName,candidate.cardName),sameRarity=!entry.rarity||!candidate.rarity||sameText(entry.rarity,candidate.rarity);if(!sameName)return 0;return (sameId?8:0)+4+(sameRarity?2:0);}
function sameText(left,right){return String(left||'').normalize('NFKC').trim().toLocaleLowerCase('en')===String(right||'').normalize('NFKC').trim().toLocaleLowerCase('en');}

export function selectSnapshotOcrResult(readings=[],{avoidCode=''}={}){
  const available=[...readings].filter(Boolean),alternatives=avoidCode?available.filter(reading=>{const normalized=normalizeSetCode(reading?.text||'');return normalized.valid&&normalized.code!==avoidCode;}):[];
  return (alternatives.length?alternatives:available).sort((left,right)=>ocrReadingScore(right)-ocrReadingScore(left))[0]||null;
}
function ocrReadingScore(reading){const normalized=normalizeSetCode(reading?.text||''),near=normalized.code.includes('-')&&normalized.code.length>=5;return (normalized.valid?10000:near?1000:0)+(Number(reading?.confidence)||0);}
function ocrReadingSummary(readings=[]){const values=readings.map(reading=>String(reading?.text||'').replace(/\s+/g,'').replace(/[^A-Z0-9-]/gi,'').toUpperCase()).filter(Boolean);return [...new Set(values)].join(' / ').slice(0,48);}
function toggle(id,label,checked){return `<label class="scan-toggle"><input id="${id}" type="checkbox" ${checked?'checked':''}><span><strong>${label}</strong><small>${checked?'Attivo':'Disattivato'}</small></span></label>`;}
function entryRow(item){const firstEdition=isFirstEdition(item.edition);return `<article class="scan-review-row"><div>${item.imageUrl?`<img src="${esc(item.imageUrl)}" alt="">`:icon('card')}<span><strong>${esc(item.cardName)}</strong><small>${esc([item.setCode,item.rarity,item.confidence,item.warning].filter(Boolean).join(' · '))}</small></span></div><div class="scan-review-controls"><div class="scan-qty-stepper"><button type="button" data-scan-qty-dec="${esc(item.key)}" aria-label="Diminuisci quantità">−</button><b>${item.quantity}</b><button type="button" data-scan-qty-inc="${esc(item.key)}" aria-label="Aumenta quantità" ${item.quantity>=999?'disabled':''}>+</button></div><button type="button" class="scan-first-edition-toggle ${firstEdition?'active':''}" data-scan-first-edition="${esc(item.key)}" aria-pressed="${firstEdition}">1ª Ed.</button><button class="btn secondary danger small" data-scan-remove="${esc(item.key)}">Rimuovi</button></div></article>`;}
function reviewRow(item){
  // An ignored pending row cannot be resurrected by a late background result.
  if(item.pending)return `<article class="scan-review-row warning pending"><div>${icon('bell')}<span><strong>${esc(item.code||item.raw||'Codice non riconosciuto')}</strong><small>${esc(item.warning||'Verifica in corso…')}</small></span></div><button class="btn secondary small" data-review-ignore="${item.id}">Ignora</button></article>`;
  return `<article class="scan-review-row warning"><div>${icon('bell')}<span><strong>${esc(item.code||item.raw||'Codice non riconosciuto')}</strong><small>${esc([item.warning,item.ocrConfidence?`confidence ${Math.round(item.ocrConfidence)}%`:''].filter(Boolean).join(' · '))}</small></span></div>${item.matches?.length?`<div class="review-choices">${item.matches.map((match,index)=>`<button class="btn secondary small" data-review-choice="${index}" data-review-id="${item.id}">${esc(match.cardName)} · ${esc(match.rarity||'Rarità non indicata')}</button>`).join('')}</div>`:`<div class="review-correction"><input data-review-input="${item.id}" value="${esc(item.code||'')}" placeholder="Correggi codice"><button class="btn secondary small" data-review-correct="${item.id}">Cerca</button></div>`}<button class="btn secondary small" data-review-ignore="${item.id}">Ignora</button></article>`;
}
function mapPrinting(row){return {printingId:row.printing_id||row.printingId||'',game:row.game||'yugioh',catalogCardId:String(row.catalog_card_id||row.catalogCardId||''),cardName:row.card_name||row.cardName,setCode:row.set_code||row.setCode,setName:row.set_name||row.setName||'',rarity:row.rarity||'',imageUrl:row.image_url||row.imageUrl||''};}
function dedupe(items){return [...new Map(items.map(item=>[[item.printingId,item.catalogCardId,item.setCode,item.rarity].join(':'),item])).values()];}
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
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function touchDistance(touches){const x=touches[0].clientX-touches[1].clientX,y=touches[0].clientY-touches[1].clientY;return Math.hypot(x,y);}
function beep(){try{const Audio=window.AudioContext||window.webkitAudioContext;const context=new Audio();const oscillator=context.createOscillator();const gain=context.createGain();oscillator.frequency.value=720;gain.gain.value=.025;oscillator.connect(gain).connect(context.destination);oscillator.start();oscillator.stop(context.currentTime+.055);oscillator.onended=()=>context.close();}catch{}}
