// Colour panel: lift / gamma / gain wheels with master sliders, plus exposure, contrast, saturation, temperature and tint.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { el, toast, clamp } from "./util.js";
import { ColorWheel, isNeutral } from "./grade.js";

const WHEELS = [["lift", "Lift", -0.5, 0.5], ["gamma", "Gamma", -0.8, 0.8], ["gain", "Gain", -0.8, 0.8]];
const SLIDERS = [["exposure", "Exposure", -3, 3, 0.01, 0], ["contrast", "Contrast", -1, 1, 0.01, 0], ["saturation", "Saturation", 0, 2, 0.01, 1],
                 ["temperature", "Temperature", -1, 1, 0.01, 0], ["tint", "Tint", -1, 1, 0.01, 0]];

export class ColourPanel {
  constructor(app) {
    this.app = app;
    this.wheels = {};
    this.masters = {};
    this.sliders = {};
    this.note = el("div.empty-note", {}, "Select a video clip to grade it.");
    const wheelRow = el("div.wheels");
    for (const [key, label, lo, hi] of WHEELS) {
      const canvas = el("canvas");
      const val = el("span.wval");
      const master = el("input", { type: "range", min: lo, max: hi, step: 0.005, title: `${label} master (luminance). Double-click to reset.` });
      master.addEventListener("input", () => this.apply(`${key}-master`, (g) => { g[key] = { ...g[key], master: parseFloat(master.value) }; }));
      master.addEventListener("dblclick", () => { master.value = 0; this.apply(`${key}-master`, (g) => { g[key] = { ...g[key], master: 0 }; }); });
      this.wheels[key] = new ColorWheel(canvas, { onChange: (v) => this.apply(`${key}-wheel`, (g) => { g[key] = { ...g[key], x: v.x, y: v.y }; }) });
      this.masters[key] = { input: master, val };
      wheelRow.append(el("div.wheel", {}, el("span.wlabel", { title: "Drag to tint. Shift-drag for fine control. Double-click to reset." }, label), canvas, master, val));
    }
    const sliderBox = el("div");
    for (const [key, label, lo, hi, step, dflt] of SLIDERS) {
      const input = el("input", { type: "range", min: lo, max: hi, step });
      const val = el("span.val");
      input.addEventListener("input", () => this.apply(key, (g) => { g[key] = parseFloat(input.value); }));
      input.addEventListener("dblclick", () => { input.value = dflt; this.apply(key, (g) => { g[key] = dflt; }); });
      this.sliders[key] = { input, val };
      sliderBox.append(el("div.field", {}, el("label", {}, label), input, val));
    }
    this.bypass = el("input", { type: "checkbox", onchange: () => this.apply("bypass", (g) => { g.enabled = !this.bypass.checked; }) });
    this.controls = el("div", {},
      el("div.btnrow", { style: { marginBottom: "8px" } },
        el("label", { style: { display: "flex", gap: "4px", alignItems: "center" }, title: "Compare with the ungraded image" }, this.bypass, "Bypass"),
        el("div.spacer"),
        el("button.small", { onclick: () => this.copy() }, "Copy"),
        el("button.small", { onclick: () => this.paste() }, "Paste"),
        el("button.small", { onclick: () => this.reset() }, "Reset")),
      wheelRow, el("div", { style: { height: "10px" } }), sliderBox,
      el("div.dim", { style: { fontSize: "11px", marginTop: "8px" } }, "Changes apply to every selected video clip. Copy/Paste moves a grade between clips (Ctrl+Alt+C / Ctrl+Alt+V)."));
    this.node = el("div", {}, el("div.panel-scroll", {}, this.note, this.controls));
    for (const name of ["selection", "project", "change"]) bus.on(name, () => this.sync());
    this.sync();
  }

  targets() {
    if (!P()) return [];
    return M.selectedClips().filter(c => M.trackKind(c.trackId) === "video");
  }

  apply(key, fn) {
    const ids = this.targets().map(c => c.id);
    if (!ids.length) return;
    M.edit("Colour", () => {
      for (const id of ids) {
        const c = M.getClip(id);
        if (!c) continue;
        const g = JSON.parse(JSON.stringify(c.grade || M.defaultGrade()));
        fn(g);
        c.grade = g;
      }
    }, { coalesceKey: `grade-${key}-${ids.join(",")}` });
  }

  sync() {
    const targets = this.targets();
    this.note.hidden = targets.length > 0;
    this.controls.hidden = targets.length === 0;
    if (!targets.length) return;
    const g = { ...M.defaultGrade(), ...(targets[0].grade || {}) };
    for (const [key] of WHEELS) {
      const w = g[key] || {};
      if (!this.wheels[key].dragging) this.wheels[key].set({ x: w.x || 0, y: w.y || 0 });
      if (document.activeElement !== this.masters[key].input) this.masters[key].input.value = w.master || 0;
      this.masters[key].val.textContent = `${(w.master || 0) >= 0 ? "+" : ""}${(w.master || 0).toFixed(2)}`;
    }
    for (const [key] of SLIDERS) {
      const s = this.sliders[key];
      if (document.activeElement !== s.input) s.input.value = g[key];
      s.val.textContent = Number(g[key]).toFixed(2);
    }
    this.bypass.checked = g.enabled === false;
  }

  copy() {
    const t = this.targets()[0];
    if (!t) return;
    state.gradeClipboard = JSON.parse(JSON.stringify(t.grade || M.defaultGrade()));
    toast("Grade copied");
  }
  paste() {
    if (!state.gradeClipboard) { toast("Copy a grade first"); return; }
    const ids = this.targets().map(c => c.id);
    if (!ids.length) return;
    M.edit("Paste grade", () => { for (const id of ids) { const c = M.getClip(id); if (c) c.grade = JSON.parse(JSON.stringify(state.gradeClipboard)); } });
    toast(`Grade pasted on ${ids.length} clip${ids.length > 1 ? "s" : ""}`);
  }
  reset() {
    const ids = this.targets().map(c => c.id);
    M.edit("Reset grade", () => { for (const id of ids) { const c = M.getClip(id); if (c) c.grade = M.defaultGrade(); } });
  }
}
