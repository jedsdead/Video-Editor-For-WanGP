// Export dialog: settings, progress and result.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { api, el, modal, toast, timecode, clamp } from "./util.js";

const HEIGHTS = [["project", "Project size"], [480, "480p"], [720, "720p"], [1080, "1080p"], [1440, "1440p"], [2160, "2160p (4K)"]];

export function openExportDialog(app) {
  const p = P();
  if (!p.clips.length) { toast("The timeline is empty", "warn"); return; }
  const saved = p.exportDefaults || {};
  const status = app.status || {};
  const s = p.settings;
  const name = el("input", { type: "text", value: saved.filename || p.name || "export", style: { width: "100%" } });
  const size = el("select", {}, HEIGHTS.map(([v, l]) => el("option", { value: v, selected: String(saved.size ?? "project") === String(v) }, l)));
  const sizeNote = el("span.dim");
  const fpsSel = el("select", {}, [["project", `Project (${s.fps} fps)`], [24, "24"], [25, "25"], [30, "30"], [48, "48"], [50, "50"], [60, "60"]]
    .map(([v, l]) => el("option", { value: v, selected: String(saved.fps ?? "project") === String(v) }, l)));
  const codec = el("select", {}, (status.codecs || [{ id: "h264", label: "H.264 (MP4)" }]).map(c => el("option", { value: c.id, selected: (saved.codec || "h264") === c.id }, c.label)));
  const quality = el("input", { type: "range", min: 10, max: 32, step: 1, value: saved.quality || 18 });
  const qualityVal = el("span.dim");
  const hasRange = !!state.range && state.range.end > state.range.start;
  const hasInOut = p.inPoint !== null || p.outPoint !== null;
  const range = el("select", {},
    el("option", { value: "all" }, `Whole timeline (${timecode(M.timelineEnd(), s.fps)})`),
    hasInOut ? el("option", { value: "inout", selected: true }, "In to out points") : null,
    hasRange ? el("option", { value: "range", selected: !hasInOut }, "Range selection") : null);
  const interp = el("select", {}, [["blend", "Frame blend"], ["rife", `Optical flow (RIFE)${status.rife ? "" : " – model not downloaded yet"}`], ["nearest", "Nearest frame"]]
    .map(([v, l]) => el("option", { value: v, selected: (saved.interpolation || "blend") === v }, l)));
  const updateNotes = () => {
    qualityVal.textContent = `${quality.value}  (lower = better & bigger)`;
    const [w, h] = outSize();
    sizeNote.textContent = `${w} × ${h}`;
  };
  const outSize = () => {
    if (size.value === "project") return [s.width, s.height];
    const h = parseInt(size.value, 10);
    const portrait = s.height > s.width;
    const short = h;
    const long = Math.round(short * Math.max(s.width, s.height) / Math.min(s.width, s.height) / 2) * 2;
    return portrait ? [short, long] : [long, short];
  };
  quality.addEventListener("input", updateNotes);
  size.addEventListener("change", updateNotes);
  updateNotes();

  const form = el("div.form-grid", {},
    el("label", {}, "File name"), name,
    el("label", {}, "Resolution"), el("div.row", {}, size, sizeNote),
    el("label", {}, "Frame rate"), fpsSel,
    el("label", {}, "Format"), codec,
    el("label", {}, "Quality"), el("div.row", {}, quality, qualityVal),
    el("label", {}, "Range"), range,
    el("label", { title: "How slowed-down or frame-rate converted clips get their in-between frames, unless a clip overrides it in the Inspector" }, "In-between frames"), interp);
  const progress = el("div.progress", {}, el("div"));
  const message = el("div.dim", { style: { marginTop: "6px", fontSize: "12px" } });
  const result = el("div", { style: { marginTop: "8px" } });
  const progressBox = el("div", { hidden: true, style: { marginTop: "14px" } }, progress, message, result);
  const body = el("div", {}, form, el("div.dim", { style: { marginTop: "10px", fontSize: "12px" } }, `Saved to ${status.exports_dir || "the editor's exports folder"}. Rendering uses ${status.device || "the GPU when available"}.`), progressBox);
  let job = null, timer = null;
  const m = modal({ title: "Export", body, buttons: ["spacer",
    { label: "Close", action: () => { if (job && job.status === "running") { toast("Export keeps running in the background"); } } },
    { label: "Export", primary: true, id: "btnDoExport", close: false, action: () => { start(); return false; } }],
    onClose: () => clearInterval(timer) });
  const exportBtn = m.box.querySelector("#btnDoExport");

  const start = async () => {
    const [w, h] = outSize();
    let a = 0, b = 0;
    if (range.value === "inout") { a = p.inPoint ?? 0; b = p.outPoint ?? M.timelineEnd(); }
    if (range.value === "range") { a = state.range.start; b = state.range.end; }
    const options = { filename: name.value.trim() || "export", width: w, height: h, fps: fpsSel.value === "project" ? s.fps : parseFloat(fpsSel.value),
                      codec: codec.value, quality: parseInt(quality.value, 10), start: a, end: b, interpolation: interp.value };
    P().exportDefaults = { filename: options.filename, size: size.value, fps: fpsSel.value, codec: codec.value, quality: options.quality, interpolation: interp.value };
    bus.emit("change");
    exportBtn.disabled = true;
    progressBox.hidden = false;
    result.innerHTML = "";
    message.textContent = "Starting…";
    try {
      job = await api("api/export", { method: "POST", body: { project: P(), options } });
    } catch (e) { message.textContent = `Could not start: ${e.message}`; exportBtn.disabled = false; return; }
    const cancelBtn = el("button.small", { onclick: () => api(`api/jobs/${job.id}/cancel`, { method: "POST" }).catch(() => {}) }, "Cancel export");
    result.append(cancelBtn);
    timer = setInterval(async () => {
      try { job = await api(`api/jobs/${job.id}`); } catch (_) { return; }
      progress.firstChild.style.width = `${Math.round(job.progress * 100)}%`;
      message.textContent = `${job.message}  ·  ${job.elapsed}s`;
      if (["done", "error", "cancelled"].includes(job.status)) {
        clearInterval(timer);
        exportBtn.disabled = false;
        result.innerHTML = "";
        if (job.status === "done") {
          result.append(el("div", { style: { marginBottom: "6px" } }, "Saved: ", el("span", { style: { userSelect: "text" } }, job.output)),
            el("div.btnrow", {}, el("a", { href: `api/exports/${encodeURIComponent(job.name)}`, download: job.name }, el("button.small.primary", {}, "Download")),
              el("button.small", { onclick: async () => { try { const item = await api("api/exports/import", { method: "POST", body: { name: job.name } }); M.edit("Import media", () => M.registerMedia(item)); bus.emit("media"); toast("Added to the media bin"); } catch (e) { toast(e.message, "error"); } } }, "Add to media bin")));
          for (const w of job.warnings || []) result.append(el("div.warn", {}, w));
          toast("Export finished");
        } else if (job.status === "error") result.append(el("div.warn", {}, job.error || "Export failed"));
        else result.append(el("div.dim", {}, "Export cancelled."));
      }
    }, 500);
  };
}
