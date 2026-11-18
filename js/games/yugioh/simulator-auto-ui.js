// SPDX-License-Identifier: AGPL-3.0-or-later
// This module renders choices; all legality and effects remain on the server.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const multiKinds = new Set(['select', 'tribute', 'sum', 'sort', 'race', 'attribute', 'place']);
export const autoIsMulti = prompt => multiKinds.has(prompt?.kind);
export function autoOptionsForCard(prompt, card) {
  if (!prompt || !card || card.hidden) return [];
  return (prompt.options || []).filter(option => {
    const source = option.card;
    return source && source.controller === card.controller && source.location === card.location && source.sequence === card.sequence
      && Object.hasOwn(source, 'overlay_sequence') === Object.hasOwn(card, 'overlay_sequence')
      && (!Object.hasOwn(source, 'overlay_sequence') || source.overlay_sequence === card.overlay_sequence);
  });
}
export function autoPromptAttributes(controller) {
  const prompt = controller.autoPrompt?.() || controller.session?.auto?.prompt;
  return `data-ygo-auto-prompt="${esc(prompt?.id || '')}" data-ygo-auto-version="${esc(controller.duel?.version ?? '')}" data-ygo-auto-duel="${esc(controller.duel?.id || '')}"`;
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
function optionOrigin(option,viewer){
  const card=option.card;if(!card)return '';
  const zone=Number.isInteger(card.overlay_sequence)?`Materiale Xyz ${card.overlay_sequence+1}`:({1:'Mazzo',2:'Mano',4:'Mostri',8:'Magie/Trappole',16:'Cimitero',32:'Bandite',64:'Extra Deck'})[card.location];
  return zone?`${card.controller!==undefined&&card.controller!==viewer?'Avversario · ':''}${zone}`:'';
}
function optionView(controller, option, prompt, index) {
  const selected = controller.autoSelected?.includes(option.id), src = art(option.card?.code),origin=optionOrigin(option,controller.viewer);
  if(prompt.kind==='counter')return `<label class="ygo-auto-counter">${src?`<img src="${src}" alt="">`:''}<span>${esc(option.label)}${origin?`<small>${esc(origin)}</small>`:''}<small>Disponibili: ${Number(option.available)}</small></span><input type="number" data-ygo-auto-counter="${esc(option.id)}" min="0" max="${Number(option.available)}" value="${controller.autoCounts?.[option.id]||0}" inputmode="numeric" aria-label="Segnalini da rimuovere da ${esc(option.label)}"></label>`;
  return `<button type="button" data-ygo-auto-option="${esc(option.id)}" class="ygo-auto-option ${selected || option.selected ? 'is-selected' : ''}" aria-pressed="${Boolean(selected || option.selected)}" ${controller.pending ? 'disabled' : ''}>${src ? `<img src="${src}" alt="" draggable="false">` : ''}<span>${esc(option.label)}${origin?`<small>${esc(origin)}</small>`:''}${option.effect ? `<small>${esc(option.effect)}</small>` : ''}${prompt.kind === 'sort' && selected ? `<b>${controller.autoSelected.indexOf(option.id) + 1}</b>` : ''}${option.contribution > 1 ? `<small>Vale ${option.contribution} tributi</small>` : ''}${option.contributions ? `<small>Livello ${option.contributions.join(' / ')}</small>` : ''}</span>${prompt.kind === 'counter' ? `<input type="number" data-ygo-auto-counter="${esc(option.id)}" min="0" max="${Number(option.available)}" value="${controller.autoCounts?.[option.id] || 0}" inputmode="numeric" aria-label="Segnalini da rimuovere da ${esc(option.label)}">` : ''}</button>`;
}
// Scelta di carte per effetto (2026-11-18): pannello orizzontale in basso.
// Si scorre col dito; un tocco evidenzia la carta e mostra «Scegli», un doppio
// tocco la sceglie subito. Con una sola carta richiesta la mossa parte lì.
const pickKinds = new Set(['select', 'tribute']);
export const autoIsPick = prompt => pickKinds.has(prompt?.kind) && prompt.options?.length > 0 && prompt.options.every(option => option.card);
export const autoIsSinglePick = prompt => autoIsPick(prompt) && prompt.min === 1 && prompt.max === 1;
function pickCardView(controller, option) {
  const selected = controller.autoSelected?.includes(option.id), src = art(option.card?.code), origin = optionOrigin(option, controller.viewer);
  return `<div class="ygo-pick-card ${selected ? 'is-selected' : ''}" data-pick-id="${esc(option.id)}"><button type="button" class="ygo-pick-face" data-ygo-pick="${esc(option.id)}" aria-pressed="${Boolean(selected)}" aria-label="${esc(option.label)}${origin ? `, ${esc(origin)}` : ''}" ${controller.pending ? 'disabled' : ''}>${src ? `<img src="${src}" alt="" draggable="false" loading="lazy" decoding="async">` : '<span class="ygo-pick-back" aria-hidden="true"></span>'}<i class="ygo-pick-check" aria-hidden="true">✓</i></button><span class="ygo-pick-name">${esc(option.label)}</span>${origin ? `<small>${esc(origin)}</small>` : ''}${option.contribution > 1 ? `<small>Vale ${option.contribution} tributi</small>` : ''}<button type="button" class="ygo-pick-choose" data-ygo-pick-choose="${esc(option.id)}" ${controller.pending ? 'disabled' : ''}>${selected ? 'Togli' : 'Scegli'}</button></div>`;
}
function pickSheetView(controller, prompt) {
  const selected = controller.autoSelected || [], single = autoIsSinglePick(prompt);
  const need = prompt.min === prompt.max ? `${prompt.min}` : `${prompt.min}–${prompt.max}`;
  return `<section ${autoPromptAttributes(controller)} class="ygo-auto-prompt ygo-pick-sheet" role="region" aria-label="${esc(prompt.title)}" aria-live="polite"><header><div><small>EFFETTO · ${prompt.options.length} ${prompt.options.length === 1 ? 'CARTA' : 'CARTE'}</small><strong>${esc(prompt.title)}</strong></div><small class="ygo-pick-hint">Scorri ← → · doppio tocco per scegliere</small></header><div class="ygo-pick-strip" role="listbox" aria-multiselectable="${!single}">${prompt.options.map(option => pickCardView(controller, option)).join('')}</div><footer class="ygo-auto-controls"><span class="ygo-pick-count" data-ygo-pick-count>${single ? 'Scegli 1 carta' : `${selected.length} di ${need} scelte`}</span>${single ? '' : `<button type="button" class="ygo-primary" data-ygo-command="auto-confirm" ${controller.pending || selected.length < prompt.min || selected.length > prompt.max ? 'disabled' : ''}>Conferma</button>`}${prompt.cancelable ? `<button type="button" data-ygo-command="auto-cancel" ${controller.pending ? 'disabled' : ''}>Annulla</button>` : ''}</footer></section>`;
}
export function autoPromptView(controller) {
  const session = controller.session, prompt = session.auto?.prompt;
  if (controller.duel.status === 'setup' || session.result) return '';
  if (!prompt) return `<section ${autoPromptAttributes(controller)} class="ygo-auto-prompt is-waiting" role="status"><strong>Attesa avversario</strong><small>${esc(session.players[session.auto?.waitingPlayer ?? 1 - controller.viewer]?.name || 'Il compagno')} sta scegliendo.</small></section>`;
  const compact = ['idle', 'battle'].includes(prompt.kind), selected = controller.autoSelected || [];
  const cardOptions = prompt.options.filter(option => option.card), otherOptions = prompt.options.filter(option => !option.card);
  if (compact && !controller.autoExpanded) return `<section ${autoPromptAttributes(controller)} class="ygo-auto-prompt is-compact" aria-label="Comandi automatici"><strong>${esc(prompt.title)}</strong><small>Tocca una carta per le azioni consentite.</small><div class="ygo-auto-controls"><button type="button" data-ygo-command="auto-expand" ${controller.pending ? 'disabled' : ''} aria-label="Mostra tutte le mosse consentite">Azioni - ${prompt.options.length}</button></div></section>`;
  if (autoIsPick(prompt)) return pickSheetView(controller, prompt);
  const multi = autoIsMulti(prompt), options = prompt.kind === 'announce-card' ? (controller.autoSearchResults || []).map(row => ({id: `announce-${row.code}`, label: row.name, card: {code: row.code}})) : prompt.options;
  return `<section ${autoPromptAttributes(controller)} class="ygo-auto-prompt ${compact ? 'is-expanded' : ''}" role="region" aria-label="${esc(prompt.title)}" aria-live="polite"><header><div><small>TCG · AUTOMATICO</small><strong>${esc(prompt.title)}</strong></div>${compact ? '<button type="button" data-ygo-command="auto-collapse">Riduci</button>' : ''}</header>${prompt.kind === 'sort' ? '<small>Tocca le carte nell’ordine desiderato. Ritocca per rimuovere una scelta.</small>' : multi ? `<small>${selected.length} selezionate · ${prompt.min === prompt.max ? prompt.min : `${prompt.min}–${prompt.max}`} richieste</small>` : ''}${prompt.mandatory?.length ? `<small>Materiali obbligatori: ${prompt.mandatory.map(row => esc(row.label)).join(', ')}</small>` : ''}${prompt.kind === 'announce-card' ? '<form data-ygo-auto-search class="ygo-auto-search"><input name="query" type="search" placeholder="Nome o passcode" minlength="2" maxlength="100" required aria-label="Cerca la carta da dichiarare"><button type="submit">Cerca</button></form>' : ''}<div class="ygo-auto-options">${options.map((option, index) => optionView(controller, option, prompt, index)).join('')}${prompt.kind === 'announce-card' && !options.length ? '<small>Cerca una carta consentita dall’effetto.</small>' : ''}</div><div class="ygo-auto-controls">${multi ? `<button type="button" class="ygo-primary" data-ygo-command="auto-confirm" ${controller.pending || selected.length < prompt.min || selected.length > prompt.max ? 'disabled' : ''}>Conferma${prompt.kind === 'sort' ? ' ordine' : ''}</button>` : ''}${prompt.kind === 'counter' ? `<button type="button" class="ygo-primary" data-ygo-command="auto-counters" ${controller.pending ? 'disabled' : ''}>Conferma segnalini</button>` : ''}${prompt.canFinish ? `<button type="button" data-ygo-command="auto-finish" ${controller.pending ? 'disabled' : ''}>Fine selezione</button>` : ''}${prompt.cancelable && !prompt.options.some(option => option.id === 'pass') ? `<button type="button" data-ygo-command="auto-cancel" ${controller.pending ? 'disabled' : ''}>Annulla</button>` : ''}</div></section>`;
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

export function autoCardContextView(session,card){
  const labels=[],zones=['hand','monsters','spells','field','extraMonsters','graveyard','banished','extra','deck'];
  const describe=pointer=>{
    const player=session.players[pointer?.controller];
    if(!player)return '';
    const found=zones.flatMap(zone=>player[zone]||[]).find(target=>!target.hidden&&target.controller===pointer.controller&&target.location===pointer.location&&target.sequence===pointer.sequence);
    return found?`${player.name}: ${found.cardName}`:'';
  };
  if([0,1].includes(card.owner)&&[0,1].includes(card.controller)&&card.owner!==card.controller)labels.push(`Proprietario: ${session.players[card.owner].name}`);
  const equipped=describe(card.equippedTo);if(equipped)labels.push(`Equipaggiata a ${equipped}`);
  const targets=(card.targets||[]).map(describe).filter(Boolean);if(targets.length)labels.push(`Bersagli: ${targets.join(' · ')}`);
  if(card.materials?.length)labels.push(`Materiali Xyz: ${card.materials.map(material=>material.cardName).join(' · ')}`);
  return labels.length?`<p class="ygo-public-card-context">${labels.map(esc).join('<br>')}</p>`:'';
}
