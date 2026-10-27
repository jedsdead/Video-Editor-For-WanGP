// Transitions panel: drag a transition onto a cut, or apply the chosen one at the playhead.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { el, toast, clamp } from "./util.js";
import { VIDEO_PRESETS, AUDIO_TRANSITIONS, isAudioTransition, transitionLabel, presetTransition, cpuTransitionPixel } from "./transitions.js";

export class TransitionsPanel {
  constructor(app) {
    this.app = app;
    const savedVideo = localStorage.getItem("ve_tr_video");
    this.selected = { video: VIDEO_PRESETS.some(p => p.id === savedVideo) ? savedVideo : "dissolve", audio: localStorage.getItem("ve_tr_audio") || "a_power" };
    this.duration = parseFloat(localStorage.getItem("ve_tr_duration") || "1") || 1;
    const durInput = el("input", { type: "number", min: 0.04, max: 10, step: 0.1, value: this.duration, style: { width: "64px" },
      onchange: (e) => { this.duration = clamp(parseFloat(e.target.value) || 1, 0.04, 10); localStorage.setItem("ve_tr_duration", this.duration); } });
    this.tiles = [];
    const grid = (list, kind) => el("div.tgrid", {}, list.map(t => this.tile(t, kind)));
    this.node = el("div", {},
      el("div.panel-toolbar", {}, el("span.dim", {}, "Duration"), durInput, el("span.dim", {}, "s"), el("div.spacer"),
        el("button.small", { title: "Add the highlighted video and audio transitions at the cut nearest the playhead (Ctrl+T)", onclick: () => this.applyAtPlayhead() }, "Apply at playhead")),
      el("div.panel-scroll", {},
        el("div.tsection", {}, "Video"), grid(VIDEO_PRESETS, "video"),
        el("div.tsection", {}, "Audio"), grid(AUDIO_TRANSITIONS, "audio"),
        el("div.dim", { style: { fontSize: "11px" } }, "Drag a transition onto a cut between two clips, or click one to make it the default and use Apply at playhead. Select a transition on the timeline to change its angle, shape, style or edge in the Inspector, or drag its edges to change the length.")));
    bus.on("drop-transition", ({ type, hit }) => this.dropOnTimeline(type, hit));
  }

  tile(t, kind) {
    const canvas = el("canvas", { width: 96, height: 44 });
    const node = el(`div.ttile${this.selected[kind] === t.id ? ".active" : ""}`, { draggable: true, title: t.label,
      ondragstart: (e) => { e.dataTransfer.setData("text/x-ve-transition", t.id); e.dataTransfer.effectAllowed = "copy"; },
      onclick: () => { this.selected[kind] = t.id; localStorage.setItem(`ve_tr_${kind}`, t.id); this.tiles.forEach(x => x.node.classList.toggle("active", this.selected[x.kind] === x.id)); },
      onmouseenter: () => this.animate(entry, true), onmouseleave: () => this.animate(entry, false) }, canvas, t.label);
    const entry = { id: t.id, kind, node, canvas, tr: presetTransition(t.id) };
    this.tiles.push(entry);
    this.paint(entry, 0.5);
    return node;
  }

  paint(entry, p) {
    const ctx = entry.canvas.getContext("2d");
    const { width: w, height: h } = entry.canvas;
    const img = ctx.createImageData(w, h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 4;
      let c;
      if (entry.kind === "audio") {
        const x = i / (w - 1);
        const [ga, gb] = M.audioTransitionGains(entry.id, x);
        const ya = (1 - ga) * (h - 6) + 3, yb = (1 - gb) * (h - 6) + 3;
        c = Math.abs(j - ya) < 1.5 ? [90, 150, 230] : Math.abs(j - yb) < 1.5 ? [240, 160, 70] : [24, 26, 32];
      } else c = cpuTransitionPixel(entry.tr, (i + 0.5) / w, (j + 0.5) / h, p, w / h, [70, 120, 210], [230, 150, 60]);
      img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  animate(entry, on) {
    cancelAnimationFrame(entry.raf);
    if (!on || entry.kind === "audio") { this.paint(entry, 0.5); return; }
    const start = performance.now();
    const loop = (now) => { const p = ((now - start) / 1400) % 1; this.paint(entry, p); entry.raf = requestAnimationFrame(loop); };
    entry.raf = requestAnimationFrame(loop);
  }

  dropOnTimeline(type, hit) {
    if (!hit || !hit.row) { toast("Drop the transition onto a cut between two clips"); return; }
    const audio = isAudioTransition(type);
    if ((hit.row.kind === "audio") !== audio) { toast(audio ? "Audio transitions go on audio tracks" : "Video transitions go on video tracks", "warn"); return; }
    const tol = Math.max(0.5, 30 / this.app.timeline.pps);
    const cut = M.findCut(hit.row.track.id, hit.t, tol);
    if (!cut) { toast("No cut between two touching clips there", "warn"); return; }
    let tr;
    M.edit("Add transition", () => { tr = M.addTransition(hit.row.track.id, cut.a, cut.b, type, this.duration); });
    if (tr) { state.selTransition = tr.id; state.selection.clear(); bus.emit("selection"); }
  }

  applyAtPlayhead() {
    const t = state.playhead;
    const tol = Math.max(0.5, 30 / this.app.timeline.pps);
    const tracks = M.selectedClips().length ? [...new Set(M.selectedClips().map(c => c.trackId))] : P().tracks.map(tr => tr.id);
    let count = 0;
    M.edit("Add transitions", () => {
      for (const trackId of tracks) {
        const cut = M.findCut(trackId, t, tol);
        if (!cut) continue;
        const type = M.trackKind(trackId) === "audio" ? this.selected.audio : this.selected.video;
        M.addTransition(trackId, cut.a, cut.b, type, this.duration);
        count++;
      }
    });
    toast(count ? `Added ${count} transition${count > 1 ? "s" : ""} (${transitionLabel(this.selected.video)} / ${transitionLabel(this.selected.audio)})` : "No cut near the playhead", count ? "info" : "warn");
  }
}
