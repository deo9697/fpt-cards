// SPDX-License-Identifier: AGPL-3.0-or-later
import {randomUUID} from 'node:crypto';
import {DuelError} from './_yugioh-duel-service.js';
import {runAutoOperation,projectAutoStateSafe} from './_yugioh-auto-executor.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(status,code,message,duel)=>{throw new DuelError(status,code,message,duel);};
const needId=value=>{if(typeof value!=='string'||!UUID.test(value))fail(400,'invalid_id','Identificativo della prova non valido.');return value;};

// One current personal table per member/team. It never creates a PvP invitation,
// touches another member's deck, sends push, or records a match statistic.
export function createPracticeService({store,practices,autoRuntime={run:runAutoOperation,project:projectAutoStateSafe},now=()=>new Date()}){
  const at=()=>now().toISOString();
  function view(row){
    const state=autoRuntime.project(row.state,0);
    return{id:row.id,practice:true,mode:'auto',viewer:0,status:row.state.result?'finished':row.status,version:row.version,ready:[true,true],firstPlayer:0,createdAt:row.created_at,updatedAt:row.updated_at,expiresAt:row.expires_at,hostDeckName:state.players[0].deckName,guestDeckName:'Campo di prova',result:state.result,state};
  }
  function owned(row,actor){if(row&&(row.team_id!==actor.teamId||row.owner_slug!==actor.slug))fail(404,'practice_not_found','Prova non disponibile.');return row;}
  function checkExpiry(row){if(!row.state.result&&new Date(row.expires_at)<=now())fail(410,'practice_expired','La prova è scaduta. Avvia un nuovo test del mazzo.');}
  async function automatic(operation,payload){
    try{return await autoRuntime.run(operation,payload);}
    catch(error){fail(Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:503,error.code||'practice_engine',error.message||'Il motore della prova non è disponibile. La sessione è conservata.');}
  }
  async function save(row,patch,actor,requestId){
    const write={...patch,version:row.version+1,last_action_id:requestId,updated_at:at()};
    const saved=await practices.update(row.id,row.version,actor.teamId,actor.slug,write);
    if(saved){
      // The database acknowledges only CAS metadata. The trigger verifies
      // membership/version and adjusts updated_at; it does not rewrite state.
      if(saved.id!==(write.id||row.id)||saved.version!==write.version||typeof saved.updated_at!=='string')fail(503,'practice_ack','La prova è stata salvata. Ricarica il campo per continuare.');
      return{duel:view({...row,...write,id:saved.id,version:saved.version,updated_at:saved.updated_at})};
    }
    const current=owned(await practices.get(actor.teamId,actor.slug),actor);
    if(current&&(current.last_action_id===requestId||current.start_request_id===requestId))return{duel:view(current),replayed:true};
    fail(409,'stale_version','La prova è stata aggiornata in un’altra finestra. Controlla il campo e riprova.',current?view(current):undefined);
  }
  return{async run(actor,payload){
    if(!actor?.slug||!UUID.test(actor.teamId||''))fail(401,'unauthorized','Accedi con il tuo profilo del team.');
    if(!payload||typeof payload!=='object'||Array.isArray(payload))fail(400,'invalid_request','Richiesta non valida.');
    if(!['practiceStart','practiceState','practiceAction','practiceSearch'].includes(payload.op))fail(400,'invalid_operation','Operazione non disponibile nella prova.');
    // Both reads use the authenticated scope. Still check current membership on
    // every request, before handling state or a read error from the private row.
    // practiceStart: il mazzo (del solo actor.slug) si legge in parallelo, ma si
    // usa solo dopo i controlli di appartenenza qui sotto.
    const deckRead=payload.op==='practiceStart'&&UUID.test(payload.deckId||'')?Promise.resolve().then(()=>store.deck(payload.deckId,actor.slug,{mode:'auto'})):null;
    deckRead?.catch(()=>{});
    const [membership,current]=await Promise.allSettled([store.members(actor.teamId),practices?practices.get(actor.teamId,actor.slug):Promise.resolve(null)]);
    if(membership.status==='rejected')throw membership.reason;
    const member=membership.value.find(member=>member.slug===actor.slug);
    if(!member)fail(403,'not_member','Il tuo profilo non appartiene al team.');
    if(!practices)fail(503,'practice_not_configured','La prova automatica non è ancora configurata.');
    if(current.status==='rejected')throw current.reason;
    const row=owned(current.value,actor);
    if(payload.op==='practiceStart'){
      const requestId=needId(payload.requestId);
      if(row?.start_request_ids?.includes(requestId)||row?.start_request_id===requestId||row?.last_action_id===requestId)return{duel:view(row),replayed:true};
      const deckId=needId(payload.deckId),deck=await (deckRead||store.deck(deckId,actor.slug,{mode:'auto'}));
      if(!deck||deck.ownerSlug!==actor.slug||deck.game!=='yugioh')fail(404,'deck_not_found','Scegli un tuo mazzo Yu-Gi-Oh! salvato.');
      const state=await automatic('createPractice',{decks:[deck,deck],names:[member.name,'Campo di prova'],firstPlayer:0,lp:[8000,8000]});
      const id=randomUUID();state.id=id;
      const fresh={id,team_id:actor.teamId,owner_slug:actor.slug,status:state.result?'finished':'playing',state,start_request_id:requestId,start_request_ids:[...(row?.start_request_ids||[]),requestId].slice(-16),last_action_id:requestId,created_at:at(),updated_at:at(),expires_at:new Date(now().getTime()+86400000).toISOString()};
      if(row)return save(row,fresh,actor,requestId);
      const saved=await practices.insert({...fresh,version:1});
      if(saved)return{duel:view(saved)};
      const current=owned(await practices.get(actor.teamId,actor.slug),actor);
      if(current?.start_request_id===requestId)return{duel:view(current),replayed:true};
      fail(409,'practice_conflict','Hai già avviato una prova in un’altra finestra.',current?view(current):undefined);
    }
    if(!row){if(payload.op==='practiceState'&&!payload.duelId)return{duel:null};fail(404,'practice_not_found','Nessuna prova disponibile. Scegli un mazzo e avvia il test.');}
    if(payload.duelId!==undefined&&needId(payload.duelId)!==row.id)fail(409,'practice_replaced','È stata avviata una nuova prova in un’altra finestra.',view(row));
    checkExpiry(row);
    if(payload.op==='practiceState'){
      if(payload.knownVersion!==undefined&&(!Number.isSafeInteger(payload.knownVersion)||payload.knownVersion<1))fail(400,'invalid_version','Versione della prova non valida.');
      return payload.knownVersion===row.version?{unchanged:true,duelId:row.id,version:row.version}:{duel:view(row)};
    }
    if(payload.op==='practiceSearch'){
      if(row.state.result)fail(409,'duel_finished','La prova è conclusa.',view(row));
      if(typeof payload.promptId!=='string'||payload.promptId.length>160||typeof payload.query!=='string'||payload.query.length>100)fail(400,'invalid_search','Ricerca non valida.');
      const cards=await automatic('search',{state:row.state,viewer:0,promptId:payload.promptId,query:payload.query});
      return{duelId:row.id,version:row.version,promptId:payload.promptId,cards:cards.slice(0,30)};
    }
    const requestId=needId(payload.requestId);
    if(row.last_action_id===requestId)return{duel:view(row),replayed:true};
    if(payload.expectedVersion!==row.version)fail(409,'stale_version','La prova è stata aggiornata. Controlla il campo e riprova.',view(row));
    if(row.state.result)fail(409,'duel_finished','La prova è conclusa. Puoi ricominciare il test.',view(row));
    const action=payload.action;
    if(!action||typeof action!=='object'||Array.isArray(action)||action.player!==undefined&&action.player!==0)fail(400,'invalid_action','Nella prova controlli soltanto il tuo campo.');
    let state;
    if(action.type==='surrender'){
      state=structuredClone(row.state);state.result={winner:1,notes:'Prova interrotta.',at:at()};
      for(const visible of state.publicViews){visible.status='finished';visible.result=state.result;visible.auto.prompt=null;visible.auto.waitingFor=null;visible.auto.waitingPlayer=null;visible.auto.actor=null;}
    }else if(action.type==='autoRespond'){
      if(typeof action.promptId!=='string'||action.promptId.length>160||!action.choice||typeof action.choice!=='object'||Array.isArray(action.choice))fail(400,'invalid_choice','Scelta non valida.');
      state=await automatic('apply',{state:row.state,viewer:0,promptId:action.promptId,choice:action.choice});
    }else fail(400,'auto_action_only','Scegli una delle azioni richieste dal motore automatico.');
    if(Buffer.byteLength(JSON.stringify(state))>3900000)fail(422,'practice_limit','La prova ha raggiunto il limite di azioni. Avvia un nuovo test.');
    return save(row,{state,status:state.result?'finished':'playing'},actor,requestId);
  }};
}
