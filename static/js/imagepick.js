// A start / end image picker for the generate dialogs: none, the picture at the playhead, an image (or a video's first
// or last frame) from the media bin, or a file chosen or dropped here. Its value is a frame reference {mediaId, t} the
// server turns into a picture for WanGP's image_start / image_end.
import * as M from "./model.js";
import { state, P } from "./model.js";
import { el, timecode, toast } from "./util.js";

// The picture at the playhead: the top visible video clip there, at its source time.
export function playheadFrame(t = state.playhead) {
  const clip = M.videoTracks().slice().reverse().flatMap(tr => M.clipsOn(tr.id))
    .find(c => c.start <= t + 1e-6 && M.clipEnd(c) > t + 1e-6 && !c.disabled && !M.getTrack(c.trackId).hidden && M.mediaOf(c));
  if (!clip) return null;
  const tau = Math.min(Math.max(0, t - clip.start), Math.max(0, M.clipDur(clip) - M.frameDur() / 2));
  return { mediaId: clip.mediaId, t: M.isStill(clip) ? 0 : M.srcTime(clip, tau), label: `${clip.name || "clip"} at ${timecode(t, P().fps || 24)}` };
}

export class ImagePick {
  // which: "start" | "end"; onChange(ref) when the choice changes
  constructor(app, which, { onChange = () => {}, initial = "none" } = {}) {
    this.app = app;
    this.which = which;
    this.onChange = onChange;
    this.picked = null;                  // a file chosen or dropped here: {mediaId, t, label}
    this.sel = el("select", { title: `The ${which === "start" ? "first" : "last"} frame of the generation` });
    this.img = el("img.rgframe.imgpick-thumb", { hidden: true });
    this.file = el("input", { type: "file", accept: "image/*", style: { display: "none" }, onchange: () => { const f = this.file.files[0]; this.file.value = ""; if (f) this.upload(f); } });
    this.node = el("div.imgpick", { title: "Drop an image file here, or choose one" },
      el("div.imgpick-row", {}, this.sel, this.file), this.img);
    this.sel.addEventListener("change", () => {
      if (this.sel.value === "file") { this.sel.value = this.last || "none"; this.file.click(); return; }
      this.last = this.sel.value;
      this.changed();
    });
    // drop an image from Explorer onto the picker
    for (const ev of ["dragenter", "dragover"]) this.node.addEventListener(ev, (e) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
      e.preventDefault(); e.stopPropagation(); this.node.classList.add("over");
    });
    this.node.addEventListener("dragleave", () => this.node.classList.remove("over"));
    this.node.addEventListener("drop", (e) => {
      const f = [...(e.dataTransfer?.files || [])].find(x => /^image\//.test(x.type) || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(x.name));
      this.node.classList.remove("over");
      if (!f) return;
      e.preventDefault(); e.stopPropagation();
      this.upload(f);
    });
    this.fill(initial);
  }

  // the choices: rebuilt each time (the playhead and the bin change)
  fill(want = this.sel.value) {
    const opt = (v, l) => el("option", { value: v }, l);
    this.sel.innerHTML = "";
    this.sel.append(opt("none", "None"));
    const ph = playheadFrame();
    this.sel.append(opt("playhead", ph ? `Picture at the playhead (${ph.label})` : "Picture at the playhead (nothing there)"));
    if (!ph) this.sel.lastChild.disabled = true;
    const items = Object.values(P().media || {}).filter(i => i.kind === "image" || i.kind === "video");
    const images = items.filter(i => i.kind === "image"), videos = items.filter(i => i.kind === "video");
    if (images.length) this.sel.append(el("optgroup", { label: "Images in the media bin" }, ...images.map(i => opt(`img:${i.id}`, i.name))));
    if (videos.length) this.sel.append(el("optgroup", { label: "A video's first or last frame" },
      ...videos.flatMap(i => [opt(`first:${i.id}`, `${i.name}: first frame`), opt(`last:${i.id}`, `${i.name}: last frame`)])));
    if (this.picked && !images.find(i => i.id === this.picked.mediaId)) this.sel.append(opt(`img:${this.picked.mediaId}`, this.picked.label));
    if (this.fixed && P().media[this.fixed.mediaId]) this.sel.append(opt("fixed", this.fixed.label || "The chosen frame"));
    this.sel.append(opt("file", "Choose an image file…"));
    this.sel.value = [...this.sel.options].some(o => o.value === want && !o.disabled) ? want : "none";
    this.last = this.sel.value;
    this.preview();
  }

