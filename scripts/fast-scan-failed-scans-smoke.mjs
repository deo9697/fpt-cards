// Revisione Fast Scan (2026-10-24, segnalazione reale): "3 scansioni" ma nessuna
// carta visibile. Gli scatti non riusciti contavano senza comparire da nessuna
// parte e la sessione restava "non salvata" per sempre. Ora sono elencati con
// motivo e azioni, e una sessione senza nulla da salvare si può chiudere.
import assert from 'node:assert/strict';
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.document ??= { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
const { FastScanController } = await import('../js/fast-scan.js');
const make = () => new FastScanController({ camera: { stream: {}, stop() {}, focusSupported: false }, paddleOcr: { prepare: async () => {} }, isOnline: () => true, onRender() {}, onRoute() {}, onToast() {} });

// Il caso segnalato: tre scatti falliti, nient'altro.
const c = make();
for (const [reason, code] of [['NO_TEXT', ''], ['NO_CATALOG_MATCH', 'BETB-IT1O4'], ['INTERRUPTED', 'BETB-IT045']]) {
  const scan = c.buffer.createScan({ normalizedCode: code });
  c.buffer.failScan(scan.id, reason);
}
assert.equal(c.buffer.scanned, 3);
assert.equal(c.buffer.entries.size + c.buffer.review.length, 0, 'premessa: niente in pronte né da verificare');
c.phase = 'review';
const view = c.reviewView();
assert.match(view, /Non riuscite <span>3<\/span>/, 'gli scatti falliti sono elencati');
assert.match(view, /Nessun codice letto/);
assert.match(view, /BETB-IT1O4<\/strong><small>Codice non trovato nel catalogo/);
assert.match(view, /Scatto interrotto/);
assert.equal((view.match(/data-scan-edit=/g) || []).length, 3, 'ognuno si può correggere a mano');
assert.equal((view.match(/data-scan-cancel=/g) || []).length, 3, 'ognuno si può togliere');
assert.match(view, /0 stampe · 3 non riuscite/, 'il riepilogo dice cosa sono, non "3 scansioni"');
assert.match(view, /data-scan-review-discard/, 'sessione senza nulla da salvare: si può chiudere');

// Togliere uno scatto lo fa sparire dall'elenco.
c.buffer.cancelScan(c.failedScans()[0].id);
assert.match(c.reviewView(), /Non riuscite <span>2<\/span>/);

// Con carte pronte la chiusura "senza salvare" non viene proposta.
c.buffer.add({ printingId: 'p', game: 'yugioh', catalogCardId: '1', cardName: 'Dark Time Wizard', setCode: 'BETB-IT052', rarity: 'Ultra Rare' });
assert.doesNotMatch(c.reviewView(), /data-scan-review-discard/);
assert.match(c.setupView.call(Object.assign(make(), { hasRecovery: true, buffer: c.buffer })), /1 carta · 2 scatti non riusciti/, 'avvio: riepilogo coerente con la revisione');
console.log('PASS Fast Scan: scatti non riusciti visibili in revisione con motivo, correzione e rimozione · sessione vuota chiudibile · riepiloghi coerenti');
