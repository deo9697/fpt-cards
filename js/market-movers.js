// Funzioni pure del Market Watch usate anche dalla Dashboard (carte in
// salita, formato della variazione %). Separate da market-watch.js (~80 KB)
// così la Dashboard non trascina l'intero controller nel primo caricamento.
// Codice spostato invariato; market-watch.js le importa da qui e le re-esporta.
export function positiveMovers(items,limit=3){const ranked=(items||[]).filter(item=>derivedPriceEligible(item)&&item.sources?.includes('owned')&&Number.isFinite(item.referencePrice)&&Number.isFinite(item.price24h)&&item.price24h>0&&item.referencePrice>item.price24h).map(item=>({...item,positiveChange:(item.referencePrice-item.price24h)/item.price24h*100})).sort((a,b)=>b.positiveChange-a.positiveChange||(b.referencePrice-b.price24h)-(a.referencePrice-a.price24h));const seen=new Set(),result=[];for(const item of ranked){const key=String(item.catalogCardId||item.cardName).toLowerCase();if(seen.has(key))continue;seen.add(key);result.push(item);if(result.length>=limit)break;}return result;}
export function derivedPriceEligible(item){return item?.mappingStatus==='manual'||(item?.referencePrice!=null&&item?.resolverStatus!=='PROVIDER_AGGREGATE');}
export function changePercent(value){if(value==null)return'—';const number=Number(value)||0;return `${number>=0?'+':'−'}${Math.abs(number).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2})}%`;}
