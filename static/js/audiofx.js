// Audio effects on audio clips: reverb, echo, pitch shift, EQ, low cut, high cut and distortion. The viewer builds a
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
};
export const AUDIO_EFFECT_ORDER = ["reverb", "echo", "pitch", "eq", "lowcut", "highcut", "distortion"];

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
`;

// A chain of the clip's switched-on effects: {input, output}. Pitch needs the worklet (skipped until it has loaded).
export function buildChain(ctx, list, { pitchReady = false } = {}) {
  const input = ctx.createGain(), output = ctx.createGain();
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
    } else if (fx.type === "pitch" && pitchReady) {
      const node = new AudioWorkletNode(ctx, "ve-pitch", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { ratio: Math.pow(2, val(fx, "semitones") / 12) } });
      last.connect(node); last = node;
    }
  }
  last.connect(output);
  return { input, output };
}