  get value() {
    const v = this.sel.value;
    if (v === "playhead") { const ph = playheadFrame(); return ph && { mediaId: ph.mediaId, t: ph.t }; }
    if (v === "fixed") return this.fixed && P().media[this.fixed.mediaId] ? { mediaId: this.fixed.mediaId, t: this.fixed.t } : null;
    const [kind, id] = v.split(":");
    const item = id && P().media[id];
    if (!item) return null;
    if (kind === "img") return { mediaId: id, t: 0 };
    if (kind === "first") return { mediaId: id, t: 0 };
    if (kind === "last") return { mediaId: id, t: Math.max(0, (item.duration || 0) - 1 / (item.fps || 24)) };
    return null;
  }
  // a choice to remember between dialogs (bin items by id; the playhead as "playhead")
  get choice() { return this.sel.value; }

  // A frame chosen earlier ({mediaId, t, label}), as the choice: the matching bin choice when there is one.
  setRef(ref) {
    if (!ref?.mediaId || !P().media[ref.mediaId]) { this.fill("none"); return false; }
    const item = P().media[ref.mediaId];
    const lastT = Math.max(0, (item.duration || 0) - 1 / (item.fps || 24));
    let want = item.kind === "image" ? `img:${ref.mediaId}` : !ref.t ? `first:${ref.mediaId}` : Math.abs(ref.t - lastT) < 1e-3 ? `last:${ref.mediaId}` : "fixed";
    if (want === "fixed") this.fixed = { mediaId: ref.mediaId, t: ref.t, label: ref.label || `${item.name} at ${timecode(ref.t, item.fps || 24)}` };
    this.fill(want);
    return true;
  }
  // The choice as a frame to keep (the playhead becomes the frame it shows now), with a label.
  get ref() {
    const v = this.value;
    if (!v) return null;
    const label = this.sel.value === "playhead" ? playheadFrame()?.label : this.sel.selectedOptions[0]?.textContent;
    return { mediaId: v.mediaId, t: v.t, label: label || "" };
  }

  set disabled(off) { this.sel.disabled = off; this.node.classList.toggle("off", off); this.preview(); }
  get disabled() { return this.sel.disabled; }

  preview() {
    const ref = this.sel.disabled ? null : this.value;
    this.img.hidden = !ref;
    if (ref) this.img.src = `api/media/${ref.mediaId}/frame?t=${ref.t.toFixed(3)}`;
  }
  changed() { this.preview(); this.onChange(this.sel.disabled ? null : this.value); }

  async upload(file) {
    const media = await this.app.bin.importFiles([file]);
    const item = (media || []).find(m => m.kind === "image");
    if (!item) { toast("That file isn't an image the editor can read", "warn"); return; }
    this.picked = { mediaId: item.id, t: 0, label: item.name };
    this.fill(`img:${item.id}`);
    this.changed();
  }
}

