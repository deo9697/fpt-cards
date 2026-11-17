// Present only the public activation snapshot. An old link without artwork may
// use its exact visible source card; hidden opponent cards are never inspected.
export function publicChainCard(session,link,viewer,index=0){
  let imageUrl=link.imageUrl||'';
  if(!imageUrl){
    const own=link.player===viewer,player=session?.players?.[link.player];
    for(const zone of ['monsters','extraMonsters','spells','field','graveyard','banished','extra','hand']){
      if(!own&&zone==='hand')continue;
      const card=player?.[zone]?.find(card=>card.id===link.cardId&&!card.hidden&&(own||zone==='graveyard'||card.faceUp===true));
      if(card?.imageUrl){imageUrl=card.imageUrl;break;}
    }
  }
  return{activationId:link.activationId||'',number:Number.isInteger(link.number)?link.number:index+1,player:link.player,cardId:link.cardId,cardName:link.cardName,imageUrl};
}

export function createActivationReveals({onHide=()=>{},environment=globalThis,durationMs=2000}={}){
  const setTimer=(environment.setTimeout||globalThis.setTimeout).bind(environment),clearTimer=(environment.clearTimeout||globalThis.clearTimeout).bind(environment);
  let duelId=null,version=-1,previous=[],current=null,timer=null,generation=0,disposed=false;
  const key=(link,index)=>link.activationId||`${index+1}:${link.player}:${link.cardId}`;
  function hide(){
    generation++;if(timer!==null)clearTimer(timer);timer=null;
    const old=current;current=null;if(old)onHide(old.key);
  }
  function clear(){hide();duelId=null;version=-1;previous=[];}
  function observe(duel){
    if(disposed||!duel?.id)return false;
    const chain=duel.state?.chain||[],activation=duel.state?.mode==='auto'?duel.state.auto?.lastActivation:null;
    const links=activation&&!chain.some(link=>link.activationId===activation.activationId)?[...chain,activation]:chain,keys=links.map(key);
    if(duelId!==duel.id){clear();duelId=duel.id;version=duel.version;previous=keys;return false;}
    if(duel.version<=version)return false;
    version=duel.version;
    const fresh=keys.map((value,index)=>({value,index})).filter(item=>!previous.includes(item.value));previous=keys;
    if(current&&!keys.includes(current.key))hide();
    if(!fresh.length)return false;
    const latest=fresh.at(-1),link=links[latest.index];hide();
    current={...publicChainCard(duel.state,link,duel.viewer,latest.index),key:latest.value,duelId};
    const ticket=generation;timer=setTimer(()=>{if(!disposed&&ticket===generation)hide();},durationMs);
    return true;
  }
  return{observe,get:()=>current?{...current}:null,clear,dispose(){clear();disposed=true;}};
}
