// Standard Synchro/Xyz material checks. Card-specific names, Types and alternate
// procedures still require the players to verify the printed requirements.
const typeOf=card=>String(card?.type||card?.cardType||'').toLowerCase();
const positive=value=>value!==null&&value!==undefined&&value!==''&&Number.isInteger(Number(value))&&Number(value)>0&&Number(value)<=1000000?Number(value):null;
const fail=message=>{throw new Error(message);};
const monster=card=>Boolean(card?.token)||/monster|mostro/.test(typeOf(card));
const tuner=card=>card?.isTuner===true||card?.tuner===true||/\btuner\b/.test(typeOf(card))&&!/non[- ]tuner/.test(typeOf(card));
const firstLine=card=>String(card?.text||card?.desc||card?.effect||'').trim().split(/\r?\n/)[0].replace(/[\u2010-\u2015]/g,'-').trim();

export function getSummonKind(card){
  const type=typeOf(card);
  return /synchro/.test(type)?'synchro':/xyz/.test(type)?'xyz':null;
}

export function materialLevel(card){
  if(!monster(card)||/xyz|link/.test(typeOf(card)))return null;
  return positive(card.level);
}

export function getSummonRecipe(card){
  const kind=getSummonKind(card),recipeText=firstLine(card);
  if(!kind)return null;
  if(kind==='xyz'){
    const englishCount=recipeText.match(/^(\d+)(\+|\s+or\s+more|\s+o\s+pi[uù])?\s+(?:Level|Livello)\s*(\d+)\b/i);
    const italianCount=recipeText.match(/^(\d+)(\+|\s+o\s+pi[uù])?\s+mostr[oi]\b/i),italianLevel=recipeText.match(/\bLivello\s*(\d+)\b/i);
    const count=englishCount||(italianCount&&italianLevel?[italianCount[0],italianCount[1],italianCount[2],italianLevel[1]]:null);
    const generic=/^\d+(?:\+|\s+or\s+more|\s+o\s+pi[uù])?\s+(?:Level|Livello)\s*\d+\s+(?:monsters?|mostri)\.?$/i.test(recipeText)||/^\d+(?:\+|\s+o\s+pi[uù])?\s+mostr[oi]\s+(?:di\s+)?Livello\s*\d+\.?$/i.test(recipeText);
    const targetRank=positive(card.rank)??positive(card.level),requiredLevel=count?positive(count[3]):targetRank;
    return{kind,recipeText,targetRank,requiredLevel,minMaterials:count?Number(count[1]):2,maxMaterials:count&&!count[2]?Number(count[1]):null,
      requiresManualConfirmation:!generic||requiredLevel!==targetRank,
      description:`Mostri scoperti di Livello ${requiredLevel??'?'}${count?` · ${count[1]}${count[2]?'+':''} materiali`:' · almeno 2 materiali'}`};
  }
  const quantity='(\\d+)(\\+|\\s+or\\s+more|\\s+o\\s+pi[uù])?';
  const tunerWords='(?:Tuners?(?:\\s+monsters?)?|mostr[oi]\\s+Tuner)';
  const nonTunerWords='(?:non[- ]Tuners?(?:\\s+monsters?)?|mostr[oi]\\s+non[- ]Tuner)';
  const generic=new RegExp(`^${quantity}\\s+${tunerWords}\\s*\\+\\s*${quantity}\\s+${nonTunerWords}\\.?$`,'i').exec(recipeText);
  const tunerCount=new RegExp(`^${quantity}\\s+${tunerWords}\\b`,'i').exec(recipeText);
  const nonTunerCount=new RegExp(`${quantity}\\s+${nonTunerWords}\\b`,'i').exec(recipeText);
  const targetLevel=positive(card.level);
  return{kind,recipeText,targetLevel,minTuners:tunerCount?Number(tunerCount[1]):1,maxTuners:tunerCount&&tunerCount[2]?null:tunerCount?Number(tunerCount[1]):1,
    minNonTuners:nonTunerCount?Number(nonTunerCount[1]):1,maxNonTuners:nonTunerCount&&!nonTunerCount[2]?Number(nonTunerCount[1]):null,
    requiresManualConfirmation:!generic,
    description:`Tuner e non-Tuner scoperti · somma dei Livelli ${targetLevel??'?'}`};
}

export function eligibleSummonMaterials(state,player,target){
  const kind=getSummonKind(target),own=state?.players?.[player];
  if(!kind||!own)return[];
  const recipe=getSummonRecipe(target);
  return[...(own.monsters||[]),...(own.extraMonsters||[])].filter(card=>card.faceUp===true&&materialLevel(card)!==null&&(kind!=='xyz'||!card.token&&materialLevel(card)===recipe.requiredLevel));
}

