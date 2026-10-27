// Scopes: luma waveform, RGB parade, vectorscope and histogram, computed from the viewer image.
import { bus } from "./model.js";
import { el } from "./util.js";

const MODES = [["waveform", "Waveform"], ["parade", "RGB Parade"], ["vector", "Vectorscope"], ["histogram", "Histogram"]];

export class ScopesPanel {
  constructor(app) {
    this.app = app;
    this.mode = localStorage.getItem("ve_scope_mode") || "waveform";
    this.canvas = el("canvas");
    this.sample = document.createElement("canvas");
    this.buttons = MODES.map(([id, label]) => el(`button.small${id === this.mode ? ".primary" : ""}`, { onclick: () => this.setMode(id) }, label));
    this.node = el("div", {}, el("div.panel-toolbar", {}, this.buttons), el("div.scope-wrap", {}, this.canvas));
    this.visible = false;
    this.last = 0;
    bus.on("rendered", () => this.update());
    new ResizeObserver(() => { this.last = 0; this.update(true); }).observe(this.canvas);
  }

  setMode(mode) {
    this.mode = mode;
    localStorage.setItem("ve_scope_mode", mode);
    this.buttons.forEach((b, i) => b.classList.toggle("primary", MODES[i][0] === mode));
    this.update(true);
  }

  update(force = false) {
    if (!this.visible) return;
    const now = performance.now();
    if (!force && now - this.last < 90) return;
    this.last = now;
    const source = this.app.renderer.canvas;
    const w = Math.max(64, Math.min(320, source.width)), h = Math.max(36, Math.round(w * source.height / Math.max(1, source.width)));
    this.sample.width = w; this.sample.height = h;
    const sctx = this.sample.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(source, 0, 0, w, h);
    const px = sctx.getImageData(0, 0, w, h).data;
    const cw = Math.max(50, Math.round(this.canvas.clientWidth * devicePixelRatio)), ch = Math.max(50, Math.round(this.canvas.clientHeight * devicePixelRatio));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    const ctx = this.canvas.getContext("2d");
    ctx.fillStyle = "#08090b";
    ctx.fillRect(0, 0, cw, ch);
    if (this.mode === "vector") this.vectorscope(ctx, px, cw, ch);
    else if (this.mode === "histogram") this.histogram(ctx, px, cw, ch);
    else this.waveform(ctx, px, w, h, cw, ch, this.mode === "parade");
  }

