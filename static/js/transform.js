// On-viewer transform handles for the selected video clip: drag to move, corners to scale, the top knob to rotate
// (Shift snaps to 15°), and in crop mode the edge handles crop. Clicking a layer in the viewer selects its clip.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { clamp, el } from "./util.js";

const HANDLE = 5, KNOB = 26;

export class TransformOverlay {
  constructor(app, stage) {
    this.app = app;
    this.stage = stage;
    this.cropMode = false;
    this.canvas = el("canvas.xf-overlay");
    stage.append(this.canvas);
    this.drag = null;
    for (const name of ["rendered", "selection", "viewer-layout", "playstate"]) bus.on(name, () => this.draw());
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", () => this.up());
    this.canvas.addEventListener("pointercancel", () => this.up());
  }

  setCropMode(on) { this.cropMode = on; this.draw(); bus.emit("crop-mode", on); }

  // geometry of the selected clip's layer in overlay (CSS pixel) coordinates
  target() {
    if (this.app.playback.playing) return null;
    if (M.selectedCompound()) return null;   // a compound clip's transform is set in the inspector
    const layers = [];
    for (const e of this.app.playback.lastLayers || []) {
      if (e.type === "clip") layers.push(e);
      else if (e.type === "transition") { if (e.a) layers.push(e.a); if (e.b) layers.push(e.b); }
    }
    const layer = layers.slice().reverse().find(l => state.selection.has(l.clip.id));
    return layer ? this.toCss(layer) : null;
  }

  toCss(layer) {
    const preview = this.app.renderer.canvas;
    const s = preview.clientWidth / preview.width;
    const [cl, ct, r1, b1] = layer.uv;
    const cw = layer.size[0] / Math.max(1e-6, r1 - cl), ch = layer.size[1] / Math.max(1e-6, b1 - ct);   // uncropped size
    const rot = layer.rotation;
    const ox = (cl - (1 - r1)) / 2 * cw, oy = (ct - (1 - b1)) / 2 * ch;
    const fullCx = layer.center[0] - (ox * Math.cos(rot) - oy * Math.sin(rot));
    const fullCy = layer.center[1] - (ox * Math.sin(rot) + oy * Math.cos(rot));
    return { layer, clip: layer.clip, s, rot,
      center: [layer.center[0] * s, layer.center[1] * s], size: [layer.size[0] * s, layer.size[1] * s],
      full: { center: [fullCx * s, fullCy * s], size: [cw * s, ch * s] }, crop: [cl, 1 - r1, ct, 1 - b1] };
  }

