// Shot detection dialog: finds cuts inside a clip from the picture (and, for WanGP generations, the prompt's shot list),
// lets the user review them, then splits the clip into labelled shots.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { api, el, modal, toast, timecode, clamp } from "./util.js";

const MATCH_WINDOW = 1.5;   // seconds between a prompt cut and the picture cut it is snapped to

// Picture cuts: frames whose score stands well above its neighbourhood and above the sensitivity threshold.
export function pickCuts(scores, fps, sensitivity, minShot) {
  const threshold = 0.6 - 0.52 * clamp(sensitivity, 0, 1);
  const cuts = [];
  for (let i = 1; i < scores.length; i++) {
    const s = scores[i];
    if (s < threshold) continue;
    let peak = true;
    for (let j = Math.max(1, i - 2); j <= Math.min(scores.length - 1, i + 2); j++) if (j !== i && scores[j] > s) { peak = false; break; }
    if (!peak) continue;
    const local = [];
    for (let j = Math.max(1, i - 12); j <= Math.min(scores.length - 1, i + 12); j++) if (Math.abs(j - i) > 1) local.push(scores[j]);
    local.sort((a, b) => a - b);
    const median = local.length ? local[Math.floor(local.length / 2)] : 0;
    if (s < median * 2.5 + 0.03) continue;
    const t = i / fps;
    const last = cuts[cuts.length - 1];
    if (last && t - last.t < minShot) { if (s > last.score) cuts[cuts.length - 1] = { t, score: s, frame: i }; continue; }
    cuts.push({ t, score: s, frame: i });
  }
  return { cuts, threshold };
}

// Combine picture cuts with the prompt's planned cuts.
function combine(data, sensitivity, minShot) {
  const { cuts, threshold } = pickCuts(data.scores, data.fps, sensitivity, minShot);
  const out = cuts.map(c => ({ t: c.t, score: c.score, kind: "picture", labels: [] }));
  for (const pc of data.promptCuts || []) {
    let best = null;
    for (const c of out) {
      const d = Math.abs(c.t - pc.t);
      if (d <= MATCH_WINDOW && (!best || d < Math.abs(best.t - pc.t)) && !c.labels.length) best = c;
    }
    const label = `W${pc.window} · Shot ${pc.shot}`;
    if (best) { best.kind = "both"; best.labels.push(label); continue; }
    // no confirmed picture cut: offer the strongest nearby frame, unticked
    const fps = data.fps;
    let bi = -1, bs = -1;
    for (let i = Math.max(1, Math.round((pc.t - MATCH_WINDOW) * fps)); i <= Math.min(data.scores.length - 1, Math.round((pc.t + MATCH_WINDOW) * fps)); i++) {
      if (data.scores[i] > bs) { bs = data.scores[i]; bi = i; }
    }
    const t = bs > threshold * 0.5 ? bi / fps : pc.t;
    out.push({ t, score: Math.max(0, bs), kind: "prompt", labels: [label], unconfirmed: true });
  }
  return { cuts: out.sort((a, b) => a.t - b.t), threshold };
}

const KIND_TEXT = { both: "Prompt + picture", picture: "Picture", prompt: "Prompt only" };
const KIND_COLOR = { both: "#36c46f", picture: "#4f8cff", prompt: "#ff9646" };

