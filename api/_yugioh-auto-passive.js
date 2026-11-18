// SPDX-License-Identifier: AGPL-3.0-or-later
import {normalizePrompt,resolveChoice,searchPromptCards} from './_yugioh-auto-prompts.js';

// Versioned training behaviour, not an opponent AI. Optional effects are
// declined; compulsory decisions and ended turns stay real validated inputs.
export const PASSIVE_POLICY_VERSION='passive-v1';
const MAX_SEARCH=250000;
function failure(){throw Object.assign(new Error('Il campo passivo non può completare questa scelta. La mossa non è stata salvata.'),{status:503,code:'passive_choice_unavailable'});}
const values=amount=>{const low=amount&0xffff,high=amount>>16;return high>0&&high!==low?[low,high]:[low];};
const bounds=amount=>{const first=amount&0xffff,second=amount>>16;return{low:second&&second<first?second:first,high:Math.max(first,second)};};
function sumChoice(message,prompt,context){
  const options=prompt.options,mandatory=message.selects_must||[],atLeast=!!message.select_max;
  let work=0;const tick=()=>{if(++work>MAX_SEARCH)failure();};
  let totals=new Set([0]);
  if(!atLeast)for(const card of mandatory){const next=new Set();for(const sum of totals)for(const value of values(card.amount)){tick();if(sum+value<=message.amount)next.add(sum+value);}totals=next;}
  const mandatoryLow=mandatory.reduce((sum,card)=>sum+bounds(card.amount).low,0);
  const mandatoryHigh=mandatory.reduce((sum,card)=>sum+bounds(card.amount).high,0);
  const mandatoryMin=mandatory.length?Math.min(...mandatory.map(card=>bounds(card.amount).low)):0x7fffffff;
  const walk=(start,left,ids,sums,low,high,minimum)=>{
    tick();
    if(!left){
      if(!(atLeast?high>=message.amount&&low-minimum<message.amount:sums.has(message.amount)))return null;
      // The core's exact-sum order/zero semantics are stricter than an ordinary
      // subset sum. Reject a candidate and keep searching other legal subsets.
      try{resolveChoice(message,{optionIds:ids},context);return ids;}catch{return null;}
    }
    if(options.length-start<left)return null;
    for(let index=start;index<=options.length-left;index++){
      const contributions=values(message.selects[index].amount);
      let next=sums;
      if(!atLeast){next=new Set();for(const sum of sums)for(const value of contributions){tick();if(sum+value<=message.amount)next.add(sum+value);}if(!next.size)continue;}
      const current=bounds(message.selects[index].amount),found=walk(index+1,left-1,[...ids,options[index].id],next,low+current.low,high+current.high,Math.min(minimum,current.low));
      if(found)return found;
    }
    return null;
  };
  for(let count=prompt.min;count<=Math.min(prompt.max,options.length);count++){const ids=walk(0,count,[],totals,mandatoryLow,mandatoryHigh,mandatoryMin);if(ids)return{optionIds:ids};}
  failure();
}
export function choosePassiveChoice(message,context={}){
  if(message?.player!==1)failure();
  const prompt=normalizePrompt(message,context);let choice;
  switch(prompt.kind){
    case'idle':case'battle':{
      const option=['to_ep','to_m2','to_bp','pass'].map(id=>prompt.options.find(option=>option.id===id)).find(Boolean)||prompt.options[0];
      if(!option)failure();choice={optionId:option.id};break;
    }
    case'chain':choice={optionId:prompt.options.find(option=>option.id==='pass')?.id||prompt.options[0]?.id};break;
    case'yes-no':choice={optionId:'no'};break;
    case'option':case'announce-number':choice={optionId:prompt.options[0]?.id};break;
    case'select':choice=prompt.cancelable?{cancel:true}:{optionIds:prompt.options.slice(0,prompt.min).map(option=>option.id)};break;
    case'tribute':{
      if(prompt.cancelable){choice={cancel:true};break;}
      let paid=0;const ids=[],options=prompt.options.map((option,index)=>({...option,index})).sort((a,b)=>b.contribution-a.contribution||a.index-b.index);
      for(const option of options){if(paid>=prompt.requiredContribution)break;ids.push(option.id);paid+=option.contribution;if(ids.length>=prompt.max)break;}
      if(paid<prompt.requiredContribution)failure();choice={optionIds:ids};break;
    }
    case'sum':choice=sumChoice(message,prompt,context);break;
    case'toggle':{
      if(prompt.canFinish)choice={optionId:'finish'};else if(prompt.cancelable)choice={cancel:true};else choice={optionId:prompt.options.find(option=>!option.selected)?.id||prompt.options[0]?.id};break;
    }
    case'place':case'race':case'attribute':choice={optionIds:prompt.options.slice(0,prompt.min).map(option=>option.id)};break;
    case'position':choice={optionId:['position-4','position-1','position-8','position-2'].find(id=>prompt.options.some(option=>option.id===id))};break;
    case'counter':{
      let remaining=prompt.count;const counts={};for(const option of prompt.options){const count=Math.min(remaining,option.available,0x7fff);if(count)counts[option.id]=count;remaining-=count;}
      if(remaining)failure();choice={counts};break;
    }
    case'sort':choice={optionIds:prompt.options.map(option=>option.id)};break;
    case'announce-card':{
      const cards=context.cards||context.resources?.cards;if(!(cards instanceof Map))failure();
      // A singleton context evaluates the real declaration predicate once per
      // row, avoiding quadratic full-catalogue searches for every candidate.
      for(const card of [...cards.values()].sort((a,b)=>a.code-b.code))if(searchPromptCards(message,String(card.code),{...context,cards:new Map([[card.code,card]]),limit:1}).length){choice={value:card.code};break;}
      if(!choice)failure();break;
    }
    case'rps':choice={optionId:'rps-2'};break;
    default:failure();
  }
  try{resolveChoice(message,choice,context);}catch{failure();}
  return choice;
}