  position() {
    const preview = this.app.renderer.canvas;
    const sr = this.stage.getBoundingClientRect(), pr = preview.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    Object.assign(this.canvas.style, { left: `${pr.left - sr.left}px`, top: `${pr.top - sr.top}px`, width: `${pr.width}px`, height: `${pr.height}px` });
    const w = Math.round(pr.width * dpr), h = Math.round(pr.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    return dpr;
  }

  corners(center, size, rot) {
    const c = Math.cos(rot), s = Math.sin(rot);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
      const lx = u * size[0] / 2, ly = v * size[1] / 2;
      return [center[0] + lx * c - ly * s, center[1] + lx * s + ly * c];
    });
  }
  edgeMids(center, size, rot) {
    const c = Math.cos(rot), s = Math.sin(rot);
    return Object.fromEntries(Object.entries({ L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] }).map(([k, [u, v]]) => {
      const lx = u * size[0] / 2, ly = v * size[1] / 2;
      return [k, [center[0] + lx * c - ly * s, center[1] + lx * s + ly * c]];
    }));
  }
  knob(g) {
    const c = Math.cos(g.rot), s = Math.sin(g.rot);
    const ly = -g.size[1] / 2 - KNOB;
    return [g.center[0] - ly * s, g.center[1] + ly * c];
  }

  draw() {
    const dpr = this.position();
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const g = this.target();
    this.canvas.style.pointerEvents = this.app.playback.playing || state.readOnly ? "none" : "auto";
    this.canvas.style.cursor = "default";
    this.geo = g;
    if (!g) return;
    if (this.cropMode) {
      ctx.setLineDash([4, 4]); ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.lineWidth = 1;
      const fc = this.corners(g.full.center, g.full.size, g.rot);
      ctx.beginPath(); fc.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
    }
    const pts = this.corners(g.center, g.size, g.rot);
    ctx.strokeStyle = this.cropMode ? "#ffcc4d" : "#4f8cff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.strokeStyle = this.cropMode ? "#ffcc4d" : "#4f8cff";
    if (this.cropMode) {
      for (const [x, y] of Object.values(this.edgeMids(g.center, g.size, g.rot))) { ctx.fillRect(x - 6, y - 6, 12, 12); ctx.strokeRect(x - 6, y - 6, 12, 12); }
    } else {
      for (const [x, y] of pts) { ctx.fillRect(x - HANDLE, y - HANDLE, HANDLE * 2, HANDLE * 2); ctx.strokeRect(x - HANDLE, y - HANDLE, HANDLE * 2, HANDLE * 2); }
      const [kx, ky] = this.knob(g);
      const top = this.edgeMids(g.center, g.size, g.rot).T;
      ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(kx, ky); ctx.stroke();
      ctx.beginPath(); ctx.arc(kx, ky, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(g.center[0] - 6, g.center[1]); ctx.lineTo(g.center[0] + 6, g.center[1]); ctx.moveTo(g.center[0], g.center[1] - 6); ctx.lineTo(g.center[0], g.center[1] + 6); ctx.stroke();
    }
    if (this.label) {
      ctx.font = "11px Segoe UI, system-ui, sans-serif";
      const w = ctx.measureText(this.label.text).width + 10;
      ctx.fillStyle = "rgba(0,0,0,.75)"; ctx.fillRect(this.label.x + 12, this.label.y - 22, w, 18);
      ctx.fillStyle = "#fff"; ctx.fillText(this.label.text, this.label.x + 17, this.label.y - 9);
    }
  }

  local(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  inside(g, x, y) {
    const c = Math.cos(-g.rot), s = Math.sin(-g.rot);
    const dx = x - g.center[0], dy = y - g.center[1];
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    return Math.abs(lx) <= g.size[0] / 2 && Math.abs(ly) <= g.size[1] / 2;
  }
  hit(x, y) {
    const g = this.geo;
    if (!g) return null;
    const near = ([px, py], r = 8) => Math.hypot(px - x, py - y) <= r;
    if (this.cropMode) {
      for (const [k, p] of Object.entries(this.edgeMids(g.center, g.size, g.rot))) if (near(p, 9)) return { mode: "crop", edge: k };
    } else {
      if (near(this.knob(g), 9)) return { mode: "rotate" };
      if (this.corners(g.center, g.size, g.rot).some(p => near(p))) return { mode: "scale" };
    }
    if (this.inside(g, x, y)) return { mode: "move" };
    return null;
  }

  // Select the topmost clip whose layer is under the pointer.
  pick(x, y) {
    const layers = [];
    for (const e of this.app.playback.lastLayers || []) {
      if (e.type === "clip") layers.push(e);
      else if (e.type === "transition") { if (e.b) layers.push(e.b); if (e.a) layers.push(e.a); }
    }
    for (const layer of layers.slice().reverse()) {
      if (layer.alpha <= 0.01) continue;
      if (this.inside(this.toCss(layer), x, y)) { M.select([layer.clip.id]); return true; }
    }
    return false;
  }

  down(e) {
    if (e.button !== 0) return;
    const [x, y] = this.local(e);
    let h = this.hit(x, y);
    if (!h) {
      if (this.pick(x, y)) { this.geo = this.target(); h = this.geo ? { mode: "move" } : null; }
      else { M.clearSelection(); return; }
      if (!h) return;
    }
    const g = this.geo;
    const clip = M.getClip(g.clip.id);
    if (!clip || M.getTrack(clip.trackId).locked) return;
    const tau = state.playhead - clip.start;
    const v = (name) => M.prop(clip, name, clamp(tau, 0, M.clipDur(clip)));
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { ...h, clipId: clip.id, tau, x0: x, y0: y, g, start: { x: v("x"), y: v("y"), scale: v("scale"), rotation: v("rotation"),
      cropL: v("cropL"), cropR: v("cropR"), cropT: v("cropT"), cropB: v("cropB") }, shift: e.shiftKey };
  }

  move(e) {
    const [x, y] = this.local(e);
    const d = this.drag;
    if (!d) {
      const h = this.hit(x, y);
      this.canvas.style.cursor = !h ? "default" : { move: "move", scale: "nwse-resize", rotate: "grab", crop: "crosshair" }[h.mode];
      return;
    }
    const g = d.g;
    // overlay CSS pixels -> renderer pixels (/ g.s) -> project pixels (/ renderer-to-project scale)
    const toProject = 1 / (g.s * (this.app.renderer.canvas.width / P().settings.width));
    const set = (name, value) => M.setPropAt(d.clipId, name, d.tau, value);
    const key = `xf-${d.clipId}-${d.mode}`;
    if (d.mode === "move") {
      let dx = (x - d.x0) * toProject, dy = (y - d.y0) * toProject;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      M.edit("Move", () => { set("x", Math.round(d.start.x + dx)); set("y", Math.round(d.start.y + dy)); }, { coalesceKey: key });
      this.label = { x, y, text: `X ${Math.round(d.start.x + dx)}  Y ${Math.round(d.start.y + dy)}` };
    } else if (d.mode === "scale") {
      const r0 = Math.hypot(d.x0 - g.center[0], d.y0 - g.center[1]), r1 = Math.hypot(x - g.center[0], y - g.center[1]);
      const scale = clamp(d.start.scale * r1 / Math.max(1, r0), 0.01, 20);
      M.edit("Scale", () => set("scale", Math.round(scale * 1000) / 1000), { coalesceKey: key });
      this.label = { x, y, text: `${Math.round(scale * 100)}%` };
    } else if (d.mode === "rotate") {
      const a0 = Math.atan2(d.y0 - g.center[1], d.x0 - g.center[0]), a1 = Math.atan2(y - g.center[1], x - g.center[0]);
      let deg = d.start.rotation + (a1 - a0) * 180 / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      deg = Math.round(deg * 10) / 10;
      M.edit("Rotate", () => set("rotation", deg), { coalesceKey: key });
      this.label = { x, y, text: `${deg}°` };
    } else if (d.mode === "crop") {
      // pointer in the uncropped frame's own (unrotated) coordinates, as a 0..1 fraction
      const c = Math.cos(-g.rot), s = Math.sin(-g.rot);
      const dx = x - g.full.center[0], dy = y - g.full.center[1];
      const fx = (dx * c - dy * s) / g.full.size[0] + 0.5, fy = (dx * s + dy * c) / g.full.size[1] + 0.5;
      const st = d.start;
      const values = {
        L: ["cropL", clamp(fx, 0, 0.99 - st.cropR)], R: ["cropR", clamp(1 - fx, 0, 0.99 - st.cropL)],
        T: ["cropT", clamp(fy, 0, 0.99 - st.cropB)], B: ["cropB", clamp(1 - fy, 0, 0.99 - st.cropT)],
      }[d.edge];
      M.edit("Crop", () => set(values[0], Math.round(values[1] * 1000) / 1000), { coalesceKey: key });
      this.label = { x, y, text: `${Math.round(values[1] * 100)}%` };
    }
    this.draw();
  }

  up() { this.drag = null; this.label = null; this.draw(); }
}
