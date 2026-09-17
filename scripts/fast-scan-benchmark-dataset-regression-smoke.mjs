// F.P.T Cards — regression fixture dal benchmark reale su telefono 2026-09-17.
// NON tocca OCR/matching (classifyPrintingMatch/classifyNearPrintingMatch/
// normalizeSetCode restano quelli esistenti): verifica solo che i codici e le
// confusioni OCR realmente osservate continuino a risolversi come atteso, e
// che i casi problematici non producano MAI un candidato inventato quando il
// catalogo non conferma.
import assert from 'node:assert/strict';
import { normalizeSetCode } from '../js/fast-scan-core.js';

const localStore = new Map();
globalThis.localStorage = {getItem:key=>localStore.get(key)||null, setItem:(key,value)=>localStore.set(key,value), removeItem:key=>localStore.delete(key)};
globalThis.window = {addEventListener(){}};
globalThis.document = {hidden:false, addEventListener(){}, querySelector:()=>null, querySelectorAll:()=>[], createElement:()=>({getContext:()=>({})})};
const {FastScanController} = await import('../js/fast-scan.js');

function printingFor(code, id) {
  return {printingId:id, game:'yugioh', catalogCardId:id, cardName:`Carta ${code}`, setCode:code, setName:'Set benchmark', rarity:'Common', imageUrl:''};
}
function resolver(catalog) {
  const controller = new FastScanController({camera:{focusSupported:false}, ocr:{}, api:{lookupPrintings:async code=>catalog.filter(item=>item.setCode===code)}, getCollection:()=>({mine:[], team:[]}), isOnline:()=>true, onRender(){}, onRoute(){}});
  return controller;
}

// --- Codici che devono riconoscersi automaticamente (letti correttamente) ---
const cleanCodes = ['5DS3-IT018','DP09-IT010','MP25-EN184','PGL2-IT082','SDCB-EN006','RYMP-IT072','DRLG-IT024'];
for (const code of cleanCodes) {
  const catalog = [printingFor(code, `id-${code}`)];
  const c = resolver(catalog);
  const result = await c.resolve(code, 95, {consensus:2});
  assert.equal(result.status, 'high_confidence', `${code}: lettura pulita con un solo candidato deve auto-riconoscersi`);
  assert.equal(result.code, code);
  clearTimeout(c.persistTimer); clearTimeout(c.feedbackTimer);
}
console.log(`PASS ${cleanCodes.length} codici del benchmark reale riconosciuti automaticamente (nessuna modifica a OCR/matching)`);

// --- Confusioni OCR osservate: auto-accept SOLO se il catalogo conferma un
//     candidato unico dopo la correzione strutturale già esistente ---
const confusionCases = [
  {raw:'PGL2-TT082', expected:'PGL2-IT082', label:'TT -> IT'},
  {raw:'DP09-ITO10', expected:'DP09-IT010', label:'ITO10 -> IT010 (O/0)'},
  {raw:'MP25-ENO14', expected:'MP25-EN014', label:'ENO14 -> EN014 (O/0)'},
  {raw:'RYMP-ITO72', expected:'RYMP-IT072', label:'ITO72 -> IT072 (O/0)'}
];
for (const {raw, expected, label} of confusionCases) {
  const catalog = [printingFor(expected, `id-${expected}`)];
  const c = resolver(catalog);
  const result = await c.resolve(raw, 82, {consensus:2});
  assert.equal(result.code, expected, `${label}: la correzione strutturale deve puntare al codice corretto`);
  assert.notEqual(result.status, 'not_found', `${label}: il catalogo conferma un candidato unico, non deve restare non trovato`);
  clearTimeout(c.persistTimer); clearTimeout(c.feedbackTimer);
}
console.log(`PASS ${confusionCases.length} confusioni OCR osservate risolte solo perché il catalogo conferma un candidato unico`);

// --- Casi problematici reali: NESSUN candidato inventato se il catalogo non
//     conferma nulla — devono restare not_found o needs_review, mai un
//     auto-accept silenzioso su un dato non verificato ---
const problematicRaws = ['RA05 TT012', 'DP09.ITO10', '1O1ENO15', 'CHO1-FNO15', 'CH01-ENO15'];
for (const raw of problematicRaws) {
  const c = resolver([]); // catalogo vuoto: nessuna conferma possibile
  const result = await c.resolve(raw, 78, {consensus:2});
  assert.notEqual(result.status, 'high_confidence', `"${raw}": senza conferma dal catalogo non deve mai auto-accettarsi`);
  assert.equal((result.matches || []).length, 0, `"${raw}": nessun candidato inventato quando il catalogo non conferma nulla`);
  clearTimeout(c.persistTimer); clearTimeout(c.feedbackTimer);
}
console.log(`PASS ${problematicRaws.length} letture problematiche del benchmark reale non producono mai un candidato inventato`);
