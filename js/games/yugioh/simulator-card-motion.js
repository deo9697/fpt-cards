// Movimenti delle carte sul campo, stile B «Rito gotico» (2026-11-18).
// Solo presentazione: confronta due stati PUBBLICI (prima/dopo una mossa) e fa
// volare un fantasma della carta dalla zona di partenza a quella di arrivo.
// Non legge mai carte nascoste: una carta coperta vola come dorso.
// Tavolo manuale: identità = id della carta (stabile). Tavolo automatico: gli id
// dipendono dalla posizione, quindi l'identità è il codice della carta.
const BACK = 'assets/backgrounds/yugioh-duel-card-back.jpg';
const BOARD = ['monsters', 'extraMonsters', 'spells', 'field'];
const ZONES = ['deck', 'hand', ...BOARD, 'graveyard', 'banished', 'extra'];
const MAX_MOVES = 8;
const isBoard = zone => BOARD.includes(zone);
const visible = card => Boolean(card) && !card.hidden && card.faceUp !== false;
function keyOf(card, mode) {
  if (!card || card.hidden) return 'hidden';
  const code = card.code ?? card.catalogCardId;
  return mode === 'auto' ? `c:${code || card.cardName || '?'}` : `i:${card.id}`;
}
function diffZone(before, after, mode) {
  const count = list => { const map = new Map(); for (const card of list) { const key = keyOf(card, mode); map.set(key, (map.get(key) || 0) + 1); } return map; };
  const left = count(after), right = count(before), removed = [], added = [];
  before.forEach((card, index) => { const key = keyOf(card, mode); if (left.get(key) > 0) left.set(key, left.get(key) - 1); else removed.push({ card, index, key }); });
  after.forEach((card, index) => { const key = keyOf(card, mode); if (right.get(key) > 0) right.set(key, right.get(key) - 1); else added.push({ card, index, key }); });
  return { removed, added };
}
function kindOf(from, to, card) {
  if (from.zone === to.zone && isBoard(to.zone)) return to.zone === 'spells' || to.zone === 'field' ? 'activate-flip' : 'flip';
  if (to.zone === 'banished') return 'banish';
  if (to.zone === 'graveyard') return from.zone === 'deck' ? 'mill' : from.zone === 'hand' ? 'discard' : isBoard(from.zone) ? 'destroy' : 'move';
  if (to.zone === 'monsters' || to.zone === 'extraMonsters') return isBoard(from.zone) ? 'move' : visible(card) ? 'summon' : 'set';
  if (to.zone === 'spells' || to.zone === 'field') return isBoard(from.zone) ? 'move' : visible(card) ? 'activate' : 'set';
  if (to.zone === 'hand') return from.zone === 'deck' ? 'draw' : 'bounce';
  if (to.zone === 'deck' || to.zone === 'extra') return isBoard(from.zone) || from.zone === 'graveyard' || from.zone === 'banished' ? 'bounce' : null;
  return 'move';
}
// Movimenti tra due stati pubblici. Esportata per i test.
export function cardMoves(previous, next, { mode = 'manual' } = {}) {
  if (!previous?.players || !next?.players) return [];
  const moves = [];
  for (const player of [0, 1]) {
    const removed = [], added = [];
    for (const zone of ZONES) {
      const before = previous.players[player]?.[zone] || [], after = next.players[player]?.[zone] || [];
      if (zone === 'deck' && before.length === after.length) continue;
      const diff = diffZone(before, after, mode);
      for (const row of diff.removed) removed.push({ ...row, zone, player, slot: row.card.slot });
      for (const row of diff.added) added.push({ ...row, zone, player, slot: row.card.slot });
    }
    const take = (list, test) => { const index = list.findIndex(test); return index < 0 ? null : list.splice(index, 1)[0]; };
    const pair = (from, to) => { const kind = kindOf(from, to, to.card); if (kind) moves.push({ kind, player, from: { zone: from.zone, index: from.index, slot: from.slot }, to: { zone: to.zone, index: to.index, slot: to.slot }, card: visible(to.card) ? to.card : visible(from.card) && !isBoard(to.zone) && to.zone !== 'hand' && to.zone !== 'deck' && to.zone !== 'extra' ? from.card : to.card }); };
    // 1) stessa carta riconosciuta (non coperta), zona diversa
    for (const to of [...added]) { if (to.key === 'hidden') continue; const from = take(removed, row => row.key === to.key && row.zone !== to.zone); if (from) { added.splice(added.indexOf(to), 1); pair(from, to); } }
    // 2) carta che si gira nella stessa casella (Trappola attivata, Flip)
    for (const to of [...added]) { if (!isBoard(to.zone)) continue; const from = take(removed, row => row.zone === to.zone && row.slot === to.slot); if (from) { added.splice(added.indexOf(to), 1); if (visible(to.card) && !visible(from.card)) pair(from, to); } }
    // 3) coperta ↔ scoperta tra zone (mano avversaria → campo, campo → mano avversaria, pescate)
    for (const to of [...added]) { const from = take(removed, row => row.key === 'hidden' || to.key === 'hidden'); if (from) { added.splice(added.indexOf(to), 1); pair(from, to); } }
  }
  return moves.slice(-MAX_MOVES);
}

