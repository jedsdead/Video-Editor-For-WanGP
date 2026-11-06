// The Audio page's analyser: a live spectrum of the master output (with peak hold), the loudness over the last
// 30 seconds (momentary and short-term LUFS) and a stereo phase / balance meter.
import { el, clamp } from "./util.js";

const F_LO = 20, F_HI = 20000, DB_LO = -100, DB_HI = -10;

export class SpectrumPanel {
  constructor(app) {
    this.app = app;
    this.visible = false;
    this.spec = el("canvas.spec-main", { title: "Master spectrum: bright line is now, faint line holds the peaks" });
    this.loud = el("canvas.spec-loud", { title: "Loudness over the last 30 seconds: momentary (thin) and short-term (thick) LUFS" });
    this.phase = el("canvas.spec-phase", { title: "Stereo: left / right balance and phase correlation (+1 mono, 0 wide, -1 out of phase)" });
    this.readout = el("div.spec-readout");
    this.node = el("div", {}, el("div.panel-scroll.spectrum-panel", {},
      el("div.spec-label", {}, "Master spectrum"), this.spec,
      el("div.spec-label", {}, "Loudness"), this.loud, this.readout,
      el("div.spec-label", {}, "Stereo"), this.phase));
    this.history = [];
    this.peak = null;
    const loop = () => { requestAnimationFrame(loop); if (this.visible && this.node.offsetParent !== null) this.draw(); };
    requestAnimationFrame(loop);
  }

  taps() {
    const pb = this.app.playback;
    if (!pb.ctx || !pb.master) return null;
    if (!this.an) {
      const ctx = pb.ctx;
      const mk = (size) => { const a = ctx.createAnalyser(); a.fftSize = size; a.smoothingTimeConstant = 0.7; return a; };
      this.an = { mix: mk(8192), l: mk(2048), r: mk(2048) };
      const split = ctx.createChannelSplitter(2);
      pb.master.connect(this.an.mix);
      pb.master.connect(split);
      split.connect(this.an.l, 0); split.connect(this.an.r, 1);
      this.buf = { mix: new Float32Array(this.an.mix.frequencyBinCount), l: new Float32Array(2048), r: new Float32Array(2048) };
    }
    return this.an;
  }

  fit(c) {
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return null;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#0c0d10"; g.fillRect(0, 0, w, h);
    return { g, w, h };
  }

