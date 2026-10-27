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
import { openExportDialog } from "./exportdialog.js";
import { CURVES, FADE_CURVES } from "./keys.js";

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
    { label: "Mark in", kbd: "I", action: setIn },
    { label: "Mark out", kbd: "O", action: setOut },
    { label: "Clear in / out", kbd: "Alt+X", action: clearInOut },
  ];
  if (name === "view") return [
    ...app.docks.menuItems(),
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
  const items = [{ head: "Show keyframes for" }];
  for (const [name, def] of Object.entries(M.KEYABLE)) {
    if (!(def.kind === kind || def.kind === "any")) continue;
    if (name === "speed" && M.kindOf(clip) === "image") continue;
    const n = M.keysOf(clip, name).length;
    items.push({ label: `${def.label}${n ? `  (${n})` : ""}`, check: current === name,
      action: () => { const c = M.getClip(clip.id); if (c) { c.lane = name; bus.emit("change"); } } });
  }
  return items;
}

function contextMenu(x, y, hit) {
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
    const clip = hit.clip, which = hit.zone, field = which === "fadeIn" ? "fadeInCurve" : "fadeOutCurve";
    showMenu(x, y, [
      { head: which === "fadeIn" ? "Fade in shape" : "Fade out shape" },
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
      { label: "Reset speed to 100%", disabled: M.kindOf(clip) === "image", action: () => M.edit("Reset speed", () => M.setSpeed([...state.selection], 1)) },
      hit.row.kind === "video" ? { label: "Copy grade", action: copyGrade } : null,
      hit.row.kind === "video" ? { label: "Paste grade", action: pasteGrade } : null,
      "-",
      { label: "Show in media bin", action: () => { state.selectedMedia = clip.mediaId; app.docks.show("media"); bus.emit("media"); } },
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
    showMenu(x, y, [
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
    ["Space / K / L", "Play-pause / pause / play"], ["J", "Back one second"], ["← / →", "Previous / next frame (Shift: 1 second)"],
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
function onKey(e) {
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
    case "k": case "K": handled(); pb.pause(); break;
    case "l": case "L": handled(); pb.play(); break;
    case "j": case "J": handled(); pb.pause(); pb.seek(state.playhead - 1); break;
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
    case "r": case "R": handled(); setTool("range"); break;
    case "s": case "S": handled(); toggleSnap(); break;
    case "m": case "M": handled(); toggleMagnetic(); break;
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
  app.docks = new Docks([
    { id: "media", title: "Media", node: app.bin.node, dock: "left" },
    { id: "transitions", title: "Transitions", node: app.transitions.node, dock: "left" },
    { id: "inspector", title: "Inspector", node: app.inspector.node, dock: "right" },
    { id: "colour", title: "Colour", node: app.colour.node, dock: "right" },
    { id: "scopes", title: "Scopes", node: app.scopes.node, dock: "right", onShow: () => { app.scopes.visible = true; app.scopes.update(true); }, onHide: () => { app.scopes.visible = false; } },
    { id: "mixer", title: "Mixer", node: app.mixer.node, dock: "bottom", onShow: () => { app.mixer.visible = true; }, onHide: () => { app.mixer.visible = false; } },
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
  $("btnFullscreen").onclick = () => { const s = $("viewerStage"); document.fullscreenElement ? document.exitFullscreen() : s.requestFullscreen?.(); };
  bus.on("playstate", (playing) => { $("playIcon").innerHTML = playing ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4v16l13-8z"/>'; });
  bus.on("time", (t) => { $("tcCurrent").textContent = timecode(t, M.fps()); });
  for (const name of ["change", "selection", "range", "project"]) bus.on(name, updateInfo);
  bus.on("settings", () => app.playback.layout());
  bus.on("change", () => { if (!loading && P()) { setSaveState("Unsaved changes"); save(); } });

  // keyboard & window
  document.addEventListener("keydown", onKey);
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
