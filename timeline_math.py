"""Timeline maths shared by the export engine. static/js/model.js and static/js/grade.js implement the same formulas
for the live preview, so what you see in the editor is what the export renders."""

import math

import numpy as np

WHEEL_RED_ANGLE = math.radians(104.0)
LIFT_RANGE, GAMMA_RANGE, GAIN_RANGE = 0.25, 0.5, 0.5
ZONE_COLOR, ZONE_BRIGHT = 0.25, 0.5
ZONES = ("master", "shadows", "mids", "highs")

VIDEO_TRANSITIONS = ("dissolve", "wipe", "slide", "iris", "clock", "blinds", "barn")
AUDIO_TRANSITIONS = ("a_power", "a_linear", "a_dip")
MAX_BORDER = 0.5


def hex_to_rgb(value):
    text = str(value or "#ffffff").lstrip("#")
    try:
        v = int(text, 16) if len(text) == 6 else 0xFFFFFF
    except ValueError:
        v = 0xFFFFFF
    return ((v >> 16 & 255) / 255.0, (v >> 8 & 255) / 255.0, (v & 255) / 255.0)


# --------------------------------------------------------------------------- keyframes (mirrors static/js/keys.js)

def curve(name, x):
    """Ease curve 0..1 -> 0..1. Works on floats and numpy arrays."""
    x = np.clip(x, 0.0, 1.0)
    if name == "ease_in":
        return x * x
    if name == "ease_out":
        return 2 * x - x * x
    if name == "s_curve":
        return 3 * x * x - 2 * x ** 3
    if name == "slow":
        return x ** 3
    if name == "fast":
        return 1 - (1 - x) ** 3
    if name == "hold":
        return np.where(x >= 1, 1.0, 0.0) if isinstance(x, np.ndarray) else (1.0 if x >= 1 else 0.0)
    return x


def _curve_int(name, u):
    u = np.clip(u, 0.0, 1.0)
    if name == "ease_in":
        return u ** 3 / 3
    if name == "ease_out":
        return u * u - u ** 3 / 3
    if name == "s_curve":
        return u ** 3 - u ** 4 / 2
    if name == "slow":
        return u ** 4 / 4
    if name == "fast":
        return u - (1 - (1 - u) ** 4) / 4
    if name == "hold":
        return u * 0.0
    return u * u / 2


def _sorted_keys(keys):
    return sorted(keys or [], key=lambda k: float(k["t"]))


def _seg_value(k0, k1, x):
    r0, r1 = (k0.get("r") or (0.0, 1.0))
    e = k0.get("ease") or "linear"
    d = float(curve(e, r1)) - float(curve(e, r0))
    if abs(d) < 1e-12:
        return x * 0.0 + float(k0["v"])
    return float(k0["v"]) + (float(k1["v"]) - float(k0["v"])) * (curve(e, r0 + x * (r1 - r0)) - float(curve(e, r0))) / d


def _seg_integral(k0, k1, u):
    r0, r1 = (k0.get("r") or (0.0, 1.0))
    e = k0.get("ease") or "linear"
    w = r1 - r0
    d = float(curve(e, r1)) - float(curve(e, r0))
    v0, v1 = float(k0["v"]), float(k1["v"])
    if abs(d) < 1e-12 or w < 1e-9:
        return v0 * u
    return v0 * u + (v1 - v0) / d * ((_curve_int(e, r0 + u * w) - float(_curve_int(e, r0))) / w - float(curve(e, r0)) * u)


def key_values(keys, t, fallback=0.0):
    """Keyframed value at time(s) t (seconds from the clip start); fallback when there are no keys."""
    ks = _sorted_keys(keys)
    scalar = not isinstance(t, np.ndarray)
    t = np.asarray(t, dtype=np.float64)
    if not ks:
        out = np.full(t.shape, float(fallback))
        return float(out) if scalar else out
    out = np.full(t.shape, float(ks[0]["v"]))
    out = np.where(t >= float(ks[-1]["t"]), float(ks[-1]["v"]), out)
    for a, b in zip(ks, ks[1:]):
        ta, tb = float(a["t"]), float(b["t"])
        if tb - ta < 1e-9:
            continue
        mask = (t >= ta) & (t < tb)
        if mask.any():
            out = np.where(mask, _seg_value(a, b, (t - ta) / (tb - ta)), out)
    return float(out) if scalar else out


