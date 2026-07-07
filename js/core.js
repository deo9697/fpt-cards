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
export const state = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') || { currentUser: null, role: null, loans: [] };
if (!state.game) state.game = 'yugioh';
if (Array.isArray(state.members) && state.members.length) setMembers(state.members);
export const GAMES = {
  yugioh: { id:'yugioh', name:'Yu-Gi-Oh!', short:'Yu-Gi-Oh!', mark:'Y' },
  onepiece: { id:'onepiece', name:'One Piece Card Game', short:'One Piece', mark:'OP' }
};
export function saveState() { localStorage.setItem(STATE_KEY, JSON.stringify(state)); }
export function member(id) { return MEMBERS.find(item => item.id === id); }
export function initials(name) { return name.split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase(); }
export function esc(value) { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
export function formatDate(value) { return new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium' }).format(new Date(value)); }
