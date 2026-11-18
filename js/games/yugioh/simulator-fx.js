// Effetti visivi del duello — stile "Neon FPT" (scelto dall'utente 2026-11-18,
// artifact "Effetti duello FPT", variante A). Solo presentazione: non conosce
// le regole, non decide nulla. Il simulatore chiama questi comandi quando il
// SUO motore ha già stabilito cosa succede.
//
//   const fx = createDuelFx(rootElement);          // rootElement = il campo
//   await fx.phase('battle', { turn: 3, player: 'Daniele' });
//   await fx.summon({ type: 'synchro', level: 8, image, name });
//   const action = await fx.actionMenu({ anchor: cardEl, actions: [{ id, label, hint, disabled, reason }] });
//   const pick = await fx.chooseSummon({ image, name, level, atk, def, options: [...] });
//   fx.destroy();
//
// Grafica originale (nessun asset ufficiale). Solo transform/opacity e
// gradienti; con prefers-reduced-motion le animazioni durano un istante.

const PHASE_LABELS = Object.freeze({
  draw: 'Draw Phase', standby: 'Standby Phase', main1: 'Main Phase 1', battle: 'Battle Phase',
  main2: 'Main Phase 2', end: 'End Phase', 'your-turn': 'Il tuo turno', 'opponent-turn': 'Turno avversario',
});
const SUMMON_CAPTIONS = Object.freeze({
  normal: 'Evocazione Normale', tribute: 'Evocazione per Tributo', set: 'Posizionata coperta', special: 'Evocazione Speciale',
  synchro: 'Evocazione Synchro', xyz: 'Evocazione Xyz', link: 'Evocazione Link', fusion: 'Evocazione per Fusione',
  ritual: 'Evocazione Rituale', pendulum: 'Evocazione Pendulum',
});
// Durata (ms) di ogni effetto: la Promise si risolve alla fine.
const DURATIONS = Object.freeze({ phase: 1700, normal: 1300, tribute: 1500, set: 900, special: 1500, synchro: 3000, xyz: 3600, link: 3000, fusion: 3000, ritual: 2800, pendulum: 2600 });
// Frecce Link: nomi → angolo (0 = in alto, senso orario).
const LINK_DIRS = Object.freeze({ top: 0, 'top-right': 45, right: 90, 'bottom-right': 135, bottom: 180, 'bottom-left': 225, left: 270, 'top-left': 315 });

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
function el(doc, tag, className, attrs = {}) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'style') for (const [prop, val] of Object.entries(value)) node.style.setProperty(prop, val);
    else node.setAttribute(key, value);
  }
  return node;
}