// Reference images for a run (WanGP's image_refs): the ones in the settings it uses (the Media Generator's, or the
// ones embedded in the clip it continues), which you can remove, add to (an image in the media bin, a video's frame
// at the playhead, or an image file) or put back. Its value is null while unchanged (the settings' own references are
// used), otherwise the list: [{mediaId, t} | {path}].
export class RefsField {
  constructor(app, { onChange = () => {} } = {}) {
    this.app = app;
    this.onChange = onChange;
    this.items = [];
    this.source = [];
    this.edited = false;
    this.list = el("div.refs-list");
    this.add = el("select.refs-add", { title: "Add a reference image" });
    this.file = el("input", { type: "file", accept: "image/*", multiple: true, style: { display: "none" }, onchange: () => { const fs = [...this.file.files]; this.file.value = ""; this.upload(fs); } });
    this.reset = el("button.small", { hidden: true, title: "Use the references in the settings again", onclick: () => { this.edited = false; this.items = this.source.slice(); this.render(); this.onChange(); } }, "Put back the settings' references");
    this.note = el("div.dim.small");
    this.node = el("div.refs", { title: "Drop image files here to add them" }, this.list, el("div.refs-row", {}, this.add, this.reset, this.file), this.note);
    this.add.addEventListener("change", () => {
      const v = this.add.value; this.add.value = "";
      if (!v) return;
      if (v === "file") { this.file.click(); return; }
      if (v === "playhead") { const ph = playheadFrame(); if (ph) this.push({ mediaId: ph.mediaId, t: ph.t, name: ph.label }); return; }
      const item = P().media[v.slice(4)];
      if (item) this.push({ mediaId: item.id, t: 0, name: item.name });
    });
    for (const ev of ["dragenter", "dragover"]) this.node.addEventListener(ev, (e) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
      e.preventDefault(); e.stopPropagation(); this.node.classList.add("over");
    });
    this.node.addEventListener("dragleave", () => this.node.classList.remove("over"));
    this.node.addEventListener("drop", (e) => {
      const fs = [...(e.dataTransfer?.files || [])].filter(x => /^image\//.test(x.type) || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(x.name));
      this.node.classList.remove("over");
      if (!fs.length) return;
      e.preventDefault(); e.stopPropagation();
      this.upload(fs);
    });
    this.render();
  }

  // the references of the settings the run uses ([{name, path, exists}]); kept unless you've changed the list
  setSource(refs, from) {
    this.source = (refs || []).map(r => ({ path: r.path, name: r.name, missing: !r.exists }));
    this.from = from;
    if (!this.edited) this.items = this.source.slice();
    this.render();
  }

  push(ref) { this.items.push(ref); this.edited = true; this.render(); this.onChange(); }

  async upload(files) {
    const media = await this.app.bin.importFiles(files);
    for (const item of (media || []).filter(m => m.kind === "image")) this.items.push({ mediaId: item.id, t: 0, name: item.name });
    this.edited = true; this.render(); this.onChange();
  }

  get value() {
    if (!this.edited) return null;
    return this.items.map(i => i.mediaId ? { mediaId: i.mediaId, t: i.t || 0 } : { path: i.path });
  }
  get count() { return this.items.length; }
  get missing() { return this.items.filter(i => i.missing).map(i => i.name); }

  render() {
    this.list.innerHTML = "";
    this.items.forEach((r, n) => {
      const src = r.mediaId ? `api/media/${r.mediaId}/frame?t=${(r.t || 0).toFixed(3)}` : r.path && !r.missing ? `api/gen/refimage?path=${encodeURIComponent(r.path)}` : "";
      this.list.append(el("div.refs-item" + (r.missing ? ".missing" : ""), { title: r.missing ? `${r.name}: the file is gone (WanGP's temporary copy was cleared). Remove it and add the picture again.` : r.name },
        src ? el("img", { src }) : el("div.refs-gone", {}, "missing"),
        el("span.refs-name", {}, `${n + 1}. ${r.name}`),
        el("button.refs-x", { title: "Remove", onclick: () => { this.items.splice(n, 1); this.edited = true; this.render(); this.onChange(); } }, "✕")));
    });
    if (!this.items.length) this.list.append(el("span.dim.small", {}, "None"));
    // the add menu
    const opt = (v, l) => el("option", { value: v }, l);
    this.add.innerHTML = "";
    this.add.append(opt("", "Add a reference…"));
    const ph = playheadFrame();
    this.add.append(opt("playhead", ph ? `Picture at the playhead (${ph.label})` : "Picture at the playhead (nothing there)"));
    if (!ph) this.add.lastChild.disabled = true;
    const images = Object.values(P().media || {}).filter(i => i.kind === "image");
    if (images.length) this.add.append(el("optgroup", { label: "Images in the media bin" }, ...images.map(i => opt(`img:${i.id}`, i.name))));
    this.add.append(opt("file", "Choose image files…"));
    this.add.value = "";
    this.reset.hidden = !this.edited;
    this.note.textContent = this.edited ? "Your list is used for this run." : this.items.length ? `From ${this.from || "the settings"}, in the order WanGP numbers them.` : `${this.from ? `None in ${this.from}. ` : ""}Add pictures here for models that take reference images (H3 Ref2VA).`;
  }
}

