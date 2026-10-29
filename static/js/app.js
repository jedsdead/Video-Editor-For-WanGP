// Editor bootstrap: builds the panels, menus, toolbar, transport, keyboard shortcuts and project persistence.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { api, el, toast, showMenu, closeMenu, modal, prompt_, confirm_, debounce, isTyping, timecode, uid } from "./util.js";
import { Renderer } from "./renderer.js";
import { Playback } from "./playback.js";
import { Timeline } from "./timeline.js";
import { Docks } from "./docks.js";
import { MediaBin } from "./mediabin.js";
import { Inspector } from "./inspector.js";
import { ColourPanel } from "./colour.js";
import { ScopesPanel } from "./scopes.js";
import { MixerPanel } from "./mixer.js";
import { TransitionsPanel } from "./transitionspanel.js";
import { EffectsPanel } from "./effectspanel.js";
import { initCollapsible } from "./collapse.js";
import { openExportDialog } from "./exportdialog.js";
import { openRenderDialog, showFinals, ensureGenSettings } from "./finalrender.js";
import { CURVES, FADE_CURVES } from "./keys.js";
import { TransformOverlay } from "./transform.js";
import { MarkersPanel } from "./markers.js";
import { openShotDetect } from "./shotdetect.js";
import { RegenJobs, openRegenDialog, canRegenerate } from "./regen.js";
import { openGenerate, sides, MODE_LABEL } from "./gendialog.js";

const $ = (id) => document.getElementById(id);
const app = { status: {} };
window.veApp = app;
const instanceId = uid("w");
const channel = "BroadcastChannel" in window ? new BroadcastChannel("wan2gp-video-editor") : null;
let loading = false;

// ------------------------------------------------------------------ persistence
function setSaveState(text) { $("saveState").textContent = text; }

async function saveNow() {
  if (!P() || state.readOnly) return;
  save.cancel();
  setSaveState("Saving…");
  try {
    await api(`api/projects/${encodeURIComponent(P().name)}`, { method: "PUT", body: P() });
    setSaveState("Saved");
  } catch (e) { setSaveState("Save failed"); toast(`Could not save: ${e.message}`, "error"); }
}
const save = debounce(() => saveNow(), 1200);

function setProject(project) {
  loading = true;
  state.project = M.normalizeProject(project);
  const repaired = M.repairTimes(state.project);
  if (repaired && state.project.magnetic) {
    M.pack();
    for (const c of state.project.clips) M.assignParent(c);
  }
  state.selection.clear();
  state.selTransition = null;
  state.range = null;
  state.selectedMedia = null;
  M.resetHistory();
  localStorage.setItem("ve_last_project", project.name);
  $("projectTitle").textContent = project.name;
  document.title = `${project.name} – Video Editor`;
  app.playback.seek(0);
  bus.emit("project");
  bus.emit("change");
  bus.emit("settings");
  syncToggles();
  app.playback.layout();
  setTimeout(() => app.timeline.zoomToFit(), 50);
  app.bin.refreshAll();
  ensureGenSettings().catch(() => {});
  loading = false;
  setSaveState("Saved");
  claim();
  if (repaired) { toast("Repaired clips that had no position on the timeline"); saveNow(); }
}

async function uniqueName(base) {
  const names = new Set((await api("api/projects").catch(() => [])).map(p => p.name.toLowerCase()));
  let name = base, i = 2;
  while (names.has(name.toLowerCase())) name = `${base} ${i++}`;
  return name;
}

async function loadProject(name) {
  try { setProject(await api(`api/projects/${encodeURIComponent(name)}`)); return true; }
  catch (_) { return false; }
}

async function newProject() {
  const name = await prompt_("New project", "Project name", await uniqueName("Untitled"));
  if (!name) return;
  await saveNow();
  setProject(M.newProject(await uniqueName(name)));
  saveNow();
}

async function openProjectDialog() {
  const list = await api("api/projects").catch(() => []);
  const box = el("div.browser-list", { style: { height: "50vh" } });
  let m;
  for (const p of list) {
    box.append(el("div.brow", { style: { gridTemplateColumns: "22px 1fr 150px 30px" }, ondblclick: async () => { await saveNow(); await loadProject(p.name); m.close(); } },
      el("span", {}, "🎬"), el("span", {}, p.name), el("span.meta", {}, new Date(p.mtime * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })),
      el("button.icon", { title: "Delete project", onclick: async (e) => {
        e.stopPropagation();
        if (p.name === P().name) { toast("That project is open"); return; }
        if (await confirm_("Delete project", `Delete "${p.name}"? Media files are not touched.`, "Delete")) { await api(`api/projects/${encodeURIComponent(p.name)}`, { method: "DELETE" }); e.target.closest(".brow").remove(); }
      } }, "✕")));
  }
  if (!list.length) box.append(el("div.empty-note", {}, "No saved projects yet."));
  m = modal({ title: "Open project", body: el("div", {}, el("div.dim", { style: { marginBottom: "6px" } }, "Double-click a project to open it."), box), buttons: ["spacer", { label: "Close" }] });
}

async function saveAs() {
  const name = await prompt_("Save project as", "New project name", await uniqueName(`${P().name} copy`));
  if (!name) return;
  const copy = JSON.parse(JSON.stringify(P()));
  copy.name = await uniqueName(name);
  setProject(copy);
  await saveNow();
  toast(`Saved as "${copy.name}"`);
}

async function renameProject() {
  const old = P().name;
  const name = await prompt_("Rename project", "Project name", old);
  if (!name || name === old) return;
  const fresh = await uniqueName(name);
  P().name = fresh;
  await saveNow();
  await api(`api/projects/${encodeURIComponent(old)}`, { method: "DELETE" }).catch(() => {});
  localStorage.setItem("ve_last_project", fresh);
  $("projectTitle").textContent = fresh;
  document.title = `${fresh} – Video Editor`;
  claim();
}

// ------------------------------------------------------------------ multi-window handover
function claim() { if (channel && P()) channel.postMessage({ type: "claim", id: instanceId, project: P().name }); }
if (channel) channel.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === "claim" && msg.id !== instanceId && P() && msg.project === P().name && !state.readOnly) {
    save.flush();
    state.readOnly = true;
    app.playback.pause();
    $("takeover").hidden = false;
  }
};

