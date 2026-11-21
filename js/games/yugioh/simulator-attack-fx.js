// Animazioni di battaglia, stile A «Carica» (2026-11-21). Solo presentazione:
// guarda lo stato prima/dopo e anima ciò che il motore ha già deciso.
// - attacco dichiarato: l'attaccante scatta verso il bersaglio (o verso i Life
//   Points avversari se l'attacco è diretto) con scia dorata, lampo e onda d'urto;
// - Life Points che calano: riquadro che trema, danno che sale, numero che scende.
// Tutto vive in un livello fisso nel body: i ridisegni del tavolo non lo toccano.

const BOARD = ['monsters', 'extraMonsters'];
const autoKey = battle => battle?.attacker ? JSON.stringify([battle.attacker, battle.target || null]) : '';

/** Pure: attack declarations and Life Point losses between two states. */
export function battleFxEvents(previous, next, { auto = false } = {}) {
  if (!previous?.players || !next?.players) return null;
  let attack = null;
  const battle = next.battle;
  if (battle) {
    if (auto) {
      const key = autoKey(battle);
      if (key && key !== autoKey(previous.battle)) {
        const attackerPlayer = battle.attacker.controller;
        attack = { auto: true, attackerPlayer, attacker: battle.attacker, target: battle.target || null };
      }
    } else if (battle.attackerId && battle.id !== previous.battle?.id) {
      attack = { auto: false, attackerPlayer: battle.player, attackerId: battle.attackerId, target: battle.target || null };
    }
  }
  const damage = [];
  next.players.forEach((player, index) => {
    const before = Number(previous.players[index]?.lp), after = Number(player?.lp);
    if (Number.isFinite(before) && Number.isFinite(after) && after < before) damage.push({ player: index, from: before, to: after });
  });
  return attack || damage.length ? { attack, damage } : null;
}

function cardAt(session, player, pointer) {
  const p = session?.players?.[player];
  if (!p || !pointer) return null;
  for (const zone of BOARD) {
    const card = (p[zone] || []).find(card => card && card.location === pointer.location && card.sequence === pointer.sequence);
    if (card) return card;
  }
  return null;
}

