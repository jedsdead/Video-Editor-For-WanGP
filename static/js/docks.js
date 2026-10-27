// Dock system: panels live in the left, right or bottom dock as tabs, can be moved between docks or hidden,
// and dock sizes are resizable. The layout is remembered per browser.
import { el, clamp } from "./util.js";

const KEY = "ve_layout_v1";
const DOCKS = ["left", "right", "bottom"];

export class Docks {
  constructor(panels) {
    this.panels = panels;              // [{id, title, node, dock, onShow, onHide}]
    this.byId = Object.fromEntries(panels.map(p => [p.id, p]));
    const defaults = {
      placement: Object.fromEntries(panels.map(p => [p.id, p.dock])),
      active: { left: panels.find(p => p.dock === "left")?.id, right: panels.find(p => p.dock === "right")?.id, bottom: panels.find(p => p.dock === "bottom")?.id },
      sizes: { left: 300, right: 340, bottom: 430, lower: 340 },
    };
    this.defaults = JSON.parse(JSON.stringify(defaults));
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { saved = null; }
    this.layout = saved ? { ...defaults, ...saved, placement: { ...defaults.placement, ...saved.placement }, active: { ...defaults.active, ...saved.active }, sizes: { ...defaults.sizes, ...saved.sizes } } : defaults;
    this.dockEls = Object.fromEntries(DOCKS.map(d => [d, document.getElementById(`dock-${d}`)]));
    this.splitters = Object.fromEntries([...document.querySelectorAll(".splitter")].map(s => [s.dataset.split, s]));
    for (const s of Object.values(this.splitters)) s.addEventListener("pointerdown", (e) => this.startResize(e, s.dataset.split));
    this.render();
  }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.layout)); } catch (_) { /* storage blocked */ } }

  visible(id) {
    const dock = this.layout.placement[id];
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
    for (const p of this.panels) {
      const vis = this.visible(p.id);
      if (vis && !p._visible) p.onShow && p.onShow();
      if (!vis && p._visible) p.onHide && p.onHide();
      p._visible = vis;
    }
    window.dispatchEvent(new Event("resize"));
  }

  activate(id) {
    const dock = this.layout.placement[id];
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
  reset() { this.layout = JSON.parse(JSON.stringify(this.defaults)); this.save(); this.render(); }

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
      for (const [dock, label] of [["left", "Left"], ["right", "Right"], ["bottom", "Bottom"], ["hidden", "Hide"]]) {
        opts.append(el(`span${current === dock ? ".on" : ""}`, { onclick: (e) => { e.stopPropagation(); this.place(p.id, dock); this.onLayoutChange && this.onLayoutChange(); } }, label));
      }
      items.push({ custom: el("div.mi.plain", {}, el("span.check"), el("span", { style: { minWidth: "80px" } }, p.title), opts) });
    }
    return items;
  }
}
