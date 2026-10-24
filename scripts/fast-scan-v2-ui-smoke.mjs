// Fast Scan v2 (2026-10-24): le viste nuove mantengono tutti gli agganci da
// cui dipende la logica (data-scan-*, .live-roi per il ritaglio OCR), lo stato
// colora il mirino e gli errori di lettura spiegano il motivo probabile.
import assert from 'node:assert/strict';
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };
const nodes = new Map();
globalThis.document ??= { addEventListener() {}, querySelector: selector => nodes.get(selector) || null, querySelectorAll: () => [] };
const { FastScanController, captureHint } = await import('../js/fast-scan.js');

const card = { printingId: 'p1', game: 'yugioh', catalogCardId: '1', cardName: 'Dark Time Wizard', setCode: 'BETB-IT052', rarity: 'Ultra Rare', imageUrl: 'https://images.ygoprodeck.com/images/cards/40235813.jpg' };
const c = new FastScanController({ camera: { stream: {}, stop() {}, focusSupported: false, torchSupported: true }, paddleOcr: { prepare: async () => {} }, isOnline: () => true, onRender() {}, onRoute() {}, onToast() {} });

// Avvio: impostazioni con gli stessi id letti da readSettings(), avvio e manuale.
const setup = c.setupView();
for (const hook of ['id="fast-scan-settings"', 'id="scan-language"', 'id="scan-condition"', 'id="scan-edition"', 'id="scan-auto"', 'id="scan-vibration"', 'id="scan-sound"', 'data-scan-manual-start', 'data-scan-setup-back']) assert.ok(setup.includes(hook), `avvio senza ${hook}`);

// Scanner: agganci della logica e foglio impostazioni con gli stessi id.
c.phase = 'scanning';
let live = c.scannerView();
for (const hook of ['class="live-roi"', 'data-scan-capture', 'data-scan-history-review', 'data-scan-total-number', 'data-scan-assistant', 'data-scan-detection', 'data-scan-background-result', 'data-scan-status', 'data-scan-torch', 'data-scan-switch-camera', 'data-scan-manual-open', 'data-scan-undo', 'data-scan-back', 'data-scan-exit-sheet', 'data-scan-manual-sheet', 'data-scan-settings-sheet', 'data-scan-settings-open', 'id="scan-language"', 'class="live-controls"', 'class="live-scan-content"']) assert.ok(live.includes(hook), `scanner senza ${hook}`);
assert.match(live, /data-state="idle"/, 'stato iniziale del mirino');
assert.match(live, /data-scan-undo disabled/, 'annulla disabilitato senza scansioni');
assert.match(live, /data-scan-settings-summary>IT · NM</, 'riepilogo sessione compatto');
assert.match(live, /<b data-scan-total-number>0<\/b> <span data-scan-total-label>carte<\/span>/);

c.buffer.add(card);
live = c.scannerView();
assert.match(live, /<b data-scan-total-number>1<\/b> <span data-scan-total-label>carta<\/span>/, 'singolare con una carta');
assert.ok(live.includes(card.imageUrl), 'miniatura dell\'ultima carta nel tray');
assert.doesNotMatch(live, /data-scan-undo disabled/, 'annulla attivo dopo una scansione');

// Lo stato segue l'esito.
c.detection = { tone: 'ok', code: card.setCode, detail: 'Aggiunta', card }; assert.equal(c.hudState(), 'ok');
c.detection = { tone: 'error', code: 'X', detail: 'Codice non letto' }; assert.equal(c.hudState(), 'error');
c.detection = null; c.snapshotInFlight = true; assert.equal(c.hudState(), 'busy');
c.snapshotInFlight = false; c.cameraError = 'Fotocamera non disponibile'; assert.equal(c.hudState(), 'error');
c.cameraError = 'Modalità manuale'; assert.equal(c.hudState(), 'idle', 'la modalità manuale non è un errore');
c.cameraError = '';

// Riscontro: il badge dell'esito resta nel contenuto rilevato.
assert.match(c.detectionContent({ tone: 'ok', code: card.setCode, detail: 'Aggiunta', card }), /class="fsx-mark"[^>]*>✓<\/i><div><strong>Aggiunta<\/strong><span>Dark Time Wizard<\/span>/);

// Revisione: righe con quantità/1ª Ed./rimozione, testo del salvataggio.
c.phase = 'review';
const review = c.reviewView();
for (const hook of ['data-scan-qty-inc', 'data-scan-qty-dec', 'data-scan-first-edition', 'data-scan-remove', 'data-scan-save', 'data-scan-continue', 'scan-review-row']) assert.ok(review.includes(hook), `revisione senza ${hook}`);
assert.match(review, /Aggiungi 1 carta alla raccolta/);

// Foglio impostazioni aperto: nessuno scatto parte dietro al foglio, e il tasto
// indietro lo chiude invece di aprirci sopra "Hai finito?".
c.phase = 'scanning'; c.toggleSettings(true);
assert.equal(c.settingsOpen, true);
c.requestSnapshot();
assert.equal(c.status, 'Chiudi la finestra aperta prima dello scatto', 'scatto bloccato con le impostazioni aperte');
await c.requestExit();
assert.equal(c.settingsOpen, false, 'indietro chiude le impostazioni');
assert.equal(c.exitOpen, true, 'poi chiede se hai finito');

// Suggerimenti sugli scatti vuoti.
assert.equal(captureHint({ meanLuma: 30, sharpness: 9 }, true), 'Troppo buio · accendi il flash');
assert.equal(captureHint({ meanLuma: 30, sharpness: 9 }, false), 'Troppo buio · avvicinati alla luce');
assert.equal(captureHint({ meanLuma: 240, sharpness: 9 }), 'Riflesso · inclina un po’ la carta');
assert.equal(captureHint({ meanLuma: 120, sharpness: 1 }), 'Immagine mossa · tieni ferma la carta');
assert.equal(captureHint({ meanLuma: 120, sharpness: 9 }), '');
assert.equal(captureHint(null), '');
console.log('PASS Fast Scan v2: agganci della logica intatti · stato del mirino per esito · tray e annulla · revisione · suggerimenti su buio/riflesso/mosso');
