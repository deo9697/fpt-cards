// Hold still to read a card; move after the hold to drag it. State mutations
// and destination legality belong to the controller.
export function createDuelCardGestures({ canStart = () => false, canInspect = canStart, getRevision = () => null, onStart = () => {}, onDrop = () => {}, onInspect = () => {}, onCancel = () => {}, environment = globalThis, longPressMs = 320, inspectMs = 700 } = {}) {
  const env = environment;
  const setTimer = (env.setTimeout || globalThis.setTimeout).bind(env);
  const clearTimer = (env.clearTimeout || globalThis.clearTimeout).bind(env);
  const now = () => env.performance?.now?.() ?? Date.now();
  let root = null, doc = null, gesture = null, disposed = false;
  let suppression = null, suppressionTimer = null;
  const targetSelector = '[data-ygo-slot],[data-ygo-drop-zone]';
  const closest = (element, selector) => element?.closest?.(selector) || element?.parentElement?.closest?.(selector) || null;
  const allowed = (card, predicate = canStart) => { try { return Boolean(predicate(card)); } catch { return false; } };
  const revision = () => { try { return getRevision(); } catch { return Symbol('invalid revision'); } };
  const same = value => gesture === value && !disposed && root?.contains?.(value.card) && value.card.isConnected !== false && value.revision === revision() && (value.dragging ? allowed(value.card) : allowed(value.card, canInspect) || allowed(value.card));
  const coordinates = (event, value) => ({ x:Number.isFinite(event.clientX) ? event.clientX : value.x, y:Number.isFinite(event.clientY) ? event.clientY : value.y });

  function clearSuppression() {
    if (suppressionTimer !== null) clearTimer(suppressionTimer);
    suppressionTimer = null; suppression = null;
  }
  function suppressClick(value, untilRelease = false) {
    clearSuppression();
    suppression = { cardId:value.cardId, player:value.player, pointerId:value.pointerId, until:now() + 400, untilRelease };
    if (!untilRelease) suppressionTimer = setTimer(clearSuppression, 400);
  }
  function onClick(event) {
    if (!suppression || !suppression.untilRelease && now() > suppression.until) return;
    const card = closest(event.target, '[data-ygo-card]');
    const matchingCard = card?.dataset.ygoCard === suppression.cardId && Number(card.dataset.player) === suppression.player;
    const matchingPointer = Number.isFinite(event.pointerId) && event.pointerId === suppression.pointerId;
    if (!matchingCard && !matchingPointer) return;
    event.preventDefault(); event.stopImmediatePropagation(); clearSuppression();
  }
  function clearTarget(value) {
    value.target?.classList?.remove('is-drag-target', 'is-touch-drop-target'); value.target = null;
  }
  function dropTarget(x, y, value) {
    const target = closest(doc?.elementFromPoint?.(x, y), targetSelector);
    if (!target || !root?.contains?.(target) || target.disabled || target.getAttribute?.('aria-disabled') === 'true' || Number(target.dataset.player) !== value.player) return null;
    const zone = target.dataset.zone || target.dataset.ygoDropZone;
    if (!zone) return null;
    let slot;
    if (target.dataset.ygoSlot !== undefined) slot = Number(target.dataset.ygoSlot);
    else if (target.dataset.ygoDropSlot !== undefined) slot = Number(target.dataset.ygoDropSlot);
    if (slot !== undefined && (!Number.isInteger(slot) || slot < 0)) return null;
    return { element:target, zone, slot };
  }
  function moveGhost(value) {
    if (value.ghost) value.ghost.style.transform = `translate3d(${value.x - value.width / 2}px,${value.y - value.height / 2}px,0)`;
    const target = dropTarget(value.x, value.y, value)?.element;
    if (target === value.target) return;
    clearTarget(value); value.target = target || null;
    target?.classList?.add('is-drag-target', 'is-touch-drop-target');
  }
  function clean(value) {
    if (value.timer !== null) clearTimer(value.timer);
    if (value.inspectTimer !== null) clearTimer(value.inspectTimer);
    value.timer = null; value.inspectTimer = null;
    clearTarget(value);
    value.ghost?.remove(); value.ghost = null;
    value.card.classList?.remove('is-drag-source', 'is-touch-dragging');
    root?.classList?.remove('is-touch-dragging');
    value.document?.removeEventListener('touchmove', onTouchMove, true);
    try { value.card.releasePointerCapture?.(value.pointerId); } catch { /* Already released by the browser. */ }
  }
  function cancel(reason = 'cancel') {
    const value = gesture; if (!value) return;
    gesture = null;
    if (value.held) suppressClick(value);
    clean(value);
    if (value.held) onCancel({ cardId:value.cardId, player:value.player, reason });
  }
  function inspect(value, untilRelease = false) {
    if (!same(value)) { cancel('revision'); return; }
    if (!allowed(value.card, canInspect)) { cancel('inspection'); return; }
    gesture = null; suppressClick(value, untilRelease); clean(value);
    onInspect({ cardId:value.cardId, player:value.player });
  }
  function arm(value) {
    if (!same(value)) { cancel('revision'); return; }
    value.timer = null; value.held = true;
    doc.addEventListener('touchmove', onTouchMove, { capture:true, passive:false });
    try { value.card.setPointerCapture?.(value.pointerId); } catch { /* Document listeners still finish the gesture. */ }
    if (allowed(value.card, canInspect)) value.inspectTimer = setTimer(() => inspect(value, true), Math.max(0, inspectMs - longPressMs));
  }
  function beginDrag(value) {
    if (!same(value) || !allowed(value.card)) { cancel('revision'); return; }
    if (value.inspectTimer !== null) clearTimer(value.inspectTimer);
    value.inspectTimer = null; value.dragging = true;
    const box = value.card.getBoundingClientRect();
    value.width = Math.max(20, box.width); value.height = Math.max(28, box.height);
    const ghost = doc.createElement('div');
    ghost.className = 'ygo-drag-ghost'; ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, { position:'fixed', left:'0', top:'0', width:`${value.width}px`, height:`${value.height}px`, pointerEvents:'none', zIndex:'1000' });
    const source = value.card.querySelector('img');
    if (source) {
      const image = doc.createElement('img');
      image.src = source.currentSrc || source.src; image.alt = ''; image.draggable = false;
      Object.assign(image.style, { width:'100%', height:'100%', objectFit:'contain', pointerEvents:'none' });
      ghost.appendChild(image);
    } else ghost.textContent = value.card.getAttribute('aria-label') || value.card.textContent || 'Carta';
    (doc.body || root).appendChild(ghost); value.ghost = ghost;
    value.card.classList?.add('is-drag-source', 'is-touch-dragging'); root.classList?.add('is-touch-dragging');
    moveGhost(value);
    onStart({ cardId:value.cardId, player:value.player });
  }
  function onDown(event) {
    if (disposed || !['touch', 'pen'].includes(event.pointerType)) return;
    if (gesture) { if (gesture.pointerId !== event.pointerId) cancel('multitouch'); return; }
    if (suppression?.untilRelease && suppression.pointerId === event.pointerId) clearSuppression();
    if (event.isPrimary === false || event.button != null && event.button !== 0) return;
    const card = closest(event.target, '[data-ygo-card]');
    if (!card || !root?.contains?.(card) || card.disabled || !allowed(card) && !allowed(card, canInspect)) return;
    const player = Number(card.dataset.player);
    if (![0, 1].includes(player) || !card.dataset.ygoCard) return;
    const value = { card, document:doc, player, cardId:card.dataset.ygoCard, pointerId:event.pointerId, revision:revision(), x:event.clientX, y:event.clientY, startX:event.clientX, startY:event.clientY, held:false, dragging:false, timer:null, inspectTimer:null, ghost:null, target:null };
    gesture = value;
    value.timer = setTimer(() => arm(value), Math.max(0, longPressMs));
  }
  function onMove(event) {
    const value = gesture; if (!value || event.pointerId !== value.pointerId) return;
    if (!same(value)) { cancel('revision'); return; }
    const point = coordinates(event, value); value.x = point.x; value.y = point.y;
    const moved = Math.hypot(value.x - value.startX, value.y - value.startY) > 10;
    if (!value.held) {
      if (moved) cancel('scroll');
      return;
    }
    if (!value.dragging && moved) {
      if (!allowed(value.card)) { cancel('scroll'); return; }
      beginDrag(value);
    }
    event.preventDefault(); if (value.dragging) moveGhost(value);
  }
  function onUp(event) {
    const value = gesture;
    if (!value) {
      if (suppression?.untilRelease && event.pointerId === suppression.pointerId) {
        suppression.untilRelease = false; suppression.until = now() + 400;
        suppressionTimer = setTimer(clearSuppression, 400); event.preventDefault();
      }
      return;
    }
    if (event.pointerId !== value.pointerId) return;
    if (!value.held) { gesture = null; clean(value); return; }
    event.preventDefault();
    if (!value.dragging) { inspect(value); return; }
    const point = coordinates(event, value), valid = same(value), destination = valid ? dropTarget(point.x, point.y, value) : null;
    gesture = null; suppressClick(value); clean(value);
    if (!destination) { onCancel({ cardId:value.cardId, player:value.player, reason:valid ? 'destination' : 'revision' }); return; }
    onDrop({ cardId:value.cardId, player:value.player, zone:destination.zone, slot:destination.slot, x:point.x, y:point.y });
  }
  function onLost(event) {
    if (gesture && event.pointerId === gesture.pointerId) cancel(event.type || 'pointercancel');
    else if (event.type === 'pointercancel' && suppression?.untilRelease && event.pointerId === suppression.pointerId) clearSuppression();
  }
  function onContextMenu(event) {
    if (gesture && closest(event.target, '[data-ygo-card]') === gesture.card && same(gesture)) { event.preventDefault(); event.stopPropagation(); }
  }
  function onNativeDrag(event) {
    if (gesture?.held && closest(event.target, '[data-ygo-card]') === gesture.card) { event.preventDefault(); event.stopPropagation(); }
  }
  function onTouchMove(event) {
    if (!gesture?.held) return;
    if (event.touches?.length > 1) { cancel('multitouch'); return; }
    // Also prevent the native pan on engines that dispatch legacy touchmove
    // alongside Pointer Events. Before the hold, normal hand scrolling wins.
    if (event.cancelable !== false) event.preventDefault();
  }
  function attachDocument(next) {
    if (doc === next) return;
    if (doc) {
      doc.removeEventListener('pointermove', onMove, true); doc.removeEventListener('pointerup', onUp, true);
      doc.removeEventListener('pointercancel', onLost, true); doc.removeEventListener('lostpointercapture', onLost, true);
      doc.removeEventListener('contextmenu', onContextMenu, true); doc.removeEventListener('dragstart', onNativeDrag, true); doc.removeEventListener('touchmove', onTouchMove, true); doc.removeEventListener('click', onClick, true);
    }
    doc = next;
    if (!doc) return;
    doc.addEventListener('pointermove', onMove, { capture:true, passive:false }); doc.addEventListener('pointerup', onUp, { capture:true, passive:false });
    doc.addEventListener('pointercancel', onLost, true); doc.addEventListener('lostpointercapture', onLost, true);
    doc.addEventListener('contextmenu', onContextMenu, true); doc.addEventListener('dragstart', onNativeDrag, true); doc.addEventListener('click', onClick, true);
  }
  function bind(element) {
    if (disposed || element === root) return;
    cancel('rebind'); root?.removeEventListener('pointerdown', onDown);
    root = element || null;
    attachDocument(root?.ownerDocument || (root ? env.document : null));
    root?.addEventListener('pointerdown', onDown, { passive:true });
  }
  function dispose() {
    if (disposed) return;
    disposed = true; cancel('dispose'); clearSuppression();
    root?.removeEventListener('pointerdown', onDown); root = null; attachDocument(null);
  }
  return { bind, cancel, dispose };
}
