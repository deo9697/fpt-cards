// Guided standard battles. Card-specific attack restrictions, replacement effects
// and Damage Step effect timing remain decisions of the manual-table players.
const zones=['monsters','extraMonsters'];
const fail=message=>{throw new Error(message);};
const integer=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
const playerIndex=value=>value===0||value===1;
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text=(value,max)=>typeof value==='string'&&value.length<=max;
const coordinate=target=>target&&typeof target==='object'&&!Array.isArray(target)&&Object.keys(target).length===2&&zones.includes(target.zone)&&integer(target.slot,0,target.zone==='monsters'?4:1);

export function battleMonsters(state,player){return zones.flatMap(zone=>(state?.players?.[player]?.[zone]||[]).map(card=>({card,zone})));}
export function battleMonster(state,player,id){return battleMonsters(state,player).find(found=>found.card.id===id)||null;}
export function battleTarget(state,battle=state?.battle){return battle?.target?state?.players?.[1-battle.player]?.[battle.target.zone]?.find(card=>card.slot===battle.target.slot)||null:null;}
export function effectiveBattleStat(card,stat){
  const override=card?.[`${stat}Override`];
  const base=override??card?.[stat],modifier=card?.[`${stat}Modifier`]??0;
  return typeof base==='number'&&Number.isFinite(base)&&base>=0&&typeof modifier==='number'&&Number.isFinite(modifier)&&Number.isInteger(base+modifier)?Math.max(0,base+modifier):null;
}
export function attackError(state,player,card,{replay=false}={}){
  if(!state?.turnState)return 'Avvia una nuova partita per usare il combattimento guidato.';
  if(state.result||state.phase==='setup')return 'Il duello non è disponibile per un attacco.';
  if(player!==state.activePlayer||state.phase!=='battle'||state.turn===1)return 'Attacca nella tua Battle Phase, dopo il primo turno.';
  if(state.chain?.length)return 'Completa la catena prima di dichiarare un attacco.';
  if(state.battle&&!replay)return 'Completa il combattimento già dichiarato.';
  const found=battleMonster(state,player,card?.id);
  if(!found||!found.card.faceUp||found.card.position!=='attack')return 'Scegli un tuo Mostro scoperto in Attacco.';
  if(!replay&&found.card.attackedTurn===state.turn)return 'Questo Mostro ha già dichiarato un attacco in questo turno.';
  if(effectiveBattleStat(found.card,'atk')===null)return 'ATK non disponibile: imposta il valore attuale prima di attaccare.';
  return null;
}
export const canDeclareAttack=(state,player,card)=>!attackError(state,player,card);
export function attackTargets(state,player){
  return battleMonsters(state,1-player).map(({card,zone})=>({zone,slot:card.slot,faceUp:card.faceUp===true,cardName:card.faceUp?card.cardName:'Mostro coperto'}));
}
function checkedTarget(state,player,target){
  if(target===null){if(battleMonsters(state,1-player).length)fail('Puoi attaccare direttamente solo se il campo avversario non ha Mostri.');return null;}
  if(!coordinate(target)||!state.players[1-player][target.zone].some(card=>card.slot===target.slot))fail('Scegli un Mostro avversario ancora presente nella casella indicata.');
  return{zone:target.zone,slot:target.slot};
}
export function declareBattle(state,player,cardId,target,{replay=false}={}){
  const previous=state.battle;
  if(replay&&(!previous||previous.stage!=='replay'||previous.player!==player))fail('Non è disponibile una nuova scelta del bersaglio.');
  const id=replay?previous.attackerId:cardId,attacker=battleMonster(state,player,id)?.card;
  const error=attackError(state,player,attacker,{replay});if(error)fail(error);
  const chosen=checkedTarget(state,player,target);
  attacker.attackedTurn=state.turn;
  state.battle={id:replay?previous.id:globalThis.crypto.randomUUID(),player,attackerId:id,target:chosen,stage:'response',priority:1-player,passes:0};
  return state.battle;
}
function targetName(state,battle){const target=battleTarget(state,battle);return battle.target?(target?.faceUp?target.cardName:'Mostro coperto'):'Attacco diretto';}
export function cancelBattle(state,player,{reason='Attacco annullato.',internal=false}={}){
  const battle=state.battle;
  if(!battle)fail('Non ci sono attacchi da annullare.');
  if(!internal&&(battle.player!==player||state.chain.length))fail('Solo chi attacca può annullare, dopo aver completato la catena.');
  if(!internal&&['damage','manual'].includes(battle.stage))fail('Non puoi rinunciare all’attacco dopo l’inizio del Damage Step.');
  const attacker=battleMonster(state,battle.player,battle.attackerId)?.card;
  state.lastBattle={id:battle.id,turn:state.turn,player:battle.player,attackerName:attacker?.cardName||'Mostro attaccante',targetName:targetName(state,battle),damage:[0,0],destroyed:[],canceled:true,summary:reason};
  state.battle=null;
  return state.lastBattle;
}
export function calculateBattle(state){
  const battle=state.battle;
  if(!battle||battle.stage!=='damage')fail('Il combattimento non è pronto per il calcolo dei danni.');
  const attacker=battleMonster(state,battle.player,battle.attackerId)?.card,target=battleTarget(state,battle);
  if(!attacker||!attacker.faceUp||attacker.position!=='attack'||battle.target&&!target)fail('Un Mostro del combattimento non è più disponibile.');
  const atk=effectiveBattleStat(attacker,'atk'),opponent=1-battle.player,damage=[0,0],destroy=[];
  if(atk===null)fail('ATK non disponibile: imposta il valore attuale prima del calcolo.');
  if(!target)damage[opponent]=atk;
  else{
    if(!target.faceUp)fail('Scopri il Mostro attaccato prima del calcolo.');
    const stat=target.position==='defense'?'def':'atk',value=effectiveBattleStat(target,stat);
    if(value===null)fail('ATK/DEF non disponibile: imposta il valore attuale prima del calcolo.');
    if(stat==='atk'){
      if(atk>value){damage[opponent]=atk-value;destroy.push({player:opponent,cardId:target.id});}
      else if(atk<value){damage[battle.player]=value-atk;destroy.push({player:battle.player,cardId:attacker.id});}
      else if(atk>0)destroy.push({player:battle.player,cardId:attacker.id},{player:opponent,cardId:target.id});
    }else if(atk>value)destroy.push({player:opponent,cardId:target.id});
    else if(atk<value)damage[battle.player]=value-atk;
  }
  const destroyed=destroy.map(ref=>({player:ref.player,cardName:battleMonster(state,ref.player,ref.cardId).card.cardName}));
  const publicResult={id:battle.id,turn:state.turn,player:battle.player,attackerName:attacker.cardName,targetName:target?.cardName||'Attacco diretto',damage,destroyed,canceled:false};
  publicResult.summary=`${publicResult.attackerName} → ${publicResult.targetName}: ${damage[0]+damage[1]} danni, ${destroyed.length} ${destroyed.length===1?'Mostro distrutto':'Mostri distrutti'}.`;
  return{damage,destroy,publicResult};
}
export function passBattle(state,player){
  const battle=state.battle;
  if(!battle)fail('Non ci sono combattimenti a cui rispondere.');
  if(state.chain.length)fail('Completa la catena prima di proseguire il combattimento.');
  if(battle.stage==='replay')fail('Scegli nuovamente il bersaglio o annulla l’attacco.');
  if(battle.stage==='manual')fail('Attendi la conferma o il rifiuto della risoluzione manuale.');
  if(battle.priority!==player)fail('Attendi la risposta dell’altro giocatore al combattimento.');
  if(battle.passes===0){battle.passes=1;battle.priority=1-player;return{calculate:false};}
  if(battle.stage==='response'){
    const target=battleTarget(state,battle);if(battle.target&&!target)fail('Il bersaglio non è più disponibile.');
    const revealed=Boolean(target&&!target.faceUp);
    if(target)target.faceUp=true;
    battle.stage='damage';battle.priority=battle.player;battle.passes=0;
    return{calculate:false,revealed};
  }
  return{calculate:true,plan:calculateBattle(state)};
}
export function requestManualBattle(state,player){
  const battle=state.battle;
  if(!battle||battle.stage!=='damage'||battle.priority!==player||state.chain.length)fail('Richiedi la risoluzione manuale nella tua possibilità di risposta del Damage Step, dopo aver completato la catena.');
  battle.stage='manual';battle.priority=1-player;battle.passes=0;
  return battle;
}
export function answerManualBattle(state,player,{accept=false}={}){
  const battle=state.battle;
  if(!battle||battle.stage!=='manual'||battle.priority!==player||state.chain.length)fail('La conferma della risoluzione manuale spetta all’altro giocatore.');
  if(accept)return cancelBattle(state,player,{reason:'Combattimento risolto manualmente per effetto dichiarato.',internal:true});
  battle.stage='damage';battle.priority=battle.player;battle.passes=0;
  return battle;
}
export function battleActivationError(state,player){
  const battle=state.battle;if(!battle)return null;
  if(battle.stage==='manual')return 'Attendi la conferma o il rifiuto della risoluzione manuale prima di attivare una carta.';
  if(state.chain.length)return null;
  if(battle.stage==='replay')return 'Scegli nuovamente il bersaglio prima di aprire una nuova catena.';
  return battle.priority===player?null:'Attendi la tua possibilità di risposta al combattimento.';
}
export function battleFieldFingerprint(state,player){return battleMonsters(state,player).map(({card,zone})=>`${zone}:${card.slot}:${card.id}`).sort().join('|');}
export function maintainBattle(previous,next){
  const battle=next.battle;if(!battle)return;
  if(next.result){next.battle=null;return;}
  const attacker=battleMonster(next,battle.player,battle.attackerId)?.card;
  if(!attacker||!attacker.faceUp||attacker.position!=='attack'){cancelBattle(next,battle.player,{reason:'Attacco interrotto: il Mostro attaccante non è più disponibile.',internal:true});return;}
  if(previous.battle?.id!==battle.id)return;
  const opponent=1-battle.player;
  if(['damage','manual'].includes(previous.battle.stage)){
    const before=battleTarget(previous,previous.battle),after=battleTarget(next,battle);
    if(battle.target&&(!after||!after.faceUp||after.id!==before?.id)){cancelBattle(next,battle.player,{reason:'Combattimento interrotto durante il Damage Step.',internal:true});}
    return;
  }
  if(battleFieldFingerprint(previous,opponent)!==battleFieldFingerprint(next,opponent)){battle.stage='replay';battle.priority=battle.player;battle.passes=0;}
}
export function validateBattleState(state){
  const battle=state.battle;
  if(battle!==undefined&&battle!==null){
    if(Object.keys(battle).length!==7||Object.keys(battle).some(key=>!['id','player','attackerId','target','stage','priority','passes'].includes(key)))return false;
    if(!uuid(battle.id)||!playerIndex(battle.player)||battle.player!==state.activePlayer||!text(battle.attackerId,100)||!battle.attackerId||battle.target!==null&&!coordinate(battle.target)||!['response','damage','replay','manual'].includes(battle.stage)||!playerIndex(battle.priority)||!integer(battle.passes,0,1)||!state.turnState||state.phase!=='battle'||state.turn===1)return false;
    const attacker=battleMonster(state,battle.player,battle.attackerId)?.card;
    if(!attacker?.faceUp||attacker.position!=='attack'||attacker.attackedTurn!==state.turn)return false;
    if(battle.stage==='replay'&&(battle.priority!==battle.player||battle.passes!==0))return false;
    if(battle.stage==='manual'&&(battle.passes!==0||state.chain.length))return false;
  }
  const last=state.lastBattle;
  if(last!==undefined&&last!==null){
    if(Object.keys(last).some(key=>!['id','turn','player','attackerName','targetName','damage','destroyed','canceled','summary'].includes(key)))return false;
    if(!uuid(last.id)||!integer(last.turn,1,state.turn)||!playerIndex(last.player)||!text(last.attackerName,300)||!text(last.targetName,300)||!text(last.summary,1200)||typeof last.canceled!=='boolean'||!Array.isArray(last.damage)||last.damage.length!==2||last.damage.some(value=>!Number.isFinite(value)||value<0||value>2000000)||!Array.isArray(last.destroyed)||last.destroyed.length>2||last.destroyed.some(item=>!playerIndex(item.player)||!text(item.cardName,300)))return false;
  }
  return true;
}
