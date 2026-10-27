// Transition catalogue and maths. Video transitions are families with parameters (angle, shape, style...);
// the same formulas exist three times: GLSL here (viewer), torch in render.py (export) and a small CPU copy
// for the panel tiles. Keep them in step.

export const FAMILIES = [
  { id: "dissolve", label: "Dissolve", edge: false },
  { id: "wipe", label: "Wipe", edge: true },
  { id: "slide", label: "Slide", edge: true },
  { id: "iris", label: "Iris", edge: true },
  { id: "clock", label: "Clock wipe", edge: true },
  { id: "blinds", label: "Venetian blinds", edge: true },
  { id: "barn", label: "Barn door", edge: true },
];
export const DISSOLVE_STYLES = [["cross", "Cross dissolve"], ["film", "Film dissolve"], ["additive", "Additive dissolve"], ["nonadditive", "Non-additive dissolve"], ["dip", "Dip to colour"]];
export const IRIS_SHAPES = [["circle", "Circle"], ["oval", "Oval"], ["diamond", "Diamond"], ["square", "Square"], ["cross", "Cross (+)"], ["x", "X"], ["triangle", "Triangle"]];
export const ANGLE_PRESETS = [[0, "→"], [45, "↗"], [90, "↑"], [135, "↖"], [180, "←"], [225, "↙"], [270, "↓"], [315, "↘"]];
export const MAX_BORDER = 0.5;

export const DEFAULT_PARAMS = {
  dissolve: { style: "cross", color: "#000000" },
  wipe: { angle: 0 },
  slide: { angle: 180, push: false },
  iris: { shape: "circle", reverse: false },
  clock: { reverse: false },
  blinds: { angle: 0, count: 8 },
  barn: { angle: 0, reverse: false },
};

// Tiles shown in the Transitions panel.
export const VIDEO_PRESETS = [
  { id: "dissolve", label: "Dissolve", type: "dissolve", params: {} },
  { id: "dip", label: "Dip to black", type: "dissolve", params: { style: "dip", color: "#000000" } },
  { id: "wipe", label: "Wipe", type: "wipe", params: {} },
  { id: "slide", label: "Slide", type: "slide", params: {} },
  { id: "iris", label: "Iris", type: "iris", params: {} },
  { id: "clock", label: "Clock wipe", type: "clock", params: {} },
  { id: "blinds", label: "Venetian blinds", type: "blinds", params: {} },
  { id: "barn", label: "Barn door", type: "barn", params: {} },
  { id: "iris_cross", label: "Cross (+)", type: "iris", params: { shape: "cross" } },
  { id: "iris_x", label: "X", type: "iris", params: { shape: "x" } },
  { id: "iris_triangle", label: "Triangle", type: "iris", params: { shape: "triangle" } },
];
export const AUDIO_TRANSITIONS = [
  { id: "a_power", label: "Crossfade (equal power)" },
  { id: "a_linear", label: "Crossfade (linear)" },
  { id: "a_dip", label: "Dip (out, then in)" },
];
export const VIDEO_TRANSITIONS = VIDEO_PRESETS;   // kept for older imports
export const isAudioTransition = (id) => String(id).startsWith("a_");
export const familyOf = (type) => FAMILIES.find(f => f.id === type) || FAMILIES[0];
export const hasEdge = (type) => !!familyOf(type).edge && !isAudioTransition(type);

export function presetTransition(presetId) {
  const audio = AUDIO_TRANSITIONS.find(a => a.id === presetId);
  if (audio) return { type: audio.id, params: {} };
  const preset = VIDEO_PRESETS.find(p => p.id === presetId) || VIDEO_PRESETS[0];
  return { type: preset.type, params: { ...DEFAULT_PARAMS[preset.type], ...preset.params } };
}

