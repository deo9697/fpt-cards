import {esc} from './core.js';
import {icon} from './icons.js';
import {getGameAdapter} from './games/index.js';

export const DEFAULT_DECK_THEME='arcane-purple';
export const DEFAULT_DECK_BOX_TEMPLATE='procedural';
export const DECK_BOX_TEMPLATES={
  procedural:{label:'Artwork dinamico',image:'',theme:null},
  'arcane-vault':{label:'Volta arcana',image:'assets/deck-boxes/arcane-vault.png',theme:'arcane-purple'},
  'infernal-dragon':{label:'Drago infernale',image:'assets/deck-boxes/infernal-dragon.png',theme:'infernal-red'},
  'cyber-core':{label:'Nucleo cyber',image:'assets/deck-boxes/cyber-core.png',theme:'cyber-cyan'},
  // Sbloccabili per archetipo (2026-09-11): 10 vittorie consecutive con un
  // mazzo di composizione specifica — vedi js/deck-archetype-unlocks.js per
  // le regole esatte e js/cosmetics.js per il cosmetic abbinato
  // (deckbox_<chiave>). Chiave del template = suffisso dell'id cosmetic,
  // per lookup diretto nel gating di js/decks.js coverPickerView(). Nessun
  // theme forzato: il box stesso è il premio, non un tema colore imposto.
  sacred_beast_orcust:{label:'Sacred Beast Orcust',image:'assets/deck-boxes/sacred_beast_orcust_deckbox.png',theme:null},
  mitsurugi:{label:'Mitsurugi',image:'assets/deck-boxes/mitsurugi_deckbox.png',theme:null},
  skystriker:{label:'Skystriker',image:'assets/deck-boxes/skystriker_deckbox.png',theme:null}
};
export const DECK_THEMES={
  'arcane-purple':{label:'Arcano viola',accent:'#c66cff',border:'#9b50d2',glow:'#9f47e8',dark:'#160b20',hue:279},
  'celestial-gold':{label:'Oro celestiale',accent:'#f4d77a',border:'#b9943e',glow:'#e9b949',dark:'#21180a',hue:43},
  'abyss-blue':{label:'Blu abissale',accent:'#62a8ff',border:'#3972ba',glow:'#377fdc',dark:'#071426',hue:214},
  'infernal-red':{label:'Rosso infernale',accent:'#ff695e',border:'#b43a38',glow:'#e03d3a',dark:'#240b0c',hue:3},
  'forest-green':{label:'Verde foresta',accent:'#70dc8e',border:'#3a9d60',glow:'#38b965',dark:'#081d12',hue:141},
  'cyber-cyan':{label:'Ciano cyber',accent:'#51e8e4',border:'#2aa7aa',glow:'#27cfce',dark:'#061d20',hue:179},
  'royal-white':{label:'Bianco reale',accent:'#f2edff',border:'#aaa0c8',glow:'#b8a8ef',dark:'#171521',hue:253},
  'shadow-black':{label:'Nero ombra',accent:'#aaa7bb',border:'#555363',glow:'#706d88',dark:'#08080d',hue:252}
};

export function normalizeDeckTheme(value){return Object.hasOwn(DECK_THEMES,value)?value:DEFAULT_DECK_THEME;}
export function normalizeDeckBoxTemplate(value){return Object.hasOwn(DECK_BOX_TEMPLATES,value)?value:DEFAULT_DECK_BOX_TEMPLATE;}
export function deckThemeOptions(selected){const current=normalizeDeckTheme(selected);return Object.entries(DECK_THEMES).map(([value,theme])=>`<option value="${value}" ${value===current?'selected':''}>${esc(theme.label)}</option>`).join('');}

export function resolveDeckSignature(deck){
  const cards=deck?.cards||[],id=String(deck?.signatureCardId||'');
  if(id){const selected=cards.find(card=>String(card.catalogCardId)===id);if(selected)return selected;}
  // One Piece: il Leader è la "faccia" del mazzo (1 copia sola, sempre
  // significativa) — priorità sul Main come cover di default, non un
  // ripiego. Un mazzo con solo il Leader scelto deve già avere una cover.
  if(deck?.game==='onepiece')return cards.find(card=>card.section==='leader')||cards.find(card=>card.section==='main')||null;
  return cards.find(card=>card.section==='main')||cards.find(card=>card.section==='extra')||null;
}