export function createAttackFx({ doc = globalThis.document } = {}) {
  let layer = null, disposed = false;
  const running = new Set();
  const reduced = () => { try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; } };
  const ensureLayer = () => {
    if (layer?.isConnected) return layer;
    layer = doc.createElement('div'); layer.className = 'ygo-attack-layer'; layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:fixed;inset:0;z-index:640;pointer-events:none;overflow:hidden';
    doc.body.appendChild(layer); return layer;
  };
  const track = animation => { running.add(animation); animation.finished.catch(() => {}).finally(() => running.delete(animation)); return animation.finished.catch(() => {}); };
  const spawn = css => { const node = doc.createElement('span'); node.style.cssText = 'position:absolute;left:0;top:0;' + css; ensureLayer().appendChild(node); return node; };
  const boxOf = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top }; };
  const at = (b, w, h, extra = '') => `translate(${b.x - w / 2}px,${b.y - h / 2}px) ${extra}`;

  function flash(b, color, size) {
    const s = Math.max(b.h, 40) * size, node = spawn(`width:${s}px;height:${s}px;border-radius:50%;background:radial-gradient(circle,${color},transparent 65%)`);
    return track(node.animate([{ transform: at(b, s, s, 'scale(.3)'), opacity: 1 }, { transform: at(b, s, s, 'scale(1.2)'), opacity: 0 }], { duration: 420, easing: 'ease-out', fill: 'forwards' })).then(() => node.remove());
  }
  function ring(b, color) {
    const s = Math.max(b.h, 40) * 1.6, node = spawn(`width:${s}px;height:${s}px;border-radius:50%;border:2px solid ${color};box-shadow:0 0 12px ${color}`);
    return track(node.animate([{ transform: at(b, s, s, 'scale(.2)'), opacity: 1 }, { transform: at(b, s, s, 'scale(1.3)'), opacity: 0 }], { duration: 520, easing: 'ease-out', fill: 'forwards' })).then(() => node.remove());
  }
  const shake = (el, amp = 6) => el ? track(el.animate([{ translate: '0 0' }, { translate: `${amp}px 0` }, { translate: `${-amp}px 0` }, { translate: `${amp / 2}px 0` }, { translate: '0 0' }], { duration: 320 })) : Promise.resolve();

  async function lunge(attackerEl, dest) {
    const a = boxOf(attackerEl), dx = dest.x - a.x, dy = dest.y - a.y, ang = Math.atan2(dx, -dy) * 180 / Math.PI, len = Math.hypot(dx, dy);
    const trail = spawn(`width:4px;height:${len}px;background:linear-gradient(transparent,#f3d79b);transform-origin:50% 100%;filter:blur(1px)`);
    trail.style.transform = `translate(${a.x - 2}px,${a.y - len}px) rotate(${ang}deg)`;
    track(trail.animate([{ opacity: 0 }, { opacity: .9, offset: .6 }, { opacity: 0 }], { duration: 520, fill: 'forwards' })).then(() => trail.remove());
    // Fantasma dell'attaccante: la carta vera resta nella sua casella (nascosta durante il volo).
    const ghost = attackerEl.cloneNode(true);
    ghost.removeAttribute('data-ygo-card'); ghost.classList.add('ygo-attack-ghost');
    Object.assign(ghost.style, { position: 'absolute', left: a.left + 'px', top: a.top + 'px', width: a.w + 'px', height: a.h + 'px', margin: '0', zIndex: '1' });
    ensureLayer().appendChild(ghost);
    const hide = attackerEl.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 760 });
    track(hide);
    const tilt = ang * .15;
    await track(ghost.animate([
      { transform: 'none' },
      { transform: `translateY(-8%) rotate(${tilt}deg) scale(1.08)`, offset: .3 },
      { transform: `translate(${dx * .85}px,${dy * .85}px) rotate(${tilt}deg) scale(1.08)`, offset: .55 },
      { transform: 'none' },
    ], { duration: 760, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' }));
    ghost.remove();
  }

  function targetElement(root, event, session, viewer) {
    const defender = 1 - event.attackerPlayer;
    if (!event.target) return { el: root.querySelector(`.ygo-duelist.${defender === viewer ? 'is-self' : 'is-opponent'}`), direct: true };
    if (event.auto) {
      const card = cardAt(session, event.target.controller, event.target);
      return { el: card && root.querySelector(`.ygo-field [data-ygo-card="${card.id}"][data-player="${event.target.controller}"]`), direct: false };
    }
    const { zone, slot } = event.target, card = (session?.players?.[defender]?.[zone] || []).find(card => card?.slot === slot);
    return { el: card && root.querySelector(`.ygo-field [data-ygo-card="${card.id}"][data-player="${defender}"]`) || root.querySelector(`[data-player="${defender}"][data-zone="${zone}"][data-slot="${slot}"]`), direct: false };
  }

  async function attack(root, event, session, viewer) {
    const attackerCard = event.auto ? cardAt(session, event.attackerPlayer, event.attacker) : { id: event.attackerId };
    const attackerEl = attackerCard && root.querySelector(`.ygo-field [data-ygo-card="${attackerCard.id}"][data-player="${event.attackerPlayer}"], .ygo-shared-extra [data-ygo-card="${attackerCard.id}"][data-player="${event.attackerPlayer}"]`);
    const { el: targetEl, direct } = targetElement(root, event, session, viewer);
    if (!attackerEl || !targetEl) return;
    const tb = boxOf(targetEl);
    if (reduced()) { await flash(tb, '#ff8a5e', 1.4); return; }
    await lunge(attackerEl, tb);
    if (disposed) return;
    flash(tb, '#fff3c4', 2); ring(tb, '#e8b85c'); if (!direct) flash(tb, '#ff5a4e', 1.2);
    await shake(targetEl, direct ? 8 : 6);
  }

  function damage(root, hit, viewer) {
    const box = root.querySelector(`.ygo-duelist.${hit.player === viewer ? 'is-self' : 'is-opponent'}`);
    if (!box) return Promise.resolve();
    const b = boxOf(box), amount = hit.from - hit.to;
    const label = spawn('font:800 clamp(18px,3.4vw,30px) Cinzel,Georgia,serif;color:#ff5a4e;text-shadow:0 0 10px #ff5a4e99,0 2px 0 #000;white-space:nowrap');
    label.textContent = '-' + amount;
    const jobs = [track(label.animate([
      { transform: `translate(${b.x - 20}px,${b.y}px)`, opacity: 0 },
      { transform: `translate(${b.x - 20}px,${b.y + 18}px)`, opacity: 1, offset: .25 },
      { transform: `translate(${b.x - 20}px,${b.y + 40}px)`, opacity: 0 },
    ], { duration: 1100, easing: 'ease-out', fill: 'forwards' })).then(() => label.remove())];
    if (!reduced()) jobs.push(shake(box, 7), flash(b, '#ff5a4e', 1.3));
    // Il numero scende da quello vecchio al nuovo (il ridisegno ha già scritto il valore finale).
    const number = box.querySelector('.ygo-duelist-info b');
    if (number && !reduced()) {
      const start = globalThis.performance?.now?.() ?? Date.now(), ms = 650, format = value => String(Math.round(value));
      const step = now => { if (disposed || !number.isConnected) return; const k = Math.min(1, (now - start) / ms); number.textContent = format(hit.from + (hit.to - hit.from) * k); if (k < 1) globalThis.requestAnimationFrame(step); };
      globalThis.requestAnimationFrame?.(step);
    }
    return Promise.all(jobs);
  }

  async function play(events, { root = doc, session, viewer }) {
    if (disposed || !events || !doc?.body) return;
    if (events.attack) await attack(root, events.attack, session, viewer).catch(error => console.error('attack-fx', error?.message));
    for (const hit of events.damage || []) damage(root, hit, viewer);
  }
  function skip() { for (const animation of [...running]) { try { animation.finish(); } catch {} } }
  function dispose() { disposed = true; skip(); layer?.remove(); layer = null; }
  return { play, skip, dispose };
}
