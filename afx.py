"""Audio effects on export: the same maths as static/js/audiofx.js (the viewer's Web Audio chain).

Each function takes and returns stereo float32 samples (2, n) at `sr`."""

import math

import numpy as np

DEFAULTS = {
    "reverb": {"mix": 30, "size": 1.8, "predelay": 20},
    "echo": {"time": 320, "feedback": 35, "mix": 35},
    "pitch": {"semitones": 3},
    "eq": {"bass": 0, "treble": 0},
    "lowcut": {"freq": 120},
    "highcut": {"freq": 6000},
    "distortion": {"drive": 40, "mix": 100},
    "bandpass": {"freq": 1200, "q": 1.2},
    "notch": {"freq": 1000, "q": 8},
    "peak": {"freq": 1000, "gain": 6, "q": 1},
    "autofilter": {"rate": 0.5, "low": 300, "high": 4000, "resonance": 6},
    "chorus": {"rate": 0.8, "depth": 3, "mix": 50},
    "flanger": {"rate": 0.25, "depth": 2, "feedback": 50, "mix": 50},
    "phaser": {"rate": 0.4, "depth": 70, "freq": 800, "mix": 50},
    "tremolo": {"rate": 5, "depth": 50},
    "vibrato": {"rate": 5, "depth": 1.5},
    "autopan": {"rate": 0.5, "depth": 80},
    "ringmod": {"freq": 30, "mix": 50},
    "geq": {f"b{i}": 0 for i in range(10)},
    "compressor": {"threshold": -18, "ratio": 4, "attack": 10, "release": 150, "knee": 6, "makeup": 0},
    "limiter": {"drive": 0, "ceiling": -1, "release": 60},
}
GEQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]   # as audiofx.js
GEQ_Q = 1.41
DYN_BLOCK = 32   # the compressor and limiter work in blocks of 32 samples (the viewer's worklet does the same)
FEEDBACK_LATENCY = 128   # Web Audio puts one render quantum into a feedback loop; the flanger matches it
MOD_DELAY_BASE = {"chorus": 0.020, "flanger": 0.006, "vibrato": 0.006}   # as audiofx.js
PHASER_STAGES = 4
BLOCK = 128   # time-varying filters update their coefficients once per block (Web Audio's render quantum)


def _val(fx, key):
    try:
        v = float((fx.get("params") or {}).get(key))
        if math.isfinite(v):
            return v
    except (TypeError, ValueError):
        pass
    return float(DEFAULTS.get(fx.get("type"), {}).get(key, 0))


def active(clip):
    return [fx for fx in (clip.get("afx") or []) if fx.get("on", True) and fx.get("type") in DEFAULTS]


def impulse_response(sr, size, predelay_ms):
    """Decaying noise from the same generator as the viewer's, energy-normalised per channel."""
    length = max(1, int(round(size * sr)))
    pre = max(0, int(round(predelay_ms / 1000.0 * sr)))
    out = []
    for seed in (12345, 67890):
        # the viewer's LCG, s -> (s * a + c) mod 2^32, one block of 4096 by hand and then jumped ahead a block at a time
        a, c, m = 1664525, 1013904223, 1 << 32
        block = 4096
        first = np.empty(block, dtype=np.uint64)
        s = seed
        for n in range(block):
            s = (s * a + c) % m
            first[n] = s
        A, C = 1, 0
        for _ in range(block):
            A, C = (A * a) % m, (C * a + c) % m
        blocks = [first]
        while len(blocks) * block < length:
            blocks.append((np.uint64(A) * blocks[-1] + np.uint64(C)) % np.uint64(m))
        seeds = np.concatenate(blocks)[:length]
        v = seeds.astype(np.float64) / 4294967296.0 * 2 - 1
        env = np.exp(-6.907755 * np.arange(length) / length)
        data = v * env
        data /= math.sqrt(max(float((data * data).sum()), 1e-12))
        out.append(np.concatenate([np.zeros(pre), data]))
    return out


