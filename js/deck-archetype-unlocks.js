// Deck Box sbloccabili per archetipo (richiesta utente 2026-09-11): 10
// vittorie CONSECUTIVE registrate nelle statistiche con un mazzo che
// rispetta una composizione minima. Isolato qui, fuori da js/cosmetics.js
// (che resta generico, non deve sapere cos'è un "Orcust") e fuori da
// js/decks.js/js/stats.js — un solo posto dove aggiungere il prossimo
// archetipo o aggiustare un pattern troppo largo/stretto.
//
// Limite accettato consapevolmente (vedi supabase/migrations/*_deck_win_
// streak.sql): non esiste uno snapshot della composizione del mazzo al
// momento di ogni vittoria passata — la striscia conta i match storici
// collegati al deck_id, ma la composizione viene verificata sullo stato
// ATTUALE di quel mazzo. Stessa imprecisione "client-trust" già accettata
// da tutto il resto del sistema cosmetics (claim_cosmetic non valida nulla
// lato server).
//
// Conteggio: somma le QUANTITÀ delle carte che matchano il pattern (non le
// righe distinte) su tutte le sezioni del mazzo — un 3x della stessa carta
// conta 3, non 1.
function matchCount(deck, pattern) {
  return (deck?.cards || []).reduce((sum, card) => sum + (pattern.test(card.cardName || '') ? Number(card.quantity || 0) : 0), 0);
}

// "Zero"/"Raye"/"Roze" sono parole corte e potenzialmente generiche: \b
// (confine di parola) riduce i falsi positivi rispetto a un .includes()
// puro. Se in futuro un'altra carta del catalogo Yu-Gi-Oh contiene una di
// queste parole senza essere la carta Skystriker voluta, va segnalato e il
// pattern va stretto (es. lista esplicita di catalogCardId invece del nome).
export const ARCHETYPE_RULES = {
  sacred_beast_orcust: deck => matchCount(deck, /orcust/i) >= 1 && matchCount(deck, /sacred beast/i) >= 1,
  mitsurugi: deck => matchCount(deck, /mitsurugi/i) >= 4,
  skystriker: deck => (matchCount(deck, /\bzero\b/i) >= 2 && matchCount(deck, /\braye\b/i) >= 3) || matchCount(deck, /\broze\b/i) >= 2
};

const REQUIRED_STREAK = 10;

// slug -> [deckbox cosmetic id, title cosmetic id] abbinato — vedi
// js/cosmetics.js per le definizioni complete.
const UNLOCK_PAIRS = {
  sacred_beast_orcust: ['deckbox_sacred_beast_orcust', 'title_apocaliptic_symphony'],
  mitsurugi: ['deckbox_mitsurugi', 'title_rivelo_abakiri'],
  skystriker: ['deckbox_skystriker', 'title_heaven_striker']
};

// Chiamata da stats.js dopo ogni vittoria registrata (deck = il mazzo usato,
// già nello state locale — non serve ricaricarlo). Interroga get_deck_win_
// streak SOLO per gli archetipi la cui composizione è già soddisfatta ORA,
// per non sprecare una RPC ad ogni vittoria per condizioni palesemente non
// ancora in gioco. Ritorna gli id dei cosmetic appena sbloccati (per un
// toast), non tocca lo stato — chi chiama decide come aggiornare
// cosmetics.unlocked.
export async function checkDeckArchetypeUnlocks(deck, api, unlockedIds) {
  if (!deck) return [];
  const unlocked = new Set(unlockedIds || []);
  const claimed = [];
  for (const [slug, rule] of Object.entries(ARCHETYPE_RULES)) {
    const [deckboxId, titleId] = UNLOCK_PAIRS[slug];
    if (unlocked.has(deckboxId) && unlocked.has(titleId)) continue;
    if (!rule(deck)) continue;
    let streak = 0;
    try { streak = await api.deckWinStreak(deck.id); } catch { continue; }
    if (streak < REQUIRED_STREAK) continue;
    for (const cosmeticId of [deckboxId, titleId]) {
      if (unlocked.has(cosmeticId)) continue;
      try { await api.claimCosmetic(cosmeticId); claimed.push(cosmeticId); } catch {}
    }
  }
  return claimed;
}