export function createDuelFx(root, { doc = root?.ownerDocument || document, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!root) throw new Error('createDuelFx: serve l\'elemento del campo');
  const layer = el(doc, 'div', 'dfx-layer', { 'aria-live': 'polite' });
  root.classList.add('dfx-host');
  root.appendChild(layer);
  let busyTimer = null, pending = null;
  const time = ms => (reducedMotion() ? 60 : ms);

  // Un effetto alla volta: il nuovo interrompe il precedente (che si risolve).
  function play(nodes, ms, label) {
    finish();
    layer.replaceChildren(...nodes);
    if (label) layer.setAttribute('aria-label', label);
    return new Promise(resolve => {
      pending = resolve;
      busyTimer = setTimer(() => finish(), time(ms));
    });
  }
  function finish(value) {
    if (busyTimer !== null) { clearTimer(busyTimer); busyTimer = null; }
    layer.replaceChildren();
    layer.classList.remove('is-interactive');
    const resolve = pending; pending = null;
    resolve?.(value);
  }
  const caption = (text, delay) => el(doc, 'span', 'dfx-caption', { text, style: { '--d': delay + 's' } });
  const flash = delay => el(doc, 'span', 'dfx-flash', { style: { '--d': delay + 's' } });
  function card(image, glow, delay, name) {
    const box = el(doc, 'div', 'dfx-card', { style: { '--glow': glow, '--d': delay + 's' } });
    if (image) box.appendChild(el(doc, 'img', '', { src: image, alt: name || '', decoding: 'async' }));
    return box;
  }

  function phase(name, { turn, player } = {}) {
    const banner = el(doc, 'div', 'dfx-banner');
    banner.appendChild(el(doc, 'b', '', { text: PHASE_LABELS[name] || String(name || '') }));
    if (turn || player) banner.appendChild(el(doc, 'small', '', { text: [turn ? 'Turno ' + turn : '', player || ''].filter(Boolean).join(' · ') }));
    return play([banner], DURATIONS.phase, PHASE_LABELS[name] || name);
  }

  function summon({ type = 'normal', level = 4, rank = 4, link = 1, markers = [], image = '', name = '', materials = 2 } = {}) {
    const nodes = [];
    const label = SUMMON_CAPTIONS[type] || SUMMON_CAPTIONS.special;
    if (type === 'synchro') {
      const n = Math.max(1, Math.min(12, Number(level) || 1));
      for (let i = 0; i < n; i++) nodes.push(el(doc, 'span', 'dfx-ring', { style: { '--x': ((i % 2 ? 1 : -1) * (40 + i * 12)) + '%', '--y': (-60 + i * 18) + '%', '--ty': (-140 + i * 40) + '%', 'animation-delay': (i * 0.07) + 's' } }));
      for (let i = 0; i < n; i++) nodes.push(el(doc, 'i', 'dfx-star', { style: { '--sx': (20 + (i * 60) / n) + '%', '--sy': (18 + (i % 3) * 6) + '%', '--sd': (0.2 + i * 0.06) + 's' } }));
      nodes.push(el(doc, 'span', 'dfx-beam'), flash(1.2), card(image, '#bfe9ff', 1.35, name), caption(label + ' · LV ' + n, 1.4));
    } else if (type === 'xyz') {
      nodes.push(el(doc, 'span', 'dfx-vortex'));
      const count = Math.max(1, Math.min(5, Number(materials) || 2));
      for (let i = 0; i < count; i++) nodes.push(el(doc, 'span', 'dfx-orb', { style: { '--o0': (i * 360 / count) + 'deg', '--oc': i % 2 ? '#ff4fd8' : '#9b5cff' } }));
      nodes.push(card(image, '#9b5cff', 1.5, name));
      for (let i = 0; i < count; i++) nodes.push(el(doc, 'span', 'dfx-unit', { style: { '--u0': (i * 360 / count) + 'deg' } }));
      nodes.push(caption(label + ' · Rango ' + rank + ' · ' + count + ' materiali', 1.5));
    } else if (type === 'link') {
      const lit = (markers.length ? markers : ['bottom-left', 'bottom-right', 'top'].slice(0, Math.max(1, Math.min(3, Number(link) || 1)))).map(dir => LINK_DIRS[dir]).filter(v => v != null);
      Object.values(LINK_DIRS).forEach(angle => nodes.push(el(doc, 'span', 'dfx-arrow' + (lit.includes(angle) ? ' is-lit' : ''), { style: { '--r': angle + 'deg', '--ld': (0.25 + Math.max(0, lit.indexOf(angle)) * 0.25) + 's' } })));
      nodes.push(el(doc, 'span', 'dfx-link-num', { text: 'LINK-' + (Number(link) || lit.length) }), card(image, '#ff6b5a', 1.2, name), caption(label, 1.3));
    } else if (type === 'fusion') {
      nodes.push(el(doc, 'span', 'dfx-swirl', { style: { '--s0': '0deg', '--sc': '#9b5cff' } }), el(doc, 'span', 'dfx-swirl', { style: { '--s0': '180deg', '--sc': '#ffb15a' } }), el(doc, 'span', 'dfx-burst'), card(image, '#ffb15a', 1.45, name), caption(label, 1.5));
    } else if (type === 'ritual') {
      nodes.push(el(doc, 'span', 'dfx-rune-circle'), flash(1.1), card(image, '#7ad1ff', 1.25, name), caption(label, 1.3));
    } else if (type === 'pendulum') {
      nodes.push(el(doc, 'span', 'dfx-scale is-left'), el(doc, 'span', 'dfx-scale is-right'), card(image, '#48d98b', 1.1, name), caption(label, 1.2));
    } else {
      // normale, tributo, speciale, posizionata: impatto e onda d'urto
      nodes.push(el(doc, 'span', 'dfx-shock'), card(type === 'set' ? '' : image, type === 'special' ? '#ff4fd8' : '#e8b84f', 0.15, name), caption(label, 0.3));
    }
    return play(nodes, DURATIONS[type] || DURATIONS.special, label);
  }

  // Menu azioni ancorato a una carta. Risolve con l'id scelto, o null.
  function actionMenu({ anchor = null, actions = [] } = {}) {
    const menu = el(doc, 'div', 'dfx-menu', { role: 'menu' });
    const host = root.getBoundingClientRect(), box = anchor?.getBoundingClientRect?.() || host;
    menu.style.left = Math.max(4, Math.min(box.left - host.left, host.width - 220)) + 'px';
    menu.style.top = Math.max(4, Math.min(box.top - host.top - 8, host.height - 40 * (actions.length + 1))) + 'px';
    for (const action of [...actions, { id: null, label: 'Annulla' }]) {
      const button = el(doc, 'button', 'dfx-btn', { type: 'button', role: 'menuitem' });
      button.appendChild(el(doc, 'span', '', { text: action.label }));
      if (action.hint) button.appendChild(el(doc, 'kbd', '', { text: action.hint }));
      if (action.disabled) { button.disabled = true; if (action.reason) button.title = action.reason; }
      button.addEventListener('click', () => finish(action.id));
      menu.appendChild(button);
    }
    layer.classList.add('is-interactive');
    const result = play([menu], 10 * 60 * 1000, 'Azioni carta');
    layer.classList.add('is-interactive');
    menu.querySelector('button:not(:disabled)')?.focus?.();
    return result;
  }

  // Pannello "Come vuoi evocarlo?". options: [{ id, label, hint, note, disabled, reason, needsPosition }]
  // Risolve con { method, position } oppure null (Annulla).
  function chooseSummon({ image = '', name = '', level, atk, def, note = '', options = [] } = {}) {
    const panel = el(doc, 'div', 'dfx-choice', { role: 'dialog', 'aria-label': 'Come vuoi evocarlo?' });
    const figure = el(doc, 'figure');
    if (image) figure.appendChild(el(doc, 'img', '', { src: image, alt: name, decoding: 'async' }));
    figure.appendChild(el(doc, 'figcaption', '', { text: [level ? 'LV ' + level : '', atk != null ? 'ATK ' + atk : '', def != null ? 'DEF ' + def : ''].filter(Boolean).join(' · ') }));
    const body = el(doc, 'div', 'dfx-choice-body');
    body.appendChild(el(doc, 'h3', '', { text: 'Come vuoi evocarlo?' }));
    if (note) body.appendChild(el(doc, 'p', '', { text: note }));
    let method = options.find(option => !option.disabled)?.id || null, position = 'attack';
    const buttons = options.map(option => {
      const button = el(doc, 'button', 'dfx-btn dfx-option', { type: 'button', 'data-method': option.id });
      button.appendChild(el(doc, 'span', '', { text: option.label }));
      if (option.hint) button.appendChild(el(doc, 'kbd', '', { text: option.hint }));
      const detail = option.disabled ? option.reason : option.note;
      if (detail) button.appendChild(el(doc, 'small', '', { text: detail }));
      button.disabled = Boolean(option.disabled);
      button.addEventListener('click', () => { method = option.id; sync(); });
      body.appendChild(button);
      return button;
    });
    const pos = el(doc, 'div', 'dfx-pos', { role: 'group', 'aria-label': 'Posizione' });
    const posButtons = [['attack', 'Attacco'], ['defense', 'Difesa']].map(([id, label]) => {
      const button = el(doc, 'button', 'dfx-btn', { type: 'button', text: label, 'data-position': id });
      button.addEventListener('click', () => { position = id; sync(); });
      pos.appendChild(button);
      return button;
    });
    body.appendChild(pos);
    const row = el(doc, 'div', 'dfx-choice-actions');
    const cancel = el(doc, 'button', 'dfx-btn', { type: 'button', text: 'Annulla' });
    const confirm = el(doc, 'button', 'dfx-btn dfx-go', { type: 'button', text: 'Conferma' });
    cancel.addEventListener('click', () => finish(null));
    confirm.addEventListener('click', () => { if (method) finish({ method, position: options.find(o => o.id === method)?.needsPosition === false ? null : position }); });
    row.append(cancel, confirm);
    body.appendChild(row);
    function sync() {
      buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.method === method)));
      const needs = options.find(o => o.id === method)?.needsPosition !== false;
      pos.hidden = !needs;
      posButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.position === position)));
      confirm.disabled = !method;
    }
    sync();
    panel.append(figure, body);
    const result = play([panel], 10 * 60 * 1000, 'Come vuoi evocarlo?');
    layer.classList.add('is-interactive');
    return result;
  }

  return {
    phase, summon, actionMenu, chooseSummon,
    cancel: () => finish(null),
    get busy() { return pending !== null; },
    destroy() { finish(null); layer.remove(); root.classList.remove('dfx-host'); },
  };
}

export const DUEL_FX_PHASES = Object.keys(PHASE_LABELS);
export const DUEL_FX_SUMMONS = Object.keys(SUMMON_CAPTIONS);
