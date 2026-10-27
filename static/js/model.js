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
           exposure: 0, contrast: 0, saturation: 1, temperature: 0, tint: 0 };
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
};

export const P = () => state.project;

export function newProject(name = "Untitled") {
  return {
    version: 1, name,
    settings: { width: 1280, height: 720, fps: 24, auto: true },
    tracks: [
      { id: uid("v"), kind: "video", name: "", hidden: false, locked: false },
      { id: uid("v"), kind: "video", name: "", hidden: false, locked: false },
      { id: uid("a"), kind: "audio", name: "", mute: false, solo: false, locked: false, volume: 0, pan: 0 },
      { id: uid("a"), kind: "audio", name: "", mute: false, solo: false, locked: false, volume: 0, pan: 0 },
    ],
    clips: [], transitions: [], media: {}, master: { volume: 0 },
    magnetic: true, snapping: true, inPoint: null, outPoint: null, exportDefaults: null,
  };
}

// ------------------------------------------------------------------ lookups

export const fps = () => P().settings.fps || 24;
export const frameDur = () => 1 / fps();
export const snapFrame = (t) => Math.round(t * fps()) / fps();
export const mediaOf = (clip) => P().media[clip.mediaId];
export const kindOf = (clip) => (mediaOf(clip) || {}).kind;
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
  speed: { label: "Speed", fallback: 1, kind: "any" },
};
export const keysOf = (clip, prop) => (clip.keys && clip.keys[prop]) || [];
export const hasKeys = (clip, prop) => keysOf(clip, prop).length > 0;
export const hasSpeedKeys = (clip) => hasKeys(clip, "speed") && kindOf(clip) !== "image";
export function prop(clip, name, tau) {
  const fallback = clip[name] ?? KEYABLE[name].fallback;
  return keyValue(keysOf(clip, name), tau, fallback);
}

export function speeds(clip) {
  if (hasSpeedKeys(clip)) { const k = K.sorted(keysOf(clip, "speed")); return [k[0].v, k[k.length - 1].v]; }
  const s = Math.max(0.01, Number(clip.speed) || 1);
  return [s, s];
}
export const isRamped = (clip) => hasSpeedKeys(clip);

export function clipDur(clip) {
  const length = Math.max(0, clip.out - clip.in);
  if (kindOf(clip) === "image") return length;
  if (hasSpeedKeys(clip)) return Math.max(0, clip.dur || 0);
  return length / speeds(clip)[0];
}
export const clipEnd = (clip) => clip.start + clipDur(clip);

export function srcTime(clip, tau) {
  if (kindOf(clip) === "image") return 0;
  if (hasSpeedKeys(clip)) return clip.in + keyIntegral(keysOf(clip, "speed"), tau);
  return clip.in + speeds(clip)[0] * tau;
}
export function speedAt(clip, tau) {
  return hasSpeedKeys(clip) ? keyValue(keysOf(clip, "speed"), tau) : speeds(clip)[0];
}
// Timeline time (from the clip start) at which the clip reaches a source time.
export function tauForSource(clip, src) {
  if (hasSpeedKeys(clip)) return K.solveIntegral(keysOf(clip, "speed"), src - clip.in);
  return (src - clip.in) / speeds(clip)[0];
}
// Keep a speed-keyed clip's source out point consistent with its curve and length, and inside the media.
export function syncSpeedOut(clip) {
  if (!hasSpeedKeys(clip)) return;
  const media = mediaOf(clip) || {};
  const total = media.duration || clip.out;
  clip.dur = Math.max(frameDur(), clip.dur || 0);
  let out = srcTime(clip, clip.dur);
  if (out > total + 1e-6) {
    clip.dur = Math.max(frameDur(), tauForSource(clip, total));
    out = total;
  }
  clip.out = Math.max(clip.in + 1e-4, out);
  for (const k of keysOf(clip, "speed")) k.v = Math.max(0, k.v);
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
  if (kindOf(clip) === "image") clip.in += tau;
  else clip.in = srcTime(clip, tau);
  cropAllKeys(clip, tau, d);
  if (hasSpeedKeys(clip)) clip.dur = d - tau;
  clip.start = newStart;
  clip.fadeIn = Math.min(clip.fadeIn || 0, clipDur(clip));
}

