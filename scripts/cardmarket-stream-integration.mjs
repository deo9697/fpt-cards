import assert from 'node:assert/strict';
import {CardmarketPriceGuideProvider} from '../market/providers.js';

const provider=new CardmarketPriceGuideProvider({
  catalogUrl:'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_3.json',
  priceGuideUrl:'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_3.json'
});
const target={game:'yugioh',catalogCardId:'42023223',cardName:'Alpha The Electromagnet Warrior',setCode:'MZMU-IT080',setName:'Maze of Muertos',rarity:'Rare',language:'Italiano',edition:'1st Edition'};
const before=process.memoryUsage().heapUsed,stats=await provider.load([target]),resolution=await provider.resolvePrinting(target),after=process.memoryUsage().heapUsed;
assert.equal(resolution.status,'resolved',`Mapping live non risolto: ${JSON.stringify(resolution)}`);
const price=await provider.getCurrentPrice({providerProductId:resolution.candidate.providerProductId});
assert.equal(price.status,'available','Price Guide live senza prezzo per il prodotto risolto');
console.log(JSON.stringify({stats,resolution:resolution.status,productId:resolution.candidate.providerProductId,prices:price.prices.length,heapDeltaMb:Math.round((after-before)/1024/1024)},null,2));
