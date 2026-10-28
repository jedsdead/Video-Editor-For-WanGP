// Canvas timeline: drawing, hit testing and all pointer interactions (select, move, trim, fades, blade, range,
// marquee, transitions, scrubbing, drag-and-drop from the media bin).
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { clamp, dbToGain, gainToDb, el, showMenu, timecode } from "./util.js";
import { curve } from "./keys.js";
import { transitionLabel, isAudioTransition } from "./transitions.js";
import { isNeutral } from "./grade.js";

const RULER_H = 28, VIDEO_H = 64, AUDIO_H = 52, GAP_H = 8, EDGE = 7, SNAP_PX = 9;
const COLORS = { video: "#34588f", videoHead: "#284774", image: "#5f4489", imageHead: "#4b356d", title: "#8a5a2c", titleHead: "#6d4520", gen: "#4a4f5c", genHead: "#3a3e48", adjust: "#5a4a6e", adjustHead: "#463a57", audio: "#2c6a4c", audioHead: "#215239",
                 wave: "rgba(170,240,200,.85)", sel: "#ffcc4d", trans: "rgba(201,141,44,.85)", playhead: "#ff4d4d", snap: "#ffe14d" };

export class Timeline {
  constructor({ canvas, wrap, headers, headersInner, scrollbar, scrollInner, playback, onImportFiles, onContextAction }) {
    Object.assign(this, { canvas, wrap, headers, headersInner, scrollbar, scrollInner, playback, onImportFiles, onContextAction });
    this.pps = 60;
    this.scrollX = 0;
    this.scrollY = 0;
    this.width = 0;
    this.height = 0;
    this.pendingFit = true;
    this.drag = null;
    this.hover = null;
    this.snapLine = null;
    this.ghost = null;
    this.marquee = null;
    this.thumbs = new Map();
    this.waves = new Map();
    this.ctx = canvas.getContext("2d");
    this.rulerLabelEl = el("div.ruler-spacer");
    headers.append(this.rulerLabelEl);
    this.queued = false;
    new ResizeObserver(() => this.resize()).observe(wrap);
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e));
    canvas.addEventListener("pointerleave", () => { if (!this.drag) { this.hover = null; this.draw(); } });
    canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    canvas.addEventListener("contextmenu", (e) => this.context(e));
    canvas.addEventListener("dblclick", (e) => this.dblclick(e));
    canvas.addEventListener("dragover", (e) => this.dragOver(e));
    canvas.addEventListener("dragleave", () => { this.ghost = null; this.draw(); });
    canvas.addEventListener("drop", (e) => this.drop(e));
    scrollbar.addEventListener("scroll", () => { if (Math.abs(scrollbar.scrollLeft - this.scrollX) > 0.5) { this.scrollX = scrollbar.scrollLeft; this.draw(); } });
    for (const name of ["change", "selection", "tracks", "project", "media-updated", "range"]) bus.on(name, () => { this.renderHeaders(); this.draw(); });
    bus.on("time", (t) => { this.follow(t); this.draw(); });
  }

  // ---------------------------------------------------------------- geometry
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.wrap.getBoundingClientRect();
    this.width = r.width; this.height = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    if (this.pendingFit && this.width > 80) this.zoomToFit();
    this.renderHeaders();
    this.draw();
  }

  rows() {
    const rows = [];
    let y = 0;
    for (const track of M.videoTracks().slice().reverse()) { rows.push({ track, kind: "video", y, h: VIDEO_H }); y += VIDEO_H; }
    y += GAP_H;
    for (const track of M.audioTracks()) { rows.push({ track, kind: "audio", y, h: AUDIO_H }); y += AUDIO_H; }
    this.contentHeight = y;
    return rows;
  }
  rowY(row) { return RULER_H + row.y - this.scrollY; }
  rowAt(y) {
    const cy = y - RULER_H + this.scrollY;
    return this.rows().find(r => cy >= r.y && cy < r.y + r.h) || null;
  }
  nearestRow(y, kind) {
    const rows = this.rows().filter(r => !kind || r.kind === kind);
    const cy = y - RULER_H + this.scrollY;
    let best = rows[0], dist = Infinity;
    for (const r of rows) { const d = Math.abs(cy - (r.y + r.h / 2)); if (d < dist) { dist = d; best = r; } }
    return best;
  }
  x(t) { return t * this.pps - this.scrollX; }
  t(x) { const v = (x + this.scrollX) / this.pps; return Number.isFinite(v) ? v : 0; }

  setZoom(pps, anchorX = null) {
    if (!Number.isFinite(pps) || pps <= 0) return;
    pps = clamp(pps, 1, 12000);
    const ax = anchorX ?? this.x(state.playhead);
    const at = this.t(ax);
    this.pps = pps;
    this.scrollX = Number.isFinite(at) ? Math.max(0, at * pps - ax) : 0;
    this.syncScrollbar();
    bus.emit("zoom", pps);
    this.draw();
  }
  zoomToFit() {
    // The editor tab may still be hidden (zero width); fit as soon as it gets a real size.
    if (!(this.width > 80) || !P()) { this.pendingFit = true; return; }
    this.pendingFit = false;
    const end = Math.max(5, M.timelineEnd());
    this.pps = clamp((this.width - 40) / end, 1, 12000);
    this.scrollX = 0;
    this.syncScrollbar();
    bus.emit("zoom", this.pps);
    this.draw();
  }
  syncScrollbar() {
    const total = Math.max(this.width + 200, (M.timelineEnd() + 30) * this.pps);
    this.scrollInner.style.width = `${total}px`;
    if (Math.abs(this.scrollbar.scrollLeft - this.scrollX) > 0.5) this.scrollbar.scrollLeft = this.scrollX;
  }
  follow(t) {
    if (!this.playback.playing || this.drag) return;
    const x = this.x(t);
    if (x > this.width - 30 || x < 0) { this.scrollX = Math.max(0, t * this.pps - 40); this.syncScrollbar(); }
  }

  // ---------------------------------------------------------------- media caches
  thumbImage(item) {
    if (item.thumbs !== "ready") return null;
    let img = this.thumbs.get(item.id);
    if (!img) {
      img = new Image();
      img.onload = () => this.draw();
      img.src = `api/media/${item.id}/thumbs`;
      this.thumbs.set(item.id, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }
  wave(item) {
    if (item.wave !== "ready") return null;
    const cached = this.waves.get(item.id);
    if (cached === undefined) {
      this.waves.set(item.id, null);
      fetch(`api/media/${item.id}/wave`).then(r => r.json()).then(data => { this.waves.set(item.id, data); this.draw(); }).catch(() => {});
      return null;
    }
    return cached;
  }

  // ---------------------------------------------------------------- headers
  renderHeaders() {
    if (!P()) return;
    const inner = this.headersInner;
    inner.innerHTML = "";
    inner.style.transform = `translateY(${-this.scrollY}px)`;
    const pid = M.primaryId();
    for (const row of this.rows()) {
      const t = row.track;
      const label = M.trackLabel(t);
      const toggle = (key, title, text, cls = "") => el(`button${t[key] ? ".on" : ""}${cls ? "." + cls : ""}`, { title,
        onclick: () => M.edit(`Toggle ${key}`, () => { t[key] = !t[key]; }) }, text);
      const head = el(`div.track-header${t.id === pid && P().magnetic ? ".primary" : ""}`, { style: { top: `${RULER_H + row.y}px`, height: `${row.h}px` } },
        el(`span.tname.${row.kind}`, { title: t.id === pid && P().magnetic ? "Primary storyline (magnetic)" : "" }, label),
        el("input.tlabel", { value: t.name || "", placeholder: row.kind === "video" ? "Video" : "Audio", title: "Track name",
          onchange: (e) => M.edit("Rename track", () => { t.name = e.target.value; }) }),
        row.kind === "video" ? toggle("hidden", "Hide this track in the viewer and export", "H") : toggle("mute", "Mute", "M", "mute"),
        row.kind === "audio" ? toggle("solo", "Solo", "S", "solo") : null,
        row.kind === "audio" ? toggle("showAuto", "Show this track's volume automation (keyframes across the whole track)", "A") : null,
        toggle("locked", "Lock (prevent edits)", "L"),
        el("button.del", { title: "Delete track", onclick: () => M.edit("Delete track", () => M.removeTrack(t.id)) }, "✕"));
      inner.append(head);
    }
    this.headersInner.style.height = `${RULER_H + this.contentHeight}px`;
  }

  // ---------------------------------------------------------------- drawing
  draw() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.paint(); });
  }

  paint() {
    if (!P() || !this.width) return;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#16171b";
    ctx.fillRect(0, 0, this.width, this.height);
    const rows = this.rows();
    const maxScrollY = Math.max(0, this.contentHeight + RULER_H - this.height + 10);
    if (this.scrollY > maxScrollY) { this.scrollY = maxScrollY; this.headersInner.style.transform = `translateY(${-this.scrollY}px)`; }
    const p = P();
    const t0 = this.t(0), t1 = this.t(this.width);

    // rows
    for (const row of rows) {
      const y = this.rowY(row);
      if (y > this.height || y + row.h < RULER_H) continue;
      ctx.fillStyle = row.kind === "video" ? "#1b1d24" : "#1a1e1c";
      ctx.fillRect(0, y, this.width, row.h - 1);
      ctx.fillStyle = "#24262d";
      ctx.fillRect(0, y + row.h - 1, this.width, 1);
      if (row.track.locked) { ctx.fillStyle = "rgba(255,255,255,.03)"; for (let x = -row.h; x < this.width; x += 14) { ctx.save(); ctx.beginPath(); ctx.rect(0, y, this.width, row.h); ctx.clip(); ctx.fillRect(x, y, 6, row.h); ctx.restore(); } }
    }
    // in/out shading
    if (p.inPoint !== null || p.outPoint !== null) {
      const a = p.inPoint ?? 0, b = p.outPoint ?? M.timelineEnd();
      ctx.fillStyle = "rgba(79,140,255,.07)";
      ctx.fillRect(this.x(a), RULER_H, this.x(b) - this.x(a), this.height);
    }
    // range selection
    if (state.range) {
      const r = state.range;
      for (const row of rows) if (r.trackIds.includes(row.track.id)) {
        ctx.fillStyle = "rgba(79,140,255,.22)";
        ctx.fillRect(this.x(r.start), this.rowY(row), this.x(r.end) - this.x(r.start), row.h - 1);
      }
      ctx.strokeStyle = "#4f8cff"; ctx.lineWidth = 1;
      for (const t of [r.start, r.end]) { ctx.beginPath(); ctx.moveTo(Math.round(this.x(t)) + .5, RULER_H); ctx.lineTo(Math.round(this.x(t)) + .5, this.height); ctx.stroke(); }
    }

    // clips
    ctx.font = "11px Segoe UI, system-ui, sans-serif";
    ctx.textBaseline = "top";
    for (const row of rows) {
      const y = this.rowY(row);
      if (y > this.height || y + row.h < RULER_H) continue;
      for (const clip of M.clipsOn(row.track.id)) {
        const end = M.clipEnd(clip);
        if (end < t0 || clip.start > t1) continue;
        this.paintClip(ctx, clip, row, y);
      }
      for (const tr of p.transitions.filter(tr => tr.trackId === row.track.id)) this.paintTransition(ctx, tr, row, y);
      if (row.kind === "audio" && row.track.showAuto) this.paintAutomation(ctx, row, y);
    }

    // ghost (media drop)
    if (this.ghost) {
      const g = this.ghost;
      ctx.fillStyle = "rgba(255,204,77,.25)"; ctx.strokeStyle = COLORS.sel;
      for (const part of g.parts) {
        const y = this.rowY(part.row);
        ctx.fillRect(this.x(g.t), y + 3, g.dur * this.pps, part.row.h - 7);
        ctx.strokeRect(this.x(g.t) + .5, y + 3.5, g.dur * this.pps, part.row.h - 8);
      }
    }
    // marquee
    if (this.marquee) {
      const m = this.marquee;
      ctx.fillStyle = "rgba(79,140,255,.15)"; ctx.strokeStyle = "#4f8cff";
      ctx.fillRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0);
      ctx.strokeRect(m.x0 + .5, m.y0 + .5, m.x1 - m.x0, m.y1 - m.y0);
    }
    // separator between video and audio
    const firstAudio = rows.find(r => r.kind === "audio");
    if (firstAudio) { ctx.fillStyle = "#0f1013"; ctx.fillRect(0, this.rowY(firstAudio) - GAP_H, this.width, GAP_H); }

    this.paintMarkerLines(ctx);
    this.paintRuler(ctx);

    // blade hover
    if (state.tool === "blade" && this.hover && this.hover.clip) {
      const x = Math.round(this.x(this.hover.bladeT)) + .5;
      const y = this.rowY(this.hover.row);
      ctx.strokeStyle = "#fff"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + this.hover.row.h); ctx.stroke(); ctx.setLineDash([]);
    }
    // snap line
    if (this.snapLine !== null) {
      const x = Math.round(this.x(this.snapLine)) + .5;
      ctx.strokeStyle = COLORS.snap; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, this.height); ctx.stroke();
    }
    // playhead
    const px = Math.round(this.x(state.playhead)) + .5;
    if (px >= -2 && px <= this.width + 2) {
      ctx.strokeStyle = COLORS.playhead; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, this.height); ctx.stroke();
      ctx.fillStyle = COLORS.playhead;
      ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px + 6, 10); ctx.lineTo(px, 16); ctx.lineTo(px - 6, 10); ctx.fill();
    }
    if (this.dragLabel) {
      const { x, y, text } = this.dragLabel;
      ctx.font = "11px Segoe UI, system-ui, sans-serif";
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = "rgba(0,0,0,.8)"; ctx.fillRect(x + 12, y - 22, w, 18);
      ctx.fillStyle = "#ffe14d"; ctx.fillText(text, x + 17, y - 19);
    }
    this.rulerLabelEl.textContent = timecode(state.playhead, M.fps());
    this.syncScrollbar();
  }

  paintRuler(ctx) {
    ctx.fillStyle = "#1a1b20";
    ctx.fillRect(0, 0, this.width, RULER_H);
    ctx.fillStyle = "#2d2f37";
    ctx.fillRect(0, RULER_H - 1, this.width, 1);
    const p = P();
    if (p.inPoint !== null || p.outPoint !== null) {
      const a = p.inPoint ?? 0, b = p.outPoint ?? M.timelineEnd();
      ctx.fillStyle = "rgba(79,140,255,.45)";
      ctx.fillRect(this.x(a), RULER_H - 6, this.x(b) - this.x(a), 5);
    }
    const fps = M.fps();
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const major = steps.find(s => s * this.pps >= 90) || 3600;
    const minorCount = major >= 1 ? (major % 5 === 0 ? 5 : major % 2 === 0 ? 4 : 4) : 5;
    const minor = major / minorCount;
    const start = Math.floor(this.t(0) / minor) * minor;
    ctx.strokeStyle = "#4a4d57"; ctx.fillStyle = "#9a9ea8"; ctx.lineWidth = 1;
    ctx.font = "10px Consolas, monospace"; ctx.textBaseline = "top";
    for (let t = start, i = 0; t < this.t(this.width) && i < 5000; t += minor, i++) {
      if (t < -1e-9) continue;
      const x = Math.round(this.x(t)) + .5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.beginPath(); ctx.moveTo(x, isMajor ? 12 : 20); ctx.lineTo(x, RULER_H - 1); ctx.stroke();
      if (isMajor) ctx.fillText(this.rulerLabel(t, major), x + 3, 3);
    }
    for (const m of p.markers || []) {
      const x = Math.round(this.x(m.t)) + .5;
      if (x < -60 || x > this.width + 4) continue;
      ctx.fillStyle = m.color || "#4f8cff";
      ctx.beginPath(); ctx.moveTo(x - 5, 2); ctx.lineTo(x + 5, 2); ctx.lineTo(x + 5, 12); ctx.lineTo(x, 17); ctx.lineTo(x - 5, 12); ctx.closePath(); ctx.fill();
      ctx.fillRect(x - 0.5, 17, 1, RULER_H - 18);
      if (m.name) {
        ctx.font = "10px Segoe UI, system-ui, sans-serif"; ctx.textBaseline = "top";
        const w = ctx.measureText(m.name).width;
        ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(x + 7, 3, w + 6, 13);
        ctx.fillStyle = "#e9ecf2"; ctx.fillText(m.name, x + 10, 4);
      }
    }
  }

  paintMarkerLines(ctx) {
    for (const m of P().markers || []) {
      const x = Math.round(this.x(m.t)) + .5;
      if (x < 0 || x > this.width) continue;
      ctx.strokeStyle = (m.color || "#4f8cff") + "55"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, this.height); ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- track automation (audio)
  autoGeo(row, ry) { const top = ry + 4, bottom = ry + row.h - 5; return { top, bottom, h: Math.max(4, bottom - top) }; }
  paintAutomation(ctx, row, ry) {
    const geo = this.autoGeo(row, ry);
    const ks = M.trackKeys(row.track);
    ctx.fillStyle = "rgba(10,12,16,.35)";
    ctx.fillRect(0, geo.top - 2, this.width, geo.h + 4);
    ctx.strokeStyle = "rgba(255,150,70,.95)"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let px = 0; px <= this.width; px += 2) {
      const py = this.laneY("volume", M.trackGainDb(row.track, Math.max(0, this.t(px))), geo);
      px ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
    ctx.fillStyle = "#ff9646"; ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.lineWidth = 1;
    for (const k of ks) {
      const kx = this.x(k.t), ky = this.laneY("volume", k.v, geo);
      if (kx < -6 || kx > this.width + 6) continue;
      ctx.beginPath(); ctx.moveTo(kx, ky - 4.5); ctx.lineTo(kx + 4.5, ky); ctx.lineTo(kx, ky + 4.5); ctx.lineTo(kx - 4.5, ky); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = "rgba(255,150,70,.9)"; ctx.font = "10px Segoe UI, system-ui, sans-serif"; ctx.textBaseline = "top";
    const label = "Track volume automation";
    ctx.fillText(label, this.width - ctx.measureText(label).width - 8, geo.bottom - 11);
  }

  rulerLabel(t, step) {
    const fps = M.fps();
    const s = Math.floor(t + 1e-6);
    const f = Math.round((t - s) * fps);
    const mm = String(Math.floor(s / 60)).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
    if (step < 1) return `${mm}:${ss}:${String(f).padStart(2, "0")}`;
    if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${ss}`;
    return `${mm}:${ss}`;
  }

  paintClip(ctx, clip, row, y) {
    const item = M.mediaOf(clip) || {};
    const x0 = this.x(clip.start), x1 = this.x(M.clipEnd(clip));
    const w = Math.max(1, x1 - x0);
    const top = y + 2, h = row.h - 5;
    const kind = item.kind === "image" ? "image" : item.kind === "title" ? "title" : item.kind === "adjust" ? "adjust" : M.GENERATOR_KINDS.has(item.kind) ? "gen" : row.kind;
    const selected = state.selection.has(clip.id);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, top, w, h); ctx.clip();
    ctx.fillStyle = COLORS[kind];
    ctx.fillRect(x0, top, w, h);
    const headH = 15;
    // body
    if (row.kind === "video" && item.kind === "video") {
      const img = this.thumbImage(item);
      if (img) {
        const th = h - headH, tw = th * (item.thumb_width || 128) / 72;
        const startX = Math.max(x0, Math.floor((0 - x0) / tw) * tw + x0);
        for (let x = startX; x < Math.min(x1, this.width); x += tw) {
          const tMid = this.t(x + tw / 2);
          const src = M.srcTime(clip, clamp(tMid - clip.start, 0, M.clipDur(clip)));
          const idx = clamp(Math.floor(src / (item.thumb_interval || 1)), 0, (item.thumb_count || 1) - 1);
          ctx.drawImage(img, idx * item.thumb_width, 0, item.thumb_width, 72, x, top + headH, tw, th);
        }
      }
    } else if (row.kind === "video" && item.kind === "title") {
      ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.font = "bold 13px Segoe UI, system-ui, sans-serif";
      ctx.fillText(String(clip.title?.text || "").split("\n")[0].slice(0, 60), Math.max(x0, 0) + 6, top + headH + 6);
      ctx.font = "11px Segoe UI, system-ui, sans-serif";
    } else if (row.kind === "video" && (item.kind === "solid" || item.kind === "gradient")) {
      const g = clip.gen || {};
      if (item.kind === "solid") ctx.fillStyle = g.color || "#000";
      else { const gr = ctx.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, g.color || "#000"); gr.addColorStop(1, g.color2 || "#fff"); ctx.fillStyle = gr; }
      ctx.fillRect(x0, top + headH, w, h - headH);
    } else if (row.kind === "video" && item.kind === "adjust") {
      ctx.fillStyle = "rgba(255,255,255,.06)";
      for (let sx = Math.floor(Math.max(x0, 0) / 12) * 12; sx < Math.min(x1, this.width); sx += 12) ctx.fillRect(sx, top + headH, 6, h - headH);
    } else if (row.kind === "video" && item.kind === "image") {
      ctx.fillStyle = "rgba(255,255,255,.06)";
      ctx.fillRect(x0, top + headH, w, h - headH);
    } else if (row.kind === "audio") {
      const wave = this.wave(item);
      if (wave && Array.isArray(wave.peaks) && wave.peaks.length) {
        const mid = top + headH + (h - headH) / 2, amp = (h - headH) / 2 - 2;
        const d = M.clipDur(clip);
        ctx.fillStyle = COLORS.wave;
        const xa = Math.max(Math.floor(x0), 0), xb = Math.min(Math.ceil(x1), this.width);
        for (let x = xa; x < xb; x++) {
          const ta = this.t(x) - clip.start, tb = this.t(x + 1) - clip.start;
          let ia = Math.floor(M.srcTime(clip, clamp(ta, 0, d)) * wave.rate), ib = Math.ceil(M.srcTime(clip, clamp(tb, 0, d)) * wave.rate);
          if (ib <= ia) ib = ia + 1;
          let peak = 0;
          for (let i = Math.max(0, ia); i < Math.min(ib, wave.peaks.length); i++) peak = Math.max(peak, wave.peaks[i]);
          const v = Math.min(1, peak / 255 * dbToGain(M.prop(clip, "volume", clamp(ta, 0, d))) * M.fadeFactor(clip, clamp(ta, 0, d), d));
          const hh = Math.max(0.5, v * amp);
          ctx.fillRect(x, mid - hh, 1, hh * 2);
        }
      }
    }
    // header strip
    ctx.fillStyle = COLORS[kind + "Head"];
    ctx.fillRect(x0, top, w, headH);
    const badges = [];
    if (clip.linkId) badges.push("🔗");
    if (M.hasSpeedKeys(clip)) badges.push(M.keysOf(clip, "speed").every(k => k.v <= 1e-6) ? "❄ freeze" : "⏱ ramp");
    else if (Math.abs((clip.speed || 1) - 1) > 1e-6 && !M.isStillKind(item.kind)) badges.push(`${Math.round(clip.speed * 100)}%`);
    if (row.kind === "video" && clip.grade && !isNeutral(clip.grade)) badges.push("CC");
    if (clip.parentId) badges.push("⤓");
    if (clip.reverse) badges.push("◀◀");
    if ((clip.effects || []).some(f => f.on !== false)) badges.push("fx");
    if (clip.takes?.length > 1) badges.push(`T${(clip.takeIndex || 0) + 1}/${clip.takes.length}`);
    const job = window.veApp?.regen?.forClip(clip.id).find(j => j.status !== "error");
    if (job) badges.push(job.status === "queued" ? "⟳ queued" : `⟳ ${Math.round((job.progress || 0) * 100)}%`);
    if (clip.gen) badges.push({ new: "✦", extend: "⇢", prepend: "⇠", bridge: "⇄", fill: "⇄", loop: "↻", replace: "⟲" }[clip.gen.mode] || "◆");
    ctx.fillStyle = "#e9ecf2";
    const label = `${badges.join(" ")}${badges.length ? "  " : ""}${clip.name || item.name || "clip"}`;
    ctx.fillText(label, Math.max(x0, 0) + 4, top + 2);
    // fades
    const d = M.clipDur(clip);
    ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 1;
    const fadeShape = (xEdge, len, name, dir) => {
      const pts = [];
      for (let i = 0; i <= 16; i++) { const u = i / 16; pts.push([xEdge + dir * u * len * this.pps, top + h - (h - headH) * curve(name, u)]); }
      ctx.beginPath(); ctx.moveTo(xEdge, top + headH); pts.forEach(([px, py]) => ctx.lineTo(px, py)); ctx.closePath(); ctx.fill();
      ctx.beginPath(); pts.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.stroke();
    };
    if (clip.fadeIn > 0) fadeShape(x0, clip.fadeIn, clip.fadeInCurve || "linear", 1);
    if (clip.fadeOut > 0) fadeShape(x1, clip.fadeOut, clip.fadeOutCurve || "linear", -1);
    this.paintKeys(ctx, clip, row, x0, x1, top, h, headH, selected);
    if (item.missing) { ctx.fillStyle = "rgba(200,40,40,.55)"; ctx.fillRect(x0, top, w, h); ctx.fillStyle = "#fff"; ctx.fillText("Media offline", x0 + 4, top + headH + 4); }
    // seam verdicts of generated joins: green seamless, yellow soft bump, red hard cut
    const seamColor = { seamless: "#36c46f", "soft bump": "#ffc83c", "hard cut": "#ff5a5a" };
    for (const [side, xEdge] of [["left", x0], ["right", x1]]) {
      const v = clip.seam?.[side];
      if (!v || !seamColor[v.verdict]) continue;
      ctx.fillStyle = seamColor[v.verdict];
      ctx.fillRect(side === "left" ? xEdge : xEdge - 3, top + headH, 3, h - headH);
    }
    ctx.restore();
    // fade handles
    const hovered = this.hover && this.hover.clip && this.hover.clip.id === clip.id;
    if ((hovered || selected) && w > 24) {
      ctx.fillStyle = "#fff";
      const hx0 = x0 + (clip.fadeIn || 0) * this.pps, hx1 = x1 - (clip.fadeOut || 0) * this.pps;
      ctx.fillRect(hx0 - 3 + (clip.fadeIn ? 0 : 3), top + 1, 6, 6);
      ctx.fillRect(hx1 - 3 - (clip.fadeOut ? 0 : 3), top + 1, 6, 6);
    }
    ctx.strokeStyle = selected ? COLORS.sel : "rgba(0,0,0,.55)";
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(x0 + (selected ? 1 : .5), top + (selected ? 1 : .5), w - (selected ? 2 : 1), h - (selected ? 2 : 1));
  }

  paintTransition(ctx, tr, row, y) {
    const info = M.transitionInfo(tr);
    if (!info) return;
    const xa = this.x(info.lo), xb = this.x(info.hi);
    if (xb < 0 || xa > this.width) return;
    const top = y + 2, h = 15;
    const w = Math.max(10, xb - xa);
    const xs = (xa + xb) / 2 - w / 2;
    ctx.fillStyle = COLORS.trans;
    ctx.fillRect(xs, top, w, h);
    ctx.strokeStyle = state.selTransition === tr.id ? COLORS.sel : "rgba(0,0,0,.6)";
    ctx.lineWidth = state.selTransition === tr.id ? 2 : 1;
    ctx.strokeRect(xs + .5, top + .5, w - 1, h - 1);
    ctx.save(); ctx.beginPath(); ctx.rect(xs, top, w, h); ctx.clip();
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.beginPath(); ctx.moveTo(xs, top + h); ctx.lineTo(xs + w, top); ctx.moveTo(xs, top); ctx.lineTo(xs + w, top + h); ctx.stroke();
    ctx.fillStyle = "#1a1206"; ctx.font = "10px Segoe UI, sans-serif";
    if (w > 60) ctx.fillText(transitionLabel(tr), xs + 4, top + 2);
    ctx.restore();
    ctx.font = "11px Segoe UI, system-ui, sans-serif";
  }

  // ---------------------------------------------------------------- keyframe lanes
  // Which property's line a clip shows: chosen per clip (right-click > Show keyframes), else volume / opacity.
  lane(clip, row) {
    const kind = row ? row.kind : M.trackKind(clip.trackId);
    const chosen = clip.lane;
    if (chosen && M.KEYABLE[chosen] && (M.KEYABLE[chosen].kind === kind || M.KEYABLE[chosen].kind === "any")) {
      if (chosen !== "speed" || !M.isStill(clip)) return chosen;
    }
    return kind === "audio" ? "volume" : "opacity";
  }
  laneGeo(row, ry) { const top = ry + 2 + 15 + 3, bottom = ry + row.h - 6; return { top, bottom, h: Math.max(4, bottom - top) }; }
  laneLimits(name) {
    const s = P().settings;
    if (name.startsWith("crop")) return [0, 1];
    return { volume: [-60, 12], opacity: [0, 1], scale: [0, 20], speed: [0, 10], x: [-s.width, s.width], y: [-s.height, s.height], rotation: [-360, 360] }[name];
  }
  laneNorm(name, v) {
    const s = P().settings;
    if (name === "volume") return Math.sqrt(dbToGain(v) / dbToGain(12));
    if (name === "opacity" || name.startsWith("crop")) return clamp(v, 0, 1);
    if (name === "rotation") return clamp((v + 360) / 720, 0, 1);
    if (name === "scale" || name === "speed") return Math.max(0, v) / (Math.max(0, v) + 1);
    if (name === "x") return clamp(0.5 + v / (2 * s.width), 0, 1);
    if (name === "y") return clamp(0.5 - v / (2 * s.height), 0, 1);
    return 0.5;
  }
  laneDenorm(name, f) {
    const s = P().settings;
    f = clamp(f, 0, 1);
    if (name === "volume") return Math.round(clamp(gainToDb(f * f * dbToGain(12)), -60, 12) * 10) / 10;
    if (name === "opacity" || name.startsWith("crop")) return Math.round(f * 1000) / 1000;
    if (name === "rotation") return Math.round(f * 720 - 360);
    if (name === "scale" || name === "speed") return Math.round(Math.min(f, 0.995) / (1 - Math.min(f, 0.995)) * 1000) / 1000;
    if (name === "x") return Math.round((f - 0.5) * 2 * s.width);
    if (name === "y") return Math.round((0.5 - f) * 2 * s.height);
    return 0;
  }
  laneY(name, v, geo) { return geo.bottom - this.laneNorm(name, v) * geo.h; }
  laneValue(name, y, geo) { return this.laneDenorm(name, (geo.bottom - y) / geo.h); }
  laneText(name, v) {
    if (name === "volume") return v <= -60 ? "-∞ dB" : `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
    if (name === "opacity" || name === "scale" || name === "speed" || name.startsWith("crop")) return `${Math.round(v * 100)}%`;
    if (name === "rotation") return `${Math.round(v)}°`;
    return `${Math.round(v)} px`;
  }

  paintKeys(ctx, clip, row, x0, x1, top, h, headH, selected) {
    const lane = this.lane(clip, row);
    const geo = this.laneGeo(row, top - 2);
    const ks = M.keysOf(clip, lane);
    const hovered = this.hover && this.hover.clip && this.hover.clip.id === clip.id;
    const visible = selected || hovered || ks.length || (lane === "volume" && (clip.volume || 0) !== 0) || (lane === "opacity" && (clip.opacity ?? 1) !== 1);
    if (!visible || geo.h < 8) return;
    const d = M.clipDur(clip);
    ctx.strokeStyle = selected ? "rgba(255,225,77,.95)" : "rgba(255,225,77,.5)";
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.beginPath();
    const xa = Math.max(x0, 0), xb = Math.min(x1, this.width);
    for (let px = xa; px <= xb; px += 2) {
      const tau = clamp(this.t(px) - clip.start, 0, d);
      const py = this.laneY(lane, M.prop(clip, lane, tau), geo);
      px === xa ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
    for (const k of ks) {
      const kx = this.x(clip.start + k.t), ky = this.laneY(lane, k.v, geo);
      if (kx < -6 || kx > this.width + 6) continue;
      ctx.fillStyle = selected ? "#ffe14d" : "rgba(255,225,77,.7)";
      ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(kx, ky - 4.5); ctx.lineTo(kx + 4.5, ky); ctx.lineTo(kx, ky + 4.5); ctx.lineTo(kx - 4.5, ky); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    if (lane !== "volume" && lane !== "opacity" || selected) {
      ctx.fillStyle = "rgba(255,225,77,.85)"; ctx.font = "10px Segoe UI, system-ui, sans-serif";
      const label = M.KEYABLE[lane].label;
      const lw = ctx.measureText(label).width;
      if (x1 - x0 > lw + 60) ctx.fillText(label, Math.min(x1, this.width) - lw - 6, geo.top);
      ctx.font = "11px Segoe UI, system-ui, sans-serif";
    }
    // small markers for other keyed properties
    const others = Object.keys(M.KEYABLE).filter(n => n !== lane && M.keysOf(clip, n).length);
    ctx.fillStyle = "rgba(255,160,60,.9)";
    for (const n of others) for (const k of M.keysOf(clip, n)) {
      const kx = this.x(clip.start + k.t);
      if (kx < x0 || kx > x1) continue;
      ctx.beginPath(); ctx.moveTo(kx, top + headH - 6); ctx.lineTo(kx + 3, top + headH - 3); ctx.lineTo(kx, top + headH); ctx.lineTo(kx - 3, top + headH - 3); ctx.closePath(); ctx.fill();
    }
  }

  // ---------------------------------------------------------------- hit testing
  hit(x, y) {
    if (y < RULER_H) {
      const marker = (P().markers || []).find(m => Math.abs(this.x(m.t) - x) <= 6 && y <= 18);
      return marker ? { area: "marker", marker, t: marker.t } : { area: "ruler", t: this.t(x) };
    }
    const row = this.rowAt(y);
    if (!row) return { area: "empty", t: this.t(x) };
    const ry = this.rowY(row);
    const t = this.t(x);
    if (row.kind === "audio" && row.track.showAuto && !row.track.locked && state.tool === "select") {
      const geo = this.autoGeo(row, ry);
      const ks = M.trackKeys(row.track);
      const index = ks.findIndex(k => Math.abs(this.x(k.t) - x) <= 5 && Math.abs(this.laneY("volume", k.v, geo) - y) <= 5);
      if (index >= 0) return { area: "auto", zone: "key", row, t, index };
      if (Math.abs(this.laneY("volume", M.trackGainDb(row.track, Math.max(0, t)), geo) - y) <= 4) return { area: "auto", zone: "line", row, t };
    }
    for (const tr of P().transitions.filter(tr => tr.trackId === row.track.id)) {
      const info = M.transitionInfo(tr);
      if (!info) continue;
      const xa = this.x(info.lo), xb = this.x(info.hi), w = Math.max(10, xb - xa), xs = (xa + xb) / 2 - w / 2;
      if (x >= xs - 3 && x <= xs + w + 3 && y >= ry + 1 && y <= ry + 19) {
        const zone = Math.abs(x - xs) < 5 ? "edgeL" : Math.abs(x - xs - w) < 5 ? "edgeR" : "body";
        return { area: "transition", row, t, transition: tr, zone };
      }
    }
    const clips = M.clipsOn(row.track.id).filter(c => t >= c.start - EDGE / this.pps && t <= M.clipEnd(c) + EDGE / this.pps);
    let best = null;
    for (const clip of clips) {
      const x0 = this.x(clip.start), x1 = this.x(M.clipEnd(clip));
      if (x < x0 - EDGE || x > x1 + EDGE) continue;
      const w = x1 - x0;
      const edge = Math.min(EDGE, w / 3);
      let zone = "body";
      const hx0 = x0 + (clip.fadeIn || 0) * this.pps, hx1 = x1 - (clip.fadeOut || 0) * this.pps;
      if (y < ry + 10 && w > 24 && Math.abs(x - hx0) < 6 && x >= x0 - 1) zone = "fadeIn";
      else if (y < ry + 10 && w > 24 && Math.abs(x - hx1) < 6 && x <= x1 + 1) zone = "fadeOut";
      else if (Math.abs(x - x1) <= edge && Math.abs(x - x0) > edge) zone = "trimR";
      else if (Math.abs(x - x0) <= edge) zone = "trimL";
      else if (x < x0 || x > x1) continue;
      let keyIndex = -1;
      if (state.selection.has(clip.id) && !row.track.locked && state.tool === "select") {
        const lane = this.lane(clip, row);
        const geo = this.laneGeo(row, ry);
        if (y >= geo.top - 5 && y <= geo.bottom + 5) {
          const ks = M.keysOf(clip, lane);
          ks.forEach((k, i) => {
            const kx = this.x(clip.start + k.t), ky = this.laneY(lane, k.v, geo);
            if (Math.abs(kx - x) <= 5 && Math.abs(ky - y) <= 5) { zone = "key"; keyIndex = i; }
          });
          if (zone !== "key" && zone === "body") {
            const ly = this.laneY(lane, M.prop(clip, lane, clamp(t - clip.start, 0, M.clipDur(clip))), geo);
            if (Math.abs(ly - y) <= 4) zone = "line";
          }
        }
      }
      const score = zone === "key" ? -1 : zone === "body" ? 1 : 0;
      if (!best || score < best.score) best = { clip, zone, score, keyIndex };
    }
    if (best) return { area: "clip", row, t, clip: best.clip, zone: best.zone, keyIndex: best.keyIndex, lane: this.lane(best.clip, row) };
    return { area: "row", row, t };
  }

  // ---------------------------------------------------------------- snapping
  snapPoints(exclude = new Set()) {
    const pts = [0, state.playhead];
    const p = P();
    if (p.inPoint !== null) pts.push(p.inPoint);
    if (p.outPoint !== null) pts.push(p.outPoint);
    for (const c of p.clips) if (!exclude.has(c.id)) { pts.push(c.start, M.clipEnd(c)); }
    for (const m of p.markers || []) pts.push(m.t);
    return pts;
  }
  snap(t, points, force = false) {
    if ((!P().snapping && !force) || !points) return { t, snapped: false };
    let best = null;
    for (const p of points) { const d = Math.abs(p - t) * this.pps; if (d <= SNAP_PX && (!best || d < best.d)) best = { p, d }; }
    return best ? { t: best.p, snapped: true } : { t, snapped: false };
  }

  // ---------------------------------------------------------------- pointer
  local(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  down(e) {
    if (!P() || state.readOnly) return;
    if (e.button === 1) { this.startPan(e); return; }
    if (e.button !== 0) return;
    const [x, y] = this.local(e);
    const h = this.hit(x, y);
    this.canvas.setPointerCapture(e.pointerId);
    const base = { startX: x, startY: y, moved: false, alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    if (h.area === "marker") {
      this.drag = { ...base, mode: "marker", markerId: h.marker.id, snapData: M.snapshot() };
      return;
    }
    if (h.area === "auto") {
      const trackId = h.row.track.id;
      let index = h.index;
      if (h.zone === "line" && (base.ctrl || !M.trackKeys(h.row.track).length)) {
        const geo = this.autoGeo(h.row, this.rowY(h.row));
        M.edit("Add automation keyframe", () => M.setTrackKeyAt(trackId, Math.max(0, h.t), this.laneValue("volume", y, geo)));
        index = M.trackKeyIndexAt(trackId, M.snapFrame(Math.max(0, h.t)));
      }
      if (index !== undefined && index >= 0) {
        this.drag = { ...base, mode: "autoKey", trackId, index, snapData: M.snapshot() };
      } else {
        const ks = M.trackKeys(h.row.track);
        const j = ks.findIndex((k, i) => ks[i + 1] && k.t <= h.t && h.t <= ks[i + 1].t);
        const indices = j >= 0 ? [j, j + 1] : [h.t < ks[0].t ? 0 : ks.length - 1];
        this.drag = { ...base, mode: "autoLine", trackId, indices, startValue: M.trackGainDb(h.row.track, Math.max(0, h.t)), snapData: M.snapshot() };
      }
      return;
    }
    if (h.area === "ruler") {
      this.playback.pause();
      this.drag = { ...base, mode: "scrub" };
      this.scrubTo(x, e);
      return;
    }
    const tool = state.tool;
    if (tool === "blade") {
      if (h.clip && !h.row.track.locked) {
        const t = this.bladeTime(h.t, h.clip);
        M.edit("Blade", () => M.splitAt(t, { ids: e.shiftKey ? null : new Set([h.clip.id]) }));
      }
      return;
    }
    if (tool === "range") {
      const row = h.row || this.nearestRow(y);
      const s = this.snap(h.t, this.snapPoints());
      this.drag = { ...base, mode: "range", t0: Math.max(0, s.t), row0: row };
      return;
    }
    if (h.area === "transition") {
      state.selTransition = h.transition.id;
      state.selection.clear();
      bus.emit("selection");
      if (h.zone !== "body") this.drag = { ...base, mode: "trdur", trId: h.transition.id, snapData: M.snapshot() };
      return;
    }
    if (h.area === "clip") {
      const clip = h.clip;
      if (h.row.track.locked) return;
      if (h.zone === "fadeIn" || h.zone === "fadeOut") {
        this.drag = { ...base, mode: "fade", clipId: clip.id, which: h.zone, snapData: M.snapshot() };
        return;
      }
      if (h.zone === "line" && base.ctrl) {
        const tau = M.snapFrame(clamp(h.t - clip.start, 0, M.clipDur(clip)));
        M.edit("Add keyframe", () => M.setKeyAt(clip.id, h.lane, tau, M.prop(clip, h.lane, tau)));
        const live = M.getClip(clip.id);
        const index = live ? M.keyIndexAt(live, h.lane, tau) : -1;
        if (index >= 0) this.drag = { ...base, mode: "key", clipId: clip.id, lane: h.lane, index, row: h.row, snapData: M.snapshot() };
        return;
      }
      if (h.zone === "key") {
        this.drag = { ...base, mode: "key", clipId: clip.id, lane: h.lane, index: h.keyIndex, row: h.row, snapData: M.snapshot() };
        return;
      }
      if (h.zone === "line") {
        const tau = clamp(h.t - clip.start, 0, M.clipDur(clip));
        const ks = M.keysOf(clip, h.lane);
        let indices = [];
        if (ks.length) {
          const j = ks.findIndex((k, i) => ks[i + 1] && k.t <= tau && tau <= ks[i + 1].t);
          indices = j >= 0 ? [j, j + 1] : [tau < ks[0].t ? 0 : ks.length - 1];
        }
        this.drag = { ...base, mode: "line", clipId: clip.id, lane: h.lane, indices, row: h.row, startValue: M.prop(clip, h.lane, tau), snapData: M.snapshot() };
        return;
      }
      if (h.zone === "trimL" || h.zone === "trimR") {
        if (!state.selection.has(clip.id)) M.select([clip.id]);
        const exclude = new Set([clip.id, ...M.partners(clip).map(p => p.id)]);
        this.drag = { ...base, mode: "trim", clipId: clip.id, edge: h.zone === "trimL" ? "start" : "end", snapData: M.snapshot(), points: this.snapPoints(exclude) };
        return;
      }
      let deferredSelect = false;
      if (base.ctrl || base.shift) M.select([clip.id], { toggle: true });
      else if (!state.selection.has(clip.id)) M.select([clip.id]);
      else deferredSelect = true;
      const ids = new Set(state.selection);
      const moving = P().clips.filter(c => ids.has(c.id));
      this.drag = { ...base, mode: "move", clipId: clip.id, kind: h.row.kind, deferredSelect, snapData: M.snapshot(),
        points: this.snapPoints(ids), groupStart: Math.min(...moving.map(c => c.start)), groupEnd: Math.max(...moving.map(c => M.clipEnd(c))),
        trackIndex: this.kindIndex(h.row.track) };
      return;
    }
    // empty area
    const additive = base.ctrl || base.shift;
    if (!additive) M.clearSelection();
    this.drag = { ...base, mode: "marquee", base: new Set(state.selection) };
  }

  kindIndex(track) { return (track.kind === "video" ? M.videoTracks() : M.audioTracks()).indexOf(track); }

  bladeTime(t, clip) {
    const s = this.snap(t, [state.playhead], true);
    return s.snapped ? s.t : M.snapFrame(t);
  }

  scrubTo(x, e) {
    this.scrubAudioAfter = true;
    let t = Math.max(0, this.t(x));
    if (!e.shiftKey) { const s = this.snap(t, this.snapPoints()); t = s.t; }
    this.playback.seek(t);
    this.playback.scrub(t);
  }

  move(e) {
    const [x, y] = this.local(e);
    if (!this.drag) {
      const h = this.hit(x, y);
      if (state.tool === "blade" && h.clip) h.bladeT = this.bladeTime(h.t, h.clip);
      const prev = this.hover;
      this.hover = h;
      this.canvas.style.cursor = this.cursorFor(h);
      if (state.tool === "blade" || (prev?.clip?.id !== h.clip?.id)) this.draw();
      return;
    }
    const d = this.drag;
    if (!d.moved && Math.hypot(x - d.startX, y - d.startY) < 3) return;
    const firstMove = !d.moved;
    d.moved = true;
    this.snapLine = null;
    if (d.mode === "pan") { this.scrollX = Math.max(0, d.scrollX - (x - d.startX)); this.scrollY = Math.max(0, d.scrollY - (y - d.startY)); this.renderHeaders(); this.draw(); return; }
    if (d.mode === "scrub") { this.scrubTo(x, e); return; }
    if (d.mode === "marker") {
      if (firstMove) M.commit("Move marker");
      M.restore(d.snapData);
      const m = M.getMarker(d.markerId);
      if (m) {
        const s = this.snap(Math.max(0, this.t(x)), this.snapPoints().filter(p => Math.abs(p - m.t) > 1e-6));
        m.t = s.snapped ? s.t : M.snapFrame(Math.max(0, this.t(x)));
        if (s.snapped) this.snapLine = s.t;
      }
      M.finalize();
      return;
    }
    if (d.mode === "autoKey" || d.mode === "autoLine") {
      if (firstMove) M.commit("Track automation");
      M.restore(d.snapData);
      const track = M.getTrack(d.trackId);
      const row = this.rows().find(r => r.track.id === d.trackId);
      if (track && row) {
        const geo = this.autoGeo(row, this.rowY(row));
        const value = this.laneValue("volume", y, geo);
        if (d.mode === "autoKey") M.moveTrackKey(d.trackId, d.index, e.shiftKey ? null : M.snapFrame(Math.max(0, this.t(x))), value);
        else M.offsetTrackKeys(d.trackId, d.indices, value - d.startValue);
        const k = M.trackKeys(M.getTrack(d.trackId))[d.mode === "autoKey" ? d.index : d.indices[0]];
        this.dragLabel = { x, y, text: this.laneText("volume", d.mode === "autoKey" && k ? k.v : value) };
      }
      M.finalize();
      return;
    }
    if (d.mode === "marquee") {
      this.marquee = { x0: Math.min(d.startX, x), y0: Math.min(d.startY, y), x1: Math.max(d.startX, x), y1: Math.max(d.startY, y) };
      const ta = this.t(this.marquee.x0), tb = this.t(this.marquee.x1);
      const ids = new Set(d.base);
      for (const row of this.rows()) {
        const ry = this.rowY(row);
        if (ry + row.h < this.marquee.y0 || ry > this.marquee.y1) continue;
        for (const c of M.clipsOn(row.track.id)) if (c.start < tb && M.clipEnd(c) > ta) ids.add(c.id);
      }
      state.selection = M.withPartners(ids);
      bus.emit("selection");
      return;
    }
    if (d.mode === "range") {
      const s = this.snap(Math.max(0, this.t(x)), this.snapPoints());
      if (s.snapped) this.snapLine = s.t;
      const row1 = this.rowAt(y) || this.nearestRow(y);
      const rows = this.rows();
      const i0 = rows.indexOf(rows.find(r => r.track.id === d.row0.track.id)), i1 = rows.indexOf(rows.find(r => r.track.id === row1.track.id));
      const trackIds = rows.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).map(r => r.track.id);
      const a = M.snapFrame(Math.min(d.t0, s.t)), b = M.snapFrame(Math.max(d.t0, s.t));
      state.range = { start: a, end: b, trackIds };
      bus.emit("range");
      return;
    }
    // model edits: restore the snapshot taken at pointerdown and re-apply the operation
    if (firstMove) M.commit({ move: "Move", trim: "Trim", fade: "Fade", trdur: "Transition duration" }[d.mode] || "Edit");
    M.restore(d.snapData);
    if (d.mode === "move") {
      let dt = this.t(x) - this.t(d.startX);
      const cands = [];
      for (const edge of [d.groupStart, d.groupEnd]) {
        const s = this.snap(edge + dt, d.points);
        if (s.snapped) cands.push({ dt: s.t - edge, t: s.t, dist: Math.abs(s.t - edge - dt) });
      }
      if (cands.length) { cands.sort((p, q) => p.dist - q.dist); dt = cands[0].dt; this.snapLine = cands[0].t; }
      else dt = M.snapFrame(d.groupStart + dt) - d.groupStart;
      const row = this.rowAt(y);
      let shift = 0;
      if (row && row.kind === d.kind) shift = this.kindIndex(row.track) - d.trackIndex;
      M.moveClips([...state.selection], dt, shift, d.kind);
    } else if (d.mode === "trim") {
      const s = this.snap(this.t(x), d.points);
      if (s.snapped) this.snapLine = s.t;
      M.trimEdge(d.clipId, d.edge, s.snapped ? s.t : M.snapFrame(this.t(x)), { linked: !e.altKey });
    } else if (d.mode === "fade") {
      const clip = M.getClip(d.clipId);
      if (clip) {
        const dur = M.clipDur(clip);
        if (d.which === "fadeIn") clip.fadeIn = M.snapFrame(clamp(this.t(x) - clip.start, 0, dur - (clip.fadeOut || 0)));
        else clip.fadeOut = M.snapFrame(clamp(M.clipEnd(clip) - this.t(x), 0, dur - (clip.fadeIn || 0)));
      }
    } else if (d.mode === "key" || d.mode === "line") {
      const clip = M.getClip(d.clipId);
      const row = this.rows().find(r => r.track.id === (clip && clip.trackId));
      if (clip && row) {
        const geo = this.laneGeo(row, this.rowY(row));
        const value = this.laneValue(d.lane, y, geo);
        if (d.mode === "key") {
          const tau = e.shiftKey ? null : M.snapFrame(this.t(x) - clip.start);
          M.moveKey(clip.id, d.lane, d.index, tau, value);
        } else if (d.indices.length) {
          M.offsetKeys(clip.id, d.lane, d.indices, value - d.startValue, this.laneLimits(d.lane));
        } else if (d.lane === "speed") {
          M.setSpeed([clip.id], Math.max(0.01, value));
        } else {
          clip[d.lane] = value;
        }
        const live = M.getClip(d.clipId);
        this.dragLabel = { x, y, text: this.laneText(d.lane, d.mode === "key" ? (M.keysOf(live, d.lane)[d.index] || {}).v ?? value : value) };
      }
    } else if (d.mode === "trdur") {
      const tr = P().transitions.find(t => t.id === d.trId);
      const info = tr && M.transitionInfo(tr);
      if (info) tr.duration = Math.max(M.frameDur(), M.snapFrame(2 * Math.abs(this.t(x) - info.cut)));
    }
    M.finalize();
  }

  up(e) {
    const d = this.drag;
    this.drag = null;
    this.dragLabel = null;
    this.snapLine = null;
    this.marquee = null;
    if (d && d.mode === "move" && !d.moved && d.deferredSelect) M.select([d.clipId]);
    if (d && d.mode === "marker" && !d.moved) { const m = M.getMarker(d.markerId); if (m) { this.playback.pause(); this.playback.seek(m.t); } }
    if (d && d.mode === "range" && !d.moved) { state.range = null; bus.emit("range"); this.playback.seek(Math.max(0, this.t(d.startX))); }
    if (d && d.mode === "marquee" && !d.moved) this.playback.seek(Math.max(0, this.t(d.startX)));
    if (d && d.moved) bus.emit("change");
    this.draw();
  }

  startPan(e) {
    const [x, y] = this.local(e);
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { mode: "pan", startX: x, startY: y, moved: true, scrollX: this.scrollX, scrollY: this.scrollY };
  }

  cursorFor(h) {
    if (state.tool === "blade") return h.clip ? "crosshair" : "default";
    if (state.tool === "range") return "text";
    if (h.area === "ruler") return "col-resize";
    if (h.area === "marker") return "pointer";
    if (h.area === "auto") return h.zone === "key" ? "move" : "ns-resize";
    if (h.area === "transition") return h.zone === "body" ? "pointer" : "ew-resize";
    if (h.area === "clip") return { trimL: "w-resize", trimR: "e-resize", fadeIn: "nesw-resize", fadeOut: "nwse-resize", key: "move", line: "ns-resize" }[h.zone] || "grab";
    return "default";
  }

  wheel(e) {
    e.preventDefault();
    const [x] = this.local(e);
    if (e.ctrlKey || e.metaKey) { this.setZoom(this.pps * Math.pow(1.0015, -e.deltaY), x); return; }
    const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    const canScrollY = this.contentHeight + RULER_H > this.height;
    if (horizontal || !canScrollY) {
      this.scrollX = Math.max(0, this.scrollX + (horizontal ? (e.deltaX || e.deltaY) : e.deltaY));
      this.syncScrollbar();
    } else {
      this.scrollY = clamp(this.scrollY + e.deltaY, 0, Math.max(0, this.contentHeight + RULER_H - this.height + 10));
      this.headersInner.style.transform = `translateY(${-this.scrollY}px)`;
    }
    this.draw();
  }

  dblclick(e) {
    const [x, y] = this.local(e);
    const h = this.hit(x, y);
    if (h.area === "marker") { bus.emit("edit-marker", h.marker.id); return; }
    if (h.area === "clip") bus.emit("open-panel", h.row.kind === "video" ? "inspector" : "inspector");
    if (h.area === "transition") bus.emit("open-panel", "inspector");
  }

  context(e) {
    e.preventDefault();
    if (state.readOnly) return;
    const [x, y] = this.local(e);
    const h = this.hit(x, y);
    if (h.area === "clip" && !state.selection.has(h.clip.id)) M.select([h.clip.id]);
    if (h.area === "transition") { state.selTransition = h.transition.id; state.selection.clear(); bus.emit("selection"); }
    this.onContextAction && this.onContextAction(e.clientX, e.clientY, h);
  }

  // ---------------------------------------------------------------- drag & drop from the media bin / OS
  dragOver(e) {
    const types = [...e.dataTransfer.types];
    if (!types.includes("text/x-ve-media") && !types.includes("text/x-ve-transition") && !types.includes("text/x-ve-effect") && !types.includes("Files")) return;
    e.preventDefault();
    const [x, y] = this.local(e);
    if (types.includes("text/x-ve-transition") || types.includes("text/x-ve-effect")) { e.dataTransfer.dropEffect = "copy"; this.ghost = null; this.hover = this.hit(x, y); this.draw(); return; }
    e.dataTransfer.dropEffect = "copy";
    const id = window.__veDragMedia;
    const item = id && P().media[id];
    let t = Math.max(0, this.t(x));
    const row = this.rowAt(y) || this.nearestRow(y);
    if (!item) { this.ghost = null; return; }
    const dur = M.isStillKind(item.kind) ? M.DEFAULT_STILL : item.duration || 1;
    const s = this.snap(t, this.snapPoints());
    t = s.snapped ? s.t : M.snapFrame(t);
    const parts = [];
    const rows = this.rows();
    if (item.kind === "audio") parts.push({ row: row.kind === "audio" ? row : rows.find(r => r.kind === "audio") });
    else {
      const vRow = row.kind === "video" ? row : rows.find(r => r.track.id === M.primaryId());
      parts.push({ row: vRow });
      if (item.has_audio) {
        const vi = this.kindIndex(vRow.track);
        const aRow = row.kind === "audio" ? row : rows.filter(r => r.kind === "audio")[vi] || rows.filter(r => r.kind === "audio").slice(-1)[0];
        if (aRow) parts.push({ row: aRow });
      }
    }
    this.ghost = { t, dur, row, parts: parts.filter(p => p.row) };
    this.snapLine = s.snapped ? s.t : null;
    this.draw();
  }

  drop(e) {
    e.preventDefault();
    const [x, y] = this.local(e);
    const ghost = this.ghost;
    this.ghost = null;
    this.snapLine = null;
    if (state.readOnly) return;
    const transitionId = e.dataTransfer.getData("text/x-ve-transition");
    if (transitionId) { bus.emit("drop-transition", { type: transitionId, hit: this.hit(x, y) }); return; }
    const effectType = e.dataTransfer.getData("text/x-ve-effect");
    if (effectType) { bus.emit("drop-effect", { type: effectType, hit: this.hit(x, y) }); this.draw(); return; }
    const mediaId = e.dataTransfer.getData("text/x-ve-media");
    if (mediaId && P().media[mediaId]) {
      const row = ghost ? ghost.row : (this.rowAt(y) || this.nearestRow(y));
      const t = ghost ? ghost.t : Math.max(0, this.t(x));
      const clips = M.edit("Add clip", () => M.placeMedia(P().media[mediaId], row.track.id, t));
      if (clips) M.select(clips.map(c => c.id));
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length && this.onImportFiles) {
      const row = this.rowAt(y) || this.nearestRow(y);
      this.onImportFiles([...e.dataTransfer.files], { trackId: row.track.id, time: Math.max(0, this.t(x)) });
    }
    this.draw();
  }
}
