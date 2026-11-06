// Colour grading maths (mirrors timeline_math.grade_params) and the lift/gamma/gain wheel widget.
import { clamp } from "./util.js";

const RED_ANGLE = 104 * Math.PI / 180;
const RANGES = { lift: 0.25, gamma: 0.5, gain: 0.5 };
// Tonal ("Final Cut style") wheels: colour push and brightness are offsets, saturation multiplies.
export const ZONE_COLOR = 0.25, ZONE_BRIGHT = 0.5;
export const ZONES = ["master", "shadows", "mids", "highs"];

function wheelVector(wheel, scale) {
  const x = wheel?.x || 0, y = wheel?.y || 0;
  const m = Math.min(1, Math.hypot(x, y));
  if (m < 1e-6) return [0, 0, 0];
  const h = Math.atan2(y, x) - RED_ANGLE;
  return [Math.cos(h), Math.cos(h - 2 * Math.PI / 3), Math.cos(h + 2 * Math.PI / 3)].map(v => v * m * scale);
}

export function gradeUniforms(grade) {
  if (!grade || grade.enabled === false) return null;
  const lift = wheelVector(grade.lift, RANGES.lift).map(v => v + (grade.lift?.master || 0));
  const gain = wheelVector(grade.gain, RANGES.gain).map(v => 1 + v + (grade.gain?.master || 0));
  const gamma = wheelVector(grade.gamma, RANGES.gamma).map(v => Math.max(0.05, 1 + v + (grade.gamma?.master || 0)));
  const t = grade.temperature || 0, tint = grade.tint || 0;
  const u = {
    exposure: Math.pow(2, grade.exposure || 0), wb: [1 + 0.2 * t, 1 - 0.2 * tint, 1 - 0.2 * t],
    lift, gain, gammaInv: gamma.map(g => 1 / g), contrast: 1 + (grade.contrast || 0),
    saturation: grade.saturation ?? 1,
  };
  u.style = grade.style === "zones" ? 1 : 0;
  if (u.style === 1) {
    u.zoneOff = ZONES.map(z => wheelVector(grade[z], ZONE_COLOR).map(v => v + ZONE_BRIGHT * (grade[z]?.bright || 0)));
    u.zoneSat = ZONES.map(z => Math.max(0, grade[z]?.sat ?? 1));
    u.zoneLo = clamp(grade.zoneLow ?? 0.33, 0.02, 0.96);
    u.zoneHi = clamp(grade.zoneHigh ?? 0.67, u.zoneLo + 0.02, 0.98);
    u.lift = [0, 0, 0]; u.gain = [1, 1, 1]; u.gammaInv = [1, 1, 1];
  }
  const zonesNeutral = u.style !== 1 || (u.zoneOff.every(o => o.every(v => Math.abs(v) < 1e-6)) && u.zoneSat.every(v => Math.abs(v - 1) < 1e-6));
  u.curves = bakeCurves(grade);
  u.match = matchUniform(grade);
  const neutral = !u.curves && !u.match && Math.abs(u.exposure - 1) < 1e-6 && [...u.wb, ...u.gain, ...u.gammaInv].every(v => Math.abs(v - 1) < 1e-6)
    && u.lift.every(v => Math.abs(v) < 1e-6) && Math.abs(u.contrast - 1) < 1e-6 && Math.abs(u.saturation - 1) < 1e-6 && zonesNeutral;
  return neutral ? null : u;
}

export function isNeutral(grade) { return gradeUniforms(grade) === null; }

// ---- curves (mirrors timeline_math.bake_curves): grade.curves = {name: [[x, y], ...]} in 0..1.
// master/r/g/b map a channel; hueHue shifts hue by (y - 0.5) turns; hueSat, hueLum and lumSat multiply by 2y (0.5 is
// neutral); satSat maps saturation. Baked to CURVE_N samples by a monotone cubic through the points.
export const CURVE_N = 256;
export const CURVE_ROWS = ["master", "r", "g", "b", "hueHue", "hueSat", "hueLum", "lumSat", "satSat"];
export const PERIODIC = ["hueHue", "hueSat", "hueLum"];
export const IDENTITY = ["master", "r", "g", "b", "satSat"];

