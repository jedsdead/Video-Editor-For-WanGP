// WebGL2 compositor for the viewer: draws graded, transformed clip layers bottom-to-top and blends transitions.
import { TRANSITION_GLSL, transitionUniforms } from "./transitions.js";

const LAYER_VS = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;
uniform vec2 uCanvas;
out vec2 vUv;
void main() {
  vec2 px = uRect.xy + aPos * uRect.zw;
  gl_Position = vec4(px.x / uCanvas.x * 2.0 - 1.0, 1.0 - px.y / uCanvas.y * 2.0, 0.0, 1.0);
  vUv = aPos;
}`;

const LAYER_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uAlpha;
uniform bool uGrade;
uniform float uExposure, uContrast, uSat;
uniform vec3 uWB, uLift, uGain, uGammaInv;
out vec4 o;
void main() {
  vec4 t = texture(uTex, vUv);
  vec3 c = t.rgb;
  if (uGrade) {
    c = c * uExposure * uWB;
    c = c * uGain + uLift * (1.0 - c);
    c = pow(max(c, vec3(0.0)), uGammaInv);
    c = (c - 0.5) * uContrast + 0.5;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = l + (c - l) * uSat;
    c = clamp(c, 0.0, 1.0);
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
    this.layer = compile(gl, LAYER_VS, LAYER_FS);
    this.trans = compile(gl, FULL_VS, TRANS_FS);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.textures = new WeakMap();
    this.fbos = [];
  }

  setSize(w, h) {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w; this.canvas.height = h;
    const gl = this.gl;
    for (const f of this.fbos) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
    this.fbos = [0, 1].map(() => {
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
      return { fb, tex };
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
    if (isVideo) {
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

  drawLayer(item) {
    const gl = this.gl;
    const tex = this.texture(item.source);
    if (!tex) return false;
    const { program, u } = this.layer;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.uTex, 0);
    gl.uniform4f(u.uRect, ...item.rect);
    gl.uniform2f(u.uCanvas, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uAlpha, item.alpha);
    const g = item.grade;
    gl.uniform1i(u.uGrade, g ? 1 : 0);
    if (g) {
      gl.uniform1f(u.uExposure, g.exposure);
      gl.uniform1f(u.uContrast, g.contrast);
      gl.uniform1f(u.uSat, g.saturation);
      gl.uniform3f(u.uWB, ...g.wb);
      gl.uniform3f(u.uLift, ...g.lift);
      gl.uniform3f(u.uGain, ...g.gain);
      gl.uniform3f(u.uGammaInv, ...g.gammaInv);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  // entries: [{type:'clip', ...layer}] or [{type:'transition', kind, p, a, b}] in bottom-to-top order
  render(entries) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    let pending = false;
    for (const entry of entries) {
      if (entry.type === "clip") { if (!this.drawLayer(entry)) pending = true; continue; }
      const layers = [entry.a, entry.b];
      layers.forEach((layer, i) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[i].fb);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (layer && !this.drawLayer(layer)) pending = true;
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
    return !pending;
  }
}
