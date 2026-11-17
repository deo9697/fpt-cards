// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import createCore, { OcgCoreInternal, OcgDuelMode, OcgLocation, OcgMessageType as Msg, OcgPhase, OcgPosition, OcgProcessResult, OcgQueryFlags, OcgResponseType, OcgType, ocgTypeString, ocgRaceString } from 'ocgcore-wasm';
import { loadAutoResources } from './_yugioh-auto-resources.js';
import { isPromptMessage, normalizePrompt, resolveChoice, searchPromptCards } from './_yugioh-auto-prompts.js';
import { validateAutoDeck, AUTO_TCG_BANLIST } from './_yugioh-auto-deck-rules.js';

// The database persists the inputs, never a native pointer or a warm-instance key.
// Every accepted response is replayed against the same pinned Lua/core snapshot.
export const AUTO_ENGINE_VERSION = 'ocgcore-wasm@0.1.6/tcg-mr5-replay-1';
export const AUTO_RULES_PROFILE = Object.freeze({ id:'tcg-mr5', format:'tcg', name:'TCG · Master Rule 2020', description:'Regole TCG moderne e ordine degli effetti simultanei TCG.', automatic:true,banlist:AUTO_TCG_BANLIST });
const DUEL_FLAGS = OcgDuelMode.MODE_MR5 | OcgDuelMode.TCG_SEGOC_NONPUBLIC | OcgDuelMode.TCG_SEGOC_FIRSTTRIGGER;
const MAX_INPUTS = 4096;
const MAX_STEPS = 100000;
const REPLAY_MS = 15000;
const QUERY = OcgQueryFlags.CODE | OcgQueryFlags.POSITION | OcgQueryFlags.TYPE | OcgQueryFlags.LEVEL | OcgQueryFlags.RANK | OcgQueryFlags.ATTACK | OcgQueryFlags.DEFENSE | OcgQueryFlags.BASE_ATTACK | OcgQueryFlags.BASE_DEFENSE | OcgQueryFlags.COUNTERS | OcgQueryFlags.OVERLAY_CARD | OcgQueryFlags.IS_PUBLIC | OcgQueryFlags.IS_HIDDEN | OcgQueryFlags.LINK | OcgQueryFlags.LSCALE | OcgQueryFlags.RSCALE;
const ZONES = ['deck','hand','extra','side','monsters','spells','field','extraMonsters','graveyard','banished'];
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
const copy = value => JSON.parse(json(value));
const hash = value => createHash('sha256').update(json(value)).digest('hex');
function failure(code, message, status = 400) { const error = new Error(message); error.code = code; error.status = status; throw error; }
const playerIndex = player => player === 0 || player === 1;
const faceUp = position => !!(position & OcgPosition.FACEUP);
const phaseName = phase => ({[OcgPhase.DRAW]:'draw',[OcgPhase.STANDBY]:'standby',[OcgPhase.MAIN1]:'main1',[OcgPhase.MAIN2]:'main2',[OcgPhase.END]:'end'})[phase] || 'battle';
const pointerId = (controller, location, sequence) => `auto-${controller}-${location}-${sequence}`;

function canonicalSeed(seed) {
  const value = seed === undefined ? randomBytes(32).toString('hex') : seed;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value) || /^0+$/.test(value)) failure('invalid_seed', 'Seme della partita non valido.');
  return value.toLowerCase();
}

