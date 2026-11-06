// EQ and filter monitor for an audio effect card: the effect's frequency response (from the same Web Audio filters
// that play it) drawn over a live spectrum of the clip, before (dim) and after (bright) its effects. The band points
// can be dragged: graphic EQ bands up and down, the parametric EQ's point anywhere (wheel for its width), the bass /
// treble shelves up and down, and the cut, band-pass and notch frequencies left and right.
import * as M from "./model.js";
import { GEQ_BANDS, AUDIO_EFFECTS } from "./audiofx.js";
import { clamp } from "./util.js";

export const MONITORED = ["geq", "peak", "eq", "lowcut", "highcut", "bandpass", "notch", "autofilter"];
const F_LO = 20, F_HI = 20000, DB = 18, SPEC_LO = -100, SPEC_HI = -20;
const POINTS = 256;

let shared = null;   // a silent context just for getFrequencyResponse when playback has none yet
const audioCtx = (app) => app.playback?.ctx || (shared ||= new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 128, 48000));

const freqs = (() => { const f = new Float32Array(POINTS); for (let i = 0; i < POINTS; i++) f[i] = F_LO * Math.pow(F_HI / F_LO, i / (POINTS - 1)); return f; })();
const val = (fx, key) => { const v = Number(fx.params?.[key]); return Number.isFinite(v) ? v : AUDIO_EFFECTS[fx.type].params.find(p => p.key === key)?.def ?? 0; };

// The filters an effect is made of, as [type, frequency, Q, gain] (Q for low/high pass in dB, as Web Audio takes it).
function filtersOf(fx) {
  switch (fx.type) {
    case "geq": return GEQ_BANDS.map((f, i) => ["peaking", f, 1.41, val(fx, `b${i}`)]).filter(b => Math.abs(b[3]) > 1e-6);
    case "peak": return [["peaking", val(fx, "freq"), val(fx, "q"), val(fx, "gain")]];
    case "eq": return [["lowshelf", 200, 1, val(fx, "bass")], ["highshelf", 4000, 1, val(fx, "treble")]];
    case "lowcut": return [["highpass", val(fx, "freq"), -3.0103, 0]];
    case "highcut": return [["lowpass", val(fx, "freq"), -3.0103, 0]];
    case "bandpass": return [["bandpass", val(fx, "freq"), val(fx, "q"), 0]];
    case "notch": return [["notch", val(fx, "freq"), val(fx, "q"), 0]];
    case "autofilter": {   // drawn at the middle of its sweep
      const lo = Math.max(20, Math.min(val(fx, "low"), val(fx, "high"))), hi = Math.max(lo, val(fx, "high"));
      return [["lowpass", Math.sqrt(lo * hi), val(fx, "resonance"), 0]];
    }
    default: return [];
  }
}

function responseDb(ctx, fx) {
  const total = new Float32Array(POINTS).fill(0);
  const mag = new Float32Array(POINTS), phase = new Float32Array(POINTS);
  for (const [type, f, q, g] of filtersOf(fx)) {
    const node = ctx.createBiquadFilter();
    node.type = type; node.frequency.value = f; node.Q.value = q; node.gain.value = g;
    node.getFrequencyResponse(freqs, mag, phase);
    for (let i = 0; i < POINTS; i++) total[i] += 20 * Math.log10(Math.max(mag[i], 1e-6));
  }
  return total;
}

// Draggable handles: {f, db, keyF, keyG} in effect parameters.
function handlesOf(fx) {
  switch (fx.type) {
    case "geq": return GEQ_BANDS.map((f, i) => ({ f, db: val(fx, `b${i}`), keyG: `b${i}` }));
    case "peak": return [{ f: val(fx, "freq"), db: val(fx, "gain"), keyF: "freq", keyG: "gain", keyQ: "q" }];
    case "eq": return [{ f: 200, db: val(fx, "bass"), keyG: "bass" }, { f: 4000, db: val(fx, "treble"), keyG: "treble" }];
    case "lowcut": case "highcut": return [{ f: val(fx, "freq"), db: 0, keyF: "freq" }];
    case "bandpass": case "notch": return [{ f: val(fx, "freq"), db: 0, keyF: "freq", keyQ: "q" }];
    case "autofilter": return [{ f: val(fx, "low"), db: 0, keyF: "low" }, { f: val(fx, "high"), db: 0, keyF: "high" }];
    default: return [];
  }
}

