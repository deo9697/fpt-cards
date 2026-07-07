const paths = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10M9 20v-6h6v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  swap: '<path d="m7 7-4 4 4 4M3 11h14M17 3l4 4-4 4M21 7H7"/>',
  team: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-4 2-6 6-6s6 2 6 6M16 4a3 3 0 0 1 0 6M17 14c2.7.3 4 2.3 4 5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'
  ,menu: '<path d="M4 7h16M4 12h16M4 17h16"/>'
  ,card: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>'
};
export function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
}
