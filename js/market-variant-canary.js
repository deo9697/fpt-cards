// Poller puro per il canale canary admin-only del Market Variant Registry
// (vedi supabase/migrations/20260912140000_ygo_market_variant_canary.sql).
// Isolato dal resto di js/api.js — che dipende da `window.FPT_CONFIG` al
// caricamento del modulo — così questa logica di attesa/timeout è
// testabile in Node puro iniettando un fetchRun/sleep finti, senza bisogno
// di un browser o di Supabase reale.
export async function pollMarketVariantCanaryRun(fetchRun, runId, {
  intervalMs = 1500,
  timeoutMs = 120000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let run = await fetchRun(runId);
  while (run && run.status !== 'succeeded' && run.status !== 'failed') {
    if (Date.now() >= deadline) return { ...run, timedOut: true };
    await sleep(intervalMs);
    run = await fetchRun(runId);
  }
  return run;
}