// Core always calls its starting player 0. Translate all public locations into
// the fixed host/guest seats, so the existing arena keeps its point of view.
function mapPlayers(value, firstPlayer) {
  if (Array.isArray(value)) return value.map(item => mapPlayers(item, firstPlayer));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = ['player','controller','triggering_controller'].includes(key) && playerIndex(item) ? item ^ firstPlayer : mapPlayers(item, firstPlayer);
  return out;
}
function cardMetadata(code, resources, query = {}) {
  const card = resources.cards.get(code) || {};
  const type = query.type ?? card.type ?? 0;
  const types = Object.values(OcgType).filter(bit => type & bit).map(bit => ocgTypeString.get(bit)).filter(Boolean).map(value => value === 'xyz' ? 'XYZ' : value[0].toUpperCase() + value.slice(1));
  return { catalogCardId:String(code), code, cardName:card.name || `Carta ${code}`, name:card.name || `Carta ${code}`, imageUrl:`https://images.ygoprodeck.com/images/cards/${code}.jpg`, type:types.join(' '), text:card.desc || card.description || '', race:ocgRaceString.get(card.race || 0n) || '', atk:query.attack ?? card.attack ?? 0, def:query.defense ?? card.defense ?? 0, baseAtk:query.baseAttack ?? card.attack ?? 0, baseDef:query.baseDefense ?? card.defense ?? 0, level:query.level ?? card.level ?? 0, rank:query.rank ?? ((type & OcgType.XYZ) ? card.level : 0), isTuner:!!(type & OcgType.TUNER), linkRating:query.link?.rating ?? ((type & OcgType.LINK) ? card.level : 0), linkMarkers:query.link?.marker ?? card.link_marker ?? 0, leftScale:query.leftScale ?? card.lscale ?? 0, rightScale:query.rightScale ?? card.rscale ?? 0, token:!!(type & OcgType.TOKEN) };
}
function concealedCard(controller, zone, sequence, position, slot,location) {
  return { id:`hidden-${controller}-${zone}-${sequence}`, hidden:true, catalogCardId:'', cardName:'Carta coperta', imageUrl:'', controller,...(location===undefined?{}:{location,sequence}),faceUp:false, position:(position & OcgPosition.DEFENSE) ? 'defense' : 'attack', slot, counters:0, materials:[] };
}
function coreBoundary(core,duel) {
  const module=core[OcgCoreInternal]?.module;
  const internal=Object.getOwnPropertySymbols(duel).map(symbol=>duel[symbol]).find(value=>Number.isInteger(value?.handle));
  if(!module||!internal) failure('engine_incompatible','Versione del motore non compatibile.',503);
  return {module,handle:internal.handle};
}
// The pinned wrapper does not consume TYPE query payloads and reverses counter
// kind/count. Read the core's length-delimited query records without losing sync.
function queryLocation(core,duel,controller,location) {
  const {module,handle}=coreBoundary(core,duel),stack=module.stackSave();
  try {
    const request=module.stackAlloc(24),lengthPointer=module.stackAlloc(4);
    const heap=new DataView(module.HEAPU8.buffer); heap.setUint32(request,QUERY,true); heap.setUint8(request+4,controller); heap.setUint32(request+8,location,true); heap.setUint32(request+12,0,true); heap.setUint32(request+16,0,true);
    const pointer=module._ocgapiDuelQueryLocation(handle,lengthPointer,request),length=module.getValue(lengthPointer,'i32');
    const data=new DataView(module.HEAPU8.slice(pointer,pointer+length).buffer);
    if(length<4) return [];
    let offset=4,current=null; const cards=[];
    const scalar={1:'code',2:'position',8:'type',16:'level',32:'rank',256:'attack',512:'defense',1024:'baseAttack',2048:'baseDefense',2097152:'leftScale',4194304:'rightScale'};
    while(offset<data.byteLength) {
      if(offset+2>data.byteLength) failure('engine_query_invalid','Risposta del motore non valida.',503);
      const size=data.getUint16(offset,true);offset+=2;
      if(size===0){cards.push(null);continue;}
      if(size<4||offset+size>data.byteLength) failure('engine_query_invalid','Risposta del motore non valida.',503);
      const flag=data.getUint32(offset,true),body=offset+4,end=offset+size; current??={};
      if(flag===0x80000000){cards.push(current);current=null;}
      else if(scalar[flag]&&size===8) current[scalar[flag]]=[256,512,1024,2048].includes(flag)?data.getInt32(body,true):data.getUint32(body,true);
      else if(flag===OcgQueryFlags.IS_PUBLIC&&size===5) current.isPublic=!!data.getUint8(body);
      else if(flag===OcgQueryFlags.IS_HIDDEN&&size===5) current.isHidden=!!data.getUint8(body);
      else if(flag===OcgQueryFlags.LINK&&size===12) current.link={rating:data.getUint32(body,true),marker:data.getUint32(body+4,true)};
      else if(flag===OcgQueryFlags.OVERLAY_CARD&&size>=8){const count=data.getUint32(body,true);if(body+4+count*4>end)failure('engine_query_invalid','Materiali non validi.',503);current.overlayCards=Array.from({length:count},(_,index)=>data.getUint32(body+4+index*4,true));}
      else if(flag===OcgQueryFlags.COUNTERS&&size>=8){const count=data.getUint32(body,true);if(body+4+count*4>end)failure('engine_query_invalid','Segnalini non validi.',503);current.counters={};for(let index=0;index<count;index++)current.counters[data.getUint16(body+4+index*4,true)]=data.getUint16(body+6+index*4,true);}
      offset=end;
    }
    return cards;
  } finally {module.stackRestore(stack);}
}
function queryPlayers(core, duel, state, resources, viewer, lp) {
  return state.initialDecks.map((deck, seat) => {
    const controller = seat ^ state.firstPlayer;
    const player = { name:state.names[seat], deckName:deck.name, deckId:seat === viewer ? deck.id : '', lp:lp[seat] };
    for (const zone of ZONES) player[zone] = [];
    const locations = [[OcgLocation.DECK,'deck'],[OcgLocation.HAND,'hand'],[OcgLocation.EXTRA,'extra'],[OcgLocation.MZONE,'monsters'],[OcgLocation.SZONE,'spells'],[OcgLocation.GRAVE,'graveyard'],[OcgLocation.REMOVED,'banished']];
    for (const [location, defaultZone] of locations) {
      const entries = queryLocation(core,duel,controller,location);
      entries.forEach((query, sequence) => {
        if (!query) return;
        const zone = location === OcgLocation.MZONE && sequence >= 5 ? 'extraMonsters' : location === OcgLocation.SZONE && sequence === 5 ? 'field' : defaultZone;
        const slot = zone === 'extraMonsters' ? (seat === 0 ? sequence - 5 : 6 - sequence) : zone === 'field' ? 0 : ['monsters','spells'].includes(zone) ? sequence : null;
        const position = query.position ?? OcgPosition.FACEDOWN_DEFENSE;
        const visible = location !== OcgLocation.DECK && (seat === viewer || !!query.isPublic || (location !== OcgLocation.HAND && faceUp(position)));
        if (!visible) { player[zone].push(concealedCard(seat,zone,sequence,position,slot,location)); return; }
        const code = query.code || 0;
        const materials = (query.overlayCards || []).map((materialCode, index) => ({...cardMetadata(materialCode,resources),id:`${pointerId(seat,location,sequence)}-material-${index}`,faceUp:true,position:'attack',slot:null,counters:0,materials:[]}));
        player[zone].push({ ...cardMetadata(code,resources,query), id:pointerId(seat,location,sequence), controller:seat, location, sequence, corePosition:position, originSection:location === OcgLocation.EXTRA ? 'extra' : 'main', faceUp:faceUp(position), position:(position & OcgPosition.DEFENSE) ? 'defense' : 'attack', slot, atkModifier:0, defModifier:0, counters:Object.values(query.counters || {}).reduce((sum,value) => sum + value,0), counterTypes:query.counters || {}, materials });
      });
    }
    player.side = deck.side.map((code,index) => seat === viewer ? {...cardMetadata(code,resources),id:`auto-side-${seat}-${index}`,faceUp:false,position:'attack',slot:null,materials:[],counters:0} : concealedCard(seat,'side',index,0,null));
    return player;
  });
}
function promptVisibility(core,duel,state,knownReveals) {
  const locations=new Map();
  return (card,viewer)=>{
    if(card.controller===viewer)return true;
    if(!playerIndex(card.controller)||!Number.isInteger(card.location)||!Number.isInteger(card.sequence))return false;
    const key=`${card.controller}-${card.location}`;
    if(!locations.has(key))locations.set(key,queryLocation(core,duel,card.controller^state.firstPlayer,card.location));
    const query=locations.get(key)[card.sequence];
    if(!query)return false;
    if(knownReveals?.[viewer]?.get(pointerId(card.controller,card.location,card.sequence))===query.code)return true;
    if(query.isPublic)return true;
    return [OcgLocation.MZONE,OcgLocation.SZONE,OcgLocation.GRAVE,OcgLocation.REMOVED,OcgLocation.EXTRA].includes(card.location)&&faceUp(query.position||0);
  };
}
function moveRevealKnowledge(known,message) {
  const vectorLocations=[OcgLocation.DECK,OcgLocation.HAND,OcgLocation.EXTRA,OcgLocation.GRAVE,OcgLocation.REMOVED];
  for(const entries of known){
    const source=pointerId(message.from.controller,message.from.location,message.from.sequence);
    const remembered=entries.get(source)===message.card||faceUp(message.from.position||0);
    entries.delete(source);
    const afterRemoval=[];
    for(const [key,code]of entries){
      const match=key.match(/^auto-([01])-(\d+)-(\d+)$/);if(!match)continue;
      const controller=Number(match[1]),location=Number(match[2]),sequence=Number(match[3]);
      afterRemoval.push([controller===message.from.controller&&location===message.from.location&&vectorLocations.includes(location)&&sequence>message.from.sequence?pointerId(controller,location,sequence-1):key,code]);
    }
    entries.clear();
    for(const [key,code]of afterRemoval){
      const match=key.match(/^auto-([01])-(\d+)-(\d+)$/);if(!match)continue;
      const controller=Number(match[1]),location=Number(match[2]),sequence=Number(match[3]);
      entries.set(controller===message.to.controller&&location===message.to.location&&vectorLocations.includes(location)&&sequence>=message.to.sequence?pointerId(controller,location,sequence+1):key,code);
    }
    if(remembered&&message.to.location)entries.set(pointerId(message.to.controller,message.to.location,message.to.sequence),message.card);
  }
}