// ------------------------------------------------------------------ actions
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll(".tool").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
  if (tool !== "range" && state.range) { state.range = null; bus.emit("range"); }
  app.timeline.draw();
  updateInfo();
}

function syncToggles() {
  if (!P()) return;
  $("tglSnap").classList.toggle("active", !!P().snapping);
  $("tglMagnetic").classList.toggle("active", !!P().magnetic);
  $("tglLink").classList.toggle("active", !!state.linked);
  $("tglLoop").classList.toggle("active", !!app.playback.loop);
}

function toggleSnap() { P().snapping = !P().snapping; syncToggles(); bus.emit("change"); toast(`Snapping ${P().snapping ? "on" : "off"}`); }
function toggleMagnetic() {
  const on = !P().magnetic;
  M.edit("Magnetic timeline", () => M.setMagnetic(on));
  syncToggles();
  toast(on ? "Magnetic timeline on: V1 closes gaps and clips above connect to it" : "Magnetic timeline off: free placement, clips overwrite");
}
function toggleLinked() { state.linked = !state.linked; syncToggles(); toast(`Linked selection ${state.linked ? "on" : "off"}`); }

function deleteSelection(ripple) {
  if (state.range && state.range.end > state.range.start) {
    M.edit(ripple ? "Ripple delete range" : "Delete range", () => M.rangeDelete(state.range, ripple));
    state.range = null; bus.emit("range");
    return;
  }
  if (state.selTransition) { M.edit("Delete transition", () => { P().transitions = P().transitions.filter(t => t.id !== state.selTransition); }); return; }
  const ids = [...state.selection];
  if (ids.length) M.edit(ripple ? "Ripple delete" : "Delete", () => M.deleteClips(ids, ripple));
}

function splitAtPlayhead() {
  const ids = state.selection.size ? new Set(state.selection) : null;
  const before = P().clips.length;
  M.edit("Split", () => M.splitAt(state.playhead, { ids }));
  if (P().clips.length === before) toast("Nothing under the playhead to split", "warn");
}

function copy(cut = false) {
  const n = M.copySelection();
  if (!n) return;
  if (cut) M.edit("Cut", () => M.deleteClips([...state.selection], false));
  toast(`${cut ? "Cut" : "Copied"} ${n} clip${n > 1 ? "s" : ""}`);
}
function paste() {
  const clips = M.edit("Paste", () => M.paste(state.playhead));
  if (clips && clips.length) M.select(clips.map(c => c.id));
}

function setIn() { M.edit("Set in", () => { P().inPoint = state.playhead; if (P().outPoint !== null && P().outPoint <= P().inPoint) P().outPoint = null; }); }
function setOut() { M.edit("Set out", () => { P().outPoint = state.playhead; if (P().inPoint !== null && P().inPoint >= P().outPoint) P().inPoint = null; }); }
function clearInOut() { M.edit("Clear in/out", () => { P().inPoint = null; P().outPoint = null; }); }

function jumpEdit(dir) {
  const pts = M.editPoints();
  const t = state.playhead;
  const next = dir > 0 ? pts.find(p => p > t + 1e-4) : [...pts].reverse().find(p => p < t - 1e-4);
  if (next !== undefined) { app.playback.pause(); app.playback.seek(next); }
}

function addMarker() {
  const m = M.edit("Add marker", () => M.addMarker(state.playhead));
  if (m) toast(`${m.name} at ${timecode(m.t, M.fps())}`);
}
app.addMarker = addMarker;

function editMarker(id) {
  const m = M.getMarker(id);
  if (!m) return;
  prompt_("Marker", "Name", m.name || "").then((name) => { if (name !== null) M.edit("Rename marker", () => { const x = M.getMarker(id); if (x) x.name = name; }); });
}

function freezeFrame() {
  const sel = state.selection.size ? new Set(state.selection) : null;
  const frozen = M.edit("Freeze frame", () => M.freezeFrame(state.playhead, 2, sel));
  if (frozen) { M.select([frozen.id]); toast("Added a 2 second freeze frame (trim it to change the length)"); }
  else toast("Put the playhead over a video clip to freeze it", "warn");
}
app.freezeFrame = freezeFrame;

function detectShots() {
  const clip = M.selectedClips().find(c => M.trackKind(c.trackId) === "video" && !M.isStill(c));
  if (!clip) { toast("Select a video clip to detect its shots", "warn"); return; }
  openShotDetect(app, clip.id);
}

function toggleReverse() {
  const clips = M.selectedClips().filter(c => !M.isStill(c));
  if (!clips.length) { toast("Select clips to reverse", "warn"); return; }
  const on = !clips[0].reverse;
  M.edit(on ? "Reverse" : "Play forwards", () => M.setReverse(clips.map(c => c.id), on));
  if (on) for (const c of clips) prepareReverse(M.mediaOf(c));
}

// Build a reversed preview proxy for smooth backwards playback (export does not need it).
const reverseRequests = new Set();
function prepareReverse(item) {
  if (!item || item.proxy_rev === "ready" || reverseRequests.has(item.id) || !["video", "audio"].includes(item.kind)) return;
  reverseRequests.add(item.id);
  P().media[item.id] = { ...item, proxy_rev: "pending" };
  toast("Preparing reversed playback…");
  api(`api/media/${item.id}/reverse`, { method: "POST" }).then((info) => {
    if (P().media[item.id]) P().media[item.id] = { ...P().media[item.id], ...info };
    bus.emit("media-updated", item.id);
  }).catch((e) => toast(`Could not prepare reversed playback: ${e.message}`, "error")).finally(() => reverseRequests.delete(item.id));
}
app.prepareReverse = prepareReverse;

