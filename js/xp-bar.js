// Barra XP "Sigilli" (variante B scelta 2026-11-18): il livello in un
// esagono con l'anello d'oro che si riempie, 10 sigilli inclinati (oro quando
// pieni, rosa quello in corso) e sotto "XP / soglia · N al LV successivo".
// Un solo markup per barra in alto, profilo, progressione e Statistiche.
// Colori fissi: si anima solo il riempimento (animateXpCells), mai il colore.
import { esc } from './core.js';

const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));

// progress = progressForXp(...) → { level, currentLevelXp, nextLevelXp, progress }
export function xpBarMarkup(progress, { size = 'compact', label = '' } = {}) {
  const p = clamp(progress?.progress);
  const max = !progress?.nextLevelXp;
  const cells = Array.from({ length: 10 }, (_, index) => {
    const fill = max ? 100 : clamp((p - index * 10) * 10);
    return '<span class="xp-cell'+(fill >= 100 ? ' is-full' : fill > 0 ? ' is-live' : '')+'"><i style="--f:'+fill+'%"></i></span>';
  }).join('');
  const remaining = Math.max(0, (progress?.nextLevelXp || 0) - (progress?.currentLevelXp || 0));
  const meta = max
    ? '<span>Livello massimo</span>'
    : '<span>'+(progress?.currentLevelXp || 0)+' / '+progress.nextLevelXp+' XP</span><span><b>'+remaining+'</b> al LV '+((progress?.level || 1) + 1)+'</span>';
  return '<span class="xp-seal xp-seal-'+size+'" data-xp-progress="'+(max ? 100 : p)+'"'+(label ? ' aria-label="'+esc(label)+'"' : '')+'>'+
    '<span class="xp-seal-badge" style="--p:'+(max ? 100 : p)+'%"><b>'+(progress?.level || 1)+'</b></span>'+
    '<span class="xp-seal-right"><span class="xp-seal-cells" aria-hidden="true">'+cells+'</span><span class="xp-seal-meta">'+meta+'</span></span>'+
  '</span>';
}

// Riempie i sigilli dal valore mostrato prima a quello nuovo (WAAPI, ~1 s).
export function animateXpCells(root, previous, next) {
  if (previous == null || previous === next || !root) return;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cells = [...root.querySelectorAll('.xp-cell > i')];
  cells.forEach((fill, index) => {
    if (!fill.animate) return;
    const from = clamp((previous - index * 10) * 10), to = clamp((next - index * 10) * 10);
    if (from === to) return;
    fill.animate([{ width: from + '%' }, { width: to + '%' }], { duration: 900, delay: Math.max(0, index - Math.floor(Math.min(previous, next) / 10)) * 60, easing: 'cubic-bezier(.22,.68,.16,1)', fill: 'backwards' });
  });
  const badge = root.querySelector('.xp-seal-badge');
  if (badge?.animate) badge.animate([{ '--p': previous + '%' }, { '--p': next + '%' }], { duration: 900, easing: 'cubic-bezier(.22,.68,.16,1)' });
}
