// Blocks: shots planned on the timeline (a prompt and a length) and generated later, one at a time or all in order.
// Generate all runs them left to right: a block that starts where a clip ends continues out of it (an Extend, with the
// usual joins) when it's set to continue, any other starts a new shot. Each one waits for the one before to land, so
// a block can continue out of the shot generated just before it.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { el, modal, toast } from "./util.js";
import { openGenerate, pinProblem } from "./gendialog.js";

export function blockDialog(app, { trackId, t, block = null } = {}) {
  const b = block ? M.getClip(block.id) : null;
  const prompt = el("textarea.rgprompt", { rows: 10, spellcheck: false });
  prompt.value = b?.block.prompt || "";
  const secs = el("input", { type: "number", min: 0.5, max: 120, step: 0.1, value: b ? M.clipDur(b).toFixed(2) : "5", style: { width: "80px" } });
  const cont = el("input", { type: "checkbox", checked: b ? b.block.cont !== false : true });
  modal({ title: b ? "Block to generate" : "Add a block to generate", body: el("div", {},
      el("div.dim.small", { style: { marginBottom: "8px" } }, "A shot planned here and generated later (right-click it → Generate, or Generate all blocks). It shows as a slate in the viewer and isn't exported. The generation's settings come from the generate dialog as usual."),
      el("div.field.wide", {}, el("label", {}, "Length"), el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, secs, el("span.dim", {}, "seconds of new footage"))),
      el("div.field.wide", {}, el("label", {}, "Continue"), el("label", { style: { display: "flex", gap: "6px", alignItems: "center", color: "inherit" } }, cont,
        "Continue out of the clip before it, when it starts where that clip ends (otherwise a new shot)")),
      el("div.field.wide", {}, el("label", {}, "Prompt"), prompt)),
    buttons: ["spacer", { label: "Cancel" }, { label: b ? "Save" : "Add block", primary: true, action: () => {
      const v = { prompt: prompt.value, seconds: Math.max(0.5, +secs.value || 5), cont: cont.checked };
      if (b) M.edit("Edit block", () => M.updateBlock(b.id, v));
      else {
        const gap = M.gapAt(trackId, t);
        if (gap && Number.isFinite(gap.end) && gap.end - t < v.seconds - 1e-3 && P().magnetic !== true) toast("The block is longer than the gap: clips after it will be pushed along", "warn");
        let made = null;
        M.edit("Add block", () => { made = M.addBlock(trackId, t, v); if (P().magnetic) M.pack?.(); });
        if (made) M.select([made.id]);
      }
    } }] });
}

// How a block will be generated: Extend out of the clip it follows, or a new shot.
export function planFor(block) {
  const lead = block.block.cont !== false ? M.blockLead(block) : null;
  if (lead && !pinProblem(lead) && !M.isStill(lead)) return { mode: "extend", where: { clipId: lead.id }, lead };
  return { mode: "new", where: { trackId: block.trackId, t: block.start + 1e-4 }, lead: null };
}

// Generate one block: the generate dialog, filled in from it (look it over, then queue).
export function generateBlock(app, block) {
  const b = M.getClip(block.id);
  if (!b?.block) return;
  const plan = planFor(b);
  openGenerate(app, plan.mode, plan.where, { prompt: b.block.prompt, seconds: M.clipDur(b), blockId: b.id });
}

let running = null;
export const generatingAll = () => !!running;
export function stopAll() { if (running) { running.stop = true; toast("Generate all will stop after the block that's generating"); } }