export function validateSummonMaterials(target,materials,{confirmRequirements=false}={}){
  const recipe=getSummonRecipe(target);
  if(!recipe)fail('Questa procedura gestisce soltanto Synchro e Xyz.');
  if(!Array.isArray(materials)||materials.length<2||materials.length>7||new Set(materials.map(card=>card?.id)).size!==materials.length)fail('Scegli materiali distinti dal tuo terreno.');
  if(materials.some(card=>!card||card.faceUp!==true||!monster(card)))fail('I materiali devono essere tuoi Mostri scoperti sul terreno.');
  if(materials.some(card=>materialLevel(card)===null))fail('Livello dei materiali non disponibile: usa Mostri con Livello noto, diversi da Xyz e Link.');
  if(recipe.kind==='xyz'){
    if(!recipe.targetRank||!recipe.requiredLevel)fail('Rango del Mostro Xyz non disponibile. Ricarica il mazzo per verificarlo.');
    if(materials.some(card=>card.token))fail('I Segna-Mostro non possono diventare materiali Xyz.');
    if(materials.length<Math.max(2,recipe.minMaterials)||recipe.maxMaterials!==null&&materials.length!==recipe.maxMaterials)fail(`Seleziona ${recipe.maxMaterials??`almeno ${Math.max(2,recipe.minMaterials)}`} materiali Xyz richiesti dalla carta.`);
    if(materials.some(card=>materialLevel(card)!==recipe.requiredLevel))fail(`I materiali Xyz devono avere tutti Livello ${recipe.requiredLevel}.`);
  }else{
    if(!recipe.targetLevel)fail('Livello del Mostro Synchro non disponibile. Ricarica il mazzo per verificarlo.');
    const tuners=materials.filter(tuner).length,nonTuners=materials.length-tuners;
    if(tuners<recipe.minTuners||recipe.maxTuners!==null&&tuners>recipe.maxTuners)fail(`Seleziona ${recipe.maxTuners===recipe.minTuners?recipe.minTuners:`almeno ${recipe.minTuners}`} Tuner richiesti dalla carta.`);
    if(nonTuners<recipe.minNonTuners||recipe.maxNonTuners!==null&&nonTuners>recipe.maxNonTuners)fail('Seleziona i Mostri non-Tuner richiesti dalla carta.');
    if(materials.reduce((sum,card)=>sum+materialLevel(card),0)!==recipe.targetLevel)fail(`La somma dei Livelli deve essere ${recipe.targetLevel}.`);
  }
  if(recipe.requiresManualConfirmation&&confirmRequirements!==true)fail('Conferma di aver verificato anche i requisiti specifici scritti sulla carta.');
  return recipe;
}

export function summonPlan(state,{player=state?.activePlayer,cardId,materialIds,to='monsters',slot,position='attack',confirmRequirements=false}={}){
  if(!state?.players?.[player]||![0,1].includes(player))fail('Giocatore non valido.');
  if(state.result||state.phase==='setup')fail('Il duello non è disponibile per questa evocazione.');
  if(state.activePlayer!==player||!['main1','main2'].includes(state.phase))fail('Evoca Synchro o Xyz durante la tua Main Phase.');
  if(state.chain?.length)fail('Termina la catena prima di effettuare questa evocazione.');
  if(!['monsters','extraMonsters'].includes(to)||!['attack','defense'].includes(position))fail('Scegli una zona Mostri e una posizione valide.');
  const own=state.players[player],card=own.extra.find(card=>card.id===cardId),kind=getSummonKind(card);
  if(!card||!kind)fail('Scegli un tuo Mostro Synchro o Xyz nell’Extra Deck.');
  if(!Array.isArray(materialIds)||materialIds.length<2||materialIds.length>7||materialIds.some(id=>typeof id!=='string'||!id)||new Set(materialIds).size!==materialIds.length)fail('Scegli materiali distinti dal tuo terreno.');
  const materials=materialIds.map(id=>{
    for(const zone of['monsters','extraMonsters']){const index=own[zone].findIndex(card=>card.id===id);if(index!==-1)return{card:own[zone][index],zone,index};}
    fail('Un materiale selezionato non è più sul tuo terreno.');
  });
  const recipe=validateSummonMaterials(card,materials.map(material=>material.card),{confirmRequirements});
  const size=to==='extraMonsters'?2:5,occupied=own[to].filter(card=>!materialIds.includes(card.id)).map(card=>card.slot);
  if(to==='extraMonsters')occupied.push(...state.players[1-player].extraMonsters.map(card=>card.slot));
  const destination=slot??Array.from({length:size},(_,index)=>index).find(index=>!occupied.includes(index));
  if(!Number.isInteger(destination)||destination<0||destination>=size||occupied.includes(destination))fail('La posizione scelta è occupata o non disponibile.');
  return{kind,card,materials,player,to,slot:destination,position,recipe};
}
