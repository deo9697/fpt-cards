// Rarità ufficiali Konami per una stampa inglese (es. BLGG-EN047).
// Serve alla Fast Scan quando YGOPRODeck segna la stampa come "New"/"Reprint"
// invece della rarità: il database Konami non ha CORS, quindi lo legge qui.
// Sola lettura, host fisso, input validato; nessuna scrittura sul DB.
const supabaseUrl=Deno.env.get('SUPABASE_URL')||'';
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const KONAMI='https://www.db.yugioh-card.com/yugiohdb/card_search.action';
const CODE=/^([A-Z0-9]{2,5}-EN)([A-Z0-9]{1,4})$/;
const TTL=6*60*60*1000;
const cache=new Map<string,{at:number,body:Result}>();
type Result={setCode:string,konamiId:string|null,cardName:string,rarities:string[]};
const cors={'access-control-allow-origin':'*','access-control-allow-methods':'GET, OPTIONS','access-control-allow-headers':'authorization, apikey, content-type, x-client-info'};

Deno.serve(async request=>{
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(request.method!=='GET')return json({error:'method_not_allowed'},405);
  const code=String(new URL(request.url).searchParams.get('setCode')||'').trim().toUpperCase();
  const match=code.match(CODE);
  if(!match)return json({error:'invalid_set_code'},400);
  const hit=cache.get(code);
  if(hit&&Date.now()-hit.at<TTL)return json(hit.body);
  try{
    const ids=await konamiIdsFor(match[1],match[2],code);
    let body:Result={setCode:code,konamiId:null,cardName:'',rarities:[]};
    for(const id of ids){
      const page=await konamiPage(id);
      if(page.rarities.length){body={setCode:code,konamiId:id,...page};break;}
    }
    cache.set(code,{at:Date.now(),body});
    return json(body);
  }catch(error){
    console.error(JSON.stringify({event:'konami_rarities_failed',setCode:code,message:String((error as Error)?.message||error)}));
    return json({error:'source_unavailable'},502);
  }

  async function konamiPage(id:string){
    const html=await text(`${KONAMI}?ope=2&cid=${encodeURIComponent(id)}&request_locale=en`);
    const cardName=decode(html.match(/id="cardname"[^>]*>\s*<h1>\s*([^<]+?)\s*</)?.[1]||'');
    const rarities=new Set<string>();
    for(const block of html.split('<div class="inside">').slice(1)){
      const number=block.match(/class="card_number">\s*([A-Z0-9-]+)\s*</)?.[1];
      const rarity=block.match(/<p>[^<]{1,6}<\/p>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/)?.[1];
      if(number===code&&rarity)rarities.add(decode(rarity));
    }
    return {cardName,rarities:[...rarities]};
  }
});

// Id carta Konami: prima il registro ygo_printcode_entries, poi la ricerca
// per numero sul sito Konami (la pagina della carta verifica comunque il codice).
async function konamiIdsFor(prefix:string,number:string,code:string){
  if(supabaseUrl&&serviceKey){
    const url=`${supabaseUrl}/rest/v1/ygo_printcode_entries?select=konami_card_id&set_prefix=eq.${encodeURIComponent(prefix)}&print_number=eq.${encodeURIComponent(number)}&limit=1`;
    const response=await fetch(url,{headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`},signal:AbortSignal.timeout(8000)});
    if(response.ok){const rows=await response.json();const id=rows?.[0]?.konami_card_id;if(id)return [String(id)];}
    else await response.body?.cancel();
  }
  const html=await text(`${KONAMI}?ope=1&sess=1&rp=10&stype=4&keyword=${encodeURIComponent(code)}&request_locale=en`);
  return [...new Set([...html.matchAll(/ope=2&(?:amp;)?cid=(\d+)/g)].map(m=>m[1]))].slice(0,3);
}
async function text(url:string){
  const response=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (F.P.T Cards catalog check)'},signal:AbortSignal.timeout(10000)});
  if(!response.ok){await response.body?.cancel();throw new Error(`konami_${response.status}`);}
  return response.text();
}
function decode(value:string){return value.replace(/&#0*39;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();}
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{...cors,'content-type':'application/json','cache-control':status===200?'public, max-age=21600':'no-store'}});}