// 0.1.6's SORT_CARD writer prepends a count, while ocgcore expects only the
// permutation bytes. Keep this small, pinned compatibility shim at the boundary.
function setResponse(core, duel, response) {
  if (response.type !== OcgResponseType.SORT_CARD) { core.duelSetResponse(duel,response); return; }
  const bytes = Uint8Array.from(response.order === null ? [255] : response.order);
  const {module,handle}=coreBoundary(core,duel);
  const stack = module.stackSave();
  try { const pointer = module.stackAlloc(Math.max(bytes.length,1)); module.HEAPU8.set(bytes,pointer); module._ocgapiDuelSetResponse(handle,pointer,bytes.length); }
  finally { module.stackRestore(stack); }
}

async function replay(state) {
  const started = performance.now();
  const resources = await loadAutoResources();
  if (state.resourceVersion && state.resourceVersion !== resources.version) failure('resource_version_changed','La versione delle carte della partita non è più disponibile.',409);
  if (state.engineVersion !== AUTO_ENGINE_VERSION) failure('engine_version_changed','Questa partita usa una versione diversa del motore.',409);
  if (!Array.isArray(state.inputs) || state.inputs.length > MAX_INPUTS) failure('replay_limit','La partita ha raggiunto il limite di azioni.',409);
  const core = await createCore({sync:true,print:() => {},printErr:() => {}});
  let duel;
  const errors = [];
  try {
    const seed = state.seed.match(/.{16}/g).map(value => BigInt(`0x${value}`));
    duel = core.createDuel({flags:DUEL_FLAGS,seed,team1:{startingLP:state.lp[state.firstPlayer],startingDrawCount:5,drawCountPerTurn:1},team2:{startingLP:state.lp[state.firstPlayer ^ 1],startingDrawCount:5,drawCountPerTurn:1},cardReader:code => resources.cards.get(code) || null,scriptReader:name => resources.scripts.get(name) || null,errorHandler:(type,text) => { if (type === 0) errors.push(String(text).slice(0,500)); }});
    if (!duel) failure('engine_start_failed','Il motore non ha potuto creare il duello.',503);
    for (const script of ['constant.lua','utility.lua']) if (!core.loadScript(duel,script,resources.scripts.get(script))) failure('engine_scripts_missing','Script base del motore non disponibile.',503);
    state.initialDecks.forEach((deck,seat) => {
      const controller = seat ^ state.firstPlayer;
      for (const [zone,location] of [['main',OcgLocation.DECK],['extra',OcgLocation.EXTRA]]) for (const code of deck[zone]) core.duelNewCard(duel,{code,team:controller,duelist:0,controller,location,sequence:0,position:OcgPosition.FACEDOWN_DEFENSE});
    });
    core.startDuel(duel);
    let sequence = 0, steps = 0, pending = null;
    const lp = [...state.lp];
    const events = {turn:0,phase:'draw',activePlayer:state.firstPlayer,chain:[],log:[],result:null,lastActivation:null,battle:null,revealedCards:[[],[]],knownReveals:[new Map(),new Map()]};
    const log = (type,player,text) => { events.log.push({at:state.createdAt,turn:events.turn,type,player,text}); if(events.log.length > 150) events.log.shift(); };
    while (++steps <= MAX_STEPS) {
      if (performance.now() - started > REPLAY_MS) failure('engine_timeout','Il motore ha impiegato troppo tempo. Riprova.',503);
      const status = core.duelProcess(duel);
      const messages = core.duelGetMessage(duel);
      pending = null;
      for (const original of messages) {
        const message = mapPlayers(original,state.firstPlayer);
        if (message.type === Msg.RETRY) failure('invalid_choice','La scelta non è valida per il motore. Aggiorna il tavolo.',409);
        if (isPromptMessage(message)) pending = message;
        switch (message.type) {
          case Msg.NEW_TURN: events.turn++; events.activePlayer=message.player; log('turn',message.player,`Turno di ${state.names[message.player]}`); break;
          case Msg.NEW_PHASE: events.phase=phaseName(message.phase); break;
          case Msg.LPUPDATE: lp[message.player]=message.lp; break;
          case Msg.DAMAGE: case Msg.PAY_LPCOST: lp[message.player]=Math.max(0,lp[message.player]-message.amount); log('lp',message.player,`${message.type === Msg.DAMAGE ? 'Danno' : 'Costo'}: ${message.amount} LP`); break;
          case Msg.RECOVER: lp[message.player]+=message.amount; log('lp',message.player,`Recupera ${message.amount} LP`); break;
          case Msg.TOSS_DICE:log('random',message.player,`Risultato dadi: ${message.results.join(', ')}`);break;
          case Msg.TOSS_COIN:log('random',message.player,`Risultato monete: ${message.results.map(result=>result?'testa':'croce').join(', ')}`);break;
          case Msg.DRAW: log('draw',message.player,`Pesca ${message.drawn.length} carta/e`); break;
          case Msg.MOVE:moveRevealKnowledge(events.knownReveals,message);break;
          case Msg.SHUFFLE_DECK:case Msg.SHUFFLE_HAND:case Msg.SHUFFLE_EXTRA:{
            const location=message.type===Msg.SHUFFLE_DECK?OcgLocation.DECK:message.type===Msg.SHUFFLE_HAND?OcgLocation.HAND:OcgLocation.EXTRA;
            for(const entries of events.knownReveals)for(const key of entries.keys())if(key.startsWith(`auto-${message.player}-${location}-`))entries.delete(key);
            break;
          }
          case Msg.SHUFFLE_SET_CARD:for(const entries of events.knownReveals)for(const key of entries.keys())if(key.match(/^auto-[01]-(4|8)-/))entries.delete(key);break;
          case Msg.CONFIRM_CARDS: case Msg.CONFIRM_DECKTOP: case Msg.CONFIRM_EXTRATOP: {
            // EDOPro's network boundary broadcasts ordinary confirmations, but
            // a deck/extra-deck CONFIRM_CARDS belongs only to its recipient.
            // DECKTOP/EXTRATOP use player as owner and are public confirmations.
            const privateConfirmation=message.type===Msg.CONFIRM_CARDS&&[OcgLocation.DECK,OcgLocation.EXTRA].includes(message.cards[0]?.location);
            const recipients=privateConfirmation?[message.player]:[0,1];
            const cards=message.cards.slice(0,60).filter(card=>card.code>0).map(card=>({...cardMetadata(card.code,resources),controller:card.controller,location:card.location,sequence:card.sequence,id:`reveal-${sequence}-${card.controller}-${card.location}-${card.sequence}`,faceUp:true,source:message.type===Msg.CONFIRM_CARDS?'confirm':message.type===Msg.CONFIRM_DECKTOP?'deck-top':'extra-top',revealId:`reveal-${hash([sequence,message]).slice(0,20)}`}));
            for(const recipient of recipients)if(playerIndex(recipient)){
              for(const card of cards)events.knownReveals[recipient].set(pointerId(card.controller,card.location,card.sequence),card.code);
              const combined=[...events.revealedCards[recipient],...cards],unique=new Map(combined.map(card=>[`${card.controller}-${card.location}-${card.sequence}-${card.code}`,card]));
              events.revealedCards[recipient]=[...unique.values()].slice(-60);
            }
            break;
          }
          case Msg.SUMMONING: case Msg.SPSUMMONING: case Msg.FLIPSUMMONING: log('summon',message.controller,`Evoca ${faceUp(message.position)?resources.cards.get(message.code)?.name||'un mostro':'un mostro coperto'}`); break;
          case Msg.CHAINING: {
            const card = cardMetadata(message.code,resources);
            const link = {activationId:`activation-${sequence}-${message.chain_size}`,number:message.chain_size,player:message.triggering_controller,cardId:pointerId(message.controller,message.location,message.sequence),cardName:card.cardName,imageUrl:card.imageUrl,card,controller:message.controller,location:message.location,sequence:message.sequence,status:'pending'};
            events.chain.push(link); events.lastActivation=link; log('activate',link.player,`Catena ${link.number}: ${link.cardName}`); break;
          }
          case Msg.CHAIN_SOLVING: { const link=events.chain.find(item=>item.number===message.chain_size); if(link) link.status='resolving'; break; }
          case Msg.CHAIN_NEGATED: case Msg.CHAIN_DISABLED: { const link=events.chain.find(item=>item.number===message.chain_size); if(link) link.status='negated'; log('chain',link?.player??null,`Catena ${message.chain_size} negata`); break; }
          case Msg.CHAIN_SOLVED: { const link=events.chain.find(item=>item.number===message.chain_size); if(link) link.status='resolved'; log('chain',link?.player??null,`Risolve catena ${message.chain_size}`); break; }
          case Msg.CHAIN_END: events.chain=[]; for(const entries of events.knownReveals)entries.clear(); break;
          case Msg.ATTACK: {
            const publicLocation=card=>card?{controller:card.controller,location:card.location,sequence:card.sequence}:null;
            events.battle={attacker:publicLocation(message.card),target:publicLocation(message.target),stage:'response'};break;
          }
          case Msg.DAMAGE_STEP_START:if(events.battle)events.battle.stage='damage';break;
          case Msg.DAMAGE_STEP_END:case Msg.ATTACK_DISABLED:events.battle=null;break;
          case Msg.WIN: events.result={winner:playerIndex(message.player)?message.player:'draw',notes:playerIndex(message.player)?`${state.names[message.player]} vince il duello.`:'Il duello termina in pareggio.',at:state.createdAt}; break;
        }
      }
      // Script diagnostics can mention an unrevealed opponent card. Keep that
      // private even when processing fails before the next public projection.
      if (errors.length) failure('engine_script_error','Non è stato possibile completare l’effetto. La mossa non è stata salvata.',503);
      if (status === OcgProcessResult.END || events.result) {
        if (sequence !== state.inputs.length) failure('stale_prompt','La partita è già conclusa.',409);
        pending=null; break;
      }
      if (status === OcgProcessResult.CONTINUE) continue;
      if (status !== OcgProcessResult.WAITING || !pending) failure('unsupported_prompt','Il motore richiede una scelta non supportata.',503);
      const id = `prompt-${hash([state.seed,state.engineVersion,resources.version,sequence,pending]).slice(0,32)}`;
      const prompt = normalizePrompt(pending,{id,sequence,resources,cards:resources.cards,strings:resources.strings,cardInfo:code=>cardMetadata(code,resources),isCardVisible:promptVisibility(core,duel,state,events.knownReveals)});
      if (!prompt) failure('unsupported_prompt','Il motore richiede una scelta non supportata.',503);
      if (sequence === state.inputs.length) {
        state.pendingMessage=copy(pending); state.pendingPromptId=id;
        const publicBase = {mode:'auto',format:'tcg',status:events.result?'finished':'playing',turn:events.turn,phase:events.phase,activePlayer:events.activePlayer,chain:events.chain,battle:events.battle,log:events.log,result:events.result,startingPlayer:state.firstPlayer,firstPlayer:state.firstPlayer};
        state.publicViews=[0,1].map(viewer=>({...copy(publicBase),players:queryPlayers(core,duel,state,resources,viewer,lp),auto:{engineVersion:state.engineVersion,resourceVersion:resources.version,rulesProfile:AUTO_RULES_PROFILE,inputSequence:sequence,prompt:pending.player===viewer?copy(prompt):null,waitingFor:pending.player,waitingPlayer:pending.player,actor:pending.player,lastActivation:copy(events.lastActivation),revealedCards:copy(events.revealedCards[viewer])}}));
        break;
      }
      const input=state.inputs[sequence];
      if (input.viewer !== pending.player || input.promptId !== id) failure('stale_prompt','La scelta non appartiene alla richiesta attuale.',409);
      const response=resolveChoice(pending,input.choice,{resources,cards:resources.cards,strings:resources.strings});
      setResponse(core,duel,mapPlayers(response,state.firstPlayer));
      sequence++;
    }
    if (steps > MAX_STEPS) failure('engine_step_limit','Il motore ha superato il limite di elaborazione.',503);
    if (!pending) {
      const publicBase={mode:'auto',format:'tcg',status:'finished',turn:events.turn,phase:events.phase,activePlayer:events.activePlayer,chain:events.chain,battle:events.battle,log:events.log,result:events.result,startingPlayer:state.firstPlayer,firstPlayer:state.firstPlayer};
      state.publicViews=[0,1].map(viewer=>({...copy(publicBase),players:queryPlayers(core,duel,state,resources,viewer,lp),auto:{engineVersion:state.engineVersion,resourceVersion:resources.version,rulesProfile:AUTO_RULES_PROFILE,inputSequence:sequence,prompt:null,waitingFor:null,waitingPlayer:null,actor:null,lastActivation:copy(events.lastActivation),revealedCards:copy(events.revealedCards[viewer])}}));
      delete state.pendingMessage; delete state.pendingPromptId;
    }
    state.resourceVersion=resources.version; state.inputSequence=sequence; state.result=events.result;
    return state;
  } finally { if (duel) core.destroyDuel(duel); }
}

