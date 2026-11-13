// Clip audio tools: Normalise (bring each clip's sound to a loudness or peak target with its volume) and Auto-duck
// (volume keyframes that lower music under the speech on the other audio tracks).
import * as M from "./model.js";
import { state, P } from "./model.js";
import { el, modal, toast } from "./util.js";

const api = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error((await r.text()) || r.statusText); return r.json(); };

// The audio clips a selection means: selected audio clips, plus the linked sound of selected video clips.
export function audioClipsOf(ids) {
  const out = new Map();
  for (const id of ids) {
    const c = M.getClip(id);
    if (!c) continue;
    const list = M.trackKind(c.trackId) === "audio" ? [c] : M.partners(c).filter(p => M.trackKind(p.trackId) === "audio");
    for (const a of list) {
      const item = M.mediaOf(a);
      if (item && (item.has_audio || item.kind === "audio")) out.set(a.id, a);
    }
  }
  return [...out.values()];
}

const srcRange = (c) => [Math.min(c.in, c.out), Math.max(c.in, c.out)];

// ---------------------------------------------------------------- normalise
const NORM_TARGETS = [["lufs:-14", "-14 LUFS (streaming, YouTube)"], ["lufs:-16", "-16 LUFS (podcasts, Apple)"], ["lufs:-23", "-23 LUFS (broadcast, EBU R128)"],
  ["peak:-1", "Peak at -1 dBFS"], ["peak:-3", "Peak at -3 dBFS"]];

export function openNormalise(app) {
  const clips = audioClipsOf([...state.selection]);
  if (!clips.length) { toast("Select clips with sound to normalise them"); return; }
  let saved = "lufs:-16";
  try { saved = localStorage.getItem("ve_norm_target") || saved; } catch {}
  const sel = el("select", {}, ...NORM_TARGETS.map(([v, l]) => el("option", { value: v, selected: v === saved }, l)));
  const note = el("div.dim.small", {}, `${clips.length} clip${clips.length > 1 ? "s" : ""}. Each clip's volume is set so its own sound (the part of the file it uses) reaches the target; a loudness target also keeps the peaks under -1 dBFS. Volume keyframes keep their shape, with the loudest at the new level.`);
  const status = el("div.dim.small");
  const m = modal({ title: "Normalise clip loudness", narrow: true, body: el("div", {}, el("div.field", {}, el("label", {}, "Target"), sel), note, status),
    buttons: ["spacer", { label: "Cancel" }, { label: "Normalise", primary: true, action: () => { run(); return false; } }] });
  const run = async () => {
    try { localStorage.setItem("ve_norm_target", sel.value); } catch {}
    const [mode, value] = sel.value.split(":");
    const target = parseFloat(value);
    status.textContent = "Measuring…";
    const gains = new Map();
    try {
      for (const [i, c] of clips.entries()) {
        status.textContent = `Measuring ${i + 1} of ${clips.length}…`;
        const [a, b] = srcRange(c);
        const r = await api(`api/media/${c.mediaId}/loudness?a=${a.toFixed(3)}&b=${b.toFixed(3)}`);
        let gain = null;
        if (mode === "lufs" && r.lufs != null) { gain = target - r.lufs; if (r.peak != null) gain = Math.min(gain, -1 - r.peak); }
        if (mode === "peak" && r.peak != null) gain = target - r.peak;
        if (gain != null && Number.isFinite(gain)) gains.set(c.id, Math.max(-60, Math.min(12, gain)));
      }
    } catch (e) { status.textContent = `Couldn't measure: ${e.message}`; return; }
    if (!gains.size) { status.textContent = "Nothing to measure: the clips are silent."; return; }
    M.edit("Normalise", () => {
      for (const [id, gain] of gains) {
        const c = M.getClip(id);
        if (!c) continue;
        const ks = M.keysOf(c, "volume");
        if (ks.length) { const top = Math.max(...ks.map(k => k.v)); for (const k of ks) k.v = Math.max(-60, Math.min(12, k.v + gain - top)); }
        c.volume = gain;
      }
    });
    const clipped = [...gains.values()].filter(g => g >= 12).length;
    toast(`Normalised ${gains.size} clip${gains.size > 1 ? "s" : ""}${clipped ? ` (${clipped} needed more than +12 dB and stopped there)` : ""}`);
    m.close();
  };
}

