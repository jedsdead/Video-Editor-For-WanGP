// Effect catalogue and shader maths. Effects run in the clip's own image space, in order, on premultiplied colour.
// fx.py implements the same effects for export; parameter units are the ones shown in the Inspector.

export const EFFECTS = {
  blur: { label: "Blur", params: [{ key: "amount", label: "Amount", min: 0, max: 100, step: 0.5, def: 20, unit: "%" }] },
  sharpen: { label: "Sharpen", params: [{ key: "amount", label: "Amount", min: 0, max: 300, step: 1, def: 60, unit: "%" }] },
  vignette: { label: "Vignette", params: [
    { key: "amount", label: "Amount", min: 0, max: 100, step: 0.5, def: 50, unit: "%" },
    { key: "size", label: "Size", min: 0, max: 100, step: 0.5, def: 50, unit: "%" },
    { key: "softness", label: "Softness", min: 0, max: 100, step: 0.5, def: 50, unit: "%" }] },
  grain: { label: "Film grain", params: [
    { key: "amount", label: "Amount", min: 0, max: 100, step: 0.5, def: 25, unit: "%" },
    { key: "size", label: "Grain size", min: 1, max: 4, step: 0.1, def: 1.5, unit: "px" }] },
  bw: { label: "Black & white", params: [{ key: "amount", label: "Amount", min: 0, max: 100, step: 0.5, def: 100, unit: "%" }] },
  chroma: { label: "Chroma key", params: [
    { key: "color", label: "Key colour", type: "color", def: "#00ff00" },
    { key: "tolerance", label: "Tolerance", min: 0, max: 100, step: 0.5, def: 25, unit: "%" },
    { key: "softness", label: "Softness", min: 0, max: 100, step: 0.5, def: 10, unit: "%" },
    { key: "spill", label: "Spill removal", min: 0, max: 100, step: 0.5, def: 50, unit: "%" }] },
  flip: { label: "Flip", params: [
    { key: "horizontal", label: "Horizontal", type: "check", def: true },
    { key: "vertical", label: "Vertical", type: "check", def: false }] },
  pixelate: { label: "Pixelate", params: [{ key: "size", label: "Block size", min: 1, max: 100, step: 0.5, def: 20, unit: "%" }] },
  aberration: { label: "Chromatic aberration", params: [{ key: "amount", label: "Amount", min: 0, max: 100, step: 0.5, def: 20, unit: "%" }] },
  letterbox: { label: "Letterbox", params: [
    { key: "ratio", label: "Aspect ratio", type: "select", def: 2.39, options: [[2.76, "2.76 : 1 (Ultra Panavision)"], [2.39, "2.39 : 1 (Scope)"], [2.0, "2 : 1"], [1.85, "1.85 : 1 (Flat)"], [1.78, "16 : 9"], [1.33, "4 : 3"], [1.0, "1 : 1"]] },
    { key: "color", label: "Bar colour", type: "color", def: "#000000" }] },
};
export const EFFECT_ORDER = ["blur", "sharpen", "vignette", "grain", "bw", "chroma", "flip", "pixelate", "aberration", "letterbox"];
export const EFFECT_TYPE_INDEX = Object.fromEntries(EFFECT_ORDER.map((id, i) => [id, i]));

export const GENERATORS = [
  { id: "__title__", kind: "title", label: "Title" },
  { id: "__solid__", kind: "solid", label: "Solid colour" },
  { id: "__gradient__", kind: "gradient", label: "Gradient" },
  { id: "__adjust__", kind: "adjust", label: "Adjustment layer" },
];

export function defaultEffectParams(type) {
  return Object.fromEntries(EFFECTS[type].params.map(p => [p.key, p.def]));
}

const hexRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const v = m ? parseInt(m[1], 16) : 0;
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
};

// Shader passes for an effect with resolved parameter values. w, h: the layer's pixel size.
// Each pass: {type, a: [4 floats], col: [r,g,b], dir: [x,y]}. Blur is two passes (horizontal, vertical).
export function effectPasses(type, p, w, h, frame = 0) {
  const t = EFFECT_TYPE_INDEX[type];
  const aspect = w / Math.max(1, h);
  switch (type) {
    case "blur": {
      const sigma = (p.amount / 100) * 0.025;   // fraction of the layer height
      if (sigma <= 1e-5) return [];
      return [{ type: t, a: [sigma / aspect, 0, 0, 0], dir: [1, 0] }, { type: t, a: [sigma, 0, 0, 0], dir: [0, 1] }];
    }
    case "sharpen": return p.amount > 0 ? [{ type: t, a: [p.amount / 100, Math.max(1, 0.0015 * h), 0, 0] }] : [];
    case "vignette": return [{ type: t, a: [p.amount / 100, 0.1 + 0.8 * p.size / 100, 0.05 + 0.9 * p.softness / 100, aspect] }];
    case "grain": return p.amount > 0 ? [{ type: t, a: [p.amount / 100, Math.max(1e-3, p.size * h / 1080), Math.round(frame) % 997, 0] }] : [];
    case "bw": return [{ type: t, a: [p.amount / 100, 0, 0, 0] }];
    case "chroma": return [{ type: t, a: [p.tolerance / 100 * 0.5, p.softness / 100 * 0.5, p.spill / 100, 0], col: hexRgb(p.color) }];
    case "flip": return p.horizontal || p.vertical ? [{ type: t, a: [p.horizontal ? 1 : 0, p.vertical ? 1 : 0, 0, 0] }] : [];
    case "pixelate": return p.size > 0 ? [{ type: t, a: [Math.max(1, p.size / 100 * 0.1 * h), 0, 0, 0] }] : [];
    case "aberration": return p.amount > 0 ? [{ type: t, a: [p.amount / 100 * 0.01, 0, 0, 0] }] : [];
    case "letterbox": return [{ type: t, a: [Number(p.ratio) || 2.39, aspect, 0, 0], col: hexRgb(p.color) }];
    default: return [];
  }
}

