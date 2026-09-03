import assert from 'node:assert/strict';
import fs from 'node:fs';

const local=new Map();
globalThis.localStorage={getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value),removeItem:key=>local.delete(key)};

const {deckAvailability,sameDeckCardIdentity}=await import('../js/decks.js');
const {canonicalCatalogCardId,catalogImageNeedsRepair}=await import('../js/cards.js');
const {verifyPendingCollectionCatalog,CATALOG_VERIFICATION_VERSION}=await import('../js/catalog-verification.js');

const translated=[
  ['14532163','Fulmine Tempesta','Lightning Storm',2],
  ['18144507',"Spolverino dell'Arpia","Harpie's Feather Duster",1],
  ['30741503',"Galatea, l'Automa Orcusestra",'Galatea, the Orcust Automaton',2],
  ['87746184','Albion il Drago Marchiato','Albion the Branded Dragon',2],
  ['15693423','Scontro ad Armi Pari','Evenly Matched',2],
  ['36346532','Cambroraster Paleozoica','Paleozoic Cambroraster',2],
  ['80532587',"Entita Maggiore N'tss","Elder Entity N'tss",1],
  ['87602890','Zaborg il Mega Monarca','Zaborg the Mega Monarch',2],
  ['47084486','Demone della Vanita',"Vanity's Fiend",1],
  ['14532163','Fulmine Tempesta','Lightning Storm',2]
];
const deck={cards:translated.map(([catalogCardId,cardName,,quantity],index)=>({catalogCardId,cardName,section:index%2?'side':'main',quantity}))};
const collection={mine:translated.map(([catalogCardId,,cardName,quantity],index)=>({id:`item-${index}`,catalogCardId,cardName,quantityAvailable:quantity})),team:[]};
const report=deckAvailability(deck,collection,'me');
assert.equal(report.rows.length,0,'le traduzioni con catalog ID identico risultano ancora mancanti');
assert(translated.every(([id,it,en])=>sameDeckCardIdentity({catalogCardId:id,cardName:it},{catalogCardId:id,cardName:en})));
assert.equal(sameDeckCardIdentity({catalogCardId:'11111111',cardName:'Nome uguale'},{catalogCardId:'22222222',cardName:'Nome uguale'}),false,'due ID validi differenti fanno match per nome');
assert.equal(sameDeckCardIdentity({catalogCardId:'',cardName:'Legacy Name'},{catalogCardId:'22222222',cardName:'Legacy Name'}),true,'il fallback legacy senza ID non funziona');
assert.equal(canonicalCatalogCardId('94145022'),'94145021');
assert(sameDeckCardIdentity({catalogCardId:'94145022',cardName:'Droll alternate'},{catalogCardId:'94145021',cardName:'Droll & Lock Bird'}),'alias esplicito non canonizzato');
assert(sameDeckCardIdentity({catalogCardId:'73642296',cardName:'Ghost Belle & Haunted Mansion'},{catalogCardId:'73642297',cardName:'Ghost Belle & Haunted Mansion'}),'alias legacy Ghost Belle non canonizzato');
assert.equal(catalogImageNeedsRepair('94145021','https://images.ygoprodeck.com/images/cards/94145022.jpg'),false,'artwork alias marcato incoerente');

let quantityOwned=1,repairPayload=null,releaseRepair;
const repairGate=new Promise(resolve=>{releaseRepair=resolve;});
const raceApi={
  catalogVerificationQueue:async()=>[{collection_item_id:'inventory-1',game:'yugioh',catalog_card_id:'14532163',card_name:'Lightning Storm',set_code:'MAMA-EN089'}],
  repairCollectionCatalogIdentity:async payload=>{repairPayload=payload;await repairGate;return {printing_id:'printing-1',catalog_card_id:'14532163',card_name:'Lightning Storm',image_url:'https://images.ygoprodeck.com/images/cards/14532163.jpg'};}
};
const race=verifyPendingCollectionCatalog({api:raceApi,resolveCard:async()=>({id:'14532163',name:'Lightning Storm',image:'https://images.ygoprodeck.com/images/cards/14532163.jpg'})});
await new Promise(resolve=>setTimeout(resolve,0));
quantityOwned=2; // Fast Scan completa mentre la repair usa ancora la vecchia fotografia logica.
releaseRepair();
const raceResult=await race;
assert.equal(quantityOwned,2,'la image repair ha sovrascritto quantity_owned');
assert.equal(raceResult.verified,1);
assert.deepEqual(Object.keys(repairPayload).sort(),['cardName','catalogCardId','collectionItemId','imageUrl','verificationVersion'].sort(),'la repair invia campi inventario non pertinenti');

