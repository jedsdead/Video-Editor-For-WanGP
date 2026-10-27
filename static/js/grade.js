// Colour grading maths (mirrors timeline_math.grade_params) and the lift/gamma/gain wheel widget.
import { clamp } from "./util.js";

const RED_ANGLE = 104 * Math.PI / 180;
const RANGES = { lift: 0.25, gamma: 0.5, gain: 0.5 };

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
  const neutral = Math.abs(u.exposure - 1) < 1e-6 && [...u.wb, ...u.gain, ...u.gammaInv].every(v => Math.abs(v - 1) < 1e-6)
    && u.lift.every(v => Math.abs(v) < 1e-6) && Math.abs(u.contrast - 1) < 1e-6 && Math.abs(u.saturation - 1) < 1e-6;
  return neutral ? null : u;
}

export function isNeutral(grade) { return gradeUniforms(grade) === null; }

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
