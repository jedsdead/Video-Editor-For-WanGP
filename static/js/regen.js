// Shot regeneration: the dialog that sets up a regeneration, and the job tracker that turns finished generations into
// takes on their clips. Generations run in WanGP's main queue (see regen.py / host.py).
import * as M from "./model.js";
import { applyRender } from "./finalrender.js";
import { state, P, bus } from "./model.js";
import { api, el, modal, toast, timecode, clamp } from "./util.js";

const PREFS = "ve_regen_prefs";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS) || "{}"); } catch (_) { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS, JSON.stringify({ ...loadPrefs(), ...p })); } catch (_) { /* storage blocked */ } };

// A clip can be regenerated when its original material is a WanGP generation.
export function canRegenerate(clip) {
  if (!clip || M.trackKind(clip.trackId) !== "video" || M.isStill(clip)) return false;
  const item = P().media[M.originalOf(clip).mediaId];
  return !!(item && item.kind === "video" && item.has_metadata);
}

// ------------------------------------------------------------------ jobs
const isHeld = (p) => p && (p.kind === "masked" || p.kind === "both");

export class RegenJobs {
  constructor(app) {
    this.app = app;
    this.jobs = [];
    this.applying = new Set();
    this.liveSeen = new Map();
    this.timer = null;
    bus.on("project", () => this.poll());
    this.poll();
  }

  markLive(job) {
    const m = P().media[job.liveMedia.id];
    if (m) m.liveJob = job.id;
    else job.liveMedia.liveJob = job.id;
  }

  forClip(clipId) { return this.jobs.filter(j => (j.clipId === clipId || (j.parts || []).some(p => p.clipId === clipId)) && ["queued", "running", "error"].includes(j.status)); }
  pending() { return this.jobs.filter(j => j.status === "queued" || j.status === "running"); }

  schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.poll(), ms); }

  async poll() {
    if (!P()) { this.schedule(3000); return; }
    let data;
    try { data = await api(`api/regen/jobs?project=${encodeURIComponent(P().name || "")}`); }
    catch (_) { this.schedule(5000); return; }
    const before = JSON.stringify(this.jobs.map(j => [j.id, j.status, Math.round((j.progress || 0) * 100)]));
    this.jobs = data.jobs || [];
    for (const job of this.jobs) {
      if (job.status === "done" && job.media && !this.applying.has(job.id)) this.apply(job);
      else if (job.kind === "compose" && job.liveMedia && !this.applying.has(job.id)) {
        if (job.status === "running" && job.liveWindows > (this.liveSeen.get(job.id) || 0)) {
          this.liveSeen.set(job.id, job.liveWindows);
          this.markLive(job);
          this.applyCompose(job, { live: true });
        } else if (job.status === "cancelled" || job.status === "error") {
          // stopped part-way: keep the windows it finished
          this.markLive(job);
          this.applyCompose({ ...job, media: job.liveMedia }).then(() => toast(`Stopped after ${job.liveWindows} window${job.liveWindows > 1 ? "s" : ""}: kept what was finished`, "warn"));
        }
      }
    }
    if (JSON.stringify(this.jobs.map(j => [j.id, j.status, Math.round((j.progress || 0) * 100)])) !== before) bus.emit("regen-jobs");
    this.schedule(this.pending().length ? 1500 : 6000);
  }

  // A finished generation becomes a take on its clip (or, for an extension without the original frames, a clip after it).
  async apply(job) {
    if (job.kind === "compose") return this.applyCompose(job);
    if (job.kind === "render") {
      this.applying.add(job.id);
      applyRender(this.app, job);
      try { await api(`api/regen/jobs/${job.id}/dismiss`, { method: "POST" }); } catch (_) { /* kept for next time */ }
      this.jobs = this.jobs.filter(j => j.id !== job.id);
      bus.emit("regen-jobs");
      return;
    }
    this.applying.add(job.id);
    const app = this.app;
    app.bin.register([job.media], null);
    const clip = M.getClip(job.clipId);
    const item = job.media;
    if (!clip) {
      toast(`Regenerated shot ready: ${item.name} (its clip is gone, so it was added to the Media panel)`);
    } else {
      const orig = M.originalOf(clip);
      const shotLen = orig.out - orig.in;
      const dur = item.duration || shotLen;
      const seedText = job.seed != null ? ` · seed ${job.seed}` : "";
      if (job.mode === "extend" && dur < shotLen + job.extra * 0.5) {
        // the model returned only the new frames: place them right after the shot
        M.edit("Add extension", () => {
          const c = M.getClip(job.clipId);
          const placed = M.placeMedia(P().media[item.id], c.trackId, M.clipEnd(c));
          for (const p of placed) p.name = `${c.name || "Shot"} · extension`;
        });
        toast("Extension added after the shot");
      } else {
        const length = job.mode === "extend" ? Math.min(dur, shotLen + (job.extra || 0)) : Math.min(dur, Math.max(job.length || shotLen, M.frameDur()));
        const n = (clip.takes?.length || 1) + 1;
        M.edit("Add take", () => M.addTake(job.clipId, { mediaId: item.id, length, label: `Take ${n}${job.mode === "extend" ? " (extended)" : ""}`,
          seed: job.seed, audio: job.audio, jobId: job.id }));
        toast(`Take ${n} added to ${clip.name || "the clip"}${seedText}`);
      }
    }
    try { await api(`api/regen/jobs/${job.id}/dismiss`, { method: "POST" }); } catch (_) { /* kept for next time */ }
    this.jobs = this.jobs.filter(j => j.id !== job.id);
    bus.emit("regen-jobs");
  }

  // Timeline generations: trim off the pinned frames, move the neighbours' cuts to where the take joins them, then
  // place the take (a new clip, or a new take on the clip already generated for that slot) and rate its joins.
  // live: the windows a sliding-window run has finished so far (job.liveMedia), shown as one growing clip. The
  // finished file (or, if the run was stopped, the last windows it finished) then takes the clip over.
  async applyCompose(job, { live = false } = {}) {
    if (!live) this.applying.add(job.id);
    const app = this.app;
    const media = live ? job.liveMedia : job.media;
    app.bin.register([media], null);
    const item = P().media[media.id] || media;
    const dur = item.duration || 0;
    // on the file's own frame grid: a duration rounded to 0.1 ms would otherwise put every later cut a hair off it
    const ff = item.fps || M.fps(), onGrid = (x) => Math.round(x * ff) / ff;
    const inT = onGrid(Math.min(job.trimHead || 0, Math.max(0, dur - 1 / ff)));
    const outT = Math.max(inT + 1 / ff, onGrid(dur - (job.trimTail || 0)));
    const length = outT - inT;
    const left = job.left && M.getClip(job.left.clipId), right = job.right && M.getClip(job.right.clipId);
    const joins = (job.left?.cut != null || job.right?.cut != null) ? {
      left: job.left?.cut != null ? { clipId: job.left.clipId, mediaId: job.left.mediaId, cut: job.left.cut } : null,
      right: job.right?.cut != null ? { clipId: job.right.clipId, mediaId: job.right.mediaId, cut: job.right.cut } : null } : null;
    const lineage = { mode: job.mode, parent: job.left?.clipId || null, child: job.right?.clipId || null, jobId: job.id, seed: job.seed, pins: job.pins, joins };
    let target = null, placedNote = "", placedNew = false;
    const targetId = job.request?.targetId;
    const liveClip = P().clips.find(c => c.live === job.id && M.trackKind(c.trackId) === "video");
    if (liveClip) {
      M.edit(live ? "Live generation" : `Add ${job.mode}`, () => {
        M.replaceMedia(liveClip.id, item.id, inT, outT);
        if (!live) for (const c of P().clips) if (c.live === job.id) {
          delete c.live;
          if (job.mode === "new") c.name = job.status === "done" ? item.name : `New shot (${job.liveWindows} window${job.liveWindows > 1 ? "s" : ""}, stopped)`;
        }
      }, { coalesceKey: live ? `live-${job.id}` : null });
      if (live) return;
      target = M.getClip(liveClip.id);
      placedNew = true;
      this.dropLiveMedia(job.id, item.id);
    } else if (live && (job.mode === "replace" || (job.mode === "new" ? !!targetId : !!M.generatedIn(job.mode, lineage.parent, lineage.child)))) {
      return;   // a new take on an existing clip: shown when it's done
    } else if ((job.left && !left) || (job.right && !right) || (job.mode === "replace" && !M.getClip(job.request?.replaceId)) || (targetId && !M.getClip(targetId))) {
      toast(`A ${job.mode} generation finished, but the clips it joins have changed; it was added to the Media panel`, "warn");
    } else {
      M.edit(`Add ${job.mode}`, () => {
        // the cuts the pins were taken at (latent grade may have moved them onto H3's grid)
        if (left && job.left.cut != null && Math.abs(job.left.cut - Math.max(left.in, left.out)) > 1e-4) M.setCutSource(left.id, "end", job.left.cut);
        if (right && job.right.cut != null && Math.abs(job.right.cut - Math.min(right.in, right.out)) > 1e-4) M.setCutSource(right.id, "start", job.right.cut);
        const takeLabel = (c) => `Take ${(c.takes?.length || 1) + 1}`;
        if (job.mode === "replace") {
          target = M.getClip(job.request.replaceId);
          const take = M.addTake(target.id, { mediaId: item.id, in: inT, length, label: takeLabel(target), seed: job.seed, audio: "new", jobId: job.id });
          if (take) take.joins = joins;
          target.gen = { ...lineage, mode: "replace" };
          return;
        }
        const existing = job.mode === "new" ? (targetId ? M.getClip(targetId) : null) : M.generatedIn(job.mode, lineage.parent, lineage.child);
        if (existing) {
          target = existing;
          const take = M.addTake(existing.id, { mediaId: item.id, in: inT, length, label: takeLabel(existing), seed: job.seed, audio: "new", jobId: job.id });
          if (take) take.joins = joins;
          if (existing.gen) existing.gen.joins = joins;
          placedNote = " as a new take";
          return;
        }
        const L = left && M.getClip(left.id), R = right && M.getClip(right.id);
        let at, room = 0;
        if (job.mode === "new") {
          at = Math.max(0, +job.request?.at || 0);
          const gap = M.gapAt(job.trackId, at);
          room = gap && Number.isFinite(gap.end) ? Math.max(0, gap.end - at) : Infinity;
        } else if (job.mode === "prepend") at = R.start;
        else if (job.mode === "fill") {
          const gap = M.gapAt(job.trackId, L ? M.clipEnd(L) + 1e-4 : Math.max(0, R.start - 1e-4));
          at = gap ? gap.start : (L ? M.clipEnd(L) : R.start);
          room = gap && Number.isFinite(gap.end) ? gap.end - gap.start : 0;
        } else at = M.clipEnd(L);
        const clips = M.insertMedia(item, job.trackId, at, inT, outT, { room, close: job.mode === "fill" });
        placedNew = true;
        for (const c of clips) {
          c.gen = lineage; c.name = job.mode === "new" ? (live ? "New shot (generating…)" : item.name) : `${(L || R)?.name?.split(" · ")[0] || item.name} · ${job.mode}`;
          if (live) c.live = job.id;
        }
        target = clips[0];
      });
      if (live) { toast(`${job.mode[0].toUpperCase() + job.mode.slice(1)}: window ${job.liveWindows} is on the timeline; the rest follow as WanGP finishes them`); return; }
      if (target && placedNew && job.request?.splitWindows) {
        // one clip per sliding window (the first keeps the joins and lineage)
        await this.splitWindows(target.id, { quiet: true });
        target = M.getClip(target.id) || target;
      }
      if (target) {
        const tid = target.id;
        M.edit("Blend the joins", () => this.crossfadeJoins(job, M.getClip(tid)), { coalesceKey: `xf-${job.id}` });
        M.select([tid]);
        toast(`${job.mode[0].toUpperCase() + job.mode.slice(1)} added${placedNote} · seed ${job.seed}`);
        this.rateSeams(tid);
        if ((job.request?.joinMatch ?? job.request?.levelLock) !== false) this.matchJoins(tid);
        else M.edit("Join match", () => { const l = M.getClip(tid); if (l) delete l.level; });
      }
    }
    try { await api(`api/regen/jobs/${job.id}/dismiss`, { method: "POST" }); } catch (_) { /* kept for next time */ }
    this.jobs = this.jobs.filter(j => j.id !== job.id);
    bus.emit("regen-jobs");
  }

  // The interim files a live run showed, once nothing uses them any more.
  dropLiveMedia(jobId, keepId) {
    const used = new Set(P().clips.map(c => c.mediaId));
    const stale = Object.values(P().media).filter(m => m.liveJob === jobId && m.id !== keepId && !used.has(m.id));
    if (stale.length) { for (const m of stale) delete P().media[m.id]; bus.emit("media"); }
  }

  // Split a WanGP clip where its sliding windows meet (from the add-on's saved windows, else its settings).
  async splitWindows(clipId, { quiet = false } = {}) {
    const clip = M.getClip(clipId);
    if (!clip) return 0;
    let info;
    try { info = await api("api/gen/windows", { method: "POST", body: { mediaId: clip.mediaId } }); }
    catch (e) { if (!quiet) toast(e.message, "warn"); return 0; }
    if (!info.cuts.length) { if (!quiet) toast("This clip was made in one window", "warn"); return 0; }
    const live = M.getClip(clipId);
    if (!live) return 0;
    const pieces = M.edit("Split at sliding windows", () => M.splitAtWindows(clipId, info.cuts));
    if (!quiet) toast(pieces.length > 1 ? `Split into ${pieces.length} windows${info.source === "settings" ? " (worked out from its WanGP settings)" : ""}` : "No window boundary falls inside the clip", pieces.length > 1 ? "info" : "warn");
    return pieces.length;
  }

  // Crossfade a join across the frames both sides rendered: a pin inside the run is the new clip's own rendering of
  // the neighbour's frames (trimmed off), so dissolving from the neighbour into it hides the step between the two
  // renderings. Ends at the cut on the way in, starts at it on the way out, so nothing moves. Linear, because the two
  // sides show the same moment. Motion-context pins leave no overlap (only the join frame), so they get none.
  crossfadeJoins(job, clip) {
    if (!clip) return;
    const { prev, next } = M.touchingNeighbours(clip);
    const on = job.request?.crossfade !== false;
    const pinOf = (place) => (job.pins || []).find(p => p.place === place && p.kind !== "history");
    const audioOf = (c) => M.partners(c).find(x => M.trackKind(x.trackId) === "audio");
    const join = (a, b, seconds, align) => {
      const pairs = [[a, b, "dissolve"]];
      const aa = audioOf(a), ab = audioOf(b);
      if (aa && ab && aa.trackId === ab.trackId && Math.abs(M.clipEnd(aa) - ab.start) < M.frameDur() / 2) pairs.push([aa, ab, "a_linear"]);
      for (const [x, y, preset] of pairs) {
        P().transitions = P().transitions.filter(t => !(t.a === x.id && t.b === y.id && t.auto));
        if (on && seconds >= M.frameDur() * 2) {
          const tr = M.addTransition(x.trackId, x, y, preset, seconds, align);
          tr.auto = "crossfade";
        }
      }
    };
    // two renderings of the window exist only for pinned keyframes and for masked windows held from re-encoded pixels;
    // a latent-grade masked window is the neighbour's own latents (a fade there only adds flicker)
    const twoRenderings = (p) => p && p.kind !== "motion" && !(isHeld(p) && p.grade === "latent");
    const before = pinOf("before"), after = pinOf("after");
    if (prev && job.left && prev.id === job.left.clipId) join(prev, clip, twoRenderings(before) ? job.trimHead || 0 : 0, "end");
    if (next && job.right && next.id === job.right.clipId) join(clip, next, twoRenderings(after) ? job.trimTail || 0 : 0, "start");
  }

  // Join match: correct a generated clip's exposure and colour where it meets the footage it joins (its opening, and
  // its closing where it runs into a clip), fading out away from the join. Recorded against the clip's media and
  // source times, so moving or trimming the clip keeps it, and switching takes drops it.
  async matchJoins(clipId) {
    const clip = M.getClip(clipId);
    if (!clip || clip.reverse || M.trackKind(clip.trackId) !== "video") return;
    // only the joins the generation was made to meet (its lineage), never a hard cut into an unrelated clip
    const { prev: p0, next: n0 } = M.touchingNeighbours(clip);
    const g = clip.gen || {};
    const prev = p0 && g.parent === p0.id ? p0 : null, next = n0 && g.child === n0.id ? n0 : null;
    const ask = async (a, b, correct) => {
      if (!a || !b || a.reverse || b.reverse || M.isStill(a) || M.isStill(b)) return null;
      try {
        return await api("api/gen/joinmatch", { method: "POST", body: { a: { mediaId: a.mediaId, end: Math.max(a.in, a.out) }, b: { mediaId: b.mediaId, start: Math.min(b.in, b.out) }, correct } });
      } catch (_) { return null; }
    };
    const exact = (place) => { const p = (g.pins || []).find(x => x.place === place && x.kind !== "history"); return p && isHeld(p) && p.grade === "latent"; };
    const open = exact("before") ? null : await ask(prev, clip, "b"), close = exact("after") ? null : await ask(clip, next, "a");
    const live = M.getClip(clipId);
    if (!live || live.mediaId !== clip.mediaId) return;
    M.edit("Join match", () => {
      const l = M.getClip(clipId);
      l.level = { mediaId: l.mediaId, on: l.level?.on !== false, open: open?.gains ? open : null, close: close?.gains ? close : null,
                  measured: { open: open && { offset: open.offset, noise: open.noise }, close: close && { offset: close.offset, noise: close.noise } } };
    }, { coalesceKey: `lv-${clipId}` });
  }

  // Measure how the clip joins the clips touching it (seamless / soft bump / hard cut).
  async rateSeams(clipId) {
    const clip = M.getClip(clipId);
    if (!clip || M.trackKind(clip.trackId) !== "video") return;
    const { prev, next } = M.touchingNeighbours(clip);
    const seam = {};
    const ask = async (a, b) => {
      try {
        return await api("api/gen/seam", { method: "POST", body: { a: { mediaId: a.mediaId, end: Math.max(a.in, a.out) }, b: { mediaId: b.mediaId, start: Math.min(b.in, b.out) } } });
      } catch (_) { return null; }
    };
    if (prev && !prev.reverse && !clip.reverse) seam.left = await ask(prev, clip);
    if (next && !next.reverse && !clip.reverse) seam.right = await ask(clip, next);
    const live = M.getClip(clipId);
    if (!live) return;
    live.seam = { ...seam, at: Date.now() };
    bus.emit("change");
  }

  async cancel(jobId) {
    try { await api(`api/regen/jobs/${jobId}/cancel`, { method: "POST" }); } catch (e) { toast(e.message, "warn"); }
    this.poll();
  }

  async dismiss(jobId) {
    try { await api(`api/regen/jobs/${jobId}/dismiss`, { method: "POST" }); } catch (e) { toast(e.message, "warn"); }
    this.poll();
  }
}

