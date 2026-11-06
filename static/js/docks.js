// Dock system: panels live in the left, right or bottom dock as tabs, can be moved between docks or hidden,
// and dock sizes are resizable. The layout is remembered per browser, and separately for each page (Edit, Colour,
// Audio): a page can also hold panels on its own stage, the area that takes the timeline's place.
import { el, clamp } from "./util.js";

const KEY = "ve_layout_v1";
const DOCKS = ["left", "right", "bottom"];

// Each page's starting layout, over the Edit page's: placement, active tabs and sizes.
const PAGE_PRESETS = {
  colour: { placement: { colour: "stage", shots: "stage", scopes: "right", inspector: "hidden", mixer: "hidden", spectrum: "hidden" },
            active: { right: "scopes", left: "media" }, sizes: { lower: 470, right: 420 } },
  audio: { placement: { mixer: "bottom", spectrum: "right", inspector: "right", effects: "left", colour: "hidden", scopes: "hidden", shots: "hidden" },
           active: { right: "inspector", left: "effects", bottom: "mixer" }, sizes: { lower: 460, bottom: 640, right: 380 } },
};

export class Docks {
  constructor(panels) {
    this.panels = panels;              // [{id, title, node, dock, onShow, onHide}]
    this.byId = Object.fromEntries(panels.map(p => [p.id, p]));
    const defaults = {
      placement: Object.fromEntries(panels.map(p => [p.id, p.dock])),
      active: { left: panels.find(p => p.dock === "left")?.id, right: panels.find(p => p.dock === "right")?.id, bottom: panels.find(p => p.dock === "bottom")?.id },
      sizes: { left: 300, right: 340, bottom: 430, lower: 340 },
      floats: {},
    };
    this.defaults = JSON.parse(JSON.stringify(defaults));
    this.page = "edit";
    this.key = KEY;
    this.layout = this.load();
    this.floatLayer = document.getElementById("floatLayer");
    this.floatEls = {};
    this.z = 10;
    this.dockEls = Object.fromEntries(DOCKS.map(d => [d, document.getElementById(`dock-${d}`)]));
    this.splitters = Object.fromEntries([...document.querySelectorAll(".splitter")].map(s => [s.dataset.split, s]));
    for (const s of Object.values(this.splitters)) s.addEventListener("pointerdown", (e) => this.startResize(e, s.dataset.split));
    this.render();
  }

