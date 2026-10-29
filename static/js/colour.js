// Colour panel: lift / gamma / gain wheels with master sliders, exposure, contrast, saturation, temperature, tint,
// a .cube LUT with mix amount, and grade keyframes (all grade values keyed together at the playhead).
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { api, el, toast, clamp } from "./util.js";
import { ColorWheel, ZONES } from "./grade.js";
import { CURVES } from "./keys.js";

const WHEELS = [["lift", "Lift", -0.5, 0.5], ["gamma", "Gamma", -0.8, 0.8], ["gain", "Gain", -0.8, 0.8]];
const ZONE_LABELS = { master: "Master", shadows: "Shadows", mids: "Midtones", highs: "Highlights" };
const SLIDERS = [["exposure", "Exposure", -3, 3, 0.01, 0], ["contrast", "Contrast", -1, 1, 0.01, 0], ["saturation", "Saturation", 0, 2, 0.01, 1],
                 ["temperature", "Temperature", -1, 1, 0.01, 0], ["tint", "Tint", -1, 1, 0.01, 0]];

export class ColourPanel {
  constructor(app) {
    this.app = app;
    this.wheels = {};
    this.masters = {};
    this.sliders = {};
    this.lutNames = [];
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
    // tonal (Final Cut style) wheels
    this.zoneWheels = {};
    const zoneGrid = el("div.wheels.zones");
    for (const z of ZONES) {
      const canvas = el("canvas");
      const bright = el("input", { type: "range", min: -1, max: 1, step: 0.005, title: `${ZONE_LABELS[z]} brightness. Double-click to reset.` });
      const sat = el("input", { type: "range", min: 0, max: 2, step: 0.01, title: `${ZONE_LABELS[z]} saturation. Double-click to reset.` });
      const bVal = el("span.wval"), sVal = el("span.wval");
      bright.addEventListener("input", () => this.apply(`${z}-bright`, (g) => { g[z] = { ...g[z], bright: parseFloat(bright.value) }; }));
      bright.addEventListener("dblclick", () => this.apply(`${z}-bright`, (g) => { g[z] = { ...g[z], bright: 0 }; }));
      sat.addEventListener("input", () => this.apply(`${z}-sat`, (g) => { g[z] = { ...g[z], sat: parseFloat(sat.value) }; }));
      sat.addEventListener("dblclick", () => this.apply(`${z}-sat`, (g) => { g[z] = { ...g[z], sat: 1 }; }));
      const wheel = new ColorWheel(canvas, { onChange: (v) => this.apply(`${z}-wheel`, (g) => { g[z] = { ...g[z], x: v.x, y: v.y }; }) });
      this.zoneWheels[z] = { wheel, bright, sat, bVal, sVal };
      zoneGrid.append(el("div.wheel", {}, el("span.wlabel", { title: "Drag to tint this tonal range. Shift-drag for fine control. Double-click to reset." }, ZONE_LABELS[z]), canvas,
        el("div.zslider", {}, el("span", { title: "Brightness" }, "☀"), bright, bVal),
        el("div.zslider", {}, el("span", { title: "Saturation" }, "◐"), sat, sVal)));
    }
    this.zoneLow = el("input", { type: "range", min: 0.05, max: 0.6, step: 0.01, title: "Where shadows hand over to midtones" });
    this.zoneHigh = el("input", { type: "range", min: 0.4, max: 0.95, step: 0.01, title: "Where midtones hand over to highlights" });
    this.zoneLowVal = el("span.val"); this.zoneHighVal = el("span.val");
    this.zoneLow.addEventListener("input", () => this.apply("zoneLow", (g) => { g.zoneLow = Math.min(parseFloat(this.zoneLow.value), (g.zoneHigh ?? 0.67) - 0.05); }));
    this.zoneHigh.addEventListener("input", () => this.apply("zoneHigh", (g) => { g.zoneHigh = Math.max(parseFloat(this.zoneHigh.value), (g.zoneLow ?? 0.33) + 0.05); }));
    this.zoneLow.addEventListener("dblclick", () => this.apply("zoneLow", (g) => { g.zoneLow = 0.33; }));
    this.zoneHigh.addEventListener("dblclick", () => this.apply("zoneHigh", (g) => { g.zoneHigh = 0.67; }));
    this.zonesBox = el("div", {}, zoneGrid,
      el("div.field", { style: { marginTop: "8px" } }, el("label", {}, "Shadows to"), this.zoneLow, this.zoneLowVal),
      el("div.field", {}, el("label", {}, "Highlights from"), this.zoneHigh, this.zoneHighVal));
    this.lggBox = el("div", {}, wheelRow);
    this.styleSelect = el("select", { title: "Lift / Gamma / Gain works on the whole image like Resolve's primaries. Shadows / Midtones / Highlights gives each tonal range its own colour, brightness and saturation, like Final Cut. Each clip keeps the values of both, and only the selected style is applied.",
      onchange: () => this.apply("style", (g) => { g.style = this.styleSelect.value; }) },
      el("option", { value: "lgg" }, "Lift / Gamma / Gain"), el("option", { value: "zones" }, "Shadows / Midtones / Highlights"));

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

    // LUT
    this.lutSelect = el("select", { onchange: () => this.apply("lut", (g) => { g.lut = this.lutSelect.value || null; }) });
    this.lutMix = el("input", { type: "range", min: 0, max: 1, step: 0.01, title: "How much of the LUT to apply. Double-click for 100%." });
    this.lutMixVal = el("span.val");
    this.lutMix.addEventListener("input", () => this.apply("lutMix", (g) => { g.lutMix = parseFloat(this.lutMix.value); }));
    this.lutMix.addEventListener("dblclick", () => this.apply("lutMix", (g) => { g.lutMix = 1; }));
    this.lutFile = el("input", { type: "file", accept: ".cube", multiple: true, style: { display: "none" }, onchange: (e) => { this.importLuts([...e.target.files]); e.target.value = ""; } });

    // grade keyframes
    this.kPrev = el("button.small.kbtn", { title: "Previous grade keyframe", onclick: () => this.jump(-1) }, "◀");
    this.kDiamond = el("button.small.kbtn", { title: "Add / remove a grade keyframe at the playhead", onclick: () => this.toggleKey() }, "◆");
    this.kNext = el("button.small.kbtn", { title: "Next grade keyframe", onclick: () => this.jump(1) }, "▶");
    this.kEase = el("select", { title: "Ease from this keyframe to the next", onchange: () => M.edit("Grade ease", () => { for (const c of this.targets()) M.setGradeEaseAt(c.id, this.tauOf(c), this.kEase.value); }) },
      CURVES.map(([id, label]) => el("option", { value: id }, label)));
    this.kClear = el("button.small", { title: "Remove all grade keyframes and keep the grade at the playhead", onclick: () => M.edit("Clear grade keyframes", () => { for (const c of this.targets()) M.clearGradeKeys(c.id, this.tauOf(c)); }) }, "Clear");
    this.keyNote = el("span.dim", { style: { fontSize: "11px" } });

    this.controls = el("div", {},
      el("div.btnrow", { style: { marginBottom: "8px" } },
        el("label", { style: { display: "flex", gap: "4px", alignItems: "center" }, title: "Compare with the ungraded image" }, this.bypass, "Bypass"),
        el("div.spacer"),
        el("button.small", { onclick: () => this.copy() }, "Copy"),
        el("button.small", { onclick: () => this.paste() }, "Paste"),
        el("button.small", { onclick: () => this.reset() }, "Reset")),
      el("div.btnrow.gradekeys", { style: { marginBottom: "8px", alignItems: "center" } },
        el("span.dim", {}, "Keyframes"), el("span.kctl", {}, this.kPrev, this.kDiamond, this.kNext), this.kEase, this.kClear, this.keyNote),
      el("div.field.wide", { style: { marginBottom: "8px" } }, el("label", {}, "Wheels"), this.styleSelect),
      this.lggBox, this.zonesBox, el("div", { style: { height: "10px" } }), sliderBox,
      el("div.insp-section", { style: { marginTop: "8px" } }, el("h4", {}, "LUT"),
        el("div.field.wide", {}, el("label", {}, "LUT"), this.lutSelect),
        el("div.field", {}, el("label", {}, "Mix"), this.lutMix, this.lutMixVal),
        el("div.btnrow", {}, el("button.small", { onclick: () => this.lutFile.click() }, "Import .cube…"), this.lutFile),
        el("div.dim", { style: { fontSize: "11px", marginTop: "4px" } }, "The LUT is applied after the wheels and sliders. Imported LUTs are kept for every project.")),
      el("div.dim", { style: { fontSize: "11px", marginTop: "8px" } }, "Changes apply to every selected video clip. Once a clip has grade keyframes, changes add or update a keyframe at the playhead. Copy/Paste moves a grade between clips (Ctrl+Alt+C / Ctrl+Alt+V)."));
    this.node = el("div", {}, el("div.panel-scroll", {}, this.note, this.controls));
    for (const name of ["selection", "project", "change"]) bus.on(name, () => this.sync());
    let last = 0;
    bus.on("time", () => { const now = performance.now(); if (now - last > 100) { last = now; this.sync(); } });
    this.refreshLuts();
    this.sync();
  }