def key_integral(keys, t):
    """Integral of the keyed value from 0 to t (constant before the first key and after the last)."""
    ks = _sorted_keys(keys)
    scalar = not isinstance(t, np.ndarray)
    t = np.asarray(t, dtype=np.float64)
    first, last = ks[0], ks[-1]
    out = float(first["v"]) * np.minimum(t, max(0.0, float(first["t"])))
    acc_t = max(0.0, float(first["t"]))
    for a, b in zip(ks, ks[1:]):
        ta, tb = float(a["t"]), float(b["t"])
        length = tb - ta
        if length <= 1e-9:
            continue
        s0 = max(acc_t, ta)
        u0 = (s0 - ta) / length
        u = np.clip((t - ta) / length, u0, 1.0)
        out = out + np.where(t > s0, length * (_seg_integral(a, b, u) - _seg_integral(a, b, u0)), 0.0)
        acc_t = max(acc_t, tb)
    out = out + np.where(t > acc_t, float(last["v"]) * (t - acc_t), 0.0)
    return float(out) if scalar else out


def is_still(kind):
    return kind in ("image", "title", "solid", "gradient", "adjust")


def keys_of(clip, name):
    return ((clip.get("keys") or {}).get(name)) or []


def has_speed_keys(clip, media_kind=None):
    return not is_still(media_kind) and bool(keys_of(clip, "speed"))


def prop(clip, name, tau, fallback):
    static = clip.get(name)
    return key_values(keys_of(clip, name), tau, fallback if static is None else static)


def clip_speeds(clip):
    s = max(0.01, float(clip.get("speed") or 1.0))
    return s, s


def clip_duration(clip, media_kind=None):
    length = max(0.0, float(clip["out"]) - float(clip["in"]))
    if is_still(media_kind):
        return length
    if has_speed_keys(clip, media_kind):
        return max(0.0, float(clip.get("dur") or 0.0))
    return length / clip_speeds(clip)[0]


def consumed(clip, tau, media_kind=None):
    """Source seconds used from the clip start to clip time(s) tau (the integral of speed)."""
    if has_speed_keys(clip, media_kind):
        return key_integral(keys_of(clip, "speed"), tau)
    return clip_speeds(clip)[0] * tau


def level_at(clip, tau, media_kind=None):
    """Join-match gains [r, g, b] for the frame a clip shows at clip time tau, or None (see compose.join_match)."""
    level = clip.get("level") or {}
    if not level or level.get("on") is False or level.get("mediaId") != clip.get("mediaId") or is_still(media_kind):
        return None
    src = float(source_time(clip, tau, media_kind))
    for part in (level.get("open"), level.get("close")):
        gains = (part or {}).get("gains")
        if not gains:
            continue
        i = int(round((src - float(part["src0"])) * float(part.get("fps") or 24)))
        if 0 <= i < len(gains):
            return gains[i]
    return None


def source_time(clip, tau, media_kind=None):
    """Source media time for clip-local time(s) tau. Speed keyframes integrate exactly; reversed clips run out -> in."""
    if is_still(media_kind):
        return tau * 0.0 if isinstance(tau, np.ndarray) else 0.0
    used = consumed(clip, tau, media_kind)
    if clip.get("reverse"):
        return float(clip["out"]) - used
    return float(clip["in"]) + used


def speed_at(clip, tau, media_kind=None):
    if has_speed_keys(clip, media_kind):
        return key_values(keys_of(clip, "speed"), tau)
    return clip_speeds(clip)[0]


def fade_factor(clip, tau, duration):
    """Fade multiplier at clip time(s) tau, using the fade-in / fade-out curve shapes."""
    factor = np.ones_like(np.asarray(tau, dtype=np.float64))
    fade_in, fade_out = float(clip.get("fadeIn") or 0), float(clip.get("fadeOut") or 0)
    tau_arr = np.asarray(tau, dtype=np.float64)
    if fade_in > 0:
        factor = factor * np.where(tau_arr < fade_in, curve(clip.get("fadeInCurve") or "linear", tau_arr / fade_in), 1.0)
    if fade_out > 0:
        factor = factor * np.where(tau_arr > duration - fade_out, curve(clip.get("fadeOutCurve") or "linear", (duration - tau_arr) / fade_out), 1.0)
    return float(factor) if not isinstance(tau, np.ndarray) else factor