export async function openShotDetect(app, clipId) {
  const clip = M.getClip(clipId);
  if (!clip || M.isStill(clip) || M.trackKind(clip.trackId) !== "video") { toast("Select a video clip on a video track", "warn"); return; }
  const item = M.mediaOf(clip);
  const status = el("div.dim", {}, "Analysing the clip…");
  const graph = el("canvas.shotgraph");
  const list = el("div.shotlist");
  const sens = el("input", { type: "range", min: 0, max: 100, step: 1, value: localStorage.getItem("ve_shot_sens") || 60 });
  const minShot = el("input", { type: "number", min: 0.1, max: 10, step: 0.1, value: localStorage.getItem("ve_shot_min") || 0.5, style: { width: "64px" } });
  const summary = el("span.dim");
  const body = el("div", {}, status,
    el("div.shot-controls", {},
      el("label", {}, "Sensitivity"), sens,
      el("label", {}, "Shortest shot"), minShot, el("span.dim", {}, "s")),
    graph, list,
    el("div.dim", { style: { fontSize: "11px", marginTop: "6px" } },
      "Green: a cut the prompt asked for, found in the picture. Blue: found in the picture only. Orange: the prompt asked for a cut that the picture doesn't clearly show (unticked). Click the graph to move the playhead there."));
  const m = modal({ title: `Detect shots: ${clip.name || item.name}`, body, buttons: ["spacer", { label: "Cancel" },
    { label: "Split into shots", primary: true, id: "btnSplitShots", action: () => { split(); } }] });
  m.box.classList.add("wide");
  m.footer.insertBefore(summary, m.footer.firstChild);
  const splitBtn = m.box.querySelector("#btnSplitShots");
  splitBtn.disabled = true;

  let data;
  try { data = await api(`api/media/${item.id}/shots`); }
  catch (e) { status.textContent = `Could not analyse: ${e.message}`; return; }
  status.textContent = data.shots.length
    ? `WanGP generation: the prompt describes ${data.shots.length} shot${data.shots.length > 1 ? "s" : ""}.`
    : "No shot list in this clip's prompt; cuts come from the picture only.";

  const range = [Math.min(clip.in, clip.out), Math.max(clip.in, clip.out)];
  let current = [];
  const choice = new Map();   // key (rounded time) -> ticked
  const keyOf = (c) => c.t.toFixed(2);

  const render = () => {
    localStorage.setItem("ve_shot_sens", sens.value);
    localStorage.setItem("ve_shot_min", minShot.value);
    const res = combine(data, sens.value / 100, Math.max(0.05, parseFloat(minShot.value) || 0.5));
    current = res.cuts.filter(c => c.t > range[0] + 1 / data.fps && c.t < range[1] - 1 / data.fps);
    drawGraph(res.threshold);
    list.innerHTML = "";
    if (!current.length) list.append(el("div.empty-note", {}, "No cuts found in this clip. Try a higher sensitivity."));
    for (const c of current) {
      const key = keyOf(c);
      if (!choice.has(key)) choice.set(key, !c.unconfirmed);
      const shot = (data.shots || []).find(s => c.labels.includes(`W${s.window} · Shot ${s.shot}`));
      const box = el("input", { type: "checkbox", checked: choice.get(key), onchange: (e) => { choice.set(key, e.target.checked); updateSummary(); drawGraph(res.threshold); } });
      const thumb = el("div.shotthumb");
      if (item.thumbs === "ready") {
        const idx = clamp(Math.floor(c.t / (item.thumb_interval || 1)), 0, (item.thumb_count || 1) - 1);
        Object.assign(thumb.style, { backgroundImage: `url(api/media/${item.id}/thumbs)`, backgroundSize: `${(item.thumb_count || 1) * 100}% 100%`,
          backgroundPosition: `${(item.thumb_count > 1 ? idx / (item.thumb_count - 1) : 0) * 100}% 0` });
      }
      const tl = clip.start + M.clipTimeForSource(clip, c.t);
      list.append(el("label.shotrow", {}, box, thumb,
        el("span.shottime", {}, timecode(tl, M.fps())),
        el("span.shotkind", { style: { color: KIND_COLOR[c.kind] } }, KIND_TEXT[c.kind]),
        el("span.shottext", { title: shot?.text || "" }, c.labels.length ? `${c.labels.join(", ")}${shot ? ": " + shot.text.replace(/^\[Shot \d+\]\s*/, "").slice(0, 140) : ""}` : `Score ${c.score.toFixed(2)}`)));
    }
    updateSummary();
  };
  const ticked = () => current.filter(c => choice.get(keyOf(c)));
  const updateSummary = () => {
    const n = ticked().length;
    summary.textContent = `${n} cut${n === 1 ? "" : "s"} → ${n + 1} shots`;
    splitBtn.disabled = n === 0;
    splitBtn.textContent = n ? `Split into ${n + 1} shots` : "Split into shots";
  };

  function drawGraph(threshold) {
    const w = Math.max(200, Math.round(graph.clientWidth * devicePixelRatio)), h = Math.round(110 * devicePixelRatio);
    if (graph.width !== w || graph.height !== h) { graph.width = w; graph.height = h; }
    const ctx = graph.getContext("2d");
    ctx.fillStyle = "#0e0f12"; ctx.fillRect(0, 0, w, h);
    const [a, b] = range;
    const x = (t) => (t - a) / Math.max(1e-6, b - a) * w;
    const y = (s) => h - 6 - (h - 18) * Math.min(1, s / 0.7);
    ctx.fillStyle = "rgba(160,170,190,.55)";
    const i0 = Math.max(0, Math.floor(a * data.fps)), i1 = Math.min(data.scores.length - 1, Math.ceil(b * data.fps));
    const bw = Math.max(1, w / Math.max(1, i1 - i0));
    for (let i = i0; i <= i1; i++) ctx.fillRect(x(i / data.fps), y(data.scores[i]), bw, h - 6 - y(data.scores[i]));
    ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, y(threshold)); ctx.lineTo(w, y(threshold)); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `${10 * devicePixelRatio}px Segoe UI, sans-serif`;
    for (const c of current) {
      const on = choice.get(keyOf(c));
      ctx.strokeStyle = KIND_COLOR[c.kind]; ctx.globalAlpha = on ? 1 : 0.35; ctx.lineWidth = 2 * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(x(c.t), 12 * devicePixelRatio); ctx.lineTo(x(c.t), h); ctx.stroke();
      if (c.labels.length) { ctx.fillStyle = KIND_COLOR[c.kind]; ctx.fillText(c.labels[0].replace(" · Shot ", "S"), x(c.t) + 3, 10 * devicePixelRatio); }
      ctx.globalAlpha = 1;
    }
    const ph = state.playhead - clip.start;
    if (ph >= 0 && ph <= M.clipDur(clip)) { ctx.fillStyle = "#ff4d4d"; ctx.fillRect(x(M.srcTime(clip, ph)), 0, devicePixelRatio, h); }
  }
  graph.addEventListener("click", (e) => {
    const r = graph.getBoundingClientRect();
    const src = range[0] + (e.clientX - r.left) / r.width * (range[1] - range[0]);
    app.playback.pause();
    app.playback.seek(clip.start + M.clipTimeForSource(clip, src));
    render();
  });
  sens.addEventListener("input", render);
  minShot.addEventListener("change", render);

  function split() {
    const cuts = ticked().map(c => ({ t: c.t, keys: c.labels.map(l => l.replace(" · Shot ", "S")) }));
    if (!cuts.length) return false;
    const pieces = M.edit("Split into shots", () => M.splitIntoShots(clip.id, cuts, data.shots || []));
    if (pieces && pieces.length) { M.select([pieces[0].id]); toast(`Split into ${pieces.length} shots`); }
  }

  render();
}
