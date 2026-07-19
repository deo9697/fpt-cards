import { member, esc, initials } from './core.js';
import { icon } from './icons.js';

export function dashboardView(state, game = 'yugioh') {
  const me = member(state.currentUser);
  const personal = state.loans.filter(l => l.game === game && (l.owner === me.id || l.borrower === me.id));
  const active = personal.filter(l => l.status !== 'returned');
  const lent = active.filter(l => l.owner === me.id).reduce((sum, l) => sum + remaining(l), 0);
  const received = active.filter(l => l.borrower === me.id).reduce((sum, l) => sum + remaining(l), 0);
  const completed = personal.filter(l => l.status === 'returned').length;
  const attention = personal.filter(l =>
    (l.borrower === me.id && l.status === 'pending') ||
    (l.owner === me.id && l.status === 'return_pending')
  );
  return `<section class="dashboard">
    <div class="welcome-card"><div><span>F.P.T · Team Card Exchange</span><small>${greeting()}</small><h2>${me.name.split(' ')[0]}</h2><p>${attention.length ? `Hai ${attention.length} ${attention.length === 1 ? 'azione' : 'azioni'} da completare` : 'Registro in ordine · tutto sotto controllo'}</p></div><button type="button" class="welcome-avatar member-${me.id}" data-rick-secret aria-label="Profilo">${initials(me.name)}</button></div>

    ${attention.length ? `<section class="attention-card"><div class="dashboard-title"><div><span class="eyebrow">Richiede attenzione</span><h3>Azioni in sospeso</h3></div><b>${attention.length}</b></div>${attention.slice(0,3).map(attentionRow).join('')}<button class="text-action" data-quick="attention">Gestisci tutte</button></section>` : ''}

    <section class="summary-card"><div class="dashboard-title"><div><span class="eyebrow">Registro personale</span><h3>La tua zona scambi</h3></div><span class="archive-code">FPT–01</span></div><div class="metric-grid">
      ${metric(icon('swap'), lent, 'Carte prestate', 'gold')}
      ${metric(icon('card'), received, 'Carte ricevute', 'blue')}
      ${metric(icon('swap'), active.length, 'Prestiti attivi', 'violet')}
      ${metric('✓', completed, 'Completati', 'green')}
    </div></section>
  </section>`;
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Buongiorno' : hour < 18 ? 'Buon pomeriggio' : 'Buonasera';
}
function metric(symbol, value, label, color) { return `<article class="metric ${color}"><div>${symbol}</div><strong>${value}</strong><span>${label}</span></article>`; }
function remaining(loan) { return Math.max(0, loan.quantity - (loan.returnedQuantity || 0)); }
function attentionRow(l) {
  const from = member(l.owner), to = member(l.borrower);
  const text = l.status === 'pending' ? `${to.name} deve accettare` : `${from.name} deve confermare la resa`;
  return `<div class="attention-row"><span class="pulse-dot"></span><div><strong>${esc(l.cardName)}</strong><small>${text}</small></div><em>${l.quantity}×</em></div>`;
}
