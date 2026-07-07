export const MEMBERS = [
  { id: 'daniele', name: 'Daniele de Oliveira', role: 'admin' },
  { id: 'cristian-arlia', name: 'Cristian Arlia', role: 'guest' },
  { id: 'cristian-spadafora', name: 'Cristian Spadafora', role: 'guest' },
  { id: 'cristofer', name: 'Cristofer Marincolo', role: 'guest' }
];

const STATE_KEY = 'fpt-cards-state-v2';
export const state = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') || { currentUser: null, role: null, loans: [] };
if (!state.game) state.game = 'yugioh';
export const GAMES = {
  yugioh: { id:'yugioh', name:'Yu-Gi-Oh!', short:'Yu-Gi-Oh!', mark:'Y' },
  onepiece: { id:'onepiece', name:'One Piece Card Game', short:'One Piece', mark:'OP' }
};
export function saveState() { localStorage.setItem(STATE_KEY, JSON.stringify(state)); }
export function member(id) { return MEMBERS.find(item => item.id === id); }
export function initials(name) { return name.split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase(); }
export function esc(value) { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
export function formatDate(value) { return new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium' }).format(new Date(value)); }