export function preferredDeckArtwork(card){
  if(!card)return'';const source=String(card.croppedImageUrl||card.imageUrl||'');
  if(/\/images\/cards\/\d+\.jpg(?:\?|$)/i.test(source))return source.replace(/\/images\/cards\//i,'/images/cards_cropped/');
  const id=String(card.catalogCardId||'');return /^\d+$/.test(id)?`https://images.ygoprodeck.com/images/cards_cropped/${id}.jpg`:source;
}

export function deckBoxModel(deck,{availability=null,marketValue=null,marketIndicative=false,marketCoverage='',delta24=null,delta7=null,topMover=null}={}){
  const signature=resolveDeckSignature(deck),template=normalizeDeckBoxTemplate(deck?.deckBoxTemplate),templatePreset=DECK_BOX_TEMPLATES[template],theme=normalizeDeckTheme(deck?.deckTheme||templatePreset.theme),preset=DECK_THEMES[theme];
  return {deckId:String(deck?.id||''),deckName:deck?.name||'Mazzo senza nome',signature,template,templatePreset,artwork:templatePreset.image||preferredDeckArtwork(signature),theme,preset,
    statLine:deckBoxStatLine(deck),availability,marketValue,marketIndicative,marketCoverage,delta24,delta7,topMover};
}

// Ogni gioco ha la sua riga di stato sulla card del Deck Box: Main/Extra/Side
// per Yu-Gi-Oh, Leader/Main/DON!! per One Piece — mai un elenco fisso che
// presuppone le sezioni dell'altro gioco (bug corretto 2026-09-09: la card
// mostrava "Main • Extra • Side" anche per i mazzi One Piece).
function deckBoxStatLine(deck){
  if(deck?.game==='onepiece'){
    const {counts}=getGameAdapter('onepiece').validateDeck(deck);
    return [
      {label:'Leader',value:counts.leader.count?'✓':'—'},
      {label:'Main',value:`${counts.main.count}/${counts.main.target}`},
      {label:'DON!!',value:`${counts.don.count}/${counts.don.target}`}
    ];
  }
  return [
    {label:'Main',value:sectionTotal(deck,'main')},
    {label:'Extra',value:sectionTotal(deck,'extra')},
    {label:'Side',value:sectionTotal(deck,'side')}
  ];
}

export function renderDeckBoxCard(deck,options={}){
  const mode=options.mode==='market'?'market':options.mode==='team'?'team':'gallery',model=deckBoxModel(deck,options),action=mode==='market'?'data-market-deck':mode==='team'?'data-deck-open-team':'data-deck-open';
  // Easter egg: la PRIMA volta che un mazzo tocca il 100% di disponibilità
  // (celebrate=true, deciso dal chiamante — non semplicemente "è al 100%",
  // altrimenti riparte a ogni render) lo scheletro ruggisce dentro il
  // riquadro dell'artwork — mai fuori, il video è assoluto dentro
  // .deck-box-visual (che clippa già con overflow:hidden) così resta
  // contenuto nella cornice inclinata del box. Niente autoplay/muted in
  // HTML: l'audio va fatto partire da JS (vedi [data-deck-celebrate] in
  // DeckController.bind(), js/decks.js) perché l'attributo autoplay del
  // browser consente solo video muti — un video con autoplay E audio
  // viene silenziosamente bloccato senza nessun errore da intercettare.
  const celebrate=mode!=='market'&&options.celebrate;
  return `<button class="deck-box-card dynamic-deck-box ${mode==='market'?'market-deck-box':''} ${options.selected?'selected':''} ${options.active?'active':''}" ${themeAttributes(model)} ${action}="${esc(model.deckId)}" aria-label="${mode==='market'?'Apri il valore di':mode==='team'?'Sfoglia il mazzo di':'Apri il mazzo'} ${esc(model.deckName)}"><span class="deck-box-visual ${model.template!=='procedural'?'uses-template':''}">${renderArtwork(model)}${celebrate?'<video class="deck-box-100-video" data-deck-celebrate src="./assets/ester-eggs/skelet_roar.mp4" playsinline preload="auto" aria-hidden="true"></video>':''}<i></i><b>F.P.T</b></span><span class="deck-box-copy"><strong>${esc(model.deckName)}</strong>${mode==='team'?`<small class="deck-owner-badge">${esc(options.ownerName||'')}</small>`:''}<small>${model.statLine.map(s=>`<b>${esc(String(s.value))}</b> ${esc(s.label)}`).join(' <i>•</i> ')}</small>${mode==='market'?marketMeta(model):availabilityMeta(model,mode==='team'?'Disponibilità':'Disponibilità personale')}</span></button>`;
}

export function renderDeckBoxVisual(deck,{className=''}={}){const model=deckBoxModel(deck);return `<div class="deck-preview-box dynamic-deck-box-visual ${model.template!=='procedural'?'uses-template':''} ${esc(className)}" ${themeAttributes(model)}>${renderArtwork(model)}<i></i><b>F.P.T</b></div>`;}

function renderArtwork(model){return model.artwork?`<img class="${model.template!=='procedural'?'deck-box-template-art':'deck-box-signature-art'}" src="${esc(model.artwork)}" alt="${model.template!=='procedural'?`Modello ${esc(model.templatePreset.label)}`:`Artwork di ${esc(model.signature?.cardName||model.deckName)} per il mazzo ${esc(model.deckName)}`}" loading="lazy">`:`<span class="deck-box-fallback">${icon('deck')}<strong>F.P.T</strong><small>CARDS</small></span>`;}
function availabilityMeta(model,label='Disponibilità personale'){if(model.availability==null)return'<em>Disponibilità non disponibile</em>';return `<em class="deck-availability-meter ${model.availability===100?'is-ready':''}" style="--availability-color:${model.availability===100?'#95e65e':model.availability>=90?'#73dca0':'#ffbb48'}">${esc(label)} <b>${model.availability}%</b><i class="deck-mini-ready" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${model.availability}" style="--ready:${model.availability}"></i></em><span class="deck-card-footer"><span>${model.availability===100?'Pronto alla sfida':'In preparazione'}</span><span class="deck-card-open">Apri ${icon('arrow')}</span></span>`;}
function marketMeta(model){return `<span class="deck-market-value">${model.marketValue==null?'Valore non disponibile':`${model.marketIndicative?'Valore indicativo ':'Valore '}${money(model.marketValue)}`}</span>${model.marketIndicative?`<em class="deck-market-deltas"><b>Copertura ${esc(model.marketCoverage||'parziale')}</b><b>Trend escluso</b></em>`:`<em class="deck-market-deltas"><b class="${tone(model.delta24)}">24h ${change(model.delta24)}</b><b class="${tone(model.delta7)}">7d ${change(model.delta7)}</b></em>${model.topMover?`<span class="deck-top-mover">Top mover · ${esc(model.topMover.cardName)} ${change(model.topMover.percent)}</span>`:''}`}`;}
function themeAttributes(model){const t=model.preset;return `data-deck-theme="${model.theme}" data-deck-template="${model.template}" style="--deck-hue:${t.hue};--deck-accent:${t.accent};--deck-border:${t.border};--deck-glow:${t.glow};--deck-dark:${t.dark}"`;}
function sectionTotal(deck,section){return (deck?.cards||[]).filter(card=>card.section===section).reduce((sum,card)=>sum+Number(card.quantity||0),0);}
function money(value){return new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR',useGrouping:true}).format(Number(value));}
function change(value){if(value==null||!Number.isFinite(Number(value)))return'—';const number=Number(value);return `${number>=0?'+':'−'}${Math.abs(number).toFixed(1)}%`;}
function tone(value){return value==null?'muted':value>0?'positive':value<0?'negative':'muted';}
