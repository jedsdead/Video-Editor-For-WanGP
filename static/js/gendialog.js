// Timeline generations: extend a clip, prepend to one, bridge two, replace a clip between its neighbours, fill a gap
// or loop the end back to the start. The neighbouring clips' frames are pinned into the generation as fixed context
// (latent grade when WanGP saved their latents, otherwise re-encoded from the file) and trimmed off the result, so the
// new clip continues out of / runs into them. Results come back as clips (or takes) placed by RegenJobs.applyCompose.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { api, el, modal, toast, clamp, debounce } from "./util.js";

const PREFS = "ve_gen_prefs";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS) || "{}"); } catch (_) { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS, JSON.stringify({ ...loadPrefs(), ...p })); } catch (_) { /* storage blocked */ } };

export const MODE_LABEL = { extend: "Extend", prepend: "Prepend", bridge: "Bridge", replace: "Replace", fill: "Fill gap", loop: "Loop" };

// Which clips a mode pins, from where the user asked. Returns {left, right, anchor, trackId, gap} or a reason.
export function sides(mode, { clipId = null, trackId = null, t = null } = {}) {
  const clip = clipId ? M.getClip(clipId) : null;
  trackId = trackId || clip?.trackId;
  if (!trackId || M.trackKind(trackId) !== "video") return { reason: "Generations work on video tracks" };
  const touch = clip ? M.touchingNeighbours(clip) : {};
  const list = M.clipsOn(trackId).filter(c => !M.isStill(c));
  if (mode === "extend") return { left: clip, right: null, anchor: clip, trackId };
  if (mode === "prepend") return { left: null, right: clip, anchor: clip, trackId };
  if (mode === "bridge") return touch.next ? { left: clip, right: touch.next, anchor: clip, trackId } : { reason: "No clip right after this one to bridge into" };
  if (mode === "replace") {
    if (!touch.prev && !touch.next) return { reason: "Replace needs a clip touching this one on at least one side" };
    return { left: touch.prev || null, right: touch.next || null, anchor: clip, trackId, replace: clip };
  }
  if (mode === "fill") {
    const gap = M.gapAt(trackId, t);
    if (!gap || (!gap.prev && !gap.next)) return { reason: "Right-click empty space between clips" };
    return { left: gap.prev, right: gap.next, anchor: gap.prev || gap.next, trackId, gap };
  }
  if (mode === "loop") {
    if (list.length < 1) return { reason: "Nothing on this track to loop" };
    return { left: list[list.length - 1], right: list[0], anchor: list[list.length - 1], trackId };
  }
  return { reason: "Unknown mode" };
}

// Whether a clip can be pinned: plain forward playback of a video file.
export function pinProblem(clip) {
  if (!clip) return null;
  const item = M.mediaOf(clip);
  if (!item || item.kind !== "video") return `${clip.name || "The clip"} isn't a video`;
  if (clip.reverse) return `${clip.name || "The clip"} plays in reverse`;
  if (M.hasSpeedKeys(clip) || Math.abs((clip.speed || 1) - 1) > 1e-6) return `${clip.name || "The clip"} has a speed change`;
  return null;
}

const endSource = (clip) => Math.max(clip.in, clip.out);     // forward clips only (see pinProblem)
const startSource = (clip) => Math.min(clip.in, clip.out);