  targets() {
    if (!P()) return [];
    return M.editTargets().filter(c => M.trackKind(c.trackId) === "video");
  }
  tauOf(c) { return state.playhead - c.start; }
  inside(c) { const t = this.tauOf(c); return t >= -1e-6 && t <= M.clipDur(c) + 1e-6; }
  gradeOf(c) { return M.gradeAt(c, clamp(this.tauOf(c), 0, M.clipDur(c))); }

  apply(key, fn) {
    const ids = this.targets().map(c => c.id);
    if (!ids.length) return;
    let skipped = 0;
    M.edit("Colour", () => {
      for (const id of ids) {
        const c = M.getClip(id);
        if (!c) continue;
        const g = JSON.parse(JSON.stringify(this.gradeOf(c)));
        fn(g);
        if (M.hasGradeKeys(c)) {
          if (!this.inside(c)) { skipped++; continue; }
          M.setGradeAt(id, this.tauOf(c), g);
        } else c.grade = g;
      }
    }, { coalesceKey: `grade-${key}-${ids.join(",")}` });
    if (skipped) toast("Move the playhead over the clip to change a keyframed grade", "warn");
  }

  toggleKey() {
    const targets = this.targets().filter(c => this.inside(c));
    if (!targets.length) { toast("Move the playhead over the clip to add a grade keyframe", "warn"); return; }
    const first = targets[0];
    const on = M.gradeKeyTimes(first).some(t => Math.abs(t - this.tauOf(first)) <= M.frameDur() / 2 + 1e-6);
    M.edit(on ? "Remove grade keyframe" : "Add grade keyframe", () => {
      for (const c of targets) {
        if (on) M.removeGradeKeyAt(c.id, this.tauOf(c));
        else M.setGradeAt(c.id, this.tauOf(c), this.gradeOf(c), { addKey: true });
      }
    });
  }

