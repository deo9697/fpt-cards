import assert from 'node:assert/strict';
import { LEVEL_THRESHOLDS, MAX_LEVEL, levelFromXp, xpForLevel, progressForXp, titleForLevel, xpAmountForResult } from '../js/progression.js';

assert.equal(MAX_LEVEL, 50);
assert.equal(LEVEL_THRESHOLDS[0], 0);
assert.equal(levelFromXp(0), 1);
assert.equal(levelFromXp(-50), 1, 'XP negativo non deve produrre un livello invalido');
assert.equal(levelFromXp(LEVEL_THRESHOLDS[1] - 1), 1, 'appena sotto la soglia resta al livello precedente');
assert.equal(levelFromXp(LEVEL_THRESHOLDS[1]), 2, 'esattamente alla soglia scatta il livello nuovo');
assert.equal(levelFromXp(LEVEL_THRESHOLDS[49]), 50, 'la soglia massima porta al livello cap (50)');
assert.equal(levelFromXp(LEVEL_THRESHOLDS[49] + 100000), 50, 'oltre la soglia massima il livello resta cappato a 50');

assert.equal(xpForLevel(1), 0);
assert.equal(xpForLevel(50), LEVEL_THRESHOLDS[49]);
assert.equal(xpForLevel(999), LEVEL_THRESHOLDS[49], 'un livello oltre il cap usa comunque la soglia massima');
assert.equal(xpForLevel(0), LEVEL_THRESHOLDS[0], 'un livello sotto 1 viene riportato al minimo');

const midProgress = progressForXp(LEVEL_THRESHOLDS[1]);
assert.equal(midProgress.level, 2);
assert.equal(midProgress.currentLevelXp, 0, 'appena saliti di livello, l\'xp nel livello corrente riparte da 0');
assert.equal(midProgress.nextLevelXp, LEVEL_THRESHOLDS[2] - LEVEL_THRESHOLDS[1]);
assert.equal(midProgress.progress, 0);

const capProgress = progressForXp(LEVEL_THRESHOLDS[49]);
assert.equal(capProgress.level, 50);
assert.equal(capProgress.progress, 100, 'al livello massimo la barra è sempre piena');
assert.equal(capProgress.nextLevelXp, 0);

assert.equal(titleForLevel(1), 'Tonno');
assert.equal(titleForLevel(9), 'Tonno', 'il titolo cambia solo al bucket successivo');
assert.equal(titleForLevel(10), 'Totonno');
assert.equal(titleForLevel(19), 'Totonno');
assert.equal(titleForLevel(20), 'Totorchio');
assert.equal(titleForLevel(29), 'Totorchio');
assert.equal(titleForLevel(30), 'Totorchiomon');
assert.equal(titleForLevel(39), 'Totorchiomon');
assert.equal(titleForLevel(40), 'Metal War Totorchiomon');
assert.equal(titleForLevel(50), 'Metal War Totorchiomon');
assert.equal(titleForLevel(999), 'Metal War Totorchiomon', 'un livello oltre il cap non deve rompere il lookup titolo');

assert.equal(xpAmountForResult('win'), 15);
assert.equal(xpAmountForResult('draw'), 12);
assert.equal(xpAmountForResult('loss'), 10);
assert.equal(xpAmountForResult('qualsiasi-altra-cosa'), 10, 'un risultato non riconosciuto non deve dare bonus');

console.log('PASS levelFromXp/xpForLevel/progressForXp su soglie esatte, livello 1 e cap 50');
console.log('PASS titleForLevel bucket e cap');
console.log('PASS xpAmountForResult win/draw/loss (15/12/10)');
