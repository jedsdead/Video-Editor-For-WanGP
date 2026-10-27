// Inspector panel: properties of the selected clips / transition, or project settings and media info.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { api, el, toast, timecode, shortTime, clamp } from "./util.js";
import { FAMILIES, AUDIO_TRANSITIONS, DISSOLVE_STYLES, IRIS_SHAPES, ANGLE_PRESETS, DEFAULT_PARAMS, MAX_BORDER, isAudioTransition, hasEdge } from "./transitions.js";

const RES_PRESETS = [[1280, 720], [1920, 1080], [3840, 2160], [832, 480], [480, 832], [720, 1280], [1080, 1920], [1024, 1024], [2560, 1080]];
const FPS_PRESETS = [16, 23.976, 24, 25, 30, 50, 60];

export class Inspector {
  constructor(app) {
    this.app = app;
    this.body = el("div.panel-scroll");
    this.node = el("div", {}, this.body);
    this.refreshers = [];
    this.metaCache = new Map();
    for (const name of ["selection", "project", "media-selected", "settings"]) bus.on(name, () => this.render());
    bus.on("change", () => this.refresh());
  }

  refresh() {
    const sig = this.signature();
    if (sig !== this.lastSig) { this.render(); return; }
    for (const fn of this.refreshers) fn();
  }

  signature() {
    if (!P()) return "";
    const clips = M.selectedClips().map(c => `${c.id}:${c.trackId}`).join(",");
    return `${clips}|${state.selTransition}|${state.selectedMedia}|${P().tracks.length}`;
  }

  render() {
    if (!P()) return;
    this.lastSig = this.signature();
    this.refreshers = [];
    this.body.innerHTML = "";
    const clips = M.selectedClips();
    if (state.selTransition) { this.renderTransition(); return; }
    if (clips.length) { this.renderClips(clips); return; }
    this.renderProject();
    if (state.selectedMedia && P().media[state.selectedMedia]) this.renderMedia(P().media[state.selectedMedia]);
  }

  // ---------------------------------------------------------------- field helpers
  section(title, ...children) { const s = el("div.insp-section", {}, el("h4", {}, title), ...children); this.body.append(s); return s; }

  slider(label, { get, set, min, max, step, format, editLabel, parse }) {
    const range = el("input", { type: "range", min, max, step });
    const num = el("input", { type: "number", min, max, step, style: { width: "64px" } });
    const update = () => {
      const v = get();
      if (document.activeElement !== range) range.value = v;
      if (document.activeElement !== num) num.value = format ? format(v) : v;
    };
    const apply = (v, key) => { if (!isFinite(v)) return; M.edit(editLabel || label, () => set(clamp(v, min, max)), { coalesceKey: key }); };
    range.addEventListener("input", () => apply(parseFloat(range.value), `${editLabel || label}-slider`));
    range.addEventListener("dblclick", () => { if (this.defaults && label in this.defaults) apply(this.defaults[label]); });
    num.addEventListener("change", () => apply(parse ? parse(num.value) : parseFloat(num.value), null));
    update();
    this.refreshers.push(update);
    return el("div.field", {}, el("label", {}, label), range, num);
  }

  numberField(label, { get, set, min = -1e9, max = 1e9, step = 1, editLabel }) {
    const num = el("input", { type: "number", min, max, step });
    const update = () => { if (document.activeElement !== num) num.value = +get().toFixed(3); };
    num.addEventListener("change", () => { const v = parseFloat(num.value); if (isFinite(v)) M.edit(editLabel || label, () => set(clamp(v, min, max))); });
    update();
    this.refreshers.push(update);
    return el("div.field.wide", {}, el("label", {}, label), num);
  }

  readout(label, get) {
    const span = el("span.val", { style: { textAlign: "left" } });
    const update = () => { span.textContent = get(); };
    update();
    this.refreshers.push(update);
    return el("div.field.wide", {}, el("label", {}, label), span);
  }

