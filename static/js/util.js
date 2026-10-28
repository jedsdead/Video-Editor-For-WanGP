// Small shared helpers.

export async function api(path, { method = "GET", body, raw = false } = {}) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let message = res.statusText;
    try { const data = await res.json(); message = data.detail || message; } catch (_) { /* not json */ }
    throw new Error(message || `HTTP ${res.status}`);
  }
  return raw ? res : res.json();
}

export const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
export const lerp = (a, b, t) => a + (b - a) * t;
let idCounter = 0;
export const uid = (prefix = "id") => `${prefix}_${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function dbToGain(db) { return db <= -60 ? 0 : Math.pow(10, db / 20); }
export function gainToDb(g) { return g <= 0.001 ? -60 : 20 * Math.log10(g); }

export function timecode(sec, fps) {
  fps = fps || 24;
  const sign = sec < 0 ? "-" : "";
  sec = Math.abs(sec);
  const totalFrames = Math.round(sec * fps);
  const f = totalFrames % Math.round(fps);
  const s = Math.floor(totalFrames / fps);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${sign}${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
}

export function shortTime(sec) {
  if (!isFinite(sec)) return "--";
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 2 : 1)}s`;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export class Emitter {
  constructor() { this.handlers = {}; }
  on(name, fn) { (this.handlers[name] ||= []).push(fn); return () => this.off(name, fn); }
  off(name, fn) { this.handlers[name] = (this.handlers[name] || []).filter(h => h !== fn); }
  emit(name, ...args) { for (const fn of [...(this.handlers[name] || [])]) { try { fn(...args); } catch (e) { console.error(e); } } }
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

// el("div.cls#id", {attrs / on*: handlers}, children...)
export function el(spec, attrs = {}, ...children) {
  const [, tag = "div", rest = ""] = spec.match(/^([a-z0-9]+)?(.*)$/i) || [];
  const node = document.createElement(tag || "div");
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === ".") node.classList.add(part.slice(1)); else node.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = {}; }
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "html") node.innerHTML = value;
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function toast(message, type = "info", ms = 3200) {
  const node = el("div.toast", {}, message);
  if (type !== "info") node.classList.add(type);
  document.getElementById("toasts").append(node);
  setTimeout(() => node.remove(), ms);
}

export function isTyping(event) {
  const t = event.target;
  return t && (t.tagName === "INPUT" && !["range", "checkbox", "button", "radio"].includes(t.type) || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

// ------------------------------------------------------------ menus & modals

let openMenuNode = null;
let subMenus = [];   // open submenus, outermost first
export function closeMenu() {
  for (const m of subMenus) m.remove();
  subMenus = [];
  if (openMenuNode) { openMenuNode.remove(); openMenuNode = null; document.querySelectorAll(".menu-btn.open").forEach(b => b.classList.remove("open")); }
}

// Fit a menu inside the window: below/right of (x, y) when there is room, otherwise moved in; tall menus scroll.
function placeMenu(menu, x, y, alignRight = null) {
  const rect = menu.getBoundingClientRect();
  let left = x;
  if (alignRight !== null && left + rect.width > window.innerWidth - 6) left = alignRight - rect.width;
  menu.style.left = `${Math.max(6, Math.min(left, window.innerWidth - rect.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - rect.height - 6))}px`;
}

function buildMenu(items, level) {
  const menu = el("div.menu");
  for (const item of items.filter(Boolean)) {
    if (item === "-") { menu.append(el("div.msep")); continue; }
    if (item.head) { menu.append(el("div.mhead", {}, item.head)); continue; }
    if (item.custom) { menu.append(item.custom); continue; }
    const sub = item.submenu && item.submenu.filter(Boolean);
    const row = el("div.mi", {}, el("span.check", {}, item.check === undefined ? "" : (item.check ? "✓" : "")), el("span", {}, item.label),
      sub ? el("span.kbd.subarrow", {}, "›") : item.kbd ? el("span.kbd", {}, item.kbd) : null);
    if (item.disabled || (sub && !sub.length)) row.classList.add("disabled");
    if (sub) {
      row.classList.add("hassub");
      const open = () => openSubmenu(row, sub, level + 1);
      row.addEventListener("mouseenter", open);
      row.addEventListener("click", (e) => { e.stopPropagation(); open(); });
    } else {
      row.addEventListener("mouseenter", () => closeSubmenusFrom(level + 1));
      row.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); item.action && item.action(); });
    }
    menu.append(row);
  }
  return menu;
}

