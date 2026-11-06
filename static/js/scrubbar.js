// A scrub bar under the viewer for when the timeline isn't on screen: in full screen and on the Colour page. It shows
// the whole timeline with its shots, markers, in / out range and the playhead; click or drag to move the playhead.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { el, clamp, timecode } from "./util.js";

export class ScrubBar {
  constructor(app) {
    this.app = app;
    this.canvas = el("canvas.scrubbar", { title: "Click or drag to move the playhead" });
    this.tip = el("div.scrub-tip", { hidden: true });
    this.node = el("div#scrubBar", {}, this.canvas, this.tip);
    const transport = document.getElementById("transport");
    transport.parentElement.insertBefore(this.node, transport);
    const at = (e) => { const r = this.canvas.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * this.length(); };
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.canvas.setPointerCapture(e.pointerId);
      this.drag = true;
      this.app.playback.pause();
      this.app.playback.seek(this.frame(at(e)));
    });
    this.canvas.addEventListener("pointermove", (e) => {
      const t = at(e);
      if (this.drag) this.app.playback.seek(this.frame(t));
      const r = this.canvas.getBoundingClientRect();
      this.tip.hidden = false;
      this.tip.textContent = timecode(t, M.fps());
      this.tip.style.left = `${clamp(e.clientX - r.left, 30, r.width - 30)}px`;
    });
    const up = () => { this.drag = false; };
    this.canvas.addEventListener("pointerup", up);
    this.canvas.addEventListener("pointercancel", up);
    this.canvas.addEventListener("pointerleave", () => { this.tip.hidden = true; });
    for (const ev of ["time", "change", "project"]) bus.on(ev, () => this.drawSoon());
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  frame(t) { const f = M.fps(); return Math.round(t * f) / f; }
  length() { return Math.max(1 / 24, M.timelineEnd()); }
  shown() { return this.node.offsetParent !== null; }
  drawSoon() { if (this.raf || !this.shown()) return; this.raf = requestAnimationFrame(() => { this.raf = null; this.draw(); }); }

  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h || !P()) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const len = this.length(), X = (t) => t / len * w;
    g.fillStyle = "rgba(255,255,255,.07)"; g.fillRect(0, 6, w, h - 12);
    // shots on the video tracks (top track brightest)
    const tracks = M.videoTracks();
    tracks.forEach((tr, k) => {
      const shade = Math.max(0.12, 0.34 - k * 0.08);
      for (const clip of M.clipsOn(tr.id)) {
        const x0 = X(clip.start), x1 = X(M.clipEnd(clip));
        g.fillStyle = `rgba(110,150,230,${shade})`;
        g.fillRect(x0, 6, Math.max(1, x1 - x0), h - 12);
        g.fillStyle = "rgba(10,12,16,.9)"; g.fillRect(Math.round(x0), 6, 1, h - 12);
      }
    });
    // in / out
    const p = P();
    if (p.inPoint != null || p.outPoint != null) {
      const a = X(p.inPoint ?? 0), b = X(p.outPoint ?? len);
      g.fillStyle = "rgba(255,204,77,.16)"; g.fillRect(a, 2, b - a, h - 4);
      g.fillStyle = "#ffcc4d"; g.fillRect(a, 2, 1, h - 4); g.fillRect(b - 1, 2, 1, h - 4);
    }
    // markers
    for (const m of p.markers || []) { g.fillStyle = m.colour || "#ff9f43"; g.beginPath(); g.moveTo(X(m.time) - 4, 0); g.lineTo(X(m.time) + 4, 0); g.lineTo(X(m.time), 6); g.fill(); }
    // playhead
    const x = Math.round(X(state.playhead)) + .5;
    g.strokeStyle = "#ff5a5a"; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
}