export function monotone(xs, ys, t) {
  const n = xs.length;
  if (n === 1 || t <= xs[0]) return ys[0];
  if (t >= xs[n - 1]) return ys[n - 1];
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]));
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-12) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  let i = 0;
  while (i < n - 2 && t > xs[i + 1]) i++;
  const hgt = xs[i + 1] - xs[i], u = (t - xs[i]) / Math.max(1e-9, hgt);
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
  return h00 * ys[i] + h10 * hgt * m[i] + h01 * ys[i + 1] + h11 * hgt * m[i + 1];
}

export function curvePoints(curves, name) {
  return ((curves || {})[name] || []).filter(p => p && Number.isFinite(+p[0]) && Number.isFinite(+p[1]))
    .map(([x, y]) => [clamp(+x, 0, 1), clamp(+y, 0, 1)]).sort((a, b) => a[0] - b[0]);
}
export function curveNeutral(curves, name) {
  const pts = curvePoints(curves, name);
  if (!pts.length) return true;
  return IDENTITY.includes(name) ? pts.every(([x, y]) => Math.abs(x - y) < 1e-4) : pts.every(([, y]) => Math.abs(y - 0.5) < 1e-4);
}
// The curve's shape in 0..1 (what the editor draws): y at each of CURVE_N points.
export function curveShape(curves, name) {
  let pts = curvePoints(curves, name);
  const out = new Float32Array(CURVE_N);
  for (let i = 0; i < CURVE_N; i++) out[i] = IDENTITY.includes(name) ? i / (CURVE_N - 1) : 0.5;
  if (!pts.length) return out;
  let xs, ys;
  if (PERIODIC.includes(name)) {
    const ext = [...pts.map(([x, y]) => [x - 1, y]), ...pts, ...pts.map(([x, y]) => [x + 1, y])];
    xs = ext.map(p => p[0]); ys = ext.map(p => p[1]);
  } else {
    if (IDENTITY.includes(name)) pts = [...(pts[0][0] > 1e-4 ? [[0, 0]] : []), ...pts, ...(pts[pts.length - 1][0] < 1 - 1e-4 ? [[1, 1]] : [])];
    xs = pts.map(p => p[0]); ys = pts.map(p => p[1]);
  }
  for (let i = 0; i < CURVE_N; i++) out[i] = monotone(xs, ys, i / (CURVE_N - 1));
  return out;
}
export function bakeCurve(curves, name) {
  const y = curveShape(curves, name);
  for (let i = 0; i < CURVE_N; i++) {
    if (name === "hueHue") y[i] = y[i] - 0.5;
    else if (name === "hueSat" || name === "hueLum" || name === "lumSat") y[i] = Math.max(0, 2 * y[i]);
    else y[i] = clamp(y[i], 0, 1);
  }
  return y;
}
// {data: Float32Array(CURVE_N * rows), rgb, hsl, sig} or null when the curves do nothing.
export function bakeCurves(grade) {
  const curves = grade?.curves;
  if (!curves || grade.curvesOn === false) return null;
  const rgb = ["master", "r", "g", "b"].some(n => !curveNeutral(curves, n));
  const hsl = ["hueHue", "hueSat", "hueLum", "lumSat", "satSat"].some(n => !curveNeutral(curves, n));
  if (!rgb && !hsl) return null;
  const data = new Float32Array(CURVE_N * CURVE_ROWS.length);
  CURVE_ROWS.forEach((n, r) => data.set(bakeCurve(curves, n), r * CURVE_N));
  return { data, rgb, hsl, sig: JSON.stringify(curves) };
}
// A shot match: after the grade and the LUT, c * gain + offset.
export function matchUniform(grade) {
  const m = grade?.match;
  if (!m || m.on === false || grade.enabled === false) return null;
  const gain = (m.gain || [1, 1, 1]).slice(0, 3).map(Number), offset = (m.offset || [0, 0, 0]).slice(0, 3).map(Number);
  if (gain.every(g => Math.abs(g - 1) < 1e-5) && offset.every(o => Math.abs(o) < 1e-5)) return null;
  return { gain, offset };
}

