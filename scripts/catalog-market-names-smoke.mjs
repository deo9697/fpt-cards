import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CardmarketPriceGuideProvider,resolveCardmarketPrinting} from '../market/providers.js';
const cases=[
 ['Superdreadnought Rail Cannon Gustav Max','CT10-IT007','2013 Collectible Tins Wave 1',"Collector's Tins 2013: Blaster, Dragon Ruler of Infernos",'1453','263742'],
 ['Jurrac Meteor','HA04-IT029',"Hidden Arsenal 4: Trishula's Triumph",'Hidden Arsenal 4','1263','246020'],
 ['Ghost Gardna','DP08-IT006','Duelist Pack: Yusei','Duelist Pack: Yusei Fudo','1170','109337'],
 ['Contact \\"C\\"','SDCB-IT013','Structure Deck: Legend of the Crystal Beasts','Structure Deck: Legend of the Crystal Beasts','5045','675295','Contact ""C""'],
 ['Lollipo☆Yummy','JUSH-EN018','Justice Hunters','Justice Hunters','6158','840025','LollipoYummy'],
];
const targets=cases.map(([cardName,setCode,setName],i)=>({catalogCardId:String(i+1),cardName,setCode,setName,rarity:'Common'}));
for(const [i,row] of cases.entries()){
 const candidate={providerProductId:row[5],providerExpansionId:row[4],cardName:row[6]||row[0],setName:row[3]};
 assert.equal(resolveCardmarketPrinting(targets[i],[candidate]).status,'PROVIDER_AGGREGATE',row[0]);
 assert.equal(resolveCardmarketPrinting(targets[i],[{...candidate,setName:'Unrelated Expansion'}]).status,'UNRESOLVED');
 assert.equal(resolveCardmarketPrinting(targets[i],[{...candidate,cardName:'Other Card'}]).status,'UNRESOLVED');
}
const gustav={providerProductId:'1',cardName:targets[0].cardName,setName:"Collector's Tins 2012: Tin"};
assert.equal(resolveCardmarketPrinting(targets[0],[gustav]).status,'UNRESOLVED','Tin years must stay distinct');
const local='supabase/.temp/cardmarket-diagnostic.json';
if(fs.existsSync(local)){
 const feed=JSON.parse(fs.readFileSync(local,'utf8'));
 const provider=new CardmarketPriceGuideProvider({catalogUrl:'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_3.json',fetchImpl:async url=>new Response(JSON.stringify(url.includes('nonsingles')?feed.boxes:feed.singles))});
 await provider.loadCatalog(targets,{internalPrintings:targets});
 for(const [i,row] of cases.entries()){
  const result=resolveCardmarketPrinting(targets[i],provider.catalog,{internalPrintings:targets});
  assert.equal(result.status,'PROVIDER_AGGREGATE',`Real feed: ${row[0]}`);
  assert(result.candidates.some(x=>String(x.providerProductId)===row[5]),`Wrong product: ${row[0]}`);
 }
 console.log('Real Cardmarket feed: all five reported name/expansion cases resolved.');
}
console.log('Catalog market names regression checks passed.');
const extraCases=[
 ['El Shaddoll Meshahrail','El Shaddoll Meshachrer','Battles of Legend: Glorious Gallery','Battles of Legend: Glorious Gallery'],
 ['Reeshaddoll Wendikurhu','Reeshaddoll Wendikuruhu','Battles of Legend: Glorious Gallery','Battles of Legend: Glorious Gallery'],
 ['DNA Surgery','DNA Surgery','Servitore del Faraone',"Pharaoh's Servant (SDF)"],
 ['Maliss <Q> White Binder','Maliss Q White Binder','Crossover Breakers','Crossover Breakers'],
 ['THE Star Ham','THE Star Ham\u200e',"Duelist's Advance","Duelist's Advance"],
 ['Falchion Beta','Falchionβ','Cyber Dragon Revolution Structure Deck','Structure Deck: Cyber Dragon Revolution'],
 ['H.E.R.O. Flash!','H.E.R.O. Flash! (BLZD)','Blazing Dominion','Blazing Dominion'],
 ['Magna Drago','Magna Drago',"Starter Deck: Yu-Gi-Oh! 5D's","5D's Starter Deck 2008"],
 ['Ookazi','Ookazi','Starter Deck 2006','GX Starter Deck 2006'],
 ['Drillago','Drillago','Structure Deck: Marik (TCG)','Structure Deck: Marik'],
];
for(const [name,providerName,setName,providerSet] of extraCases){
 const target={catalogCardId:'12345678',cardName:name,setCode:'TEST-IT001',setName,rarity:'Common'};
 const product={providerProductId:'1',providerExpansionId:'test',cardName:providerName,setName:providerSet};
 assert.equal(resolveCardmarketPrinting(target,[product]).status,'PROVIDER_AGGREGATE',name);
 assert.equal(resolveCardmarketPrinting(target,[{...product,setName:providerSet+' (Japanese)'}]).status,'UNRESOLVED',`${name}: OCG not TCG`);
}
const superStarter={catalogCardId:'12345678',cardName:'Cosmo Queen',setCode:'YS13-IT001',setName:'Super Starter: V for Victory',rarity:'Common'};
assert.equal(resolveCardmarketPrinting(superStarter,[{providerProductId:'1',providerExpansionId:'1445',cardName:'Cosmo Queen',setName:'Super Starter Power-Up',expansionNames:['Super Starter: V for Victory','Super Starter Power-Up']}]).status,'PROVIDER_AGGREGATE','All expansion labels must be preserved');
const {cardmarketMappingNeedsResolver,CARDMARKET_RESOLVER_VERSION}=await import('../market/providers.js');
assert(cardmarketMappingNeedsResolver({resolution_status:'unresolved',provider_metadata:{resolverVersion:CARDMARKET_RESOLVER_VERSION}}),'Unresolved cards must retry after the next feed update');
assert(!cardmarketMappingNeedsResolver({resolution_status:'manual',provider_metadata:{resolverVersion:1}}),'Preserve manual confirmations');
