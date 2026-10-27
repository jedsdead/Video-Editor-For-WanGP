// Keyframes: curves, evaluation, exact integration (for speed) and cropping. Mirrored in timeline_math.py.
// A key is {t, v, ease, r?}: t is seconds from the clip start, ease shapes the segment to the next key, and the
// optional r = [x0, x1] restricts that segment to part of its curve (kept when a clip is split, so cuts are exact).

export const CURVES = [
  ["linear", "Linear"], ["ease_in", "Ease in"], ["ease_out", "Ease out"], ["s_curve", "S-curve"],
  ["fast", "Fast start"], ["slow", "Slow start"], ["hold", "Hold"],
];
export const FADE_CURVES = CURVES.filter(([id]) => id !== "hold");

export function curve(name, x) {
  x = Math.min(1, Math.max(0, x));
  switch (name) {
    case "ease_in": return x * x;
    case "ease_out": return 2 * x - x * x;
    case "s_curve": return 3 * x * x - 2 * x * x * x;
    case "slow": return x * x * x;
    case "fast": return 1 - (1 - x) ** 3;
    case "hold": return x >= 1 ? 1 : 0;
    default: return x;
  }
}

// Antiderivative of curve(): F(u) = integral of curve from 0 to u.
function curveInt(name, u) {
  u = Math.min(1, Math.max(0, u));
  switch (name) {
    case "ease_in": return u ** 3 / 3;
    case "ease_out": return u * u - u ** 3 / 3;
    case "s_curve": return u ** 3 - u ** 4 / 2;
    case "slow": return u ** 4 / 4;
    case "fast": return u - (1 - (1 - u) ** 4) / 4;
    case "hold": return 0;
    default: return u * u / 2;
  }
}

export const sorted = (keys) => (keys || []).slice().sort((a, b) => a.t - b.t);

function segValue(k0, k1, x) {
  const [r0, r1] = k0.r || [0, 1];
  const e = k0.ease || "linear";
  const d = curve(e, r1) - curve(e, r0);
  if (Math.abs(d) < 1e-12) return k0.v;
  return k0.v + (k1.v - k0.v) * (curve(e, r0 + x * (r1 - r0)) - curve(e, r0)) / d;
}

// Integral of the segment value from local x = 0 to u, in units of the segment length.
function segIntegral(k0, k1, u) {
  const [r0, r1] = k0.r || [0, 1];
  const e = k0.ease || "linear";
  const w = r1 - r0;
  const d = curve(e, r1) - curve(e, r0);
  if (Math.abs(d) < 1e-12 || w < 1e-9) return k0.v * u;
  return k0.v * u + (k1.v - k0.v) / d * ((curveInt(e, r0 + u * w) - curveInt(e, r0)) / w - curve(e, r0) * u);
}

export function keyValue(keys, t, fallback) {
  if (!keys || !keys.length) return fallback;
  const ks = keys.length > 1 ? sorted(keys) : keys;
  if (t <= ks[0].t) return ks[0].v;
  const last = ks[ks.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    if (t < b.t) return b.t - a.t < 1e-9 ? b.v : segValue(a, b, (t - a.t) / (b.t - a.t));
  }
  return last.v;
}

// Integral of the keyed value from 0 to t (constant before the first key and after the last).
export function keyIntegral(keys, t) {
  const ks = sorted(keys);
  if (!ks.length) return 0;
  if (t < 0) return ks[0].v * t;
  let acc = 0, pos = 0;
  if (t <= ks[0].t) return ks[0].v * t;
  acc = ks[0].v * Math.max(0, ks[0].t);
  pos = Math.max(0, ks[0].t);
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    const len = b.t - a.t;
    if (len <= 1e-9) continue;
    const s0 = Math.max(pos, a.t);
    if (t <= b.t) {
      const u0 = (s0 - a.t) / len, u1 = (t - a.t) / len;
      return acc + len * (segIntegral(a, b, u1) - segIntegral(a, b, u0));
    }
    const u0 = (s0 - a.t) / len;
    acc += len * (segIntegral(a, b, 1) - segIntegral(a, b, u0));
    pos = b.t;
  }
  return acc + ks[ks.length - 1].v * (t - pos);
}

// Smallest t >= 0 where keyIntegral reaches target (Infinity if it never does).
export function solveIntegral(keys, target, limit = 1e5) {
  if (target <= 0) return 0;
  const ks = sorted(keys);
  const last = ks[ks.length - 1];
  const atLast = keyIntegral(ks, Math.max(0, last.t));
  let hi;
  if (atLast >= target) hi = Math.max(0, last.t);
  else if (last.v > 1e-9) return Math.max(0, last.t) + (target - atLast) / last.v;
  else return Infinity;
  let lo = 0;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (keyIntegral(ks, mid) < target) lo = mid; else hi = mid; }
  return hi;
}

// Keys covering [a, b] of the original curve, re-based so a becomes 0. Exact: segments cut in the middle keep their shape.
export function cropKeys(keys, a, b) {
  if (!keys || !keys.length) return [];
  const ks = sorted(keys);
  const first = ks[0], last = ks[ks.length - 1];
  if (a >= last.t) return [{ t: 0, v: last.v, ease: "linear" }];
  if (b <= first.t) return [{ t: 0, v: first.v, ease: "linear" }];
  const out = [];   // entries carry origT / nextT while building
  const segAt = (t) => { for (let i = 0; i < ks.length - 1; i++) if (ks[i].t < t && t < ks[i + 1].t) return i; return -1; };
  const sub = (k, t, nextT) => {
    const [r0, r1] = k.r || [0, 1];
    const xl = (t - k.t) / (nextT - k.t);
    return r0 + xl * (r1 - r0);
  };
  const ia = segAt(a);
  if (ia >= 0) {
    const k = ks[ia], n = ks[ia + 1];
    out.push({ t: a, v: keyValue(ks, a), ease: k.ease || "linear", r: [sub(k, a, n.t), (k.r || [0, 1])[1]], origT: a, nextT: n.t });
  }
  ks.forEach((k, i) => {
    if (k.t >= a - 1e-9 && k.t <= b + 1e-9) out.push({ ...k, origT: k.t, nextT: i < ks.length - 1 ? ks[i + 1].t : null });
  });
  const ib = segAt(b);
  if (ib >= 0 && out.length) {
    const prev = out[out.length - 1];
    if (prev.nextT !== null && prev.origT < b && b < prev.nextT) {
      const [r0, r1] = prev.r || [0, 1];
      const xl = (b - prev.origT) / (prev.nextT - prev.origT);
      prev.r = [r0, r0 + xl * (r1 - r0)];
      out.push({ t: b, v: keyValue(ks, b), ease: "linear", origT: b, nextT: null });
    }
  }
  return out.map(({ origT, nextT, ...k }) => {
    const key = { ...k, t: k.t - a };
    if (key.r && Math.abs(key.r[0]) < 1e-9 && Math.abs(key.r[1] - 1) < 1e-9) delete key.r;
    return key;
  });
}

export function shiftKeys(keys, dt) { return (keys || []).map(k => ({ ...k, t: k.t + dt })); }
