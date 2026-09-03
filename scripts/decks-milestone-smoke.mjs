import assert from 'node:assert/strict';
import fs from 'node:fs';

const local=new Map();globalThis.localStorage={getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value),removeItem:key=>local.delete(key)};
const {DeckController,parseDeckList,deckAvailability,isExtraDeckCard}=await import('../js/decks.js');
const {DEFAULT_DECK_THEME,DECK_BOX_TEMPLATES,normalizeDeckBoxTemplate,normalizeDeckTheme,resolveDeckSignature,preferredDeckArtwork,renderDeckBoxCard}=await import('../js/deck-box.js');
const {normalizeTcgBanStatus}=await import('../js/cards.js');

assert.equal(normalizeTcgBanStatus('Limited'),'limited');
assert.equal(normalizeTcgBanStatus('Semi-Limited'),'semi-limited');
assert.equal(normalizeTcgBanStatus('Banned'),'forbidden');
assert.equal(normalizeTcgBanStatus('Unlimited'),'');
const signatureDeck={id:'signature',name:'Signature Test',deckTheme:'celestial-gold',signatureCardId:'2',cards:[{catalogCardId:'1',cardName:'Main One',section:'main',quantity:1,imageUrl:'https://images.ygoprodeck.com/images/cards/1.jpg'},{catalogCardId:'2',cardName:'Extra Signature',section:'extra',quantity:1,imageUrl:'https://images.ygoprodeck.com/images/cards/2.jpg'}]};
assert.equal(resolveDeckSignature(signatureDeck).cardName,'Extra Signature');
assert.equal(resolveDeckSignature({...signatureDeck,signatureCardId:null}).cardName,'Main One');
assert.equal(resolveDeckSignature({cards:[{catalogCardId:'2',cardName:'Extra',section:'extra'}]}).cardName,'Extra');
assert.equal(resolveDeckSignature({cards:[{catalogCardId:'3',cardName:'Side',section:'side'}]}),null);
assert.equal(normalizeDeckTheme('missing-theme'),DEFAULT_DECK_THEME);assert(preferredDeckArtwork(signatureDeck.cards[1]).includes('cards_cropped/2.jpg'));
assert(renderDeckBoxCard({...signatureDeck,cards:[]}).includes('deck-box-fallback'),'Deck Box senza artwork non usa il fallback F.P.T');
assert(renderDeckBoxCard(signatureDeck).includes('data-deck-theme="celestial-gold"'),'Tema Deck Box non applicato');
assert.equal(normalizeDeckBoxTemplate('unknown'),'procedural');assert.equal(Object.keys(DECK_BOX_TEMPLATES).length,4);
for(const template of ['arcane-vault','infernal-dragon','cyber-core']){const rendered=renderDeckBoxCard({...signatureDeck,deckBoxTemplate:template});assert(rendered.includes(`data-deck-template="${template}"`)&&rendered.includes(DECK_BOX_TEMPLATES[template].image),`Modello ${template} non renderizzato`);assert(fs.existsSync(new URL(`../${DECK_BOX_TEMPLATES[template].image}`,import.meta.url)),`Asset ${template} non incorporato`);}

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
  {catalogCardId:'10000001',cardName:'Carta Uno',section:'main',quantity:3,imageUrl:'one.jpg',banTcg:'limited'},
  {catalogCardId:'10000002',cardName:'Carta Due',section:'side',quantity:2,imageUrl:'two.jpg',banTcg:'forbidden'}
]};
const collection={mine:[
  {catalogCardId:'10000001',quantityAvailable:1},{catalogCardId:'10000002',quantityAvailable:2}
],team:[
  {id:'a',catalogCardId:'10000001',ownerSlug:'alice',ownerName:'Alice',quantityAvailable:1},
  {id:'b',catalogCardId:'10000001',ownerSlug:'bob',ownerName:'Bob',quantityAvailable:2},
  {id:'c',catalogCardId:'10000001',ownerSlug:'me',ownerName:'Io',quantityAvailable:9}
]};
const report=deckAvailability(deck,collection,'me');
assert.equal(report.total,5);assert.equal(report.covered,3);assert.equal(report.percent,60);
assert.equal(report.rows.length,1);assert.equal(report.rows[0].missing,2);
assert.equal(report.rows[0].best.ownerSlug,'bob','non seleziona il proprietario con più copie');
assert.equal(report.rows[0].best.quantity,2);assert.equal(report.requestable,1);

