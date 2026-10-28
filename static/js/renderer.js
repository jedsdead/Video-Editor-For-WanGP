// WebGL2 compositor for the viewer: draws graded, transformed clip layers bottom-to-top and blends transitions.
import { TRANSITION_GLSL, transitionUniforms } from "./transitions.js";
import { EFFECT_FS } from "./effects.js";

// A layer is a (possibly cropped) image of size uSize centred at uCenter, rotated clockwise by uRot (radians);
// uUv selects the visible part of the texture. render.py's Compositor.place uses the same geometry.
const LAYER_VS = `#version 300 es
in vec2 aPos;
uniform vec2 uCenter, uSize, uCanvas;
uniform float uRot;
uniform vec4 uUv;
out vec2 vUv;
void main() {
  vec2 local = (aPos - 0.5) * uSize;
  float c = cos(uRot), s = sin(uRot);
  vec2 px = uCenter + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  gl_Position = vec4(px.x / uCanvas.x * 2.0 - 1.0, 1.0 - px.y / uCanvas.y * 2.0, 0.0, 1.0);
  vUv = mix(uUv.xy, uUv.zw, aPos);
}`;

const LAYER_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
uniform sampler2D uTex;
uniform sampler3D uLut;
uniform bool uLutOn;
uniform float uLutMix, uLutSize;
uniform float uAlpha;
uniform vec3 uLevel;
uniform bool uPremul;
uniform bool uGrade;
uniform float uExposure, uContrast, uSat;
uniform vec3 uWB, uLift, uGain, uGammaInv;
uniform int uStyle;
uniform vec3 uZoneOff[4];
uniform vec4 uZoneSat;
uniform float uZoneLo, uZoneHi;
out vec4 o;
void main() {
  vec4 t = texture(uTex, vUv);
  if (uPremul) { o = t * uAlpha; return; }   // an already premultiplied effect buffer
  vec3 c = clamp(t.rgb * uLevel, 0.0, 1.0);   // level lock (1,1,1 when off)
  if (uGrade) {
    c = c * uExposure * uWB;
    if (uStyle == 1) {
      // tonal wheels: soft luminance zones for shadows / midtones / highlights, plus a master wheel
      float L = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
      float w = max(0.02, min(0.2, (uZoneHi - uZoneLo) * 0.5));
      float ws = 1.0 - smoothstep(uZoneLo - w, uZoneLo + w, L);
      float wh = smoothstep(uZoneHi - w, uZoneHi + w, L);
      float wm = clamp(1.0 - ws - wh, 0.0, 1.0);
      c += uZoneOff[0] + ws * uZoneOff[1] + wm * uZoneOff[2] + wh * uZoneOff[3];
      float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float zs = uZoneSat.x * (1.0 + ws * (uZoneSat.y - 1.0) + wm * (uZoneSat.z - 1.0) + wh * (uZoneSat.w - 1.0));
      c = l2 + (c - l2) * zs;
    } else {
      c = c * uGain + uLift * (1.0 - c);
      c = pow(max(c, vec3(0.0)), uGammaInv);
    }
    c = (c - 0.5) * uContrast + 0.5;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = l + (c - l) * uSat;
    c = clamp(c, 0.0, 1.0);
  }
  if (uLutOn) {
    vec3 coord = clamp(c, 0.0, 1.0) * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    c = mix(c, texture(uLut, coord).rgb, uLutMix);
  }
  float a = uAlpha * t.a;
  o = vec4(c * a, a);
}`;

const FULL_VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); vUv = aPos; }`;

const TRANS_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uA, uB;
uniform int uFamily, uMode;
uniform float uP, uAspect, uBorder, uAngle;
uniform bool uFeather, uReverse, uPush;
uniform vec3 uBorderColor, uColor;
out vec4 o;
${TRANSITION_GLSL}
void main() { o = transition(vUv); }`;

const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 o;
void main() { o = vec4(texture(uSrc, vUv).rgb, 1.0); }`;

