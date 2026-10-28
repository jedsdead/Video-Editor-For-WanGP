// Effects panel: generators (title, solid colour, gradient, adjustment layer) and video effects.
// Drag a generator onto a video track; drag an effect onto a clip, or click it to add it to the selected clips.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { el, toast } from "./util.js";
import { EFFECTS, EFFECT_ORDER, GENERATORS, defaultEffectParams } from "./effects.js";

const BLURB = {
  blur: "Gaussian blur", sharpen: "Crisper detail", vignette: "Darken the edges", grain: "Animated film grain",
  bw: "Black and white", chroma: "Key out green or blue", flip: "Mirror the picture", pixelate: "Mosaic blocks",
  aberration: "Colour fringing", letterbox: "Cinema bars",
  __title__: "Text with font, outline and shadow", __solid__: "A full-frame colour", __gradient__: "Two-colour linear gradient",
  __adjust__: "Grade and effects for everything below",
};

// A small scene for the effect previews: sky, sun and hills.
function scene(ctx, w, h, green = false) {
  if (green) { ctx.fillStyle = "#16c235"; ctx.fillRect(0, 0, w, h); }
  else {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#3d6fb6"); sky.addColorStop(1, "#f0a35e");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#ffe08a"; ctx.beginPath(); ctx.arc(w * 0.7, h * 0.42, h * 0.16, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = "#2f5a3a"; ctx.beginPath(); ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 4) ctx.lineTo(x, h * 0.72 - Math.sin(x / w * 7) * h * 0.08);
  ctx.lineTo(w, h); ctx.fill();
  ctx.fillStyle = "#e9e4d8"; ctx.fillRect(w * 0.18, h * 0.38, w * 0.12, h * 0.34);
  ctx.fillStyle = "#8a3b2b"; ctx.beginPath(); ctx.moveTo(w * 0.15, h * 0.4); ctx.lineTo(w * 0.24, h * 0.24); ctx.lineTo(w * 0.33, h * 0.4); ctx.fill();
}

function paintEffect(canvas, type) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  if (type === "blur") { ctx.filter = "blur(2.5px)"; scene(ctx, w, h); }
  else if (type === "bw") { ctx.filter = "grayscale(1)"; scene(ctx, w, h); }
  else if (type === "sharpen") { ctx.filter = "contrast(1.35) saturate(1.15)"; scene(ctx, w, h); }
  else if (type === "flip") { ctx.translate(w, 0); ctx.scale(-1, 1); scene(ctx, w, h); }
  else if (type === "pixelate") {
    const small = document.createElement("canvas"); small.width = Math.ceil(w / 8); small.height = Math.ceil(h / 8);
    scene(small.getContext("2d"), small.width, small.height);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(small, 0, 0, w, h);
  } else if (type === "chroma") {
    for (let y = 0; y < h; y += 6) for (let x = 0; x < w; x += 6) { ctx.fillStyle = (x + y) / 6 % 2 ? "#3a3d45" : "#2a2c32"; ctx.fillRect(x, y, 6, 6); }
    const fg = document.createElement("canvas"); fg.width = w; fg.height = h;
    const f = fg.getContext("2d"); scene(f, w, h, true);
    const img = f.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 1] > 150 && img.data[i] < 80) img.data[i + 3] = 0;
    f.putImageData(img, 0, 0); ctx.drawImage(fg, 0, 0);
  } else if (type === "aberration") {
    scene(ctx, w, h);
    const img = ctx.getImageData(0, 0, w, h), out = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, dx = Math.round((x - w / 2) * 0.05);
      const r = (y * w + Math.min(w - 1, Math.max(0, x + dx))) * 4, b = (y * w + Math.min(w - 1, Math.max(0, x - dx))) * 4;
      out.data[i] = img.data[r]; out.data[i + 1] = img.data[i + 1]; out.data[i + 2] = img.data[b + 2]; out.data[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
  } else {
    scene(ctx, w, h);
    if (type === "vignette") {
      const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, w * 0.6);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.85)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    } else if (type === "grain") {
      const img = ctx.getImageData(0, 0, w, h);
      for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * 70; for (let c = 0; c < 3; c++) img.data[i + c] += n; }
      ctx.putImageData(img, 0, 0);
    } else if (type === "letterbox") {
      ctx.fillStyle = "#000"; const bar = h * 0.17; ctx.fillRect(0, 0, w, bar); ctx.fillRect(0, h - bar, w, bar);
    }
  }
  ctx.restore();
}

function paintGenerator(canvas, kind) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  if (kind === "title") {
    scene(ctx, w, h); ctx.fillStyle = "rgba(0,0,0,.25)"; ctx.fillRect(0, 0, w, h);
    ctx.font = "bold 22px Segoe UI, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillText("Title", w / 2 + 1.5, h / 2 + 1.5);
    ctx.fillStyle = "#fff"; ctx.fillText("Title", w / 2, h / 2);
  } else if (kind === "solid") { ctx.fillStyle = "#1b2a49"; ctx.fillRect(0, 0, w, h); }
  else if (kind === "gradient") { const g = ctx.createLinearGradient(0, h, 0, 0); g.addColorStop(0, "#1b2a49"); g.addColorStop(1, "#c86b3c"); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }
  else if (kind === "adjust") {
    scene(ctx, w, h);
    ctx.save(); ctx.beginPath(); ctx.rect(w / 2, 0, w / 2, h); ctx.clip();
    ctx.filter = "grayscale(.6) contrast(1.3) sepia(.4)"; scene(ctx, w, h); ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
  }
}

