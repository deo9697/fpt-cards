// Web Vitals solo in debug (?debugPerf=1): senza il flag non si scarica nulla.
// In un file (non inline) per la Content-Security-Policy (vercel.json).
if (new URLSearchParams(location.search).get('debugPerf') === '1') import('./performance-vitals.js').then(m => m.startPerformanceVitals()).catch(error => console.warn('[perf] web-vitals non disponibile', error));
