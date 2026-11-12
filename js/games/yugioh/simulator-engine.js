import { validateYugiohDeck } from './rules.js';
import {deriveChainState,appendChain,passChain,resolveChain} from './simulator-chain.js';
import {getSummonKind,summonPlan} from './simulator-summoning.js';

// A manual table: effects, costs, summoning conditions and attack resolution
// belong to the players. This engine preserves cards, zones and public state.
export const PHASES = Object.freeze(['draw', 'standby', 'main1', 'battle', 'main2', 'end']);
export const ZONES = Object.freeze(['deck', 'hand', 'monsters', 'spells', 'field', 'extra', 'graveyard', 'banished', 'extraMonsters']);
const BOARD = ['monsters', 'spells', 'field', 'extraMonsters'];
const MONSTERS = ['monsters', 'extraMonsters'];
const SECTIONS = ['main', 'extra', 'side'];
const clone = value => JSON.parse(JSON.stringify(value));
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max) => typeof value === 'string' && value.length <= max;
const fail = message => { throw new Error(message); };
const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const typeOf = card => String(card?.type || card?.cardType || '').toLowerCase();
export const isMonster = card => /monster|mostro|token/.test(typeOf(card));
export const isExtraDeckMonster = card => /fusion|synchro|xyz|link/.test(typeOf(card));
const isPendulum = card => /pendulum|pendolo/.test(typeOf(card));
const isLink = card => /link/.test(typeOf(card));
const knownType = card => /monster|mostro|token|spell|magia|trap|trappola/.test(typeOf(card));

export function validateSimulatorDeck(deck) {
  if (!deck || deck.game !== 'yugioh' || !Array.isArray(deck.cards)) return { valid:false, errors:['Scegli un mazzo Yu-Gi-Oh! salvato.'] };
  const errors = [];
  if (deck.cards.length > 90) errors.push('Il mazzo contiene troppe righe.');
  for (const card of deck.cards) {
    if (!card || !SECTIONS.includes(card.section) || !integer(card.quantity, 1, 3)) { errors.push('Sezione o quantità di una carta non valida.'); continue; }
    if (!text(card.catalogCardId, 100) || !card.catalogCardId.trim() || !text(card.cardName, 300) || !card.cardName.trim()) errors.push('Una carta non ha nome o codice catalogo.');
    if (card.section === 'main' && isExtraDeckMonster(card)) errors.push(`${card.cardName}: questa carta appartiene all’Extra Deck.`);
    if (card.section === 'extra' && knownType(card) && !isExtraDeckMonster(card)) errors.push(`${card.cardName}: l’Extra Deck contiene Fusion, Synchro, Xyz e Link.`);
    if (/token/.test(typeOf(card))) errors.push('I Segna-Mostro si creano al tavolo e non fanno parte del mazzo.');
  }
  if (!errors.length) errors.push(...validateYugiohDeck(deck).errors);
  return { valid:errors.length === 0, errors:[...new Set(errors)] };
}