// Regeneration and takes in the clip menu.
function regenItems(clip, row) {
  if (row.kind !== "video" || M.isStill(clip)) return [];
  const items = [];
  const gen = [];
  for (const mode of ["extend", "prepend", "bridge", "replace", "loop"]) {
    const sd = sides(mode, { clipId: clip.id });
    if (mode === "loop" && (sd.reason || sd.left?.id !== clip.id)) continue;
    gen.push({ label: { extend: "Extend after this clip…", prepend: "Prepend before this clip…", bridge: "Bridge into the next clip…",
      replace: "Replace, joining its neighbours…", loop: "Loop back to the first clip…" }[mode], disabled: !!sd.reason, action: () => openGenerate(app, mode, { clipId: clip.id }) });
  }
  if (canRegenerate(clip)) gen.push("-", { label: "Fresh take, new seed (no pins)…", action: () => openRegenDialog(app, clip.id, "new") },
    { label: "Fresh take, same seed (no pins)…", action: () => openRegenDialog(app, clip.id, "same") });
  items.push({ label: "Generate", submenu: gen });
  if (clip.takes?.length) {
    items.push({ label: `Takes (${(clip.takeIndex || 0) + 1} of ${clip.takes.length})`, submenu: clip.takes.map((t, i) => ({
      label: `${i + 1}. ${t.label}${t.seed != null ? ` (seed ${t.seed})` : ""}`, check: (clip.takeIndex || 0) === i,
      action: () => M.edit("Switch take", () => M.setTake(clip.id, i)) })) });
  }
  return items;
}

// Effects clipboard: the whole effect chain (with its keyframes) of one clip, pasted onto others (added after theirs).
function copyEffects() {
  const clip = M.editTargets().find(c => M.trackKind(c.trackId) === "video" && (c.effects || []).length);
  if (!clip) { toast("Select a video clip with effects", "warn"); return; }
  const lanes = Object.fromEntries(Object.entries(clip.keys || {}).filter(([k]) => k.startsWith("fx:")));
  state.effectsClipboard = JSON.parse(JSON.stringify({ effects: clip.effects, lanes }));
  toast(`Copied ${clip.effects.length} effect${clip.effects.length > 1 ? "s" : ""}`);
}
function pasteEffects() {
  const data = state.effectsClipboard;
  const targets = M.editTargets().filter(c => M.trackKind(c.trackId) === "video");
  if (!data || !targets.length) return;
  M.edit("Paste effects", () => {
    for (const t of targets) {
      const c = M.getClip(t.id);
      for (const fx of data.effects) {
        const id = uid("fx");
        c.effects = [...(c.effects || []), { ...JSON.parse(JSON.stringify(fx)), id }];
        for (const [lane, ks] of Object.entries(data.lanes)) {
          const [, oldId, key] = lane.split(":");
          if (oldId !== fx.id) continue;
          const d = M.clipDur(c);
          const kept = ks.filter(k => k.t <= d + 1e-6);
          if (kept.length) { c.keys ||= {}; c.keys[M.effectLane(id, key)] = JSON.parse(JSON.stringify(kept)); }
        }
      }
    }
  });
  toast(`Pasted effects onto ${targets.length} clip${targets.length > 1 ? "s" : ""}`);
}
function removeEffects() {
  M.edit("Remove effects", () => { for (const c of M.editTargets()) for (const f of [...(c.effects || [])]) M.removeEffect(c.id, f.id); });
}

function copyGrade() { app.colour.copy(); }
function pasteGrade() { app.colour.paste(); }

function linkToggle() {
  const clips = M.selectedClips();
  if (!clips.length) return;
  if (clips.some(c => c.linkId)) M.edit("Unlink", () => M.unlinkClips(clips.map(c => c.id)));
  else if (clips.length > 1) M.edit("Link", () => M.linkClips(clips.map(c => c.id)));
}

// ------------------------------------------------------------------ menus
const isMac = navigator.platform.toUpperCase().includes("MAC");
const K = (s) => isMac ? s.replace("Ctrl", "⌘") : s;

function menuItems(name) {
  if (name === "file") return [
    { label: "New project…", action: newProject },
    { label: "Open project…", action: openProjectDialog },
    { label: "Save now", kbd: K("Ctrl+S"), action: saveNow },
    { label: "Save as…", action: saveAs },
    { label: "Rename project…", action: renameProject },
    "-",
    { label: "Import media files…", kbd: K("Ctrl+I"), action: () => app.bin.fileInput.click() },
    { label: "Browse WanGP outputs…", action: () => app.bin.browse() },
    "-",
    { label: "Project settings", action: () => { M.clearSelection(); state.selectedMedia = null; app.docks.show("inspector"); bus.emit("selection"); } },
    { label: "Render final…", action: () => openRenderDialog(app) },
    { label: "Export…", kbd: K("Ctrl+E"), action: () => openExportDialog(app) },
  ];
  if (name === "edit") return [
    { label: "Undo", kbd: K("Ctrl+Z"), action: M.undo, disabled: !M.canUndo() },
    { label: "Redo", kbd: K("Ctrl+Shift+Z"), action: M.redo, disabled: !M.canRedo() },
    "-",
    { label: "Cut", kbd: K("Ctrl+X"), action: () => copy(true) },
    { label: "Copy", kbd: K("Ctrl+C"), action: () => copy() },
    { label: "Paste at playhead", kbd: K("Ctrl+V"), action: paste },
    { label: "Delete", kbd: "Del", action: () => deleteSelection(false) },
    { label: "Ripple delete", kbd: "Shift+Del", action: () => deleteSelection(true) },
    "-",
    { label: "Split at playhead", kbd: K("Ctrl+B"), action: splitAtPlayhead },
    { label: "Select all", kbd: K("Ctrl+A"), action: () => M.select(P().clips.map(c => c.id)) },
    { label: "Deselect all", kbd: "Esc", action: () => { M.clearSelection(); state.range = null; bus.emit("range"); } },
    { label: "Link / unlink clips", kbd: K("Ctrl+L"), action: linkToggle },
    "-",
    { label: "Add transitions at playhead", kbd: K("Ctrl+T"), action: () => app.transitions.applyAtPlayhead() },
    { label: "Copy grade", kbd: K("Ctrl+Alt+C"), action: copyGrade },
    { label: "Paste grade", kbd: K("Ctrl+Alt+V"), action: pasteGrade },
    "-",
    { label: "Add marker", kbd: "Shift+M", action: addMarker },
    { label: "Freeze frame at playhead", kbd: "Shift+F", action: freezeFrame },
    { label: "Reverse selected clips", kbd: "Shift+R", action: toggleReverse },
    { label: "Add title at playhead", kbd: "Shift+T", action: () => app.effects.addGenerator(M.TITLE_MEDIA.id) },
    { label: "Detect shots in selected clip…", kbd: "Shift+D", action: detectShots },
    "-",
    { label: "Mark in", kbd: "I", action: setIn },
    { label: "Mark out", kbd: "O", action: setOut },
    { label: "Clear in / out", kbd: "Alt+X", action: clearInOut },
  ];
  if (name === "view") return [
    ...app.docks.menuItems(),
    "-",
    { label: "Audio scrubbing", check: app.playback.scrubAudio, action: () => { app.playback.scrubAudio = !app.playback.scrubAudio; localStorage.setItem("ve_scrub", app.playback.scrubAudio ? "1" : "0"); } },
    { label: "Crop handles on the viewer", kbd: "C", check: app.overlay.cropMode, action: () => app.overlay.setCropMode(!app.overlay.cropMode) },
    { label: "Show final renders", check: !!P()?.settings?.showFinal, action: () => { showFinals(!P().settings.showFinal); toast(P().settings.showFinal ? "Showing final renders (clips whose final is out of date stay on their draft)" : "Showing drafts"); } },
    { label: "Snap cuts to H3's 17-frame grid", check: state.h3Snap, action: () => { state.h3Snap = !state.h3Snap; localStorage.setItem("ve_h3snap", state.h3Snap ? "1" : "0");
      toast(state.h3Snap ? "Cuts on WanGP clips snap to H3's 17-frame grid, so extends and prepends from them stay latent grade" : "H3 grid snapping off"); } },
    "-",
    { label: "Zoom in", kbd: "+", action: () => app.timeline.setZoom(app.timeline.pps * 1.4) },
    { label: "Zoom out", kbd: "-", action: () => app.timeline.setZoom(app.timeline.pps / 1.4) },
    { label: "Zoom to fit", kbd: "\\", action: () => app.timeline.zoomToFit() },
    "-",
    { label: "Reset panel layout", action: () => app.docks.reset() },
  ];
  return [
    { label: "Keyboard shortcuts", kbd: "?", action: showShortcuts },
    { label: "About the editor", action: () => modal({ title: "Video Editor", narrow: true, body: el("div", {},
      el("p", {}, "A multi-track editor inside WanGP. Previews use lightweight proxies; exports render from the original files on " + (app.status.device || "the GPU") + "."),
      el("p.dim", {}, `Projects and cache: ${app.status.data_root || "?"}`)), buttons: ["spacer", { label: "Close" }] }) },
  ];
}

