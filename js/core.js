export const MEMBERS = [
  { id: 'daniele', name: 'Daniele de Oliveira', role: 'admin' },
  { id: 'cristian-arlia', name: 'Cristian Arlia', role: 'guest' },
  { id: 'cristian-spadafora', name: 'Cristian Spadafora', role: 'guest' },
  { id: 'cristofer', name: 'Cristofer Marincolo', role: 'guest' },
  { id: 'giuseppe-ventre', name: 'Giuseppe Ventre', role: 'guest' },
  { id: 'antonio-donato', name: 'Antonio Donato', role: 'guest' },
  { id: 'vittorio-oro-jackson', name: 'Vittorio Oro Jackson', role: 'guest' },
  { id: 'mirco-sposato', name: 'Mirco Sposato', role: 'guest' },
  { id: 'ivo-scalercio', name: 'Ivo Scalercio', role: 'guest' },
  { id: 'antonello-napolitano', name: 'Antonello Napolitano', role: 'guest' },
  { id: 'matteo-scorza', name: 'Matteo Scorza', role: 'guest' },
  { id: 'vincenzo-de-marco', name: 'Vincenzo De Marco', role: 'guest' }
];
export function setMembers(items) {
  if (!Array.isArray(items) || !items.length) return;
  MEMBERS.splice(0, MEMBERS.length, ...items.map(item => ({
    id:item.slug || item.id, name:item.full_name || item.name, role:item.role || 'guest'
  })));
}

const STATE_KEY = 'fpt-cards-state-v2';
export const state = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') || { currentUser: null, role: null, canVerifyYgoArtwork: false, loans: [] };
if (!state.game) state.game = 'yugioh';
if (!state.collection || typeof state.collection !== 'object') state.collection = { mine:[], team:[], syncedAt:null };
if (!Array.isArray(state.collection.mine)) state.collection.mine = [];
if (!Array.isArray(state.collection.team)) state.collection.team = [];
if (!Array.isArray(state.decks)) state.decks = [];
if (Array.isArray(state.members) && state.members.length) setMembers(state.members);
export const GAMES = {
  yugioh: { id:'yugioh', name:'Yu-Gi-Oh!', short:'Yu-Gi-Oh!', logo:'assets/game-logos/yugioh-tcg.png' },
  onepiece: { id:'onepiece', name:'One Piece Card Game', short:'One Piece', logo:'assets/game-logos/onepiece.webp' }
};
export const FUTURE_GAMES = [
  { id:'magic', name:'Magic: The Gathering', logo:'assets/game-logos/magic.png' },
  { id:'pokemon', name:'Pokémon TCG', logo:'assets/game-logos/pokemon.png' }
];
// localStorage ha una quota per origine (in genere 5-10MB): una collezione
// cresciuta nel tempo (migliaia di carte, prestiti, mazzi) può superarla.
// Prima di questo fix, il QuotaExceededError di setItem interrompeva
// qualunque chiamante a metà — es. updateLoan() falliva DOPO che la RPC
// (accetta/conferma prestito) era già andata a buon fine server-side,
// mostrando all'utente il testo grezzo dell'eccezione del browser ("Failed
// to execute 'setItem' on 'Storage'...") al posto del toast di successo, e
// senza mai richiamare render() — il prestito sembrava non essersi
// aggiornato anche se in realtà lo era. La cache locale resta un
// acceleratore per la ripresa offline, mai una condizione per completare
// un'azione già confermata dal server: un fallimento qui non deve mai
// bloccare il resto del flusso chiamante.
export function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); }
  catch (error) { console.warn('saveState: scrittura locale non riuscita (quota storage?)', error); }
}
export function member(id) { return MEMBERS.find(item => item.id === id); }
export function initials(name) { return name.split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase(); }
export function esc(value) { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
export function formatDate(value) { return new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium' }).format(new Date(value)); }
