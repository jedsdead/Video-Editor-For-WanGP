// Project model, timeline maths and every editing operation. All edits go through edit(), which records undo history.
// The speed/ramp maths mirrors timeline_math.py so the preview and the export agree.
import { Emitter, uid, clamp } from "./util.js";
import { presetTransition, normalizeTransition } from "./transitions.js";
import * as K from "./keys.js";
import { keyValue, keyIntegral, cropKeys, curve } from "./keys.js";

export const bus = new Emitter();
const EPS = 1e-6;

export const DEFAULT_STILL = 5;

export function defaultGrade() {
  return { enabled: true, lift: { x: 0, y: 0, master: 0 }, gamma: { x: 0, y: 0, master: 0 }, gain: { x: 0, y: 0, master: 0 },
           exposure: 0, contrast: 0, saturation: 1, temperature: 0, tint: 0, lut: null, lutMix: 1,
           // Final Cut style tonal wheels (used when style is "zones")
           style: "lgg", master: zone(), shadows: zone(), mids: zone(), highs: zone(), zoneLow: 0.33, zoneHigh: 0.67 };
}
function zone() { return { x: 0, y: 0, bright: 0, sat: 1 }; }
// Numeric grade fields that can be keyframed; each is stored as its own key lane "grade:<field>".
export const GRADE_FIELDS = ["lift.x", "lift.y", "lift.master", "gamma.x", "gamma.y", "gamma.master", "gain.x", "gain.y", "gain.master",
                             "exposure", "contrast", "saturation", "temperature", "tint", "lutMix",
                             ...["master", "shadows", "mids", "highs"].flatMap(z => [`${z}.x`, `${z}.y`, `${z}.bright`, `${z}.sat`]), "zoneLow", "zoneHigh"];

export function defaultFx() {
  return { eq: { on: false, low: { f: 120, g: 0 }, mid: { f: 1000, g: 0, q: 1 }, high: { f: 8000, g: 0 } },
           comp: { on: false, threshold: -18, ratio: 3, attack: 10, release: 150, makeup: 0 } };
}

export function defaultTitle() {
  return { text: "Title", font: "Segoe UI", size: 96, bold: true, italic: false, color: "#ffffff", align: "center", lineHeight: 1.15,
           outline: { on: false, color: "#000000", width: 4 }, shadow: { on: true, color: "#000000", blur: 8, x: 3, y: 3, opacity: 0.6 },
           box: { on: false, color: "#000000", opacity: 0.5, padding: 24 } };
}
export const TITLE_MEDIA = { id: "__title__", kind: "title", name: "Title", duration: 0, generator: true };
// Generators live in the Effects panel: built-in "media" that make clips without a file.
export const GENERATOR_MEDIA = [TITLE_MEDIA,
  { id: "__solid__", kind: "solid", name: "Solid colour", duration: 0, generator: true },
  { id: "__gradient__", kind: "gradient", name: "Gradient", duration: 0, generator: true },
  { id: "__adjust__", kind: "adjust", name: "Adjustment layer", duration: 0, generator: true }];
export const GENERATOR_KINDS = new Set(GENERATOR_MEDIA.map(g => g.kind));
const generatorMedia = () => Object.fromEntries(GENERATOR_MEDIA.map(g => [g.id, { ...g }]));
export function defaultGen(kind) {
  if (kind === "solid") return { color: "#1b2a49" };
  if (kind === "gradient") return { color: "#1b2a49", color2: "#c86b3c", angle: 90 };
  return {};
}

export const state = {
  project: null,
  selection: new Set(),
  selTransition: null,
  selectedMedia: null,
  playhead: 0,
  tool: "select",
  range: null,          // {start, end, trackIds}
  linked: true,
  clipboard: null,
  gradeClipboard: null,
  readOnly: false,
  h3Snap: false,        // snap cuts on WanGP clips to H3's 17-frame grid
};

export const P = () => state.project;

export function newProject(name = "Untitled") {
  return {
    version: 1, name,
    settings: { width: 1280, height: 720, fps: 24, auto: true },
    tracks: [
      { id: uid("v"), kind: "video", name: "", hidden: false, locked: false },
      { id: uid("v"), kind: "video", name: "", hidden: false, locked: false },
      { id: uid("a"), kind: "audio", name: "", mute: false, solo: false, locked: false, volume: 0, pan: 0, fx: defaultFx(), keys: {} },
      { id: uid("a"), kind: "audio", name: "", mute: false, solo: false, locked: false, volume: 0, pan: 0, fx: defaultFx(), keys: {} },
    ],
    clips: [], transitions: [], media: generatorMedia(), master: { volume: 0, fx: defaultFx() }, markers: [],
    magnetic: true, snapping: true, inPoint: null, outPoint: null, exportDefaults: null,
  };
}

// ------------------------------------------------------------------ lookups

export const fps = () => P().settings.fps || 24;
export const frameDur = () => 1 / fps();
export const snapFrame = (t) => Math.round(t * fps()) / fps();
export const mediaOf = (clip) => P().media[clip.mediaId];
export const kindOf = (clip) => (mediaOf(clip) || {}).kind;
export const isStillKind = (kind) => kind === "image" || GENERATOR_KINDS.has(kind);
export const isGenerator = (clip) => GENERATOR_KINDS.has(kindOf(clip));
export const isStill = (clip) => isStillKind(kindOf(clip));
export const getClip = (id) => P().clips.find(c => c.id === id);
export const getTrack = (id) => P().tracks.find(t => t.id === id);
export const videoTracks = () => P().tracks.filter(t => t.kind === "video");
export const audioTracks = () => P().tracks.filter(t => t.kind === "audio");
export const primaryId = () => (videoTracks()[0] || {}).id;
export const trackKind = (id) => (getTrack(id) || {}).kind;
export const clipsOn = (trackId) => P().clips.filter(c => c.trackId === trackId).sort((a, b) => a.start - b.start);
export function trackLabel(track) {
  const list = track.kind === "video" ? videoTracks() : audioTracks();
  return `${track.kind === "video" ? "V" : "A"}${list.indexOf(track) + 1}`;
}

// ------------------------------------------------------------------ keyframes, speed & time maths

// Keyable clip properties: static value key, default, and which track kind they apply to.
export const KEYABLE = {
  volume: { label: "Volume", fallback: 0, kind: "audio" },
  opacity: { label: "Opacity", fallback: 1, kind: "video" },
  scale: { label: "Scale", fallback: 1, kind: "video" },
  x: { label: "Position X", fallback: 0, kind: "video" },
  y: { label: "Position Y", fallback: 0, kind: "video" },
  rotation: { label: "Rotation", fallback: 0, kind: "video" },
  cropL: { label: "Crop left", fallback: 0, kind: "video" },
  cropR: { label: "Crop right", fallback: 0, kind: "video" },
  cropT: { label: "Crop top", fallback: 0, kind: "video" },
  cropB: { label: "Crop bottom", fallback: 0, kind: "video" },
  speed: { label: "Speed", fallback: 1, kind: "any" },
};
export const keysOf = (clip, prop) => (clip.keys && clip.keys[prop]) || [];
export const hasKeys = (clip, prop) => keysOf(clip, prop).length > 0;
export const hasSpeedKeys = (clip) => hasKeys(clip, "speed") && !isStill(clip);
export function prop(clip, name, tau) {
  if (name.startsWith("fx:")) return effectParam(clip, name, tau);
  const fallback = clip[name] ?? KEYABLE[name].fallback;
  return keyValue(keysOf(clip, name), tau, fallback);
}