  // ---------------------------------------------------------------- clips
  renderClips(clips) {
    const first = clips[0];
    const video = clips.filter(c => M.trackKind(c.trackId) === "video");
    const audio = clips.filter(c => M.trackKind(c.trackId) === "audio");
    const each = (list, fn) => () => list.forEach(c => { const live = M.getClip(c.id); if (live) fn(live); });
    const live = (c) => M.getClip(c.id) || c;
    const fps = M.fps();
    if (clips.length === 1) {
      const nameInput = el("input", { type: "text", value: first.name || "", onchange: (e) => M.edit("Rename clip", () => { live(first).name = e.target.value; }) });
      this.section("Clip",
        el("div.field.wide", {}, el("label", {}, "Name"), nameInput),
        this.readout("Track", () => M.trackLabel(M.getTrack(live(first).trackId) || {})),
        this.readout("Start", () => timecode(live(first).start, fps)),
        this.readout("Duration", () => `${timecode(M.clipDur(live(first)), fps)}  (${shortTime(M.clipDur(live(first)))})`),
        M.kindOf(first) !== "image" ? this.readout("Source in / out", () => `${live(first).in.toFixed(2)}s → ${live(first).out.toFixed(2)}s`) : null,
        this.readout("Media", () => (M.mediaOf(first) || {}).name || "?"));
    } else {
      this.section(`${clips.length} clips selected`, el("div.dim", {}, "Changes apply to every selected clip of the matching kind."));
    }

    if (video.length) {
      const v0 = video[0];
      const g = (key, dflt) => () => (M.getClip(v0.id) || v0)[key] ?? dflt;
      this.defaults = { Opacity: 100, Scale: 100, "Position X": 0, "Position Y": 0 };
      this.section("Video",
        this.slider("Opacity", { get: () => Math.round(g("opacity", 1)() * 100), set: (v) => each(video, c => { c.opacity = v / 100; })(), min: 0, max: 100, step: 1 }),
        this.slider("Scale", { get: () => Math.round(g("scale", 1)() * 100), set: (v) => each(video, c => { c.scale = v / 100; })(), min: 5, max: 400, step: 1 }),
        this.slider("Position X", { get: g("x", 0), set: (v) => each(video, c => { c.x = v; })(), min: -P().settings.width, max: P().settings.width, step: 1 }),
        this.slider("Position Y", { get: g("y", 0), set: (v) => each(video, c => { c.y = v; })(), min: -P().settings.height, max: P().settings.height, step: 1 }),
        this.slider("Fade in", { get: g("fadeIn", 0), set: (v) => each(video, c => { c.fadeIn = Math.min(v, M.clipDur(c)); })(), min: 0, max: 10, step: 1 / fps, format: (v) => v.toFixed(2), editLabel: "Video fade in" }),
        this.slider("Fade out", { get: g("fadeOut", 0), set: (v) => each(video, c => { c.fadeOut = Math.min(v, M.clipDur(c)); })(), min: 0, max: 10, step: 1 / fps, format: (v) => v.toFixed(2), editLabel: "Video fade out" }),
        el("div.btnrow", {}, el("button.small", { onclick: () => M.edit("Reset transform", each(video, c => { c.opacity = 1; c.scale = 1; c.x = 0; c.y = 0; })) }, "Reset transform"),
          el("button.small", { onclick: () => this.app.docks.show("colour") }, "Colour…")));
    }

    const timed = clips.filter(c => M.kindOf(c) !== "image");
    if (timed.length) {
      const s0 = timed[0];
      const cur = () => M.getClip(s0.id) || s0;
      const rampBox = el("input", { type: "checkbox" });
      const startPct = el("input", { type: "number", min: 5, max: 1000, step: 1, style: { width: "70px" } });
      const endPct = el("input", { type: "number", min: 5, max: 1000, step: 1, style: { width: "70px" } });
      const interp = el("select", {}, [["default", "Export default"], ["nearest", "Nearest frame"], ["blend", "Frame blend"], ["rife", "Optical flow (RIFE)"]].map(([v, l]) => el("option", { value: v }, l)));
      const update = () => {
        const c = cur();
        const [a, b] = M.speeds(c);
        if (document.activeElement !== startPct) startPct.value = Math.round(a * 100);
        if (document.activeElement !== endPct) endPct.value = Math.round(b * 100);
        rampBox.checked = M.isRamped(c) || this.rampOn === c.id;
        endPct.disabled = !rampBox.checked;
        interp.value = c.interp || "default";
      };
      const applySpeed = () => {
        const a = clamp(parseFloat(startPct.value) || 100, 5, 1000) / 100;
        const b = rampBox.checked ? clamp(parseFloat(endPct.value) || 100, 5, 1000) / 100 : null;
        M.edit("Change speed", () => M.setSpeed(timed.map(c => c.id), a, b));
      };
      startPct.addEventListener("change", applySpeed);
      endPct.addEventListener("change", applySpeed);
      rampBox.addEventListener("change", () => { this.rampOn = rampBox.checked ? cur().id : null; if (!rampBox.checked) applySpeed(); else { endPct.disabled = false; endPct.focus(); } });
      interp.addEventListener("change", () => M.edit("Interpolation", each(timed, c => { c.interp = interp.value; })));
      update();
      this.refreshers.push(update);
      const presets = el("div.btnrow", {}, [25, 50, 100, 200, 400].map(p => el("button.small", { onclick: () => { startPct.value = p; rampBox.checked = false; this.rampOn = null; applySpeed(); } }, `${p}%`)),
        el("button.small", { title: "Ramp from normal speed down to 25% (slow-motion ending)", onclick: () => { startPct.value = 100; endPct.value = 25; rampBox.checked = true; applySpeed(); } }, "Ramp ↘"),
        el("button.small", { title: "Ramp from 25% up to normal speed", onclick: () => { startPct.value = 25; endPct.value = 100; rampBox.checked = true; applySpeed(); } }, "Ramp ↗"));
      this.section("Speed",
        el("div.field", {}, el("label", {}, "Speed %"), startPct, el("span")),
        el("div.field", {}, el("label", {}, el("label", { style: { display: "flex", gap: "4px", alignItems: "center", color: "inherit" } }, rampBox, "Ramp to %")), endPct, el("span")),
        presets,
        el("div.field.wide", {}, el("label", {}, "In-betweens"), interp),
        el("div.dim", { style: { fontSize: "11px", marginTop: "4px" } }, "Ramps change speed smoothly across the clip; blade a clip to build multi-stage ramps. Optical flow is applied on export; the viewer shows the timing live."));
    }

    if (audio.length) {
      const a0 = audio[0];
      const g = (key, dflt) => () => (M.getClip(a0.id) || a0)[key] ?? dflt;
      this.defaults = { ...(this.defaults || {}), Volume: 0 };
      this.section("Audio",
        this.slider("Volume", { get: g("volume", 0), set: (v) => each(audio, c => { c.volume = v; })(), min: -60, max: 12, step: 0.1, format: (v) => v.toFixed(1), editLabel: "Clip volume" }),
        this.slider("Fade in ", { get: g("fadeIn", 0), set: (v) => each(audio, c => { c.fadeIn = Math.min(v, M.clipDur(c)); })(), min: 0, max: 10, step: 0.01, format: (v) => v.toFixed(2), editLabel: "Audio fade in" }),
        this.slider("Fade out ", { get: g("fadeOut", 0), set: (v) => each(audio, c => { c.fadeOut = Math.min(v, M.clipDur(c)); })(), min: 0, max: 10, step: 0.01, format: (v) => v.toFixed(2), editLabel: "Audio fade out" }),
        el("div.dim", { style: { fontSize: "11px" } }, "Volume is in dB. Track level and pan are in the Mixer."));
    }

    if (clips.length === 1 || new Set(clips.map(c => c.mediaId)).size === 1) {
      const item = M.mediaOf(first);
      if (item && item.has_metadata) this.renderGeneration(item);
    }
  }

