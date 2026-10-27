// Audio mixer: a channel strip per audio track (fader, pan, mute, solo, stereo meter, FX) plus the master bus with a
// loudness meter, and an EQ / compressor editor for the strip whose FX button was clicked.
import * as M from "./model.js";
import { P, bus } from "./model.js";
import { el, clamp } from "./util.js";

const fmtLufs = (v) => (v === null || v === undefined || !isFinite(v) ? "–" : v.toFixed(1));

export class MixerPanel {
  constructor(app) {
    this.app = app;
    this.box = el("div.mixer");
    this.fxBox = el("div.fxbox");
    this.node = el("div", {}, el("div.mixer-wrap", {}, this.box, this.fxBox));
    this.strips = [];
    this.visible = false;
    this.layoutKey = "";
    this.fxTarget = null;
    for (const name of ["project", "tracks", "change"]) bus.on(name, () => this.sync());
    const loop = () => { requestAnimationFrame(loop); if (this.visible) this.meters(); };
    requestAnimationFrame(loop);
  }

  owner(id) { return id === "master" ? P().master : M.getTrack(id); }

  sync() {
    if (!P()) return;
    const key = M.audioTracks().map(t => t.id).join(",");
    if (key !== this.layoutKey) { this.layoutKey = key; this.build(); }
    for (const s of this.strips) s.refresh();
    if (this.fxTarget && !this.owner(this.fxTarget)) this.openFx(null);
    else if (this.fxTarget) this.fxRefresh && this.fxRefresh();
  }

  build() {
    this.box.innerHTML = "";
    this.strips = [];
    for (const track of M.audioTracks()) this.strips.push(this.strip(track.id));
    this.strips.push(this.strip("master"));
    for (const s of this.strips) this.box.append(s.node);
    this.openFx(this.fxTarget && this.owner(this.fxTarget) ? this.fxTarget : null);
  }

