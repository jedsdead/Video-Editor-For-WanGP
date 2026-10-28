// Final render: draft clips refined as one piece per continuous stretch, at twice the size, by WanGP's own two-phase
// machinery (phase 2 refines the stretch's drafts instead of a fresh phase 1), then cut back onto the clips as "Final"
// takes. Also the project's generation size (the draft size editor generations use).
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { api, el, modal, toast, debounce } from "./util.js";

// ---------------------------------------------------------------- project generation size

const metaCache = new Map();
async function metaOf(mediaId) {
  if (!metaCache.has(mediaId)) metaCache.set(mediaId, api(`api/media/${mediaId}/metadata`).catch(() => null));
  return metaCache.get(mediaId);
}

// The size editor generations use. Defaults from the first WanGP clip on the timeline.
export async function ensureGenSettings() {
  if (!P()) return null;
  if (P().settings.gen) return P().settings.gen;
  const clips = [...M.clipsOn(M.primaryId()), ...P().clips].filter(c => M.mediaOf(c)?.has_metadata);
  for (const c of clips) {
    const meta = await metaOf(c.mediaId);
    const [w, h] = String(meta?.resolution || "").split("x").map(Number);
    if (!w || !h) continue;
    const gen = { width: w, height: h, phases: Math.max(1, parseInt(meta.guidance_phases, 10) || (meta.switch_threshold != null && meta.num_inference_steps2 ? 2 : 1)),
                  vaeX2: String(meta.spatial_upsampling || "").startsWith("h3_vae") };
    if (!P().settings.gen) { M.edit("Generation size", () => { P().settings.gen = gen; }); bus.emit("settings"); }
    return P().settings.gen;
  }
  return null;
}

export const genOutput = (g) => g ? [g.width * (g.vaeX2 ? 2 : 1), g.height * (g.vaeX2 ? 2 : 1)] : null;
export const genLabel = (g) => g ? `${g.width} × ${g.height}, ${g.phases > 1 ? "two phases" : "one phase"}${g.vaeX2 ? ", VAE ×2" : ""}` : "the clip's own settings";

// ---------------------------------------------------------------- stretches

const plain = (c) => {
  const item = M.mediaOf(c);
  return item && item.kind === "video" && !c.reverse && !M.hasSpeedKeys(c) && Math.abs((c.speed || 1) - 1) < 1e-6;
};
// Whether b continues a on screen (so they are refined together): a generation joining them, or one shot split.
function continues(a, b) {
  if (b.gen?.parent === a.id || a.gen?.child === b.id) return true;
  if ((b.seam?.left?.verdict && b.seam.left.verdict !== "hard cut")) return true;
  return a.mediaId === b.mediaId && Math.abs(Math.max(a.in, a.out) - Math.min(b.in, b.out)) < 1.5 / M.fps();
}

export function stretches() {
  const list = M.clipsOn(M.primaryId());
  const out = [];
  let cur = null;
  for (const c of list) {
    if (!plain(c)) { cur = null; continue; }
    const prev = cur && cur.clips[cur.clips.length - 1];
    if (prev && Math.abs(M.clipEnd(prev) - c.start) < M.frameDur() / 2 && continues(prev, c)) cur.clips.push(c);
    else { cur = { clips: [c] }; out.push(cur); }
  }
  for (const s of out) {
    s.start = s.clips[0].start;
    s.end = M.clipEnd(s.clips[s.clips.length - 1]);
    s.final = s.clips.every(c => finalIndex(c) >= 0);
    s.stale = s.clips.some(c => isStale(c));
  }
  return out;
}

// ---------------------------------------------------------------- final takes