  // ---------------------------------------------------------------- generation metadata (WanGP outputs)
  async renderGeneration(item) {
    const holder = this.section("Generation", el("div.dim", {}, "Loading…"));
    let meta = this.metaCache.get(item.id);
    if (!meta) {
      try { meta = await api(`api/media/${item.id}/metadata`); this.metaCache.set(item.id, meta); }
      catch (_) { meta = {}; }
    }
    holder.innerHTML = "";
    holder.append(el("h4", {}, "Generation"));
    const prompt = meta.prompt || meta.text_prompt || "";
    if (prompt) holder.append(el("div.prompt-box", {}, prompt));
    const rows = [["Model", meta.model_type || meta.model_filename || meta.type], ["Seed", meta.seed], ["Resolution", meta.resolution], ["Frames", meta.video_length],
                  ["Steps", meta.num_inference_steps], ["Guidance", meta.guidance_scale], ["Negative", meta.negative_prompt]].filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (rows.length) holder.append(el("div.kv", { style: { marginTop: "6px" } }, rows.flatMap(([k, v]) => [el("span", {}, k), el("span", {}, String(v))])));
    holder.append(el("div.btnrow", {}, prompt ? el("button.small", { onclick: () => navigator.clipboard?.writeText(prompt).then(() => toast("Prompt copied")) }, "Copy prompt") : null,
      el("button.small", { onclick: () => navigator.clipboard?.writeText(JSON.stringify(meta, null, 2)).then(() => toast("Settings copied as JSON")) }, "Copy all settings")));
    holder.append(el("div.dim", { style: { fontSize: "11px", marginTop: "6px" } }, "Regenerating a shot from these settings is planned for version 2."));
  }