def audio_transition_gains(kind, p):
    p = min(1.0, max(0.0, p))
    if kind == "a_linear":
        return 1.0 - p, p
    if kind == "a_dip":
        return (max(0.0, 1.0 - 2.0 * p), max(0.0, 2.0 * p - 1.0))
    return math.cos(p * math.pi / 2.0), math.sin(p * math.pi / 2.0)


def db_to_gain(db):
    if isinstance(db, np.ndarray):
        return np.where(db <= -60, 0.0, 10.0 ** (db / 20.0))
    db = float(db or 0)
    return 0.0 if db <= -60 else 10.0 ** (db / 20.0)


def _wheel(wheel, scale):
    wheel = wheel or {}
    x, y = float(wheel.get("x") or 0), float(wheel.get("y") or 0)
    magnitude = min(1.0, math.hypot(x, y))
    if magnitude < 1e-6:
        return [0.0, 0.0, 0.0], float(wheel.get("master") or 0)
    h = math.atan2(y, x) - WHEEL_RED_ANGLE
    direction = [math.cos(h), math.cos(h - 2 * math.pi / 3), math.cos(h + 2 * math.pi / 3)]
    return [scale * magnitude * d for d in direction], float(wheel.get("master") or 0)


def grade_params(grade):
    """Uniform values for the grading formula, or None when the grade is neutral."""
    if not grade or grade.get("enabled") is False:
        return None
    lift_d, lift_m = _wheel(grade.get("lift"), LIFT_RANGE)
    gamma_d, gamma_m = _wheel(grade.get("gamma"), GAMMA_RANGE)
    gain_d, gain_m = _wheel(grade.get("gain"), GAIN_RANGE)
    temperature, tint = float(grade.get("temperature") or 0), float(grade.get("tint") or 0)
    # white balance (Colour panel: Auto, or picked from something neutral): per-channel gains before everything else
    wbg = [float(v) for v in (grade.get("wbGain") or [1, 1, 1])][:3] if grade.get("wbOn") is not False else [1.0, 1.0, 1.0]
    params = {
        "exposure": 2.0 ** float(grade.get("exposure") or 0),
        "wb": [(1.0 + 0.2 * temperature) * wbg[0], (1.0 - 0.2 * tint) * wbg[1], (1.0 - 0.2 * temperature) * wbg[2]],
        "lift": [lift_m + d for d in lift_d],
        "gain": [1.0 + gain_m + d for d in gain_d],
        "gamma": [max(0.05, 1.0 + gamma_m + d) for d in gamma_d],
        "contrast": 1.0 + float(grade.get("contrast") or 0),
        "saturation": float(grade.get("saturation") if grade.get("saturation") is not None else 1.0),
    }
    params["style"] = 1 if grade.get("style") == "zones" else 0
    zones_neutral = True
    if params["style"] == 1:
        offsets, sats = [], []
        for z in ZONES:
            zone = grade.get(z) or {}
            d, _ = _wheel(zone, ZONE_COLOR)
            offsets.append([v + ZONE_BRIGHT * float(zone.get("bright") or 0) for v in d])
            sats.append(max(0.0, float(zone.get("sat") if zone.get("sat") is not None else 1.0)))
        lo = min(0.96, max(0.02, float(grade.get("zoneLow") if grade.get("zoneLow") is not None else 0.33)))
        hi = min(0.98, max(lo + 0.02, float(grade.get("zoneHigh") if grade.get("zoneHigh") is not None else 0.67)))
        params.update(zone_off=offsets, zone_sat=sats, zone_lo=lo, zone_hi=hi, lift=[0.0] * 3, gain=[1.0] * 3, gamma=[1.0] * 3)
        zones_neutral = all(abs(v) < 1e-6 for o in offsets for v in o) and all(abs(v - 1) < 1e-6 for v in sats)
    neutral = (abs(params["exposure"] - 1) < 1e-6 and all(abs(v - 1) < 1e-6 for v in params["wb"] + params["gain"] + params["gamma"])
               and all(abs(v) < 1e-6 for v in params["lift"]) and abs(params["contrast"] - 1) < 1e-6 and abs(params["saturation"] - 1) < 1e-6
               and zones_neutral)
    curves = bake_curves(grade)
    if curves:
        params["curves"] = curves
    return None if neutral and not curves else params