  // The current page's layout: saved, or the page's preset over the Edit page's defaults.
  pageDefaults(page = this.page) {
    const d = JSON.parse(JSON.stringify(this.defaults));
    const pr = PAGE_PRESETS[page];
    if (!pr) return d;
    return { ...d, placement: { ...d.placement, ...pr.placement }, active: { ...d.active, ...pr.active }, sizes: { ...d.sizes, ...pr.sizes } };
  }
  load() {
    const defaults = this.pageDefaults();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this.key) || "null"); } catch (_) { saved = null; }
    // a panel that only a page's stage can hold goes back to its dock on another page
    if (saved && this.page === "edit") for (const [id, d] of Object.entries(saved.placement || {})) if (d === "stage") saved.placement[id] = defaults.placement[id];
    return saved ? { ...defaults, ...saved, placement: { ...defaults.placement, ...saved.placement }, active: { ...defaults.active, ...saved.active },
                     sizes: { ...defaults.sizes, ...saved.sizes }, floats: { ...(saved.floats || {}) } } : defaults;
  }
  setPage(page) {
    if (page === this.page) return;
    this.save();
    this.page = page;
    this.key = page === "edit" ? KEY : `${KEY}_${page}`;
    this.layout = this.load();
    this.render();
  }
  save() { try { localStorage.setItem(this.key, JSON.stringify(this.layout)); } catch (_) { /* storage blocked */ } }

  visible(id) {
    const dock = this.layout.placement[id];
    if (dock === "float" || dock === "stage") return true;
    return dock && dock !== "hidden" && this.layout.active[dock] === id;
  }

  render() {
    for (const dock of DOCKS) {
      const node = this.dockEls[dock];
      const panels = this.panels.filter(p => this.layout.placement[p.id] === dock);
      node.innerHTML = "";
      node.classList.toggle("empty", panels.length === 0);
      const splitter = { left: this.splitters.left, right: this.splitters.right, bottom: this.splitters.bottom }[dock];
      if (splitter) splitter.classList.toggle("hidden", panels.length === 0);
      if (!panels.length) continue;
      if (!panels.find(p => p.id === this.layout.active[dock])) this.layout.active[dock] = panels[0].id;
      const tabs = el("div.dock-tabs");
      const body = el("div.dock-body");
      for (const p of panels) {
        const active = this.layout.active[dock] === p.id;
        tabs.append(el(`button.dock-tab${active ? ".active" : ""}`, { onclick: () => this.activate(p.id), title: "Right-click to move or hide",
          oncontextmenu: (e) => { e.preventDefault(); this.onTabMenu && this.onTabMenu(e.clientX, e.clientY, p.id); } }, p.title));
        p.node.classList.add("panel");
        p.node.classList.toggle("active", active);
        body.append(p.node);
      }
      node.append(tabs, body);
      node.style.width = dock === "bottom" ? `${this.layout.sizes.bottom}px` : `${this.layout.sizes[dock]}px`;
    }
    document.getElementById("lower").style.height = `${this.layout.sizes.lower}px`;
    // the page's stage: its panels in their listed order
    const stage = document.getElementById("stage");
    if (stage) {
      const onStage = this.panels.filter(p => this.layout.placement[p.id] === "stage");
      stage.innerHTML = "";
      for (const p of onStage) { p.node.classList.add("panel", "active", "on-stage"); stage.append(p.node); }
      for (const p of this.panels) if (this.layout.placement[p.id] !== "stage") p.node.classList.remove("on-stage");
      stage.hidden = !onStage.length;
    }
    this.renderFloats();
    for (const p of this.panels) {
      const vis = this.visible(p.id);
      if (vis && !p._visible) p.onShow && p.onShow();
      if (!vis && p._visible) p.onHide && p.onHide();
      p._visible = vis;
    }
    window.dispatchEvent(new Event("resize"));
  }

  // Floating windows: drag the title bar to move, the corner to resize; buttons send the panel back to a dock.
  renderFloats() {
    const floating = this.panels.filter(p => this.layout.placement[p.id] === "float");
    for (const id of Object.keys(this.floatEls)) if (!floating.find(p => p.id === id)) { this.floatEls[id].remove(); delete this.floatEls[id]; }
    floating.forEach((p, i) => {
      const r = this.layout.floats[p.id] ||= { x: 120 + i * 30, y: 90 + i * 30, w: 380, h: 460 };
      r.x = clamp(r.x, 0, Math.max(0, window.innerWidth - 80)); r.y = clamp(r.y, 0, Math.max(0, window.innerHeight - 40));
      let win = this.floatEls[p.id];
      if (!win) {
        const head = el("div.float-head", {}, el("span", {}, p.title), el("div.spacer"),
          ...[["left", "⇤", "Dock left"], ["right", "⇥", "Dock right"], ["bottom", "⤓", "Dock at the bottom"], ["hidden", "✕", "Hide"]].map(([d, icon, title]) =>
            el("button.icon", { title, onclick: (e) => { e.stopPropagation(); this.place(p.id, d); this.onLayoutChange && this.onLayoutChange(); } }, icon)));
        const body = el("div.float-body");
        win = el("div.float-win", {}, head, body);
        win.addEventListener("pointerdown", () => { win.style.zIndex = ++this.z; });
        head.addEventListener("pointerdown", (e) => {
          if (e.target.closest("button")) return;
          e.preventDefault();
          head.setPointerCapture(e.pointerId);
          const sx = e.clientX, sy = e.clientY, ox = r.x, oy = r.y;
          const move = (ev) => { r.x = clamp(ox + ev.clientX - sx, 0, window.innerWidth - 80); r.y = clamp(oy + ev.clientY - sy, 0, window.innerHeight - 40); win.style.left = `${r.x}px`; win.style.top = `${r.y}px`; };
          const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); this.save(); };
          head.addEventListener("pointermove", move);
          head.addEventListener("pointerup", up);
        });
        new ResizeObserver(() => {
          if (!win.isConnected) return;
          const w = win.offsetWidth, h = win.offsetHeight;
          if (w && h && (Math.abs(w - r.w) > 1 || Math.abs(h - r.h) > 1)) { r.w = w; r.h = h; this.saveSoon(); window.dispatchEvent(new Event("resize")); }
        }).observe(win);
        this.floatLayer.append(win);
        this.floatEls[p.id] = win;
        win.style.zIndex = ++this.z;
      }
      Object.assign(win.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      const body = win.querySelector(".float-body");
      p.node.classList.add("panel", "active");
      if (p.node.parentElement !== body) body.append(p.node);
    });
  }
  saveSoon() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.save(), 300); }

  activate(id) {
    const dock = this.layout.placement[id];
    if (dock === "float") { const w = this.floatEls[id]; if (w) w.style.zIndex = ++this.z; return; }
    if (!dock || dock === "hidden") { this.place(id, this.byId[id].dock); return; }
    this.layout.active[dock] = id;
    this.save();
    this.render();
  }
  show(id) { this.activate(id); }
  place(id, dock) {
    this.layout.placement[id] = dock;
    if (dock !== "hidden") this.layout.active[dock] = id;
    this.save();
    this.render();
  }
  reset() { this.layout = this.pageDefaults(); this.save(); this.render(); }

  startResize(e, which) {
    e.preventDefault();
    const splitter = this.splitters[which];
    splitter.classList.add("dragging");
    splitter.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, sizes: { ...this.layout.sizes } };
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      const s = this.layout.sizes;
      if (which === "left") s.left = clamp(start.sizes.left + dx, 200, window.innerWidth * 0.5);
      if (which === "right") s.right = clamp(start.sizes.right - dx, 220, window.innerWidth * 0.55);
      if (which === "bottom") s.bottom = clamp(start.sizes.bottom - dx, 200, window.innerWidth * 0.6);
      if (which === "timeline") s.lower = clamp(start.sizes.lower - dy, 140, window.innerHeight - 220);
      this.dockEls.left.style.width = `${s.left}px`;
      this.dockEls.right.style.width = `${s.right}px`;
      this.dockEls.bottom.style.width = `${s.bottom}px`;
      document.getElementById("lower").style.height = `${s.lower}px`;
    };
    const up = () => {
      splitter.classList.remove("dragging");
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
      this.save();
      window.dispatchEvent(new Event("resize"));
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
  }

  // Rows for the View menu: one per panel with Left / Right / Bottom / Hide choices.
  menuItems() {
    const items = [{ head: "Panels" }];
    for (const p of this.panels) {
      const current = this.layout.placement[p.id];
      const opts = el("span.opts");
      for (const [dock, label] of [["left", "Left"], ["right", "Right"], ["bottom", "Bottom"], ["float", "Float"], ["hidden", "Hide"]]) {
        opts.append(el(`span${current === dock ? ".on" : ""}`, { onclick: (e) => { e.stopPropagation(); this.place(p.id, dock); this.onLayoutChange && this.onLayoutChange(); } }, label));
      }
      items.push({ custom: el("div.mi.plain", {}, el("span.check"), el("span", { style: { minWidth: "80px" } }, p.title), opts) });
    }
    return items;
  }
}
