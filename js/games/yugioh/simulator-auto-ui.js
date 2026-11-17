// SPDX-License-Identifier: AGPL-3.0-or-later
// This module renders choices; all legality and effects remain on the server.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const multiKinds = new Set(['select', 'tribute', 'sum', 'sort', 'race', 'attribute', 'place']);
export const autoIsMulti = prompt => multiKinds.has(prompt?.kind);
export function autoOptionsForCard(prompt, card) {
  if (!prompt || !card || card.hidden) return [];
  return (prompt.options || []).filter(option => {
    const source = option.card;
    return source && source.controller === card.controller && source.location === card.location && source.sequence === card.sequence;
  });
}
export function autoPlaceOption(prompt, player, zone, slot) {
  if (prompt?.kind !== 'place') return null;
  return prompt.options.find(option => {
    const place = option.place;
    if (!place || place.player !== player) return false;
    const actualZone = place.location === 4 ? place.sequence < 5 ? 'monsters' : 'extraMonsters' : place.location === 8 ? place.sequence === 5 ? 'field' : 'spells' : '';
    const actualSlot = actualZone === 'extraMonsters' ? player === 0 ? place.sequence - 5 : 1 - (place.sequence - 5) : actualZone === 'field' ? 0 : place.sequence;
    return zone === actualZone && slot === actualSlot;
  });
}
const art = code => Number.isSafeInteger(Number(code)) && Number(code) > 0 ? `https://images.ygoprodeck.com/images/cards/${Number(code)}.jpg` : '';
function optionView(controller, option, prompt, index) {
  const selected = controller.autoSelected?.includes(option.id), src = art(option.card?.code);
  if(prompt.kind==='counter')return `<label class="ygo-auto-counter">${src?`<img src="${src}" alt="">`:''}<span>${esc(option.label)}<small>Disponibili: ${Number(option.available)}</small></span><input type="number" data-ygo-auto-counter="${esc(option.id)}" min="0" max="${Number(option.available)}" value="${controller.autoCounts?.[option.id]||0}" inputmode="numeric" aria-label="Segnalini da rimuovere da ${esc(option.label)}"></label>`;
  return `<button type="button" data-ygo-auto-option="${esc(option.id)}" class="ygo-auto-option ${selected || option.selected ? 'is-selected' : ''}" aria-pressed="${Boolean(selected || option.selected)}" ${controller.pending ? 'disabled' : ''}>${src ? `<img src="${src}" alt="" draggable="false">` : ''}<span>${esc(option.label)}${option.effect ? `<small>${esc(option.effect)}</small>` : ''}${prompt.kind === 'sort' && selected ? `<b>${controller.autoSelected.indexOf(option.id) + 1}</b>` : ''}${option.contribution > 1 ? `<small>Vale ${option.contribution} tributi</small>` : ''}${option.contributions ? `<small>Livello ${option.contributions.join(' / ')}</small>` : ''}</span>${prompt.kind === 'counter' ? `<input type="number" data-ygo-auto-counter="${esc(option.id)}" min="0" max="${Number(option.available)}" value="${controller.autoCounts?.[option.id] || 0}" inputmode="numeric" aria-label="Segnalini da rimuovere da ${esc(option.label)}">` : ''}</button>`;
}
export function autoPromptView(controller) {
  const session = controller.session, prompt = session.auto?.prompt;
  if (controller.duel.status === 'setup' || session.result) return '';
  if (!prompt) return `<section class="ygo-auto-prompt is-waiting" role="status"><strong>Attesa avversario</strong><small>${esc(session.players[session.auto?.waitingPlayer ?? 1 - controller.viewer]?.name || 'Il compagno')} sta scegliendo.</small></section>`;
  const compact = ['idle', 'battle'].includes(prompt.kind), selected = controller.autoSelected || [];
  const cardOptions = prompt.options.filter(option => option.card), otherOptions = prompt.options.filter(option => !option.card);
  if (compact && !controller.autoExpanded) return `<section class="ygo-auto-prompt is-compact" aria-label="Comandi automatici"><strong>${esc(prompt.title)}</strong><small>Tocca una carta per le azioni consentite.</small><div class="ygo-auto-controls">${otherOptions.map(option => optionView(controller, option, prompt)).join('')}<button type="button" data-ygo-command="auto-expand" ${controller.pending ? 'disabled' : ''}>Azioni · ${cardOptions.length}</button></div></section>`;
  const multi = autoIsMulti(prompt), options = prompt.kind === 'announce-card' ? (controller.autoSearchResults || []).map(row => ({id: `announce-${row.code}`, label: row.name, card: {code: row.code}})) : prompt.options;
  return `<section class="ygo-auto-prompt ${compact ? 'is-expanded' : ''}" role="region" aria-label="${esc(prompt.title)}" aria-live="polite"><header><div><small>TCG · AUTOMATICO</small><strong>${esc(prompt.title)}</strong></div>${compact ? '<button type="button" data-ygo-command="auto-collapse">Riduci</button>' : ''}</header>${prompt.kind === 'sort' ? '<small>Tocca le carte nell’ordine desiderato. Ritocca per rimuovere una scelta.</small>' : multi ? `<small>${selected.length} selezionate · ${prompt.min === prompt.max ? prompt.min : `${prompt.min}–${prompt.max}`} richieste</small>` : ''}${prompt.mandatory?.length ? `<small>Materiali obbligatori: ${prompt.mandatory.map(row => esc(row.label)).join(', ')}</small>` : ''}${prompt.kind === 'announce-card' ? '<form data-ygo-auto-search class="ygo-auto-search"><input name="query" type="search" placeholder="Nome o passcode" minlength="2" maxlength="100" required aria-label="Cerca la carta da dichiarare"><button type="submit">Cerca</button></form>' : ''}<div class="ygo-auto-options">${options.map((option, index) => optionView(controller, option, prompt, index)).join('')}${prompt.kind === 'announce-card' && !options.length ? '<small>Cerca una carta consentita dall’effetto.</small>' : ''}</div><div class="ygo-auto-controls">${multi ? `<button type="button" class="ygo-primary" data-ygo-command="auto-confirm" ${controller.pending || selected.length < prompt.min || selected.length > prompt.max ? 'disabled' : ''}>Conferma${prompt.kind === 'sort' ? ' ordine' : ''}</button>` : ''}${prompt.kind === 'counter' ? `<button type="button" class="ygo-primary" data-ygo-command="auto-counters" ${controller.pending ? 'disabled' : ''}>Conferma segnalini</button>` : ''}${prompt.canFinish ? `<button type="button" data-ygo-command="auto-finish" ${controller.pending ? 'disabled' : ''}>Fine selezione</button>` : ''}${prompt.cancelable && !prompt.options.some(option => option.id === 'pass') ? `<button type="button" data-ygo-command="auto-cancel" ${controller.pending ? 'disabled' : ''}>Annulla</button>` : ''}</div></section>`;
}

