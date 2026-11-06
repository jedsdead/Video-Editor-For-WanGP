// Colour picker on the viewer: click the picture to pick a colour (a 5 x 5 pixel average). It can read the picture
// as shown, before the curves (what the curves are fed: after the wheels and sliders, before the curves, LUT and shot
// match), or the source itself before any grade (for white balance). Esc or a right-click cancels.
import { el, toast } from "./util.js";

export function rgbToHsv([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = (((g - b) / d) % 6 + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, mx > 1e-6 ? d / mx : 0, mx];
}
export const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const toHex = (rgb) => "#" + rgb.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");

export class ColourPicker {
  constructor(app) {
    this.app = app;
    this.active = null;
    this.hint = el("div.pick-hint", { hidden: true });
    document.getElementById("viewerStage").append(this.hint);
    // ahead of everything else on the page (the viewer's transform handles, the timeline): while picking, a click on the
    // picture picks and does nothing else; a click anywhere else, or a right-click, cancels
    const stage = document.getElementById("viewerStage");
    window.addEventListener("pointerdown", (e) => {
      if (!this.active) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.button !== 0 || !this.pixelAt(e.clientX, e.clientY)) { this.finish(null); return; }
      this.finish(this.sample(e.clientX, e.clientY, this.active.stage));
    }, true);
    window.addEventListener("pointermove", (e) => {
      if (!this.active || !this.pixelAt(e.clientX, e.clientY)) return;
      const rgb = this.readAt(e.clientX, e.clientY);   // the picture as shown, for the swatch
      const r = stage.getBoundingClientRect();
      if (rgb) { this.swatch.style.background = toHex(rgb); this.hint.style.left = `${e.clientX - r.left + 18}px`; this.hint.style.top = `${e.clientY - r.top + 18}px`; }
    }, true);
    window.addEventListener("contextmenu", (e) => { if (this.active) e.preventDefault(); }, true);
    window.addEventListener("keydown", (e) => { if (this.active && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.finish(null); } }, true);
  }

  // pick({stage: "output" | "precurves" | "source", label}) -> Promise<{rgb, hsv, luma, hex} | null>
  pick({ stage = "output", label = "Click the picture to pick a colour" } = {}) {
    if (this.active) this.finish(null);
    this.app.playback.pause();
    return new Promise((resolve) => {
      this.active = { stage, resolve };
      document.body.classList.add("picking");
      this.swatch = el("span.pick-swatch");
      this.hint.innerHTML = "";
      this.hint.append(this.swatch, el("span", {}, `${label} · Esc to cancel`));
      this.hint.style.left = "12px"; this.hint.style.top = "12px";
      this.hint.hidden = false;
    });
  }

  finish(result) {
    const a = this.active;
    this.active = null;
    document.body.classList.remove("picking");
    this.hint.hidden = true;
    a?.resolve(result);
  }

  pixelAt(clientX, clientY) {
    const c = document.getElementById("previewCanvas");
    const r = c.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    return [Math.round((clientX - r.left) / r.width * c.width), Math.round((1 - (clientY - r.top) / r.height) * c.height)];
  }
  readAt(clientX, clientY, size = 5) {
    const p = this.pixelAt(clientX, clientY);
    if (!p) return null;
    const gl = this.app.renderer.gl, c = this.app.renderer.canvas;
    const half = Math.floor(size / 2);
    const x = Math.max(0, Math.min(c.width - size, p[0] - half)), y = Math.max(0, Math.min(c.height - size, p[1] - half));
    const d = new Uint8Array(size * size * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, d);
    const sum = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
    return sum.map(v => v / (size * size) / 255);
  }
  // the frame drawn at a stage, then put back as it was
  withStage(stage, fn) {
    const r = this.app.renderer;
    if (stage === "output") return fn();
    r.pickStage = stage;
    try { this.app.playback.renderNow(); return fn(); }
    finally { r.pickStage = null; this.app.playback.renderNow(); this.app.playback.dirty = true; }
  }
  sample(clientX, clientY, stage) {
    const rgb = this.withStage(stage, () => this.readAt(clientX, clientY));
    if (!rgb) { toast("Click inside the picture"); return null; }
    return { rgb, hsv: rgbToHsv(rgb), luma: luma(rgb), hex: toHex(rgb) };
  }
  // the whole frame at a stage, as pixels (for automatic white balance)
  frame(stage, step = 4) {
    return this.withStage(stage, () => {
      const gl = this.app.renderer.gl, c = this.app.renderer.canvas;
      const d = new Uint8Array(c.width * c.height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, d);
      const out = [];
      for (let y = 0; y < c.height; y += step) for (let x = 0; x < c.width; x += step) {
        const i = (y * c.width + x) * 4;
        out.push([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255]);
      }
      return out;
    });
  }
}

// An eyedropper button for a colour input: picks from the viewer into it.
export function eyedropper(app, input, { stage = "output", label = "Pick a colour from the picture" } = {}) {
  return el("button.small.pick-btn", { type: "button", title: `${label} (click the viewer)`, onclick: async (e) => {
    e.preventDefault();
    const res = await app.picker.pick({ stage, label });
    if (!res) return;
    input.value = res.hex;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } }, "⌖");
}
