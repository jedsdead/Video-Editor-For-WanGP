// Audio mixer: a channel strip per audio track (fader, pan, mute, solo, stereo meter) plus the master bus.
import * as M from "./model.js";
import { P, bus } from "./model.js";
import { el, clamp } from "./util.js";

export class MixerPanel {
  constructor(app) {
    this.app = app;
    this.box = el("div.mixer");
    this.node = el("div", {}, this.box);
    this.strips = [];
    this.visible = false;
    this.layoutKey = "";
    for (const name of ["project", "tracks", "change"]) bus.on(name, () => this.sync());
    const loop = () => { requestAnimationFrame(loop); if (this.visible) this.meters(); };
    requestAnimationFrame(loop);
  }

  sync() {
    if (!P()) return;
    const key = M.audioTracks().map(t => t.id).join(",");
    if (key !== this.layoutKey) { this.layoutKey = key; this.build(); }
    for (const s of this.strips) s.refresh();
  }

  build() {
    this.box.innerHTML = "";
    this.strips = [];
    for (const track of M.audioTracks()) this.strips.push(this.strip(track.id));
    this.strips.push(this.strip("master"));
    for (const s of this.strips) this.box.append(s.node);
  }

  strip(id) {
    const isMaster = id === "master";
    const get = () => (isMaster ? P().master : M.getTrack(id)) || {};
    const fader = el("input.fader", { type: "range", min: -60, max: 12, step: 0.1, title: "Level (dB). Double-click for 0 dB." });
    const db = el("span.db");
    const meter = el("canvas.meter");
    const pan = isMaster ? null : el("input.pan", { type: "range", min: -1, max: 1, step: 0.01, title: "Pan. Double-click to centre." });
    const panVal = isMaster ? null : el("span.panval");
    const mute = isMaster ? null : el("button.mute", { title: "Mute" }, "M");
    const solo = isMaster ? null : el("button.solo", { title: "Solo" }, "S");
    const name = el("span.sname");
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
      isMaster ? el("span.dim", { style: { fontSize: "10px" } }, "MASTER") : el("div.ms", {}, mute, solo));
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
      const bw = (w - 3) / 2;
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
      ctx.fillStyle = "rgba(255,255,255,.25)";
      for (const mark of [0, -6, -12, -24, -48]) ctx.fillRect(0, toY(mark), w, 1);
    };
    refresh();
    return { node, refresh, draw };
  }

  meters() { for (const s of this.strips) s.draw(); }
}