  // ---------------------------------------------------------------- transition
  renderTransition() {
    const tr = P().transitions.find(t => t.id === state.selTransition);
    if (!tr) return;
    const live = () => P().transitions.find(x => x.id === tr.id) || tr;
    const params = () => (live().params ||= {});
    const audio = isAudioTransition(tr.type);
    const setParam = (key, value, label, coalesce = false) =>
      M.edit(label, () => { live().params = { ...params(), [key]: value }; }, coalesce ? { coalesceKey: `trp-${key}-${tr.id}` } : {});
    const options = audio ? AUDIO_TRANSITIONS.map(a => [a.id, a.label]) : FAMILIES.map(f => [f.id, f.label]);
    const select = el("select", { onchange: (e) => {
      const type = e.target.value;
      M.edit("Transition type", () => { const t = live(); t.type = type; t.params = audio ? {} : { ...DEFAULT_PARAMS[type] }; });
      this.render();
    } }, options.map(([id, label]) => el("option", { value: id, selected: id === tr.type }, label)));
    const warn = el("div.warn");
    const updateWarn = () => {
      const h = M.transitionHandles(live());
      if (!h) { warn.textContent = ""; return; }
      const parts = [];
      if (h.spareA + 1e-3 < h.needed) parts.push(`the outgoing clip has ${h.spareA.toFixed(2)}s of extra footage`);
      if (h.spareB + 1e-3 < h.needed) parts.push(`the incoming clip has ${h.spareB.toFixed(2)}s before its in-point`);
      warn.textContent = parts.length ? `The transition needs ${h.needed.toFixed(2)}s on each side, but ${parts.join(" and ")}; the first/last frame is held for the rest.` : "";
    };
    updateWarn();
    this.refreshers.push(updateWarn);

    const controls = [];
    const p0 = params();
    const check = (key, text, label) => {
      const box = el("input", { type: "checkbox", checked: !!p0[key], onchange: (e) => setParam(key, e.target.checked, label) });
      this.refreshers.push(() => { box.checked = !!params()[key]; });
      return el("div.field.wide", {}, el("label", {}, ""), el("label", { style: { display: "flex", gap: "6px", alignItems: "center", color: "inherit" } }, box, text));
    };
    const choose = (key, list, text, after) => {
      const sel = el("select", { onchange: (e) => { setParam(key, e.target.value, text); if (after) this.render(); } },
        list.map(([id, label]) => el("option", { value: id, selected: id === p0[key] }, label)));
      return el("div.field.wide", {}, el("label", {}, text), sel);
    };
    const angle = () => {
      const presets = el("div.btnrow", {}, ANGLE_PRESETS.map(([deg, arrow]) => el("button.small", { title: `${deg}°`, style: { minWidth: "30px" }, onclick: () => setParam("angle", deg, "Transition angle") }, arrow)));
      return [this.slider("Angle", { get: () => Number(params().angle) || 0, set: (v) => { live().params = { ...params(), angle: v }; }, min: 0, max: 359, step: 1, format: (v) => Math.round(v), editLabel: "Transition angle" }),
        presets, el("div.dim", { style: { fontSize: "11px" } }, "The direction the edge travels: 0° moves right, 90° moves up.")];
    };
    if (tr.type === "dissolve") {
      controls.push(choose("style", DISSOLVE_STYLES, "Style", true));
      if (p0.style === "dip") {
        const colour = el("input", { type: "color", value: p0.color || "#000000", oninput: (e) => setParam("color", e.target.value, "Dip colour", true) });
        controls.push(el("div.field.wide", {}, el("label", {}, "Colour"), colour));
      }
    } else if (tr.type === "wipe") controls.push(...angle());
    else if (tr.type === "slide") controls.push(...angle(), check("push", "Push (the outgoing clip moves out too)", "Push"));
    else if (tr.type === "iris") controls.push(choose("shape", IRIS_SHAPES, "Shape"), check("reverse", "Reverse (close in instead of opening out)", "Reverse"));
    else if (tr.type === "clock") controls.push(check("reverse", "Reverse (anticlockwise)", "Reverse"));
    else if (tr.type === "blinds") {
      controls.push(...angle());
      controls.push(this.slider("Blinds", { get: () => Number(params().count) || 8, set: (v) => { live().params = { ...params(), count: Math.round(v) }; }, min: 2, max: 40, step: 1, format: (v) => Math.round(v), editLabel: "Blind count" }));
    } else if (tr.type === "barn") controls.push(...angle(), check("reverse", "Reverse (doors close)", "Reverse"));

    this.section(audio ? "Audio transition" : "Video transition",
      el("div.field.wide", {}, el("label", {}, "Type"), select),
      ...controls,
      this.numberField("Duration (s)", { get: () => live().duration, set: (v) => { live().duration = v; }, min: M.frameDur(), max: 30, step: 1 / M.fps() }),
      warn,
      el("div.btnrow", {}, el("button.small.danger", { onclick: () => M.edit("Delete transition", () => { P().transitions = P().transitions.filter(t => t.id !== tr.id); }) }, "Delete transition")));
    if (hasEdge(tr.type)) this.renderEdge(live);
  }