const repairedIdentityReport=deckAvailability({cards:[
  {catalogCardId:'94145021',cardName:'Droll & Lock Bird',section:'main',quantity:1},
  {catalogCardId:'73642296',cardName:'Ghost Belle & Haunted Mansion',section:'main',quantity:1}
]},{mine:[
  {id:'droll-alias',catalogCardId:'94145022',cardName:'Droll alternate artwork',quantityAvailable:1},
  {id:'ghost-old',catalogCardId:'',cardName:'Ghost Belle & Haunted Mansion',quantityAvailable:1}
],team:[]},'me');
assert.equal(repairedIdentityReport.percent,100,'alias esplicito o record senza ID impedisce il match Droll/Ghost Belle');
assert.equal(repairedIdentityReport.rows.length,0,'alias catalogo espliciti risultano mancanti');

const uiState={game:'yugioh',currentUser:'me',decks:[{id:'deck-1',persisted:true,name:'Control Test',format:'TCG Avanzato',game:'yugioh',cover:'one.jpg',cards:deck.cards}],collection};
const controller=new DeckController({getState:()=>uiState,isOnline:()=>true,onRender:()=>{},onToast:()=>{}});controller.activeId='deck-1';controller.previewId='deck-1';const galleryHtml=controller.view();
for(const required of ['Scegli il tuo mazzo','deck-box-grid','deck-box-card','Control Test','Disponibilità personale','data-deck-import-new'])assert(galleryHtml.includes(required),`Gallery Mazzi incompleta: ${required}`);
assert(!galleryHtml.includes('data-deck-search'),"L'editor compare ancora nella schermata iniziale dei mazzi");
controller.open('deck-1');const html=controller.view();
for(const required of ['Control Test','data-deck-section="main"','data-deck-section="extra"','data-deck-section="side"','60% pronto per il team','deck-ban-badge limited','Limitata a 1 copia'])assert(html.includes(required),`UI Mazzi incompleta: ${required}`);
assert(html.includes('data-deck-section='),'Il compilatore mobile-first non usa più le schede Main/Extra/Side');
controller.setSection('side');const sideHtml=controller.view();
for(const required of ['deck-ban-badge forbidden','Proibita','>⊘</i>'])assert(sideHtml.includes(required),`Bollino banlist TCG Advanced assente nella scheda Side: ${required}`);
controller.setSection('main');
controller.toggleMissingPanel(true);const missingHtml=controller.view();
for(const required of ['Bob ne ha 2','data-deck-request="10000001"','Richiedi tutte le carte mancanti'])assert(missingHtml.includes(required),`Pannello carte mancanti incompleto: ${required}`);
controller.toggleMissingPanel(false);
controller.toggleMoreMenu();const moreHtml=controller.view();
assert(moreHtml.includes('Tema Deck Box')&&moreHtml.includes('data-deck-cover-open'),'Controlli cover/tema assenti dal menu Altro');
controller.toggleMoreMenu();
controller.chooseCover('10000002');assert.equal(uiState.decks[0].signatureCardId,'10000002','Scelta cover non persistita nella bozza');
controller.chooseDeckBoxTemplate('infernal-dragon');assert.equal(uiState.decks[0].deckBoxTemplate,'infernal-dragon');assert.equal(uiState.decks[0].deckTheme,'infernal-red','Il modello rosso non applica il tema coerente');
assert(isExtraDeckCard({type:'Synchro Effect Monster'}));assert(isExtraDeckCard({type:'Link Monster'}));assert(!isExtraDeckCard({type:'Effect Monster'}));