export const finalIndex = (c) => (c.takes || []).findIndex(t => t.final);
const draftSig = (t) => `${t.mediaId}|${(+t.in).toFixed(4)}|${(+t.out).toFixed(4)}`;
// The draft a clip shows (or would show): the take the final was rendered over, else the active one.
function draftTake(c) {
  const fi = finalIndex(c);
  const idx = fi >= 0 && (c.takeIndex || 0) === fi ? (c.takes[fi].draftIndex ?? 0) : (c.takeIndex || 0);
  if (c.takes && c.takes[idx]) {
    // the active draft's live range is the clip's own (trims move it); a parked draft keeps its stored range
    return (c.takeIndex || 0) === idx ? { mediaId: c.mediaId, in: c.in, out: c.out } : c.takes[idx];
  }
  return { mediaId: c.mediaId, in: c.in, out: c.out };
}
export function isStale(c) {
  const fi = finalIndex(c);
  if (fi < 0) return false;
  return c.takes[fi].sig !== draftSig(draftTake(c));
}

export function showFinals(on) {
  P().settings.showFinal = !!on;
  M.edit(on ? "Show finals" : "Show drafts", () => {
    for (const c of P().clips) {
      const fi = finalIndex(c);
      if (fi < 0) continue;
      const active = c.takeIndex || 0;
      if (on && active !== fi && !isStale(c)) { c.takes[fi].draftIndex = active; M.setTake(c.id, fi); }
      if (!on && active === fi) M.setTake(c.id, c.takes[fi].draftIndex ?? 0);
    }
  });
  bus.emit("change");
}

// A finished render: one Final take per clip of the stretch, cut from the rendered file at the clip's place in it.
export function applyRender(app, job) {
  const item = job.media;
  app.bin.register([item], null);
  const fps = job.fps || M.fps();
  let added = 0;
  M.edit("Add final renders", () => {
    for (const part of job.parts || []) {
      const c = M.getClip(part.clipId);
      if (!c) continue;
      const sig = (job.request?.clips || []).find(x => x.clipId === part.clipId);
      const old = finalIndex(c);
      let draftIndex = c.takeIndex || 0;
      if (old >= 0) {
        if (draftIndex === old) draftIndex = c.takes[old].draftIndex ?? 0;
        M.removeTake(c.id, old);
        if (draftIndex > old) draftIndex -= 1;
        if (!c.takes) draftIndex = 0;
      }
      const take = M.addTake(c.id, { mediaId: item.id, in: part.offset / fps, length: part.frames / fps, label: "Final", audio: "keep", jobId: job.id, seed: job.seed });
      if (!take) continue;
      Object.assign(take, { final: true, draftIndex, audioFrom: draftIndex, sig: sig ? draftSig(sig) : "" });
      // addTake switched to it; stay on the draft unless finals are showing
      if (!P().settings.showFinal) M.setTake(c.id, draftIndex);
      else M.setTake(c.id, c.takes.indexOf(take));
      added++;
    }
  });
  toast(added ? `Final render added to ${added} clip${added > 1 ? "s" : ""}${P().settings.showFinal ? "" : " (View → Show final renders to see it)"}` : "A final render finished, but its clips have gone; it was added to the Media panel", added ? "info" : "warn");
}

// ---------------------------------------------------------------- dialog

