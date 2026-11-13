// Captions: each caption is a title clip on a "Captions" video track (the top one), so it shows in the viewer, burns
// into the export and edits like any clip (move, trim, Inspector styling). The Captions panel lists them for typing,
// adds one at the playhead, drafts them from the dialogue in WanGP prompts (<d>…</d> lines and their "At mm:ss"
// times), imports and exports SRT, sets one style for all, and turns the track off to leave them out of the export.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { el, toast, timecode, modal, debounce } from "./util.js";

const MAX_LINE = 42;      // characters per caption line

export function captionsTrack(create = false) {
  let tr = P().tracks.find(t => t.kind === "video" && t.captions);
  if (!tr && create) {
    tr = M.addTrack("video", false);
    tr.captions = true;
    tr.name = "Captions";
    bus.emit("tracks");
  }
  return tr || null;
}

export function defaultCaptionStyle() {
  const h = P().settings.height || 720;
  return { font: "Segoe UI", size: Math.max(14, Math.round(h * 0.048)), bold: true, color: "#ffffff", position: 0.86,
           box: true, boxOpacity: 0.55, outline: false };
}
export const captionStyle = () => ({ ...defaultCaptionStyle(), ...(P().captionStyle || {}) });

// The title (and placement) a caption gets from the style.
function styled(clip, text, style = captionStyle()) {
  const t = M.defaultTitle();
  clip.title = { ...t, text, font: style.font, size: style.size, bold: style.bold, color: style.color, align: "center", lineHeight: 1.18,
    shadow: { ...t.shadow, on: !style.box, blur: 6, x: 2, y: 2 }, outline: { on: !!style.outline, color: "#000000", width: Math.max(1, Math.round(style.size / 14)) },
    box: { on: !!style.box, color: "#000000", opacity: style.boxOpacity, padding: Math.round(style.size * 0.3) } };
  // up or down from the centre to the chosen height (position: 0 top … 1 bottom, for the middle of the text)
  clip.y = Math.round((style.position - 0.5) * (P().settings.height || 720));
  clip.x = 0; clip.scale = 1;
  clip.name = text.split("\n")[0].slice(0, 40) || "Caption";
}

export function wrap(text, max = MAX_LINE) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > max) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  // two lines read best; balance a long caption over two rather than three short ones where it fits
  return lines.join("\n");
}

export function captions() {
  const tr = captionsTrack();
  return tr ? M.clipsOn(tr.id).filter(c => M.mediaOf(c)?.kind === "title").sort((a, b) => a.start - b.start) : [];
}

// Add a caption (start / end in timeline seconds). Overlapping captions are trimmed so they don't stack.
export function addCaption(start, end, text) {
  const tr = captionsTrack(true);
  start = M.snapFrame(Math.max(0, start)); end = M.snapFrame(Math.max(start + M.frameDur(), end));
  for (const c of M.clipsOn(tr.id)) {
    if (c.start < end && M.clipEnd(c) > start) {
      if (c.start < start) M.trimEdge(c.id, "end", start, { linked: false, snap: false });
      else end = Math.min(end, c.start);
    }
  }
  if (end - start < M.frameDur()) return null;
  const [clip] = M.newClipsForMedia(M.TITLE_MEDIA, tr.id, null, start);
  clip.out = end - start;
  styled(clip, wrap(text));
  P().clips.push(clip);
  return clip;
}