let typesRequests=0;
const typeDeck={id:'deck-types',persisted:true,name:'Type Sort Test',format:'TCG Avanzato',game:'yugioh',cover:'',cards:[
  {catalogCardId:'1',cardName:'Zeta Trap',section:'main',quantity:1,imageUrl:''},
  {catalogCardId:'2',cardName:'Alpha Monster',section:'main',quantity:1,imageUrl:''},
  {catalogCardId:'3',cardName:'Beta Spell',section:'main',quantity:1,imageUrl:''}
]};
const typeState={game:'yugioh',currentUser:'me',decks:[typeDeck],collection:{mine:[],team:[]}};
const typeController=new DeckController({getState:()=>typeState,isOnline:()=>true,onRender:()=>{},onToast:()=>{},cardTypesByIds:async ids=>{typesRequests+=1;return {'1':'Trap Card','2':'Effect Monster','3':'Spell Card'};}});
typeController.activeId='deck-types';typeController.previewId='deck-types';typeController.screen='detail';
const resolvePromise=typeController.resolveCardTypes(typeController.active());
assert.equal(typeController.typesLoading,true,'typesLoading non attivo durante la risoluzione bulk dei tipi');
await resolvePromise;
assert.equal(typesRequests,1,'la risoluzione dei tipi deve usare una sola richiesta bulk, non una per carta');
assert.equal(typeController.typesLoading,false,'typesLoading non si disattiva dopo la risoluzione');
assert.deepEqual(typeController.cardTypes,{'1':'trap','2':'monster','3':'spell'},'tipi carta non normalizzati correttamente dalla risposta bulk');
const sortedDefault=typeController.sortCards(typeDeck.cards).map(c=>c.cardName);
assert.deepEqual(sortedDefault,['Alpha Monster','Beta Spell','Zeta Trap'],'ordinamento predefinito non raggruppa Mostri → Magie → Trappole');
typeController.setSort('name-asc');
assert.deepEqual(typeController.sortCards(typeDeck.cards).map(c=>c.cardName),['Alpha Monster','Beta Spell','Zeta Trap'],'ordinamento Nome A-Z errato');
typeController.setTypeFilter('trap');const trapHtml=typeController.view();
assert(trapHtml.includes('Zeta Trap')&&!trapHtml.includes('Alpha Monster')&&!trapHtml.includes('Beta Spell'),'filtro Trappole non isola le sole carte trappola risolte');

const draftState={game:'yugioh',currentUser:'me',decks:[],collection:{mine:[],team:[]}},draftController=new DeckController({api:{decks:async()=>[]},getState:()=>draftState,isOnline:()=>true,onRender:()=>{},onToast:()=>{}});draftController.create(false);draftController.add({id:'99',name:'Synchro Test',type:'Synchro Monster',image:'synchro.jpg',banTcg:'semi-limited'});assert.equal(draftController.active().cards[0].section,'extra','una carta Extra Deck inserita dal Main non viene classificata automaticamente');
const restoredState={game:'yugioh',currentUser:'me',decks:[],collection:{mine:[],team:[]}},restoredController=new DeckController({api:{decks:async()=>[]},getState:()=>restoredState,isOnline:()=>true,onRender:()=>{},onToast:()=>{}});await restoredController.load();assert.equal(restoredController.active().cards[0].cardName,'Synchro Test','hard refresh perde la bozza locale');
assert.equal(restoredController.active().cards[0].banTcg,'semi-limited','hard refresh perde lo stato della banlist TCG');