  // Edge of wipes, slides, irises etc: hard with an optional coloured border, or feathered (border = softness).
  renderEdge(live) {
    const feather = el("input", { type: "checkbox" });
    const colour = el("input", { type: "color", style: { width: "48px", height: "24px", padding: "0" } });
    const note = el("div.dim", { style: { fontSize: "11px", marginTop: "4px" } });
    const update = () => {
      const t = live();
      feather.checked = !!t.feather;
      if (document.activeElement !== colour) colour.value = t.borderColor || "#ffffff";
      colour.disabled = !!t.feather;
      note.textContent = t.feather ? "Feather on: Border sets how soft the edge is." : "Feather off: Border draws a solid line in the colour on the right. 0% is a clean hard edge.";
    };
    feather.addEventListener("change", () => M.edit("Transition feather", () => {
      const t = live();
      t.feather = feather.checked;
      if (t.feather && !(t.border > 0)) t.border = 0.1;
    }));
    colour.addEventListener("input", () => M.edit("Border colour", () => { live().borderColor = colour.value; }, { coalesceKey: `bcol-${live().id}` }));
    update();
    this.refreshers.push(update);
    this.section("Edge",
      el("div.field.wide", {}, el("label", {}, "Feather"), el("label", { style: { display: "flex", gap: "6px", alignItems: "center", color: "inherit" } }, feather, "Soft edge")),
      el("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
        el("div", { style: { flex: "1" } }, this.slider("Border", { get: () => Math.round((live().border || 0) * 1000) / 10, set: (v) => { live().border = v / 100; },
          min: 0, max: MAX_BORDER * 100, step: 0.5, format: (v) => v.toFixed(1), editLabel: "Transition border" })),
        colour),
      note);
  }

