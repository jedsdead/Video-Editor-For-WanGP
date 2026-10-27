// .cube LUT loading for the viewer (luts.py parses the same format for export).
import { api } from "./util.js";

const pending = new Map();

export function parseCube(text) {
  let size = 0, min = [0, 0, 0], max = [1, 1, 1];
  const values = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const head = parts[0].toUpperCase();
    if (head === "LUT_3D_SIZE") size = parseInt(parts[1], 10);
    else if (head === "DOMAIN_MIN") min = parts.slice(1, 4).map(Number);
    else if (head === "DOMAIN_MAX") max = parts.slice(1, 4).map(Number);
    else if (parts.length >= 3 && !isNaN(parseFloat(parts[0]))) values.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!size || values.length !== size * size * size * 3) throw new Error("Not a valid 3D .cube LUT");
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) { const c = i % 3; data[i] = (values[i] - min[c]) / Math.max(1e-6, max[c] - min[c]); }
  return { size, data };
}

// Make sure the renderer has a LUT texture; resolves when it does (or fails quietly).
export function ensureLut(renderer, name, onReady) {
  if (!name || renderer.hasLut(name)) return;
  if (pending.has(name)) return;
  const job = api(`api/luts/${encodeURIComponent(name)}`, { raw: true }).then(r => r.text()).then(text => {
    renderer.setLut(name, parseCube(text));
    onReady && onReady();
  }).catch(err => console.warn("LUT", name, err)).finally(() => pending.delete(name));
  pending.set(name, job);
}