// ---------------------------------------------------------------- auto-duck
export function openDuck(app) {
  const targets = audioClipsOf([...state.selection]);
  if (!targets.length) { toast("Select the music (or other clips) to duck under the dialogue"); return; }
  const targetIds = new Set(targets.map(c => c.id));
  // the speech: audio clips on other tracks that play
  const targetTracks = new Set(targets.map(c => c.trackId));
  const sources = P().clips.filter(c => M.trackKind(c.trackId) === "audio" && !targetIds.has(c.id) && !targetTracks.has(c.trackId) && !c.disabled
    && !M.getTrack(c.trackId).mute && (M.mediaOf(c)?.has_audio || M.mediaOf(c)?.kind === "audio"));
  if (!sources.length) { toast("There's no other sound on other audio tracks to duck under"); return; }
  const num = (v, min, max, step) => el("input", { type: "number", value: v, min, max, step, style: { width: "80px" } });
  let p = { duck: -12, attack: 0.3, release: 0.6, sens: 50 };
  try { p = { ...p, ...JSON.parse(localStorage.getItem("ve_duck") || "{}") }; } catch {}
  const duck = num(p.duck, -40, -1, 1), attack = num(p.attack, 0.02, 3, 0.05), release = num(p.release, 0.02, 5, 0.05);
  const sens = el("input", { type: "range", min: 0, max: 100, value: p.sens });
  const row = (label, input, unit) => el("div.field", {}, el("label", {}, label), el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, input, unit ? el("span.dim", {}, unit) : null));
  const status = el("div.dim.small");
  const tracks = [...new Set(sources.map(c => c.trackId))].map(id => M.getTrack(id)).map(t => t.name || `A${M.audioTracks().indexOf(t) + 1}`);
  const m = modal({ title: "Duck under dialogue", narrow: true, body: el("div", {},
      el("div.dim.small", { style: { marginBottom: "8px" } }, `Lowers ${targets.length} clip${targets.length > 1 ? "s" : ""} while someone speaks on ${tracks.join(", ")}, with volume keyframes you can adjust afterwards. Replaces their existing volume keyframes.`),
      row("Duck by", duck, "dB"), row("Fade down", attack, "s before the speech"), row("Fade back up", release, "s after it"),
      row("Sensitivity", sens, "more counts as speech →"), status),
    buttons: ["spacer", { label: "Cancel" }, { label: "Duck", primary: true, action: () => { run(); return false; } }] });
  const run = async () => {
    const o = { duck: Math.min(-1, +duck.value || -12), attack: Math.max(0.02, +attack.value || 0.3), release: Math.max(0.02, +release.value || 0.6), sens: +sens.value };
    try { localStorage.setItem("ve_duck", JSON.stringify(o)); } catch {}
    // speech on the timeline: each source clip's speech, mapped from its footage to where it plays
    const spans = [];
    try {
      for (const [i, c] of sources.entries()) {
        status.textContent = `Listening ${i + 1} of ${sources.length}…`;
        if (M.hasSpeedKeys(c)) continue;          // a speed ramp doesn't map simply; leave it out
        const [a, b] = srcRange(c);
        const r = await api(`api/media/${c.mediaId}/speech?a=${a.toFixed(3)}&b=${b.toFixed(3)}&sensitivity=${(o.sens / 100).toFixed(2)}`);
        const s = Math.abs(c.speed || 1), dur = M.clipDur(c);
        for (const [x0, x1] of r.segments || []) {
          let t0 = c.reverse ? (b - x1) / s : (x0 - a) / s, t1 = c.reverse ? (b - x0) / s : (x1 - a) / s;
          t0 = Math.max(0, t0); t1 = Math.min(dur, t1);
          if (t1 > t0) spans.push([c.start + t0, c.start + t1]);
        }
      }
    } catch (e) { status.textContent = `Couldn't listen: ${e.message}`; return; }
    spans.sort((x, y) => x[0] - y[0]);
    // join spans whose fades would overlap
    const merged = [];
    for (const sp of spans) {
      const last = merged[merged.length - 1];
      if (last && sp[0] - o.attack <= last[1] + o.release) last[1] = Math.max(last[1], sp[1]);
      else merged.push([...sp]);
    }
    if (!merged.length) { status.textContent = "No speech found. Try a higher sensitivity."; return; }
    let keyed = 0;
    M.edit("Duck under dialogue", () => {
      for (const t of targets) {
        const c = M.getClip(t.id);
        if (!c) continue;
        const base = M.keysOf(c, "volume").length ? M.prop(c, "volume", 0) : (c.volume || 0);
        const low = Math.max(-60, base + o.duck), dur = M.clipDur(c);
        const pts = [];
        for (const [s0, s1] of merged) {
          const a0 = s0 - c.start - o.attack, a1 = s0 - c.start, b0 = s1 - c.start, b1 = s1 - c.start + o.release;
          if (b1 < 0 || a0 > dur) continue;
          pts.push([a0, base], [a1, low], [b0, low], [b1, base]);
        }
        if (!pts.length) continue;
        M.clearKeys(c.id, "volume", base);
        M.setKeyAt(c.id, "volume", 0, pts[0][0] <= 0 ? (pts[0][0] === pts[1][0] ? low : base + (low - base) * Math.min(1, -pts[0][0] / o.attack)) : base);
        for (const [tau, v] of pts) if (tau > 0 && tau < dur) M.setKeyAt(c.id, "volume", tau, v);
        M.setKeyAt(c.id, "volume", dur, M.prop(M.getClip(c.id), "volume", dur));
        keyed++;
      }
    });
    toast(`Ducked ${keyed} clip${keyed === 1 ? "" : "s"} under ${merged.length} stretch${merged.length === 1 ? "" : "es"} of speech`);
    m.close();
  };
}