// ---- grade keyframes
const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) { o[p] = o[p] && typeof o[p] === "object" ? { ...o[p] } : {}; o = o[p]; }
  o[parts[parts.length - 1]] = value;
}
export const hasGradeKeys = (clip) => GRADE_FIELDS.some(f => hasKeys(clip, "grade:" + f));
// The grade in effect at clip time tau (keyframed fields interpolated, the rest static).
export function gradeAt(clip, tau) {
  const base = mergeGrade(clip.grade);
  if (!hasGradeKeys(clip)) return base;
  const g = JSON.parse(JSON.stringify(base));
  for (const f of GRADE_FIELDS) {
    const ks = keysOf(clip, "grade:" + f);
    if (ks.length) setPath(g, f, keyValue(ks, tau));
  }
  return g;
}
// A grade with every field present (older projects lack the zone wheels).
export function mergeGrade(g) {
  const d = defaultGrade();
  g = g || {};
  const out = { ...d, ...g };
  for (const k of ["lift", "gamma", "gain", "master", "shadows", "mids", "highs"]) out[k] = { ...d[k], ...(g[k] || {}) };
  return out;
}
// ---- effects: clip.effects = [{id, type, on, params}], keyframed as lanes "fx:<id>:<param>"
export const effectLane = (fxId, key) => `fx:${fxId}:${key}`;
function parseLane(name) { const [, id, key] = name.split(":"); return { id, key }; }
export function effectParam(clip, name, tau) {
  const { id, key } = parseLane(name);
  const fx = (clip.effects || []).find(f => f.id === id);
  const base = fx ? Number(fx.params?.[key]) || 0 : 0;
  return keyValue(keysOf(clip, name), tau, base);
}
// Resolved parameters of an effect at clip time tau.
export function effectParamsAt(clip, fx, tau) {
  const out = { ...(fx.params || {}) };
  for (const key of Object.keys(out)) { const ks = keysOf(clip, effectLane(fx.id, key)); if (ks.length) out[key] = keyValue(ks, tau); }
  return out;
}
export function addEffect(clipIds, type, params) {
  const added = [];
  for (const id of clipIds) {
    const c = getClip(id);
    if (!c || trackKind(c.trackId) !== "video") continue;
    c.effects = [...(c.effects || []), { id: uid("fx"), type, on: true, params: { ...params } }];
    added.push(c);
  }
  return added;
}
export function removeEffect(clipId, fxId) {
  const c = getClip(clipId);
  if (!c) return;
  c.effects = (c.effects || []).filter(f => f.id !== fxId);
  for (const name of Object.keys(c.keys || {})) if (name.startsWith(`fx:${fxId}:`)) delete c.keys[name];
}
export function moveEffect(clipId, fxId, delta) {
  const c = getClip(clipId);
  if (!c) return;
  const list = [...(c.effects || [])];
  const i = list.findIndex(f => f.id === fxId), j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  c.effects = list;
}
export function updateEffect(clipId, fxId, fn) {
  const c = getClip(clipId);
  const fx = c && (c.effects || []).find(f => f.id === fxId);
  if (!fx) return;
  const copy = { ...fx, params: { ...fx.params } };
  fn(copy);
  c.effects = c.effects.map(f => f.id === fxId ? copy : f);
}
export function setEffectStatic(clip, name, value) { const { id, key } = parseLane(name); updateEffect(clip.id, id, f => { f.params[key] = value; }); }
export const hasEffects = (clip) => (clip.effects || []).some(f => f.on !== false);

export function gradeFieldValue(grade, field) { const v = getPath(grade, field); return typeof v === "number" ? v : getPath(defaultGrade(), field); }
export { setPath as setGradePath };

export function speeds(clip) {
  if (hasSpeedKeys(clip)) { const k = K.sorted(keysOf(clip, "speed")); return [k[0].v, k[k.length - 1].v]; }
  const s = Math.max(0.01, Number(clip.speed) || 1);
  return [s, s];
}
export const isRamped = (clip) => hasSpeedKeys(clip);

export function clipDur(clip) {
  const length = Math.max(0, clip.out - clip.in);
  if (isStill(clip)) return length;
  if (hasSpeedKeys(clip)) return Math.max(0, clip.dur || 0);
  return length / speeds(clip)[0];
}
export const clipEnd = (clip) => clip.start + clipDur(clip);

// Source seconds consumed from the clip start to clip time tau (the integral of speed).
export function consumed(clip, tau) {
  return hasSpeedKeys(clip) ? keyIntegral(keysOf(clip, "speed"), tau) : speeds(clip)[0] * tau;
}
// Source time shown at clip time tau. Reversed clips play their source range from out back to in.
export function srcTime(clip, tau) {
  if (isStill(clip)) return 0;
  return clip.reverse ? clip.out - consumed(clip, tau) : clip.in + consumed(clip, tau);
}
// Clip time needed to consume `length` seconds of source.
export function tauForLength(clip, length) {
  if (hasSpeedKeys(clip)) return K.solveIntegral(keysOf(clip, "speed"), length);
  return length / speeds(clip)[0];
}
// Unused source before the first shown frame and after the last one (in playback direction).
export function sourceRoom(clip) {
  const total = (mediaOf(clip) || {}).duration || clip.out;
  const atIn = clip.in, atOut = Math.max(0, total - clip.out);
  return clip.reverse ? { before: atOut, after: atIn } : { before: atIn, after: atOut };
}
export function speedAt(clip, tau) {
  return hasSpeedKeys(clip) ? keyValue(keysOf(clip, "speed"), tau) : speeds(clip)[0];
}
// Keep a speed-keyed clip's source range consistent with its curve and length, and inside the media.
export function syncSpeedOut(clip) {
  if (!hasSpeedKeys(clip)) return;
  for (const k of keysOf(clip, "speed")) k.v = Math.max(0, k.v);
  const total = (mediaOf(clip) || {}).duration || Math.max(clip.out, clip.in);
  clip.dur = Math.max(frameDur(), clip.dur || 0);
  if (clip.reverse) {
    // the playback start (out) is fixed; the curve decides how far back towards 0 it goes
    let used = consumed(clip, clip.dur);
    if (used > clip.out + 1e-6) { clip.dur = Math.max(frameDur(), tauForLength(clip, clip.out)); used = clip.out; }
    clip.in = Math.min(clip.out - 1e-4, Math.max(0, clip.out - used));
  } else {
    let used = consumed(clip, clip.dur);
    if (clip.in + used > total + 1e-6) { clip.dur = Math.max(frameDur(), tauForLength(clip, total - clip.in)); used = total - clip.in; }
    clip.out = Math.max(clip.in + 1e-4, clip.in + used);
  }
}

export function fadeFactor(clip, tau, d) {
  let f = 1;
  if (clip.fadeIn > 0 && tau < clip.fadeIn) f *= curve(clip.fadeInCurve || "linear", tau / clip.fadeIn);
  if (clip.fadeOut > 0 && tau > d - clip.fadeOut) f *= curve(clip.fadeOutCurve || "linear", (d - tau) / clip.fadeOut);
  return f;
}
export function audioTransitionGains(type, p) {
  p = clamp(p, 0, 1);
  if (type === "a_linear") return [1 - p, p];
  if (type === "a_dip") return [Math.max(0, 1 - 2 * p), Math.max(0, 2 * p - 1)];
  return [Math.cos(p * Math.PI / 2), Math.sin(p * Math.PI / 2)];
}

