import fs from 'node:fs';
const base='https://downloads.s3.cardmarket.com/productCatalog/productList/';
const [singles,boxes]=await Promise.all(['products_singles_3.json','products_nonsingles_3.json'].map(async file=>{const r=await fetch(base+file);if(!r.ok)throw new Error(`${file}: ${r.status}`);return r.json();}));
fs.writeFileSync('supabase/.temp/cardmarket-diagnostic.json',JSON.stringify({singles,boxes}));
const rows=singles.products.filter(x=>/Gustav Max|Jurrac Meteor|Ghost Gardna|Lollipo|Contact.*C/.test(x.name));
const ids=new Set(rows.map(x=>x.idExpansion));
console.log(JSON.stringify({rows,expansions:boxes.products.filter(x=>ids.has(x.idExpansion)).map(x=>({name:x.name,idExpansion:x.idExpansion}))}));