// Older projects used one type per direction; convert them in place.
const LEGACY = {
  dip_black: ["dissolve", { style: "dip", color: "#000000" }], dip_white: ["dissolve", { style: "dip", color: "#ffffff" }],
  wipe_left: ["wipe", { angle: 180 }], wipe_right: ["wipe", { angle: 0 }], wipe_up: ["wipe", { angle: 90 }], wipe_down: ["wipe", { angle: 270 }],
  slide_left: ["slide", { angle: 180 }], slide_right: ["slide", { angle: 0 }], push_left: ["slide", { angle: 180, push: true }], push_right: ["slide", { angle: 0, push: true }],
  circle_open: ["iris", { shape: "circle" }], circle_close: ["iris", { shape: "circle", reverse: true }],
};
export function normalizeTransition(tr) {
  if (isAudioTransition(tr.type)) return tr;
  if (LEGACY[tr.type]) { const [type, params] = LEGACY[tr.type]; tr.type = type; tr.params = { ...(tr.params || {}), ...params }; }
  if (!DEFAULT_PARAMS[tr.type]) tr.type = "dissolve";
  tr.params = { ...DEFAULT_PARAMS[tr.type], ...(tr.params || {}) };
  return tr;
}

export function transitionLabel(trOrType) {
  if (typeof trOrType === "string") return (AUDIO_TRANSITIONS.find(a => a.id === trOrType) || VIDEO_PRESETS.find(p => p.id === trOrType) || familyOf(trOrType)).label;
  const tr = trOrType;
  if (isAudioTransition(tr.type)) return AUDIO_TRANSITIONS.find(a => a.id === tr.type)?.label || tr.type;
  const p = tr.params || {};
  if (tr.type === "dissolve") return (DISSOLVE_STYLES.find(s => s[0] === p.style) || DISSOLVE_STYLES[0])[1];
  if (tr.type === "iris") return `${p.shape && p.shape !== "circle" ? (IRIS_SHAPES.find(s => s[0] === p.shape) || ["", "Iris"])[1] : "Iris"}${p.reverse ? " (close)" : ""}`;
  const base = familyOf(tr.type).label;
  return "angle" in p ? `${base} ${Math.round(p.angle)}°` : base;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const v = m ? parseInt(m[1], 16) : 0xffffff;
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}

// Shader uniforms for a transition.
export function transitionUniforms(tr) {
  const p = { ...DEFAULT_PARAMS[tr.type] || {}, ...(tr.params || {}) };
  const family = Math.max(0, FAMILIES.findIndex(f => f.id === tr.type));
  let mode = 0;
  if (tr.type === "dissolve") mode = Math.max(0, DISSOLVE_STYLES.findIndex(s => s[0] === p.style));
  if (tr.type === "iris") mode = Math.max(0, IRIS_SHAPES.findIndex(s => s[0] === p.shape));
  if (tr.type === "blinds") mode = Math.max(1, Math.round(p.count || 8));
  return {
    family, mode, angle: (Number(p.angle) || 0) * Math.PI / 180, reverse: !!p.reverse, push: !!p.push, color: hexToRgb(p.color || "#000000"),
    feather: !!tr.feather, border: Math.min(MAX_BORDER, Math.max(0, Number(tr.border) || 0)), borderColor: hexToRgb(tr.borderColor || "#ffffff"),
  };
}

