import assert from 'node:assert/strict';
import fs from 'node:fs';

const local=new Map();globalThis.localStorage={getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value),removeItem:key=>local.delete(key)};
const {DeckController,parseDeckList,deckAvailability,isExtraDeckCard}=await import('../js/decks.js');
const {normalizeTcgBanStatus}=await import('../js/cards.js');

assert.equal(normalizeTcgBanStatus('Limited'),'limited');
assert.equal(normalizeTcgBanStatus('Semi-Limited'),'semi-limited');
assert.equal(normalizeTcgBanStatus('Banned'),'forbidden');
assert.equal(normalizeTcgBanStatus('Unlimited'),'');

const parsed=parseDeckList(`#main
46986414
46986414
2 Dark Magician
#extra
10000080
!side
3 Mystical Space Typhoon`);
assert.deepEqual(parsed.find(item=>item.id==='46986414'),{section:'main',quantity:2,id:'46986414',name:''});
assert.equal(parsed.find(item=>item.name==='Dark Magician').quantity,2);
assert.equal(parsed.find(item=>item.id==='10000080').section,'extra');
assert.equal(parsed.find(item=>item.name==='Mystical Space Typhoon').section,'side');

const deck={cards:[
  {catalogCardId:'1',cardName:'Carta Uno',section:'main',quantity:3,imageUrl:'one.jpg',banTcg:'limited'},
  {catalogCardId:'2',cardName:'Carta Due',section:'side',quantity:2,imageUrl:'two.jpg',banTcg:'forbidden'}
]};
const collection={mine:[
  {catalogCardId:'1',quantityAvailable:1},{catalogCardId:'2',quantityAvailable:2}
],team:[
  {id:'a',catalogCardId:'1',ownerSlug:'alice',ownerName:'Alice',quantityAvailable:1},
  {id:'b',catalogCardId:'1',ownerSlug:'bob',ownerName:'Bob',quantityAvailable:2},
  {id:'c',catalogCardId:'1',ownerSlug:'me',ownerName:'Io',quantityAvailable:9}
]};
const report=deckAvailability(deck,collection,'me');
assert.equal(report.total,5);assert.equal(report.covered,3);assert.equal(report.percent,60);
assert.equal(report.rows.length,1);assert.equal(report.rows[0].missing,2);
assert.equal(report.rows[0].best.ownerSlug,'bob','non seleziona il proprietario con più copie');
assert.equal(report.rows[0].best.quantity,2);assert.equal(report.requestable,1);

const uiState={game:'yugioh',currentUser:'me',decks:[{id:'deck-1',persisted:true,name:'Control Test',format:'TCG Avanzato',game:'yugioh',cover:'one.jpg',cards:deck.cards}],collection};
const controller=new DeckController({getState:()=>uiState,isOnline:()=>true,onRender:()=>{},onToast:()=>{}});controller.activeId='deck-1';const html=controller.view();
for(const required of ['Control Test','Main Deck','Extra Deck','Side Deck','60% pronto','Bob ne ha 2','data-deck-request="1"','Richiedi tutte le carte mancanti'])assert(html.includes(required),`UI Mazzi incompleta: ${required}`);
for(const required of ['deck-ban-badge limited','Limitata a 1 copia','deck-ban-badge forbidden','Proibita','>⊘</i>'])assert(html.includes(required),`Bollino banlist TCG Advanced assente: ${required}`);
assert(!html.includes('data-deck-section='),'Il compilatore divide ancora il mazzo in tre schede');
assert(isExtraDeckCard({type:'Synchro Effect Monster'}));assert(isExtraDeckCard({type:'Link Monster'}));assert(!isExtraDeckCard({type:'Effect Monster'}));

const draftState={game:'yugioh',currentUser:'me',decks:[],collection:{mine:[],team:[]}},draftController=new DeckController({api:{decks:async()=>[]},getState:()=>draftState,isOnline:()=>true,onRender:()=>{},onToast:()=>{}});draftController.create(false);draftController.add({id:'99',name:'Synchro Test',type:'Synchro Monster',image:'synchro.jpg',banTcg:'semi-limited'});assert.equal(draftController.active().cards[0].section,'extra','una carta Extra Deck inserita dal Main non viene classificata automaticamente');
const restoredState={game:'yugioh',currentUser:'me',decks:[],collection:{mine:[],team:[]}},restoredController=new DeckController({api:{decks:async()=>[]},getState:()=>restoredState,isOnline:()=>true,onRender:()=>{},onToast:()=>{}});await restoredController.load();assert.equal(restoredController.active().cards[0].cardName,'Synchro Test','hard refresh perde la bozza locale');
assert.equal(restoredController.active().cards[0].banTcg,'semi-limited','hard refresh perde lo stato della banlist TCG');

const legacyState={game:'yugioh',currentUser:'legacy-owner',decks:[],collection:{mine:[],team:[]}},legacyController=new DeckController({api:{decks:async()=>[{id:'legacy-deck',owner_slug:'legacy-owner',name:'Legacy',format:'TCG Avanzato',game:'yugioh',cards:[{catalog_card_id:'24224830',card_name:'Called by the Grave',section:'main',quantity:1},{catalog_card_id:'94145021',card_name:'Droll & Lock Bird',section:'main',quantity:2}]}]},tcgBanlistStatuses:async()=>({'24224830':'limited','94145021':'semi-limited'}),getState:()=>legacyState,isOnline:()=>true,onRender:()=>{},onToast:()=>{}});await legacyController.load();
assert.equal(legacyState.decks[0].cards[0].banTcg,'limited','mazzo esistente non aggiornato con Limited');
assert.equal(legacyState.decks[0].cards[1].banTcg,'semi-limited','mazzo esistente non aggiornato con Semi-Limited');
const legacyHtml=legacyController.view();assert(legacyHtml.includes('deck-ban-badge limited')&&legacyHtml.includes('deck-ban-badge semi-limited'),'bollini retroattivi non renderizzati');

const sql=fs.readFileSync(new URL('../supabase-milestone-4-decks.sql',import.meta.url),'utf8');
for(const required of ['create table if not exists public.decks','create table if not exists public.deck_cards','ban_tcg','deck_cards_ban_tcg_check','public.session_member(p_token)','where d.owner_slug=me','public.save_deck','public.delete_deck','on delete cascade','grant execute'])assert(sql.includes(required),`Migrazione mazzi incompleta: ${required}`);
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8'),sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8'),styles=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
for(const required of ["page === 'decks'","decks.view()","decks.bind(document)","['decks','deck','Mazzi']",'loadDecks()'])assert(app.includes(required),`Integrazione Mazzi assente: ${required}`);
assert(sw.includes("'./js/decks.js'"),'Modulo Mazzi non incluso nella cache PWA');
assert(styles.includes('.deck-ban-badge.limited { background:#e04444; }'),'Limited non usa il bollino rosso');
assert(styles.includes('.deck-ban-badge.semi-limited { border-color:#fff1a0;background:#e3b51c;color:#1a1200; }'),'Semi-Limited non usa il bollino giallo');
assert(styles.includes('.deck-ban-badge.forbidden { background:#c72d4a;'),'Il bollino Proibita Ã¨ stato alterato');

console.log('PASS import YDK/testo e sezioni Main/Extra/Side');
console.log('PASS disponibilità personale e scelta proprietario con più copie');
console.log('PASS persistenza privata, routing e cache PWA Mazzi');
