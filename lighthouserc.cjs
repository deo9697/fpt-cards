// Lighthouse CI — baseline locale (npm run perf:lighthouse).
//
// - Usa il preview server del progetto (scripts/preview-server.mjs, :8080):
//   nessun URL di deploy inventato. La porta 8080 deve essere libera.
// - Copre solo l'app shell (index.html → schermata di accesso). Le pagine
//   autenticate (Dashboard, Raccolta, Market Watch, Fast Scan) richiedono una
//   sessione reale: NON vengono simulate qui (niente credenziali nel repo,
//   niente bypass dell'autenticazione).
// - Asserzioni solo 'warn': servono a fissare una baseline e a vedere le
//   regressioni, non a bloccare. Le soglie sono larghe di proposito; si
//   stringono quando ci sono almeno alcune misure confrontabili.
// - Report salvati in .lighthouseci/ (ignorata da git), mai caricati online.
//
// Chrome: passarlo come collect.chromePath (percorso con spazi, "Program
// Files") bloccava lhci al primo run su Windows; tramite CHROME_PATH invece
// chrome-launcher lo trova correttamente (verificato 2026-10-11).
if (!process.env.CHROME_PATH && process.platform === 'win32') process.env.CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

module.exports = {
  ci: {
    collect: {
      startServerCommand: 'node scripts/preview-server.mjs',
      startServerReadyPattern: 'FPT Cards disponibile',
      startServerReadyTimeout: 20000,
      url: ['http://localhost:8080/index.html'],
      numberOfRuns: 3,
      settings: {
        // Default Lighthouse = profilo mobile (Moto G Power, 4G lenta, CPU 4x): coerente con una PWA mobile-first.
        chromeFlags: '--headless=new --no-sandbox --disable-gpu',
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['warn', { minScore: 0.5 }],
        'categories:accessibility': ['warn', { minScore: 0.8 }],
        'categories:best-practices': ['warn', { minScore: 0.8 }],
        'largest-contentful-paint': ['warn', { maxNumericValue: 4000 }],
        'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
        'total-blocking-time': ['warn', { maxNumericValue: 600 }],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: '.lighthouseci/reports',
    },
  },
};
