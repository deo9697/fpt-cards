// Metadati di presentazione per le missioni giornaliere. Id/target/xp reward
// "veri" restano lato server (get_my_daily_missions in
// supabase-milestone-10-daily-missions.sql) — qui solo label/icona/testo,
// stesso schema di separazione già usato per COSMETICS in cosmetics.js.
export const DAILY_MISSIONS_META = {
  daily_collection_100: { icon: 'collection', label: 'Aggiorna la raccolta', description: 'Aggiungi 100 carte alla tua collezione' },
  daily_deck_complete: { icon: 'deck', label: 'Mazzo pronto', description: 'Registra un nuovo mazzo' },
  daily_duel_log: { icon: 'trophy', label: 'Scendi in campo', description: "Registra l'esito di un duello" },
};
