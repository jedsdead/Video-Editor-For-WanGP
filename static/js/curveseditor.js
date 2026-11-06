// Curves editor for the Colour panel: custom curves (master, red, green, blue) and Resolve-style hue / saturation /
// luminance curves (hue vs hue, hue vs sat, hue vs lum, lum vs sat, sat vs sat). Click to add a point, drag to move,
// double-click or right-click a point to remove it. The maths is grade.js bakeCurves (timeline_math on export).
import { el, clamp } from "./util.js";
import { curveShape, CURVE_N, IDENTITY, PERIODIC } from "./grade.js";

export const CURVE_MODES = [
  { id: "rgb", label: "Custom", curves: ["master", "r", "g", "b"] },
  { id: "hueHue", label: "Hue vs Hue" },
  { id: "hueSat", label: "Hue vs Sat" },
  { id: "hueLum", label: "Hue vs Lum" },
  { id: "lumSat", label: "Lum vs Sat" },
  { id: "satSat", label: "Sat vs Sat" },
];
const CHANNEL_COLOUR = { master: "#e8e8e8", r: "#ff5a5a", g: "#5ade6a", b: "#5a8cff" };
const CHANNEL_LABEL = { master: "Y", r: "R", g: "G", b: "B" };
// the six hue points (red, yellow, green, cyan, blue, magenta) for the hue curves' quick buttons
const HUES = [["R", 0], ["Y", 1 / 6], ["G", 2 / 6], ["C", 3 / 6], ["B", 4 / 6], ["M", 5 / 6]];
const AXIS = {
  hueHue: ["Hue", "Hue shift"], hueSat: ["Hue", "Saturation"], hueLum: ["Hue", "Luminance"],
  lumSat: ["Luminance", "Saturation"], satSat: ["Input saturation", "Output saturation"],
};

function hueRgb(h) {
  const k = [0, 2 / 3, 1 / 3].map(o => clamp(Math.abs(((h + o) % 1) * 6 - 3) - 1, 0, 1));
  return `rgb(${k.map(v => Math.round(v * 255)).join(",")})`;
}

