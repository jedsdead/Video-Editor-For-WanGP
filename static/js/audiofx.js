// Audio effects on audio clips: reverb, echo, pitch shift, EQ, filters (low/high cut, band pass, notch, parametric,
// auto filter), distortion and modulation (chorus, flanger, phaser, tremolo, vibrato, auto pan, ring mod). The viewer builds a
// Web Audio chain per clip; afx.py runs the same maths on export (same impulse responses, filters and pitch shifter).

export const AUDIO_EFFECTS = {
  reverb: { label: "Reverb", blurb: "Room or hall ambience", params: [
    { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 30, unit: "%" },
    { key: "size", label: "Decay", min: 0.2, max: 8, step: 0.1, def: 1.8, unit: "s" },
    { key: "predelay", label: "Pre-delay", min: 0, max: 200, step: 1, def: 20, unit: "ms" }] },
  echo: { label: "Echo / delay", blurb: "Repeats that fade away", params: [
    { key: "time", label: "Time", min: 20, max: 2000, step: 5, def: 320, unit: "ms" },
    { key: "feedback", label: "Feedback", min: 0, max: 90, step: 1, def: 35, unit: "%" },
    { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 35, unit: "%" }] },
  pitch: { label: "Pitch shift", blurb: "Higher or lower, same speed", params: [
    { key: "semitones", label: "Semitones", min: -12, max: 12, step: 0.1, def: 3, unit: "st" }] },
  eq: { label: "EQ (bass / treble)", blurb: "Shelving bass and treble", params: [
    { key: "bass", label: "Bass", min: -15, max: 15, step: 0.5, def: 0, unit: "dB" },
    { key: "treble", label: "Treble", min: -15, max: 15, step: 0.5, def: 0, unit: "dB" }] },
  lowcut: { label: "Low cut", blurb: "Remove rumble below a frequency", params: [
    { key: "freq", label: "Frequency", min: 20, max: 2000, step: 5, def: 120, unit: "Hz" }] },
  highcut: { label: "High cut", blurb: "Remove hiss above a frequency", params: [
    { key: "freq", label: "Frequency", min: 500, max: 20000, step: 50, def: 6000, unit: "Hz" }] },
  distortion: { label: "Distortion", blurb: "Overdrive and grit", params: [
    { key: "drive", label: "Drive", min: 0, max: 100, step: 1, def: 40, unit: "%" },
    { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 100, unit: "%" }] },
  // filters
  bandpass: { label: "Band pass", blurb: "Keep one band (telephone, radio)", params: [
    { key: "freq", label: "Centre", min: 50, max: 12000, step: 10, def: 1200, unit: "Hz" },
    { key: "q", label: "Width (Q)", min: 0.3, max: 12, step: 0.1, def: 1.2, unit: "" }] },
  notch: { label: "Notch", blurb: "Cut a narrow band (hum, whine)", params: [
    { key: "freq", label: "Centre", min: 30, max: 12000, step: 5, def: 1000, unit: "Hz" },
    { key: "q", label: "Narrowness (Q)", min: 0.5, max: 30, step: 0.1, def: 8, unit: "" }] },
  peak: { label: "Parametric EQ", blurb: "Boost or cut around a frequency", params: [
    { key: "freq", label: "Frequency", min: 40, max: 16000, step: 10, def: 1000, unit: "Hz" },
    { key: "gain", label: "Gain", min: -18, max: 18, step: 0.5, def: 6, unit: "dB" },
    { key: "q", label: "Width (Q)", min: 0.2, max: 10, step: 0.1, def: 1, unit: "" }] },
  autofilter: { label: "Auto filter", blurb: "A low-pass that sweeps up and down (auto-wah)", params: [
    { key: "rate", label: "Rate", min: 0.05, max: 10, step: 0.05, def: 0.5, unit: "Hz" },
    { key: "low", label: "From", min: 50, max: 4000, step: 10, def: 300, unit: "Hz" },
    { key: "high", label: "To", min: 200, max: 16000, step: 50, def: 4000, unit: "Hz" },
    { key: "resonance", label: "Resonance", min: 0, max: 20, step: 0.5, def: 6, unit: "dB" }] },
  // modulation
  chorus: { label: "Chorus", blurb: "Thicker, doubled sound", params: [
    { key: "rate", label: "Rate", min: 0.05, max: 5, step: 0.05, def: 0.8, unit: "Hz" },
    { key: "depth", label: "Depth", min: 0.1, max: 8, step: 0.1, def: 3, unit: "ms" },
    { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 50, unit: "%" }] },
  flanger: { label: "Flanger", blurb: "Sweeping jet-plane whoosh", params: [
    { key: "rate", label: "Rate", min: 0.05, max: 5, step: 0.05, def: 0.25, unit: "Hz" },
    { key: "depth", label: "Depth", min: 0.1, max: 3, step: 0.1, def: 2, unit: "ms" },
    { key: "feedback", label: "Feedback", min: 0, max: 90, step: 1, def: 50, unit: "%" },
    { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 50, unit: "%" }] },
  phaser: { label: "Phaser", blurb: "Swirling, sweeping notches", params: [
    { key: "rate", label: "Rate", min: 0.05, max: 5, step: 0.05, def: 0.4, unit: "Hz" },
    { key: "depth", label: "Depth", min: 0, max: 100, step: 1, def: 70, unit: "%" },
    { key: "freq", label: "Centre", min: 200, max: 4000, step: 10, def: 800, unit: "Hz" },
    { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 50, unit: "%" }] },
  tremolo: { label: "Tremolo", blurb: "Pulsing volume", params: [
    { key: "rate", label: "Rate", min: 0.1, max: 20, step: 0.1, def: 5, unit: "Hz" },
    { key: "depth", label: "Depth", min: 0, max: 100, step: 1, def: 50, unit: "%" }] },
  vibrato: { label: "Vibrato", blurb: "Wavering pitch", params: [
    { key: "rate", label: "Rate", min: 0.1, max: 12, step: 0.1, def: 5, unit: "Hz" },
    { key: "depth", label: "Depth", min: 0.1, max: 5, step: 0.1, def: 1.5, unit: "ms" }] },
  autopan: { label: "Auto pan", blurb: "Sound moving left and right", params: [
    { key: "rate", label: "Rate", min: 0.05, max: 10, step: 0.05, def: 0.5, unit: "Hz" },
    { key: "depth", label: "Width", min: 0, max: 100, step: 1, def: 80, unit: "%" }] },
  ringmod: { label: "Ring modulator", blurb: "Metallic, robotic tone", params: [
    { key: "freq", label: "Frequency", min: 1, max: 2000, step: 1, def: 30, unit: "Hz" },
    { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 50, unit: "%" }] },
  // equaliser and dynamics
  geq: { label: "Graphic EQ", blurb: "Ten-band equaliser, 31 Hz to 16 kHz", params: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((f, i) => (
    { key: `b${i}`, label: f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`, min: -12, max: 12, step: 0.5, def: 0, unit: "dB" })) },
  compressor: { label: "Compressor", blurb: "Evens out loud and quiet parts", params: [
    { key: "threshold", label: "Threshold", min: -60, max: 0, step: 0.5, def: -18, unit: "dB" },
    { key: "ratio", label: "Ratio", min: 1, max: 20, step: 0.1, def: 4, unit: ":1" },
    { key: "attack", label: "Attack", min: 0.5, max: 200, step: 0.5, def: 10, unit: "ms" },
    { key: "release", label: "Release", min: 10, max: 1000, step: 5, def: 150, unit: "ms" },
    { key: "knee", label: "Knee", min: 0, max: 24, step: 0.5, def: 6, unit: "dB" },
    { key: "makeup", label: "Makeup gain", min: 0, max: 24, step: 0.5, def: 0, unit: "dB" }] },
  limiter: { label: "Limiter", blurb: "Stops peaks going over a ceiling", params: [
    { key: "drive", label: "Input gain", min: 0, max: 24, step: 0.5, def: 0, unit: "dB" },
    { key: "ceiling", label: "Ceiling", min: -12, max: 0, step: 0.1, def: -1, unit: "dB" },
    { key: "release", label: "Release", min: 10, max: 500, step: 5, def: 60, unit: "ms" }] },
};
export const GEQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const GEQ_Q = 1.41;
// Effects that run in the editor's audio worklet (loaded on first use)
export const WORKLET_EFFECTS = ["pitch", "compressor", "limiter"];
export const AUDIO_EFFECT_ORDER = ["reverb", "echo", "pitch", "distortion",
  "eq", "geq", "peak", "lowcut", "highcut", "bandpass", "notch", "autofilter",
  "compressor", "limiter",
  "chorus", "flanger", "phaser", "tremolo", "vibrato", "autopan", "ringmod"];
export const AUDIO_EFFECT_GROUPS = [
  ["Sound", ["reverb", "echo", "pitch", "distortion"]],
  ["EQ and filters", ["eq", "geq", "peak", "lowcut", "highcut", "bandpass", "notch", "autofilter"]],
  ["Dynamics", ["compressor", "limiter"]],
  ["Modulation", ["chorus", "flanger", "phaser", "tremolo", "vibrato", "autopan", "ringmod"]],
];
// Modulated delays: the base delay under the swing (the flanger's stays above Web Audio's 128-frame minimum in a loop)
export const MOD_DELAY_BASE = { chorus: 0.020, flanger: 0.006, vibrato: 0.006 };
export const PHASER_STAGES = 4;

export function defaultAudioParams(type) {
  return Object.fromEntries((AUDIO_EFFECTS[type]?.params || []).map(p => [p.key, p.def]));
}
const val = (fx, key) => {
  const p = (AUDIO_EFFECTS[fx.type]?.params || []).find(q => q.key === key);
  const v = Number(fx.params?.[key]);
  return Number.isFinite(v) ? v : p ? p.def : 0;
};

// The reverb's impulse response: decaying noise from a fixed generator (afx.py makes the same one).
export function impulseResponse(sampleRate, size, predelayMs) {
  const length = Math.max(1, Math.round(size * sampleRate));
  const pre = Math.max(0, Math.round(predelayMs / 1000 * sampleRate));
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const data = new Float32Array(pre + length);
    let seed = ch === 0 ? 12345 : 67890;
    let energy = 0;
    for (let n = 0; n < length; n++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const v = (seed / 4294967296) * 2 - 1;
      const s = v * Math.exp(-6.907755 * n / length);
      data[pre + n] = s;
      energy += s * s;
    }
    const k = 1 / Math.sqrt(Math.max(energy, 1e-12));
    for (let n = pre; n < data.length; n++) data[n] *= k;
    out.push(data);
  }
  return out;
}

export function distortionCurve(drive) {
  const k = 1 + drive / 100 * 30;
  const curve = new Float32Array(2048);
  const norm = Math.tanh(k);
  for (let i = 0; i < curve.length; i++) { const x = i / (curve.length - 1) * 2 - 1; curve[i] = Math.tanh(k * x) / norm; }
  return curve;
}

// Pitch shifter: two read taps sweeping a 50 ms window, crossfaded with equal power (afx.py runs the same).
export const PITCH_WORKLET = `
class VePitch extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = options.processorOptions.ratio;
    this.W = Math.max(16, Math.round(0.05 * sampleRate));
    this.size = this.W * 2 + 8;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.pos = 0;
    this.n = 0;
  }
  read(b, at) {
    const i = Math.floor(at), f = at - i, s = this.size;
    const a = b[((i % s) + s) % s], c = b[(((i + 1) % s) + s) % s];
    return a + (c - a) * f;
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    const frames = output[0].length, W = this.W, r = this.ratio;
    for (let k = 0; k < frames; k++) {
      const n = this.n + k;
      let d1 = (n * (1 - r)) % W; if (d1 < 0) d1 += W;
      const d2 = (d1 + W / 2) % W;
      const g1 = Math.sin(Math.PI * d1 / W), g2 = Math.sin(Math.PI * d2 / W);
      const w = (this.pos + k) % this.size;
      for (let ch = 0; ch < output.length; ch++) {
        const src = input[ch] || input[0];
        const b = this.buf[Math.min(ch, 1)];
        b[w] = src ? src[k] : 0;
        output[ch][k] = g1 * this.read(b, this.pos + k - d1) + g2 * this.read(b, this.pos + k - d2);
      }
    }
    this.pos = (this.pos + frames) % this.size;
    this.n += frames;
    return true;
  }
}
registerProcessor("ve-pitch", VePitch);

// Compressor and limiter, in blocks of 32 samples with a stereo-linked peak detector (afx.dynamics runs the same)
class VeDynamics extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.mode = o.mode; this.p = o.params;
    const B = 32;
    this.B = B;
    this.rel = Math.exp(-B / (sampleRate * Math.max(1e-4, o.params.release / 1000)));
    this.att = o.mode === "compressor" ? Math.exp(-B / (sampleRate * Math.max(1e-4, o.params.attack / 1000))) : 0;
    this.drive = o.mode === "compressor" ? 1 : Math.pow(10, o.params.drive / 20);
    this.makeup = o.mode === "compressor" ? o.params.makeup : 0;
    this.gs = 0; this.prev = Math.pow(10, this.makeup / 20);
  }
  knee(level) {
    const { threshold: T, knee: W } = this.p, R = Math.max(1, this.p.ratio), over = level - T;
    if (W > 0 && 2 * Math.abs(over) <= W) return (1 / R - 1) * (over + W / 2) * (over + W / 2) / (2 * W);
    if (2 * over > W) return over / R - over;
    return 0;
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    const frames = output[0].length, B = this.B;
    for (let s0 = 0; s0 < frames; s0 += B) {
      const s1 = Math.min(frames, s0 + B);
      let peak = 0;
      for (let ch = 0; ch < output.length; ch++) {
        const src = input[ch] || input[0];
        if (!src) continue;
        for (let k = s0; k < s1; k++) peak = Math.max(peak, Math.abs(src[k] * this.drive));
      }
      const level = 20 * Math.log10(Math.max(peak, 1e-6));
      let cur, hold = false;
      if (this.mode === "compressor") {
        const gr = this.knee(level), a = gr < this.gs ? this.att : this.rel;
        this.gs = a * this.gs + (1 - a) * gr;
        cur = Math.pow(10, (this.gs + this.makeup) / 20);
      } else {
        const gr = Math.min(0, this.p.ceiling - level);
        this.gs = gr < this.gs ? gr : this.rel * this.gs + (1 - this.rel) * gr;
        cur = Math.pow(10, this.gs / 20);
        hold = cur <= this.prev;
      }
      const n = s1 - s0;
      for (let ch = 0; ch < output.length; ch++) {
        const src = input[ch] || input[0], dst = output[ch];
        for (let k = 0; k < n; k++) {
          const g = hold ? cur : this.prev + (cur - this.prev) * (k + 1) / n;
          dst[s0 + k] = src ? src[s0 + k] * this.drive * g : 0;
        }
      }
      this.prev = cur;
    }
    return true;
  }
}
registerProcessor("ve-dynamics", VeDynamics);
`;
export const WORKLET_MODULE = PITCH_WORKLET;

// A chain of the clip's switched-on effects: {input, output, stop}. Pitch, compressor and limiter need the worklet
// (pitchReady: the module has loaded; skipped until then).
export function buildChain(ctx, list, { pitchReady = false } = {}) {
  const input = ctx.createGain(), output = ctx.createGain();
  const oscs = [];
  // a sine LFO driving `param` around its value by +/- amount
  const lfo = (rate, amount, param) => {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.value = rate; g.gain.value = amount;
    osc.connect(g); g.connect(param); osc.start(); oscs.push(osc);
    return osc;
  };
  let last = input;
  const mixer = (dry, wetNode, mix) => {
    // dry and wet mixed into one node
    const out = ctx.createGain(), d = ctx.createGain(), w = ctx.createGain();
    d.gain.value = 1 - mix; w.gain.value = mix;
    dry.connect(d); wetNode.connect(w); d.connect(out); w.connect(out);
    return out;
  };
  for (const fx of list) {
    if (fx.on === false || !AUDIO_EFFECTS[fx.type]) continue;
    if (fx.type === "lowcut" || fx.type === "highcut") {
      const f = ctx.createBiquadFilter();
      f.type = fx.type === "lowcut" ? "highpass" : "lowpass";
      f.frequency.value = val(fx, "freq");
      f.Q.value = -3.0103;   // dB here: a Butterworth Q of 0.707
      last.connect(f); last = f;
    } else if (fx.type === "eq") {
      const lo = ctx.createBiquadFilter(), hi = ctx.createBiquadFilter();
      lo.type = "lowshelf"; lo.frequency.value = 200; lo.gain.value = val(fx, "bass");
      hi.type = "highshelf"; hi.frequency.value = 4000; hi.gain.value = val(fx, "treble");
      last.connect(lo); lo.connect(hi); last = hi;
    } else if (fx.type === "echo") {
      const delay = ctx.createDelay(2.5), fb = ctx.createGain();
      delay.delayTime.value = val(fx, "time") / 1000;
      fb.gain.value = val(fx, "feedback") / 100;
      last.connect(delay); delay.connect(fb); fb.connect(delay);
      last = mixer(last, delay, val(fx, "mix") / 100);
    } else if (fx.type === "reverb") {
      const conv = ctx.createConvolver();
      conv.normalize = false;
      const ir = impulseResponse(ctx.sampleRate, val(fx, "size"), val(fx, "predelay"));
      const buffer = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
      buffer.copyToChannel(ir[0], 0); buffer.copyToChannel(ir[1], 1);
      conv.buffer = buffer;
      last.connect(conv);
      last = mixer(last, conv, val(fx, "mix") / 100);
    } else if (fx.type === "distortion") {
      const shaper = ctx.createWaveShaper();
      shaper.curve = distortionCurve(val(fx, "drive"));
      last.connect(shaper);
      last = mixer(last, shaper, val(fx, "mix") / 100);
    } else if (fx.type === "bandpass" || fx.type === "notch" || fx.type === "peak") {
      const f = ctx.createBiquadFilter();
      f.type = fx.type === "peak" ? "peaking" : fx.type;
      f.frequency.value = val(fx, "freq"); f.Q.value = val(fx, "q");
      if (fx.type === "peak") f.gain.value = val(fx, "gain");
      last.connect(f); last = f;
    } else if (fx.type === "autofilter") {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      const lo = Math.max(20, Math.min(val(fx, "low"), val(fx, "high"))), hi = Math.max(lo, val(fx, "high"));
      const cents = 1200 * Math.log2(hi / lo);
      f.frequency.value = lo; f.detune.value = cents / 2; f.Q.value = val(fx, "resonance");
      lfo(val(fx, "rate"), cents / 2, f.detune);
      last.connect(f); last = f;
    } else if (fx.type === "chorus" || fx.type === "flanger" || fx.type === "vibrato") {
      const base = MOD_DELAY_BASE[fx.type];
      const delay = ctx.createDelay(0.1);
      delay.delayTime.value = base;
      lfo(val(fx, "rate"), val(fx, "depth") / 1000, delay.delayTime);
      last.connect(delay);
      if (fx.type === "flanger") { const fb = ctx.createGain(); fb.gain.value = val(fx, "feedback") / 100; delay.connect(fb); fb.connect(delay); }
      last = fx.type === "vibrato" ? delay : mixer(last, delay, val(fx, "mix") / 100);
    } else if (fx.type === "phaser") {
      let node = last;
      const octaves = 2 * val(fx, "depth") / 100;
      for (let k = 0; k < PHASER_STAGES; k++) {
        const ap = ctx.createBiquadFilter();
        ap.type = "allpass"; ap.frequency.value = val(fx, "freq"); ap.Q.value = 0.7;
        lfo(val(fx, "rate"), 1200 * octaves, ap.detune);
        node.connect(ap); node = ap;
      }
      last = mixer(last, node, val(fx, "mix") / 100);
    } else if (fx.type === "tremolo") {
      const g = ctx.createGain(), depth = val(fx, "depth") / 100;
      g.gain.value = 1 - depth / 2;
      lfo(val(fx, "rate"), depth / 2, g.gain);
      last.connect(g); last = g;
    } else if (fx.type === "autopan") {
      const pan = ctx.createStereoPanner();
      pan.pan.value = 0;
      lfo(val(fx, "rate"), val(fx, "depth") / 100, pan.pan);
      last.connect(pan); last = pan;
    } else if (fx.type === "geq") {
      GEQ_BANDS.forEach((f, i) => {
        const g = val(fx, `b${i}`);
        if (Math.abs(g) < 1e-6) return;
        const b = ctx.createBiquadFilter();
        b.type = "peaking"; b.frequency.value = f; b.Q.value = GEQ_Q; b.gain.value = g;
        last.connect(b); last = b;
      });
    } else if ((fx.type === "compressor" || fx.type === "limiter") && pitchReady) {
      const params = Object.fromEntries(AUDIO_EFFECTS[fx.type].params.map(p => [p.key, val(fx, p.key)]));
      const node = new AudioWorkletNode(ctx, "ve-dynamics", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { mode: fx.type, params } });
      last.connect(node); last = node;
    } else if (fx.type === "ringmod") {
      const ring = ctx.createGain();
      ring.gain.value = 0;
      lfo(val(fx, "freq"), 1, ring.gain);
      last.connect(ring);
      last = mixer(last, ring, val(fx, "mix") / 100);
    } else if (fx.type === "pitch" && pitchReady) {
      const node = new AudioWorkletNode(ctx, "ve-pitch", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { ratio: Math.pow(2, val(fx, "semitones") / 12) } });
      last.connect(node); last = node;
    }
  }
  last.connect(output);
  // LFOs run until stopped: stop() when the chain is replaced
  return { input, output, stop: () => { for (const o of oscs) { try { o.stop(); o.disconnect(); } catch (_) { /* stopped */ } } } };
}