function closeSubmenusFrom(level) {
  while (subMenus.length >= level) subMenus.pop().remove();
  document.querySelectorAll(".menu .mi.subopen").forEach(r => { if (!r.isConnected || Number(r.dataset.level) >= level) r.classList.remove("subopen"); });
}

function openSubmenu(row, items, level) {
  if (row.classList.contains("subopen") && subMenus[level - 1]) return;
  closeSubmenusFrom(level);
  row.closest(".menu").querySelectorAll(":scope > .mi.subopen").forEach(r => r.classList.remove("subopen"));
  row.classList.add("subopen");
  row.dataset.level = String(level);
  const menu = buildMenu(items, level);
  document.getElementById("menuLayer").append(menu);
  subMenus.push(menu);
  const r = row.getBoundingClientRect();
  placeMenu(menu, r.right - 2, r.top - 5, r.left + 2);
}

// items: [{label, kbd, action, disabled, check, submenu: [...]}, "-", {head}]
export function showMenu(x, y, items) {
  closeMenu();
  const menu = buildMenu(items, 0);
  document.getElementById("menuLayer").append(menu);
  placeMenu(menu, x, y);
  openMenuNode = menu;
  return menu;
}
document.addEventListener("pointerdown", (e) => {
  if (openMenuNode && !openMenuNode.contains(e.target) && !subMenus.some(m => m.contains(e.target)) && !e.target.closest(".menu-btn")) closeMenu();
});

export function modal({ title, body, buttons = [], narrow = false, onClose }) {
  const layer = document.getElementById("modalLayer");
  const close = () => { backdrop.remove(); onClose && onClose(); };
  const footer = el("footer");
  for (const b of buttons) {
    if (b === "spacer") { footer.append(el("div.spacer")); continue; }
    const btn = el(`button${b.primary ? ".primary" : ""}`, { onclick: () => { if (b.action && b.action() === false) return; if (b.close !== false) close(); } }, b.label);
    if (b.id) btn.id = b.id;
    footer.append(btn);
  }
  const box = el(`div.modal${narrow ? ".narrow" : ""}`, {}, el("header", {}, title, el("button.icon.x", { onclick: close, title: "Close" }, "✕")), el("div.mbody", {}, body), buttons.length ? footer : null);
  const backdrop = el("div.modal-backdrop", {}, box);
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(); });
  layer.append(backdrop);
  const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey, true); e.stopPropagation(); } };
  document.addEventListener("keydown", onKey, true);
  return { close, box, footer };
}

export function prompt_(title, label, value = "") {
  return new Promise((resolve) => {
    const input = el("input", { type: "text", value, style: { width: "100%" } });
    let done = false;
    const m = modal({
      title, narrow: true, body: el("div", {}, el("div.dim", { style: { marginBottom: "6px" } }, label), input),
      buttons: ["spacer", { label: "Cancel" }, { label: "OK", primary: true, action: () => { done = true; resolve(input.value.trim()); } }],
      onClose: () => { if (!done) resolve(null); },
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { done = true; resolve(input.value.trim()); m.close(); } });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

export function confirm_(title, text, okLabel = "OK") {
  return new Promise((resolve) => {
    let done = false;
    modal({ title, narrow: true, body: el("p", {}, text), onClose: () => { if (!done) resolve(false); },
      buttons: ["spacer", { label: "Cancel" }, { label: okLabel, primary: true, action: () => { done = true; resolve(true); } }] });
  });
}