// Audio for a run (WanGP's audio_guide / 2 / 3): up to three voice / audio references, or one soundtrack the video
// follows and keeps. Starts from what the settings bring (loaded in the Media Generator); you can remove, add (audio
// or a video's sound from the media bin, or audio files) and switch between references and a soundtrack. Its value is
// null while unchanged, otherwise {mode, items: [{mediaId} | {path}]}.
export class AudioRefsField {
  constructor(app, { onChange = () => {} } = {}) {
    this.app = app;
    this.onChange = onChange;
    this.items = [];
    this.source = [];
    this.mode = "reference";
    this.sourceMode = "reference";
    this.edited = false;
    this.max = 3;
    this.soundtrackOk = true;
    this.list = el("div.arefs-list");
    this.modeSel = el("select", { title: "How the run uses the audio" },
      el("option", { value: "reference" }, "References (the voice / sound is reused in new audio)"),
      el("option", { value: "soundtrack" }, "Soundtrack (kept as the run's sound; the video follows it)"));
    this.modeSel.addEventListener("change", () => { this.mode = this.modeSel.value; this.edited = true; this.render(); this.onChange(); });
    this.add = el("select", { title: "Add audio" });
    this.file = el("input", { type: "file", accept: "audio/*,video/*", multiple: true, style: { display: "none" }, onchange: () => { const fs = [...this.file.files]; this.file.value = ""; this.upload(fs); } });
    this.reset = el("button.small", { hidden: true, onclick: () => { this.edited = false; this.items = this.source.slice(); this.mode = this.sourceMode; this.render(); this.onChange(); } }, "Put back the settings' audio");
    this.note = el("div.dim.small");
    this.node = el("div.arefs", { title: "Drop audio files here to add them" }, this.list, el("div.refs-row", {}, this.modeSel, this.add, this.reset, this.file), this.note);
    this.add.addEventListener("change", () => {
      const v = this.add.value; this.add.value = "";
      if (!v) return;
      if (v === "file") { this.file.click(); return; }
      const item = P().media[v.slice(4)];
      if (item) this.push({ mediaId: item.id, name: item.name + (item.kind === "video" ? " (its sound)" : "") });
    });
    for (const ev of ["dragenter", "dragover"]) this.node.addEventListener(ev, (e) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
      e.preventDefault(); e.stopPropagation(); this.node.classList.add("over");
    });
    this.node.addEventListener("dragleave", () => this.node.classList.remove("over"));
    this.node.addEventListener("drop", (e) => {
      const fs = [...(e.dataTransfer?.files || [])].filter(x => /^(audio|video)\//.test(x.type) || /\.(wav|mp3|flac|ogg|m4a|aac|opus)$/i.test(x.name));
      this.node.classList.remove("over");
      if (!fs.length) return;
      e.preventDefault(); e.stopPropagation();
      this.upload(fs);
    });
    this.render();
  }