export const TRANSITION_GLSL = `
const float AA = 0.0015;
float sm(float e0, float e1, float x) { return smoothstep(e0, e1, x); }
vec4 sampleImg(sampler2D t, vec2 q) { return texture(t, vec2(q.x, 1.0 - q.y)); }
bool inside01(vec2 q) { return q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0; }
float irisDist(int shape, float x, float y, float X, float Y) {
  if (shape == 0) return length(vec2(X, Y)) / length(vec2(uAspect * 0.5, 0.5));
  if (shape == 1) return length(vec2(x, y)) / length(vec2(0.5, 0.5));
  if (shape == 2) return abs(x) + abs(y);
  if (shape == 3) return 2.0 * max(abs(x), abs(y));
  if (shape == 4) return 2.0 * min(abs(x), abs(y));
  if (shape == 5) return min(abs(x + y), abs(x - y)) / 0.5;
  return max(abs(x) * 0.8660254 + y * 0.5, -y) / 0.6830127;
}
vec4 transition(vec2 uv) {
  float p = uP;
  vec2 img = vec2(uv.x, 1.0 - uv.y);
  vec4 A = texture(uA, uv); vec4 B = texture(uB, uv);
  if (uFamily == 0) {
    if (uMode == 1) { vec3 la = pow(A.rgb, vec3(2.2)), lb = pow(B.rgb, vec3(2.2)); return vec4(pow(mix(la, lb, p), vec3(1.0 / 2.2)), mix(A.a, B.a, p)); }
    if (uMode == 2) return min(A * min(1.0, 2.0 * (1.0 - p)) + B * min(1.0, 2.0 * p), vec4(1.0));
    if (uMode == 3) return max(A * min(1.0, 2.0 * (1.0 - p)), B * min(1.0, 2.0 * p));
    if (uMode == 4) { vec4 C = vec4(uColor, 1.0); return p < 0.5 ? mix(A, C, p * 2.0) : mix(C, B, p * 2.0 - 1.0); }
    return mix(A, B, p);
  }
  float s = uFeather ? max(uBorder * 0.5, AA) : AA;
  float bw = uFeather ? 0.0 : uBorder;
  float pad = s + bw * 0.5;
  float inc = -pad + p * (1.0 + 2.0 * pad);
  float dec = (1.0 + pad) - p * (1.0 + 2.0 * pad);
  float dx = cos(uAngle), dy = -sin(uAngle);
  float x = img.x - 0.5, y = img.y - 0.5;
  float X = x * uAspect, Y = y;
  if (uFamily == 2) {
    float L = 1.0 / max(abs(dx), abs(dy));
    vec2 Tv = vec2(dx, dy) * L;
    float padS = 2.0 * s + bw;
    vec2 oB = -(1.0 - p) * Tv * (1.0 + padS);
    vec2 q = img - oB;
    float e = 1e-3;
    float ox = dx > e ? q.x - 1.0 : (dx < -e ? -q.x : -1e9);
    float oy = dy > e ? q.y - 1.0 : (dy < -e ? -q.y : -1e9);
    float outd = max(ox, oy);
    bool inX = dx > e ? q.x >= 0.0 : (dx < -e ? q.x <= 1.0 : (q.x >= 0.0 && q.x <= 1.0));
    bool inY = dy > e ? q.y >= 0.0 : (dy < -e ? q.y <= 1.0 : (q.y >= 0.0 && q.y <= 1.0));
    vec4 base = A;
    if (uPush) { vec2 qa = img - p * Tv * (1.0 + padS); base = inside01(qa) ? sampleImg(uA, qa) : vec4(0.0); }
    float aB = (inX && inY) ? (outd <= 0.0 ? 1.0 : 1.0 - sm(0.0, 2.0 * s, outd)) : 0.0;
    vec4 Bs = sampleImg(uB, clamp(q, 0.0, 1.0)) * aB;
    vec4 o = Bs + base * (1.0 - Bs.a);
    if (bw > 0.0 && inX && inY) {
      float bm = sm(-AA, AA, outd) * (1.0 - sm(bw - AA, bw + AA, outd));
      o = mix(o, vec4(uBorderColor, 1.0), bm);
    }
    return o;
  }
  float v; float ed; float m;
  float dirR = 0.5 * uAspect * abs(dx) + 0.5 * abs(dy);
  float proj = X * dx + Y * dy;
  if (uFamily == 1) { v = proj / (2.0 * dirR) + 0.5; ed = inc; m = 1.0 - sm(ed - s, ed + s, v); }
  else if (uFamily == 5) { v = fract((proj / (2.0 * dirR) + 0.5) * float(uMode)); ed = inc; m = 1.0 - sm(ed - s, ed + s, v); }
  else if (uFamily == 4) {
    v = atan(X, -Y) / 6.2831853; if (v < 0.0) v += 1.0;
    if (uReverse) v = 1.0 - v;
    ed = inc; m = 1.0 - sm(ed - s, ed + s, v);
  } else {
    v = uFamily == 6 ? abs(proj) / dirR : irisDist(uMode, x, y, X, Y);
    if (uReverse) { ed = dec; m = sm(ed - s, ed + s, v); } else { ed = inc; m = 1.0 - sm(ed - s, ed + s, v); }
  }
  vec4 o = mix(A, B, m);
  if (bw > 0.0) {
    float bm = 1.0 - sm(bw * 0.5 - AA, bw * 0.5 + AA, abs(v - ed));
    o = mix(o, vec4(uBorderColor, 1.0), bm);
  }
  return o;
}`;

