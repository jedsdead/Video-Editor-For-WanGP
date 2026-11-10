// Dock system: panels live in the left, right or bottom dock as tabs, on a page's stage, floating, or hidden.
// Drag a tab (or a floating window's title bar, or a stage panel's grip) to move it: the place it will snap to is
// highlighted, and letting go puts it there; dropped anywhere else it floats. Dock sizes are resizable. The layout is
// remembered per browser, and separately for each page (Edit, Colour, Audio): the Colour and Audio pages also have a
// stage, the area under the viewer that takes the timeline's place (or sits beside it).
import { el, clamp } from "./util.js";

const KEY = "ve_layout_v1";
const DOCKS = ["left", "right", "bottom"];
export const PLACE_NAMES = { left: "Left dock", right: "Right dock", bottom: "Bottom dock", stage: "Stage (under the viewer)", float: "Floating window", hidden: "Hidden" };

// Each page's starting layout, over the Edit page's: placement, active tabs and sizes.
const PAGE_PRESETS = {
  colour: { placement: { colour: "stage", shots: "stage", scopes: "right", inspector: "hidden", mixer: "hidden", spectrum: "hidden" },
            active: { right: "scopes", left: "media" }, sizes: { lower: 470, right: 420 }, stageOrder: ["shots", "colour"] },
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
      stageOrder: [],
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
    return { ...d, placement: { ...d.placement, ...pr.placement }, active: { ...d.active, ...pr.active }, sizes: { ...d.sizes, ...pr.sizes },
             stageOrder: [...(pr.stageOrder || [])] };
  }
  load() {
    const defaults = this.pageDefaults();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this.key) || "null"); } catch (_) { saved = null; }
    // a panel that only a page's stage can hold goes back to its dock on another page
    if (saved && this.page === "edit") for (const [id, d] of Object.entries(saved.placement || {})) if (d === "stage") saved.placement[id] = defaults.placement[id];
    return saved ? { ...defaults, ...saved, placement: { ...defaults.placement, ...saved.placement }, active: { ...defaults.active, ...saved.active },
                     sizes: { ...defaults.sizes, ...saved.sizes }, floats: { ...(saved.floats || {}) },
                     stageOrder: [...(saved.stageOrder || defaults.stageOrder || [])] } : defaults;
  }
  setPage(page) {
    if (page === this.page) return;
    this.save();
    this.page = page;
    this.key = page === "edit" ? KEY : `${KEY}_${page}`;
    this.layout = this.load();
    this.render();
  }
  hasStage() { return this.page !== "edit"; }
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
        const tab = el(`button.dock-tab${active ? ".active" : ""}`, { onclick: () => { if (!this.justDragged) this.activate(p.id); }, title: "Drag to move this panel · right-click for more",
          oncontextmenu: (e) => { e.preventDefault(); this.onTabMenu && this.onTabMenu(e.clientX, e.clientY, p.id); } }, p.title);
        tab.addEventListener("pointerdown", (e) => this.startDrag(e, p.id, tab));
        tabs.append(tab);
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
      const onStage = this.stagePanels();
      stage.innerHTML = "";
      for (const p of onStage) {
        p.node.classList.add("panel", "active", "on-stage");
        const grip = el("div.stage-head", { title: "Drag to move this panel · right-click for more",
          oncontextmenu: (e) => { e.preventDefault(); this.onTabMenu && this.onTabMenu(e.clientX, e.clientY, p.id); } },
          el("span.grip", {}, "⠿"), el("span", {}, p.title), el("div.spacer"),
          el("button.icon", { title: "Hide", onclick: (e) => { e.stopPropagation(); this.place(p.id, "hidden"); } }, "✕"));
        grip.addEventListener("pointerdown", (e) => { if (!e.target.closest("button")) this.startDrag(e, p.id, grip); });
        stage.append(el(`div.stage-item${p.id === "shots" ? ".fixed" : ""}`, { dataset: { panel: p.id } }, grip, p.node));
      }
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
          // a floating window snaps into a dock or the stage when let go over one (highlighted while over it)
          const zones = this.dropZones(p.id, false);
          let target = null;
          const move = (ev) => {
            r.x = clamp(ox + ev.clientX - sx, 0, window.innerWidth - 80); r.y = clamp(oy + ev.clientY - sy, 0, window.innerHeight - 40);
            win.style.left = `${r.x}px`; win.style.top = `${r.y}px`;
            target = this.zoneAt(zones, ev.clientX, ev.clientY);
            this.showHint(target);
          };
          const up = () => {
            head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up);
            this.showHint(null);
            if (target) { this.drop(p.id, target); this.onLayoutChange && this.onLayoutChange(); } else this.save();
          };
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
  // the stage's panels, in their order (top to bottom)
  stagePanels() {
    const on = this.panels.filter(p => this.layout.placement[p.id] === "stage");
    const order = this.layout.stageOrder || [];
    const rank = (p) => { const i = order.indexOf(p.id); return i < 0 ? order.length + this.panels.indexOf(p) : i; };
    return on.sort((a, b) => rank(a) - rank(b));
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
    if (dock === "stage" && !this.hasStage()) dock = this.byId[id].dock;
    if (dock === "stage" && this.layout.placement[id] !== "stage") {
      this.layout.stageOrder = (this.layout.stageOrder || []).filter(x => x !== id);
      // the shot strip goes back on top, under the viewer; anything else below what's there
      if (id === "shots") this.layout.stageOrder.unshift(id); else this.layout.stageOrder.push(id);
    }
    this.layout.placement[id] = dock;
    if (DOCKS.includes(dock)) this.layout.active[dock] = id;
    this.save();
    this.render();
  }

  // ---- dragging panels into place ----
  // Where a panel can go, as screen rectangles: each dock (or, while it's empty, a strip where it would open), the
  // stage (on the Colour and Audio pages) with the slot between its panels, and floating anywhere else.
  dropZones(id) {
    const rect = (n) => n && n.offsetParent !== null ? n.getBoundingClientRect() : null;
    const upper = document.getElementById("upper").getBoundingClientRect();
    const lower = document.getElementById("lower");
    const lr = rect(lower);
    const zones = [];
    const strip = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });
    const add = (place, r, extra = {}) => { if (r && r.width > 4 && r.height > 4) zones.push({ place, r, ...extra }); };
    for (const dock of DOCKS) {
      const n = this.dockEls[dock];
      if (getComputedStyle(n).display === "none") continue;
      const has = this.panels.some(p => p.id !== id && this.layout.placement[p.id] === dock);
      if (has) { add(dock, rect(n)); continue; }
      // empty: a strip at the edge where it would open
      if (dock === "left") add(dock, strip(upper.left, upper.top, Math.min(this.layout.sizes.left, upper.width * 0.3), upper.height), { ghost: true });
      if (dock === "right") add(dock, strip(upper.right - Math.min(this.layout.sizes.right, upper.width * 0.3), upper.top, Math.min(this.layout.sizes.right, upper.width * 0.3), upper.height), { ghost: true });
      if (dock === "bottom" && lr) { const w = Math.min(this.layout.sizes.bottom, lr.width * 0.4); add(dock, strip(lr.right - w, lr.top, w, lr.height), { ghost: true }); }
    }
    if (this.hasStage() && lr) {
      const stage = document.getElementById("stage");
      const items = [...stage.querySelectorAll(":scope > .stage-item")].filter(n => n.dataset.panel !== id);
      if (!stage.hidden && items.length) add("stage", rect(stage), { slots: items.map(n => ({ id: n.dataset.panel, r: n.getBoundingClientRect() })) });
      else {
        const tl = document.getElementById("timelineArea");
        const over = tl && tl.offsetParent !== null ? tl.getBoundingClientRect() : lr;
        // where the stage would open: the whole lower area on the Colour page, beside the timeline on the Audio page
        add("stage", this.page === "colour" ? strip(lr.left, lr.top, lr.width, lr.height) : strip(over.left, over.top, over.width * 0.5, over.height), { ghost: true, slots: [] });
      }
    }
    return zones;
  }
  zoneAt(zones, x, y) {
    const inside = (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    // real docks before the strips where an empty one would open
    const hit = zones.filter(z => inside(z.r)).sort((a, b) => (a.ghost ? 1 : 0) - (b.ghost ? 1 : 0))[0];
    if (!hit) return null;
    if (hit.place !== "stage") return { place: hit.place, r: hit.r };
    // the stage: before the first panel whose middle is below the pointer
    const slots = hit.slots || [];
    let index = slots.length;
    for (let i = 0; i < slots.length; i++) if (y < slots[i].r.top + slots[i].r.height / 2) { index = i; break; }
    const before = slots[index]?.id ?? null;
    let line = null;
    if (slots.length) {
      const yy = index < slots.length ? slots[index].r.top : slots[slots.length - 1].r.bottom;
      line = { left: hit.r.left, right: hit.r.right, y: yy };
    }
    return { place: "stage", r: hit.r, before, line };
  }
  showHint(t) {
    if (!this.hint) {
      this.hint = el("div.dock-drop-hint", { hidden: true }, el("span"));
      this.hintLine = el("div.dock-drop-line", { hidden: true });
      document.body.append(this.hint, this.hintLine);
    }
    this.hint.hidden = !t;
    this.hintLine.hidden = !(t && t.line);
    if (!t) return;
    Object.assign(this.hint.style, { left: `${t.r.left}px`, top: `${t.r.top}px`, width: `${t.r.width ?? t.r.right - t.r.left}px`, height: `${t.r.height ?? t.r.bottom - t.r.top}px` });
    this.hint.firstChild.textContent = PLACE_NAMES[t.place];
    if (t.line) Object.assign(this.hintLine.style, { left: `${t.line.left}px`, top: `${t.line.y - 2}px`, width: `${t.line.right - t.line.left}px` });
  }
  drop(id, t, at = null) {
    if (t.place === "stage") {
      this.layout.placement[id] = "stage";
      const order = this.stagePanels().map(p => p.id).filter(x => x !== id);
      const i = t.before ? order.indexOf(t.before) : -1;
      if (i < 0) order.push(id); else order.splice(i, 0, id);
      this.layout.stageOrder = order;
      this.save(); this.render();
      return;
    }
    if (t.place === "float" && at) {
      const r = this.layout.floats[id] ||= { w: 380, h: 460 };
      r.x = Math.max(0, at.x - 60); r.y = Math.max(0, at.y - 14);
    }
    this.place(id, t.place);
  }
  // Drag from a tab or a stage grip: once it moves a few pixels, a label follows the pointer and the place under it is
  // highlighted; let go to put the panel there, or anywhere else to float it. Esc cancels.
  startDrag(e, id, handle) {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let zones = null, target = null, label = null;
    handle.setPointerCapture(e.pointerId);
    const finish = (commit, ev) => {
      handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", key, true);
      this.showHint(null);
      label?.remove();
      document.body.classList.remove("dock-dragging");
      if (!zones) return;
      this.justDragged = true; setTimeout(() => { this.justDragged = false; }, 0);
      if (!commit) return;
      const t = target || { place: "float" };
      if (t.place === this.layout.placement[id] && t.place !== "stage") { this.activate(id); return; }
      this.drop(id, t, { x: ev.clientX, y: ev.clientY });
      this.onLayoutChange && this.onLayoutChange();
    };
    const move = (ev) => {
      if (!zones) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        zones = this.dropZones(id);
        label = el("div.dock-drag-label", {}, this.byId[id].title);
        document.body.append(label);
        document.body.classList.add("dock-dragging");
      }
      target = this.zoneAt(zones, ev.clientX, ev.clientY);
      this.showHint(target || { place: "float", r: { left: ev.clientX - 60, top: ev.clientY - 14, width: 260, height: 180 } });
      label.style.left = `${ev.clientX + 12}px`; label.style.top = `${ev.clientY + 10}px`;
    };
    const up = (ev) => finish(true, ev);
    const cancel = () => finish(false);
    const key = (ev) => { if (ev.key === "Escape" && zones) { ev.preventDefault(); ev.stopPropagation(); finish(false); } };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
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

  // where a panel can be sent from a menu on this page
  places() {
    return [["left", "Left"], ["right", "Right"], ...(this.page === "colour" ? [] : [["bottom", "Bottom"]]),
            ...(this.hasStage() ? [["stage", "Stage"]] : []), ["float", "Float"], ["hidden", "Hide"]];
  }
  // Rows for the View menu: one per panel with Left / Right / Bottom / Stage / Float / Hide choices.
  menuItems() {
    const items = [{ head: `Panels${this.page === "edit" ? "" : ` (${this.page[0].toUpperCase() + this.page.slice(1)} page)`} · or drag a tab` }];
    for (const p of this.panels) {
      const current = this.layout.placement[p.id];
      const opts = el("span.opts");
      for (const [dock, label] of this.places()) {
        opts.append(el(`span${current === dock ? ".on" : ""}`, { onclick: (e) => { e.stopPropagation(); this.place(p.id, dock); this.onLayoutChange && this.onLayoutChange(); } }, label));
      }
      items.push({ custom: el("div.mi.plain", {}, el("span.check"), el("span", { style: { minWidth: "80px" } }, p.title), opts) });
    }
    return items;
  }
}
