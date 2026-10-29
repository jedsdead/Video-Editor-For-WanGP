// Playback engine: master clock (with J/K/L shuttle), pooled <video>/<audio>/canvas sources kept in sync with the
// timeline, the Web Audio mixer graph and the per-frame render of the viewer.
//
// Audio graph per track:  clips -> input -> EQ low/mid/high -> compressor -> makeup -> fader(+automation, mute) -> pan -> master in
// Master:                 master in -> EQ -> compressor -> makeup -> master fader -> speakers (+ meters and LUFS)
// render.py applies the same EQ/compressor (via ffmpeg) and the same fader, automation and pan maths on export.
import { state, P, bus, levelAt, clipsOn, videoTracks, audioTracks, clipDur, srcTime, speedAt, fadeFactor, isRamped, transitionInfo,
         mediaOf, timelineEnd, getClip, audioTransitionGains, fps, clipWindow, prop, gradeAt, hasGradeKeys,
         trackGainDb, effectParamsAt, GENERATOR_KINDS, compoundOf, compoundAudioFades, trackKind } from "./model.js";
import { gradeUniforms } from "./grade.js";
import { isAudioTransition } from "./transitions.js";
import { drawTitle } from "./titles.js";
import { drawGenerator, effectPasses, EFFECTS } from "./effects.js";
const EFFECTS_KNOWN = new Set(Object.keys(EFFECTS));
import { ensureLut } from "./lut.js";
import { dbToGain, clamp } from "./util.js";
import { buildChain, PITCH_WORKLET } from "./audiofx.js";

const LOOKAHEAD = 2.5;