export function timelineEnd() {
  let end = 0;
  for (const c of P().clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function transitionInfo(tr) {
  const a = getClip(tr.a), b = getClip(tr.b);
  if (!a || !b) return null;
  const cut = clipEnd(a);
  return { a, b, cut, lo: cut - tr.duration / 2, hi: cut + tr.duration / 2 };
}

export function clipWindow(clip) {
  let s = clip.start, e = clipEnd(clip);
  for (const tr of P().transitions) {
    const info = transitionInfo(tr);
    if (!info) continue;
    if (tr.a === clip.id) e = Math.max(e, info.hi);
    if (tr.b === clip.id) s = Math.min(s, info.lo);
  }
  return [s, e];
}

// ------------------------------------------------------------------ history

const history = { undo: [], redo: [] };
let coalesce = { key: null, time: 0 };

export function snapshot() { return JSON.stringify(P()); }

export function commit(label = "edit") {
  history.undo.push({ label, data: snapshot() });
  if (history.undo.length > 300) history.undo.shift();
  history.redo = [];
  coalesce = { key: null, time: 0 };
}

export function edit(label, fn, { coalesceKey = null } = {}) {
  if (state.readOnly) return;
  const now = performance.now();
  if (!(coalesceKey && coalesce.key === coalesceKey && now - coalesce.time < 900)) commit(label);
  if (coalesceKey) coalesce = { key: coalesceKey, time: now };
  const result = fn();
  finalize();
  return result;
}

export function finalize() {
  repairTimes(P());
  validateTransitions();
  for (const id of [...state.selection]) if (!getClip(id)) state.selection.delete(id);
  if (state.selTransition && !P().transitions.find(t => t.id === state.selTransition)) state.selTransition = null;
  bus.emit("change");
}

export function restore(data) { state.project = JSON.parse(data); }

export function undo() {
  if (!history.undo.length || state.readOnly) return;
  const entry = history.undo.pop();
  history.redo.push({ label: entry.label, data: snapshot() });
  restore(entry.data);
  finalize();
  bus.emit("project");
}
export function redo() {
  if (!history.redo.length || state.readOnly) return;
  const entry = history.redo.pop();
  history.undo.push({ label: entry.label, data: snapshot() });
  restore(entry.data);
  finalize();
  bus.emit("project");
}
export const canUndo = () => history.undo.length > 0;
export const canRedo = () => history.redo.length > 0;
export function resetHistory() { history.undo = []; history.redo = []; }

// ------------------------------------------------------------------ selection

export function partners(clip) {
  if (!clip.linkId) return [];
  return P().clips.filter(c => c !== clip && c.linkId === clip.linkId);
}

export function withPartners(ids) {
  const out = new Set(ids);
  if (state.linked) for (const id of ids) { const c = getClip(id); if (c) partners(c).forEach(p => out.add(p.id)); }
  return out;
}

export function select(ids, { additive = false, toggle = false } = {}) {
  const set = withPartners(ids);
  if (!additive && !toggle) state.selection = set;
  else if (toggle && [...set].every(id => state.selection.has(id))) set.forEach(id => state.selection.delete(id));
  else set.forEach(id => state.selection.add(id));
  state.selTransition = null;
  bus.emit("selection");
}
export function clearSelection() { state.selection.clear(); state.selTransition = null; bus.emit("selection"); }
export const selectedClips = () => P().clips.filter(c => state.selection.has(c.id));

// ------------------------------------------------------------------ clip editing primitives

function cloneClip(clip) { return JSON.parse(JSON.stringify(clip)); }

function cropAllKeys(clip, a, b) {
  if (!clip.keys) return;
  for (const name of Object.keys(clip.keys)) {
    if (!clip.keys[name] || !clip.keys[name].length) { delete clip.keys[name]; continue; }
    clip.keys[name] = cropKeys(clip.keys[name], a, b);
  }
}

function trimStartTo(clip, newStart) {
  const tau = newStart - clip.start;
  const d = clipDur(clip);
  if (isStill(clip)) clip.in += tau;
  else if (clip.reverse) clip.out = srcTime(clip, tau);
  else clip.in = srcTime(clip, tau);
  cropAllKeys(clip, tau, d);
  if (hasSpeedKeys(clip)) clip.dur = d - tau;
  clip.start = newStart;
  clip.fadeIn = Math.min(clip.fadeIn || 0, clipDur(clip));
}

function trimEndTo(clip, newEnd) {
  const tau = newEnd - clip.start;
  if (isStill(clip)) clip.out = clip.in + tau;
  else if (clip.reverse) clip.in = srcTime(clip, tau);
  else clip.out = srcTime(clip, tau);
  cropAllKeys(clip, 0, tau);
  if (hasSpeedKeys(clip)) clip.dur = tau;
  clip.fadeOut = Math.min(clip.fadeOut || 0, clipDur(clip));
}

export function splitClip(clip, t) {
  if (t <= clip.start + EPS * 10 || t >= clipEnd(clip) - EPS * 10) return null;
  const right = cloneClip(clip);
  right.id = uid("c");
  trimStartTo(right, t);
  right.fadeIn = 0;
  trimEndTo(clip, t);
  clip.fadeOut = 0;
  P().clips.push(right);
  for (const tr of P().transitions) if (tr.a === clip.id) tr.a = right.id;
  return right;
}

function removeClip(clip) {
  P().clips = P().clips.filter(c => c !== clip);
  P().transitions = P().transitions.filter(t => t.a !== clip.id && t.b !== clip.id);
  for (const c of P().clips) if (c.parentId === clip.id) c.parentId = null;
  state.selection.delete(clip.id);
}

// Make room on a track for [a, b): trim, split or remove other clips (overwrite edit).
export function clearRange(trackId, a, b, exclude = new Set()) {
  for (const c of clipsOn(trackId)) {
    if (exclude.has(c.id)) continue;
    const s = c.start, e = clipEnd(c);
    if (s >= b - EPS || e <= a + EPS) continue;
    if (s >= a - EPS && e <= b + EPS) removeClip(c);
    else if (s < a && e > b) { const right = splitClip(c, b); trimEndTo(c, a); if (right) right.parentId = c.parentId; }
    else if (s < a) trimEndTo(c, a);
    else trimStartTo(c, b);
  }
}

function isPrimaryLinked(clip) {
  const pid = primaryId();
  return !!clip.linkId && P().clips.some(c => c.trackId === pid && c.linkId === clip.linkId && c !== clip);
}

function dependents(clip) {
  const pid = primaryId();
  return P().clips.filter(c => c !== clip && c.trackId !== pid && ((clip.linkId && c.linkId === clip.linkId) || c.parentId === clip.id));
}

export function pack(order) {
  const pid = primaryId();
  order = order || clipsOn(pid);
  let t = 0;
  for (const c of order) {
    const delta = Number.isFinite(c.start) ? t - c.start : 0;
    if (Math.abs(delta) > 1e-9 || !Number.isFinite(c.start)) {
      c.start = t;
      if (delta) for (const d of dependents(c)) d.start = Math.max(0, d.start + delta);
    }
    t += clipDur(c);
  }
}

export function assignParent(clip) {
  const pid = primaryId();
  if (!P().magnetic || clip.trackId === pid || isPrimaryLinked(clip)) { clip.parentId = null; return; }
  const host = clipsOn(pid).find(p => p.start <= clip.start + EPS && clipEnd(p) > clip.start + EPS);
  clip.parentId = host ? host.id : null;
}

// After clips were moved/added (already positioned), resolve overlaps the way the current mode dictates.
export function applyPlacement(movedIds) {
  const moved = new Set(movedIds);
  const pid = primaryId();
  if (P().magnetic) {
    const all = clipsOn(pid);
    const stationary = all.filter(c => !moved.has(c.id));
    const movers = all.filter(c => moved.has(c.id));
    const keyed = stationary.map((c, i) => ({ c, key: i }));
    movers.forEach((m, j) => {
      const idx = stationary.filter(s => s.start + clipDur(s) / 2 < m.start + EPS).length;
      keyed.push({ c: m, key: idx - 0.5 + j * 1e-4 });
    });
    keyed.sort((x, y) => x.key - y.key);
    pack(keyed.map(k => k.c));
    for (const id of moved) {
      const c = getClip(id);
      if (!c || c.trackId === pid) continue;
      if (!isPrimaryLinked(c)) clearRange(c.trackId, c.start, clipEnd(c), moved);
      assignParent(c);
    }
  } else {
    for (const id of moved) {
      const c = getClip(id);
      if (c) { clearRange(c.trackId, c.start, clipEnd(c), moved); c.parentId = null; }
    }
  }
}

// ------------------------------------------------------------------ high level operations

export function ensureAudioTrack(index) {
  while (audioTracks().length <= index) addTrack("audio", false);
  return audioTracks()[index].id;
}

export function addTrack(kind, emit = true) {
  const track = kind === "video" ? { id: uid("v"), kind, name: "", hidden: false, locked: false }
                                 : { id: uid("a"), kind, name: "", mute: false, solo: false, locked: false, volume: 0, pan: 0, fx: defaultFx(), keys: {} };
  const tracks = P().tracks;
  if (kind === "video") {
    const lastVideo = tracks.map(t => t.kind).lastIndexOf("video");
    tracks.splice(lastVideo + 1, 0, track);
  } else tracks.push(track);
  if (emit) bus.emit("tracks");
  return track;
}

export function removeTrack(trackId) {
  const track = getTrack(trackId);
  if (!track) return;
  const same = track.kind === "video" ? videoTracks() : audioTracks();
  if (same.length <= 1) return;
  for (const c of clipsOn(trackId)) removeClip(c);
  P().tracks = P().tracks.filter(t => t !== track);
}

export function newClipsForMedia(item, videoTrackId, audioTrackId, start) {
  const clips = [];
  const base = { mediaId: item.id, start, name: item.name, speed: 1, interp: "default", fadeIn: 0, fadeOut: 0, fadeInCurve: "linear", fadeOutCurve: "linear",
                 parentId: null, keys: {}, reverse: false };
  const length = isStillKind(item.kind) ? DEFAULT_STILL : Math.max(frameDur(), item.duration || 0);
  const linkId = item.kind === "video" && item.has_audio ? uid("l") : null;
  if (item.kind === "video" || isStillKind(item.kind)) {
    const clip = { ...base, id: uid("c"), trackId: videoTrackId, in: 0, out: length, linkId,
                   opacity: 1, scale: 1, x: 0, y: 0, rotation: 0, cropL: 0, cropR: 0, cropT: 0, cropB: 0, grade: defaultGrade() };
    clip.effects = [];
    if (item.kind === "title") { clip.title = defaultTitle(); clip.name = "Title"; }
    else if (GENERATOR_KINDS.has(item.kind)) { clip.gen = defaultGen(item.kind); clip.name = item.name; }
    clips.push(clip);
  }
  if (item.kind === "audio" || (item.kind === "video" && item.has_audio)) {
    clips.push({ ...base, id: uid("c"), trackId: audioTrackId, in: 0, out: length, linkId, volume: 0 });
  }
  return clips;
}

export function registerMedia(item) {
  P().media[item.id] = { ...(P().media[item.id] || {}), ...item };
  if (item.generator) return;
  const s = P().settings;
  if (s.auto && item.kind === "video" && item.width && item.height && !P().clips.length) {
    s.width = Math.round(item.width / 2) * 2;
    s.height = Math.round(item.height / 2) * 2;
    if (item.fps) s.fps = Math.round(item.fps * 1000) / 1000;
    s.auto = false;
    bus.emit("settings");
  }
}

// Place media at a time on a track. trackId may be a video or audio track; the counterpart track is chosen to match.
export function placeMedia(item, trackId, time) {
  if (!Number.isFinite(time)) time = timelineEnd();
  const kind = trackKind(trackId);
  let vTrack, aTrack;
  if (item.kind === "audio") {
    aTrack = kind === "audio" ? trackId : audioTracks()[0].id;
  } else if (GENERATOR_KINDS.has(item.kind)) {
    vTrack = kind === "video" ? trackId : videoTracks()[videoTracks().length - 1].id;
  } else {
    vTrack = kind === "video" ? trackId : primaryId();
    const vIndex = videoTracks().findIndex(t => t.id === vTrack);
    aTrack = kind === "audio" ? trackId : ensureAudioTrack(Math.max(0, vIndex));
  }
  const clips = newClipsForMedia(item, vTrack, aTrack, Math.max(0, snapFrame(time)));
  P().clips.push(...clips);
  applyPlacement(clips.map(c => c.id));
  return clips;
}

export function splitAt(t, { ids = null } = {}) {
  let targets = ids ? P().clips.filter(c => ids.has(c.id)) : P().clips.slice();
  targets = targets.filter(c => c.start < t - EPS && clipEnd(c) > t + EPS && !getTrack(c.trackId).locked);
  if (state.h3Snap) {   // cut WanGP clips on H3's 17-frame grid
    const wangp = targets.find(c => trackKind(c.trackId) === "video" && mediaOf(c)?.has_metadata);
    if (wangp) {
      t = gridSnapTime(wangp, t);
      targets = targets.filter(c => c.start < t - EPS && clipEnd(c) > t + EPS);
    }
  }
  const all = new Set(targets.map(c => c.id));
  if (state.linked) for (const c of targets) for (const p of partners(c)) if (p.start < t - EPS && clipEnd(p) > t + EPS) all.add(p.id);
  const newLinks = {};
  const rights = [];
  for (const id of all) {
    const c = getClip(id);
    const right = splitClip(c, t);
    if (!right) continue;
    if (c.linkId) right.linkId = newLinks[c.linkId] ||= uid("l");
    rights.push(right);
  }
  return rights;
}

export function deleteClips(ids, ripple = false) {
  const set = withPartners(ids);
  const removed = P().clips.filter(c => set.has(c.id) && !getTrack(c.trackId).locked);
  const intervals = {};
  for (const c of removed) (intervals[c.trackId] ||= []).push([c.start, clipEnd(c)]);
  for (const c of removed) removeClip(c);
  if (P().magnetic) { pack(); return; }
  if (!ripple) return;
  for (const [trackId, list] of Object.entries(intervals)) {
    for (const c of clipsOn(trackId)) {
      let shift = 0;
      for (const [s, e] of list) if (e <= c.start + EPS) shift += e - s;
      c.start = Math.max(0, c.start - shift);
    }
  }
}

export function rangeDelete(range, ripple) {
  const a = range.start, b = range.end;
  if (b - a < EPS) return;
  const tracks = ripple ? P().tracks.map(t => t.id) : range.trackIds;
  for (const tid of tracks) if (!getTrack(tid).locked) clearRange(tid, a, b);
  if (ripple) {
    for (const c of P().clips) if (c.start >= b - EPS) c.start = Math.max(0, c.start - (b - a));
  }
  if (P().magnetic) pack();
}

// Ripple everything after `time` on the given tracks by delta (used by speed changes in free mode).
function rippleAfter(trackIds, time, delta, exclude) {
  for (const c of P().clips) {
    if (exclude.has(c.id) || !trackIds.has(c.trackId)) continue;
    if (c.start >= time - 1e-4) c.start = Math.max(0, c.start + delta);
  }
}

// Changes that alter a clip's length: ripple later clips in free mode, repack in magnetic mode.
function afterLengthChange(changed) {
  const pid = primaryId();
  if (P().magnetic) { pack(); return; }
  for (const { clip, oldEnd } of changed.sort((x, y) => y.oldEnd - x.oldEnd)) {
    const delta = clipEnd(clip) - oldEnd;
    if (Math.abs(delta) < 1e-9 || clip.trackId === pid && P().magnetic) continue;
    const groupIds = new Set([clip.id, ...partners(clip).map(p => p.id)]);
    rippleAfter(new Set([clip.trackId, ...partners(clip).map(p => p.trackId)]), oldEnd, delta, groupIds);
  }
}

// Constant speed (removes any speed keyframes).
export function setSpeed(ids, speed) {
  const set = withPartners(ids);
  const clips = P().clips.filter(c => set.has(c.id) && !isStill(c));
  const changed = [];
  for (const c of clips) {
    const oldEnd = clipEnd(c);
    if (c.keys) delete c.keys.speed;
    delete c.dur;
    c.speed = Math.max(0.01, speed);
    if (c.fadeIn) c.fadeIn = Math.min(c.fadeIn, clipDur(c));
    if (c.fadeOut) c.fadeOut = Math.min(c.fadeOut, clipDur(c));
    changed.push({ clip: c, oldEnd });
  }
  afterLengthChange(changed);
}

// Copy a clip's timing (speed curve, length, source range) to linked partners that are aligned with it.
function syncTimingToPartners(clip, before) {
  for (const p of partners(clip)) {
    if (Math.abs(p.start - before.start) > 1e-4 || Math.abs(p.in - before.in) > 1e-4) continue;
    p.in = clip.in; p.out = clip.out; p.speed = clip.speed; p.reverse = !!clip.reverse;
    if (hasSpeedKeys(clip)) { p.keys = { ...(p.keys || {}), speed: JSON.parse(JSON.stringify(clip.keys.speed)) }; p.dur = clip.dur; }
    else { if (p.keys) delete p.keys.speed; delete p.dur; }
  }
}

// Replace a clip's speed curve (keys in multiplier units, t from the clip start). Keeps the clip length.
export function setSpeedKeys(clipId, keys, { keepLength = true } = {}) {
  const clip = getClip(clipId);
  if (!clip || isStill(clip)) return;
  const before = { start: clip.start, in: clip.in };
  const oldEnd = clipEnd(clip);
  const dur = clipDur(clip);
  clip.keys = clip.keys || {};
  if (!keys || !keys.length) {
    const s = clip.keys.speed?.length ? Math.max(0.01, keyValue(clip.keys.speed, 0)) : clip.speed;
    delete clip.keys.speed;
    delete clip.dur;
    clip.speed = Math.max(0.01, s);
    if (clip.reverse) clip.in = Math.max(0, clip.out - clip.speed * dur);
    else clip.out = Math.min((mediaOf(clip) || {}).duration || Infinity, clip.in + clip.speed * dur);
  } else {
    clip.keys.speed = keys.map(k => ({ ...k, v: Math.max(0, k.v) }));
    if (keepLength || !clip.dur) clip.dur = dur;
    syncSpeedOut(clip);
  }
  syncTimingToPartners(clip, before);
  afterLengthChange([{ clip, oldEnd }]);
}

// Allowed new time for trimming a clip edge, honouring source length and neighbours.
export function trimLimits(clip, edge, groupIds) {
  const still = isStill(clip);
  const room = sourceRoom(clip);
  const s0 = speedAt(clip, 0);
  const free = !(P().magnetic && (clip.trackId === primaryId() || isPrimaryLinked(clip)));
  const neighbours = clipsOn(clip.trackId).filter(c => !groupIds.has(c.id));
  const minDur = frameDur();
  if (edge === "start") {
    let lo = still || s0 <= 1e-6 ? -Infinity : clip.start - room.before / s0;
    if (free) for (const n of neighbours) if (clipEnd(n) <= clip.start + EPS) lo = Math.max(lo, clipEnd(n));
    if (free) lo = Math.max(lo, 0);
    return [lo, clipEnd(clip) - minDur];
  }
  let hi = still ? Infinity : clip.start + tauForLength(clip, (clip.out - clip.in) + room.after);
  if (free) for (const n of neighbours) if (n.start >= clipEnd(clip) - EPS) hi = Math.min(hi, n.start);
  return [clip.start + minDur, hi];
}

export function trimEdge(clipId, edge, time, { linked = true, snap = true } = {}) {
  const clip = getClip(clipId);
  if (!clip) return;
  if (snap && state.h3Snap && trackKind(clip.trackId) === "video") time = gridSnapTime(clip, time);
  const edgeTime = edge === "start" ? clip.start : clipEnd(clip);
  const group = [clip];
  if (linked && state.linked) for (const p of partners(clip)) {
    const pt = edge === "start" ? p.start : clipEnd(p);
    if (Math.abs(pt - edgeTime) < 1e-3) group.push(p);
  }
  const ids = new Set(group.map(c => c.id));
  let lo = -Infinity, hi = Infinity;
  for (const g of group) {
    const [a, b] = trimLimits(g, edge, ids);
    lo = Math.max(lo, a); hi = Math.min(hi, b);
  }
  const t = clamp(time, lo, hi);
  for (const g of group) {
    if (edge === "start") trimStartTo(g, t); else trimEndTo(g, t);
  }
  if (P().magnetic) pack();
}

export function moveClips(ids, dt, trackShift, grabbedKind) {
  const set = withPartners(ids);
  const clips = P().clips.filter(c => set.has(c.id) && !getTrack(c.trackId).locked);
  if (!clips.length) return;
  const minStart = Math.min(...clips.map(c => c.start));
  dt = Math.max(dt, -minStart);
  const kinds = { video: videoTracks(), audio: audioTracks() };
  if (trackShift) {
    const list = kinds[grabbedKind];
    const indices = clips.filter(c => trackKind(c.trackId) === grabbedKind).map(c => list.findIndex(t => t.id === c.trackId));
    const lo = Math.min(...indices), hi = Math.max(...indices);
    trackShift = clamp(trackShift, -lo, list.length - 1 - hi);
  }
  for (const c of clips) {
    c.start = Math.max(0, c.start + dt);
    if (trackShift && trackKind(c.trackId) === grabbedKind) {
      const list = kinds[grabbedKind];
      c.trackId = list[list.findIndex(t => t.id === c.trackId) + trackShift].id;
    }
  }
  applyPlacement(clips.map(c => c.id));
}

// ------------------------------------------------------------------ keyframe editing
// Times are seconds from the owner's start (clip start, or 0 for track automation); values in stored units.

function indexNear(ks, tau, tol) {
  tol = tol ?? frameDur() / 2 + 1e-6;
  let best = -1, dist = Infinity;
  ks.forEach((k, i) => { const d = Math.abs(k.t - tau); if (d <= tol && d < dist) { best = i; dist = d; } });
  return best;
}
function resetShape(ks, i) { for (const j of [i - 1, i]) if (ks[j]) delete ks[j].r; }
function tidy(ks) { for (const k of ks) if (k.r && Math.abs(k.r[0]) < 1e-9 && Math.abs(k.r[1] - 1) < 1e-9) delete k.r; return ks; }

// Pure operations on a key list (sorted copies in, sorted copies out).
const KeyOps = {
  set(list, tau, value) {
    const ks = K.sorted(list).map(k => ({ ...k }));
    const i = indexNear(ks, tau);
    if (i >= 0) { ks[i].v = value; resetShape(ks, i); return ks; }
    if (!ks.length) return [{ t: tau, v: value, ease: "linear" }];
    const before = keyValue(ks, tau);
    const j = ks.findIndex((k, n) => ks[n + 1] && k.t < tau && tau < ks[n + 1].t);
    const key = { t: tau, v: before, ease: j >= 0 ? (ks[j].ease || "linear") : "linear" };
    if (j >= 0) {
      const [r0, r1] = ks[j].r || [0, 1];
      const xm = r0 + (tau - ks[j].t) / (ks[j + 1].t - ks[j].t) * (r1 - r0);
      ks[j].r = [r0, xm];
      key.r = [xm, r1];
    }
    ks.push(key);
    const out = K.sorted(ks);
    if (Math.abs(value - before) > 1e-9) { key.v = value; resetShape(out, out.indexOf(key)); }
    return tidy(out);
  },
  remove(list, index) { const ks = K.sorted(list).map(k => ({ ...k })); if (ks[index]) { ks.splice(index, 1); resetShape(ks, index); } return ks; },
  ease(list, index, ease) { const ks = K.sorted(list).map(k => ({ ...k })); if (ks[index]) { ks[index].ease = ease; delete ks[index].r; } return ks; },
  move(list, index, tau, value, maxT) {
    const ks = K.sorted(list).map(k => ({ ...k }));
    const k = ks[index];
    if (!k) return ks;
    const fd = frameDur() / 4;
    const lo = index > 0 ? ks[index - 1].t + fd : 0;
    const hi = index < ks.length - 1 ? ks[index + 1].t - fd : maxT;
    if (tau !== null && tau !== undefined) k.t = clamp(tau, Math.min(lo, hi), Math.max(lo, hi));
    if (value !== null && value !== undefined) k.v = value;
    resetShape(ks, index);
    return ks;
  },
  offset(list, indices, delta, [lo, hi]) {
    const ks = K.sorted(list).map(k => ({ ...k }));
    for (const i of indices) if (ks[i]) { ks[i].v = clamp(ks[i].v + delta, lo, hi); resetShape(ks, i); }
    return ks;
  },
};

export function keyIndexAt(clip, name, tau, tol = null) { return indexNear(keysOf(clip, name), tau, tol); }

function storeKeys(clip, name, ks) {
  ks = K.sorted(ks);
  if (name === "speed") { setSpeedKeys(clip.id, ks); return; }
  clip.keys = clip.keys || {};
  if (ks.length) clip.keys[name] = ks;
  else delete clip.keys[name];
}

export function setKeyAt(clipId, name, tau, value) {
  const clip = getClip(clipId);
  if (!clip) return;
  storeKeys(clip, name, KeyOps.set(keysOf(clip, name), clamp(tau, 0, clipDur(clip)), value));
}
export function removeKey(clipId, name, index) {
  const clip = getClip(clipId);
  if (!clip) return;
  const ks = K.sorted(keysOf(clip, name));
  if (!ks[index]) return;
  const after = KeyOps.remove(ks, index);
  if (!after.length && name !== "speed" && !name.startsWith("grade:") && !name.startsWith("fx:")) clip[name] = ks[index].v;
  if (!after.length && name.startsWith("fx:")) { const { id, key } = parseLane(name); updateEffect(clip.id, id, f => { f.params[key] = ks[index].v; }); }
  if (!after.length && name.startsWith("grade:")) { clip.grade = { ...(clip.grade || defaultGrade()) }; setPath(clip.grade, name.slice(6), ks[index].v); }
  storeKeys(clip, name, after);
}
export function clearKeys(clipId, name, keepValue) {
  const clip = getClip(clipId);
  if (!clip) return;
  if (name !== "speed" && keepValue !== undefined) clip[name] = keepValue;
  storeKeys(clip, name, []);
}
export function setKeyEase(clipId, name, index, ease) {
  const clip = getClip(clipId);
  if (clip) storeKeys(clip, name, KeyOps.ease(keysOf(clip, name), index, ease));
}
export function moveKey(clipId, name, index, tau, value) {
  const clip = getClip(clipId);
  if (clip) storeKeys(clip, name, KeyOps.move(keysOf(clip, name), index, tau, value, clipDur(clip)));
}
export function offsetKeys(clipId, name, indices, delta, limits) {
  const clip = getClip(clipId);
  if (clip) storeKeys(clip, name, KeyOps.offset(keysOf(clip, name), indices, delta, limits));
}

// Set a property at a clip time: a keyframe if the property is keyframed, otherwise the static value.
export function setPropAt(clipId, name, tau, value) {
  const clip = getClip(clipId);
  if (!clip) return;
  if (hasKeys(clip, name)) { if (tau >= -1e-6 && tau <= clipDur(clip) + 1e-6) setKeyAt(clipId, name, snapFrame(clamp(tau, 0, clipDur(clip))), value); }
  else if (name === "speed") setSpeed([clipId], Math.max(0.01, value));
  else if (name.startsWith("fx:")) setEffectStatic(clip, name, value);
  else clip[name] = value;
}

// ---- grade keyframes: every grade field is keyed together at the same times
export function gradeKeyTimes(clip) {
  const times = new Set();
  for (const f of GRADE_FIELDS) for (const k of keysOf(clip, "grade:" + f)) times.add(+k.t.toFixed(6));
  return [...times].sort((a, b) => a - b);
}
export function setGradeAt(clipId, tau, grade, { addKey = false } = {}) {
  const clip = getClip(clipId);
  if (!clip) return;
  const keyed = hasGradeKeys(clip);
  if (!keyed && !addKey) { clip.grade = JSON.parse(JSON.stringify(grade)); return; }
  tau = snapFrame(clamp(tau, 0, clipDur(clip)));
  clip.grade = { ...mergeGrade(clip.grade), enabled: grade.enabled, lut: grade.lut ?? null, style: grade.style || "lgg" };
  for (const f of GRADE_FIELDS) storeKeys(clip, "grade:" + f, KeyOps.set(keysOf(clip, "grade:" + f), tau, gradeFieldValue(grade, f)));
}
export function removeGradeKeyAt(clipId, tau) {
  const clip = getClip(clipId);
  if (!clip) return;
  const current = gradeAt(clip, tau);
  for (const f of GRADE_FIELDS) {
    const i = keyIndexAt(clip, "grade:" + f, tau);
    if (i >= 0) storeKeys(clip, "grade:" + f, KeyOps.remove(keysOf(clip, "grade:" + f), i));
  }
  if (!hasGradeKeys(clip)) clip.grade = current;
}
export function clearGradeKeys(clipId, tau) {
  const clip = getClip(clipId);
  if (!clip) return;
  const current = gradeAt(clip, tau);
  for (const f of GRADE_FIELDS) storeKeys(clip, "grade:" + f, []);
  clip.grade = current;
}
export function setGradeEaseAt(clipId, tau, ease) {
  const clip = getClip(clipId);
  if (!clip) return;
  for (const f of GRADE_FIELDS) {
    const i = keyIndexAt(clip, "grade:" + f, tau);
    if (i >= 0) storeKeys(clip, "grade:" + f, KeyOps.ease(keysOf(clip, "grade:" + f), i, ease));
  }
}

// ---- track volume automation (times are timeline seconds, values dB added to the fader)
export const trackKeys = (track) => (track && track.keys && track.keys.volume) || [];
export function trackGainDb(track, t) { const ks = trackKeys(track); return ks.length ? keyValue(ks, t) : 0; }
function storeTrackKeys(track, ks) { track.keys = track.keys || {}; if (ks.length) track.keys.volume = K.sorted(ks); else delete track.keys.volume; }
export function trackKeyIndexAt(trackId, t) { return indexNear(trackKeys(getTrack(trackId)), t, Math.max(frameDur() / 2, 1e-3)); }
export function setTrackKeyAt(trackId, t, value) { const tr = getTrack(trackId); if (tr) storeTrackKeys(tr, KeyOps.set(trackKeys(tr), Math.max(0, snapFrame(t)), value)); }
export function removeTrackKey(trackId, index) { const tr = getTrack(trackId); if (tr) storeTrackKeys(tr, KeyOps.remove(trackKeys(tr), index)); }
export function setTrackKeyEase(trackId, index, ease) { const tr = getTrack(trackId); if (tr) storeTrackKeys(tr, KeyOps.ease(trackKeys(tr), index, ease)); }
export function moveTrackKey(trackId, index, t, value) { const tr = getTrack(trackId); if (tr) storeTrackKeys(tr, KeyOps.move(trackKeys(tr), index, t, value, 1e9)); }
export function offsetTrackKeys(trackId, indices, delta) { const tr = getTrack(trackId); if (tr) storeTrackKeys(tr, KeyOps.offset(trackKeys(tr), indices, delta, [-60, 12])); }
export function clearTrackKeys(trackId) { const tr = getTrack(trackId); if (tr) storeTrackKeys(tr, []); }

// ------------------------------------------------------------------ shot detection
// Clip time (from the clip start) at which a source time is shown.
export function clipTimeForSource(clip, src) {
  return tauForLength(clip, clip.reverse ? clip.out - src : src - clip.in);
}

// Split a clip (and its aligned linked audio) at cuts ({t: source time, keys: ["W1S2", ...]}), then label every piece
// as a shot. `shots` is the prompt's shot list: a piece gets the shot matched to the cut that starts it (the first shot
// for the opening piece) plus any shot that continues without a cut inside it. Pieces are named "Name · Shot N".
export function splitIntoShots(clipId, cuts, shots = []) {
  cuts = cuts.map(c => (typeof c === "number" ? { t: c, keys: [] } : c));
  const srcTimes = cuts.map(c => c.t);
  const clip = getClip(clipId);
  if (!clip) return [];
  const base = clip.name || (mediaOf(clip) || {}).name || "Clip";
  const mediaId = clip.mediaId;
  const start = clip.start, end = clipEnd(clip);
  const tracks = new Set([clip.trackId, ...partners(clip).filter(p => Math.abs(p.start - start) < 1e-3).map(p => p.trackId)]);
  const times = srcTimes.map(src => start + clipTimeForSource(clip, src))
    .filter(t => t > start + frameDur() / 2 && t < end - frameDur() / 2).sort((a, b) => a - b);
  for (const t of times) {
    const ids = new Set(P().clips.filter(c => c.mediaId === mediaId && tracks.has(c.trackId) && c.start < t - EPS && clipEnd(c) > t + EPS).map(c => c.id));
    splitAt(snapFrame(t), { ids });
  }
  const pieces = P().clips.filter(c => c.mediaId === mediaId && tracks.has(c.trackId) && c.start >= start - 1e-3 && clipEnd(c) <= end + 1e-3);
  const videoPieces = pieces.filter(c => c.trackId === clip.trackId).sort((a, b) => a.start - b.start);
  const keyOf = (s) => `W${s.window}S${s.shot}`;
  const matched = new Set(cuts.flatMap(c => c.keys || []));
  const ordered = shots.slice().sort((x, y) => x.start - y.start);
  videoPieces.forEach((piece, i) => {
    const a = srcTime(piece, 0), b = srcTime(piece, clipDur(piece));
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const startSrc = a;   // where this piece begins in playback order
    const cut = cuts.find(c => Math.abs(c.t - startSrc) < frameDur());
    const primary = cut && cut.keys?.length ? ordered.filter(s => cut.keys.includes(keyOf(s)))
      : i === 0 ? ordered.filter(s => !matched.has(keyOf(s))).slice(0, 1) : [];
    // shots that begin inside this piece without a cut of their own (e.g. a window continuing the same camera)
    const continuing = ordered.filter(s => !matched.has(keyOf(s)) && s.start > lo + frameDur() && s.start < hi - frameDur() && !primary.includes(s));
    const info = { index: i + 1, count: videoPieces.length, source: [lo, hi], shots: [...primary, ...continuing] };
    const name = `${base} · Shot ${i + 1}`;
    for (const c of pieces.filter(c => Math.abs(c.start - piece.start) < 1e-3)) { c.shotInfo = info; c.name = name; }
  });
  return videoPieces;
}

// ------------------------------------------------------------------ takes (regenerated versions of a shot)

// The original material of a clip: its first take when it has takes, else the clip itself.
export function originalOf(clip) {
  const t = clip.takes && clip.takes[0];
  const src = t || clip;
  return { mediaId: src.mediaId, in: Math.min(src.in, src.out), out: Math.max(src.in, src.out) };
}
const alignedPartners = (clip) => partners(clip).filter(p => Math.abs(p.start - clip.start) < 1e-3);

// Add a take to a clip and switch to it. take: {mediaId, length (seconds of usable footage), label, seed, audio: "keep"|"new", jobId}
export function addTake(clipId, take) {
  const clip = getClip(clipId);
  if (!clip) return null;
  if (!clip.takes || !clip.takes.length) {
    clip.takes = [{ id: uid("tk"), mediaId: clip.mediaId, in: clip.in, out: clip.out, label: "Original",
                    partners: alignedPartners(clip).map(p => ({ id: p.id, mediaId: p.mediaId, in: p.in, out: p.out })) }];
    clip.takeIndex = 0;
  }
  const t0 = take.in || 0;
  const entry = { id: uid("tk"), mediaId: take.mediaId, in: t0, out: t0 + Math.max(frameDur(), take.length), label: take.label || `Take ${clip.takes.length + 1}`,
                  seed: take.seed ?? null, audio: take.audio || "new", jobId: take.jobId || null, created: Date.now() };
  clip.takes.push(entry);
  setTake(clipId, clip.takes.length - 1);
  return entry;
}

// Show take `index` in the clip (and its linked audio when that take brought new audio).
export function setTake(clipId, index) {
  const clip = getClip(clipId);
  if (!clip || !clip.takes || !clip.takes[index]) return;
  const take = clip.takes[index];
  const oldEnd = clipEnd(clip);
  const before = alignedPartners(clip);
  clip.mediaId = take.mediaId;
  if (clip.reverse) { clip.out = take.out; clip.in = take.in; } else { clip.in = take.in; clip.out = take.out; }
  if (hasSpeedKeys(clip)) syncSpeedOut(clip);
  clip.takeIndex = index;
  const original = clip.takes[0].partners || [];
  for (const p of before) {
    const o = original.find(x => x.id === p.id);
    if (index > 0 && take.audio === "new") { p.mediaId = take.mediaId; p.in = take.in; p.out = take.out; }
    else if (o) { p.mediaId = o.mediaId; p.in = o.in; p.out = o.out; }
    p.speed = clip.speed;
    if (hasSpeedKeys(clip)) { p.keys = { ...(p.keys || {}), speed: JSON.parse(JSON.stringify(clip.keys.speed)) }; p.dur = clip.dur; }
  }
  afterLengthChange([{ clip, oldEnd }]);
}

export function removeTake(clipId, index) {
  const clip = getClip(clipId);
  if (!clip || !clip.takes || index <= 0 || !clip.takes[index]) return;
  const active = clip.takeIndex || 0;
  clip.takes.splice(index, 1);
  if (active === index) setTake(clipId, 0);
  else if (active > index) clip.takeIndex = active - 1;
  if (clip.takes.length === 1 && (clip.takeIndex || 0) === 0) { delete clip.takes; delete clip.takeIndex; }
}

// ---- timeline generations (extend / prepend / bridge / fill / loop)

// The empty stretch of a track around time t: {start, end, prev, next}, or null when t is on a clip.
export function gapAt(trackId, t) {
  const list = clipsOn(trackId);
  if (list.some(c => c.start <= t + EPS && clipEnd(c) > t + EPS)) return null;
  const prev = list.filter(c => clipEnd(c) <= t + EPS).pop() || null;
  const next = list.find(c => c.start >= t - EPS) || null;
  return { start: prev ? clipEnd(prev) : 0, end: next ? next.start : Infinity, prev, next };
}

// Place media at a time with its source range [inT, outT], pushing later clips on its tracks along to make room
// (or, filling a gap, only by the part that does not fit). Returns the new clips (video first).
export function insertMedia(item, trackId, time, inT, outT, { room = 0, close = false } = {}) {
  const vIndex = videoTracks().findIndex(t => t.id === trackId);
  const audioTrack = item.has_audio ? ensureAudioTrack(Math.max(0, vIndex)) : null;
  const clips = newClipsForMedia(item, trackId, audioTrack, snapFrame(time));
  for (const c of clips) { c.in = inT; c.out = outT; }
  const dur = outT - inT;
  // a fill that comes back shorter than its gap pulls the later clips in, so it still meets the next clip
  const push = close && room > 0 ? dur - room : Math.max(0, dur - room);
  if (Math.abs(push) > EPS) rippleAfter(new Set([trackId, ...(audioTrack ? [audioTrack] : [])]), time + room - EPS, push, new Set());
  P().clips.push(...clips);
  if (P().magnetic && trackId === primaryId()) applyPlacement(clips.map(c => c.id));
  return clips;
}

// Move a clip's cut (the source time at its end or start) to `src` seconds, with its aligned linked audio.
export function setCutSource(clipId, edge, src) {
  const clip = getClip(clipId);
  if (!clip) return;
  const tau = clipTimeForSource(clip, src);
  if (!Number.isFinite(tau)) return;
  trimEdge(clipId, edge === "end" ? "end" : "start", clip.start + tau, { snap: false });
}

// The generated clip that already sits in a slot (so a new take goes onto it instead of adding another clip).
export function generatedIn(mode, parentId, childId) {
  return P().clips.find(c => c.gen && c.gen.mode === mode && (c.gen.parent || null) === (parentId || null) && (c.gen.child || null) === (childId || null)) || null;
}

// H3 compresses time in 17-frame groups; latent-grade pins need cuts on that grid.
export function gridSnapTime(clip, t) {
  const item = mediaOf(clip);
  if (!item || item.kind !== "video" || !item.has_metadata) return t;
  const f = item.fps || fps();
  const src = srcTime(clip, clamp(t - clip.start, 0, clipDur(clip)));
  const snapped = Math.round(src * f / 17) * 17 / f;
  const tau = clipTimeForSource(clip, Math.min(Math.max(snapped, 0), item.duration || snapped));
  return Number.isFinite(tau) ? clip.start + tau : t;
}

// Neighbouring clips on the same track that touch this one (for previous / next shot frames).
export function touchingNeighbours(clip) {
  const list = clipsOn(clip.trackId);
  const tol = frameDur() * 0.6;
  return { prev: list.find(c => c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < tol) || null,
           next: list.find(c => c.id !== clip.id && Math.abs(c.start - clipEnd(clip)) < tol) || null };
}

// ------------------------------------------------------------------ reverse, freeze frame, markers

export function setReverse(ids, on) {
  const set = withPartners(ids);
  for (const c of P().clips) if (set.has(c.id) && !isStill(c)) c.reverse = !!on;
}

// Insert a held frame of the clip under the playhead, pushing later material along.
export function freezeFrame(t, duration = 2, preferIds = null) {
  const candidates = videoTracks().slice().reverse()
    .flatMap(tr => clipsOn(tr.id))
    .filter(c => !isStill(c) && c.start <= t + EPS && clipEnd(c) > t + EPS && !getTrack(c.trackId).hidden && !getTrack(c.trackId).locked);
  const source = (preferIds && candidates.find(c => preferIds.has(c.id))) || candidates[0];
  if (!source) return null;
  const tau = clamp(t - source.start, 0, clipDur(source));
  const frozen = cloneClip(source);
  frozen.id = uid("c");
  frozen.linkId = null;
  frozen.parentId = null;
  for (const name of Object.keys(frozen.keys || {})) {
    if (name === "speed") continue;
    const v = keyValue(frozen.keys[name], tau);
    frozen.keys[name] = [{ t: 0, v, ease: "linear" }];
  }
  const src = srcTime(source, Math.min(tau, Math.max(0, clipDur(source) - frameDur() / 2)));
  frozen.reverse = false;
  frozen.in = src;
  frozen.out = src + 1e-3;
  frozen.keys = { ...(frozen.keys || {}), speed: [{ t: 0, v: 0, ease: "linear" }] };
  frozen.dur = Math.max(frameDur(), duration);
  frozen.fadeIn = 0; frozen.fadeOut = 0;
  frozen.name = `${source.name || "Clip"} (freeze)`;
  const pid = primaryId();
  const cut = snapFrame(t);
  splitAt(cut, { ids: new Set([source.id]) });
  frozen.start = cut;
  frozen.trackId = source.trackId;
  if (P().magnetic && source.trackId === pid) {
    const order = clipsOn(pid);
    const idx = order.findIndex(c => c.start >= cut - EPS);
    order.splice(idx < 0 ? order.length : idx, 0, frozen);
    P().clips.push(frozen);
    pack(order);
  } else if (P().magnetic) {
    // freeze on a connected track: push only that track's later clips (and what is linked to them)
    const moving = new Set(clipsOn(source.trackId).filter(c => c.start >= cut - EPS).map(c => c.id));
    for (const id of [...moving]) for (const p of partners(getClip(id))) moving.add(p.id);
    for (const c of P().clips) if (moving.has(c.id)) c.start += frozen.dur;
    P().clips.push(frozen);
    assignParent(frozen);
  } else {
    for (const c of P().clips) if (c.start >= cut - EPS) c.start += frozen.dur;
    for (const m of P().markers || []) if (m.t >= cut - EPS) m.t += frozen.dur;
    P().clips.push(frozen);
  }
  return frozen;
}

export const MARKER_COLORS = ["#4f8cff", "#ff5a5a", "#ffcc4d", "#36c46f", "#b86bff", "#ff8a3d", "#e0e0e0"];
export function addMarker(t, name = "") {
  P().markers = P().markers || [];
  t = Math.max(0, snapFrame(t));
  const existing = P().markers.find(m => Math.abs(m.t - t) < frameDur() / 2);
  if (existing) return existing;
  const m = { id: uid("m"), t, name: name || `Marker ${P().markers.length + 1}`, color: MARKER_COLORS[0], note: "" };
  P().markers.push(m);
  P().markers.sort((a, b) => a.t - b.t);
  return m;
}
export const getMarker = (id) => (P().markers || []).find(m => m.id === id);
export function removeMarker(id) { P().markers = (P().markers || []).filter(m => m.id !== id); }

// ------------------------------------------------------------------ transitions

export function findCut(trackId, time, tolerance) {
  const list = clipsOn(trackId);
  let best = null;
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    const cut = clipEnd(a);
    if (Math.abs(cut - b.start) > frameDur() / 2 + 1e-4) continue;
    const dist = Math.abs(cut - time);
    if (dist <= tolerance && (!best || dist < best.dist)) best = { a, b, cut, dist };
  }
  return best;
}

export function addTransition(trackId, a, b, presetId, duration) {
  const max = Math.max(frameDur(), Math.min(clipDur(a), clipDur(b)));
  duration = clamp(snapFrame(duration) || frameDur(), frameDur(), max);
  P().transitions = P().transitions.filter(t => !(t.a === a.id && t.b === b.id));
  const { type, params } = presetTransition(presetId);
  const tr = { id: uid("t"), trackId, a: a.id, b: b.id, type, params, duration, feather: false, border: 0, borderColor: "#ffffff" };
  P().transitions.push(tr);
  return tr;
}

export function validateTransitions() {
  const fd = frameDur();
  P().transitions = P().transitions.filter(tr => {
    const a = getClip(tr.a), b = getClip(tr.b);
    if (!a || !b || a.trackId !== b.trackId) return false;
    if (Math.abs(clipEnd(a) - b.start) > fd / 2 + 1e-4) return false;
    tr.trackId = a.trackId;
    tr.duration = clamp(tr.duration, fd, Math.max(fd, Math.min(clipDur(a), clipDur(b))));
    return true;
  });
}

// How many seconds of real footage a transition can use beyond each cut (for the "frames will be held" warning).
export function transitionHandles(tr) {
  const info = transitionInfo(tr);
  if (!info) return null;
  const { a, b } = info;
  const half = tr.duration / 2;
  const endSpeed = speedAt(a, clipDur(a)), startSpeed = speedAt(b, 0);
  const spareA = isStill(a) || endSpeed <= 1e-6 ? Infinity : sourceRoom(a).after / endSpeed;
  const spareB = isStill(b) || startSpeed <= 1e-6 ? Infinity : sourceRoom(b).before / startSpeed;
  return { needed: half, spareA, spareB };
}

// ------------------------------------------------------------------ clipboard

export function copySelection() {
  const clips = selectedClips();
  if (!clips.length) return 0;
  const minStart = Math.min(...clips.map(c => c.start));
  state.clipboard = clips.map(c => ({ ...cloneClip(c), rel: c.start - minStart }));
  return clips.length;
}

export function paste(at) {
  if (!state.clipboard || !state.clipboard.length) return [];
  const linkMap = {};
  const created = [];
  for (const src of state.clipboard) {
    if (!P().media[src.mediaId] || !getTrack(src.trackId)) continue;
    const c = cloneClip(src);
    delete c.rel;
    c.id = uid("c");
    c.start = snapFrame(at + src.rel);
    c.parentId = null;
    if (c.linkId) c.linkId = linkMap[c.linkId] ||= uid("l");
    P().clips.push(c);
    created.push(c);
  }
  applyPlacement(created.map(c => c.id));
  return created;
}

export function setMagnetic(on) {
  P().magnetic = on;
  if (on) {
    pack();
    for (const c of P().clips) assignParent(c);
  } else for (const c of P().clips) c.parentId = null;
}

export function linkClips(ids) {
  const linkId = uid("l");
  for (const id of ids) { const c = getClip(id); if (c) c.linkId = linkId; }
}
export function unlinkClips(ids) {
  for (const id of ids) { const c = getClip(id); if (c) c.linkId = null; }
}

// Edit points (clip starts and ends) for up/down navigation and snapping.
export function editPoints() {
  const pts = new Set([0]);
  for (const c of P().clips) { pts.add(+c.start.toFixed(6)); pts.add(+clipEnd(c).toFixed(6)); }
  for (const m of P().markers || []) pts.add(+m.t.toFixed(6));
  return [...pts].sort((a, b) => a - b);
}

// Bring projects saved by older versions (or hand edited) up to the current shape.
// Clip times must be real numbers; anything else (from an earlier bug) is reset so the clip shows up again.
export function repairTimes(project) {
  let fixed = 0;
  for (const c of project.clips) {
    for (const key of ["start", "in", "out"]) {
      if (!Number.isFinite(c[key])) { c[key] = key === "out" ? (Number.isFinite(c.in) ? c.in : 0) + 1 : 0; fixed++; }
    }
    if (c.out <= c.in) { c.out = c.in + 1 / (project.settings.fps || 24); fixed++; }
  }
  if (!Number.isFinite(project.inPoint)) project.inPoint = null;
  if (!Number.isFinite(project.outPoint)) project.outPoint = null;
  return fixed;
}

function mergeFx(fx) {
  const d = defaultFx();
  fx = fx || {};
  return { eq: { ...d.eq, ...(fx.eq || {}), low: { ...d.eq.low, ...(fx.eq?.low || {}) }, mid: { ...d.eq.mid, ...(fx.eq?.mid || {}) }, high: { ...d.eq.high, ...(fx.eq?.high || {}) } },
           comp: { ...d.comp, ...(fx.comp || {}) } };
}
export function mergeTitle(t) {
  const d = defaultTitle();
  t = t || {};
  return { ...d, ...t, outline: { ...d.outline, ...(t.outline || {}) }, shadow: { ...d.shadow, ...(t.shadow || {}) }, box: { ...d.box, ...(t.box || {}) } };
}

export function normalizeProject(project) {
  const base = newProject(project.name || "Untitled");
  for (const key of Object.keys(base)) if (project[key] === undefined) project[key] = base[key];
  project.settings = { ...base.settings, ...project.settings };
  Object.assign(project.media, generatorMedia());
  project.markers ??= [];
  project.master = { volume: 0, ...(project.master || {}) };
  project.master.fx = mergeFx(project.master.fx);
  for (const t of project.tracks) if (t.kind === "audio") { t.fx = mergeFx(t.fx); t.keys ??= {}; }
  for (const tr of project.transitions) normalizeTransition(tr);
  for (const c of project.clips) {
    c.speed ??= 1; c.interp ??= "default"; c.fadeIn ??= 0; c.fadeOut ??= 0; c.parentId ??= null; c.linkId ??= null;
    c.fadeInCurve ??= "linear"; c.fadeOutCurve ??= "linear"; c.keys ??= {}; c.reverse ??= false;
    // Older projects stored a linear ramp as speed -> rampTo; turn it into two speed keyframes.
    if (c.rampTo !== undefined && c.rampTo !== null && c.rampTo !== "" && Math.abs(Number(c.rampTo) - c.speed) > 1e-9 && project.media[c.mediaId]?.kind !== "image") {
      const s0 = Math.max(0.05, Number(c.speed) || 1), s1 = Math.max(0.05, Number(c.rampTo));
      const d = 2 * (c.out - c.in) / (s0 + s1);
      c.keys.speed = [{ t: 0, v: s0, ease: "linear" }, { t: d, v: s1, ease: "linear" }];
      c.dur = d;
    }
    delete c.rampTo;
    if (project.tracks.find(t => t.id === c.trackId)?.kind === "video") {
      c.opacity ??= 1; c.scale ??= 1; c.x ??= 0; c.y ??= 0; c.rotation ??= 0; c.cropL ??= 0; c.cropR ??= 0; c.cropT ??= 0; c.cropB ??= 0;
      c.grade = mergeGrade(c.grade);
      c.effects = Array.isArray(c.effects) ? c.effects : [];
      const kind = project.media[c.mediaId]?.kind;
      if (kind === "title") c.title = mergeTitle(c.title);
      else if (GENERATOR_KINDS.has(kind)) c.gen = { ...defaultGen(kind), ...(c.gen || {}) };
    } else c.volume ??= 0;
  }
  return project;
}