function openMenu(btn) {
  const r = btn.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, menuItems(btn.dataset.menu));
  btn.classList.add("open");
}

function laneItems(clip, row) {
  const kind = row.kind;
  const current = app.timeline.lane(clip, row);
  const items = [];
  for (const [name, def] of Object.entries(M.KEYABLE)) {
    if (!(def.kind === kind || def.kind === "any")) continue;
    if (name === "speed" && M.isStill(clip)) continue;
    const n = M.keysOf(clip, name).length;
    items.push({ label: `${def.label}${n ? `  (${n})` : ""}`, check: current === name,
      action: () => { const c = M.getClip(clip.id); if (c) { c.lane = name; bus.emit("change"); } } });
  }
  const label = M.KEYABLE[current]?.label;
  return [{ label: `Show keyframes for${label ? `: ${label}` : ""}`, submenu: items }];
}

// Compound clips: make one from the selection, open or close one, break one apart.
function compoundItems(clip) {
  const cp = M.compoundOf(clip);
  if (cp) {
    const members = M.compoundMembers(cp.id).map(c => c.id);
    return ["-",
      cp.open ? { label: "Close compound clip", action: () => { M.edit("Close compound clip", () => M.setCompoundOpen(cp.id, false)); M.select(members); } }
              : { label: "Open compound clip", kbd: "Double-click", action: () => { M.edit("Open compound clip", () => M.setCompoundOpen(cp.id, true)); M.select([clip.id]); } },
      { label: "Break apart compound clip", action: () => { M.edit("Break apart compound clip", () => M.breakCompound(cp.id)); M.select(members); } }];
  }
  const ids = [...state.selection];
  const why = M.compoundProblem(ids);
  return ["-", { label: ids.length > 1 ? "Make compound clip from selection" : "Make compound clip", disabled: !!why, title: why || "",
    action: () => { const made = M.edit("Make compound clip", () => M.makeCompound(ids)); if (made) M.select(M.compoundMembers(made.id).map(c => c.id)); } }];
}