_IR_CACHE = {}


def _biquad(kind, f0, sr, gain_db=0.0, q=0.7071067811865476):
    """RBJ cookbook coefficients (what Web Audio's BiquadFilterNode uses); shelves with slope 1. q is linear (Web
    Audio's low/high-pass Q is in dB: pass 10 ** (dB / 20))."""
    w0 = 2 * math.pi * min(max(f0, 1.0), sr * 0.499) / sr
    cos, sin = math.cos(w0), math.sin(w0)
    A = 10 ** (gain_db / 40)
    if kind in ("bandpass", "notch", "peaking", "allpass"):
        alpha = sin / (2 * max(q, 1e-4))
        if kind == "bandpass":
            b, a = [alpha, 0.0, -alpha], [1 + alpha, -2 * cos, 1 - alpha]
        elif kind == "notch":
            b, a = [1.0, -2 * cos, 1.0], [1 + alpha, -2 * cos, 1 - alpha]
        elif kind == "allpass":
            b, a = [1 - alpha, -2 * cos, 1 + alpha], [1 + alpha, -2 * cos, 1 - alpha]
        else:
            b, a = [1 + alpha * A, -2 * cos, 1 - alpha * A], [1 + alpha / A, -2 * cos, 1 - alpha / A]
        return np.array(b) / a[0], np.array(a) / a[0]
    if kind in ("lowpass", "highpass"):
        alpha = sin / (2 * q)
        if kind == "lowpass":
            b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
        else:
            b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
        a = [1 + alpha, -2 * cos, 1 - alpha]
    else:
        alpha = sin / 2 * math.sqrt(2)
        sq = 2 * math.sqrt(A) * alpha
        if kind == "lowshelf":
            b = [A * ((A + 1) - (A - 1) * cos + sq), 2 * A * ((A - 1) - (A + 1) * cos), A * ((A + 1) - (A - 1) * cos - sq)]
            a = [(A + 1) + (A - 1) * cos + sq, -2 * ((A - 1) + (A + 1) * cos), (A + 1) + (A - 1) * cos - sq]
        else:
            b = [A * ((A + 1) + (A - 1) * cos + sq), -2 * A * ((A - 1) + (A + 1) * cos), A * ((A + 1) + (A - 1) * cos - sq)]
            a = [(A + 1) - (A - 1) * cos + sq, 2 * ((A - 1) - (A + 1) * cos), (A + 1) - (A - 1) * cos - sq]
    return np.array(b) / a[0], np.array(a) / a[0]


def _filter(x, kind, f0, sr, gain_db=0.0, q=0.7071067811865476):
    try:
        from scipy.signal import lfilter
    except Exception:
        return x
    b, a = _biquad(kind, f0, sr, gain_db, q)
    return lfilter(b, a, x, axis=-1).astype(np.float32)


def _lfo(n, rate, sr, t0):
    """sin(2 pi rate t) for each sample, t counted from the clip's start."""
    return np.sin(2 * np.pi * rate * (t0 + np.arange(n, dtype=np.float64) / sr))


def _varying_filter(x, kind, freqs_per_block, sr, q, stages=1):
    """A biquad (or a chain of `stages`) whose frequency changes every BLOCK samples, its state carried across."""
    try:
        from scipy.signal import lfilter, lfilter_zi
    except Exception:
        return x
    out = x.astype(np.float64).copy()
    for _ in range(stages):
        zi = None
        y = np.empty_like(out)
        for k, f in enumerate(freqs_per_block):
            s0, s1 = k * BLOCK, min(out.shape[1], (k + 1) * BLOCK)
            if s0 >= s1:
                break
            b, a = _biquad(kind, float(f), sr, 0.0, q)
            if zi is None:
                zi = np.zeros((out.shape[0], 2))
            y[:, s0:s1], zi = lfilter(b, a, out[:, s0:s1], axis=-1, zi=zi)
        out = y
    return out.astype(np.float32)