  // the model's limits: how many references, whether it takes a soundtrack
  setCaps({ max = 3, soundtrack = true } = {}) { this.max = max; this.soundtrackOk = soundtrack; this.render(); }

  setSource(inputs) {
    this.source = (inputs || []).filter(a => a.path).map(a => ({ path: a.path, name: a.name, missing: !a.exists }));
    this.sourceMode = (inputs || []).some(a => a.role === "soundtrack") ? "soundtrack" : "reference";
    if (!this.edited) { this.items = this.source.slice(); this.mode = this.sourceMode; }
    this.render();
  }

  push(ref) { this.items.push(ref); this.edited = true; this.render(); this.onChange(); }

  async upload(files) {
    const media = await this.app.bin.importFiles(files);
    for (const item of (media || []).filter(m => m.kind === "audio" || m.kind === "video")) this.items.push({ mediaId: item.id, name: item.name });
    this.edited = true; this.render(); this.onChange();
  }

  limit() { return this.mode === "soundtrack" ? 1 : this.max; }
  get value() {
    if (!this.edited) return null;
    return { mode: this.mode, items: this.items.slice(0, this.limit()).map(i => i.mediaId ? { mediaId: i.mediaId } : { path: i.path }) };
  }
  get count() { return this.items.length; }

  render() {
    this.list.innerHTML = "";
    let playing = null;
    this.items.forEach((r, n) => {
      const over = n >= this.limit();
      const src = r.mediaId ? `api/media/${r.mediaId}/proxy` : r.path && !r.missing ? `api/gen/refimage?audio=1&path=${encodeURIComponent(r.path)}` : "";
      const play = el("button.small", { title: "Listen", disabled: !src, onclick: () => {
        if (playing && !playing.paused) { playing.pause(); playing = null; return; }
        playing = new Audio(src); playing.play().catch(() => {});
      } }, "▶");
      const label = this.mode === "soundtrack" ? "Soundtrack" : `<Audio ${n + 1}>`;
      this.list.append(el("div.arefs-item" + (r.missing ? ".missing" : "") + (over ? ".over" : ""), { title: r.missing ? `${r.name}: the file is gone (WanGP's temporary copy was cleared). Remove it and add it again.` : over ? "Not used: the model takes fewer" : r.name },
        play, el("span.dim", {}, label), el("span.arefs-name", {}, r.name), r.missing ? el("span.warn", {}, " missing") : null,
        el("button.refs-x", { title: "Remove", onclick: () => { this.items.splice(n, 1); this.edited = true; this.render(); this.onChange(); } }, "✕")));
    });
    if (!this.items.length) this.list.append(el("span.dim.small", {}, "None"));
    this.modeSel.value = this.mode;
    this.modeSel.querySelector('option[value="soundtrack"]').disabled = !this.soundtrackOk;
    const opt = (v, l) => el("option", { value: v }, l);
    this.add.innerHTML = "";
    this.add.append(opt("", "Add audio…"));
    const media = Object.values(P().media || {});
    const audio = media.filter(i => i.kind === "audio"), video = media.filter(i => i.kind === "video" && i.has_audio);
    if (audio.length) this.add.append(el("optgroup", { label: "Audio in the media bin" }, ...audio.map(i => opt(`med:${i.id}`, i.name))));
    if (video.length) this.add.append(el("optgroup", { label: "A video's sound" }, ...video.map(i => opt(`med:${i.id}`, i.name))));
    this.add.append(opt("file", "Choose audio files…"));
    this.add.value = "";
    this.add.disabled = this.items.length >= this.limit();
    this.reset.hidden = !this.edited;
    this.note.textContent = this.mode === "soundtrack"
      ? "The run keeps this as its sound and the picture follows it (for speech, ask for lip movements synchronized in the prompt)."
      : `Voices or sounds the run reuses in its new audio (up to ${this.max}); name each one's role in the prompt with <Audio 1>…`;
  }
}
