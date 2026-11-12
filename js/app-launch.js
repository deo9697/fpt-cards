// Runs before the SDK/modules. Dismiss on usable UI; never add a minimum wait.
(() => {
  const splash = document.getElementById('app-launch');
  if (!splash) return;
  let finished = false, held = false, fallback, reveal;
  const status = splash.querySelector('[data-launch-status]');
  const setStatus = label => { if (!finished && status && label) status.textContent = label; };
  const checkReady = () => {
    const app = document.getElementById('app');
    if (held || !app?.firstElementChild || app.querySelector('.login-loading')) return;
    dismiss();
  };
  const observer = new MutationObserver(checkReady);
  function dismiss() {
    if (finished) return;
    finished = true;
    observer.disconnect(); clearTimeout(fallback); clearTimeout(reveal);
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

  const storm = splash.querySelector('[data-launch-storm]');
  if (storm) for (let i=0;i<11;i++) {
    const card = document.createElement('i'); card.className = 'launch-card';
    for (const [name,value] of Object.entries({
      '--card-width':`${31+(i%4)*7}px`, '--orbit-time':`${6.8+(i%4)*.7}s`,
      '--orbit-delay':`${-(i*.81+.6)}s`, '--trail':`${36+(i%4)*13}px`,
      '--still-x':`${(i%4-1.5)*69}px`, '--still-y':`${Math.floor(i/4)*71-100}px`, '--still-rotate':`${i*27-40}deg`
    })) card.style.setProperty(name,value);
    const art = document.createElement('img');
    art.src='assets/loading/yugioh-card-back.jpg';art.alt='';art.width=428;art.height=614;
    card.append(art);storm.append(card);
  }
  const particles = splash.querySelector('[data-launch-particles]');
  if (particles) for (let i=0;i<14;i++) {
    const dot = document.createElement('i');dot.className='launch-particle';
    dot.style.setProperty('--x',`${15+(i*23)%72}%`);
    dot.style.setProperty('--duration',`${3+(i%5)*.8}s`);
    dot.style.setProperty('--delay',`${-(i*.53)}s`);
    particles.append(dot);
  }
  const mascot = splash.querySelector('[data-launch-mascot]');
  const showMascot = () => { if (!finished && mascot?.naturalWidth) splash.classList.add('has-mascot'); };
  mascot?.addEventListener('load',showMascot,{once:true});
  if (mascot?.complete) showMascot();
  requestAnimationFrame(() => {
    reveal = setTimeout(() => { if (!finished) splash.classList.add('is-branded'); },120);
  });
  observer.observe(document.body,{childList:true,subtree:true});
  // Failed SDK, offline boot or a slow RPC must not trap the user behind a splash.
  fallback = setTimeout(dismiss,6000);
  window.addEventListener('pagehide',dismiss,{once:true});
})();
