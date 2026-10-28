// Shot regeneration: the dialog that sets up a regeneration, and the job tracker that turns finished generations into
// takes on their clips. Generations run in WanGP's main queue (see regen.py / host.py).
import * as M from "./model.js";
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
export class RegenJobs {
  constructor(app) {
    this.app = app;
    this.jobs = [];
    this.applying = new Set();
    this.timer = null;
    bus.on("project", () => this.poll());
    this.poll();
  }

  forClip(clipId) { return this.jobs.filter(j => j.clipId === clipId && ["queued", "running", "error"].includes(j.status)); }
  pending() { return this.jobs.filter(j => j.status === "queued" || j.status === "running"); }

  schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.poll(), ms); }

  async poll() {
    if (!P()) { this.schedule(3000); return; }
    let data;
    try { data = await api(`api/regen/jobs?project=${encodeURIComponent(P().name || "")}`); }
    catch (_) { this.schedule(5000); return; }
    const before = JSON.stringify(this.jobs.map(j => [j.id, j.status, Math.round((j.progress || 0) * 100)]));
    this.jobs = data.jobs || [];
    for (const job of this.jobs) if (job.status === "done" && job.media && !this.applying.has(job.id)) this.apply(job);
    if (JSON.stringify(this.jobs.map(j => [j.id, j.status, Math.round((j.progress || 0) * 100)])) !== before) bus.emit("regen-jobs");
    this.schedule(this.pending().length ? 1500 : 6000);
  }

  // A finished generation becomes a take on its clip (or, for an extension without the original frames, a clip after it).
  async apply(job) {
    if (job.kind === "compose") return this.applyCompose(job);
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
  async applyCompose(job) {
    this.applying.add(job.id);
    const app = this.app;
    app.bin.register([job.media], null);
    const item = P().media[job.media.id] || job.media;
    const dur = item.duration || 0;
    const inT = Math.min(job.trimHead || 0, Math.max(0, dur - M.frameDur()));
    const outT = Math.max(inT + M.frameDur(), dur - (job.trimTail || 0));
    const length = outT - inT;
    const left = job.left && M.getClip(job.left.clipId), right = job.right && M.getClip(job.right.clipId);
    const lineage = { mode: job.mode, parent: job.left?.clipId || null, child: job.right?.clipId || null, jobId: job.id, seed: job.seed, pins: job.pins };
    let target = null, placedNote = "";
    const targetId = job.request?.targetId;
    if ((job.left && !left) || (job.right && !right) || (job.mode === "replace" && !M.getClip(job.request?.replaceId)) || (targetId && !M.getClip(targetId))) {
      toast(`A ${job.mode} generation finished, but the clips it joins have changed; it was added to the Media panel`, "warn");
    } else {
      M.edit(`Add ${job.mode}`, () => {
        // the cuts the pins were taken at (latent grade may have moved them onto H3's grid)
        if (left && job.left.cut != null && Math.abs(job.left.cut - Math.max(left.in, left.out)) > 1e-4) M.setCutSource(left.id, "end", job.left.cut);
        if (right && job.right.cut != null && Math.abs(job.right.cut - Math.min(right.in, right.out)) > 1e-4) M.setCutSource(right.id, "start", job.right.cut);
        const takeLabel = (c) => `Take ${(c.takes?.length || 1) + 1}`;
        if (job.mode === "replace") {
          target = M.getClip(job.request.replaceId);
          M.addTake(target.id, { mediaId: item.id, in: inT, length, label: takeLabel(target), seed: job.seed, audio: "new", jobId: job.id });
          target.gen = { ...lineage, mode: "replace" };
          return;
        }
        const existing = job.mode === "new" ? (targetId ? M.getClip(targetId) : null) : M.generatedIn(job.mode, lineage.parent, lineage.child);
        if (existing) {
          target = existing;
          M.addTake(existing.id, { mediaId: item.id, in: inT, length, label: takeLabel(existing), seed: job.seed, audio: "new", jobId: job.id });
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
        for (const c of clips) { c.gen = lineage; c.name = job.mode === "new" ? item.name : `${(L || R)?.name?.split(" · ")[0] || item.name} · ${job.mode}`; }
        target = clips[0];
      });
      if (target) {
        M.select([target.id]);
        toast(`${job.mode[0].toUpperCase() + job.mode.slice(1)} added${placedNote} · seed ${job.seed}`);
        this.rateSeams(target.id);
      }
    }
    try { await api(`api/regen/jobs/${job.id}/dismiss`, { method: "POST" }); } catch (_) { /* kept for next time */ }
    this.jobs = this.jobs.filter(j => j.id !== job.id);
    bus.emit("regen-jobs");
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
