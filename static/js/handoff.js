// Hand-off and collect: the open timeline as FCP 7 XML (Premiere, Resolve) or an EDL; the project zipped with every
// file it uses; and opening such a ZIP on any machine.
import { P } from "./model.js";
import { el, modal, toast, api } from "./util.js";

const download = (name) => { const a = el("a", { href: `api/exports/${encodeURIComponent(name)}`, download: name }); document.body.append(a); a.click(); a.remove(); };

export async function exportInterchange(fmt) {
  let res;
  try { res = await api(`api/interchange/${fmt}`, { method: "POST", body: { project: P() } }); }
  catch (e) { toast(`Couldn't export: ${e.message}`, "error", 6000); return; }
  const what = fmt === "xml" ? "FCP 7 XML" : "EDL";
  modal({ title: `${what} saved`, narrow: true, body: el("div", {},
      el("div", { style: { marginBottom: "6px" } }, "Saved: ", el("span", { style: { userSelect: "text" } }, res.path)),
      el("div.dim.small", { style: { marginBottom: "6px" } }, fmt === "xml"
        ? "Premiere: File → Import. Resolve: File → Import → Timeline. The clips link to the original files where they are."
        : "Most editors import EDLs; point them at the original files when they ask for media."),
      ...(res.notes.length ? [el("div.dim.small", {}, "Not carried over:"), el("ul.small", { style: { margin: "2px 0 0 18px", padding: 0 } }, ...res.notes.map(n => el("li", {}, n)))] : [])),
    buttons: ["spacer", { label: "Close" }, { label: "Download", primary: true, action: () => download(res.name) }] });
}

export async function collectProject() {
  let job;
  try { job = await api("api/collect", { method: "POST", body: { project: P() } }); }
  catch (e) { toast(`Couldn't collect: ${e.message}`, "error", 8000); return; }
  const bar = el("div.progress", {}, el("div"));
  const msg = el("div.dim.small");
  const result = el("div");
  const m = modal({ title: "Collect project", narrow: true, body: el("div", {},
      el("div.dim.small", { style: { marginBottom: "8px" } }, `One ZIP with this project (every timeline), each file it uses (${(job.bytes_total / 1e9).toFixed(2)} GB) and its LUTs, for archiving or moving to another machine. Open it there with File → Open collected project.`),
      bar, msg, result),
    buttons: ["spacer", { label: "Cancel", action: () => { if (job.status === "running") api(`api/collect/${job.id}/cancel`, { method: "POST" }).catch(() => {}); } }] });
  while (job.status === "running") {
    await new Promise(r => setTimeout(r, 600));
    try { job = await api(`api/collect/${job.id}`); } catch (_) { continue; }
    bar.firstChild.style.width = `${Math.round((job.progress || 0) * 100)}%`;
    msg.textContent = job.message || "";
  }
  if (job.status !== "done") { msg.textContent = job.status === "cancelled" ? "Cancelled." : `Couldn't collect: ${job.error}`; return; }
  msg.textContent = `${job.files} file${job.files === 1 ? "" : "s"}, ${(job.bytes / 1e9).toFixed(2)} GB`;
  result.append(el("div", { style: { margin: "6px 0" } }, "Saved: ", el("span", { style: { userSelect: "text" } }, job.path)),
    ...(job.missing?.length ? [el("div.warn", {}, `Missing, so not in the ZIP: ${job.missing.join(", ")}`)] : []),
    el("button.small.primary", { onclick: () => download(job.name) }, "Download"));
  m.footer.querySelector("button").textContent = "Close";
}

export function openCollected(loadProject) {
  const input = el("input", { type: "file", accept: ".zip,application/zip", style: { display: "none" } });
  input.onchange = async () => {
    const f = input.files[0];
    input.remove();
    if (!f) return;
    toast(`Unpacking ${f.name}…`);
    const form = new FormData();
    form.append("file", f);
    let res;
    try {
      const r = await fetch("api/collect/open", { method: "POST", body: form });
      res = await r.json();
      if (!r.ok) throw new Error(res.detail || r.statusText);
    } catch (e) { toast(`Couldn't open: ${e.message}`, "error", 8000); return; }
    await loadProject(res.name);
    toast(`Opened “${res.name}” (files in ${res.folder})${res.notes.length ? `. ${res.notes.join(" · ")}` : ""}`, res.notes.length ? "warn" : "info", 8000);
  };
  document.body.append(input);
  input.click();
}