export async function createAutoState({decks,names=['Giocatore 1','Giocatore 2'],lp=[8000,8000],firstPlayer=0,seed}={}) {
  if (!Array.isArray(decks) || decks.length !== 2 || !playerIndex(firstPlayer)) failure('invalid_setup','Servono due mazzi e il primo giocatore.');
  if (typeof lp === 'number') lp=[lp,lp];
  if (!Array.isArray(lp) || lp.length !== 2 || !lp.every(value=>Number.isInteger(value)&&value>=1&&value<=999999)) failure('invalid_lp','Life Points iniziali non validi.');
  const resources=await loadAutoResources();
  const initialDecks=decks.map(deck=>validateAutoDeck(deck,resources));
  const state={mode:'auto',engineVersion:AUTO_ENGINE_VERSION,resourceVersion:resources.version,seed:canonicalSeed(seed),initialDecks,names:[0,1].map(index=>String(names?.[index]||`Giocatore ${index+1}`).slice(0,100)),lp:[...lp],firstPlayer,inputs:[],inputSequence:0,createdAt:new Date().toISOString()};
  return replay(state);
}

export function projectAutoState(state,viewer) {
  if (!state || state.mode !== 'auto' || !playerIndex(viewer) || !state.publicViews?.[viewer]) return null;
  const source=state.publicViews[viewer];
  // Explicit top-level allowlist: seed, initial decks, response transcript and
  // pending raw engine messages can never cross this service boundary.
  return copy({...(state.id?{id:state.id}:{}),mode:'auto',format:'tcg',status:source.status,players:source.players,turn:source.turn,phase:source.phase,activePlayer:source.activePlayer,firstPlayer:source.firstPlayer,startingPlayer:source.startingPlayer,chain:source.chain,battle:source.battle,log:source.log,result:source.result,auto:source.auto});
}