function cardNode(root, place) {
  if (!root || !place) return null;
  const { zone, index, slot } = place, player = place.player;
  if (isBoard(zone)) { const cell = root.querySelector(`[data-zone="${zone}"][data-slot="${zone === 'field' ? 0 : slot}"][data-player="${player}"]`); return cell?.querySelector('.ygo-card') || cell; }
  if (zone === 'hand') { const hand = root.querySelector(`.ygo-hand[data-player="${player}"]`); return hand?.querySelector('.ygo-hand-cards')?.children?.[index] || hand; }
  const pile = root.querySelector(`[data-ygo-pile="${zone}"][data-player="${player}"]`);
  return pile?.querySelector('.ygo-pile-art') || pile;
}
function boxOf(node) {
  const rect = node?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  let height = Math.max(34, Math.min(96, rect.height)), width = height * 59 / 86;
  if (rect.width < width) { width = rect.width; height = width * 86 / 59; }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width, height };
}
function imageOf(card) {
  if (!visible(card)) return BACK;
  try { const url = new URL(card.imageUrl || '', globalThis.location?.href || 'http://localhost'); if (card.imageUrl && ['http:', 'https:'].includes(url.protocol)) return url.href; } catch {}
  return BACK;
}

export function createCardMotion({ doc = globalThis.document, speed = 1 } = {}) {
  let layer = null, prepared = null, disposed = false;
  const animations = new Set(), hiddenTargets = new Set();
  const reduced = () => { try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; } };
  const ensureLayer = () => {
    if (layer?.isConnected) return layer;
    layer = doc.createElement('div'); layer.className = 'ygo-motion-layer'; layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:fixed;inset:0;z-index:630;pointer-events:none;overflow:hidden';
    doc.body.appendChild(layer); return layer;
  };
  const track = animation => { animation.playbackRate = speed; animations.add(animation); animation.finished.catch(() => {}).finally(() => animations.delete(animation)); return animation.finished.catch(() => {}); };
  function spawn(className, css) { const node = doc.createElement('span'); node.className = className; Object.assign(node.style, css); ensureLayer().appendChild(node); return node; }
  const place = (box, extra = '') => `translate(${box.x - box.width / 2}px,${box.y - box.height / 2}px) ${extra}`;

  function ghost(card, box) {
    const node = spawn('ygo-motion-ghost', { width: box.width + 'px', height: box.height + 'px' });
    const img = doc.createElement('img'); img.alt = ''; img.decoding = 'async'; img.draggable = false; img.src = imageOf(card); node.appendChild(img);
    return { node, img };
  }
  function fly(card, from, to, { ms = 480, lift = 40, end = '', fade = false, flipFromBack = false } = {}) {
    const { node, img } = ghost(flipFromBack ? null : card, from);
    // Il fantasma ha la misura di partenza; si sposta il centro e si scala verso l'arrivo.
    const at = (x, y, extra) => `translate(${x - from.width / 2}px,${y - from.height / 2}px) ${extra}`;
    const scale = to.width / from.width, midScale = (1 + scale) / 2 * 1.12;
    if (flipFromBack) setTimeout(() => { img.src = imageOf(card); }, ms / speed / 2);
    return track(node.animate([
      { transform: at(from.x, from.y, flipFromBack ? 'rotateY(180deg)' : ''), opacity: 1 },
      { transform: at((from.x + to.x) / 2, Math.min(from.y, to.y) - lift, `scale(${midScale})${flipFromBack ? ' rotateY(90deg)' : ''}`), opacity: 1, offset: .5 },
      { transform: at(to.x, to.y, `scale(${scale}) ${end}`), opacity: fade ? 0 : 1 },
    ], { duration: ms, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' })).then(() => node.remove());
  }
  function embers(box, { color, count = 10, spread = 50, ms = 520, size = 4 }) {
    const jobs = [];
    for (let index = 0; index < count; index++) {
      const angle = Math.PI * 2 * index / count + Math.random() * .5, distance = spread * (.6 + Math.random() * .6);
      const dot = spawn('ygo-motion-dot', { width: size + 'px', height: size + 'px', background: color, boxShadow: `0 0 6px ${color}` });
      jobs.push(track(dot.animate([{ transform: `translate(${box.x}px,${box.y}px)`, opacity: 1 }, { transform: `translate(${box.x + Math.cos(angle) * distance}px,${box.y + Math.sin(angle) * distance - 10}px)`, opacity: 0 }], { duration: ms, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' })).then(() => dot.remove()));
    }
    return Promise.all(jobs);
  }
  function runes(box, { color = '#e8b85c', ms = 560, size = 1.35 } = {}) {
    const diameter = box.height * size;
    const ring = spawn('ygo-motion-runes', { width: diameter + 'px', height: diameter + 'px', borderColor: color, boxShadow: `0 0 12px ${color}, inset 0 0 10px ${color}` });
    return track(ring.animate([{ transform: `translate(${box.x - diameter / 2}px,${box.y - diameter / 2}px) scale(.3) rotate(0deg)`, opacity: 1 }, { transform: `translate(${box.x - diameter / 2}px,${box.y - diameter / 2}px) scale(1.15) rotate(120deg)`, opacity: 0 }], { duration: ms, easing: 'ease-out', fill: 'forwards' })).then(() => ring.remove());
  }
  function glow(box, color, ms = 380) {
    const width = box.width * 2.2, height = box.height * 2.2;
    const node = spawn('ygo-motion-dot', { width: width + 'px', height: height + 'px', background: `radial-gradient(circle, ${color}, transparent 65%)`, boxShadow: 'none' });
    return track(node.animate([{ transform: `translate(${box.x - width / 2}px,${box.y - height / 2}px) scale(.4)`, opacity: .95 }, { transform: `translate(${box.x - width / 2}px,${box.y - height / 2}px) scale(1.1)`, opacity: 0 }], { duration: ms, easing: 'ease-out', fill: 'forwards' })).then(() => node.remove());
  }

  async function animate(move, from, to, target) {
    if (target) { target.style.opacity = '0'; hiddenTargets.add(target); }
    const reveal = () => { if (target) { target.style.opacity = ''; hiddenTargets.delete(target); } };
    const card = move.card;
    switch (move.kind) {
      case 'draw': await fly(card, from, to, { ms: 460, lift: 30, flipFromBack: visible(card) }); break;
      case 'summon': runes(to, { color: '#e8b85c' }); await fly(card, from, to, { ms: 500, lift: 50 }); reveal(); embers(to, { color: '#ffb15a', count: 10, spread: 46 }); return;
      case 'set': await fly(null, from, to, { ms: 440, lift: 30 }); break;
      case 'activate': await fly(card, from, to, { ms: 480, lift: 45, flipFromBack: true }); reveal(); glow(to, '#5fe0c8'); runes(to, { color: '#5fe0c8' }); return;
      case 'activate-flip': reveal(); glow(to, '#c58cff'); embers(to, { color: '#a974ff', count: 12, spread: 50 }); runes(to, { color: '#a974ff', size: 1.2 }); return;
      case 'flip': reveal(); glow(to, '#f3d79b', 320); return;
      case 'mill': case 'discard': await fly(card, from, to, { ms: 460, lift: move.kind === 'mill' ? 35 : 20, end: 'rotate(-8deg)' }); reveal(); embers(to, { color: '#8a6a55', count: 8, spread: 26, size: 3 }); return;
      case 'destroy': embers(from, { color: '#ff5a4f', count: 14, spread: 58, size: 5, ms: 560 }); embers(from, { color: '#ffb15a', count: 8, spread: 38, size: 3, ms: 440 }); await fly(card, from, to, { ms: 500, lift: 15 }); break;
      case 'bounce': await fly(card, from, to, { ms: 500, lift: 60 }); break;
      case 'banish': embers(from, { color: '#a974ff', count: 16, spread: 44, size: 6, ms: 660 }); await fly(card, from, to, { ms: 520, lift: 25, fade: true, end: 'scale(.6)' }); break;
      default: await fly(card, from, to, { ms: 420, lift: 25 });
    }
    reveal();
  }

  return {
    // Prima del ridisegno: calcola i movimenti e misura le zone di partenza.
    prepare(previous, next, { mode, root = doc } = {}) {
      if (disposed || !doc || reduced()) { prepared = null; return 0; }
      const moves = cardMoves(previous, next, { mode });
      prepared = moves.length ? moves.map(move => ({ move, from: boxOf(cardNode(root, { ...move.from, player: move.player })) })).filter(row => row.from) : null;
      return prepared?.length || 0;
    },
    // Dopo il ridisegno: misura gli arrivi e anima tutto in parallelo.
    play(root = doc) {
      const rows = prepared; prepared = null;
      if (disposed || !rows?.length) return Promise.resolve();
      return Promise.all(rows.map((row, order) => {
        const target = cardNode(root, { ...row.move.to, player: row.move.player }), to = boxOf(target);
        if (!to) return null;
        // La carta vera all'arrivo resta nascosta finché il fantasma non atterra.
        const hideable = target?.classList?.contains('ygo-card') && !['flip', 'activate-flip'].includes(row.move.kind) ? target : null;
        return new Promise(resolve => setTimeout(resolve, order * 45)).then(() => animate(row.move, row.from, to, hideable));
      }));
    },
    // Un tocco: tutto al suo posto subito.
    skip() {
      prepared = null;
      for (const animation of [...animations]) { try { animation.finish(); } catch {} }
      for (const node of [...hiddenTargets]) node.style.opacity = '';
      hiddenTargets.clear(); layer?.replaceChildren();
    },
    get busy() { return animations.size > 0; },
    dispose() { this.skip(); layer?.remove(); layer = null; disposed = true; },
  };
}