export class EffectsPanel {
  constructor(app) {
    this.app = app;
    this.filter = "";
    this.grid = el("div.panel-scroll");
    this.node = el("div", {},
      el("div.panel-toolbar", {},
        el("input", { type: "search", placeholder: "Filter", style: { flex: "1", minWidth: "60px" }, oninput: (e) => { this.filter = e.target.value.toLowerCase(); this.render(); } })),
      this.grid);
    bus.on("drop-effect", ({ type, hit }) => this.dropOnClip(type, hit));
    this.render();
  }

  match(label, key) { return !this.filter || label.toLowerCase().includes(this.filter) || (BLURB[key] || "").toLowerCase().includes(this.filter); }

  render() {
    this.grid.innerHTML = "";
    const gens = GENERATORS.filter(g => this.match(g.label, g.id));
    const fx = EFFECT_ORDER.filter(id => this.match(EFFECTS[id].label, id));
    if (gens.length) this.grid.append(el("div.tsection", {}, "Generators"), el("div.tgrid", {}, gens.map(g => this.generatorTile(g))));
    if (fx.length) this.grid.append(el("div.tsection", {}, "Video effects"), el("div.tgrid", {}, fx.map(id => this.effectTile(id))));
    if (!gens.length && !fx.length) this.grid.append(el("div.empty-note", {}, "Nothing matches."));
    this.grid.append(el("div.dim", { style: { fontSize: "11px", marginTop: "8px", lineHeight: "1.45" } },
      "Generators: drag onto a video track, or double-click to add at the playhead on the top track. Effects: drag onto a clip, or click to add to the selected clips. Edit, reorder and keyframe effects in the Inspector."));
  }

  generatorTile(g) {
    const canvas = el("canvas", { width: 96, height: 54 });
    paintGenerator(canvas, g.kind);
    return el("div.ttile.fxtile", {
      draggable: true, title: `${g.label}: ${BLURB[g.id]}`,
      ondragstart: (e) => { e.dataTransfer.setData("text/x-ve-media", g.id); e.dataTransfer.effectAllowed = "copy"; window.__veDragMedia = g.id; },
      ondragend: () => { window.__veDragMedia = null; },
      ondblclick: () => this.addGenerator(g.id),
    }, canvas, el("span", {}, g.label));
  }

  effectTile(id) {
    const canvas = el("canvas", { width: 96, height: 54 });
    paintEffect(canvas, id);
    return el("div.ttile.fxtile", {
      draggable: true, title: `${EFFECTS[id].label}: ${BLURB[id]}. Drag onto a clip, or click to add it to the selected clips.`,
      ondragstart: (e) => { e.dataTransfer.setData("text/x-ve-effect", id); e.dataTransfer.effectAllowed = "copy"; },
      onclick: () => this.applyToSelection(id),
    }, canvas, el("span", {}, EFFECTS[id].label));
  }

  // Generators go on the top video track at the playhead (the title also has Shift+T). If something is already there,
  // a new video track is added above so nothing gets overwritten.
  addGenerator(mediaId, at = null) {
    const item = P().media[mediaId];
    if (!item) return;
    const t = M.snapFrame(at ?? state.playhead);
    const clips = M.edit(`Add ${item.name.toLowerCase()}`, () => {
      const tracks = M.videoTracks();
      let track = tracks[tracks.length - 1];
      const busy = M.clipsOn(track.id).some(c => c.start < t + M.DEFAULT_STILL - 1e-6 && M.clipEnd(c) > t + 1e-6);
      if (busy) track = M.addTrack("video");
      return M.placeMedia(item, track.id, t);
    });
    if (clips) { M.select(clips.map(c => c.id)); this.app.docks.show("inspector"); }
  }

  apply(type, ids) {
    const added = M.edit(`Add ${EFFECTS[type].label}`, () => M.addEffect(ids, type, defaultEffectParams(type)));
    if (added && added.length) {
      this.app.docks.show("inspector");
      toast(`${EFFECTS[type].label} added to ${added.length} clip${added.length > 1 ? "s" : ""}`);
    }
    return added;
  }

  applyToSelection(type) {
    const ids = M.selectedClips().filter(c => M.trackKind(c.trackId) === "video").map(c => c.id);
    if (!ids.length) { toast("Select a video clip first, or drag the effect onto one", "warn"); return; }
    this.apply(type, ids);
  }

  dropOnClip(type, hit) {
    if (!hit || !hit.clip || hit.row?.kind !== "video") { toast("Drop the effect onto a clip on a video track", "warn"); return; }
    const ids = state.selection.has(hit.clip.id)
      ? M.selectedClips().filter(c => M.trackKind(c.trackId) === "video").map(c => c.id)
      : [hit.clip.id];
    if (!state.selection.has(hit.clip.id)) M.select([hit.clip.id]);
    this.apply(type, ids);
  }
}
