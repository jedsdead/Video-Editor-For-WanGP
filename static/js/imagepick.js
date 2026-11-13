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
    this.sel.append(opt("file", "Choose an image file…"));
    this.sel.value = [...this.sel.options].some(o => o.value === want && !o.disabled) ? want : "none";
    this.last = this.sel.value;
    this.preview();
  }

  get value() {
    const v = this.sel.value;
    if (v === "playhead") { const ph = playheadFrame(); return ph && { mediaId: ph.mediaId, t: ph.t }; }
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
