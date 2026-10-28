// Inspector panel: properties of the selected clips / transition, or project settings and media info.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { api, el, toast, timecode, shortTime, clamp } from "./util.js";
import { CURVES, FADE_CURVES } from "./keys.js";
import { FONT_FALLBACK } from "./titles.js";
import { EFFECTS, EFFECT_ORDER, defaultEffectParams } from "./effects.js";
import { openRegenDialog, canRegenerate } from "./regen.js";
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
    let lastTime = 0;
    bus.on("time", () => { const now = performance.now(); if (now - lastTime > 120) { lastTime = now; for (const fn of this.refreshers) fn(); } });
  }

  refresh() {
    const sig = this.signature();
    if (sig !== this.lastSig) { this.render(); return; }
    for (const fn of this.refreshers) fn();
  }

  signature() {
    if (!P()) return "";
    const clips = M.selectedClips().map(c => `${c.id}:${c.trackId}:${(c.effects || []).map(f => f.id).join(".")}:${c.takeIndex || 0}/${c.takes?.length || 0}`).join(",");
    return `${clips}|${state.selTransition}|${state.selectedMedia}|${P().tracks.length}`;
  }

  render() {
    if (!P()) return;
    this.lastSig = this.signature();
    this.refreshers = [];
    for (const fn of this.cleanups || []) fn();
    this.cleanups = [];
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
    const videoAll = clips.filter(c => M.trackKind(c.trackId) === "video");
    const adjust = videoAll.filter(c => M.kindOf(c) === "adjust");
    const video = videoAll.filter(c => M.kindOf(c) !== "adjust");
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
        !M.isStill(first) ? this.readout("Source in / out", () => `${live(first).in.toFixed(2)}s → ${live(first).out.toFixed(2)}s`) : null,
        this.readout("Media", () => (M.mediaOf(first) || {}).name || "?"));
    } else {
      this.section(`${clips.length} clips selected`, el("div.dim", {}, "Changes apply to every selected clip of the matching kind."));
    }

    // a shot and its linked audio share the same shot details: show them once
    const shotClip = clips.find(c => c.shotInfo && M.trackKind(c.trackId) === "video") || clips.find(c => c.shotInfo);
    if (shotClip && clips.every(c => c.mediaId === shotClip.mediaId && c.shotInfo?.index === shotClip.shotInfo.index)) this.renderShot(shotClip);
    const regenClip = clips.length === 1 || (clips.length === 2 && clips[0].linkId && clips[0].linkId === clips[1].linkId) ? clips.find(c => canRegenerate(c)) : null;
    if (regenClip) this.renderRegen(regenClip);

    if (video.length) {
      const pw = P().settings.width, ph = P().settings.height;
      this.defaults = { Opacity: 100, Scale: 100, "Position X": 0, "Position Y": 0 };
      this.section("Video",
        this.keySlider("Opacity", video, "opacity", { toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => v / 100, min: 0, max: 100, step: 0.5 }),
        this.keySlider("Scale", video, "scale", { toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => v / 100, min: 0, max: 400, step: 0.5 }),
        this.keySlider("Position X", video, "x", { toUi: (v) => Math.round(v), fromUi: (v) => v, min: -pw, max: pw, step: 1 }),
        this.keySlider("Position Y", video, "y", { toUi: (v) => Math.round(v), fromUi: (v) => v, min: -ph, max: ph, step: 1 }),
        this.keySlider("Rotation", video, "rotation", { toUi: (v) => Math.round(v * 10) / 10, fromUi: (v) => v, min: -360, max: 360, step: 0.5, format: (v) => v.toFixed(1) }),
        this.keySlider("Crop left", video, "cropL", { toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => v / 100, min: 0, max: 99, step: 0.5 }),
        this.keySlider("Crop right", video, "cropR", { toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => v / 100, min: 0, max: 99, step: 0.5 }),
        this.keySlider("Crop top", video, "cropT", { toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => v / 100, min: 0, max: 99, step: 0.5 }),
        this.keySlider("Crop bottom", video, "cropB", { toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => v / 100, min: 0, max: 99, step: 0.5 }),
        this.slider("Fade in", { get: () => (M.getClip(video[0].id) || video[0]).fadeIn || 0, set: (v) => each(video, c => { c.fadeIn = Math.min(v, M.clipDur(c)); })(), min: 0, max: 10, step: 1 / fps, format: (v) => v.toFixed(2), editLabel: "Video fade in" }),
        this.curveSelect("Fade in shape", video, "fadeInCurve"),
        this.slider("Fade out", { get: () => (M.getClip(video[0].id) || video[0]).fadeOut || 0, set: (v) => each(video, c => { c.fadeOut = Math.min(v, M.clipDur(c)); })(), min: 0, max: 10, step: 1 / fps, format: (v) => v.toFixed(2), editLabel: "Video fade out" }),
        this.curveSelect("Fade out shape", video, "fadeOutCurve"),
        el("div.btnrow", {}, el("button.small", { onclick: () => M.edit("Reset transform", each(video, c => {
            Object.assign(c, { opacity: 1, scale: 1, x: 0, y: 0, rotation: 0, cropL: 0, cropR: 0, cropT: 0, cropB: 0 });
            for (const n of ["opacity", "scale", "x", "y", "rotation", "cropL", "cropR", "cropT", "cropB"]) if (c.keys) delete c.keys[n];
          })) }, "Reset transform"),
          el("button.small", { title: "Show crop handles on the viewer (C)", onclick: () => this.app.overlay.setCropMode(!this.app.overlay.cropMode) }, "Crop on viewer"),
          el("button.small", { onclick: () => this.app.docks.show("colour") }, "Colour…")),
        this.keyHelp());
    }

    if (adjust.length) this.renderAdjust(adjust);
    const gens = clips.filter(c => M.kindOf(c) === "solid" || M.kindOf(c) === "gradient");
    if (gens.length === 1) this.renderGenerator(gens[0]);
    const titles = clips.filter(c => M.kindOf(c) === "title");
    if (titles.length) this.renderTitle(titles);
    if (videoAll.length) this.renderEffects(videoAll);

    const timed = clips.filter(c => !M.isStill(c));
    if (timed.length) this.renderSpeed(timed);

    if (audio.length) {
      this.defaults = { ...(this.defaults || {}), Volume: 0 };
      this.section("Audio",
        this.keySlider("Volume", audio, "volume", { toUi: (v) => Math.round(v * 10) / 10, fromUi: (v) => v, min: -60, max: 12, step: 0.1, format: (v) => v.toFixed(1) }),
        this.slider("Fade in ", { get: () => (M.getClip(audio[0].id) || audio[0]).fadeIn || 0, set: (v) => each(audio, c => { c.fadeIn = Math.min(v, M.clipDur(c)); })(), min: 0, max: 10, step: 0.01, format: (v) => v.toFixed(2), editLabel: "Audio fade in" }),
        this.curveSelect("Fade in shape ", audio, "fadeInCurve"),
        this.slider("Fade out ", { get: () => (M.getClip(audio[0].id) || audio[0]).fadeOut || 0, set: (v) => each(audio, c => { c.fadeOut = Math.min(v, M.clipDur(c)); })(), min: 0, max: 10, step: 0.01, format: (v) => v.toFixed(2), editLabel: "Audio fade out" }),
        this.curveSelect("Fade out shape ", audio, "fadeOutCurve"),
        el("div.dim", { style: { fontSize: "11px" } }, "Volume is in dB. Track level and pan are in the Mixer."),
        video.length ? null : this.keyHelp());
    }

    if (clips.length === 1 || new Set(clips.map(c => c.mediaId)).size === 1) {
      const item = M.mediaOf(first);
      if (item && item.has_metadata) this.renderGeneration(item);
    }
  }

  // ---------------------------------------------------------------- keyframed fields
  keyHelp() {
    return el("div.dim", { style: { fontSize: "11px", marginTop: "6px", lineHeight: "1.45" } },
      "◆ adds or removes a keyframe at the playhead. Once a property has keyframes, changing it adds one automatically. On the timeline, Ctrl+click a clip's line to add one, drag points to move them and right-click a point for its ease. Right-click a clip to choose which property its line shows.");
  }

  curveSelect(label, list, field) {
    const sel = el("select", { onchange: (e) => M.edit("Fade shape", () => { for (const c of list) { const l = M.getClip(c.id); if (l) l[field] = e.target.value; } }) },
      FADE_CURVES.map(([id, text]) => el("option", { value: id }, text)));
    const update = () => { if (document.activeElement !== sel) sel.value = (M.getClip(list[0].id) || list[0])[field] || "linear"; };
    update();
    this.refreshers.push(update);
    return el("div.field.wide", {}, el("label", {}, label.trim()), sel);
  }

  // A slider for a keyable property, with ◀ ◆ ▶ keyframe controls and the ease of the key under the playhead.
  keySlider(label, list, name, { toUi, fromUi, min, max, step, format }) {
    const live = (c) => M.getClip(c.id) || c;
    const tauOf = (c) => state.playhead - live(c).start;
    const inside = (c) => { const t = tauOf(c); return t >= -1e-6 && t <= M.clipDur(live(c)) + 1e-6; };
    const primary = () => live(list[0]);
    const valueAt = (c) => M.prop(live(c), name, Math.max(0, Math.min(M.clipDur(live(c)), tauOf(c))));
    const field = this.slider(label, {
      get: () => toUi(valueAt(list[0])),
      set: (ui) => {
        const v = fromUi(ui);
        for (const c of list) {
          const l = live(c);
          if (M.hasKeys(l, name)) { if (inside(c)) M.setKeyAt(l.id, name, M.snapFrame(tauOf(c)), v); }
          else if (name === "speed") M.setSpeed([l.id], Math.max(0.01, v));
          else if (name.startsWith("fx:")) M.setEffectStatic(l, name, v);
          else l[name] = v;
        }
      }, min, max, step, format, editLabel: label,
    });
    const diamond = el("button.small.kbtn", { title: "Add / remove a keyframe at the playhead" }, "◆");
    const prev = el("button.small.kbtn", { title: "Previous keyframe" }, "◀");
    const next = el("button.small.kbtn", { title: "Next keyframe" }, "▶");
    const ease = el("select", { title: "Ease from this keyframe to the next" }, CURVES.map(([id, text]) => el("option", { value: id }, text)));
    const easeRow = el("div.field.wide.keyease", {}, el("label", {}, "↳ ease"), ease);
    const keyTimes = () => M.keysOf(primary(), name).map(k => primary().start + k.t).sort((a, b) => a - b);
    const update = () => {
      const c = primary();
      const keyed = M.hasKeys(c, name);
      const idx = inside(list[0]) ? M.keyIndexAt(c, name, tauOf(list[0])) : -1;
      diamond.classList.toggle("on", idx >= 0);
      diamond.classList.toggle("keyed", keyed);
      diamond.disabled = !inside(list[0]);
      diamond.title = inside(list[0]) ? (idx >= 0 ? "Remove the keyframe at the playhead" : "Add a keyframe at the playhead") : "Move the playhead over the clip to add keyframes";
      const times = keyTimes();
      prev.disabled = !times.some(t => t < state.playhead - 1e-4);
      next.disabled = !times.some(t => t > state.playhead + 1e-4);
      prev.hidden = next.hidden = !keyed;
      easeRow.hidden = idx < 0;
      if (idx >= 0 && document.activeElement !== ease) ease.value = M.keysOf(c, name)[idx].ease || "linear";
    };
    diamond.addEventListener("click", () => {
      const c = primary();
      const idx = M.keyIndexAt(c, name, tauOf(list[0]));
      M.edit(idx >= 0 ? "Remove keyframe" : "Add keyframe", () => {
        for (const item of list) {
          const l = live(item);
          if (!inside(item)) continue;
          const tau = M.snapFrame(tauOf(item));
          const i = M.keyIndexAt(l, name, tau);
          if (idx >= 0) { if (i >= 0) M.removeKey(l.id, name, i); }
          else M.setKeyAt(l.id, name, tau, M.prop(l, name, tau));
        }
      });
    });
    prev.addEventListener("click", () => { const t = keyTimes().filter(t => t < state.playhead - 1e-4).pop(); if (t !== undefined) { this.app.playback.pause(); this.app.playback.seek(t); } });
    next.addEventListener("click", () => { const t = keyTimes().find(t => t > state.playhead + 1e-4); if (t !== undefined) { this.app.playback.pause(); this.app.playback.seek(t); } });
    ease.addEventListener("change", () => M.edit("Keyframe ease", () => {
      for (const item of list) { const l = live(item); const i = M.keyIndexAt(l, name, tauOf(item)); if (i >= 0) M.setKeyEase(l.id, name, i, ease.value); }
    }));
    update();
    this.refreshers.push(update);
    field.classList.add("keyed");
    field.append(el("span.kctl", {}, prev, diamond, next));
    return el("div", {}, field, easeRow);
  }

  reverseRow(timed) {
    const box = el("input", { type: "checkbox" });
    const update = () => { box.checked = !!(M.getClip(timed[0].id) || timed[0]).reverse; };
    box.addEventListener("change", () => {
      M.edit("Reverse", () => M.setReverse(timed.map(c => c.id), box.checked));
      if (box.checked) for (const c of timed) this.app.prepareReverse(M.mediaOf(c));
    });
    update();
    this.refreshers.push(update);
    return el("div.field.wide", {}, el("label", {}, "Direction"), el("label", { style: { display: "flex", gap: "6px", alignItems: "center", color: "inherit" } }, box, "Reverse (play backwards)"));
  }

  // ---------------------------------------------------------------- shots (from Detect shots)
  renderShot(clip) {
    const info = clip.shotInfo;
    const [a, b] = info.source || [0, 0];
    const parts = [el("div.kv", {}, el("span", {}, "Shot"), el("span", {}, `${info.index} of ${info.count}`),
      el("span", {}, "Source"), el("span", {}, `${a.toFixed(2)}s – ${b.toFixed(2)}s`))];
    if (!info.shots?.length) parts.push(el("div.dim", { style: { fontSize: "11px", marginTop: "6px" } }, "Found from the picture. This clip's prompt has no shot list."));
    for (const s of info.shots || []) {
      parts.push(el("div.dim", { style: { fontSize: "11px", margin: "8px 0 3px" } }, `Prompt: window ${s.window}, shot ${s.shot}`),
        el("div.prompt-box", {}, s.text),
        el("div.btnrow", {}, el("button.small", { onclick: () => navigator.clipboard?.writeText(s.text).then(() => toast("Shot text copied")) }, "Copy shot text")));
    }
    this.section("Shot", ...parts);
  }

  // ---------------------------------------------------------------- adjustment layers & generators
  renderAdjust(list) {
    const fps = M.fps();
    const each = (fn) => () => list.forEach(c => { const l = M.getClip(c.id); if (l) fn(l); });
    this.defaults = { ...(this.defaults || {}), Opacity: 100 };
    this.section("Adjustment layer",
      el("div.dim", { style: { fontSize: "11px", marginBottom: "6px", lineHeight: "1.45" } },
        "Its colour grade and effects apply to everything on the tracks below it, for as long as it lasts. Opacity mixes the result with the original."),
      this.keySlider("Opacity", list, "opacity", { toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => v / 100, min: 0, max: 100, step: 0.5 }),
      this.slider("Fade in", { get: () => (M.getClip(list[0].id) || list[0]).fadeIn || 0, set: (v) => each(c => { c.fadeIn = Math.min(v, M.clipDur(c)); })(), min: 0, max: 10, step: 1 / fps, format: (v) => v.toFixed(2), editLabel: "Fade in" }),
      this.curveSelect("Fade in shape", list, "fadeInCurve"),
      this.slider("Fade out", { get: () => (M.getClip(list[0].id) || list[0]).fadeOut || 0, set: (v) => each(c => { c.fadeOut = Math.min(v, M.clipDur(c)); })(), min: 0, max: 10, step: 1 / fps, format: (v) => v.toFixed(2), editLabel: "Fade out" }),
      this.curveSelect("Fade out shape", list, "fadeOutCurve"),
      el("div.btnrow", {}, el("button.small", { onclick: () => this.app.docks.show("colour") }, "Colour…"), el("button.small", { onclick: () => this.app.docks.show("effects") }, "Effects…")));
  }

  renderGenerator(clip) {
    const live = () => M.getClip(clip.id) || clip;
    const kind = M.kindOf(clip);
    const set = (key, value, label) => M.edit(label, () => { const l = live(); l.gen = { ...(l.gen || {}), [key]: value }; }, { coalesceKey: `gen-${key}-${clip.id}` });
    const colour = (key, label) => {
      const input = el("input", { type: "color", value: live().gen?.[key] || "#000000", oninput: (e) => set(key, e.target.value, label) });
      this.refreshers.push(() => { if (document.activeElement !== input) input.value = live().gen?.[key] || "#000000"; });
      return el("div.field.wide", {}, el("label", {}, label), input);
    };
    const parts = kind === "solid" ? [colour("color", "Colour")] : [colour("color", "Start colour"), colour("color2", "End colour"),
      this.slider("Angle", { get: () => Number(live().gen?.angle) || 0, set: (v) => { const l = live(); l.gen = { ...(l.gen || {}), angle: v }; }, min: 0, max: 359, step: 1, format: (v) => Math.round(v), editLabel: "Gradient angle" }),
      el("div.dim", { style: { fontSize: "11px" } }, "The direction the gradient runs from the start colour to the end colour: 0° is left to right, 90° is bottom to top.")];
    this.section(kind === "solid" ? "Solid colour" : "Gradient", ...parts);
  }

  // ---------------------------------------------------------------- effects
  renderEffects(list) {
    const holder = this.section("Effects");
    const add = el("select", { onchange: (e) => {
      const type = e.target.value;
      e.target.value = "";
      if (!type) return;
      M.edit(`Add ${EFFECTS[type].label}`, () => M.addEffect(list.map(c => c.id), type, defaultEffectParams(type)));
      this.render();
    } }, el("option", { value: "" }, "Add effect…"), EFFECT_ORDER.map(id => el("option", { value: id }, EFFECTS[id].label)));
    holder.append(el("div.field.wide", {}, el("label", {}, ""), add));
    if (list.length > 1) {
      const count = list.reduce((n, c) => n + (c.effects || []).length, 0);
      holder.append(el("div.dim", { style: { fontSize: "11px" } }, `${count} effect${count === 1 ? "" : "s"} across ${list.length} clips. Select one clip to edit its effects; Add effect adds to every selected clip.`),
        count ? el("div.btnrow", {}, el("button.small.danger", { onclick: () => { M.edit("Remove effects", () => { for (const c of list) { const l = M.getClip(c.id); if (l) for (const f of [...(l.effects || [])]) M.removeEffect(l.id, f.id); } }); this.render(); } }, "Remove all effects")) : null);
      return;
    }
    const clip = list[0];
    const live = () => M.getClip(clip.id) || clip;
    const effects = live().effects || [];
    if (!effects.length) holder.append(el("div.dim", { style: { fontSize: "11px" } }, "No effects. Pick one above, or drag one from the Effects panel onto the clip."));
    effects.forEach((fx, index) => {
      const def = EFFECTS[fx.type];
      if (!def) return;
      const fxLive = () => (live().effects || []).find(f => f.id === fx.id) || fx;
      const change = (label, fn) => M.edit(label, () => M.updateEffect(clip.id, fx.id, fn));
      const on = el("input", { type: "checkbox", checked: fx.on !== false, title: "Turn the effect on or off", onchange: (e) => change(`${def.label} on/off`, f => { f.on = e.target.checked; }) });
      this.refreshers.push(() => { on.checked = fxLive().on !== false; });
      const head = el("div.fxhead", {}, on, el("span.fxname", {}, def.label), el("div.spacer"),
        el("button.small.kbtn", { title: "Move up (earlier in the chain)", disabled: index === 0, onclick: () => { M.edit("Reorder effects", () => M.moveEffect(clip.id, fx.id, -1)); this.render(); } }, "▲"),
        el("button.small.kbtn", { title: "Move down (later in the chain)", disabled: index === effects.length - 1, onclick: () => { M.edit("Reorder effects", () => M.moveEffect(clip.id, fx.id, 1)); this.render(); } }, "▼"),
        el("button.small.kbtn", { title: "Reset to defaults", onclick: () => { M.edit(`Reset ${def.label}`, () => {
          const l = live();
          for (const name of Object.keys(l.keys || {})) if (name.startsWith(`fx:${fx.id}:`)) delete l.keys[name];
          M.updateEffect(clip.id, fx.id, f => { f.params = defaultEffectParams(fx.type); });
        }); this.render(); } }, "↺"),
        el("button.small.kbtn", { title: "Remove the effect", onclick: () => { M.edit(`Remove ${def.label}`, () => M.removeEffect(clip.id, fx.id)); this.render(); } }, "✕"));
      const rows = [];
      for (const p of def.params) {
        const value = () => fxLive().params?.[p.key] ?? p.def;
        if (p.type === "check") {
          const box = el("input", { type: "checkbox", checked: !!value(), onchange: (e) => change(`${def.label} ${p.label}`, f => { f.params[p.key] = e.target.checked; }) });
          this.refreshers.push(() => { box.checked = !!value(); });
          rows.push(el("div.field.wide", {}, el("label", {}, ""), el("label", { style: { display: "flex", gap: "6px", alignItems: "center", color: "inherit" } }, box, p.label)));
        } else if (p.type === "color") {
          const input = el("input", { type: "color", value: value(), oninput: (e) => M.edit(`${def.label} ${p.label}`, () => M.updateEffect(clip.id, fx.id, f => { f.params[p.key] = e.target.value; }), { coalesceKey: `fxc-${fx.id}-${p.key}` }) });
          this.refreshers.push(() => { if (document.activeElement !== input) input.value = value(); });
          rows.push(el("div.field.wide", {}, el("label", {}, p.label), input));
        } else if (p.type === "select") {
          const sel = el("select", { onchange: (e) => change(`${def.label} ${p.label}`, f => { f.params[p.key] = parseFloat(e.target.value); }) },
            p.options.map(([v, label]) => el("option", { value: v, selected: Math.abs(v - value()) < 1e-6 }, label)));
          rows.push(el("div.field.wide", {}, el("label", {}, p.label), sel));
        } else {
          const lane = M.effectLane(fx.id, p.key);
          const label = p.label + "\u200b".repeat(index);   // keeps slider labels unique between effects
          this.defaults = { ...(this.defaults || {}), [label]: p.def };
          rows.push(this.keySlider(label, [clip], lane, { toUi: (v) => Math.round(v * 10) / 10, fromUi: (v) => v, min: p.min, max: p.max, step: p.step, format: (v) => (+v).toFixed(p.step < 1 ? 1 : 0) }));
        }
      }
      const card = el(`div.fxcard${fx.on === false ? ".off" : ""}`, {}, head, ...rows);
      this.refreshers.push(() => card.classList.toggle("off", fxLive().on === false));
      holder.append(card);
    });
    if (effects.length) holder.append(el("div.dim", { style: { fontSize: "11px", marginTop: "4px" } }, "Effects run top to bottom, after the colour grade. Sliders keyframe with ◆ like any other property."));
  }

  // ---------------------------------------------------------------- regeneration & takes
  renderRegen(clip) {
    const live = () => M.getClip(clip.id) || clip;
    const jobsBox = el("div.rgjobs");
    const drawJobs = () => {
      jobsBox.innerHTML = "";
      for (const job of this.app.regen.forClip(clip.id)) {
        const pct = Math.round((job.progress || 0) * 100);
        const text = job.status === "error" ? `Failed: ${job.error || job.message}` : job.status === "queued" ? "Waiting in WanGP's queue…" : `${pct}% · ${job.message || "Generating…"}`;
        jobsBox.append(el(`div.rgjob.${job.status}`, {},
          el("div.rgbar", {}, el("div", { style: { width: `${job.status === "error" ? 100 : pct}%` } })),
          el("div.rgjobline", {}, el("span", {}, `${job.mode === "extend" ? "Extending" : "Regenerating"} · seed ${job.seed}`), el("span.dim", {}, text),
            job.status === "error" ? el("button.small", { onclick: () => this.app.regen.dismiss(job.id) }, "Clear")
              : el("button.small", { onclick: () => this.app.regen.cancel(job.id) }, "Cancel"))));
      }
    };
    drawJobs();
    this.cleanups.push(bus.on("regen-jobs", drawJobs));
    const takes = live().takes || [];
    const rows = takes.map((t, i) => {
      const active = (live().takeIndex || 0) === i;
      return el(`div.take${active ? ".active" : ""}`, { onclick: () => { if (!active) M.edit("Switch take", () => M.setTake(clip.id, i)); } },
        el("span.takeno", {}, String(i + 1)),
        el("span.takelabel", {}, t.label, t.seed != null ? el("span.dim", {}, ` · seed ${t.seed}`) : null,
          i > 0 ? el("span.dim", {}, ` · ${t.audio === "keep" ? "original audio" : "new audio"}`) : null),
        el("span.dim", {}, `${Math.abs(t.out - t.in).toFixed(1)}s`),
        i > 0 ? el("button.small.kbtn", { title: "Remove this take from the clip (the file stays in the Media panel)",
          onclick: (e) => { e.stopPropagation(); M.edit("Remove take", () => M.removeTake(clip.id, i)); } }, "✕") : null);
    });
    this.section("Regenerate",
      el("div.btnrow", {},
        el("button.small", { onclick: () => openRegenDialog(this.app, clip.id, "new") }, "New seed…"),
        el("button.small", { onclick: () => openRegenDialog(this.app, clip.id, "same") }, "Same seed…"),
        el("button.small", { onclick: () => openRegenDialog(this.app, clip.id) }, "Extend…")),
      jobsBox,
      takes.length ? el("div.takes", {}, el("div.dim", { style: { fontSize: "11px", margin: "6px 0 4px" } }, "Takes (click to use one):"), ...rows) : null,
      el("div.dim", { style: { fontSize: "11px", marginTop: "6px" } }, "Regenerations run in WanGP's queue and come back as takes on this clip; the original is always take 1."));
  }

  // ---------------------------------------------------------------- titles
  renderTitle(list) {
    const live = () => M.getClip(list[0].id) || list[0];
    const t0 = () => M.mergeTitle(live().title);
    const update = (fn, label = "Title", key = null) => M.edit(label, () => {
      for (const c of list) { const l = M.getClip(c.id); if (l) { const t = M.mergeTitle(l.title); fn(t); l.title = t; } }
    }, key ? { coalesceKey: `title-${key}-${list[0].id}` } : {});
    const text = el("textarea", { rows: 3, value: t0().text, oninput: (e) => update(t => { t.text = e.target.value; }, "Title text", "text") });
    const fonts = [...new Set([...(this.app.status?.fonts || []), ...FONT_FALLBACK])];
    const font = el("select", { onchange: (e) => update(t => { t.font = e.target.value; }, "Font") }, fonts.map(f => el("option", { value: f, selected: f === t0().font, style: { fontFamily: f } }, f)));
    const num = (value, min, max, step, fn, key) => el("input", { type: "number", value, min, max, step, style: { width: "64px" }, onchange: (e) => { const v = parseFloat(e.target.value); if (isFinite(v)) update(t => fn(t, clamp(v, min, max)), "Title", key); } });
    const color = (value, fn, key) => el("input", { type: "color", value, oninput: (e) => update(t => fn(t, e.target.value), "Title colour", key) });
    const check = (value, label, fn) => el("label", { style: { display: "flex", gap: "4px", alignItems: "center", color: "inherit" } }, el("input", { type: "checkbox", checked: value, onchange: (e) => update(t => fn(t, e.target.checked)) }), label);
    const t = t0();
    const align = el("select", { onchange: (e) => update(t => { t.align = e.target.value; }, "Alignment") }, [["left", "Left"], ["center", "Centre"], ["right", "Right"]].map(([v, l]) => el("option", { value: v, selected: v === t.align }, l)));
    const row = (label, ...items) => el("div.field.wide", {}, el("label", {}, label), el("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } }, ...items));
    this.section("Title",
      text,
      row("Font", font),
      row("Size", num(t.size, 4, 800, 1, (t, v) => { t.size = v; }, "size"), check(t.bold, "Bold", (t, v) => { t.bold = v; }), check(t.italic, "Italic", (t, v) => { t.italic = v; })),
      row("Colour", color(t.color, (t, v) => { t.color = v; }, "color"), align),
      row("Line height", num(t.lineHeight, 0.5, 3, 0.05, (t, v) => { t.lineHeight = v; }, "lh")),
      row("Outline", check(t.outline.on, "On", (t, v) => { t.outline.on = v; }), color(t.outline.color, (t, v) => { t.outline.color = v; }, "oc"), num(t.outline.width, 0, 60, 1, (t, v) => { t.outline.width = v; }, "ow")),
      row("Shadow", check(t.shadow.on, "On", (t, v) => { t.shadow.on = v; }), color(t.shadow.color, (t, v) => { t.shadow.color = v; }, "sc"),
        el("span.dim", {}, "blur"), num(t.shadow.blur, 0, 100, 1, (t, v) => { t.shadow.blur = v; }, "sb"),
        el("span.dim", {}, "x"), num(t.shadow.x, -100, 100, 1, (t, v) => { t.shadow.x = v; }, "sx"),
        el("span.dim", {}, "y"), num(t.shadow.y, -100, 100, 1, (t, v) => { t.shadow.y = v; }, "sy"),
        el("span.dim", {}, "opacity"), num(t.shadow.opacity, 0, 1, 0.05, (t, v) => { t.shadow.opacity = v; }, "so")),
      row("Background", check(t.box.on, "Box", (t, v) => { t.box.on = v; }), color(t.box.color, (t, v) => { t.box.color = v; }, "bc"),
        el("span.dim", {}, "opacity"), num(t.box.opacity, 0, 1, 0.05, (t, v) => { t.box.opacity = v; }, "bo"),
        el("span.dim", {}, "padding"), num(t.box.padding, 0, 400, 1, (t, v) => { t.box.padding = v; }, "bp")),
      el("div.dim", { style: { fontSize: "11px", marginTop: "4px" } }, "Position, scale, rotation, opacity and fades are in the Video section and can be keyframed to animate the title."));
  }

  // ---------------------------------------------------------------- speed
  renderSpeed(timed) {
    const live = (c) => M.getClip(c.id) || c;
    const first = () => live(timed[0]);
    const interp = el("select", {}, [["default", "Export default"], ["nearest", "Nearest frame"], ["blend", "Frame blend"], ["rife", "Optical flow (RIFE)"]].map(([v, l]) => el("option", { value: v }, l)));
    interp.addEventListener("change", () => M.edit("Interpolation", () => { for (const c of timed) { const l = live(c); if (l) l.interp = interp.value; } }));
    const graph = el("canvas.speedgraph", { title: "Speed over the clip. Click to move the playhead." });
    graph.addEventListener("click", (e) => {
      const c = first(), r = graph.getBoundingClientRect();
      this.app.playback.pause();
      this.app.playback.seek(c.start + (e.clientX - r.left) / r.width * M.clipDur(c));
    });
    const drawGraph = () => {
      const c = first();
      const w = Math.max(60, Math.round(graph.clientWidth * devicePixelRatio)), h = Math.round(56 * devicePixelRatio);
      if (graph.width !== w || graph.height !== h) { graph.width = w; graph.height = h; }
      const ctx = graph.getContext("2d");
      ctx.fillStyle = "#0e0f12"; ctx.fillRect(0, 0, w, h);
      const d = M.clipDur(c) || 1;
      const ks = M.keysOf(c, "speed");
      const maxV = Math.max(1.2, ...ks.map(k => k.v), M.speeds(c)[0]) * 1.1;
      const yOf = (v) => h - 4 - (h - 8) * v / maxV;
      ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.beginPath(); ctx.moveTo(0, yOf(1)); ctx.lineTo(w, yOf(1)); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.font = `${9 * devicePixelRatio}px Segoe UI, sans-serif`; ctx.fillText("100%", 3, yOf(1) - 2);
      ctx.strokeStyle = "#ffe14d"; ctx.lineWidth = 1.5 * devicePixelRatio; ctx.beginPath();
      for (let i = 0; i <= w; i += 2) { const v = M.speedAt(c, i / w * d); i ? ctx.lineTo(i, yOf(v)) : ctx.moveTo(i, yOf(v)); }
      ctx.stroke();
      ctx.fillStyle = "#ffe14d";
      for (const k of ks) { const x = k.t / d * w, y = yOf(k.v); ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y); ctx.fill(); }
      const px = (state.playhead - c.start) / d * w;
      if (px >= 0 && px <= w) { ctx.fillStyle = "#ff4d4d"; ctx.fillRect(px, 0, devicePixelRatio, h); }
    };
    const ramp = (from, to, curveName) => {
      M.edit("Speed ramp", () => {
        for (const item of timed) {
          const c = live(item);
          const d = M.clipDur(c);
          const tau = state.playhead - c.start;
          const startAt = tau > M.frameDur() && tau < d - M.frameDur() ? M.snapFrame(tau) : 0;
          const keys = startAt > 0
            ? [{ t: 0, v: from, ease: "linear" }, { t: startAt, v: from, ease: curveName }, { t: d, v: to, ease: "linear" }]
            : [{ t: 0, v: from, ease: curveName }, { t: d, v: to, ease: "linear" }];
          M.setSpeedKeys(c.id, keys);
        }
      });
    };
    const update = () => { if (document.activeElement !== interp) interp.value = first().interp || "default"; requestAnimationFrame(drawGraph); };
    update();
    this.refreshers.push(update);
    const keyed = M.hasSpeedKeys(first());
    this.section("Speed",
      this.keySlider("Speed %", timed, "speed", { toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => v / 100, min: 0, max: 1000, step: 1 }),
      graph,
      el("div.btnrow", {}, [25, 50, 100, 200, 400].map(p => el("button.small", { title: `Constant ${p}% (removes speed keyframes)`, onclick: () => M.edit("Change speed", () => M.setSpeed(timed.map(c => c.id), p / 100)) }, `${p}%`))),
      el("div.btnrow", {},
        el("button.small", { title: "Smoothly slow to a complete stop and hold the frame. Starts at the playhead if it is over the clip, otherwise at the clip start.", onclick: () => ramp(M.speedAt(first(), Math.max(0, state.playhead - first().start)) || 1, 0, "s_curve") }, "Ramp to stop"),
        el("button.small", { title: "Ease into 25% slow motion", onclick: () => ramp(M.speedAt(first(), Math.max(0, state.playhead - first().start)) || 1, 0.25, "s_curve") }, "Ease to slow-mo"),
        el("button.small", { title: "Ease from 25% up to normal speed", onclick: () => ramp(0.25, 1, "s_curve") }, "Speed up"),
        keyed ? el("button.small", { title: "Remove the speed keyframes and keep the speed at the start", onclick: () => M.edit("Clear speed keyframes", () => { for (const c of timed) M.setSpeedKeys(live(c).id, []); }) }, "Clear ramp") : null),
      el("div.field.wide", {}, el("label", {}, "In-betweens"), interp),
      this.reverseRow(timed),
      el("div.btnrow", {}, el("button.small", { title: "Insert a held frame of the clip under the playhead (Shift+F)", onclick: () => this.app.freezeFrame() }, "Freeze frame at playhead")),
      el("div.dim", { style: { fontSize: "11px", marginTop: "4px" } },
        "Speed can go down to 0% (the frame holds). Ramps keep the clip's length and change how much of the source it uses. Ramp presets start at the playhead when it is over the clip. Right-click a clip > Show keyframes > Speed to edit the curve on the timeline. Optical flow is applied on export."));
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
