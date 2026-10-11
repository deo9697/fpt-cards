// PROOF OF CONCEPT — scansione assistita con ritaglio manuale (Cropper.js).
//
// Flusso: immagine (foto o fotogramma) → l'utente ritaglia la zona del codice
// → canvas → createOcrInputPlan() ESISTENTE → stesso recognize (PaddleOCR) →
// normalizeSetCode() ESISTENTE. Il risultato si può poi passare alla stessa
// risoluzione del flusso manuale (FastScanController.resolve/commitResolution).
//
// Isolato di proposito: NON è collegato al Fast Scan automatico né alla UI.
// Nessuna modifica a OCR, matching, rarità, catalogo, tempi o recovery della
// fotocamera; nessun invio di immagini a servizi esterni, nessun salvataggio
// (tutto resta in canvas in memoria). Cropper.js si carica da jsDelivr solo
// quando questo modulo viene usato; la versione DEVE restare allineata a
// "cropperjs" in package.json.
export const CROPPER_VERSION = '1.6.2';
export const CROPPER_JS_URL = `https://cdn.jsdelivr.net/npm/cropperjs@${CROPPER_VERSION}/dist/cropper.esm.js`;
export const CROPPER_CSS_URL = `https://cdn.jsdelivr.net/npm/cropperjs@${CROPPER_VERSION}/dist/cropper.min.css`;

// createOcrInputPlan() tiene solo la fascia 5%–95% dell'altezza (OCR_SUB_ROI):
// un ritaglio stretto attorno al codice perderebbe i bordi del testo. Questo
// margine bianco sopra/sotto compensa.
export const CROP_VERTICAL_PADDING = 0.08;

export async function loadCropper({ loader = () => import(CROPPER_JS_URL), doc = globalThis.document, cssUrl = CROPPER_CSS_URL } = {}) {
  if (doc && cssUrl && !doc.querySelector(`link[data-cropper-css]`)) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet'; link.href = cssUrl; link.dataset.cropperCss = 'true';
    doc.head.appendChild(link);
  }
  const module = await loader();
  return module.default || module.Cropper || module;
}

// Riquadro iniziale largo e basso, come la guida del Fast Scan (il codice set
// è una striscia orizzontale); l'utente può comunque ridimensionarlo.
export function createCropSession(image, Cropper, options = {}) {
  return new Cropper(image, {
    viewMode: 1, dragMode: 'move', autoCropArea: 0.6, aspectRatio: NaN,
    background: false, guides: true, center: true, movable: true, zoomable: true,
    rotatable: false, scalable: false, toggleDragModeOnDblclick: false,
    ...options,
  });
}

export function padCanvasVertically(source, ratio = CROP_VERTICAL_PADDING, doc = globalThis.document) {
  const pad = Math.round(source.height * ratio);
  const canvas = doc.createElement('canvas');
  canvas.width = source.width; canvas.height = source.height + pad * 2;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, pad);
  return canvas;
}

export function croppedCodeCanvas(cropper, { maxWidth = 1600, doc = globalThis.document } = {}) {
  const raw = cropper.getCroppedCanvas({ maxWidth, imageSmoothingEnabled: true, imageSmoothingQuality: 'high', fillColor: '#ffffff' });
  if (!raw?.width || !raw?.height) throw new Error('Ritaglio vuoto: seleziona la zona del codice');
  return padCanvasVertically(raw, CROP_VERTICAL_PADDING, doc);
}

// Le tre dipendenze sono quelle di produzione, iniettate: createPlan =
// createOcrInputPlan (js/fast-scan.js), recognize = controller.recognizeProduction
// (PaddleOCR), normalize = normalizeSetCode (js/fast-scan-core.js).
export async function recognizeCroppedCode(canvas, { createPlan, recognize, normalize }) {
  const plan = createPlan({ rawCanvas: canvas });
  const reading = await recognize(plan.primary.canvas);
  return { plan, reading, code: normalize(reading?.text || '') };
}