  draw() {
    const an = this.taps();
    const pb = this.app.playback;
    const playing = pb.playing && pb.rate === 1;
    // spectrum
    const s = this.fit(this.spec);
    if (s) {
      const { g, w, h } = s;
      const X = (f) => Math.log(f / F_LO) / Math.log(F_HI / F_LO) * w;
      g.strokeStyle = "rgba(255,255,255,.06)"; g.fillStyle = "rgba(255,255,255,.35)"; g.font = "9px sans-serif";
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(X(f)) + .5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, h - 3); }
      for (let db = -90; db <= -20; db += 10) { const y = Math.round((DB_HI - db) / (DB_HI - DB_LO) * h) + .5; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.fillText(`${db}`, 2, y - 2); }
      if (an) {
        an.mix.getFloatFrequencyData(this.buf.mix);
        const data = this.buf.mix, nyq = an.mix.context.sampleRate / 2;
        const cols = Math.ceil(w / 2);
        if (!this.peak || this.peak.length !== cols) this.peak = new Float32Array(cols).fill(DB_LO);
        const now = new Float32Array(cols);
        for (let i = 0; i < cols; i++) {
          const f0 = F_LO * Math.pow(F_HI / F_LO, i / cols), f1 = F_LO * Math.pow(F_HI / F_LO, (i + 1) / cols);
          let b0 = Math.floor(f0 / nyq * data.length), b1 = Math.max(b0 + 1, Math.ceil(f1 / nyq * data.length));
          let m = DB_LO;
          for (let b = b0; b < Math.min(b1, data.length); b++) if (Number.isFinite(data[b])) m = Math.max(m, data[b]);
          now[i] = playing ? m : DB_LO;
          this.peak[i] = Math.max(now[i], this.peak[i] - 0.4);
        }
        const Y = (db) => clamp((DB_HI - db) / (DB_HI - DB_LO), 0, 1) * h;
        const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, "rgba(255,120,90,.55)"); grad.addColorStop(0.4, "rgba(127,214,168,.5)"); grad.addColorStop(1, "rgba(90,140,255,.25)");
        g.fillStyle = grad; g.beginPath(); g.moveTo(0, h);
        for (let i = 0; i < cols; i++) g.lineTo(i * 2, Y(now[i]));
        g.lineTo(w, h); g.closePath(); g.fill();
        g.strokeStyle = "rgba(255,204,77,.7)"; g.lineWidth = 1; g.beginPath();
        for (let i = 0; i < cols; i++) i ? g.lineTo(i * 2, Y(this.peak[i])) : g.moveTo(0, Y(this.peak[i]));
        g.stroke();
      }
      if (!playing) { g.fillStyle = "rgba(255,255,255,.3)"; g.font = "11px sans-serif"; g.textAlign = "right"; g.fillText("Play to see the master spectrum", w - 8, 14); g.textAlign = "left"; }
    }
    // loudness history
    const L = pb.loudness ? pb.loudness() : { m: null, s: null, i: null };
    const t = performance.now();
    if (playing) this.history.push({ t, m: L.m, s: L.s });
    while (this.history.length && t - this.history[0].t > 30000) this.history.shift();
    const l = this.fit(this.loud);
    if (l) {
      const { g, w, h } = l;
      const Y = (v) => clamp((-6 - v) / 54, 0, 1) * h;   // -6 to -60 LUFS
      g.strokeStyle = "rgba(255,255,255,.07)"; g.fillStyle = "rgba(255,255,255,.35)"; g.font = "9px sans-serif";
      for (const v of [-14, -23, -30, -40, -50]) { const y = Math.round(Y(v)) + .5; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.fillText(`${v}`, 2, y - 2); }
      g.strokeStyle = "rgba(255,204,77,.35)"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, Y(-14) + .5); g.lineTo(w, Y(-14) + .5); g.stroke(); g.setLineDash([]);
      for (const [key, colour, width] of [["m", "rgba(127,214,168,.55)", 1], ["s", "#7fd6a8", 2]]) {
        g.strokeStyle = colour; g.lineWidth = width; g.beginPath();
        let started = false;
        for (const p of this.history) {
          const v = p[key];
          if (v === null || !Number.isFinite(v)) { started = false; continue; }
          const x = w - (t - p.t) / 30000 * w;
          started ? g.lineTo(x, Y(v)) : g.moveTo(x, Y(v));
          started = true;
        }
        g.stroke();
      }
    }
    const f = (v) => (v === null || !Number.isFinite(v) || v < -70 ? "–" : v.toFixed(1));
    this.readout.textContent = `Momentary ${f(L.m)}   Short-term ${f(L.s)}   Integrated ${f(L.i)} LUFS`;
    // stereo
    const st = this.fit(this.phase);
    if (st && an) {
      const { g, w, h } = st;
      an.l.getFloatTimeDomainData(this.buf.l); an.r.getFloatTimeDomainData(this.buf.r);
      let ll = 0, rr = 0, lr = 0;
      for (let i = 0; i < 2048; i++) { const a = this.buf.l[i], b = this.buf.r[i]; ll += a * a; rr += b * b; lr += a * b; }
      const corr = playing && ll > 1e-9 && rr > 1e-9 ? lr / Math.sqrt(ll * rr) : 0;
      const bal = playing && ll + rr > 1e-9 ? (Math.sqrt(rr) - Math.sqrt(ll)) / (Math.sqrt(rr) + Math.sqrt(ll)) : 0;
      const bar = (y, v, label, lo, hi, good) => {
        g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(40, y, w - 48, 10);
        const x0 = 40 + (w - 48) * (0 - lo) / (hi - lo), x1 = 40 + (w - 48) * (v - lo) / (hi - lo);
        g.fillStyle = good(v) ? "#7fd6a8" : "#ff7a5a";
        g.fillRect(Math.min(x0, x1), y, Math.max(2, Math.abs(x1 - x0)), 10);
        g.fillStyle = "rgba(255,255,255,.5)"; g.font = "10px sans-serif"; g.fillText(label, 4, y + 9);
      };
      bar(6, corr, "Phase", -1, 1, (v) => v >= 0);
      bar(24, bal, "L / R", -1, 1, (v) => Math.abs(v) < 0.3);
    }
  }
}
