import { createSession, applyAction } from './simulator-engine.js';

const clone=value=>JSON.parse(JSON.stringify(value));
const covered=(player,zone,index,card={})=>({id:`hidden-${player}-${zone}-${index}`,hidden:true,cardName:'Carta coperta',catalogCardId:'',imageUrl:'',faceUp:false,position:card.position||'attack',slot:card.slot??null,counters:card.counters||0,materials:clone(card.materials||[])});

// An ephemeral solo table. It never writes multiplayer state, invitations or
// statistics. The second field is a passive mirror, not a computer opponent.
export function createPracticeTable({deck,name='Il tuo test'}) {
  const source=clone(deck);
  let state,version;
  const id=crypto.randomUUID();
  function restart(){
    state=createSession({decks:[source,source],names:[name,'Campo di prova'],firstPlayer:0});state.id=id;
    state=applyAction(state,{type:'start'});
    state=applyAction(state,{type:'nextPhase',player:0});
    state=applyAction(state,{type:'nextPhase',player:0});
    version=(version||0)+1;
  }
  function projection(){
    const visible=clone(state);
    for(const[player,p]of visible.players.entries()){
      p.deck=p.deck.map((card,index)=>covered(player,'deck',index));
      if(player===0)continue;
      p.hand=p.hand.map((card,index)=>covered(player,'hand',index));
      p.extra=p.extra.map((card,index)=>card.faceUp?card:covered(player,'extra',index));
      p.side=p.side.map((card,index)=>covered(player,'side',index));
      for(const zone of ['monsters','spells','field','extraMonsters','banished'])p[zone]=p[zone].map((card,index)=>card.faceUp?card:covered(player,zone,index,card));
      p.deckId='';
    }
    return{id,status:state.result?'finished':'playing',version,viewer:0,ready:[true,true],state:visible,practice:true};
  }
  restart();
  return{
    snapshot:projection,
    restart(){restart();return{duel:projection()};},
    run(payload){
      if(payload.duelId&&payload.duelId!==id)throw new Error('Il test non è più disponibile.');
      if(payload.op==='state')return payload.knownVersion===version?{unchanged:true,version,duelId:id}:{duel:projection()};
      if(payload.op==='inspect'){
        if(payload.zone!=='deck'||payload.player!==undefined&&payload.player!==0)throw new Error('Puoi consultare soltanto il tuo mazzo.');
        return{duel:projection(),version,cards:clone(state.players[0].deck),zone:'deck'};
      }
      if(payload.op!=='action')throw new Error('Operazione non disponibile nel test in solitaria.');
      if(payload.expectedVersion!==version)throw new Error('Il test è cambiato. Riprova.');
      const action={...payload.action,player:payload.action?.player??0};
      if(action.player!==0||['start','finish','ready'].includes(action.type))throw new Error('Nel test controlli soltanto il tuo campo.');
      for(const key of ['cardId','targetId'])if(typeof action[key]==='string'&&action[key].startsWith('hidden-')){
        const found=action[key].match(/^hidden-0-deck-(\d+)$/);
        if(!found||!state.players[0].deck[Number(found[1])])throw new Error('Carta coperta non disponibile.');
        action[key]=state.players[0].deck[Number(found[1])].id;
      }
      let next=applyAction(state,action);
      if(next.activePlayer===1)next=applyAction(next,{type:'nextTurn',player:1});
      state=next;version++;return{duel:projection()};
    }
  };
}