export function autoRevealView(controller) {
  const cards=controller.session.auto?.revealedCards||[],key=cards.map(card=>card.revealId).join(':');
  if(!cards.length||controller.autoDismissedReveal===key)return '';
  return `<section class="ygo-auto-reveals" aria-label="Carte mostrate dall’effetto"><header><strong>Carte rivelate</strong><button type="button" data-ygo-command="auto-close-reveals" aria-label="Chiudi carte rivelate">×</button></header><div>${cards.map((card,index)=>`<button type="button" data-ygo-auto-reveal-index="${index}" aria-label="Leggi ${esc(card.cardName)}"><img src="${art(card.code)}" alt="${esc(card.cardName)}" draggable="false"></button>`).join('')}</div></section>`;
}

export function autoBattleMessage(session) {
  const battle=session.battle;if(!battle?.attacker)return '';
  const label=pointer=>{
    const player=session.players[pointer.controller],card=[...player.monsters,...player.extraMonsters].find(card=>card.controller===pointer.controller&&card.location===pointer.location&&card.sequence===pointer.sequence);
    return `${player.name}: ${card&&!card.hidden?card.cardName:'Mostro coperto'}`;
  };
  return `${battle.stage==='damage'?'Damage Step':'Attacco'} · ${label(battle.attacker)} → ${battle.target?label(battle.target):'Attacco diretto'}`;
}