// Colour shown on the wheel at an angle: the direction a puck pushes the image.
function wheelColour(angle, strength = 1) {
  const h = angle - RED_ANGLE;
  const d = [Math.cos(h), Math.cos(h - 2 * Math.PI / 3), Math.cos(h + 2 * Math.PI / 3)];
  return d.map(v => clamp(0.5 + 0.42 * v * strength, 0, 1) * 255);
}

export class ColorWheel {
  constructor(canvas, { onChange, onCommit } = {}) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.onCommit = onCommit;
    this.value = { x: 0, y: 0 };
    this.background = null;
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("dblclick", () => { this.set({ x: 0, y: 0 }, true); });
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const size = Math.max(60, Math.round(this.canvas.clientWidth * devicePixelRatio));
    if (this.canvas.width !== size) { this.canvas.width = this.canvas.height = size; this.background = null; }
    this.draw();
  }

  buildBackground() {
    const n = this.canvas.width;
    const img = new ImageData(n, n);
    const r = n / 2 - 2;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const dx = i - n / 2, dy = n / 2 - j;
      const d = Math.hypot(dx, dy);
      const k = (j * n + i) * 4;
      if (d > r) { img.data[k + 3] = 0; continue; }
      const [cr, cg, cb] = wheelColour(Math.atan2(dy, dx), d / r);
      const shade = 0.55;
      img.data[k] = cr * shade; img.data[k + 1] = cg * shade; img.data[k + 2] = cb * shade;
      img.data[k + 3] = d > r - 1.5 ? 140 : 255;
    }
    this.background = img;
  }

  draw() {
    const ctx = this.canvas.getContext("2d");
    const n = this.canvas.width;
    if (!this.background || this.background.width !== n) this.buildBackground();
    ctx.putImageData(this.background, 0, 0);
    const r = n / 2 - 2;
    ctx.strokeStyle = "rgba(255,255,255,.18)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(n / 2, n / 2, r * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(n / 2 - 6, n / 2); ctx.lineTo(n / 2 + 6, n / 2); ctx.moveTo(n / 2, n / 2 - 6); ctx.lineTo(n / 2, n / 2 + 6); ctx.stroke();
    const px = n / 2 + this.value.x * r, py = n / 2 - this.value.y * r;
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * devicePixelRatio;
    ctx.beginPath(); ctx.arc(px, py, 5 * devicePixelRatio, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(px, py, 7 * devicePixelRatio, 0, Math.PI * 2); ctx.stroke();
  }

  set(value, notify = false) {
    this.value = { x: value.x || 0, y: value.y || 0 };
    this.draw();
    if (notify) { this.onChange && this.onChange(this.value); this.onCommit && this.onCommit(this.value); }
  }

  down(e) {
    const rect = this.canvas.getBoundingClientRect();
    const fine = e.shiftKey ? 0.25 : 1;
    const start = { ...this.value }, sx = e.clientX, sy = e.clientY;
    const absolute = !e.shiftKey;
    const update = (ev) => {
      const r = rect.width / 2 - 2;
      let x, y;
      if (absolute && !ev.shiftKey) { x = (ev.clientX - rect.left - rect.width / 2) / r; y = -(ev.clientY - rect.top - rect.height / 2) / r; }
      else { x = start.x + (ev.clientX - sx) / r * fine; y = start.y - (ev.clientY - sy) / r * fine; }
      const m = Math.hypot(x, y);
      if (m > 1) { x /= m; y /= m; }
      this.value = { x, y };
      this.draw();
      this.onChange && this.onChange(this.value);
    };
    if (absolute) update(e);
    this.canvas.setPointerCapture(e.pointerId);
    const move = (ev) => update(ev);
    const up = () => {
      this.canvas.removeEventListener("pointermove", move);
      this.canvas.removeEventListener("pointerup", up);
      this.onCommit && this.onCommit(this.value);
    };
    this.canvas.addEventListener("pointermove", move);
    this.canvas.addEventListener("pointerup", up);
  }
}
