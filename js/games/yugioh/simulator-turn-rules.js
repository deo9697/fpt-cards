// Basic turn rules for newly created tables. Missing turnState keeps existing
// manual tables compatible; effect-specific exceptions remain explicit actions.
const phases=['draw','standby','main1','battle','main2','end'];
const monsterZones=['monsters','extraMonsters'];
const typeOf=card=>String(card?.type||card?.cardType||'').toLowerCase();
const fail=message=>{throw new Error(message);};
export const newTurnState=turn=>({turn,normalUsed:0,normalLimit:1,drawn:turn===1,battleEntered:false});
export function getTurnState(session){return session?.turnState?{...session.turnState}:null;}
export function canDrawNormally(session,player){
  if(!session?.players?.[player]||session.result||session.phase==='setup')return false;
  if(!getTurnState(session))return Boolean(session.players[player].deck.length);
  return player===session.activePlayer&&session.phase==='draw'&&session.turn!==1&&!session.turnState.drawn&&!session.chain.length&&Boolean(session.players[player].deck.length);
}
export function phaseError(session,player,phase){
  if(!phases.includes(phase))return 'Fase di gioco non valida.';
  if(player!==session.activePlayer)return 'Il cambio fase spetta al giocatore attivo.';
  if(session.chain.length)return 'Completa la catena prima di cambiare fase o turno.';
  if(session.result||session.phase==='setup')return 'Il duello non è disponibile.';
  const rules=getTurnState(session);if(!rules)return null;
  if(phase===session.phase)return null;
  if(session.phase==='draw'){
    if(!rules.drawn)return 'Esegui la pescata del turno prima di cambiare fase.';
    return phase==='standby'?null:'Passa prima alla Standby Phase.';
  }
  if(session.phase==='standby')return phase==='main1'?null:'Passa prima alla Main Phase 1.';
  if(session.phase==='main1'){
    if(phase==='end')return null;
    if(phase==='battle')return session.turn===1?'Nel primo turno non puoi entrare in Battle Phase.':null;
  }
  if(session.phase==='battle'&&['main2','end'].includes(phase))return null;
  if(session.phase==='main2'&&phase==='end')return null;
  return phase==='main2'&&!rules.battleEntered?'La Main Phase 2 segue una Battle Phase.':'Non puoi tornare a una fase precedente del turno.';
}
export const canSelectPhase=(session,player,phase)=>!phaseError(session,player,phase);
export function endTurnError(session,player,{ignoreHand=false}={}){
  if(player!==session.activePlayer)return 'Il cambio turno spetta al giocatore attivo.';
  if(session.chain.length)return 'Completa la catena prima di cambiare fase o turno.';
  if(session.result||session.phase==='setup')return 'Il duello non è disponibile.';
  const rules=getTurnState(session);if(!rules)return null;
  if(!rules.drawn)return 'Esegui la pescata del turno prima di terminarlo.';
  if(['draw','standby'].includes(session.phase))return 'Passa prima alla Main Phase 1 prima di terminare il turno.';
  if(!ignoreHand&&session.players[player].hand.length>6)return 'A fine turno scegli le carte da scartare fino ad avere 6 carte in mano.';
  return null;
}
export function requiredTributes(card){
  const level=card?.level;
  if(level===null||level===undefined||level===''||!Number.isInteger(Number(level))||Number(level)<1)return null;
  return Number(level)>=7?2:Number(level)>=5?1:0;
}
export function normalPlayError(session,player,card){
  if(!getTurnState(session))return null;
  if(player!==session.activePlayer||!['main1','main2'].includes(session.phase))return 'Evoca o posiziona normalmente durante la tua Main Phase.';
  if(session.chain.length)return 'Completa la catena prima dell’Evocazione Normale/Set.';
  if(session.turnState.normalUsed>=session.turnState.normalLimit)return 'Hai già usato l’Evocazione Normale/Set di questo turno.';
  if(!session.players[player]?.hand.some(item=>item.id===card?.id)||/ritual|fusion|synchro|xyz|link/.test(typeOf(card)))return 'Scegli un Mostro dalla mano che possa essere Evocato Normalmente.';
  if(requiredTributes(card)===null)return 'Livello del Mostro non disponibile: ricarica il mazzo per verificare i tributi.';
  return null;
}
export function validateNormalTributes(session,player,card,ids=[]){
  if(!getTurnState(session))return [];
  const error=normalPlayError(session,player,card);if(error)fail(error);
  const count=requiredTributes(card);
  if(!Array.isArray(ids)||ids.length!==count||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id))fail(`Seleziona ${count} tributo/i distinti dal tuo terreno.`);
  return ids.map(id=>{
    for(const zone of monsterZones){const index=session.players[player][zone].findIndex(material=>material.id===id);if(index!==-1)return{card:session.players[player][zone][index],zone,index};}
    fail('Un tributo selezionato non è un tuo Mostro sul terreno.');
  });
}
export function positionChangeError(session,player,card,zone,{position,faceUp}={}){
  if(!getTurnState(session)||!monsterZones.includes(zone))return null;
  if(player!==session.activePlayer||!['main1','main2'].includes(session.phase))return 'Cambia posizione durante la tua Main Phase.';
  if(session.chain.length)return 'Completa la catena prima di cambiare posizione.';
  if(card.summonedTurn===session.turn)return 'Non puoi cambiare posizione a un Mostro evocato o posizionato in questo turno.';
  if(card.positionChangedTurn===session.turn)return 'Questo Mostro ha già cambiato posizione in questo turno.';
  if(!faceUp)return 'Per coprire un Mostro usa il comando di posizione per effetto.';
  if(!card.faceUp&&position!=='attack')return 'La Flip Summon scopre il Mostro in Attacco; per scoprirlo in Difesa usa un effetto.';
  if(card.faceUp&&position===card.position)return 'Il Mostro è già in questa posizione.';
  return null;
}