const legacyState={game:'yugioh',currentUser:'legacy-owner',decks:[],collection:{mine:[],team:[]}},legacyController=new DeckController({api:{decks:async()=>[{id:'legacy-deck',owner_slug:'legacy-owner',name:'Legacy',format:'TCG Avanzato',game:'yugioh',cards:[{catalog_card_id:'24224830',card_name:'Called by the Grave',section:'main',quantity:1},{catalog_card_id:'94145021',card_name:'Droll & Lock Bird',section:'main',quantity:2}]}]},tcgBanlistStatuses:async()=>({'24224830':'limited','94145021':'semi-limited'}),getState:()=>legacyState,isOnline:()=>true,onRender:()=>{},onToast:()=>{}});await legacyController.load();
assert.equal(legacyState.decks[0].cards[0].banTcg,'limited','mazzo esistente non aggiornato con Limited');
assert.equal(legacyState.decks[0].cards[1].banTcg,'semi-limited','mazzo esistente non aggiornato con Semi-Limited');
legacyController.open('legacy-deck');const legacyHtml=legacyController.view();assert(legacyHtml.includes('deck-ban-badge limited')&&legacyHtml.includes('deck-ban-badge semi-limited'),'bollini retroattivi non renderizzati');
assert(!legacyHtml.includes('Printing da selezionare')&&!legacyHtml.includes('deck-printing-status'),'Il deck builder mostra ancora dettagli printing del Market Watch');

const sql=fs.readFileSync(new URL('../supabase-milestone-4-decks.sql',import.meta.url),'utf8');
for(const required of ['create table if not exists public.decks','create table if not exists public.deck_cards','ban_tcg','deck_cards_ban_tcg_check','public.session_member(p_token)','where d.owner_slug=me','public.save_deck','public.delete_deck','on delete cascade','grant execute'])assert(sql.includes(required),`Migrazione mazzi incompleta: ${required}`);
const deckBoxSql=fs.readFileSync(new URL('../supabase-milestone-4-1-dynamic-deck-boxes.sql',import.meta.url),'utf8');for(const required of ['add column if not exists signature_card_id','add column if not exists deck_theme','add column if not exists deck_box_template','list_my_decks_with_boxes','save_deck_with_box','La carta signature deve appartenere al mazzo'])assert(deckBoxSql.includes(required),`Migration Deck Box incompleta: ${required}`);
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8'),sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8'),styles=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
for(const required of ["page === 'decks'","decks.view()","decks.bind(document)","['decks','deck','Mazzi']",'loadDecks()'])assert(app.includes(required),`Integrazione Mazzi assente: ${required}`);
assert(sw.includes("'./js/decks.js'"),'Modulo Mazzi non incluso nella cache PWA');
assert(sw.includes("'./js/deck-box.js'"),'Componente Deck Box non incluso nella cache PWA');
for(const asset of Object.values(DECK_BOX_TEMPLATES).map(row=>row.image).filter(Boolean))assert(sw.includes(`'./${asset}'`),`Asset Deck Box non incluso nella PWA: ${asset}`);
assert(styles.includes('.deck-ban-badge.limited { background:#e04444; }'),'Limited non usa il bollino rosso');
assert(styles.includes('.deck-ban-badge.semi-limited { border-color:#fff1a0;background:#e3b51c;color:#1a1200; }'),'Semi-Limited non usa il bollino giallo');
assert(styles.includes('.deck-ban-badge.forbidden { background:#c72d4a;'),'Il bollino Proibita Ã¨ stato alterato');
for(const required of ['.deck-gallery-layout','.deck-box-grid','.deck-box-card','.deck-gallery-preview','@media (max-width:480px)'])assert(styles.includes(required),`Stile gallery Mazzi assente: ${required}`);

console.log('PASS import YDK/testo e sezioni Main/Extra/Side');
console.log('PASS disponibilità personale e scelta proprietario con più copie');
console.log('PASS gallery Mazzi separata, accessibile e responsive');
console.log('PASS persistenza privata, routing e cache PWA Mazzi');
