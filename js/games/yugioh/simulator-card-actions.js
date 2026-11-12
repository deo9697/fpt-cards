import {canMoveCardToZone,isMonster,isExtraDeckMonster} from './simulator-engine.js';

const board=['monsters','spells','field','extraMonsters'];
const typeOf=card=>String(card?.type||card?.cardType||'').toLowerCase();
const unknownType=card=>!/monster|mostro|token|spell|magia|trap|trappola/.test(typeOf(card));
export function cardDropActions(card,from,to,{samePosition=false}={}){
  if(!canMoveCardToZone(card,to))return[];
  const type=typeOf(card),link=type.includes('link'),monster=isMonster(card),unknown=unknownType(card);
  const actions=[];
  const add=(id,label,changes={})=>actions.push({id,label,changes});
  if(to==='monsters'||to==='extraMonsters'){
    if(board.includes(from)||card.token){
      if(samePosition){
        if(card.faceUp){
          add('activate','Activate',{activateOnly:true});
          if(!link){
            const position=card.position==='defense'?'attack':'defense';
            add('position',position==='attack'?'Posizione Attacco':'Posizione Difesa',{positionOnly:true,position,faceUp:true});
            if(!card.token)add('set','Set',{positionOnly:true,position:'defense',faceUp:false});
          }
        }else if(!link){
          add('flip-attack','Scopri in Attacco',{positionOnly:true,position:'attack',faceUp:true});
          add('flip-defense','Scopri in Difesa',{positionOnly:true,position:'defense',faceUp:true});
        }
      }else{
        add('move','Sposta qui',{position:card.position||'attack',faceUp:card.faceUp});
        if(!link&&!card.token)add('set','Set',{position:'defense',faceUp:false,intent:'set'});
      }
    }else{
      if(from==='hand'&&to==='monsters'&&!isExtraDeckMonster(card)&&!/ritual/.test(type))add('normal','Norm. Summon',{position:'attack',faceUp:true,intent:'normal'});
      add('special','Sp. Summon',{position:'attack',faceUp:true,intent:'special'});
      if(from==='hand'&&to==='monsters'&&!link&&!isExtraDeckMonster(card)&&!/ritual/.test(type))add('set','Set',{position:'defense',faceUp:false,intent:'set'});
    }
  }else if(to==='spells'||to==='field'){
    if(!monster||unknown)add('activate','Activate',samePosition?{activateOnly:true}:{position:'attack',faceUp:true,intent:'activate',activateAfter:true});
    add('set','Set',{position:'attack',faceUp:false,intent:'set'});
    if(board.includes(from)||monster)add('move',monster?'Posiziona / equipaggia':'Sposta qui',{position:'attack',faceUp:card.faceUp!==false});
  }else{
    const label={graveyard:card.token?'Rimuovi Segna-Mostro':'Manda al Cimitero',banished:'Bandisci',hand:'Riprendi in mano',deck:'Metti in cima al mazzo',extra:'Rimetti nell’Extra Deck'}[to];
    if(!label)return[];
    add('move',label,{faceUp:!['hand','deck','extra'].includes(to),placement:'top'});
    if(to==='deck')add('bottom','Metti in fondo al mazzo',{faceUp:false,placement:'bottom'});
    if(to==='banished'&&!card.token)add('banish-set','Bandisci coperta',{faceUp:false});
  }
  return actions;
}

// A short tap proposes the play first; choosing a placement action lets the
// controller ask for a destination without opening the large details dialog.
export function cardTapActions(card,from){
  if(!card||from==='side')return[];
  const type=typeOf(card),monster=isMonster(card),unknown=unknownType(card),link=type.includes('link');
  const actions=[];
  const add=(id,label,changes={},destination={})=>actions.push({id,label,changes,...destination});
  const destinations=()=>['monsters','extraMonsters'].filter(zone=>canMoveCardToZone(card,zone));
  const summons=(hand=false)=>{
    const zones=destinations();if(!zones.length)return;
    for(const choice of cardDropActions(card,hand?'hand':from,'monsters')){
      if(!['normal','special','set'].includes(choice.id))continue;
      if((choice.id==='normal'||choice.id==='set')&&(!hand||isExtraDeckMonster(card)||/ritual/.test(type)))continue;
      const targets=['normal','set'].includes(choice.id)?['monsters']:zones;
      add(choice.id,choice.label,choice.changes,{to:'monsters',zones:targets});
    }
  };
  if(from==='hand'){
    if(monster||unknown)summons(true);
    if(monster||unknown)add('activate','Activate',{activateOnly:true});
    if(!monster&&!unknown){
      const to=canMoveCardToZone(card,'field')?'field':'spells';
      for(const choice of cardDropActions(card,'hand',to)){
        if(!['activate','set'].includes(choice.id))continue;
        add(choice.id,choice.label,choice.changes,{to,zones:[to]});
      }
    }
  }else if(board.includes(from)){
    const monsterZone=['monsters','extraMonsters'].includes(from);
    if(!monsterZone||card.faceUp)add('activate','Activate',{activateOnly:true});
    if(monsterZone&&!link){
      if(card.faceUp){
        const position=card.position==='defense'?'attack':'defense';
        add('position',position==='attack'?'Posizione Attacco':'Posizione Difesa',{positionOnly:true,position,faceUp:true});
      }else{
        add('flip-attack','Scopri in Attacco',{positionOnly:true,position:'attack',faceUp:true});
        add('flip-defense','Scopri in Difesa',{positionOnly:true,position:'defense',faceUp:true});
      }
    }else if(!monsterZone&&card.faceUp)add('set','Set',{positionOnly:true,position:'attack',faceUp:false});
    add('graveyard',card.token?'Rimuovi Segna-Mostro':'Manda al Cimitero',{faceUp:true},{to:'graveyard'});
  }else if(['graveyard','banished','extra','deck'].includes(from)){
    if(monster||unknown)summons();
    if(from!=='deck')add('activate','Activate effetto',{activateOnly:true});
  }
  return actions;
}