  waveform(ctx, px, w, h, cw, ch, parade) {
    const cols = parade ? w * 3 : w;
    const rows = 256;
    const acc = new Float32Array(cols * rows);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      if (parade) { acc[(255 - r) * cols + x]++; acc[(255 - g) * cols + w + x]++; acc[(255 - b) * cols + 2 * w + x]++; }
      else acc[(255 - Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)) * cols + x]++;
    }
    const img = new ImageData(cols, rows);
    const gain = 255 * 6 / h;
    for (let i = 0; i < acc.length; i++) {
      const v = Math.min(255, acc[i] * gain);
      if (!v) continue;
      const k = i * 4, x = i % cols;
      if (!parade) { img.data[k] = v * 0.75; img.data[k + 1] = v; img.data[k + 2] = v * 0.8; }
      else { const ch_ = Math.floor(x / w); img.data[k] = ch_ === 0 ? v : v * 0.15; img.data[k + 1] = ch_ === 1 ? v : v * 0.15; img.data[k + 2] = ch_ === 2 ? v : v * 0.2; }
      img.data[k + 3] = 255;
    }
    const tmp = document.createElement("canvas");
    tmp.width = cols; tmp.height = rows;
    tmp.getContext("2d").putImageData(img, 0, 0);
    const pad = 22 * devicePixelRatio;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, pad, 4, cw - pad - 4, ch - 8);
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.fillStyle = "rgba(255,255,255,.45)";
    ctx.font = `${9 * devicePixelRatio}px Consolas, monospace`;
    for (const level of [0, 25, 50, 75, 100]) {
      const y = 4 + (ch - 8) * (1 - level / 100);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(cw - 4, y); ctx.stroke();
      ctx.fillText(String(level), 2, y + 3);
    }
  }

  vectorscope(ctx, px, cw, ch) {
    const size = Math.min(cw, ch) - 12;
    const n = 200;
    const acc = new Float32Array(n * n);
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const cb = (b - y) / 1.8556, cr = (r - y) / 1.5748;
      const x = Math.round((cb + 0.5) * (n - 1)), yy = Math.round((0.5 - cr) * (n - 1));
      if (x >= 0 && x < n && yy >= 0 && yy < n) acc[yy * n + x]++;
    }
    const img = new ImageData(n, n);
    for (let i = 0; i < acc.length; i++) {
      if (!acc[i]) continue;
      const v = Math.min(255, 40 + acc[i] * 25);
      const k = i * 4;
      img.data[k] = v * 0.7; img.data[k + 1] = v; img.data[k + 2] = v * 0.7; img.data[k + 3] = 255;
    }
    const tmp = document.createElement("canvas");
    tmp.width = n; tmp.height = n;
    tmp.getContext("2d").putImageData(img, 0, 0);
    const ox = (cw - size) / 2, oy = (ch - size) / 2;
    ctx.strokeStyle = "rgba(255,255,255,.15)";
    ctx.beginPath(); ctx.arc(cw / 2, ch / 2, size / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cw / 2 - size / 2, ch / 2); ctx.lineTo(cw / 2 + size / 2, ch / 2); ctx.moveTo(cw / 2, ch / 2 - size / 2); ctx.lineTo(cw / 2, ch / 2 + size / 2); ctx.stroke();
    // skin tone line
    ctx.strokeStyle = "rgba(255,190,140,.35)";
    ctx.beginPath(); ctx.moveTo(cw / 2, ch / 2); ctx.lineTo(cw / 2 + Math.cos(-2.15) * size / 2, ch / 2 + Math.sin(-2.15) * size / 2); ctx.stroke();
    ctx.drawImage(tmp, ox, oy, size, size);
    const targets = [["R", [0.75, 0, 0]], ["Mg", [0.75, 0, 0.75]], ["B", [0, 0, 0.75]], ["Cy", [0, 0.75, 0.75]], ["G", [0, 0.75, 0]], ["Yl", [0.75, 0.75, 0]]];
    ctx.font = `${10 * devicePixelRatio}px Segoe UI, sans-serif`;
    for (const [label, [r, g, b]] of targets) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const cb = (b - y) / 1.8556, cr = (r - y) / 1.5748;
      const x = ox + (cb + 0.5) * size, yy = oy + (0.5 - cr) * size;
      ctx.strokeStyle = `rgb(${r * 340},${g * 340},${b * 340})`;
      ctx.strokeRect(x - 5, yy - 5, 10, 10);
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.fillText(label, x + 7, yy + 4);
    }
  }

  histogram(ctx, px, cw, ch) {
    const bins = [new Float32Array(256), new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (let i = 0; i < px.length; i += 4) {
      bins[0][px[i]]++; bins[1][px[i + 1]]++; bins[2][px[i + 2]]++;
      bins[3][Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2])]++;
    }
    let max = 1;
    for (const b of bins) for (let i = 1; i < 255; i++) max = Math.max(max, b[i]);
    const colors = ["rgba(255,80,80,.55)", "rgba(80,255,120,.5)", "rgba(90,140,255,.55)", "rgba(230,230,230,.35)"];
    ctx.globalCompositeOperation = "lighter";
    bins.forEach((b, ci) => {
      ctx.fillStyle = colors[ci];
      ctx.beginPath();
      ctx.moveTo(4, ch - 4);
      for (let i = 0; i < 256; i++) ctx.lineTo(4 + (cw - 8) * i / 255, ch - 4 - (ch - 8) * Math.min(1, b[i] / max));
      ctx.lineTo(cw - 4, ch - 4);
      ctx.closePath();
      ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";
  }
}