  // ---------------------------------------------------------------- project & media
  renderProject() {
    const s = P().settings;
    const res = el("select", { onchange: (e) => {
      if (!e.target.value) return;
      const [w, h] = e.target.value.split("x").map(Number);
      M.edit("Resolution", () => { s.width = w; s.height = h; s.auto = false; });
      bus.emit("settings");
    } }, el("option", { value: "" }, "Presets…"), RES_PRESETS.map(([w, h]) => el("option", { value: `${w}x${h}` }, `${w} × ${h}`)));
    const fpsSel = el("select", { onchange: (e) => { const v = parseFloat(e.target.value); if (v) { M.edit("Frame rate", () => { s.fps = v; s.auto = false; }); bus.emit("settings"); } } },
      el("option", { value: "" }, "Presets…"), FPS_PRESETS.map(f => el("option", { value: f }, `${f} fps`)));
    this.section("Project",
      el("div.dim", { style: { marginBottom: "6px", fontSize: "12px" } }, s.auto ? "The first video you add sets the resolution and frame rate." : ""),
      this.numberField("Width", { get: () => s.width, set: (v) => { s.width = Math.round(v / 2) * 2; s.auto = false; bus.emit("settings"); }, min: 64, max: 8192, step: 2, editLabel: "Resolution" }),
      this.numberField("Height", { get: () => s.height, set: (v) => { s.height = Math.round(v / 2) * 2; s.auto = false; bus.emit("settings"); }, min: 64, max: 8192, step: 2, editLabel: "Resolution" }),
      el("div.field.wide", {}, el("label", {}, ""), res),
      this.numberField("Frame rate", { get: () => s.fps, set: (v) => { s.fps = v; s.auto = false; bus.emit("settings"); }, min: 1, max: 240, step: 0.001, editLabel: "Frame rate" }),
      el("div.field.wide", {}, el("label", {}, ""), fpsSel),
      this.readout("Length", () => timecode(M.timelineEnd(), M.fps())),
      this.readout("Clips", () => `${P().clips.length} on ${P().tracks.length} tracks`));
    this.section("Tips", el("div.dim", { style: { fontSize: "12px", lineHeight: "1.5" } },
      "Drag media onto the timeline. V/B/R switch between Select, Blade and Range. M toggles the magnetic timeline, S toggles snapping. Right-click clips and panel tabs for more options. Help → Shortcuts lists every key."));
  }

  renderMedia(item) {
    const rows = [["Name", item.name], ["Kind", item.kind], ["Path", item.path], item.width ? ["Size", `${item.width} × ${item.height}`] : null,
      item.fps ? ["Frame rate", `${item.fps} fps`] : null, item.duration ? ["Duration", shortTime(item.duration)] : null,
      item.vcodec ? ["Video codec", item.vcodec] : null, item.acodec ? ["Audio codec", item.acodec] : null,
      ["Preview", item.proxy === "ready" ? "Proxy ready" : item.proxy === "error" ? `Proxy failed (${item.error || "?"})` : item.proxy === "none" ? "Original file" : "Building proxy…"]].filter(Boolean);
    this.section("Media", el("div.kv", {}, rows.flatMap(([k, v]) => [el("span", {}, k), el("span", {}, String(v))])));
    if (item.has_metadata) this.renderGeneration(item);
  }
}
