// Playback engine: master clock, pooled <video>/<audio> elements kept in sync with the timeline,
// the Web Audio mixer graph (clip gain -> track strip -> master) and the per-frame render of the viewer.
import { state, P, bus, clipsOn, videoTracks, audioTracks, clipDur, srcTime, speedAt, fadeFactor, isRamped, transitionInfo,
         kindOf, mediaOf, timelineEnd, getClip, audioTransitionGains, fps, clipWindow, trackKind } from "./model.js";
import { gradeUniforms } from "./grade.js";
import { isAudioTransition } from "./transitions.js";
import { dbToGain, clamp } from "./util.js";

const LOOKAHEAD = 2.5;

export class Playback {
  constructor(renderer, stage) {
    this.renderer = renderer;
    this.stage = stage;
    this.playing = false;
    this.time = 0;
    this.loop = false;
    this.pool = new Map();
    this.dirty = true;
    this.ctx = null;
    this.strips = new Map();
    this.gradeCache = new WeakMap();
    this.pending = false;
    this.lastEmit = -1;
    bus.on("change", () => { this.dirty = true; });
    bus.on("project", () => { this.resetPool(); this.dirty = true; });
    bus.on("media-updated", (id) => this.dropMedia(id));
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
    const scale = Math.min(box.width / width, box.height / height);
    const cssW = Math.max(16, Math.floor(width * scale)), cssH = Math.max(16, Math.floor(height * scale));
    const canvas = this.renderer.canvas;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pxW = Math.min(width, Math.round(cssW * dpr)), pxH = Math.min(height, Math.round(cssH * dpr));
    this.renderer.setSize(Math.max(2, pxW), Math.max(2, pxH));
    this.dirty = true;
  }

  // ---------------------------------------------------------------- transport
  get end() { return timelineEnd(); }
  playRange() {
    const p = P();
    const start = p.inPoint ?? 0;
    const end = p.outPoint ?? this.end;
    return [start, Math.max(start, end)];
  }