// ------------------------------------------------------------ CPU copy (panel tiles)
const smoothJs = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
export function cpuTransitionPixel(tr, ix, iy, p, aspect, A, B) {
  const u = transitionUniforms(tr);
  const mix = (a, b, m) => a.map((v, i) => v * (1 - m) + b[i] * m);
  if (u.family === 0) {
    if (u.mode === 4) { const C = u.color.map(v => v * 255); return p < 0.5 ? mix(A, C, p * 2) : mix(C, B, p * 2 - 1); }
    return mix(A, B, p);
  }
  const s = u.feather ? Math.max(u.border * 0.5, 0.0015) : 0.0015, bw = u.feather ? 0 : u.border, pad = s + bw * 0.5;
  const inc = -pad + p * (1 + 2 * pad), dec = (1 + pad) - p * (1 + 2 * pad);
  const dx = Math.cos(u.angle), dy = -Math.sin(u.angle);
  const x = ix - 0.5, y = iy - 0.5, X = x * aspect, Y = y;
  if (u.family === 2) {
    const L = 1 / Math.max(Math.abs(dx), Math.abs(dy));
    const qx = ix + (1 - p) * dx * L, qy = iy + (1 - p) * dy * L;
    const inB = qx >= 0 && qx <= 1 && qy >= 0 && qy <= 1;
    if (inB) return B;
    if (u.push) { const ax = ix - p * dx * L, ay = iy - p * dy * L; return ax >= 0 && ax <= 1 && ay >= 0 && ay <= 1 ? A.map(v => v * 0.8) : [0, 0, 0]; }
    return A;
  }
  const dirR = 0.5 * aspect * Math.abs(dx) + 0.5 * Math.abs(dy), proj = X * dx + Y * dy;
  let v, ed, m;
  if (u.family === 1) { v = proj / (2 * dirR) + 0.5; ed = inc; m = 1 - smoothJs(ed - s, ed + s, v); }
  else if (u.family === 5) { const w = (proj / (2 * dirR) + 0.5) * u.mode; v = w - Math.floor(w); ed = inc; m = 1 - smoothJs(ed - s, ed + s, v); }
  else if (u.family === 4) { v = Math.atan2(X, -Y) / (2 * Math.PI); if (v < 0) v += 1; if (u.reverse) v = 1 - v; ed = inc; m = 1 - smoothJs(ed - s, ed + s, v); }
  else {
    const ax = Math.abs(x), ay = Math.abs(y);
    const shape = [Math.hypot(X, Y) / Math.hypot(aspect * 0.5, 0.5), Math.hypot(x, y) / Math.hypot(0.5, 0.5), ax + ay, 2 * Math.max(ax, ay), 2 * Math.min(ax, ay),
                   Math.min(Math.abs(x + y), Math.abs(x - y)) / 0.5, Math.max(ax * 0.8660254 + y * 0.5, -y) / 0.6830127];
    v = u.family === 6 ? Math.abs(proj) / dirR : shape[u.mode];
    if (u.reverse) { ed = dec; m = smoothJs(ed - s, ed + s, v); } else { ed = inc; m = 1 - smoothJs(ed - s, ed + s, v); }
  }
  let o = mix(A, B, m);
  if (bw > 0) { const bm = 1 - smoothJs(bw * 0.5 - 0.0015, bw * 0.5 + 0.0015, Math.abs(v - ed)); o = mix(o, u.borderColor.map(c => c * 255), bm); }
  return o;
}