  strip(id) {
    const isMaster = id === "master";
    const get = () => this.owner(id) || {};
    const fader = el("input.fader", { type: "range", min: -60, max: 12, step: 0.1, title: "Level (dB). Double-click for 0 dB." });
    const db = el("span.db");
    const meter = el("canvas.meter");
    const pan = isMaster ? null : el("input.pan", { type: "range", min: -1, max: 1, step: 0.01, title: "Pan. Double-click to centre." });
    const panVal = isMaster ? null : el("span.panval");
    const mute = isMaster ? null : el("button.mute", { title: "Mute" }, "M");
    const solo = isMaster ? null : el("button.solo", { title: "Solo" }, "S");
    const fxBtn = el("button.small.fxbtn", { title: "EQ and compressor", onclick: () => this.openFx(this.fxTarget === id ? null : id) }, "FX");
    const name = el("span.sname");
    const lufs = isMaster ? el("div.lufs", { title: "Loudness while playing (EBU R128): momentary, short-term and integrated. Click to reset the integrated value.",
      onclick: () => this.app.playback.resetLoudness() }) : null;
    const setVol = (v) => M.edit("Mixer level", () => { const t = get(); t.volume = clamp(v, -60, 12); }, { coalesceKey: `vol-${id}` });
    fader.addEventListener("input", () => setVol(parseFloat(fader.value)));
    fader.addEventListener("dblclick", () => setVol(0));
    if (pan) {
      pan.addEventListener("input", () => M.edit("Pan", () => { get().pan = parseFloat(pan.value); }, { coalesceKey: `pan-${id}` }));
      pan.addEventListener("dblclick", () => M.edit("Pan", () => { get().pan = 0; }));
      mute.addEventListener("click", () => M.edit("Mute", () => { get().mute = !get().mute; }));
      solo.addEventListener("click", () => M.edit("Solo", () => { get().solo = !get().solo; }));
    }
    const node = el(`div.strip${isMaster ? ".master" : ""}`, {}, name,
      pan, panVal,
      el("div.fader-row", {}, fader, meter),
      db,
      isMaster ? null : el("div.ms", {}, mute, solo),
      fxBtn,
      lufs);
    const peaks = { l: -90, r: -90, hl: -90, hr: -90, ht: 0 };
    const refresh = () => {
      const t = get();
      if (isMaster) name.textContent = "Master";
      else { const track = M.getTrack(id); name.textContent = track ? `${M.trackLabel(track)}${track.name ? " " + track.name : ""}` : "?"; }
      if (document.activeElement !== fader) fader.value = t.volume ?? 0;
      db.textContent = `${(t.volume ?? 0) > 0 ? "+" : ""}${(t.volume ?? 0).toFixed(1)} dB`;
      if (pan) {
        if (document.activeElement !== pan) pan.value = t.pan ?? 0;
        const p = t.pan ?? 0;
        panVal.textContent = Math.abs(p) < 0.005 ? "C" : `${p < 0 ? "L" : "R"}${Math.round(Math.abs(p) * 100)}`;
        mute.classList.toggle("on", !!t.mute);
        solo.classList.toggle("on", !!t.solo);
      }
      const fx = t.fx || {};
      fxBtn.classList.toggle("on", !!(fx.eq?.on || fx.comp?.on));
      fxBtn.classList.toggle("open", this.fxTarget === id);
    };
    const draw = () => {
      const lv = this.app.playback.levels(id);
      const now = performance.now();
      peaks.l = Math.max(lv.l, peaks.l - 1.2); peaks.r = Math.max(lv.r, peaks.r - 1.2);
      if (lv.l > peaks.hl || lv.r > peaks.hr || now - peaks.ht > 1500) { peaks.hl = Math.max(lv.l, now - peaks.ht > 1500 ? -90 : peaks.hl); peaks.hr = Math.max(lv.r, now - peaks.ht > 1500 ? -90 : peaks.hr); peaks.ht = now; }
      const w = Math.max(10, Math.round(meter.clientWidth * devicePixelRatio)), h = Math.max(20, Math.round(meter.clientHeight * devicePixelRatio));
      if (meter.width !== w || meter.height !== h) { meter.width = w; meter.height = h; }
      const ctx = meter.getContext("2d");
      ctx.fillStyle = "#08090b"; ctx.fillRect(0, 0, w, h);
      const toY = (dbv) => h - h * clamp((dbv + 60) / 66, 0, 1);
      const comp = (get().fx || {}).comp || {};
      const bw = (w - 3 - (comp.on ? 4 : 0)) / 2;
      [peaks.l, peaks.r].forEach((v, i) => {
        const x = 1 + i * (bw + 1);
        const y = toY(v);
        const grad = ctx.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, "#2fbf71"); grad.addColorStop(0.75, "#2fbf71"); grad.addColorStop(0.88, "#e3c341"); grad.addColorStop(1, "#ff4d4d");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, bw, h - y);
        const hy = toY(i ? peaks.hr : peaks.hl);
        ctx.fillStyle = (i ? peaks.hr : peaks.hl) > -0.1 ? "#ff4d4d" : "#ddd";
        ctx.fillRect(x, hy, bw, 2 * devicePixelRatio);
      });
      if (comp.on) {   // compressor gain reduction, drawn down from the top
        const gr = Math.min(0, this.app.playback.reduction(id) || 0);
        ctx.fillStyle = "#ff9646";
        ctx.fillRect(w - 4, 0, 3, h * clamp(-gr / 30, 0, 1));
      }
      ctx.fillStyle = "rgba(255,255,255,.25)";
      for (const mark of [0, -6, -12, -24, -48]) ctx.fillRect(0, toY(mark), w, 1);
      if (lufs) {
        const L = this.app.playback.loudness();
        lufs.innerHTML = `<span>M</span>${fmtLufs(L.m)}<span>S</span>${fmtLufs(L.s)}<span>I</span>${fmtLufs(L.i)}<em>LUFS</em>`;
      }
    };
    refresh();
    return { node, refresh, draw };
  }

  meters() { for (const s of this.strips) s.draw(); }

  // ---------------------------------------------------------------- FX editor
  openFx(id) {
    this.fxTarget = id;
    this.fxBox.innerHTML = "";
    this.fxBox.hidden = !id;
    this.fxRefresh = null;
    for (const s of this.strips) s.refresh();
    if (!id) return;
    const fx = () => (this.owner(id) || {}).fx || M.defaultFx();
    const set = (fn, key) => M.edit("Audio effects", () => {
      const o = this.owner(id);
      if (!o) return;
      const f = JSON.parse(JSON.stringify(o.fx || M.defaultFx()));
      fn(f);
      o.fx = f;
    }, key ? { coalesceKey: `fx-${id}-${key}` } : {});
    const refreshers = [];
    const slider = (label, path, min, max, step, unit, log = false) => {
      const getV = () => path.reduce((o, k) => o?.[k], fx());
      const toPos = (v) => log ? Math.log(v / min) / Math.log(max / min) * 1000 : v;
      const fromPos = (p) => log ? min * Math.pow(max / min, p / 1000) : p;
      const range = el("input", { type: "range", min: log ? 0 : min, max: log ? 1000 : max, step: log ? 1 : step });
      const num = el("input", { type: "number", min, max, step, style: { width: "62px" } });
      const apply = (v, key) => set(f => { const parent = path.slice(0, -1).reduce((o, k) => o[k], f); parent[path[path.length - 1]] = clamp(v, min, max); }, key);
      range.addEventListener("input", () => apply(Math.round(fromPos(parseFloat(range.value)) / step) * step, path.join(".")));
      num.addEventListener("change", () => { const v = parseFloat(num.value); if (isFinite(v)) apply(v); });
      const update = () => { const v = getV(); if (document.activeElement !== range) range.value = toPos(v); if (document.activeElement !== num) num.value = +(+v).toFixed(2); };
      update(); refreshers.push(update);
      return el("div.field", {}, el("label", {}, label), range, el("span", { style: { display: "flex", gap: "3px", alignItems: "center" } }, num, el("span.dim", { style: { fontSize: "10px" } }, unit)));
    };
    const toggle = (label, path) => {
      const box = el("input", { type: "checkbox", onchange: () => set(f => { f[path].on = box.checked; }) });
      const update = () => { box.checked = !!fx()[path]?.on; };
      update(); refreshers.push(update);
      return el("label", { style: { display: "flex", gap: "6px", alignItems: "center", color: "inherit", fontWeight: 600 } }, box, label);
    };
    const title = id === "master" ? "Master" : M.trackLabel(M.getTrack(id));
    this.fxBox.append(
      el("div.fxhead", {}, el("strong", {}, `${title} effects`), el("div.spacer"), el("button.icon", { title: "Close", onclick: () => this.openFx(null) }, "✕")),
      el("div.insp-section", {}, el("h4", {}, toggle("EQ", "eq"),
          el("button.small", { onclick: () => set(f => { f.eq = M.defaultFx().eq; f.eq.on = true; }) }, "Flat")),
        slider("Low freq", ["eq", "low", "f"], 20, 1000, 1, "Hz", true),
        slider("Low gain", ["eq", "low", "g"], -24, 24, 0.5, "dB"),
        slider("Mid freq", ["eq", "mid", "f"], 100, 10000, 1, "Hz", true),
        slider("Mid gain", ["eq", "mid", "g"], -24, 24, 0.5, "dB"),
        slider("Mid Q", ["eq", "mid", "q"], 0.1, 10, 0.05, ""),
        slider("High freq", ["eq", "high", "f"], 1000, 20000, 10, "Hz", true),
        slider("High gain", ["eq", "high", "g"], -24, 24, 0.5, "dB")),
      el("div.insp-section", {}, el("h4", {}, toggle("Compressor", "comp")),
        slider("Threshold", ["comp", "threshold"], -60, 0, 0.5, "dB"),
        slider("Ratio", ["comp", "ratio"], 1, 20, 0.1, ": 1"),
        slider("Attack", ["comp", "attack"], 0.1, 200, 0.1, "ms", true),
        slider("Release", ["comp", "release"], 10, 2000, 1, "ms", true),
        slider("Makeup", ["comp", "makeup"], 0, 24, 0.5, "dB"),
        el("div.dim", { style: { fontSize: "11px" } }, "The orange bar beside the meter shows gain reduction. Effects run before the fader, and are applied the same way on export.")));
    this.fxRefresh = () => refreshers.forEach(fn => fn());
  }
}