  play() {
    if (this.playing) return;
    this.ensureAudio();
    const [start, end] = this.playRange();
    if (this.time >= end - 1e-3 || (this.loop && (this.time < start || this.time >= end))) this.time = start;
    this.playing = true;
    this.wallStart = performance.now();
    this.timeStart = this.time;
    bus.emit("playstate", true);
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const entry of this.pool.values()) if (entry.el && entry.el.pause) entry.el.pause();
    this.time = Math.round(this.time * fps()) / fps();
    state.playhead = this.time;
    this.dirty = true;
    bus.emit("playstate", false);
    bus.emit("time", this.time);
  }
  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t, { snap = true } = {}) {
    if (!Number.isFinite(t)) return;
    t = Math.max(0, snap ? Math.round(t * fps()) / fps() : t);
    this.time = t;
    state.playhead = t;
    if (this.playing) { this.wallStart = performance.now(); this.timeStart = t; }
    this.dirty = true;
    bus.emit("time", t);
  }
  step(frames) { this.pause(); this.seek(this.time + frames / fps()); }

  // ---------------------------------------------------------------- audio graph
  ensureAudio() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: "interactive", sampleRate: 48000 });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.masterMeter = this.makeMeter(this.master);
      for (const entry of this.pool.values()) if (entry.kind === "audio") this.connectAudio(entry);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
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

  strip(trackId) {
    let s = this.strips.get(trackId);
    if (!s && this.ctx) {
      const input = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      input.connect(pan);
      pan.connect(this.master);
      s = { input, pan, meter: this.makeMeter(pan) };
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

  updateStrips() {
    if (!this.ctx) return;
    const tracks = audioTracks();
    const soloed = tracks.some(t => t.solo);
    const now = this.ctx.currentTime;
    for (const t of tracks) {
      const s = this.strip(t.id);
      const g = t.mute || (soloed && !t.solo) ? 0 : dbToGain(t.volume || 0);
      s.input.gain.setTargetAtTime(g, now, 0.015);
      s.pan.pan.setTargetAtTime(clamp(t.pan || 0, -1, 1), now, 0.015);
    }
    this.master.gain.setTargetAtTime(dbToGain(P().master?.volume || 0), now, 0.015);
  }

  // ---------------------------------------------------------------- element pool
  url(item) {
    if (item.kind === "image") return `api/media/${item.id}/original`;
    return `api/media/${item.id}/proxy`;
  }

  entryFor(clip, kind) {
    let entry = this.pool.get(clip.id);
    const item = mediaOf(clip);
    if (!item) return null;
    if (entry && entry.mediaId !== clip.mediaId) { this.dispose(clip.id); entry = null; }
    if (!entry) {
      let el;
      if (kind === "image") { el = new Image(); el.decoding = "async"; el.onload = () => { this.dirty = true; }; }
      else {
        el = document.createElement(kind === "audio" ? "audio" : "video");
        el.preload = "auto";
        el.playsInline = true;
        if (kind === "video") el.muted = true;
        el.addEventListener("seeked", () => { this.dirty = true; });
        el.addEventListener("loadeddata", () => { this.dirty = true; });
      }
      el.src = this.url(item);
      entry = { el, kind, mediaId: clip.mediaId, proxy: item.proxy, used: performance.now(), trackId: null };
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
    entry.el.removeAttribute("src");
    if (entry.el.load) try { entry.el.load(); } catch (_) { /* ignore */ }
    this.pool.delete(clipId);
  }
  resetPool() { for (const id of [...this.pool.keys()]) this.dispose(id); }
  dropMedia(mediaId) { for (const [id, e] of [...this.pool]) if (e.mediaId === mediaId) this.dispose(id); this.dirty = true; }

  syncElement(entry, clip, t, isAudio) {
    const el = entry.el;
    const item = mediaOf(clip);
    const tau = t - clip.start;
    const raw = srcTime(clip, tau);
    const maxT = Math.max(0, (item.duration || 0) - 0.03);
    const desired = clamp(raw, 0, maxT);
    const holding = raw < 0 || raw > maxT;
    if (!this.playing || holding) {
      if (!el.paused) el.pause();
      if (!el.seeking && Math.abs(el.currentTime - desired) > (this.playing ? 0.2 : 0.015)) el.currentTime = desired;
      return;
    }
    const rate = clamp(speedAt(clip, tau), 0.0625, 16);
    if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
    const ramped = isRamped(clip);
    if ("preservesPitch" in el && el.preservesPitch === ramped) el.preservesPitch = !ramped;
    if (el.paused) {
      if (Math.abs(el.currentTime - desired) > 0.03) el.currentTime = desired;
      el.play().catch(() => {});
    } else if (Math.abs(el.currentTime - desired) > (isAudio ? 0.12 : 0.3)) {
      el.currentTime = desired;
    }
  }

  // ---------------------------------------------------------------- per frame
  layerFor(clip, t) {
    const item = mediaOf(clip);
    if (!item) return null;
    const kind = item.kind === "image" ? "image" : "video";
    const entry = this.entryFor(clip, kind);
    if (!entry) return null;
    if (kind === "video") this.syncElement(entry, clip, t, false);
    const p = P();
    const canvas = this.renderer.canvas;
    const k = canvas.width / p.settings.width;
    const sw = item.width || p.settings.width, sh = item.height || p.settings.height;
    const fit = Math.min(p.settings.width / sw, p.settings.height / sh) * (clip.scale ?? 1);
    const w = sw * fit * k, h = sh * fit * k;
    const x = canvas.width / 2 + (clip.x || 0) * k - w / 2;
    const y = canvas.height / 2 + (clip.y || 0) * k - h / 2;
    const d = clipDur(clip);
    const tau = t - clip.start;
    const alpha = (clip.opacity ?? 1) * fadeFactor(clip, clamp(tau, 0, d), d);
    let grade = this.gradeCache.get(clip.grade);
    if (grade === undefined) { grade = gradeUniforms(clip.grade); if (clip.grade) this.gradeCache.set(clip.grade, grade); }
    return { type: "clip", source: entry.el, rect: [x, y, w, h], alpha, grade };
  }

  buildFrame(t) {
    const entries = [];
    const needed = new Set();
    for (const track of videoTracks()) {
      if (track.hidden) continue;
      const trs = P().transitions.filter(tr => tr.trackId === track.id && !isAudioTransition(tr.type));
      let active = null;
      for (const tr of trs) {
        const info = transitionInfo(tr);
        if (info && t >= info.lo && t < info.hi) { active = { tr, info }; break; }
      }
      if (active) {
        const { tr, info } = active;
        needed.add(info.a.id); needed.add(info.b.id);
        const a = this.layerFor(info.a, t), b = this.layerFor(info.b, t);
        entries.push({ type: "transition", tr, p: (t - info.lo) / tr.duration, a, b });
        continue;
      }
      for (const clip of clipsOn(track.id)) {
        if (clip.start <= t && t < clip.start + clipDur(clip)) {
          needed.add(clip.id);
          const layer = this.layerFor(clip, t);
          if (layer) entries.push(layer);
        }
      }
    }
    return { entries, needed };
  }

  syncAudio(t, needed) {
    const soloTracks = audioTracks();
    const transitions = P().transitions.filter(tr => isAudioTransition(tr.type));
    for (const track of soloTracks) {
      for (const clip of clipsOn(track.id)) {
        const item = mediaOf(clip);
        if (!item || !(item.has_audio || item.kind === "audio")) continue;
        const [w0, w1] = clipWindow(clip);
        const active = t >= w0 && t < w1;
        const soon = this.playing && w0 > t && w0 - t < LOOKAHEAD;
        if (!active && !soon) continue;
        needed.add(clip.id);
        const entry = this.entryFor(clip, "audio");
        if (!entry) continue;
        if (this.ctx) this.routeAudio(entry, track.id);
        if (!active) { this.preload(entry, clip); continue; }
        this.syncElement(entry, clip, t, true);
        if (entry.gain) {
          const d = clipDur(clip);
          const tau = t - clip.start;
          let g = dbToGain(clip.volume || 0) * fadeFactor(clip, clamp(tau, 0, d), d);
          for (const tr of transitions) {
            if (tr.a !== clip.id && tr.b !== clip.id) continue;
            const info = transitionInfo(tr);
            if (!info || t < info.lo || t >= info.hi) continue;
            const [ga, gb] = audioTransitionGains(tr.type, (t - info.lo) / tr.duration);
            g *= tr.a === clip.id ? ga : gb;
          }
          entry.gain.gain.setTargetAtTime(this.playing ? g : 0, this.ctx.currentTime, 0.008);
        }
      }
    }
  }

  preload(entry, clip) {
    const el = entry.el;
    if (!el.paused) el.pause();
    const target = clamp(srcTime(clip, 0), 0, Math.max(0, (mediaOf(clip).duration || 0) - 0.03));
    if (!el.seeking && Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
  }

  preloadVideo(t, needed) {
    if (!this.playing) return;
    for (const track of videoTracks()) {
      if (track.hidden) continue;
      for (const clip of clipsOn(track.id)) {
        const [w0] = clipWindow(clip);
        if (w0 > t && w0 - t < LOOKAHEAD && !needed.has(clip.id)) {
          const item = mediaOf(clip);
          if (!item || item.kind === "audio") continue;
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
      let t = this.timeStart + (now - this.wallStart) / 1000;
      const [start, end] = this.playRange();
      if (t >= end) {
        if (this.loop && end > start) { t = start; this.wallStart = now; this.timeStart = start; }
        else { this.time = end; state.playhead = end; this.pause(); return; }
      }
      this.time = t;
      state.playhead = t;
    }
    const t = this.time;
    if (!this.playing && !this.dirty && !this.pending) return;
    const { entries, needed } = this.buildFrame(t);
    this.preloadVideo(t, needed);
    this.syncAudio(t, needed);
    this.updateStrips();
    const complete = this.renderer.render(entries);
    this.pending = !complete;
    this.dirty = false;
    for (const [id, entry] of this.pool) {
      if (needed.has(id)) continue;
      if (entry.el.pause && !entry.el.paused) entry.el.pause();
      if (entry.gain && this.ctx) entry.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
      if (!getClip(id) || now - entry.used > 8000) this.dispose(id);
    }
    if (this.playing || this.lastEmit !== t) { this.lastEmit = t; bus.emit("time", t); }
    bus.emit("rendered");
  }
}
