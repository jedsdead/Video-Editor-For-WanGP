// Collapsible sections: click a section heading (Inspector, Colour, Mixer FX…) or an effect card's name to fold it
// away. Alt+click folds or unfolds every section in that panel. What is folded is remembered in this browser.
const KEY = "ve_collapsed";
let folded;
try { folded = new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch (_) { folded = new Set(); }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...folded].slice(-400))); } catch (_) { /* storage blocked */ } };

// A section is remembered by its heading text (the same section folds for every clip); an effect card by its effect.
function keyOf(node) {
  if (node.dataset.collapseKey) return node.dataset.collapseKey;
  const h = node.querySelector(":scope > h4");
  if (!h) return null;
  const text = [...h.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(" ").trim() || h.textContent.trim();
  return text ? `section:${text.toLowerCase()}` : null;
}

function apply(node) {
  const key = keyOf(node);
  if (key) node.classList.toggle("collapsed", folded.has(key));
}

function toggle(node, force) {
  const key = keyOf(node);
  if (!key) return;
  const on = force ?? !node.classList.contains("collapsed");
  node.classList.toggle("collapsed", on);
  if (on) folded.add(key); else folded.delete(key);
  save();
}

export function initCollapsible(root = document.body) {
  root.addEventListener("click", (e) => {
    if (e.target.closest("input, button, select, textarea, label, a")) return;
    const head = e.target.closest(".insp-section > h4, .fxcard .fxname");
    if (!head) return;
    const node = head.closest(".fxcard") || head.parentElement;
    if (e.altKey && node.classList.contains("insp-section")) {
      const panel = node.closest(".panel, .panel-scroll") || document;
      const fold = !node.classList.contains("collapsed");
      panel.querySelectorAll(".insp-section").forEach(s => toggle(s, fold));
      return;
    }
    toggle(node);
  });
  const scan = (n) => {
    if (n.nodeType !== 1) return;
    if (n.matches(".insp-section, .fxcard")) apply(n);
    n.querySelectorAll?.(".insp-section, .fxcard").forEach(apply);
  };
  new MutationObserver((records) => { for (const r of records) r.addedNodes.forEach(scan); }).observe(root, { childList: true, subtree: true });
  scan(root);
}
