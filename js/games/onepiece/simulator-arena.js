import { characterSlots, PHASES } from './simulator-engine.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const logo = 'assets/game-logos/onepiece.webp';
const labels = { setup:'Preparazione',refresh:'Refresh',draw:'Draw',don:'DON!!',main:'Main',end:'End' };
const safeImage = value => {
  try { const url = new URL(value || '', globalThis.location?.href || 'http://localhost'); return ['http:','https:'].includes(url.protocol) && value ? esc(url.href) : ''; } catch { return ''; }
};
const cssUrl = value => { const src = safeImage(value); return src && !/['"()\\\s]/.test(src) ? src : ''; };
const initials = name => esc(String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?');
const button = (type, text, player, disabled = false) => `<button type="button" class="btn secondary" data-op-action="${type}" ${player == null ? '' : `data-player="${player}"`} ${disabled ? 'disabled' : ''}>${text}</button>`;
const command = (name, text) => `<button type="button" class="btn secondary" data-op-command="${name}">${text}</button>`;
const back = (text = '', index = 0) => `<span class="op-battle-card-back" style="--stack-index:${index}" aria-hidden="true"><img src="${logo}" alt="">${text ? `<small>${esc(text)}</small>` : ''}</span>`;

export function battlefieldCard(controller, card, player, { hand = false } = {}) {
  if (!card || card.hidden || hand && !controller.revealHands[player]) return `<span class="op-battle-card op-battle-covered" aria-label="Carta coperta">${back()}</span>`;
  const src = safeImage(card.imageUrl);
  const selected = controller.selected?.player === player && controller.selected.cardId === card.id;
  const numericPower = controller.metadata.get(card.catalogCardId)?.power ?? card.power;
  const power = numericPower == null ? null : Number(numericPower) + Number(card.powerModifier || 0) + (controller.session.activePlayer === player ? Number(card.don || 0) * 1000 : 0);
  return `<button type="button" class="op-battle-card ${card.rested ? 'is-rested' : ''} ${selected ? 'is-selected' : ''}" data-op-card="${esc(card.id)}" data-player="${player}" ${player === controller.viewer && controller.canControl(player) && controller.session.phase !== 'setup' ? 'draggable="true"' : ''} aria-pressed="${selected}" aria-label="${esc(card.cardName)}${card.rested ? ', rested' : ''}">${src ? `<img src="${src}" alt="${esc(card.cardName)}" draggable="false" loading="eager">` : `<span class="op-battle-card-title">${esc(card.cardName)}</span>`}${power != null && !hand ? `<span class="op-battle-power">${power}</span>` : ''}${card.don ? `<span class="op-battle-don-badge">DON!! ×${card.don}</span>` : ''}</button>`;
}

export function canPlace(controller, player, destination) {
  const selected = controller.selectedCard();
  if (!selected || player !== controller.viewer || selected.player !== player || !controller.canControl(player) || controller.session.phase === 'setup' || selected.zone === 'leader') return false;
  const type = String(selected.card.type || '').toLowerCase();
  if (destination === 'characters' && (type.includes('event') || type.includes('stage') || type.includes('leader'))) return false;
  if (destination === 'stage' && (type.includes('character') || type.includes('event') || type.includes('leader'))) return false;
  return true;
}

function characterSlot(controller, player, card, slot) {
  const legal = !card && canPlace(controller, player, 'characters');
  const label = `<small class="op-battle-slot-label">${slot + 1}</small>`;
  if (card) return `<div class="op-battle-slot" data-zone="characters" data-slot="${slot}" data-player="${player}">${label}${battlefieldCard(controller,card,player)}</div>`;
  return `<button type="button" class="op-battle-slot is-empty ${legal ? 'is-legal-target' : ''}" data-zone="characters" data-slot="${slot}" data-op-slot="${slot}" data-player="${player}" ${player !== controller.viewer || !controller.canControl(player) || controller.session.phase === 'setup' ? 'disabled' : ''} aria-label="Posizione Personaggio ${slot + 1}${legal ? ', gioca qui la carta selezionata' : ', vuota'}">${label}<span class="op-battle-slot-name">PERSONAGGIO</span></button>`;
}

function handView(controller, player) {
  const mine = player === controller.viewer, p = controller.session.players[player];
  return `<div class="op-battle-hand" data-player="${player}" aria-label="${mine ? 'La tua mano' : 'Mano avversaria coperta'}"><small class="op-battle-hand-label">${mine ? `LA TUA MANO · ${p.hand.length}` : `MANO · ${p.hand.length}`}</small><div class="op-battle-hand-cards">${p.hand.map(card=>battlefieldCard(controller,card,player,{hand:true})).join('')}</div>${mine ? `<button type="button" class="op-battle-hand-toggle" data-op-hand="${player}" aria-label="${controller.revealHands[player] ? 'Copri la mano' : 'Mostra la tua mano'}">${controller.revealHands[player] ? 'Copri' : 'Mostra'}</button>` : ''}</div>`;
}

function playerBar(controller, player) {
  const p = controller.session.players[player], mine = player === controller.viewer, img = safeImage(p.leader.imageUrl);
  return `<div class="op-battle-player-bar">${img ? `<img class="op-battle-avatar" src="${img}" alt="">` : ''}<div class="op-battle-name"><strong>${esc(p.name)}</strong><small>${mine ? 'TU' : 'AVVERSARIO'}${controller.session.phase === 'setup' ? controller.duel.ready?.[player] ? ' · PRONTO' : ' · PREPARAZIONE' : ''}</small></div><div class="op-battle-resource"><span>LIFE <b>${p.life.length}</b></span><span>DON!! <b>${p.don.active}</b><small> / ${p.don.active + p.don.rested}</small></span></div></div>`;
}

function sideView(controller, player) {
  const p = controller.session.players[player], mine = player === controller.viewer;
  const disabled = controller.pending || !controller.canControl(player) || controller.session.phase === 'setup';
  const slots = characterSlots(p);
  const stage = p.stage[0];
  const legalStage = !stage && canPlace(controller, player, 'stage');
  const lifeCards = mine && controller.privateLife?.version === controller.duel.version ? controller.privateLife.cards : p.life;
  const life = `<button type="button" class="op-battle-pile op-battle-life" data-op-command="battle-life" data-player="${player}" ${controller.pending || controller.session.phase === 'setup' ? 'disabled' : ''} aria-label="Life, ${p.life.length} carte"><small class="op-battle-slot-label">LIFE</small><span class="op-battle-life-stack">${lifeCards.slice(0,4).map((card,i)=>card.hidden ? back('',i) : `<span class="op-battle-card-back is-face-up" style="--stack-index:${i}"><img src="${safeImage(card.imageUrl)}" alt="Life scoperta"></span>`).join('') || '<span class="op-battle-slot-name">LIFE</span>'}</span><b class="op-battle-count">${p.life.length}</b></button>`;
  const deck = `<button type="button" class="op-battle-pile op-battle-deck" data-op-command="battle-deck" data-player="${player}" ${!mine || disabled ? 'disabled' : ''} aria-label="Mazzo, ${p.deck.length} carte"><small class="op-battle-slot-label">MAZZO</small>${back()}<b class="op-battle-count">${p.deck.length}</b></button>`;
  const trash = `<button type="button" class="op-battle-pile op-battle-trash" data-op-command="battle-trash" data-player="${player}" aria-label="Trash, ${p.trash.length} carte"><small class="op-battle-slot-label">TRASH</small>${p.trash.length ? `<img class="op-battle-pile-face" src="${safeImage(p.trash.at(-1).imageUrl)}" alt="${esc(p.trash.at(-1).cardName)}">` : '<span class="op-battle-slot-name">TRASH</span>'}<b class="op-battle-count">${p.trash.length}</b></button>`;
  const donDeck = `<button type="button" class="op-battle-pile op-battle-don-deck" data-op-action="addDon" data-player="${player}" ${disabled || !p.don.deck ? 'disabled' : ''} aria-label="Aggiungi un DON!! dal mazzo, disponibili ${p.don.deck}"><small class="op-battle-slot-label">DON!! DECK</small>${back('DON!!')}<b class="op-battle-count">${p.don.deck}</b></button>`;
  const costCards = [...Array.from({length:p.don.active},()=>false),...Array.from({length:p.don.rested},()=>true)];
  const cost = `<div class="op-battle-cost"><small class="op-battle-cost-label">COST AREA <b>${p.don.active} attivi · ${p.don.rested} rested</b></small><div class="op-battle-cost-cards">${costCards.map(rested=>mine ? `<button type="button" class="op-battle-don-chip ${rested ? 'is-rested' : ''}" data-op-action="${rested ? 'activateDon' : 'restDon'}" data-player="${player}" ${disabled ? 'disabled' : ''} aria-label="${rested ? 'Attiva' : 'Riposa'} un DON!!"><img src="${logo}" alt=""><small>DON!!</small></button>` : `<span class="op-battle-don-chip ${rested ? 'is-rested' : ''}"><img src="${logo}" alt=""><small>DON!!</small></span>`).join('') || '<span class="op-battle-slot-name">DON!!</span>'}</div></div>`;
  const field = `<div class="op-battle-field" aria-label="Campo ${esc(p.name)}">${life}${slots.map((card,slot)=>characterSlot(controller,player,card,slot)).join('')}${deck}${donDeck}<div class="op-battle-leader op-battle-slot" data-zone="leader"><small class="op-battle-slot-label">LEADER</small>${battlefieldCard(controller,p.leader,player)}</div>${cost}${stage ? `<div class="op-battle-stagezone op-battle-slot" data-zone="stage"><small class="op-battle-slot-label">STAGE</small>${battlefieldCard(controller,stage,player)}</div>` : `<button type="button" class="op-battle-stagezone op-battle-slot is-empty ${legalStage ? 'is-legal-target' : ''}" data-op-zone="stage" data-player="${player}" ${disabled || !mine ? 'disabled' : ''}><small class="op-battle-slot-label">STAGE</small><span class="op-battle-slot-name">STAGE</span></button>`}${trash}</div>`;
  const art = cssUrl(p.leader.imageUrl);
  return `<section class="op-battle-side ${mine ? 'is-self' : 'is-opponent'} ${controller.session.activePlayer === player ? 'is-active' : ''}" data-player="${player}" ${art ? `style="--side-art:url('${art}')"` : ''}>${playerBar(controller,player)}${!mine ? handView(controller,player) : ''}${field}${mine ? handView(controller,player) : ''}</section>`;
}

function railProfile(controller, player) {
  const s = controller.session, p = s.players[player], mine = player === controller.viewer, img = safeImage(p.leader.imageUrl);
  const total = Math.max(Number(p.lifeCount) || 0, p.life.length), lost = s.phase === 'setup' ? 0 : Math.max(0, total - p.life.length);
  const state = s.phase === 'setup' ? controller.duel.ready?.[player] ? 'Pronto' : 'Preparazione' : s.activePlayer === player ? 'Di turno' : 'In attesa';
  return `<div class="op-rail-profile ${mine ? 'is-self' : 'is-opponent'} ${s.activePlayer === player && s.phase !== 'setup' ? 'is-active' : ''}"><span class="op-rail-avatar">${img ? `<img src="${img}" alt="">` : initials(p.name)}</span><strong>${esc(p.name)}</strong><small>${mine ? 'Tu' : 'Avversario'} · ${esc(state)}</small><small class="op-rail-deck">${esc(p.deckName)}</small><div class="op-rail-life" aria-label="Life ${p.life.length} su ${total}"><span>${Array.from({length:total},(_,i)=>`<i class="${i >= total - lost ? 'is-lost' : ''}"></i>`).join('')}</span><b>LIFE <em>${s.phase === 'setup' ? total : p.life.length}</em></b></div><dl class="op-rail-stats"><div><dt>DON!!</dt><dd>${p.don.active} / ${p.don.active + p.don.rested}</dd></div><div><dt>Mano</dt><dd>${p.hand.length}</dd></div><div><dt>Mazzo</dt><dd>${p.deck.length}</dd></div><div><dt>Trash</dt><dd>${p.trash.length}</dd></div></dl></div>`;
}

function railPhases(controller) {
  const s = controller.session, current = PHASES.indexOf(s.phase);
  return `<div class="op-rail-turn"><small>One Piece</small><b>${s.phase === 'setup' ? 'Preparazione' : `Turno ${s.turn}`}</b></div><ol class="op-rail-phases" aria-label="Fasi del turno">${PHASES.map((phase,i)=>`<li class="${i === current ? 'is-current' : i < current ? 'is-done' : ''}" ${i === current ? 'aria-current="step"' : ''}>${labels[phase]}</li>`).join('')}</ol>`;
}

function inspectorView(controller) {
  const selected = controller.selectedCard(), visible = selected && !controller.battlePlacing;
  const mine = selected?.player === controller.viewer && controller.canControl(controller.viewer) && controller.session.phase !== 'setup';
  const canPlay = mine && selected.zone !== 'leader' && selected.zone !== 'characters' && !/event|leader/i.test(selected.card.type || '');
  const quick = mine ? `<div class="op-battle-quick-actions">${canPlay ? command('battle-place', /stage/i.test(selected.card.type || '') ? 'Posiziona Stage' : 'Gioca sul campo') : ''}${selected.zone === 'characters' ? command('battle-place','Sposta posizione') : ''}${selected.zone !== 'leader' ? command('battle-to-trash',/event/i.test(selected.card.type || '') ? 'Risolvi evento → Trash' : 'Sposta nel Trash') : ''}</div>` : '';
  const content = selected ? controller.inspectorView() : '<h2>Il campo di battaglia</h2><p>Seleziona una carta per leggerla e scegliere un’azione. Per giocare, scegli la carta e una posizione libera sul tuo campo.</p>';
  return `${visible ? '<button type="button" class="op-sim-inspector-backdrop" data-op-command="deselect" aria-label="Chiudi carta"></button>' : ''}<aside class="op-battle-inspector op-sim-inspector op-sim-panel ${visible ? 'has-selection' : ''}" tabindex="-1" aria-label="Carta e azioni">${visible ? command('deselect','Chiudi carta') : ''}${visible ? quick : ''}${content}</aside>`;
}

function toolsView(controller) {
  if (!controller.battleTools) return '';
  const s = controller.session, player = controller.viewer, p = s.players[player], disabled = controller.pending || !controller.canControl(player) || s.phase === 'setup';
  return `<button type="button" class="op-sim-inspector-backdrop" data-op-command="battle-tools-close" aria-label="Chiudi strumenti"></button><section class="op-battle-tools op-sim-panel" role="dialog" aria-modal="true" aria-label="Strumenti del duello">${command('battle-tools-close','Chiudi strumenti')}<h2>Strumenti del duello</h2><div class="op-sim-actions">${button('refresh','Refresh',player,disabled)}${button('addDon','+1 DON!!',player,disabled || !p.don.deck)}${button('addDon2','+2 DON!!',player,disabled || p.don.deck < 2)}${button('restDon','Riposa DON!!',player,disabled || !p.don.active)}${button('activateDon','Attiva DON!!',player,disabled || !p.don.rested)}${button('returnDon','DON!!− attivo',player,disabled || !p.don.active)}${button('returnRestedDon','DON!!− rested',player,disabled || !p.don.rested)}${button('shuffle','Mescola mazzo',player,disabled)}${button('shuffleLife','Mescola Life',player,disabled)}${command('battle-inspect-deck','Cerca nel mio mazzo')}${command('battle-inspect-life','Guarda le mie Life')}</div><div class="op-sim-actions"><button type="button" class="btn secondary" data-op-tab="rules">Regole e ruling</button><button type="button" class="btn secondary" data-op-tab="history">Test e statistiche</button></div><details><summary>Registro condiviso · ${s.log.length}</summary><ol>${s.log.slice(-50).reverse().map(row=>`<li>T${row.turn} · ${esc(row.text)}</li>`).join('')}</ol></details>${!s.result && s.phase !== 'setup' ? `<details><summary>Concludi il test</summary><form data-op-finish><label>Risultato<select name="winner">${s.players.map((p,i)=>`<option value="${i}" ${controller.finishDraft.winner === String(i) ? 'selected' : ''}>Vince ${esc(p.name)}</option>`).join('')}<option value="draw" ${controller.finishDraft.winner === 'draw' ? 'selected' : ''}>Pareggio</option></select></label><label>Note condivise<textarea name="notes" rows="3" maxlength="2000">${esc(controller.finishDraft.notes)}</textarea></label><button type="submit" class="btn">Concludi test</button></form></details>` : ''}<p>Effetti, costi, attacchi, Counter e Trigger restano manuali.</p></section>`;
}

function pileView(controller) {
  if (!controller.pile) return '';
  const {player,zone,cards} = controller.pile;
  const p = controller.session.players[player];
  const list = zone === 'deck' && !cards ? [] : cards || p[zone] || [];
  const own = player === controller.viewer;
  const disabled = controller.pending || !controller.canControl(player);
  const actions = own && zone === 'deck' ? `${button('draw','Pesca una carta',player,disabled || !p.deck.length)}${command('battle-inspect-deck','Cerca nel mazzo')}${button('shuffle','Mescola',player,disabled)}`
    : own && zone === 'life' ? `${button('takeLife','Life → mano',player,disabled || !p.life.length)}${command('battle-inspect-life','Guarda Life per effetto')}` : '';
  return `<button type="button" class="op-sim-inspector-backdrop" data-op-command="close-pile" aria-label="Chiudi zona"></button><section class="op-battle-tools op-sim-panel" role="dialog" aria-modal="true" aria-label="Carte della zona">${command('close-pile','Chiudi zona')}<h2>${zone === 'deck' ? 'Mazzo' : zone === 'life' ? 'Life' : 'Trash'}</h2><div class="op-sim-actions">${actions}</div><div class="op-battle-pile-cards">${list.map(card=>battlefieldCard(controller,card,player)).join('') || `<p>${zone === 'deck' ? `${p.deck.length} carte coperte` : 'Zona vuota'}</p>`}</div></section>`;
}

export function battlefieldView(controller) {
  const s = controller.session, player = controller.viewer, p = s.players[player], setup = s.phase === 'setup';
  const disabled = controller.pending || !controller.canControl(player);
  const active = s.activePlayer === player;
  const selected = controller.selectedCard();
  const instruction = controller.error || (controller.battlePlacing && selected ? `Scegli una posizione libera per ${selected.card.cardName}` : setup ? 'Scegli se fare mulligan. La partita inizia quando entrambi siete pronti.' : selected ? selected.card.cardName : 'Tocca una carta per leggerla o giocarla.');
  return `<section class="op-battlefield" aria-label="Campo di battaglia One Piece"><header class="op-battle-header">${command('lobby','Team')}<div class="op-battle-turn"><small>ONE PIECE · TURNO ${s.turn}</small><strong>${setup ? 'PREPARAZIONE' : s.result ? 'TEST CONCLUSO' : active ? 'IL TUO TURNO' : esc(s.players[s.activePlayer].name)}</strong></div><span class="op-battle-connection ${controller.connected ? 'is-connected' : 'is-offline'}">${controller.pending ? 'Sync…' : controller.connected ? 'Online' : 'Riconnessione'}</span>${command('battle-tools','Strumenti')}</header><aside class="op-battle-rail is-left" aria-label="Il tuo profilo e le fasi">${railProfile(controller,player)}${railPhases(controller)}</aside><aside class="op-battle-rail is-right" aria-label="Avversario">${railProfile(controller,1-player)}</aside><div class="op-battle-layout"><div class="op-battle-stage"><div class="op-battle-mat">${sideView(controller,1-player)}<div class="op-battle-midline"><span>${setup ? 'PREPARAZIONE' : labels[s.phase]}</span></div>${sideView(controller,player)}</div><p class="op-battle-status" role="status">${esc(instruction)}</p></div>${inspectorView(controller)}</div><footer class="op-battle-controls">${setup ? `${button('mulligan',p.mulliganUsed ? 'Mulligan usato' : 'Mulligan',player,disabled || p.mulliganUsed || controller.duel.ready?.[player])}${button('ready',controller.duel.ready?.[player] ? 'Attesa compagno…' : 'Sono pronto',player,disabled || controller.duel.ready?.[player])}` : `${button('draw','Pesca',player,disabled || !p.deck.length)}${button('addDon2','+2 DON!!',player,disabled || p.don.deck < 2)}${button('nextPhase','Fase',null,disabled || !active)}${button('nextTurn','Fine turno',null,disabled || !active)}`}</footer>${s.result ? `<div class="op-battle-result">${s.result.winner === 'draw' ? 'Pareggio' : `Vince ${esc(s.players[s.result.winner].name)}`}</div>` : ''}${toolsView(controller)}${pileView(controller)}</section>`;
}