function contextMenu(x, y, hit) {
  if (hit.area === "marker") {
    const m = hit.marker;
    showMenu(x, y, [
      { head: m.name || "Marker" },
      { label: "Rename…", action: () => editMarker(m.id) },
      ...M.MARKER_COLORS.map((c, i) => ({ label: ["Blue", "Red", "Yellow", "Green", "Purple", "Orange", "White"][i], check: m.color === c,
        action: () => M.edit("Marker colour", () => { const x = M.getMarker(m.id); if (x) x.color = c; }) })),
      "-",
      { label: "Delete marker", action: () => M.edit("Delete marker", () => M.removeMarker(m.id)) },
    ]);
    return;
  }
  if (hit.area === "auto") {
    const trackId = hit.row.track.id;
    if (hit.zone === "key") {
      const key = M.trackKeys(hit.row.track)[hit.index];
      showMenu(x, y, [
        { head: "Automation keyframe · ease to next" },
        ...CURVES.map(([id, label]) => ({ label, check: (key.ease || "linear") === id, action: () => M.edit("Automation ease", () => M.setTrackKeyEase(trackId, hit.index, id)) })),
        "-",
        { label: "Delete keyframe", action: () => M.edit("Delete automation keyframe", () => M.removeTrackKey(trackId, hit.index)) },
      ]);
    } else {
      showMenu(x, y, [
        { label: "Add automation keyframe here", kbd: "Ctrl+click", action: () => M.edit("Add automation keyframe", () => M.setTrackKeyAt(trackId, Math.max(0, hit.t), M.trackGainDb(hit.row.track, Math.max(0, hit.t)))) },
        { label: "Clear track automation", disabled: !M.trackKeys(hit.row.track).length, action: () => M.edit("Clear automation", () => M.clearTrackKeys(trackId)) },
        { label: "Hide automation", action: () => M.edit("Hide automation", () => { const t = M.getTrack(trackId); if (t) t.showAuto = false; }) },
      ]);
    }
    return;
  }
  if (hit.area === "clip" && hit.zone === "key") {
    const clip = hit.clip, lane = hit.lane, index = hit.keyIndex;
    const key = M.keysOf(clip, lane)[index];
    if (!key) return;
    showMenu(x, y, [
      { head: `${M.KEYABLE[lane].label} keyframe · ease to next` },
      ...CURVES.map(([id, label]) => ({ label, check: (key.ease || "linear") === id, action: () => M.edit("Keyframe ease", () => M.setKeyEase(clip.id, lane, index, id)) })),
      "-",
      { label: "Go to keyframe", action: () => { app.playback.pause(); app.playback.seek(clip.start + key.t); } },
      { label: "Delete keyframe", action: () => M.edit("Delete keyframe", () => M.removeKey(clip.id, lane, index)) },
    ]);
    return;
  }
  if (hit.area === "clip" && (hit.zone === "fadeIn" || hit.zone === "fadeOut")) {
    const clip = hit.clip, a = hit.compoundAudio ? "a" : "";   // a compound clip's sound has fades of its own
    const which = a ? (hit.zone === "fadeIn" ? "aFadeIn" : "aFadeOut") : hit.zone;
    const field = a ? (hit.zone === "fadeIn" ? "aFadeInCurve" : "aFadeOutCurve") : hit.zone === "fadeIn" ? "fadeInCurve" : "fadeOutCurve";
    showMenu(x, y, [
      { head: hit.zone === "fadeIn" ? "Fade in shape" : "Fade out shape" },
      ...FADE_CURVES.map(([id, label]) => ({ label, check: (clip[field] || "linear") === id, action: () => M.edit("Fade shape", () => {
        for (const c of [M.getClip(clip.id), ...(state.linked ? M.partners(clip) : [])]) if (c) c[field] = id;
      }) })),
      "-",
      { label: "Remove fade", action: () => M.edit("Remove fade", () => { const c = M.getClip(clip.id); if (c) c[which] = 0; }) },
    ]);
    return;
  }
  if (hit.area === "clip" && hit.zone === "line") {
    const clip = hit.clip, lane = hit.lane;
    const tau = M.snapFrame(Math.max(0, Math.min(M.clipDur(clip), hit.t - clip.start)));
    showMenu(x, y, [
      { label: "Add keyframe here", kbd: "Ctrl+click", action: () => M.edit("Add keyframe", () => M.setKeyAt(clip.id, lane, tau, M.prop(clip, lane, tau))) },
      { label: `Clear ${M.KEYABLE[lane].label.toLowerCase()} keyframes`, disabled: !M.keysOf(clip, lane).length,
        action: () => M.edit("Clear keyframes", () => M.clearKeys(clip.id, lane, M.prop(clip, lane, Math.max(0, Math.min(M.clipDur(clip), state.playhead - clip.start))))) },
      "-",
      ...laneItems(clip, hit.row),
    ]);
    return;
  }
  if (hit.area === "clip") {
    const clip = hit.clip;
    showMenu(x, y, [
      { label: "Split at playhead", kbd: K("Ctrl+B"), action: splitAtPlayhead },
      { label: "Delete", kbd: "Del", action: () => deleteSelection(false) },
      { label: "Ripple delete", kbd: "Shift+Del", action: () => deleteSelection(true) },
      "-",
      { label: "Cut", action: () => copy(true) },
      { label: "Copy", action: () => copy() },
      { label: clip.linkId ? "Unlink" : "Link selected", action: linkToggle },
      "-",
      { label: "Reset speed to 100%", disabled: M.isStill(clip), action: () => M.edit("Reset speed", () => M.setSpeed([...state.selection], 1)) },
      { label: clip.reverse ? "Play forwards" : "Reverse", kbd: "Shift+R", disabled: M.isStill(clip), action: toggleReverse },
      hit.row.kind === "video" ? { label: "Freeze frame at playhead", kbd: "Shift+F", disabled: M.isStill(clip), action: freezeFrame } : null,
      hit.row.kind === "video" ? { label: "Detect shots…", kbd: "Shift+D", disabled: M.isStill(clip), action: () => openShotDetect(app, clip.id) } : null,
      ...regenItems(clip, hit.row),
      hit.row.kind === "video" && M.mediaOf(clip)?.has_metadata && !M.isStill(clip) ? { label: "Split at sliding windows", action: () => app.regen.splitWindows(clip.id) } : null,
      ...compoundItems(clip),
      hit.row.kind === "video" && hit.row.track.id === M.primaryId() ? { label: state.selection.size > 1 ? "Render final (selected clips)…" : "Render final (this clip)…",
        disabled: M.isStill(clip), action: () => openRenderDialog(app, { clipIds: new Set(state.selection) }) } : null,
      hit.row.kind === "video" ? { label: "Grade & effects", submenu: [
        { label: "Copy grade", kbd: K("Ctrl+Alt+C"), action: copyGrade },
        { label: "Paste grade", kbd: K("Ctrl+Alt+V"), action: pasteGrade },
        "-",
        { label: "Copy effects", disabled: !(clip.effects || []).length, action: copyEffects },
        { label: "Paste effects", disabled: !state.effectsClipboard, action: pasteEffects },
        { label: "Remove all effects", disabled: !(clip.effects || []).length, action: removeEffects }] } : null,
      "-",
      M.isGenerator(clip) ? null : { label: "Show in media bin", action: () => { state.selectedMedia = clip.mediaId; app.docks.show("media"); bus.emit("media"); } },
      { label: "Properties", action: () => app.docks.show("inspector") },
      "-",
      ...laneItems(clip, hit.row),
    ].filter(Boolean));
  } else if (hit.area === "transition") {
    showMenu(x, y, [
      { label: "Delete transition", action: () => deleteSelection(false) },
      { label: "Properties", action: () => app.docks.show("inspector") },
    ]);
  } else {
    const gap = hit.row && hit.row.kind === "video" ? M.gapAt(hit.row.track.id, hit.t) : null;
    const fill = gap && (gap.prev || gap.next) ? { label: gap.prev && gap.next ? "Fill gap with a generation, joining both clips…" : "Fill with a generation…",
      action: () => openGenerate(app, "fill", { trackId: hit.row.track.id, t: hit.t }) } : null;
    const fresh = hit.row && hit.row.kind === "video" && gap ? { label: "Generate a new shot here…", action: () => openGenerate(app, "new", { trackId: hit.row.track.id, t: hit.t }) } : null;
    showMenu(x, y, [
      fresh, fill, fresh || fill ? "-" : null,
      { label: "Paste at playhead", disabled: !state.clipboard, action: paste },
      state.range ? { label: "Delete range", action: () => deleteSelection(false) } : null,
      state.range ? { label: "Ripple delete range", action: () => deleteSelection(true) } : null,
      state.range ? { label: "Set in/out from range", action: () => M.edit("Set in/out", () => { P().inPoint = state.range.start; P().outPoint = state.range.end; }) } : null,
      "-",
      { label: "Add video track", action: () => M.edit("Add track", () => M.addTrack("video")) },
      { label: "Add audio track", action: () => M.edit("Add track", () => M.addTrack("audio")) },
    ].filter(Boolean));
  }
}