export class Playback {
  constructor(renderer, stage) {
    this.renderer = renderer;
    this.stage = stage;
    this.playing = false;
    this.rate = 1;
    this.time = 0;
    this.loop = false;
    this.scrubAudio = true;
    this.pool = new Map();
    this.dirty = true;
    this.ctx = null;
    this.strips = new Map();
    this.gradeCache = new WeakMap();
    this.pending = false;
    this.lastEmit = -1;
    this.onNeedReverse = null;
    this.loud = { blocks: [], ring: [], integratedBlocks: [] };
    bus.on("change", () => { this.dirty = true; });
    bus.on("project", () => { this.resetPool(); this.dirty = true; this.resetLoudness(); });
    bus.on("media-updated", (id) => this.dropMedia(id));
    // the WebGL context came back after the GPU was reset: every video element is rebuilt too (their decoders were
    // reset with it), then the frame is drawn again
    this.renderer.onRestore = () => { this.resetPool(); this.layout(); this.dirty = true; };
    new ResizeObserver(() => this.layout()).observe(stage);
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.pause(); });
    requestAnimationFrame((t) => this.tick(t));
  }

  // ---------------------------------------------------------------- viewer size
  layout() {
    if (!P()) return;
    const { width, height } = P().settings;
    const box = this.stage.getBoundingClientRect();
    if (!box.width || !box.height) return;
    // Fit (the default) or a fixed percentage of the project's resolution (100%: one picture pixel per screen pixel)
    const zoom = state.viewerZoom && state.viewerZoom !== "fit" ? parseFloat(state.viewerZoom) : 0;
    const scale = zoom ? zoom / (window.devicePixelRatio || 1) : Math.min(box.width / width, box.height / height);
    this.stage.classList.toggle("zoomed", !!zoom);
    const cssW = Math.max(16, Math.floor(width * scale)), cssH = Math.max(16, Math.floor(height * scale));
    if (zoom) {
      // centred while it fits, scrollable once it's bigger than the viewer
      this.renderer.canvas.style.marginTop = `${Math.max(0, (box.height - cssH) / 2)}px`;
    } else this.renderer.canvas.style.marginTop = "";
    const canvas = this.renderer.canvas;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pxW = Math.min(width, Math.round(cssW * dpr)), pxH = Math.min(height, Math.round(cssH * dpr));
    this.renderer.setSize(Math.max(2, pxW), Math.max(2, pxH));
    this.dirty = true;
    bus.emit("viewer-layout");
  }

  // ---------------------------------------------------------------- transport
  get end() { return timelineEnd(); }
  playRange() {
    const p = P();
    const start = p.inPoint ?? 0;
    const end = p.outPoint ?? this.end;
    return [start, Math.max(start, end)];
  }

  play(rate = 1) {
    this.ensureAudio();
    const [start, end] = this.playRange();
    if (rate > 0 && (this.time >= end - 1e-3 || (this.loop && (this.time < start || this.time >= end)))) this.time = start;
    if (rate < 0 && this.time <= 1e-3) return;
    this.rate = rate;
    this.wallStart = performance.now();
    this.timeStart = this.time;
    if (!this.playing) { this.playing = true; bus.emit("playstate", true); }
    bus.emit("rate", rate);
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.rate = 1;
    for (const entry of this.pool.values()) if (entry.el && entry.el.pause) entry.el.pause();
    this.time = Math.round(this.time * fps()) / fps();
    state.playhead = this.time;
    this.dirty = true;
    bus.emit("playstate", false);
    bus.emit("rate", 1);
    bus.emit("time", this.time);
  }
  toggle() { this.playing ? this.pause() : this.play(1); }
  // J/K/L: repeated presses double the speed in that direction (up to 8x).
  shuttle(direction) {
    if (direction === 0) { this.pause(); return; }
    let rate = direction;
    if (this.playing && Math.sign(this.rate) === direction) rate = clamp(this.rate * 2, -8, 8);
    this.play(rate);
  }

  seek(t, { snap = true } = {}) {
    if (!Number.isFinite(t)) return;
    t = Math.max(0, snap ? Math.round(t * fps()) / fps() : t);
    this.time = t;
    state.playhead = t;
    if (this.playing) { this.wallStart = performance.now(); this.timeStart = t; }
    this.dirty = true;
    bus.emit("time", t);
  }
  step(frames) { this.pause(); this.seek(this.time + frames / fps()); this.scrub(this.time); }

  // ---------------------------------------------------------------- audio graph
  ensureAudio() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: "interactive", sampleRate: 48000 });
      this.masterIn = this.ctx.createGain();
      this.masterFx = this.makeFx(this.masterIn);
      this.master = this.ctx.createGain();
      this.masterFx.out.connect(this.master);
      this.master.connect(this.ctx.destination);
      this.masterMeter = this.makeMeter(this.master);
      this.makeLoudnessMeter(this.master);
      for (const entry of this.pool.values()) if (entry.kind === "audio") this.connectAudio(entry);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  // EQ (low shelf, peaking, high shelf) and compressor with makeup gain, fed by `input`.
  makeFx(input) {
    const low = this.ctx.createBiquadFilter(); low.type = "lowshelf";
    const mid = this.ctx.createBiquadFilter(); mid.type = "peaking";
    const high = this.ctx.createBiquadFilter(); high.type = "highshelf";
    const comp = this.ctx.createDynamicsCompressor(); comp.knee.value = 6;
    const makeup = this.ctx.createGain();
    input.connect(low); low.connect(mid); mid.connect(high); high.connect(comp); comp.connect(makeup);
    return { low, mid, high, comp, makeup, out: makeup };
  }

  applyFx(fx, settings) {
    if (!fx || !settings) return;
    const now = this.ctx.currentTime;
    const eq = settings.eq || {}, comp = settings.comp || {};
    const on = !!eq.on;
    fx.low.frequency.setTargetAtTime(eq.low?.f || 120, now, 0.02);
    fx.low.gain.setTargetAtTime(on ? (eq.low?.g || 0) : 0, now, 0.02);
    fx.mid.frequency.setTargetAtTime(eq.mid?.f || 1000, now, 0.02);
    fx.mid.Q.setTargetAtTime(Math.max(0.1, eq.mid?.q || 1), now, 0.02);
    fx.mid.gain.setTargetAtTime(on ? (eq.mid?.g || 0) : 0, now, 0.02);
    fx.high.frequency.setTargetAtTime(eq.high?.f || 8000, now, 0.02);
    fx.high.gain.setTargetAtTime(on ? (eq.high?.g || 0) : 0, now, 0.02);
    const c = !!comp.on;
    fx.comp.threshold.setTargetAtTime(c ? clamp(comp.threshold ?? -18, -100, 0) : 0, now, 0.02);
    fx.comp.ratio.setTargetAtTime(c ? clamp(comp.ratio ?? 3, 1, 20) : 1, now, 0.02);
    fx.comp.attack.setTargetAtTime(clamp((comp.attack ?? 10) / 1000, 0, 1), now, 0.02);
    fx.comp.release.setTargetAtTime(clamp((comp.release ?? 150) / 1000, 0, 1), now, 0.02);
    // Web Audio's compressor adds its own makeup gain of 0.6 x the full-range gain reduction; cancel it so only the
    // user's makeup applies, as with ffmpeg's acompressor on export.
    const t = clamp(comp.threshold ?? -18, -100, 0), r = clamp(comp.ratio ?? 3, 1, 20);
    const autoMakeup = -0.6 * t * (1 - 1 / r);
    fx.makeup.gain.setTargetAtTime(c ? dbToGain((comp.makeup || 0) - autoMakeup) : 1, now, 0.02);
  }

  makeMeter(node) {
    const split = this.ctx.createChannelSplitter(2);
    node.connect(split);
    const analysers = [0, 1].map(i => {
      const a = this.ctx.createAnalyser();
      a.fftSize = 1024;
      split.connect(a, i);
      return a;
    });
    return { analysers, buf: new Float32Array(1024) };
  }

  // ITU-R BS.1770 K-weighting (shelf + high-pass) feeding per-channel analysers.
  makeLoudnessMeter(node) {
    const shelf = this.ctx.createBiquadFilter(); shelf.type = "highshelf"; shelf.frequency.value = 1681.97; shelf.gain.value = 4.0;
    const hp = this.ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 38.13; hp.Q.value = 0.5003;
    node.connect(shelf); shelf.connect(hp);
    const split = this.ctx.createChannelSplitter(2);
    hp.connect(split);
    this.loud.analysers = [0, 1].map(i => { const a = this.ctx.createAnalyser(); a.fftSize = 2048; split.connect(a, i); return a; });
    this.loud.buf = new Float32Array(2048);
  }

  resetLoudness() { this.loud.ring = []; this.loud.integratedBlocks = []; this.loud.lastBlock = 0; }

  measureLoudness(now) {
    const L = this.loud;
    if (!L.analysers || !this.playing || this.rate !== 1) return;
    let ms = 0;
    for (const a of L.analysers) {
      a.getFloatTimeDomainData(L.buf);
      let sum = 0;
      for (let i = 0; i < L.buf.length; i++) sum += L.buf[i] * L.buf[i];
      ms += sum / L.buf.length;
    }
    L.ring.push({ t: now, ms });
    while (L.ring.length && now - L.ring[0].t > 3000) L.ring.shift();
    if (now - (L.lastBlock || 0) >= 100) {   // a 400 ms gating block every 100 ms
      L.lastBlock = now;
      const block = this.meanLoudness(400, now);
      if (block !== null && block > -70) L.integratedBlocks.push(block);
    }
  }
  meanLoudness(windowMs, now) {
    const items = this.loud.ring.filter(r => now - r.t <= windowMs);
    if (!items.length) return null;
    const ms = items.reduce((s, r) => s + r.ms, 0) / items.length;
    return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity;
  }
  // {m: momentary, s: short-term, i: integrated} in LUFS (null when unavailable)
  loudness() {
    const now = performance.now();
    const blocks = this.loud.integratedBlocks;
    let integrated = null;
    if (blocks.length) {
      const energy = (list) => list.reduce((s, l) => s + Math.pow(10, (l + 0.691) / 10), 0) / list.length;
      const ungated = -0.691 + 10 * Math.log10(energy(blocks));
      const gated = blocks.filter(l => l > ungated - 10);
      if (gated.length) integrated = -0.691 + 10 * Math.log10(energy(gated));
    }
    const live = this.playing && this.rate === 1;
    return { m: live ? this.meanLoudness(400, now) : null, s: live ? this.meanLoudness(3000, now) : null, i: integrated };
  }

  strip(trackId) {
    let s = this.strips.get(trackId);
    if (!s && this.ctx) {
      const input = this.ctx.createGain();
      const fx = this.makeFx(input);
      const fader = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      fx.out.connect(fader);
      fader.connect(pan);
      pan.connect(this.masterIn);
      s = { input, fx, fader, pan, meter: this.makeMeter(pan) };
      this.strips.set(trackId, s);
    }
    return s;
  }

  connectAudio(entry) {
    if (!this.ctx || entry.node) return;
    try {
      entry.node = this.ctx.createMediaElementSource(entry.el);
      entry.gain = this.ctx.createGain();
      entry.gain.gain.value = 0;
      entry.node.connect(entry.gain);
    } catch (e) { console.warn("audio node", e); }
  }

  // The clip's audio effects between its source and its gain; rebuilt when they change.
  ensureAudioFx(entry, clip) {
    if (!this.ctx || !entry.node || !entry.gain) return;
    const list = (clip.afx || []).filter(f => f.on !== false);
    if (list.some(f => f.type === "pitch") && !this.pitchState) {
      this.pitchState = "loading";
      const url = URL.createObjectURL(new Blob([PITCH_WORKLET], { type: "application/javascript" }));
      this.ctx.audioWorklet.addModule(url).then(() => { this.pitchState = "ready"; for (const e of this.pool.values()) e.fxSig = null; })
        .catch((e) => { console.warn("pitch worklet", e); this.pitchState = "failed"; });
    }
    const sig = JSON.stringify(list) + (this.pitchState === "ready" ? "|p" : "");
    if (entry.fxSig === sig) return;
    entry.fxSig = sig;
    try { entry.node.disconnect(); } catch (_) { /* not connected */ }
    if (entry.chain) { try { entry.chain.output.disconnect(); } catch (_) { /* ignore */ } entry.chain = null; }
    if (!list.length) { entry.node.connect(entry.gain); return; }
    try {
      entry.chain = buildChain(this.ctx, list, { pitchReady: this.pitchState === "ready" });
      entry.node.connect(entry.chain.input);
      entry.chain.output.connect(entry.gain);
    } catch (e) { console.warn("audio effects", e); entry.node.connect(entry.gain); }
  }

  routeAudio(entry, trackId) {
    if (!entry.gain) return;
    if (entry.trackId === trackId) return;
    try { entry.gain.disconnect(); } catch (_) { /* not connected */ }
    const s = this.strip(trackId);
    if (s) entry.gain.connect(s.input);
    entry.trackId = trackId;
  }

  // levels in dBFS: {l, r}
  levels(trackId) {
    const meter = trackId === "master" ? this.masterMeter : this.strips.get(trackId)?.meter;
    if (!meter || !this.playing) return { l: -90, r: -90 };
    const out = meter.analysers.map(a => {
      a.getFloatTimeDomainData(meter.buf);
      let peak = 0;
      for (let i = 0; i < meter.buf.length; i++) peak = Math.max(peak, Math.abs(meter.buf[i]));
      return peak > 0 ? 20 * Math.log10(peak) : -90;
    });
    return { l: out[0], r: out[1] };
  }
  // gain reduction of a track's (or the master's) compressor, in dB (negative)
  reduction(trackId) {
    const fx = trackId === "master" ? this.masterFx : this.strips.get(trackId)?.fx;
    const r = fx?.comp?.reduction;
    return typeof r === "number" ? r : (r?.value ?? 0);
  }

  updateStrips() {
    if (!this.ctx) return;
    const tracks = audioTracks();
    const soloed = tracks.some(t => t.solo);
    const now = this.ctx.currentTime;
    for (const t of tracks) {
      const s = this.strip(t.id);
      const g = t.mute || (soloed && !t.solo) ? 0 : dbToGain(t.volume || 0) * dbToGain(trackGainDb(t, this.time));
      s.fader.gain.setTargetAtTime(g, now, 0.015);
      s.pan.pan.setTargetAtTime(clamp(t.pan || 0, -1, 1), now, 0.015);
      this.applyFx(s.fx, t.fx);
    }
    this.applyFx(this.masterFx, P().master?.fx);
    this.master.gain.setTargetAtTime(dbToGain(P().master?.volume || 0), now, 0.015);
  }

  // ---------------------------------------------------------------- element pool
  url(item, reversed) {
    if (item.kind === "image") return `api/media/${item.id}/original`;
    return reversed ? `api/media/${item.id}/proxy_rev` : `api/media/${item.id}/proxy`;
  }

  // Reversed clips play from a reversed proxy when it exists (smooth); until then the forward proxy is stepped.
  reversedReady(clip) {
    const item = mediaOf(clip);
    if (!clip.reverse || !item) return false;
    if (item.proxy_rev === "ready") return true;
    if (this.onNeedReverse && item.proxy_rev !== "pending" && item.proxy_rev !== "error") this.onNeedReverse(item);
    return false;
  }

  entryFor(clip, kind) {
    let entry = this.pool.get(clip.id);
    const item = mediaOf(clip);
    if (!item) return null;
    const rev = kind === "video" && this.reversedReady(clip);
    if (entry && (entry.mediaId !== clip.mediaId || entry.kind !== kind || entry.rev !== rev)) { this.dispose(clip.id); entry = null; }
    // a media element whose decoder failed (it happens after a GPU reset) never recovers by itself: rebuild it,
    // at most every 2 s so a file that really is broken doesn't thrash
    if (entry && entry.el.error && performance.now() - (entry.created || 0) > 2000) { this.dispose(clip.id); entry = null; }
    if (!entry) {
      let el;
      if (kind === "title" || kind === "solid" || kind === "gradient") el = document.createElement("canvas");
      else if (kind === "image") { el = new Image(); el.decoding = "async"; el.onload = () => { this.dirty = true; }; }
      else {
        el = document.createElement(kind === "audio" ? "audio" : "video");
        el.preload = "auto";
        el.playsInline = true;
        if (kind === "video") el.muted = true;
        el.addEventListener("seeked", () => { this.dirty = true; });
        el.addEventListener("loadeddata", () => { this.dirty = true; });
        el.addEventListener("error", () => { this.dirty = true; });
      }
      if (el.tagName !== "CANVAS") el.src = this.url(item, rev);
      entry = { el, kind, rev, mediaId: clip.mediaId, used: performance.now(), created: performance.now(), trackId: null };
      this.pool.set(clip.id, entry);
      if (kind === "audio") this.connectAudio(entry);
    }
    entry.used = performance.now();
    return entry;
  }

  dispose(clipId) {
    const entry = this.pool.get(clipId);
    if (!entry) return;
    try { entry.el.pause && entry.el.pause(); } catch (_) { /* ignore */ }
    try { entry.gain && entry.gain.disconnect(); entry.node && entry.node.disconnect(); } catch (_) { /* ignore */ }
    if (entry.el.tagName !== "CANVAS") {
      entry.el.removeAttribute("src");
      if (entry.el.load) try { entry.el.load(); } catch (_) { /* ignore */ }
    }
    this.pool.delete(clipId);
  }
  resetPool() { for (const id of [...this.pool.keys()]) this.dispose(id); }
  dropMedia(mediaId) { for (const [id, e] of [...this.pool]) if (e.mediaId === mediaId) this.dispose(id); this.dirty = true; }

  // Element time for a clip time: forward proxies use source time; reversed proxies run backwards from the end.
  elementTime(entry, clip, tau) {
    const item = mediaOf(clip);
    const src = srcTime(clip, tau);
    return entry.rev ? (item.duration || 0) - src : src;
  }

  syncElement(entry, clip, t, isAudio) {
    const el = entry.el;
    const item = mediaOf(clip);
    const tau = t - clip.start;
    const raw = this.elementTime(entry, clip, tau);
    const maxT = Math.max(0, (item.duration || 0) - 0.03);
    let desired = clamp(raw, 0, maxT);
    const speed = speedAt(clip, tau) * Math.abs(this.rate);
    // Elements can't play backwards or slower than 1/16: step by seeking instead (reverse shuttle, freezes, unprepared reverse).
    const stepping = this.rate < 0 || (clip.reverse && !entry.rev);
    const holding = raw < 0 || raw > maxT || speed < 0.07 || stepping;
    if (!this.playing || holding) {
      if (!el.paused) el.pause();
      // paused or stepping: aim at the middle of the source frame, never its edge, so the element can't land on the
      // frame before (a frame boundary a hair early shows the previous frame)
      const sf = item.fps || fps();
      if (sf > 0 && entry.kind === "video") desired = clamp((Math.floor(desired * sf + 0.02) + 0.5) / sf, 0, maxT);
      const tolerance = this.playing && !stepping && speed >= 0.07 ? 0.2 : 0.015;
      if (!el.seeking && Math.abs(el.currentTime - desired) > tolerance) el.currentTime = desired;
      return;
    }
    const rate = clamp(speed, 0.0625, 16);
    if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
    const ramped = isRamped(clip);
    if ("preservesPitch" in el && el.preservesPitch === ramped) el.preservesPitch = !ramped;
    if (el.paused) {
      if (Math.abs(el.currentTime - desired) > 0.03) el.currentTime = desired;
      el.play().catch(() => {});
    } else if (Math.abs(el.currentTime - desired) > (isAudio ? 0.12 : 0.3) * Math.max(1, Math.abs(this.rate))) {
      el.currentTime = desired;
    }
  }

  // ---------------------------------------------------------------- per frame
  // Geometry shared with render.py Compositor.place: crop fractions, rotation (clockwise degrees), centre offset.
  geometry(clip, kt, srcW, srcH) {
    const p = P();
    const canvas = this.renderer.canvas;
    const k = canvas.width / p.settings.width;
    const fit = Math.min(p.settings.width / srcW, p.settings.height / srcH) * Math.max(0, prop(clip, "scale", kt));
    // each axis can be stretched on its own (an anamorphic clip desqueezed, say)
    const w = srcW * fit * k * Math.max(0, prop(clip, "scaleX", kt)), h = srcH * fit * k * Math.max(0, prop(clip, "scaleY", kt));
    const cl = clamp(prop(clip, "cropL", kt), 0, 1), cr = clamp(prop(clip, "cropR", kt), 0, 1);
    const ct = clamp(prop(clip, "cropT", kt), 0, 1), cb = clamp(prop(clip, "cropB", kt), 0, 1);
    const rot = (prop(clip, "rotation", kt) || 0) * Math.PI / 180;
    const ox = (cl - cr) / 2 * w, oy = (ct - cb) / 2 * h;
    const cx = canvas.width / 2 + prop(clip, "x", kt) * k + ox * Math.cos(rot) - oy * Math.sin(rot);
    const cy = canvas.height / 2 + prop(clip, "y", kt) * k + ox * Math.sin(rot) + oy * Math.cos(rot);
    return { center: [cx, cy], size: [Math.max(0, w * (1 - cl - cr)), Math.max(0, h * (1 - ct - cb))], rotation: rot,
             uv: [cl, ct, 1 - cr, 1 - cb], full: [w, h], k };
  }

  // Effect passes for a clip at clip time kt, as a function of the buffer size (null when it has none).
  effectsFor(clip, kt, t) {
    const list = (clip.effects || []).filter(f => f.on !== false && EFFECTS_KNOWN.has(f.type));
    if (!list.length) return null;
    const frame = Math.round(t * fps());
    const resolved = list.map(f => [f.type, effectParamsAt(clip, f, kt)]);
    return (w, h) => resolved.flatMap(([type, params]) => effectPasses(type, params, w, h, frame));
  }

  gradeFor(clip, kt) {
    let gradeObj = clip.grade, grade;
    if (hasGradeKeys(clip)) { gradeObj = gradeAt(clip, kt); grade = gradeUniforms(gradeObj); }
    else {
      grade = this.gradeCache.get(clip.grade);
      if (grade === undefined) { grade = gradeUniforms(clip.grade); if (clip.grade) this.gradeCache.set(clip.grade, grade); }
    }
    let lut = null;
    if (gradeObj && gradeObj.lut && gradeObj.enabled !== false) {
      ensureLut(this.renderer, gradeObj.lut, () => { this.dirty = true; });
      lut = { name: gradeObj.lut, mix: clamp(gradeObj.lutMix ?? 1, 0, 1) };
    }
    return { grade, lut };
  }

  // Adjustment layer: grade and effects applied to everything below it.
  adjustFor(clip, t) {
    const d = clipDur(clip);
    const kt = clamp(t - clip.start, 0, d);
    const alpha = clamp(prop(clip, "opacity", kt), 0, 1) * fadeFactor(clip, kt, d);
    if (alpha <= 0) return null;
    return { type: "adjust", clip, alpha, ...this.gradeFor(clip, kt), effects: this.effectsFor(clip, kt, t) };
  }

  layerFor(clip, t) {
    const item = mediaOf(clip);
    if (!item || item.kind === "adjust") return null;
    const kind = item.kind === "image" || GENERATOR_KINDS.has(item.kind) ? item.kind : "video";
    const entry = this.entryFor(clip, kind);
    if (!entry) return null;
    if (kind === "video") this.syncElement(entry, clip, t, false);
    const p = P();
    if (kind === "title" || kind === "solid" || kind === "gradient") {
      const sig = JSON.stringify([kind, kind === "title" ? clip.title : clip.gen, p.settings.width, p.settings.height]);
      if (entry.sig !== sig) {
        if (kind === "title") drawTitle(entry.el, clip.title, p.settings.width, p.settings.height);
        else drawGenerator(entry.el, kind, clip.gen, p.settings.width, p.settings.height);
        entry.sig = sig;
      }
    }
    const projectSized = GENERATOR_KINDS.has(kind);
    const sw = projectSized ? p.settings.width : item.width || p.settings.width;
    const sh = projectSized ? p.settings.height : item.height || p.settings.height;
    const d = clipDur(clip);
    const kt = clamp(t - clip.start, 0, d);
    const geo = this.geometry(clip, kt, sw, sh);
    const alpha = clamp(prop(clip, "opacity", kt), 0, 1) * fadeFactor(clip, kt, d);
    return { type: "clip", clip, source: entry.el, center: geo.center, size: geo.size, rotation: geo.rotation, uv: geo.uv, full: geo.full, alpha,
             level: levelAt(clip, t - clip.start),
             ...this.gradeFor(clip, kt), effects: this.effectsFor(clip, kt, t), post: this.compoundPost(clip, t) };
  }

  // A compound clip's own grade, effects, opacity, fades and transform, applied on top of its clip's (null when it
  // has none of them).
  // The compound's placement on the frame (for the viewer's handles).
  compoundLayer(x, t) {
    const p = P();
    const kt = clamp(t - x.start, 0, clipDur(x));
    const geo = this.geometry(x, kt, p.settings.width, p.settings.height);
    return { type: "clip", clip: x, center: geo.center, size: geo.size, rotation: geo.rotation, uv: geo.uv, full: geo.full,
             alpha: clamp(prop(x, "opacity", kt), 0, 1) };
  }

  compoundPost(clip, t) {
    const x = compoundOf(clip);
    if (!x) return null;
    const d = clipDur(x);
    const kt = clamp(t - x.start, 0, d);
    const { grade, lut } = this.gradeFor(x, kt);
    const effects = this.effectsFor(x, kt, t);
    const alpha = clamp(prop(x, "opacity", kt), 0, 1) * fadeFactor(x, kt, d);
    const p = P();
    const geo = this.geometry(x, kt, p.settings.width, p.settings.height);
    const k = geo.k;
    const moved = Math.abs(geo.size[0] - p.settings.width * k) > 0.5 || Math.abs(geo.size[1] - p.settings.height * k) > 0.5 || Math.abs(geo.rotation) > 1e-6
      || Math.abs(geo.center[0] - this.renderer.canvas.width / 2) > 0.5 || Math.abs(geo.center[1] - this.renderer.canvas.height / 2) > 0.5;
    if (!grade && !lut && !effects && alpha >= 1 && !moved) return null;
    return { grade, lut, effects, alpha, center: geo.center, size: geo.size, rotation: geo.rotation, uv: geo.uv, full: geo.full };
  }

  buildFrame(t) {
    const entries = [];
    const needed = new Set();
    // which clip shows is decided at the middle of the frame containing t (as export does), so an edge a hair off the
    // frame grid can't show the clip that has just ended
    const tm = (Math.floor(t * fps() + 1e-6) + 0.5) / fps();
    for (const track of videoTracks()) {
      if (track.hidden) continue;
      const trs = P().transitions.filter(tr => tr.trackId === track.id && !isAudioTransition(tr.type));
      let active = null;
      for (const tr of trs) {
        const info = transitionInfo(tr);
        if (info && tm >= info.lo && tm < info.hi) { active = { tr, info }; break; }
      }
      if (active) {
        const { tr, info } = active;
        needed.add(info.a.id); needed.add(info.b.id);
        const a = this.layerFor(info.a, t), b = this.layerFor(info.b, t);
        entries.push({ type: "transition", tr, p: (t - info.lo) / tr.duration, a, b });
        continue;
      }
      for (const clip of clipsOn(track.id)) {
        if (clip.start <= tm && tm < clip.start + clipDur(clip)) {
          needed.add(clip.id);
          if (mediaOf(clip)?.kind === "adjust") { const adj = this.adjustFor(clip, t); if (adj) entries.push(adj); continue; }
          const layer = this.layerFor(clip, t);
          if (layer) entries.push(layer);
        }
      }
    }
    this.lastLayers = entries;
    return { entries, needed };
  }

  clipGain(clip, t) {
    const d = clipDur(clip);
    const tau = t - clip.start;
    let g = dbToGain(prop(clip, "volume", clamp(tau, 0, d))) * fadeFactor(clip, clamp(tau, 0, d), d);
    for (const tr of P().transitions) {
      if (!isAudioTransition(tr.type) || (tr.a !== clip.id && tr.b !== clip.id)) continue;
      const info = transitionInfo(tr);
      if (!info || t < info.lo || t >= info.hi) continue;
      const [ga, gb] = audioTransitionGains(tr.type, (t - info.lo) / tr.duration);
      g *= tr.a === clip.id ? ga : gb;
    }
    if (speedAt(clip, clamp(tau, 0, d)) < 0.1) g *= clamp(speedAt(clip, clamp(tau, 0, d)) / 0.1, 0, 1);
    // a compound clip's own volume and audio fades, on top of the clip's
    const x = compoundOf(clip);
    if (x && trackKind(clip.trackId) === "audio") {
      const dx = clipDur(x), kx = clamp(t - x.start, 0, dx);
      g *= dbToGain(prop(x, "volume", kx)) * fadeFactor(compoundAudioFades(x), kx, dx);
    }
    return g;
  }

  syncAudio(t, needed) {
    for (const track of audioTracks()) {
      for (const clip of clipsOn(track.id)) {
        const item = mediaOf(clip);
        if (!item || !(item.has_audio || item.kind === "audio")) continue;
        const [w0, w1] = clipWindow(clip);
        const active = t >= w0 && t < w1;
        const soon = this.playing && this.rate > 0 && w0 > t && w0 - t < LOOKAHEAD;
        if (!active && !soon) continue;
        needed.add(clip.id);
        const entry = this.entryFor(clip, "audio");
        if (!entry) continue;
        if (this.ctx) { this.routeAudio(entry, track.id); this.ensureAudioFx(entry, clip); }
        if (!active) { this.preload(entry, clip); continue; }
        if (!this.scrubbing) this.syncElement(entry, clip, t, true);
        if (entry.gain && !this.scrubbing) {
          const audible = this.playing && this.rate > 0;
          entry.gain.gain.setTargetAtTime(audible ? this.clipGain(clip, t) : 0, this.ctx.currentTime, 0.008);
        }
      }
    }
  }

  // Play a short burst of audio at t while scrubbing or stepping.
  scrub(t) {
    if (!this.scrubAudio || this.playing || !P()) return;
    const now = performance.now();
    if (now - (this.lastScrub || 0) < 45) return;
    this.lastScrub = now;
    this.ensureAudio();
    clearTimeout(this.scrubTimer);
    this.scrubbing = true;
    for (const track of audioTracks()) {
      for (const clip of clipsOn(track.id)) {
        const item = mediaOf(clip);
        if (!item || !(item.has_audio || item.kind === "audio")) continue;
        if (t < clip.start || t >= clip.start + clipDur(clip)) continue;
        const entry = this.entryFor(clip, "audio");
        if (!entry || !entry.gain) continue;
        this.routeAudio(entry, track.id);
        this.ensureAudioFx(entry, clip);
        const el = entry.el;
        const target = clamp(this.elementTime(entry, clip, t - clip.start), 0, Math.max(0, (item.duration || 0) - 0.1));
        if (Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
        el.playbackRate = 1;
        entry.gain.gain.setTargetAtTime(this.clipGain(clip, t), this.ctx.currentTime, 0.005);
        el.play().catch(() => {});
      }
    }
    this.updateStrips();
    this.scrubTimer = setTimeout(() => {
      for (const entry of this.pool.values()) {
        if (entry.kind !== "audio") continue;
        if (entry.gain) entry.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.005);
        setTimeout(() => { if (!this.playing) entry.el.pause(); }, 20);
      }
      this.scrubbing = false;
    }, 90);
  }

  // (A warm start, crawling the next clip at 1/16 speed just before its cut, was tried and made joins jump in
  // playback; the next clip waits paused on its in-point.)
  preload(entry, clip) {
    const el = entry.el;
    const target = clamp(this.elementTime(entry, clip, 0), 0, Math.max(0, (mediaOf(clip).duration || 0) - 0.03));
    if (!el.paused) el.pause();
    if (!el.seeking && Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
  }

  preloadVideo(t, needed) {
    if (!this.playing || this.rate < 0) return;
    for (const track of videoTracks()) {
      if (track.hidden) continue;
      for (const clip of clipsOn(track.id)) {
        const [w0] = clipWindow(clip);
        if (w0 > t && w0 - t < LOOKAHEAD && !needed.has(clip.id)) {
          const item = mediaOf(clip);
          if (!item || item.kind === "audio" || GENERATOR_KINDS.has(item.kind)) continue;
          const entry = this.entryFor(clip, item.kind === "image" ? "image" : "video");
          if (entry && item.kind !== "image") this.preload(entry, clip);
          needed.add(clip.id);
        }
      }
    }
  }

  tick(now) {
    requestAnimationFrame((t) => this.tick(t));
    if (!P()) return;
    if (this.playing && window.innerWidth === 0) this.pause();
    if (this.playing) {
      let t = this.timeStart + this.rate * (now - this.wallStart) / 1000;
      const [start, end] = this.playRange();
      if (this.rate > 0 && t >= end) {
        if (this.loop && end > start) { t = start; this.wallStart = now; this.timeStart = start; }
        else { this.time = end; state.playhead = end; this.pause(); return; }
      }
      if (this.rate < 0 && t <= 0) { this.time = 0; state.playhead = 0; this.pause(); return; }
      this.time = t;
      state.playhead = t;
    }
    const t = this.time;
    if (!this.playing && !this.dirty && !this.pending && !this.scrubbing) return;
    const { entries, needed } = this.buildFrame(t);
    this.preloadVideo(t, needed);
    this.syncAudio(t, needed);
    this.updateStrips();
    this.measureLoudness(now);
    const complete = this.renderer.render(entries);
    this.pending = !complete;
    this.dirty = false;
    for (const [id, entry] of this.pool) {
      if (needed.has(id)) continue;
      if (entry.el.pause && !entry.el.paused && !this.scrubbing) entry.el.pause();
      if (entry.gain && this.ctx && !this.scrubbing) entry.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
      if (!getClip(id) || now - entry.used > 8000) this.dispose(id);
    }
    if (this.playing || this.lastEmit !== t) { this.lastEmit = t; bus.emit("time", t); }
    bus.emit("rendered");
  }
}