export async function openRenderDialog(app) {
  if (!P()) return;
  const gen = await ensureGenSettings();
  const list = stretches();
  if (!list.length) { toast("Nothing to render: the main video track has no plain video clips", "warn"); return; }
  const prefs = (() => { try { return JSON.parse(localStorage.getItem("ve_render") || "{}"); } catch (_) { return {}; } })();
  const fmt = (t) => `${t.toFixed(1)}s`;
  const rows = list.map((s, i) => {
    const box = el("input", { type: "checkbox", checked: !s.final || s.stale });
    const names = s.clips.length === 1 ? s.clips[0].name : `${s.clips[0].name} … ${s.clips[s.clips.length - 1].name}`;
    const note = el("span.dim.small", {}, s.final ? (s.stale ? " · final is out of date" : " · rendered") : "");
    return { s, box, row: el("label.rrow", {}, box, el("span", {}, `${fmt(s.start)}–${fmt(s.end)} · ${s.clips.length} clip${s.clips.length > 1 ? "s" : ""} · ${names}`), note) };
  });
  // refine at twice the draft size (one-phase drafts), or at the draft size when the drafts already had a phase 2
  const base = gen ? [gen.width, gen.height] : [M.mediaOf(list[0].clips[0])?.width || 768, M.mediaOf(list[0].clips[0])?.height || 320];
  const k = gen && gen.phases > 1 ? 1 : 2;
  const wIn = el("input", { type: "number", min: 64, step: 32, value: prefs.width || base[0] * k, style: { width: "90px" } });
  const hIn = el("input", { type: "number", min: 64, step: 32, value: prefs.height || base[1] * k, style: { width: "90px" } });
  const strength = el("input", { type: "number", min: 0.05, max: 1, step: 0.05, value: prefs.strength ?? "", placeholder: "clip's", style: { width: "70px" } });
  const steps = el("input", { type: "number", min: 1, max: 20, step: 1, value: prefs.steps ?? "", placeholder: "clip's", style: { width: "70px" } });
  const vae = el("input", { type: "checkbox", checked: prefs.vaeX2 !== false });
  const keepLoras = el("input", { type: "checkbox", checked: !!prefs.keepLoras });
  const prompt = el("textarea.rgprompt", { rows: 4, placeholder: "Leave empty to use the prompt of each stretch's first clip" });
  const note = el("div.dim.small");
  const error = el("div.warn");
  const field = (label, ...children) => el("div.rgfield", {}, el("label.rglabel", {}, label), el("div.rgctl", {}, ...children));
  const body = el("div.rgbody", {},
    el("div", { style: { marginBottom: "8px" } }, "Refine each continuous stretch of the main track as one piece, at the final size, with the same Turbo LoRA, noise level and steps as your clips' phase 2. Each clip gets a Final take; its draft is kept."),
    field("Stretches", ...rows.map(r => r.row)),
    field("Refine at", el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, wIn, el("span", {}, "×"), hIn),
      el("label.rrow", {}, vae, el("span", {}, "Decode with the H3 VAE ×2")), note),
    field("Phase 2", el("div", { style: { display: "flex", gap: "10px", alignItems: "center" } },
      el("span.dim", {}, "noise level start"), strength, el("span.dim", {}, "steps"), steps),
      el("label.rrow", {}, keepLoras, el("span", {}, "Keep the clips' LoRAs in the refine (otherwise only RefMods, references and the Turbo LoRA)"))),
    field("Prompt", prompt),
    error);
  const m = modal({ title: "Render final", body, buttons: ["spacer", { label: "Cancel" }, { label: "Queue in WanGP", primary: true, id: "btnRenderGo", action: () => { submit(); return false; } }] });
  m.box.classList.add("wide");
  const go = m.box.querySelector("#btnRenderGo");
  const request = (s) => ({
    project: P().name, size: [parseInt(wIn.value, 10), parseInt(hIn.value, 10)], vaeX2: vae.checked,
    strength: strength.value === "" ? null : parseFloat(strength.value), steps: steps.value === "" ? null : parseInt(steps.value, 10),
    prompt: prompt.value.trim(), keepLoras: keepLoras.checked, clips: s.clips.map(c => ({ clipId: c.id, ...draftTake(c) })),
    settingsFrom: (s.clips.find(c => M.mediaOf(c)?.has_metadata) || s.clips[0]).mediaId,
  });
  const refresh = debounce(async () => {
    error.textContent = "";
    const first = rows.find(r => r.box.checked);
    if (!first) { note.textContent = "Pick at least one stretch."; go.disabled = true; return; }
    try {
      const info = await api("api/render/prepare", { method: "POST", body: request(first.s) });
      note.textContent = `Phase 1 size ${info.phase1[0]} × ${info.phase1[1]} (the drafts are scaled to it), refined at ${info.size[0]} × ${info.size[1]}, output ${info.output[0]} × ${info.output[1]}. ${info.model}; noise ${info.strength}, ${info.steps} steps${info.loras.length ? `; the clips' LoRAs: ${info.loras.join(", ")}${keepLoras.checked ? " (kept)" : " (left out)"}` : ""}.`;
      if (!strength.value) strength.placeholder = String(info.strength);
      if (!steps.value) steps.placeholder = String(info.steps);
      go.disabled = !info.available || !info.h3?.installed;
      if (!info.available) error.textContent = info.reason;
      else if (!info.h3?.installed) error.textContent = "The editor's H3 add-on isn't active in WanGP (restart WanGP).";
    } catch (e) { error.textContent = e.message; go.disabled = true; }
  }, 250);
  for (const c of [wIn, hIn, vae, keepLoras, strength, steps, ...rows.map(r => r.box)]) c.addEventListener("change", refresh);
  async function submit() {
    const chosen = rows.filter(r => r.box.checked);
    if (!chosen.length) return;
    try { localStorage.setItem("ve_render", JSON.stringify({ width: +wIn.value, height: +hIn.value, vaeX2: vae.checked, strength: strength.value === "" ? null : +strength.value, steps: steps.value === "" ? null : +steps.value, keepLoras: keepLoras.checked })); } catch (_) { /* ignore */ }
    go.disabled = true;
    let queued = 0;
    for (const r of chosen) {
      try { await api("api/render/submit", { method: "POST", body: request(r.s) }); queued++; }
      catch (e) { error.textContent = `${fmt(r.s.start)}–${fmt(r.s.end)}: ${e.message}`; }
    }
    if (queued) { toast(`${queued} final render${queued > 1 ? "s" : ""} queued in WanGP`); app.regen.poll(); m.close(); }
    else go.disabled = false;
  }
  refresh();
}