export function eqMonitor(app, clipId, fxId, label) {
  const canvas = document.createElement("canvas");
  canvas.className = "eqmon";
  canvas.title = "Live spectrum (dim: before the clip's effects, bright: after) under this effect's curve. Drag the points; scroll over a point to change its width.";
  const live = () => (M.getClip(clipId)?.afx || []).find(f => f.id === fxId);
  const X = (f, w) => Math.log(f / F_LO) / Math.log(F_HI / F_LO) * w;
  const F = (x, w) => F_LO * Math.pow(F_HI / F_LO, clamp(x / w, 0, 1));
  const Y = (db, h) => h / 2 - db / DB * (h / 2 - 6);
  const D = (y, h) => (h / 2 - y) / (h / 2 - 6) * DB;
  let drag = null, hover = -1, curveSig = "", curve = null;
  const spec = { pre: null, post: null };

  const set = (h, f, db, q) => {
    const fx = live();
    if (!fx) return;
    const def = AUDIO_EFFECTS[fx.type];
    const lim = (key, v) => { const p = def.params.find(p => p.key === key); return p ? clamp(Math.round(v / p.step) * p.step, p.min, p.max) : v; };
    M.edit(`${def.label} ${label || ""}`.trim(), () => M.updateAudioEffect(clipId, fxId, (e) => {
      const params = { ...(e.params || {}) };
      if (h.keyF && f != null) params[h.keyF] = lim(h.keyF, f);
      if (h.keyG && db != null) params[h.keyG] = lim(h.keyG, db);
      if (h.keyQ && q != null) params[h.keyQ] = lim(h.keyQ, q);
      e.params = params;
    }), { coalesceKey: `eqmon-${fxId}` });
  };
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, r.width, r.height]; };
  const nearest = (x, y, w, h) => {
    const fx = live();
    if (!fx) return -1;
    let best = -1, bd = 14;
    handlesOf(fx).forEach((hd, i) => { const d = Math.hypot(X(hd.f, w) - x, Y(hd.db, h) - y); if (d < bd) { bd = d; best = i; } });
    // anywhere on a frequency-only handle's column picks it too
    if (best < 0) handlesOf(fx).forEach((hd, i) => { if (!hd.keyG && Math.abs(X(hd.f, w) - x) < 10) best = i; });
    return best;
  };
  canvas.addEventListener("pointerdown", (e) => {
    const [x, y, w, h] = local(e);
    const i = nearest(x, y, w, h);
    if (i < 0) return;
    drag = i; canvas.setPointerCapture(e.pointerId); e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    const [x, y, w, h] = local(e);
    if (drag == null) { hover = nearest(x, y, w, h); canvas.style.cursor = hover >= 0 ? "grab" : "default"; return; }
    const fx = live();
    const hd = fx && handlesOf(fx)[drag];
    if (hd) set(hd, hd.keyF ? F(x, w) : null, hd.keyG ? D(y, h) : null, null);
  });
  const up = () => { drag = null; };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("dblclick", (e) => {
    const [x, y, w, h] = local(e);
    const i = nearest(x, y, w, h), fx = live();
    if (i < 0 || !fx) return;
    const hd = handlesOf(fx)[i];
    if (hd.keyG) set(hd, null, 0, null);   // a band back to flat
  });
  canvas.addEventListener("wheel", (e) => {
    const [x, y, w, h] = local(e);
    const i = nearest(x, y, w, h), fx = live();
    if (i < 0 || !fx) return;
    const hd = handlesOf(fx)[i];
    if (!hd.keyQ) return;
    e.preventDefault();
    set(hd, null, null, val(fx, hd.keyQ) * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  const draw = () => {
    if (!canvas.isConnected) return;   // the card was re-rendered away: stop
    requestAnimationFrame(draw);
    const fx = live();
    if (!fx || canvas.offsetParent === null) return;   // folded or hidden
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#0c0d10"; g.fillRect(0, 0, w, h);
    // grid: octaves-ish frequencies and dB lines
    g.strokeStyle = "rgba(255,255,255,.06)"; g.fillStyle = "rgba(255,255,255,.35)"; g.font = "9px sans-serif"; g.lineWidth = 1;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(X(f, w)) + .5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, h - 3);
    }
    for (const db of [-12, -6, 0, 6, 12]) {
      const y = Math.round(Y(db, h)) + .5;
      g.strokeStyle = db ? "rgba(255,255,255,.06)" : "rgba(255,255,255,.16)";
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      if (db) g.fillText(`${db > 0 ? "+" : ""}${db}`, 2, y - 2);
    }
    // live spectrum
    const an = app.playback?.analysers?.(clipId);
    const playing = an && app.playback?.playing;
    if (an) {
      for (const [key, node, colour] of [["pre", an.pre, "rgba(120,140,170,.35)"], ["post", an.post, "rgba(127,214,168,.45)"]]) {
        if (!spec[key] || spec[key].length !== node.frequencyBinCount) spec[key] = new Float32Array(node.frequencyBinCount);
        node.getFloatFrequencyData(spec[key]);
        const data = spec[key], nyq = node.context.sampleRate / 2;
        g.beginPath(); g.moveTo(0, h);
        for (let x = 0; x <= w; x += 2) {
          const f = F(x, w), bin = Math.min(data.length - 1, Math.max(0, Math.round(f / nyq * data.length)));
          const v = Number.isFinite(data[bin]) ? data[bin] : SPEC_LO;
          g.lineTo(x, h - clamp((v - SPEC_LO) / (SPEC_HI - SPEC_LO), 0, 1) * h);
        }
        g.lineTo(w, h); g.closePath();
        g.fillStyle = colour; g.fill();
      }
    }
    if (!playing) { g.fillStyle = "rgba(255,255,255,.3)"; g.font = "10px sans-serif"; g.textAlign = "right"; g.fillText("Play to see the live spectrum", w - 6, 12); g.textAlign = "left"; }
    // response curve
    const sig = JSON.stringify([fx.type, fx.params]);
    if (sig !== curveSig) { curveSig = sig; curve = responseDb(audioCtx(app), fx); }
    g.strokeStyle = fx.on === false ? "rgba(255,204,77,.4)" : "#ffcc4d"; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < POINTS; i++) { const x = i / (POINTS - 1) * w, y = clamp(Y(curve[i], h), 1, h - 1); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
    // handles
    handlesOf(fx).forEach((hd, i) => {
      const x = X(hd.f, w), y = Y(hd.db, h);
      g.fillStyle = i === drag || i === hover ? "#fff" : "#ffcc4d";
      g.strokeStyle = "#0c0d10"; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, hd.keyG ? y : h / 2, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
    });
  };
  requestAnimationFrame(draw);
  return canvas;
}