# --------------------------------------------------------------------------- curves (mirrors grade.js)
# grade.curves = {name: [[x, y], ...]} in 0..1. RGB curves (master, r, g, b) map a channel; the hue curves are periodic
# with y = 0.5 neutral: hueHue shifts hue by (y - 0.5) turns, hueSat / hueLum / lumSat multiply by 2y; satSat maps
# saturation. Each is baked to CURVE_N samples (monotone cubic through the points) and looked up with linear
# interpolation, by the shader and by the export alike.
CURVE_N = 256
CURVE_ROWS = ("master", "r", "g", "b", "hueHue", "hueSat", "hueLum", "lumSat", "satSat")
PERIODIC = ("hueHue", "hueSat", "hueLum")
IDENTITY = ("master", "r", "g", "b", "satSat")


def _monotone(xs, ys, t):
    """Fritsch-Carlson monotone cubic through (xs, ys), at t (clamped to the ends)."""
    n = len(xs)
    if n == 1:
        return ys[0]
    if t <= xs[0]:
        return ys[0]
    if t >= xs[-1]:
        return ys[-1]
    d = [(ys[i + 1] - ys[i]) / max(1e-9, xs[i + 1] - xs[i]) for i in range(n - 1)]
    m = [d[0]] + [0.0 if d[i - 1] * d[i] <= 0 else (d[i - 1] + d[i]) / 2 for i in range(1, n - 1)] + [d[-1]]
    for i in range(n - 1):
        if abs(d[i]) < 1e-12:
            m[i] = m[i + 1] = 0.0
            continue
        a, b = m[i] / d[i], m[i + 1] / d[i]
        h = a * a + b * b
        if h > 9:
            k = 3 / math.sqrt(h)
            m[i], m[i + 1] = k * a * d[i], k * b * d[i]
    i = 0
    while i < n - 2 and t > xs[i + 1]:
        i += 1
    hgt = xs[i + 1] - xs[i]
    u = (t - xs[i]) / max(1e-9, hgt)
    h00, h10, h01, h11 = 2 * u ** 3 - 3 * u ** 2 + 1, u ** 3 - 2 * u ** 2 + u, -2 * u ** 3 + 3 * u ** 2, u ** 3 - u ** 2
    return h00 * ys[i] + h10 * hgt * m[i] + h01 * ys[i + 1] + h11 * hgt * m[i + 1]


def curve_points(curves, name):
    pts = (curves or {}).get(name) or []
    pts = sorted(([min(1.0, max(0.0, float(x))), min(1.0, max(0.0, float(y)))] for x, y in pts if x is not None and y is not None), key=lambda p: p[0])
    return pts


def curve_neutral(curves, name):
    pts = curve_points(curves, name)
    if not pts:
        return True
    if name in IDENTITY:
        return all(abs(x - y) < 1e-4 for x, y in pts)
    return all(abs(y - 0.5) < 1e-4 for _, y in pts)


def bake_curve(curves, name):
    """CURVE_N samples of a curve, as the value the grade uses (see above)."""
    pts = curve_points(curves, name)
    xs_out = [i / (CURVE_N - 1) for i in range(CURVE_N)]
    if not pts:
        ys = [x if name in IDENTITY else 0.5 for x in xs_out]
    elif name in PERIODIC:
        ext = [[x - 1, y] for x, y in pts] + pts + [[x + 1, y] for x, y in pts]
        xs, yv = [p[0] for p in ext], [p[1] for p in ext]
        ys = [_monotone(xs, yv, x) for x in xs_out]
    else:
        if name in IDENTITY:
            pts = ([[0.0, 0.0]] if pts[0][0] > 1e-4 else []) + pts + ([[1.0, 1.0]] if pts[-1][0] < 1 - 1e-4 else [])
        xs, yv = [p[0] for p in pts], [p[1] for p in pts]
        ys = [_monotone(xs, yv, x) for x in xs_out]
    if name == "hueHue":
        return [y - 0.5 for y in ys]
    if name in ("hueSat", "hueLum", "lumSat"):
        return [max(0.0, 2 * y) for y in ys]
    return [min(1.0, max(0.0, y)) for y in ys]