// Full-screen effect pass on a premultiplied texture. vUv covers the layer; uTexel is one pixel in uv units.
// Must stay in step with fx.py Effects.one.
export const EFFECT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform int uType;
uniform vec4 uA;
uniform vec3 uCol;
uniform vec2 uDir, uTexel;
out vec4 o;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
void main() {
  vec4 c = texture(uSrc, vUv);
  vec2 st = vec2(vUv.x, 1.0 - vUv.y);     // effect buffers are stored bottom-up; st runs from the image's top-left
  if (uType == 0) {                       // gaussian blur along uDir; uA.x = sigma in uv units
    float sigma = uA.x; vec4 acc = vec4(0.0); float wsum = 0.0;
    for (int i = -12; i <= 12; i++) {
      float x = float(i) / 4.0;            // taps cover +-3 sigma
      float w = exp(-0.5 * x * x);
      acc += texture(uSrc, vUv + uDir * x * sigma) * w; wsum += w;
    }
    o = acc / wsum; return;
  }
  if (uType == 1) {                       // sharpen (unsharp mask with a small cross kernel)
    vec2 dx = vec2(uTexel.x * uA.y, 0.0), dy = vec2(0.0, uTexel.y * uA.y);
    vec4 blur = (texture(uSrc, vUv + dx) + texture(uSrc, vUv - dx) + texture(uSrc, vUv + dy) + texture(uSrc, vUv - dy)) * 0.25;
    vec4 s = c + uA.x * (c - blur);
    o = vec4(clamp(s.rgb, 0.0, c.a), c.a); return;
  }
  if (uType == 2) {                       // vignette: amount, start radius, width, aspect
    float d = length(vec2((vUv.x - 0.5) * uA.w, vUv.y - 0.5)) / length(vec2(uA.w * 0.5, 0.5));
    o = vec4(c.rgb * (1.0 - uA.x * smoothstep(uA.y, uA.y + uA.z, d)), c.a); return;
  }
  if (uType == 3) {                       // film grain: amount, grain size in pixels
    vec2 cell = floor(st / (uTexel * uA.y));
    float n = (hash(cell + uA.z) + hash(cell * 1.37 + uA.z + 17.0)) - 1.0;
    o = vec4(clamp(c.rgb + n * uA.x * 0.25 * c.a, 0.0, c.a), c.a); return;
  }
  if (uType == 4) { o = vec4(mix(c.rgb, vec3(luma(c.rgb)), uA.x), c.a); return; }
  if (uType == 5) {                       // chroma key on straight colour: tolerance, softness, spill
    vec3 s = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    vec2 cc = vec2(-0.1146 * s.r - 0.3854 * s.g + 0.5 * s.b, 0.5 * s.r - 0.4542 * s.g - 0.0458 * s.b);
    vec2 kc = vec2(-0.1146 * uCol.r - 0.3854 * uCol.g + 0.5 * uCol.b, 0.5 * uCol.r - 0.4542 * uCol.g - 0.0458 * uCol.b);
    float d = distance(cc, kc);
    float mask = smoothstep(uA.x, uA.x + uA.y + 1e-3, d);
    float spill = uA.z * (1.0 - smoothstep(uA.x, uA.x + uA.y + 0.25, d));
    s = mix(s, vec3(luma(s)), spill);
    float a = c.a * mask;
    o = vec4(s * a, a); return;
  }
  if (uType == 6) { o = texture(uSrc, vec2(uA.x > 0.5 ? 1.0 - vUv.x : vUv.x, uA.y > 0.5 ? 1.0 - vUv.y : vUv.y)); return; }
  if (uType == 7) {                       // pixelate: block size in pixels
    vec2 b = uTexel * uA.x;
    vec2 q = (floor(st / b) + 0.5) * b;
    o = texture(uSrc, vec2(q.x, 1.0 - q.y)); return;
  }
  if (uType == 8) {                       // chromatic aberration: radial split of red and blue
    vec2 dir = (vUv - 0.5) * uA.x * 2.0;
    vec4 r = texture(uSrc, vUv + dir), b = texture(uSrc, vUv - dir);
    o = vec4(r.r, c.g, b.b, max(c.a, max(r.a, b.a))); return;
  }
  if (uType == 9) {                       // letterbox / pillarbox to an aspect ratio
    float ratio = uA.x, aspect = uA.y;
    bool bar = aspect < ratio ? abs(vUv.y - 0.5) > 0.5 * aspect / ratio : abs(vUv.x - 0.5) > 0.5 * ratio / aspect;
    o = bar ? vec4(uCol, 1.0) : c; return;
  }
  o = c;
}`;

// Generators drawn on a canvas for the viewer (fx.py renders the same for export).
export function drawGenerator(canvas, kind, gen, width, height) {
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext("2d");
  const g = gen || {};
  if (kind === "solid") { ctx.fillStyle = g.color || "#000000"; ctx.fillRect(0, 0, width, height); }
  else if (kind === "gradient") {
    const a = (Number(g.angle) || 0) * Math.PI / 180;
    const dx = Math.cos(a), dy = -Math.sin(a);
    const half = Math.abs(dx) * width / 2 + Math.abs(dy) * height / 2;
    const grad = ctx.createLinearGradient(width / 2 - dx * half, height / 2 - dy * half, width / 2 + dx * half, height / 2 + dy * half);
    grad.addColorStop(0, g.color || "#1b2a49");
    grad.addColorStop(1, g.color2 || "#c86b3c");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, width, height);
  }
  canvas.__version = (canvas.__version || 0) + 1;
}
