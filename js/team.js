import {esc} from './core.js';
import {icon} from './icons.js';

export const teamFilters = {query:'',role:'all'};

export function teamMemberRows({members,currentUser,admin,avatar,title}) {
  const query=teamFilters.query.trim().toLocaleLowerCase('it');
  const visible=members.filter(m=>(!query||m.name.toLocaleLowerCase('it').includes(query))&&(teamFilters.role==='all'||(teamFilters.role==='admin'?m.role==='admin':m.role!=='admin')));
  const rows=visible.map(m=>{
    const self=m.id===currentUser,isAdmin=m.role==='admin';
    return `<article class="team-person ${self?'is-self':''}">
      <div class="team-person-avatar">${avatar(m)}</div>
      <div class="team-person-copy"><h3>${esc(m.name)} ${self?'<span class="team-you">Tu</span>':''}</h3><p>${esc(title(m))}</p></div>
      <span class="team-role ${isAdmin?'is-admin':''}">${isAdmin?'Admin':'Membro'}</span>
      ${admin&&!isAdmin?`<div class="team-person-actions"><button type="button" class="btn secondary small" data-member-action="reset-pin" data-member-id="${esc(m.id)}">${icon('lock')} Reset PIN</button><button type="button" class="btn secondary danger small" data-member-action="deactivate" data-member-id="${esc(m.id)}">${icon('logout')} Disattiva</button></div>`:''}
    </article>`;
  }).join('');
  return `<p class="team-result-count" role="status">${visible.length} ${visible.length===1?'membro':'membri'}${query?' trovati':''}</p><div class="team-roster">${rows||`<div class="team-no-results">${icon('search')}<h3>Nessun membro trovato</h3><p>Prova un altro nome o cambia filtro.</p></div>`}</div>`;
}

export function renderTeamPage(model) {
  const {members,admin,supported,configured,openLoans}=model;
  const admins=members.filter(m=>m.role==='admin').length;
  const stats=[['team',members.length,'Membri'],['lock',admins,'Admin'],['swap',openLoans,'Prestiti aperti'],['bell',configured?'On':'Off','Notifiche']];
  return `<section class="team-page page-stack">
    <header class="team-hero"><div><span class="eyebrow">F.P.T Cards · La tua squadra</span><h1>Il DREAM team</h1><p>chi squadrune...<br>Il team fa la differenza.</p></div><img src="assets/fpt-card-hero.png" alt="" aria-hidden="true"></header>
    <div class="team-summary" aria-label="Riepilogo team">${stats.map(([symbol,value,label])=>`<div>${icon(symbol)}<strong>${value}</strong><small>${label}</small></div>`).join('')}</div>
    <section class="team-notifications"><span class="team-notification-icon">${icon('bell')}</span><div><h2>Notifiche richieste</h2><p>${!supported?'Le notifiche push non sono supportate su questo browser.':configured?'Push configurate su questo dispositivo.':'Ricevi le richieste di prestito anche quando l’app è chiusa.'}</p></div><button type="button" class="btn secondary" id="enable-notifications" ${!supported?'disabled':''}>${configured?'Riconfigura':'Configura'} ${icon('arrow')}</button></section>
    <section class="team-members" aria-labelledby="team-members-title"><div class="team-section-heading">${icon('team')}<div><h2 id="team-members-title">${admin?'Gestione membri':'La squadra'}</h2><p>${admin?'Tutti i tuoi compagni, in un solo posto.':'Conosci i membri del tuo team F.P.T.'}</p></div></div>
      <div class="team-toolbar"><label class="team-search">${icon('search')}<input type="search" data-team-search aria-label="Cerca un membro" placeholder="Cerca un membro…" value="${esc(teamFilters.query)}"></label>${admin?`<button type="button" class="btn team-add-toggle" data-team-add-toggle aria-expanded="false" aria-controls="team-add-panel">${icon('plus')} Aggiungi</button>`:''}</div>
      ${admin?`<div id="team-add-panel" class="team-add-panel" hidden><form id="member-form"><label for="new-member-name">Nome e cognome</label><div><input id="new-member-name" autocomplete="name" maxlength="100" placeholder="Nome del nuovo membro" required><button class="btn" type="submit">Crea membro</button></div><small>Il membro imposterà il suo PIN al primo accesso.</small></form></div>`:''}
      <div class="team-filters" role="group" aria-label="Filtra membri">${[['all','Tutti',members.length],['admin','Admin',admins],['member','Membri',members.length-admins]].map(([value,label,count])=>`<button type="button" data-team-filter="${value}" aria-pressed="${teamFilters.role===value}" class="${teamFilters.role===value?'active':''}">${label} <span>${count}</span></button>`).join('')}</div>
      <div data-team-results>${teamMemberRows(model)}</div>
    </section>
  </section>`;
}

export function bindTeamPage(root,model,onMemberAction) {
  const page=root.querySelector('.team-page');if(!page)return;
  const refresh=()=>{page.querySelector('[data-team-results]').innerHTML=teamMemberRows(model);};
  page.querySelector('[data-team-search]').addEventListener('input',event=>{teamFilters.query=event.target.value;refresh();});
  page.addEventListener('click',event=>{
    const filter=event.target.closest('[data-team-filter]');
    if(filter){teamFilters.role=filter.dataset.teamFilter;page.querySelectorAll('[data-team-filter]').forEach(button=>{const active=button===filter;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});refresh();}
    const add=event.target.closest('[data-team-add-toggle]');
    if(add){const panel=page.querySelector('#team-add-panel');panel.hidden=!panel.hidden;add.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)panel.querySelector('input').focus();}
    const action=event.target.closest('[data-member-action]');
    if(action&&model.admin)onMemberAction(action.dataset.memberAction,action.dataset.memberId);
  });
}