function snapshotCard(card, id, originSection) {
  return {
    id, catalogCardId:String(card.catalogCardId || '').trim(), cardName:String(card.cardName || '').trim(),
    imageUrl:String(card.imageUrl || '').slice(0, 2000), type:String(card.type || card.cardType || '').slice(0, 100),
    race:String(card.race || '').slice(0, 100), text:String(card.text || card.desc || card.effect || '').slice(0, 10000),
    atk:numeric(card.atk ?? card.attack), def:numeric(card.def ?? card.defense),
    level:/xyz|link/i.test(card.type||card.cardType||'')?null:numeric(card.level),rank:/xyz/i.test(card.type||card.cardType||'')?numeric(card.rank??card.level):null,
    isTuner:card.isTuner===true||card.tuner===true||/\btuner\b/i.test(card.type||card.cardType||'')&&!/non[- ]tuner/i.test(card.type||card.cardType||''),originSection,
    faceUp:false, position:'attack', slot:null, atkModifier:0, defModifier:0, counters:0, materials:[], token:false
  };
}
function shuffled(cards) {
  const result = [...cards], bytes = new Uint32Array(1);
  for (let i = result.length - 1; i > 0; i--) {
    const range = i + 1, limit = 0x100000000 - 0x100000000 % range;
    do { globalThis.crypto.getRandomValues(bytes); } while (bytes[0] >= limit);
    const j = bytes[0] % range; [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export function createSession({ decks, firstPlayer = 0, names = [], lp = [8000, 8000] } = {}) {
  if (!Array.isArray(decks) || decks.length !== 2) fail('Scegli un mazzo per entrambi i giocatori.');
  if (!integer(firstPlayer, 0, 1)) fail('Giocatore iniziale non valido.');
  if (!Array.isArray(lp) || lp.length !== 2 || lp.some(value => !integer(value, 1, 1000000))) fail('Life Points iniziali non validi.');
  for (const deck of decks) { const checked = validateSimulatorDeck(deck); if (!checked.valid) fail(checked.errors.join(' ')); }
  const at = new Date().toISOString();
  const session = {
    version:1, id:globalThis.crypto.randomUUID(), createdAt:at, updatedAt:at, firstPlayer, activePlayer:firstPlayer, turn:1, phase:'setup',
    players:decks.map((deck, player) => {
      const piles = Object.fromEntries(SECTIONS.map(section => {
        let index = 0;
        return [section, deck.cards.filter(card => card.section === section).flatMap(card => Array.from({ length:card.quantity }, () => snapshotCard(card, `p${player}-${section}-${index++}`, section)))];
      }));
      const main = shuffled(piles.main), hand = main.splice(0, 5);
      return {
        name:String(names[player] || `Giocatore ${player + 1}`).trim().slice(0, 80), deckId:String(deck.id || '').slice(0, 100), deckName:String(deck.name || 'Mazzo Yu-Gi-Oh!').slice(0, 200), lp:lp[player],
        initialCounts:{ main:main.length + hand.length, extra:piles.extra.length, side:piles.side.length },
        deck:main, hand, extra:piles.extra, side:piles.side, monsters:[], spells:[], field:[], graveyard:[], banished:[], extraMonsters:[]
      };
    }), chain:[], chainState:null, log:[{ at, turn:1, type:'create', player:null, text:'Tavolo preparato: cinque carte iniziali ciascuno. Confermate quando siete pronti.' }], result:null
  };
  assertSession(session); return session;
}
export function zoneSlots(player, zone) {
  const size = zone === 'field' ? 1 : zone === 'extraMonsters' ? 2 : 5;
  const slots = Array(size).fill(null);
  for (const card of player?.[zone] || []) if (integer(card.slot, 0, size - 1)) slots[card.slot] = card;
  return slots;
}
export function canMoveCardToZone(card, destination) {
  if (!card || !ZONES.includes(destination)) return false;
  if (destination === 'extraMonsters') return !knownType(card) || isExtraDeckMonster(card) || isPendulum(card);
  if (destination === 'monsters') return !knownType(card) || isMonster(card);
  if (destination === 'field') return !knownType(card) || /field|terreno/i.test(`${card.race || ''} ${typeOf(card)}`);
  if (destination === 'extra') return !knownType(card) || isExtraDeckMonster(card) || isPendulum(card) || card.originSection === 'extra';
  return true; // Monster cards may become equip cards in the Spell/Trap area.
}
function findCard(player, id, boardOnly = false) {
  for (const zone of boardOnly ? BOARD : ZONES) {
    const index = player[zone].findIndex(card => card.id === id);
    if (index !== -1) return { card:player[zone][index], zone, index };
  }
  fail('Carta non presente nella zona richiesta.');
}
function allCards(player) {
  return [...ZONES, 'side'].flatMap(zone => player[zone].flatMap(card => [card, ...card.materials]));
}
export function validateSession(session) {
  const errors = [];
  try {
    if (!session || session.version !== 1 || !text(session.id, 100) || !session.id || !Number.isFinite(Date.parse(session.createdAt)) || !Number.isFinite(Date.parse(session.updatedAt))) errors.push('Formato del tavolo non valido.');
    if (!integer(session.turn, 1, 100000) || !integer(session.firstPlayer, 0, 1) || !integer(session.activePlayer, 0, 1) || !['setup', ...PHASES].includes(session.phase)) errors.push('Turno o fase non validi.');
    if (!Array.isArray(session.players) || session.players.length !== 2) return { valid:false, errors:[...errors, 'Servono due giocatori.'] };
    const seen = new Set(), emz = new Set();
    for (const [index, player] of session.players.entries()) {
      if (!player || !text(player.name, 80) || !text(player.deckId, 100) || !text(player.deckName, 200) || !integer(player.lp, 0, 1000000)) { errors.push('Dati del giocatore non validi.'); continue; }
      if ([...ZONES, 'side'].some(zone => !Array.isArray(player[zone]) || player[zone].length > 100)) { errors.push('Zone non valide.'); continue; }
      if (!player.initialCounts || !integer(player.initialCounts.main, 40, 60) || !integer(player.initialCounts.extra, 0, 15) || !integer(player.initialCounts.side, 0, 15)) { errors.push('Conteggio iniziale non valido.'); continue; }
      for (const zone of BOARD) {
        const slots = new Set(), size = zone === 'field' ? 1 : zone === 'extraMonsters' ? 2 : 5;
        if (player[zone].length > size) errors.push('Limite delle zone superato.');
        for (const card of player[zone]) {
          if (!integer(card.slot, 0, size - 1) || slots.has(card.slot)) errors.push('Posizione di una carta non valida.');
          slots.add(card.slot);
          if (zone === 'extraMonsters') { if (emz.has(card.slot)) errors.push('Extra Monster Zone già occupata.'); emz.add(card.slot); }
        }
      }
      const counts = { main:0, extra:0, side:0 };
      for (const card of allCards(player)) {
        if (!card || !text(card.id, 100) || seen.has(card.id) || !text(card.cardName, 300) || !card.cardName || !text(card.catalogCardId, 100)) { errors.push('Identità di una carta non valida.'); continue; }
        seen.add(card.id);
        const identity = card.id.match(new RegExp(`^p${index}-(main|extra|side)-(\\d+)$`));
        if (card.token) {
          if (!card.id.startsWith(`p${index}-token-`) || !player.monsters.includes(card) && !player.extraMonsters.includes(card)) errors.push('Segna-Mostro fuori dal campo.');
          if (!card.faceUp || card.materials.length) errors.push('Segna-Mostro non valido.');
        } else if (!identity || card.originSection !== identity[1] || !integer(Number(identity[2]), 0, player.initialCounts[identity[1]] - 1)) errors.push('Una carta appartiene a un altro mazzo.');
        else counts[identity[1]]++;
        if (!text(card.type, 100) || !text(card.race, 100) || !text(card.text, 10000) || !text(card.imageUrl, 2000)) errors.push('Metadati non validi.');
        if (typeof card.token !== 'boolean' || typeof card.faceUp !== 'boolean' || !['attack', 'defense'].includes(card.position) || !integer(card.atkModifier, -1000000, 1000000) || !integer(card.defModifier, -1000000, 1000000) || !integer(card.counters, 0, 999)) errors.push('Stato della carta non valido.');
        if (['atk', 'def'].some(stat => card[stat] !== null && (!Number.isFinite(card[stat]) || Math.abs(card[stat]) > 1000000))) errors.push('Statistiche della carta non valide.');
        if (['level','rank'].some(stat=>card[stat]!=null&&!integer(card[stat],1,1000000))||card.isTuner!==undefined&&typeof card.isTuner!=='boolean') errors.push('Livello, Rango o Tuner non validi.');
        if (!Array.isArray(card.materials) || card.materials.length > 90 || card.materials.some(material => material.materials?.length || material.token)) errors.push('Materiali Xyz non validi.');
        if (card.materials.length && !player.monsters.includes(card) && !player.extraMonsters.includes(card)) errors.push('Materiali assegnati fuori dalla zona Mostri.');
        if (isLink(card) && card.position !== 'attack') errors.push('Un Mostro Link non può andare in Difesa.');
        if (!BOARD.some(zone => player[zone].includes(card)) && card.slot !== null) errors.push('Posizione assegnata fuori dal campo.');
      }
      if (SECTIONS.some(section => counts[section] !== player.initialCounts[section])) errors.push('Il tavolo ha perso o duplicato carte.');
    }
    if (!Array.isArray(session.chain) || session.chain.length > 50 || session.chain.some(link => !link || !integer(link.player, 0, 1) || !text(link.cardId, 100) || !text(link.cardName, 300))) errors.push('Catena non valida.');
    if(Array.isArray(session.chain)){try{deriveChainState(session);}catch{errors.push('Stato della catena non valido.');}}
    if (!Array.isArray(session.log) || session.log.length > 200 || session.log.some(row => !row || !text(row.text, 1200) || !text(row.type, 40) || !Number.isFinite(Date.parse(row.at)) || !integer(row.turn, 1, 100000) || row.player !== null && !integer(row.player, 0, 1))) errors.push('Registro non valido.');
    if (session.result !== null && (!session.result || ![0, 1, 'draw'].includes(session.result.winner) || !text(session.result.notes, 4000) || !Number.isFinite(Date.parse(session.result.at)))) errors.push('Risultato non valido.');
  } catch { errors.push('Tavolo incompleto o danneggiato.'); }
  return { valid:errors.length === 0, errors:[...new Set(errors)] };
}
function assertSession(session) { const checked = validateSession(session); if (!checked.valid) fail(checked.errors.join(' ')); }
function clearBoardState(card) { card.slot = null; card.counters = 0; card.atkModifier = 0; card.defModifier = 0; card.position = 'attack'; }
function releaseMaterials(player, card) {
  for (const material of card.materials) { clearBoardState(material); material.faceUp = true; player.graveyard.push(material); }
  card.materials = [];
}
function destinationFor(card, from, requested) {
  if (isExtraDeckMonster(card) && ['deck', 'hand'].includes(requested)) return 'extra';
  if (BOARD.includes(from) && requested === 'graveyard' && isPendulum(card)) return 'extra';
  return requested;
}
function moveCard(session, playerIndex, action, {summoning=false}={}) {
  const player = session.players[playerIndex], found = findCard(player, action.cardId), card = found.card;
  if (!ZONES.includes(action.to)) fail('Zona di destinazione non valida.');
  const destination = destinationFor(card, found.zone, action.to);
  if(!summoning&&found.zone==='extra'&&MONSTERS.includes(destination)&&getSummonKind(card))fail('Usa la procedura Synchro/Xyz e scegli i materiali sul terreno.');
  if (!canMoveCardToZone(card, destination)) fail('Questa carta non può occupare la zona scelta.');
  const enteringBoard = BOARD.includes(destination), leavingBoard = BOARD.includes(found.zone);
  let slot = null;
  if (enteringBoard) {
    const size = destination === 'field' ? 1 : destination === 'extraMonsters' ? 2 : 5;
    const occupied = player[destination].filter(other => other.id !== card.id).map(other => other.slot);
    if (destination === 'extraMonsters') occupied.push(...session.players[1 - playerIndex].extraMonsters.map(other => other.slot));
    slot = action.slot ?? (found.zone === destination ? card.slot : Array.from({ length:size }, (_, i) => i).find(i => !occupied.includes(i)));
    if (!integer(slot, 0, size - 1) || occupied.includes(slot)) fail('La posizione scelta è già occupata o non disponibile.');
  } else if (action.slot !== undefined) fail('Questa zona non usa posizioni del campo.');
  const position = action.position ?? (MONSTERS.includes(destination) ? found.zone === destination ? card.position : 'attack' : 'attack');
  if (!['attack', 'defense'].includes(position) || isLink(card) && position !== 'attack') fail('Posizione della carta non valida.');
  let faceUp = action.faceUp ?? (destination === 'graveyard' || destination === 'banished' || enteringBoard);
  if (typeof faceUp !== 'boolean') fail('Orientamento della carta non valido.');
  if (destination === 'extra') faceUp = BOARD.includes(found.zone) && action.to === 'graveyard' && isPendulum(card) || action.faceUp === true && isPendulum(card);
  if (['deck', 'hand'].includes(destination)) faceUp = false;
  if (destination === 'graveyard') faceUp = true;
  if (card.token && !enteringBoard) {
    player[found.zone].splice(found.index, 1); return { name:'un Segna-Mostro', destination:'rimosso', faceUp:true };
  }
  if (card.token && !faceUp || isLink(card) && !faceUp && MONSTERS.includes(destination)) fail('Questa carta deve restare scoperta.');
  if (MONSTERS.includes(destination) && !faceUp && position !== 'defense') fail('Un Mostro coperto va in Posizione di Difesa.');
  const publiclyKnown = found.zone === 'graveyard' || found.zone === 'banished' && card.faceUp || leavingBoard && card.faceUp || found.zone === 'extra' && card.faceUp;
  player[found.zone].splice(found.index, 1);
  if (!MONSTERS.includes(destination)) releaseMaterials(player, card);
  if (!enteringBoard) clearBoardState(card);
  card.slot = slot; card.faceUp = faceUp; card.position = position;
  if (action.placement !== undefined && !['top', 'bottom'].includes(action.placement)) fail('Posizione nel mazzo non valida.');
  if (destination === 'deck' && action.placement !== 'bottom') player.deck.unshift(card); else player[destination].push(card);
  return { name:faceUp || publiclyKnown ? card.cardName : 'una carta coperta', destination, faceUp };
}
export function applyAction(session, action) {
  assertSession(session);
  if (!action || typeof action !== 'object' || Array.isArray(action) || !text(action.type, 40)) fail('Azione non valida.');
  if (session.result) fail('Il test è già concluso.');
  const next = clone(session), at = new Date().toISOString(), playerIndex = action.player ?? next.activePlayer;
  if (!integer(playerIndex, 0, 1)) fail('Giocatore non valido.');
  const player = next.players[playerIndex]; let message = '';
  if (action.type === 'start') {
    if (next.phase !== 'setup') fail('La partita è già iniziata.');
    next.phase = 'draw'; message = 'Duello iniziato. Il primo giocatore salta la prima pescata; azioni e risoluzioni restano manuali.';
  } else {
    if (next.phase === 'setup') fail('Attendi che entrambi i giocatori siano pronti.');
    switch (action.type) {
      case 'draw': {
        const count = action.count ?? 1; if (!integer(count, 1, 60) || player.deck.length < count) fail('Non ci sono abbastanza carte nel mazzo.');
        player.hand.push(...player.deck.splice(0, count)); message = `${player.name} pesca ${count} ${count === 1 ? 'carta' : 'carte'}.`; break;
      }
      case 'summon': {
        const plan=summonPlan(next,{...action,player:playerIndex});
        const materialNames=plan.materials.map(found=>found.card.cardName.slice(0,100));
        if(plan.kind==='xyz'){
          for(const item of plan.materials){const found=findCard(player,item.card.id,true);player[found.zone].splice(found.index,1);releaseMaterials(player,found.card);clearBoardState(found.card);found.card.faceUp=true;plan.card.materials.push(found.card);}
        }else{
          for(const item of plan.materials)moveCard(next,playerIndex,{cardId:item.card.id,to:'graveyard',faceUp:true});
        }
        moveCard(next,playerIndex,{cardId:plan.card.id,to:plan.to,slot:plan.slot,position:plan.position,faceUp:true},{summoning:true});
        message=`${player.name} evoca ${plan.kind==='xyz'?'Xyz':'Synchro'} ${plan.card.cardName} con ${materialNames.join(', ')}.`;break;
      }
      case 'move': {
        if(action.intent!==undefined&&!['normal','special','set','activate'].includes(action.intent))fail('Tipo di giocata non valido.');
        if(action.intent==='normal'){
          const found=findCard(player,action.cardId);
          if(found.zone!=='hand'||action.to!=='monsters'||isExtraDeckMonster(found.card)||/ritual/.test(typeOf(found.card))||action.faceUp===false||action.position==='defense')fail('L’evocazione normale richiede un Mostro dalla mano in Attacco, diverso da un Mostro Rituale o dell’Extra Deck.');
        }
        const moved = moveCard(next, playerIndex, action);
        const verb={normal:'evoca normalmente',special:'evoca specialmente',set:'posiziona coperta',activate:'gioca'}[action.intent]||'sposta';
        message = `${player.name} ${verb} ${moved.name} → ${moved.destination}.`; break;
      }
      case 'setPosition': case 'flip': {
        const { card, zone } = findCard(player, action.cardId, true);
        const position = action.type === 'flip' ? card.position : action.position;
        const faceUp = action.type === 'flip' ? !card.faceUp : action.faceUp ?? card.faceUp;
        if (!['attack', 'defense'].includes(position) || typeof faceUp !== 'boolean' || isLink(card) && (position !== 'attack' || !faceUp) || card.token && !faceUp || MONSTERS.includes(zone) && !faceUp && position !== 'defense') fail('Orientamento della carta non valido.');
        card.position = position; card.faceUp = faceUp;
        message = `${player.name} cambia posizione a ${faceUp ? card.cardName : 'una carta coperta'}.`; break;
      }
      case 'lp': {
        if (!integer(action.delta, -1000000, 1000000) || !integer(player.lp + action.delta, 0, 1000000)) fail('Variazione dei Life Points non valida.');
        player.lp += action.delta; message = `${player.name}: ${action.delta >= 0 ? '+' : ''}${action.delta} LP → ${player.lp}.`; break;
      }
      case 'stats': {
        const { card, zone } = findCard(player, action.cardId, true);
        if (!MONSTERS.includes(zone) || !['atk', 'def'].includes(action.stat) || !integer(action.delta, -1000000, 1000000)) fail('Modifica ATK/DEF non valida.');
        const key = `${action.stat}Modifier`; if (!integer(card[key] + action.delta, -1000000, 1000000)) fail('Modificatore troppo grande.');
        card[key] += action.delta; message = `${player.name} modifica ${action.stat.toUpperCase()} di ${card.faceUp ? card.cardName : 'un Mostro coperto'}.`; break;
      }
      case 'counter': {
        const { card } = findCard(player, action.cardId, true);
        if (!integer(action.delta, -999, 999) || !integer(card.counters + action.delta, 0, 999)) fail('Numero di segnalini non valido.');
        card.counters += action.delta; message = `${player.name} aggiorna i segnalini di ${card.faceUp ? card.cardName : 'una carta coperta'}.`; break;
      }
      case 'activate': {
        let {card,zone}=findCard(player,action.cardId);
        if(zone==='deck')fail('Attivazione non disponibile.');
        if(action.playTo!==undefined){
          if(!['spells','field'].includes(action.playTo))fail('Zona di attivazione non valida.');
          moveCard(next,playerIndex,{cardId:card.id,to:action.playTo,slot:action.slot,position:'attack',faceUp:true});zone=action.playTo;
        }
        if(MONSTERS.includes(zone)&&!card.faceUp)fail('Scopri il Mostro prima di attivare il suo effetto.');
        const count=action.detachCount??0;
        if(!integer(count,0,90))fail('Numero di materiali da staccare non valido.');
        if(count&&(!MONSTERS.includes(zone)||!/xyz/i.test(card.type)||card.materials.length<count))fail('Materiali Xyz insufficienti per pagare questo costo.');
        const ids=action.detachMaterialIds??card.materials.slice(0,count).map(material=>material.id);
        if(!Array.isArray(ids)||ids.length!==count||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!card.materials.some(material=>material.id===id)))fail('Scegli i materiali Xyz da staccare.');
        for(const id of ids){const index=card.materials.findIndex(material=>material.id===id),material=card.materials.splice(index,1)[0];clearBoardState(material);material.faceUp=true;player.graveyard.push(material);}
        if(zone!=='hand')card.faceUp=true;
        const link=appendChain(next,playerIndex,card);
        message=`Catena ${link.number}: ${player.name} attiva ${card.cardName}${count?` e stacca ${count} materiale/i`:''}.`;break;
      }
      case 'passChain': {
        const chain=passChain(next,playerIndex);
        message=`${player.name} non risponde.${chain.stage==='resolving'?' La catena si risolve dall’ultimo anello.':''}`;break;
      }
      case 'resolveChain': {
        const link=resolveChain(next,playerIndex);message=`Risolto manualmente anello ${link.number}: ${link.cardName}.`;break;
      }
      case 'shuffle': {
        if (action.zone !== undefined && action.zone !== 'deck') fail('Puoi mescolare soltanto il Main Deck.');
        player.deck = shuffled(player.deck); message = `${player.name} mescola il mazzo.`; break;
      }
      case 'setPhase': {
        if(next.chain.length)fail('Completa la catena prima di cambiare fase o turno.');
        if (playerIndex !== next.activePlayer) fail('Il cambio fase spetta al giocatore attivo.');
        if (!PHASES.includes(action.phase)) fail('Fase di gioco non valida.');
        // Phase selection is a manual declaration: it never draws cards,
        // resolves effects or advances the turn implicitly.
        next.phase = action.phase;
        message = `Turno ${next.turn}: ${player.name} · ${next.phase}.`; break;
      }
      case 'nextPhase': {
        if(next.chain.length)fail('Completa la catena prima di cambiare fase o turno.');
        if (playerIndex !== next.activePlayer) fail('Il cambio fase spetta al giocatore attivo.');
        const index = PHASES.indexOf(next.phase);
        if (index === PHASES.length - 1) { next.turn++; next.activePlayer = 1 - next.activePlayer; next.phase = 'draw'; }
        else next.phase = PHASES[index + 1];
        message = `Turno ${next.turn}: ${next.players[next.activePlayer].name} · ${next.phase}.`; break;
      }
      case 'nextTurn': {
        if(next.chain.length)fail('Completa la catena prima di cambiare fase o turno.');
        if (playerIndex !== next.activePlayer) fail('Il cambio turno spetta al giocatore attivo.');
        next.turn++; next.activePlayer = 1 - next.activePlayer; next.phase = 'draw'; message = `Turno ${next.turn}: ${next.players[next.activePlayer].name}.`; break;
      }
      case 'token': {
        const slot = action.slot ?? zoneSlots(player, 'monsters').indexOf(null);
        if (!integer(slot, 0, 4) || player.monsters.some(card => card.slot === slot)) fail('Non c’è una posizione libera per il Segna-Mostro.');
        const position = action.position ?? 'attack'; if (!['attack', 'defense'].includes(position)) fail('Posizione del Segna-Mostro non valida.');
        const card = snapshotCard({ catalogCardId:'token', cardName:String(action.cardName || 'Segna-Mostro').slice(0, 300), type:'Token', atk:action.atk ?? 0, def:action.def ?? 0 }, `p${playerIndex}-token-${crypto.randomUUID()}`, 'token');
        card.token = true; card.faceUp = true; card.slot = slot; card.position = position; player.monsters.push(card); message = `${player.name} crea un Segna-Mostro.`; break;
      }
      case 'attachMaterial': {
        const found = findCard(player, action.cardId), target = findCard(player, action.targetId, true);
        if (found.card.id === target.card.id || found.card.token || !MONSTERS.includes(target.zone) || !/xyz/i.test(target.card.type) || !target.card.faceUp || target.card.materials.length >= 90) fail('Scegli una carta e un Mostro Xyz scoperto del tuo campo.');
        const publiclyKnown = found.card.faceUp && (BOARD.includes(found.zone) || ['graveyard', 'banished', 'extra'].includes(found.zone));
        player[found.zone].splice(found.index, 1); releaseMaterials(player, found.card); clearBoardState(found.card); found.card.faceUp = true;
        target.card.materials.push(found.card); message = `${player.name} assegna ${publiclyKnown ? found.card.cardName : 'una carta'} come materiale a ${target.card.cardName}.`; break;
      }
      case 'detachMaterial': {
        const { card, zone } = findCard(player, action.cardId, true), index = action.index ?? 0;
        if (!MONSTERS.includes(zone) || !integer(index, 0, card.materials.length - 1)) fail('Materiale Xyz non disponibile.');
        const material = card.materials.splice(index, 1)[0]; clearBoardState(material); material.faceUp = true; player.graveyard.push(material);
        message = `${player.name} stacca ${material.cardName} → Cimitero.`; break;
      }
      case 'finish': {
        if (![0, 1, 'draw'].includes(action.winner) || !text(action.notes ?? '', 4000)) fail('Risultato non valido.');
        next.result = { winner:action.winner, notes:action.notes || '', at }; message = action.winner === 'draw' ? 'Test concluso in pareggio.' : `${next.players[action.winner].name} vince il test.`; break;
      }
      default: fail('Azione non disponibile.');
    }
  }
  next.updatedAt = at; next.log.push({ at, turn:next.turn, type:action.type, player:action.type === 'start' ? null : playerIndex, text:message }); next.log = next.log.slice(-200);
  assertSession(next); return next;
}
