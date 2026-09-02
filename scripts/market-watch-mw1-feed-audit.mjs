import {CardmarketPriceGuideProvider} from '../market/providers.js';

const catalogUrl='https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_3.json';
const priceGuideUrl='https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_3.json';
const targets=[
  {cardName:'Sky Striker Ace - Shizuku',setName:'Legendary Modern Decks 2026'},
  {cardName:'Bramble Rose Dragon',setName:'Doom of Dimensions'},
  {cardName:'Sea Monster of Theseus',setName:'2017 Mega-Tin Mega Pack'}
];
const provider=new CardmarketPriceGuideProvider({catalogUrl,priceGuideUrl});
const catalogStats=await provider.loadCatalog(targets);
const selected=provider.catalog.filter(row=>targets.some(target=>target.cardName===row.cardName&&target.setName===row.setName));
const mappings=selected.map(row=>({resolution_status:'manual',providerProductId:row.providerProductId}));
const priceStats=await provider.loadPrices(mappings);
const rows=selected.map(row=>({
  cardName:row.cardName,setName:row.setName,providerProductId:row.providerProductId,
  providerExpansionId:row.providerExpansionId,rawProduct:pick(row,['idProduct','idCategory','idExpansion','idMetacard','countReprints','name','website']),
  normalized:{rarity:row.rarity||null,foil:row.foil??null},
  rawPrice:pick(provider.prices.get(String(row.providerProductId))||{},['idProduct','avg','low','trend','avg1','avg7','avg30','avg-foil','low-foil','trend-foil','avg1-foil','avg7-foil','avg30-foil']),
  rawProductKeys:Object.keys(row).sort(),rawPriceKeys:Object.keys(provider.prices.get(String(row.providerProductId))||{}).sort()
}));
console.log(JSON.stringify({catalogStats,priceStats,rows},null,2));

function pick(row,keys){return Object.fromEntries(keys.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));}
