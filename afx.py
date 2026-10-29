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
}


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
    """RBJ cookbook coefficients (what Web Audio's BiquadFilterNode uses); shelves with slope 1."""
    w0 = 2 * math.pi * min(f0, sr * 0.499) / sr
    cos, sin = math.cos(w0), math.sin(w0)
    A = 10 ** (gain_db / 40)
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


def _filter(x, kind, f0, sr, gain_db=0.0):
    try:
        from scipy.signal import lfilter
    except Exception:
        return x
    b, a = _biquad(kind, f0, sr, gain_db)
    return lfilter(b, a, x, axis=-1).astype(np.float32)


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


def apply(seg, clip, sr):
    """The clip's switched-on audio effects, in order, on its samples (2, n)."""
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
    return x.astype(np.float32)
