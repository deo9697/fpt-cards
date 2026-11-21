// In-place DOM update for the duel table (2026-11-21).
// A full page re-render recreated every card image on each server response
// (~20 <img> per render, p95 ~200 ms on phones). This patches the existing
// tree instead: unchanged nodes (and their decoded images, scroll positions and
// delegated listeners on the root) are kept; only differences are written.
// Cards are matched by data-ygo-card so a card leaving the hand does not shift
// every other image.

const keyOf = node => node.nodeType === 1 ? node.getAttribute('data-ygo-card') : null;
const sameKind = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);

function syncAttributes(target, source, keep) {
  for (const { name } of [...target.attributes]) if (!source.hasAttribute(name) && !keep?.has(name)) target.removeAttribute(name);
  for (const { name, value } of source.attributes) if (target.getAttribute(name) !== value) target.setAttribute(name, value);
}

function syncFormState(target, source) {
  if (target.ownerDocument?.activeElement === target) return;
  if (target.tagName === 'INPUT') {
    if (target.type === 'checkbox' || target.type === 'radio') target.checked = source.hasAttribute('checked');
    else if (target.value !== (source.getAttribute('value') ?? '')) target.value = source.getAttribute('value') ?? '';
  } else if (target.tagName === 'TEXTAREA') {
    if (target.value !== source.textContent) target.value = source.textContent;
  }
}

function patchNode(target, source) {
  if (target.nodeType !== 1) { if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue; return; }
  syncAttributes(target, source);
  patchChildren(target, source);
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') syncFormState(target, source);
  else if (target.tagName === 'SELECT' && target.ownerDocument?.activeElement !== target) {
    const selected = source.querySelector('option[selected]');
    if (selected && target.value !== selected.value) target.value = selected.value;
  }
}

function patchChildren(target, source) {
  const keyed = new Map();
  for (const node of target.childNodes) { const key = keyOf(node); if (key) keyed.set(key, node); }
  let index = 0;
  for (const next of [...source.childNodes]) {
    const current = target.childNodes[index] || null, key = keyOf(next);
    let match = null;
    if (key) { match = keyed.get(key) || null; if (match && !sameKind(match, next)) match = null; if (match) keyed.delete(key); }
    else if (current && !keyOf(current) && sameKind(current, next)) match = current;
    if (match) { if (match !== current) target.insertBefore(match, current); patchNode(match, next); }
    else target.insertBefore(next, current);
    index++;
  }
  while (target.childNodes.length > index) target.lastChild.remove();
}

/** Patches `root` to match `html` (a single root element of the same tag). Returns false if it cannot. */
export function patchElement(root, html, { keepAttributes = [] } = {}) {
  const doc = root?.ownerDocument;
  if (!doc) return false;
  const template = doc.createElement('template');
  template.innerHTML = html.trim();
  const next = template.content.firstElementChild;
  if (!next || template.content.childElementCount !== 1 || next.tagName !== root.tagName) return false;
  syncAttributes(root, next, new Set(keepAttributes));
  patchChildren(root, next);
  return true;
}