export async function openGenerate(app, mode, where) {
  if (!P()) return;
  const s = sides(mode, where);
  if (s.reason) { toast(s.reason, "warn"); return; }
  const problem = pinProblem(s.left) || pinProblem(s.right);
  if (problem) { toast(`${problem}, so its frames can't be pinned`, "warn"); return; }
  const prefs = loadPrefs();
  const leftItem = s.left && M.mediaOf(s.left), rightItem = s.right && M.mediaOf(s.right);
  const replaceItem = s.replace && P().media[M.originalOf(s.replace).mediaId];
  const settingsItem = [replaceItem, leftItem, rightItem].find(i => i && i.has_metadata) || null;
  // the prompt starts from the clip the new footage continues (or replaces)
  const promptClip = s.replace || s.left || s.right;
  const promptRange = s.replace ? [M.originalOf(s.replace).in, M.originalOf(s.replace).out]
    : s.left ? [Math.max(startSource(s.left), endSource(s.left) - 0.25), endSource(s.left)]
    : [startSource(s.right), startSource(s.right) + 0.25];
  const gapLen = s.gap && Number.isFinite(s.gap.end) ? s.gap.end - s.gap.start : null;
  const defaultSeconds = s.replace ? M.clipDur(s.replace) : gapLen ?? (prefs.newSeconds || 3);

  let status = { available: false, reason: "Checking…", current: null, h3: {} };
  try { status = await api("api/regen/status"); } catch (_) { /* shown below */ }

  const radio = (name, value, label, checked, extra = {}) => {
    const input = el("input", { type: "radio", name, value, checked, ...extra });
    return { input, row: el("label.rrow", {}, input, el("span", {}, label)) };
  };
  const what = {
    extend: `Continue “${s.left?.name || "the clip"}” from its last frames.`,
    prepend: `Generate what happens before “${s.right?.name || "the clip"}”, running into its first frames.`,
    bridge: `Generate a new piece between “${s.left?.name}” and “${s.right?.name}”, joining both.`,
    replace: `Regenerate “${s.replace?.name}” so it joins ${s.left && s.right ? "both neighbours" : s.left ? "the clip before it" : "the clip after it"}. The result is a new take of it.`,
    fill: `Fill the ${gapLen != null ? gapLen.toFixed(2) + "s " : ""}gap${s.left && s.right ? " between the two clips, joining both" : s.left ? " after the clip" : " before the clip"}.`,
    loop: `Bridge the end of “${s.left?.name}” back into the start of “${s.right?.name}”, so the sequence can loop.`,
  }[mode];

  const windowSel = el("select", {}, [22, 39, 56].map(f => el("option", { value: f }, `${f} frames`)));
  windowSel.value = String(prefs.window || 22);
  const seconds = el("input", { type: "number", min: 0.5, max: 19, step: 0.1, value: (+defaultSeconds).toFixed(2), style: { width: "76px" } });
  const lengthNote = el("div.dim.small");
  const pinsBox = el("div.gpins");
  const keepCut = el("input", { type: "checkbox", checked: !!prefs.keepCut });
  const carryAudio = el("input", { type: "checkbox", checked: prefs.carryAudio !== false });
  const srcClip = radio("g_src", "clip", settingsItem ? "The clip's settings" : "The clip's settings (not a WanGP clip)", !!settingsItem && !prefs.useCurrent, { disabled: !settingsItem });
  const srcCurrent = radio("g_src", "current", status.current ? `Current Media Generator settings (${status.current.name})` : "Current Media Generator settings (open the Video Generator tab first)",
    !settingsItem || !!prefs.useCurrent, { disabled: !status.current });
  const modelNote = el("div.dim.small");
  const seedSel = el("select", {}, el("option", { value: "new" }, "New random seed"), el("option", { value: "same" }, "Same seed as the clip"), el("option", { value: "custom" }, "Custom seed…"));
  seedSel.value = prefs.seed === "custom" ? "custom" : "new";
  const seedInput = el("input", { type: "number", min: 0, step: 1, style: { width: "130px" }, value: prefs.customSeed || "" });
  const promptBox = el("textarea.rgprompt", { rows: 10, spellcheck: false });
  const promptNote = el("div.dim.small");
  const error = el("div.warn");
  const addonNote = status.h3?.installed ? null : el("div.warn", { style: { marginBottom: "8px" } },
    `The editor's H3 add-on isn't active in WanGP${status.h3?.problems?.length ? `: ${status.h3.problems.join("; ")}` : ""}. Restart WanGP after updating the plugin.`);

  const field = (label, ...children) => el("div.rgfield", {}, el("label.rglabel", {}, label), el("div.rgctl", {}, ...children));
  const body = el("div.rgbody", {},
    el("div", { style: { marginBottom: "8px" } }, what),
    status.available ? null : el("div.warn", { style: { marginBottom: "8px" } }, status.reason || "Generation is unavailable"),
    addonNote,
    field("Pinned frames", el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, windowSel, el("span.dim.small", {}, "of each neighbour held as fixed context")),
      pinsBox,
      el("label.rrow", {}, keepCut, el("span", {}, "Keep my exact cuts (pixel grade instead of moving a cut onto H3's grid)")),
      el("label.rrow", {}, carryAudio, el("span", {}, "Carry the pinned audio too"))),
    field("New footage", el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, seconds, el("span.dim", {}, "seconds")), lengthNote),
    field("Settings", srcClip.row, srcCurrent.row, modelNote),
    field("Seed", el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, seedSel, seedInput)),
    field("Prompt", promptBox, promptNote),
    error);
  const m = modal({ title: `${MODE_LABEL[mode]}: generate in WanGP`, body, buttons: ["spacer", { label: "Cancel" }, { label: "Queue in WanGP", primary: true, id: "btnGenGo", action: () => { submit(); return false; } }] });
  m.box.classList.add("wide");
  const go = m.box.querySelector("#btnGenGo");

  let info = null, promptEdited = false;
  promptBox.addEventListener("input", () => { promptEdited = true; });

  const request = () => ({
    project: P().name, mode, trackId: s.trackId, clipId: s.anchor?.id,
    left: s.left ? { clipId: s.left.id, mediaId: s.left.mediaId, cut: endSource(s.left), pixel: keepCut.checked, audio: carryAudio.checked } : null,
    right: s.right ? { clipId: s.right.id, mediaId: s.right.mediaId, cut: startSource(s.right), pixel: keepCut.checked, audio: carryAudio.checked } : null,
    replaceId: s.replace?.id || null,
    gap: s.gap ? { start: s.gap.start, end: Number.isFinite(s.gap.end) ? s.gap.end : null } : null,
    window: parseInt(windowSel.value, 10), newSeconds: clamp(parseFloat(seconds.value) || 3, 0.2, 30),
    useCurrent: srcCurrent.input.checked, settingsFrom: settingsItem?.id || (s.left || s.right).mediaId, promptRange,
  });

  const describePin = (p) => {
    const who = p.place === "before" ? "Previous clip" : "Next clip";
    const fps = info?.fps || 24;
    const grade = p.grade === "latent" ? el("span.grade.latent", {}, "latent grade") : el("span.grade.pixel", {}, "pixel grade");
    const extra = p.grade === "latent" && p.shift ? ` · the cut moves ${(p.shift / fps).toFixed(2)}s ${p.place === "before" ? "earlier" : "later"} onto H3's grid`
      : p.reason ? ` · ${p.reason}` : "";
    return el("div.gpin", {}, el("b", {}, `${who}: `), `${p.frames} frames, `, grade, extra);
  };

  const prepare = debounce(async () => {
    error.textContent = "";
    try {
      info = await api("api/gen/prepare", { method: "POST", body: request() });
      pinsBox.innerHTML = "";
      for (const p of info.pins) pinsBox.append(describePin(p));
      const L = info.lengths;
      lengthNote.textContent = `One run of ${L.totalSeconds.toFixed(2)}s (${L.total} frames): ${L.before ? `${(L.before / info.fps).toFixed(2)}s pinned + ` : ""}${L.newSeconds.toFixed(2)}s new${L.after ? ` + ${(L.after / info.fps).toFixed(2)}s pinned` : ""}. H3 runs in steps of 17 frames, so the new part is the nearest legal length.`;
      modelNote.textContent = `Model: ${info.model.name}`;
      for (const r of info.refmods || []) modelNote.append(el(r.status === "relinked" ? "div" : "div.warn", {},
        r.status === "relinked" ? `RefMod '${r.mod}' has moved: using ${r.now}.` : `RefMod '${r.mod}' can't be found, so it will be skipped.`));
      if (!promptEdited) promptBox.value = info.prompt || "";
      promptNote.textContent = `Describe the whole run, pinned frames included: ${L.before ? `the first ${(L.before / info.fps).toFixed(2)}s are the previous clip's last frames` : ""}${L.before && L.after ? " and " : ""}${L.after ? `the last ${(L.after / info.fps).toFixed(2)}s are the next clip's first frames` : ""}. Started from ${promptClip?.name || "the clip"}'s prompt.`;
      seedSel.options[1].textContent = info.originalSeed != null ? `Same seed as the clip (${info.originalSeed})` : "Same seed as the clip";
    } catch (e) { info = null; error.textContent = e.message; }
    update();
  }, 200);

  const update = () => {
    seedInput.hidden = seedSel.value !== "custom";
    go.disabled = !info || !status.available || !status.h3?.installed;
  };
  for (const c of [windowSel, seconds, keepCut, carryAudio, srcClip.input, srcCurrent.input]) c.addEventListener("change", prepare);
  seedSel.addEventListener("change", update);

  async function submit() {
    if (!info) return;
    let seed = "new";
    if (seedSel.value === "same") seed = info.originalSeed ?? "new";
    else if (seedSel.value === "custom") {
      seed = parseInt(seedInput.value, 10);
      if (!Number.isFinite(seed) || seed < 0) { error.textContent = "Enter a seed of 0 or more"; return; }
    }
    const req = { ...request(), seed, prompt: promptBox.value };
    savePrefs({ window: req.window, newSeconds: s.gap || s.replace ? prefs.newSeconds : req.newSeconds, keepCut: keepCut.checked, carryAudio: carryAudio.checked,
      useCurrent: req.useCurrent, seed: seedSel.value === "custom" ? "custom" : "new", customSeed: seedInput.value });
    go.disabled = true;
    try {
      const job = await api("api/gen/submit", { method: "POST", body: req });
      toast(`${MODE_LABEL[mode]} queued in WanGP (seed ${job.seed})`);
      m.close();
      app.regen.poll();
    } catch (e) { error.textContent = e.message; go.disabled = false; }
  }

  update();
  prepare();
}

// Reroll: the same generation again with a new seed (from a generated clip's lineage).
export function rerollFor(app, clip) {
  const g = clip?.gen;
  if (!g) return;
  const where = g.mode === "fill" ? { trackId: clip.trackId, t: clip.start } : { clipId: g.mode === "prepend" ? g.child : g.mode === "replace" ? clip.id : g.parent || clip.id };
  if (g.mode === "fill") {
    // the gap is now filled by this clip: regenerate it as a replacement between its neighbours
    openGenerate(app, "replace", { clipId: clip.id });
    return;
  }
  openGenerate(app, g.mode === "replace" ? "replace" : g.mode, where);
}
