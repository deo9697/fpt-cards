// Manual chains preserve response priority and resolve last-in, first-out.
// Card effects and activation costs are checked/applied by the duel engine.
const isPlayer=value=>value===0||value===1;
const fail=message=>{throw new Error(message);};

export function deriveChainState(session){
  if(!Array.isArray(session?.chain))fail('Catena non valida.');
  if(!session.chain.length)return{stage:'idle',priority:null,passes:0};
  const saved=session.chainState;
  if(saved==null){
    const last=session.chain.at(-1);
    if(!isPlayer(last?.player))fail('Giocatore della catena non valido.');
    return{stage:'building',priority:1-last.player,passes:0};
  }
  if(saved.stage==='building'&&isPlayer(saved.priority)&&(saved.passes===0||saved.passes===1))return{stage:'building',priority:saved.priority,passes:saved.passes};
  if(saved.stage==='resolving'&&saved.priority===null&&saved.passes===2)return{stage:'resolving',priority:null,passes:2};
  fail('Stato della catena non valido.');
}

export function appendChain(session,player,card){
  if(!isPlayer(player))fail('Giocatore non valido.');
  const state=deriveChainState(session);
  if(state.stage==='resolving')fail('La catena si sta risolvendo: non puoi aggiungere attivazioni.');
  if(state.stage==='building'&&state.priority!==player)fail('Attendi la risposta dell’altro giocatore.');
  if(session.chain.length>=50)fail('La catena ha raggiunto il numero massimo di anelli.');
  if(typeof card?.id!=='string'||!card.id||card.id.length>100||typeof card.cardName!=='string'||!card.cardName||card.cardName.length>300)fail('Carta della catena non valida.');
  const link={number:session.chain.length+1,player,cardId:card.id,cardName:card.cardName,imageUrl:typeof card.imageUrl==='string'?card.imageUrl.slice(0,2000):''};
  session.chain.push(link);
  session.chainState={stage:'building',priority:1-player,passes:0};
  return link;
}

export function passChain(session,player){
  if(!isPlayer(player))fail('Giocatore non valido.');
  const state=deriveChainState(session);
  if(state.stage==='idle')fail('Non ci sono attivazioni a cui rispondere.');
  if(state.stage==='resolving')fail('La catena è già in risoluzione.');
  if(state.priority!==player)fail('Attendi la risposta dell’altro giocatore.');
  session.chainState=state.passes===1?{stage:'resolving',priority:null,passes:2}:{stage:'building',priority:1-player,passes:1};
  return{...session.chainState};
}

export function resolveChain(session,player){
  if(!isPlayer(player))fail('Giocatore non valido.');
  const state=deriveChainState(session);
  if(state.stage==='idle')fail('Non ci sono anelli di catena da risolvere.');
  if(state.stage!=='resolving')fail('Entrambi i giocatori devono scegliere “Non rispondo” prima di risolvere la catena.');
  const link=session.chain.pop();
  if(!session.chain.length)session.chainState=null;
  return{...link,number:link.number??session.chain.length+1};
}