function showShortcuts() {
  const rows = [
    ["Space", "Play / pause"], ["J / K / L", "Shuttle back / stop / forward (press again for 2x, 4x, 8x)"], ["← / →", "Previous / next frame (Shift: 1 second)"],
    ["Shift+D", "Detect shots in the selected clip"], ["Shift+M", "Add a marker"], ["Shift+F", "Freeze frame at the playhead"], ["Shift+R", "Reverse selected clips"], ["Shift+T", "Add a title"], ["C", "Crop handles on the viewer"],
    ["↑ / ↓", "Previous / next edit point"], ["Home / End", "Start / end of timeline"], ["I / O, Alt+X", "Mark in / out, clear"],
    ["V / B / R", "Select / Blade / Range tool"], ["S / M", "Snapping / Magnetic timeline"], [K("Ctrl+Shift+L"), "Linked selection"],
    [K("Ctrl+B"), "Split at playhead (selected clips, or all)"], ["Del / Shift+Del", "Delete / ripple delete (clips, range or transition)"],
    [K("Ctrl+C / X / V"), "Copy / cut / paste at playhead"], [K("Ctrl+Z / Ctrl+Shift+Z"), "Undo / redo"], [K("Ctrl+A"), "Select all"],
    [K("Ctrl+L"), "Link / unlink selected clips"], [K("Ctrl+T"), "Transitions at the cut under the playhead"],
    [K("Ctrl+Alt+C / V"), "Copy / paste grade"], ["+ / - / \\", "Zoom in / out / fit"], [K("Ctrl+wheel"), "Zoom the timeline"],
    ["Middle-drag", "Pan the timeline"], ["Alt+drag clip edge", "Trim one side of a linked clip"], [K("Ctrl+E / Ctrl+I"), "Export / import"], [K("Ctrl+S"), "Save now"],
    ["Shift+click (Blade)", "Cut every track at that point"], ["Shift-drag a wheel", "Fine colour adjustment"],
  ];
  modal({ title: "Keyboard shortcuts", body: el("div.shortcuts", {}, rows.flatMap(([k, v]) => [el("span", {}, el("kbd", {}, k)), el("span", {}, v)])), buttons: ["spacer", { label: "Close" }] });
}

// ------------------------------------------------------------------ keyboard
// Space plays / pauses from anywhere in the editor except text boxes. A focused button, checkbox, slider or dropdown
// would otherwise take the key (a focused Play button would even toggle twice), so it loses focus first.
function isTextEntry(target) {
  return !!target && ((target.tagName === "INPUT" && !["range", "checkbox", "button", "radio", "color"].includes(target.type)) || target.tagName === "TEXTAREA" || target.isContentEditable);
}
function spaceToggles(e) {
  if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || !P()) return false;
  if (isTextEntry(e.target) || document.querySelector(".modal-backdrop")) return false;
  e.preventDefault(); e.stopPropagation();
  if (!e.repeat) {
    const t = e.target;
    if (t && t !== document.body && typeof t.blur === "function" && t.matches?.("button, select, input, [tabindex]")) t.blur();
    app.playback.toggle();
  }
  return true;
}

function onKey(e) {
  if (e.defaultPrevented && e.key === " ") return;   // handled by spaceToggles
  if (isTyping(e) || !P()) return;
  if (document.querySelector(".modal-backdrop")) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key;
  const pb = app.playback;
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  if (ctrl && key.toLowerCase() === "s") { handled(); saveNow(); return; }
  if (state.readOnly) return;
  if (ctrl && !e.altKey && key.toLowerCase() === "z") { handled(); e.shiftKey ? M.redo() : M.undo(); return; }
  if (ctrl && key.toLowerCase() === "y") { handled(); M.redo(); return; }
  if (ctrl && e.altKey && key.toLowerCase() === "c") { handled(); copyGrade(); return; }
  if (ctrl && e.altKey && key.toLowerCase() === "v") { handled(); pasteGrade(); return; }
  if (ctrl && key.toLowerCase() === "c") { handled(); copy(); return; }
  if (ctrl && key.toLowerCase() === "x") { handled(); copy(true); return; }
  if (ctrl && key.toLowerCase() === "v") { handled(); paste(); return; }
  if (ctrl && key.toLowerCase() === "a") { handled(); M.select(P().clips.map(c => c.id)); return; }
  if (ctrl && (key.toLowerCase() === "b" || key.toLowerCase() === "k")) { handled(); splitAtPlayhead(); return; }
  if (ctrl && e.shiftKey && key.toLowerCase() === "l") { handled(); toggleLinked(); return; }
  if (ctrl && key.toLowerCase() === "l") { handled(); linkToggle(); return; }
  if (ctrl && key.toLowerCase() === "t") { handled(); app.transitions.applyAtPlayhead(); return; }
  if (ctrl && key.toLowerCase() === "e") { handled(); openExportDialog(app); return; }
  if (ctrl && key.toLowerCase() === "i") { handled(); app.bin.fileInput.click(); return; }
  if (ctrl) return;
  if (e.altKey && key.toLowerCase() === "x") { handled(); clearInOut(); return; }
  switch (key) {
    case " ": handled(); pb.toggle(); break;
    case "k": case "K": handled(); pb.shuttle(0); break;
    case "l": case "L": handled(); pb.shuttle(1); break;
    case "j": case "J": handled(); pb.shuttle(-1); break;
    case "c": case "C": handled(); app.overlay.setCropMode(!app.overlay.cropMode); break;
    case "ArrowLeft": handled(); e.shiftKey ? (pb.pause(), pb.seek(state.playhead - 1)) : pb.step(-1); break;
    case "ArrowRight": handled(); e.shiftKey ? (pb.pause(), pb.seek(state.playhead + 1)) : pb.step(1); break;
    case "ArrowUp": handled(); jumpEdit(-1); break;
    case "ArrowDown": handled(); jumpEdit(1); break;
    case "Home": handled(); pb.pause(); pb.seek(0); break;
    case "End": handled(); pb.pause(); pb.seek(M.timelineEnd()); break;
    case "i": case "I": handled(); setIn(); break;
    case "o": case "O": handled(); setOut(); break;
    case "v": case "V": handled(); setTool("select"); break;
    case "b": case "B": handled(); setTool("blade"); break;
    case "r": case "R": handled(); e.shiftKey ? toggleReverse() : setTool("range"); break;
    case "s": case "S": handled(); toggleSnap(); break;
    case "m": case "M": handled(); e.shiftKey ? addMarker() : toggleMagnetic(); break;
    case "f": case "F": if (e.shiftKey) { handled(); freezeFrame(); } break;
    case "t": case "T": if (e.shiftKey) { handled(); app.effects.addGenerator(M.TITLE_MEDIA.id); } break;
    case "d": case "D": if (e.shiftKey) { handled(); detectShots(); } break;
    case "Delete": case "Backspace": handled(); deleteSelection(e.shiftKey); break;
    case "Escape": M.clearSelection(); state.range = null; bus.emit("range"); break;
    case "+": case "=": handled(); app.timeline.setZoom(app.timeline.pps * 1.4); break;
    case "-": case "_": handled(); app.timeline.setZoom(app.timeline.pps / 1.4); break;
    case "\\": handled(); app.timeline.zoomToFit(); break;
    case "?": handled(); showShortcuts(); break;
    default: break;
  }
}