def bake_curves(grade):
    """The grade's curves as rows of CURVE_N values (CURVE_ROWS order), plus which stages are active; None if neutral."""
    curves = (grade or {}).get("curves") or {}
    if not curves or (grade or {}).get("curvesOn") is False:
        return None
    rgb = any(not curve_neutral(curves, n) for n in ("master", "r", "g", "b"))
    hsl = any(not curve_neutral(curves, n) for n in ("hueHue", "hueSat", "hueLum", "lumSat", "satSat"))
    if not (rgb or hsl):
        return None
    return {"rows": [bake_curve(curves, n) for n in CURVE_ROWS], "rgb": rgb, "hsl": hsl}


def match_params(grade):
    """A shot match (grade.match = {on, gain: [r, g, b], offset: [r, g, b]}): applied after the grade and LUT."""
    m = (grade or {}).get("match") or {}
    if not m or m.get("on") is False or (grade or {}).get("enabled") is False:
        return None
    gain = [float(v) for v in (m.get("gain") or [1, 1, 1])][:3]
    off = [float(v) for v in (m.get("offset") or [0, 0, 0])][:3]
    if all(abs(g - 1) < 1e-5 for g in gain) and all(abs(o) < 1e-5 for o in off):
        return None
    return {"gain": gain, "offset": off}


DISSOLVE_STYLES = ("cross", "film", "additive", "nonadditive", "dip")
IRIS_SHAPES = ("circle", "oval", "diamond", "square", "cross", "x", "triangle")
DEFAULT_PARAMS = {
    "dissolve": {"style": "cross", "color": "#000000"}, "wipe": {"angle": 0}, "slide": {"angle": 180, "push": False},
    "iris": {"shape": "circle", "reverse": False}, "clock": {"reverse": False}, "blinds": {"angle": 0, "count": 8},
    "barn": {"angle": 0, "reverse": False},
}
_LEGACY = {
    "dip_black": ("dissolve", {"style": "dip", "color": "#000000"}), "dip_white": ("dissolve", {"style": "dip", "color": "#ffffff"}),
    "wipe_left": ("wipe", {"angle": 180}), "wipe_right": ("wipe", {"angle": 0}), "wipe_up": ("wipe", {"angle": 90}), "wipe_down": ("wipe", {"angle": 270}),
    "slide_left": ("slide", {"angle": 180}), "slide_right": ("slide", {"angle": 0}),
    "push_left": ("slide", {"angle": 180, "push": True}), "push_right": ("slide", {"angle": 0, "push": True}),
    "circle_open": ("iris", {"shape": "circle"}), "circle_close": ("iris", {"shape": "circle", "reverse": True}),
}


GRADE_FIELDS = ("lift.x", "lift.y", "lift.master", "gamma.x", "gamma.y", "gamma.master", "gain.x", "gain.y", "gain.master",
                "exposure", "contrast", "saturation", "temperature", "tint", "lutMix",
                *[f"{z}.{f}" for z in ("master", "shadows", "mids", "highs") for f in ("x", "y", "bright", "sat")], "zoneLow", "zoneHigh")


def has_grade_keys(clip):
    return any(keys_of(clip, "grade:" + f) for f in GRADE_FIELDS)


def grade_at(clip, tau):
    """The clip's grade at clip time tau, with keyframed fields interpolated (mirrors model.gradeAt)."""
    import copy
    grade = copy.deepcopy(clip.get("grade") or {})
    for field in GRADE_FIELDS:
        ks = keys_of(clip, "grade:" + field)
        if not ks:
            continue
        value = float(key_values(ks, tau))
        node = grade
        parts = field.split(".")
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node[parts[-1]] = value
    return grade


def normalize_transition(tr):
    """Convert older per-direction transition types and fill in default parameters (mirrors transitions.js)."""
    tr = dict(tr)
    kind = tr.get("type")
    if kind in AUDIO_TRANSITIONS:
        return tr
    if kind in _LEGACY:
        kind, extra = _LEGACY[kind]
        tr["params"] = {**(tr.get("params") or {}), **extra}
    if kind not in DEFAULT_PARAMS:
        kind = "dissolve"
    tr["type"] = kind
    tr["params"] = {**DEFAULT_PARAMS[kind], **(tr.get("params") or {})}
    return tr