export class CurvesEditor {
  // getGrade(): the grade shown; change(label, fn(curves, grade)): edit it (fn mutates a copy of grade.curves)
  constructor({ getGrade, change }) {
    this.getGrade = getGrade;
    this.change = change;
    this.mode = "rgb";
    this.channel = "master";
    this.drag = null;
    this.canvas = el("canvas.curves", { title: "Click to add a point, drag to move it, double-click or right-click a point to remove it." });
    this.modeSel = el("select", { onchange: () => { this.mode = this.modeSel.value; this.renderTools(); this.draw(); } },
      CURVE_MODES.map(m => el("option", { value: m.id }, m.label)));
    this.onOff = el("input", { type: "checkbox", title: "Curves on or off (compare)", onchange: () => this.change("Curves on/off", (_, g) => { g.curvesOn = this.onOff.checked; }) });
    this.tools = el("div.btnrow.curve-tools");
    this.node = el("div.curves-editor", {},
      el("div.btnrow", { style: { alignItems: "center", marginBottom: "6px" } },
        el("label", { style: { display: "flex", gap: "4px", alignItems: "center" } }, this.onOff, "On"), this.modeSel, el("div.spacer"),
        el("button.small", { title: "Reset this curve", onclick: () => this.resetCurve() }, "Reset"),
        el("button.small", { title: "Reset every curve", onclick: () => this.change("Reset curves", (c) => { for (const k of Object.keys(c)) delete c[k]; }) }, "Reset all")),
      this.tools, this.canvas);
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", () => { this.drag = null; });
    this.canvas.addEventListener("pointercancel", () => { this.drag = null; });
    this.canvas.addEventListener("dblclick", (e) => this.remove(e));
    this.canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); this.remove(e); });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    this.renderTools();
  }

  get name() { return this.mode === "rgb" ? this.channel : this.mode; }

  renderTools() {
    this.tools.innerHTML = "";
    if (this.mode === "rgb") {
      for (const ch of ["master", "r", "g", "b"]) {
        this.tools.append(el(`button.small.toggle${this.channel === ch ? ".on" : ""}`, { style: { color: CHANNEL_COLOUR[ch] },
          title: ch === "master" ? "Master (all channels)" : `${ch.toUpperCase()} channel`,
          onclick: () => { this.channel = ch; this.renderTools(); this.draw(); } }, CHANNEL_LABEL[ch]));
      }
    } else if (PERIODIC.includes(this.mode)) {
      this.tools.append(el("span.dim", { style: { fontSize: "11px" } }, "Add points:"));
      for (const [label, h] of HUES) {
        this.tools.append(el("button.small", { style: { color: hueRgb(h) }, title: `Add a point at ${label}`,
          onclick: () => this.addPoint(h, this.valueAt(h)) }, label));
      }
    }
  }

  points(name = this.name) {
    const g = this.getGrade();
    return (g?.curves?.[name] || []).map(p => [p[0], p[1]]);
  }
  // the points the editor shows: an untouched custom curve shows its two ends
  shownPoints(name = this.name) {
    const pts = this.points(name);
    if (!pts.length && IDENTITY.includes(name)) return [[0, 0], [1, 1]];
    return pts.sort((a, b) => a[0] - b[0]);
  }
  valueAt(x, name = this.name) {
    const shape = curveShape(this.getGrade()?.curves, name);
    const p = clamp(x, 0, 1) * (CURVE_N - 1), i = Math.min(CURVE_N - 2, Math.floor(p));
    return shape[i] + (shape[i + 1] - shape[i]) * (p - i);
  }

  setPoints(label, pts, name = this.name) {
    this.change(label, (c) => { c[name] = pts.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]); });
  }
  addPoint(x, y) {
    const pts = this.shownPoints();
    pts.push([clamp(x, 0, 1), clamp(y, 0, 1)]);
    pts.sort((a, b) => a[0] - b[0]);
    this.setPoints("Add curve point", pts);
    this.draw();
  }
  resetCurve() {
    const name = this.name;
    this.change("Reset curve", (c) => { delete c[name]; });
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1), r];
  }
  hit(x, y, r) {
    const pts = this.shownPoints();
    let best = -1, bd = 10;
    pts.forEach(([px, py], i) => { const d = Math.hypot((px - x) * r.width, (py - y) * r.height); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  down(e) {
    if (e.button !== 0) return;
    const [x, y, r] = this.local(e);
    let i = this.hit(x, y, r);
    const pts = this.shownPoints();
    if (i < 0) {
      // a click adds a point on the curve under the pointer (or where clicked when well away from it)
      const cy = this.valueAt(x);
      const py = Math.abs(cy - y) * r.height < 14 ? cy : y;
      pts.push([x, py]);
      pts.sort((a, b) => a[0] - b[0]);
      i = pts.findIndex(p => p[0] === x && p[1] === py);
      this.setPoints("Add curve point", pts);
    }
    this.drag = { index: i, pts };
    this.canvas.setPointerCapture(e.pointerId);
    this.draw();
  }
  move(e) {
    const [x, y, r] = this.local(e);
    if (!this.drag) { this.canvas.style.cursor = this.hit(x, y, r) >= 0 ? "grab" : "crosshair"; return; }
    const pts = this.drag.pts, i = this.drag.index;
    // a point stays between its neighbours (the ends of a custom curve keep their place in x)
    const lo = i > 0 ? pts[i - 1][0] + 0.005 : 0, hi = i < pts.length - 1 ? pts[i + 1][0] - 0.005 : 1;
    pts[i] = [clamp(x, lo, hi), y];
    this.setPoints("Move curve point", pts);
    this.draw();
  }
  remove(e) {
    const [x, y, r] = this.local(e);
    const i = this.hit(x, y, r);
    if (i < 0) return;
    const pts = this.shownPoints();
    pts.splice(i, 1);
    this.setPoints("Remove curve point", pts);
    this.draw();
  }

  sync() {
    const g = this.getGrade();
    this.onOff.checked = g?.curvesOn !== false;
    if (!this.drag) this.draw();
  }

  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#0c0d10"; g.fillRect(0, 0, w, h);
    const name = this.name, grade = this.getGrade();
    // backgrounds: a hue band along the bottom for hue curves, a grey ramp for luminance, a saturation ramp
    if (PERIODIC.includes(name)) {
      for (let x = 0; x < w; x++) { g.fillStyle = hueRgb(x / w); g.globalAlpha = 0.22; g.fillRect(x, 0, 1, h); g.globalAlpha = 0.9; g.fillRect(x, h - 8, 1, 8); }
      g.globalAlpha = 1;
    } else if (name === "lumSat") {
      const grad = g.createLinearGradient(0, 0, w, 0); grad.addColorStop(0, "#000"); grad.addColorStop(1, "#fff");
      g.fillStyle = grad; g.fillRect(0, h - 8, w, 8);
    } else if (name === "satSat") {
      const grad = g.createLinearGradient(0, 0, w, 0); grad.addColorStop(0, "#808080"); grad.addColorStop(1, "#ff3030");
      g.fillStyle = grad; g.fillRect(0, h - 8, w, 8);
    }
    // grid
    g.strokeStyle = "rgba(255,255,255,.07)"; g.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      g.beginPath(); g.moveTo(Math.round(w * k / 4) + .5, 0); g.lineTo(Math.round(w * k / 4) + .5, h); g.stroke();
      g.beginPath(); g.moveTo(0, Math.round(h * k / 4) + .5); g.lineTo(w, Math.round(h * k / 4) + .5); g.stroke();
    }
    // the neutral line
    g.strokeStyle = "rgba(255,255,255,.18)"; g.setLineDash([4, 4]); g.beginPath();
    if (IDENTITY.includes(name)) { g.moveTo(0, h); g.lineTo(w, 0); } else { g.moveTo(0, h / 2); g.lineTo(w, h / 2); }
    g.stroke(); g.setLineDash([]);
    // the other channels of the custom curves, faint
    const curves = grade?.curves;
    if (this.mode === "rgb") {
      for (const ch of ["master", "r", "g", "b"]) {
        if (ch === name) continue;
        const shape = curveShape(curves, ch);
        g.strokeStyle = CHANNEL_COLOUR[ch]; g.globalAlpha = 0.28; g.lineWidth = 1; g.beginPath();
        for (let i = 0; i < CURVE_N; i++) { const x = i / (CURVE_N - 1) * w, y = (1 - shape[i]) * h; i ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.stroke(); g.globalAlpha = 1;
      }
    }
    const shape = curveShape(curves, name);
    g.strokeStyle = this.mode === "rgb" ? CHANNEL_COLOUR[name] : "#ffcc4d";
    if (grade?.curvesOn === false) g.globalAlpha = 0.45;
    g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < CURVE_N; i++) { const x = i / (CURVE_N - 1) * w, y = (1 - shape[i]) * h; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke(); g.globalAlpha = 1;
    for (const [px, py] of this.shownPoints()) {
      g.fillStyle = "#fff"; g.strokeStyle = "#0c0d10"; g.lineWidth = 1.5;
      g.beginPath(); g.arc(px * w, (1 - py) * h, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    const axis = AXIS[name];
    if (axis) { g.fillStyle = "rgba(255,255,255,.4)"; g.font = "10px sans-serif"; g.fillText(`${axis[1]} ↑   ${axis[0]} →`, 6, 12); }
  }
}