function trimEndTo(clip, newEnd) {
  const tau = newEnd - clip.start;
  if (kindOf(clip) === "image") clip.out = clip.in + tau;
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
                                 : { id: uid("a"), kind, name: "", mute: false, solo: false, locked: false, volume: 0, pan: 0 };
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
  const base = { mediaId: item.id, start, name: item.name, speed: 1, interp: "default", fadeIn: 0, fadeOut: 0, fadeInCurve: "linear", fadeOutCurve: "linear", parentId: null, keys: {} };
  const length = item.kind === "image" ? DEFAULT_STILL : Math.max(frameDur(), item.duration || 0);
  const linkId = item.kind === "video" && item.has_audio ? uid("l") : null;
  if (item.kind === "video" || item.kind === "image") {
    clips.push({ ...base, id: uid("c"), trackId: videoTrackId, in: 0, out: length, linkId,
                 opacity: 1, scale: 1, x: 0, y: 0, grade: defaultGrade() });
  }
  if (item.kind === "audio" || (item.kind === "video" && item.has_audio)) {
    clips.push({ ...base, id: uid("c"), trackId: audioTrackId, in: 0, out: length, linkId, volume: 0 });
  }
  return clips;
}

export function registerMedia(item) {
  P().media[item.id] = { ...(P().media[item.id] || {}), ...item };
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
  const clips = P().clips.filter(c => set.has(c.id) && kindOf(c) !== "image");
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
    p.in = clip.in; p.out = clip.out; p.speed = clip.speed;
    if (hasSpeedKeys(clip)) { p.keys = { ...(p.keys || {}), speed: JSON.parse(JSON.stringify(clip.keys.speed)) }; p.dur = clip.dur; }
    else { if (p.keys) delete p.keys.speed; delete p.dur; }
  }
}

