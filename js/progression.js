// Motore XP/livello — funzioni pure, nessun accesso a DOM/API.
// LEVEL_THRESHOLDS[i] = XP cumulativo per raggiungere il livello (i+1), i=0..49.
// Generato una volta con round(25*n^2+50*n) per n=1..49 (n=0 -> livello 1 a 0 XP)
// e congelato come tabella letterale: è il posto unico dove ritarare la curva.
// La funzione Postgres public.level_from_xp() (supabase-milestone-6-statistics-progression.sql)
// usa la STESSA tabella tradotta in un array SQL — se cambi questa, aggiorna anche quella.
export const LEVEL_THRESHOLDS = [0,75,200,375,600,875,1200,1575,2000,2475,3000,3575,4200,4875,5600,6375,7200,8075,9000,9975,11000,12075,13200,14375,15600,16875,18200,19575,21000,22475,24000,25575,27200,28875,30600,32375,34200,36075,38000,39975,42000,44075,46200,48375,50600,52875,55200,57575,60000,62475];
export const MAX_LEVEL = LEVEL_THRESHOLDS.length;

const TITLE_BUCKETS = [
  [1, 'Tonno'], [10, 'Totonno'], [20, 'Totorchio'], [30, 'Totorchiomon'], [40, 'Metal War Totorchiomon']
];

export function levelFromXp(totalXp) {
  const xp = Math.max(0, Number(totalXp) || 0);
  let level = 1;
  for (let index = 1; index < LEVEL_THRESHOLDS.length; index += 1) {
    if (xp < LEVEL_THRESHOLDS[index]) break;
    level = index + 1;
  }
  return level;
}

export function xpForLevel(level) {
  const clamped = Math.min(MAX_LEVEL, Math.max(1, Number(level) || 1));
  return LEVEL_THRESHOLDS[clamped - 1];
}

export function progressForXp(totalXp) {
  const xp = Math.max(0, Number(totalXp) || 0);
  const level = levelFromXp(xp);
  const currentLevelXp = xp - xpForLevel(level);
  if (level >= MAX_LEVEL) return { level, currentLevelXp: 0, nextLevelXp: 0, progress: 100 };
  const nextLevelXp = xpForLevel(level + 1) - xpForLevel(level);
  return { level, currentLevelXp, nextLevelXp, progress: Math.round((currentLevelXp / nextLevelXp) * 100) };
}

export function titleForLevel(level) {
  const clamped = Math.min(MAX_LEVEL, Math.max(1, Number(level) || 1));
  let title = TITLE_BUCKETS[0][1];
  for (const [threshold, name] of TITLE_BUCKETS) { if (clamped >= threshold) title = name; }
  return title;
}

export function xpAmountForResult(result) {
  return 10 + (result === 'win' ? 5 : result === 'draw' ? 2 : 0);
}
