// The Colour page's shot strip: every shot on the timeline's video tracks in timeline order, as Resolve's clips row.
// Click a shot to grade it (it is selected and shown in the viewer); Ctrl/Shift+click picks several. Right-click a
// shot to match the selected shots' colour to it, copy its grade to them, or reset a grade.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { el, toast, showMenu, clamp } from "./util.js";
import { Renderer } from "./renderer.js";
import { gradeUniforms } from "./grade.js";
import { ensureLut } from "./lut.js";

const MEASURE = 96;      // the measuring frame's width (height follows the shot's aspect)
const SAMPLES = [0.25, 0.5, 0.75];   // where in a shot its colour is measured

function tc(t) {
  const f = M.fps(), fr = Math.round(t * f);
  const s = Math.floor(fr / f), ff = fr % Math.round(f);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

export class ShotStrip {
  constructor(app) {
    this.app = app;
    this.row = el("div.shot-row");
    this.info = el("span.dim", { style: { fontSize: "11px" } });
    this.node = el("div.shotstrip", {},
      el("div.panel-toolbar", {}, el("strong", { style: { fontSize: "11px", letterSpacing: ".8px", textTransform: "uppercase", color: "var(--muted)" } }, "Shots"),
        this.info, el("div.spacer"),
        el("span.dim", { style: { fontSize: "11px" } }, "Click a shot to grade it · right-click another to match colour")),
      this.row);
    for (const name of ["project", "change", "selection"]) bus.on(name, () => this.renderSoon());
    let last = -1;
    bus.on("time", () => { const s = this.current()?.id; if (s !== last) { last = s; this.mark(); } });
  }

  shots() {
    if (!P()) return [];
    const order = M.videoTracks().map(t => t.id);
    return P().clips.filter(c => M.trackKind(c.trackId) === "video" && ["video", "image"].includes(M.kindOf(c)))
      .sort((a, b) => a.start - b.start || order.indexOf(a.trackId) - order.indexOf(b.trackId));
  }
  // the shot under the playhead (top-most video track first)
  current() {
    const t = state.playhead;
    const order = M.videoTracks().map(tr => tr.id);
    return this.shots().filter(c => t >= c.start - 1e-6 && t < M.clipEnd(c) - 1e-6).sort((a, b) => order.indexOf(a.trackId) - order.indexOf(b.trackId))[0];
  }

  renderSoon() { if (this.timer) return; this.timer = requestAnimationFrame(() => { this.timer = null; if (this.node.isConnected) this.render(); }); }

  render() {
    const shots = this.shots();
    this.row.innerHTML = "";
    this.info.textContent = shots.length ? `${shots.length} shot${shots.length > 1 ? "s" : ""}` : "";
    if (!shots.length) { this.row.append(el("div.empty-note", {}, "Put some video clips on the timeline to grade them here.")); return; }
    shots.forEach((clip, i) => this.row.append(this.tile(clip, i + 1)));
    this.mark();
  }

  tile(clip, n) {
    const item = M.mediaOf(clip) || {};
    const thumb = el("div.shot-thumb");
    if (item.kind === "image") thumb.style.backgroundImage = `url(api/media/${item.id}/original)`;
    else if (item.thumbs === "ready") {
      const count = item.thumb_count || 1;
      const src = M.srcTime(clip, Math.min(0.5, M.clipDur(clip) / 2));
      const k = count > 1 ? clamp(Math.round(src / Math.max(1e-6, item.duration || 1) * (count - 1)), 0, count - 1) : 0;
      thumb.style.backgroundImage = `url(api/media/${item.id}/thumbs)`;
      thumb.style.backgroundSize = `${count * 100}% 100%`;
      thumb.style.backgroundPosition = count > 1 ? `${k / (count - 1) * 100}% 0` : "0 0";
    }
    const graded = !!gradeUniforms(M.gradeAt(clip, 0)) || !!(clip.grade && clip.grade.lut);
    const track = M.getTrack(clip.trackId);
    const node = el("div.shot", { "data-id": clip.id, title: `${item.name || ""}\n${M.trackLabel(track)} · ${tc(clip.start)}` },
      thumb,
      el("div.shot-meta", {}, el("span.shot-n", {}, String(n).padStart(2, "0")), el("span", {}, M.trackLabel(track)),
        graded ? el("span.shot-graded", { title: "Graded" }, "●") : null, clip.grade?.match && clip.grade.match.on !== false ? el("span.shot-graded", { title: "Shot matched" }, "≈") : null),
      el("div.shot-tc", {}, tc(clip.start)));
    node.addEventListener("click", (e) => this.pick(clip, e));
    node.addEventListener("contextmenu", (e) => { e.preventDefault(); this.menu(e, clip); });
    return node;
  }

  pick(clip, e) {
    if (e.ctrlKey || e.metaKey || e.shiftKey) { M.select([clip.id], { toggle: true }); return; }
    M.select([clip.id]);
    this.app.playback.pause();
    // show the shot: its middle, or the playhead if that is already inside it
    if (!(state.playhead >= clip.start && state.playhead < M.clipEnd(clip))) this.app.playback.seek(clip.start + Math.min(M.clipDur(clip) / 2, 1));
  }

  mark() {
    const cur = this.current()?.id;
    const sel = new Set(state.selection || []);
    for (const n of this.row.querySelectorAll(".shot")) {
      n.classList.toggle("current", n.dataset.id === cur);
      n.classList.toggle("selected", sel.has(n.dataset.id));
    }
    const curNode = this.row.querySelector(".shot.current");
    if (curNode && !this.scrolled) { curNode.scrollIntoView({ block: "nearest", inline: "nearest" }); }
  }

  selectedShots(except) {
    const ids = new Set(state.selection || []);
    return this.shots().filter(c => ids.has(c.id) && c.id !== except.id);
  }

  menu(e, ref) {
    const targets = this.selectedShots(ref);
    const many = targets.length > 1 ? `${targets.length} selected shots` : "the selected shot";
    showMenu(e.clientX, e.clientY, [
      { head: "Shot" },
      { label: targets.length ? `Match ${many} to this shot` : "Match to this shot (select the shots to change first)", disabled: !targets.length,
        action: () => { if (targets.length) this.match(targets, ref); } },
      { label: targets.length ? `Copy this grade to ${many}` : "Copy this grade (select shots first)", disabled: !targets.length,
        action: () => { if (targets.length) this.copyGrade(ref, targets); } },
      { label: "Grade this shot", action: () => this.pick(ref, {}) },
      "-",
      { label: "Clear shot match", disabled: !ref.grade?.match, action: () => ref.grade?.match && M.edit("Clear shot match", () => { const c = M.getClip(ref.id); if (c?.grade) c.grade = { ...c.grade, match: null }; }) },
      { label: "Reset grade", action: () => M.edit("Reset grade", () => { M.clearGradeKeys(ref.id, 0); const c = M.getClip(ref.id); if (c) c.grade = M.defaultGrade(); }) },
    ]);
  }

  copyGrade(ref, targets) {
    const g = JSON.parse(JSON.stringify(M.gradeAt(ref, 0)));
    M.edit("Copy grade", () => { for (const t of targets) { M.clearGradeKeys(t.id, 0); const c = M.getClip(t.id); if (c) c.grade = JSON.parse(JSON.stringify(g)); } });
    toast(`Grade copied to ${targets.length} shot${targets.length > 1 ? "s" : ""}`);
  }

  // Shot match: each target's graded picture (without its old match) is measured against the reference's final
  // picture, per channel (mean and spread), and a gain and offset bring the target's to the reference's.
  async match(targets, ref) {
    toast("Measuring the shots…");
    try {
      const want = await this.measure(ref, true);
      const refName = (M.mediaOf(ref)?.name || "shot").replace(/\.[^.]+$/, "");
      const results = [];
      for (const t of targets) {
        const have = await this.measure(t, false);
        const gain = [0, 1, 2].map(c => clamp(want.std[c] / Math.max(1e-3, have.std[c]), 0.5, 2));
        const offset = [0, 1, 2].map(c => clamp(want.mean[c] - gain[c] * have.mean[c], -0.5, 0.5));
        results.push([t.id, { on: true, gain: gain.map(v => +v.toFixed(4)), offset: offset.map(v => +v.toFixed(4)), ref: refName, refId: ref.id }]);
      }
      M.edit("Shot match", () => { for (const [id, match] of results) { const c = M.getClip(id); if (c) c.grade = { ...M.mergeGrade(c.grade), match }; } });
      toast(`Matched ${results.length} shot${results.length > 1 ? "s" : ""} to ${refName}`);
    } catch (err) {
      console.warn("shot match", err);
      toast(`Couldn't measure the shots: ${err.message || err}`, "error");
    }
  }

  // Mean and standard deviation of r, g, b over a few frames of a shot, as the viewer draws it.
  async measure(clip, withMatch) {
    const item = M.mediaOf(clip);
    if (!item) throw new Error("the shot's media is missing");
    const aspect = item.width && item.height ? item.height / item.width : 9 / 16;
    const w = MEASURE, h = Math.max(8, Math.round(MEASURE * aspect));
    if (!this.r) { this.canvas = document.createElement("canvas"); this.r = new Renderer(this.canvas); }
    this.canvas.width = w; this.canvas.height = h;
    const sums = [0, 0, 0], sq = [0, 0, 0];
    let n = 0;
    const source = await this.sourceFor(item);
    try {
      for (const f of (item.kind === "image" ? [0.5] : SAMPLES)) {
        const tau = M.clipDur(clip) * f;
        if (item.kind !== "image") await this.seek(source, M.srcTime(clip, tau));
        const g = JSON.parse(JSON.stringify(M.gradeAt(clip, tau)));
        if (!withMatch) g.match = null;
        let lut = null;
        if (g.lut && g.enabled !== false) {
          await new Promise(res => { ensureLut(this.r, g.lut, res); if (this.r.hasLut(g.lut)) res(); setTimeout(res, 3000); });
          lut = this.r.hasLut(g.lut) ? { name: g.lut, mix: clamp(g.lutMix ?? 1, 0, 1) } : null;
        }
        const gl = this.r.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.BLEND);
        if (source.__version !== undefined) source.__version++;
        this.r.drawLayer({ source, center: [w / 2, h / 2], size: [w, h], rotation: 0, uv: [0, 0, 1, 1], alpha: 1, grade: gradeUniforms(g), lut,
                           level: M.levelAt(clip, tau) || [1, 1, 1] }, [w, h]);
        const d = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
        for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { const v = d[i + c] / 255; sums[c] += v; sq[c] += v * v; }
        n += w * h;
      }
    } finally { if (source.tagName === "VIDEO") { source.removeAttribute("src"); source.load(); } }
    const mean = sums.map(s => s / n);
    const std = sq.map((s, c) => Math.sqrt(Math.max(0, s / n - mean[c] * mean[c])));
    return { mean, std };
  }

  async sourceFor(item) {
    if (item.kind === "image") {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.src = `api/media/${item.id}/original`;
      await im.decode();
      const c = document.createElement("canvas");
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext("2d").drawImage(im, 0, 0);
      c.__version = 1;
      return c;
    }
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto"; v.crossOrigin = "anonymous";
    v.src = this.app.playback.url(item, false, "video");
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error("the shot's video could not be loaded")); setTimeout(() => rej(new Error("the shot's video took too long to load")), 15000); });
    return v;
  }
  seek(v, t) {
    return new Promise((res) => {
      const done = () => { v.removeEventListener("seeked", done); requestAnimationFrame(() => res()); };
      v.addEventListener("seeked", done);
      v.currentTime = Math.max(0, Math.min(t, (v.duration || t) - 0.01));
      setTimeout(done, 4000);
    });
  }
}