function compile(gl, vs, fs) {
  const make = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); uniforms[info.name] = gl.getUniformLocation(p, info.name); }
  return { program: p, u: uniforms };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: false, antialias: false });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.onRestore = null;
    // A heavy GPU job (WanGP decoding a generation) can make the browser drop the WebGL context, which leaves the
    // viewer black until it is rebuilt: keep the context restorable and rebuild everything on restore.
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      this.init();
      if (this.onRestore) this.onRestore();
    });
    this.init();
  }

  init() {
    const gl = this.gl;
    this.layer = compile(gl, LAYER_VS, LAYER_FS);
    this.trans = compile(gl, FULL_VS, TRANS_FS);
    this.effect = compile(gl, FULL_VS, EFFECT_FS);
    this.copy = compile(gl, FULL_VS, COPY_FS);
    this.pool = new Map();   // offscreen buffers by name and size
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.textures = new WeakMap();
    this.luts = new Map();
    // a 2x2x2 identity LUT keeps the sampler valid when no LUT is used
    this.emptyLut = this.makeLut(2, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]));
    this.fbos = [];
    this.acc = null;
  }

  makeLut(size, rgb) {
    const gl = this.gl;
    const data = new Uint8Array(size * size * size * 4);
    for (let i = 0; i < size * size * size; i++) {
      for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(Math.min(1, Math.max(0, rgb[i * 3 + c])) * 255);
      data[i * 4 + 3] = 255;
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return { tex, size };
  }
  // lut: {size, data: Float32Array of r,g,b in 0..1, red fastest}
  setLut(name, lut) { if (!this.luts.has(name)) this.luts.set(name, this.makeLut(lut.size, lut.data)); }
  hasLut(name) { return this.luts.has(name); }

  setSize(w, h) {
    if (this.canvas.width === w && this.canvas.height === h && this.acc) return;
    this.canvas.width = w; this.canvas.height = h;
    const gl = this.gl;
    for (const f of this.fbos) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
    this.fbos = [0, 1, 2].map(() => this.makeTarget(w, h));
    this.acc = this.fbos[2];   // the composite; adjustment layers read it, then it is copied to the screen
    for (const t of this.pool.values()) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
    this.pool.clear();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  makeTarget(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex, w, h };
  }

  // Offscreen buffer for effects, reused while the size stays the same. Unused sizes are dropped after a while.
  target(name, w, h) {
    const key = `${name}:${w}x${h}`;
    let t = this.pool.get(key);
    if (!t) {
      t = this.makeTarget(w, h);
      this.pool.set(key, t);
      if (this.pool.size > 24) {
        const gl = this.gl;
        const [oldKey, old] = [...this.pool].sort((a, b) => a[1].used - b[1].used)[0];
        gl.deleteFramebuffer(old.fb); gl.deleteTexture(old.tex); this.pool.delete(oldKey);
      }
    }
    t.used = performance.now();
    return t;
  }

  texture(source) {
    const gl = this.gl;
    let entry = this.textures.get(source);
    if (!entry) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      entry = { tex, time: -1, ready: false };
      this.textures.set(source, entry);
    }
    const isVideo = source instanceof HTMLVideoElement;
    if (source instanceof HTMLCanvasElement) {
      if (entry.time !== source.__version) {
        gl.bindTexture(gl.TEXTURE_2D, entry.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        entry.time = source.__version;
        entry.ready = true;
      }
    } else if (isVideo) {
      if (source.readyState >= 2 && (!source.paused || entry.time !== source.currentTime || !entry.ready)) {
        gl.bindTexture(gl.TEXTURE_2D, entry.tex);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); entry.ready = true; entry.time = source.currentTime; }
        catch (e) { /* frame not decodable yet */ }
      }
    } else if (!entry.ready && source.complete && source.naturalWidth) {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      entry.ready = true;
    }
    return entry.ready ? entry.tex : null;
  }

  drawLayer(item, size = null) {
    const gl = this.gl;
    const tex = item.tex || this.texture(item.source);
    if (!tex) return false;
    const { program, u } = this.layer;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.uTex, 0);
    gl.uniform2f(u.uCenter, item.center[0], item.center[1]);
    gl.uniform2f(u.uSize, item.size[0], item.size[1]);
    gl.uniform1f(u.uRot, item.rotation || 0);
    gl.uniform4f(u.uUv, ...(item.uv || [0, 0, 1, 1]));
    gl.uniform2f(u.uCanvas, size ? size[0] : this.canvas.width, size ? size[1] : this.canvas.height);
    gl.uniform1i(u.uPremul, item.premul ? 1 : 0);
    const lut = !item.premul && item.lut && this.luts.get(item.lut.name);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, (lut || this.emptyLut).tex);
    gl.uniform1i(u.uLut, 1);
    gl.uniform1i(u.uLutOn, lut ? 1 : 0);
    gl.uniform1f(u.uLutMix, lut ? item.lut.mix : 0);
    gl.uniform1f(u.uLutSize, (lut || this.emptyLut).size);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(u.uAlpha, item.alpha);
    gl.uniform3f(u.uLevel, ...(item.level || [1, 1, 1]));
    const g = item.premul ? null : item.grade;
    gl.uniform1i(u.uGrade, g ? 1 : 0);
    if (g) {
      gl.uniform1f(u.uExposure, g.exposure);
      gl.uniform1f(u.uContrast, g.contrast);
      gl.uniform1f(u.uSat, g.saturation);
      gl.uniform3f(u.uWB, ...g.wb);
      gl.uniform3f(u.uLift, ...g.lift);
      gl.uniform3f(u.uGain, ...g.gain);
      gl.uniform3f(u.uGammaInv, ...g.gammaInv);
      gl.uniform1i(u.uStyle, g.style || 0);
      if (g.style === 1) {
        gl.uniform3fv(u["uZoneOff[0]"], new Float32Array(g.zoneOff.flat()));
        gl.uniform4f(u.uZoneSat, ...g.zoneSat);
        gl.uniform1f(u.uZoneLo, g.zoneLo);
        gl.uniform1f(u.uZoneHi, g.zoneHi);
      }
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  // Run effect passes on a buffer pair; returns the buffer holding the result.
  runEffects(src, other, passes) {
    const gl = this.gl;
    const { program, u } = this.effect;
    gl.disable(gl.BLEND);
    gl.useProgram(program);
    for (const pass of passes) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, other.fb);
      gl.viewport(0, 0, other.w, other.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(u.uSrc, 0);
      gl.uniform1i(u.uType, pass.type);
      gl.uniform4f(u.uA, ...pass.a);
      if (u.uCol) gl.uniform3f(u.uCol, ...(pass.col || [0, 0, 0]));
      if (u.uDir) gl.uniform2f(u.uDir, ...(pass.dir || [0, 0]));
      if (u.uTexel) gl.uniform2f(u.uTexel, 1 / src.w, 1 / src.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      [src, other] = [other, src];
    }
    gl.enable(gl.BLEND);
    return src;
  }

  // A layer with effects: grade the whole source image into a buffer at its on-screen size, run the effects, and
  // return a premultiplied layer that draws that buffer with the clip's crop, position and opacity.
  effectLayer(item) {
    const gl = this.gl;
    const w = Math.max(1, Math.min(4096, Math.round(item.full[0]))), h = Math.max(1, Math.min(4096, Math.round(item.full[1])));
    const a = this.target(`fx${item.slot || 0}a`, w, h), b = this.target(`fx${item.slot || 0}b`, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (!this.drawLayer({ ...item, center: [w / 2, h / 2], size: [w, h], rotation: 0, uv: [0, 0, 1, 1], alpha: 1 }, [w, h])) return null;
    const out = this.runEffects(a, b, item.effects(w, h));
    const [l, t, r, bo] = item.uv || [0, 0, 1, 1];
    return { ...item, tex: out.tex, premul: true, uv: [l, 1 - t, r, 1 - bo] };
  }

  // Draw a layer (with its effects, if any) into a target.
  drawInto(item, target) {
    const gl = this.gl;
    let layer = item;
    if (item.effects) {
      layer = this.effectLayer(item);
      if (!layer) return false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    return this.drawLayer(layer);
  }

  // Adjustment layer: grade and run effects on everything composited so far, then mix it back by the layer's opacity.
  applyAdjust(entry) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const a = this.target("adjA", w, h), b = this.target("adjB", w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    this.drawLayer({ tex: this.acc.tex, center: [w / 2, h / 2], size: [w, h], rotation: 0, uv: [0, 1, 1, 0], alpha: 1, grade: entry.grade, lut: entry.lut });
    gl.enable(gl.BLEND);
    const out = entry.effects ? this.runEffects(a, b, entry.effects(w, h)) : a;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.acc.fb);
    gl.viewport(0, 0, w, h);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawLayer({ tex: out.tex, premul: true, center: [w / 2, h / 2], size: [w, h], rotation: 0, uv: [0, 1, 1, 0], alpha: entry.alpha });
  }

  // entries: [{type:'clip', ...layer}], [{type:'transition', kind, p, a, b}] or [{type:'adjust', ...}] in bottom-to-top order
  render(entries) {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) return false;
    if (!this.acc) this.setSize(this.canvas.width, this.canvas.height);
    const w = this.canvas.width, h = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.acc.fb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    let pending = false;
    for (const entry of entries) {
      if (entry.type === "clip") { if (!this.drawInto(entry, this.acc)) pending = true; continue; }
      if (entry.type === "adjust") { this.applyAdjust(entry); continue; }
      const layers = [entry.a, entry.b];
      layers.forEach((layer, i) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[i].fb);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (layer && !this.drawInto(layer, this.fbos[i])) pending = true;
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.acc.fb);
      gl.viewport(0, 0, w, h);
      const { program, u } = this.trans;
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fbos[0].tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.fbos[1].tex);
      gl.uniform1i(u.uA, 0); gl.uniform1i(u.uB, 1);
      const t = transitionUniforms(entry.tr);
      const set = (name, fn, ...v) => { if (u[name]) gl[fn](u[name], ...v); };
      set("uFamily", "uniform1i", t.family);
      set("uMode", "uniform1i", t.mode);
      set("uP", "uniform1f", entry.p);
      set("uAspect", "uniform1f", w / h);
      set("uAngle", "uniform1f", t.angle);
      set("uReverse", "uniform1i", t.reverse ? 1 : 0);
      set("uPush", "uniform1i", t.push ? 1 : 0);
      set("uColor", "uniform3f", ...t.color);
      set("uFeather", "uniform1i", t.feather ? 1 : 0);
      set("uBorder", "uniform1f", t.border);
      set("uBorderColor", "uniform3f", ...t.borderColor);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.activeTexture(gl.TEXTURE0);
    }
    // copy the composite to the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.copy.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.acc.tex);
    gl.uniform1i(this.copy.u.uSrc, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND);
    return !pending;
  }
}
