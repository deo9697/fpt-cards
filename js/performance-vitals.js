// Osservabilità delle performance SOLO in debug (?debugPerf=1).
//
// - Usa la libreria ufficiale web-vitals (LCP, INP, CLS, FCP, TTFB), caricata
//   da jsDelivr con versione fissata come le altre librerie esterne dell'app
//   (niente bundler: node_modules non arriva al browser). La versione DEVE
//   restare allineata a "web-vitals" in package.json.
// - Nessuna richiesta di rete verso backend/telemetria, nessuna persistenza
//   (né Supabase né storage): i valori restano in memoria in
//   window.__fptVitals, nella console e in un piccolo riquadro in sovrimpressione.
// - Senza il flag questo modulo non viene nemmeno scaricato (l'import è
//   condizionale in index.html): la UX normale resta identica.
// - web-vitals usa PerformanceObserver con buffered:true, quindi anche
//   registrandosi dopo il primo paint LCP/FCP/TTFB non vanno persi.
export const WEB_VITALS_VERSION = '6.2.3';
export const WEB_VITALS_URL = `https://cdn.jsdelivr.net/npm/web-vitals@${WEB_VITALS_VERSION}/+esm`;
export const VITAL_NAMES = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'];

export function perfDebugEnabled(locationLike = globalThis.location) {
  try { return new URLSearchParams(locationLike?.search || '').get('debugPerf') === '1'; } catch { return false; }
}

// CLS è adimensionale, le altre metriche sono millisecondi.
export function formatVital(name, value) {
  if (!Number.isFinite(value)) return '—';
  return name === 'CLS' ? value.toFixed(3) : `${Math.round(value)} ms`;
}

export function createVitalsStore() {
  return { version: WEB_VITALS_VERSION, startedAt: Date.now(), metrics: {}, history: [] };
}

export function recordVital(store, metric) {
  const entry = { name: metric.name, value: metric.value, delta: metric.delta, rating: metric.rating, id: metric.id, navigationType: metric.navigationType, at: Date.now() };
  store.metrics[metric.name] = entry;
  store.history.push(entry);
  return entry;
}

const RATING_COLORS = { good: '#7ef0bf', 'needs-improvement': '#f4b942', poor: '#ff8fa0' };
function renderOverlay(store, doc) {
  if (!doc?.body) return;
  let box = doc.getElementById('fpt-vitals-debug');
  if (!box) {
    box = doc.createElement('aside');
    box.id = 'fpt-vitals-debug';
    box.setAttribute('aria-label', 'Web Vitals (debug)');
    box.style.cssText = 'position:fixed;left:8px;bottom:calc(92px + env(safe-area-inset-bottom));z-index:2147483000;padding:6px 8px;border-radius:8px;background:#000c;color:#f3f4f7;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;pointer-events:none;box-shadow:0 4px 12px #0008';
    doc.body.appendChild(box);
  }
  box.replaceChildren(...VITAL_NAMES.map(name => {
    const metric = store.metrics[name], row = doc.createElement('div');
    row.textContent = `${name.padEnd(4)} ${metric ? formatVital(name, metric.value) : '…'}`;
    if (metric) row.style.color = RATING_COLORS[metric.rating] || '#f3f4f7';
    return row;
  }));
}

export async function startPerformanceVitals({ loader = () => import(WEB_VITALS_URL), target = globalThis, doc = globalThis.document, log = globalThis.console, overlay = true } = {}) {
  const store = createVitalsStore();
  target.__fptVitals = store;
  const lib = await loader();
  const report = metric => {
    const entry = recordVital(store, metric);
    log?.info?.(`[perf] ${entry.name} ${formatVital(entry.name, entry.value)} (${entry.rating})`);
    if (overlay) renderOverlay(store, doc);
  };
  // reportAllChanges: in debug interessa vedere LCP/CLS/INP aggiornarsi dal
  // vivo mentre si usa l'app, non solo il valore finale al pagehide.
  lib.onLCP(report, { reportAllChanges: true });
  lib.onINP(report, { reportAllChanges: true });
  lib.onCLS(report, { reportAllChanges: true });
  lib.onFCP(report);
  lib.onTTFB(report);
  if (overlay) renderOverlay(store, doc);
  return store;
}
