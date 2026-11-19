// Timeline generations: extend a clip, prepend to one, bridge two, replace a clip between its neighbours, fill a gap
// or loop the end back to the start. The neighbouring clips' frames are pinned into the generation as fixed context
// (latent grade when WanGP saved their latents, otherwise re-encoded from the file) and trimmed off the result, so the
// new clip continues out of / runs into them. Results come back as clips (or takes) placed by RegenJobs.applyCompose.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { api, el, modal, toast, clamp, debounce, timecode } from "./util.js";
import { ensureGenSettings, genLabel, genOutput } from "./finalrender.js";
import { ImagePick } from "./imagepick.js";

const PREFS = "ve_gen_prefs";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS) || "{}"); } catch (_) { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS, JSON.stringify({ ...loadPrefs(), ...p })); } catch (_) { /* storage blocked */ } };

// The sound switches, written into the prompt: an H3 prompt's own sections are rewritten where it has them, otherwise
// a line is added at the end.
const JOIN_CHECKS_OFF = true;

export function applySound(prompt, o = {}) {
  let p = String(prompt || "");
  const section = (tag, text) => {
    const re = new RegExp(`(<${tag}>)([\\s\\S]*?)(</${tag}>)`, "i");
    if (re.test(p)) { p = p.replace(re, `$1\n${text}\n$3`); return true; }
    return false;
  };
  const lines = [];
  if (o.ambience) {
    section("non_diegetic_music", "N/A");
    if (!section("overall_soundscape", "Only quiet, steady room tone. No music, no voices, no sound effects.")) lines.push("Sound: only quiet room tone; no music, no voices, no sound effects.");
    if (/<d>/i.test(p)) lines.push("Nobody speaks; any lines above are not spoken.");
  } else {
    if (o.noMusic) {
      const had = section("non_diegetic_music", "N/A");
      const m = /<overall_soundscape>([\s\S]*?)<\/overall_soundscape>/i.exec(p);
      if (m && /music|song|score|melod/i.test(m[1])) {
        // the soundscape's sentences that mention music go; the rest stay
        const kept = (m[1].trim().match(/[^.!?]+[.!?]*/g) || []).map(x => x.trim()).filter(Boolean).filter(x => !/music|song|score|melod/i.test(x));
        section("overall_soundscape", `${kept.join(" ")}${kept.length ? " " : ""}No music.`);
      }
      else if (!had) lines.push("No music.");
    }
    if (o.noSpeech) lines.push("Nobody speaks: no dialogue, no voices.");
    if (o.noFx) {
      const m = /<overall_soundscape>([\s\S]*?)<\/overall_soundscape>/i.exec(p);
      if (m) section("overall_soundscape", `${m[1].trim()} Only ambience and voices: no sound effects.`);
      else lines.push("No sound effects: only ambience and voices.");
    }
  }
  return lines.length ? `${p.trimEnd()}\n${lines.join(" ")}` : p;
}

export const MODE_LABEL = { new: "New shot", extend: "Extend", prepend: "Prepend", bridge: "Bridge", replace: "Replace", fill: "Fill gap", loop: "Loop" };