def _block_values(curve):
    """One value per BLOCK (its middle sample) of a per-sample curve."""
    mids = np.arange(BLOCK // 2, curve.shape[0] + BLOCK // 2, BLOCK)
    return curve[np.minimum(mids, curve.shape[0] - 1)]


def _read(buf, pos):
    """buf (channels, n) read at fractional positions pos (n,), zero outside, linear interpolation."""
    i = np.floor(pos).astype(np.int64)
    f = pos - i
    n = buf.shape[1]
    ok0, ok1 = (i >= 0) & (i < n), (i + 1 >= 0) & (i + 1 < n)
    a = np.where(ok0, buf[:, np.clip(i, 0, n - 1)], 0.0)
    b = np.where(ok1, buf[:, np.clip(i + 1, 0, n - 1)], 0.0)
    return a + (b - a) * f


def _mod_delay(x, base, depth_s, rate, sr, t0, feedback=0.0):
    """A delay line swung by a sine LFO (chorus, flanger, vibrato); with feedback, as the viewer's delay -> gain loop:
    w = x + fb * v[n - 128], v[n] = w[n - D(n)] (Web Audio delays a loop by a render quantum). Blocks no longer than
    the shortest delay keep it vectorised."""
    n = x.shape[1]
    delay = (base + depth_s * _lfo(n, rate, sr, t0)) * sr
    pos = np.arange(n, dtype=np.float64) - delay
    if not feedback:
        return _read(x.astype(np.float64), pos).astype(np.float32)
    # each block reads only samples of w already final: positions up to (block end - shortest delay) + 1
    step = max(1, min(BLOCK, FEEDBACK_LATENCY, int(np.floor(delay.min())) - 1))
    w = x.astype(np.float64).copy()
    v = np.zeros_like(w)
    for s0 in range(0, n, step):
        s1 = min(n, s0 + step)
        v[:, s0:s1] = _read(w, pos[s0:s1])
        back = np.arange(s0, s1) - FEEDBACK_LATENCY
        ok = back >= 0
        if ok.any():
            w[:, s0:s1][:, ok] = x[:, s0:s1][:, ok] + feedback * v[:, back[ok]]
    return v.astype(np.float32)


def _knee_gain(level, threshold, ratio, knee):
    """Gain change in dB of a soft-knee compressor for an input level in dB."""
    over = level - threshold
    if knee > 0 and 2 * abs(over) <= knee:
        return (1 / ratio - 1) * (over + knee / 2) ** 2 / (2 * knee)
    if 2 * over > knee:
        return over / ratio - over
    return 0.0


def dynamics(x, sr, mode, p):
    """Compressor / limiter, block by block (DYN_BLOCK samples, stereo-linked peak detector), exactly as the viewer's
    worklet. Compressor: soft-knee gain computer, attack and release smoothing of the gain in dB, makeup. Limiter:
    drive, instant attack to the ceiling, smooth release."""
    n = x.shape[1]
    out = np.empty_like(x, dtype=np.float32)
    B = DYN_BLOCK
    rel = math.exp(-B / (sr * max(1e-4, p["release"] / 1000.0)))
    if mode == "compressor":
        att = math.exp(-B / (sr * max(1e-4, p["attack"] / 1000.0)))
        drive, makeup = 1.0, p["makeup"]
    else:
        drive, makeup = 10 ** (p["drive"] / 20), 0.0
    src = x.astype(np.float64) * drive
    g_s, prev = 0.0, 10 ** (makeup / 20)
    for s0 in range(0, n, B):
        s1 = min(n, s0 + B)
        blk = src[:, s0:s1]
        peak = float(np.abs(blk).max()) if blk.size else 0.0
        level = 20 * math.log10(max(peak, 1e-6))
        if mode == "compressor":
            gr = _knee_gain(level, p["threshold"], max(1.0, p["ratio"]), max(0.0, p["knee"]))
            a = att if gr < g_s else rel
            g_s = a * g_s + (1 - a) * gr
            cur = 10 ** ((g_s + makeup) / 20)
            ramp = prev + (cur - prev) * (np.arange(1, s1 - s0 + 1) / (s1 - s0))
        else:
            gr = min(0.0, p["ceiling"] - level)
            g_s = gr if gr < g_s else rel * g_s + (1 - rel) * gr
            cur = 10 ** (g_s / 20)
            ramp = np.full(s1 - s0, cur) if cur <= prev else prev + (cur - prev) * (np.arange(1, s1 - s0 + 1) / (s1 - s0))
        out[:, s0:s1] = blk * ramp
        prev = cur
    return out


def _stereo_pan(x, pan):
    """Web Audio StereoPannerNode on stereo input, with a per-sample pan in [-1, 1]."""
    L, R = x[0].astype(np.float64), x[min(1, x.shape[0] - 1)].astype(np.float64)
    p = np.clip(pan, -1, 1)
    left = p <= 0
    xg = np.where(left, p + 1, p) * np.pi / 2
    gl, gr = np.cos(xg), np.sin(xg)
    outL = np.where(left, L + R * gl, L * gl)
    outR = np.where(left, R * gr, R + L * gr)
    return np.stack([outL, outR]).astype(np.float32)


def _convolve(x, ir):
    try:
        from scipy.signal import fftconvolve
        return fftconvolve(x, ir)[: x.shape[0]]
    except Exception:
        n = x.shape[0] + ir.shape[0] - 1
        size = 1 << (n - 1).bit_length()
        return np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[: x.shape[0]]


def _pitch(x, ratio, sr):
    """Two read taps sweeping a 50 ms window, crossfaded with equal power, as the viewer's worklet."""
    W = max(16, int(round(0.05 * sr)))
    n = np.arange(x.shape[1], dtype=np.float64)
    d1 = np.mod(n * (1 - ratio), W)
    d2 = np.mod(d1 + W / 2, W)
    g1, g2 = np.sin(np.pi * d1 / W), np.sin(np.pi * d2 / W)

    def tap(ch, d):
        at = n - d
        i = np.floor(at).astype(np.int64)
        f = at - i
        def get(idx):
            ok = (idx >= 0) & (idx < ch.shape[0])
            return np.where(ok, ch[np.clip(idx, 0, ch.shape[0] - 1)], 0.0)
        a, b = get(i), get(i + 1)
        return a + (b - a) * f

    return np.stack([g1 * tap(x[c], d1) + g2 * tap(x[c], d2) for c in range(x.shape[0])]).astype(np.float32)


def apply(seg, clip, sr, t0=0.0):
    """The clip's switched-on audio effects, in order, on its samples (2, n). t0: seconds into the clip at the first
    sample (the phase of modulation effects' LFOs)."""
    fxs = active(clip)
    if not fxs or seg.shape[1] == 0:
        return seg
    x = seg.astype(np.float32)
    for fx in fxs:
        kind = fx["type"]
        if kind == "lowcut":
            x = _filter(x, "highpass", _val(fx, "freq"), sr)
        elif kind == "highcut":
            x = _filter(x, "lowpass", _val(fx, "freq"), sr)
        elif kind == "eq":
            x = _filter(x, "lowshelf", 200.0, sr, _val(fx, "bass"))
            x = _filter(x, "highshelf", 4000.0, sr, _val(fx, "treble"))
        elif kind == "echo":
            D = max(1, int(round(_val(fx, "time") / 1000.0 * sr)))
            fb, mix = _val(fx, "feedback") / 100.0, _val(fx, "mix") / 100.0
            wet = np.zeros_like(x)
            k, coef = 1, 1.0
            while k * D < x.shape[1] and coef >= 1e-4:
                wet[:, k * D:] += coef * x[:, : x.shape[1] - k * D]
                k += 1
                coef *= fb
            x = x * (1 - mix) + wet * mix
        elif kind == "reverb":
            key = (sr, round(_val(fx, "size"), 3), round(_val(fx, "predelay"), 1))
            if key not in _IR_CACHE:
                _IR_CACHE.clear()
                _IR_CACHE[key] = impulse_response(sr, key[1], key[2])
            ir = _IR_CACHE[key]
            mix = _val(fx, "mix") / 100.0
            wet = np.stack([_convolve(x[c], ir[min(c, 1)]) for c in range(x.shape[0])]).astype(np.float32)
            x = x * (1 - mix) + wet * mix
        elif kind == "distortion":
            k = 1 + _val(fx, "drive") / 100.0 * 30
            mix = _val(fx, "mix") / 100.0
            x = x * (1 - mix) + (np.tanh(k * np.clip(x, -1, 1)) / math.tanh(k)) * mix
        elif kind == "pitch":
            ratio = 2 ** (_val(fx, "semitones") / 12.0)
            if abs(ratio - 1) > 1e-4:
                x = _pitch(x, ratio, sr)
        elif kind in ("bandpass", "notch", "peak"):
            x = _filter(x, "peaking" if kind == "peak" else kind, _val(fx, "freq"), sr,
                        _val(fx, "gain") if kind == "peak" else 0.0, _val(fx, "q"))
        elif kind == "autofilter":
            lo = max(20.0, min(_val(fx, "low"), _val(fx, "high")))
            hi = max(lo, _val(fx, "high"))
            octaves = math.log2(hi / lo)
            freqs = lo * 2 ** (octaves / 2 * (1 + _lfo(x.shape[1], _val(fx, "rate"), sr, t0)))
            x = _varying_filter(x, "lowpass", _block_values(freqs), sr, 10 ** (_val(fx, "resonance") / 20))
        elif kind in ("chorus", "flanger", "vibrato"):
            wet = _mod_delay(x, MOD_DELAY_BASE[kind], _val(fx, "depth") / 1000.0, _val(fx, "rate"), sr, t0,
                             _val(fx, "feedback") / 100.0 if kind == "flanger" else 0.0)
            mix = 1.0 if kind == "vibrato" else _val(fx, "mix") / 100.0
            x = x * (1 - mix) + wet * mix
        elif kind == "phaser":
            octaves = 2 * _val(fx, "depth") / 100.0
            freqs = _val(fx, "freq") * 2 ** (octaves * _lfo(x.shape[1], _val(fx, "rate"), sr, t0))
            wet = _varying_filter(x, "allpass", _block_values(freqs), sr, 0.7, PHASER_STAGES)
            mix = _val(fx, "mix") / 100.0
            x = x * (1 - mix) + wet * mix
        elif kind == "tremolo":
            depth = _val(fx, "depth") / 100.0
            x = (x * (1 - depth / 2 + depth / 2 * _lfo(x.shape[1], _val(fx, "rate"), sr, t0))).astype(np.float32)
        elif kind == "autopan":
            x = _stereo_pan(x, _val(fx, "depth") / 100.0 * _lfo(x.shape[1], _val(fx, "rate"), sr, t0))
        elif kind == "geq":
            for i, f in enumerate(GEQ_BANDS):
                g = _val(fx, f"b{i}")
                if abs(g) > 1e-6:
                    x = _filter(x, "peaking", f, sr, g, GEQ_Q)
        elif kind in ("compressor", "limiter"):
            x = dynamics(x, sr, kind, {k: _val(fx, k) for k in DEFAULTS[kind]})
        elif kind == "ringmod":
            mix = _val(fx, "mix") / 100.0
            x = x * (1 - mix) + x * _lfo(x.shape[1], _val(fx, "freq"), sr, t0) * mix
    return x.astype(np.float32)
