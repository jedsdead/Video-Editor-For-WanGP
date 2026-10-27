"""Timeline maths shared by the export engine. static/js/model.js and static/js/grade.js implement the same formulas
for the live preview, so what you see in the editor is what the export renders."""

import math

WHEEL_RED_ANGLE = math.radians(104.0)
LIFT_RANGE, GAMMA_RANGE, GAIN_RANGE = 0.25, 0.5, 0.5

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


def clip_speeds(clip):
    s0 = max(0.05, float(clip.get("speed") or 1.0))
    ramp = clip.get("rampTo")
    s1 = max(0.05, float(ramp)) if ramp not in (None, "", False) else s0
    return s0, s1


def clip_duration(clip, media_kind=None):
    length = max(0.0, float(clip["out"]) - float(clip["in"]))
    if media_kind == "image":
        return length
    s0, s1 = clip_speeds(clip)
    return length / s0 if abs(s1 - s0) < 1e-9 else 2.0 * length / (s0 + s1)


def source_time(clip, tau, media_kind=None):
    """Source media time for a clip-local time tau (seconds from the clip start). Linear speed ramps integrate exactly."""
    if media_kind == "image":
        return 0.0
    s0, s1 = clip_speeds(clip)
    d = clip_duration(clip)
    if tau < 0:
        return float(clip["in"]) + s0 * tau
    if tau > d:
        return float(clip["out"]) + s1 * (tau - d)
    return float(clip["in"]) + s0 * tau + ((s1 - s0) * tau * tau / (2.0 * d) if d > 0 else 0.0)


def speed_at(clip, tau):
    s0, s1 = clip_speeds(clip)
    d = clip_duration(clip)
    if d <= 0:
        return s0
    return s0 + (s1 - s0) * min(1.0, max(0.0, tau / d))


def fade_factor(clip, tau, duration):
    factor = 1.0
    fade_in, fade_out = float(clip.get("fadeIn") or 0), float(clip.get("fadeOut") or 0)
    if fade_in > 0 and tau < fade_in:
        factor *= max(0.0, tau / fade_in)
    if fade_out > 0 and tau > duration - fade_out:
        factor *= max(0.0, (duration - tau) / fade_out)
    return factor


def audio_transition_gains(kind, p):
    p = min(1.0, max(0.0, p))
    if kind == "a_linear":
        return 1.0 - p, p
    if kind == "a_dip":
        return (max(0.0, 1.0 - 2.0 * p), max(0.0, 2.0 * p - 1.0))
    return math.cos(p * math.pi / 2.0), math.sin(p * math.pi / 2.0)


def db_to_gain(db):
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
    params = {
        "exposure": 2.0 ** float(grade.get("exposure") or 0),
        "wb": [1.0 + 0.2 * temperature, 1.0 - 0.2 * tint, 1.0 - 0.2 * temperature],
        "lift": [lift_m + d for d in lift_d],
        "gain": [1.0 + gain_m + d for d in gain_d],
        "gamma": [max(0.05, 1.0 + gamma_m + d) for d in gamma_d],
        "contrast": 1.0 + float(grade.get("contrast") or 0),
        "saturation": float(grade.get("saturation") if grade.get("saturation") is not None else 1.0),
    }
    neutral = (abs(params["exposure"] - 1) < 1e-6 and all(abs(v - 1) < 1e-6 for v in params["wb"] + params["gain"] + params["gamma"])
               and all(abs(v) < 1e-6 for v in params["lift"]) and abs(params["contrast"] - 1) < 1e-6 and abs(params["saturation"] - 1) < 1e-6)
    return None if neutral else params


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
