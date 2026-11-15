// Runs before the SDK/modules. Dismiss on usable UI; never add a minimum wait.
// 2026-11-15 "tempesta di carte": card storm on two canvases (behind/in front
// of Blattaman), glitch title, terminal-style status with a log of finished
// steps. Card glows are baked once into sprites (no per-frame shadowBlur) and
// the loop stops as soon as the splash goes away or the page is hidden.
(() => {
  const splash = document.getElementById('app-launch');
  if (!splash) return;
  let finished = false, held = false, fallback, reveal, frame = 0;
  const timers = [];
  const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id; };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const status = splash.querySelector('[data-launch-status]');
  const log = splash.querySelector('[data-launch-log]');
  const bar = splash.querySelector('[data-launch-bar]');
  const SEGMENTS = 16;
  let filled = 2, logged = [];
  if (bar) bar.innerHTML = '<i></i>'.repeat(SEGMENTS);
  const paintBar = (done) => { if (!bar) return; [...bar.children].forEach((seg, i) => { seg.className = i < filled ? (done ? 'on is-done' : 'on') : ''; }); };
  const typeIn = () => {
    if (!status) return;
    status.style.setProperty('--chars', String(Math.max(1, status.textContent.length)));
    status.classList.remove('is-typing'); void status.offsetWidth; status.classList.add('is-typing');
  };
  const pushLog = label => {
    if (!log || !label) return;
    logged = [...logged, label.replace(/…$/, '')].slice(-2);
    log.innerHTML = '';
    for (const line of logged) { const row = document.createElement('div'); if (line === egg) row.className = 'is-egg'; const ok = document.createElement('b'); ok.textContent = '✓'; row.append(ok, ' ' + line); log.append(row); }
    filled = Math.min(SEGMENTS - 2, filled + 3); paintBar(false);
  };
  const setStatus = label => {
    if (finished || !status || !label || status.textContent === label) return;
    pushLog(status.textContent);
    status.textContent = label; typeIn();
  };

  // Frasi di attesa: solo mentre l'avvio non ha nulla di nuovo da dire.
  // Easter egg del team: compare in circa un avvio su tre (o con ?launch-egg).
  const EGGS = ['Trovo un lavoro a Cristofer', 'Insegno a suonare ad Arlia', 'Trovo un dentista a Nello'];
  const FILLER = ['Mescolo il mazzo', 'Conto le Secret Rare', 'Lucido le Ultra Rare', 'Controllo chi ti deve una carta'];
  const egg = (/[?&]launch-egg\b/.test(location.search) || Math.random() < 0.34) ? EGGS[Math.floor(Math.random() * EGGS.length)] : '';
  const fillers = FILLER.slice().sort(() => Math.random() - 0.5);
  if (egg) fillers.splice(Math.random() < 0.5 ? 0 : 1, 0, egg);
  splash.dataset.launchEgg = egg ? 'on' : 'off';
  const tickFiller = () => {
    if (finished) return;
    const line = fillers.shift();
    if (line) pushLog(line);
    // L'easter egg resta in vista: dopo di lui niente altre frasi di attesa.
    if (line !== egg && fillers.length) later(tickFiller, 650);
  };

  const checkReady = () => {
    const app = document.getElementById('app');
    if (held || !app?.firstElementChild || app.querySelector('.login-loading')) return;
    dismiss();
  };
  const observer = new MutationObserver(checkReady);
  function dismiss() {
    if (finished) return;
    finished = true;
    observer.disconnect(); clearTimeout(fallback); clearTimeout(reveal); timers.forEach(clearTimeout);
    cancelAnimationFrame(frame);
    filled = SEGMENTS; paintBar(true);
    splash.setAttribute('aria-hidden','true');
    splash.classList.add('is-ready');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content','#07080d');
    setTimeout(() => splash.remove(),450);
  }
  window.FPT_LAUNCH = {
    hold(label) { if (!finished) { held = true; setStatus(label); } },
    status: setStatus,
    release() { held = false; checkReady(); }
  };

  // ---- card storm -------------------------------------------------------
  const stage = splash.querySelector('.launch-stage');
  const back = splash.querySelector('[data-launch-storm="back"]'), front = splash.querySelector('[data-launch-storm="front"]');
  const bx = back?.getContext('2d'), fx = front?.getContext('2d');
  const PAD = 10, SW = 86, SH = 124;
  const sprite = draw => { const c = document.createElement('canvas'); c.width = SW + PAD * 2; c.height = SH + PAD * 2; draw(c.getContext('2d')); return c; };
  const glowFrame = (g, color) => { g.shadowColor = color; g.shadowBlur = 9; g.fillStyle = '#000'; g.fillRect(PAD, PAD, SW, SH); g.shadowBlur = 0; };
  const fptSprite = () => sprite(g => {
    glowFrame(g, '#ff4fd8');
    const grad = g.createLinearGradient(PAD, PAD, PAD + SW, PAD + SH); grad.addColorStop(0, '#2a1250'); grad.addColorStop(1, '#0c0618');
    g.fillStyle = grad; g.fillRect(PAD, PAD, SW, SH);
    g.strokeStyle = '#e8b84f'; g.lineWidth = 3; g.strokeRect(PAD + 3, PAD + 3, SW - 6, SH - 6);
    g.strokeStyle = '#ff4fd8'; g.lineWidth = 1; g.strokeRect(PAD + 8, PAD + 8, SW - 16, SH - 16);
    const cx = PAD + SW / 2, cy = PAD + SH / 2, r = 22; g.beginPath();
    for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i - Math.PI / 2; g.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
    g.closePath(); g.strokeStyle = '#e8b84f'; g.lineWidth = 2.5; g.stroke();
    g.fillStyle = '#fff1c4'; g.font = "900 13px 'Cinzel FPT', Georgia, serif"; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('FPT', cx, cy + 1);
  });
  const sprites = { fpt: fptSprite(), ygo: null };
  document.fonts?.ready?.then(() => { if (!finished) sprites.fpt = fptSprite(); });
  const backArt = new Image();
  backArt.onload = () => { sprites.ygo = sprite(g => { glowFrame(g, '#9b5cff'); g.drawImage(backArt, PAD, PAD, SW, SH); g.strokeStyle = '#d6965b88'; g.lineWidth = 1; g.strokeRect(PAD + .5, PAD + .5, SW - 1, SH - 1); }); };
  backArt.src = 'assets/loading/yugioh-card-back.jpg';

  const N = 34, rnd = (a, b) => a + Math.random() * (b - a);
  const cards = Array.from({ length: N }, (_, i) => ({
    art: i % 2 ? 'fpt' : 'ygo', a: rnd(0, Math.PI * 2), sp: rnd(.9, 1.7) * (i % 5 ? 1 : 1.5), h: rnd(0, 1), hs: rnd(.05, .12),
    r: rnd(.75, 1.15), w: rnd(26, 40), spin: rnd(-3, 3), rot: rnd(0, 6.28), close: i % 9 === 0
  }));
  splash.dataset.launchCards = String(N);
  let W = 0, H = 0, DPR = 1;
  const size = () => {
    if (!stage || !back || !front) return;
    const rect = stage.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1); W = rect.width; H = rect.height;
    for (const c of [back, front]) { c.width = Math.max(1, Math.round(W * DPR)); c.height = Math.max(1, Math.round(H * DPR)); }
  };
  const drawCard = (g, c, x, y, w, rot, alpha, flip) => {
    const img = sprites[c.art]; if (!img) return;
    const scale = w / SW, dw = img.width * scale, dh = img.height * scale;
    g.save(); g.globalAlpha = alpha; g.translate(x, y); g.rotate(rot); g.scale(Math.max(.08, Math.abs(flip)), 1);
    g.drawImage(img, -dw / 2, -dh / 2, dw, dh); g.restore();
  };
  let start = 0, last = 0;
  const paint = (now, still) => {
    if (!bx || !fx || !W) return;
    const dt = still ? 0 : Math.min(.05, (now - (last || now)) / 1000); last = now;
    const burst = still ? 1 : Math.min(1, (now - start) / 700), ease = 1 - Math.pow(1 - burst, 3);
    for (const g of [bx, fx]) { g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, W, H); }
    const cx = W / 2, cy = H * .5;
    for (const c of cards) {
      c.rot += c.spin * dt; c.a += c.sp * dt * 1.6; c.h = (c.h + c.hs * dt) % 1;
      const s = Math.sin(c.a), co = Math.cos(c.a), depth = (s + 1) / 2, isFront = s > 0;
      const radius = W * .44 * c.r * (.55 + c.h * .6) * ease;
      const x = cx + co * radius, y = cy + (.5 - c.h) * H * .8 * ease + s * 18;
      let w = c.w * (.6 + depth * .7); if (c.close && isFront) w *= 1.9;
      const alpha = (.35 + depth * .65) * Math.min(1, burst * 2), g = isFront ? fx : bx;
      if (c.close && isFront && !still) for (let k = 3; k >= 1; k--) drawCard(g, c, x - co * k * 9, y - k * 4, w, c.rot - k * .08, alpha * .12 * k, co);
      drawCard(g, c, x, y, w, c.rot + c.a * .2, alpha, co);
    }
  };
  const loop = now => {
    if (finished) return;
    if (!document.hidden) paint(now, false);
    frame = requestAnimationFrame(loop);
  };

  // ---- glitch + flash -----------------------------------------------------
  const logo = splash.querySelector('[data-launch-logo]'), flash = splash.querySelector('[data-launch-flash]');
  const retrigger = (node, cls) => { if (!node) return; node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };
  const glitchLoop = () => { if (finished) return; retrigger(logo, 'is-glitch'); later(glitchLoop, 2600); };

  const mascot = splash.querySelector('[data-launch-mascot]');
  const showMascot = () => { if (!finished && mascot?.naturalWidth) splash.classList.add('has-mascot'); };
  mascot?.addEventListener('load',showMascot,{once:true});
  if (mascot?.complete) showMascot();
  paintBar(false);
  requestAnimationFrame(() => {
    reveal = setTimeout(() => {
      if (finished) return;
      splash.classList.add('is-branded');
      size();
      if (reduced) { const still = () => paint(0, true); still(); backArt.addEventListener('load', () => setTimeout(still), { once:true }); splash.dataset.launchStorm = 'static'; return; }
      splash.dataset.launchStorm = 'live';
      start = performance.now(); retrigger(flash, 'is-on'); typeIn();
      frame = requestAnimationFrame(loop);
      later(glitchLoop, 250); later(tickFiller, 500);
    },120);
  });
  window.addEventListener('resize', size);
  observer.observe(document.body,{childList:true,subtree:true});
  // Failed SDK, offline boot or a slow RPC must not trap the user behind a splash.
  fallback = setTimeout(dismiss,6000);
  window.addEventListener('pagehide',dismiss,{once:true});
})();
