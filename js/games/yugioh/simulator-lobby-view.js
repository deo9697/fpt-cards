// Arena del Duellante (restyle FPT 2026-11-15, proposta approvata): viste della
// sala d'attesa — hero con numeri, schede con icone, biglietti dei tavoli,
// tessere mazzo, compagni esagonali, pulsanti LP/inizio. I campi dei moduli
// restano quelli di prima (name=deckId/opponentSlug/lp/firstPlayer) come
// controlli nativi nascosti: le tessere li pilotano, submit e test invariati.
import { esc } from './simulator-arena.js';
import { validateSimulatorDeck } from './simulator-engine.js';

const ICONS = {
  table:'<path d="M4 12h16M12 4l8 8-8 8-8-8z"/>',
  practice:'<rect x="6" y="4" width="12" height="16" rx="1"/><path d="M9 9h6M9 13h6"/>',
  rules:'<path d="M5 4h11l3 3v13H5z"/><path d="M8 10h8M8 14h6"/>',
  history:'<path d="M4 19V9M10 19V5M16 19v-7M22 19V3"/>'
};
const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const initials = name => String(name || '?').split(/[\s·]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
const smallImage = url => String(url || '').replace('/images/cards/', '/images/cards_small/');
const count = (deck, section) => (deck.cards || []).filter(card => card.section === section).reduce((sum, card) => sum + Number(card.quantity || 0), 0);

export function deckArt(deck) {
  if (!deck) return '';
  const cards = deck.cards || [];
  const signature = cards.find(card => String(card.catalogCardId) === String(deck.signatureCardId || ''));
  return smallImage(deck.coverImageUrl || signature?.imageUrl || cards.find(card => card.section === 'main' && card.imageUrl)?.imageUrl || cards.find(card => card.imageUrl)?.imageUrl || '');
}

export function arenaStats(duels = []) {
  const finished = duels.filter(row => row.status === 'finished' && row.result);
  const wins = finished.filter(row => row.result.winner === row.viewer).length;
  const open = duels.filter(row => ['waiting', 'setup', 'playing'].includes(row.status)).length;
  return { played:finished.length, wins, draws:finished.filter(row => row.result.winner === 'draw').length, rate:finished.length ? Math.round(wins / finished.length * 100) : 0, open };
}

export function arenaHeader(sim) {
  const stats = arenaStats(sim.lobby.duels);
  const tabs = [['table', 'Sfida'], ['practice', 'Testa'], ['rules', 'Regole'], ['history', 'Statistiche']];
  return `<div class="ygo-arena-strip"><b>YU-GI-OH!</b><span>· ARENA PRIVATA</span><i aria-hidden="true"></i><span class="ygo-arena-live"><em></em>${sim.lobby.members.length || 0} NEL TEAM</span></div>
    <header class="ygo-arena-hero"><span class="ygo-arena-eyebrow">// Tavolo del team</span><h1>Arena del Duellante</h1><p>Sfida un compagno o metti alla prova un mazzo.</p>
      <div class="ygo-arena-hud"><div><b>${stats.played}</b><small>Duelli</small></div><div><b class="is-gold">${stats.rate}%</b><small>Vittorie</small></div><div><b class="is-pink">${stats.open}</b><small>Tavoli aperti</small></div></div></header>
    <nav class="ygo-tabs" role="tablist" aria-label="Arena">${tabs.map(([id, name]) => `<button type="button" role="tab" data-ygo-tab="${id}" aria-selected="${id === sim.tab}" class="${id === sim.tab ? 'is-current' : ''}">${svg(id)}<span>${name}</span></button>`).join('')}</nav>`;
}

export function deckTiles(decks, selectedId, field) {
  if (!decks.length) return '<div class="ygo-arena-empty"><p>Non hai ancora mazzi Yu-Gi-Oh! salvati.</p><button type="button" class="btn secondary" data-page="decks">Apri i mazzi</button></div>';
  return `<div class="ygo-deck-tiles" role="radiogroup" aria-label="Il tuo mazzo">${decks.map(deck => {
    const validation = validateSimulatorDeck(deck), art = deckArt(deck), main = count(deck, 'main');
    return `<button type="button" role="radio" class="ygo-deck-tile" data-ygo-pick="${field}" data-value="${esc(deck.id)}" aria-checked="${deck.id === selectedId}">${art ? `<img src="${esc(art)}" alt="" loading="lazy">` : '<span class="ygo-deck-tile-blank" aria-hidden="true"></span>'}<i class="${validation.valid ? '' : 'is-bad'}">${validation.valid ? 'PRONTO' : `${main}/40`}</i><strong>${esc(deck.name)}</strong><small>${main} · ${count(deck, 'extra')} · ${count(deck, 'side')}</small></button>`;
  }).join('')}</div>`;
}

export function deckIssues(deck) {
  if (!deck) return '';
  const validation = validateSimulatorDeck(deck);
  return validation.valid ? '' : `<p class="ygo-arena-warning" role="status">${validation.errors.map(esc).join('<br>')}</p>`;
}

export function memberChips(members, selectedSlug) {
  if (!members.length) return '<p class="ygo-arena-muted">Nessun compagno disponibile nel team.</p>';
  return `<div class="ygo-member-chips" role="radiogroup" aria-label="Avversario">${members.map(member => `<button type="button" role="radio" class="ygo-member-chip" data-ygo-pick="opponentSlug" data-value="${esc(member.slug)}" aria-checked="${member.slug === selectedSlug}"><span>${esc(initials(member.name))}</span><i class="${member.pushEnabled ? 'is-on' : ''}" title="${member.pushEnabled ? 'Notifiche attive' : 'Notifiche non attive'}"></i><small>${esc(String(member.name || member.slug).split(' · ')[0])}</small></button>`).join('')}</div>`;
}

export function segmented(field, value, options) {
  return `<div class="ygo-seg" role="radiogroup">${options.map(([optionValue, label]) => `<button type="button" role="radio" data-ygo-pick="${field}" data-value="${esc(optionValue)}" aria-checked="${String(optionValue) === String(value)}">${esc(label)}</button>`).join('')}</div>`;
}

export function duelTicket(row, pending) {
  const opponent = row.viewer === 0 ? row.guestName : row.hostName;
  const incoming = row.status === 'waiting' && row.viewer === 1;
  const tone = row.status === 'playing' ? 'is-live' : row.status === 'setup' ? 'is-setup' : incoming ? 'is-invite' : 'is-sent';
  const title = incoming ? `${esc(opponent)} ti sfida` : row.status === 'waiting' ? `Sfida inviata a ${esc(opponent)}` : `vs ${esc(opponent)}`;
  const tag = incoming ? 'INVITO' : row.status === 'waiting' ? 'IN ATTESA' : row.status === 'setup' ? 'PREPARAZIONE' : 'IN CORSO';
  const decks = [row.hostDeckName, row.guestDeckName].filter(Boolean).join(' vs ');
  return `<article class="ygo-ticket ${tone}"><span class="ygo-ticket-avatar" aria-hidden="true">${esc(initials(opponent))}</span><div><strong>${title}</strong><small><b>${tag}</b>${decks ? ` · ${esc(decks)}` : ''}</small></div><button type="button" class="ygo-ticket-action" data-ygo-open="${esc(row.id)}" ${pending ? 'disabled' : ''}>${incoming ? 'Accetta' : row.status === 'waiting' ? 'Apri' : 'Rientra'}</button></article>`;
}

export function historyTicket(row) {
  const opponent = row.viewer === 0 ? row.guestName : row.hostName;
  const myDeck = row.viewer === 0 ? row.hostDeckName : row.guestDeckName, theirDeck = row.viewer === 0 ? row.guestDeckName : row.hostDeckName;
  const outcome = row.result.winner === 'draw' ? ['is-draw', 'Pareggio'] : row.result.winner === row.viewer ? ['is-win', 'Vittoria'] : ['is-loss', 'Sconfitta'];
  const when = row.updatedAt ? new Intl.DateTimeFormat('it-IT', { day:'numeric', month:'short' }).format(new Date(row.updatedAt)) : '';
  return `<article class="ygo-ticket ${outcome[0]}"><span class="ygo-ticket-avatar" aria-hidden="true">${esc(initials(opponent))}</span><div><strong>${outcome[1]} vs ${esc(opponent)}</strong><small><b>${esc(myDeck || 'Mazzo')}</b>${theirDeck ? ` vs ${esc(theirDeck)}` : ''}${when ? ` · ${esc(when)}` : ''}${row.result.notes ? ` · ${esc(row.result.notes)}` : ''}</small></div><button type="button" class="ygo-ticket-action" data-ygo-open="${esc(row.id)}">Tavolo</button></article>`;
}

export function deckRecords(duels = []) {
  const byDeck = new Map();
  for (const row of duels.filter(item => item.status === 'finished' && item.result)) {
    const name = (row.viewer === 0 ? row.hostDeckName : row.guestDeckName) || 'Mazzo';
    const record = byDeck.get(name) || { name, wins:0, losses:0 };
    if (row.result.winner === row.viewer) record.wins++; else if (row.result.winner !== 'draw') record.losses++;
    byDeck.set(name, record);
  }
  return [...byDeck.values()].sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses)).slice(0, 5);
}

// Mano di prova: 5 carte del Main Deck, rimescolabili (seed nel controller).
export function sampleHand(deck, seed = 1) {
  const pool = [];
  for (const card of deck?.cards || []) if (card.section === 'main' && card.imageUrl) for (let i = 0; i < Math.min(3, Number(card.quantity || 1)); i++) pool.push(smallImage(card.imageUrl));
  let state = (Number(seed) * 9301 + 49297) % 233280 || 1;
  const random = () => { state = (state * 9301 + 49297) % 233280; return state / 233280; };
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, 5);
}