// ------------------------------------------------------------------ dialog
// preset: "dialog" | "new" | "same" (the quick menu items open the dialog with that seed choice)
export async function openRegenDialog(app, clipId, preset = "dialog") {
  const clip = M.getClip(clipId);
  if (!canRegenerate(clip)) { toast("Only clips generated by WanGP can be regenerated", "warn"); return; }
  const orig = M.originalOf(clip);
  const item = P().media[orig.mediaId];
  const range = [orig.in, orig.out];
  const shotLen = range[1] - range[0];
  const prefs = loadPrefs();
  const { prev, next } = M.touchingNeighbours(clip);
  const activeTake = clip.takes?.[clip.takeIndex || 0];

  let status = { available: false, reason: "Checking…", current: null };
  try { status = await api("api/regen/status"); } catch (_) { /* shown below */ }

  // ---- controls
  const radio = (name, value, label, checked, extra = {}) => {
    const input = el("input", { type: "radio", name, value, checked, ...extra });
    return { input, row: el("label.rrow", {}, input, el("span", {}, label)) };
  };
  const srcClip = radio("rg_src", "clip", "This clip's settings", !prefs.useCurrent || !status.current);
  const srcCurrent = radio("rg_src", "current", status.current ? `Current Media Generator settings (${status.current.name})` : "Current Media Generator settings (open the Video Generator tab first)",
    !!prefs.useCurrent && !!status.current, { disabled: !status.current });
  const modelNote = el("div.dim.small");

  const seedSel = el("select", {},
    el("option", { value: "same" }, "Same seed as the original"),
    activeTake?.seed != null ? el("option", { value: "take" }, `Same seed as the current take (${activeTake.seed})`) : null,
    el("option", { value: "new" }, "New random seed"),
    el("option", { value: "custom" }, "Custom seed…"));
  seedSel.value = preset === "new" ? "new" : preset === "same" ? "same" : (prefs.seed || "new");
  const seedInput = el("input", { type: "number", min: 0, step: 1, style: { width: "130px" }, value: prefs.customSeed || "" });
  const seedNote = el("div.dim.small", {}, "The same seed with a shorter prompt and length gives a new result, not the original shot: the seed only fixes the starting noise.");

  const modeRegen = radio("rg_mode", "regen", "Regenerate the shot", true);
  const modeExtend = radio("rg_mode", "extend", "Extend: continue from the shot's last frames", false);
  const length = el("input", { type: "number", min: 0.5, max: 30, step: 0.1, value: shotLen.toFixed(2), style: { width: "72px" } });
  const extra = el("input", { type: "number", min: 0.5, max: 15, step: 0.5, value: prefs.extra || 2, style: { width: "72px" } });
  const lengthNote = el("div.dim.small");

  const startSel = el("select", {}, el("option", { value: "none" }, "None"), el("option", { value: "first" }, "This shot's first frame"),
    el("option", { value: "prev", disabled: !prev }, prev ? "The previous shot's last frame" : "The previous shot's last frame (no clip touching it)"));
  startSel.value = prefs.start && !(prefs.start === "prev" && !prev) ? prefs.start : "none";
  const endSel = el("select", {}, el("option", { value: "none" }, "None"),
    el("option", { value: "next", disabled: !next }, next ? "The next shot's first frame" : "The next shot's first frame (no clip touching it)"));
  endSel.value = prefs.end === "next" && next ? "next" : "none";
  const startImg = el("img.rgframe"), endImg = el("img.rgframe");

  const audioKeep = radio("rg_audio", "keep", "Keep the shot's audio (the new picture lip-syncs to it)", (prefs.audio || "keep") === "keep");
  const audioNew = radio("rg_audio", "new", "Generate new audio", prefs.audio === "new");
  const audioNote = el("div.dim.small");
  let wantAudio = prefs.audio || "keep";
  audioKeep.input.addEventListener("change", () => { wantAudio = "keep"; });
  audioNew.input.addEventListener("change", () => { wantAudio = "new"; });

  const promptBox = el("textarea.rgprompt", { rows: 12, spellcheck: false });
  const shotsNote = el("div.dim.small");
  const resetPrompt = el("button.small", { onclick: () => { promptBox.value = info?.prompt || ""; } }, "Reset to the shot's prompt");
  const error = el("div.warn");

  const field = (label, ...children) => el("div.rgfield", {}, el("label.rglabel", {}, label), el("div.rgctl", {}, ...children));
  const body = el("div.rgbody", {},
    el("div.dim", { style: { marginBottom: "8px" } }, `${clip.name || item.name} · source ${range[0].toFixed(2)}s – ${range[1].toFixed(2)}s (${shotLen.toFixed(2)}s)`),
    status.available ? null : el("div.warn", { style: { marginBottom: "8px" } }, status.reason || "Regeneration is unavailable"),
    field("Settings", srcClip.row, srcCurrent.row, modelNote),
    field("Seed", el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, seedSel, seedInput), seedNote),
    field("Mode", modeRegen.row, modeExtend.row,
      el("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "4px" } }, el("span.dim", {}, "Length"), length, el("span.dim", {}, "s"),
        el("span.dim", { style: { marginLeft: "12px" } }, "Add"), extra, el("span.dim", {}, "s")), lengthNote),
    field("Start image", startSel, startImg),
    field("End image", endSel, endImg),
    field("Audio", audioKeep.row, audioNew.row, audioNote),
    field("Prompt", promptBox, el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, resetPrompt, shotsNote)),
    error);

  const m = modal({ title: "Regenerate shot", body, buttons: ["spacer", { label: "Cancel" }, { label: "Queue in WanGP", primary: true, id: "btnRegenGo", action: () => { submit(); return false; } }] });
  m.box.classList.add("wide");
  const go = m.box.querySelector("#btnRegenGo");

  let info = null;
  const useCurrent = () => srcCurrent.input.checked;
  const mode = () => (modeExtend.input.checked ? "extend" : "regen");

  const frameRef = (which) => {
    if (which === "first") return { mediaId: orig.mediaId, t: range[0] };
    if (which === "prev" && prev) return { mediaId: prev.mediaId, t: M.srcTime(prev, Math.max(0, M.clipDur(prev) - M.frameDur())) };
    if (which === "next" && next) return { mediaId: next.mediaId, t: M.srcTime(next, 0) };
    return null;
  };
  const preview = (img, ref) => {
    img.hidden = !ref;
    if (ref) img.src = `api/media/${ref.mediaId}/frame?t=${ref.t.toFixed(3)}`;
  };

  const update = () => {
    const caps = info?.capabilities || {};
    const extend = mode() === "extend";
    seedInput.hidden = seedSel.value !== "custom";
    modeExtend.input.disabled = !caps.extend;
    if (!caps.extend && extend) modeRegen.input.checked = true;
    length.disabled = mode() === "extend";
    extra.disabled = mode() !== "extend";
    startSel.disabled = !caps.start || mode() === "extend";
    endSel.disabled = !caps.end;
    const canKeep = !!caps.keepAudio && !!item.has_audio && mode() !== "extend";
    audioKeep.input.disabled = !canKeep;
    // follow the user's choice whenever keeping is possible (it can be unavailable for a moment while loading)
    if (!canKeep) audioNew.input.checked = true;
    else (wantAudio === "keep" ? audioKeep : audioNew).input.checked = true;
    audioNote.textContent = !item.has_audio ? "This clip has no audio." : !caps.keepAudio ? "This model can't generate a picture to a given soundtrack." :
      mode() === "extend" ? "An extension generates new audio for the added part." : "";
    const minS = info?.minSeconds || 0;
    const want = parseFloat(length.value) || shotLen;
    lengthNote.textContent = mode() === "extend"
      ? "The model continues the shot from its last frames (keeping its motion); the result comes back as a longer take, trimmed to the length you asked for."
      : `${want < minS - 1e-3 ? `This model's shortest video is ${minS.toFixed(2)}s, so it will be generated at that length and trimmed. ` : ""}A longer length gives a longer take.`;
    preview(startImg, startSel.disabled ? null : frameRef(startSel.value));
    preview(endImg, endSel.disabled ? null : frameRef(endSel.value));
    go.disabled = !status.available || !info;
  };

  const prepare = async () => {
    error.textContent = "";
    modelNote.textContent = "Loading…";
    try {
      const keep = promptBox.value && info && promptBox.value !== info.prompt;   // keep the user's edits
      info = await api("api/regen/prepare", { method: "POST", body: { mediaId: orig.mediaId, range, useCurrent: useCurrent() } });
      modelNote.textContent = `Model: ${info.model.name}`;
      for (const r of info.refmods || []) {
        const line = r.status === "relinked" ? `RefMod '${r.mod}' has moved since this clip was made: using ${r.now}.`
          : r.status === "ambiguous" ? `RefMod '${r.mod}' isn't where this clip expects it, and several files have that name (${r.candidates.join(", ")}). Move it back or use the Media Generator settings.`
          : `RefMod '${r.mod}' can't be found in the RefMods folder, so it will be skipped.`;
        modelNote.append(el(r.status === "relinked" ? "div" : "div.warn", {}, line));
      }
      if (!keep) promptBox.value = info.prompt;
      shotsNote.textContent = info.shots.length ? `Built from ${info.shots.map(s => `window ${s.window} shot ${s.shot}`).join(", ")} of the original prompt, retimed to start at 00:00.` :
        "The original prompt has no shot list, so this is its text for this part of the clip.";
      const orig0 = info.originalSeed;
      seedSel.options[0].textContent = orig0 != null ? `Same seed as the original (${orig0})` : "Same seed as the original";
    } catch (e) { info = null; modelNote.textContent = ""; error.textContent = e.message; }
    update();
  };

  for (const r of [srcClip.input, srcCurrent.input]) r.addEventListener("change", prepare);
  for (const c of [seedSel, modeRegen.input, modeExtend.input, startSel, endSel, audioKeep.input, audioNew.input, length]) c.addEventListener("change", update);

  async function submit() {
    if (!info) return;
    const seedChoice = seedSel.value;
    let seed = "new";
    if (seedChoice === "same") seed = info.originalSeed ?? "new";
    else if (seedChoice === "take") seed = activeTake?.seed ?? "new";
    else if (seedChoice === "custom") {
      seed = parseInt(seedInput.value, 10);
      if (!Number.isFinite(seed) || seed < 0) { error.textContent = "Enter a seed of 0 or more"; return; }
    }
    const req = {
      project: P().name, clipId: clip.id, mediaId: orig.mediaId, range, useCurrent: useCurrent(), seed, mode: mode(),
      length: clamp(parseFloat(length.value) || shotLen, 0.1, 60), extra: clamp(parseFloat(extra.value) || 2, 0.5, 30),
      startImage: startSel.disabled ? null : frameRef(startSel.value), endImage: endSel.disabled ? null : frameRef(endSel.value),
      audio: audioKeep.input.checked && !audioKeep.input.disabled ? "keep" : "new", prompt: promptBox.value,
    };
    savePrefs({ useCurrent: req.useCurrent, seed: seedChoice === "take" ? "same" : seedChoice, customSeed: seedInput.value, start: startSel.value, end: endSel.value,
      audio: req.audio, extra: req.extra });
    go.disabled = true;
    try {
      const job = await api("api/regen/submit", { method: "POST", body: req });
      toast(`Queued in WanGP (seed ${job.seed}). The result arrives as a new take on this clip.`);
      m.close();
      app.regen.poll();
    } catch (e) { error.textContent = e.message; go.disabled = false; }
  }

  update();
  prepare();
}