// ------------------------------------------------------------------ status line & viewer message
function updateInfo() {
  if (!P()) return;
  const n = state.selection.size;
  const parts = [];
  if (state.range && state.range.end > state.range.start) parts.push(`Range ${timecode(state.range.start, M.fps())} – ${timecode(state.range.end, M.fps())}  (Del lifts, Shift+Del ripples)`);
  else if (state.selTransition) parts.push("Transition selected");
  else if (n) parts.push(`${n} clip${n > 1 ? "s" : ""} selected`);
  parts.push(`${P().settings.width}×${P().settings.height} · ${P().settings.fps} fps`);
  if (P().magnetic) parts.push("Magnetic");
  $("tlInfo").textContent = parts.join("   ·   ");
  $("tcDuration").textContent = timecode(M.timelineEnd(), M.fps());
  $("viewerMsg").textContent = P().clips.length ? "" : (Object.keys(P().media).length ? "Drag media from the bin onto the timeline" : "Import media to get started (File → Import, or Browse outputs)");
}

const ZOOM_MAX = 13.5;
function zoomToSlider(pps) { return Math.round(Math.log2(Math.max(1, pps)) / ZOOM_MAX * 1000); }

// ------------------------------------------------------------------ boot
async function main() {
  app.status = await api("api/status").catch(() => ({}));
  try { app.renderer = new Renderer($("previewCanvas")); }
  catch (e) { $("viewerMsg").textContent = `Preview unavailable: ${e.message}`; throw e; }
  app.playback = new Playback(app.renderer, $("viewerStage"));
  app.bin = new MediaBin(app);
  app.inspector = new Inspector(app);
  app.colour = new ColourPanel(app);
  app.scopes = new ScopesPanel(app);
  app.mixer = new MixerPanel(app);
  app.transitions = new TransitionsPanel(app);
  app.effects = new EffectsPanel(app);
  app.regen = new RegenJobs(app);
  state.h3Snap = localStorage.getItem("ve_h3snap") === "1";
  initCollapsible(document.body);
  bus.on("regen-jobs", () => app.timeline && app.timeline.draw());
  app.markers = new MarkersPanel(app);
  app.docks = new Docks([
    { id: "media", title: "Media", node: app.bin.node, dock: "left" },
    { id: "transitions", title: "Transitions", node: app.transitions.node, dock: "left" },
    { id: "effects", title: "Effects", node: app.effects.node, dock: "left" },
    { id: "inspector", title: "Inspector", node: app.inspector.node, dock: "right" },
    { id: "colour", title: "Colour", node: app.colour.node, dock: "right" },
    { id: "scopes", title: "Scopes", node: app.scopes.node, dock: "right", onShow: () => { app.scopes.visible = true; app.scopes.update(true); }, onHide: () => { app.scopes.visible = false; } },
    { id: "mixer", title: "Mixer", node: app.mixer.node, dock: "bottom", onShow: () => { app.mixer.visible = true; }, onHide: () => { app.mixer.visible = false; } },
    { id: "markers", title: "Markers", node: app.markers.node, dock: "left" },
  ]);
  app.docks.onTabMenu = (x, y, id) => showMenu(x, y, [{ head: "Move panel" },
    ...[["left", "To left dock"], ["right", "To right dock"], ["bottom", "To bottom dock"], ["hidden", "Hide"]].map(([d, l]) => ({ label: l, action: () => app.docks.place(id, d) }))]);
  app.timeline = new Timeline({
    canvas: $("tlCanvas"), wrap: $("tlCanvasWrap"), headers: $("trackHeaders"), headersInner: $("trackHeadersInner"),
    scrollbar: $("tlScrollbar"), scrollInner: $("tlScrollInner"), playback: app.playback,
    onImportFiles: (files, place) => app.bin.importFiles(files, place),
    onContextAction: contextMenu,
  });
  bus.on("open-panel", (id) => app.docks.show(id));
  app.overlay = new TransformOverlay(app, $("viewerStage"));
  app.playback.onNeedReverse = prepareReverse;
  try { app.playback.scrubAudio = localStorage.getItem("ve_scrub") !== "0"; } catch (_) { /* storage blocked */ }
  bus.on("edit-marker", editMarker);
  bus.on("crop-mode", (on) => $("tglCrop").classList.toggle("active", on));
  bus.on("rate", (rate) => { $("rateBadge").textContent = rate === 1 ? "" : `${rate > 0 ? "▶" : "◀"} ${Math.abs(rate)}x`; });
  $("tglCrop").onclick = () => app.overlay.setCropMode(!app.overlay.cropMode);

  // toolbar
  document.querySelectorAll(".menu-btn").forEach(b => {
    b.addEventListener("click", () => openMenu(b));
    b.addEventListener("mouseenter", () => { if (document.querySelector(".menu-btn.open") && !b.classList.contains("open")) openMenu(b); });
  });
  document.querySelectorAll(".tool").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("tglSnap").onclick = toggleSnap;
  $("tglMagnetic").onclick = toggleMagnetic;
  $("tglLink").onclick = toggleLinked;
  $("tglLoop").onclick = () => { app.playback.loop = !app.playback.loop; syncToggles(); };
  $("btnUndo").onclick = M.undo;
  $("btnRedo").onclick = M.redo;
  $("btnExport").onclick = () => openExportDialog(app);
  $("projectTitle").onclick = renameProject;
  $("btnAddVideoTrack").onclick = () => M.edit("Add track", () => M.addTrack("video"));
  $("btnAddAudioTrack").onclick = () => M.edit("Add track", () => M.addTrack("audio"));
  $("btnZoomIn").onclick = () => app.timeline.setZoom(app.timeline.pps * 1.4);
  $("btnZoomOut").onclick = () => app.timeline.setZoom(app.timeline.pps / 1.4);
  $("btnZoomFit").onclick = () => app.timeline.zoomToFit();
  $("zoomSlider").addEventListener("input", (e) => app.timeline.setZoom(Math.pow(2, e.target.value / 1000 * ZOOM_MAX)));
  bus.on("zoom", (pps) => { $("zoomSlider").value = zoomToSlider(pps); });
  $("btnTakeBack").onclick = async () => {
    state.readOnly = false;
    $("takeover").hidden = true;
    await loadProject(P().name);
  };

  // transport
  $("btnPlay").onclick = () => app.playback.toggle();
  $("btnStart").onclick = () => { app.playback.pause(); app.playback.seek(0); };
  $("btnEnd").onclick = () => { app.playback.pause(); app.playback.seek(M.timelineEnd()); };
  $("btnPrevFrame").onclick = () => app.playback.step(-1);
  $("btnNextFrame").onclick = () => app.playback.step(1);
  // full screen takes the whole viewer, transport included, so playback and leaving work without the keyboard
  $("btnFullscreen").onclick = () => { const v = $("viewer"); document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen?.(); };
  document.addEventListener("fullscreenchange", () => {
    const on = !!document.fullscreenElement;
    $("btnFullscreen").title = on ? "Leave full screen (Esc)" : "Full screen (Esc to leave)";
    $("btnFullscreen").innerHTML = on ? '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'
                                      : '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    app.playback.layout();
  });
  // viewer size: fit, or a percentage of the project's resolution (remembered per browser)
  try { state.viewerZoom = localStorage.getItem("ve_viewer_zoom") || "fit"; } catch (_) { state.viewerZoom = "fit"; }
  $("viewerZoom").value = state.viewerZoom;
  try { state.viewerQuality = localStorage.getItem("ve_viewer_quality") || "proxy"; } catch (_) { state.viewerQuality = "proxy"; }
  $("viewerQuality").value = state.viewerQuality;
  $("viewerQuality").onchange = (e) => {
    state.viewerQuality = e.target.value;
    try { localStorage.setItem("ve_viewer_quality", state.viewerQuality); } catch (_) { /* ignore */ }
    app.playback.dirty = true;   // the pool swaps each video's source as it's next drawn
  };
  $("viewerZoom").onchange = (e) => { state.viewerZoom = e.target.value; try { localStorage.setItem("ve_viewer_zoom", state.viewerZoom); } catch (_) { /* ignore */ } app.playback.layout(); };
  $("viewerStage").addEventListener("scroll", () => bus.emit("viewer-layout"));
  bus.on("playstate", (playing) => { $("playIcon").innerHTML = playing ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4v16l13-8z"/>'; });
  bus.on("time", (t) => { $("tcCurrent").textContent = timecode(t, M.fps()); });
  for (const name of ["change", "selection", "range", "project"]) bus.on(name, updateInfo);
  bus.on("settings", () => app.playback.layout());
  bus.on("change", () => { if (!loading && P()) { setSaveState("Unsaved changes"); save(); } });

  // keyboard & window
  document.addEventListener("keydown", (e) => { spaceToggles(e); }, true);   // before any focused control sees it
  document.addEventListener("keydown", onKey);
  // a button activates on Space when the key comes up: swallow that too
  document.addEventListener("keyup", (e) => { if (e.key === " " && !isTextEntry(e.target)) e.preventDefault(); }, true);
  // Inside WanGP the editor is in a frame: Space pressed while WanGP's own page has focus (after clicking the tab,
  // say) also plays, as long as the editor is the tab on screen.
  try {
    const host = window.frameElement && window.parent && window.parent.document;
    if (host) host.addEventListener("keydown", (e) => {
      const frame = window.frameElement;
      if (!frame || !frame.isConnected || frame.offsetParent === null || frame.getClientRects().length === 0) return;
      if (e.key === " " && !isTextEntry(e.target) && !e.target.closest?.("select, [role=button], button:not([role=tab])")) spaceToggles(e);
    }, true);
  } catch (_) { /* different origin: nothing to listen to */ }
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());
  window.addEventListener("beforeunload", () => { if (P() && !state.readOnly) { try { navigator.sendBeacon && fetch(`api/projects/${encodeURIComponent(P().name)}`, { method: "PUT", body: JSON.stringify(P()), headers: { "Content-Type": "application/json" }, keepalive: true }); } catch (_) { /* ignore */ } } });
  window.addEventListener("pointerdown", (e) => { if (!e.target.closest(".menu") && !e.target.closest(".menu-btn")) closeMenu(); }, true);

  // project
  const last = localStorage.getItem("ve_last_project");
  let ok = last ? await loadProject(last) : false;
  if (!ok) {
    const list = await api("api/projects").catch(() => []);
    ok = list.length ? await loadProject(list[0].name) : false;
  }
  if (!ok) { setProject(M.newProject("Untitled")); saveNow(); }
  setTool("select");
  syncToggles();
  updateInfo();
}

main().catch((e) => { console.error(e); toast(`Editor failed to start: ${e.message}`, "error", 10000); });
