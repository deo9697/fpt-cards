// Orientation locking is a best effort browser capability. The arena must
// separately block play while isPortraitBlocked() is true, including on iOS.
// Fullscreen is requested only from a user gesture, never from a render.
export function createDuelOrientation({ onChange = () => {}, environment = globalThis, timeoutMs = 2500 } = {}) {
  const env = environment;
  const doc = env.document;
  const orientation = env.screen?.orientation;
  const setTimer = (env.setTimeout || globalThis.setTimeout).bind(env);
  const clearTimer = (env.clearTimeout || globalThis.clearTimeout).bind(env);
  const queue = (env.queueMicrotask || globalThis.queueMicrotask || (callback => Promise.resolve().then(callback))).bind(env);
  let active = false, disposed = false, listening = false, notifiedBlocked = false, notificationQueued = false;
  let operation = null, inFlight = null, fullscreenPending = null, ownedFullscreen = null, lockTouched = false;

  const media = query => { try { return Boolean(env.matchMedia?.(query).matches); } catch { return false; } };
  function isMobile() {
    const nav = env.navigator || {};
    return Boolean(media('(pointer: coarse)') || nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || '') || nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  }
  function portrait() {
    const width = Number(env.innerWidth || doc?.documentElement?.clientWidth || env.screen?.width);
    const height = Number(env.innerHeight || doc?.documentElement?.clientHeight || env.screen?.height);
    if (width > 0 && height > 0) return height >= width;
    return media('(orientation: portrait)');
  }
  function isPortraitBlocked() { return active && !disposed && isMobile() && portrait(); }
  function notify() {
    if (notificationQueued || disposed) return;
    notificationQueued = true;
    queue(() => {
      notificationQueued = false;
      if (disposed) return;
      const blocked = isPortraitBlocked();
      if (blocked === notifiedBlocked) return;
      notifiedBlocked = blocked;
      onChange({ blocked, mobile:isMobile(), active });
    });
  }
  function watch(install) {
    if (install === listening) return;
    listening = install;
    const method = install ? 'addEventListener' : 'removeEventListener';
    env[method]?.('resize', notify);
    env[method]?.('orientationchange', notify);
    orientation?.[method]?.('change', notify);
    doc?.[method]?.('fullscreenchange', notify);
  }
  const current = token => active && !disposed && operation === token;
  function unlock() { try { orientation?.unlock?.(); } catch { /* Unsupported or inactive document. */ } }
  function leaveOwnedFullscreen(element = ownedFullscreen) {
    if (!element) return Promise.resolve();
    if (ownedFullscreen === element) ownedFullscreen = null;
    if (doc?.fullscreenElement !== element || typeof doc?.exitFullscreen !== 'function') return Promise.resolve();
    try { return Promise.resolve(doc.exitFullscreen()).catch(() => {}); } catch { return Promise.resolve(); }
  }
  // Cancelled and non-settling platform promises cannot keep navigation or the
  // rotate button pending. Their eventual completion still gets cleaned up.
  function settle(token, promise, completed) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimer(timer); resolve(value); };
      const timer = setTimer(() => finish(false), Math.max(1, timeoutMs));
      Promise.resolve(promise).then(() => { completed?.(); finish(true); }, () => finish(false));
      token.cancelled.then(() => finish(false));
    });
  }
  function requestFullscreen(token) {
    const element = doc?.documentElement;
    if (doc?.fullscreenElement || typeof element?.requestFullscreen !== 'function') return Promise.resolve(true);
    if (fullscreenPending) return fullscreenPending;
    let promise;
    try { promise = element.requestFullscreen(); } catch { return Promise.resolve(false); }
    const waiting = settle(token, promise, () => {
      if (doc?.fullscreenElement !== element) return;
      if (current(token) || active && !disposed && isMobile()) ownedFullscreen = element;
      else void leaveOwnedFullscreen(element);
    });
    fullscreenPending = waiting;
    void waiting.then(() => { if (fullscreenPending === waiting) fullscreenPending = null; });
    return waiting;
  }
  async function attempt(token, fullscreen) {
    if (fullscreen) await fullscreen;
    if (!current(token) || !isMobile()) return false;
    if (typeof orientation?.lock !== 'function') return false;
    lockTouched = true;
    let promise;
    try { promise = orientation.lock('landscape'); } catch { return false; }
    const locked = await settle(token, promise, () => {
      // An old lock resolving after exit must not rotate a page we left. A
      // newer active mobile arena still wants the same landscape lock.
      if (!current(token) && (!active || disposed || !isMobile())) unlock();
    });
    notify();
    return locked && current(token);
  }
  function enter({ userGesture = false } = {}) {
    if (disposed) return Promise.resolve(false);
    if (active && !userGesture) return inFlight || Promise.resolve(!isPortraitBlocked());
    if (!active) {
      active = true;
      let cancel;
      const cancelled = new Promise(resolve => { cancel = resolve; });
      operation = { cancelled, cancel };
      watch(true);
    }
    notify();
    if (!isMobile()) return Promise.resolve(false);
    const token = operation;
    // Invoke requestFullscreen synchronously in the click's activation window.
    const fullscreen = userGesture ? requestFullscreen(token) : null;
    const task = attempt(token, fullscreen);
    inFlight = task;
    void task.then(() => { if (inFlight === task) inFlight = null; });
    return task;
  }
  function exit() {
    active = false;
    operation?.cancel(); operation = null;
    inFlight = null; fullscreenPending = null;
    watch(false);
    if (lockTouched) { lockTouched = false; unlock(); }
    notify();
    return leaveOwnedFullscreen();
  }
  function dispose() { const cleanup = exit(); disposed = true; return cleanup; }
  return { enter, exit, dispose, isMobile, isPortraitBlocked };
}