let verifiedProviderCalls=0;
const verified500=await verifyPendingCollectionCatalog({
  api:{catalogVerificationQueue:async()=>[],repairCollectionCatalogIdentity:async()=>{throw new Error('non attesa');}},
  resolveCard:async()=>{verifiedProviderCalls+=1;return null;}
});
assert.equal(verified500.queued,0);assert.equal(verifiedProviderCalls,0);
const benchmark={printing:500,beforeHttpRequests:1000,afterHttpRequests:verifiedProviderCalls};

let newPending=true,newProviderCalls=0,newRepairCalls=0;
const newRecordApi={
  catalogVerificationQueue:async()=>newPending?[{collection_item_id:'new-verified-1',game:'yugioh',catalog_card_id:'12345678',card_name:'Nuova carta',set_code:'TEST-IT001'}]:[],
  repairCollectionCatalogIdentity:async()=>{newRepairCalls+=1;newPending=false;return {catalog_card_id:'12345678'};}
};
await verifyPendingCollectionCatalog({api:newRecordApi,resolveCard:async()=>{newProviderCalls+=1;return{id:'12345678',name:'Nuova carta',image:'https://images.ygoprodeck.com/images/cards/12345678.jpg'};}});
await verifyPendingCollectionCatalog({api:newRecordApi,resolveCard:async()=>{newProviderCalls+=1;return null;}});
assert.equal(newProviderCalls,1,'un record verificato viene ricontrollato al refresh successivo');
assert.equal(newRepairCalls,1,'un record nuovo non viene verificato e persistito una sola volta');

let handledRepairCalls=0;
const transient=await verifyPendingCollectionCatalog({
  api:{catalogVerificationQueue:async()=>[{collection_item_id:'new-1',game:'yugioh',catalog_card_id:'12345678',card_name:'Nuova',set_code:'TEST-IT001'}],repairCollectionCatalogIdentity:async()=>{handledRepairCalls+=1;}},
  resolveCard:async()=>{throw new Error('provider temporaneamente non disponibile');}
});
assert.equal(transient.failed,1);assert.equal(handledRepairCalls,0,'un failure provider ha scritto stato catalogo');

const sql=fs.readFileSync(new URL('../supabase-catalog-verification-v1.sql',import.meta.url),'utf8');
for(const required of ['catalog_verification_status','catalog_verification_version','list_collection_catalog_verification_queue','repair_collection_item_catalog_identity',"'pending','verified','incoherent'",'where ci.owner_slug = me'])assert(sql.includes(required),`Migration catalog verification incompleta: ${required}`);
const repairBody=sql.slice(sql.indexOf('create or replace function public.repair_collection_item_catalog_identity'));
assert(repairBody.includes('update public.collection_items set printing_id = target_printing_id'),'la repair non aggiorna il riferimento canonico');
assert(!/update public\.collection_items set[^;]*(quantity_owned|language\s*=|condition\s*=|edition\s*=)/is.test(repairBody),'la repair modifica campi inventario non pertinenti');
assert.equal(CATALOG_VERIFICATION_VERSION,1);

const sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
assert(sw.includes("const CACHE = 'fpt-cards-v137'"));
assert(sw.includes("'./js/catalog-verification.js'"));

console.log('PASS Deck identity ID-first, traduzioni, fallback legacy e alias espliciti');
console.log('PASS image repair field-specific: quantity 1 -> Fast Scan 2 -> repair tardiva -> 2');
console.log(`PASS catalog benchmark ${benchmark.printing} printing verificati: ${benchmark.beforeHttpRequests} request prima -> ${benchmark.afterHttpRequests} dopo`);
console.log('PASS record nuovo verificato una volta e poi escluso dalla coda persistente');
console.log('PASS failure provider non gestito come verifica e nessuna Promise rejection');