// Generate every block in order, each after the one before has landed.
export async function generateAll(app) {
  if (running) { toast("Generate all is already running"); return; }
  const list = M.blocks();
  if (!list.length) { toast("There are no blocks to generate. Right-click empty space on a video track → Add a block to generate.", "warn", 6000); return; }
  running = { stop: false };
  bus.emit("blocks-run");
  const ids = list.map(c => c.id);
  let done = 0;
  try {
    for (const [i, id] of ids.entries()) {
      if (running.stop) break;
      const b = M.getClip(id);
      if (!b?.block) continue;           // removed or already generated
      const plan = planFor(b);
      toast(`Generate all: block ${i + 1} of ${ids.length} (${plan.mode === "extend" ? `continuing out of ${plan.lead.name || "the clip before"}` : "a new shot"})`);
      const jobId = await openGenerate(app, plan.mode, plan.where, { prompt: b.block.prompt, seconds: M.clipDur(b), blockId: b.id, auto: true });
      if (!jobId) { toast(`Generate all stopped at block ${i + 1}: the generate dialog says why`, "warn", 8000); break; }
      // wait for it to land (the block is replaced by the new clip), or to fail
      const ok = await new Promise((resolve) => {
        const check = () => {
          const job = app.regen.jobs.find(j => j.id === jobId);
          if (job && ["error", "failed", "cancelled"].includes(job.status)) return resolve(false);
          // placed: the block has made way and the job has left the list
          if (!job && !M.getClip(id)?.block) return resolve(true);
          // done, but the block is still there (it was added to the Media panel instead): stop here
          if (!job && M.getClip(id)?.block && app.regen.applying.has(jobId)) return resolve(false);
          setTimeout(check, 1500);
        };
        check();
      });
      if (!ok) { toast(`Generate all stopped: block ${i + 1}'s generation failed`, "error", 8000); break; }
      done++;
    }
  } finally {
    running = null;
    bus.emit("blocks-run");
  }
  if (done) toast(`Generate all: ${done} block${done > 1 ? "s" : ""} generated`);
}

// Settings drift: the generated clips on the timeline whose WanGP settings differ from the Media Generator's current
// ones (model, steps, phases, guidance, shift, sampler, sigmas, resolution, LoRAs), to see which shots to redo.
export async function openDrift(app) {
  const clips = P().clips.filter(c => M.trackKind(c.trackId) === "video" && !c.block && M.mediaOf(c)?.has_metadata);
  if (!clips.length) { toast("There are no WanGP generations on this timeline", "warn"); return; }
  const ids = [...new Set(clips.map(c => M.originalOf ? M.originalOf(c).mediaId : c.mediaId))];
  let res;
  try {
    const r = await fetch("api/gen/drift", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaIds: ids }) });
    res = await r.json();
    if (!r.ok) throw new Error(res.detail || r.statusText);
  } catch (e) { toast(`Couldn't compare: ${e.message}`, "error", 6000); return; }
  const drifted = clips.filter(c => (res[M.originalOf ? M.originalOf(c).mediaId : c.mediaId] || []).length);
  const same = clips.length - drifted.length;
  const list = el("div.drift-list");
  for (const c of drifted.sort((a, b) => a.start - b.start)) {
    const d = res[M.originalOf ? M.originalOf(c).mediaId : c.mediaId];
    list.append(el("div.drift-item", {},
      el("div.drift-name", { title: "Go to this clip", onclick: () => { app.playback.pause(); app.playback.seek(c.start + 1e-3); M.select([c.id]); } }, c.name || M.mediaOf(c).name),
      el("div.drift-diffs", {}, ...d.map(x => el("div", {}, el("span.dim", {}, `${x.label}: `), `${x.was} → `, el("b", {}, x.now))))));
  }
  modal({ title: "Settings drift", body: el("div", {},
      el("div.dim.small", { style: { marginBottom: "8px" } }, drifted.length
        ? `${drifted.length} of ${clips.length} generated clips were made with settings that differ from the Media Generator's current ones (was → now). ${same ? `${same} match.` : ""}`
        : `All ${clips.length} generated clips match the Media Generator's current settings.`),
      list),
    buttons: ["spacer", { label: "Close" }, ...(drifted.length ? [{ label: "Select these clips", primary: true, action: () => M.select(drifted.map(c => c.id)) }] : [])] });
}