// ---------------------------------------------------------------- generation size in the project inspector

export function genSection(inspector) {
  const g = P().settings.gen;
  const set = (key, value) => { M.edit("Generation size", () => { P().settings.gen = { ...(P().settings.gen || { width: 768, height: 320, phases: 1, vaeX2: false }), [key]: value }; }); bus.emit("settings"); };
  const w = el("input", { type: "number", min: 64, step: 32, value: g?.width ?? "", style: { width: "80px" }, onchange: (e) => set("width", Math.max(64, Math.round(+e.target.value / 32) * 32)) });
  const h = el("input", { type: "number", min: 64, step: 32, value: g?.height ?? "", style: { width: "80px" }, onchange: (e) => set("height", Math.max(64, Math.round(+e.target.value / 32) * 32)) });
  const phases = el("select", { onchange: (e) => set("phases", +e.target.value) }, el("option", { value: 1, selected: g?.phases !== 2 }, "One phase (fast drafts)"), el("option", { value: 2, selected: g?.phases === 2 }, "Two phases"));
  const vae = el("input", { type: "checkbox", checked: !!g?.vaeX2, onchange: (e) => set("vaeX2", e.target.checked) });
  const reset = el("button.small", { onclick: async () => { M.edit("Generation size", () => { delete P().settings.gen; }); await ensureGenSettings(); inspector.render(); } }, "From the first clip");
  inspector.section("Generation",
    el("div.dim", { style: { fontSize: "12px", marginBottom: "6px" } }, "The size the editor generates at (extend, prepend, new shots and so on). Keep it the same across a project so joins stay latent grade and stretches can be rendered final together. For 2.40:1 drafts, 768 × 320 renders final at 1536 × 640 and 3072 × 1280 with the VAE ×2."),
    el("div.field.wide", {}, el("label", {}, "Size"), el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, w, el("span", {}, "×"), h)),
    el("div.field.wide", {}, el("label", {}, "Passes"), phases),
    el("label.rrow", {}, vae, el("span", {}, "Decode drafts with the H3 VAE ×2")),
    el("div.btnrow", {}, reset, el("button.small.primary", { onclick: () => openRenderDialog(inspector.app) }, "Render final…")));
}