  jump(dir) {
    const c = this.targets()[0];
    if (!c) return;
    const times = M.gradeKeyTimes(c).map(t => c.start + t);
    const t = dir < 0 ? times.filter(x => x < state.playhead - 1e-4).pop() : times.find(x => x > state.playhead + 1e-4);
    if (t !== undefined) { this.app.playback.pause(); this.app.playback.seek(t); }
  }

  async refreshLuts() {
    try { this.lutNames = await api("api/luts"); } catch (_) { this.lutNames = []; }
    this.sync();
  }

  async importLuts(files) {
    if (!files.length) return;
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);
    try {
      const res = await api("api/luts", { method: "POST", body: form });
      for (const e of res.errors) toast(`${e.name}: ${e.error}`, "error", 6000);
      await this.refreshLuts();
      if (res.saved.length) {
        toast(`Imported ${res.saved.length} LUT${res.saved.length > 1 ? "s" : ""}`);
        if (this.targets().length) this.apply("lut", (g) => { g.lut = res.saved[0]; g.lutMix = g.lutMix ?? 1; });
      }
    } catch (e) { toast(`LUT import failed: ${e.message}`, "error"); }
  }

  sync() {
    const targets = this.targets();
    this.note.hidden = targets.length > 0;
    this.controls.hidden = targets.length === 0;
    if (!targets.length) return;
    const c = targets[0];
    const g = M.mergeGrade(this.gradeOf(c));
    for (const [key] of WHEELS) {
      const w = g[key] || {};
      if (!this.wheels[key].dragging) this.wheels[key].set({ x: w.x || 0, y: w.y || 0 });
      if (document.activeElement !== this.masters[key].input) this.masters[key].input.value = w.master || 0;
      this.masters[key].val.textContent = `${(w.master || 0) >= 0 ? "+" : ""}${(w.master || 0).toFixed(2)}`;
    }
    const zones = g.style === "zones";
    if (document.activeElement !== this.styleSelect) this.styleSelect.value = zones ? "zones" : "lgg";
    this.lggBox.hidden = zones;
    this.zonesBox.hidden = !zones;
    for (const z of ZONES) {
      const zw = this.zoneWheels[z], v = g[z] || {};
      zw.wheel.set({ x: v.x || 0, y: v.y || 0 });
      if (document.activeElement !== zw.bright) zw.bright.value = v.bright || 0;
      if (document.activeElement !== zw.sat) zw.sat.value = v.sat ?? 1;
      zw.bVal.textContent = `${(v.bright || 0) >= 0 ? "+" : ""}${(v.bright || 0).toFixed(2)}`;
      zw.sVal.textContent = `${Math.round((v.sat ?? 1) * 100)}%`;
    }
    if (document.activeElement !== this.zoneLow) this.zoneLow.value = g.zoneLow ?? 0.33;
    if (document.activeElement !== this.zoneHigh) this.zoneHigh.value = g.zoneHigh ?? 0.67;
    this.zoneLowVal.textContent = `${Math.round((g.zoneLow ?? 0.33) * 100)}%`;
    this.zoneHighVal.textContent = `${Math.round((g.zoneHigh ?? 0.67) * 100)}%`;
    for (const [key] of SLIDERS) {
      const s = this.sliders[key];
      if (document.activeElement !== s.input) s.input.value = g[key];
      s.val.textContent = Number(g[key]).toFixed(2);
    }
    this.bypass.checked = g.enabled === false;
    const names = [...new Set([...this.lutNames, ...(g.lut ? [g.lut] : [])])];
    const sig = names.join("|");
    if (this.lutSelect.dataset.sig !== sig) {
      this.lutSelect.innerHTML = "";
      this.lutSelect.append(el("option", { value: "" }, "None"), ...names.map(n => el("option", { value: n }, n)));
      this.lutSelect.dataset.sig = sig;
    }
    if (document.activeElement !== this.lutSelect) this.lutSelect.value = g.lut || "";
    if (document.activeElement !== this.lutMix) this.lutMix.value = g.lutMix ?? 1;
    this.lutMixVal.textContent = `${Math.round((g.lutMix ?? 1) * 100)}%`;
    this.lutMix.disabled = !g.lut;
    // keyframe controls
    const times = M.gradeKeyTimes(c);
    const tau = this.tauOf(c);
    const onKey = times.some(t => Math.abs(t - tau) <= M.frameDur() / 2 + 1e-6);
    this.kDiamond.classList.toggle("on", onKey);
    this.kDiamond.classList.toggle("keyed", times.length > 0);
    this.kDiamond.disabled = !this.inside(c);
    this.kPrev.disabled = !times.some(t => c.start + t < state.playhead - 1e-4);
    this.kNext.disabled = !times.some(t => c.start + t > state.playhead + 1e-4);
    this.kPrev.hidden = this.kNext.hidden = this.kClear.hidden = !times.length;
    this.kEase.hidden = !onKey;
    if (onKey && document.activeElement !== this.kEase) {
      const i = M.keyIndexAt(c, "grade:exposure", tau);
      this.kEase.value = (i >= 0 && M.keysOf(c, "grade:exposure")[i].ease) || "linear";
    }
    this.keyNote.textContent = times.length ? `${times.length} keyframe${times.length > 1 ? "s" : ""}` : "";
  }

  copy() {
    const t = this.targets()[0];
    if (!t) return;
    state.gradeClipboard = JSON.parse(JSON.stringify(this.gradeOf(t)));
    toast("Grade copied");
  }
  paste() {
    if (!state.gradeClipboard) { toast("Copy a grade first"); return; }
    const ids = this.targets().map(c => c.id);
    if (!ids.length) return;
    M.edit("Paste grade", () => { for (const id of ids) { M.clearGradeKeys(id, 0); const c = M.getClip(id); if (c) c.grade = JSON.parse(JSON.stringify(state.gradeClipboard)); } });
    toast(`Grade pasted on ${ids.length} clip${ids.length > 1 ? "s" : ""}`);
  }
  reset() {
    const ids = this.targets().map(c => c.id);
    M.edit("Reset grade", () => { for (const id of ids) { M.clearGradeKeys(id, 0); const c = M.getClip(id); if (c) c.grade = M.defaultGrade(); } });
  }
}