export async function applyAutoInput(state,{viewer,promptId,choice}={}) {
  if (!state || state.mode !== 'auto' || !playerIndex(viewer)) failure('invalid_state','Partita automatica non disponibile.');
  if(state.result) failure('duel_finished','La partita è già conclusa.',409);
  const prompt=state.publicViews?.[viewer]?.auto?.prompt;
  if (!prompt || prompt.id !== promptId || state.pendingPromptId !== promptId) failure('stale_prompt','La richiesta è cambiata o spetta all’altro giocatore.',409);
  if (state.inputs.length >= MAX_INPUTS) failure('replay_limit','La partita ha raggiunto il limite di azioni.',409);
  if (!choice || typeof choice !== 'object' || Array.isArray(choice) || json(choice).length > 16000) failure('invalid_choice','Scelta non valida.');
  const resources=await loadAutoResources();
  resolveChoice(state.pendingMessage,choice,{resources,cards:resources.cards,strings:resources.strings});
  const next=copy(state);
  next.inputs.push({viewer,promptId,choice:copy(choice)});
  return replay(next);
}

export async function searchAutoCards(state,{viewer,promptId,query}={}) {
  if (!state || !playerIndex(viewer) || state.pendingMessage?.player !== viewer || state.pendingPromptId !== promptId || state.pendingMessage?.type !== Msg.ANNOUNCE_CARD) failure('stale_prompt','La dichiarazione di carta non è disponibile.',409);
  const resources=await loadAutoResources();
  return searchPromptCards(state.pendingMessage,String(query||'').slice(0,100),{resources,cards:resources.cards,limit:30});
}