// Replace a clip's speed curve (keys in multiplier units, t from the clip start). Keeps the clip length.
export function setSpeedKeys(clipId, keys, { keepLength = true } = {}) {
  const clip = getClip(clipId);
  if (!clip || kindOf(clip) === "image") return;
  const before = { start: clip.start, in: clip.in };
  const oldEnd = clipEnd(clip);
  const dur = clipDur(clip);
  clip.keys = clip.keys || {};
  if (!keys || !keys.length) {
    const s = clip.keys.speed?.length ? Math.max(0.01, keyValue(clip.keys.speed, 0)) : clip.speed;
    delete clip.keys.speed;
    delete clip.dur;
    clip.speed = s;
    clip.out = Math.min((mediaOf(clip) || {}).duration || Infinity, clip.in + s * dur);
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
  const kind = kindOf(clip);
  const item = mediaOf(clip) || {};
  const [s0] = speeds(clip);
  const free = !(P().magnetic && (clip.trackId === primaryId() || isPrimaryLinked(clip)));
  const neighbours = clipsOn(clip.trackId).filter(c => !groupIds.has(c.id));
  const minDur = frameDur();
  if (edge === "start") {
    let lo = kind === "image" || s0 <= 1e-6 ? -Infinity : clip.start - clip.in / s0;
    if (free) for (const n of neighbours) if (clipEnd(n) <= clip.start + EPS) lo = Math.max(lo, clipEnd(n));
    if (free) lo = Math.max(lo, 0);
    return [lo, clipEnd(clip) - minDur];
  }
  let hi = kind === "image" ? Infinity : clip.start + tauForSource(clip, item.duration || clip.out);
  if (free) for (const n of neighbours) if (n.start >= clipEnd(clip) - EPS) hi = Math.min(hi, n.start);
  return [clip.start + minDur, hi];
}

export function trimEdge(clipId, edge, time, { linked = true } = {}) {
  const clip = getClip(clipId);
  if (!clip) return;
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
// Times are seconds from the clip start; values are in stored units (dB, 0-1 opacity, multiplier scale/speed, pixels).

export function keyIndexAt(clip, name, tau, tol = null) {
  tol = tol ?? frameDur() / 2 + 1e-6;
  const ks = keysOf(clip, name);
  let best = -1, dist = Infinity;
  ks.forEach((k, i) => { const d = Math.abs(k.t - tau); if (d <= tol && d < dist) { best = i; dist = d; } });
  return best;
}

function plainKeys(clip, name) { return K.sorted(keysOf(clip, name)).map(k => ({ ...k })); }
function resetShape(ks, i) { for (const j of [i - 1, i]) if (ks[j]) delete ks[j].r; }

function storeKeys(clip, name, ks) {
  ks = K.sorted(ks);
  if (name === "speed") { setSpeedKeys(clip.id, ks); return; }
  clip.keys = clip.keys || {};
  if (ks.length) clip.keys[name] = ks;
  else delete clip.keys[name];
}

// Add a key (splitting the curve exactly) or change the value of the key at tau.
export function setKeyAt(clipId, name, tau, value) {
  const clip = getClip(clipId);
  if (!clip) return;
  tau = clamp(tau, 0, clipDur(clip));
  const ks = plainKeys(clip, name);
  let i = keyIndexAt(clip, name, tau);
  if (i >= 0) { ks[i].v = value; resetShape(ks, i); storeKeys(clip, name, ks); return; }
  if (!ks.length) { storeKeys(clip, name, [{ t: tau, v: value, ease: "linear" }]); return; }
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
  const sortedKs = K.sorted(ks);
  const at = sortedKs.indexOf(key);
  if (Math.abs(value - before) > 1e-9) { key.v = value; resetShape(sortedKs, at); }
  for (const k of sortedKs) if (k.r && Math.abs(k.r[0]) < 1e-9 && Math.abs(k.r[1] - 1) < 1e-9) delete k.r;
  storeKeys(clip, name, sortedKs);
}

export function removeKey(clipId, name, index) {
  const clip = getClip(clipId);
  if (!clip) return;
  const ks = plainKeys(clip, name);
  if (!ks[index]) return;
  const value = ks[index].v;
  ks.splice(index, 1);
  resetShape(ks, index);
  if (!ks.length && name !== "speed") clip[name] = value;
  storeKeys(clip, name, ks);
}

export function clearKeys(clipId, name, keepValue) {
  const clip = getClip(clipId);
  if (!clip) return;
  if (name !== "speed" && keepValue !== undefined) clip[name] = keepValue;
  storeKeys(clip, name, []);
}

export function setKeyEase(clipId, name, index, ease) {
  const clip = getClip(clipId);
  if (!clip) return;
  const ks = plainKeys(clip, name);
  if (!ks[index]) return;
  ks[index].ease = ease;
  delete ks[index].r;
  storeKeys(clip, name, ks);
}

// Move a key in time (between its neighbours) and/or value.
export function moveKey(clipId, name, index, tau, value) {
  const clip = getClip(clipId);
  if (!clip) return;
  const ks = plainKeys(clip, name);
  const k = ks[index];
  if (!k) return;
  const fd = frameDur() / 4;
  const lo = index > 0 ? ks[index - 1].t + fd : 0;
  const hi = index < ks.length - 1 ? ks[index + 1].t - fd : clipDur(clip);
  if (tau !== null && tau !== undefined) k.t = clamp(tau, Math.min(lo, hi), Math.max(lo, hi));
  if (value !== null && value !== undefined) k.v = value;
  resetShape(ks, index);
  storeKeys(clip, name, ks);
}

// Shift every key of a property by a value delta (dragging the line between keys, or with no keys the static value).
export function offsetKeys(clipId, name, indices, delta, limits) {
  const clip = getClip(clipId);
  if (!clip) return;
  const [lo, hi] = limits;
  const ks = plainKeys(clip, name);
  for (const i of indices) if (ks[i]) { ks[i].v = clamp(ks[i].v + delta, lo, hi); resetShape(ks, i); }
  storeKeys(clip, name, ks);
}

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
  const itemA = mediaOf(a) || {}, itemB = mediaOf(b) || {};
  const spareA = kindOf(a) === "image" ? Infinity : Math.max(0, tauForSource(a, itemA.duration || a.out) - clipDur(a));
  const [b0] = speeds(b);
  const spareB = kindOf(b) === "image" || b0 <= 1e-6 ? Infinity : b.in / b0;
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

export function normalizeProject(project) {
  const base = newProject(project.name || "Untitled");
  for (const key of Object.keys(base)) if (project[key] === undefined) project[key] = base[key];
  project.settings = { ...base.settings, ...project.settings };
  for (const tr of project.transitions) normalizeTransition(tr);
  for (const c of project.clips) {
    c.speed ??= 1; c.interp ??= "default"; c.fadeIn ??= 0; c.fadeOut ??= 0; c.parentId ??= null; c.linkId ??= null;
    c.fadeInCurve ??= "linear"; c.fadeOutCurve ??= "linear"; c.keys ??= {};
    // Older projects stored a linear ramp as speed -> rampTo; turn it into two speed keyframes.
    if (c.rampTo !== undefined && c.rampTo !== null && c.rampTo !== "" && Math.abs(Number(c.rampTo) - c.speed) > 1e-9 && project.media[c.mediaId]?.kind !== "image") {
      const s0 = Math.max(0.05, Number(c.speed) || 1), s1 = Math.max(0.05, Number(c.rampTo));
      const d = 2 * (c.out - c.in) / (s0 + s1);
      c.keys.speed = [{ t: 0, v: s0, ease: "linear" }, { t: d, v: s1, ease: "linear" }];
      c.dur = d;
    }
    delete c.rampTo;
    if (project.tracks.find(t => t.id === c.trackId)?.kind === "video") {
      c.opacity ??= 1; c.scale ??= 1; c.x ??= 0; c.y ??= 0; c.grade = { ...defaultGrade(), ...(c.grade || {}) };
    } else c.volume ??= 0;
  }
  return project;
}
