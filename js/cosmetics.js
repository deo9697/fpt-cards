// Catalogo cosmetici (avatar/titoli sbloccabili ed equipaggiabili) — un solo
// posto dove aggiungere nuovi item o nuovi tipi di sblocco, niente
// `if (level >= 5) ...` sparso per l'app. Lo stato "cosa ho sbloccato/cosa
// ho equipaggiato" vive nel database (supabase-milestone-9-cosmetics.sql);
// questo file decide solo QUANDO un item è sbloccabile e COME mostrarlo.
//
// Ogni cosmetic: { id, type:'avatar'|'title', label, unlock:{type,value}, ... }.
// Tipi di unlock supportati oggi: 'level' (richiede progression.level >= value,
// sempre vero per value<=1), 'achievement' (richiede che context.rivalWins
// abbia almeno unlock.value vittorie contro unlock.opponentSlug — vedi
// get_rival_wins in supabase-milestone-14-rival-avatars.sql) ed 'event'
// (nessuna condizione calcolabile: sbloccato SOLO quando chi trigghera
// l'easter egg corrispondente chiama api.claimCosmetic() direttamente nel
// momento in cui l'utente lo vede — isCosmeticUnlocked() torna sempre false
// per questi, non c'è uno stato da ricontrollare al login). Pensato per
// estendersi ulteriormente a 'daily' | 'admin' | 'special' senza cambiare
// la struttura sopra.

export const COSMETICS = [
  // Avatar: per ora solo il mascotte "Tonno" (artwork reale, non più
  // placeholder), sempre sbloccato da LV1 — lo Starter Avatar Pack
  // Blattaman è stato ritirato in attesa di artwork vero, si riaggiunge
  // qui come nuove voci quando pronto.
  { id:'avatar_tonno', type:'avatar', label:'Tonno', image:'assets/avatars/avatar-tonno.jpg', unlock:{ type:'level', value:1 } },

  // Avatar segreti "rivalità": si sbloccano battendo un compagno specifico
  // N volte, su tutti i match mai giocati (qualsiasi gioco) — niente livello
  // richiesto da mostrare, la condizione resta volutamente non rivelata
  // finché non scatta (isCosmeticUnlocked() torna sempre false per questi
  // finché chi chiama non passa context.rivalWins, cosa che oggi fa solo
  // stats.js in claimNewCosmetics() — il selettore "Personalizza" in app.js
  // non passa context, quindi li mostra sempre bloccati senza spoilerarli).
  { id:'avatar_nellento', type:'avatar', label:'Nellento', image:'assets/avatars/nellentone.jpeg', unlock:{ type:'achievement', opponentSlug:'cristian-spadafora', value:5 } },
  { id:'avatar_christofer', type:'avatar', label:'Christofer', image:'assets/avatars/cristofer.jpeg', unlock:{ type:'achievement', opponentSlug:'cristofer', value:5 } },
  { id:'avatar_capeleira', type:'avatar', label:'Capeleira', image:'assets/avatars/capeleira.jpeg', unlock:{ type:'achievement', opponentSlug:'daniele', value:5 } },

  // Titoli: gli stessi 5 già calcolati automaticamente da titleForLevel() in
  // progression.js, portati nel catalogo così passano dallo stesso sistema
  // sblocca/equipaggia invece di essere "sempre quello massimo raggiunto" —
  // un membro di LV20 può tornare a mostrare "Tonno" se preferisce.
  { id:'title_tonno', type:'title', label:'Tonno', unlock:{ type:'level', value:1 } },
  { id:'title_totonno', type:'title', label:'Totonno', unlock:{ type:'level', value:10 } },
  { id:'title_totorchio', type:'title', label:'Totorchio', unlock:{ type:'level', value:20 } },
  { id:'title_totorchiomon', type:'title', label:'Totorchiomon', unlock:{ type:'level', value:30 } },
  { id:'title_metal_war_totorchiomon', type:'title', label:'Metal War Totorchiomon', unlock:{ type:'level', value:40 } },

  // Titoli "rivalità": stessa condizione del rispettivo avatar sopra (stesso
  // opponentSlug/value), così sbloccano insieme in un colpo solo.
  { id:'title_nellento', type:'title', label:'Nello, Ryu-ge Lento', unlock:{ type:'achievement', opponentSlug:'cristian-spadafora', value:5 } },
  { id:'title_christofer', type:'title', label:"L'Altezzoso", unlock:{ type:'achievement', opponentSlug:'cristofer', value:5 } },
  { id:'title_capeleira', type:'title', label:"Capeleira, Malebranche dell'Abisso Bruciante", unlock:{ type:'achievement', opponentSlug:'daniele', value:5 } },

  // Titoli "easter egg": sbloccati assistendo a un easter egg specifico, non
  // da una condizione calcolabile — vedi checkLossStreakEasterEgg() in
  // stats.js (triple sconfitta) e il bind di [data-deck-celebrate] in
  // decks.js (mazzo al 100%), che chiamano claimCosmetic() nel momento
  // esatto in cui l'utente vede il rispettivo video.
  { id:'title_skill_issue', type:'title', label:'Skill Issue', unlock:{ type:'event', value:'triple_loss' } },
  { id:'title_battle_ready', type:'title', label:'Battle Ready', unlock:{ type:'event', value:'deck_100' } }
];

export function isCosmeticUnlocked(cosmetic, progression, context = {}) {
  if (!cosmetic?.unlock) return false;
  const { type, value, opponentSlug } = cosmetic.unlock;
  if (type === 'level') return (progression?.level || 1) >= value;
  if (type === 'achievement') return (context.rivalWins?.[opponentSlug] || 0) >= value;
  // 'event': mai vero qui, va sempre e solo claimato direttamente da chi
  // trigghera l'easter egg — vedi commento sopra COSMETICS.
  return false;
}

export function cosmeticsByType(type) {
  return COSMETICS.filter(item => item.type === type);
}

export function findCosmetic(id) {
  return COSMETICS.find(item => item.id === id) || null;
}

// Cosmetici appena diventati sblocca-bili ma non ancora "claim"-ati lato
// server — chi chiama questa decide cosa farne (di solito: claim silenzioso
// uno per uno all'apertura del profilo, vedi app.js).
export function newlyUnlockedCosmetics(progression, alreadyUnlockedIds, context = {}) {
  const known = new Set(alreadyUnlockedIds || []);
  return COSMETICS.filter(item => !known.has(item.id) && isCosmeticUnlocked(item, progression, context));
}

// Pacchetti (più cosmetici sbloccati dalla stessa condizione, es. il primo
// Avatar Pack a LV5) raggruppati per mostrarli insieme invece che uno alla
// volta — usato dalla vista "Personalizza" per l'intestazione di gruppo.
export function cosmeticPacks(type) {
  const packs = new Map();
  for (const item of cosmeticsByType(type)) {
    const key = item.pack || item.label;
    if (!packs.has(key)) packs.set(key, []);
    packs.get(key).push(item);
  }
  return [...packs.entries()].map(([label, items]) => ({ label, items }));
}