// Which clips a mode pins, from where the user asked. Returns {left, right, anchor, trackId, gap} or a reason.
export function sides(mode, { clipId = null, trackId = null, t = null, targetId = null } = {}) {
  const clip = clipId ? M.getClip(clipId) : null;
  trackId = trackId || clip?.trackId;
  if (!trackId || M.trackKind(trackId) !== "video") return { reason: "Generations work on video tracks" };
  const touch = clip ? M.touchingNeighbours(clip) : {};
  const list = M.clipsOn(trackId).filter(c => !M.isStill(c));
  if (mode === "new") {
    // a shot from nothing, placed where asked (a reroll of one passes the clip as targetId and gets a new take on it)
    const target = targetId ? M.getClip(targetId) : null;
    const at = target ? target.start : Math.max(0, t ?? 0);
    const gap = target ? null : M.gapAt(trackId, at);
    if (!target && !gap) return { reason: "Right-click empty space on a video track" };
    const near = gap ? [gap.prev, gap.next].find(c => c && M.mediaOf(c)?.has_metadata) : M.mediaOf(target)?.has_metadata ? target : null;
    return { left: null, right: null, anchor: target || null, trackId, gap, at, target, near };
  }
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

// preset: {prompt, seconds, blockId, auto} — a block to generate: its prompt and length, and with auto the dialog
// queues itself once it's ready without being shown (it's shown instead if something needs looking at). With auto
// the returned promise gives the job id, or null when it didn't queue.
export async function openGenerate(app, mode, where, preset = {}) {
  if (!P()) return null;
  const s = sides(mode, where);
  if (s.reason) { toast(s.reason, "warn"); return null; }
  const problem = pinProblem(s.left) || pinProblem(s.right);
  if (problem) { toast(`${problem}, so its frames can't be pinned`, "warn"); return null; }
  let resolveAuto = () => {};
  const autoDone = new Promise(r => { resolveAuto = r; });
  const prefs = loadPrefs();
  const leftItem = s.left && M.mediaOf(s.left), rightItem = s.right && M.mediaOf(s.right);
  const replaceItem = s.replace && P().media[M.originalOf(s.replace).mediaId];
  const fresh = mode === "new";
  const settingsItem = fresh ? (s.near ? P().media[M.originalOf(s.near).mediaId] : null) : [replaceItem, leftItem, rightItem].find(i => i && i.has_metadata) || null;
  // the prompt starts from the clip the new footage continues (or replaces)
  const promptClip = s.replace || s.left || s.right;
  const promptRange = fresh ? null : s.replace ? [M.originalOf(s.replace).in, M.originalOf(s.replace).out]
    : s.left ? [Math.max(startSource(s.left), endSource(s.left) - 0.25), endSource(s.left)]
    : [startSource(s.right), startSource(s.right) + 0.25];
  const gapLen = s.gap && Number.isFinite(s.gap.end) ? s.gap.end - s.gap.start : null;
  const roomLen = fresh && s.gap && Number.isFinite(s.gap.end) ? s.gap.end - s.at : null;
  const defaultSeconds = fresh ? (s.target ? M.clipDur(s.target) : roomLen && roomLen > 0.5 && roomLen < 30 ? roomLen : prefs.freshSeconds || 5)
    : s.replace ? M.clipDur(s.replace) : gapLen ?? (prefs.newSeconds || 3);

  const gen = await ensureGenSettings();
  let status = { available: false, reason: "Checking…", current: null, h3: {} };
  try { status = await api("api/regen/status"); } catch (_) { /* shown below */ }

  const radio = (name, value, label, checked, extra = {}) => {
    const input = el("input", { type: "radio", name, value, checked, ...extra });
    return { input, row: el("label.rrow", {}, input, el("span", {}, label)) };
  };
  const what = {
    new: s.target ? `A new take of “${s.target.name}”, generated from scratch with no pinned frames.`
      : `Generate a new shot from scratch and ${P().magnetic && s.trackId === M.primaryId() ? (s.gap?.prev ? "add it after the last clip" : "start the sequence with it") : `place it at ${timecode(s.at, P().fps || 24)}`}. Nothing is pinned, so it doesn't continue from other clips; use Extend, Prepend or Bridge for that.`,
    extend: `Continue “${s.left?.name || "the clip"}” from its last frames.`,
    prepend: `Generate what happens before “${s.right?.name || "the clip"}”, running into its first frames.`,
    bridge: `Generate a new piece between “${s.left?.name}” and “${s.right?.name}”, joining both.`,
    replace: `Regenerate “${s.replace?.name}” so it joins ${s.left && s.right ? "both neighbours" : s.left ? "the clip before it" : "the clip after it"}. The result is a new take of it.`,
    fill: `Fill the ${gapLen != null ? gapLen.toFixed(2) + "s " : ""}gap${s.left && s.right ? " between the two clips, joining both" : s.left ? " after the clip" : " before the clip"}.`,
    loop: `Bridge the end of “${s.left?.name}” back into the start of “${s.right?.name}”, so the sequence can loop.`,
  }[mode];

  const windowSel = el("select", {}, [22, 39, 56].map(f => el("option", { value: f }, `${f} frames`)));
  windowSel.value = String(prefs.window || 22);
  const opt = (v, l) => el("option", { value: v }, l);
  const leaveSel = el("select", {}, opt("motion_masked", "Motion + masked: motion context, then held by the mask (recommended)"),
    opt("both", "Masked + keyframes"), opt("masked", "Masked: held exactly inside the run"), opt("motion", "Motion context: H3's native continuation"),
    opt("pinned", "Pinned keyframes (re-rendered, trimmed)"));
  // Motion + masked became the recommended way to leave a clip: a choice saved while plain motion context was the
  // default moves to it once (a deliberate choice made since is kept)
  if (!prefs.leaveModeV2) { if (!prefs.leaveMode || prefs.leaveMode === "motion") prefs.leaveMode = "motion_masked"; }
  leaveSel.value = prefs.leaveMode || (prefs.pinMode === "pinned" ? "pinned" : "motion_masked");
  const arriveSel = el("select", {}, opt("both", "Masked + keyframes: steer toward it, arrive exactly (recommended)"), opt("masked", "Masked: held exactly inside the run"),
    opt("pinned", "Pinned keyframes (re-rendered, trimmed)"));
  arriveSel.value = prefs.arriveMode || "both";
  const modeNote = el("div.dim.small", {}, "Motion context hands H3 the frames before the cut as history, the way Wan2GP continues a sliding window. Masked holds the neighbour's frames inside the run with a denoise mask (WanGP's Denoise Control Video), so they are never re-drawn and the join has one rendering. Motion + masked does both: the earlier frames go in as history, the last ones are held. Pinned keyframes are re-drawn by the model and trimmed off.");
  const modeRow = (label, sel) => el("div", { style: { display: "flex", gap: "8px", alignItems: "center", margin: "6px 0 2px" } }, el("span.dim.small", { style: { width: "92px" } }, label), sel);
  const seconds = el("input", { type: "number", min: 0.5, max: fresh || !s.right ? 120 : 19, step: 0.1, value: (+(preset.seconds || defaultSeconds)).toFixed(2), style: { width: "76px" } });
  const lengthNote = el("div.dim.small");
  const pinsBox = el("div.gpins");
  const keepCut = el("input", { type: "checkbox", checked: !!prefs.keepCut });
  const carryAudio = el("input", { type: "checkbox", checked: prefs.carryAudio !== false });
  const crossfade = el("input", { type: "checkbox", checked: prefs.crossfade !== false });
  const splitWindows = el("input", { type: "checkbox", checked: !!prefs.splitWindows });
  const splitRow = el("label.rrow", { style: { marginLeft: "22px" } }, splitWindows, el("span", {}, "One clip per sliding window (cut where the windows meet)"));
  const windowJoin = el("input", { type: "checkbox", checked: prefs.windowJoin !== false });
  const joinRow = el("label.rrow", { style: { marginLeft: "22px" }, title: "Each window takes the previous one's last frames as motion context and holds its final 18 frames (and their sound) inside the new window with the denoise mask, so the seam falls inside one rendering. Uses an overlap of at least 35 frames and discards each window's last 4." },
    windowJoin, el("span", {}, "Join the windows as Motion + masked (seamless)"));
  // Sliding windows: on when the length needs more than one window, and also when the prompt sets its own windows
  // ([/duration=...] blocks override the length here), so tick it for those
  const slidingAllowed = !s.right;   // a run arriving on a clip must fit one window
  const sliding = el("input", { type: "checkbox", checked: !!prefs.sliding });
  let slidingTouched = false;
  const slidingOpts = el("div", {}, splitRow, joinRow);
  const slidingRow = el("div", { style: { display: slidingAllowed ? "" : "none" } },
    el("label.rrow", { title: "Run in WanGP's sliding windows. Needed when the prompt sets its own windows with [/duration=...]: the length here is then only a starting point." },
      sliding, el("span", {}, "Sliding windows (several windows, or windows set in the prompt)")), slidingOpts);
  const syncSliding = () => { slidingOpts.style.display = sliding.checked ? "" : "none"; };
  sliding.addEventListener("change", () => { slidingTouched = true; syncSliding(); prepare(); });
  syncSliding();
  const joinMatch = el("input", { type: "checkbox", checked: (prefs.joinMatch ?? prefs.levelLock) !== false });
  const srcClip = radio("g_src", "clip", fresh ? (settingsItem ? `The same settings as “${s.near.name}”` : "A neighbouring clip's settings (none here)") : settingsItem ? "The clip's settings" : "The clip's settings (not a WanGP clip)", !!settingsItem && !prefs.useCurrent, { disabled: !settingsItem });
  const srcCurrent = radio("g_src", "current", status.current ? `Current Media Generator settings (${status.current.name})` : "Current Media Generator settings (open the Video Generator tab first)",
    !settingsItem || !!prefs.useCurrent || fresh, { disabled: !status.current });
  const modelNote = el("div.dim.small");
  const sizeSel = el("select", {}, el("option", { value: "project" }, `Project size: ${genLabel(gen)}`), el("option", { value: "clip" }, "The settings' own size"));
  sizeSel.value = gen && prefs.size !== "clip" ? "project" : "clip";
  if (!gen) sizeSel.options[0].disabled = true;
  const sizeNote = el("div.dim.small");
  const updateSizeNote = () => {
    const out = sizeSel.value === "project" ? genOutput(gen) : null;
    const nb = [s.left, s.right].filter(Boolean).map(c => M.mediaOf(c)).filter(Boolean);
    const odd = out && nb.some(i => i.width && (i.width !== out[0] || i.height !== out[1]));
    sizeNote.textContent = odd ? "The clips it joins are a different size, so their frames are pinned from pixels and this stretch can't be rendered final together with them." : "";
  };
  const seedSel = el("select", {}, el("option", { value: "new" }, "New random seed"), el("option", { value: "same" }, "Same seed as the clip"), el("option", { value: "custom" }, "Custom seed…"));
  seedSel.value = prefs.seed === "custom" ? "custom" : "new";
  const seedInput = el("input", { type: "number", min: 0, step: 1, style: { width: "130px" }, value: prefs.customSeed || "" });
  // Start / end images: the run's first and last frames, where nothing is pinned on that side (a new shot takes both,
  // an extension can end on a picture, a prepend can start from one)
  const wantStart = !s.left, wantEnd = !s.right;
  const startPick = wantStart ? new ImagePick(app, "start", { onChange: () => imagesNote() }) : null;
  const endPick = wantEnd ? new ImagePick(app, "end", { onChange: () => imagesNote() }) : null;
  if (preset.startImage && startPick) startPick.setRef(preset.startImage);
  if (preset.endImage && endPick) endPick.setRef(preset.endImage);
  const imagesNoteEl = el("div.dim.small");
  const imagesNote = () => {
    const caps = info?.capabilities || {};
    const lines = [];
    if (startPick && !caps.start) lines.push("This model can't start from an image.");
    if (endPick && !caps.end) lines.push("This model can't end on an image.");
    const using = (startPick?.value && caps.start) || (endPick?.value && caps.end);
    if (using) lines.push("The images count as the generation's own pictures in the prompt: the start image is <Picture 1> and the end image comes next; RefMod pictures move up after them.");
    if (endPick?.value && caps.end && sliding.checked) lines.push("With sliding windows the end image steers every window and the last one lands on it.");
    imagesNoteEl.textContent = lines.join(" ");
  };
  const imagesField = (startPick || endPick) ? (() => {
    const row = (label, pick) => el("div.imgpick-line", {}, el("span.dim.small", { style: { width: "42px" } }, label), pick.node);
    return el("div", {}, startPick ? row("Start", startPick) : null, endPick ? row("End", endPick) : null, imagesNoteEl);
  })() : null;
  const promptBox = el("textarea.rgprompt", { rows: 10, spellcheck: false });
  const promptNote = el("div.dim.small");
  // sound switches: applied to the prompt as it's sent (the box keeps what you wrote)
  const soundPrefs = loadPrefs().sound || {};
  const sndBox = (key, label, title) => { const i = el("input", { type: "checkbox", checked: !!soundPrefs[key] }); i.dataset.key = key; return el("label.snd", { title }, i, label); };
  const soundRow = el("div.sound-row", {}, sndBox("noMusic", "No music", "Clears the prompt's music section (or adds a line saying so)"),
    sndBox("noSpeech", "No speech", "Nobody speaks: adds a line saying so (dialogue in the prompt is still sent: take it out if it's there)"),
    sndBox("ambience", "Ambience only", "Only quiet room tone: no music, voices or sound effects"),
    sndBox("noFx", "No sound effects", "Keeps the soundscape to ambience and voices"));
  const soundFlags = () => Object.fromEntries([...soundRow.querySelectorAll("input")].map(i => [i.dataset.key, i.checked]));
  const joinBox = el("div.joincheck", { hidden: true });
  const error = el("div.warn");
  const addonNote = status.h3?.installed || fresh ? null : el("div.warn", { style: { marginBottom: "8px" } },
    `The editor's H3 add-on isn't active in WanGP${status.h3?.problems?.length ? `: ${status.h3.problems.join("; ")}` : ""}. Restart WanGP after updating the plugin.`);

  const field = (label, ...children) => el("div.rgfield", {}, el("label.rglabel", {}, label), el("div.rgctl", {}, ...children));
  const body = el("div.rgbody", {},
    el("div", { style: { marginBottom: "8px" } }, what),
    status.available ? null : el("div.warn", { style: { marginBottom: "8px" } }, status.reason || "Generation is unavailable"),
    addonNote,
    fresh ? null : field("Pinned frames", el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, windowSel, el("span.dim.small", {}, "of each neighbour held as fixed context")),
      s.left ? modeRow("Leaving a clip", leaveSel) : null, s.right ? modeRow("Arriving at one", arriveSel) : null, s.left || s.right ? modeNote : null,
      pinsBox,
      el("label.rrow", {}, keepCut, el("span", {}, "Keep my exact cuts (pixel grade instead of moving a cut onto H3's grid)")),
      el("label.rrow", {}, carryAudio, el("span", {}, "Carry the pinned audio too")),
      el("label.rrow", {}, joinMatch, el("span", {}, "Join match: correct the new footage's exposure and colour where it meets the clip it joins, fading out over about half a second")),
      el("label.rrow", {}, crossfade, el("span", {}, "Blend the joins: crossfade across the frames both sides rendered (pinned frames inside the run only)"))),
    field(fresh ? "Length" : "New footage", el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, seconds, el("span.dim", {}, "seconds")), lengthNote, slidingRow),
    imagesField ? field(fresh ? "Start / end images" : wantStart ? "Start image" : "End image", imagesField) : null,
    field("Settings", srcClip.row, srcCurrent.row, modelNote),
    field("Size", sizeSel, sizeNote),
    field("Seed", el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, seedSel, seedInput)),
    field("Prompt", promptBox, promptNote, joinBox),
    field("Sound", soundRow),
    error);
  const m = modal({ title: `${MODE_LABEL[mode]}: generate in WanGP`, body, buttons: ["spacer", { label: "Cancel" }, { label: "Queue in WanGP", primary: true, id: "btnGenGo", action: () => { submit(); return false; } }] });
  m.box.classList.add("wide");
  const go = m.box.querySelector("#btnGenGo");

  let info = null, promptEdited = false;
  if (preset.prompt) { promptBox.value = preset.prompt; promptEdited = true; }
  if (preset.auto) m.box.parentElement.style.display = "none";
  let autoTried = false;
  // Join check: the clip a run leaves shouldn't be cut in the middle of a word (off for now).
  const joinCheck = () => {
    joinBox.innerHTML = "";
    // switched off for now: the prompt-timing check and the move-the-cut-into-the-pause check
    joinBox.hidden = true;
    if (!info || JOIN_CHECKS_OFF) return;
    const rows = [];
    // (the prompt-timing check for continuations — Fix the timings — is switched off for now)
    const sp = info.speech;
    if (sp && sp.speaking) {
      const sg = sp.suggest;
      const left = s.left && M.getClip(s.left.id);
      const move = sg && left ? el("button.small", { onclick: () => {
        // trim the clip being left so the cut lands in the pause
        const end = M.clipEnd(left) - (endSource(left) - sg.request) / Math.abs(left.speed || 1);
        M.edit("Move the cut to a pause", () => M.trimEdge(left.id, "end", end, { snap: false }));
        s.left = M.getClip(left.id);
        toast(`Cut moved ${sg.earlier.toFixed(2)}s earlier, into the pause`);
        prepare();
      } }, `Move the cut ${sg.earlier.toFixed(2)}s earlier, into the pause`) : null;
      rows.push(el("div.jc-row.warn", {}, el("div", {},
        el("div", {}, "Someone is speaking at the cut: the held frames end in the middle of a word, so the new footage starts on a cut-off word."),
        el("div.dim.small", {}, sg ? `There's a pause ${sg.earlier.toFixed(2)}s before it${keepCut.checked ? "" : " that the cut can land on (on H3's grid)"}.`
          : keepCut.checked ? "There's no pause in the last 4 seconds; trim the clip back to one yourself." : "No pause in the last 4 seconds lands on H3's grid; tick Keep my exact cuts to cut on any frame, or trim the clip back yourself.")), move));
    }
    joinBox.hidden = !rows.length;
    joinBox.append(...rows);
  };
  const joinCheckSoon = debounce(joinCheck, 250);
  promptBox.addEventListener("input", () => {
    promptEdited = true;
    joinCheckSoon();
    if (slidingAllowed && !slidingTouched && /\[\s*\/\s*duration/i.test(promptBox.value) && !sliding.checked) { sliding.checked = true; syncSliding(); }
  });

  const request = () => ({
    blockId: preset.blockId || null,
    blockSeconds: preset.blockId ? (+preset.seconds || null) : null,
    project: P().name, mode, trackId: s.trackId, clipId: s.anchor?.id,
    left: s.left ? { clipId: s.left.id, mediaId: s.left.mediaId, cut: endSource(s.left), pixel: keepCut.checked, audio: carryAudio.checked } : null,
    right: s.right ? { clipId: s.right.id, mediaId: s.right.mediaId, cut: startSource(s.right), pixel: keepCut.checked, audio: carryAudio.checked } : null,
    replaceId: s.replace?.id || null,
    gap: s.gap ? { start: s.gap.start, end: Number.isFinite(s.gap.end) ? s.gap.end : null } : null,
    window: parseInt(windowSel.value, 10), leaveMode: leaveSel.value, arriveMode: arriveSel.value, crossfade: crossfade.checked, joinMatch: joinMatch.checked, newSeconds: clamp(parseFloat(seconds.value) || 3, 0.2, 120), sliding: slidingAllowed && sliding.checked,
    splitWindows: slidingAllowed && sliding.checked && splitWindows.checked, windowJoin: slidingAllowed && sliding.checked && windowJoin.checked,
    useCurrent: srcCurrent.input.checked, settingsFrom: settingsItem?.id || (s.left || s.right)?.mediaId || null, promptRange,
    at: s.at ?? null, targetId: s.target?.id || null,
    gen: sizeSel.value === "project" ? gen : null,
    startImage: startPick && !startPick.disabled ? startPick.value : null,
    endImage: endPick && !endPick.disabled ? endPick.value : null,
  });

  const describePin = (p) => {
    const who = p.place === "before" ? "Previous clip" : "Next clip";
    const fps = info?.fps || 24;
    const grade = p.grade === "latent" ? el("span.grade.latent", {}, "latent grade") : el("span.grade.pixel", {}, "pixel grade");
    const extra = (p.grade === "latent" && p.shift ? ` · the cut moves ${(p.shift / fps).toFixed(2)}s ${p.place === "before" ? "earlier" : "later"} onto H3's grid` : "")
      + (p.reason ? ` · ${p.reason}` : "");
    const how = { motion: "as motion context", history: "as motion context (H3 history, before the run)", masked: "held by the mask", both: "held by the mask + keyframes", pinned: "pinned keyframes" }[p.kind] || "";
    const hand = p.handover ? ` · handover ${p.handover} frames inside the window` : "";
    return el("div.gpin", {}, el("b", {}, `${who}: `), `${p.frames} frames ${how}, `, grade, extra, hand);
  };

  const prepare = debounce(async () => {
    error.textContent = "";
    try {
      info = await api("api/gen/prepare", { method: "POST", body: request() });
      pinsBox.innerHTML = "";
      for (const p of info.pins) pinsBox.append(describePin(p));
      const L = info.lengths;
      if (fresh) lengthNote.textContent = `${L.totalSeconds.toFixed(2)}s (${L.total} frames)${(info.windows || 1) > 1 ? `, ${info.windows} sliding windows` : ""}. ${L.note}`;
      const motionPin = info.pins.some(p => p.kind === "motion");
      const windows = info.windows || 1;
      // a length past one window turns sliding windows on (unless you've chosen yourself)
      if (slidingAllowed && !slidingTouched && windows > 1 && !sliding.checked) { sliding.checked = true; syncSliding(); }
      if (!fresh) lengthNote.textContent = `${windows > 1 ? `${windows} sliding windows` : "One run"} of ${L.totalSeconds.toFixed(2)}s (${L.total} frames): ${motionPin ? "the join frame + " : L.before ? `${(L.before / info.fps).toFixed(2)}s pinned + ` : ""}${L.newSeconds.toFixed(2)}s new${L.after ? ` + ${(L.after / info.fps).toFixed(2)}s pinned` : ""}. ${L.note}`;
      modelNote.textContent = `Model: ${info.model.name}`;
      for (const r of info.refmods || []) modelNote.append(el(r.status === "relinked" ? "div" : "div.warn", {},
        r.status === "relinked" ? `RefMod '${r.mod}' has moved: using ${r.now}.` : `RefMod '${r.mod}' can't be found, so it will be skipped.`));
      if (!promptEdited) promptBox.value = info.prompt || "";
      if (slidingAllowed && !slidingTouched && /\[\s*\/\s*duration/i.test(promptBox.value) && !sliding.checked) { sliding.checked = true; syncSliding(); }
      if (fresh) promptNote.textContent = settingsItem && !srcCurrent.input.checked ? `Started from ${s.near.name}'s prompt.` : "Started from the Media Generator's prompt.";
      else if (motionPin) promptNote.textContent = `Describe the run: it starts on the previous clip's last frame and carries on from its motion${L.after ? `; the last ${(L.after / info.fps).toFixed(2)}s are the next clip's first frames` : ""}. Started from ${promptClip?.name || "the clip"}'s prompt.`;
      else promptNote.textContent = `Describe the whole run, pinned frames included: ${L.before ? `the first ${(L.before / info.fps).toFixed(2)}s are the previous clip's last frames` : ""}${L.before && L.after ? " and " : ""}${L.after ? `the last ${(L.after / info.fps).toFixed(2)}s are the next clip's first frames` : ""}. Started from ${promptClip?.name || "the clip"}'s prompt.`;
      seedSel.options[1].textContent = info.originalSeed != null ? `Same seed as the clip (${info.originalSeed})` : "Same seed as the clip";
    } catch (e) { info = null; error.textContent = e.message; }
    joinCheck();
    update();
    // a block run: queue straight away when it's ready, or show the dialog to say why not
    if (preset.auto && !autoTried) {
      autoTried = true;
      // a block's picture that this run can't use: show the dialog rather than generate without it
      const caps = info?.capabilities || {};
      const lost = [preset.endImage && (!endPick || !caps.end || !endPick.value) ? "end" : null,
        preset.startImage && (!startPick || !caps.start || !startPick.value) ? "start" : null].filter(Boolean);
      if (info && lost.length) error.textContent = `This block has a${lost.length > 1 ? " start and end" : `n ${lost[0]}`} image this run can't use: ${!info.capabilities?.[lost[0]] ? `the model (${info.model.name}) doesn't take ${lost[0]} images` : lost[0] === "end" ? "a clip follows it, so the run has to join that instead" : "the image is missing"}. Switch to H3 FL2VA or Ref2VA in the Media Generator, or change the block.`;
      if (info && !go.disabled && !lost.length) submit();
      else { m.box.parentElement.style.display = ""; resolveAuto(null); }
    }
  }, 200);

  const update = () => {
    seedInput.hidden = seedSel.value !== "custom";
    const caps = info?.capabilities;
    if (caps) { if (startPick) startPick.disabled = !caps.start; if (endPick) endPick.disabled = !caps.end; }
    imagesNote();
    go.disabled = !info || !status.available || (!fresh && !status.h3?.installed);
  };
  sizeSel.addEventListener("change", () => { updateSizeNote(); prepare(); });
  updateSizeNote();
  for (const c of [windowSel, leaveSel, arriveSel, seconds, keepCut, carryAudio, srcClip.input, srcCurrent.input]) c.addEventListener("change", prepare);
  seedSel.addEventListener("change", update);

  async function submit() {
    if (!info) return;
    let seed = "new";
    if (seedSel.value === "same") seed = info.originalSeed ?? "new";
    else if (seedSel.value === "custom") {
      seed = parseInt(seedInput.value, 10);
      if (!Number.isFinite(seed) || seed < 0) { error.textContent = "Enter a seed of 0 or more"; return; }
    }
    const req = { ...request(), seed, prompt: applySound(promptBox.value, soundFlags()) };
    savePrefs({ sound: soundFlags(), size: sizeSel.value, window: req.window, leaveMode: req.leaveMode, leaveModeV2: true, arriveMode: req.arriveMode, crossfade: req.crossfade, joinMatch: req.joinMatch, splitWindows: splitWindows.checked, windowJoin: windowJoin.checked, sliding: sliding.checked, newSeconds: s.gap || s.replace || fresh ? prefs.newSeconds : req.newSeconds,
      freshSeconds: fresh && !s.target ? req.newSeconds : prefs.freshSeconds, keepCut: keepCut.checked, carryAudio: carryAudio.checked,
      useCurrent: req.useCurrent, seed: seedSel.value === "custom" ? "custom" : "new", customSeed: seedInput.value });
    go.disabled = true;
    try {
      const job = await api("api/gen/submit", { method: "POST", body: req });
      if (!preset.auto) toast(`${MODE_LABEL[mode]} queued in WanGP (seed ${job.seed})`);
      m.close();
      app.regen.poll();
      resolveAuto(job.id);
    } catch (e) {
      error.textContent = e.message; go.disabled = false;
      if (preset.auto) { m.box.parentElement.style.display = ""; resolveAuto(null); }
    }
  }

  update();
  prepare();
  return preset.auto ? autoDone : null;
}

// Reroll: the same generation again with a new seed (from a generated clip's lineage).
export function rerollFor(app, clip) {
  const g = clip?.gen;
  if (!g) return;
  if (g.mode === "new") { openGenerate(app, "new", { trackId: clip.trackId, targetId: clip.id }); return; }
  const where = g.mode === "fill" ? { trackId: clip.trackId, t: clip.start } : { clipId: g.mode === "prepend" ? g.child : g.mode === "replace" ? clip.id : g.parent || clip.id };
  if (g.mode === "fill") {
    // the gap is now filled by this clip: regenerate it as a replacement between its neighbours
    openGenerate(app, "replace", { clipId: clip.id });
    return;
  }
  openGenerate(app, g.mode === "replace" ? "replace" : g.mode, where);
}