// ---------------------------------------------------------------- SRT
const srtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
export function toSrt(list = captions()) {
  return list.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(M.clipEnd(c))}\n${(c.title?.text || "").trim()}\n`).join("\n");
}
export function parseSrt(text) {
  const out = [];
  const t = (s) => { const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, "0").slice(0, 3) / 1000 : null; };
  for (const block of String(text).replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.trim().split("\n");
    const i = lines.findIndex(l => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->").map(t);
    const body = lines.slice(i + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (a != null && b != null && body) out.push({ start: a, end: b, text: body });
  }
  return out;
}

// ---------------------------------------------------------------- drafting from prompts
// The dialogue lines of an H3 prompt with their times in the file: [{t, text}]. Each [/duration=…] block is a
// sliding window; window k's times count from its first frame, which is `overlap` frames before the cut where it
// takes over (windows: the cuts in file seconds).
export function promptLines(prompt, cuts = [], overlapSeconds = 0) {
  const marks = [...prompt.matchAll(/\[\/duration=[^\]]*\]/g)];
  const blocks = marks.length ? marks.map((m, i) => prompt.slice(i === 0 ? 0 : m.index, marks[i + 1]?.index ?? prompt.length)) : [prompt];
  const out = [];
  blocks.forEach((text, k) => {
    const origin = k === 0 ? 0 : Math.max(0, (cuts[k - 1] ?? 0) - overlapSeconds);
    const events = [...text.matchAll(/\bAt (\d{1,2}):(\d{2}(?:\.\d+)?)/g)].map(m => ({ at: m.index, t: +m[1] * 60 + +m[2] }));
    for (const d of text.matchAll(/<d>([\s\S]*?)<\/d>/g)) {
      const ev = events.filter(e => e.at < d.index).pop();
      if (!ev) continue;
      const line = d[1].replace(/^\s*\[[^\]]*\]\s*/, "").replace(/\s+/g, " ").trim();
      if (line) out.push({ t: origin + ev.t, text: line, next: events.find(e => e.at > d.index)?.t });
    }
  });
  return out;
}

export async function draftFromPrompts(app, { replace = false } = {}) {
  const clips = P().clips.filter(c => M.trackKind(c.trackId) === "video" && !M.getTrack(c.trackId).captions && !c.disabled
    && M.mediaOf(c)?.has_metadata && !M.isStill(c) && !M.hasSpeedKeys(c) && !c.reverse);
  const found = [];
  const cache = new Map();
  for (const c of clips) {
    let info = cache.get(c.mediaId);
    if (!info) {
      try {
        const meta = await (await fetch(`api/media/${c.mediaId}/metadata`)).json();
        let cuts = [];
        if ((meta.prompt || "").includes("[/duration=")) {
          try { cuts = (await (await fetch("api/gen/windows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaId: c.mediaId }) })).json()).cuts || []; } catch {}
        }
        const fps = M.mediaOf(c).fps || 24;
        info = promptLines(meta.prompt || "", cuts, (meta.sliding_window_overlap || 0) / fps);
      } catch { info = []; }
      cache.set(c.mediaId, info);
    }
    const s = Math.abs(c.speed || 1), end = M.clipEnd(c);
    for (const ln of info) {
      const t = c.start + (ln.t - c.in) / s;
      if (t < c.start - 1e-3 || t >= end - 0.2) continue;
      // as long as it takes to say (about 2.6 words a second), but not past the next timed event or the clip
      const words = ln.text.split(" ").length;
      let dur = Math.max(1.2, words / 2.6 + 0.4);
      if (ln.next != null && ln.next > ln.t) dur = Math.min(dur, Math.max(0.8, (ln.next - ln.t) / s));
      found.push({ start: t, end: Math.min(end, t + dur), text: ln.text });
    }
  }
  if (!found.length) return 0;
  found.sort((a, b) => a.start - b.start);
  M.edit("Draft captions from prompts", () => {
    const tr = captionsTrack(true);
    if (replace) for (const c of M.clipsOn(tr.id)) M.deleteClips([c.id]);
    for (const f of found) addCaption(f.start, f.end, f.text);
  });
  return found.length;
}

// ---------------------------------------------------------------- panel
export class CaptionsPanel {
  constructor(app) {
    this.app = app;
    this.list = el("div.cap-list");
    this.burn = el("input", { type: "checkbox", onchange: () => {
      const tr = captionsTrack();
      if (tr) M.edit(this.burn.checked ? "Show captions" : "Hide captions", () => { tr.hidden = !this.burn.checked; });
    } });
    const fileIn = el("input", { type: "file", accept: ".srt,text/plain", style: { display: "none" }, onchange: async () => {
      const f = fileIn.files[0]; fileIn.value = "";
      if (!f) return;
      const cues = parseSrt(await f.text());
      if (!cues.length) { toast("No captions found in that file", "warn"); return; }
      M.edit("Import captions", () => { for (const q of cues) addCaption(q.start, q.end, q.text); });
      toast(`Imported ${cues.length} caption${cues.length > 1 ? "s" : ""}`);
    } });
    const btn = (label, title, fn) => el("button.small", { title, onclick: fn }, label);
    this.node = el("div", {}, el("div.panel-scroll.captions-panel", {},
      el("div.cap-tools", {},
        btn("+ At playhead", "Add a caption at the playhead (2 seconds)", () => this.addAtPlayhead()),
        btn("Draft from prompts", "Make captions from the dialogue (<d>…</d>) in the WanGP prompts of the clips on the timeline, at the times the prompts give", () => this.draft()),
        btn("Style…", "Font, size, colour, background and height for every caption", () => this.styleDialog()),
        btn("Import SRT", "Add captions from an .srt file", () => fileIn.click()),
        btn("Export SRT", "Save the captions as an .srt file", () => this.exportSrt()), fileIn),
      el("label.cap-burn", {}, this.burn, "Show captions and burn them into the export"),
      this.list));
    const refresh = debounce(() => this.render(), 120);
    for (const ev of ["change", "project", "tracks"]) bus.on(ev, refresh);
    bus.on("time", () => this.highlight());
  }

  addAtPlayhead() {
    let made = null;
    M.edit("Add caption", () => { made = addCaption(state.playhead, state.playhead + 2, "Caption"); });
    if (!made) { toast("There's a caption at the playhead already", "warn"); return; }
    M.select([made.id]);
    this.render();
    setTimeout(() => this.list.querySelector(`[data-id="${made.id}"] textarea`)?.select(), 30);
  }

  async draft() {
    const existing = captions().length;
    let replace = false;
    if (existing) {
      replace = await new Promise((resolve) => {
        const m = modal({ title: "Draft captions", narrow: true, body: el("div", {}, `There are ${existing} captions already. Replace them, or add the drafted ones alongside?`),
          buttons: ["spacer", { label: "Add", action: () => resolve(false) }, { label: "Replace", primary: true, action: () => resolve(true) }], onClose: () => resolve(null) });
      });
      if (replace === null) return;
    }
    toast("Reading the prompts…");
    const n = await draftFromPrompts(this.app, { replace });
    toast(n ? `Drafted ${n} caption${n > 1 ? "s" : ""} from the prompts' dialogue` : "No dialogue found in the prompts of the clips on the timeline", n ? "info" : "warn");
  }

  exportSrt() {
    const list = captions();
    if (!list.length) { toast("No captions to export", "warn"); return; }
    const blob = new Blob([toSrt(list)], { type: "text/plain" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${(P().name || "captions").replace(/[\\/:*?"<>|]+/g, "_")}.srt` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  styleDialog() {
    const s = captionStyle();
    const size = el("input", { type: "number", min: 8, max: 300, value: s.size });
    const font = el("input", { type: "text", value: s.font });
    const color = el("input", { type: "color", value: s.color });
    const bold = el("input", { type: "checkbox", checked: s.bold });
    const box = el("input", { type: "checkbox", checked: s.box });
    const boxOp = el("input", { type: "range", min: 0, max: 1, step: 0.05, value: s.boxOpacity });
    const outline = el("input", { type: "checkbox", checked: s.outline });
    const pos = el("input", { type: "range", min: 0.05, max: 0.95, step: 0.01, value: s.position });
    const row = (l, ...c) => el("div.field.wide", {}, el("label", {}, l), el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, ...c));
    modal({ title: "Caption style", narrow: true, body: el("div", {},
        row("Font", font), row("Size", size, el("span.dim", {}, "px at project size")), row("Colour", color, el("label", {}, bold, " Bold")),
        row("Background", box, boxOp), row("Outline", outline), row("Height", pos, el("span.dim", {}, "top … bottom")),
        el("div.dim.small", {}, "Applies to every caption, and to new ones.")),
      buttons: ["spacer", { label: "Cancel" }, { label: "Apply", primary: true, action: () => {
        const st = { font: font.value || "Segoe UI", size: Math.max(8, +size.value || s.size), color: color.value, bold: bold.checked, box: box.checked,
          boxOpacity: +boxOp.value, outline: outline.checked, position: +pos.value };
        M.edit("Caption style", () => {
          P().captionStyle = st;
          for (const c of captions()) styled(c, c.title?.text || "", st);
        });
      } }] });
  }

  render() {
    if (!this.node.isConnected) return;
    const tr = captionsTrack();
    this.burn.checked = !!tr && !tr.hidden;
    this.burn.disabled = !tr;
    const list = captions();
    const focused = document.activeElement?.closest?.(".cap-item")?.dataset.id;
    if (focused) return;   // don't rebuild under the typing
    this.list.innerHTML = "";
    if (!list.length) {
      this.list.append(el("div.dim.small", { style: { padding: "8px 2px" } }, "No captions yet. Add one at the playhead, draft them from the prompts' dialogue, or import an SRT file. They sit on a Captions track at the top of the timeline."));
      return;
    }
    const fps = M.fps();
    for (const c of list) {
      const ta = el("textarea", { rows: 2, value: c.title?.text || "", spellcheck: true });
      ta.value = c.title?.text || "";
      ta.addEventListener("input", () => M.edit("Caption text", () => { const x = M.getClip(c.id); if (x) { x.title = { ...x.title, text: ta.value }; x.name = ta.value.split("\n")[0].slice(0, 40) || "Caption"; } }, { coalesceKey: `cap-${c.id}` }));
      ta.addEventListener("blur", () => setTimeout(() => this.render(), 0));
      const item = el("div.cap-item", { dataset: { id: c.id } },
        el("div.cap-time", { title: "Go to this caption", onclick: () => { this.app.playback.pause(); this.app.playback.seek(c.start + 1e-3); M.select([c.id]); } },
          `${timecode(c.start, fps)} → ${timecode(M.clipEnd(c), fps)}`),
        ta,
        el("button.icon", { title: "Delete this caption", onclick: () => M.edit("Delete caption", () => M.deleteClips([c.id])) }, "✕"));
      this.list.append(item);
    }
    this.highlight();
  }

  highlight() {
    const t = state.playhead;
    for (const n of this.list.querySelectorAll(".cap-item")) {
      const c = M.getClip(n.dataset.id);
      n.classList.toggle("now", !!c && c.start <= t && t < M.clipEnd(c));
    }
  }
}
