// Markers panel: every marker with its time, name, colour and note; click to jump, edit in place.
import * as M from "./model.js";
import { state, P, bus } from "./model.js";
import { el, timecode } from "./util.js";

export class MarkersPanel {
  constructor(app) {
    this.app = app;
    this.list = el("div.marker-list");
    this.node = el("div", {},
      el("div.panel-toolbar", {},
        el("button.small", { title: "Add a marker at the playhead (Shift+M)", onclick: () => app.addMarker() }, "+ Marker at playhead"),
        el("div.spacer"), el("span.dim", { style: { fontSize: "11px" } }, "Shift+M adds, ↑/↓ jump")),
      el("div.panel-scroll", {}, this.list));
    for (const name of ["change", "project"]) bus.on(name, () => this.render());
    bus.on("time", () => this.highlight());
  }

  render() {
    if (!P()) return;
    const markers = (P().markers || []).slice().sort((a, b) => a.t - b.t);
    const sig = JSON.stringify(markers);
    if (sig === this.sig) return;
    this.sig = sig;
    this.list.innerHTML = "";
    if (!markers.length) { this.list.append(el("div.empty-note", {}, "No markers yet. Press Shift+M to mark the playhead.")); return; }
    for (const m of markers) {
      const name = el("input.mname", { value: m.name || "", placeholder: "Name",
        onchange: (e) => M.edit("Rename marker", () => { const x = M.getMarker(m.id); if (x) x.name = e.target.value; }) });
      const note = el("input.mnote", { value: m.note || "", placeholder: "Note",
        onchange: (e) => M.edit("Marker note", () => { const x = M.getMarker(m.id); if (x) x.note = e.target.value; }) });
      const colours = el("span.mcolors", {}, M.MARKER_COLORS.map(c => el("span.mdot", { style: { background: c }, title: "Colour",
        onclick: (e) => { e.stopPropagation(); M.edit("Marker colour", () => { const x = M.getMarker(m.id); if (x) x.color = c; }); } })));
      const row = el("div.mrow", { dataset: { id: m.id }, onclick: (e) => { if (e.target.tagName === "INPUT") return; this.app.playback.pause(); this.app.playback.seek(m.t); } },
        el("span.mflag", { style: { background: m.color } }), el("span.mtime", {}, timecode(m.t, M.fps())), name, note, colours,
        el("button.icon", { title: "Delete marker", onclick: (e) => { e.stopPropagation(); M.edit("Delete marker", () => M.removeMarker(m.id)); } }, "✕"));
      this.list.append(row);
    }
    this.highlight();
  }

  highlight() {
    const fd = M.frameDur ? M.frameDur() : 1 / 24;
    for (const row of this.list.querySelectorAll(".mrow")) {
      const m = M.getMarker(row.dataset.id);
      row.classList.toggle("at", !!m && Math.abs(m.t - state.playhead) < fd / 2);
    }
  }
}
