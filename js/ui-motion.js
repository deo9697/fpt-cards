let previousView = '';

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const animator = () => window.Motion?.animateMini || window.Motion?.animate;

export function prepareUi(game, page, loggedIn) {
  const key = `${loggedIn ? 'app' : 'login'}:${game}:${page}`;
  const changed = key !== previousView;
  const initial = !previousView;
  previousView = key;
  document.body.dataset.game = game;
  document.body.dataset.page = loggedIn ? page : 'login';
  return { changed, initial };
}

export function paintWithTransition(_ui, paint) {
  // Il DOM deve essere aggiornato subito: form nativi e tastiere mobile possono
  // perdere selezione/focus se l'update viene rinviato dalla View Transition API.
  // Motion gestisce comunque l'animazione visiva dopo il paint.
  paint();
}

export function animateInterface({ changed }) {
  if (reducedMotion()) return;
  const animate = animator();
  if (!animate) return;

  if (changed) {
    const stage = document.querySelector('.page-stage, .login');
    if (stage) animate(stage, { opacity:[0, 1], transform:['translateY(9px)', 'translateY(0)'] }, { duration:.34, ease:'ease-out' });

    document.querySelectorAll('.page-stage > .section-heading, .dashboard > *, .page-stage > .card, .team-list > *').forEach((node, index) => {
      animate(node, { opacity:[0, 1], transform:['translateY(12px) scale(.985)', 'translateY(0) scale(1)'] }, {
        duration:.38,
        delay:Math.min(index * .045, .22),
        ease:'ease-out'
      });
    });
  }

  if (document.querySelector('.game-menu.open')) {
    document.querySelectorAll('.game-menu.open .game-options > button').forEach((node, index) => {
      animate(node, { opacity:[0, 1], transform:['translateX(-8px)', 'translateX(0)'] }, { duration:.24, delay:index * .04, ease:'ease-out' });
    });
  }
}
